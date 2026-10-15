import { useRef, useState } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { EllipsisIcon, DownloadIcon } from "lucide-react";
import { VideoTile } from "../components/quincy/VideoTile";
import { IconButton } from "../components/quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../components/quincy/menu";
import { unlockOf, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
import { FilmPlayerDialog } from "./FilmPlayerDialog";
import { PremiumBadge, UnlockControl } from "./UnlockControl";

/** Where tapping a film goes (#882, D34): the Delivery review link in THIS tab, with the page to return to carried in the fragment (`p`, validated by the review page before use). */
export const reviewAddress = (reviewUrl: string, pageSlug: string | null): string => (pageSlug === null ? reviewUrl : `${reviewUrl}&p=${pageSlug}`);

/**
 * The Film tab: the same poster tile as the Video collection (`quincy/VideoTile`, D30/D31), in paper colours on the light page. Tapping a tile with a `review` opens that film on the Delivery review link in the
 * same tab; with no `review` (staff Preview, or guest review off) it plays in the plain player (D36), and then the tile shows neither a Version nor a count, because the page has no review to point them at. "⋯"
 * offers Download original (D35), absent in Preview. A locked Premium film is a locked tile (D37) whose tap, and whose button, request an unlock. The grid (D32/D33): as many 280 px columns as fit, one under 721 px,
 * a lone film across the full width.
 */
export function FilmList({ items, hrefs, unlock, onRequestUnlock, pageSlug = null, assign = (address: string) => { window.location.assign(address); } }: {
  items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void;
  /** This page's own address segment, so the review's Back button can return here. */
  pageSlug?: string | null;
  /** The same-tab navigation; injectable because a document cannot be left in a test. */
  assign?: (address: string) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const player = playing === null ? null : items.find((item) => item.handle === playing) ?? null;
  return <>
    <ul aria-label="Film" data-testid="delivery-film" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[var(--space-5)] p-0 has-[>li:only-child]:grid-cols-1 max-[721px]:grid-cols-1">
      {items.map((item) => <li key={item.handle} data-testid="delivery-film-item" data-handle={item.handle} className="min-w-0">
        {item.locked
          ? <VideoTile
            tone="paper" locked testId="delivery-film-tile" openTestId="delivery-film-open"
            title={item.label} posterUrl={null} version={null} durationMs={null} openNotes={null}
            onOpen={() => { onRequestUnlock(item.handle); }}
            menu={<PremiumBadge />}
            footer={<UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />}
          />
          : <VideoTile
            tone="paper" testId="delivery-film-tile" openTestId="delivery-film-open"
            title={item.label} posterUrl={item.thumbUrl} version={item.version ?? null} durationMs={item.durationMs} openNotes={item.openNotes ?? null}
            onOpen={(element) => {
              if (item.review) assign(reviewAddress(item.review.url, pageSlug));
              else if (item.url !== null) { trigger.current = element; setPlaying(item.handle); }
            }}
            menu={hrefs ? <FilmMenu item={item} hrefs={hrefs} /> : undefined}
          />}
      </li>)}
    </ul>
    <FilmPlayerDialog item={player} hrefs={hrefs} returnFocusTo={trigger} onClose={() => { setPlaying(null); }} />
  </>;
}

function FilmMenu({ item, hrefs }: { item: DeliveryItemDto; hrefs: DeliveryHrefs }) {
  return <Menu triggerLabel={`Actions for ${item.label}`} label={`${item.label} actions`} triggerTestId="delivery-film-menu" triggerRender={<IconButton />} triggerClassName="text-foreground" trigger={<EllipsisIcon aria-hidden="true" className="size-4" />}>
    <MenuPrimitive.LinkItem closeOnClick className={`${MENU_ITEM} gap-[var(--space-2)]`} data-testid="delivery-film-download" href={hrefs.download(item.handle)} download aria-label={`Download ${item.label}, original`}>
      <DownloadIcon aria-hidden="true" className="size-4" />Download original
    </MenuPrimitive.LinkItem>
  </Menu>;
}
