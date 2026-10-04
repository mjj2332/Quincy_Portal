import { linkPreviewResponseSchema, type LinkPreviewCard } from "@quincy/shared";
import { apiPost } from "./api";
import type { EmbeddedMediaScope } from "./embedded-media";

/**
 * Asks the server for the card behind a link just added to a post (#497). A page with no card, a hit rate limit, a blocked
 * address or a failed request all come back as `null`: the link stays a link and posting is never held up by it.
 */
export async function requestLinkPreview(scope: EmbeddedMediaScope, url: string, _signal?: AbortSignal): Promise<LinkPreviewCard | null> {
  const path = "noticeBoard" in scope ? "/api/notice-board/link-previews" : `/api/projects/${encodeURIComponent(scope.projectId)}/link-previews`;
  // The server fetches a link once. A second request for it while the first is still running is told so (409) and asks again once after
  // a short wait, by which time the first has stored the card.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = linkPreviewResponseSchema.safeParse(await apiPost<unknown, { url: string }>(path, { url }));
      return parsed.success ? parsed.data.preview : null;
    } catch (error) {
      if (attempt === 0 && isInProgress(error)) { await new Promise((resolve) => setTimeout(resolve, IN_PROGRESS_RETRY_MS)); continue; }
      return null;
    }
  }
  return null;
}

const IN_PROGRESS_RETRY_MS = 1_500;
const isInProgress = (error: unknown): boolean =>
  (error as { status?: unknown } | null)?.status === 409 && (error as { details?: { code?: unknown } | null }).details?.code === "link_preview_in_progress";
