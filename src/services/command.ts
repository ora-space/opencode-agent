import {
  AGENT_NOT_INSTALLED,
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  HostRequestError,
  PluginMethodError,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";
import { bundledBinaryPath } from "./bundled-binary.ts";
import { providerEnv } from "./provider-env.ts";

/** The CLI this plugin fronts, as a user's own install spells it. */
const BINARY_NAME = "opencode";

/**
 * Names the PATH spellings that can launch OpenCode, in the order they should be tried.
 *
 * Deliberately not derived from `bundledBinaryPath()`: the name upstream publishes the binary
 * under and the names a user's own install answers to are independent facts that only happen to
 * overlap today. Windows installers disagree about what they put on PATH, and the host's PATH lookup only
 * appends `.exe` to a bare name — it does not try the others — so every spelling a real
 * installer produces has to be named here or the CLI is reported missing on a machine that
 * has it. The order follows Windows' own `PATHEXT` precedence: `.exe` first, so the process
 * the host ends up holding is the CLI itself rather than a shell wrapper around it.
 */
function pathCommands(): string[] {
  return Deno.build.os === "windows"
    ? [
      `${BINARY_NAME}.exe`,
      `${BINARY_NAME}.cmd`,
      `${BINARY_NAME}.bat`,
      BINARY_NAME,
    ]
    : [BINARY_NAME];
}

/** Full path to a locally built OpenCode, overriding both ways of resolving one. */
const BIN_OVERRIDE_ENV = "ORA_OPENCODE_BIN";

/**
 * Spawns the OpenCode CLI, whichever way this package was built to reach one.
 *
 * The same source is published two ways — as a per-target package that bundles the CLI, and as a
 * universal package that runs whatever the user installed — and it cannot know at build time which
 * one it ended up in. `spawnAgentProcess` answers that at spawn time: it asks for the bundled
 * binary first and falls back to a PATH lookup only when the host reports that this package
 * carries no such file. So a bundled package never silently runs some other OpenCode, a universal
 * one needs no detection step of its own, and a package whose bundled binary is broken fails
 * loudly instead of being retried forever as a missing CLI.
 *
 * `ORA_OPENCODE_BIN` outranks both, because it is the only way to point the plugin at a locally
 * built CLI: neither of the other two can name a path outside an installed package.
 */
export function spawnOpenCode(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  invocation = {
    ...invocation,
    env: { ...providerEnv(), ...invocation.env },
  };
  const override = readEnv(BIN_OVERRIDE_ENV)?.trim();
  if (override !== undefined && override !== "") {
    return spawnOverride(processes, override, invocation);
  }
  return spawnAgentProcess(processes, {
    packageCommand: bundledBinaryPath(),
    command: pathCommands(),
  }, invocation);
}

/**
 * Spawns the CLI a developer named explicitly, reporting an absent one as local configuration.
 *
 * An override pointing at nothing is the same kind of fault as an uninstalled CLI — fixable
 * without restarting Ora — so it stays retryable rather than failing this agent outright.
 */
async function spawnOverride(
  processes: HostProcesses,
  command: string,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  try {
    return await processes.spawn({ command, ...invocation });
  } catch (error) {
    if (
      error instanceof HostRequestError && error.kind === "program_not_found"
    ) {
      throw new PluginMethodError(
        AGENT_NOT_INSTALLED,
        `${BIN_OVERRIDE_ENV} points at ${command}, which does not exist`,
      );
    }
    throw error;
  }
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
