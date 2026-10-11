import { useState } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { LazyImage } from "../components/LazyImage";
import { Button, buttonVariants } from "../components/reui/button";
import { aspectOf, unlockOf, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
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

function PhotoTile({ item, items, index, hrefs, unlock, onRequestUnlock, onOpen }: { item: DeliveryItemDto; items: DeliveryItemDto[]; index: number; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; onOpen: OpenViewer }) {
  const [failed, setFailed] = useState(false);
  return <li data-testid="delivery-tile" data-handle={item.handle} className="grid content-start gap-[var(--space-2)]">
    <div style={{ aspectRatio: aspectOf(item) }} className="relative overflow-hidden border border-solid border-[var(--border-hairline)] bg-surface-sunken">
      {item.thumbUrl !== null && !failed
        ? <LazyImage src={item.thumbUrl} alt={item.label} className="size-full object-cover" onFailedChange={setFailed} />
        : <ProcessingTile label={item.label} />}
      <Button type="button" variant="ghost" aria-label={`Open ${item.label}`} className="absolute inset-0 h-full w-full rounded-none p-0 hover:bg-transparent" onClick={(event) => { onOpen(items, index, event.currentTarget); }} />
      {item.locked && <span className="pointer-events-none absolute top-[var(--space-2)] left-[var(--space-2)]"><PremiumBadge /></span>}
    </div>
    <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
      <span className="[font:var(--type-label)]">{item.label}</span>
      {!item.locked && hrefs && <PhotoDownloads item={item} hrefs={hrefs} />}
    </div>
    {item.locked && <UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />}
  </li>;
}

/** The thumbnails: four columns, two once the page itself (not the window) is 721 px or narrower, so it holds its shape inside Preview's 720 px dialog. Boxes carry the photo's own ratio, so nothing shifts as images load. */
export function PhotoGrid({ items, hrefs, unlock, onRequestUnlock, onOpen, label = "Photos" }: { items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; onOpen: OpenViewer; label?: string }) {
  return <ul aria-label={label} data-testid="delivery-grid" className="m-0 grid list-none grid-cols-4 gap-[var(--space-3)] p-0 @max-[721px]:grid-cols-2">
    {items.map((item, index) => <PhotoTile key={item.handle} item={item} items={items} index={index} hrefs={hrefs} unlock={unlock} onRequestUnlock={onRequestUnlock} onOpen={onOpen} />)}
  </ul>;
}
