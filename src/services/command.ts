import {
  AGENT_NOT_INSTALLED,
  HostRequestError,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import { bundledBinaryPath } from "./bundled-binary.ts";

/**
 * Names the program that launches OpenCode, in the shape `HostProcesses.spawn` accepts.
 *
 * The two forms decide who resolves the path. `packageCommand` is package-relative and resolved
 * by the host against this plugin's install root; `command` is handed to the operating system.
 */
export type OpenCodeProgram =
  | { packageCommand: string; command?: never }
  | { command: string; packageCommand?: never };

/**
 * Resolves the program that launches OpenCode.
 *
 * The bundled binary is the normal answer, and this plugin never learns — or computes — the host
 * path it lives at. `ORA_OPENCODE_BIN` stays as the one escape hatch: a developer running a
 * locally built OpenCode has no way to get that binary into an installed package.
 */
export function resolveOpenCodeProgram(): OpenCodeProgram {
  const explicit = readEnv("ORA_OPENCODE_BIN");
  if (explicit !== undefined && explicit.trim() !== "") {
    return { command: explicit.trim() };
  }
  return { packageCommand: bundledBinaryPath() };
}

/**
 * Rethrows one spawn failure under the classification the host should act on.
 *
 * A missing `ORA_OPENCODE_BIN` target is local configuration, which Ora retries quietly. A bundled
 * binary that will not resolve is a broken or wrong-target package: it fails identically on every
 * retry, so reporting it as `agent_not_installed` would bury it under an infinite silent retry
 * loop instead of surfacing the agent as failing.
 */
export function rethrowSpawnFailure(
  program: OpenCodeProgram,
  error: unknown,
): never {
  const notFound = error instanceof HostRequestError &&
    error.kind === "program_not_found";
  if (notFound && program.command !== undefined) {
    throw new PluginMethodError(
      AGENT_NOT_INSTALLED,
      `ORA_OPENCODE_BIN points at ${program.command}, which does not exist`,
    );
  }
  throw error instanceof Error ? error : new Error(String(error));
}

/** Reads an env var, treating a missing read permission as an unset value. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // The host may not grant --allow-env; absence is indistinguishable from "not set".
    return undefined;
  }
}
