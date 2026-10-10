import { useState } from "react";
import type { Role } from "@quincy/shared";
import { useProjectVideosQuery, useVideoReviewQuery } from "../../lib/project-data";
import type { ReviewLinkStore } from "../../lib/review-link-form-store";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Notice } from "../quincy/Notice";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { ReviewLinkCreateView } from "./ReviewLinkCreateView";
import { ReviewLinkDetail } from "./ReviewLinkDetail";
import { ReviewLinkList } from "./ReviewLinkList";
import { ReviewLinkReveal } from "./ReviewLinkReveal";
import { useReviewLinksUi, useReviewLinkState } from "./use-review-links-ui";

/**
 * The one Review links dialog (#741 11b), whose step (list, create, detail, one-time reveal) is the form store's `view`. Mounted by
 * `ReviewLinksScope` above the Collection tabs. The gate answer and the Videos are read from the query cache the Video tab fills (disabled
 * observers: this never fetches them), and the link list is fetched only while the dialog is open. Reuse ledger: docs/plans/741-11b-ledger.md.
 */
export function ReviewLinksDialogHost({ store, projectId, role, archived }: { store: ReviewLinkStore; projectId: string; role: Role; archived: boolean }) {
  const state = useReviewLinkState(store);
  const review = useVideoReviewQuery(projectId, false, role).data;
  const videos = useProjectVideosQuery(projectId, false, role).data ?? [];
  const ui = useReviewLinksUi({ projectId, role, review, archived, store, fetchLinks: state.view.kind !== "closed" });
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  if (!ui.enabled) return null;
  const { view, reveal, reveals } = state;
  return <Dialog open={view.kind !== "closed"} onOpenChange={(open) => { if (!open) store.closeDialog(); }} disablePointerDismissal={view.kind === "reveal"}>
    <DialogContent data-testid="review-links-dialog" showCloseButton className="max-h-[calc(100dvh-2rem)] gap-[var(--space-4)] overflow-y-auto sm:max-w-xl">
      <OverlayContainerContext.Provider value={slot}>
        {view.kind === "list" && <ReviewLinkList ui={ui} />}
        {view.kind === "create" && (ui.canWrite
          ? <ReviewLinkCreateView ui={ui} videos={videos} />
          // Archived under an open Create: say so under the same title. The draft stays in the store for Restore.
          : <>
            <DialogHeader><DialogTitle>Create Review link</DialogTitle><DialogDescription>New links can't be made right now.</DialogDescription></DialogHeader>
            <Notice tone="caution" role="status">Archived projects are read-only, so a new link can't be created. Your draft is kept until you restore the project.</Notice>
          </>)}
        {view.kind === "detail" && <ReviewLinkDetail ui={ui} videos={videos} linkId={view.linkId} />}
        {view.kind === "reveal" && reveal && <ReviewLinkReveal reveal={reveal} queued={reveals.length} onDone={store.dismissReveal} />}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} />
    </DialogContent>
  </Dialog>;
}
