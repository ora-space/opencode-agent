/**
 * Rejects provider configuration fields that OpenCode v1 silently ignores.
 *
 * Postmortem: opencode-config-version-silently-ignored.
 */

const DEFAULT_BUNDLE = "dist/main.js";

const TOP_LEVEL_FIELDS = new Set(["$schema", "model", "provider"]);
const PROVIDER_FIELDS = new Set(["name", "npm", "options", "models"]);
const MODEL_FIELDS = new Set(["name", "options"]);

export function verifyOpenCodeV1Config(config: unknown): void {
  const root = recordAt(config, "config");
  rejectUnknownFields(root, TOP_LEVEL_FIELDS, "config");

  if ("providers" in root) {
    fail("config.providers", "use the OpenCode v1 field 'provider'");
  }
  const providers = recordAt(root.provider, "config.provider");
  for (const [providerId, value] of Object.entries(providers)) {
    const path = `config.provider.${providerId}`;
    const provider = recordAt(value, path);
    rejectUnknownFields(provider, PROVIDER_FIELDS, path);
    recordAt(provider.options, `${path}.options`);

    const models = recordAt(provider.models, `${path}.models`);
    for (const [modelId, modelValue] of Object.entries(models)) {
      const modelPath = `${path}.models.${modelId}`;
      const model = recordAt(modelValue, modelPath);
      rejectUnknownFields(model, MODEL_FIELDS, modelPath);
      recordAt(model.options, `${modelPath}.options`);
    }
  }
}

export function configFromBundle(bundle: string): unknown {
  const match = bundle.match(
    /var EMBEDDED_CONFIG = ("(?:\\.|[^"\\])*");/,
  );
  if (match === null) {
    fail(
      DEFAULT_BUNDLE,
      "rebuild it so the embedded provider configuration is present",
    );
  }
  const embeddedText = JSON.parse(match[1]) as string;
  const embedded = recordAt(JSON.parse(embeddedText), "embedded config");
  return embedded.config;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field}`, "replace it with the OpenCode v1 equivalent");
    }
  }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "make it an object using OpenCode v1 fields");
  }
  return value as Record<string, unknown>;
}

function fail(path: string, fix: string): never {
  throw new Error(
    `${path} is not valid for the injected OpenCode v1 config; ${fix}, then run 'deno task build'`,
  );
}

if (import.meta.main) {
  const bundlePath = Deno.args[0] ?? DEFAULT_BUNDLE;
  const bundle = await Deno.readTextFile(bundlePath);
  verifyOpenCodeV1Config(configFromBundle(bundle));
  console.log(`verified OpenCode v1 provider fields in ${bundlePath}`);
}
