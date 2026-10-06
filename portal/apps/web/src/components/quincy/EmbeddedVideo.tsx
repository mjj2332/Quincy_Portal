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
  // A posterless video shows no frame until it plays; `#t=0.1` asks the browser for one. Only the player gets it: the download href stays on the bare `src`.
  const playSrc = hasPoster === false ? `${src}#t=0.1` : src;
  return <div data-testid="embedded-video" className={cn("my-[var(--space-2)]", className)}>
    {failed
      ? <div data-testid="embedded-video-unavailable" className={cn("rich-text__embedded-video rich-text__embedded-video--unavailable", videoClassName)}>
        <p className="m-0 text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">This video can't play in this browser.</p>
        <a data-slot="button" href={`${src}?download=1`} download className={cn(buttonVariants({ variant: "outline", size: "default" }))}>Download video</a>
      </div>
      : <video controls preload="metadata" playsInline poster={hasPoster === false ? undefined : embeddedMediaPosterUrl(mediaId)} src={playSrc} aria-label="Embedded video" onError={() => setFailed(true)} className={cn("rich-text__embedded-video", videoClassName)} />}
  </div>;
}
