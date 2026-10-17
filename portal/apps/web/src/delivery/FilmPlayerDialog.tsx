import { useEffect, useRef, useState, type RefObject } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { DownloadIcon, XIcon } from "lucide-react";
import { EmptyState } from "../components/quincy/EmptyState";
import { Button } from "../components/reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/reui/dialog";
import { Spinner } from "../components/reui/spinner";
import { filmName, type DeliveryHrefs } from "./delivery-model";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * The plain player (#882, D36): a film played over the Delivery page where there is no review to open (staff Preview, or the guest part of the gate shut). Title, the browser's own `<video>`, Download original
 * (absent when `hrefs` is null, which is Preview) and Close; no notes, no code, no Version. The reui dialog on the same inverse stage as `quincy/EmbeddedVideoDialog` (which is not importable here: it plays
 * a staff whiteboard media id). `item` is null while closed. A film that can no longer be played (relocked, or its URL gone) closes the dialog: the parent passes null. The video pauses when the dialog
 * closes or the page goes away, because a detached `<video>` keeps playing sound (docs/lessons.md "A removed `<video>` does not stop"). Focus returns to the tile that opened it.
 * Until the film's metadata is in, a spinner sits over the poster (one status line); a film that fails to load is an inline error with Try again, which mounts a fresh `<video>` (a failed element does not reload
 * by itself). Title, Download original and Close stay through both, so a film that will not stream can still be downloaded.
 */
export function FilmPlayerDialog({ item, hrefs, returnFocusTo, onClose }: { item: DeliveryItemDto | null; hrefs: DeliveryHrefs | null; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const playable = item !== null && !item.locked && item.url !== null ? item : null;
  return <Dialog open={playable !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-surface="inverse" data-testid="delivery-film-player" showCloseButton={false} finalFocus={returnFocusTo}
      className="max-h-[90dvh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]">
      {playable !== null && <>
        <div className="flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-2)]">
          <DialogTitle className="min-w-0 flex-1 truncate [font:var(--type-body)]">{filmName(playable)}</DialogTitle>
          {hrefs && <Button variant="ghost" nativeButton={false} data-testid="delivery-film-player-download" className={`shrink-0 ${TOUCH}`} render={<a href={hrefs.download(playable.handle)} download aria-label={`Download ${filmName(playable)}, original`} />}><DownloadIcon aria-hidden="true" />Download original</Button>}
          <DialogClose render={<Button type="button" variant="ghost" size="icon" aria-label="Close" data-testid="delivery-film-player-close" className={`shrink-0 ${TOUCH}`} />}><XIcon aria-hidden="true" /></DialogClose>
        </div>
        <DialogDescription className="sr-only">{`${filmName(playable)}, played here.`}</DialogDescription>
        <PlainVideo item={playable} url={playable.url!} />
      </>}
    </DialogContent>
  </Dialog>;
}

type Load = "loading" | "ready" | "failed";

function PlainVideo({ item, url }: { item: DeliveryItemDto; url: string }) {
  const [load, setLoad] = useState<Load>("loading");
  // Try again remounts the element under a new key: the old one has given up on its source.
  const [attempt, setAttempt] = useState(0);
  if (load === "failed") {
    return <div className="grid place-items-center bg-invert px-[var(--space-4)] py-[var(--space-6)]">
      <EmptyState size="compact" tone="error" role="alert" data-testid="delivery-film-player-error" title="Couldn't play this film. Check your connection and try again.">
        <Button type="button" variant="outline" data-testid="delivery-film-player-retry" className={`mt-[var(--space-2)] ${TOUCH}`} onClick={() => { setLoad("loading"); setAttempt((n) => n + 1); }}>Try again</Button>
      </EmptyState>
    </div>;
  }
  return <div className="grid place-items-center bg-invert">
    <PlainVideoElement key={attempt} item={item} url={url} onReady={() => { setLoad("ready"); }} onFailed={() => { setLoad("failed"); }} />
    {load === "loading" && <div role="status" data-testid="delivery-film-player-loading" className="pointer-events-none flex items-center gap-[var(--space-2)] text-invert-foreground [grid-area:1/1] [font:var(--type-label)]">
      <Spinner aria-hidden="true" role="presentation" className="size-5" /><span className="sr-only">Loading the film</span>
    </div>}
  </div>;
}

function PlainVideoElement({ item, url, onReady, onFailed }: { item: DeliveryItemDto; url: string; onReady: () => void; onFailed: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { const video = ref.current; return () => { video?.pause(); }; }, []);
  return <video ref={ref} controls playsInline autoPlay src={url} poster={item.thumbUrl ?? undefined} aria-label={filmName(item)} data-testid="delivery-film-player-video"
    // Metadata is enough to call it loaded: iOS Safari fetches no frame data until the viewer presses play, so `loadeddata` alone would leave the spinner up.
    onLoadedMetadata={onReady} onLoadedData={onReady} onError={onFailed}
    className="max-h-[calc(90dvh-var(--space-8))] w-full object-contain [grid-area:1/1]" />;
}
