import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  EMBEDDED_HEIC_CONTENT_TYPES, EMBEDDED_IMAGE_CONTENT_TYPES, EMBEDDED_VIDEO_CONTENT_TYPES, embeddedImageDimensionsShape, embeddedMediaKindFor, embeddedMediaMaxBytes, externalEmbeddedMediaRenditionSchema,
  isEmbeddedHeicContentType, renditionsEnabled, requireBothImageDimensions,
} from "@quincy/shared";
import { auditMeta } from "../lib/audit";
import { heicFlagEnabled } from "../lib/embedded-heic";
import { getEmbeddedMedia, type EmbeddedMediaRow } from "../lib/embedded-media";
import { embeddedServeTarget } from "../lib/embedded-media-serve";
import { abortEmbeddedUpload, completeEmbeddedMedia, directEmbeddedMedia, posterEmbeddedMedia, presignEmbeddedMedia, type UploadScope } from "../lib/embedded-media-upload";
import { guestMediaGuard, noteWriteParts } from "../lib/guest-fence-sql";
import { newId } from "../lib/ids";
import { serveR2Object } from "../lib/r2-serve";
import { attachedVideoNote } from "../lib/video-note-media";
import type { AppEnv } from "../env";
import { classifyRefusal } from "./fence";
import { guestNotFound, guestRoute, INVALID, originRejection, readJson, TOO_LARGE, tooMany, UUID } from "./http";
import { loadActiveLink, resolveSession, type GuestSession } from "./link";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";
import { resolveGrantedVersion } from "./read";

/**
 * Guest media (#835 C): a verified guest attaches images and videos to a video note, and any guest of the link who can read a public note can read the media in it. The routes sit under the link's own
 * cookie `Path` (`/d/api/links/:linkId/media`). The upload core is `lib/embedded-media-upload.ts`, shared with the staff routes and parametrised by uploader (`{guestId}` here) and by the fence every
 * write repeats (`guestMediaGuard`). Writes follow the order of `notes-write.ts` `enter()`: link, gate and the `guest` and `guest_comments` parts (the stub), Origin, the session (the stub), verified (401),
 * comments on (403), archived (409). A presign then reserves its attempt (429) before the body is judged (400). Every non-success after the credential goes through `classifyRefusal` first, so lost access is
 * the byte-identical stub whatever else went wrong. Audit rows have no actor user: the guest, the session and the link are in the meta.
 *
 * Reads (`withSession`: an unverified guest can read, as the notes list lets them) are a miss, the one stub, unless the row is a video note's medium of THIS link's Project and either (a) attached to a
 * public, live note on a Version this link reaches, or (b) the reading guest's own upload that has no note yet. An internal note's media, another link's and a staff-only upload are all that miss.
 */
type Handled<P extends string> = Context<AppEnv, P>;
const asApp = <P extends string>(c: Handled<P>): Context<AppEnv> => c as unknown as Context<AppEnv>;
const MEDIA_BASE = "/d/api/links/:linkId/media";
/** Complete carries every multipart part's ETag; a 5 GB video at the part size is a few hundred, well under this. */
const COMPLETE_BODY_MAX_BYTES = 256 * 1024;
const POSTER_HEADERS = { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" } as const;
const MEDIA_HEADERS = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin", "cache-control": "private, no-store" } as const;

const presignInput = z.object({ contentType: z.enum([...EMBEDDED_IMAGE_CONTENT_TYPES, ...EMBEDDED_HEIC_CONTENT_TYPES, ...EMBEDDED_VIDEO_CONTENT_TYPES]), bytes: z.number().int().min(1) }).strict()
  .superRefine((value, context) => { if (value.bytes > embeddedMediaMaxBytes(embeddedMediaKindFor(value.contentType)!)) context.addIssue({ code: "custom", path: ["bytes"], message: "File is too large" }); });
const completeInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional(), ...embeddedImageDimensionsShape }).strict().superRefine(requireBothImageDimensions);

type Admitted = { session: GuestSession; guestId: string };

