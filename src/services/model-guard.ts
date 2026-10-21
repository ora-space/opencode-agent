import type { JsonValue } from "@ora-space/plugin-sdk";

/** The one model a platform-model execution may use, as OpenCode's ACP selector names it. */
export interface FrozenModel {
  /** OpenCode's `<provider>/<model>` reference, e.g. `ora-model/vendor/model`. */
  readonly id: string;
  readonly name: string;
}

/** What the bridge does with one frame Ora sent towards the CLI. */
export type InboundDecision =
  /** Write this frame into the CLI. */
  | { readonly forward: JsonValue }
  /** Answer Ora with this frame instead; the CLI never sees the request. */
  | { readonly reply: JsonValue }
  /** A notification nobody may send in this execution; there is nothing to answer. */
  | { readonly drop: true };

/** JSON-RPC "method not found": these methods do not exist for a frozen execution. */
const METHOD_NOT_AVAILABLE = -32601;
/** JSON-RPC "invalid params": a model other than the frozen one was asked for. */
const MODEL_FROZEN = -32602;
/** What every CLI error says instead; its own text can quote the gateway or a provider response. */
const REDACTED_ERROR_MESSAGE =
  "The OpenCode agent could not complete the request";
/** What a secret is replaced with wherever it would otherwise reach Ora or a log. */
const REDACTED = "[redacted]";

/**
 * Methods that could hand the CLI another upstream, another credential, or none at all.
 *
 * OpenCode 2.0.32 answers `authenticate` as a no-op and serves none of the others, but ACP
 * defines them (`providers/set` reroutes an agent, `logout` drops its login), and a later CLI pin
 * that starts serving one must not quietly become a way around the frozen provider.
 */
function isRouteMutation(method: string): boolean {
  return method === "authenticate" || method === "logout" ||
    method.startsWith("auth/") || method.startsWith("_auth/") ||
    method.startsWith("providers/");
}

/**
 * Keeps one platform-model execution on its frozen provider and model.
 *
 * The provider itself is fixed by the configuration `model-route.ts` hands the CLI; this class
 * keeps a client from asking the CLI to leave it over ACP, and narrows every model selector the
 * CLI reports to the frozen model. It also keeps the route's secrets in the CLI: error text is
 * replaced, and the token and gateway address are scrubbed from every line the CLI prints before
 * it is forwarded or logged.
 */
export class ModelGuard {
  readonly #model: FrozenModel;
  /** Longest first, so a URL is replaced whole before the host inside it is. */
  readonly #secrets: readonly string[];

  constructor(model: FrozenModel, secrets: readonly string[] = []) {
    this.#model = model;
    this.#secrets = [...new Set(secrets.filter((secret) => secret !== ""))]
      .sort((a, b) => b.length - a.length);
  }

  /** Replaces every secret in one line of CLI output before it is parsed, sent or logged. */
  scrub(text: string): string {
    let scrubbed = text;
    for (const secret of this.#secrets) {
      if (scrubbed.includes(secret)) {
        scrubbed = scrubbed.split(secret).join(REDACTED);
      }
    }
    return scrubbed;
  }

  /** The model `agent/list_models` reports: the frozen one, never anything discovered. */
  get model(): FrozenModel {
    return this.#model;
  }

  /** Decides what happens to one frame Ora sent towards the CLI. */
  inbound(frame: JsonValue): InboundDecision {
    if (!isObject(frame) || typeof frame.method !== "string") {
      return { forward: frame };
    }
    const method = frame.method;
    const params = isObject(frame.params) ? frame.params : {};
    if (isRouteMutation(method)) {
      return refuse(
        frame,
        METHOD_NOT_AVAILABLE,
        `${method} is not available: this execution's model route is fixed`,
      );
    }
    const requested = method === "session/set_model"
      ? params.modelId
      : method === "session/set_config_option" && params.configId === "model"
      ? params.value
      : undefined;
    if (requested !== undefined && !this.#isFrozen(requested)) {
      return refuse(
        frame,
        MODEL_FROZEN,
        `this execution is fixed to the model ${this.#model.id}`,
      );
    }
    return { forward: frame };
  }

  /**
   * Narrows every model selector in, and redacts any error of, one frame the CLI sent.
   *
   * `enabled_providers` already limits OpenCode's catalog to the one provider this plugin writes,
   * but configuration that outranks it (managed settings) is outside this plugin's control, so
   * the selector Ora shows is narrowed here as well (ADR D5: visible session options never widen
   * the set). Results and `config_option_update` notifications both carry one.
   */
  outbound(frame: JsonValue): JsonValue {
    if (!isObject(frame)) return frame;
    if (typeof frame.method !== "string" && "error" in frame) {
      // The code still tells Ora what kind of failure this was; the text and data are the CLI's,
      // and may carry a provider response or the gateway's address (ADR D2).
      const code = isObject(frame.error) ? frame.error.code : undefined;
      return {
        ...frame,
        error: {
          code: typeof code === "number" && Number.isInteger(code)
            ? code
            : -32603,
          message: REDACTED_ERROR_MESSAGE,
        },
      };
    }
    if (isObject(frame.result)) {
      return { ...frame, result: this.#narrowModels(frame.result) };
    }
    if (
      frame.method === "session/update" && isObject(frame.params) &&
      isObject(frame.params.update)
    ) {
      return {
        ...frame,
        params: {
          ...frame.params,
          update: this.#narrowModels(frame.params.update),
        },
      };
    }
    return frame;
  }

  #narrowModels(
    payload: { [key: string]: JsonValue },
  ): { [key: string]: JsonValue } {
    const narrowed = { ...payload };
    const only = { value: this.#model.id, name: this.#model.name };
    if (Array.isArray(payload.configOptions)) {
      narrowed.configOptions = payload.configOptions.map((option) =>
        isObject(option) &&
          (option.id === "model" || option.category === "model")
          ? { ...option, currentValue: only.value, options: [only] }
          : option
      );
    }
    if (isObject(payload.models)) {
      narrowed.models = {
        ...payload.models,
        currentModelId: this.#model.id,
        availableModels: [{ modelId: this.#model.id, name: this.#model.name }],
      };
    }
    return narrowed;
  }

  /**
   * Accepts the frozen reference itself, and the same reference with an effort variant appended
   * (`<provider>/<model>/<variant>`), which OpenCode's selector also understands; neither changes
   * the model.
   */
  #isFrozen(value: JsonValue): boolean {
    return typeof value === "string" &&
      (value === this.#model.id || value.startsWith(`${this.#model.id}/`));
  }
}

function refuse(
  frame: { [key: string]: JsonValue },
  code: number,
  message: string,
): InboundDecision {
  return typeof frame.id === "string" || typeof frame.id === "number"
    ? { reply: { jsonrpc: "2.0", id: frame.id, error: { code, message } } }
    : { drop: true };
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
