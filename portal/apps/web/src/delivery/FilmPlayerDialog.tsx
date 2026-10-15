import { useEffect, useRef, type RefObject } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { DownloadIcon, XIcon } from "lucide-react";
import { Button } from "../components/reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/reui/dialog";
import type { DeliveryHrefs } from "./delivery-model";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * The plain player (#882, D36): a film played over the Delivery page where there is no review to open (staff Preview, or the guest part of the gate shut). Title, the browser's own `<video>`, Download original
 * (absent when `hrefs` is null, which is Preview) and Close; no notes, no code, no Version. The reui dialog on the same inverse stage as `quincy/EmbeddedVideoDialog` (which is not importable here: it plays
 * a staff whiteboard media id). `item` is null while closed. A film that can no longer be played (relocked, or its URL gone) closes the dialog: the parent passes null. The video pauses when the dialog
 * closes or the page goes away, because a detached `<video>` keeps playing sound (docs/lessons.md "A removed `<video>` does not stop"). Focus returns to the tile that opened it.
 */
export function FilmPlayerDialog({ item, hrefs, returnFocusTo, onClose }: { item: DeliveryItemDto | null; hrefs: DeliveryHrefs | null; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const playable = item !== null && !item.locked && item.url !== null ? item : null;
  return <Dialog open={playable !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-surface="inverse" data-testid="delivery-film-player" showCloseButton={false} finalFocus={returnFocusTo}
      className="max-h-[90dvh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]">
      {playable !== null && <>
        <div className="flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-2)]">
          <DialogTitle className="min-w-0 flex-1 truncate [font:var(--type-body)]">{playable.label}</DialogTitle>
          {hrefs && <Button variant="ghost" nativeButton={false} data-testid="delivery-film-player-download" className={`shrink-0 ${TOUCH}`} render={<a href={hrefs.download(playable.handle)} download aria-label={`Download ${playable.label}, original`} />}><DownloadIcon aria-hidden="true" />Download original</Button>}
          <DialogClose render={<Button type="button" variant="ghost" size="icon" aria-label="Close" data-testid="delivery-film-player-close" className={`shrink-0 ${TOUCH}`} />}><XIcon aria-hidden="true" /></DialogClose>
        </div>
        <DialogDescription className="sr-only">{`${playable.label}, played here.`}</DialogDescription>
        <PlainVideo item={playable} url={playable.url!} />
      </>}
    </DialogContent>
  </Dialog>;
}

function PlainVideo({ item, url }: { item: DeliveryItemDto; url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const video = ref.current; return () => { video?.pause(); }; }, []);
  return <div className="grid place-items-center bg-invert">
    <video ref={ref} controls playsInline autoPlay src={url} poster={item.thumbUrl ?? undefined} aria-label={item.label} data-testid="delivery-film-player-video" className="max-h-[calc(90dvh-var(--space-8))] w-full object-contain" />
  </div>;
}
