import type { JsonValue } from "@ora-space/plugin-sdk";
import type { SkillEffectCoordinator } from "./effects.ts";
import type { OpenCodeClient } from "../services/opencode-client.ts";

/**
 * Serves the `agent/acp` notification by piping one host frame into the CLI verbatim.
 *
 * The frame's payload is never parsed. ACP carries its own ids, ordering, and cancellation, so
 * anything this plugin decided about a payload would only be a second, weaker copy of what the
 * two ACP peers already agreed on. `effects` only reads `method` and `id` off the envelope, to
 * hold a new turn behind the Skill Effect barrier when one is engaged; see {@link SkillEffectCoordinator}.
 *
 * A frame that arrives while the CLI is down is dropped with a warning rather than throwing:
 * notifications have no response channel, so the host would never see the error, and failing the
 * handler cannot recover the frame either.
 */
export function forwardAcpFrame(
  client: OpenCodeClient,
  effects: SkillEffectCoordinator,
  frame: JsonValue,
): Promise<void> | void {
  if (effects.intercept(frame)) {
    return;
  }
  if (!client.running) {
    console.warn("dropping ACP frame: the OpenCode agent is not running");
    return;
  }
  return client.writeAcp(frame);
}
