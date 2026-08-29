import type {
  McpConfigurationSnapshotRequest,
  SnapshotResolvedMcp,
} from "@ora-space/plugin-sdk";
import { join } from "@std/path";
import { McpMaterializationError } from "../src/mcp/errors.ts";
import {
  type AtomicReplacer,
  DenoAtomicReplacer,
  DenoMaterializationFileSystem,
  type PermissionRestrictor,
} from "../src/mcp/filesystem.ts";
import { fingerprintBytes } from "../src/mcp/fingerprint.ts";
import {
  type GitWorkspaceGuard,
  RepositoryLocalGitGuard,
} from "../src/mcp/git.ts";
import type {
  ManagedDocumentState,
  ManagedStateStore,
} from "../src/mcp/ledger.ts";
import {
  MANAGED_DOCUMENT_LOCATOR,
  OpenCodeMcpMaterializer,
} from "../src/mcp/materializer.ts";
import {
  assertNoNativeKeyCollisions,
  nativeMcpKey,
} from "../src/mcp/native-key.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class MemoryStateStore implements ManagedStateStore {
  readonly values = new Map<string, ManagedDocumentState>();

  read(agentTargetId: string): Promise<ManagedDocumentState | undefined> {
    return Promise.resolve(structuredClone(this.values.get(agentTargetId)));
  }

  write(agentTargetId: string, state: ManagedDocumentState): Promise<void> {
    this.values.set(agentTargetId, structuredClone(state));
    return Promise.resolve();
  }
}

class NoopPermissions implements PermissionRestrictor {
  restrict(_path: string): Promise<void> {
    return Promise.resolve();
  }
}

class RecordingPermissions implements PermissionRestrictor {
  calls = 0;
  readonly sizesBeforeRestriction: number[] = [];

  async restrict(path: string): Promise<void> {
    this.calls += 1;
    this.sizesBeforeRestriction.push((await Deno.stat(path)).size);
  }
}

class CommitFailingStateStore extends MemoryStateStore {
  failCommit = true;
  #writes = 0;

  override write(
    agentTargetId: string,
    state: ManagedDocumentState,
  ): Promise<void> {
    this.#writes += 1;
    if (this.failCommit && this.#writes === 2) {
      throw new Error("injected ledger commit failure");
    }
    return super.write(agentTargetId, state);
  }
}

class NoopGit implements GitWorkspaceGuard {
  prepare(_workspaceRoot: string, _managedPath: string): Promise<void> {
    return Promise.resolve();
  }
}

class FailingPermissions implements PermissionRestrictor {
  restrict(_path: string): Promise<void> {
    throw new McpMaterializationError("mcp_config_permissions_failed");
  }
}

class FailingGit implements GitWorkspaceGuard {
  prepare(_workspaceRoot: string, _managedPath: string): Promise<void> {
    throw new McpMaterializationError("mcp_config_git_exclude_failed");
  }
}

class FailingAtomicReplacer implements AtomicReplacer {
  replace(_stagingPath: string, _targetPath: string): Promise<void> {
    throw new Error("injected atomic replacement failure");
  }
}

class MutatingReadFileSystem extends DenoMaterializationFileSystem {
  targetPath = "";
  targetReads = 0;

  override async read(path: string): Promise<Uint8Array | undefined> {
    if (path === this.targetPath) {
      this.targetReads += 1;
      if (this.targetReads === 2) {
        await Deno.writeTextFile(path, '{"externally":"raced"}\n');
      }
    }
    return await super.read(path);
  }
}

function tavily(
  authorization = "Bearer tavily-secret-key",
): SnapshotResolvedMcp {
  return {
    canonicalIdentity: "official/ora-space.tavily-search",
    managedIdentity: "mcp-tavily",
    packageVersion: "0.1.0",
    sourceRevisionId: "rev-tavily-1",
    transport: {
      kind: "http",
      url: "https://mcp.tavily.com/mcp",
      headers: { Authorization: authorization },
    },
  };
}

function snapshot(
  workspaceRoot: string,
  resolvedMcps: readonly SnapshotResolvedMcp[] = [tavily()],
  operationId = "op-7",
  generation = 4,
): McpConfigurationSnapshotRequest {
  return {
    protocolVersion: 1,
    operationId,
    agentTargetId: "target-1",
    workspaceRoot,
    generation,
    resolvedMcps,
  };
}