/** The refusal (stub, `comments_disabled`, `project_archived`) if there is one now, else `response`: the only way a non-success leaves a write handler once admitted. */
const answerOf = <P extends string>(c: Handled<P>, session: GuestSession, writes: boolean) => async (response: Response | Promise<Response>): Promise<Response> =>
  await classifyRefusal(asApp(c), session, true, writes ? { parts: noteWriteParts(false), comments: true } : { parts: noteWriteParts(false), archived: false }) ?? await response;

/**
 * Steps 1 to 7 of the write order: the link and media ids, the link and its parts, Origin, the session, verified (401), comments (403, writes only), archived (409, writes only). `json` false is a byte body
 * (the dev PUT and the poster): the Origin alone is checked. A route that only cleans up (abort) passes `writes: false`, so a link whose comments went off can still drop what it started.
 */
async function admit<P extends string>(c: Handled<P>, input: { mediaId?: boolean; writes: boolean; json: boolean }): Promise<{ response: Response } | Admitted> {
  const stub = async () => ({ response: await guestNotFound(asApp(c)) });
  if (input.mediaId && !UUID.test(c.req.param("mediaId" as never) as string)) return stub();
  const linkId = c.req.param("linkId" as never) as string;
  const link = await loadActiveLink(asApp(c), linkId, Date.now());
  if (!link || !link.parts.includes("guest") || !link.parts.includes("guest_comments")) return stub();
  const rejected = originRejection(asApp(c), input.json); if (rejected) return { response: rejected };
  const session = await resolveSession(asApp(c), linkId, Date.now()); if (!session) return stub();
  const early = (response: Response) => classifyRefusal(asApp(c), session, true, { parts: noteWriteParts(false), archived: false }).then((refused) => refused ?? response);
  if (session.guestId === null) return { response: await early(asApp(c).json({ error: "verification_required" }, 401)) };
  if (input.writes && !session.link.allowComments) return { response: await early(asApp(c).json({ error: "comments_disabled" }, 403)) };
  const refused = await classifyRefusal(asApp(c), session, true, input.writes ? { parts: noteWriteParts(false), comments: true } : { parts: noteWriteParts(false), archived: false });
  return refused ? { response: refused } : { session, guestId: session.guestId };
}

/** The upload core's scope for this guest: the guest column is the uploader and every write repeats the guest fence at its own time. */
function scopeOf<P extends string>(c: Handled<P>, admitted: Admitted): UploadScope {
  const { session, guestId } = admitted;
  const writer = { guestId, sessionId: session.id, linkId: session.link.id, tokenHash: session.tokenHash };
  return {
    env: c.env, projectId: session.link.projectId, uploader: { guestId }, fence: (first) => guestMediaGuard(writer, first, String(Date.now())),
    audit: async (action, mediaId, meta) => {
      await c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, NULL, ?2, 'embedded_media', ?3, ?4, ?5)")
        .bind(newId(), action, mediaId, auditMeta(null, { ...meta, guest: { guestId, sessionId: session.id }, linkId: session.link.id }), Date.now()).run();
    },
  };
}

/** HEIC for a guest: renditions on and the owner's flag on. There is no Admin bypass, because a guest is not staff. */
async function heicRefusal<P extends string>(c: Handled<P>): Promise<Response | null> {
  if (!renditionsEnabled(c.env)) return c.json({ error: "HEIC images are unavailable right now", code: "heic_unavailable" }, 503);
  if (!await heicFlagEnabled(c.env.DB)) return c.json({ error: "HEIC images are not enabled yet", code: "heic_not_enabled" }, 403);
  return null;
}

/** A body for a JSON route: 413 over `max`, 400 not JSON or not the schema. */
function judge<T, P extends string>(c: Handled<P>, raw: unknown, schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false } }): { data: T } | { response: Response } {
  if (raw === TOO_LARGE) return { response: c.json({ error: "payload_too_large" }, 413) };
  const parsed = raw === INVALID ? null : schema.safeParse(raw);
  return parsed?.success ? { data: parsed.data } : { response: c.json({ error: "invalid_request" }, 400) };
}

