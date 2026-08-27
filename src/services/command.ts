import {
  AGENT_NOT_INSTALLED,
  HostRequestError,
  PluginMethodError,
} from "@ora-space/plugin-sdk";

/** Names one concrete way to launch the OpenCode CLI. */
export interface OpenCodeCommand {
  command: string;
  extraArgs: string[];
}

/**
 * Resolves the command that launches OpenCode.
 *
 * `ORA_OPENCODE_BIN` pins an explicit binary path, which matters on Windows where npm only
 * exposes a `.cmd` shim on PATH. Otherwise the platform default is used and expanded by
 * {@link spawnCandidates}.
 */
export function resolveOpenCodeCommand(): OpenCodeCommand {
  const explicit = readEnv("ORA_OPENCODE_BIN");
  if (explicit !== undefined && explicit.trim() !== "") {
    return { command: explicit.trim(), extraArgs: [] };
  }
  return Deno.build.os === "windows"
    ? { command: "opencode.cmd", extraArgs: [] }
    : { command: "opencode", extraArgs: [] };
}

/**
 * Expands one resolved command into spawn candidates in priority order.
 *
 * npm installs only a `.cmd` shim on Windows while scoop and choco expose `opencode.exe`; trying
 * both keeps either installation style working with no user configuration.
 */
export function spawnCandidates(command: string): string[] {
  if (Deno.build.os !== "windows") {
    return [command];
  }
  const fallback = command.toLowerCase().endsWith(".cmd")
    ? "opencode"
    : "opencode.cmd";
  return command === fallback ? [command] : [command, fallback];
}

/**
 * Classifies a spawn failure as a missing binary.
 *
 * The host spawns the process now, so this is the host's own classification
 * (`program_not_found` means the OS could not resolve the executable) rather than sniffing
 * platform-specific error text.
 */
export function isCommandNotFound(error: unknown): boolean {
  return error instanceof HostRequestError &&
    error.kind === "program_not_found";
}

/**
 * Runs `attempt` against every candidate for the resolved OpenCode command.
 *
 * The first candidate that does not throw wins. Failures are classified on the way out: a
 * failure that is not "binary missing" is the real startup fault and is rethrown as-is, while an
 * exhausted candidate list means OpenCode is simply absent, which Ora retries quietly.
 */
export async function tryEachCandidate<T>(
  attempt: (resolved: OpenCodeCommand) => T | Promise<T>,
): Promise<T> {
  const resolved = resolveOpenCodeCommand();
  const candidates = spawnCandidates(resolved.command);
  const failures: unknown[] = [];
  for (const command of candidates) {
    try {
      return await attempt({ command, extraArgs: resolved.extraArgs });
    } catch (error) {
      failures.push(error);
    }
  }

  const realFailure = failures.find((error) => !isCommandNotFound(error));
  if (realFailure !== undefined) {
    throw realFailure instanceof Error
      ? realFailure
      : new Error(String(realFailure));
  }
  throw new PluginMethodError(
    AGENT_NOT_INSTALLED,
    `OpenCode is not installed or not on PATH (tried: ${
      candidates.join(", ")
    }); install it from https://opencode.ai/docs/ or set ORA_OPENCODE_BIN`,
  );
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
