import type { Role, VideoDto } from "@quincy/shared";
import { Button } from "../reui/button";
import { STRIP_TEXT_BUTTON } from "../quincy/compose-strip";
import { VideoReviewStatusPill } from "./VideoReviewStatusPill";
import { useReviewStatusWrite } from "./use-review-status-write";

/**
 * The phone header's Approve (#879, D4). Staff: "Approve (internal)" at in_review for the roles that may set the status, in a non-archived Project; disabled, with the pill's spoken hint,
 * while an older Version is on show (nobody approves a cut they have not seen). Once approved, the Review status pill takes its place (its menu changes the status); published or read-only hides it.
 * Reuse: `reui/button`; the approved state is the existing `VideoReviewStatusPill`, compact.
 * #879 PR 3a (P1, owner decision): the label is drawn in full, "Approve (internal)", 32px tall with a 44px hit area (`STRIP_TEXT_BUTTON`), so it fits the 56pt bar.
 */
export function VideoPhoneApprove({ video, version, comparing, projectId, role, archived }: { video: VideoDto; version: VideoDto["versions"][number]; comparing: boolean; projectId: string; role: Role; archived: boolean }) {
  const write = useReviewStatusWrite({ video, version, comparing, projectId, role, archived });
  const { status, readOnly, allowed, blocked, pending, problem, watchingOlder, latest, choose } = write;
  if (readOnly || status === "published") return null;
  if (status !== "in_review") return <div data-testid="video-phone-approved" className="flex-none"><VideoReviewStatusPill video={video} version={version} comparing={comparing} projectId={projectId} role={role} archived={archived} compact checked /></div>;
  if (!allowed.includes("approved_internal")) return null;
  return <div className="relative flex-none">
    <Button type="button" size="sm" variant="outline" data-testid="video-phone-approve" disabled={blocked || pending} className={STRIP_TEXT_BUTTON} onClick={() => { void choose("approved_internal"); }}>Approve (internal)</Button>
    {blocked && <span data-testid="video-phone-approve-hint" className="sr-only">{watchingOlder ? `Switch to the latest version, v${latest.version}, to approve.` : "Leave Compare to approve."}</span>}
    {problem && <span role="alert" data-testid="video-phone-approve-error" className="absolute top-full right-0 z-10 mt-[var(--space-1)] w-max max-w-[min(24rem,90vw)] border border-border bg-card p-[var(--space-2)] text-[length:var(--text-sm)] text-destructive-wash-foreground">{problem}</span>}
  </div>;
}
