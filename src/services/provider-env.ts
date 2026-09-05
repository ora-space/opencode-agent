/**
 * Extra environment merged into every OpenCode spawn (see `command.ts`).
 *
 * `deno task build` replaces `EMBEDDED_CONFIG` with the provider described by the ignored local
 * `config.toml`. `providerEnv()` decodes its packed token at runtime so the CLI needs no separate
 * login step.
 *
 * The packing is reversible by anyone who reads `unpack`; it only keeps the raw value from sitting
 * in the bundle as a plain string.
 */

/** Replaced in the production bundle by scripts/inject-provider-config.ts. */
const EMBEDDED_CONFIG = "__ORA_PROVIDER_CONFIG__";

/** Additional environment for the CLI, or `{}` when nothing is configured. */
export function providerEnv(): Record<string, string> {
  if (EMBEDDED_CONFIG === "__ORA_PROVIDER_CONFIG__") {
    return {};
  }
  const embedded = JSON.parse(EMBEDDED_CONFIG) as EmbeddedProviderConfig;
  const provider = embedded.config.provider[embedded.providerId];
  provider.options.apiKey = unpack(embedded.encodedApiKey, embedded.mask);
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(embedded.config) };
}

interface EmbeddedProviderConfig {
  config: {
    provider: Record<string, { options: Record<string, unknown> }>;
    [key: string]: unknown;
  };
  providerId: string;
  encodedApiKey: string;
  mask: number[];
}

function unpack(value: string, mask: number[]): string {
  const bytes = Uint8Array.from(
    atob(value),
    (character) => character.charCodeAt(0),
  );
  return new TextDecoder().decode(
    bytes.map((byte, index) => byte ^ mask[index % mask.length]),
  );
}