function materializer(
  state = new MemoryStateStore(),
  overrides: {
    permissions?: PermissionRestrictor;
    git?: GitWorkspaceGuard;
    atomicReplacer?: AtomicReplacer;
  } = {},
): OpenCodeMcpMaterializer {
  const fs = new DenoMaterializationFileSystem();
  return new OpenCodeMcpMaterializer({
    fileSystem: fs,
    permissions: overrides.permissions ?? new NoopPermissions(),
    atomicReplacer: overrides.atomicReplacer ?? new DenoAtomicReplacer(),
    git: overrides.git ?? new NoopGit(),
    state,
  });
}

async function withWorkspace(
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await Deno.makeTempDir({ prefix: "ora-mcp-" });
  try {
    await run(workspaceRoot);
  } finally {
    await Deno.remove(workspaceRoot, { recursive: true });
  }
}

async function readManaged(workspaceRoot: string): Promise<Uint8Array> {
  return await Deno.readFile(join(workspaceRoot, ".opencode", "opencode.json"));
}

async function expectedTavilyDocument(): Promise<Uint8Array> {
  const key = await nativeMcpKey(tavily().canonicalIdentity);
  return encoder.encode(`${
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [key]: {
            type: "remote",
            url: "https://mcp.tavily.com/mcp",
            enabled: true,
            oauth: false,
            headers: { Authorization: "Bearer tavily-secret-key" },
          },
        },
      },
      null,
      2,
    )
  }\n`);
}

Deno.test("Tavily materializes exact deterministic bytes and complete receipts", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const rootConfig = encoder.encode('{"theme":"user-owned"}\n');
    await Deno.writeFile(join(workspaceRoot, "opencode.json"), rootConfig);
    const state = new MemoryStateStore();
    const permissions = new RecordingPermissions();
    const adapter = materializer(state, { permissions });
    const request = snapshot(workspaceRoot);
    const receipt = await adapter.configureWorkspace(request);
    const bytes = await readManaged(workspaceRoot);
    const expectedBytes = await expectedTavilyDocument();
    assertEquals([...bytes], [...expectedBytes]);
    assertEquals(
      [...await Deno.readFile(join(workspaceRoot, "opencode.json"))],
      [...rootConfig],
    );

    const key = await nativeMcpKey(tavily().canonicalIdentity);
    const entry = JSON.parse(decoder.decode(bytes)).mcp[key];
    assertEquals(receipt, {
      appliedGeneration: 4,
      documentLocator: MANAGED_DOCUMENT_LOCATOR,
      documentFingerprint: await fingerprintBytes(expectedBytes),
      entries: [{
        managedIdentity: "mcp-tavily",
        nativeKey: key,
        entryFingerprint: await fingerprintBytes(
          encoder.encode(JSON.stringify(entry)),
        ),
        sourceRevisionId: "rev-tavily-1",
      }],
    });
    assert(
      /^sha256:[a-f0-9]{64}$/.test(receipt.documentFingerprint),
      "document fingerprint",
    );
    const sharedReceiptFixture = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "./fixtures/mcp-configuration/receipts/valid.json",
          import.meta.url,
        ),
      ),
    );
    assertEquals(Object.keys(receipt), Object.keys(sharedReceiptFixture));
    assertEquals(
      Object.keys(receipt.entries[0]),
      Object.keys(sharedReceiptFixture.entries[0]),
    );
    assertEquals(permissions.calls, 1);
    assertEquals(permissions.sizesBeforeRestriction, [0]);

    // The same operation and snapshot is a byte-for-byte no-op with the same complete receipt.
    assertEquals(await adapter.configureWorkspace(request), receipt);
    assertEquals([...await readManaged(workspaceRoot)], [...expectedBytes]);

    // A configuration revision changes bytes and receipts without changing the native key.
    const updated = await adapter.configureWorkspace(
      snapshot(workspaceRoot, [tavily("Bearer rotated-secret")], "op-8", 5),
    );
    assertEquals(updated.entries[0].nativeKey, receipt.entries[0].nativeKey);
    assert(
      decoder.decode(await readManaged(workspaceRoot)).includes(
        "rotated-secret",
      ),
      "updated bytes",
    );
    assertEquals(permissions.calls, 3);
    assertEquals(permissions.sizesBeforeRestriction, [
      0,
      expectedBytes.length,
      0,
    ]);
  });
});

