import { useState, type CSSProperties } from "react";
import { embeddedMediaUrl } from "../../lib/embedded-media-core";
import { ImageOffIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../reui/dialog";

/** Twice the 48px (--space-7) close chip. */
const SMALL_NATURAL = 96;

/**
 * Adaptation (#927 T1): the 56px tile a posted note's media strip draws (48px + 8px, in spacing tokens). Shared with `EmbeddedVideo`'s
 * `size="thumb"`, so an image and a video sit in the strip as the same square. No prototype frame shows a posted strip; the plan
 * settles 56px tiles that open the existing dialogs.
 */
export const EMBEDDED_THUMB_TILE = "block size-[calc(var(--space-7)+var(--space-2))] shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-border bg-muted";
/**
 * Adaptation (#927 T2): the 32px (--space-6) thumb inside a draft note's chip (frame C4: `.cmp-file .thumb`, 32px at a 5px radius, here
 * `--radius-sm`). It opens the same dialog as the posted tile, so the author can check what they attached. No border: the chip draws one.
 */
export const EMBEDDED_CHIP_TILE = "block size-[var(--space-6)] shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-muted";
/** The two tile sizes, and every size an embedded image or video takes (the video adds its dialog `stage`). One union for both renderers. */
export type EmbeddedTileSize = "thumb" | "chip";
export type EmbeddedMediaSize = "default" | EmbeddedTileSize;
/** The tile class for a tile size. */
export const embeddedTile = (size: EmbeddedTileSize) => (size === "thumb" ? EMBEDDED_THUMB_TILE : EMBEDDED_CHIP_TILE);

/**
 * The larger view's stage, shared by this image's dialog, `EmbeddedVideo`'s tile dialog and `EmbeddedVideoDialog` (#553, #927 review): the
 * inverse (dark) ground, the media edge to edge, no padding and no ring; capped at 90% of the viewport's height, and on a wider screen at
 * 90% of its width or 64rem. Each dialog adds its own sizing to it.
 */
export const MEDIA_STAGE = "max-h-[90dvh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]";

/**
 * The larger view's close control (#553), shared with `EmbeddedVideo`'s tile dialog: the drawn 48px (--space-7) square in the top right,
 * and the button fills it, so the click area is what is seen. The scrim chip under it takes the dialog's corner radius (`--radius-lg`, what
 * `rounded-xl` resolves to on the dialog) and a hairline ring, so it reads as part of the dialog rather than a bite out of its corner, and a
 * light image or bright footage never hides the button. The focus ring is drawn inside the chip (`--space-1` in), since the dialog clips.
 */
export function MediaStageClose({ testId, scrimTestId }: { testId: string; scrimTestId?: string }) {
  return <>
    <div data-testid={scrimTestId} aria-hidden="true" className="pointer-events-none absolute top-0 right-0 size-[var(--space-7)] rounded-[var(--radius-lg)] bg-[var(--scrim-overlay)] ring-[length:var(--border-width-hair)] ring-[color:var(--border-hover)]" />
    <DialogClose render={<Button type="button" variant="ghost" size="icon" data-testid={testId} className="absolute top-0 right-0 size-[var(--space-7)] rounded-[var(--radius-lg)] outline-offset-[calc(var(--space-1)*-1)] focus-visible:!outline-offset-[calc(var(--space-1)*-1)]" />}>
      <XIcon aria-hidden="true" />
      <span className="sr-only">Close</span>
    </DialogClose>
  </>;
}

/**
 * A posted embedded image (#493): a thumbnail that opens the larger view in the ReUI dialog. The
 * source is the auth-gated `/media/embedded/:id` route; a file that cannot be loaded (the post's
 * image was removed, or access ended) says so instead of showing a broken icon. The server gives the image's pixel size when it
 * knows it (#611): `width` and `height` attributes let the browser reserve the box before the lazy file loads, and the stylesheet's
 * `max-width: 100%` and `height: auto` keep it responsive. Without a size (an older image) the box is as it always was.
 */
/** `mediaUrl` (#835) is where the bytes are read from: the staff route by default, a Review link's own for a guest. */
/** `size="thumb"` (#927 T1) is a posted note's strip tile: the picture cropped to a 56px square, opening the same dialog. The default is the inline image every other post draws, unchanged. */
/** `size="chip"` (#927 T2) is the same tile at 32px, inside a draft note's chip. */
export function EmbeddedImage({ mediaId, alt, width, height, mediaUrl = embeddedMediaUrl, size = "default" }: { mediaId: string; alt?: string; width?: number; height?: number; mediaUrl?: (mediaId: string) => string; size?: EmbeddedMediaSize }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // Under twice the 48px close chip in either dimension, the chip would cover most of the image (a 24px one entirely): the stage then pads its top and right by the chip so the image sits beside it.
  const [small, setSmall] = useState(false);
  const src = mediaUrl(mediaId);
  // The author's alt text (#553); an image posted before alt existed has none and keeps the generic name.
  const label = alt?.trim() || "Embedded image";
  const tile = size === "default" ? null : embeddedTile(size);
  const thumb = tile !== null;
  const reserved = width !== undefined && height !== undefined && width > 0 && height > 0 ? { width, height } : {};
  // The trigger hugs the image the stylesheet draws (#611): it takes the recorded size too, since a button sizes from the image's width attribute, not from the width the CSS caps it to.
  const sizedTrigger = width !== undefined && height !== undefined && width > 0 && height > 0 ? { "data-sized": "", style: { "--embedded-image-aspect": width / height, "--embedded-image-width": width } as CSSProperties } : {};
  // A tile keeps its square when the file is gone, so the strip does not reflow; it says why in its name.
  if (failed && thumb) return <span data-testid="embedded-image-unavailable" role="img" aria-label="Image unavailable" title="Image unavailable" className={cn(tile, "grid place-items-center text-foreground-secondary")}><ImageOffIcon aria-hidden="true" className="size-4" /></span>;
  if (failed) return <p data-testid="embedded-image-unavailable" className="my-[var(--space-2)] text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">Image unavailable</p>;
  return <>
    {/* The trigger is registered with the dialog, so Escape or Close returns focus to this thumbnail even where a click does not focus a button. */}
    <Dialog open={open} onOpenChange={setOpen}>
      {thumb
        // The tile is a fixed square, so the recorded size has no box to reserve and nothing to hug.
        ? <DialogTrigger render={<button type="button" data-testid="embedded-image" data-size={size} aria-label={`View image: ${label}`} className={cn(tile, "cursor-zoom-in p-0 transition-colors hover:border-[color:var(--border-hover)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2")} />}>
          <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} className="block size-full object-cover" />
        </DialogTrigger>
        : <DialogTrigger render={<button type="button" data-testid="embedded-image" {...sizedTrigger} aria-label={`View image: ${label}`} className="rich-text__embedded-image-trigger my-[var(--space-2)] block max-w-full cursor-zoom-in rounded-[var(--radius-xs)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          <img src={src} alt={label} {...reserved} loading="lazy" decoding="async" onError={() => setFailed(true)} className="rich-text__embedded-image" />
        </DialogTrigger>}
      {/* The review Lightbox's language: an inverse (dark) stage, the image edge to edge, and the close button on a scrim chip only as large as the button, so a light image never hides it and the photo is not darkened. */}
      <DialogContent data-surface="inverse" data-testid="embedded-image-dialog" showCloseButton={false} className={cn(MEDIA_STAGE, "place-items-center min-h-[var(--space-7)] w-fit min-w-[var(--space-7)]", small && "p-[var(--space-7)]")}>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">The image as posted.</DialogDescription>
        {/* Never upscaled: the dialog fits the image (w-fit) and the image is capped at its natural size, so a small photo is not stretched soft. */}
        <img src={src} alt={label} onLoad={(event) => setSmall(event.currentTarget.naturalWidth < SMALL_NATURAL || event.currentTarget.naturalHeight < SMALL_NATURAL)} className={`mx-auto block h-auto ${small ? "max-h-[calc(90dvh-2*var(--space-7))]" : "max-h-[90dvh]"} w-auto max-w-full object-contain`} />
        <MediaStageClose testId="embedded-image-close" scrimTestId="embedded-image-scrim" />
      </DialogContent>
    </Dialog>
  </>;
}
