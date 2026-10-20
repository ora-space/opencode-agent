import { assertEquals, assertRejects } from "@std/assert";
import type {
  AgentModelContext,
  HostChildProcessOptions,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  openCodeModelEnvironment,
  openCodeModelId,
  permitsOpenCodeFrame,
  redactOpenCodeModelError,
} from "../src/services/model-adapter.ts";
import { AGENT_UNUSABLE, PluginMethodError } from "@ora-space/plugin-sdk";

Deno.test("OpenCode model errors retain codes while removing private diagnostics", () => {
  const token = context().token;
  assertEquals(
    redactOpenCodeModelError({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: token, data: { private: token } },
    }),
    {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Agent operation failed" },
    },
  );
});
import { spawnOpenCodeModel } from "../src/services/command.ts";
import { OpenCodeClient } from "../src/services/opencode-client.ts";
import { startOpenCode } from "../src/handlers/lifecycle.ts";

/** No credential or ambient profile is involved in the synthetic binding. */
function context(): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.opencode",
      pluginVersion: "1.0.0",
      target: Deno.build.target,
      packageSha256: "a".repeat(64),
      schemaVersion: 2,
      declarationFingerprint: "b".repeat(64),
      adapterVersion: 1,
      configurationRevision: 0,
      settingsJson: "{}",
      protocol: "openai-completions",
      model: {
        id: "vendor/model",
        name: "Frozen",
        contextWindow: 128000,
        maxTokens: 8192,
      },
    },
    proxyBaseUrl: "https://gateway.invalid/runtime/openai/v1",
    token: "synthetic-runtime-token",
  };
}

Deno.test("OpenCode converts both protocols without persisting token literals or splitting model IDs", () => {
  for (
    const protocol of ["openai-completions", "anthropic-messages"] as const
  ) {
    const frozen = context();
    frozen.configuration.protocol = protocol;
    frozen.proxyBaseUrl = "https://gateway.invalid/runtime/" +
      (protocol === "openai-completions" ? "openai" : "anthropic") + "/v1";
    const env = openCodeModelEnvironment(frozen, "/private/execution");
    assertEquals(env.ORA_MODEL_ACCESS_TOKEN, frozen.token);
    assertEquals(env.OPENCODE_CONFIG_CONTENT.includes(frozen.token), false);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assertEquals(config.model, "ora-model/vendor/model");
    assertEquals(config.small_model, config.model);
    assertEquals(config.enabled_providers, ["ora-model"]);
    assertEquals(config.provider["ora-model"].options, {
      baseURL: frozen.proxyBaseUrl,
      apiKey: "{env:ORA_MODEL_ACCESS_TOKEN}",
    });
    assertEquals(Object.keys(config.provider["ora-model"].models), [
      "vendor/model",
    ]);
    assertEquals(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  }
});

Deno.test("OpenCode model and authentication mutations cannot replace the frozen provider", () => {
  const frozen = context();
  for (const method of ["authenticate", "logout", "providers/set"]) {
    assertEquals(permitsOpenCodeFrame({ id: 1, method }, frozen), false);
  }
  assertEquals(
    permitsOpenCodeFrame({
      id: 1,
      method: "session/set_model",
      params: { modelId: "other/model" },
    }, frozen),
    false,
  );
  assertEquals(
    permitsOpenCodeFrame({
      id: 1,
      method: "session/set_config_option",
      params: { configId: "model", value: "other/model" },
    }, frozen),
    false,
  );
  assertEquals(
    permitsOpenCodeFrame({
      id: 1,
      method: "session/set_model",
      params: { modelId: openCodeModelId(frozen) },
    }, frozen),
    true,
  );
});

Deno.test("the declared OpenCode route never falls back to a local CLI", async () => {
  const calls: HostChildProcessOptions[] = [];
  const processes: HostProcesses = {
    spawn: (options) => {
      calls.push(options);
      return Promise.reject(new Error("absent package"));
    },
  };
  const error = await assertRejects(
    () => spawnOpenCodeModel(processes, { cwd: "/private", args: ["acp"] }),
    PluginMethodError,
  );
  assertEquals(error.code, AGENT_UNUSABLE);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.command, undefined);
  assertEquals(calls[0]?.packageCommand?.includes("assets/bin/opencode"), true);
});

Deno.test("OpenCode applies the context before acknowledging startup and blocks a later model switch", async () => {
  const writes: JsonValue[] = [];
  const frames: JsonValue[] = [];
  const output = new TransformStream<Uint8Array>();
  const errors = new TransformStream<Uint8Array>();
  const exited = Promise.withResolvers<void>();
  const client = new OpenCodeClient({
    spawn: () => ({
      stdin: new WritableStream({
        write: (chunk) => {
          writes.push(JSON.parse(new TextDecoder().decode(chunk)));
        },
      }),
      stdout: output.readable,
      stderr: errors.readable,
      pid: 7,
      kill: () => {
        void output.writable.close();
        void errors.writable.close();
        exited.resolve();
      },
      exited: exited.promise,
    }),
    onAcpFrame: (frame) => frames.push(frame),
  });
  const frozen = context();
  assertEquals(
    await startOpenCode(client, {
      cwd: "/private",
      hostVersion: "0",
      modelContext: frozen,
    }),
    {
      adapterVersion: 1,
      declarationFingerprint: "b".repeat(64),
      configurationRevision: 0,
    },
  );
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 1,
    method: "session/set_model",
    params: { modelId: "other" },
  });
  assertEquals(writes, []);
  assertEquals(frames, [{
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message: "The execution model is frozen" },
  }]);
  assertEquals(client.frozenModel, {
    id: "ora-model/vendor/model",
    displayName: "Frozen",
    default: true,
  });
  await client.stop();
  await exited.promise;
});
