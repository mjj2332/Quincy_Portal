import { linkPreviewResponseSchema, type LinkPreviewCard } from "@quincy/shared";
import { apiPost } from "./api";
import type { EmbeddedMediaScope } from "./embedded-media";

/**
 * Asks the server for the card behind a link just added to a post (#497). A page with no card, a hit rate limit, a blocked
 * address or a failed request all come back as `null`: the link stays a link and posting is never held up by it.
 */
export async function requestLinkPreview(scope: EmbeddedMediaScope, url: string, _signal?: AbortSignal): Promise<LinkPreviewCard | null> {
  const path = "noticeBoard" in scope ? "/api/notice-board/link-previews" : `/api/projects/${encodeURIComponent(scope.projectId)}/link-previews`;
  try {
    const parsed = linkPreviewResponseSchema.safeParse(await apiPost<unknown, { url: string }>(path, { url }));
    return parsed.success ? parsed.data.preview : null;
  } catch { return null; }
}
