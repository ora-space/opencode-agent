import type { HostProcesses, JsonValue } from "@ora-space/plugin-sdk";
import { spawnOpenCode } from "./command.ts";
import { logger } from "./log.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

const log = logger("opencode-client");
/** The CLI's own stderr, republished line by line under its own target. */
const cliLog = logger("opencode-cli");

/** The subset of a spawned child process this bridge depends on, so tests can substitute one. */
export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly pid: number | undefined;
  kill(): void;
  readonly exited: Promise<void>;
}

export interface OpenCodeClientOptions {
  /**
   * Overrides process spawning; injected by tests. Production spawns through `attachProcesses`.
   *
   * Which program a spawn resolves to is `command.ts`'s decision and is deliberately not a
   * parameter here: this class owns the CLI's lifetime, not the question of where it lives.
   */
  spawn?: (args: string[], cwd: string) => SpawnedProcess;
  /** Receives every ACP frame emitted by the CLI, in output order. */
  onAcpFrame?: (frame: JsonValue) => void;
  /** Invoked after the CLI exits on its own, never after an explicit stop. */
  onExited?: () => void;
}

interface RunningProcess {
  process: SpawnedProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Owns one `opencode acp` subprocess and bridges ACP frames between its stdio and Ora.
 *
 * The plugin owns the CLI's whole lifetime: spawn on `agent/start`, kill on `agent/stop`. Ora
 * never sees the child's stdio, which is what lets OpenCode use ACP methods this host has never
 * heard of. Nothing here parses ACP; frames are re-framed between Ora's binary envelope and the
 * CLI's NDJSON and otherwise passed through verbatim.
 */
export class OpenCodeClient {
  readonly #spawn: (
    args: string[],
    cwd: string,
  ) => SpawnedProcess | Promise<SpawnedProcess>;
  readonly #onAcpFrame: (frame: JsonValue) => void;
  readonly #onExited: () => void;
  /** Supplied by `attachProcesses` once the plugin's `Plugin` instance exists; see `main.ts`. */
  #processes: HostProcesses | undefined;
  #running: RunningProcess | undefined;
  #expectedExit = false;

  constructor(options: OpenCodeClientOptions = {}) {
    this.#spawn = options.spawn ??
      ((args, cwd) => this.#spawnViaHost(args, cwd));
    this.#onAcpFrame = options.onAcpFrame ?? (() => {});
    this.#onExited = options.onExited ?? (() => {});
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /**
   * Supplies the host-managed process client this plugin spawns `opencode acp` through.
   *
   * Called once, from `onActivate`: the `Plugin` instance `createHostProcesses` needs does not
   * exist yet when this client is constructed as a class field, so production spawning stays
   * unavailable until this runs. Tests that inject `options.spawn` never need to call it.
   */
  attachProcesses(processes: HostProcesses): void {
    this.#processes = processes;
  }

  /**
   * Spawns `opencode acp` in the given working directory and starts bridging its stdio.
   *
   * Any previous child is stopped first so a restart cannot leave two CLIs writing frames into
   * the same host connection.
   */
  async start(cwd: string): Promise<void> {
    const restarting = this.#running !== undefined;
    await this.stop();
    this.#expectedExit = false;

    log.info(restarting ? "restarting the CLI" : "starting the CLI", {
      context: { cwd },
    });
    // Failures are already classified for Ora by `spawnOpenCode`: a CLI this machine does not have
    // stays retryable, while a package that cannot run the one it ships does not.
    let process: SpawnedProcess;
    try {
      process = await this.#spawn(["acp", "--cwd", cwd], cwd);
    } catch (error) {
      log.warn("the CLI could not be spawned", { context: { cwd }, error });
      throw error;
    }
    this.#running = { process, stdinWriter: process.stdin.getWriter() };
    this.#attach(process);
    log.info("CLI running", { context: { cwd, pid: process.pid } });
  }

  /**
   * Forwards one host ACP frame into the CLI's stdin as NDJSON.
   *
   * Awaiting the write is what lets the CLI's backpressure reach the host instead of growing an
   * unbounded queue inside this process.
   */
  async writeAcp(frame: JsonValue): Promise<void> {
    const running = this.#running;
    if (running === undefined) {
      throw new Error("the OpenCode agent is not running");
    }
    try {
      await running.stdinWriter.write(encodeLine(JSON.stringify(frame)));
    } catch (error) {
      log.warn("writing an ACP frame to the CLI failed", {
        context: { pid: running.process.pid },
        error,
      });
      throw error;
    }
  }

  /** Kills the CLI and releases every pipe; idempotent when already stopped. */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    this.#expectedExit = true;
    if (running === undefined) {
      log.debug("stop requested with no CLI running");
      return;
    }
    log.info("stopping the CLI", { context: { pid: running.process.pid } });
    try {
      await running.stdinWriter.close();
    } catch {
      // The child already exited and closed its stdin; nothing is left to flush.
    }
    try {
      running.process.kill();
    } catch {
      // Already dead.
    }
  }

  /** Wires stdout, stderr, and exit bookkeeping for one live child. */
  #attach(process: SpawnedProcess): void {
    void this.#pumpStdout(process);
    void this.#pumpStderr(process);
    void process.exited.then(() => {
      // A process that is no longer `#running` was already superseded by a later `start()` (an
      // Effect restart, for instance); its death is old news, not a live agent going away, so it
      // must never clear the new process's tracking or fire `onExited` regardless of the shared
      // `#expectedExit` flag, which by then reflects the newer generation's intent, not this one's.
      if (this.#running?.process !== process) {
        log.debug("a superseded CLI generation exited", {
          context: { pid: process.pid },
        });
        return;
      }
      this.#running = undefined;
      if (this.#expectedExit) {
        log.info("CLI exited after stop", {
          context: { pid: process.pid },
        });
      } else {
        log.warn("opencode acp exited unexpectedly", {
          context: { pid: process.pid },
        });
        this.#onExited();
      }
    });
  }

