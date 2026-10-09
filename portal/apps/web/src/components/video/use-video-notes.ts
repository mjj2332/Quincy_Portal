import { useCallback, useMemo, useRef, useState } from "react";
import { framesToTimecode, type Role, type VideoNoteCreateInput, type VideoNoteDto, type VideoNoteEditInput, type VideoNoteThreadDto, type VideoVersionDto } from "@quincy/shared";
import type { TimelineMarker } from "../quincy/VideoTimelineMarkers";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import type { VideoFrameClock } from "../../lib/video-frame-clock";
import { DEFAULT_NOTE_FILTERS, visibleThreads, type NoteFilters } from "../../lib/video-note-view";
import { EMPTY_MARKS, markFrame, marksToFrames, type NoteMarks } from "../../lib/video-note-marks";
import {
  classifyVideoNoteError, createVideoNote, deleteVideoNote, editVideoNote, replyToVideoNote, setVideoNoteResolution, useVideoNotesQuery, type NoteWriteContext,
} from "../../lib/video-notes-data";
import type { NoteDraft } from "./VideoNoteComposer";
import type { EditFrames, ThreadActions } from "./VideoNoteThread";

/** Unsent notes, kept by the Video tab for as long as it is open (never in a module: a different person renders none). */
export type DraftStore = { get(assetId: string): NoteDraft | undefined; set(assetId: string, draft: NoteDraft | null): void };

/** What belongs to one Version only: it starts empty when the Version on screen changes (marks are frames of one film). */
type Local = { assetId: string; marks: NoteMarks; editing: { marks: NoteMarks } | null; selectedId: string | null; scroll: { id: string; seq: number } | null };
const fresh = (assetId: string): Local => ({ assetId, marks: EMPTY_MARKS, editing: null, selectedId: null, scroll: null });

/**
 * Everything the notes panel and the player share for one Version (#741 5b): the list query, the filters, selection, the in / out marks
 * (the composer's, or the edit form's while one is open), the clock handed up by the player, and the writes. The viewer calls this once
 * and gives the panel `session` and the player `playerProps`.
 */
