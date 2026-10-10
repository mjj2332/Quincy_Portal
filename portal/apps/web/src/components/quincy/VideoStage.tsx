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
export function VideoStage({ streamUrl, title, width, height, timecode, frame, onVideo, overlay }: {
  streamUrl: string;
  title: string;
  /** The stored size: the stage's shape on a phone, and the picture box's stand-in until the decoded size is known. */
  width: number;
  height: number;
  /** The timecode label of `frame`, for the chip. */
  timecode: string;
  /** The frame on screen, appended to the chip where the picture is wide enough. */
  frame: number;
  onVideo?: (video: HTMLVideoElement | null) => void;
  overlay?: ReactNode | ((box: Box | null) => ReactNode);
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  const box = usePictureBox(video, { width, height });
  const onVideoRef = useRef(onVideo);
  onVideoRef.current = onVideo;
  const attach = useCallback((element: HTMLVideoElement | null) => { setVideo(element); onVideoRef.current?.(element); }, []);

  const chipFull = `${timecode} · frame ${frame}`;
  const chip = box && box.width >= chipFull.length * CHIP_GLYPH_PX + CHIP_CHROME_PX ? chipFull : timecode;

  return <div
    data-testid="video-stage"
    style={{ "--stage-ratio": `${width}/${height}` } as React.CSSProperties}
    className="relative min-h-0 w-full flex-1 overflow-hidden bg-invert text-invert-foreground max-[721px]:mx-auto max-[721px]:max-h-[55dvh] max-[721px]:flex-none max-[721px]:[aspect-ratio:var(--stage-ratio)]"
  >
    <video
      ref={attach}
      src={streamUrl}
      aria-label={title}
      preload="auto"
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      controlsList="nodownload noremoteplayback"
      onContextMenu={(event) => { event.preventDefault(); }}
      onError={() => { setFailed(true); }}
      className="absolute inset-0 h-full w-full object-contain"
    />
    {box && <div data-testid="video-picture-box" className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <span data-testid="video-timecode-chip" aria-hidden="true" className={cn("absolute bottom-[var(--space-2)] left-[var(--space-2)] max-w-[calc(100%-var(--space-4))] overflow-hidden whitespace-nowrap border border-invert-foreground/20 bg-invert px-[var(--space-2)] py-[var(--space-1)] text-invert-foreground", MONO)}>{chip}</span>
    </div>}
    {failed && <div data-surface="default" className="absolute inset-x-[var(--space-3)] top-[var(--space-3)]"><Notice tone="caution" role="alert" className="bg-card">This version can't play in this browser.</Notice></div>}
    {typeof overlay === "function" ? overlay(box) : overlay}
  </div>;
}
