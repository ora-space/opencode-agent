import type {
  AgentModel,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { INVALID_PARAMS, PluginMethodError } from "@ora-space/plugin-sdk";
import { AcpProbe } from "../services/acp-probe.ts";
import { spawnOpenCode } from "../services/command.ts";

/** The ACP revision this plugin speaks; the same one Ora declares on its own connection. */
const ACP_PROTOCOL_VERSION = 1;

/**
 * How long one workspace's answer is reused before OpenCode is asked again.
 *
 * Ora deliberately keeps no copy: discovery is on demand, so a picker that re-renders asks again,
 * and every ask costs a CLI start plus an ACP handshake. A short window collapses that burst
 * without outliving the reason a catalog changes — logging into a provider, or editing OpenCode's
 * config — which stays visible the next time the picker is opened.
 */
const CATALOG_TTL_MS = 5 * 60_000;

/** One workspace's in-flight or recent answer. */
interface CachedCatalog {
  models: Promise<AgentModel[]>;
  expiresAt: number;
}

const catalogs = new Map<string, CachedCatalog>();

/** Drops the catalog for one workspace so the next request probes the current CLI state. */
export function invalidateOpenCodeModels(cwd: string): void {
  catalogs.delete(cwd);
}

/** Drops every workspace catalog when this plugin generation is going away. */
export function invalidateAllOpenCodeModels(): void {
  catalogs.clear();
}

/**
 * Serves `agent/list_models` for one workspace by asking OpenCode itself.
 *
 * OpenCode publishes no pre-session model list — `opencode models` prints ids without the display
 * names or the current selection, and its real catalog is the ACP session config the CLI computes
 * from the user's providers and config file. So discovery holds a whole ACP conversation, which is
 * why it needs its own process rather than the connection Ora is reading; see {@link AcpProbe}.
 *
 * A concurrent second call joins the promise already in flight rather than starting a second CLI:
 * Ora renders the agent picker and the workflow inspector independently, and both ask on open.
 *
 * The directory is checked rather than assumed: a host predating the `cwd` parameter sends no
 * params at all, and this plugin cannot invent a workspace to answer for. Saying so is the whole
 * value — the alternative is a probe spawned against nothing, failing several seconds later with
 * an error about a CLI rather than about the host that asked.
 */
export function listOpenCodeModels(
  processes: HostProcesses,
  cwd: string,
): Promise<AgentModel[]> {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/list_models requires the cwd of the workspace to discover models for",
    );
  }
  const cached = catalogs.get(cwd);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.models;
  }
  const models = discoverModels(processes, cwd);
  catalogs.set(cwd, { models, expiresAt: Date.now() + CATALOG_TTL_MS });
  // A failure is not an answer worth reusing: a CLI that was still starting, or a provider the
  // user is in the middle of configuring, must not keep the picker broken for the whole window.
  void models.catch(() => {
    if (catalogs.get(cwd)?.models === models) {
      catalogs.delete(cwd);
    }
  });
  return models;
}

/**
 * Runs one throwaway `opencode acp` and reads the model selector out of a session it creates.
 *
 * The probe session is deleted when OpenCode says it can be, and the process is killed either
 * way, so discovery leaves nothing behind in the user's session history.
 *
 * Failures propagate. Ora treats a failed `agent/list_models` as a failed discovery rather than a
 * failed agent, so reporting one is cheap and honest, while answering with an empty list would
 * make a CLI that could not start indistinguishable from one that genuinely offers no pre-session
 * catalog — which is a real answer this returns for an agent exposing no model selector.
 */
async function discoverModels(
  processes: HostProcesses,
  cwd: string,
): Promise<AgentModel[]> {
  // Resolution failures — no CLI on PATH, a bundled one that cannot run — are raised here as the
  // classified errors Ora acts on, before any probe exists to blur them into a timeout.
  const child = await spawnOpenCode(processes, {
    args: ["acp", "--cwd", cwd],
    cwd,
  });
  const probe = AcpProbe.attach(child);
  try {
    const initialized = await probe.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // An agent only reports config options to a client that advertises them, so this one
      // declaration is what makes the model selector appear at all. Nothing else is claimed: the
      // probe has no filesystem to lend and no user to prompt.
      clientCapabilities: { session: { configOptions: {} } },
    });
    const session = await probe.request("session/new", { cwd, mcpServers: [] });
    const models = modelsFrom(configOptionsOf(session));
    await deleteProbeSession(probe, initialized, session);
    return models;
  } finally {
    await probe.close();
  }
}

