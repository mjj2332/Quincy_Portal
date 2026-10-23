import { useCallback, useEffect, useRef, useState } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { EllipsisIcon, DownloadIcon } from "lucide-react";
import { VideoTile } from "../components/quincy/VideoTile";
import { IconButton } from "../components/quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../components/quincy/menu";
import type { StepDelta } from "../components/quincy/VideoStepControl";
import { filmName, unlockOf, type DeliveryHrefs, type UnlockState, type UnlockStates } from "./delivery-model";
import { FilmPlayerDialog, isPlayableFilm, type FilmStep } from "./FilmPlayerDialog";
import { PremiumBadge, UnlockLine, useUnlockView } from "./UnlockControl";

/** Where tapping a film goes (#882, D34): the Delivery review link in THIS tab, with the page to return to carried in the fragment (`p`, validated by the review page before use). */
export const reviewAddress = (reviewUrl: string, pageSlug: string | null): string => (pageSlug === null ? reviewUrl : `${reviewUrl}&p=${pageSlug}`);

/**
 * The Film tab: the same poster tile as the Video collection (`quincy/VideoTile`, D30/D31), in paper colours on the light page. A tile with a `review` is a real same-tab link to that film on the Delivery
 * review link (story 28, "one link": open-in-new-tab and copy-link work as on any link); with no `review` (staff Preview, or guest review off) it is a button that plays the film in the plain player (D36), and
 * then the tile shows neither a Version nor a count, because the page has no review to point them at. "⋯" offers Download original (D35), absent in Preview. A locked Premium film is a locked tile (D37,
 * `LockedFilmTile`). The grid (D32/D33): as many 280 px columns as fit, one at 721 px and under the page's CONTAINER (the page holds its
 * phone layout at 720 px inside the staff Preview dialog, `DeliveryPage`), a lone film across the full width. The plain player steps through this list's playable films (#937, `usePlainPlayer`).
 */
export function FilmList({ items, hrefs, unlock, onRequestUnlock, pageSlug = null }: {
  items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void;
  /** This page's own address segment, so the review's Back button can return here. */
  pageSlug?: string | null;
}) {
  const { listRef, openFilm, player } = usePlainPlayer(items);
  return <>
    <ul ref={listRef} aria-label="Film" data-testid="delivery-film" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-[var(--space-4)] p-0 has-[>li:only-child]:grid-cols-1 @max-[721px]:grid-cols-1">
      {items.map((item) => { const name = filmName(item); return <li key={item.handle} data-testid="delivery-film-item" data-handle={item.handle} className="min-w-0">
        {item.locked
          ? <LockedFilmTile name={name} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />
          : <VideoTile
            tone="paper" testId="delivery-film-tile" openTestId="delivery-film-open"
            title={name} posterUrl={item.thumbUrl} version={item.version ?? null} durationMs={item.durationMs} openNotes={item.openNotes ?? null}
            {...(item.review
              ? { href: reviewAddress(item.review.url, pageSlug) }
              : { onOpen: () => { openFilm(item.handle); } })}
            menu={hrefs ? <FilmMenu item={item} hrefs={hrefs} /> : undefined}
          />}
      </li>; })}
    </ul>
    <FilmPlayerDialog hrefs={hrefs} {...player} />
  </>;
}

/** The films the plain player plays and steps through, in list order (#937): unlocked, with a URL, no Review link. */
export const playableFilms = (items: readonly DeliveryItemDto[]): DeliveryItemDto[] => items.filter(isPlayableFilm);

/**
 * The plain player for one list of films (#937): which film is showing, previous / next over that list's playable films only (the Film tab and the Premium tab's films step separately), and where focus
 * goes on close. `listRef` goes on the element that holds the films' `[data-testid=delivery-film-item][data-handle]` entries, each with its `[data-testid=delivery-film-open]` control, in any layout (#941):
 * on close, focus goes to the open control of the film showing THEN (after steps, not the one first opened), resolved at that moment. A refetch that makes that film unplayable closes the player and
 * forgets it (so it never reopens by itself); focus then goes to that film's tile if it is still in the list (relocked on the Premium tab), else to the tile that took its place.
 */
