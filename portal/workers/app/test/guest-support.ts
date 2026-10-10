import { SELF as workerSelf } from "cloudflare:test";
import { hashToken, randomToken } from "../src/lib/opaque-token";
import { baseEnv, database, ids } from "./embedded-media-support";
import { clearVideoFlags, setVideoFlags } from "./video-review-support";

/** Fixtures for the guest review surface (#741 12a): link, member and grant rows go in directly (11a is a separate PR). */
export const guestOrigin = baseEnv.APP_ORIGIN;
export const GUEST_WINDOW_MS = 15 * 60_000;

/** Master flag, pilot scope and the `guest` part (plus the two capability parts, `guest_comments` and `delivery`, which 13a makes the `allow` flags depend on): what a guest link needs before any `/d` route answers. */
export const guestFlags = (projectId: string = ids.project) => ["video_review", `video_review_pilot:${projectId}`, "video_review_guest", "video_review_guest_comments", "video_review_delivery"] as const;
export async function openGuestGate(projectId: string = ids.project) { await clearVideoFlags(); await setVideoFlags(...guestFlags(projectId)); }

export type LinkInput = { projectId?: string; expiresAt?: number; passcodeHash?: string | null; kind?: "video_review" | "delivery"; revoked?: boolean; label?: string | null; generation?: number; allow?: [number, number, number] };
export async function seedGuestLink(input: LinkInput = {}) {
  const id = crypto.randomUUID(); const token = randomToken(); const tokenHash = await hashToken(token); const now = Date.now();
  const allow = input.allow ?? [1, 1, 1];
  await database.DB.prepare(`INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, created_at, kind, label, allow_comments, allow_approve, allow_download, created_by, token_generation, updated_at, revoked_at, revoked_by)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.projectId ?? ids.project, tokenHash, input.expiresAt ?? now + 30 * 86_400_000, input.passcodeHash ?? null, now, input.kind ?? "video_review", input.label === undefined ? "Smith family" : input.label,
      allow[0], allow[1], allow[2], ids.member, input.generation ?? 1, now, input.revoked ? now : null, input.revoked ? ids.member : null).run();
  return { id, token, tokenHash };
}

/** A Video on the link, with the listed Versions granted (live). */
export async function addMember(linkId: string, videoId: string, grantedAssetIds: string[], projectId: string = ids.project) {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), linkId, videoId, projectId, ids.member, now).run();
  for (const assetId of grantedAssetIds) await grant(linkId, videoId, assetId);
}
export async function grant(linkId: string, videoId: string, assetId: string) {
  await database.DB.prepare("INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), linkId, videoId, assetId, ids.member, Date.now()).run();
}

/** A fresh client address per call, so rate-limit buckets never bleed between cases. */
export const freshIp = () => `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID().slice(0, 8)}`;

type GuestInit = { method?: string; body?: unknown; cookie?: string | null; ip?: string; headers?: Record<string, string>; origin?: string | null; contentType?: string | null; url?: string };
/** A guest request. Unsafe methods carry the app Origin and a JSON content type unless a case overrides them. */
export async function guestFetch(path: string, init: GuestInit = {}): Promise<Response> {
  const method = init.method ?? "GET"; const headers = new Headers({ "cf-connecting-ip": init.ip ?? freshIp(), ...init.headers });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (method !== "GET" && method !== "HEAD") {
    if (init.origin !== null) headers.set("origin", init.origin ?? guestOrigin);
    if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
  }
  return workerSelf.fetch(`${init.url ?? "https://portal.test"}${path}`, { method, headers, ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }) });
}

export const linkPath = (linkId: string, rest = "") => `/d/api/links/${linkId}${rest}`;
export const cookieName = (linkId: string) => `__Secure-quincy_guest_${linkId}`;
/** The `name=value` pair of the session cookie a response set, or null. */
export function sessionCookie(response: Response, linkId: string): string | null {
  const raw = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${cookieName(linkId)}=`));
  return raw ? raw.split(";")[0]! : null;
}
export async function startSession(link: { id: string; token: string }, passcode?: string, ip?: string): Promise<{ response: Response; cookie: string | null }> {
  const response = await guestFetch(linkPath(link.id, "/session"), { method: "POST", body: { token: link.token, ...(passcode === undefined ? {} : { passcode }) }, ...(ip ? { ip } : {}) });
  return { response, cookie: sessionCookie(response, link.id) };
}
/** A link with a started session, ready for the read routes. */
export async function linkWithSession(input: LinkInput = {}) {
  const link = await seedGuestLink(input); const { cookie, response } = await startSession(link);
  if (!cookie) throw new Error(`linkWithSession: exchange answered ${response.status}`);
  return { ...link, cookie };
}

export const HYGIENE = { "referrer-policy": "no-referrer", "cache-control": "private, no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" } as const;
export async function sha256Hex(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export const clearGuestRows = async () => { await database.DB.batch([database.DB.prepare("DELETE FROM guest_rate_limits"), database.DB.prepare("DELETE FROM guest_sessions"), database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM client_links WHERE kind = 'video_review'")]); };

export type SentEmail = { from: string; to: string; subject: string; text: string; html: string };
/**
 * Replaces the Worker's `EMAIL` binding and sender address with a spy (the test and the Worker share one `env` object). `fail` makes `send` throw it. `restore()` puts the originals back.
 * `configured: false` removes both, the way a Worker without the binding looks.
 */
export function mockEmail(options: { fail?: unknown; configured?: boolean } = {}) {
  const mutable = baseEnv as unknown as Record<string, unknown>; const original = { email: mutable.EMAIL, from: mutable.NOTIFICATIONS_FROM_ADDRESS };
  const sent: SentEmail[] = [];
  if (options.configured === false) { delete mutable.EMAIL; delete mutable.NOTIFICATIONS_FROM_ADDRESS; }
  else {
    mutable.EMAIL = { send: async (message: SentEmail) => { if (options.fail !== undefined) throw options.fail; sent.push(message); return { messageId: `message-${sent.length}` }; } };
    mutable.NOTIFICATIONS_FROM_ADDRESS = "studio@example.test";
  }
  return { sent, restore() { mutable.EMAIL = original.email; mutable.NOTIFICATIONS_FROM_ADDRESS = original.from; } };
}
