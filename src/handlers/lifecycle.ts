import type {
  AgentModelApplied,
  AgentStartContext,
} from "@ora-space/plugin-sdk";
import { INVALID_PARAMS, PluginMethodError } from "@ora-space/plugin-sdk";
import type { OpenCodeClient } from "../services/opencode-client.ts";
import { logger } from "../services/log.ts";
import { modelRoute } from "../services/model-route.ts";

const log = logger("lifecycle");

/**
 * Serves `agent/start` by bringing the OpenCode CLI up in the host's working directory.
 *
 * Ora calls this once per connection, before any session exists, so the CLI is already accepting
 * ACP frames when the host runs its own `initialize` handshake. Per-session directories travel
 * later in ACP `session/new`, not here.
 *
 * A platform-model start carries a frozen model context, which this plugin turns into OpenCode's
 * provider configuration and confirms once the CLI started with it; a start without one keeps the
 * CLI's own configuration, exactly as on a local desktop. `configDirectory` is the private
 * configuration root of the session home the host provides.
 */
export async function startOpenCode(
  client: OpenCodeClient,
  context: AgentStartContext,
  configDirectory: string | undefined,
): Promise<AgentModelApplied | void> {
  if (context.cwd.trim() === "") {
    log.warn("agent/start refused: empty cwd");
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/start requires a non-empty cwd",
    );
  }
  const route = context.modelContext === undefined
    ? undefined
    : modelRoute(context.modelContext, configDirectory ?? "");
  client.useRoute(route);
  await client.start(context.cwd);
  log.info("OpenCode CLI started for agent/start", {
    context: { cwd: context.cwd, platformRoute: route !== undefined },
  });
  return route?.applied;
}

/**
 * Serves `agent/stop` by killing the CLI while keeping this plugin process alive.
 *
 * A later `agent/start` respawns it, which is what lets Ora restart a failed agent without
 * paying for a new plugin handshake.
 */
export async function stopOpenCode(client: OpenCodeClient): Promise<void> {
  const wasRunning = client.running;
  await client.stop();
  log.info("OpenCode CLI stopped for agent/stop", {
    context: { wasRunning },
  });
}
