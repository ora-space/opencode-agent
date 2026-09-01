import type { AgentStartContext } from "@ora-space/plugin-sdk";
import { INVALID_PARAMS, PluginMethodError } from "@ora-space/plugin-sdk";
import type { OpenCodeClient } from "../services/opencode-client.ts";

/**
 * Serves `agent/start` by bringing the OpenCode CLI up in the host's working directory.
 *
 * Ora calls this once per connection, before any session exists, so the CLI is already accepting
 * ACP frames when the host runs its own `initialize` handshake. Per-session directories travel
 * later in ACP `session/new`, not here.
 */
export async function startOpenCode(
  client: OpenCodeClient,
  context: AgentStartContext,
): Promise<void> {
  if (context.cwd.trim() === "") {
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/start requires a non-empty cwd",
    );
  }
  await client.start(context.cwd);
}

/**
 * Serves `agent/stop` by killing the CLI while keeping this plugin process alive.
 *
 * A later `agent/start` respawns it, which is what lets Ora restart a failed agent without
 * paying for a new plugin handshake.
 */
export function stopOpenCode(client: OpenCodeClient): Promise<void> {
  return client.stop();
}
