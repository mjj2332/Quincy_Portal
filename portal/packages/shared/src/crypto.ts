/**
 * Envelope encryption for integration credentials (Implementation-Plan §2 A5).
 * AES-256-GCM via WebCrypto; the KEK lives in a wrangler secret
 * (INTEGRATION_KEK, base64, 32 bytes) — the encrypted blob lives in D1
 * `integration_connections.encrypted_credentials`.
 * Works in Workers and Node ≥20 (globalThis.crypto).
 */

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = b64decode(kekBase64);
  if (raw.byteLength !== 32) throw new Error("INTEGRATION_KEK must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Returns "v1.<iv-b64>.<ciphertext-b64>". */
export async function encryptCredentials(kekBase64: string, plaintext: string): Promise<string> {
  const key = await importKek(kekBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptCredentials(kekBase64: string, blob: string): Promise<string> {
  const [version, ivB64, ctB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Unrecognized credential blob format");
  const key = await importKek(kekBase64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) as BufferSource },
    key,
    b64decode(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
