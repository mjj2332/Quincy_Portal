import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv, Env } from "../env";

/**
 * HTTP plumbing of the guest surface (#741 12a): the one response wrapper, the Origin check and the cookie. The wrapper is a function around each handler and not a `.use()`,
 * because router-wide middleware leaks across sibling mounts (docs/lessons.md). Nothing here reads a staff session.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_MAX_MS = 7 * 86_400_000;

const HYGIENE: Record<string, string> = { "referrer-policy": "no-referrer", "cache-control": "private, no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" };

/** Every `/d` response, the stub and a failure included, carries these, so a stub is the same bytes wherever it comes from. */
export function withHygiene(response: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...HYGIENE, ...extra })) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The one miss: unknown, expired, revoked, replaced, out of pilot, wrong credential and the `/d/*` fallback all answer with this. */
export const guestNotFound = (c: Context<AppEnv>): Promise<Response> => Promise.resolve(c.notFound()).then((response) => withHygiene(response));

/** A guest route: terminal for the manifest, hygiene on whatever it returns, and an unexpected throw is a bare 500 that names nothing. */
export function guestRoute<P extends string>(path: P, handler: (c: Context<AppEnv, P>) => Response | Promise<Response>) {
  return terminalRoute(path, async (c) => {
    try { return withHygiene(await handler(c)); }
    catch { return withHygiene(c.json({ error: "server_error" }, 500)); }
  });
}

/** Unsafe methods need the app Origin and a JSON content type, else 403 `invalid_origin`. The staff `requireAppOrigin` is mounted on `/api` only, so the guest surface has its own. */
export function originRejection(c: Context<AppEnv>): Response | null {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD") return null;
  const jsonBody = /^application\/json(\s*;|$)/i.test(c.req.header("content-type") ?? "");
  if (c.req.header("origin") !== c.env.APP_ORIGIN || !jsonBody) return c.json({ error: "invalid_origin" }, 403);
  return null;
}

/** Only `http://localhost` drops `Secure` and the `__Secure-` prefix (Chrome accepts a Secure cookie there either way, but Safari does not). */
export function isLocalDev(env: Pick<Env, "APP_ORIGIN">): boolean {
  try { const origin = new URL(env.APP_ORIGIN); return origin.protocol === "http:" && origin.hostname === "localhost"; } catch { return false; }
}
export const guestCookieName = (env: Pick<Env, "APP_ORIGIN">, linkId: string): string => `${isLocalDev(env) ? "" : "__Secure-"}quincy_guest_${linkId}`;
export const guestCookiePath = (linkId: string): string => `/d/api/links/${linkId}`;

/** `Path` is this link's API only, so a browser never sends the cookie anywhere else and two links work side by side. `__Host-` is impossible: it forces `Path=/`. */
export function sessionCookieHeader(env: Pick<Env, "APP_ORIGIN">, linkId: string, token: string, maxAgeSeconds: number): string {
  return `${guestCookieName(env, linkId)}=${token}; Path=${guestCookiePath(linkId)}; HttpOnly; ${isLocalDev(env) ? "" : "Secure; "}SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
export const readSessionCookie = (c: Context<AppEnv>, linkId: string): string | null => getCookie(c, guestCookieName(c.env, linkId)) ?? null;

/** Constant-time equality of two strings, as UTF-8 bytes (the link token hash is compared with this). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder(); const x = encoder.encode(a); const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index]! ^ y[index]!;
  return difference === 0;
}

export const BODY_MAX_BYTES = 2048;
/**
 * The one way a guest handler reads a body. A declared `Content-Length` over the limit is refused before a byte is read; otherwise the stream is read chunk by chunk and the reader is
 * cancelled the moment the count passes the limit, so an unauthenticated caller cannot make the Worker buffer more than the limit. Returns the text, or `null` when too large.
 */
export async function readBoundedText(request: Request, max: number = BODY_MAX_BYTES): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) { await request.body?.cancel().catch(() => undefined); return null; }
  if (!request.body) return "";
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export const INVALID = Symbol("invalid");
export const TOO_LARGE = Symbol("too_large");
/** The parsed JSON body, `TOO_LARGE` over `max` bytes (413 for the caller) or `INVALID` when it is not JSON (400). */
export async function readJson(c: Context<AppEnv>, max: number = BODY_MAX_BYTES): Promise<unknown | typeof INVALID | typeof TOO_LARGE> {
  const text = await readBoundedText(c.req.raw, max);
  if (text === null) return TOO_LARGE;
  try { return JSON.parse(text) as unknown; } catch { return INVALID; }
}

/** 429 with `Retry-After`: the one answer to every rate limit on the guest surface. */
export const tooMany = (retryAfterSeconds: number): Response => Response.json({ error: "too_many_attempts", retryAfterSeconds }, { status: 429, headers: { "retry-after": String(retryAfterSeconds) } });
