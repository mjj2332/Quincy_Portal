import { TRANSFORM_CACHE_VERSION } from "./media";

/** Short-lived HMAC contract for the private source used by Image Transformations. */
export const TRANSFORM_SOURCE_VERSION = "v2";
// Cloudflare can retain transformed output after a source URL has expired. This expiry only
// authorizes a cold source fetch; the browser-facing transform URL is a bearer URL whose
// effective lifetime is the Images cache lifetime (currently at least an hour), not five
// minutes or a revocation promise.
export const TRANSFORM_SOURCE_TTL_SECONDS = 120;
export const TRANSFORM_SOURCE_CLOCK_SKEW_SECONDS = 30;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equal(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function expiry(value: string | number): number | null {
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const PRINCIPAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validPrincipal(principalId: string): boolean {
  return PRINCIPAL_ID.test(principalId);
}

function validEpoch(authorizationEpoch: number): boolean {
  return Number.isSafeInteger(authorizationEpoch) && authorizationEpoch >= 0;
}

function payload(key: string, expiresAt: number, principalId: string, authorizationEpoch: number, cacheVersion: string): string {
  // The byte length makes the final key field unambiguous even if a future R2 key
  // convention permits separators/newlines.
  return `${TRANSFORM_SOURCE_VERSION}\n${cacheVersion}\n${expiresAt}\n${principalId}\n${authorizationEpoch}\n${encoder.encode(key).byteLength}\n${key}`;
}

async function digest(secret: string, key: string, expiresAt: number, principalId: string, authorizationEpoch: number, cacheVersion: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload(key, expiresAt, principalId, authorizationEpoch, cacheVersion))));
}

export async function signTransformSource(secret: string | undefined, key: string, expiresAt: number, principalId: string, authorizationEpoch: number, cacheVersion = TRANSFORM_CACHE_VERSION): Promise<string | null> {
  if (!secret || !Number.isSafeInteger(expiresAt) || !validPrincipal(principalId) || !validEpoch(authorizationEpoch)) return null;
  if (cacheVersion !== TRANSFORM_CACHE_VERSION) return null;
  return digest(secret, key, expiresAt, principalId, authorizationEpoch, cacheVersion);
}

export async function issueTransformSource(secret: string | undefined, key: string, principalId: string, authorizationEpoch: number, nowSeconds = Math.floor(Date.now() / 1000), cacheVersion = TRANSFORM_CACHE_VERSION) {
  const expiresAt = nowSeconds + TRANSFORM_SOURCE_TTL_SECONDS;
  const signature = await signTransformSource(secret, key, expiresAt, principalId, authorizationEpoch, cacheVersion);
  return signature ? { expiresAt, signature, cacheVersion } : null;
}

export async function verifyTransformSource(
  secret: string | undefined,
  key: string,
  signature: string | undefined,
  expiresAt: string | undefined,
  principalId: string | undefined,
  authorizationEpoch: string | undefined,
  cacheVersion: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature) || !principalId || !validPrincipal(principalId) || cacheVersion !== TRANSFORM_CACHE_VERSION) return false;
  const parsedExpiry = expiresAt === undefined ? null : expiry(expiresAt);
  const parsedEpoch = authorizationEpoch === undefined ? null : expiry(authorizationEpoch);
  if (parsedExpiry === null || parsedEpoch === null || !validEpoch(parsedEpoch) || !Number.isSafeInteger(nowSeconds)) return false;
  if (parsedExpiry < nowSeconds - TRANSFORM_SOURCE_CLOCK_SKEW_SECONDS) return false;
  if (parsedExpiry > nowSeconds + TRANSFORM_SOURCE_TTL_SECONDS + TRANSFORM_SOURCE_CLOCK_SKEW_SECONDS) return false;
  const expected = await signTransformSource(secret, key, parsedExpiry, principalId, parsedEpoch, cacheVersion);
  return expected !== null && equal(signature, expected);
}
