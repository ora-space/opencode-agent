/**
 * Builds one `.orax` per target for an agent plugin that bundles an upstream CLI.
 *
 * Nothing here names a particular plugin or CLI, and nothing here reaches into a plugin's `src/`:
 * which asset serves each target and where the binary lands inside the package come from
 * `bundle.config.ts`; the exact upstream release to bundle — resolved and verified ahead of time
 * by `deno task sync` — comes from `upstream.lock.json`. That is what lets this script and the
 * release workflow be copied to another agent plugin unchanged — including to one that bundles no
 * CLI at all and therefore has no in-package binary path to name, and no lock to read.
 *
 * Usage:
 *   deno task package --tag v1.2.3 --repo owner/name
 *   deno task package --tag v1.2.3 --repo owner/name --agent-configuration
 *                                            # also ship and bind the Agent declaration
 *
 * Produces `dist/packages/<identifier>-<tag>-<triple>.orax` plus `dist/manifest.toml`, the release
 * form of the manifest the marketplace index needs. `gh` is the only external tool required:
 * archives are read and written in-process so a maintainer can run this anywhere CI can.
 *
 * `--agent-configuration` is the publish-order switch for the Agent declaration
 * (`assets/config.json`): with it, every package carries the declaration, the release manifest
 * gains an `[agent_configuration]` section binding its digest, and `dist/agent-configuration.json`
 * — the static copy the marketplace reads beside the entry — is written. Without it, packages
 * carry no declaration and current Ora hosts install the release exactly as before. An
 * `agent`-kind package whose declaration a host cannot compile installs but then refuses to
 * activate, so the switch is flipped only once the hosts that resolve it are deployed — an owner
 * decision made by editing one line of the release workflow, not something this script detects.
 */
import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, relative } from "@std/path";
import { UntarStream } from "@std/tar";
import { BlobReader, ZipReader, ZipWriter } from "@zip-js/zip-js";
import bundle from "../bundle.config.ts";
import { LOCK_PATH, readLock, verifyIntegrity } from "./upstream.ts";

/** Operating systems a package can be built for, as `Deno.build.os` spells them. */
export type TargetOs = typeof Deno.build.os;

/**
 * How a plugin reaches the CLI it drives, which is what decides the shape of its release.
 *
 * The two are mutually exclusive per release, because a marketplace release carries either one
 * universal artifact or one artifact per target triple, never both. Bundling produces a package
 * per declared target, each refusing to install on a machine it was not built for; the other
 * produces a single package installable everywhere, which resolves the user's own install from
 * PATH at spawn time. The plugin source is identical either way — it discovers which package it
 * is running from when it spawns.
 */
export type BundleConfig =
  | {
    cli: "bundled";
    /** GitHub `owner/name` the CLI is released from. */
    upstream: string;
    /** An explicitly selected npm distribution; never resolves latest at package time. */
    npm?: { package: string; version: string };
    /** Release asset serving each canonical Rust target triple. */
    assets: Record<string, string>;
    /**
     * Package-relative path this target's binary is staged at, which the plugin later asks the
     * host to spawn.
     *
     * Supplied by the plugin rather than fixed here so the staging path and the path the running
     * plugin names stay one decision: a mismatch between them would only ever surface as an
     * install that cannot start its agent.
     */
    binaryPath: (os: TargetOs) => string;
  }
  | { cli: "user_installed" };

/**
 * This plugin's own declaration, widened to the union this script handles.
 *
 * `bundle.config.ts` states one concrete shape, which narrows its type to that arm alone and would
 * make the other arm look like dead code here. The script must compile against both, since which
 * arm a plugin picks is exactly what it is generic over.
 */
const config: BundleConfig = bundle;

/** One target's resolved packaging inputs. */
interface TargetPlan {
  triple: string;
  asset: string;
  /** Package-relative path the binary is staged at, and the plugin later asks the host to spawn. */
  binaryPath: string;
}

