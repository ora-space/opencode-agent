import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip-js/zip-js";

/** The package-relative declaration validated by the host's shared compiler. */
export const AGENT_DECLARATION_ENTRY = "assets/config.json";
/** Static copy distributed alongside an explicitly opted-in release. */
export const AGENT_DECLARATION_COPY = "agent-configuration.json";

/** Exact bytes held once for every target, its copy and the final release association. */
export interface AgentDeclarationPublication {
  bytes: Uint8Array;
  schemaVersion: number;
  sha256: string;
}

/** Reads only an explicitly requested declaration; default packaging never calls this function. */
export async function readAgentDeclaration(
  path: string,
): Promise<AgentDeclarationPublication> {
  const stat = await Deno.lstat(path);
  if (!stat.isFile || stat.size > 256 * 1024) {
    throw new Error("invalid Agent declaration file");
  }
  const bytes = await Deno.readFile(path);
  if (bytes.length > 256 * 1024) {
    throw new Error("Agent declaration exceeds size limit");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    typeof parsed !== "object" || parsed === null ||
    !("schemaVersion" in parsed) || parsed.schemaVersion !== 2
  ) throw new Error("unsupported Agent declaration schema");
  return { bytes, schemaVersion: 2, sha256: await digest(bytes) };
}

/** Emits no association until the caller explicitly provided verified publication bytes. */
export function agentDeclarationManifest(
  publication: AgentDeclarationPublication | undefined,
): string {
  return publication
    ? `\n\n[agent_configuration]\nschema_version = ${publication.schemaVersion}\ndeclaration_sha256 = "${publication.sha256}"\ncopy = "${AGENT_DECLARATION_COPY}"`
    : "";
}

/** Rejects missing, duplicate or modified packaged copies before their association is published. */
export async function verifyPackagedAgentDeclaration(
  path: string,
  publication: AgentDeclarationPublication,
): Promise<void> {
  const archive = await Deno.readFile(path);
  const reader = new ZipReader(new BlobReader(new Blob([archive])));
  try {
    const entries = (await reader.getEntries()).filter((entry) =>
      entry.filename === AGENT_DECLARATION_ENTRY
    );
    const entry = entries[0];
    if (
      entries.length !== 1 || !entry || entry.directory ||
      entry.uncompressedSize > 256 * 1024
    ) throw new Error("package Agent declaration is missing or invalid");
    const bytes = await entry.getData(new Uint8ArrayWriter());
    if (await digest(bytes) !== publication.sha256) {
      throw new Error("package Agent declaration differs from publication");
    }
  } finally {
    await reader.close();
  }
}

/** Hashes immutable source bytes, rather than a parsed/reserialized approximation. */
async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
