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

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await inbound.next();
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
    await send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Resolves one spawn request's program the way the real host does.
 *
 * `packageCommand` is joined onto the package root — this repository, since a simulated run has
 * no installed package — so the simulator exercises the same two-form contract Ora enforces.
 */
function resolveSimulatedProgram(params: Record<string, unknown>): string {
  const packageCommand = params.packageCommand as string | undefined;
  if (packageCommand === undefined) {
    return params.command as string;
  }
  const packageRoot = new URL("../", import.meta.url);
  return fromFileUrl(new URL(packageCommand, packageRoot));
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
      const child = new Deno.Command(command, {
        args,
        cwd,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
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
    case "ora/childprocess/closeStdin": {
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

const effectSurfaces =
  (register.params as { effectSurfaces?: unknown[] } | undefined)
    ?.effectSurfaces ?? [];
if (effectSurfaces.length === 0) {
  throw new Error("registration did not declare any Effect surface");
}
console.log(`ok: effectSurfaces ${JSON.stringify(effectSurfaces)}`);

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

await send({ jsonrpc: "2.0", id: 2, method: "agent/listModels", params: {} });
const models = await waitFor((message) => message.id === 2, "agent/listModels");
const modelList = ((models.result ?? {}) as { models?: unknown[] }).models ??
  [];
console.log(
  `ok: listModels ${modelList.length} models, first ${
    JSON.stringify(modelList[0])
  }`,
);

const surface = effectSurfaces[0] as {
  workspaceRelativePath: string;
  materializationFormat: string;
  coordination: string;
};
const effectParams = {
  surfaceKey: "sim-surface",
  workspaceRoot: Deno.cwd(),
  relativePath: surface.workspaceRelativePath,
};

await send({
  jsonrpc: "2.0",
  id: 3,
  method: "effect/waitForIdle",
  params: effectParams,
});
const idle = await waitFor(
  (message) => message.id === 3,
  "effect/waitForIdle",
);
const idleState = (idle.result as { state?: string } | undefined)?.state;
if (idleState !== "ready") {
  throw new Error(`expected waitForIdle to report ready, got ${idleState}`);
}
console.log("ok: effect/waitForIdle (no turn in flight) -> ready");

await send({
  jsonrpc: "2.0",
  id: 4,
  method: "effect/restart",
  params: { ...effectParams, generation: 1 },
});
const restarted = await waitFor(
  (message) => message.id === 4,
  "effect/restart",
);
if (restarted.error !== undefined) {
  throw new Error(`effect/restart failed: ${JSON.stringify(restarted.error)}`);
}
console.log("ok: effect/restart (CLI respawned)");

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

await send({ jsonrpc: "2.0", id: 5, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 5, "agent/stop");
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
