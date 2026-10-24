import { assertEquals, assertRejects } from "@std/assert";
import {
  AGENT_UNUSABLE,
  type AgentModelContext,
  createLogger,
  createStderrLogSink,
  type HostChildProcessOptions,
  HostRequestError,
  INVALID_PARAMS,
  type JsonValue,
} from "@ora-space/plugin-sdk";
import { bundledBinaryPath } from "../src/services/bundled-binary.ts";
import { BIN_OVERRIDE_ENV } from "../src/services/command.ts";
import { installLogger } from "../src/services/log.ts";
import { startOpenCode } from "../src/handlers/lifecycle.ts";
import { modelRoute } from "../src/services/model-route.ts";
import {
  OpenCodeClient,
  type SpawnedProcess,
} from "../src/services/opencode-client.ts";

const TOKEN = "synthetic-temporary-token";
const CONFIG = "/session/home/.config";

/** The frozen context a Node hands this plugin for one platform-model execution. */
function context(
  overrides: Partial<AgentModelContext["configuration"]> = {},
): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.opencode",
      pluginVersion: "0.7.0",
      target: "x86_64-unknown-linux-gnu",
      packageSha256: "a".repeat(64),
      schemaVersion: 2,
      declarationFingerprint: "b".repeat(64),
      adapterVersion: 1,
      configurationRevision: 3,
      settingsJson: "{}",
      protocol: "openai-completions",
      model: {
        id: "team/model",
        name: "Team model",
        contextWindow: 32768,
        maxTokens: 1024,
      },
      ...overrides,
    },
    proxyBaseUrl: "https://gateway.internal/runtime/openai/v1",
    token: TOKEN,
  };
}

Deno.test("the frozen model becomes the one OpenCode provider the Node used to write", () => {
  const route = modelRoute(context(), CONFIG);
  assertEquals(route.applied, {
    adapterVersion: 1,
    declarationFingerprint: "b".repeat(64),
    configurationRevision: 3,
  });
  const { OPENCODE_CONFIG_CONTENT, ...environment } = route.environment;
  assertEquals(environment, {
    ORA_MODEL_ACCESS_TOKEN: TOKEN,
    OPENCODE_CONFIG_DIR: CONFIG,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_CONFIG: "",
    OPENCODE_MODELS_URL: "",
    OPENCODE_MODELS_PATH: "",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  });
  assertEquals(JSON.parse(OPENCODE_CONFIG_CONTENT), {
    $schema: "https://opencode.ai/config.json",
    model: "ora-model/team/model",
    small_model: "ora-model/team/model",
    enabled_providers: ["ora-model"],
    provider: {
      "ora-model": {
        npm: "@ai-sdk/openai-compatible",
        name: "Ora model gateway",
        options: {
          baseURL: "https://gateway.internal/runtime/openai/v1",
          apiKey: "{env:ORA_MODEL_ACCESS_TOKEN}",
        },
        models: {
          "team/model": {
            name: "Team model",
            limit: { context: 32768, output: 1024 },
          },
        },
      },
    },
  });
  // The configuration text names the variable, so serializing it never persists the token.
  assertEquals(OPENCODE_CONFIG_CONTENT.includes(TOKEN), false);
});

Deno.test("Anthropic Messages selects the bundled Anthropic provider", () => {
  const route = modelRoute(
    context({ protocol: "anthropic-messages" }),
    CONFIG,
  );
  assertEquals(
    JSON.parse(route.environment.OPENCODE_CONFIG_CONTENT).provider["ora-model"]
      .npm,
    "@ai-sdk/anthropic",
  );
});

Deno.test("configurations this release cannot apply are refused without echoing the token", () => {
  const cases: [AgentModelContext, string][] = [
    [context({ settingsJson: '{"model":"other"}' }), CONFIG],
    [context({ settingsJson: "[]" }), CONFIG],
    [{ ...context(), proxyBaseUrl: "http://gateway.internal/v1" }, CONFIG],
    [{ ...context(), proxyBaseUrl: "https://u:p@gateway.internal/v1" }, CONFIG],
    [context(), ""],
  ];
  for (const [input, directory] of cases) {
    let caught: unknown;
    try {
      modelRoute(input, directory);
    } catch (error) {
      caught = error;
    }
    assertEquals((caught as { code?: number }).code, INVALID_PARAMS);
    assertEquals(String((caught as Error).message).includes(TOKEN), false);
  }
});

