import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Box } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { usePictureBox } from "../../lib/use-picture-box";
import { Notice } from "./Notice";

const MONO = "[font:var(--type-mono)] tabular-nums";
// What the timecode chip needs to show its frame part: mono glyph advance plus padding, border and the offset from the picture's edge.
const CHIP_GLYPH_PX = 9;
const CHIP_CHROME_PX = 40;

/**
 * The picture half of the review player (#741 7a, extracted from `VideoPlayer` so Compare can draw one per side): the stage, the
 * `<video>` (no native controls, no download, no picture-in-picture), the picture box with the timecode chip inside it, and the
 * "can't play" Notice. `onVideo` hands up the element (and null when it goes away); `overlay` is drawn over the stage, and as a function
 * it is handed the picture box (the box the picture really occupies, null until measured) so markup can be mapped onto the picture and not
 * the letterbox bands (#741 6b-ui). Key it by Version like the player: a new Version is a new element.
 */
export function VideoStage({ streamUrl, title, width, height, timecode, frame, frameSuffix = true, onVideo, overlay, watermark, onMediaError, social }: {
  streamUrl: string;
  title: string;
  /** The stored size: the stage's shape on a phone, and the picture box's stand-in until the decoded size is known. */
  width: number;
  height: number;
  /** The timecode label of `frame`, for the chip. */
  timecode: string;
  /** The frame on screen, appended to the chip where the picture is wide enough. */
  frame: number;
  /** False when `timecode` already is the frame number (the Frames format): the chip then reads `frame N`, not `N · frame N`. */
  frameSuffix?: boolean;
  onVideo?: (video: HTMLVideoElement | null) => void;
  overlay?: ReactNode | ((box: Box | null) => ReactNode);
  /** Drawn over the picture, never dropped by Social (#872): the premium watermark is a deterrent, so a locked film is marked in the 9:16 frame too. Handed the box the picture occupies in the frame (the whole frame in Fill, the contained picture in Fit). */
  watermark?: (box: Box) => ReactNode;
  /** The element reported a media error (after the stage has shown its own notice). The guest page rechecks access here: a revoked link fails a range request the same way a bad file does. */
  onMediaError?: () => void;
  /**
   * Social preview (#871): the film in a centred 9:16 frame (Fill crops to it, Fit letterboxes inside it) with the overlay picture over the whole frame.
   * The stage takes the 9:16 shape on a phone, where the film's own 16:9 would leave the frame about 120px wide; the timecode chip and `overlay` are not drawn.
   * The same `<video>` element throughout: it moves into the frame by CSS only, never remounts.
   */
  social?: { fit: "fill" | "fit"; imageUrl: string | null; onImageError?: () => void; onImageLoad?: () => void };
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const box = usePictureBox(video, { width, height }, social?.fit === "fill" ? "cover" : "contain");
  const onMediaErrorRef = useRef(onMediaError);
  onMediaErrorRef.current = onMediaError;
  const onVideoRef = useRef(onVideo);
  onVideoRef.current = onVideo;
  const attach = useCallback((element: HTMLVideoElement | null) => { setVideo(element); onVideoRef.current?.(element); }, []);

  const chipFull = frameSuffix ? `${timecode} · frame ${frame}` : `frame ${frame}`;
  const chip = box && box.width >= chipFull.length * CHIP_GLYPH_PX + CHIP_CHROME_PX ? chipFull : timecode;

  const framed = social !== undefined;
  const videoElement = <video
      ref={attach}
      src={streamUrl}
      aria-label={title}
      preload="auto"
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      controlsList="nodownload noremoteplayback"
      onContextMenu={(event) => { event.preventDefault(); }}
      onError={() => { setFailed(true); onMediaErrorRef.current?.(); }}
      className={cn("absolute inset-0 h-full w-full", framed && social.fit === "fill" ? "object-cover" : "object-contain")}
    />;

  return <div
    data-testid="video-stage"
    {...(framed ? { "data-social": social.fit } : {})}
    style={{ "--stage-ratio": framed ? "9/16" : `${width}/${height}` } as React.CSSProperties}
    className={cn("relative min-h-0 w-full flex-1 overflow-hidden bg-invert text-invert-foreground max-[721px]:mx-auto max-[721px]:max-h-[55dvh] max-[721px]:flex-none max-[721px]:[aspect-ratio:var(--stage-ratio)]", framed && "flex [container-type:size]")}
  >
    {/* One wrapper in both modes, so toggling Social never reparents (and so never remounts) the `<video>`. */}
    <div data-testid="video-social-frame" className={framed ? "relative m-auto aspect-[9/16] w-[min(100cqw,calc(100cqh*9/16))] overflow-hidden" : "absolute inset-0"}>
      {videoElement}
      {framed && box && watermark?.(box)}
      {framed && social.imageUrl && <img data-testid="video-social-overlay" src={social.imageUrl} alt="" aria-hidden="true" draggable={false} onError={social.onImageError} onLoad={social.onImageLoad} className="pointer-events-none absolute inset-0 size-full select-none object-fill" />}
    </div>
    {!framed && box && <div data-testid="video-picture-box" className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <span data-testid="video-timecode-chip" aria-hidden="true" className={cn("absolute bottom-[var(--space-2)] left-[var(--space-2)] max-w-[calc(100%-var(--space-4))] overflow-hidden whitespace-nowrap border border-invert-foreground/20 bg-invert px-[var(--space-2)] py-[var(--space-1)] text-invert-foreground", MONO)}>{chip}</span>
    </div>}
    {!framed && box && watermark?.(box)}
    {failed && <div className="absolute inset-x-[var(--space-3)] top-[var(--space-3)]"><Notice tone="caution" role="alert" className="bg-card">This version can't play in this browser.</Notice></div>}
    {!framed && (typeof overlay === "function" ? overlay(box) : overlay)}
  </div>;
}