Deno.test("a completed write before ledger commit is recoverable only by the same operation", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const state = new CommitFailingStateStore();
    const request = snapshot(workspaceRoot);
    const firstError = await captureFailure(
      materializer(state).configureWorkspace(request),
    );
    assertEquals(firstError.code, "mcp_materialization_conflict");
    assertEquals(
      [...await readManaged(workspaceRoot)],
      [...await expectedTavilyDocument()],
    );
    assertEquals(state.values.get("target-1")?.prepared?.operationId, "op-7");

    const differentOperation = await captureFailure(
      materializer(state).configureWorkspace(
        snapshot(workspaceRoot, [tavily()], "op-different"),
      ),
    );
    assertEquals(differentOperation.code, "mcp_materialization_conflict");

    state.failCommit = false;
    const recovered = await materializer(state).configureWorkspace(request);
    assertEquals(
      recovered.documentFingerprint,
      await fingerprintBytes(await expectedTavilyDocument()),
    );
    assertEquals(state.values.get("target-1")?.prepared, undefined);
  });
});

Deno.test("an idempotent replay reapplies restrictive document permissions", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const state = new MemoryStateStore();
    await materializer(state).configureWorkspace(snapshot(workspaceRoot));
    const permissions = new RecordingPermissions();
    const receipt = await materializer(state, { permissions })
      .configureWorkspace(snapshot(workspaceRoot));

    assertEquals(receipt.appliedGeneration, 4);
    assertEquals(permissions.calls, 1);
    assert(
      permissions.sizesBeforeRestriction[0] > 0,
      "the committed document must be restricted on replay",
    );
  });
});

Deno.test("native keys are stable, bounded, character-safe, and collision checked", async () => {
  const identity = "official/ora-space.tavily-search";
  const key = await nativeMcpKey(identity);
  assertEquals(key, "ora_official_ora-space_tavily-search_d6968c95d917");
  assertEquals(await nativeMcpKey(identity), key);
  const longKey = await nativeMcpKey(`official/${"punctuation.".repeat(10)}`);
  assert(longKey.length <= 65, "native key length");
  assert(/^[a-z0-9_-]+$/.test(longKey), "native key character set");

  assertEquals(
    await nativeMcpKey(identity, () => Promise.resolve("a".repeat(64))),
    "ora_official_ora-space_tavily-search_aaaaaaaaaaaa",
  );
  let collision: unknown;
  try {
    assertNoNativeKeyCollisions([
      { canonicalIdentity: "one", nativeKey: "ora_same_aaaaaaaaaaaa" },
      { canonicalIdentity: "two", nativeKey: "ora_same_aaaaaaaaaaaa" },
    ]);
  } catch (error) {
    collision = error;
  }
  assertEquals(
    (collision as McpMaterializationError).code,
    "mcp_native_key_collision",
  );
});

Deno.test("entry ordering and fingerprints do not depend on snapshot order", async () => {
  const other: SnapshotResolvedMcp = {
    canonicalIdentity: "official/alpha",
    managedIdentity: "mcp-alpha",
    packageVersion: "9.9.9",
    sourceRevisionId: "rev-alpha",
    transport: {
      kind: "http",
      url: "https://alpha.example/mcp",
      headers: { Zeta: "z", Alpha: "a" },
    },
  };
  let firstBytes: Uint8Array | undefined;
  let firstFingerprint: string | undefined;
  await withWorkspace(async (workspaceRoot) => {
    const receipt = await materializer().configureWorkspace(
      snapshot(workspaceRoot, [tavily(), other]),
    );
    firstBytes = await readManaged(workspaceRoot);
    firstFingerprint = receipt.documentFingerprint;
  });
  await withWorkspace(async (workspaceRoot) => {
    const receipt = await materializer().configureWorkspace(
      snapshot(workspaceRoot, [other, tavily()]),
    );
    assertEquals([...await readManaged(workspaceRoot)], [...firstBytes!]);
    assertEquals(receipt.documentFingerprint, firstFingerprint);
    assertEquals(receipt.entries.map((entry) => entry.nativeKey), [
      await nativeMcpKey(other.canonicalIdentity),
      await nativeMcpKey(tavily().canonicalIdentity),
    ]);
  });
});

Deno.test("root JSONC native-key collisions block without modifying user state", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const key = await nativeMcpKey(tavily().canonicalIdentity);
    const rootBytes = encoder.encode(`{
      // Preserved user configuration
      "mcp": { "${key}": { "type": "remote", }, },
    }\n`);
    await Deno.writeFile(join(workspaceRoot, "opencode.jsonc"), rootBytes);
    const error = await captureFailure(
      materializer().configureWorkspace(snapshot(workspaceRoot)),
    );
    assertEquals(error.code, "mcp_materialization_conflict");
    assertEquals([
      ...await Deno.readFile(join(workspaceRoot, "opencode.jsonc")),
    ], [...rootBytes]);
    assertEquals(
      await pathExists(join(workspaceRoot, ".opencode", "opencode.json")),
      false,
    );
  });
});

