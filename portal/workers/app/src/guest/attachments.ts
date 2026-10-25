import type { Context, Hono } from "hono";
import { ATTACHMENT_GUEST_MAX_BYTES, guestAttachmentPresignInput } from "@quincy/shared";
import { auditMeta } from "../lib/audit";
import { abortAttachmentUpload, attachmentCompleteInput, completeAttachment, directAttachment, presignAttachment, type AttachmentScope } from "../lib/attachment-upload";
import { guestMediaGuard } from "../lib/guest-fence-sql";
import { newId } from "../lib/ids";
import type { AppEnv } from "../env";
import { guestNotFound, guestRoute, readJson, tooMany } from "./http";
import { admit, answerOf, judge, type Admitted } from "./media";
import { GUEST_LIMITS, reserveAttempts } from "./rate-limit";

/**
 * A Guest reviewer's Attachment uploads (#956): presign, the dev PUT, complete and abort, under the link's cookie `Path` (`/d/api/links/:linkId/attachments`), beside the download #955 added there.
 * The upload core is the staff routes' (`lib/attachment-upload.ts`), with the guest as uploader, the guest MEDIA fence on every write (`guestMediaGuard`: the exact session and token, a verified
 * guest, the link live with comments on, the gate and an unarchived Project) and the guest's own limit, 25 MB a file. The write order is the guest media routes' (`admit` in ./media.ts): link, gate
 * and parts (the stub), Origin, session (the stub), verified (401), comments (403), archived (409); a presign then reserves its attempt in the guest's and the link's Attachment buckets (429) before
 * the body is judged (400). Every non-success after the credential goes through `classifyRefusal` first, so lost access is the byte-identical stub. Audit rows have no actor user: the guest, the
 * session and the link are in the meta. A file is attached only by the guest's own note write (`guest/notes-write.ts`), five a note.
 */
type Handled<P extends string> = Context<AppEnv, P>;
const asApp = <P extends string>(c: Handled<P>): Context<AppEnv> => c as unknown as Context<AppEnv>;
const BASE = "/d/api/links/:linkId/attachments";
/** Complete carries every multipart part's ETag; a 25 MB file is a handful of parts. */
const COMPLETE_BODY_MAX_BYTES = 64 * 1024;

/** The upload core's scope for this guest (not `staffAttachmentScope`: the uploader, the fence and the audit row all differ): the guest column is the uploader, every write repeats the guest fence at its own time, and audit rows name the guest, session and link. */
function scopeOf<P extends string>(c: Handled<P>, admitted: Admitted): AttachmentScope {
  const { session, guestId } = admitted;
  const writer = { guestId, sessionId: session.id, linkId: session.link.id, tokenHash: session.tokenHash };
  return {
    env: c.env, projectId: session.link.projectId, uploader: { guestId }, fence: (first) => guestMediaGuard(writer, first, String(Date.now())),
    audit: async (action, attachmentId, meta) => {
      await c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?1, NULL, ?2, 'attachment', ?3, ?4, ?5)")
        .bind(newId(), action, attachmentId, auditMeta(null, { ...meta, guest: { guestId, sessionId: session.id }, linkId: session.link.id }), Date.now()).run();
    },
  };
}

async function presign(c: Handled<typeof BASE>): Promise<Response> {
  const admitted = await admit(c, { writes: true, json: true }); if ("response" in admitted) return admitted.response;
  const answer = answerOf(c, admitted.session, true);
  const raw = await readJson(asApp(c));
  // One upload costs one attempt in each bucket, charged before the body is judged, so an invalid or refused one is charged too.
  const attempt = await reserveAttempts(c.env.DB, [
    { bucket: `attachment:guest:${admitted.guestId}`, limit: GUEST_LIMITS.attachmentGuest },
    { bucket: `attachment:link:${admitted.session.link.id}`, limit: GUEST_LIMITS.attachmentLink },
  ], Date.now());
  if (attempt.limited) return answer(tooMany(attempt.retryAfterSeconds));
  const judged = judge(c, raw, guestAttachmentPresignInput); if ("response" in judged) return answer(judged.response);
  const response = await presignAttachment(scopeOf(c, admitted), { ...judged.data, ownerKind: "video_note", maxBytes: ATTACHMENT_GUEST_MAX_BYTES });
  return response.ok ? response : answer(response);
}

async function direct(c: Handled<`${typeof BASE}/:attachmentId/direct`>): Promise<Response> {
  const admitted = await admit(c, { id: "attachmentId", writes: true, json: false }); if ("response" in admitted) return admitted.response;
  if (c.env.APP_ENV !== "dev") return guestNotFound(asApp(c));
  const response = await directAttachment(scopeOf(c, admitted), c.req.param("attachmentId"), c.req.raw.body);
  return response.ok ? response : answerOf(c, admitted.session, true)(response);
}

async function complete(c: Handled<`${typeof BASE}/:attachmentId/complete`>): Promise<Response> {
  const admitted = await admit(c, { id: "attachmentId", writes: true, json: true }); if ("response" in admitted) return admitted.response;
  const answer = answerOf(c, admitted.session, true);
  const judged = judge(c, await readJson(asApp(c), COMPLETE_BODY_MAX_BYTES), attachmentCompleteInput); if ("response" in judged) return answer(judged.response);
  const response = await completeAttachment(scopeOf(c, admitted), c.req.param("attachmentId"), judged.data);
  return response.ok ? response : answer(response);
}

/** A cancelled upload: the uploading guest's alone (the core checks the uploader and the Project), and allowed with comments off, since cleaning up is never harmful. */
async function abort(c: Handled<`${typeof BASE}/:attachmentId/abort`>): Promise<Response> {
  const admitted = await admit(c, { id: "attachmentId", writes: false, json: true }); if ("response" in admitted) return admitted.response;
  const response = await abortAttachmentUpload(scopeOf(c, admitted), c.req.param("attachmentId"));
  return response.ok ? response : answerOf(c, admitted.session, false)(response);
}

export function mountGuestAttachments(app: Hono<AppEnv>): void {
  app.post(BASE, guestRoute(BASE, presign));
  app.put(`${BASE}/:attachmentId/direct`, guestRoute(`${BASE}/:attachmentId/direct`, direct));
  app.post(`${BASE}/:attachmentId/complete`, guestRoute(`${BASE}/:attachmentId/complete`, complete));
  app.post(`${BASE}/:attachmentId/abort`, guestRoute(`${BASE}/:attachmentId/abort`, abort));
}
