import { apiPost } from "./api";
import { uploadAttachmentVia, type AttachmentIo, type AttachmentUploadOptions } from "./attachments-core";

// The path split, the checks and the upload flow live in `attachments-core.ts`, which the Review-link page can reach (it imports no `lib/api`).
// This module is the staff app's side: the flow runs over `lib/api`.
export * from "./attachments-core";

/** A Project's staff routes. The abort is `fetch` with `keepalive`, so it survives the page closing. */
function staffIo(projectId: string): AttachmentIo {
  const base = `/api/projects/${encodeURIComponent(projectId)}/attachments`;
  const at = (attachmentId: string) => `${base}/${encodeURIComponent(attachmentId)}`;
  return {
    presign: (body) => apiPost<unknown, typeof body>(base, body),
    directUrl: (attachmentId) => `${at(attachmentId)}/direct`,
    complete: (attachmentId, body) => apiPost<unknown, typeof body>(`${at(attachmentId)}/complete`, body),
    abort: (attachmentId) => fetch(`${at(attachmentId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
  };
}

export function uploadAttachment(projectId: string, file: File, options: AttachmentUploadOptions = {}): Promise<string> {
  return uploadAttachmentVia(staffIo(projectId), file, options);
}
