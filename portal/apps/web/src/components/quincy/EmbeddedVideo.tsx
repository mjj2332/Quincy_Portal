import { useState } from "react";
import { FilmIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "../../lib/embedded-media-core";
import { buttonVariants } from "../reui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../reui/dialog";
import { MEDIA_STAGE, MediaStageClose, embeddedTile, type EmbeddedMediaSize, type EmbeddedTileSize } from "./EmbeddedImage";

type MediaUrls = { mediaUrl?: (mediaId: string) => string; posterUrl?: (mediaId: string) => string };

/**
 * A posted embedded video (#494): the browser's own player with its controls (keyboard-operable, with fullscreen and
 * picture-in-picture), fed from the auth-gated `/media/embedded/:id` route, which answers byte ranges so it can seek. It preloads
 * only metadata and shows the poster frame the uploader's browser captured. Nothing is transcoded, so whether a file plays depends
 * on the viewer's browser: the decision is made here, per viewer, from the element's own `error` event, and a file that cannot play
 * (ProRes, say) offers itself as a download instead of a dead player. Neither ReUI nor base-nova has a media-playback component.
 */
/** `hasPoster` is the server's answer (#556): `false` leaves `poster` off so a posterless video never requests `/poster`; absent (an older node, the whiteboard dialog) asks for it as before. */
/** `mediaUrl` and `posterUrl` (#835) are where the bytes and the poster are read from: the staff routes by default, a Review link's own for a guest. */
/** `size="thumb"` (#927 T1) is a posted note's strip tile, which opens this same player in a dialog. The default is the inline player, unchanged. */
/** `size="chip"` (#927 T2) is the same tile at 32px, inside a draft note's chip, with a smaller play badge. */
/**
 * `size="stage"` (#927 review) is the player on a dialog's stage (this file's tile dialog, `EmbeddedVideoDialog`): no margin, the full
 * width, as tall as the dialog allows and no frame. Adaptation note: it is a modifier class beside the inline player's in `app.css`
 * (`.rich-text__embedded-video--stage`), since that stylesheet is unlayered and a utility cannot override it without `!`; the inline
 * player and its unavailable panel render exactly as before.
 */
export function EmbeddedVideo({ mediaId, hasPoster, className, videoClassName, mediaUrl = embeddedMediaUrl, posterUrl = embeddedMediaPosterUrl, size = "default" }: { mediaId: string; hasPoster?: boolean; className?: string; videoClassName?: string; size?: EmbeddedMediaSize | "stage" } & MediaUrls) {
  const [failed, setFailed] = useState(false);
  if (size === "thumb" || size === "chip") return <EmbeddedVideoThumb mediaId={mediaId} hasPoster={hasPoster} mediaUrl={mediaUrl} posterUrl={posterUrl} size={size} />;
  const stage = size === "stage";
  const src = mediaUrl(mediaId);
  // A posterless video shows no frame until it plays; `#t=0.1` asks the browser for one. Only the player gets it: the download href stays on the bare `src`.
  const playSrc = hasPoster === false ? `${src}#t=0.1` : src;
  return <div data-testid="embedded-video" className={cn(stage ? "w-full" : "my-[var(--space-2)]", className)}>
    {failed
      ? <div data-testid="embedded-video-unavailable" className={cn("rich-text__embedded-video rich-text__embedded-video--unavailable", stage && "rich-text__embedded-video--stage", videoClassName)}>
        <p className="m-0 text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">This video can't play in this browser.</p>
        <a data-slot="button" href={`${src}?download=1`} download className={cn(buttonVariants({ variant: "outline", size: "default" }))}>Download video</a>
      </div>
      : <video controls preload="metadata" playsInline poster={hasPoster === false ? undefined : posterUrl(mediaId)} src={playSrc} aria-label="Embedded video" onError={() => setFailed(true)} className={cn("rich-text__embedded-video", stage && "rich-text__embedded-video--stage", videoClassName)} />}
  </div>;
}

/**
 * The strip tile (#927 T1): the poster frame under a play badge, and no player until one is asked for, so a note with several videos
 * loads no video bytes. A posterless video, or a poster that fails, is the plain tile with a film glyph.
 *
 * Adaptation note: the player inside the dialog is this component's default, the same `EmbeddedVideo` a posted note played inline
 * before #927 (through `RichTextContent`), fed the same `mediaUrl` / `posterUrl`: the staff routes for staff, the Review link's own routes
 * for a guest. Only the dialog shell is new. The one shared video dialog, `EmbeddedVideoDialog` (the whiteboard's), takes no media URLs
 * and so always plays from the staff routes, which a guest cannot read; `delivery/FilmPlayerDialog` is the Delivery page's film player.
 * The shell shares `MEDIA_STAGE` (inverse, the player edge to edge) with `EmbeddedVideoDialog` and `EmbeddedImage`, and `EmbeddedImage`'s
 * 48px close chip (`MediaStageClose`, #553). The trigger is registered with the dialog, so Escape or Close returns focus to the tile.
 */
function EmbeddedVideoThumb({ mediaId, hasPoster, mediaUrl, posterUrl, size }: { mediaId: string; hasPoster?: boolean; mediaUrl: (mediaId: string) => string; posterUrl: (mediaId: string) => string; size: EmbeddedTileSize }) {
  const chip = size === "chip";
  const [open, setOpen] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const showPoster = hasPoster !== false && !posterFailed;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<button type="button" data-testid="embedded-video-thumb" data-size={size} aria-label="Play video" className={cn(embeddedTile(size), "relative grid cursor-pointer place-items-center p-0 text-foreground-secondary transition-colors hover:border-[color:var(--border-hover)] focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2")} />}>
      {showPoster
        ? <img src={posterUrl(mediaId)} alt="" loading="lazy" decoding="async" onError={() => setPosterFailed(true)} className="col-start-1 row-start-1 block size-full object-cover" />
        : <FilmIcon aria-hidden="true" className={cn("col-start-1 row-start-1", chip ? "size-3.5" : "size-4")} />}
      {showPoster && <span aria-hidden="true" className={cn("col-start-1 row-start-1 grid place-items-center rounded-full bg-[var(--scrim-badge)] text-invert-foreground", chip ? "size-[var(--space-4)]" : "size-[var(--space-5)]")}><PlayIcon className={chip ? "size-2.5" : "size-3"} /></span>}
    </DialogTrigger>
    <DialogContent data-surface="inverse" data-testid="embedded-video-dialog" showCloseButton={false} className={MEDIA_STAGE}>
      <DialogTitle className="sr-only">Video</DialogTitle>
      <DialogDescription className="sr-only">The video as posted.</DialogDescription>
      <div className="grid place-items-center"><EmbeddedVideo mediaId={mediaId} hasPoster={hasPoster} mediaUrl={mediaUrl} posterUrl={posterUrl} size="stage" /></div>
      <MediaStageClose testId="embedded-video-close" />
    </DialogContent>
  </Dialog>;
}
