/**
 * The confirm token for `delete_project` (#709). The first call reads what a delete would destroy and returns a token; the second
 * call presents it. One HMAC-SHA256 binds the connection, the Project, the hash of the summary the user was shown and the expiry.
 *
 * The key is `MCP_DOWNLOAD_SECRET`, reused deliberately rather than adding a secret. A distinct domain-separation prefix keeps a
 * confirm token from ever verifying as a download signature (those start `["mcp-download-v1",`) or the reverse.
 *
 * Token shape: `<exp>.<summaryHash>.<signature>` (decimal seconds, hex sha256, hex HMAC). The hash travels in the token so the
 * writer can tell "forged" (signature fails) from "the Project changed since" (signature holds, hash differs from a fresh summary).
 */
export const CONFIRM_TTL_SECONDS = 5 * 60;
const DOMAIN = "mcp-confirm-v1\n";

export type ConfirmClaims = { connectionId: string; projectId: string; summaryHash: string; exp: number };

const encoder = new TextEncoder();
const hexOf = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hmacKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
/** A JSON array, so no delimiter an id could smuggle makes two claim sets share a message. */
const message = (claims: ConfirmClaims) => encoder.encode(DOMAIN + JSON.stringify([claims.connectionId, claims.projectId, claims.summaryHash, claims.exp]));

export async function sha256Hex(text: string): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function signConfirmToken(secret: string, claims: ConfirmClaims): Promise<string> {
  const signature = hexOf(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), message(claims)));
  return `${claims.exp}.${claims.summaryHash}.${signature}`;
}

export type ConfirmVerdict = { ok: true; summaryHash: string } | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Signature first (constant-time), then expiry. A token for another connection or Project fails at the signature. */
export async function verifyConfirmToken(secret: string, token: string, expected: { connectionId: string; projectId: string }, nowSeconds: number): Promise<ConfirmVerdict> {
  const match = /^(\d{1,15})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return { ok: false, reason: "malformed" };
  const claims: ConfirmClaims = { connectionId: expected.connectionId, projectId: expected.projectId, summaryHash: match[2]!, exp: Number(match[1]) };
  const signature = bytesOfHex(match[3]!);
  if (!signature || !await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, message(claims))) return { ok: false, reason: "signature" };
  if (claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, summaryHash: claims.summaryHash };
}
