import type { PluginStorage } from "@ora-space/plugin-sdk";
import { fingerprintBytes } from "./fingerprint.ts";

export interface AppliedManagedDocument {
  fingerprint: string;
}

export interface PreparedManagedDocumentOperation {
  operationId: string;
  desiredFingerprint: string;
  previousFingerprint: string | undefined;
  deleting: boolean;
}

export interface ManagedDocumentState {
  applied: AppliedManagedDocument | undefined;
  prepared: PreparedManagedDocumentOperation | undefined;
}

/** Persists ownership proof independently from the managed document's target-native bytes. */
export interface ManagedStateStore {
  read(agentTargetId: string): Promise<ManagedDocumentState | undefined>;
  write(
    agentTargetId: string,
    state: ManagedDocumentState,
  ): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Stores non-secret fingerprints in the plugin's Host-protected private storage namespace. */
export class PluginStorageManagedStateStore implements ManagedStateStore {
  readonly #storage: PluginStorage;

  constructor(storage: PluginStorage) {
    this.#storage = storage;
  }

  async read(
    agentTargetId: string,
  ): Promise<ManagedDocumentState | undefined> {
    try {
      const parsed = JSON.parse(
        decoder.decode(
          await this.#storage.read(await statePath(agentTargetId)),
        ),
      );
      return parseState(parsed);
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async write(
    agentTargetId: string,
    state: ManagedDocumentState,
  ): Promise<void> {
    const bytes = encoder.encode(
      JSON.stringify({ schemaVersion: 1, ...state }),
    );
    await this.#storage.write(await statePath(agentTargetId), bytes);
  }
}

/** Hashing the target id keeps private storage paths bounded and slash-safe. */
async function statePath(agentTargetId: string): Promise<string> {
  const fingerprint = await fingerprintBytes(encoder.encode(agentTargetId));
  return `mcp-managed-state/${fingerprint.slice(7)}.json`;
}

function parseState(value: unknown): ManagedDocumentState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("invalid MCP managed-state ledger");
  }
  const applied = value.applied;
  const prepared = value.prepared;
  if (
    applied !== undefined &&
    (!isRecord(applied) || !isFingerprint(applied.fingerprint))
  ) {
    throw new Error("invalid MCP managed-state ledger");
  }
  if (
    prepared !== undefined &&
    (
      !isRecord(prepared) ||
      typeof prepared.operationId !== "string" ||
      !isFingerprint(prepared.desiredFingerprint) ||
      (
        prepared.previousFingerprint !== undefined &&
        !isFingerprint(prepared.previousFingerprint)
      ) ||
      typeof prepared.deleting !== "boolean"
    )
  ) {
    throw new Error("invalid MCP managed-state ledger");
  }
  return {
    applied: applied as AppliedManagedDocument | undefined,
    prepared: prepared as PreparedManagedDocumentOperation | undefined,
  };
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "kind" in error && error.kind === "not_found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
