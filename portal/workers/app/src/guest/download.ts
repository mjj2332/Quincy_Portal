import type { Context, Hono } from "hono";
import { GUEST_ZIP_MAX_BYTES, GUEST_ZIP_MAX_ENTRIES, guestDownloadManifestSchema, guestDownloadPolicySchema, type GuestArchiveState, type GuestDownloadManifest, type VideoReviewPart } from "@quincy/shared";
import { auditMeta } from "../lib/audit";
import { attachment, safeFileName, videoVersionFileName } from "../lib/download-name";
import { newId } from "../lib/ids";
import { LIVE_VERSION, LIVE_VIDEO } from "../lib/video-live-sql";
import { gateSql, guestDownloadableSql, liveSql, reachSql } from "../lib/guest-fence-sql";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { createZipStream, type ZipStreamEntry } from "../lib/zip-stream";
import { nativeZipResponse, planNativeZip, type NativeZipEntry } from "../lib/zip-native";
import { assessZip, objectEntry, ZIP_LEGACY_MAX_BYTES, type ZipAssessment } from "../lib/object-crc";
import type { AppEnv, Env } from "../env";
import { classifyRefusal, type RefusalScope } from "./fence";
import { guestNotFound, guestRoute, originRejection, tooMany, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestLink, type GuestSession } from "./link";
import { GUEST_LIMITS, clientAddress, ipBucket, refundAttempt, reserveAllOrNone, reserveAttempts, windowStart } from "./rate-limit";

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

const entryName = videoVersionFileName;
/** The audit identity: the verified guest and session, or null for an unverified Delivery-link session (ADR 0025: no guest identity; the opaque `sessionId` sits beside it). */
type Principal = { kind: "anon"; sessionId: string } | { kind: "guest"; guestId: string; sessionId: string };
const principalOf = (session: GuestSession): Principal => (session.guestId === null ? { kind: "anon", sessionId: session.id } : { kind: "guest", guestId: session.guestId, sessionId: session.id });
/** The `guest` SQL bind: the verified guest, or NULL for the unverified session. */
const guestIdOf = (principal: Principal): string | null => (principal.kind === "guest" ? principal.guestId : null);
/** The audit identity fields, in meta order: `guest` (null when unverified), then the opaque `sessionId` beside it for an unverified session only. */
const auditWho = (principal: Principal) => (principal.kind === "guest" ? { guest: { guestId: principal.guestId, sessionId: principal.sessionId } } : { guest: null, sessionId: principal.sessionId });
/** The two rate-limit buckets of a zip start (`zip`) or of prepare (`zipprep`): the principal's own, then the link's. Unverified: keyed by address (hashed, as the Delivery zips do) and an anonymous-only link pool, so it can never exhaust the verified client's Download all. */
async function zipBuckets(c: Ctx, kind: "zip" | "zipprep", principal: Principal, linkId: string, now: number): Promise<{ bucket: string; limit: number }[]> {
  const prep = kind === "zipprep";
  if (principal.kind === "anon") return [{ bucket: await ipBucket(kind, clientAddress(c.req.raw), windowStart(now)), limit: prep ? GUEST_LIMITS.zipPrepareIp : GUEST_LIMITS.zipIp }, { bucket: `${kind}:anon-link:${linkId}`, limit: prep ? GUEST_LIMITS.zipPrepareAnonLink : GUEST_LIMITS.zipAnonLink }];
  return [{ bucket: `${kind}:guest:${principal.guestId}`, limit: prep ? GUEST_LIMITS.zipPrepareGuest : GUEST_LIMITS.zipGuest }, { bucket: `${kind}:link:${linkId}`, limit: prep ? GUEST_LIMITS.zipPrepareLink : GUEST_LIMITS.zipLink }];
}
export { attachment, safeFileName };

// -- SQL: the fence a committing statement and every zip entry repeat. Aliases: `s` guest_sessions, `l` client_links. Downloads read, so there is NO unarchived test here. --
type Binds = { session: string; token: string; guest: string; now: string };
/**
 * The credential, re-read in SQL (ADR 0025): either the verified guest this request authenticated as, or, with `guest` bound NULL, an UNVERIFIED session on a link whose `delivery_review` is 1 RIGHT NOW. The
 * cached `session.link.deliveryReview` only decides whether to try; it is never what authorises a commit or a byte. A link that stops being the Delivery link, or a session that verifies, mid-request misses this.
 */
