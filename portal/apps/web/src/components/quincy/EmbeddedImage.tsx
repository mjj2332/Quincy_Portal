import { useState } from "react";
import { embeddedMediaUrl } from "../../lib/embedded-media";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../reui/dialog";

/**
 * A posted embedded image (#493): a thumbnail that opens the larger view in the ReUI dialog. The
 * source is the auth-gated `/media/embedded/:id` route; a file that cannot be loaded (the post's
 * image was removed, or access ended) says so instead of showing a broken icon.
 */
export function EmbeddedImage({ mediaId }: { mediaId: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = embeddedMediaUrl(mediaId);
  if (failed) return <p data-testid="embedded-image-unavailable" className="my-[var(--space-2)] text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">Image unavailable</p>;
  return <>
    {/* The trigger is registered with the dialog, so Escape or Close returns focus to this thumbnail even where a click does not focus a button. */}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<button type="button" data-testid="embedded-image" aria-label="View image larger" className="my-[var(--space-2)] block max-w-full cursor-zoom-in rounded-[var(--radius-xs)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2" />}>
        <img src={src} alt="Embedded image" loading="lazy" decoding="async" onError={() => setFailed(true)} className="rich-text__embedded-image" />
      </DialogTrigger>
      {/* The review Lightbox's language: an inverse (dark) stage, the image edge to edge, and the close button on a scrim so a wide image never sits under it. */}
      <DialogContent data-surface="inverse" data-testid="embedded-image-dialog" className="max-h-[90dvh] max-w-[calc(100%-2rem)] gap-0 overflow-hidden bg-background p-0 text-foreground ring-0 sm:max-w-[min(90vw,64rem)]">
        <DialogTitle className="sr-only">Image</DialogTitle>
        <DialogDescription className="sr-only">The image as posted in the discussion.</DialogDescription>
        <div data-testid="embedded-image-scrim" aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[var(--space-7)] bg-[var(--scrim-overlay)]" />
        <img src={src} alt="Embedded image, full size" className="mx-auto block max-h-[90dvh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  </>;
}