const DIST = "dist";
const PACKAGES_DIR = join(DIST, "packages");
const DOWNLOAD_DIR = join(DIST, "download");
const STAGE_DIR = join(DIST, "stage");

/** Package-relative path of the Agent declaration a release carries when it binds one. */
const DECLARATION_ENTRY = "assets/config.json";

/** The static copy's name, both as a release asset and inside a marketplace registry entry. */
const DECLARATION_COPY = "agent-configuration.json";

/** The declaration size bound the host's compiler enforces; a larger file could never install. */
const MAX_DECLARATION_BYTES = 256 * 1024;

/** Runs one command, failing loudly rather than letting a broken package be published. */
async function run(command: string, ...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${code}: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Derives the operating system a canonical Rust target triple runs on.
 *
 * Only the OS is needed, and only to name the binary: the architecture never changes the package
 * layout, because one package serves exactly one triple.
 */
function osOfTriple(triple: string): TargetOs {
  if (triple.includes("-windows-")) return "windows";
  if (triple.includes("-apple-")) return "darwin";
  if (triple.includes("-linux-")) return "linux";
  throw new Error(`cannot derive an operating system from target ${triple}`);
}

/** Reads one required field out of the installed manifest this repository ships. */
async function manifestField(field: string): Promise<string> {
  const source = await Deno.readTextFile("orax.toml");
  const match = source.match(new RegExp(`^${field}\\s*=\\s*"(.*)"`, "m"));
  if (match === null) {
    throw new Error(`orax.toml declares no ${field}`);
  }
  return match[1];
}

/**
 * Reads the one file named `entry` out of an upstream archive and writes it to `destination`.
 *
 * Archives are read in-process rather than by shelling out to `tar`/`unzip` so this script runs
 * the same way on a maintainer's machine as it does in CI, whatever that machine is. Only the
 * bytes are taken: the upstream mode is not consulted, because the staged file is chmod'ed to a
 * known-good mode below regardless of what upstream happened to record.
 */
async function extractEntry(
  archive: string,
  entry: string,
  destination: string,
): Promise<void> {
  if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    const stream = (await Deno.open(archive)).readable
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new UntarStream());
    for await (const item of stream) {
      if (item.path !== entry || item.readable === undefined) {
        await item.readable?.cancel();
        continue;
      }
      await item.readable.pipeTo((await Deno.create(destination)).writable);
      return;
    }
    throw new Error(`${archive} does not contain ${entry}`);
  }
  if (archive.endsWith(".zip")) {
    const reader = new ZipReader(new BlobReader(await openBlob(archive)));
    try {
      for (const item of await reader.getEntries()) {
        // A directory entry carries no reader; only the named file is of interest anyway.
        if (item.filename !== entry || item.directory) continue;
        const file = await Deno.create(destination);
        await item.getData!(file.writable);
        return;
      }
    } finally {
      await reader.close();
    }
    throw new Error(`${archive} does not contain ${entry}`);
  }
  throw new Error(`unsupported upstream archive format: ${archive}`);
}

/** Reads one file as a Blob, which is what `zip-js` takes as a random-access source. */
async function openBlob(path: string): Promise<Blob> {
  return new Blob([await Deno.readFile(path)]);
}

/**
 * Writes one staged directory tree into a `.orax`, recording the execute bit on `executable`.
 *
 * The execute bit is what makes the bundled CLI spawnable after Ora extracts the package, and a
 * ZIP carries it in the upper 16 bits of the external file attributes. A fixed `0o100755` is
 * written rather than whatever upstream recorded, so the package can never install a setuid or
 * otherwise surprising mode. A package that bundles no CLI names no executable: everything it
 * ships is data Ora reads, and nothing in it is ever spawned.
 */
async function writeOrax(
  stageDir: string,
  destination: string,
  executable: string | undefined,
): Promise<void> {
  const file = await Deno.create(destination);
  const writer = new ZipWriter(file.writable);
  for await (const entry of walk(stageDir)) {
    const relative = relativeSlashPath(stageDir, entry);
    await writer.add(relative, new BlobReader(await openBlob(entry)), {
      externalFileAttribute: relative === executable
        ? (0o100_755 << 16) >>> 0
        : (0o100_644 << 16) >>> 0,
    });
  }
  await writer.close();
}

