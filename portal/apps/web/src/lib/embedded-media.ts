import { externalEmbeddedMediaSettingsSchema } from "@quincy/shared";
import { ApiError, apiGet, apiPost } from "./api";
import { retryRenditionVia, uploadImageVia, uploadVideoVia, type EmbeddedImageUploadOptions, type EmbeddedMediaScope, type MediaIo } from "./embedded-media-core";

// The pure helpers, the upload flows and their types live in `embedded-media-core.ts`, which the Review-link page can reach (it imports no `lib/api`). This module is the staff app's side: the flows run over `lib/api`.
export * from "./embedded-media-core";

/** Whether this person may upload HEIC (#495). The server decides (an Admin, or everyone once the owner turns it on); a bad answer means no. */
export async function fetchEmbeddedHeicSetting(): Promise<boolean> {
  const parsed = externalEmbeddedMediaSettingsSchema.safeParse(await apiGet<unknown>("/api/embedded-media/settings"));
  return parsed.success && parsed.data.heic;
}

function mediaBase(scope: EmbeddedMediaScope): string {
  return "noticeBoard" in scope ? "/api/notice-board/embedded-media" : `/api/projects/${encodeURIComponent(scope.projectId)}/embedded-media`;
}

/** The staff routes of a scope, as the flows of `embedded-media-core` run them. The abort and poster calls are `fetch` with `keepalive` / the cookie, so they survive the page closing. */
function staffIo(scope: EmbeddedMediaScope): MediaIo {
  const base = mediaBase(scope);
  const at = (mediaId: string) => `${base}/${encodeURIComponent(mediaId)}`;
  return {
    presign: (body) => apiPost<unknown, typeof body>(base, body),
    directUrl: (mediaId) => `${at(mediaId)}/direct`,
    complete: (mediaId, body) => apiPost<unknown, typeof body>(`${at(mediaId)}/complete`, body),
    rendition: (mediaId, signal) => apiGet<unknown>(`${at(mediaId)}/rendition`, { signal }),
    retry: async (mediaId) => {
      try { await apiPost<unknown, Record<string, never>>(`${at(mediaId)}/rendition/retry`, {}); }
      catch (error) {
        // 409 means it is no longer failed (a second Retry won, or it finished): the status route says which.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
    },
    // A Project has an abort route; the Notice board has none, so there the row is just forgotten and the sweep reclaims it.
    abort: (mediaId) => "noticeBoard" in scope ? Promise.resolve() : fetch(`${at(mediaId)}/abort`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
    putPoster: (mediaId, frame, signal) => fetch(`${at(mediaId)}/poster`, { method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" }, body: frame, ...(signal ? { signal } : {}) }).then((response) => response.ok, () => false),
  };
}

/** Retry a failed display copy: the server sets it pending again and queues the conversion, then this resumes polling. Resolves with the id at ready. */
export function retryEmbeddedRendition(scope: EmbeddedMediaScope, mediaId: string, options: EmbeddedImageUploadOptions = {}): Promise<string> {
  return retryRenditionVia(staffIo(scope), mediaId, options);
}

/**
 * Tells the server to drop an image upload the person removed while it was being prepared (or after it failed), so no reservation or
 * object is left behind. A Project has an abort route; the Notice board has none, so there the row is just forgotten and the sweep
 * reclaims it. Fire and forget, and `keepalive` so it survives the page closing.
 */
export function abortEmbeddedImage(scope: EmbeddedMediaScope, mediaId: string): Promise<unknown> {
  return staffIo(scope).abort(mediaId);
}

/** presign, then bytes straight to R2, then complete (see `uploadImageVia`). `scope.owner` names the row's owner kind (a whiteboard, a video note). */
export function uploadEmbeddedImage(scope: EmbeddedMediaScope, file: File, onProgress?: (percent: number) => void, options: EmbeddedImageUploadOptions = {}): Promise<string> {
  return uploadImageVia(staffIo(scope), file, onProgress, options, "projectId" in scope ? scope.owner : undefined);
}

/** A Project video (#494), over the staff routes: see `uploadVideoVia`. The abort request is `keepalive`, so it survives the page closing. */
export function uploadEmbeddedVideo(projectId: string, file: File, options: Parameters<typeof uploadVideoVia>[2] = {}): Promise<string> {
  return uploadVideoVia(staffIo({ projectId }), file, options);
}
