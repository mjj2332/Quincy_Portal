import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { clampMark, type NoteMarks } from "../../lib/video-note-marks";
import { clusterMarkers, clusterWidthPx, frameAtX, frameFraction, markerHitTargets, nearestMarkerId, spanFractions } from "../../lib/video-timeline-geometry";

/** One note on the timeline. Data, not a note DTO: the guest page (12b) and Compare (7) draw the same lane from their own notes. */
export type TimelineMarker = { id: string; startFrame: number; endFrame: number | null; tone: "public" | "internal"; selected: boolean; /** Breaks ties between markers on one frame: the oldest note wins. */ createdAt?: string };

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
 * It is a plain `div` with a pointer handler, not buttons. Markers that would overlap at the measured lane width merge into one cluster marker
 * showing a count (recomputed as the lane resizes); a press on it picks its earliest note. The notes list is still the way to every note.
 */
export function VideoTimelineMarkers({ markers, frameCount, onSelect, className }: {
  markers: readonly TimelineMarker[];
  frameCount: number;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  // The lane's measured width (and the thumb half it is laid out with): clustering depends on how many pixels a frame gets.
  const [measure, setMeasure] = useState({ width: 0, half: 6 });
  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const read = (width: number) => {
      const half = Number.parseFloat(getComputedStyle(lane).getPropertyValue("--thumb-half")) || 6;
      setMeasure((held) => (held.width === width && held.half === half ? held : { width, half }));
    };
    read(lane.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => { read(entries[0]?.contentRect.width ?? lane.getBoundingClientRect().width); });
    observer.observe(lane);
    return () => { observer.disconnect(); };
  }, []);
  const clusters = useMemo(() => clusterMarkers(markers, frameCount, measure.width, measure.half), [markers, frameCount, measure]);

  return <div
    ref={laneRef}
    data-testid="video-marker-lane"
    aria-hidden="true"
    onPointerDown={onSelect ? (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const half = Number.parseFloat(getComputedStyle(event.currentTarget).getPropertyValue("--thumb-half")) || 6;
      const id = nearestMarkerId(markerHitTargets(clusters), frameCount, event.clientX - rect.left, rect.width, half);
      if (id) onSelect(id);
    } : undefined}
    className={cn("relative h-3 w-full", THUMB_HALF, onSelect && "cursor-pointer", "pointer-coarse:pointer-events-none max-[721px]:pointer-events-none", className)}
  >
    {clusters.map((cluster) => {
      const marker = cluster.first;
      if (cluster.members.length > 1) {
        const f = frameFraction(marker.startFrame, frameCount);
        const tones = new Set(cluster.members.map((member) => member.tone));
        return <span
          key={cluster.id}
          data-marker-id={marker.id}
          data-cluster-count={cluster.members.length}
          data-tone={tones.size === 1 ? marker.tone : "mixed"}
          data-has-internal={tones.has("internal") ? "true" : "false"}
          data-selected={cluster.members.some((member) => member.selected) ? "true" : "false"}
          style={{ ...fractionStyle(f, f), width: clusterWidthPx(cluster.members) }}
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2", LEFT,
            "inline-flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full bg-foreground px-1 text-background font-mono tabular-nums text-[length:var(--text-xs)] leading-none",
            // A cluster holding an internal note carries the internal treatment: an amber edge and a diamond, never colour alone.
            "data-[has-internal=true]:border data-[has-internal=true]:border-[var(--signal-caution-on-inverse)]",
            "data-[selected=true]:outline data-[selected=true]:outline-2 data-[selected=true]:outline-offset-1 data-[selected=true]:outline-foreground",
          )}
        >{tones.has("internal") && <span aria-hidden="true" data-cluster-diamond="" className="size-1.5 shrink-0 rotate-45 rounded-[1px] bg-[var(--signal-caution-on-inverse)]" />}{cluster.members.length}</span>;
      }
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


type HandleKind = "in" | "out";

/**
 * The In / Out handles over the scrubber (#861). Hand-built, not a second Base UI Slider: the playhead cannot share a sorted thumb set with
 * them, and an overlaid root would steal presses on the open track. The wrapper takes no pointer, only the handles do, so a press anywhere else
 * still seeks. Each handle sits at the frame it marks (Out is the LAST included frame, where the pending band ends). In's hit box lies to the left
 * of its frame and Out's to the right, so a one-frame range keeps both reachable. A handle moves only its own end and stops at the other (`clampMark`);
 * a drag follows the primary pointer alone and ends on release, cancel, capture loss, locking or unmounting (a Version switch remounts the player).
 * Touch: inert, the range button is the path (no 44px target fits on the track).
 */
export function VideoRangeHandles({ marks, frameCount, label, largeStep, interactive, onMove, onGrab, className }: {
  marks: NoteMarks;
  frameCount: number;
  /** The frame as text in the person's chosen time format. */
  label: (frame: number) => string;
  largeStep: number;
  interactive: boolean;
  /** A handle landed on a frame (already clamped against the other end). */
  onMove: (kind: HandleKind, frame: number) => void;
  /** A gesture starts (pointer down or the first key): the host pauses so the playhead can follow. */
  onGrab: () => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastFrame = Math.max(0, frameCount - 1);
  const latest = useRef({ marks, interactive, onMove, frameCount, lastFrame });
  latest.current = { marks, interactive, onMove, frameCount, lastFrame };
  const drag = useRef<{ kind: HandleKind; pointerId: number; offset: number; end: () => void } | null>(null);

  const endDrag = () => { drag.current?.end(); drag.current = null; };
  useEffect(() => { if (!interactive) endDrag(); }, [interactive]);
  useEffect(() => endDrag, []);

  const geometry = () => {
    const wrap = wrapRef.current!;
    const rect = wrap.getBoundingClientRect();
    const half = Number.parseFloat(getComputedStyle(wrap).getPropertyValue("--thumb-half")) || 6;
    return { rect, half };
  };

  const onPointerDown = (kind: HandleKind) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = latest.current;
    if (!now.interactive || drag.current !== null || event.button !== 0 || event.isPrimary === false) return;
    const { rect, half } = geometry();
    const held = now.marks[kind];
    if (held === null) return;
    const pointerId = event.pointerId ?? 1;
    // Where inside the handle the press landed, so a press never jumps it.
    const offset = event.clientX - rect.left - (half + (rect.width - 2 * half) * frameFraction(held, now.frameCount));
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    try { target.setPointerCapture?.(pointerId); } catch { /* a pointer that is already gone */ }
    onGrab();
    const move = (moved: PointerEvent) => {
      if ((moved.pointerId ?? 1) !== pointerId || moved.isPrimary === false) return;
      const live = latest.current;
      if (!live.interactive) { endDrag(); return; }
      const box = geometry();
      const frame = clampMark(live.marks, kind, frameAtX(moved.clientX - box.rect.left - offset, box.rect.width, box.half, live.frameCount), live.lastFrame);
      if (frame !== live.marks[kind]) live.onMove(kind, frame);
    };
    const finish = (ended: PointerEvent) => { if ((ended.pointerId ?? 1) === pointerId) endDrag(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    target.addEventListener("lostpointercapture", finish);
    drag.current = {
      kind, pointerId, offset,
      end: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        target.removeEventListener("lostpointercapture", finish);
        try { target.releasePointerCapture?.(pointerId); } catch { /* already released */ }
      },
    };
  };

  const onKeyDown = (kind: HandleKind) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const now = latest.current;
    if (!now.interactive || event.ctrlKey || event.metaKey || event.altKey) return;
    const held = now.marks[kind];
    if (held === null) return;
    const big = event.shiftKey;
    let target: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") target = held + (big ? largeStep : 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = held - (big ? largeStep : 1);
    else if (event.key === "PageUp") target = held + largeStep;
    else if (event.key === "PageDown") target = held - largeStep;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = now.lastFrame;
    if (target === null) return;
    event.preventDefault();
    const frame = clampMark(now.marks, kind, target, now.lastFrame);
    if (frame === held) return;
    onGrab();
    now.onMove(kind, frame);
  };

  const bounds = (kind: HandleKind): [number, number] => (kind === "in" ? [0, marks.out ?? lastFrame] : [marks.in ?? 0, lastFrame]);
  const render = (kind: HandleKind) => {
    const frame = marks[kind];
    if (frame === null) return null;
    const [min, max] = bounds(kind);
    const f = frameFraction(frame, frameCount);
    return <div
      key={kind}
      role="slider"
      tabIndex={0}
      aria-label={kind === "in" ? "In point" : "Out point"}
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={frame}
      aria-valuetext={label(frame)}
      aria-disabled={interactive ? undefined : true}
      data-testid={`video-range-${kind}`}
      data-kind={kind}
      onPointerDown={onPointerDown(kind)}
      onKeyDown={onKeyDown(kind)}
      style={fractionStyle(f, f)}
      className={cn(
        "absolute inset-y-0 w-3 touch-none outline-none",
        LEFT,
        // In's box lies left of its frame and Out's right of it, so a one-frame range keeps both reachable.
        kind === "in" ? "-translate-x-full border-r-2 border-solid border-foreground" : "border-l-2 border-solid border-foreground",
        interactive ? "pointer-events-auto cursor-ew-resize" : "pointer-events-none",
        "pointer-coarse:pointer-events-none max-[721px]:pointer-events-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
      )}
    />;
  };

  return <div ref={wrapRef} data-testid="video-range-handles" className={cn("pointer-events-none absolute inset-0", THUMB_HALF, className)}>
    {render("in")}
    {render("out")}
  </div>;
}