/** Yields every ordinary file under `root`, depth first. */
async function* walk(root: string): AsyncGenerator<string> {
  for await (const item of Deno.readDir(root)) {
    const path = join(root, item.name);
    if (item.isDirectory) {
      yield* walk(path);
    } else if (item.isFile) {
      yield path;
    }
  }
}

/** Renders one path below `root` as the slash-separated name a ZIP entry carries. */
function relativeSlashPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

/** Returns the lowercase hex SHA-256 of one file, the spelling `sha256` takes in a manifest. */
async function sha256Hex(path: string): Promise<string> {
  return sha256Bytes(await Deno.readFile(path));
}

/** Returns the lowercase hex SHA-256 of exact bytes. */
async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Matches every logo asset a plugin might carry: `logo.svg`, a themed variant like
 * `logo.dark.svg`, and the same two shapes for the raster formats marketplaces also accept.
 */
const LOGO_PATTERN = /^logo(\.[^./]+)?\.(svg|png|jpe?g|webp)$/i;

/** Every logo file in the plugin root, discovered by name rather than a fixed list. */
async function findLogoFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(".")) {
    if (entry.isFile && LOGO_PATTERN.test(entry.name)) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * Stages the files every package ships, whether or not it also carries a CLI.
 *
 * `target` is the triple a bundled package self-declares in `[artifact]`, which is what lets Ora
 * verify after extraction that the package it downloaded is really the one built for this machine.
 * A universal package declares none: it carries no binary whose host compatibility could be wrong,
 * and an `[artifact]` section on it would make Ora check the one thing it cannot promise.
 * `includeDeclaration` is the `--agent-configuration` switch described at the top of this file.
 */
async function stagePluginFiles(
  target: string | undefined,
  includeDeclaration: boolean,
): Promise<void> {
  await Deno.mkdir(STAGE_DIR, { recursive: true });
  await Deno.copyFile(join(DIST, "main.js"), join(STAGE_DIR, "main.js"));
  for (const extra of [...await findLogoFiles(), "README.md"]) {
    await Deno.copyFile(extra, join(STAGE_DIR, extra)).catch(() => {});
  }
  if (includeDeclaration) {
    await Deno.mkdir(dirname(join(STAGE_DIR, DECLARATION_ENTRY)), {
      recursive: true,
    });
    await Deno.copyFile(DECLARATION_ENTRY, join(STAGE_DIR, DECLARATION_ENTRY));
  }
  const manifest = (await Deno.readTextFile("orax.toml")).trimEnd();
  const artifact = target === undefined
    ? ""
    : `\n\n[artifact]\ntarget = "${target}"`;
  await Deno.writeTextFile(
    join(STAGE_DIR, "orax.toml"),
    `${manifest}${artifact}\n`,
  );
}

/** Stages one target's package tree, CLI included, and zips it into a `.orax`. */
async function buildBundledPackage(
  plan: TargetPlan,
  upstream: string,
  upstreamTag: string,
  expectedSha256: string | undefined,
  fileName: string,
  includeDeclaration: boolean,
  npmAsset?: { url: string; integrity: string },
): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  const staged = join(STAGE_DIR, plan.binaryPath);
  await Deno.mkdir(dirname(staged), { recursive: true });

  const archive = join(
    DOWNLOAD_DIR,
    npmAsset ? `${plan.triple}.tgz` : plan.asset,
  );
  if (npmAsset) {
    const response = await fetch(npmAsset.url, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyIntegrity(bytes, npmAsset.integrity);
    await Deno.writeFile(archive, bytes);
  } else {
    await run(
      "gh",
      "release",
      "download",
      upstreamTag,
      "--repo",
      upstream,
      "--pattern",
      plan.asset,
      "--dir",
      DOWNLOAD_DIR,
      "--clobber",
    );
  }
  // A GitHub-release download is checked against the digest `deno task sync` recorded from the
  // Releases API, which catches upstream replacing an asset under a tag this plugin already
  // pinned. An npm archive was already checked against its `dist.integrity` SRI above, before it
  // was written, so only the release branch has a digest left to verify here.
  const actualSha256 = npmAsset ? undefined : await sha256Hex(archive);
  if (!npmAsset && actualSha256 !== expectedSha256) {
    throw new Error(
      `${plan.asset} sha256 ${actualSha256} does not match ${LOCK_PATH}'s pinned ${expectedSha256}; run 'deno task sync'`,
    );
  }
  // The CLI sits at the archive root in a GitHub release and under `package/bin/` in an npm
  // tarball; either way the staged file keeps the name this package asks the host to spawn.
  await extractEntry(
    archive,
    npmAsset
      ? `package/bin/${basename(plan.binaryPath)}`
      : basename(plan.binaryPath),
    staged,
  );

  await stagePluginFiles(plan.triple, includeDeclaration);
  await writeOrax(STAGE_DIR, join(PACKAGES_DIR, fileName), plan.binaryPath);
  await Deno.remove(STAGE_DIR, { recursive: true });
  await Deno.remove(archive).catch(() => {});
}

/** Stages the one package every host can install, which runs the user's own CLI. */
async function buildUniversalPackage(
  fileName: string,
  includeDeclaration: boolean,
): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  await stagePluginFiles(/*target*/ undefined, includeDeclaration);
  await writeOrax(
    STAGE_DIR,
    join(PACKAGES_DIR, fileName),
    /*executable*/ undefined,
  );
  await Deno.remove(STAGE_DIR, { recursive: true });
}

