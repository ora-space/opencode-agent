/**
 * Drives the installed plugin exactly the way Ora's host does, against a real OpenCode CLI.
 *
 * Run it with the same permissions Ora grants an agent plugin:
 *   deno run --allow-run --allow-read --allow-env --allow-net tests/host-simulator.ts
 */
import type { JsonValue } from "@ora-space/plugin-sdk";
import { fromFileUrl } from "@std/path";

const JSON_RPC_FRAME_TYPE = 0x01;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * Encodes and decodes Ora's binary JSON-RPC frame envelope.
 *
 * This is a standalone reimplementation of the wire format, not an import from the plugin SDK:
 * this file plays the host's side of the protocol, and the host does not depend on the SDK it is
 * exercising.
 */

/** Encodes one JSON value into Ora's binary JSON-RPC frame envelope. */
function encodeFrame(message: JsonValue): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const length = payload.byteLength + 1;
  if (length > MAX_FRAME_LENGTH) {
    throw new Error(`Plugin frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }

  const frame = new Uint8Array(length + 4);
  new DataView(frame.buffer).setUint32(0, length, false);
  frame[4] = JSON_RPC_FRAME_TYPE;
  frame.set(payload, 5);
  return frame;
}

/** Decodes arbitrarily fragmented bytes into complete JSON-RPC messages. */
async function* decodeFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  let buffer = new Uint8Array();
  for await (const chunk of readable) {
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    combined.set(buffer);
    combined.set(chunk, buffer.byteLength);
    buffer = combined;

    while (buffer.byteLength >= 4) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).getUint32(0, false);
      if (length < 1 || length > MAX_FRAME_LENGTH) {
        throw new Error(`Invalid plugin frame length ${length}`);
      }
      if (buffer.byteLength < length + 4) {
        break;
      }
      if (buffer[4] !== JSON_RPC_FRAME_TYPE) {
        throw new Error(`Unsupported plugin frame type ${buffer[4]}`);
      }

      const payload = buffer.slice(5, length + 4);
      buffer = buffer.slice(length + 4);
      yield JSON.parse(new TextDecoder().decode(payload));
    }
  }

  if (buffer.byteLength !== 0) {
    throw new Error("Plugin protocol stream ended inside a frame");
  }
}

// The long-lived ACP server is no longer spawned by the plugin itself (this simulator, playing
// the host, does that instead — see `ora/childprocess/*` below), but `--allow-run` is still
// needed for the plugin's own one-shot `opencode models` invocation in handlers/models.ts.
const HOST_PERMISSIONS = [
  "--no-prompt",
  "--allow-run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
];

/** Converts this module-relative URL into a host path, including a Windows drive prefix. */
const entrypoint = decodeURIComponent(
  new URL("../src/main.ts", import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, "$1");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", ...HOST_PERMISSIONS, entrypoint],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const send = (message: JsonValue) => writer.write(encodeFrame(message));
const inbound = decodeFrames(child.stdout)[Symbol.asyncIterator]();

/**
 * How long any one step may wait before the run is declared stuck.
 *
 * Generous because a cold CLI start is genuinely slow, but bounded: without it a step that never
 * gets an answer hangs the whole run with no output at all, which is exactly what a bundled binary
 * that starts but does not speak ACP produces.
 */
const STEP_TIMEOUT_MS = 90_000;

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await withStepTimeout(inbound.next(), label);
    if (next.done) {
      throw new Error(`plugin closed stdout while waiting for ${label}`);
    }
    const message = next.value as Record<string, unknown>;
    if (isChildProcessRequest(message)) {
      // The plugin no longer spawns `opencode` itself; it asks this simulator, playing the host,
      // to do it. Answered off the main wait loop's critical path so a slow spawn cannot desync
      // reading of unrelated frames arriving concurrently.
      void handleChildProcessRequest(message).catch((error) => {
        console.error(`[host] ora/childprocess request failed: ${error}`);
      });
      continue;
    }
    if (match(message)) {
      return message;
    }
    console.log(`[host] << ${JSON.stringify(message).slice(0, 160)}`);
  }
}

/**
 * Fails a pending read with the step it was waiting on instead of hanging forever.
 *
 * The abandoned read is not cancelled: this only ever fires on the way to exiting, and naming the
 * stuck step is worth more here than tidily unwinding the stream.
 */
function withStepTimeout<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: number | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `timed out after ${
              STEP_TIMEOUT_MS / 1000
            }s waiting for ${label}; the CLI started but never answered`,
          ),
        ),
      STEP_TIMEOUT_MS,
    );
  });
  return Promise.race([pending, expiry]).finally(() =>
    clearTimeout(timer)
  ) as Promise<T>;
}

