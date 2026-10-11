import { useRef, useState } from "react";
import { VIDEO_TRASH_RETENTION_DAYS, type VideoTrashItem } from "@quincy/shared";
import { useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import { pushToast } from "../../lib/toast-store";
import { restoreVideoVersion, restoreWholeVideo, useVideoTrashQuery } from "../../lib/video-trash-data";
import { classifyVideoTrashError } from "../../lib/video-trash-errors";
import { Badge } from "../reui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Spinner } from "../reui/spinner";
import { Button } from "../quincy/Button";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { SheetCloseButton, SHEET_CLOSE_CLEARANCE } from "../quincy/SheetCloseButton";
import { DIALOG_TITLE } from "./ReviewLinkDialogFrame";
import { formatVideoDate } from "./video-format";
import { cn } from "@/lib/utils";

/**
 * The Video Trash (#776 E): what was removed from the Project's Video tab and is waiting out its retention, with the days left and a Restore each. A dialog opened from the Films header
 * (like Review links); the list is read afresh on every opening, and again after every restore or refusal. Restore needs no confirmation: it only brings a hidden thing back.
 * `reui/dialog` + `reui/item` + `reui/badge` + `quincy/Button`, `EmptyState` and `Notice`; reuse ledger: docs/plans/776-e-ledger.md.
 */
const DAY_MS = 86_400_000;
/** A part day counts as a whole one, so "1 day left" is never "0 days left" while time remains. */
export const daysLeft = (purgeAt: string, now: number): number => Math.ceil((Date.parse(purgeAt) - now) / DAY_MS);
const keyOf = (item: VideoTrashItem) => (item.kind === "version" ? `version:${item.assetId}` : `video:${item.videoId}`);
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

export function VideoTrashDialog({ projectId, archived, open, onOpenChange, returnFocusId }: {
  projectId: string;
  archived: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `data-testid` of the control that opened the dialog: focus goes back to it. */
  returnFocusId: string;
}) {
  const query = useVideoTrashQuery(projectId, open);
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const now = Date.now();
  // Focus opens on the dialog itself: the list arrives after the dialog opens, so when it opened the only tabbable control was Close, and that took focus.
  const popupRef = useRef<HTMLDivElement | null>(null);

  const restore = async (item: VideoTrashItem) => {
    const key = keyOf(item);
    if (!queryClient || busy.has(key)) return;
    setBusy((held) => new Set(held).add(key)); setProblem(null);
    const ctx = { queryClient, projectId, videoId: item.videoId };
    try {
      if (item.kind === "version" && item.assetId) await restoreVideoVersion({ ...ctx, assetId: item.assetId }); else await restoreWholeVideo(ctx);
      pushToast(item.kind === "version" ? `Restored version ${item.version} of “${item.title}”.` : `Restored “${item.title}”.`);
    } catch (error) {
      terminate(error);
      setProblem(classifyVideoTrashError(error, "restore").message);
    } finally {
      setBusy((held) => { const next = new Set(held); next.delete(key); return next; });
    }
  };

  const items = query.data?.items ?? [];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {/* `sm:max-w-[560px]`: `max-w-xl` is 1320px here (Quincy redefines `--container-xl`, see `reui/alert-dialog.tsx`). */}
    <DialogContent data-testid="video-trash-dialog" ref={popupRef} initialFocus={popupRef} showCloseButton={false} finalFocus={() => document.querySelector<HTMLElement>(`[data-testid="${returnFocusId}"]`) ?? true} className="flex max-h-[calc(100dvh-var(--space-6))] flex-col focus-visible:!outline-none gap-[var(--space-4)] sm:max-w-[560px]">
      <DialogHeader className={cn("border-b border-solid border-[var(--border-hairline)] pb-[var(--space-3)]", SHEET_CLOSE_CLEARANCE)}>
        <DialogTitle className={DIALOG_TITLE}>Trash</DialogTitle>
        <DialogDescription className="text-foreground-secondary">Removed films and versions are kept for {VIDEO_TRASH_RETENTION_DAYS} days, then deleted for good. Restoring one brings back its notes, releases and links.</DialogDescription>
      </DialogHeader>
      <div className="-mx-[var(--space-1)] grid min-h-0 flex-1 content-start gap-[var(--space-3)] overflow-y-auto px-[var(--space-1)]">
        {archived && <Notice tone="caution" role="status">Archived projects are read-only, so nothing can be restored. Restore the project first.</Notice>}
        {problem !== null && <Notice tone="critical" role="alert" data-testid="video-trash-problem">{problem}</Notice>}
        {query.isPending && <p className="m-0 flex items-center gap-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]" role="status"><Spinner aria-hidden="true" />Loading Trash…</p>}
        {query.isError && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>The Trash could not be loaded.</span><Button type="button" variant="text" onClick={() => { void query.refetch(); }}>Retry</Button></Notice>}
        {query.data && items.length === 0 && <EmptyState title="Trash is empty.">Removed films and versions wait here for {VIDEO_TRASH_RETENTION_DAYS} days.</EmptyState>}
        {items.length > 0 && <ItemGroup>
          {items.map((item) => {
            const left = daysLeft(item.purgeAt, now);
            const blocked = item.kind === "version" && item.canRestore === false;
            return <Item key={keyOf(item)} variant="outline" data-testid="video-trash-row" className="flex-wrap">
              <ItemContent>
                <ItemTitle className="font-normal">{item.title}</ItemTitle>
                <ItemDescription>{item.kind === "version" ? `Version ${item.version}` : `Whole film · ${item.versionCount} version${item.versionCount === 1 ? "" : "s"}`}</ItemDescription>
                <ItemDescription>{`Removed by ${item.removedBy.name} · ${formatVideoDate(item.removedAt)}`}</ItemDescription>
                {blocked && <ItemDescription>Restore the film first.</ItemDescription>}
              </ItemContent>
              <ItemActions>
                <Badge variant={left <= 3 ? "warning-light" : "secondary"} size="sm">{left <= 0 ? "Due for deletion" : `${left} day${left === 1 ? "" : "s"} left`}</Badge>
                <Button type="button" variant="secondary" className={TOUCH} disabled={archived || blocked || busy.has(keyOf(item)) || !queryClient} onClick={() => { void restore(item); }}>Restore</Button>
              </ItemActions>
            </Item>;
          })}
        </ItemGroup>}
      </div>
      {/* Last child, so Close comes after the content in tab order; initial focus is the dialog itself (`initialFocus`). */}
      <SheetCloseButton label="Close" data-testid="video-trash-close" />
    </DialogContent>
  </Dialog>;
}