/**
 * Builds every package this release publishes and returns where each one is downloaded from.
 *
 * The two shapes produce different release sources — one `[[targets]]` entry per bundled package,
 * or a single `url`/`sha256` pair — and Ora rejects a manifest carrying both, which is why the
 * choice is made once here rather than merged afterwards.
 */
async function buildRelease(
  identifier: string,
  tag: string,
  repo: string,
  includeDeclaration: boolean,
): Promise<{ source: ReleaseSource; packages: string[] }> {
  const base = `https://github.com/${repo}/releases/download/${tag}`;

  if (config.cli === "user_installed") {
    const fileName = `${identifier}-${tag}.orax`;
    await buildUniversalPackage(fileName, includeDeclaration);
    const path = join(PACKAGES_DIR, fileName);
    console.log(`packaged ${fileName} (no bundled CLI)`);
    return {
      source: {
        kind: "universal",
        url: `${base}/${fileName}`,
        sha256: await sha256Hex(path),
      },
      packages: [path],
    };
  }
  const targets: ReleaseTarget[] = [];
  const packages: string[] = [];

  await Deno.mkdir(DOWNLOAD_DIR, { recursive: true });
  // Read, never resolved here: `deno task sync` is the only thing allowed to ask GitHub what
  // "latest" means. Rebuilding an existing tag must reproduce exactly the release it already
  // shipped, and a "latest" lookup at package time could straddle an upstream release and ship a
  // version skew a rebuild would not repeat.
  const lock = await readLock();
  if (
    config.npm &&
    (lock.npm?.package !== config.npm.package ||
      lock.npm.version !== config.npm.version)
  ) {
    throw new Error(
      "npm configuration differs from upstream.lock.json; run 'deno task sync'",
    );
  }
  if (!config.npm && lock.npm) {
    throw new Error("unexpected npm lock for GitHub configuration");
  }
  console.log(`Bundling ${lock.repo} ${lock.tag}`);

  for (const [triple, asset] of Object.entries(config.assets)) {
    const pinned = lock.assets[triple];
    if (pinned === undefined) {
      throw new Error(
        `${LOCK_PATH} pins no asset for ${triple}; run 'deno task sync'`,
      );
    }
    if (pinned.name !== asset) {
      throw new Error(
        `${LOCK_PATH} pins ${pinned.name} for ${triple}, but bundle.config.ts now names ${asset}; run 'deno task sync'`,
      );
    }
    if (config.npm ? !pinned.npm : !pinned.sha256 || pinned.npm) {
      throw new Error(`missing or mismatched integrity source for ${triple}`);
    }
    if (
      pinned.npm &&
      new URL(pinned.npm.url).origin !== "https://registry.npmjs.org"
    ) {
      throw new Error(`unexpected npm download origin for ${triple}`);
    }
    const plan: TargetPlan = {
      triple,
      asset,
      binaryPath: config.binaryPath(osOfTriple(triple)),
    };
    const fileName = `${identifier}-${tag}-${triple}.orax`;
    await buildBundledPackage(
      plan,
      lock.repo,
      lock.tag,
      pinned.sha256,
      fileName,
      includeDeclaration,
      pinned.npm,
    );

    const path = join(PACKAGES_DIR, fileName);
    targets.push({
      triple,
      url: `${base}/${fileName}`,
      sha256: await sha256Hex(path),
    });
    packages.push(path);
    console.log(`packaged ${fileName}`);
  }
  await Deno.remove(DOWNLOAD_DIR, { recursive: true }).catch(() => {});
  console.log(`\nUpstream CLI: ${lock.tag}`);
  return { source: { kind: "targets", targets }, packages };
}

