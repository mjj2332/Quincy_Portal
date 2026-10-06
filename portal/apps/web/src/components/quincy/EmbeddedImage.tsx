import { useState } from "react";
import { embeddedMediaUrl } from "../../lib/embedded-media";
import { XIcon } from "lucide-react";
import { Button } from "../reui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../reui/dialog";

/** Twice the 48px (--space-7) close chip. */
const SMALL_NATURAL = 96;

/**
 * A posted embedded image (#493): a thumbnail that opens the larger view in the ReUI dialog. The
 * source is the auth-gated `/media/embedded/:id` route; a file that cannot be loaded (the post's
 * image was removed, or access ended) says so instead of showing a broken icon.
 */
export function EmbeddedImage({ mediaId, alt }: { mediaId: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // Under twice the 48px close chip in either dimension, the chip would cover most of the image (a 24px one entirely): the stage then pads its top and right by the chip so the image sits beside it.
  const [small, setSmall] = useState(false);
  const src = embeddedMediaUrl(mediaId);
  // The author's alt text (#553); an image posted before alt existed has none and keeps the generic name.
  const label = alt?.trim() || "Embedded image";
  if (failed) return <p data-testid="embedded-image-unavailable" className="my-[var(--space-2)] text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">Image unavailable</p>;
  return <>
    {/* The trigger is registered with the dialog, so Escape or Close returns focus to this thumbnail even where a click does not focus a button. */}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<button type="button" data-testid="embedded-image" aria-label={`View image: ${label}`} className="my-[var(--space-2)] block max-w-full cursor-zoom-in rounded-[var(--radius-xs)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2" />}>
        <img src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} className="rich-text__embedded-image" />
      </DialogTrigger>
      {/* The review Lightbox's language: an inverse (dark) stage, the image edge to edge, and the close button on a scrim chip only as large as the button, so a light image never hides it and the photo is not darkened. */}
      <DialogContent data-surface="inverse" data-testid="embedded-image-dialog" showCloseButton={false} className={`place-items-center max-h-[90dvh] min-h-[var(--space-7)] w-fit min-w-[var(--space-7)] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]${small ? " p-[var(--space-7)]" : ""}`}>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">The image as posted.</DialogDescription>
        {/* Never upscaled: the dialog fits the image (w-fit) and the image is capped at its natural size, so a small photo is not stretched soft. */}
        <img src={src} alt={label} onLoad={(event) => setSmall(event.currentTarget.naturalWidth < SMALL_NATURAL || event.currentTarget.naturalHeight < SMALL_NATURAL)} className={`mx-auto block h-auto ${small ? "max-h-[calc(90dvh-2*var(--space-7))]" : "max-h-[90dvh]"} w-auto max-w-full object-contain`} />
        {/* The close chip is the drawn 48px (--space-7) square and the button fills it, so the click area is what is seen. It takes the dialog's corner radius and a hairline ring, so the scrim reads as part of the dialog rather than a bite taken out of its corner. */}
        <div data-testid="embedded-image-scrim" aria-hidden="true" className="pointer-events-none absolute top-0 right-0 size-[var(--space-7)] rounded-xl bg-[var(--scrim-overlay)] ring-[length:var(--border-width-hair)] ring-[color:var(--border-hover)]" />
        <DialogClose render={<Button type="button" variant="ghost" size="icon" data-testid="embedded-image-close" className="absolute top-0 right-0 size-[var(--space-7)] rounded-xl outline-offset-[-4px] focus-visible:!outline-offset-[-4px]" />}>
          <XIcon aria-hidden="true" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  </>;
}
