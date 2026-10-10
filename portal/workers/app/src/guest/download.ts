import type { Context, Hono } from "hono";
import { GUEST_ZIP_MAX_BYTES, GUEST_ZIP_MAX_ENTRIES, guestDownloadManifestSchema, type GuestDownloadManifest, type VideoReviewPart } from "@quincy/shared";
import { auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { gateSql, liveSql, reachSql } from "../lib/guest-fence-sql";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { createZipStream, type ZipStreamEntry } from "../lib/zip-stream";
import type { AppEnv, Env } from "../env";
import { classifyRefusal, type RefusalScope } from "./fence";
import { guestNotFound, guestRoute, originRejection, tooMany, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestLink, type GuestSession } from "./link";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";

/**
 * Guest downloads (#741 14b): one released Version, the manifest of Download all, and the streaming zip. A download is a READ, so there is no body and no Origin step (the shared check passes
 * GET and HEAD), and an archived Project still downloads. But every gate runs before any R2 read, so GET, HEAD and Range are refused alike (story 90). The order, as `approval.ts` and
 * docs/plans/741-13-15.md section 1.1:
 *
 *  1. path ids are UUIDs, else the stub;  2. the link is active, the gate is open and the `guest` and `delivery` parts are on, else the stub;  3. Origin (a no-op for GET and HEAD);
 *  4. the session cookie, else the stub;  5. capability: unverified is 401, `allow_download` off is 403;  6. visibility: the Version is reachable through a live member and a live grant, else the stub;
 *  7. (no archive step);  8. zip only: the start is rate limited (429);  9. (no body);  10. state: not released 409, premium locked 403, nothing to zip 409, too large 422.
 *
 * Every non-success answer after the credential goes through `classifyRefusal` (./fence.ts), so lost access is the byte-identical stub. The audit row is a fenced INSERT ... SELECT written
 * BEFORE any byte streams (as the staff `project.download_selection`): it carries the whole fence, and an INSERT that lands nothing is a refusal. The zip re-authorises the session, the
 * Release and the unlock before EACH entry and errors the stream the moment any is lost, so a truncated archive can never look complete.
 */
const PARTS: readonly VideoReviewPart[] = ["guest", "delivery"];
type Ctx = Context<AppEnv>;
const plain = <C>(c: C) => c as unknown as Ctx;
const open = (link: GuestLink | null): link is GuestLink => link !== null && PARTS.every((part) => link.parts.includes(part));
const SECURITY_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" } as const;

/** A file name with nothing in it that a path, a header or an archive could read as structure. */
export function safeFileName(title: string): string {
  // Lone surrogates (a stored title can hold one) become U+FFFD, and the cut is by code point, so `encodeURIComponent` never throws.
  const cleaned = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return [...cleaned].slice(0, 120).join("").trim() || "Video";
}
/** `attachment` with a quoted ASCII fallback and the RFC 5987 UTF-8 name. Never interpolates an unsanitised title. */
export function attachment(filename: string): string {
  const fallback = [...filename].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== "%" && ch !== '"' && ch !== "\\" ? ch : "_")).join("");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
const entryName = (title: string, version: number): string => `${safeFileName(title)} v${version}.mp4`;

// -- SQL: the fence a committing statement and every zip entry repeat. Aliases: `s` guest_sessions, `l` client_links. Downloads read, so there is NO unarchived test here. --
type Binds = { session: string; token: string; guest: string; now: string };
const sessionFence = (b: Binds): string => `s.id = ${b.session} AND s.token_hash = ${b.token} AND s.guest_id = ${b.guest} AND s.verified_at IS NOT NULL AND l.allow_download = 1 AND ${liveSql(b.now)} AND ${gateSql(PARTS)}`;
/** The Version has a live Release and its Video is not a locked premium one. `asset` is a SQL expression. */
const deliverableSql = (asset: string): string => `EXISTS (SELECT 1 FROM video_releases dr JOIN videos dv ON dv.id = dr.video_id WHERE dr.asset_id = ${asset} AND dr.withdrawn_at IS NULL
    AND (dv.premium = 0 OR EXISTS (SELECT 1 FROM video_premium_unlocks du WHERE du.video_id = dv.id)))`;

/** Whether this session may still be handed `assetId` (or, with null, anything at all): the same predicate the audit INSERT carries, at a fresh time. */
async function stillAllowed(db: D1Database, session: GuestSession, assetId: string | null): Promise<boolean> {
  if (session.guestId === null) return false;
  const asset = assetId === null ? "" : ` AND ${reachSql("l.id", "l.project_id", "?5")} AND ${deliverableSql("?5")}`;
  const row = await db.prepare(`SELECT 1 AS ok FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE ${sessionFence({ session: "?1", token: "?2", guest: "?3", now: "?4" })}${asset}`)
    .bind(session.id, session.tokenHash, session.guestId, Date.now(), ...(assetId === null ? [] : [assetId])).first();
  return row !== null;
}

