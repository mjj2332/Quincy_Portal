import { useEffect, useState } from "react";
import type { VideoDto } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { Dialog, DialogContent } from "../reui/dialog";
import { ReviewLinkCreateView } from "./ReviewLinkCreateView";
import { ReviewLinkDetail } from "./ReviewLinkDetail";
import { ReviewLinkList } from "./ReviewLinkList";
import { ReviewLinkReveal } from "./ReviewLinkReveal";
import { ReviewLinkSelectionBar } from "./ReviewLinkSelectionBar";
import { useReviewLinkState, type ReviewLinksUi } from "./use-review-links-ui";

/**
 * The Review links surface of the Video tab (#741 11b): the header button, the selection bar and one dialog whose step (list, create,
 * detail, one-time reveal) is the form store's `view`. Mounted by `VideoCollectionPanel`; renders nothing unless the `links` part is on and
 * the role may share Videos. Reuse ledger: docs/plans/741-11b-ledger.md.
 */
export function ReviewLinksHost({ ui, videos }: { ui: ReviewLinksUi; videos: VideoDto[] }) {
  const { store } = ui;
  const state = useReviewLinkState(store);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const videoIds = videos.map((video) => video.id).join(",");
  // A Video that left the Project takes its tick with it.
  useEffect(() => { store.pruneSelection(videoIds === "" ? [] : videoIds.split(",")); }, [store, videoIds]);
  if (!ui.enabled) return null;
  const { view, reveal } = state;
  return <>
    <div className="flex justify-end">
      <Button type="button" variant="secondary" className="min-h-11" data-testid="review-links-open" onClick={store.openList}>Review links</Button>
    </div>
    {ui.canWrite && state.selection.size > 0 && <ReviewLinkSelectionBar count={state.selection.size} onCreate={store.openCreate} onClear={store.clearSelection} />}
    <Dialog open={view.kind !== "closed"} onOpenChange={(open) => { if (!open) store.closeDialog(); }} disablePointerDismissal={view.kind === "reveal"}>
      <DialogContent data-testid="review-links-dialog" showCloseButton className="max-h-[calc(100dvh-2rem)] gap-[var(--space-4)] overflow-y-auto sm:max-w-xl">
        <OverlayContainerContext.Provider value={slot}>
          {view.kind === "list" && <ReviewLinkList ui={ui} />}
          {view.kind === "create" && ui.canWrite && <ReviewLinkCreateView ui={ui} videos={videos} />}
          {view.kind === "detail" && <ReviewLinkDetail ui={ui} videos={videos} linkId={view.linkId} />}
          {view.kind === "reveal" && reveal && <ReviewLinkReveal reveal={reveal} onDone={store.dismissReveal} />}
        </OverlayContainerContext.Provider>
        <div ref={setSlot} />
      </DialogContent>
    </Dialog>
  </>;
}
