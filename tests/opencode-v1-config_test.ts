import { verifyOpenCodeV1Config } from "../checks/verify-opencode-v1-config.ts";

Deno.test("accepts the injected OpenCode v1 provider shape", () => {
  verifyOpenCodeV1Config({
    $schema: "https://opencode.ai/config.json",
    model: "acme/coding",
    provider: {
      acme: {
        name: "Acme",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://example.invalid/v1",
          body: { stream: true },
        },
        models: {
          coding: { name: "Coding", options: { body: { stream: true } } },
        },
      },
    },
  });
});

Deno.test("rejects OpenCode v2 provider fields", () => {
  const cases: Array<[string, unknown]> = [
    ["config.providers", {
      $schema: "https://opencode.ai/config.json",
      model: "acme/coding",
      providers: {
        acme: {
          package: "@opencode-ai/ai/providers/openai-compatible",
          settings: { baseURL: "https://example.invalid/v1" },
          body: { stream: true },
        },
      },
    }],
    ["config.provider.acme.package", v1WithProviderField("package", "package")],
    ["config.provider.acme.settings", v1WithProviderField("settings", {})],
    [
      "config.provider.acme.body",
      v1WithProviderField("body", { stream: true }),
    ],
    [
      "config.provider.acme.models.coding.body",
      v1WithModelField("body", { stream: true }),
    ],
  ];

  for (const [path, config] of cases) {
    let error: unknown;
    try {
      verifyOpenCodeV1Config(config);
    } catch (cause) {
      error = cause;
    }
    if (!(error instanceof Error) || !error.message.includes(path)) {
      throw new Error(`expected ${path} rejection, received ${error}`);
    }
  }
});

interface TestConfig {
  $schema: string;
  model: string;
  provider: Record<string, {
    [key: string]: unknown;
    models: Record<string, Record<string, unknown>>;
  }>;
}

function v1WithProviderField(field: string, value: unknown): TestConfig {
  const config = validConfig();
  config.provider.acme[field] = value;
  return config;
}

function v1WithModelField(field: string, value: unknown): TestConfig {
  const config = validConfig();
  config.provider.acme.models.coding[field] = value;
  return config;
}

function validConfig(): TestConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    model: "acme/coding",
    provider: {
      acme: {
        name: "Acme",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.invalid/v1" },
        models: { coding: { name: "Coding", options: {} } },
      },
    },
  };
}
