import type { HostProcesses, JsonValue } from "@ora-space/plugin-sdk";
import { spawnOpenCode } from "./command.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

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
    await this.stop();
    this.#expectedExit = false;

    // Failures are already classified for Ora by `spawnOpenCode`: a CLI this machine does not have
    // stays retryable, while a package that cannot run the one it ships does not.
    const process = await this.#spawn(["acp", "--cwd", cwd], cwd);
    this.#running = { process, stdinWriter: process.stdin.getWriter() };
    this.#attach(process);
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
    await running.stdinWriter.write(encodeLine(JSON.stringify(frame)));
  }

  /** Kills the CLI and releases every pipe; idempotent when already stopped. */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    this.#expectedExit = true;
    if (running === undefined) {
      return;
    }
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
        return;
      }
      this.#running = undefined;
      if (!this.#expectedExit) {
        console.warn("opencode acp exited unexpectedly");
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
          console.warn(`dropping non-JSON stdout line: ${line}`);
          continue;
        }
        if (
          frame === null || typeof frame !== "object" || Array.isArray(frame)
        ) {
          console.warn("dropping non-object ACP frame from opencode");
          continue;
        }
        this.#onAcpFrame(frame);
      }
    } catch (error) {
      console.warn(`opencode stdout read failed: ${error}`);
    }
  }

  /** Republishes the CLI's diagnostics on this plugin's stderr, which Ora logs. */
  async #pumpStderr(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stderr)) {
        if (line.length > 0) {
          console.error(`[opencode] ${line}`);
        }
      }
    } catch (error) {
      console.warn(`opencode stderr read failed: ${error}`);
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
