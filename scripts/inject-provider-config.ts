/** Embeds the ignored local config.toml into the already bundled plugin. */

const CONFIG_FILE = "config.toml";
const DIST_MAIN = "dist/main.js";
const MARKER = '"__ORA_PROVIDER_CONFIG__"';

const source = await Deno.readTextFile(CONFIG_FILE).catch(() => {
  throw new Error(
    `${CONFIG_FILE} is required when building the provider-enabled bundle`,
  );
});
const values = parseConfig(source);
const config = {
  $schema: "https://opencode.ai/config.json",
  model: `${values.id}/${values.modelId}`,
  provider: {
    [values.id]: {
      name: values.name,
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: values.baseURL,
        apiKey: "__ORA_API_KEY__",
        body: { stream: true },
      },
      models: {
        [values.modelId]: {
          name: values.modelName,
          options: { body: { stream: true } },
        },
      },
    },
  },
};
const embedded = {
  config,
  providerId: values.id,
  encodedApiKey: values.encodedApiKey,
  mask: values.mask,
};

let bundle = await Deno.readTextFile(DIST_MAIN);
if (!bundle.includes(MARKER)) {
  throw new Error(`provider config marker not found in ${DIST_MAIN}`);
}
bundle = bundle.replace(MARKER, JSON.stringify(JSON.stringify(embedded)));
await Deno.writeTextFile(DIST_MAIN, bundle);
console.log(`provider config injected from ${CONFIG_FILE}`);

interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  modelId: string;
  modelName: string;
  encodedApiKey: string;
  mask: number[];
}

function parseConfig(source: string): ProviderConfig {
  const section = source.match(/\[provider\]([\s\S]*)/i)?.[1] ?? "";
  const get = (key: string): string => {
    const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "mi"));
    if (match === null || match[1].trim() === "") {
      throw new Error(`${CONFIG_FILE} is missing provider.${key}`);
    }
    return match[1].trim();
  };
  const mask = section.match(/^mask\s*=\s*\[([^\]]+)\]/mi);
  if (mask === null) throw new Error(`${CONFIG_FILE} is missing provider.mask`);
  return {
    id: get("id"),
    name: get("name"),
    baseURL: get("base_url"),
    modelId: get("model_id"),
    modelName: get("model_name"),
    encodedApiKey: get("encoded_api_key"),
    mask: mask[1].split(",").map((value) => Number(value.trim())),
  };
}
