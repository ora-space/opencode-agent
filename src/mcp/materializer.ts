import type {
  McpConfigurationReceipt,
  McpConfigurationSnapshotRequest,
  McpEntryReceipt,
  SnapshotResolvedMcp,
} from "@ora-space/plugin-sdk";
import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { McpMaterializationError } from "./errors.ts";
import {
  type AtomicReplacer,
  CurrentUserPermissionRestrictor,
  DenoAtomicReplacer,
  DenoMaterializationFileSystem,
  type MaterializationFileSystem,
  type PermissionRestrictor,
} from "./filesystem.ts";
import { fingerprintBytes } from "./fingerprint.ts";
import { type GitWorkspaceGuard, RepositoryLocalGitGuard } from "./git.ts";
import type { ManagedDocumentState, ManagedStateStore } from "./ledger.ts";
import {
  assertNoNativeKeyCollisions,
  type IdentityDigest,
  nativeMcpKey,
} from "./native-key.ts";

export const MANAGED_DOCUMENT_LOCATOR = ".opencode/opencode.json";
const OPEN_CODE_SCHEMA = "https://opencode.ai/config.json";
const encoder = new TextEncoder();

interface OpenCodeRemoteEntry {
  type: "remote";
  url: string;
  enabled: true;
  oauth: false;
  headers: Record<string, string>;
}

interface PlannedEntry {
  canonicalIdentity: string;
  managedIdentity: string;
  nativeKey: string;
  sourceRevisionId: string;
  value: OpenCodeRemoteEntry;
  receipt: McpEntryReceipt;
}

type ManagedDocumentIntent = "replace" | "delete";

/** Dependencies whose failure behavior is significant to the all-or-nothing write contract. */
export interface McpMaterializerDependencies {
  fileSystem: MaterializationFileSystem;
  permissions: PermissionRestrictor;
  atomicReplacer: AtomicReplacer;
  git: GitWorkspaceGuard;
  state: ManagedStateStore;
  identityDigest?: IdentityDigest;
}

/**
 * Reconciles a complete supported snapshot into OpenCode's exclusively Ora-managed document.
 *
 * Every public failure is reduced to a stable code. In particular, filesystem and parser errors
 * are never interpolated because their original messages may contain an absolute path or content.
 */
export class OpenCodeMcpMaterializer {
  readonly #dependencies: McpMaterializerDependencies;

  constructor(dependencies: McpMaterializerDependencies) {
    this.#dependencies = dependencies;
  }

  async configureWorkspace(
    request: McpConfigurationSnapshotRequest,
  ): Promise<McpConfigurationReceipt> {
    try {
      return await this.#configureWorkspace(request);
    } catch (error) {
      if (error instanceof McpMaterializationError) {
        throw error;
      }
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Orders proof, preserved-state, Git, ledger, and atomic-write gates before reporting success. */
  async #configureWorkspace(
    request: McpConfigurationSnapshotRequest,
  ): Promise<McpConfigurationReceipt> {
    const plans = await this.#planEntries(request.resolvedMcps);
    const intent: ManagedDocumentIntent = plans.length === 0
      ? "delete"
      : "replace";
    const documentBytes = renderDocument(plans);
    const documentFingerprint = await fingerprintBytes(documentBytes);
    const managedDirectory = join(request.workspaceRoot, ".opencode");
    const targetPath = join(
      request.workspaceRoot,
      ...MANAGED_DOCUMENT_LOCATOR.split("/"),
    );
    await this.#dependencies.fileSystem.assertSafeManagedPaths(
      managedDirectory,
      targetPath,
    );
    const observedBytes = await this.#dependencies.fileSystem.read(targetPath);
    const observedFingerprint = observedBytes === undefined
      ? undefined
      : await fingerprintBytes(observedBytes);
    const state = await this.#readState(request.agentTargetId);

    this.#assertOwnership(
      request,
      state,
      observedFingerprint,
      documentFingerprint,
      intent,
    );

