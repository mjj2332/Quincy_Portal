import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { framesToTimecode, roleHasCapability, type Role, type VideoNoteCreateInput, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto, type VideoVersionDto } from "@quincy/shared";
import type { TimelineMarker } from "../quincy/VideoTimelineMarkers";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { DEFAULT_NOTE_FILTERS, visibleThreads, type NoteFilters } from "../../lib/video-note-view";
import { effectiveMarks, type NoteFormStore } from "../../lib/video-note-form-store";
import { marksToFrames } from "../../lib/video-note-marks";
import {
  commitVideoNotePaste, createVideoNote, deleteVideoNote, previewVideoNotePaste, editVideoNote, replyToVideoNote, setVideoNoteResolution, useVideoNotesQuery, type NoteWriteContext,
} from "../../lib/video-notes-data";
import type { ThreadActions } from "./VideoNoteThread";

/** What belongs to one Version only: it starts empty when the Version on screen changes. (Form state is not here: it lives in the Video tab's form store.) */
type Local = { assetId: string; selectedId: string | null; scroll: { id: string; seq: number } | null };
const fresh = (assetId: string): Local => ({ assetId, selectedId: null, scroll: null });

/**
 * Everything the notes panel and the player share for one Version (#741 5b): the list query, the filters, selection, the in / out marks
 * (read from the form store), the clock handed up by the player, and the writes. The viewer calls this once
 * and gives the panel `session` and the player `playerProps`.
 */