type Entered = { session: GuestSession; guestId: string; answer: (response: Response) => Promise<Response> };
/** Steps 1 to 5: the response that ends the request, or the session with an `answer` that re-classifies any non-success first. */
async function enter(c: Ctx, assetId?: string): Promise<Entered | Response> {
  const linkId = c.req.param("linkId") ?? "";
  const stub = () => guestNotFound(c);
  if (assetId !== undefined && !UUID.test(assetId)) return stub();
  if (!open(await loadActiveLink(c, linkId, Date.now()))) return stub();
  const rejected = originRejection(c); if (rejected) return rejected;
  const session = await resolveSession(c, linkId, Date.now()); if (!session) return stub();
  const early = (response: Response) => classifyRefusal(c, session, true, { parts: PARTS, archived: false }).then((refused) => refused ?? response);
  // The capability is not a stub on purpose: the session body already tells the page whether it is verified and what the link allows.
  if (session.guestId === null) return early(c.json({ error: "verification_required" }, 401));
  if (!session.link.allowDownload) return early(c.json({ error: "download_disabled" }, 403));
  const scope: RefusalScope = { parts: PARTS, download: true, archived: false, ...(assetId === undefined ? {} : { assetId }) };
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(c, session, true, scope) ?? response;
  return { session, guestId: session.guestId, answer };
}

type VersionState = { r2Key: string; bytes: number; version: number; videoId: string; title: string; released: boolean; locked: boolean };
/** One Version through a live member and a live grant, with whether it is released and whether its Video is locked premium; null when unreachable. */
async function readVersion(db: D1Database, linkId: string, projectId: string, assetId: string): Promise<VersionState | null> {
  const row = await db.prepare(`SELECT a.r2_key, a.bytes, a.version, v.id AS video_id, v.title, v.premium,
      EXISTS (SELECT 1 FROM video_premium_unlocks u WHERE u.video_id = v.id) AS unlocked,
      EXISTS (SELECT 1 FROM video_releases r WHERE r.asset_id = a.id AND r.withdrawn_at IS NULL) AS released
    FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id AND v.project_id = ?2
    WHERE a.id = ?3 AND ${reachSql("?1", "?2", "a.id")}`).bind(linkId, projectId, assetId)
    .first<{ r2_key: string; bytes: number; version: number; video_id: string; title: string; premium: number; unlocked: number; released: number }>();
  return row ? { r2Key: row.r2_key, bytes: row.bytes, version: row.version, videoId: row.video_id, title: row.title, released: row.released === 1, locked: row.premium === 1 && row.unlocked !== 1 } : null;
}

/** Nothing landed: say why from a fresh read, in the order of the entry. The stub or the capability first, then the Version's state, else the stub. */
async function refusedBecause(c: Ctx, session: GuestSession, assetId: string | undefined): Promise<Response> {
  const refused = await classifyRefusal(c, session, true, { parts: PARTS, download: true, archived: false, ...(assetId === undefined ? {} : { assetId }) }); if (refused) return refused;
  const row = await c.env.DB.prepare("SELECT guest_id, verified_at FROM guest_sessions WHERE id = ?1").bind(session.id).first<{ guest_id: string | null; verified_at: number | null }>();
  if (!row) return guestNotFound(c);
  if (row.guest_id === null || row.verified_at === null || row.guest_id !== session.guestId) return c.json({ error: "verification_required" }, 401);
  if (assetId !== undefined) {
    const state = await readVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
    if (state && !state.released) return c.json({ error: "not_released" }, 409);
    if (state?.locked) return c.json({ error: "premium_locked" }, 403);
  }
  return guestNotFound(c);
}