    if (plans.length > 0) {
      await this.#assertRootConfigurationPreserved(
        request.workspaceRoot,
        plans,
      );
    }
    if (observedBytes !== undefined || plans.length > 0) {
      await this.#dependencies.git.prepare(request.workspaceRoot, targetPath);
    }

    const receipt = receiptFor(request, documentFingerprint, plans);
    if (plans.length === 0) {
      return await this.#deleteManagedDocument(
        request,
        state,
        observedBytes,
        documentFingerprint,
        receipt,
        targetPath,
      );
    }

    if (observedFingerprint === documentFingerprint) {
      await this.#assertObservedUnchanged(targetPath, observedFingerprint);
      await this.#commitAppliedState(
        request.agentTargetId,
        documentFingerprint,
      );
      return receipt;
    }

    await this.#prepareState(
      request,
      state,
      documentFingerprint,
      "replace",
    );
    await this.#dependencies.fileSystem.ensureDirectory(managedDirectory);
    await this.#dependencies.fileSystem.assertSafeManagedPaths(
      managedDirectory,
      targetPath,
    );
    const stagingPath = await this.#dependencies.fileSystem.createStagingFile(
      targetPath,
    );
    try {
      // Windows ignores create mode, so restrict the empty file before plaintext can inherit ACLs.
      await this.#dependencies.permissions.restrict(stagingPath);
      await this.#dependencies.fileSystem.writeStagingFile(
        stagingPath,
        documentBytes,
      );
      await this.#assertObservedUnchanged(targetPath, observedFingerprint);
      await this.#dependencies.atomicReplacer.replace(stagingPath, targetPath);
    } finally {
      await this.#dependencies.fileSystem.cleanup(stagingPath);
    }
    await this.#commitAppliedState(
      request.agentTargetId,
      documentFingerprint,
    );
    return receipt;
  }

  /** Plans the entire entry set first so one invalid MCP cannot leave a partially changed file. */
  async #planEntries(
    resolvedMcps: readonly SnapshotResolvedMcp[],
  ): Promise<PlannedEntry[]> {
    const plans = await Promise.all(resolvedMcps.map(async (mcp) => {
      if (mcp.transport.kind !== "http") {
        // The Host must exclude stdio after HTTP-only negotiation; accepting it here would let a
        // malformed request accidentally enter either the document or the success receipt.
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      let url: URL;
      try {
        url = new URL(mcp.transport.url);
      } catch {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      if (url.protocol !== "https:" || url.hostname.length === 0) {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      const nativeKey = await nativeMcpKey(
        mcp.canonicalIdentity,
        this.#dependencies.identityDigest,
      );
      const value: OpenCodeRemoteEntry = {
        type: "remote",
        url: mcp.transport.url,
        enabled: true,
        oauth: false,
        headers: Object.fromEntries(
          Object.entries(mcp.transport.headers).sort(([left], [right]) =>
            compareCodeUnits(left, right)
          ),
        ),
      };
      return {
        canonicalIdentity: mcp.canonicalIdentity,
        managedIdentity: mcp.managedIdentity,
        nativeKey,
        sourceRevisionId: mcp.sourceRevisionId,
        value,
        receipt: {
          managedIdentity: mcp.managedIdentity,
          nativeKey,
          entryFingerprint: await fingerprintBytes(
            encoder.encode(JSON.stringify(value)),
          ),
          sourceRevisionId: mcp.sourceRevisionId,
        },
      };
    }));
    plans.sort((left, right) =>
      compareCodeUnits(left.nativeKey, right.nativeKey)
    );
    assertNoNativeKeyCollisions(plans);
    if (
      new Set(plans.map((entry) => entry.managedIdentity)).size !==
        plans.length ||
      new Set(plans.map((entry) => entry.nativeKey)).size !== plans.length
    ) {
      throw new McpMaterializationError("mcp_native_key_collision");
    }
    return plans;
  }

  /** Accepts bytes only when an applied ledger or this exact prepared replay proves ownership. */
  #assertOwnership(
    request: McpConfigurationSnapshotRequest,
    state: ManagedDocumentState | undefined,
    observedFingerprint: string | undefined,
    desiredFingerprint: string,
    intent: ManagedDocumentIntent,
  ): void {
    if (
      state?.prepared !== undefined &&
      (
        state.prepared.operationId !== request.operationId ||
        state.prepared.desiredFingerprint !== desiredFingerprint ||
        state.prepared.intent !== intent
      )
    ) {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
    const appliedMatches = observedFingerprint !== undefined &&
      state?.applied?.fingerprint === observedFingerprint;
    const preparedMatches =
      state?.prepared?.operationId === request.operationId &&
      state.prepared.desiredFingerprint === desiredFingerprint &&
      state.prepared.intent === intent &&
      (intent === "delete"
        ? observedFingerprint === undefined
        : observedFingerprint === desiredFingerprint);

    if (
      observedFingerprint !== undefined && !appliedMatches && !preparedMatches
    ) {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
    if (
      observedFingerprint === undefined && state?.applied !== undefined &&
      !preparedMatches
    ) {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Blocks ambiguous user-layer merges before Git state or managed bytes are changed. */
  async #assertRootConfigurationPreserved(
    workspaceRoot: string,
    plans: readonly PlannedEntry[],
  ): Promise<void> {
    const nativeKeys = new Set(plans.map((plan) => plan.nativeKey));
    for (const fileName of ["opencode.json", "opencode.jsonc"]) {
      const bytes = await this.#dependencies.fileSystem.read(
        join(workspaceRoot, fileName),
      );
      if (bytes === undefined) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseJsonc(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      if (!isRecord(parsed) || !("mcp" in parsed)) {
        continue;
      }
      if (!isRecord(parsed.mcp)) {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      if (Object.keys(parsed.mcp).some((key) => nativeKeys.has(key))) {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
    }
  }

  /** Deletes only an owned, fingerprint-verified document while leaving its directory untouched. */
  async #deleteManagedDocument(
    request: McpConfigurationSnapshotRequest,
    state: ManagedDocumentState | undefined,
    observedBytes: Uint8Array | undefined,
    desiredFingerprint: string,
    receipt: McpConfigurationReceipt,
    targetPath: string,
  ): Promise<McpConfigurationReceipt> {
    if (observedBytes === undefined && state === undefined) {
      return receipt;
    }
    if (observedBytes === undefined) {
      await this.#clearOwnershipState(request.agentTargetId);
      return receipt;
    }
    await this.#prepareState(request, state, desiredFingerprint, "delete");
    await this.#assertObservedUnchanged(
      targetPath,
      await fingerprintBytes(observedBytes),
    );
    await this.#dependencies.fileSystem.removeFile(targetPath);
    await this.#clearOwnershipState(request.agentTargetId);
    return receipt;
  }

  /** Rechecks the last observed fingerprint immediately before return, replace, or deletion. */
  async #assertObservedUnchanged(
    targetPath: string,
    expectedFingerprint: string | undefined,
  ): Promise<void> {
    const currentBytes = await this.#dependencies.fileSystem.read(targetPath);
    const currentFingerprint = currentBytes === undefined
      ? undefined
      : await fingerprintBytes(currentBytes);
    if (currentFingerprint !== expectedFingerprint) {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Maps unavailable or malformed ownership state to a safe preserved-state conflict. */
  async #readState(
    agentTargetId: string,
  ): Promise<ManagedDocumentState | undefined> {
    try {
      return await this.#dependencies.state.read(agentTargetId);
    } catch {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Persists replay evidence before the first plaintext filesystem mutation. */
  async #prepareState(
    request: McpConfigurationSnapshotRequest,
    state: ManagedDocumentState | undefined,
    desiredFingerprint: string,
    intent: ManagedDocumentIntent,
  ): Promise<void> {
    try {
      await this.#dependencies.state.write(request.agentTargetId, {
        applied: state?.applied,
        prepared: {
          operationId: request.operationId,
          desiredFingerprint,
          previousFingerprint: state?.applied?.fingerprint,
          intent,
        },
      });
    } catch {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Advances applied ownership only after the filesystem replacement has committed. */
  async #commitAppliedState(
    agentTargetId: string,
    fingerprint: string,
  ): Promise<void> {
    try {
      await this.#dependencies.state.write(agentTargetId, {
        applied: { fingerprint },
        prepared: undefined,
      });
    } catch {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }

  /** Clears ownership only after absence or a fingerprint-verified deletion is established. */
  async #clearOwnershipState(agentTargetId: string): Promise<void> {
    try {
      await this.#dependencies.state.write(agentTargetId, {
        applied: undefined,
        prepared: undefined,
      });
    } catch {
      throw new McpMaterializationError("mcp_materialization_conflict");
    }
  }
}