  /**
   * Forwards every NDJSON line the CLI prints as one ACP frame.
   *
   * A line that is not a JSON object is dropped with a warning rather than failing the bridge:
   * Ora rejects non-object frames anyway, and one stray diagnostic line must not end every live
   * session on this agent.
   */
  async #pumpStdout(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stdout)) {
        let frame: JsonValue;
        try {
          frame = JSON.parse(line) as JsonValue;
        } catch {
          // The line itself is logged: it is the CLI's own output on its protocol channel, and
          // the only clue to what went wrong with the pairing.
          log.warn("dropping a non-JSON stdout line from the CLI", {
            context: { pid: process.pid, line: line.slice(0, 512) },
          });
          continue;
        }
        if (
          frame === null || typeof frame !== "object" || Array.isArray(frame)
        ) {
          log.warn("dropping a non-object ACP frame from the CLI", {
            context: { pid: process.pid },
          });
          continue;
        }
        log.debug("CLI ACP frame received", {
          context: { pid: process.pid, ...summarize(frame) },
        });
        this.#onAcpFrame(frame);
      }
      log.debug("CLI stdout reached EOF", {
        context: { pid: process.pid },
      });
    } catch (error) {
      log.warn("opencode acp stdout read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Republishes the CLI's diagnostics into this plugin's log, one record per line.
   *
   * The CLI is a third party whose stderr severity this plugin cannot know, so every line is
   * recorded at `info` under its own target rather than guessed at; the host's per-plugin level
   * decides whether it is kept.
   */
  async #pumpStderr(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stderr)) {
        if (line.length > 0) {
          cliLog.info(line, { context: { pid: process.pid } });
        }
      }
    } catch (error) {
      log.warn("opencode acp stderr read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Asks the host to spawn and own the CLI process, adapting its `HostChildProcess` handle onto
   * `SpawnedProcess` so every other method above stays unaware of who owns the OS process.
   */
  async #spawnViaHost(
    args: string[],
    cwd: string,
  ): Promise<SpawnedProcess> {
    if (this.#processes === undefined) {
      throw new Error(
        "OpenCodeClient cannot spawn before attachProcesses() runs",
      );
    }
    const child = await spawnOpenCode(this.#processes, { args, cwd });
    return {
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => child.write(chunk),
        close: () => child.closeStdin(),
      }),
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      // Best effort: the host already treats kill() as idempotent and tolerant of a process
      // that is already gone, so a rejection here is nothing callers need to observe.
      kill: () => void child.kill().catch(() => {}),
      exited: child.exited.then(() => undefined),
    };
  }
}

/** The envelope fields of one frame that are safe to log: never its params or result. */
function summarize(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return {};
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
  };
}