const credentialSql = (guest: string): string => `((${guest} IS NOT NULL AND s.guest_id = ${guest} AND s.verified_at IS NOT NULL) OR (${guest} IS NULL AND s.guest_id IS NULL AND l.delivery_review = 1))`;
const sessionFence = (b: Binds): string => `s.id = ${b.session} AND s.token_hash = ${b.token} AND ${credentialSql(b.guest)} AND l.allow_download = 1 AND ${liveSql(b.now)} AND ${gateSql(PARTS)}`;
/**
 * The Version may be handed over now: a live Version of a live Video that is not a locked premium one, and either released or (the Delivery review link only, #847) in the latest Published set.
 * `link` and `asset` are SQL expressions. One predicate for the audit INSERT, the last fence before R2, and every zip entry.
 */
const deliverableSql = (link: string, asset: string): string => `EXISTS (SELECT 1 FROM videos dv JOIN video_version_meta dm ON dm.video_id = dv.id AND dm.asset_id = ${asset} AND ${LIVE_VERSION("dm")} WHERE ${LIVE_VIDEO("dv")}
    AND (dv.premium = 0 OR EXISTS (SELECT 1 FROM video_premium_unlocks du WHERE du.video_id = dv.id)) AND ${guestDownloadableSql(link, asset)})`;

/** Whether this session may still be handed `assetId` (or, with null, anything at all): the same predicate the audit INSERT carries, at a fresh time. */
async function stillAllowed(db: D1Database, session: GuestSession, assetId: string | null): Promise<boolean> {
  const asset = assetId === null ? "" : ` AND ${reachSql("l.id", "l.project_id", "?5")} AND ${deliverableSql("l.id", "?5")}`;
  const row = await db.prepare(`SELECT 1 AS ok FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE ${sessionFence({ session: "?1", token: "?2", guest: "?3", now: "?4" })}${asset}`)
    .bind(session.id, session.tokenHash, session.guestId, Date.now(), ...(assetId === null ? [] : [assetId])).first();
  return row !== null;
}

type Entered = { session: GuestSession; /** `anon`: an unverified session on the Delivery review link (ADR 0025). */ principal: Principal; answer: (response: Response) => Promise<Response> };
/** Steps 1 to 5: the response that ends the request, or the session with an `answer` that re-classifies any non-success first. */
async function enter(c: Ctx, assetId?: string): Promise<Entered | Response> {
  const linkId = c.req.param("linkId") ?? "";
  const stub = () => guestNotFound(c);
  if (assetId !== undefined && !UUID.test(assetId)) return stub();
  if (!open(await loadActiveLink(c, linkId, Date.now()))) return stub();
  const rejected = originRejection(c); if (rejected) return rejected;
  const session = await resolveSession(c, linkId, Date.now()); if (!session) return stub();
  // The gate is read again inside `resolveSession`; it may have closed since `loadActiveLink`, so the session's own parts must still carry both.
  if (!open(session.link)) return stub();
  const principal = principalOf(session);
  const early = (response: Response) => classifyRefusal(c, session, true, { parts: PARTS, archived: false }).then((refused) => refused ?? response);
  // The capability is not a stub on purpose: the session body already tells the page whether it is verified and what the link allows.
  // Only the Delivery review link downloads without a verified session (ADR 0025). The fences below re-read this in SQL; this is the cheap early answer.
  if (principal.kind === "anon" && !session.link.deliveryReview) return early(c.json({ error: "verification_required" }, 401));
  if (!session.link.allowDownload) return early(c.json({ error: "download_disabled" }, 403));
  const scope: RefusalScope = { parts: PARTS, download: true, archived: false, ...(assetId === undefined ? {} : { assetId }) };
  const answer = async (response: Response): Promise<Response> => await classifyRefusal(c, session, true, scope) ?? response;
  return { session, principal, answer };
}