Deno.test("a platform start runs the CLI with its route and confirms it, and a restart keeps it", async () => {
  const environments: Record<string, string>[] = [];
  const client = new OpenCodeClient({
    spawn: (_args, _cwd, env) => {
      environments.push(env);
      return silentProcess();
    },
  });
  const applied = await startOpenCode(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  }, CONFIG);
  assertEquals(applied, modelRoute(context(), CONFIG).applied);
  await client.start("/workspace");
  assertEquals(environments, [
    { ...modelRoute(context(), CONFIG).environment },
    { ...modelRoute(context(), CONFIG).environment },
  ]);
  await client.stop();
});

Deno.test("a local start keeps the CLI's own configuration and confirms nothing", async () => {
  const environments: Record<string, string>[] = [];
  const client = new OpenCodeClient({
    spawn: (_args, _cwd, env) => {
      environments.push(env);
      return silentProcess();
    },
  });
  const applied = await startOpenCode(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
  }, undefined);
  assertEquals(environments, [{}]);
  assertEquals(applied, undefined);
  await client.stop();
});

Deno.test("a platform start without a private configuration root is refused before spawning", async () => {
  let spawned = 0;
  const client = new OpenCodeClient({
    spawn: () => {
      spawned += 1;
      return silentProcess();
    },
  });
  const error = await assertRejects(() =>
    startOpenCode(client, {
      cwd: "/workspace",
      hostVersion: "1.0.0",
      modelContext: context(),
    }, undefined)
  );
  assertEquals((error as { code?: number }).code, INVALID_PARAMS);
  assertEquals(spawned, 0);
});

Deno.test("inherited OpenCode configuration variables cannot reach the route", async () => {
  const inherited = {
    OPENCODE_CONFIG: "/home/user/elsewhere.json",
    OPENCODE_CONFIG_PROJECT_DISABLE: "false",
    OPENCODE_MODELS_URL: "https://models.invalid",
    OPENCODE_MODELS_PATH: "/home/user/models.json",
  };
  const environments: Record<string, string>[] = [];
  const client = new OpenCodeClient({
    spawn: (_args, _cwd, env) => {
      environments.push(env);
      return silentProcess();
    },
  });
  await startOpenCode(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  }, CONFIG);
  // The host merges the spawn environment over its own, so each inherited value is overridden.
  const effective = { ...inherited, ...environments[0] };
  assertEquals(effective.OPENCODE_CONFIG, "");
  assertEquals(effective.OPENCODE_CONFIG_PROJECT_DISABLE, "true");
  assertEquals(effective.OPENCODE_MODELS_URL, "");
  assertEquals(effective.OPENCODE_MODELS_PATH, "");
  await client.stop();
});

Deno.test("a client cannot re-authenticate or reroute the frozen provider", async () => {
  const { cli, client, forwarded } = await platformClient();
  for (
    const [id, method] of [
      [11, "authenticate"],
      [12, "logout"],
      [13, "providers/set"],
      [14, "providers/disable"],
    ] as const
  ) {
    await client.writeAcp({ jsonrpc: "2.0", id, method, params: {} });
  }
  await client.writeAcp({ jsonrpc: "2.0", method: "providers/disable" });
  assertEquals(cli.written, []);
  assertEquals(
    forwarded.map((frame) => (frame as { id: number }).id),
    [11, 12, 13, 14],
  );
  for (const frame of forwarded) {
    assertEquals((frame as { error: { code: number } }).error.code, -32601);
  }
  await client.stop();
});