/** One subprocess this simulator, playing the host, spawned on the plugin's behalf. */
interface SimulatedChildProcess {
  child: Deno.ChildProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

const simulatedChildProcesses = new Map<string, SimulatedChildProcess>();
let nextChildProcessId = 1;

/** Recognizes a plugin-to-host request for `ora/childprocess/*`. */
function isChildProcessRequest(
  message: Record<string, unknown>,
): message is Record<string, unknown> & {
  id: number | string;
  method: string;
} {
  return typeof message.method === "string" &&
    message.method.startsWith("ora/childprocess/") &&
    (typeof message.id === "number" || typeof message.id === "string");
}

/**
 * Serves one `ora/childprocess/*` request the same way Ora's real host does: this simulator owns
 * the real `opencode` process and relays its stdout/stderr/exit back as notifications.
 */
async function handleChildProcessRequest(
  message: Record<string, unknown> & {
    id: number | string;
    method: string;
  },
): Promise<void> {
  try {
    const result = await dispatchChildProcessMethod(
      message.method,
      (message.params ?? {}) as Record<string, unknown>,
    );
    await send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    // Ora classifies every childprocess failure with a stable `data.kind`, and the plugin's
    // resolution ladder branches on it, so a simulator that answered with a bare message would
    // exercise a path production never takes.
    const classified = error instanceof SimulatedSpawnError
      ? error
      : new SimulatedSpawnError(
        "io",
        error instanceof Error ? error.message : String(error),
      );
    await send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: classified.kind === "io" ? -32000 : -32602,
        message: classified.message,
        data: { kind: classified.kind },
      },
    });
  }
}

/** One childprocess failure carrying the classification Ora's host would have attached. */
class SimulatedSpawnError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Resolves one spawn request's program the way the real host does.
 *
 * `packageCommand` is joined onto the package root — this repository, since a simulated run has
 * no installed package — so the simulator exercises the same two-form contract Ora enforces. A
 * path this "package" does not carry is reported as `package_command_missing` rather than left to
 * fail at spawn, because that answer is what makes the plugin fall back to a PATH lookup: without
 * it, a checkout with no staged binary would look like a broken package instead of the universal
 * one it is.
 */
function resolveSimulatedProgram(params: Record<string, unknown>): string {
  const packageCommand = params.packageCommand as string | undefined;
  if (packageCommand === undefined) {
    return params.command as string;
  }
  const packageRoot = new URL("../", import.meta.url);
  const resolved = fromFileUrl(new URL(packageCommand, packageRoot));
  const stat = statOrUndefined(resolved);
  if (stat === undefined) {
    throw new SimulatedSpawnError(
      "package_command_missing",
      `packageCommand ${packageCommand} is not part of this plugin package`,
    );
  }
  if (!stat.isFile) {
    throw new SimulatedSpawnError(
      "invalid_package_command",
      `packageCommand ${packageCommand} must name a regular package file`,
    );
  }
  return resolved;
}

/** Stats one path, treating an absent one as a value rather than a throw. */
function statOrUndefined(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.statSync(path);
  } catch {
    return undefined;
  }
}

