import { useEffect } from "react";
import type { VideoDto } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { PROJECT_SHEET_CLOSE_SCROLL_MARGIN } from "../quincy/ProjectSheet";
import { ReviewLinkSelectionBar } from "./ReviewLinkSelectionBar";
import { useReviewLinkState, type ReviewLinksUi } from "./use-review-links-ui";

/**
 * The Review links surface of the Video tab (#741 11b): the selection bar (the header button is `ReviewLinksOpenButton`). The dialog (list, create, detail, one-time
 * reveal) is `ReviewLinksDialogHost`, mounted by `ReviewLinksScope` above the tab switch. Mounted by `VideoCollectionPanel`; renders nothing
 * unless the `links` part is on and the role may share Videos. Reuse ledger: docs/plans/741-11b-ledger.md.
 */
export function ReviewLinksHost({ ui, videos, onBarHeight, onDownload }: { ui: ReviewLinksUi; videos: VideoDto[]; onBarHeight?: (height: number) => void; /** The selection bar's Download (#884), present when staff may download. */ onDownload?: (selectedIds: string[]) => void }) {
  const { store } = ui;
  const state = useReviewLinkState(store);
  const videoIds = videos.map((video) => video.id).join(",");
  // A Video that left the Project takes its tick with it.
  useEffect(() => { store.pruneSelection(videoIds === "" ? [] : videoIds.split(",")); }, [store, videoIds]);
  if (!ui.canSelect) return null;
  return state.selection.size > 0 ? <ReviewLinkSelectionBar count={state.selection.size} {...(ui.canWrite ? { onCreate: store.openCreate } : {})} onClear={store.clearSelection} {...(onDownload ? { onDownload: () => { onDownload([...state.selection]); } } : {})} {...(onBarHeight ? { onHeight: onBarHeight } : {})} /> : null;
}

/** The "Review links" button, in the Films header (`VideoCollectionPanel`); renders nothing unless Review links are on. */
export function ReviewLinksOpenButton({ ui }: { ui: ReviewLinksUi }) {
  if (!ui.enabled) return null;
  return <Button type="button" variant="secondary" className={`min-h-11 ${PROJECT_SHEET_CLOSE_SCROLL_MARGIN}`} data-testid="review-links-open" onClick={() => { ui.store.openList(); }}>Review links</Button>;
}