/** One built per-target package, as the release form of the manifest advertises it. */
export interface ReleaseTarget {
  /** The canonical Rust triple this package installs on. */
  triple: string;
  url: string;
  sha256: string;
}

/**
 * Where a release's packages are downloaded from: one universal package, or one per target.
 *
 * Ora rejects a manifest carrying both, which is why a release is exactly one of the two.
 */
export type ReleaseSource =
  | { kind: "universal"; url: string; sha256: string }
  | { kind: "targets"; targets: ReleaseTarget[] };

/** One release's verified Agent declaration, as the marketplace entry binds it. */
export interface AgentConfigurationAssociation {
  /** Declaration schema version the published copy declares. */
  schemaVersion: number;
  /** Lowercase hex SHA-256 of the exact declaration bytes every package of this release carries. */
  declarationSha256: string;
  /** Registry-entry-relative path of the static copy the marketplace sync reads. */
  copy: string;
}

/**
 * Renders the release form of the manifest, which is what a marketplace entry is copied from.
 *
 * TOML binds a bare key to the table header above it, so the order is load bearing: the installed
 * manifest's own keys, then a universal package's top-level `url`/`sha256`, then the
 * `[agent_configuration]` table when the release binds a declaration, then the `[[targets]]`
 * blocks. A universal `url` written below a table would silently become part of that table.
 */
