/**
 * The confirm token for an outward or destructive action (#709, made reusable per action in #961). The first call reads what the
 * action would do and returns a token; the second call presents it. One HMAC-SHA256 binds the action, the connection, the Project,
 * the hash of the summary the user was shown and the expiry. `delete_project` is the first action; Publish, Unlock and the other
 * outward actions mint their own with their own action name, and never need to edit this file.
 *
 * The action name is inside the signed message, so a token minted for one action never verifies as another (domain separation per
 * action). The key is `MCP_DOWNLOAD_SECRET`, reused deliberately rather than adding a secret. A distinct domain-separation prefix
 * keeps a confirm token from ever verifying as a download signature (those start `["mcp-download-v1",`) or the reverse.
 *
 * Token shape: `<exp>.<summaryHash>.<signature>` (decimal seconds, hex sha256, hex HMAC). The hash travels in the token so the
 * writer can tell "forged" (signature fails) from "the Project changed since" (signature holds, hash differs from a fresh summary).
 */
export const CONFIRM_TTL_SECONDS = 5 * 60;
const DOMAIN = "mcp-confirm-v2\n";

/** `action` is the tool's own name for what is being confirmed (`delete_project`, and so on): one name per action, never shared. */
export type ConfirmClaims = { action: string; connectionId: string; projectId: string; summaryHash: string; exp: number };
export type ConfirmScope = Pick<ConfirmClaims, "action" | "connectionId" | "projectId">;

const encoder = new TextEncoder();
const hexOf = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const hmacKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
/** A JSON array, so no delimiter an id or action name could smuggle makes two claim sets share a message. */
const message = (claims: ConfirmClaims) => encoder.encode(DOMAIN + JSON.stringify([claims.action, claims.connectionId, claims.projectId, claims.summaryHash, claims.exp]));

export async function sha256Hex(text: string): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function signConfirmToken(secret: string, claims: ConfirmClaims): Promise<string> {
  if (claims.action === "") throw new Error("A confirm token needs an action name.");
  const signature = hexOf(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), message(claims)));
  return `${claims.exp}.${claims.summaryHash}.${signature}`;
}

export type ConfirmVerdict = { ok: true; summaryHash: string } | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Signature first (constant-time), then expiry. A token for another action, connection or Project fails at the signature. */
export async function verifyConfirmToken(secret: string, token: string, expected: ConfirmScope, nowSeconds: number): Promise<ConfirmVerdict> {
  const match = /^(\d{1,15})\.([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(token);
  if (!match || expected.action === "") return { ok: false, reason: "malformed" };
  const claims: ConfirmClaims = { ...expected, summaryHash: match[2]!, exp: Number(match[1]) };
  const signature = bytesOfHex(match[3]!);
  if (!signature || !await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, message(claims))) return { ok: false, reason: "signature" };
  if (claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, summaryHash: claims.summaryHash };
}