type VersionState = { r2Key: string; bytes: number; version: number; videoId: string; title: string; /** A live Release, or on the Delivery review link a place in the latest Published set. */ downloadable: boolean; locked: boolean };
/** One Version through a live member and a live grant, with whether it may be downloaded and whether its Video is locked premium; null when unreachable. */
async function readVersion(db: D1Database, linkId: string, projectId: string, assetId: string): Promise<VersionState | null> {
  const row = await db.prepare(`SELECT a.r2_key, a.bytes, a.version, v.id AS video_id, v.title, v.premium,
      EXISTS (SELECT 1 FROM video_premium_unlocks u WHERE u.video_id = v.id) AS unlocked,
      ${guestDownloadableSql("?1", "a.id")} AS downloadable
    FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' AND ${LIVE_VERSION("m")} JOIN videos v ON v.id = m.video_id AND v.project_id = ?2 AND ${LIVE_VIDEO("v")}
    WHERE a.id = ?3 AND ${reachSql("?1", "?2", "a.id")}`).bind(linkId, projectId, assetId)
    .first<{ r2_key: string; bytes: number; version: number; video_id: string; title: string; premium: number; unlocked: number; downloadable: number }>();
  return row ? { r2Key: row.r2_key, bytes: row.bytes, version: row.version, videoId: row.video_id, title: row.title, downloadable: row.downloadable === 1, locked: row.premium === 1 && row.unlocked !== 1 } : null;
}

/** Nothing landed: say why from a fresh read, in the order of the entry. The stub or the capability first, then the Version's state, else the stub. */
async function refusedBecause(c: Ctx, session: GuestSession, assetId: string | undefined): Promise<Response> {
  const refused = await classifyRefusal(c, session, true, { parts: PARTS, download: true, archived: false, ...(assetId === undefined ? {} : { assetId }) }); if (refused) return refused;
  const row = await c.env.DB.prepare("SELECT s.guest_id, s.verified_at, l.delivery_review FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.id = ?1").bind(session.id).first<{ guest_id: string | null; verified_at: number | null; delivery_review: number }>();
  if (!row) return guestNotFound(c);
  // 401 whenever the credential this request held no longer matches the row: a verified guest changed or unverified; an unverified one is no longer on a Delivery link, or has verified since (the page re-reads the session and retries).
  const principal = principalOf(session);
  if (principal.kind === "anon" ? row.guest_id !== null || row.delivery_review !== 1 : row.guest_id === null || row.verified_at === null || row.guest_id !== principal.guestId) return c.json({ error: "verification_required" }, 401);
  if (assetId !== undefined) {
    const state = await readVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
    if (state && !state.downloadable) return c.json({ error: "not_released" }, 409);
    if (state?.locked) return c.json({ error: "premium_locked" }, 403);
  }
  return guestNotFound(c);
}