// -- one Version --
async function downloadOne(c: Ctx): Promise<Response> {
  const assetId = c.req.param("assetId") ?? "";
  const entered = await enter(c, assetId); if (entered instanceof Response) return entered;
  const { session, guestId, answer } = entered;
  const state = await readVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
  if (!state) return answer(await guestNotFound(c));
  if (!state.released) return answer(c.json({ error: "not_released" }, 409));
  if (state.locked) return answer(c.json({ error: "premium_locked" }, 403));
  // One audit row per download: a GET that asks for the whole file (no Range, or `bytes=0-`). A resumed or chunked read, and HEAD, write nothing, but they passed every gate above.
  const range = c.req.header("range")?.trim();
  if (c.req.method === "GET" && (range === undefined || range === "bytes=0-")) {
    const at = Date.now();
    const written = await c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'review_link.download', 'review_link', l.id, ?2, ?3 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
      WHERE ${sessionFence({ session: "?4", token: "?5", guest: "?6", now: "?3" })} AND ${reachSql("l.id", "l.project_id", "?7")} AND ${deliverableSql("?7")}`)
      .bind(newId(), auditMeta(null, { guest: { guestId, sessionId: session.id }, linkId: session.link.id, projectId: session.link.projectId, videoId: state.videoId, assetId, version: state.version, bytes: state.bytes }), at, session.id, session.tokenHash, guestId, assetId).run();
    if (written.meta.changes === 0) return refusedBecause(c, session, assetId);
  }
  const served = await serveR2Object(c, state.r2Key, { ...VIDEO_STREAM_HEADERS, "content-disposition": attachment(entryName(state.title, state.version)) }, "Video object not found");
  // A missing object after the access check is not an oracle, but it must still read as the stub.
  return served.status === 404 ? guestNotFound(c) : served;
}

// -- Download all --
type Included = { videoId: string; title: string; assetId: string; version: number; bytes: number; r2Key: string };
type LeftOut = { videoId: string; title: string; reason: "not_released" | "premium_locked" };

/**
 * What Download all holds: per current member Video that has a live grant, the NEWEST Version that is live-granted AND live-released, unless the Video is locked premium. A Video with no
 * released Version is left out as `not_released` (that is checked first, as for a single download), a released but locked one as `premium_locked`.
 */
async function readDownloadSet(db: D1Database, linkId: string, projectId: string): Promise<{ included: Included[]; leftOut: LeftOut[] }> {
  const rows = (await db.prepare(`SELECT v.id AS video_id, v.title, v.premium, (u.video_id IS NOT NULL) AS unlocked, a.id AS asset_id, a.version, a.bytes, a.r2_key,
        EXISTS (SELECT 1 FROM video_releases r WHERE r.asset_id = a.id AND r.withdrawn_at IS NULL) AS released
      FROM review_link_videos rv JOIN videos v ON v.id = rv.video_id AND v.project_id = ?2 LEFT JOIN video_premium_unlocks u ON u.video_id = v.id
        JOIN review_link_version_grants g ON g.link_id = rv.link_id AND g.video_id = rv.video_id AND g.revoked_at IS NULL
        JOIN assets a ON a.id = g.asset_id AND a.kind = 'video' JOIN video_version_meta m ON m.asset_id = a.id AND m.video_id = g.video_id
      WHERE rv.link_id = ?1 AND rv.removed_at IS NULL ORDER BY v.position, v.created_at, v.id, a.version DESC`).bind(linkId, projectId).all<{
    video_id: string; title: string; premium: number; unlocked: number; asset_id: string; version: number; bytes: number; r2_key: string; released: number;
  }>()).results;
  const included: Included[] = []; const leftOut: LeftOut[] = []; const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.video_id)) continue;
    // Rows of one Video are consecutive and newest first, so the first released one is the newest released.
    if (row.released !== 1) { if (!rows.some((other) => other.video_id === row.video_id && other.released === 1)) { seen.add(row.video_id); leftOut.push({ videoId: row.video_id, title: row.title, reason: "not_released" }); } continue; }
    seen.add(row.video_id);
    if (row.premium === 1 && row.unlocked !== 1) leftOut.push({ videoId: row.video_id, title: row.title, reason: "premium_locked" });
    else included.push({ videoId: row.video_id, title: row.title, assetId: row.asset_id, version: row.version, bytes: row.bytes, r2Key: row.r2_key });
  }
  return { included, leftOut };
}
const totalOf = (included: Included[]): number => included.reduce((sum, entry) => sum + entry.bytes, 0);
const tooLarge = (included: Included[]): boolean => included.length > GUEST_ZIP_MAX_ENTRIES || totalOf(included) > GUEST_ZIP_MAX_BYTES;

async function manifest(c: Ctx): Promise<Response> {
  const entered = await enter(c); if (entered instanceof Response) return entered;
  const { session } = entered;
  const { included, leftOut } = await readDownloadSet(c.env.DB, session.link.id, session.link.projectId);
  return c.json(guestDownloadManifestSchema.parse({
    included: included.map(({ videoId, title, version, bytes }) => ({ videoId, title, version, bytes })),
    leftOut: leftOut.map(({ title, reason }) => ({ title, reason })),
    totalBytes: totalOf(included), tooLarge: tooLarge(included),
  } satisfies GuestDownloadManifest));
}

const REASON_TEXT = { not_released: "not released yet", premium_locked: "premium video, not unlocked yet" } as const;
function leftOutText(leftOut: LeftOut[]): Uint8Array | null {
  if (leftOut.length === 0) return null;
  const lines = leftOut.map((entry) => `- ${safeFileName(entry.title)}: ${REASON_TEXT[entry.reason]}`);
  return new TextEncoder().encode(`These videos are not in this download.\r\n\r\n${lines.join("\r\n")}\r\n`);
}
const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });

/**
 * The entries of the zip, one at a time as the archive is pulled. Before EACH entry (the notice included) the session, the Release and the unlock are checked again; losing any throws,
 * which errors the response stream, so the client gets a truncated archive with no central directory and not a complete-looking one.
 */
export async function* zipEntries(env: Pick<Env, "DB" | "MEDIA">, session: GuestSession, included: Included[], notice: Uint8Array | null): AsyncGenerator<ZipStreamEntry> {
  for (const entry of included) {
    if (!await stillAllowed(env.DB, session, entry.assetId)) throw new Error("download access lost");
    const object = await env.MEDIA.get(entry.r2Key);
    if (!object) throw new Error("download object missing");
    if (object.size !== entry.bytes) { await object.body.cancel().catch(() => undefined); throw new Error("download object changed"); }
    yield { name: entryName(entry.title, entry.version), size: entry.bytes, stream: object.body };
  }
  if (notice) {
    if (!await stillAllowed(env.DB, session, null)) throw new Error("download access lost");
    yield { name: "Left out.txt", size: notice.byteLength, stream: bytesStream(notice) };
  }
}

async function downloadAll(c: Ctx): Promise<Response> {
  const entered = await enter(c); if (entered instanceof Response) return entered;
  const { session, guestId, answer } = entered;
  // Starting a zip is the costly thing, so it is the only download with a quota, and a HEAD must not spend it, write an audit row or build anything.
  if (c.req.method === "HEAD") return answer(c.json({ error: "method_not_allowed" }, 405, { allow: "GET" }));
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: `zip:guest:${guestId}`, limit: GUEST_LIMITS.zipGuest }, { bucket: `zip:link:${session.link.id}`, limit: GUEST_LIMITS.zipLink }], Date.now());
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));
  const { included, leftOut } = await readDownloadSet(c.env.DB, session.link.id, session.link.projectId);
  if (included.length === 0) return answer(c.json({ error: "nothing_to_download" }, 409));
  if (tooLarge(included)) return answer(c.json({ error: "zip_too_large", maxEntries: GUEST_ZIP_MAX_ENTRIES, maxBytes: GUEST_ZIP_MAX_BYTES }, 422));
  // A missing or resized object fails here, before byte 0 and before the audit row, and not halfway through an archive.
  const heads = await Promise.all(included.map((entry) => c.env.MEDIA.head(entry.r2Key)));
  if (heads.some((head, index) => head === null || head.size !== included[index]!.bytes)) return answer(c.json({ error: "download_unavailable" }, 502));
  const at = Date.now();
  const written = await c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?1, NULL, 'review_link.download_all', 'review_link', l.id, ?2, ?3 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE ${sessionFence({ session: "?4", token: "?5", guest: "?6", now: "?3" })}`)
    .bind(newId(), auditMeta(null, {
      guest: { guestId, sessionId: session.id }, linkId: session.link.id, projectId: session.link.projectId,
      assetIds: included.map((entry) => entry.assetId), leftOut: leftOut.map(({ videoId, reason }) => ({ videoId, reason })), totalBytes: totalOf(included),
    }), at, session.id, session.tokenHash, guestId).run();
  if (written.meta.changes === 0) return refusedBecause(c, session, undefined);
  const stream = createZipStream(zipEntries(c.env, session, included, leftOutText(leftOut)));
  return new Response(stream, { status: 200, headers: { ...SECURITY_HEADERS, "content-type": "application/zip", "content-disposition": attachment(`${safeFileName(session.link.label ?? "Videos")}.zip`) } });
}

export function mountGuestDownloads(app: Hono<AppEnv>): void {
  // `app.get` also answers HEAD (Hono runs the GET handler and drops the body), so `c.req.method` is what tells them apart inside.
  app.get("/d/api/links/:linkId/versions/:assetId/download", guestRoute("/d/api/links/:linkId/versions/:assetId/download", (c) => downloadOne(plain(c))));
  app.get("/d/api/links/:linkId/downloads", guestRoute("/d/api/links/:linkId/downloads", (c) => manifest(plain(c))));
  app.get("/d/api/links/:linkId/downloads/all.zip", guestRoute("/d/api/links/:linkId/downloads/all.zip", (c) => downloadAll(plain(c))));
}
