import { apiPost } from "./api";
import { uploadAttachmentVia, type AttachmentIo, type AttachmentUploadOptions } from "./attachments-core";

/** An Attachment failed to upload (#952, #955): Post, Send and Save wait until it is retried or removed, so a post or note never goes out missing a file. */
export const ATTACHMENT_RETRY_OR_REMOVE = "Retry or remove the file that failed.";

// The path split, the checks and the upload flow live in `attachments-core.ts`, which the Review-link page can reach (it imports no `lib/api`).
// This module is the staff app's side: the flow runs over `lib/api`.
export * from "./attachments-core";

/** What a staff file is for (#955): the Project's discussion (no owner sent, the default) or a staff Video note, which the server gates as note writing. */
export type AttachmentOwner = "video_note";

/** A Project's staff routes, or the Notice board's (#954). The abort is `fetch` with `keepalive`, so it survives the page closing. `owner` is sent on a presign only (#955). */
function staffIo(base: string, owner?: AttachmentOwner): AttachmentIo {
  const at = (attachmentId: string) => `${base}/${encodeURIComponent(attachmentId)}`;
  return {
    presign: (body) => apiPost<unknown, typeof body & { owner?: AttachmentOwner }>(base, owner ? { ...body, owner } : body),
    directUrl: (attachmentId) => `${at(attachmentId)}/direct`,
    complete: (attachmentId, body) => apiPost<unknown, typeof body>(`${at(attachmentId)}/complete`, body),
    abort: (attachmentId) => fetch(`${at(attachmentId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
  };
}

export function uploadAttachment(projectId: string, file: File, options: AttachmentUploadOptions = {}, owner?: AttachmentOwner): Promise<string> {
  return uploadAttachmentVia(staffIo(`/api/projects/${encodeURIComponent(projectId)}/attachments`, owner), file, options);
}

/** An Attachment on a Notice board post (#954): the Notice board's own routes, with no Project. */
export function uploadNoticeAttachment(file: File, options: AttachmentUploadOptions = {}): Promise<string> {
  return uploadAttachmentVia(staffIo("/api/notice-board/attachments"), file, options);
}
