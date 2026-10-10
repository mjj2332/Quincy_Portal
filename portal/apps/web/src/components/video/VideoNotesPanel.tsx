import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { roleHasCapability, VIDEO_NOTE_PASTE_MAX, type VideoDto, type VideoNoteDto, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useNow } from "../../lib/use-now";
import { noteCounts, type NoteStatusFilter, type NoteVisibilityFilter } from "../../lib/video-note-view";
import { classifyVideoNoteError } from "../../lib/video-notes-data";
import { ARCHIVED_NOTICE_CLASS } from "../archived-notice";
import { ConfirmDeleteDialog } from "../ConfirmDeleteDialog";
import { Button } from "../quincy/Button";
import { ICON_BUTTON } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { Popover, PopoverContent, PopoverTrigger } from "../reui/popover";
import { ScrollArea } from "../reui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { VideoNoteComposer } from "./VideoNoteComposer";
import { VideoNotePasteDialog } from "./VideoNotePasteDialog";
import { VideoNoteThread } from "./VideoNoteThread";
import type { VideoNotesSession } from "./use-video-notes";

const FILTER_ITEM = "min-h-8 pointer-coarse:min-h-11 max-[721px]:min-h-11";
const COUNT = "ms-[var(--space-1)] text-foreground-secondary tabular-nums";

/** `revision` is the one the confirm was opened with; after a conflict the person reviewed it becomes the current note's ("Delete anyway"). */
type Deleting = { note: VideoNoteDto; root: VideoNoteThreadDto; revision: number; conflicted: boolean; pending: boolean; error: string | null };

/** The words the delete confirm uses: a root others replied to stays on as "Note deleted" with its replies; anything else is gone for everyone. */
function deleteCopy(tombstone: boolean, conflicted: boolean) {
  return {
    title: "Delete note?", action: conflicted ? "Delete anyway" : "Delete", pending: "Deleting…", fallbackSubject: "This note",
    description: (subject: ReactNode) => tombstone
      ? <>{subject} will be replaced by “Note deleted” because others replied to it. Their replies stay. This can't be undone.</>
      : <>{subject} will be removed for everyone. This can't be undone.</>,
  };
}

/**
 * The notes panel beside the player (#741 5b), on a paper surface: header (title, totals, the Version details popover), the two filters,
 * the list, and the composer. On a desktop the list is the only inner scroller and the composer stays at the foot; on a phone (below
 * 721px) nothing inside scrolls on its own: the whole dialog scrolls, with the composer directly under the player ahead of the list.
 * It holds no data of its own: `session` (from `useVideoNotes`) is shared with the player, which draws the markers and takes I and O.
 */