async function dispatchChildProcessMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<JsonValue> {
  switch (method) {
    case "ora/childprocess/spawn": {
      const command = resolveSimulatedProgram(params);
      const args = (params.args as string[] | undefined) ?? [];
      const cwd = (params.cwd as string | null | undefined) ?? undefined;
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(command, {
          args,
          cwd,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      } catch (error) {
        throw new SimulatedSpawnError(
          error instanceof Deno.errors.NotFound ? "program_not_found" : "io",
          error instanceof Error ? error.message : String(error),
        );
      }
      const processId = String(nextChildProcessId++);
      simulatedChildProcesses.set(processId, {
        child,
        stdinWriter: child.stdin.getWriter(),
      });
      void pumpChildOutput(processId, child.stdout, "ora/childprocess/stdout");
      void pumpChildOutput(processId, child.stderr, "ora/childprocess/stderr");
      void child.status.then(async (status) => {
        simulatedChildProcesses.delete(processId);
        await notifyHostBestEffort({
          jsonrpc: "2.0",
          method: "ora/childprocess/exit",
          params: { processId, code: status.code, signal: null },
        });
      });
      return { processId, pid: child.pid };
    }
    case "ora/childprocess/write": {
      const process = requireSimulatedProcess(params);
      await process.stdinWriter.write(
        base64Decode(params.bytesBase64 as string),
      );
      return {};
    }
    case "ora/childprocess/close_stdin": {
      await requireSimulatedProcess(params).stdinWriter.close();
      return {};
    }
    case "ora/childprocess/kill": {
      requireSimulatedProcess(params).child.kill();
      return {};
    }
    default:
      throw new Error(`unsupported host method ${method}`);
  }
}

function requireSimulatedProcess(
  params: Record<string, unknown>,
): SimulatedChildProcess {
  const processId = params.processId as string;
  const process = simulatedChildProcesses.get(processId);
  if (process === undefined) {
    throw new Error(`unknown processId ${processId}`);
  }
  return process;
}

/** Streams one piped stdio stream as base64-encoded `ora/childprocess/{stdout,stderr}` chunks. */
async function pumpChildOutput(
  processId: string,
  stream: ReadableStream<Uint8Array>,
  method: string,
): Promise<void> {
  for await (const chunk of stream) {
    await notifyHostBestEffort({
      jsonrpc: "2.0",
      method,
      params: { processId, bytesBase64: base64Encode(chunk) },
    });
  }
}

/**
 * Sends one notification, swallowing failure exactly as the real host does: `agent/stop` does
 * not wait for a killed process to finish exiting, so a trailing chunk or the eventual exit
 * notification can still be in flight after the plugin connection has already closed.
 */
async function notifyHostBestEffort(message: JsonValue): Promise<void> {
  try {
    await send(message);
  } catch {
    // The plugin connection is already gone; there is nothing left to notify.
  }
}

/** Encodes bytes as standard base64 without building one giant intermediate string. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Decodes standard base64 into bytes. */
function base64Decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const acpFrame = (message: Record<string, unknown>): Record<string, unknown> =>
  (message.params ?? {}) as Record<string, unknown>;

const register = await waitFor(
  (message) => message.method === "ora/register",
  "ora/register",
);
console.log(`ok: register ${JSON.stringify(register.params)}`);

const effectResources =
  (register.params as { effectResources?: unknown[] } | undefined)
    ?.effectResources ?? [];
if (effectResources.length === 0) {
  throw new Error("registration did not declare any Effect Resource");
}
console.log(`ok: effectResources ${JSON.stringify(effectResources)}`);

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "agent/start",
  params: { cwd: Deno.cwd(), hostVersion: "0.8.0" },
});
const started = await waitFor((message) => message.id === 1, "agent/start");
console.log(
  `ok: agent/start ${JSON.stringify(started.result ?? started.error)}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  },
});
const initialized = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 1,
  "ACP initialize",
);
console.log(
  `ok: initialize ${
    JSON.stringify(acpFrame(initialized).result).slice(0, 200)
  }`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const session = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 2,
  "ACP session/new",
);
console.log(
  `ok: session/new ${
    JSON.stringify(acpFrame(session).result ?? acpFrame(session).error).slice(
      0,
      200,
    )
  }`,
);

await send({ jsonrpc: "2.0", id: 2, method: "agent/list_models", params: {} });
const models = await waitFor(
  (message) => message.id === 2,
  "agent/list_models",
);
const modelList = ((models.result ?? {}) as { models?: unknown[] }).models ??
  [];
console.log(
  `ok: listModels ${modelList.length} models, first ${
    JSON.stringify(modelList[0])
  }`,
);

// Ora addresses coordination by Target and Resource identity; the plugin never resolves a path
// from these, so any stable pair drives the same code the host would.
const coordinationParams = {
  targetId: "sim-target",
  resourceIds: ["sim-resource"],
};

await send({
  jsonrpc: "2.0",
  id: 3,
  method: "effect/coordinate",
  params: coordinationParams,
});
const coordinated = await waitFor(
  (message) => message.id === 3,
  "effect/coordinate",
);
if (coordinated.error !== undefined) {
  throw new Error(
    `effect/coordinate failed: ${JSON.stringify(coordinated.error)}`,
  );
}
console.log("ok: effect/coordinate (no turn in flight) -> safe to mutate");

// Readiness must be refused while the barrier is up: the CLI has not rescanned yet, and Ora would
// otherwise mark a Target ready against Skills its Consumer has never read.
await send({
  jsonrpc: "2.0",
  id: 4,
  method: "effect/verify_ready",
  params: {
    targetId: coordinationParams.targetId,
    generation: 1,
    consumerRevisionId: "sim-revision",
    projectionDigest: "sim-digest",
  },
});
const readyWhileQuiesced = await waitFor(
  (message) => message.id === 4,
  "effect/verify_ready while quiesced",
);
if (readyWhileQuiesced.error === undefined) {
  throw new Error("effect/verify_ready reported ready while still quiesced");
}
console.log("ok: effect/verify_ready while quiesced -> refused");

await send({
  jsonrpc: "2.0",
  id: 5,
  method: "effect/reactivate",
  params: coordinationParams,
});
const reactivated = await waitFor(
  (message) => message.id === 5,
  "effect/reactivate",
);
if (reactivated.error !== undefined) {
  throw new Error(
    `effect/reactivate failed: ${JSON.stringify(reactivated.error)}`,
  );
}
console.log("ok: effect/reactivate (CLI respawned)");

await send({
  jsonrpc: "2.0",
  id: 6,
  method: "effect/verify_ready",
  params: {
    targetId: coordinationParams.targetId,
    generation: 1,
    consumerRevisionId: "sim-revision",
    projectionDigest: "sim-digest",
  },
});
const ready = await waitFor(
  (message) => message.id === 6,
  "effect/verify_ready",
);
if (ready.error !== undefined) {
  throw new Error(`effect/verify_ready failed: ${JSON.stringify(ready.error)}`);
}
console.log("ok: effect/verify_ready after reactivate -> ready");

// The barrier must release a fully working bridge: prove the respawned CLI still answers ACP.
await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 3,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const sessionAfterRestart = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 3,
  "ACP session/new after restart",
);
console.log(
  `ok: session/new after restart ${
    JSON.stringify(
      acpFrame(sessionAfterRestart).result ??
        acpFrame(sessionAfterRestart).error,
    ).slice(0, 200)
  }`,
);

await send({ jsonrpc: "2.0", id: 7, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 7, "agent/stop");
console.log("ok: agent/stop");

await send({ jsonrpc: "2.0", method: "ora/shutdown" });
await writer.close();
const status = await child.status;
console.log(`plugin exited with code ${status.code}`);
console.log(
  status.success
    ? "ALL HOST SIMULATION CHECKS PASSED"
    : "PLUGIN EXITED NON-ZERO",
);
Deno.exit(status.success ? 0 : 1);
