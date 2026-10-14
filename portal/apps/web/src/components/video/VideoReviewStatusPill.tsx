import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { reviewStatusTransitions, type Role, type VersionReviewStatus, type VideoDto, type VideoReviewStatus } from "@quincy/shared";
import { useRunFence } from "../../lib/use-run-fence";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { classifyReviewStatusError, reviewStatusErrorText, setVideoReviewStatus } from "../../lib/video-review-status-data";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { StatusPill, type StatusTone } from "../quincy/StatusPill";
import { cn } from "@/lib/utils";

/**
 * The Review status of a Video (#863), in the viewer header: the label and tone of the Video's status (its latest live Version's, or Published while that Version is in the latest Published
 * set), and for a person who may change it, a menu of the statuses their role may set. It always reports the Video, never the Version on show: changing it is disabled while an older Version
 * is on show or in Compare, so nobody approves a cut they have not seen. Read-only (a plain pill) while Published, in an archived Project, and for a role with nothing to set. The write is
 * addressed to the latest Version with the status the pill showed (`video-review-status-data.ts`). Reuse: `quincy/StatusPill` (the tones), `quincy/menu.tsx` with its Base UI radio items (the menu, as VideoVersionMenu does), lucide `Check`.
 */
export const REVIEW_STATUS_LABEL: Record<VideoReviewStatus, string> = { in_review: "In review", approved_internal: "Approved (internal)", published: "Published" };
export const REVIEW_STATUS_TONE: Record<VideoReviewStatus, StatusTone> = { in_review: "caution", approved_internal: "positive", published: "info" };

export const REVIEW_STATUS_SHORT: Record<VideoReviewStatus, string> = { in_review: "In review", approved_internal: "Approved", published: "Published" };

export function VideoReviewStatusPill({ video, version, comparing, projectId, role, archived, testId = "video-review-status", compact = false }: {
  video: VideoDto;
  /** The Version on show. */
  version: VideoDto["versions"][number];
  comparing: boolean;
  projectId: string;
  role: Role;
  archived: boolean;
  /** Prefix of every test id (the card's pill must not collide with the viewer's). */
  testId?: string;
  /** A phone bar (#877 S2): the short label is drawn, the older-publication hint is spoken only; the full label stays the accessible name. */
  compact?: boolean;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // No key: putVideo moves `latest` before a refusal arrives, so keying on the Version would drop the error and strand `pending` (docs/lessons.md).
  const fence = useRunFence();

  const latest = video.versions.find((candidate) => candidate.current) ?? video.versions[0]!;
  const allowed = reviewStatusTransitions(role);
  const status = video.reviewStatus;
  const tone = REVIEW_STATUS_TONE[status];
  // Compact (a phone bar): the short word is drawn, what it leaves out is still read aloud.
  const label = compact ? <>{REVIEW_STATUS_SHORT[video.reviewStatus]}<span className="sr-only">{REVIEW_STATUS_LABEL[video.reviewStatus].slice(REVIEW_STATUS_SHORT[video.reviewStatus].length)}</span></> : REVIEW_STATUS_LABEL[video.reviewStatus];
  const older = video.olderPublishedVersion !== null && <span data-testid={`${testId}-older`} className={cn("text-foreground-secondary [font:var(--type-label)] whitespace-nowrap", compact && "sr-only")}>{`v${video.olderPublishedVersion} published`}</span>;

  if (status === "published" || archived || allowed.length === 0 || !queryClient) {
    return <div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
      <StatusPill tone={tone} data-testid={testId}>{label}</StatusPill>
      {older}
    </div>;
  }

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

  return <div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
    <Menu
      triggerLabel={`Review status: ${REVIEW_STATUS_LABEL[status]}`} label="Review status" triggerTestId={testId}
      triggerClassName={cn("pointer-coarse:min-h-11 max-[721px]:min-h-11 rounded-full", blocked && "cursor-not-allowed disabled:opacity-50")}
      disabled={blocked || pending}
      trigger={<StatusPill tone={tone}>{label}<ChevronDown aria-hidden="true" className="ml-[var(--space-1)] size-3" /></StatusPill>}
    >
      <MenuPrimitive.Group>
        <MenuPrimitive.GroupLabel className="px-[var(--space-3)] py-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{`Latest v${latest.version}`}</MenuPrimitive.GroupLabel>
        <MenuPrimitive.RadioGroup value={latest.reviewStatus} onValueChange={(next) => { void choose(next as VersionReviewStatus); }}>
          {allowed.map((option) => <MenuPrimitive.RadioItem key={option} value={option} data-testid={`${testId}-option-${option}`} className={cn(MENU_ITEM, "justify-between gap-[var(--space-3)]")}>
            {REVIEW_STATUS_LABEL[option]}
            <MenuPrimitive.RadioItemIndicator><Check aria-hidden="true" className="size-4" /></MenuPrimitive.RadioItemIndicator>
          </MenuPrimitive.RadioItem>)}
        </MenuPrimitive.RadioGroup>
      </MenuPrimitive.Group>
    </Menu>
    {older}
    {blocked && <span data-testid={`${testId}-hint`} className="sr-only">{watchingOlder ? `Switch to the latest version, v${latest.version}, to change the review status.` : "Leave Compare to change the review status."}</span>}
    {problem && <span role="alert" data-testid={`${testId}-error`} className="basis-full text-[length:var(--text-sm)] text-destructive-wash-foreground">{problem}</span>}
  </div>;
}
