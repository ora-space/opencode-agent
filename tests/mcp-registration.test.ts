import { defineAgent, type JsonValue } from "@ora-space/plugin-sdk";
import { defineOpenCodeMcpConfiguration } from "../src/mcp/definition.ts";
import {
  DenoAtomicReplacer,
  DenoMaterializationFileSystem,
} from "../src/mcp/filesystem.ts";
import type { ManagedStateStore } from "../src/mcp/ledger.ts";
import { OpenCodeMcpMaterializer } from "../src/mcp/materializer.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

/** Exercises the public SDK definition so capability and handler are observed on one handshake. */
Deno.test("OpenCode registers protocol-v1 HTTP MCP support through the high-level SDK API", async () => {
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const transport = {
    readable: input.readable,
    writable: output.writable,
    redirectConsole: false,
  };
  const plugin = defineAgent({
    start: () => {},
    stop: () => {},
    listModels: () => [],
    onAcp: () => {},
    mcpConfiguration: defineOpenCodeMcpConfiguration(() => testMaterializer()),
  });
  const running = plugin.run(transport);
  const reader = output.readable.getReader();
  const registration = decodeFrame((await reader.read()).value!);
  assertEquals(registration, {
    jsonrpc: "2.0",
    method: "ora/register",
    params: {
      methods: [
        "agent/start",
        "agent/stop",
        "agent/listModels",
        "agent/configureWorkspace",
      ],
      emits: ["agent/acp"],
      mcpConfiguration: {
        protocolVersion: 1,
        transports: ["http"],
        coordination: "wait_for_idle_and_restart",
      },
    },
  });
  reader.releaseLock();
  const writer = input.writable.getWriter();
  await writer.write(encodeFrame({ jsonrpc: "2.0", method: "ora/shutdown" }));
  await writer.close();
  await running;
});

function testMaterializer(): OpenCodeMcpMaterializer {
  const fileSystem = new DenoMaterializationFileSystem();
  return new OpenCodeMcpMaterializer({
    fileSystem,
    permissions: { restrict: () => Promise.resolve() },
    atomicReplacer: new DenoAtomicReplacer(),
    git: { prepare: () => Promise.resolve() },
    state: {
      read: () => Promise.resolve(undefined),
      write: () => Promise.resolve(),
    } satisfies ManagedStateStore,
  });
}

function encodeFrame(message: JsonValue): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 5);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, false);
  frame[4] = 1;
  frame.set(payload, 5);
  return frame;
}

function decodeFrame(frame: Uint8Array): unknown {
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    .getUint32(0, false);
  if (frame[4] !== 1 || length + 4 !== frame.byteLength) {
    throw new Error("invalid test frame");
  }
  return JSON.parse(new TextDecoder().decode(frame.slice(5)));
}