async function presign(c: Handled<typeof MEDIA_BASE>): Promise<Response> {
  const admitted = await admit(c, { writes: true, json: true }); if ("response" in admitted) return admitted.response;
  const answer = answerOf(c, admitted.session, true);
  const raw = await readJson(asApp(c));
  // One upload costs one attempt in each bucket, charged before the body is judged, so an invalid one is charged too.
  const attempt = await reserveAttempts(c.env.DB, [{ bucket: `media:guest:${admitted.guestId}`, limit: GUEST_LIMITS.mediaGuest }, { bucket: `media:link:${admitted.session.link.id}`, limit: GUEST_LIMITS.mediaLink }], Date.now());
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));
  const judged = judge(c, raw, presignInput); if ("response" in judged) return answer(judged.response);
  if (isEmbeddedHeicContentType(judged.data.contentType)) { const refused = await heicRefusal(c); if (refused) return answer(refused); }
  const response = await presignEmbeddedMedia(scopeOf(c, admitted), { contentType: judged.data.contentType, bytes: judged.data.bytes, ownerKind: "video_note" });
  return response.ok ? response : answer(response);
}

async function direct(c: Handled<`${typeof MEDIA_BASE}/:mediaId/direct`>): Promise<Response> {
  const admitted = await admit(c, { mediaId: true, writes: true, json: false }); if ("response" in admitted) return admitted.response;
  if (c.env.APP_ENV !== "dev") return guestNotFound(asApp(c));
  const response = await directEmbeddedMedia(scopeOf(c, admitted), c.req.param("mediaId"), c.req.raw.body);
  return response.ok ? response : answerOf(c, admitted.session, true)(response);
}

async function complete(c: Handled<`${typeof MEDIA_BASE}/:mediaId/complete`>): Promise<Response> {
  const admitted = await admit(c, { mediaId: true, writes: true, json: true }); if ("response" in admitted) return admitted.response;
  const answer = answerOf(c, admitted.session, true);
  const judged = judge(c, await readJson(asApp(c), COMPLETE_BODY_MAX_BYTES), completeInput); if ("response" in judged) return answer(judged.response);
  const response = await completeEmbeddedMedia(scopeOf(c, admitted), c.req.param("mediaId"), judged.data, () => heicRefusal(c));
  return response.ok ? response : answer(response);
}

async function poster(c: Handled<`${typeof MEDIA_BASE}/:mediaId/poster`>): Promise<Response> {
  const admitted = await admit(c, { mediaId: true, writes: true, json: false }); if ("response" in admitted) return admitted.response;
  const response = await posterEmbeddedMedia(scopeOf(c, admitted), c.req.param("mediaId"), { contentLength: c.req.header("content-length"), body: () => c.req.arrayBuffer() });
  return response.ok ? response : answerOf(c, admitted.session, true)(response);
}

async function abort(c: Handled<`${typeof MEDIA_BASE}/:mediaId/abort`>): Promise<Response> {
  const admitted = await admit(c, { mediaId: true, writes: false, json: true }); if ("response" in admitted) return admitted.response;
  const response = await abortEmbeddedUpload(scopeOf(c, admitted), c.req.param("mediaId"));
  return response.ok ? response : answerOf(c, admitted.session, false)(response);
}

/**
 * The row when THIS session may read it, else null (the one stub). A video note's medium of this link's Project, never one still `uploading`. Attached: the owner note is live on a live Version, is PUBLIC,
 * and the Version is one this link reaches (staff public media and other guests' media both qualify; an internal note's does not). Otherwise (pending, detached, an owner that is gone): the reading guest's own upload.
 */
export async function readableGuestMedia(db: D1Database, session: Pick<GuestSession, "guestId" | "link">, mediaId: string): Promise<EmbeddedMediaRow | null> {
  const row = await getEmbeddedMedia(db, mediaId);
  if (!row || row.ownerKind !== "video_note" || row.projectId !== session.link.projectId || row.state === "uploading") return null;
  if (row.state === "attached") {
    const note = await attachedVideoNote(db, row);
    if (note?.visibility === "public" && await resolveGrantedVersion(db, session.link.id, session.link.projectId, note.assetId) !== null) return row;
  }
  return session.guestId !== null && row.uploaderGuestId === session.guestId ? row : null;
}

