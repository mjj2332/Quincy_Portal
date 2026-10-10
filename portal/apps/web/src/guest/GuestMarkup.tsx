import { useEffect, useState, type ReactNode } from "react";
import type { Box, GuestNoteThreadDto, MarkupItem } from "@quincy/shared";
import { readStoredMarkup } from "../lib/read-stored-markup";
import { useFrameClockSelector, type VideoFrameClock } from "../lib/video-frame-clock";
import { MarkupLayer, StrokeVisible } from "../components/quincy/freehand-strokes";
import type { GuestApi } from "./guest-api";

/**
 * The selected note's drawing on the guest page (#741 12b), read-only. The staff overlay (`useVideoMarkup`) is a drawing tool bound to the staff form store and `lib/api`, so this is
 * its read half only: the tolerant `readStoredMarkup` reader and the shared stroke renderer, on the same picture box, shown only while the film is paused on the frame it was drawn on.
 * Items this build cannot render are skipped (never guessed at). A markup read the server answers with the stub calls `onGone`; the caller decides whether that is the link or only the note.
 */
export function useGuestMarkup(api: GuestApi, clock: VideoFrameClock | null, thread: GuestNoteThreadDto | null, onGone: () => void, selectionCount: number): (box: Box | null) => ReactNode {
  const wanted = thread !== null && !thread.deleted && thread.hasMarkup && thread.drawingFrame !== null ? thread : null;
  const [loaded, setLoaded] = useState<{ noteId: string; revision: number; items: MarkupItem[] } | null>(null);
  useEffect(() => {
    if (wanted === null) return;
    let live = true;
    void api.markup(wanted.id).then((response) => {
      if (!live) return;
      // The stub: the link may be revoked or just this note deleted, so the caller rechecks access (and drops the note) rather than leaving. A transient failure draws nothing; selecting the note again retries.
      if (response.kind === "gone") { setLoaded(null); onGone(); }
      else if (response.kind === "ok") setLoaded(response.value.markup ? { noteId: wanted.id, revision: wanted.revision, items: readStoredMarkup(response.value.markup).items } : null); // null: the drawing was removed, so the old strokes go
    });
    return () => { live = false; };
  }, [api, wanted?.id, wanted?.revision, onGone, selectionCount]); // revision: a saved edit (a redraw) changes the drawing under the same id; selectionCount: selecting the same note again retries a failed read // eslint-disable-line react-hooks/exhaustive-deps
  const playing = useFrameClockSelector(clock, (state) => state.playing, false);
  const frame = useFrameClockSelector(clock, (state) => (state.targetFrame === null ? state.frame : -1), -1);
  const items = wanted !== null && loaded?.noteId === wanted.id && loaded.revision === wanted.revision && !playing && frame === wanted.drawingFrame ? loaded.items : null;
  return (box) => {
    if (box === null || items === null) return null;
    return <div data-testid="guest-markup" className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <MarkupLayer aria-hidden="true" viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-hidden" style={{ pointerEvents: "none" }}>
        {items.map((item, index) => <StrokeVisible key={index} stroke={item} opacity={1} testId="guest-markup-stroke" pixelDots />)}
      </MarkupLayer>
    </div>;
  };
}
