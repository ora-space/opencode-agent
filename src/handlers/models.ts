import type { AgentModel, HostProcesses } from "@ora-space/plugin-sdk";
import { spawnOpenCode } from "../services/command.ts";

/** Reads the raw model id list from OpenCode; injectable so the cache can be exercised. */
export type ModelIdSource = () => Promise<string[]>;

/**
 * Models offered when OpenCode cannot be asked for its real list.
 *
 * An empty picker is indistinguishable from a broken agent in the UI, so a curated set keeps the
 * agent selectable while the user fixes their OpenCode installation or provider credentials.
 */
const FALLBACK_MODEL_IDS = [
  "anthropic/claude-sonnet-4",
  "anthropic/claude-opus-4",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat",
];

let cache: Promise<AgentModel[]> | undefined;

/**
 * Serves `agent/listModels`, cached for the plugin process lifetime.
 *
 * Ora asks for models before any session exists and may ask repeatedly while the pickers render,
 * and `opencode models` spawns a whole CLI, so the first answer is reused. A model list that
 * changes because the user logged into a new provider therefore needs a plugin restart.
 */
export function listOpenCodeModels(
  processes: HostProcesses,
  source: ModelIdSource = () => runOpenCodeModels(processes),
): Promise<AgentModel[]> {
  if (cache === undefined) {
    cache = discoverModels(source);
  }
  return cache;
}

/** Reads the live list, falling back to the curated set when OpenCode cannot answer. */
async function discoverModels(source: ModelIdSource): Promise<AgentModel[]> {
  try {
    const ids = await source();
    if (ids.length > 0) {
      // No model is marked default from the live list: OpenCode's own default lives in its
      // config and is not exposed by `opencode models`, so guessing one here would silently
      // override the user's choice.
      return ids.map((id) => ({ id, displayName: displayNameFor(id) }));
    }
  } catch (error) {
    console.warn(`model discovery failed, using defaults: ${error}`);
  }
  return FALLBACK_MODEL_IDS.map((id, index) => ({
    id,
    displayName: displayNameFor(id),
    default: index === 0,
  }));
}

/** Strips the `provider/` prefix so the picker shows a short name. */
function displayNameFor(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Runs `opencode models` through the host and returns the non-empty id lines it prints.
 *
 * This goes through the host rather than `Deno.Command` for the same reason the ACP server does:
 * the bundled CLI's path is only resolvable by the host, and a process the host owns is torn down
 * with this plugin generation instead of outliving it.
 */
async function runOpenCodeModels(processes: HostProcesses): Promise<string[]> {
  const child = await spawnOpenCode(processes, { args: ["models"] });
  await child.closeStdin();
  const output = await new Response(child.stdout).text();
  const { code } = await child.exited;
  if (code !== 0) {
    throw new Error(`opencode models exited with code ${code}`);
  }

  const ids = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (ids.length === 0) {
    throw new Error("opencode models returned no model ids");
  }
  return ids;
}