export function VideoNotesPanel({ session, video, detailsRows }: { session: VideoNotesSession; video: VideoDto; detailsRows: ReactNode }) {
  const { query, threads, shown, filters, setFilters, selectedId, version, readOnly } = session;
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  /** Where focus may land once the confirm closes: kept in a ref because `deleting` is already null by then. */
  const focusIds = useRef<string[]>([]);
  /** The ⋯ that opened the confirm, and how it closed: only a successful delete uses the current destination, Cancel and Escape go back to the trigger. */
  const deleteTrigger = useRef<HTMLElement | null>(null);
  const deleteDone = useRef(false);

  // Copy and paste (#741 5c-ui): the ⋯ menu exists only where the person can write notes. The clipboard is the form store's, per Video, so it
  // outlives this panel (switching Version remounts it) and the paste dialog's offset and ticks outlive the dialog.
  const canCopy = !readOnly && roleHasCapability(session.role, "annotateVideo");
  const clipboard = useSyncExternalStore(session.forms.subscribe, () => session.forms.clipboard(video.id));
  const pasteFrom = clipboard && clipboard.sourceAssetId !== session.assetId ? clipboard : null;
  const pasteOpen = useSyncExternalStore(session.forms.subscribe, () => session.forms.pasteOpen(session.assetId));
  const pasteResult = useSyncExternalStore(session.forms.subscribe, () => session.forms.pasteResult(session.assetId));
  const setPasteOpen = (next: boolean) => { session.forms.setPasteOpen(session.assetId, next); };
  const [pasted, setPasted] = useState<string | null>(null);
  useEffect(() => {
    if (pasted === null) return;
    const timer = setTimeout(() => { setPasted(null); }, 6000);
    return () => { clearTimeout(timer); };
  }, [pasted]);
  useEffect(() => {
    if (pasteResult === null) return;
    const timer = setTimeout(() => { session.forms.clearPasteResult(session.assetId); }, 6000);
    return () => { clearTimeout(timer); };
  }, [pasteResult, session.forms, session.assetId]);
  const copyShown = () => {
    const ids = shown.map((thread) => thread.id);
    if (ids.length === 0) { setPasted("No notes to copy"); return; }
    session.forms.copyNotes(video.id, { sourceAssetId: session.assetId, sourceVersion: version.version, noteIds: ids });
    setPasted(ids.length > VIDEO_NOTE_PASTE_MAX ? `Copied the first ${VIDEO_NOTE_PASTE_MAX} of ${ids.length} notes` : `Copied ${ids.length} ${ids.length === 1 ? "note" : "notes"}`);
  };

  const counts = useMemo(() => noteCounts(threads ?? [], filters), [threads, filters]);
  // The thread holding the open edit or reply stays listed when the filters exclude it, so the form is never invisible. Counts and markers still follow the filters.
  const openRootId = useSyncExternalStore(session.forms.subscribe, () => session.forms.slot(session.assetId).open?.rootId ?? null);
  // A notice left by a form whose root thread is no longer listed (hard-deleted elsewhere) has no thread to show it: the panel does.
  const heldNotice = useSyncExternalStore(session.forms.subscribe, () => session.forms.slot(session.assetId).notice);
  const orphanNotice = heldNotice && !(threads ?? []).some((thread) => thread.id === heldNotice.rootId) ? heldNotice : null;
  const listed = useMemo(() => {
    if (openRootId === null || shown.some((thread) => thread.id === openRootId)) return shown;
    const keep = new Set([...shown.map((thread) => thread.id), openRootId]);
    return (threads ?? []).filter((thread) => keep.has(thread.id));
  }, [shown, threads, openRootId]);

  // A marker press scrolls the list's own scroller by arithmetic: scrollIntoView would also scroll the phone's single-column dialog body.
  const scrollRequest = session.scroll;
  useEffect(() => {
    if (!scrollRequest) return;
    const viewport = listRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const target = listRef.current?.querySelector<HTMLElement>(`[data-testid="video-note-thread"][data-note-id="${scrollRequest.id}"]`);
    if (!viewport || !target) return;
    viewport.scrollTop = Math.max(0, viewport.scrollTop + (target.getBoundingClientRect().top - viewport.getBoundingClientRect().top) - 8);
  }, [scrollRequest]);

  const requestDelete = (note: VideoNoteDto, root: VideoNoteThreadDto) => {
    const index = listed.findIndex((thread) => thread.id === root.id);
    const neighbours = [listed[index + 1]?.id, listed[index - 1]?.id].filter((id): id is string => id !== undefined);
    focusIds.current = [root.id, ...neighbours];
    deleteTrigger.current = listRef.current?.querySelector<HTMLElement>(`[data-note-id="${note.id}"] [data-testid="video-note-actions"]`) ?? null;
    deleteDone.current = false;
    setDeleting({ note, root, revision: note.revision, conflicted: false, pending: false, error: null });
  };
  const actions = { ...session.actions, requestDelete };

  async function confirmDelete() {
    if (!deleting || deleting.pending) return;
    const { note, revision } = deleting;
    setDeleting({ ...deleting, pending: true, error: null });
    try {
      await session.remove(note, revision);
      deleteDone.current = true;
      setDeleting(null);
    } catch (error) {
      const classified = classifyVideoNoteError(error);
      const kind = classified.kind;
      if (kind === "gone" || kind === "deleted") { deleteDone.current = true; setDeleting(null); return; }
      if (kind === "conflict" && classified.thread) {
        // The server's note beside the confirm; only an explicit "Delete anyway" sends its revision.
        const current = [classified.thread, ...classified.thread.replies].find((candidate) => candidate.id === note.id);
        const currentText = current && !current.deleted ? ` Current note: “${current.body.replace(/\s+/g, " ").trim().slice(0, 200)}”` : "";
        setDeleting((open) => (open ? { ...open, pending: false, conflicted: true, revision: current?.revision ?? open.revision, error: `This note changed since you opened Delete.${currentText} Delete anyway removes it as it is now.` } : open));
        return;
      }
      const message = kind === "conflict" ? "This note changed since you opened Delete. Review it and try again."
        : kind === "archived" ? "This Project was archived, so nothing was deleted."
        : kind === "network" ? "Couldn't reach the server. The note may or may not be deleted — refresh the notes to check."
        : error instanceof ApiError || error instanceof Error ? error.message || "The note could not be deleted." : "The note could not be deleted.";
      setDeleting((current) => (current ? { ...current, pending: false, error: message } : current));
    }
  }

  // After a delete focus goes to the thread that is still there (a tombstone), else the next one's timecode, else the previous one's, else the composer.
  const deleteFinalFocus = (): HTMLElement | true => {
    if (!deleteDone.current && deleteTrigger.current?.isConnected) return deleteTrigger.current;
    for (const id of focusIds.current) {
      const anchor = listRef.current?.querySelector<HTMLElement>(`[data-testid="video-note-thread"][data-note-id="${id}"] [data-testid="video-note-anchor-button"]`);
      if (anchor) return anchor;
    }
    return document.getElementById("video-note-body") ?? true;
  };

  const tombstoneDelete = deleting !== null && deleting.note.parentId === null
    && deleting.root.replies.some((reply) => !reply.deleted && JSON.stringify(reply.author) !== JSON.stringify(deleting.note.author));
  const excerpt = deleting && !deleting.note.deleted ? deleting.note.body.replace(/\s+/g, " ").trim().slice(0, 60) : "";

  const total = (counts.totals.open + counts.totals.resolved);
  const loading = query.isPending;
  const failed = query.isError && !query.data;

  const filterGroup = <Value extends string,>(label: string, group: string, value: Value, options: Array<{ value: Value; label: string; count: number }>, onChange: (next: Value) => void) => (
    <ToggleGroup variant="outline" size="sm" spacing={0} aria-label={label} value={[value]} onValueChange={(next) => { const picked = next[0] as Value | undefined; if (picked !== undefined) onChange(picked); }}>
      {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} data-testid={`video-notes-filter-${group}-${option.value}`} className={FILTER_ITEM}>{option.label}<span className={COUNT}>{option.count}</span></ToggleGroupItem>)}
    </ToggleGroup>
  );

  return <aside
    aria-label="Notes"
    data-testid="video-notes-panel"
    data-surface="default"
    className="flex flex-[1_1_360px] flex-col gap-[var(--space-3)] border-l border-border bg-card p-[var(--space-4)] text-card-foreground min-[721px]:min-h-0 min-[721px]:flex-[0_0_clamp(240px,28vw,360px)] min-[721px]:overflow-clip max-[721px]:border-t max-[721px]:border-l-0"
  >
    <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-3)] gap-y-[var(--space-1)] max-[721px]:order-0">
      <div className="grid gap-[var(--space-1)]">
        <h3 data-testid="video-notes-title" className="m-0 text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Notes on v${version.version}`}</h3>
        <span data-testid="video-notes-counts" className="text-foreground-secondary [font:var(--type-label)]">{`${counts.totals.open} open · ${counts.totals.resolved} resolved`}</span>
      </div>
      <div className="flex items-center gap-[var(--space-1)]">
        <Popover>
          <PopoverTrigger render={<Button type="button" variant="text" data-testid="video-details-button" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" />}>Version details</PopoverTrigger>
          <PopoverContent align="end" className="w-[min(320px,calc(100vw-var(--space-5)))] max-h-[min(70dvh,520px)] overflow-y-auto" data-testid="video-details-popover">{detailsRows}</PopoverContent>
        </Popover>
        {canCopy && <Menu triggerLabel="Notes actions" label="Notes actions" triggerClassName={ICON_BUTTON} triggerTestId="video-notes-menu" trigger={<span aria-hidden="true">⋯</span>}>
          <MenuPrimitive.Item className={MENU_ITEM} disabled={shown.length === 0} onClick={copyShown}>Copy shown notes</MenuPrimitive.Item>
          {pasteFrom && <MenuPrimitive.Item className={MENU_ITEM} onClick={() => { setPasteOpen(true); }}>{`Paste ${pasteFrom.noteIds.length} ${pasteFrom.noteIds.length === 1 ? "note" : "notes"} from v${pasteFrom.sourceVersion}…`}</MenuPrimitive.Item>}
        </Menu>}
      </div>
    </div>

    {(pasteResult ?? pasted) && <Notice tone="positive" role="status" data-testid="video-notes-paste-status" className="max-[721px]:order-2">{pasteResult ?? pasted}</Notice>}

    {total > 0 && <div className="grid gap-[var(--space-2)] max-[721px]:order-2" data-testid="video-notes-filters">
      {filterGroup<NoteStatusFilter>("Show notes that are", "status", filters.status, [
        { value: "open", label: "Open", count: counts.status.open }, { value: "resolved", label: "Resolved", count: counts.status.resolved }, { value: "all", label: "All", count: counts.status.all },
      ], (status) => { setFilters({ ...filters, status }); })}
      {filterGroup<NoteVisibilityFilter>("Show notes visible to", "visibility", filters.visibility, [
        { value: "all", label: "All", count: counts.visibility.all }, { value: "public", label: "Client-visible", count: counts.visibility.public }, { value: "internal", label: "Internal", count: counts.visibility.internal },
      ], (visibility) => { setFilters({ ...filters, visibility }); })}
    </div>}

    {orphanNotice && <Notice tone="critical" role="alert" data-testid="video-notes-orphan-notice" className="flex flex-wrap items-center justify-between gap-[var(--space-2)] max-[721px]:order-3">
      <span>{orphanNotice.text}</span>
      <Button type="button" variant="text" data-testid="video-notes-orphan-dismiss" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { session.forms.dismissNotice(session.assetId); }}>Dismiss</Button>
    </Notice>}

    <div ref={listRef} className="flex flex-col min-[721px]:min-h-32 min-[721px]:flex-1 max-[721px]:order-3">
      <ScrollArea className="min-[721px]:min-h-0 min-[721px]:flex-1" data-testid="video-notes-list" viewportProps={{ tabIndex: -1 }}>
        <div className="grid gap-[var(--space-2)] pe-[var(--space-1)]">
          {loading && <span data-testid="video-notes-loading" role="status" className="text-foreground-secondary [font:var(--type-label)]">Loading notes…</span>}
          {failed && <Notice tone="critical" role="alert" data-testid="video-notes-error" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>Notes could not be loaded.</span><Button type="button" variant="text" data-testid="video-notes-retry" onClick={session.refresh}>Retry</Button></Notice>}
          {!loading && !failed && listed.length === 0 && <EmptyState size="compact" data-testid="video-notes-empty" title={total === 0 ? "No notes on this version yet." : "No notes match these filters."} />}
          {listed.map((thread) => <VideoNoteThread
            key={thread.id}
            thread={thread}
            pinned={!shown.some((candidate) => candidate.id === thread.id)}
            selected={thread.id === selectedId}
            userId={session.userId}
            readOnly={readOnly}
            now={now}
            timecode={session.timecode}
            frameCount={session.frameCount}
            actions={actions}
            onSeek={session.seekToNote}
            store={session.forms}
            assetId={session.assetId}
            clock={session.clock}
          />)}
        </div>
      </ScrollArea>
    </div>

    <div className="min-[721px]:shrink-0 min-[721px]:border-t min-[721px]:border-border min-[721px]:pt-[var(--space-3)] max-[721px]:order-1">
      {readOnly
        ? <p data-testid="video-notes-archived" className={ARCHIVED_NOTICE_CLASS}>Read-only while archived. Restore the project before adding or changing notes.</p>
        : <VideoNoteComposer store={session.forms} assetId={session.assetId} clock={session.clock} frameCount={session.frameCount} timecode={session.timecode} post={session.post} onRefresh={session.refresh} />}
    </div>

    {canCopy && pasteFrom && <VideoNotePasteDialog
      open={pasteOpen}
      onOpenChange={setPasteOpen}
      finalFocus={() => document.querySelector<HTMLElement>('[data-testid="video-notes-menu"]')}
      store={session.forms}
      assetId={session.assetId}
      target={version}
      source={video.versions.find((candidate) => candidate.assetId === pasteFrom.sourceAssetId)}
      clipboard={pasteFrom}
      previewPaste={session.previewPaste}
      commitPaste={session.commitPaste}
    />}

    <ConfirmDeleteDialog
      open={deleting !== null}
      excerpt={excerpt}
      deleting={deleting?.pending ?? false}
      error={deleting?.error ?? null}
      onConfirm={() => { void confirmDelete(); }}
      onCancel={() => { setDeleting(null); }}
      finalFocus={deleteFinalFocus}
      copy={deleteCopy(tombstoneDelete, deleting?.conflicted ?? false)}
      testIdPrefix="video-note-delete"
    />
  </aside>;
}