Deno.test("an existing managed-path document is never adopted", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const managedDirectory = join(workspaceRoot, ".opencode");
    await Deno.mkdir(managedDirectory);
    const existing = encoder.encode('{"mcp":{"user":{}}}\n');
    const target = join(managedDirectory, "opencode.json");
    await Deno.writeFile(target, existing);
    const error = await captureFailure(
      materializer().configureWorkspace(snapshot(workspaceRoot)),
    );
    assertEquals(error.code, "mcp_materialization_conflict");
    assertEquals([...await Deno.readFile(target)], [...existing]);
  });
});

Deno.test("a non-Git Workspace skips exclude while retaining permission enforcement", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const fs = new DenoMaterializationFileSystem();
    const replacer = new DenoAtomicReplacer();
    const permissions = new RecordingPermissions();
    const adapter = new OpenCodeMcpMaterializer({
      fileSystem: fs,
      permissions,
      atomicReplacer: replacer,
      git: new RepositoryLocalGitGuard(fs, replacer),
      state: new MemoryStateStore(),
    });
    await adapter.configureWorkspace(snapshot(workspaceRoot));
    assertEquals(permissions.calls, 1);
    assertEquals(permissions.sizesBeforeRestriction, [0]);
    assertEquals(await pathExists(join(workspaceRoot, ".gitignore")), false);
  });
});

Deno.test("a broken Git marker blocks instead of masquerading as a non-Git Workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await Deno.writeTextFile(
      join(workspaceRoot, ".git"),
      "not a gitdir pointer\n",
    );
    const fs = new DenoMaterializationFileSystem();
    const replacer = new DenoAtomicReplacer();
    const adapter = new OpenCodeMcpMaterializer({
      fileSystem: fs,
      permissions: new NoopPermissions(),
      atomicReplacer: replacer,
      git: new RepositoryLocalGitGuard(fs, replacer),
      state: new MemoryStateStore(),
    });
    const error = await captureFailure(
      adapter.configureWorkspace(snapshot(workspaceRoot)),
    );
    assertEquals(error.code, "mcp_config_git_exclude_failed");
    assertEquals(
      await pathExists(join(workspaceRoot, ".opencode", "opencode.json")),
      false,
    );
  });
});

Deno.test("Git workspaces receive only the exact local exclude and reject tracked paths", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await git(workspaceRoot, "init");
    const fs = new DenoMaterializationFileSystem();
    const replacer = new DenoAtomicReplacer();
    const state = new MemoryStateStore();
    const adapter = new OpenCodeMcpMaterializer({
      fileSystem: fs,
      permissions: new NoopPermissions(),
      atomicReplacer: replacer,
      git: new RepositoryLocalGitGuard(fs, replacer),
      state,
    });
    await adapter.configureWorkspace(snapshot(workspaceRoot));
    const excludePath =
      (await git(workspaceRoot, "rev-parse", "--git-path", "info/exclude"))
        .trim();
    const exclude = await Deno.readTextFile(
      /^([A-Za-z]:[\\/]|\/)/.test(excludePath)
        ? excludePath
        : join(workspaceRoot, excludePath),
    );
    assertEquals(
      exclude.split(/\r?\n/).filter((line) =>
        line === "/.opencode/opencode.json"
      ),
      ["/.opencode/opencode.json"],
    );
    assert(
      !exclude.split(/\r?\n/).includes("/.opencode"),
      "directory must not be ignored",
    );
    assertEquals(await pathExists(join(workspaceRoot, ".gitignore")), false);

    await git(workspaceRoot, "add", "-f", ".opencode/opencode.json");
    const changed = tavily("Bearer rotated-secret");
    const error = await captureFailure(
      adapter.configureWorkspace(snapshot(workspaceRoot, [changed], "op-8", 5)),
    );
    assertEquals(error.code, "mcp_config_file_tracked");
  });
});

Deno.test("Git exclude and permission failures leave no plaintext document or staging file", async () => {
  for (
    const overrides of [
      { git: new FailingGit() },
      { permissions: new FailingPermissions() },
    ]
  ) {
    await withWorkspace(async (workspaceRoot) => {
      const error = await captureFailure(
        materializer(new MemoryStateStore(), overrides).configureWorkspace(
          snapshot(workspaceRoot),
        ),
      );
      assert(
        error.code === "mcp_config_git_exclude_failed" ||
          error.code === "mcp_config_permissions_failed",
        "stable preparation failure",
      );
      assertEquals(
        await pathExists(join(workspaceRoot, ".opencode", "opencode.json")),
        false,
      );
      const names = await directoryNames(join(workspaceRoot, ".opencode"));
      assertEquals(names.filter((name) => name.endsWith(".tmp")), []);
    });
  }
});