Deno.test("a client can only ever select the frozen model", async () => {
  const { cli, client, forwarded } = await platformClient();
  const select = (id: number, value: string): JsonValue => ({
    jsonrpc: "2.0",
    id,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "model", value },
  });
  await client.writeAcp(select(1, "openai/gpt-5"));
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 2,
    method: "session/set_model",
    params: { sessionId: "s1", modelId: "ora-model/other" },
  });
  // The frozen model, also with an effort variant, and every other option reach the CLI.
  await client.writeAcp(select(3, "ora-model/team/model"));
  await client.writeAcp(select(4, "ora-model/team/model/high"));
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 5,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "mode", value: "plan" },
  });
  assertEquals(
    cli.written.map((frame) => (frame as { id: number }).id),
    [3, 4, 5],
  );
  assertEquals(forwarded, [
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "this execution is fixed to the model ora-model/team/model",
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32602,
        message: "this execution is fixed to the model ora-model/team/model",
      },
    },
  ]);
  await client.stop();
});

Deno.test("a local start passes every ACP frame through untouched", async () => {
  const cli = new ScriptedCli();
  const client = new OpenCodeClient({ spawn: () => cli.spawn() });
  await startOpenCode(
    client,
    { cwd: "/workspace", hostVersion: "1.0.0" },
    CONFIG,
  );
  const frame = { jsonrpc: "2.0", id: 1, method: "authenticate", params: {} };
  await client.writeAcp(frame);
  assertEquals(cli.written, [frame]);
  await client.stop();
});

Deno.test("a platform route spawns only the bundled CLI, ignoring an override and PATH", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const client = new OpenCodeClient();
  client.attachProcesses({
    spawn: (options) => {
      spawns.push(options);
      return Promise.reject(
        new HostRequestError("package_command_missing", "not in this package"),
      );
    },
  });
  const previous = Deno.env.get(BIN_OVERRIDE_ENV);
  Deno.env.set(BIN_OVERRIDE_ENV, "/usr/local/bin/opencode");
  try {
    const error = await assertRejects(() =>
      startOpenCode(client, {
        cwd: "/workspace",
        hostVersion: "1.0.0",
        modelContext: context(),
      }, CONFIG)
    );
    // Not retried as a missing install: the package itself cannot serve a platform route.
    assertEquals((error as { code?: number }).code, AGENT_UNUSABLE);
  } finally {
    if (previous === undefined) Deno.env.delete(BIN_OVERRIDE_ENV);
    else Deno.env.set(BIN_OVERRIDE_ENV, previous);
  }
  assertEquals(spawns.length, 1);
  assertEquals(spawns[0].packageCommand, bundledBinaryPath());
  assertEquals(Object.hasOwn(spawns[0], "command"), false);
  assertEquals(spawns[0].args, ["acp"]);
});

Deno.test("every model selector the CLI reports offers only the frozen model", async () => {
  const { cli, client, forwarded } = await platformClient();
  assertEquals(client.frozenModel, {
    id: "ora-model/team/model",
    name: "Team model",
  });
  const mode = { id: "mode", category: "mode", currentValue: "build" };
  const picker = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "openai/gpt-5",
    options: [
      { value: "openai/gpt-5", name: "openai/GPT-5" },
      { value: "ora-model/team/model", name: "ora-model/Team model" },
    ],
  };
  const frozen = {
    ...picker,
    currentValue: "ora-model/team/model",
    options: [{ value: "ora-model/team/model", name: "Team model" }],
  };
  cli.emit({
    jsonrpc: "2.0",
    id: 1,
    result: { sessionId: "s1", configOptions: [picker, mode] },
  });
  cli.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [picker],
      },
    },
  });
  await waitFor(() => forwarded.length === 2);
  assertEquals(forwarded, [
    {
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "s1", configOptions: [frozen, mode] },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [frozen],
        },
      },
    },
  ]);
  await client.stop();
});

Deno.test("model discovery on a platform route answers the frozen model without a probe", async () => {
  // Read as text: importing the entrypoint would start serving the host.
  const main = await Deno.readTextFile(
    new URL("../src/main.ts", import.meta.url),
  );
  const handler = main.slice(main.indexOf("override onListModels"));
  assertEquals(
    handler.indexOf("this.#client.frozenModel") <
      handler.indexOf("listOpenCodeModels("),
    true,
  );
  assertEquals(new OpenCodeClient().frozenModel, undefined);
});

