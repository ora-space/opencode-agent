/**
 * Bumps this plugin's own release version, in the one place a release reads it.
 *
 * The version counts this plugin's releases, not the upstream CLI's: an upstream bump is one of
 * the things that causes a release, but the two move independently. The nightly `upstream.yml`
 * runs this after refreshing `upstream.lock.json`, and `release.yml` then refuses a tag that
 * disagrees with the manifest.
 *
 * A suffixed experiment line keeps its own counter instead of being forced back onto the plain
 * patch sequence:
 *
 *   `0.6.11`            -> `0.6.12`            no suffix: the patch number moves
 *   `0.7.0-opencode2.1` -> `0.7.0-opencode2.2` suffix: its trailing counter moves
 *   `0.7.0-opencode2`   -> `0.7.0-opencode2.1` no counter yet: start one
 *
 * Anything else is refused rather than guessed at: a version the rule cannot describe is a
 * maintainer decision, and a wrong guess publishes a package under a number nobody chose.
 */

/** The manifest `release.yml` compares the tag against, and the only file this script writes. */
export const MANIFEST_PATH = "orax.toml";

/**
 * `MAJOR.MINOR.PATCH`, optionally followed by a `-SUFFIX` of dot-separated identifiers.
 *
 * Deliberately stricter than semver's full grammar: build metadata (`+…`) and empty identifiers
 * are outside what this repository's versions use, and accepting them would mean inventing a bump
 * rule for something no release has carried.
 */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** A `version = "…"` line, split into its prefix, value and tail so only the value changes. */
const VERSION_LINE = /^(version *= *")([^"]*)(" *)$/m;

/** Returns the version one automated release ahead of `version`. */
export function bumpVersion(version: string): string {
  const match = VERSION.exec(version);
  if (match === null) {
    throw new Error(
      `${version} is not MAJOR.MINOR.PATCH[-SUFFIX]; bump it by hand`,
    );
  }
  const [, major, minor, patch, suffix] = match;
  if (suffix === undefined) return `${major}.${minor}.${Number(patch) + 1}`;
  const segments = suffix.split(".");
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = /^\d+$/.test(last)
    ? String(Number(last) + 1)
    : `${last}.1`;
  return `${major}.${minor}.${patch}-${segments.join(".")}`;
}

/** What one manifest bump changed, so a caller can report it without re-reading the file. */
export interface ManifestBump {
  current: string;
  next: string;
  /** The manifest with its version line bumped and every other byte untouched. */
  text: string;
}

/** Bumps the version line of a manifest, leaving every other byte of it alone. */
export function bumpManifest(text: string): ManifestBump {
  const line = VERSION_LINE.exec(text);
  if (line === null) {
    throw new Error(`${MANIFEST_PATH} has no single-line version = "…" entry`);
  }
  const current = line[2];
  const next = bumpVersion(current);
  return {
    current,
    next,
    text: `${text.slice(0, line.index)}${line[1]}${next}${line[3]}${
      text.slice(line.index + line[0].length)
    }`,
  };
}

async function main(): Promise<void> {
  const source = await Deno.readTextFile(MANIFEST_PATH);
  const bumped = bumpManifest(source);
  await Deno.writeTextFile(MANIFEST_PATH, bumped.text);
  // stdout carries the bare version so a workflow can tag it; the rest is a log line.
  console.log(bumped.next);
  console.error(`bumped ${MANIFEST_PATH} ${bumped.current} -> ${bumped.next}`);
}

if (import.meta.main) await main();