Deno.test("atomic replacement failure preserves the prior committed document", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const state = new MemoryStateStore();
    const first = materializer(state);
    await first.configureWorkspace(snapshot(workspaceRoot));
    const committed = await readManaged(workspaceRoot);
    const replacement = materializer(state, {
      atomicReplacer: new FailingAtomicReplacer(),
    });
    const error = await captureFailure(replacement.configureWorkspace(
      snapshot(workspaceRoot, [tavily("Bearer rotated-secret")], "op-8", 5),
    ));
    assertEquals(error.code, "mcp_materialization_conflict");
    assertEquals([...await readManaged(workspaceRoot)], [...committed]);
    const competingOperation = await captureFailure(
      materializer(state).configureWorkspace(
        snapshot(
          workspaceRoot,
          [tavily("Bearer another-secret")],
          "op-competing",
          6,
        ),
      ),
    );
    assertEquals(competingOperation.code, "mcp_materialization_conflict");
    assertEquals(
      (await directoryNames(join(workspaceRoot, ".opencode"))).filter((name) =>
        name.endsWith(".tmp")
      ),
      [],
    );
  });
});

Deno.test("a last-moment external replacement blocks the atomic commit", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const state = new MemoryStateStore();
    await materializer(state).configureWorkspace(snapshot(workspaceRoot));
    const target = join(workspaceRoot, ".opencode", "opencode.json");
    const fs = new MutatingReadFileSystem();
    fs.targetPath = target;
    const adapter = new OpenCodeMcpMaterializer({
      fileSystem: fs,
      permissions: new NoopPermissions(),
      atomicReplacer: new DenoAtomicReplacer(),
      git: new NoopGit(),
      state,
    });
    const error = await captureFailure(adapter.configureWorkspace(
      snapshot(workspaceRoot, [tavily("Bearer rotated-secret")], "op-race", 5),
    ));
    assertEquals(error.code, "mcp_materialization_conflict");
    assertEquals(await Deno.readTextFile(target), '{"externally":"raced"}\n');
    assertEquals(
      (await directoryNames(join(workspaceRoot, ".opencode"))).filter((name) =>
        name.endsWith(".tmp")
      ),
      [],
    );
  });
});

Deno.test("last-MCP deletion requires the applied fingerprint and preserves neighbors", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const state = new MemoryStateStore();
    const adapter = materializer(state);
    await adapter.configureWorkspace(snapshot(workspaceRoot));
    const neighbor = join(workspaceRoot, ".opencode", "neighbor.txt");
    await Deno.writeTextFile(neighbor, "preserve me");
    const deleteReceipt = await adapter.configureWorkspace(
      snapshot(workspaceRoot, [], "op-delete", 5),
    );
    assertEquals(deleteReceipt.entries, []);
    assertEquals(
      deleteReceipt.documentFingerprint,
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assertEquals(
      await pathExists(join(workspaceRoot, ".opencode", "opencode.json")),
      false,
    );
    assertEquals(await Deno.readTextFile(neighbor), "preserve me");
    assertEquals(await pathExists(join(workspaceRoot, ".opencode")), true);
  });

  await withWorkspace(async (workspaceRoot) => {
    const state = new MemoryStateStore();
    const adapter = materializer(state);
    await adapter.configureWorkspace(snapshot(workspaceRoot));
    const target = join(workspaceRoot, ".opencode", "opencode.json");
    await Deno.writeTextFile(target, '{"externally":"changed"}\n');
    const error = await captureFailure(
      adapter.configureWorkspace(snapshot(workspaceRoot, [], "op-delete", 5)),
    );
    assertEquals(error.code, "mcp_materialization_conflict");
    assertEquals(await Deno.readTextFile(target), '{"externally":"changed"}\n');
  });
});

Deno.test("errors contain neither authorization values nor resolved URLs", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const error = await captureFailure(
      materializer(new MemoryStateStore(), {
        permissions: new FailingPermissions(),
      }).configureWorkspace(snapshot(workspaceRoot)),
    );
    const rendered = JSON.stringify(error);
    assert(!rendered.includes("tavily-secret-key"), "API key leaked");
    assert(!rendered.includes("Authorization"), "header name leaked");
    assert(!rendered.includes("mcp.tavily.com"), "resolved URL leaked");
  });
});

async function captureFailure(
  operation: Promise<unknown>,
): Promise<McpMaterializationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof McpMaterializationError) return error;
    throw error;
  }
  throw new Error("expected materialization to fail");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names.sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function git(workspaceRoot: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", workspaceRoot, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("temporary Git command failed");
  return decoder.decode(result.stdout);
}