Deno.test("CLI errors reach Ora with their code but without their text", async () => {
  const { cli, client, forwarded } = await platformClient();
  cli.emit({
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32000,
      message: "401 from https://other.invalid: bad key",
      data: { body: "leaked" },
    },
  });
  cli.emit({ jsonrpc: "2.0", id: 8, error: "not an object" });
  await waitFor(() => forwarded.length === 2);
  assertEquals(forwarded, [
    {
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32000,
        message: "The OpenCode agent could not complete the request",
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      error: {
        code: -32603,
        message: "The OpenCode agent could not complete the request",
      },
    },
  ]);
  await client.stop();
});

Deno.test("the token and gateway address never leave the CLI's output", async () => {
  const records: string[] = [];
  installLogger(createLogger({ write: (line) => records.push(line) }));
  try {
    const { cli, client, forwarded } = await platformClient();
    cli.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              `Error calling https://gateway.internal/runtime/openai/v1/chat/completions with ${TOKEN}; gateway.internal unreachable`,
          },
        },
      },
    });
    cli.emitLine(`not json ${TOKEN} https://gateway.internal`);
    cli.emitStderr(
      `ERROR service=llm url=https://gateway.internal/runtime/openai/v1 key=${TOKEN}`,
    );
    await waitFor(() =>
      forwarded.length === 1 &&
      records.some((record) => record.includes("service=llm")) &&
      records.some((record) => record.includes("non-JSON"))
    );
    const text = JSON.stringify(forwarded) + records.join("\n");
    assertEquals(text.includes(TOKEN), false);
    assertEquals(text.includes("gateway.internal"), false);
    assertEquals(
      (forwarded[0] as {
        params: { update: { content: { text: string } } };
      }).params.update.content.text,
      "Error calling [redacted]/chat/completions with [redacted]; [redacted] unreachable",
    );
    await client.stop();
  } finally {
    installLogger(createLogger(createStderrLogSink()));
  }
});

/** A client started on the platform route over a scripted CLI. */
async function platformClient() {
  const cli = new ScriptedCli();
  const forwarded: JsonValue[] = [];
  const client = new OpenCodeClient({
    spawn: () => cli.spawn(),
    onAcpFrame: (frame) => forwarded.push(frame),
  });
  await startOpenCode(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  }, CONFIG);
  return { cli, client, forwarded };
}

/** An `opencode acp` stand-in that records what it is sent and prints what a test tells it to. */
class ScriptedCli {
  readonly written: JsonValue[] = [];
  #stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  #stderr: ReadableStreamDefaultController<Uint8Array> | undefined;

  spawn(): SpawnedProcess {
    let ended: (() => void) | undefined;
    return {
      pid: 4321,
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => {
          for (const line of new TextDecoder().decode(chunk).split("\n")) {
            if (line.trim() !== "") this.written.push(JSON.parse(line));
          }
        },
      }),
      stdout: new ReadableStream({
        start: (controller) => {
          this.#stdout = controller;
        },
      }),
      stderr: new ReadableStream({
        start: (controller) => {
          this.#stderr = controller;
        },
      }),
      exited: new Promise((resolve) => {
        ended = () => resolve();
      }),
      kill: () => {
        this.#stdout?.close();
        this.#stderr?.close();
        ended?.();
      },
    };
  }

  /** Writes one NDJSON frame to stdout. */
  emit(frame: JsonValue): void {
    this.emitLine(JSON.stringify(frame));
  }

  /** Writes one raw line to stdout. */
  emitLine(line: string): void {
    this.#stdout?.enqueue(new TextEncoder().encode(`${line}\n`));
  }

  /** Writes one diagnostic line to stderr. */
  emitStderr(line: string): void {
    this.#stderr?.enqueue(new TextEncoder().encode(`${line}\n`));
  }
}

/** A `SpawnedProcess` that never speaks and ends when killed. */
function silentProcess(): SpawnedProcess {
  let ended: (() => void) | undefined;
  let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    pid: 4321,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream({
      start: (controller) => {
        stdout = controller;
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: new Promise((resolve) => {
      ended = () => resolve();
    }),
    kill: () => {
      stdout?.close();
      ended?.();
    },
  };
}

/** Polls a condition the bridge settles asynchronously, failing after a bounded wait. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}
