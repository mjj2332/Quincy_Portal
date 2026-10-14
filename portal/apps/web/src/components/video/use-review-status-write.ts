import { useState } from "react";
import { reviewStatusTransitions, type Role, type VersionReviewStatus, type VideoDto, type VideoReviewStatus } from "@quincy/shared";
import { useRunFence } from "../../lib/use-run-fence";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { classifyReviewStatusError, reviewStatusErrorText, setVideoReviewStatus } from "../../lib/video-review-status-data";

/**
 * The Review status write (#863), shared by the header pill and the phone Approve button (#879): the statuses the role may set, whether the write is blocked right now, the write
 * itself, and its pending and error state. It always acts on the Video: the write is addressed to the latest Version with the status the screen showed, and it is blocked while an older
 * Version is on show or in Compare, so nobody approves a cut they have not seen. `readOnly` is true where nothing can be set at all (Published, an archived Project, a role with
 * nothing to set, no query client).
 */
export function useReviewStatusWrite({ video, version, comparing, projectId, role, archived }: {
  video: VideoDto;
  /** The Version on show. */
  version: VideoDto["versions"][number];
  comparing: boolean;
  projectId: string;
  role: Role;
  archived: boolean;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // No key: putVideo moves `latest` before a refusal arrives, so keying on the Version would drop the error and strand `pending` (docs/lessons.md).
  const fence = useRunFence();

  const latest = video.versions.find((candidate) => candidate.current) ?? video.versions[0]!;
  const allowed: readonly VideoReviewStatus[] = reviewStatusTransitions(role);
  const status = video.reviewStatus;
  const readOnly = status === "published" || archived || allowed.length === 0 || !queryClient;
  const watchingOlder = version.assetId !== video.currentAssetId;
  const blocked = watchingOlder || comparing;
  const choose = async (next: VersionReviewStatus) => {
    if (next === latest.reviewStatus || pending || !queryClient) return;
    const ticket = fence.begin();
    setPending(true); setProblem(null);
    try { await setVideoReviewStatus({ queryClient, projectId, role }, { assetId: latest.assetId, reviewStatus: next, expectedStatus: latest.reviewStatus }); }
    catch (error) { if (ticket.isCurrent()) setProblem(reviewStatusErrorText(classifyReviewStatusError(error).kind)); }
    finally { if (ticket.isCurrent()) setPending(false); }
  };
  return { latest, allowed, status, readOnly, watchingOlder, blocked, pending, problem, choose };
}
