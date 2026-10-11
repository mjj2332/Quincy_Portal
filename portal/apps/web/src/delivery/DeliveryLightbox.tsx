import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "../components/reui/button";
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "../components/reui/carousel";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/reui/dialog";
import { unlockOf, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
import { useNeighbourPreload, usePrefersReducedMotion } from "./delivery-hooks";
import { PhotoDownloads, ProcessingTile } from "./PhotoGrid";
import { PremiumBadge, TOUCH, UnlockControl } from "./UnlockControl";

/** How long the slideshow holds each photo. */
export const SLIDE_MS = 4000;

function Slide({ item, near }: { item: DeliveryItemDto; near: boolean }) {
  const [failed, setFailed] = useState(false);
  // Only the photo on screen and its neighbours get an <img>; `useNeighbourPreload` warms the two beyond. 40 slides do not mean 40 full-size requests.
  return <div className="grid h-full w-full place-items-center">
    {near && item.url !== null && !failed
      ? <img src={item.url} alt={item.label} onError={() => { setFailed(true); }} className="max-h-full max-w-full object-contain" />
      : near ? <div className="h-[40dvh] w-[min(40rem,90%)]"><ProcessingTile label={item.label} /></div> : null}
  </div>;
}

/**
 * The full-viewport photo viewer (#787 slice 9): `reui/dialog` holding the base-nova `carousel` (embla). The index is OURS (React state), not embla's: the counter, the keys and the slideshow read it, and embla
 * is told where to go (`scrollTo`) and reports where a swipe landed (`select`). Controls: swipe, previous / next, ← →, Esc (the dialog's), a slideshow the person starts and pauses, and a live "Photo 7 of 42".
 * Under `prefers-reduced-motion` embla jumps instead of sliding, and the slideshow cuts. Focus returns to the tile that opened it. Loaded lazily (`DeliveryPage`), so embla ships with nothing else.
 */
export function DeliveryLightbox({ title, items, startIndex, hrefs, unlock, onRequestUnlock, onClose, returnFocus }: {
  title: string; items: DeliveryItemDto[]; startIndex: number; hrefs: DeliveryHrefs | null; unlock: UnlockStates;
  onRequestUnlock: (handle: string) => void; onClose: () => void; returnFocus: () => HTMLElement | null;
}) {
  const count = items.length;
  const [api, setApi] = useState<CarouselApi>();
  const [initial] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(count - 1, 0)));
  const [index, setIndex] = useState(initial);
  const [playing, setPlaying] = useState(false);
  const reduced = usePrefersReducedMotion();
  // Embla re-initialises when its options change, so they are fixed per mount (and per motion preference), never per photo.
  const options = useMemo(() => ({ startIndex: initial, duration: reduced ? 0 : 25 }), [initial, reduced]);
  // A refetch can shrink the list under an open viewer.
  const at = Math.min(index, Math.max(count - 1, 0));
  const item = items[at];
  const urls = useMemo(() => items.map((entry) => entry.url), [items]);
  useNeighbourPreload(urls, at);

  const go = useCallback((next: number) => {
    const target = Math.min(Math.max(next, 0), count - 1);
    setIndex(target);
    api?.scrollTo(target, reduced);
  }, [api, count, reduced]);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => { setIndex(api.selectedScrollSnap()); };
    api.on("select", onSelect);
    return () => { api.off("select", onSelect); };
  }, [api]);

  // The slideshow: one timer per photo, so any move (a key, a swipe) restarts the hold. It stops at the last photo.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => { if (at + 1 < count) go(at + 1); else setPlaying(false); }, SLIDE_MS);
    return () => { clearTimeout(timer); };
  }, [playing, at, count, go]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Embla's own capture handler already moved on an arrow pressed inside the carousel; do not step twice.
    if (event.defaultPrevented) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); go(at - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); go(at + 1); }
  };

  if (!item) return null;
  const nav = `absolute top-1/2 z-10 -translate-y-1/2 rounded-full ${TOUCH}`;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent
      data-testid="delivery-lightbox" data-surface="inverse" showCloseButton={false}
      finalFocus={() => { const tile = returnFocus(); return tile?.isConnected ? tile : true; }}
      onKeyDown={onKeyDown}
      className="inset-0 top-0 left-0 flex h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 focus-visible:!outline-none motion-reduce:animate-none sm:max-w-none"
    >
      <DialogTitle className="sr-only">{`${title}: photos`}</DialogTitle>
      <DialogDescription className="sr-only">Use the arrow keys to move between photos and Escape to close.</DialogDescription>
      <div className="flex items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)]">
        <p data-testid="delivery-lightbox-counter" aria-live="polite" aria-atomic="true" className="m-0 [font:var(--type-label)]">{`Photo ${at + 1} of ${count}`}</p>
        <div className="flex items-center gap-[var(--space-2)]">
          <Button type="button" variant="ghost" aria-pressed={playing} className={TOUCH} disabled={count < 2} onClick={() => { setPlaying((current) => !current); }}>
            {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}{playing ? "Pause slideshow" : "Start slideshow"}
          </Button>
          <DialogClose render={<Button type="button" variant="ghost" size="icon" aria-label="Close" className="max-[721px]:size-11" />}><XIcon aria-hidden /></DialogClose>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Carousel opts={options} setApi={setApi} className="h-full [&>[data-slot=carousel-content]]:h-full" aria-label={`${title} photos`}>
          <CarouselContent className="ml-0 h-full">
            {items.map((entry, position) => <CarouselItem key={entry.handle} className="h-full pl-0" aria-label={`${position + 1} of ${count}`}><Slide item={entry} near={Math.abs(position - at) <= 1} /></CarouselItem>)}
          </CarouselContent>
        </Carousel>
        <Button type="button" variant="secondary" size="icon" aria-label="Previous photo" disabled={at === 0} className={`${nav} left-[var(--space-3)] max-[721px]:size-11`} onClick={() => { go(at - 1); }}><ChevronLeftIcon aria-hidden /></Button>
        <Button type="button" variant="secondary" size="icon" aria-label="Next photo" disabled={at >= count - 1} className={`${nav} right-[var(--space-3)] max-[721px]:size-11`} onClick={() => { go(at + 1); }}><ChevronRightIcon aria-hidden /></Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)]">
        <span className="[font:var(--type-label)]">{item.label}</span>
        {item.locked && <PremiumBadge />}
        {!item.locked && hrefs && <PhotoDownloads item={item} hrefs={hrefs} />}
        {item.locked && <UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />}
      </div>
    </DialogContent>
  </Dialog>;
}