export function useVideoNotes({ projectId, version, role, userId, archived, forms, markup = false, seekFrame }: {
  projectId: string;
  version: VideoVersionDto;
  role: Role;
  userId: string | null;
  archived: boolean;
  /** The Video tab's form store: drafts, the open edit or reply, marks and the request that is out outlive this panel. */
  forms: NoteFormStore;
  /** The Project's `markup` part is on (#741 6b-ui): drawing, and a note's drawing on screen. Off, the notes are exactly 5b's. */
  markup?: boolean;
  /** Where a note or marker click sends the playhead. Defaults to this Version's own clock; Compare (#741 7c) routes it through the transport so both sides follow. */
  seekFrame?: (frame: number) => void;
}) {
  const assetId = version.assetId;
  const queryClient = useOptionalProjectQueryClient();
  const query = useVideoNotesQuery(projectId, assetId, true, role);
  const [filters, setFilters] = useState<NoteFilters>(DEFAULT_NOTE_FILTERS);
  const [local, setLocal] = useState<Local>(() => fresh(assetId));
  // The Version on screen changed: the selection belongs to the one just left, and must not come back with it.
  if (local.assetId !== assetId) setLocal(fresh(assetId));
  const live = local.assetId === assetId ? local : fresh(assetId);
  // An update from a render of a Version already left (a Post that completes late) is dropped: applied, it would reset the Version now on screen to the old one's blank state.
  const update = useCallback((change: (current: Local) => Local) => { if (assetIdRef.current !== assetId) return; setLocal((current) => change(current.assetId === assetId ? current : fresh(assetId))); }, [assetId]);

  // The player's clock, tagged with the Version it was built for: a clock of the Version just left is never handed to the new one.
  const assetIdRef = useRef(assetId);
  assetIdRef.current = assetId;
  const [clockState, setClockState] = useState<{ assetId: string; clock: VideoFrameClock } | null>(null);
  const onClockChange = useCallback((next: VideoFrameClock | null) => { setClockState(next ? { assetId: assetIdRef.current, clock: next } : null); }, []);
  const clock = clockState && clockState.assetId === assetId ? clockState.clock : null;

  const base = useMemo(() => ({ nominalFps: version.tcNominalFps, dropFrame: version.tcDropFrame }), [version.tcNominalFps, version.tcDropFrame]);
  const start = version.startTimecodeFrames ?? 0;
  const timecode = useCallback((frame: number) => framesToTimecode(frame, base, start), [base, start]);
  const frameCount = version.frameCount;
  const readOnly = archived;

  const threads = query.data;
  const shown = useMemo(() => (threads ? visibleThreads(threads, filters) : []), [threads, filters]);
  const marks = useSyncExternalStore(forms.subscribe, () => forms.slot(assetId).marks);
  // Draw mode locks the transport, seeks and marks; with the part off there is no draw mode, whatever a stale slot says.
  const drawHeld = useSyncExternalStore(forms.subscribe, () => forms.slot(assetId).draw !== null);
  const drawing = markup && drawHeld;
  const pendingRange = useMemo(() => marksToFrames(effectiveMarks(marks, clock).value, frameCount), [marks, clock, frameCount]);
  // A form whose note left the Version's list goes; an archived Project takes no forms; leaving the Version re-arms the first Escape.
  useEffect(() => { if (threads) forms.retireMissing(assetId, threads); }, [forms, assetId, threads]);
  useEffect(() => { if (clock) forms.observeClock(assetId, clock); }, [forms, assetId, clock]);
  useEffect(() => { if (readOnly) { forms.close(assetId); forms.cancelConfirmation(assetId); forms.exitDraw(assetId); } }, [forms, assetId, readOnly]);
  useEffect(() => { if (!markup) forms.exitDraw(assetId); }, [forms, assetId, markup]);
  useEffect(() => () => { forms.leave(assetId); }, [forms, assetId]);
  const markers = useMemo<TimelineMarker[]>(() => shown.filter((thread) => thread.startFrame !== null).map((thread) => ({ id: thread.id, startFrame: thread.startFrame!, endFrame: thread.endFrame, tone: thread.visibility, selected: thread.id === live.selectedId, createdAt: thread.createdAt })), [shown, live.selectedId]);

  const select = useCallback((id: string | null) => { update((current) => ({ ...current, selectedId: id })); }, [update]);
  /** A note with a drawing opens on the frame it was drawn on, so selecting it shows the drawing at once; every other note on its first frame. While drawing nothing seeks. */
  const landing = (thread: VideoNoteThreadDto) => (markup && thread.hasMarkup && thread.drawingFrame !== null ? thread.drawingFrame : thread.startFrame);
  const seekRef = useRef(seekFrame);
  seekRef.current = seekFrame;
  const goTo = useCallback((frame: number) => { if (seekRef.current) seekRef.current(frame); else clock?.seekToFrame(frame); }, [clock]);
  const seekToNote = useCallback((thread: VideoNoteThreadDto) => {
    if (forms.slot(assetId).draw !== null && markup) return;
    const frame = landing(thread);
    if (frame !== null) goTo(frame);
    select(thread.id);
  }, [goTo, select, forms, assetId, markup]); // eslint-disable-line react-hooks/exhaustive-deps
  const onMarkerSelect = useCallback((id: string) => {
    if (forms.slot(assetId).draw !== null && markup) return;
    const thread = threads?.find((candidate) => candidate.id === id);
    if (!thread) return;
    const frame = landing(thread);
    if (frame !== null) goTo(frame);
    update((current) => ({ ...current, selectedId: id, scroll: { id, seq: (current.scroll?.seq ?? 0) + 1 } }));
  }, [goTo, threads, update, forms, assetId, markup]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo<NoteWriteContext | null>(() => (queryClient ? { queryClient, projectId, assetId, role } : null), [queryClient, projectId, assetId, role]);
  const withCtx = useCallback(<T,>(run: (context: NoteWriteContext) => Promise<T>): Promise<T> => (ctx ? run(ctx) : Promise.reject(new Error("Notes are not available here."))), [ctx]);

  const refresh = useCallback(() => { void query.refetch(); }, [query]);

  // A note posted with a drawing becomes the selected one, so its drawing stays on the picture (the display rule shows the selected note's).
  const post = useCallback((input: VideoNoteCreateInput) => withCtx((context) => createVideoNote(context, input)).then((created) => { if (markup && input.markup !== undefined) select(created.id); return created; }), [withCtx, markup, select]);
  const actions = useMemo<ThreadActions>(() => ({
    reply: (rootId, body) => withCtx((context) => replyToVideoNote(context, rootId, body)),
    edit: (noteId: string, input: VideoNoteEditInput) => withCtx((context) => editVideoNote(context, noteId, input)),
    resolve: (rootId, resolved) => withCtx((context) => setVideoNoteResolution(context, rootId, resolved)),
    requestDelete: () => undefined, // replaced by the panel, which owns the confirmation
    refresh,
  }), [withCtx, refresh]);
  /** Delete sends the revision the confirm was opened with (or, after a conflict the person reviewed, the current one): never the live cache value. */
  const remove = useCallback((note: VideoNoteDto, revision: number) => withCtx((context) => deleteVideoNote(context, note, revision)), [withCtx]);

  const previewPaste = useCallback((input: Parameters<typeof previewVideoNotePaste>[1]) => withCtx((context) => previewVideoNotePaste(context, input)), [withCtx]);
  const commitPaste = useCallback((input: Parameters<typeof commitVideoNotePaste>[1]) => withCtx((context) => commitVideoNotePaste(context, input)), [withCtx]);

  const writable = !readOnly && clock !== null;
  const canAnnotate = !readOnly && roleHasCapability(role, "annotateVideo");
  const selectedThread = live.selectedId === null ? null : shown.find((thread) => thread.id === live.selectedId) ?? null;
  return {
    assetId, version, role, userId, readOnly, query, threads, shown, filters, setFilters, selectedId: live.selectedId, scroll: live.scroll,
    clock, frameCount, timecode, forms, pendingRange, markers, projectId,
    /** Drawing (#741 6b-ui): whether the part is on, whether this person may draw, and the selected note when it is live and passes the filters (its saved drawing may show). */
    markup, canAnnotate, selectedThread,
    seekToNote, select, actions, post, remove, refresh, previewPaste, commitPaste,
    /** What the viewer hands the player. `onMark` exists only while the panel can take a mark, so I and O do nothing on an archived Project; it marks the frame on screen at once, with no pause and nothing pending. */
    playerProps: { markers, pendingRange, onMarkerSelect, onClockChange, transportLocked: drawing, ...(writable && clock ? { onMark: (kind: "in" | "out", frame: number) => { forms.mark(assetId, kind, frame, clock); } } : {}) },
  };
}

export type VideoNotesSession = ReturnType<typeof useVideoNotes>;