// -- one Version --
async function downloadOne(c: Ctx): Promise<Response> {
  const assetId = c.req.param("assetId") ?? "";
  const entered = await enter(c, assetId); if (entered instanceof Response) return entered;
  const { session, principal, answer } = entered;
  const state = await readVersion(c.env.DB, session.link.id, session.link.projectId, assetId);
  if (!state) return answer(await guestNotFound(c));
  if (!state.downloadable) return answer(c.json({ error: "not_released" }, 409));
  if (state.locked) return answer(c.json({ error: "premium_locked" }, 403));
  // One audit row per download: a GET that asks for the whole file (no Range, or `bytes=0-`). A resumed or chunked read, and HEAD, write nothing, but they passed every gate above.
  const range = c.req.header("range")?.trim();
  if (c.req.method === "GET" && (range === undefined || range === "bytes=0-")) {
    const at = Date.now();
    const written = await c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'review_link.download', 'review_link', l.id, ?2, ?3 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id
      WHERE ${sessionFence({ session: "?4", token: "?5", guest: "?6", now: "?3" })} AND ${reachSql("l.id", "l.project_id", "?7")} AND ${deliverableSql("l.id", "?7")}`)
      .bind(newId(), auditMeta(null, { ...auditWho(principal), linkId: session.link.id, projectId: session.link.projectId, videoId: state.videoId, assetId, version: state.version, bytes: state.bytes }), at, session.id, session.tokenHash, guestIdOf(principal), assetId).run();
    if (written.meta.changes === 0) return refusedBecause(c, session, assetId);
  }
  // The last fence before any R2 read, for every method: HEAD and a resumed Range write no audit row, so the audit INSERT cannot be what stops them, and a revoke can land after `readVersion`.
  if (!await stillAllowed(c.env.DB, session, assetId)) return refusedBecause(c, session, assetId);
  const served = await serveR2Object(c, state.r2Key, { ...VIDEO_STREAM_HEADERS, "content-disposition": attachment(entryName(state.title, state.version)) }, "Video object not found",
    () => stillAllowed(c.env.DB, session, assetId));
  // A missing object after the access check is not an oracle, but it must still read as the stub.
  if (served.status !== 404) return served;
  // The flag may have been lost during the read: that is a 401, not a missing object.
  return await stillAllowed(c.env.DB, session, assetId) ? guestNotFound(c) : refusedBecause(c, session, assetId);
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
        ${guestDownloadableSql("?1", "a.id")} AS released
      FROM review_link_videos rv JOIN videos v ON v.id = rv.video_id AND v.project_id = ?2 AND ${LIVE_VIDEO("v")} LEFT JOIN video_premium_unlocks u ON u.video_id = v.id
        JOIN review_link_version_grants g ON g.link_id = rv.link_id AND g.video_id = rv.video_id AND g.revoked_at IS NULL
        JOIN assets a ON a.id = g.asset_id AND a.kind = 'video' JOIN video_version_meta m ON m.asset_id = a.id AND m.video_id = g.video_id AND ${LIVE_VERSION("m")}
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

/** The gate's answer as the page sees it. `ready` covers both writers: a click will download. */
function archiveState(assessed: ZipAssessment): GuestArchiveState {
  switch (assessed.kind) {
    case "too_large": return { state: "too_large", pending: 0 };
    case "unavailable": return { state: "unavailable", pending: 0 };
    case "preparing": return { state: "preparing", pending: assessed.pending.length };
    default: return { state: "ready", pending: 0 };
  }
}

/** An unverified session costs nothing to mint, so the storage HEAD pass it triggers is throttled by address and by an anonymous-only link pool (as the Delivery `dlcheck`). A check is never refunded. */
async function checkLimited(c: Ctx, session: GuestSession, now: number): Promise<Response | null> {
  const attempt = await reserveAllOrNone(c.env.DB, [{ bucket: await ipBucket("zipcheck", clientAddress(c.req.raw), windowStart(now)), limit: GUEST_LIMITS.zipCheckIp }, { bucket: `zipcheck:anon-link:${session.link.id}`, limit: GUEST_LIMITS.zipCheckAnonLink }], now);
  return attempt.limited ? tooMany(attempt.retryAfterSeconds) : null;
}

/** Read-only: the page polls this, and a GET must not queue work (that is `prepare`'s job). */
async function manifest(c: Ctx): Promise<Response> {
  const entered = await enter(c); if (entered instanceof Response) return entered;
  const { session, principal, answer } = entered;
  const { included, leftOut } = await readDownloadSet(c.env.DB, session.link.id, session.link.projectId);
  if (principal.kind === "anon" && included.length > 0 && !tooLarge(included)) { const limited = await checkLimited(c, session, Date.now()); if (limited) return answer(limited); }
  const archive: GuestArchiveState = included.length === 0 ? { state: "ready", pending: 0 }
    : tooLarge(included) ? { state: "too_large", pending: 0 }
    : archiveState(await assessZip(c.env, included, { source: "guest-downloads-manifest", enqueue: "never", headWhenOff: false }));
  const body = guestDownloadManifestSchema.parse({
    included: included.map(({ videoId, title, version, bytes }) => ({ videoId, title, version, bytes })),
    leftOut: leftOut.map(({ title, reason }) => ({ title, reason })),
    totalBytes: totalOf(included), tooLarge: tooLarge(included), archive,
  } satisfies GuestDownloadManifest);
  // The credential is re-read at the end: access lost while the set was built or the objects HEADed must not hand over the manifest.
  if (!await stillAllowed(c.env.DB, session, null)) return refusedBecause(c, session, undefined);
  return c.json(body);
}

/**
 * `POST .../downloads/prepare` (#802): queues the CRC-32 job for every object Download all still needs and says where that stands. It goes through the same session, capability, Origin and fence steps
 * as the zip (`enter`), but it streams nothing, writes no audit row, and spends its own small quota, never a zip start.
 */
async function prepare(c: Ctx): Promise<Response> {
  const entered = await enter(c); if (entered instanceof Response) return entered;
  const { session, principal, answer } = entered;
  const now = Date.now();
  // A session with no guest costs nothing to mint, so its per-guest bucket would mean nothing: key it by address. Anonymous callers have their own link pool (see `zipBuckets`).
  const buckets = await zipBuckets(c, "zipprep", principal, session.link.id, now);
  // An address already over its limit must not also burn the link's slots (anyone holding the link could then lock every other visitor out of Download all): the unverified path takes both buckets or neither.
  const attempt = principal.kind === "anon" ? await reserveAllOrNone(c.env.DB, buckets, now) : await reserveAttempts(c.env.DB, buckets, now);
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));
  const { included } = await readDownloadSet(c.env.DB, session.link.id, session.link.projectId);
  if (included.length === 0) return answer(c.json({ error: "nothing_to_download" }, 409));
  if (tooLarge(included)) return answer(c.json({ error: "zip_too_large", maxEntries: GUEST_ZIP_MAX_ENTRIES, maxBytes: GUEST_ZIP_MAX_BYTES }, 422));
  // No CRC work is queued after access is lost.
  if (!await stillAllowed(c.env.DB, session, null)) return refusedBecause(c, session, undefined);
  const assessed = await assessZip(c.env, included, { source: "guest-downloads-prepare", enqueue: "always" });
  return answer(c.json(assessed.kind === "preparing" ? { ...archiveState(assessed), retryAfterSeconds: assessed.retryAfterSeconds } : archiveState(assessed)));
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
/**
 * The writer's re-authorisation for a guest archive: before each entry's R2 read and again after it answered (a removal during the fetch must not put the removed Version's bytes in the
 * archive), for the notice, and once more before the central directory. Losing any aborts the stream, so the client sees fewer bytes than the `Content-Length` and the download fails.
 */
export function zipAuthorizer(db: D1Database, session: GuestSession, included: Included[]): (entry: NativeZipEntry | null) => Promise<boolean> {
  const assetByKey = new Map(included.map((entry) => [entry.r2Key, entry.assetId]));
  return async (entry) => {
    if (entry === null || "data" in entry) return stillAllowed(db, session, null);
    const assetId = assetByKey.get(entry.r2Key);
    return assetId !== undefined && await stillAllowed(db, session, assetId);
  };
}

/** The legacy writer's entries (the native writer is used when every CRC-32 is ready). */
export async function* zipEntries(env: Pick<Env, "DB" | "MEDIA">, session: GuestSession, included: Included[], notice: Uint8Array | null): AsyncGenerator<ZipStreamEntry> {
  for (const entry of included) {
    if (!await stillAllowed(env.DB, session, entry.assetId)) throw new Error("download access lost");
    const object = await env.MEDIA.get(entry.r2Key);
    if (!object) throw new Error("download object missing");
    if (object.size !== entry.bytes) { await object.body.cancel().catch(() => undefined); throw new Error("download object changed"); }
    // A removal during the fetch must not put the removed Version's bytes in the archive: authorise again after R2 answered and before anything is yielded.
    if (!await stillAllowed(env.DB, session, entry.assetId)) { await object.body.cancel().catch(() => undefined); throw new Error("download access lost"); }
    yield { name: entryName(entry.title, entry.version), size: entry.bytes, stream: object.body };
  }
  if (notice) {
    if (!await stillAllowed(env.DB, session, null)) throw new Error("download access lost");
    yield { name: "Left out.txt", size: notice.byteLength, stream: bytesStream(notice) };
  }
}

/**
 * What the gate's refusals look like to a guest. The error string is the stable part; `download_preparing` carries the count and when to ask again. Not a stub: the caller has already passed
 * every access check, and these only say that the archive cannot be served right now.
 */
function archiveRefusal(c: Ctx, assessed: ZipAssessment): Response | null {
  switch (assessed.kind) {
    case "too_large": return c.json({ error: "download_too_large", maxBytes: ZIP_LEGACY_MAX_BYTES }, 413);
    case "unavailable": return c.json({ error: "download_unavailable" }, 502);
    case "preparing": return c.json({ error: "download_preparing", pending: assessed.pending.length, retryAfterSeconds: assessed.retryAfterSeconds }, 409, { "retry-after": String(assessed.retryAfterSeconds) });
    default: return null;
  }
}

async function downloadAll(c: Ctx): Promise<Response> {
  const entered = await enter(c); if (entered instanceof Response) return entered;
  const { session, principal, answer } = entered;
  // A HEAD must not write an audit row or build anything.
  if (c.req.method === "HEAD") return answer(c.json({ error: "method_not_allowed" }, 405, { allow: "GET" }));
  const { included, leftOut } = await readDownloadSet(c.env.DB, session.link.id, session.link.projectId);
  if (included.length === 0) return answer(c.json({ error: "nothing_to_download" }, 409));
  if (tooLarge(included)) return answer(c.json({ error: "zip_too_large", maxEntries: GUEST_ZIP_MAX_ENTRIES, maxBytes: GUEST_ZIP_MAX_BYTES }, 422));
  // The gate: a missing or resized object fails here, before byte 0 and before the audit row, and so does a set whose CRC-32s are still being prepared or that is too big for the old writer.
  if (principal.kind === "anon") { const limited = await checkLimited(c, session, Date.now()); if (limited) return answer(limited); }
  const assessed = await assessZip(c.env, included, { source: "guest-download-all", enqueue: "when_blocked" });
  const refusal = archiveRefusal(c, assessed); if (refusal) return answer(refusal);
  const notice = leftOutText(leftOut);
  // Plan before the audit row, so an archive that cannot be built leaves no audit row behind it.
  const planned = assessed.kind === "native" ? (() => {
    const entries: NativeZipEntry[] = included.map((entry) => objectEntry(entryName(entry.title, entry.version), entry.r2Key, assessed.ready));
    if (notice) entries.push({ name: "Left out.txt", data: notice });
    return planNativeZip({ bucket: c.env.MEDIA, entries, authorize: zipAuthorizer(c.env.DB, session, included) });
  })() : null;
  // Starting a zip is the costly thing, so it is the only download with a quota. It is spent only here, on a start that has passed every check and is about to be audited: preparing, a refusal or a
  // failed plan never costs a start.
  // Both buckets are taken together or not at all (#824), so a refused start changes neither; a start that then fails gives back exactly one slot in each, as the Delivery zips do.
  const at = Date.now();
  const startBuckets = await zipBuckets(c, "zip", principal, session.link.id, at);
  const attempt = await reserveAllOrNone(c.env.DB, startBuckets, at);
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));
  const refund = async () => { for (const { bucket } of startBuckets) await refundAttempt(c.env.DB, bucket, at); };
  const written = await c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
    SELECT ?1, NULL, 'review_link.download_all', 'review_link', l.id, ?2, ?3 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE ${sessionFence({ session: "?4", token: "?5", guest: "?6", now: "?3" })}`)
    .bind(newId(), auditMeta(null, {
      ...auditWho(principal), linkId: session.link.id, projectId: session.link.projectId,
      assetIds: included.map((entry) => entry.assetId), leftOut: leftOut.map(({ videoId, reason }) => ({ videoId, reason })), totalBytes: totalOf(included),
    }), at, session.id, session.tokenHash, guestIdOf(principal)).run().catch(async (error: unknown) => { await refund(); throw error; });
  if (written.meta.changes === 0) { await refund(); return refusedBecause(c, session, undefined); }
  const filename = attachment(`${safeFileName(session.link.label ?? "Videos")}.zip`);
  if (planned) return nativeZipResponse(planned.open(), (promise) => c.executionCtx.waitUntil(promise), { ...SECURITY_HEADERS, "content-disposition": filename });
  const stream = createZipStream(zipEntries(c.env, session, included, notice));
  return new Response(stream, { status: 200, headers: { ...SECURITY_HEADERS, "content-type": "application/zip", "content-disposition": filename } });
}

