import { useEffect, useState } from "react";
import { Notice } from "./Notice";
import { Button } from "./Button";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";

/** What a Social preview needs of an overlay: the picture and its name. A staff Project's resolved overlay and (#872) a guest payload's both fit. */
export type SocialOverlayFrame = { id: string; name: string; imageUrl: string };

/**
 * Social preview (#871), presentation only: the film framed 9:16 (always fitted: the whole picture, letterboxed inside the frame) under the Project's overlay.
 * The host owns the data and the choices. Nothing else is paused (#877): notes, marks and drawing work as ever, in the picture's own coordinates. Reused by the guest page (#872)
 * and by Compare (#877), where one switcher drives both sides.
 */
export type SocialPreviewMode = {
  overlays: readonly SocialOverlayFrame[];
  /** The overlay on screen (null while none is). */
  currentId: string | null;
  onOverlay(id: string): void;
  status: "loading" | "ready" | "error";
  onRetry(): void;
};

const COARSE = "pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[721px]:min-h-11 max-[721px]:min-w-11";

/**
 * The overlay on screen and whether its picture loaded (#877): the failed / loaded state, shared by the player and by Compare's one switcher. A failure is about one attempt:
 * a new overlay, or Social turned off and on again, starts clean; a successful load clears it. `onError` / `onLoad` go on every `<img>` that shows the artwork.
 */
/** What a stage needs to draw the Social overlay picture: the artwork and its load outcome (`useOverlayImage` produces all three). */
export type SocialStageProps = { imageUrl: string | null; onImageError: () => void; onImageLoad: () => void };

export function useOverlayImage(social: SocialPreviewMode | undefined) {
  const overlay = social?.overlays.find((candidate) => candidate.id === social.currentId) ?? null;
  const active = social !== undefined;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  useEffect(() => { setFailedImage(null); }, [overlay?.imageUrl, active]);
  const imageUrl = overlay?.imageUrl ?? null;
  return {
    imageUrl,
    failed: imageUrl !== null && failedImage === imageUrl,
    onImageError: () => { setFailedImage(imageUrl); },
    onImageLoad: () => { setFailedImage(null); },
  };
}

/** The overlay switcher, in the transport row where the range button sits (and in Compare's toolbar). */
export function SocialPreviewControls({ social, imageFailed }: { social: SocialPreviewMode; imageFailed: boolean }) {
  const current = social.overlays.find((overlay) => overlay.id === social.currentId) ?? null;
  return <div data-testid="video-social-controls" className="flex flex-wrap items-center gap-[var(--space-2)]">
    {social.status === "loading" && <span role="status" className="text-foreground-secondary [font:var(--type-label)]">Loading overlays…</span>}
    {social.status === "error" && <>
      <Notice tone="critical" role="alert" className="py-[var(--space-1)]">Overlays could not be loaded.</Notice>
      <Button type="button" variant="secondary" data-testid="video-social-retry" onClick={social.onRetry}>Retry</Button>
    </>}
    {social.status === "ready" && social.overlays.length === 0 && <span className="text-foreground-secondary [font:var(--type-label)]">No overlay available</span>}
    {social.status === "ready" && imageFailed && <Notice tone="caution" role="alert" className="py-[var(--space-1)]">Overlay unavailable</Notice>}
    {social.status === "ready" && social.overlays.length === 1 && current && <span data-testid="video-social-overlay-name" className="px-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">{current.name}</span>}
    {social.status === "ready" && social.overlays.length > 1 && <Select value={current?.id ?? null} onValueChange={(next) => { if (typeof next === "string") social.onOverlay(next); }}>
      <SelectTrigger aria-label="Overlay" data-testid="video-social-overlay-select" className={cn("min-w-36", COARSE)}>
        <SelectValue>{() => <span className="block truncate">{current?.name ?? "Overlay"}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent className="w-auto min-w-(--anchor-width)">
        {social.overlays.map((overlay) => <SelectItem key={overlay.id} value={overlay.id} className={COARSE}>{overlay.name}</SelectItem>)}
      </SelectContent>
    </Select>}
  </div>;
}
