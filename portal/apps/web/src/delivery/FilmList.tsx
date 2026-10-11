import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { DeliveryItemDto } from "@quincy/shared";
import { FilmIcon } from "lucide-react";
import { buttonVariants } from "../components/reui/button";
import { unlockOf, formatDuration, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
import { PremiumBadge, TOUCH, UnlockControl } from "./UnlockControl";

/**
 * One film: the browser's own player, nothing loaded until play (`preload="none"`, the poster is the thumbnail). Hand-built because `quincy/VideoPlayer` needs `VideoVersionDto` timing the public DTO lacks and the
 * ReUI registry has no player (see docs/plans/787-9-ledger.md). It pauses on unmount, which is also tab change: a detached `<video>` keeps playing, sound and all (docs/lessons.md "A removed `<video>` does not stop").
 */
function FilmPlayer({ item, hrefs }: { item: DeliveryItemDto; hrefs: DeliveryHrefs | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = ref.current;
    return () => { video?.pause(); };
  }, [failed]);
  // One film at a time: starting this one pauses any other on the page.
  const onPlay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const current = event.currentTarget;
    current.closest("[data-testid='delivery-film']")?.querySelectorAll("video").forEach((other) => { if (other !== current) other.pause(); });
  };
  const duration = formatDuration(item.durationMs);
  return <div className="grid gap-[var(--space-2)]">
    {failed || item.url === null
      ? <div role="alert" data-testid="delivery-film-failed" style={{ aspectRatio: "16 / 9" }} className="grid place-items-center bg-surface-sunken p-[var(--space-4)] text-center [font:var(--type-body)] text-foreground-secondary">This film can't be played here.{hrefs ? " You can download it instead." : ""}</div>
      : <video ref={ref} controls playsInline preload="none" poster={item.thumbUrl ?? undefined} src={item.url} aria-label={item.label} onError={() => { setFailed(true); }} onPlay={onPlay} style={{ aspectRatio: item.width !== null && item.height !== null ? `${item.width} / ${item.height}` : "16 / 9" }} className="w-full bg-surface-sunken" />}
    <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
      <span className="[font:var(--type-label)]">{item.label}</span>
      {duration !== null && <span className="[font:var(--type-label)] text-foreground-secondary">{duration}</span>}
      {hrefs && <a href={hrefs.download(item.handle)} download aria-label={`Download ${item.label}, original`} className={buttonVariants({ variant: "outline", size: "sm", className: `w-fit ${TOUCH}` })}>Download original</a>}
    </div>
  </div>;
}

/** A locked film or document has no URL at all, so it is a labelled placeholder: a mark, the name, Premium, and the way to ask. */
export function LockedTile({ item, unlock, onRequestUnlock, noun }: { item: DeliveryItemDto; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; noun: string }) {
  return <div data-testid="delivery-locked" className="grid gap-[var(--space-2)]">
    <div style={{ aspectRatio: "16 / 9" }} className="grid place-items-center border border-solid border-[var(--border-hairline)] bg-surface-sunken text-foreground-secondary">
      <div className="grid justify-items-center gap-[var(--space-2)]"><FilmIcon aria-hidden className="size-6" /><span className="[font:var(--type-label)]">{`${noun} · locked`}</span></div>
    </div>
    <div className="flex flex-wrap items-center gap-[var(--space-3)]"><span className="[font:var(--type-label)]">{item.label}</span><PremiumBadge /></div>
    <UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />
  </div>;
}

export function FilmList({ items, hrefs, unlock, onRequestUnlock }: { items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void }) {
  return <ul aria-label="Film" data-testid="delivery-film" className="m-0 grid list-none grid-cols-2 gap-[var(--space-5)] p-0 @max-[721px]:grid-cols-1">
    {items.map((item) => <li key={item.handle} data-testid="delivery-film-item" data-handle={item.handle}>
      {item.locked ? <LockedTile item={item} unlock={unlock} onRequestUnlock={onRequestUnlock} noun="Film" /> : <FilmPlayer item={item} hrefs={hrefs} />}
    </li>)}
  </ul>;
}
