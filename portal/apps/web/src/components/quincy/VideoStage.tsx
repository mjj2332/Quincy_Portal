import { useCallback, useRef, useState, type ReactNode } from "react";
import type { SocialStageProps } from "./SocialPreviewControls";
import type { Box } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { usePictureBox } from "../../lib/use-picture-box";
import { useMediaQuery } from "../../lib/use-media-query";
import { PHONE_QUERY } from "../../lib/review-pane-geometry";
import { Notice } from "./Notice";

const MONO = "[font:var(--type-mono)] tabular-nums";
const CHIP_MIN_PICTURE_PX = 140;
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
export function VideoStage({ streamUrl, title, width, height, timecode, frame, frameSuffix = true, onVideo, overlay, watermark, onMediaError, social, frameStyle, badge, chip: chipWanted = true }: {
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
  /** Drawn over the picture box and kept by Social (#872): the premium watermark is a deterrent, so a locked film is marked in the 9:16 frame too. Handed the box the picture occupies in its frame (the contained picture). */
  watermark?: (box: Box) => ReactNode;
  /** The element reported a media error (after the stage has shown its own notice). The guest page rechecks access here: a revoked link fails a range request the same way a bad file does. */
  onMediaError?: () => void;
  /**
   * Social preview (#871, #877): the film in a centred 9:16 frame, always fitted (the whole picture letterboxed inside it) with the overlay picture over the whole frame.
   * The stage takes the 9:16 shape on a phone, where the film's own 16:9 would leave the frame about 120px wide. The timecode chip is not drawn; `overlay` (markup, Compare's labels) and
   * `watermark` are, inside the frame and above the artwork, in the coordinates of the letterboxed picture, so a stroke lands on the same point of the film with Social on or off.
   * The same `<video>` element throughout: it moves into the frame by CSS only, never remounts.
   */
  social?: SocialStageProps;
  /**
   * Compare's Wipe with Social on: a style on the frame itself (a clip), not on the stage, so the wipe lands on the artwork's own percentages whatever the stage measures. With it the stage is
   * transparent and the frame carries the background, so the clipped side shows the other side through the part it does not cover. Ignored unless `social` is set.
   */
  frameStyle?: React.CSSProperties;
  /** Centred over the whole stage, above the picture and the overlay (#879 PR 3a: the phone player's play badge). Not drawn while the film cannot play. */
  badge?: ReactNode;
  /** False leaves the timecode chip out: Full screen draws none (F1, F2), where the dock lies over the picture's bottom edge and shows the time itself (#880). */
  chip?: boolean;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const box = usePictureBox(video, { width, height });
  const onMediaErrorRef = useRef(onMediaError);
  onMediaErrorRef.current = onMediaError;
  const onVideoRef = useRef(onVideo);
  onVideoRef.current = onVideo;
  const attach = useCallback((element: HTMLVideoElement | null) => { setVideo(element); onVideoRef.current?.(element); }, []);

  /** A picture this short is mostly covered by its own chip: the transport already shows the time then. */
  const phone = useMediaQuery(PHONE_QUERY);
  const chipHidden = !chipWanted || (phone && box !== null && box.height < CHIP_MIN_PICTURE_PX);
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
      className="absolute inset-0 h-full w-full object-contain"
    />;

  const clipped = framed && frameStyle !== undefined;
  return <div
    data-testid="video-stage"
    {...(framed ? { "data-social": "fit" } : {})}
    style={{ "--stage-ratio": framed ? "9/16" : `${width}/${height}` } as React.CSSProperties}
    className={cn("relative min-h-0 w-full flex-1 overflow-hidden text-invert-foreground", clipped ? "bg-transparent" : "bg-invert", framed && "flex [container-type:size]")}
  >
    {/* One wrapper in both modes, so toggling Social never reparents (and so never remounts) the `<video>`, the watermark or the overlay. Outside Social it is the stage itself, so every coordinate is unchanged. */}
    <div data-testid="video-social-frame" {...(clipped ? { style: frameStyle } : {})} className={cn(framed ? "relative m-auto aspect-[9/16] w-[min(100cqw,calc(100cqh*9/16))] overflow-hidden" : "absolute inset-0", clipped && "bg-invert")}>
      {videoElement}
      {!framed && box && <div data-testid="video-picture-box" className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        {!chipHidden && <span data-testid="video-timecode-chip" aria-hidden="true" className={cn("absolute bottom-[var(--space-2)] left-[var(--space-2)] max-w-[calc(100%-var(--space-4))] overflow-hidden whitespace-nowrap border border-invert-foreground/20 bg-invert px-[var(--space-2)] py-[var(--space-1)] text-invert-foreground", MONO)}>{chip}</span>}
      </div>}
      {box && watermark?.(box)}
      {framed && social.imageUrl && <img data-testid="video-social-overlay" src={social.imageUrl} alt="" aria-hidden="true" draggable={false} onError={social.onImageError} onLoad={social.onImageLoad} className="pointer-events-none absolute inset-0 size-full select-none object-fill" />}
      {typeof overlay === "function" ? overlay(box) : overlay}
    </div>
    {badge != null && !failed && <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{badge}</div>}
    {failed && <div className="absolute inset-x-[var(--space-3)] top-[var(--space-3)]"><Notice tone="caution" role="alert" className="bg-card">This version can't play in this browser.</Notice></div>}
  </div>;
}