export function releaseManifest(
  installed: string,
  source: ReleaseSource,
  agentConfiguration?: AgentConfigurationAssociation,
): string {
  const sections = [installed.trimEnd()];
  if (source.kind === "universal") {
    sections[0] += `\n\nurl = "${source.url}"\nsha256 = "${source.sha256}"`;
  }
  if (agentConfiguration !== undefined) {
    sections.push(
      `[agent_configuration]\nschema_version = ${agentConfiguration.schemaVersion}\n` +
        `declaration_sha256 = "${agentConfiguration.declarationSha256}"\n` +
        `copy = "${agentConfiguration.copy}"`,
    );
  }
  if (source.kind === "targets") {
    sections.push(
      ...source.targets.map((target) =>
        `[[targets]]\ntarget = "${target.triple}"\nurl = "${target.url}"\n` +
        `sha256 = "${target.sha256}"`
      ),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * Reads the declaration bytes back out of a built package, or `undefined` when it carries none.
 *
 * The release association is derived from what the archive actually carries, not from the file
 * that was staged into it: reading the entry back is what proves the copy a marketplace will
 * publish is byte-identical to the declaration every target installs.
 */
export async function packagedDeclaration(
  archive: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const zip = new ZipReader(new BlobReader(await openBlob(archive)));
  try {
    for (const entry of await zip.getEntries()) {
      if (entry.filename === DECLARATION_ENTRY && !entry.directory) {
        return new Uint8Array(await entry.arrayBuffer());
      }
    }
    return undefined;
  } finally {
    await zip.close();
  }
}

/**
 * Builds the release association from the bytes the packages actually carry.
 *
 * The digest is over the exact bytes, so a reformatted declaration is a different release
 * identity by construction. Only what this script owns is checked — readable UTF-8, a positive
 * integer `schemaVersion` and the host's size bound; whether the declaration is legal is proven by
 * the host compilers at marketplace sync and install, not re-implemented here.
 */
export async function declarationAssociation(
  declaration: Uint8Array<ArrayBuffer>,
): Promise<AgentConfigurationAssociation> {
  if (declaration.byteLength > MAX_DECLARATION_BYTES) {
    throw new Error(
      `${DECLARATION_ENTRY} is ${declaration.byteLength} bytes, over the ` +
        `${MAX_DECLARATION_BYTES}-byte bound every host enforces`,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(declaration);
  const parsed = JSON.parse(text) as { schemaVersion?: unknown } | null;
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof parsed.schemaVersion !== "number" ||
    !Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < 1
  ) {
    throw new Error(
      `${DECLARATION_ENTRY} declares no positive integer schemaVersion`,
    );
  }
  return {
    schemaVersion: parsed.schemaVersion,
    declarationSha256: await sha256Bytes(declaration),
    copy: DECLARATION_COPY,
  };
}

/**
 * Proves every package carries the same declaration, or none, and returns its association.
 *
 * A release binds exactly one declaration digest, so one package with different bytes — or one
 * missing them — would install a declaration identity the manifest does not name.
 */
async function bindDeclaration(
  packages: readonly string[],
): Promise<AgentConfigurationAssociation> {
  let bound: Uint8Array<ArrayBuffer> | undefined;
  for (const archive of packages) {
    const carried = await packagedDeclaration(archive);
    if (carried === undefined) {
      throw new Error(`${archive} carries no ${DECLARATION_ENTRY}`);
    }
    if (bound !== undefined && !bytesEqual(bound, carried)) {
      throw new Error(
        `${archive} carries different ${DECLARATION_ENTRY} bytes`,
      );
    }
    bound = carried;
  }
  if (bound === undefined) {
    throw new Error("the release built no package to bind a declaration to");
  }
  await Deno.writeFile(join(DIST, DECLARATION_COPY), bound);
  return await declarationAssociation(bound);
}

/** Compares two byte sequences; `Uint8Array` has no equality of its own. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["tag", "repo"],
    boolean: ["agent-configuration"],
  });
  const tag = flags.tag ?? Deno.env.get("GITHUB_REF_NAME");
  const repo = flags.repo ?? Deno.env.get("GITHUB_REPOSITORY");
  if (tag === undefined || repo === undefined) {
    throw new Error("both --tag and --repo are required");
  }

  const identifier = await manifestField("identifier");
  await Deno.mkdir(PACKAGES_DIR, { recursive: true });

  const includeDeclaration = flags["agent-configuration"];
  // A stale copy from an earlier declaration-binding build must not be published by this one.
  await Deno.remove(join(DIST, DECLARATION_COPY)).catch(() => {});
  const { source, packages } = await buildRelease(
    identifier,
    tag,
    repo,
    includeDeclaration,
  );
  const association = includeDeclaration
    ? await bindDeclaration(packages)
    : undefined;

  // The marketplace index needs the release form of the manifest, which carries the download URLs
  // and digests. It is only knowable once the packages exist, so it is generated here rather than
  // committed.
  await Deno.writeTextFile(
    join(DIST, "manifest.toml"),
    releaseManifest(
      await Deno.readTextFile("orax.toml"),
      source,
      association,
    ),
  );
}

if (import.meta.main) {
  await main();
}