/** `GET .../download-policy`: read-only, the same stub as every session read (no cookie, no link, no gate), then whether a download still needs the code. Authorises nothing: the download routes decide for themselves. */
async function downloadPolicy(c: Ctx): Promise<Response> {
  const session = await resolveSession(c, c.req.param("linkId") ?? "", Date.now());
  // The `delivery` part is what the download routes need, so without it this is the stub too (the page then treats a failed read as "code required" for downloads only).
  return session && open(session.link) ? c.json(guestDownloadPolicySchema.parse({ codeRequired: !session.link.deliveryReview })) : guestNotFound(c);
}

export function mountGuestDownloads(app: Hono<AppEnv>): void {
  app.get("/d/api/links/:linkId/download-policy", guestRoute("/d/api/links/:linkId/download-policy", (c) => downloadPolicy(plain(c))));
  // `app.get` also answers HEAD (Hono runs the GET handler and drops the body), so `c.req.method` is what tells them apart inside.
  app.get("/d/api/links/:linkId/versions/:assetId/download", guestRoute("/d/api/links/:linkId/versions/:assetId/download", (c) => downloadOne(plain(c))));
  app.get("/d/api/links/:linkId/downloads", guestRoute("/d/api/links/:linkId/downloads", (c) => manifest(plain(c))));
  app.get("/d/api/links/:linkId/downloads/all.zip", guestRoute("/d/api/links/:linkId/downloads/all.zip", (c) => downloadAll(plain(c))));
  app.post("/d/api/links/:linkId/downloads/prepare", guestRoute("/d/api/links/:linkId/downloads/prepare", (c) => prepare(plain(c))));
}