export function useVideoNotes({ projectId, version, role, userId, archived, drafts }: {
  projectId: string;
  version: VideoVersionDto;
  role: Role;
  userId: string | null;
  archived: boolean;
  drafts: DraftStore;
}) {
  const assetId = version.assetId;
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const query = useVideoNotesQuery(projectId, assetId, true, role);
  const [filters, setFilters] = useState<NoteFilters>(DEFAULT_NOTE_FILTERS);
  const [local, setLocal] = useState<Local>(() => fresh(assetId));
  // The Version on screen changed: marks, selection and any open edit belong to the one just left, and must not come back with it.
  if (local.assetId !== assetId) setLocal(fresh(assetId));
  const live = local.assetId === assetId ? local : fresh(assetId);
  const update = useCallback((change: (current: Local) => Local) => { setLocal((current) => change(current.assetId === assetId ? current : fresh(assetId))); }, [assetId]);

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
  const activeMarks = live.editing ? live.editing.marks : live.marks;
  const pendingRange = useMemo(() => marksToFrames(activeMarks, frameCount), [activeMarks, frameCount]);
  const markers = useMemo<TimelineMarker[]>(() => shown.filter((thread) => thread.startFrame !== null).map((thread) => ({ id: thread.id, startFrame: thread.startFrame!, endFrame: thread.endFrame, tone: thread.visibility, selected: thread.id === live.selectedId })), [shown, live.selectedId]);

  const frameOnScreen = useCallback(() => { const state = clock?.getState(); return state ? (state.playing ? state.frame : (state.targetFrame ?? state.frame)) : 0; }, [clock]);
  const mark = useCallback((kind: "in" | "out", frame: number) => {
    update((current) => current.editing ? { ...current, editing: { marks: markFrame(current.editing.marks, kind, frame) } } : { ...current, marks: markFrame(current.marks, kind, frame) });
  }, [update]);
  /** The composer's own Set in / Set out buttons always mark the composer, whatever else is open. */
  const markComposer = useCallback((kind: "in" | "out", frame: number) => { update((current) => ({ ...current, marks: markFrame(current.marks, kind, frame) })); }, [update]);
  const clearMarks = useCallback(() => { update((current) => ({ ...current, marks: EMPTY_MARKS })); }, [update]);

  const select = useCallback((id: string | null) => { update((current) => ({ ...current, selectedId: id })); }, [update]);
  const seekToNote = useCallback((thread: VideoNoteThreadDto) => {
    if (thread.startFrame !== null) clock?.seekToFrame(thread.startFrame);
    select(thread.id);
  }, [clock, select]);
  const onMarkerSelect = useCallback((id: string) => {
    const thread = threads?.find((candidate) => candidate.id === id);
    if (!thread) return;
    if (thread.startFrame !== null) clock?.seekToFrame(thread.startFrame);
    update((current) => ({ ...current, selectedId: id, scroll: { id, seq: (current.scroll?.seq ?? 0) + 1 } }));
  }, [clock, threads, update]);

  const ctx = useMemo<NoteWriteContext | null>(() => (queryClient ? { queryClient, projectId, assetId, role } : null), [queryClient, projectId, assetId, role]);
  const withCtx = useCallback(<T,>(run: (context: NoteWriteContext) => Promise<T>): Promise<T> => (ctx ? run(ctx) : Promise.reject(new Error("Notes are not available here."))), [ctx]);

  /** Every failed write: a 401 ends the session's data; a 404 that is not "Note not found" means the Project (or the gate) is gone, so the gate is asked again. */
  const onWriteError = useCallback((error: unknown) => {
    terminate(error);
    if (queryClient && classifyVideoNoteError(error).kind === "access") {
      void invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "video-review" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
    }
  }, [terminate, queryClient, projectId]);
  const refresh = useCallback(() => { void query.refetch(); }, [query]);

  const post = useCallback((input: VideoNoteCreateInput) => withCtx((context) => createVideoNote(context, input)), [withCtx]);
  const actions = useMemo<ThreadActions>(() => ({
    reply: (rootId, body) => withCtx((context) => replyToVideoNote(context, rootId, body)),
    edit: (noteId: string, input: VideoNoteEditInput) => withCtx((context) => editVideoNote(context, noteId, input)),
    resolve: (rootId, resolved) => withCtx((context) => setVideoNoteResolution(context, rootId, resolved)),
    requestDelete: () => undefined, // replaced by the panel, which owns the confirmation
    refresh,
    onWriteError,
  }), [withCtx, refresh, onWriteError]);
  const remove = useCallback((note: VideoNoteDto) => withCtx((context) => deleteVideoNote(context, note, note.revision)), [withCtx]);

  const editFrames = useMemo<EditFrames>(() => ({
    marks: live.editing?.marks ?? EMPTY_MARKS,
    onMark: (kind) => { mark(kind, frameOnScreen()); },
    onMakePoint: () => { update((current) => current.editing ? { ...current, editing: { marks: { in: current.editing.marks.in ?? current.editing.marks.out, out: null } } } : current); },
    // An edit form seeds its marks from the note's stored frames: the end is exclusive in storage, so the last included frame is end - 1.
    onBegin: (note) => { update((current) => ({ ...current, editing: { marks: note.startFrame === null ? EMPTY_MARKS : { in: note.startFrame, out: note.endFrame === null ? null : note.endFrame - 1 } } })); },
    onEnd: () => { update((current) => (current.editing ? { ...current, editing: null } : current)); },
  }), [live.editing, mark, frameOnScreen, update]);

  const writable = !readOnly && clock !== null;
  return {
    assetId, version, role, userId, readOnly, query, threads, shown, filters, setFilters, selectedId: live.selectedId, scroll: live.scroll,
    clock, frameCount, timecode, marks: live.marks, markComposer, clearMarks, editFrames, pendingRange, markers,
    seekToNote, select, actions, post, remove, refresh, onWriteError,
    draft: drafts.get(assetId), onDraftChange: (draft: NoteDraft | null) => { drafts.set(assetId, draft); },
    /** What the viewer hands the player. `onMark` exists only while the panel can take a mark, so I and O do nothing on an archived Project. */
    playerProps: { markers, pendingRange, onMarkerSelect, onClockChange, ...(writable ? { onMark: mark } : {}) },
  };
}

export type VideoNotesSession = ReturnType<typeof useVideoNotes>;