/**
 * Removes the session the probe created, when the agent supports removing one.
 *
 * Killing the process already ends the session as far as this plugin is concerned, but OpenCode
 * persists its sessions, so every probe leaves an empty conversation in the user's own history.
 * Today OpenCode advertises `close`, `fork`, `list`, and `resume` but not `delete`, which is why
 * this is gated on the capability rather than sent unconditionally: an unsupported call would earn
 * a `method_not_found` on every discovery and clean up nothing. It stays here because the
 * capability is the agent's to add, and best effort — a failure is not a discovery failure, and
 * the answer has already been read.
 */
async function deleteProbeSession(
  probe: AcpProbe,
  initialized: JsonValue,
  session: JsonValue,
): Promise<void> {
  const sessionId = readString(session, "sessionId");
  if (sessionId === undefined || !supportsSessionDelete(initialized)) {
    return;
  }
  try {
    await probe.request("session/delete", { sessionId });
  } catch (error) {
    console.debug(`probe session ${sessionId} was not deleted: ${error}`);
  }
}

/** Reports whether the agent advertised `session/delete` in its initialize response. */
function supportsSessionDelete(initialized: JsonValue): boolean {
  const capabilities = readRecord(
    readRecord(initialized, "agentCapabilities"),
    "sessionCapabilities",
  );
  return readRecord(capabilities, "delete") !== undefined;
}

/**
 * Picks the model selector out of a session's config options and flattens it into Ora's list.
 *
 * The choice mirrors how Ora reads the same options for its in-session picker, so the models a
 * user sees before starting a session are the models they will see inside one: prefer the option
 * the agent categorised as `model`, and otherwise accept a lone selector, since `category` is a UX
 * hint the protocol says clients must tolerate missing. An agent offering no selector yields an
 * empty list, which Ora accepts — its models then arrive with the session instead.
 */
function modelsFrom(configOptions: JsonValue[]): AgentModel[] {
  const selects = configOptions.filter(isSelectOption);
  const option = selects.find((select) => select.category === "model") ??
    (selects.length === 1 ? selects[0] : undefined);
  if (option === undefined) {
    return [];
  }
  const currentValue = readString(option, "currentValue");
  return selectableValues(option).map((value) => ({
    id: value.value,
    displayName: value.name,
    default: value.value === currentValue,
  }));
}

/** One selectable value of an ACP `select` config option. */
interface SelectValue {
  value: string;
  name: string;
}

/**
 * Flattens the two shapes an ACP selector's values take: a flat list, or a list of named groups.
 *
 * Group headers carry no value of their own and are dropped: Ora's pre-session list is flat, and a
 * group name is presentation the in-session picker renders from the same options later.
 */
function selectableValues(option: { [key: string]: JsonValue }): SelectValue[] {
  const options = option.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((entry): SelectValue[] => {
    if (!isRecord(entry)) {
      return [];
    }
    if (Array.isArray(entry.options)) {
      return entry.options.filter(isRecord).flatMap(toSelectValue);
    }
    return toSelectValue(entry);
  });
}

/** Keeps one option value only when it carries both halves Ora's picker needs. */
function toSelectValue(entry: { [key: string]: JsonValue }): SelectValue[] {
  const value = readString(entry, "value");
  const name = readString(entry, "name");
  return value === undefined ? [] : [{ value, name: name ?? value }];
}

/** Reads the config options off a `session/new` result, tolerating an agent that sends none. */
function configOptionsOf(session: JsonValue): JsonValue[] {
  if (!isRecord(session) || !Array.isArray(session.configOptions)) {
    return [];
  }
  return session.configOptions;
}

/** Narrows one config option to a `select`, the only kind that can carry a model catalog. */
function isSelectOption(
  option: JsonValue,
): option is { [key: string]: JsonValue } {
  return isRecord(option) && option.type === "select";
}

function readRecord(
  value: JsonValue | undefined,
  key: string,
): { [key: string]: JsonValue } | undefined {
  if (value === undefined || !isRecord(value)) {
    return undefined;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function readString(value: JsonValue, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
