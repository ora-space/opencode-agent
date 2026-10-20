import type { AgentModelContext, JsonValue } from "@ora-space/plugin-sdk";
import { join } from "@std/path";

/** Frozen OpenCode model identity retains the entire upstream ID, including embedded slashes. */
export function openCodeModelId(context: AgentModelContext): string {
  return "ora-model/" + context.configuration.model.id;
}

/** Converts the neutral binding into one private provider; the token is only an env reference. */
export function openCodeModelEnvironment(
  context: AgentModelContext,
  home = Deno.env.get("HOME") ?? "",
): Record<string, string> {
  const frozen = context.configuration;
  if (
    !home || frozen.target !== Deno.build.target ||
    frozen.pluginId.split("/").at(-1) !== "ora-space.opencode"
  ) throw new Error("opencode_model_adapter_failed");
  let settings: unknown;
  let url: URL;
  try {
    settings = JSON.parse(frozen.settingsJson);
    url = new URL(context.proxyBaseUrl);
  } catch {
    throw new Error("opencode_model_adapter_failed");
  }
  const endpoint = frozen.protocol === "openai-completions"
    ? "/runtime/openai/v1"
    : "/runtime/anthropic/v1";
  if (
    !isObject(settings) || Object.keys(settings).length !== 0 ||
    url.protocol !== "https:" || url.pathname !== endpoint || url.username ||
    url.password || url.search || url.hash
  ) throw new Error("opencode_model_adapter_failed");
  const id = frozen.model.id;
  const config = {
    "$schema": "https://opencode.ai/config.json",
    model: openCodeModelId(context),
    small_model: openCodeModelId(context),
    enabled_providers: ["ora-model"],
    provider: {
      "ora-model": {
        npm: frozen.protocol === "openai-completions"
          ? "@ai-sdk/openai-compatible"
          : "@ai-sdk/anthropic",
        name: "Ora model gateway",
        options: {
          baseURL: context.proxyBaseUrl,
          apiKey: "{env:ORA_MODEL_ACCESS_TOKEN}",
        },
        models: {
          [id]: {
            name: frozen.model.name,
            limit: {
              context: frozen.model.contextWindow,
              output: frozen.model.maxTokens,
            },
          },
        },
      },
    },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ORA_MODEL_ACCESS_TOKEN: context.token,
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: join(home, ".opencode-platform"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  };
}

/** A single-model execution refuses credential/provider changes and out-of-binding model choices. */
export function permitsOpenCodeFrame(
  frame: JsonValue,
  context: AgentModelContext,
): boolean {
  if (!isObject(frame) || typeof frame.method !== "string") return true;
  if (
    frame.method === "authenticate" || frame.method === "logout" ||
    frame.method.startsWith("providers/")
  ) return false;
  const params = isObject(frame.params) ? frame.params : {};
  if (frame.method === "session/set_model") {
    return params.modelId === openCodeModelId(context);
  }
  if (
    frame.method === "session/set_config_option" && params.configId === "model"
  ) return params.value === openCodeModelId(context);
  return true;
}

/** Keeps protocol error codes available while removing private provider messages and data. */
export function redactOpenCodeModelError(frame: JsonValue): JsonValue {
  if (!isObject(frame) || !("error" in frame)) return frame;
  const candidate = isObject(frame.error) ? frame.error.code : undefined;
  const code = typeof candidate === "number" && Number.isInteger(candidate) &&
      candidate >= -2147483648 && candidate <= 2147483647
    ? candidate
    : -32603;
  return { ...frame, error: { code, message: "Agent operation failed" } };
}

/** Only JSON objects can carry protocol envelope members. */
function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
