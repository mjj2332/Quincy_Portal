/**
 * Back from a film's review to its tile (#882 follow-up). The review's "Delivery page" link is `/d/<slug>#v=<videoId>`, naming the film the viewer was watching; the Delivery page reads the fragment
 * once on load, opens the tab that holds that film and brings its tile into view. The Video id is no secret on this page: every reviewable tile's link already carries it (`review.url`, ADR 0023).
 * The fragment stays in the bar (the Delivery tree never writes history), so a reload lands on the same tile. Both ends live here so the address and its reader cannot drift.
 */
import type { DeliveryItemDto } from "@quincy/shared";
import type { DeliveryTab, DeliveryTabId } from "./delivery-model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const videoIdOf = (fragment: string): string | null => {
  const id = new URLSearchParams(fragment.replace(/^#/, "")).get("v");
  return id !== null && UUID.test(id) ? id.toLowerCase() : null;
};

/** The review's Back address: the page, plus the film being watched when there is one. */
export const deliveryPageAddress = (pageSlug: string, videoId: string | null): string => `/d/${pageSlug}${videoId !== null && UUID.test(videoId) ? `#v=${videoId}` : ""}`;

/** The film named by the Delivery page's own fragment (`location.hash`), or null. */
export const returnFilmOf = (hash: string): string | null => videoIdOf(hash);

/** The film's Video id, read from its review link's fragment (`…#t=<secret>&v=<videoId>`); null for any item with no review. */
const reviewVideoIdOf = (item: DeliveryItemDto): string | null => {
  const url = item.review?.url;
  const at = url?.indexOf("#") ?? -1;
  return url === undefined || at < 0 ? null : videoIdOf(url.slice(at + 1));
};

/** Where the returning film is: its tab and its handle. Null when no tile on the page opens that film (removed, locked since, or no review). */
export function returnTargetOf(tabs: readonly DeliveryTab[], videoId: string | null): { tab: DeliveryTabId; handle: string } | null {
  if (videoId === null) return null;
  for (const tab of tabs) {
    const item = tab.items.find((entry) => entry.kind === "video" && reviewVideoIdOf(entry) === videoId);
    if (item) return { tab: tab.id, handle: item.handle };
  }
  return null;
}
