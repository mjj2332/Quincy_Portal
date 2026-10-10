import { useEffect, useRef, useState } from "react";
import type { Role } from "@quincy/shared";
import { useProjectVideosQuery, useVideoReviewQuery } from "../../lib/project-data";
import type { ReviewLinkStore } from "../../lib/review-link-form-store";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Notice } from "../quincy/Notice";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "./ReviewLinkDialogFrame";
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
  const { view, reveal, reveals } = state;
  const closed = view.kind === "closed";
  // Where focus goes back to: the control that opened the dialog (the header button, the selection bar's Create, a card chip). Base UI's own
  // return needs that control to have been focused, and Safari does not focus a button on click, so the last click before the dialog opened is kept.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!closed) return;
    const remember = (event: MouseEvent) => { opener.current = event.target instanceof Element ? event.target.closest<HTMLElement>("button, a, [role=button]") : null; };
    document.addEventListener("click", remember, true);
    return () => { document.removeEventListener("click", remember, true); };
  }, [closed]);
  if (!ui.enabled) return null;
  return <Dialog open={view.kind !== "closed"} onOpenChange={(open) => { if (!open) store.closeDialog(); }} disablePointerDismissal={view.kind === "reveal"}>
    {/* `sm:max-w-[560px]`, Modal's "wide": `max-w-xl` is 1320px here (Quincy redefines `--container-xl`, see `reui/alert-dialog.tsx`). */}
    <DialogContent data-testid="review-links-dialog" showCloseButton={false} finalFocus={() => (opener.current?.isConnected ? opener.current : true)} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-4)] sm:max-w-[560px]">
      <OverlayContainerContext.Provider value={slot}>
        {view.kind === "list" && <ReviewLinkList ui={ui} />}
        {view.kind === "create" && (ui.canWrite
          ? <ReviewLinkCreateView ui={ui} videos={videos} />
          // Archived under an open Create: say so under the same title. The draft stays in the store for Restore.
          : <ReviewLinkDialogFrame header={<DialogHeader><DialogTitle className={DIALOG_TITLE}>Create Review link</DialogTitle><DialogDescription>New links can't be made right now.</DialogDescription></DialogHeader>}>
            <Notice tone="caution" role="status">Archived projects are read-only, so a new link can't be created. Your draft is kept until you restore the project.</Notice>
          </ReviewLinkDialogFrame>)}
        {view.kind === "detail" && <ReviewLinkDetail ui={ui} videos={videos} linkId={view.linkId} />}
        {view.kind === "reveal" && reveal && <ReviewLinkReveal reveal={reveal} queued={reveals.length} onDone={store.dismissReveal} />}
      </OverlayContainerContext.Provider>
      <div ref={setSlot} className="contents" />
      {/* Last child, so the first tabbable (initial focus) is never the close control. */}
      <SheetCloseButton label="Close" data-testid="review-links-dialog-close" />
    </DialogContent>
  </Dialog>;
}
