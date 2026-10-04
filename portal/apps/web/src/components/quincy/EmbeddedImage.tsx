import { useState } from "react";
import { embeddedMediaUrl } from "../../lib/embedded-media";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../reui/dialog";

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
    <button type="button" data-testid="embedded-image" aria-label="View image larger" onClick={() => setOpen(true)} className="block max-w-full cursor-zoom-in rounded-[var(--radius-xs)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2">
      <img src={src} alt="Embedded image" loading="lazy" decoding="async" onError={() => setFailed(true)} className="rich-text__embedded-image" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[min(90vw,64rem)] max-h-[90dvh] overflow-auto" data-testid="embedded-image-dialog">
        <DialogTitle className="sr-only">Image</DialogTitle>
        <DialogDescription className="sr-only">The image as posted in the discussion.</DialogDescription>
        <img src={src} alt="Embedded image, full size" className="mx-auto block max-h-[80dvh] max-w-full object-contain" />
      </DialogContent>
    </Dialog>
  </>;
}
