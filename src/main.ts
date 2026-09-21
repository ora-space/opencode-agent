import type {
  AcpSender,
  AgentModel,
  AgentStartContext,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { AGENT_METHODS } from "@ora-space/plugin-sdk";
import {
  type AgentListModelsContext,
  AgentPlugin,
  type PluginContext,
  runAgentPlugin,
} from "./base/agent-plugin.ts";
import { forwardAcpFrame } from "./handlers/acp.ts";
import { SkillEffectCoordinator } from "./handlers/effects.ts";
import { startOpenCode, stopOpenCode } from "./handlers/lifecycle.ts";
import {
  invalidateAllOpenCodeModels,
  invalidateOpenCodeModels,
  listOpenCodeModels,
} from "./handlers/models.ts";
import { OpenCodeClient } from "./services/opencode-client.ts";
import { logger } from "./services/log.ts";

/** Must match `identifier` in orax.toml, which is also this agent's identity inside Ora. */
const PLUGIN_ID = "ora-space.opencode";

/**
 * Publishes OpenCode as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one CLI and needs no addressing of
 * its own. Every API is delegated to a handler module, which keeps the entrypoint to wiring: the
 * sender handed in by `agent/start`, the CLI bridge, and the route mounting below.
 */
class OpenCodeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;
  /** The workspace root the CLI is running against; also what a Skill Effect restart respawns into. */
  #cwd: string | undefined;
  /** Set by `onActivate`, which the base class runs before the host can call anything. */
  #processes: HostProcesses | undefined;

  readonly #log = logger("plugin");

  readonly #client = new OpenCodeClient({
    onAcpFrame: (frame) => {
      this.#effects.observe(frame);
      if (this.#send === undefined) {
        this.#log.warn(
          "dropping ACP frame from the CLI: no host sender yet",
          {
            context: acpFrameSummary(frame),
          },
        );
        return;
      }
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send(frame).catch((error) => {
        this.#log.warn("failed to forward ACP frame to the host", {
          context: acpFrameSummary(frame),
          error,
        });
      });
    },
    onExited: () => {
      if (this.#cwd !== undefined) {
        invalidateOpenCodeModels(this.#cwd);
      }
      this.#log.warn(
        "the OpenCode CLI exited on its own; Ora decides whether to reconnect",
        { context: { cwd: this.#cwd } },
      );
    },
  });

  readonly #effects = new SkillEffectCoordinator(this.#client, () => this.#cwd);

  override readonly effects = this.#effects.definition;

  override onActivate(context: PluginContext): void {
    this.#log.info(`${context.pluginId} activated`, {
      context: { pluginId: context.pluginId },
    });
    this.#processes = context.processes;
    this.#client.attachProcesses(context.processes);
  }

  override onStart = async (
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<void> => {
    this.#log.info("agent start requested", {
      context: { cwd: context.cwd, previousCwd: this.#cwd },
    });
    if (this.#cwd !== undefined) {
      invalidateOpenCodeModels(this.#cwd);
    }
    this.#send = send;
    this.#cwd = context.cwd;
    invalidateOpenCodeModels(context.cwd);
    await startOpenCode(this.#client, context);
  };

  override onStop = async (): Promise<void> => {
    this.#log.info("agent stop requested", { context: { cwd: this.#cwd } });
    if (this.#cwd !== undefined) {
      invalidateOpenCodeModels(this.#cwd);
    }
    await stopOpenCode(this.#client);
  };

  override onListModels = (
    context: AgentListModelsContext,
  ): Promise<AgentModel[]> => {
    if (this.#processes === undefined) {
      throw new Error(
        `${AGENT_METHODS.listModels} was called before activation`,
      );
    }
    // Discovery is answered for the Workspace the host named, not for `#cwd`: `agent/start` gets a
    // neutral directory, and a user can open pickers for a project this connection never ran in.
    return listOpenCodeModels(this.#processes, context.cwd);
  };

  override onAcp = (frame: JsonValue): Promise<void> | void =>
    forwardAcpFrame(this.#client, this.#effects, frame);

  override async onDeactivate(): Promise<void> {
    this.#log.info("plugin deactivating; stopping the CLI", {
      context: { cwd: this.#cwd, cliRunning: this.#client.running },
    });
    invalidateAllOpenCodeModels();
    await this.#client.stop();
  }
}

/** The envelope fields of one ACP frame that are safe to log: never its params or result. */
function acpFrameSummary(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { shape: typeof frame };
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
    kind: "method" in frame
      ? ("id" in frame ? "request" : "notification")
      : ("error" in frame ? "error" : "response"),
  };
}

await runAgentPlugin(new OpenCodeAgentPlugin(), { pluginId: PLUGIN_ID });
