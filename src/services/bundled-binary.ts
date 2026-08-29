/**
 * The one place that decides where the bundled CLI lives inside the package.
 *
 * Two very different callers depend on this agreeing: `command.ts` asks the host to spawn this
 * path at runtime, and the release packaging script stages the upstream binary at it. A mismatch
 * would only surface as a broken install, so both derive it from here rather than each spelling
 * the path out.
 */

/** Directory inside the package that holds the bundled CLI. */
export const BUNDLED_BIN_DIR = "assets/bin";

/** Operating systems a package can be built for, as `Deno.build.os` spells them. */
export type TargetOs = typeof Deno.build.os;

/**
 * Names the bundled CLI for one target operating system.
 *
 * Windows decides executability by extension at spawn time, so the suffix is not cosmetic: a
 * `.exe`-less binary there exists but cannot be started.
 */
export function bundledBinaryName(os: TargetOs): string {
  return os === "windows" ? "opencode.exe" : "opencode";
}

/**
 * Returns the package-relative path of the bundled CLI for one target operating system.
 *
 * The path carries no architecture segment: releases are built one package per target, so the
 * binary that reaches a machine is already the right one.
 */
export function bundledBinaryPath(os: TargetOs = Deno.build.os): string {
  return `${BUNDLED_BIN_DIR}/${bundledBinaryName(os)}`;
}
