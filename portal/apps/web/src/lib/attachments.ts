import { apiPost } from "./api";
import { uploadAttachmentVia, type AttachmentIo, type AttachmentUploadOptions } from "./attachments-core";

// The path split, the checks and the upload flow live in `attachments-core.ts`, which the Review-link page can reach (it imports no `lib/api`).
// This module is the staff app's side: the flow runs over `lib/api`.
export * from "./attachments-core";

/** A Project's staff routes, or the Notice board's (#954). The abort is `fetch` with `keepalive`, so it survives the page closing. */
function staffIo(base: string): AttachmentIo {
  const at = (attachmentId: string) => `${base}/${encodeURIComponent(attachmentId)}`;
  return {
    presign: (body) => apiPost<unknown, typeof body>(base, body),
    directUrl: (attachmentId) => `${at(attachmentId)}/direct`,
    complete: (attachmentId, body) => apiPost<unknown, typeof body>(`${at(attachmentId)}/complete`, body),
    abort: (attachmentId) => fetch(`${at(attachmentId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
  };
}

export function uploadAttachment(projectId: string, file: File, options: AttachmentUploadOptions = {}): Promise<string> {
  return uploadAttachmentVia(staffIo(`/api/projects/${encodeURIComponent(projectId)}/attachments`), file, options);
}

/** An Attachment on a Notice board post (#954): the Notice board's own routes, with no Project. */
export function uploadNoticeAttachment(file: File, options: AttachmentUploadOptions = {}): Promise<string> {
  return uploadAttachmentVia(staffIo("/api/notice-board/attachments"), file, options);
}
