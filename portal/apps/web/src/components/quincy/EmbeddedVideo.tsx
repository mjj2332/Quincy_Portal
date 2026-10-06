import { useState } from "react";
import { cn } from "@/lib/utils";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "../../lib/embedded-media";
import { buttonVariants } from "../reui/button";

/**
 * A posted embedded video (#494): the browser's own player with its controls (keyboard-operable, with fullscreen and
 * picture-in-picture), fed from the auth-gated `/media/embedded/:id` route, which answers byte ranges so it can seek. It preloads
 * only metadata and shows the poster frame the uploader's browser captured. Nothing is transcoded, so whether a file plays depends
 * on the viewer's browser: the decision is made here, per viewer, from the element's own `error` event, and a file that cannot play
 * (ProRes, say) offers itself as a download instead of a dead player. Neither ReUI nor base-nova has a media-playback component.
 */
/** `hasPoster` is the server's answer (#556): `false` leaves `poster` off so a posterless video never requests `/poster`; absent (an older node, the whiteboard dialog) asks for it as before. */
export function EmbeddedVideo({ mediaId, hasPoster, className, videoClassName }: { mediaId: string; hasPoster?: boolean; className?: string; videoClassName?: string }) {
  const [failed, setFailed] = useState(false);
  const src = embeddedMediaUrl(mediaId);
  if (failed) return <div data-testid="embedded-video-unavailable" className="my-[var(--space-2)] grid justify-items-start gap-[var(--space-2)] rounded-[var(--radius-xs)] border-[length:var(--border-width-hair)] border-solid border-border bg-surface-sunken p-[var(--space-3)]">
    <p className="m-0 text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">This video can't play in this browser.</p>
    <a data-slot="button" href={`${src}?download=1`} download className={buttonVariants({ variant: "outline", size: "default" })}>Download video</a>
  </div>;
  return <div data-testid="embedded-video" className={cn("my-[var(--space-2)]", className)}>
    <video controls preload="metadata" playsInline poster={hasPoster === false ? undefined : embeddedMediaPosterUrl(mediaId)} src={src} aria-label="Embedded video" onError={() => setFailed(true)} className={cn("rich-text__embedded-video", videoClassName)} />
  </div>;
}