/** Creates the production adapter while leaving private storage ownership at the callsite. */
export function createOpenCodeMcpMaterializer(
  state: ManagedStateStore,
): OpenCodeMcpMaterializer {
  const fileSystem = new DenoMaterializationFileSystem();
  const atomicReplacer = new DenoAtomicReplacer();
  return new OpenCodeMcpMaterializer({
    fileSystem,
    permissions: new CurrentUserPermissionRestrictor(),
    atomicReplacer,
    git: new RepositoryLocalGitGuard(fileSystem, atomicReplacer),
    state,
  });
}

/** Renders only the target-native fields Ora owns, with a single canonical trailing newline. */
function renderDocument(plans: readonly PlannedEntry[]): Uint8Array {
  if (plans.length === 0) {
    return new Uint8Array();
  }
  const mcp = Object.fromEntries(
    plans.map((entry) => [entry.nativeKey, entry.value]),
  );
  return encoder.encode(
    `${JSON.stringify({ $schema: OPEN_CODE_SCHEMA, mcp }, null, 2)}\n`,
  );
}

/** Mirrors every planned entry into the exact full-coverage receipt the Host validates. */
function receiptFor(
  request: McpConfigurationSnapshotRequest,
  documentFingerprint: string,
  plans: readonly PlannedEntry[],
): McpConfigurationReceipt {
  return {
    appliedGeneration: request.generation,
    documentLocator: MANAGED_DOCUMENT_LOCATOR,
    documentFingerprint,
    entries: plans.map((plan) => plan.receipt),
  };
}

/** Uses locale-independent UTF-16 order so output bytes agree on every host locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
