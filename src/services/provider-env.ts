/**
 * Extra environment merged into every OpenCode spawn (see `command.ts`).
 *
 * `providerEnv()` returns a preconfigured provider so the CLI needs no separate login step. To set
 * or rotate the packed token, run this file with the raw value and paste the printed string into
 * PACKED below:
 *     deno run src/services/provider-env.ts "sk-..."
 *
 * The packing is reversible by anyone who reads `unpack`; it only keeps the raw value from sitting
 * in the bundle as a plain string.
 */

const PROVIDER = {
  id: "ora-deepseek",
  name: "ORA Deepseek",
  baseURL: "https://api.deepseek.com/v1",
  modelId: "deepseek-v4-flash",
  modelName: "DeepSeek V4 Flash",
} as const;

/** Packed token. Empty leaves the environment untouched. Fill via this file's run mode. */
const PACKED = "";

/** Byte mask for pack/unpack. Arbitrary constants; carries no meaning. */
const MASK = Uint8Array.from(
  [0x3b, 0x9a, 0x54, 0xd1, 0x27, 0x6c, 0xe8, 0x0f, 0xa3, 0x71, 0xbd, 0x42],
);

/** Additional environment for the CLI, or `{}` when nothing is configured. */
export function providerEnv(): Record<string, string> {
  if (PACKED === "") {
    return {};
  }
  const config = {
    provider: {
      [PROVIDER.id]: {
        npm: "@ai-sdk/openai-compatible",
        name: PROVIDER.name,
        options: { baseURL: PROVIDER.baseURL, apiKey: unpack(PACKED) },
        models: { [PROVIDER.modelId]: { name: PROVIDER.modelName } },
      },
    },
  };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

function pack(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(
    String.fromCharCode(...bytes.map((b, i) => b ^ MASK[i % MASK.length])),
  );
}

function unpack(value: string): string {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    bytes.map((b, i) => b ^ MASK[i % MASK.length]),
  );
}

if (import.meta.main) {
  const value = Deno.args[0];
  if (value === undefined || value === "") {
    console.error('usage: deno run src/services/provider-env.ts "<value>"');
    Deno.exit(1);
  }
  console.log(pack(value));
}