export function usePlainPlayer(items: readonly DeliveryItemDto[]) {
  const [playing, setPlaying] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const playable = playableFilms(items);
  const index = playing === null ? -1 : playable.findIndex((item) => item.handle === playing);
  const current = index < 0 ? null : playable[index]!;
  if (playing !== null && current === null) setPlaying(null);
  // The film last shown and its place in the whole list, kept past its removal so a close can still find its tile or its neighbour.
  const shown = useRef<{ handle: string; at: number } | null>(null);
  useEffect(() => { if (current !== null) shown.current = { handle: current.handle, at: items.indexOf(current) }; }, [current, items]);

  const returnFocusTo = useCallback((): HTMLElement | boolean => {
    const last = shown.current;
    const entries = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-testid="delivery-film-item"]') ?? [])];
    if (last === null || entries.length === 0) return true;
    const entry = entries.find((element) => element.dataset.handle === last.handle) ?? entries[Math.min(last.at, entries.length - 1)]!;
    const open = entry.querySelector<HTMLElement>('[data-testid="delivery-film-open"]');
    return open?.isConnected ? open : true;
  }, []);
  const onStep = (delta: StepDelta) => { const target = playable[index + delta]; if (target) setPlaying(target.handle); };
  const step: FilmStep | undefined = current !== null && playable.length > 1
    ? { position: index, total: playable.length, canPrev: index > 0, canNext: index < playable.length - 1, onStep }
    : undefined;
  /** Plays a film from its tile (or row); a film this player does not play is ignored. */
  const openFilm = (handle: string) => { if (playable.some((item) => item.handle === handle)) setPlaying(handle); };
  return { listRef, openFilm, player: { item: current, step, returnFocusTo, onClose: () => { setPlaying(null); } } };
}

/**
 * A locked Premium film (#882, prototype V1/V3): one control, the tile itself. Its tap requests the unlock, and "Request unlock" is a text line on the tile (`UnlockLine`), not a second button.
 * Once requested (V3) the line is the studio's acknowledgement and the tile is inert but still focusable (`openDisabled`, so focus stays on the tile the viewer pressed, where a `disabled` button would
 * drop it to the page), named "Unlock requested: <title>". It is inert the same way while the request is sending or waiting out a rate limit; a failed request leaves it a live "Request unlock" to retry.
 */
function LockedFilmTile({ name, state, onRequest }: { name: string; state: UnlockState; onRequest: () => void }) {
  const view = useUnlockView(state);
  return <VideoTile
    tone="paper" locked testId="delivery-film-tile" openTestId="delivery-film-open"
    title={name} posterUrl={null} version={null} durationMs={null} openNotes={null}
    openLabel={`${view.requested ? "Unlock requested" : "Request unlock"}: ${name}`} openDisabled={view.inert} onOpen={onRequest}
    menu={<PremiumBadge />}
    caption={<UnlockLine view={view} />}
  />;
}

function FilmMenu({ item, hrefs }: { item: DeliveryItemDto; hrefs: DeliveryHrefs }) {
  return <Menu triggerLabel={`Actions for ${filmName(item)}`} label={`${filmName(item)} actions`} triggerTestId="delivery-film-menu" triggerRender={<IconButton />} triggerClassName="text-foreground" trigger={<EllipsisIcon aria-hidden="true" className="size-4" />}>
    <MenuPrimitive.LinkItem closeOnClick className={`${MENU_ITEM} gap-[var(--space-2)]`} data-testid="delivery-film-download" href={hrefs.download(item.handle)} download aria-label={`Download ${filmName(item)}, original`}>
      <DownloadIcon aria-hidden="true" className="size-4" />Download original
    </MenuPrimitive.LinkItem>
  </Menu>;
}
