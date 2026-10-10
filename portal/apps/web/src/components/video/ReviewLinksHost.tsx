import { useEffect } from "react";
import type { VideoDto } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { ReviewLinkSelectionBar } from "./ReviewLinkSelectionBar";
import { useReviewLinkState, type ReviewLinksUi } from "./use-review-links-ui";

/**
 * The Review links surface of the Video tab (#741 11b): the header button and the selection bar. The dialog (list, create, detail, one-time
 * reveal) is `ReviewLinksDialogHost`, mounted by `ReviewLinksScope` above the tab switch. Mounted by `VideoCollectionPanel`; renders nothing
 * unless the `links` part is on and the role may share Videos. Reuse ledger: docs/plans/741-11b-ledger.md.
 */
export function ReviewLinksHost({ ui, videos }: { ui: ReviewLinksUi; videos: VideoDto[] }) {
  const { store } = ui;
  const state = useReviewLinkState(store);
  const videoIds = videos.map((video) => video.id).join(",");
  // A Video that left the Project takes its tick with it.
  useEffect(() => { store.pruneSelection(videoIds === "" ? [] : videoIds.split(",")); }, [store, videoIds]);
  if (!ui.enabled) return null;
  return <>
    <div className="flex justify-end">
      <Button type="button" variant="secondary" className="min-h-11" data-testid="review-links-open" onClick={store.openList}>Review links</Button>
    </div>
    {ui.canWrite && state.selection.size > 0 && <ReviewLinkSelectionBar count={state.selection.size} onCreate={store.openCreate} onClear={store.clearSelection} />}
  </>;
}
