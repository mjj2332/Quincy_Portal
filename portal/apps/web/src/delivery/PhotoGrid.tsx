import { useState } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { LazyImage } from "../components/LazyImage";
import { Button, buttonVariants } from "../components/reui/button";
import { unlockOf, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
import { PremiumBadge, TOUCH, UnlockControl } from "./UnlockControl";

/** What a tile shows when its derivative is not there (yet): never the original, never a broken image. */
export function ProcessingTile({ label }: { label: string }) {
  return <div data-testid="delivery-processing" className="grid size-full place-items-center bg-surface-sunken p-[var(--space-3)] text-center [font:var(--type-label)] text-foreground-secondary">{`${label} is still being prepared.`}</div>;
}

export type OpenViewer = (items: DeliveryItemDto[], index: number, opener: HTMLElement) => void;

/** A Web-size / Full-res pair. Same-origin `download` anchors: the browser saves them, the page reads nothing back. */
export function PhotoDownloads({ item, hrefs }: { item: DeliveryItemDto; hrefs: DeliveryHrefs }) {
  const link = buttonVariants({ variant: "outline", size: "sm", className: `w-fit ${TOUCH}` });
  return <div className="flex flex-wrap gap-[var(--space-2)]">
    <a href={hrefs.media(item.handle)} download aria-label={`Download ${item.label}, web size`} className={link}>Web-size</a>
    <a href={hrefs.download(item.handle)} download aria-label={`Download ${item.label}, full resolution`} className={link}>Full-res</a>
  </div>;
}

/** The tile's picture. Keyed by its address and lock state, so a failure belongs to the file that failed: an unlock refetch brings a different file and gets a fresh try. */
function TileImage({ item }: { item: DeliveryItemDto }) {
  const [failed, setFailed] = useState(false);
  if (item.thumbUrl === null || failed) return <ProcessingTile label={item.label} />;
  // The caption is the picture's, not the tile's: a processing tile already says its piece in words, and the scrim would sit over them.
  // Always visible (the prototype reveals it on hover, which a phone has no equivalent of), and it never takes a click from the open button over it.
  return <>
    <LazyImage src={item.thumbUrl} alt={item.label} className="size-full object-cover" onFailedChange={setFailed} />
    <span data-testid="delivery-tile-caption" className="pointer-events-none absolute inset-x-0 bottom-0 bg-[image:var(--scrim-caption)] px-[var(--space-3)] pt-[var(--space-6)] pb-[var(--space-2)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-on-inverse">{item.label}</span>
  </>;
}

function PhotoTile({ item, items, index, hrefs, unlock, onRequestUnlock, onOpen }: { item: DeliveryItemDto; items: DeliveryItemDto[]; index: number; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; onOpen: OpenViewer }) {
  return <li data-testid="delivery-tile" data-handle={item.handle} className="grid content-start gap-[var(--space-2)]">
    {/* The clip is on the picture's own wrapper, not on the tile: the open button's focus outline is drawn outward and an ancestor with overflow-hidden would cut it off. */}
    <div className="relative aspect-[3/2] bg-surface-sunken">
      <div className="absolute inset-0 overflow-hidden"><TileImage key={`${item.locked}:${item.thumbUrl}`} item={item} /></div>
      <Button type="button" variant="ghost" aria-label={`Open ${item.label}`} className="absolute inset-0 h-full w-full rounded-none p-0 hover:bg-transparent" onClick={(event) => { onOpen(items, index, event.currentTarget); }} />
      {item.locked && <span className="pointer-events-none absolute top-[var(--space-2)] left-[var(--space-2)]"><PremiumBadge overPhoto /></span>}
    </div>
    {!item.locked && hrefs && <PhotoDownloads item={item} hrefs={hrefs} />}
    {item.locked && <UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />}
  </li>;
}

/** The thumbnails: four columns, two once the page itself (not the window) is 721 px or narrower, so it holds its shape inside Preview's 720 px dialog. Every tile is a uniform 3:2 box and the picture covers it (cropped), so rows stay even and nothing shifts as images load; the viewer shows the whole photo. */
export function PhotoGrid({ items, hrefs, unlock, onRequestUnlock, onOpen, label = "Photos" }: { items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; onOpen: OpenViewer; label?: string }) {
  return <ul aria-label={label} data-testid="delivery-grid" className="m-0 grid list-none grid-cols-4 gap-[var(--space-4)] p-0 @max-[721px]:grid-cols-2 @max-[721px]:gap-[var(--space-2)]">
    {items.map((item, index) => <PhotoTile key={item.handle} item={item} items={items} index={index} hrefs={hrefs} unlock={unlock} onRequestUnlock={onRequestUnlock} onOpen={onOpen} />)}
  </ul>;
}
