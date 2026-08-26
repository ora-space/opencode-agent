import type {
  AgentEffectContext,
  AgentEffectDefinition,
  AgentEffectIdleState,
  AgentEffectRestartContext,
  EffectSurfaceDeclaration,
  JsonValue,
} from "@ora-space/plugin-sdk";
import type { OpenCodeClient } from "../services/opencode-client.ts";

/**
 * The only Skill surface OpenCode reads: a project-relative `skills/<name>/SKILL.md` tree.
 *
 * See https://opencode.ai/docs/skills — OpenCode also reads `.claude/skills` and `.agents/skills`,
 * but those are Preserved State from this plugin's point of view: Ora only manages the surface it
 * declares here, so it never fights another tool over the compatibility directories.
 */
export const SKILLS_SURFACE: EffectSurfaceDeclaration = {
  workspaceRelativePath: ".opencode/skills",
  materializationFormat: "skill_directory.v1",
  coordination: "wait_for_idle_and_restart",
};

const SESSION_PROMPT_METHOD = "session/prompt";

/**
 * Coordinates the `.opencode/skills` Effect surface against the one CLI process this plugin owns.
 *
 * OpenCode scans its Skill directories once at startup and never rescans them, so a Skill edit on
 * disk only takes effect once the CLI restarts. This tracks in-flight `session/prompt` turns from
 * the ACP frames already flowing through the bridge — nothing here parses ACP beyond `method` and
 * `id` — and, once every turn has finished, holds any new one behind a barrier until `restart` has
 * respawned the CLI with the new Skill files and replayed what it held.
 */
export class SkillEffectCoordinator {
  readonly #client: OpenCodeClient;
  readonly #cwd: () => string | undefined;
  readonly #openTurns = new Set<string | number>();
  /** `undefined` while no barrier is held; an array from the moment `waitForIdle` reports ready. */
  #held: JsonValue[] | undefined;
  #appliedGeneration: number | undefined;

  constructor(client: OpenCodeClient, cwd: () => string | undefined) {
    this.#client = client;
    this.#cwd = cwd;
  }

  readonly definition: AgentEffectDefinition = {
    surfaces: [SKILLS_SURFACE],
    waitForIdle: (context) => this.#waitForIdle(context),
    restart: (context) => this.#restart(context),
  };

  /**
   * Observes one host-to-agent frame before it would be forwarded, absorbing it instead if the
   * barrier is holding new turns. Returns whether the frame was absorbed.
   */
  intercept(frame: JsonValue): boolean {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return false;
    }
    const { method, id } = frame;
    if (
      typeof method !== "string" ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    if (method !== SESSION_PROMPT_METHOD) {
      return false;
    }
    if (this.#held !== undefined) {
      this.#held.push(frame);
      return true;
    }
    this.#openTurns.add(id);
    return false;
  }

  /** Observes one agent-to-host frame, clearing turn tracking once a prompt resolves. */
  observe(frame: JsonValue): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return;
    }
    if ("method" in frame) {
      return; // requests and notifications the CLI sends are not responses.
    }
    const { id } = frame;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    this.#openTurns.delete(id);
  }

  /**
   * Reports whether every turn has finished, engaging the new-turn barrier the moment it has.
   *
   * Idempotent by design: once the barrier is engaged, `#openTurns` stays empty forever because
   * `intercept` routes every later `session/prompt` into `#held` instead, so a repeated call keeps
   * returning `ready` with no further side effect.
   */
  #waitForIdle(_context: AgentEffectContext): AgentEffectIdleState {
    if (this.#openTurns.size > 0) {
      return "waiting_for_idle";
    }
    this.#held ??= [];
    return "ready";
  }

  /**
   * Restarts the CLI so it rescans `.opencode/skills`, then replays every held turn in order.
   *
   * The barrier is released only after the queue is fully drained, and draining re-checks the
   * queue length on every iteration, so a `session/prompt` that arrives mid-restart is still
   * caught by `intercept` and gets appended in time to be replayed rather than dropped.
   */
  async #restart(context: AgentEffectRestartContext): Promise<void> {
    const cwd = this.#cwd();
    const alreadyRunning = this.#client.running &&
      this.#appliedGeneration === context.generation;
    if (!alreadyRunning && cwd !== undefined) {
      await this.#client.start(cwd);
    }
    this.#appliedGeneration = context.generation;

    while (this.#held !== undefined && this.#held.length > 0) {
      const frame = this.#held.shift();
      if (frame !== undefined) {
        await this.#client.writeAcp(frame);
      }
    }
    this.#held = undefined;
  }
}
