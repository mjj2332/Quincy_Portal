import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { frameFraction, nearestMarkerId, spanFractions } from "../../lib/video-timeline-geometry";

/** One note on the timeline. Data, not a note DTO: the guest page (12b) and Compare (7) draw the same lane from their own notes. */
export type TimelineMarker = { id: string; startFrame: number; endFrame: number | null; tone: "public" | "internal"; selected: boolean };

/**
 * Where a fraction lands on the scrubber (#741 5b). With `thumbAlignment="edge"` the slider thumb's centre is
 * `thumbWidth / 2 + (controlWidth - thumbWidth) * fraction` (Base UI 1.7.0 `SliderThumb`), so a marker uses the same formula on a box
 * the Control's width. The thumb is `size-3` (half 6px) and `pointer-coarse:size-4` (half 8px); it does not grow at <=721px on a fine pointer.
 */
const THUMB_HALF = "[--thumb-half:6px] pointer-coarse:[--thumb-half:8px]";
const LEFT = "left-[calc(var(--thumb-half)+(100%-2*var(--thumb-half))*var(--f))]";
const SPAN = "w-[max(2px,calc((var(--f2)-var(--f))*(100%-2*var(--thumb-half))))]";
const AMBER = "var(--signal-caution-on-inverse)";

const fractionStyle = (from: number, to: number) => ({ "--f": from, "--f2": to }) as CSSProperties;

/**
 * The marker lane under the scrubber's track (#741 5b), drawn on the inverse stage. Public is a paper dot, internal an amber
 * diamond (shape and colour both differ, never colour alone); a range is a bar from its start to its last included frame. The lane is
 * `aria-hidden` (the note list is the accessible path), has no tooltips, and is inert on touch: a 12px target fails the 44px rule.
 * It is a plain `div` with a pointer handler, not buttons.
 */
export function VideoTimelineMarkers({ markers, frameCount, onSelect, className }: {
  markers: readonly TimelineMarker[];
  frameCount: number;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  return <div
    data-testid="video-marker-lane"
    aria-hidden="true"
    onPointerDown={onSelect ? (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const half = Number.parseFloat(getComputedStyle(event.currentTarget).getPropertyValue("--thumb-half")) || 6;
      const id = nearestMarkerId(markers, frameCount, event.clientX - rect.left, rect.width, half);
      if (id) onSelect(id);
    } : undefined}
    className={cn("relative h-3 w-full", THUMB_HALF, onSelect && "cursor-pointer", "pointer-coarse:pointer-events-none max-[721px]:pointer-events-none", className)}
  >
    {markers.map((marker) => {
      const range = marker.endFrame !== null;
      const [from, to] = range ? spanFractions(marker.startFrame, marker.endFrame!, frameCount) : [frameFraction(marker.startFrame, frameCount), frameFraction(marker.startFrame, frameCount)];
      const internal = marker.tone === "internal";
      return <span
        key={marker.id}
        data-marker-id={marker.id}
        data-tone={marker.tone}
        data-shape={range ? "bar" : internal ? "diamond" : "dot"}
        data-selected={marker.selected ? "true" : "false"}
        style={{ ...fractionStyle(from, to), ...(internal ? { "--mark": AMBER } : { "--mark": "var(--foreground)" }) } as CSSProperties}
        className={cn(
          "absolute top-1/2 -translate-y-1/2",
          LEFT,
          range ? cn("h-1.5 rounded-[1px] border border-[var(--mark)]", SPAN, internal ? "bg-[var(--mark)]/30" : "bg-transparent")
            : cn("-translate-x-1/2 size-2 bg-[var(--mark)] data-[selected=true]:size-3", internal ? "rotate-45 rounded-[2px]" : "rounded-full"),
          "data-[selected=true]:outline data-[selected=true]:outline-2 data-[selected=true]:outline-offset-1 data-[selected=true]:outline-foreground",
        )}
      />;
    })}
  </div>;
}

/**
 * The composer's in / out marks, drawn as a band over the scrubber track. Render it BEFORE the Slider in the DOM so the slider's
 * `relative` Control paints over it and the thumb stays on top; it never takes the pointer. A single mark is a one-frame band.
 */
export function VideoPendingRangeBand({ range, frameCount }: { range: { startFrame: number; endFrame: number | null } | null; frameCount: number }) {
  if (!range) return null;
  const [from, to] = spanFractions(range.startFrame, range.endFrame ?? range.startFrame + 1, frameCount);
  return <div
    data-testid="video-pending-band"
    aria-hidden="true"
    style={fractionStyle(from, to)}
    className={cn("pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 bg-foreground/30", THUMB_HALF, LEFT, SPAN)}
  />;
}
