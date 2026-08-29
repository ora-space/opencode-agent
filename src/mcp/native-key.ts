import { McpMaterializationError } from "./errors.ts";
import { sha256Hex } from "./fingerprint.ts";

export type IdentityDigest = (canonicalIdentity: string) => Promise<string>;

const NATIVE_KEY = /^ora_[a-z0-9_-]{0,48}_[a-f0-9]{12}$/;
const MAX_NATIVE_KEY_LENGTH = 65;

/**
 * Derives the version-independent OpenCode key mandated by MCP Configuration protocol v1.
 *
 * The digest is computed from the unmodified identity so truncation and punctuation folding do
 * not silently merge identities. The injectable digest is solely a deterministic collision-test
 * seam; production always uses SHA-256.
 */
export async function nativeMcpKey(
  canonicalIdentity: string,
  digest: IdentityDigest = sha256Hex,
): Promise<string> {
  if (
    canonicalIdentity.length === 0 ||
    canonicalIdentity !== canonicalIdentity.toLowerCase()
  ) {
    throw new McpMaterializationError("mcp_materialization_conflict");
  }
  const readable = canonicalIdentity
    .replaceAll(/[^a-z0-9_-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 48);
  const fullDigest = await digest(canonicalIdentity);
  if (!/^[a-f0-9]{64}$/.test(fullDigest)) {
    throw new McpMaterializationError("mcp_materialization_conflict");
  }
  const key = `ora_${readable}_${fullDigest.slice(0, 12)}`;
  if (!NATIVE_KEY.test(key) || key.length > MAX_NATIVE_KEY_LENGTH) {
    throw new McpMaterializationError("mcp_materialization_conflict");
  }
  return key;
}

/** Rejects the final key map if two distinct identities ever defeat digest disambiguation. */
export function assertNoNativeKeyCollisions(
  entries: readonly { canonicalIdentity: string; nativeKey: string }[],
): void {
  const identitiesByKey = new Map<string, string>();
  for (const entry of entries) {
    const existing = identitiesByKey.get(entry.nativeKey);
    if (existing !== undefined && existing !== entry.canonicalIdentity) {
      throw new McpMaterializationError("mcp_native_key_collision");
    }
    identitiesByKey.set(entry.nativeKey, entry.canonicalIdentity);
  }
}