async function withMedia<P extends string>(c: Handled<P>, handler: (row: EmbeddedMediaRow, session: GuestSession) => Response | Promise<Response>): Promise<Response> {
  const mediaId = c.req.param("mediaId" as never) as string;
  if (!UUID.test(mediaId)) return guestNotFound(asApp(c));
  const session = await resolveSession(asApp(c), c.req.param("linkId" as never) as string, Date.now());
  if (!session || !session.link.parts.includes("guest")) return guestNotFound(asApp(c));
  const row = await readableGuestMedia(c.env.DB, session, mediaId);
  return row ? handler(row, session) : guestNotFound(asApp(c));
}

async function serve(c: Handled<`${typeof MEDIA_BASE}/:mediaId`>): Promise<Response> {
  return withMedia(c, async (row, session) => {
    const target = embeddedServeTarget(row);
    if ("status" in target) return target.status === 404 ? guestNotFound(asApp(c)) : c.json(target.body, target.status, target.retryAfter ? { "retry-after": target.retryAfter } : {});
    // The last admission, after R2 has answered and before a byte leaves: revoking the link or removing the Version meanwhile is a miss.
    const served = await serveR2Object(asApp(c), target.key, { "content-type": target.contentType, ...MEDIA_HEADERS }, "Media object not found", async () => await readableGuestMedia(c.env.DB, session, row.id) !== null);
    return served.status === 404 ? guestNotFound(asApp(c)) : served;
  });
}

async function servePoster(c: Handled<`${typeof MEDIA_BASE}/:mediaId/poster`>): Promise<Response> {
  return withMedia(c, async (row, session) => {
    if (row.kind !== "video" || !row.posterKey) return guestNotFound(asApp(c));
    const object = await c.env.MEDIA.get(row.posterKey);
    if (!object || await readableGuestMedia(c.env.DB, session, row.id) === null) return guestNotFound(asApp(c));
    return new Response(object.body, { headers: { ...POSTER_HEADERS, "content-length": String(object.size) } });
  });
}

/** The uploader's view of a HEIC image's display copy: where it has got to. The uploading guest's alone. */
async function renditionStatus(c: Handled<`${typeof MEDIA_BASE}/:mediaId/rendition`>): Promise<Response> {
  return withMedia(c, (row, session) => row.uploaderGuestId !== null && row.uploaderGuestId === session.guestId && row.kind === "image"
    ? c.json(externalEmbeddedMediaRenditionSchema.parse({ mediaId: row.id, status: row.renditionStatus }))
    : guestNotFound(asApp(c)));
}

export function mountGuestMedia(app: Hono<AppEnv>): void {
  app.post(MEDIA_BASE, guestRoute(MEDIA_BASE, presign));
  app.put(`${MEDIA_BASE}/:mediaId/direct`, guestRoute(`${MEDIA_BASE}/:mediaId/direct`, direct));
  app.post(`${MEDIA_BASE}/:mediaId/complete`, guestRoute(`${MEDIA_BASE}/:mediaId/complete`, complete));
  app.put(`${MEDIA_BASE}/:mediaId/poster`, guestRoute(`${MEDIA_BASE}/:mediaId/poster`, poster));
  app.post(`${MEDIA_BASE}/:mediaId/abort`, guestRoute(`${MEDIA_BASE}/:mediaId/abort`, abort));
  app.get(`${MEDIA_BASE}/:mediaId/rendition`, guestRoute(`${MEDIA_BASE}/:mediaId/rendition`, renditionStatus));
  app.get(`${MEDIA_BASE}/:mediaId/poster`, guestRoute(`${MEDIA_BASE}/:mediaId/poster`, servePoster));
  app.get(`${MEDIA_BASE}/:mediaId`, guestRoute(`${MEDIA_BASE}/:mediaId`, serve));
}
