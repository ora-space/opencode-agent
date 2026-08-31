/**
 * Builds one `.orax` per target for an agent plugin that bundles an upstream CLI.
 *
 * Nothing here names a particular plugin or CLI, and nothing here reaches into a plugin's `src/`:
 * what to download, which asset serves each target, and where the binary lands inside the package
 * all come from `bundle.config.ts`. That is what lets this script and the release workflow be
 * copied to another agent plugin unchanged — including to one that bundles no CLI at all and
 * therefore has no in-package binary path to name.
 *
 * Usage:
 *   deno task package --tag v1.2.3 --repo owner/name
 *
 * Produces `dist/packages/<identifier>-<tag>-<triple>.orax` plus `dist/manifest.toml`, the release
 * form of the manifest the marketplace index needs. `gh` is the only external tool required:
 * archives are read and written in-process so a maintainer can run this anywhere CI can.
 */
import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, relative } from "@std/path";
import { UntarStream } from "@std/tar";
import { BlobReader, ZipReader, ZipWriter } from "@zip-js/zip-js";
import bundle from "../bundle.config.ts";

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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stages the files every package ships, whether or not it also carries a CLI.
 *
 * `target` is the triple a bundled package self-declares in `[artifact]`, which is what lets Ora
 * verify after extraction that the package it downloaded is really the one built for this machine.
 * A universal package declares none: it carries no binary whose host compatibility could be wrong,
 * and an `[artifact]` section on it would make Ora check the one thing it cannot promise.
 */
async function stagePluginFiles(target: string | undefined): Promise<void> {
  await Deno.mkdir(STAGE_DIR, { recursive: true });
  await Deno.copyFile(join(DIST, "main.js"), join(STAGE_DIR, "main.js"));
  for (const extra of ["logo.svg", "README.md"]) {
    await Deno.copyFile(extra, join(STAGE_DIR, extra)).catch(() => {});
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
  fileName: string,
): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  const staged = join(STAGE_DIR, plan.binaryPath);
  await Deno.mkdir(dirname(staged), { recursive: true });

  const archive = join(DOWNLOAD_DIR, plan.asset);
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
  // Upstream ships the CLI as the sole entry at the archive root, under the same name this
  // package uses for it.
  await extractEntry(archive, basename(plan.binaryPath), staged);

  await stagePluginFiles(plan.triple);
  await writeOrax(STAGE_DIR, join(PACKAGES_DIR, fileName), plan.binaryPath);
  await Deno.remove(STAGE_DIR, { recursive: true });
  await Deno.remove(archive).catch(() => {});
}

/** Stages the one package every host can install, which runs the user's own CLI. */
async function buildUniversalPackage(fileName: string): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  await stagePluginFiles(/*target*/ undefined);
  await writeOrax(
    STAGE_DIR,
    join(PACKAGES_DIR, fileName),
    /*executable*/ undefined,
  );
  await Deno.remove(STAGE_DIR, { recursive: true });
}

/**
 * Builds every package this release publishes and returns the release-form manifest body.
 *
 * The two shapes produce different release sources — one `[[targets]]` entry per bundled package,
 * or a single `url`/`sha256` pair — and Ora rejects a manifest carrying both, which is why the
 * choice is made once here rather than merged afterwards.
 */
async function buildRelease(
  identifier: string,
  tag: string,
  repo: string,
): Promise<string> {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  let manifest = (await Deno.readTextFile("orax.toml")).trimEnd();

  if (config.cli === "user_installed") {
    const fileName = `${identifier}-${tag}.orax`;
    await buildUniversalPackage(fileName);
    const digest = await sha256Hex(join(PACKAGES_DIR, fileName));
    console.log(`packaged ${fileName} (no bundled CLI)`);
    return `${manifest}\n\nurl = "${base}/${fileName}"\nsha256 = "${digest}"`;
  }

  await Deno.mkdir(DOWNLOAD_DIR, { recursive: true });
  // Resolved once so every package in this release bundles the same CLI build: one "latest"
  // lookup per target could straddle an upstream release and ship a version skew that only some
  // platforms would ever see.
  const upstreamTag = await run(
    "gh",
    "release",
    "view",
    "--repo",
    config.upstream,
    "--json",
    "tagName",
    "--jq",
    ".tagName",
  );
  console.log(`Bundling ${config.upstream} ${upstreamTag}`);

  for (const [triple, asset] of Object.entries(config.assets)) {
    const plan: TargetPlan = {
      triple,
      asset,
      binaryPath: config.binaryPath(osOfTriple(triple)),
    };
    const fileName = `${identifier}-${tag}-${triple}.orax`;
    await buildBundledPackage(plan, config.upstream, upstreamTag, fileName);

    const digest = await sha256Hex(join(PACKAGES_DIR, fileName));
    manifest +=
      `\n\n[[targets]]\ntarget = "${triple}"\nurl = "${base}/${fileName}"\nsha256 = "${digest}"`;
    console.log(`packaged ${fileName}`);
  }
  await Deno.remove(DOWNLOAD_DIR, { recursive: true }).catch(() => {});
  console.log(`\nUpstream CLI: ${upstreamTag}`);
  return manifest;
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, { string: ["tag", "repo"] });
  const tag = flags.tag ?? Deno.env.get("GITHUB_REF_NAME");
  const repo = flags.repo ?? Deno.env.get("GITHUB_REPOSITORY");
  if (tag === undefined || repo === undefined) {
    throw new Error("both --tag and --repo are required");
  }

  const identifier = await manifestField("identifier");
  await Deno.mkdir(PACKAGES_DIR, { recursive: true });

  const manifest = await buildRelease(identifier, tag, repo);

  // The marketplace index needs the release form of the manifest, which carries the download URLs
  // and digests. It is only knowable once the packages exist, so it is generated here rather than
  // committed.
  await Deno.writeTextFile(join(DIST, "manifest.toml"), `${manifest}\n`);
}

if (import.meta.main) {
  await main();
}
