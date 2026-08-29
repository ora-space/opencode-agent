/** Returns the Host-canonical SHA-256 fingerprint of exactly the supplied bytes. */
export async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  // Copying narrows a possibly shared backing buffer to the ArrayBuffer WebCrypto accepts.
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Returns the lowercase SHA-256 hex of one UTF-8 string for native-key derivation. */
export async function sha256Hex(value: string): Promise<string> {
  return (await fingerprintBytes(new TextEncoder().encode(value))).slice(7);
}
