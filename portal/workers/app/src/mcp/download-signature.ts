/**
 * Signed download URLs (#707). One HMAC-SHA256 under `MCP_DOWNLOAD_SECRET` (never `TRANSFORM_SOURCE_SECRET`) binds the target, the
 * expiry, the user, the authorization epoch and the connection. The query has one canonical shape: `?u=&c=&e=&exp=&sig=`.
 */
export const DOWNLOAD_MAX_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_QUERY_NAMES = ["c", "e", "exp", "sig", "u"] as const;

export type DownloadTarget =
  | { kind: "asset"; assetId: string; variant: string }
  | { kind: "zip"; projectId: string; ticket: string };
export type DownloadClaims = { target: DownloadTarget; exp: number; userId: string; authorizationEpoch: number; connectionId: string };

const encoder = new TextEncoder();

/** JSON of a fixed-order array: no delimiter an id could smuggle, so two distinct claim sets never share a canonical string. */
function canonical(claims: DownloadClaims): string {
  const { target } = claims;
  const subject = target.kind === "asset" ? ["asset", target.assetId, target.variant] : ["zip", target.projectId, target.ticket];
  return JSON.stringify(["mcp-download-v1", ...subject, claims.exp, claims.userId, claims.authorizationEpoch, claims.connectionId]);
}

const hexOf = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hmacKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signDownload(secret: string, claims: DownloadClaims): Promise<string> {
  return hexOf(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(canonical(claims))));
}

/** Constant-time: `crypto.subtle.verify` compares the MAC without an early exit. */
export async function verifyDownload(secret: string, claims: DownloadClaims, signature: string): Promise<boolean> {
  const bytes = bytesOfHex(signature);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, encoder.encode(canonical(claims)));
}

export function downloadPath(target: DownloadTarget): string {
  return target.kind === "asset"
    ? `/dl/asset/${encodeURIComponent(target.assetId)}/${encodeURIComponent(target.variant)}`
    : `/dl/zip/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.ticket)}`;
}

export function buildDownloadUrl(origin: string, claims: DownloadClaims, signature: string): string {
  const url = new URL(downloadPath(claims.target), origin);
  url.searchParams.set("u", claims.userId);
  url.searchParams.set("c", claims.connectionId);
  url.searchParams.set("e", String(claims.authorizationEpoch));
  url.searchParams.set("exp", String(claims.exp));
  url.searchParams.set("sig", signature);
  return url.href;
}

/** The claims a request's query carries, or null unless the query is exactly the canonical shape with well-formed values. */
export function parseDownloadQuery(target: DownloadTarget, query: URLSearchParams): { claims: DownloadClaims; signature: string } | null {
  const names = [...query.keys()].sort();
  if (names.join(",") !== DOWNLOAD_QUERY_NAMES.join(",")) return null;
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const userId = query.get("u")!, connectionId = query.get("c")!, epoch = query.get("e")!, exp = query.get("exp")!;
  if (!ID.test(userId) || !ID.test(connectionId) || !/^\d{1,15}$/.test(epoch) || !/^\d{1,15}$/.test(exp)) return null;
  return { claims: { target, exp: Number(exp), userId, authorizationEpoch: Number(epoch), connectionId }, signature: query.get("sig")! };
}
