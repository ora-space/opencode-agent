import {
  type AgentModelApplied,
  type AgentModelContext,
  INVALID_PARAMS,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import type { FrozenModel } from "./model-guard.ts";

/** The one provider this plugin configures; OpenCode addresses models as `<provider>/<id>`. */
const PROVIDER = "ora-model";

/** The variable OpenCode's configuration names instead of the token itself. */
const TOKEN_VARIABLE = "ORA_MODEL_ACCESS_TOKEN";

/**
 * What one platform-model execution adds to the environment of the `opencode acp` process.
 *
 * This is the configuration the Node used to write for OpenCode, now owned by the plugin that
 * drives the CLI. The configuration text references the token through `{env:...}`, so serializing
 * it can never persist the token; only the child's own environment holds it.
 */
export interface ModelRoute {
  readonly applied: AgentModelApplied;
  /** The one model this execution may use; every selector and switch is held to it. */
  readonly model: FrozenModel;
  /**
   * What must never leave the CLI: the token, and the gateway address in every spelling a
   * message is likely to use (full URL, host with port, bare hostname).
   */
  readonly secrets: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Turns a frozen model context into OpenCode's provider configuration, refusing what it cannot
 * apply.
 *
 * Both platform protocols map onto an AI SDK provider OpenCode bundles. Settings must be empty —
 * this release declares none — and the proxy must be the platform's HTTPS endpoint; anything else
 * would leave OpenCode on a route nobody admitted. `configDirectory` is a private directory under
 * the session home the host provides; pointing `OPENCODE_CONFIG_DIR` there, together with
 * disabling project configuration, keeps a repository's or the host's own `opencode.json` from
 * replacing this provider.
 */
export function modelRoute(
  context: AgentModelContext,
  configDirectory: string,
): ModelRoute {
  const { configuration } = context;
  let settings: unknown;
  try {
    settings = JSON.parse(configuration.settingsJson);
  } catch {
    refuse();
  }
  if (
    settings === null || typeof settings !== "object" ||
    Array.isArray(settings) || Object.keys(settings).length > 0 ||
    !platformProxy(context.proxyBaseUrl) || context.token.length === 0 ||
    configDirectory.length === 0
  ) {
    refuse();
  }
  const model = configuration.model;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER}/${model.id}`,
    small_model: `${PROVIDER}/${model.id}`,
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        npm: configuration.protocol === "anthropic-messages"
          ? "@ai-sdk/anthropic"
          : "@ai-sdk/openai-compatible",
        name: "Ora model gateway",
        options: {
          baseURL: context.proxyBaseUrl,
          apiKey: `{env:${TOKEN_VARIABLE}}`,
        },
        models: {
          [model.id]: {
            name: model.name,
            limit: { context: model.contextWindow, output: model.maxTokens },
          },
        },
      },
    },
  };
  return {
    applied: {
      adapterVersion: configuration.adapterVersion,
      declarationFingerprint: configuration.declarationFingerprint,
      configurationRevision: configuration.configurationRevision,
    },
    model: { id: `${PROVIDER}/${model.id}`, name: model.name },
    secrets: gatewaySecrets(context),
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      [TOKEN_VARIABLE]: context.token,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      // OpenCode reads `OPENCODE_CONFIG_PROJECT_DISABLE ?? OPENCODE_DISABLE_PROJECT_CONFIG`, so an
      // inherited `OPENCODE_CONFIG_PROJECT_DISABLE=false` would otherwise turn project config
      // back on.
      OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      // The host's spawn environment only adds variables, so inherited ones are cleared by setting
      // them empty; OpenCode treats an empty value as unset. `OPENCODE_CONFIG` names one more
      // config file to merge, which could add options to this provider; the models catalog
      // source could describe it differently.
      OPENCODE_CONFIG: "",
      OPENCODE_MODELS_URL: "",
      OPENCODE_MODELS_PATH: "",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
  };
}

/** Accepts only an HTTPS proxy URL without credentials, query or fragment. */
function platformProxy(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" &&
    url.password === "" && url.search === "" && url.hash === "";
}

function gatewaySecrets(context: AgentModelContext): string[] {
  const gateway = new URL(context.proxyBaseUrl);
  return [
    context.token,
    context.proxyBaseUrl,
    gateway.origin,
    gateway.host,
    gateway.hostname,
  ];
}

/** Fails `agent/start` without describing the sensitive input. */
function refuse(): never {
  throw new PluginMethodError(
    INVALID_PARAMS,
    "this OpenCode release cannot apply the supplied model configuration",
  );
}
