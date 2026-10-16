import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { type VideoNoteDto, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useHairlineWithHead } from "../../lib/use-hairline-with-head";
import { useNow } from "../../lib/use-now";
import { DEFAULT_NOTE_FILTERS, noteAuthors, noteCounts, type NoteStatusFilter, type NoteVisibilityFilter } from "../../lib/video-note-view";
import { classifyVideoNoteError } from "../../lib/video-notes-data";
import { ARCHIVED_NOTICE_CLASS } from "../archived-notice";
import { ConfirmDeleteDialog } from "../ConfirmDeleteDialog";
import { Button } from "../quincy/Button";
import { ICON_BUTTON } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { NotesFilterHead, type NotesSearchState } from "../quincy/NotesFilterHead";
import { ReviewPaneHideContext } from "../quincy/ReviewPane";
import { Popover, PopoverContent, PopoverTrigger } from "../reui/popover";
import { ScrollArea } from "../reui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../reui/toggle-group";
import { EXPORT_PANEL_WIDTH, MarkerExportMenuItems, MarkerExportNotices, type MarkerExport } from "./VideoMarkerExportMenu";
import { VideoNoteComposer } from "./VideoNoteComposer";
import { VideoNoteThread } from "./VideoNoteThread";
import type { VideoNotesSession } from "./use-video-notes";
import type { NotesClipboard } from "./use-notes-clipboard";

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
export function VideoNotesPanel({ session, detailsRows, exp, clipboard, pen, phone = false, onSearchChange }: { session: VideoNotesSession; detailsRows: ReactNode; /** Copy and paste (#741 5c-ui), owned by the notes host (#879 PR 3b) so the phone header's ⋯ sheet drives the same controller and the paste dialog outlives this panel. */ clipboard: NotesClipboard; /** The marker export (#741 9), owned by the notes host so the phone header can reach it: `enabled` is the Project's `export` part and the role. */ exp: MarkerExport; /** The Draw button, handed to the composer on a phone (D11). */ pen?: ReactNode; /** The phone layout (#879): the panel is the sheet's body, its composer the sheet's foot. */ phone?: boolean; /** The phone head's search opened or closed (#879 PR 3b). */ onSearchChange?: (state: NotesSearchState) => void; }) {
  const { query, threads, shown, filters, setFilters, selectedId, version } = session;
  const archived = session.readOnly;
  const readOnly = archived;
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  // On a phone the hairline above the composer follows the notes head (#879 PR 3b), the row that now opens the list.
  const headRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useHairlineWithHead(phone, listRef, headRef, composerRef);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  /** Where focus may land once the confirm closes: kept in a ref because `deleting` is already null by then. */
  const focusIds = useRef<string[]>([]);
  /** The ⋯ that opened the confirm, and how it closed: only a successful delete uses the current destination, Cancel and Escape go back to the trigger. */
  const deleteTrigger = useRef<HTMLElement | null>(null);
  const deleteDone = useRef(false);

  // NLE marker export (#741 9): its options and request live in the hook, keyed by this Version; the ⋯ menu shows for anyone who can copy or export.
  const canExport = exp.enabled;

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

  // The screen that owns the pane places its hide (⇥) button here (#877 S2); Compare's panel and a phone provide none.
  const hideButton = useContext(ReviewPaneHideContext);
  const total = (counts.totals.open + counts.totals.resolved);
  const loading = query.isPending;
  const failed = query.isError && !query.data;

  const filterGroup = <Value extends string,>(label: string, group: string, value: Value, options: Array<{ value: Value; label: string; count: number }>, onChange: (next: Value) => void) => (
    <ToggleGroup variant="outline" size="sm" spacing={0} aria-label={label} value={[value]} onValueChange={(next) => { const picked = next[0] as Value | undefined; if (picked !== undefined) onChange(picked); }}>
      {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} data-testid={`video-notes-filter-${group}-${option.value}`} className={FILTER_ITEM}>{option.label}<span className={COUNT}>{option.count}</span></ToggleGroupItem>)}
    </ToggleGroup>
  );

  const headerRow = (
    <div data-sheet-part="body" className="flex flex-wrap items-baseline justify-between max-[721px]:flex-nowrap max-[721px]:items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
      <div className="grid gap-[var(--space-1)]">
        <h3 data-testid="video-notes-title" className="m-0 max-[721px]:sr-only text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{`Notes on v${version.version}`}</h3>
        <span data-testid="video-notes-counts" className="text-foreground-secondary [font:var(--type-label)]">{`${counts.totals.open} open · ${counts.totals.resolved} resolved`}</span>
      </div>
      <div className="flex items-center gap-[var(--space-1)]">
        <Popover>
          <PopoverTrigger render={<Button type="button" variant="text" data-testid="video-details-button" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" />}>Version details</PopoverTrigger>
          <PopoverContent align="end" className="w-[min(320px,calc(100vw-var(--space-5)))] max-h-[min(70dvh,520px)] overflow-y-auto" data-testid="video-details-popover">{detailsRows}</PopoverContent>
        </Popover>
        {(clipboard.canCopy || (canExport && !phone)) && <Menu triggerLabel="Notes actions" label="Notes actions" triggerClassName={ICON_BUTTON} panelClassName={canExport ? EXPORT_PANEL_WIDTH : undefined} triggerTestId="video-notes-menu" trigger={<span aria-hidden="true">⋯</span>}>
          {clipboard.canCopy && <MenuPrimitive.Item className={MENU_ITEM} disabled={clipboard.copyDisabled} onClick={clipboard.copyShown}>Copy shown notes</MenuPrimitive.Item>}
          {clipboard.pasteLabel !== null && <MenuPrimitive.Item className={MENU_ITEM} onClick={clipboard.openPaste}>{clipboard.pasteLabel}</MenuPrimitive.Item>}
          {canExport && !phone && <MarkerExportMenuItems exp={exp} separated={clipboard.canCopy} />}
        </Menu>}
        {hideButton}
      </div>
    </div>
  );
  const filtersBlock = (
    <>{total > 0 && <div className="grid gap-[var(--space-2)]" data-sheet-part="body" data-testid="video-notes-filters">
      {filterGroup<NoteStatusFilter>("Show notes that are", "status", filters.status, [
        { value: "open", label: "Open", count: counts.status.open }, { value: "resolved", label: "Resolved", count: counts.status.resolved }, { value: "all", label: "All", count: counts.status.all },
      ], (status) => { setFilters({ ...filters, status }); })}
      {filterGroup<NoteVisibilityFilter>("Show notes visible to", "visibility", filters.visibility, [
        { value: "all", label: "All", count: counts.visibility.all }, { value: "public", label: "Client-visible", count: counts.visibility.public }, { value: "internal", label: "Internal", count: counts.visibility.internal },
      ], (visibility) => { setFilters({ ...filters, visibility }); })}
    </div>}</>
  );

  const statusOptions = [{ value: "open" as const, label: "Open", count: counts.status.open }, { value: "resolved" as const, label: "Resolved", count: counts.status.resolved }, { value: "all" as const, label: "All", count: counts.status.all }];
  const visibilityOptions = [{ value: "all" as const, label: "All", count: counts.visibility.all }, { value: "public" as const, label: "Client-visible", count: counts.visibility.public }, { value: "internal" as const, label: "Internal", count: counts.visibility.internal }];
  // The phone head (#879 PR 3b, P1 `NotesFilter`) in place of the title row, the two toggle groups and the notes ⋯ (whose Copy and Paste move to the header's ⋯ sheet).
  const authors = useMemo(() => noteAuthors(threads ?? []), [threads]);
  const phoneHead = total > 0 && <NotesFilterHead<NoteStatusFilter, NoteVisibilityFilter>
    headRef={headRef}
    status={{ label: "Show notes that are", value: filters.status, options: statusOptions, onChange: (status) => { setFilters({ ...filters, status }); } }}
    visibility={{ label: "Show notes visible to", value: filters.visibility, options: visibilityOptions, onChange: (visibility) => { setFilters({ ...filters, visibility }); } }}
    authors={{ value: filters.author, options: authors, onChange: (author) => { setFilters({ ...filters, author }); } }}
    query={filters.query}
    onQueryChange={(query) => { setFilters({ ...filters, query }); }}
    {...(onSearchChange ? { onSearchChange } : {})}
  />;
  // A phone filter that leaves nothing to show says so and offers the way back (#879 PR 3b); the desktop keeps its one quiet line.
  const filteredEmpty = phone && total > 0
    ? <EmptyState size="compact" data-testid="video-notes-empty" title="No notes match."><Button type="button" variant="text" data-testid="video-notes-reset-filters" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { setFilters(DEFAULT_NOTE_FILTERS); }}>Reset filters</Button></EmptyState>
    : null;

  return <aside
    aria-label="Notes"
    data-testid="video-notes-panel"
    // In the phone sheet's compose mode only the composer shows, with a tighter top and bottom; the side gutter stays the browse one, so the pill and Send never shift (#879 fix r3).
    // Browse mode's composer band is P1's (#879 PR 3a): no padding above the list or below the pill and no gap above the composer, which owns one border and `--space-2` around the pill.
    className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)] min-[721px]:overflow-clip max-[721px]:overflow-clip border-l border-border bg-card p-[var(--space-4)] text-card-foreground max-[721px]:border-l-0 in-data-[mode=browse]:gap-0 in-data-[mode=browse]:py-0 in-data-[mode=compose]:py-[var(--space-2)]"
  >
    {!phone && headerRow}

    <div data-sheet-part="body" className="contents"><MarkerExportNotices exp={exp} /></div>

    {clipboard.status !== null && <Notice tone="positive" role="status" data-testid="video-notes-paste-status" data-sheet-part="body">{clipboard.status}</Notice>}

    {!phone && filtersBlock}

    {orphanNotice && <Notice tone="critical" role="alert" data-testid="video-notes-orphan-notice" data-sheet-part="body" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
      <span>{orphanNotice.text}</span>
      <Button type="button" variant="text" data-testid="video-notes-orphan-dismiss" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { session.forms.dismissNotice(session.assetId); }}>Dismiss</Button>
    </Notice>}

    <div ref={listRef} data-sheet-part="body" className="flex flex-1 flex-col min-[721px]:min-h-32 max-[721px]:min-h-0">
      <ScrollArea className="min-h-0 flex-1" data-testid="video-notes-list" viewportProps={{ tabIndex: -1 }}>
        <div data-testid="video-notes-list-body" className="grid gap-[var(--space-2)] pe-[var(--space-1)] in-data-[mode=browse]:py-[var(--space-3)]">
          {phone && phoneHead}
          {loading && <span data-testid="video-notes-loading" role="status" className="text-foreground-secondary [font:var(--type-label)]">Loading notes…</span>}
          {failed && <Notice tone="critical" role="alert" data-testid="video-notes-error" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>Notes could not be loaded.</span><Button type="button" variant="text" data-testid="video-notes-retry" onClick={session.refresh}>Retry</Button></Notice>}
          {!loading && !failed && listed.length === 0 && (filteredEmpty ?? <EmptyState size="compact" data-testid="video-notes-empty" title={total === 0 ? "No notes on this version yet." : "No notes match these filters."} />)}
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
            drawings={{ on: session.markup, canAnnotate: session.canAnnotate, projectId: session.projectId, role: session.role }}
            rich={{ projectId: session.projectId, role: session.role }}
          />)}
        </div>
      </ScrollArea>
    </div>

    {/* In compose mode the composer is the strip: it may shrink (only its + tray gives way), and the sheet's own top border is the strip's. */}
    <div ref={composerRef} data-sheet-part="composer" className="shrink-0 border-t border-border data-[head-cut=true]:border-t-transparent pt-[var(--space-3)] in-data-[mode=browse]:py-[var(--space-2)] in-data-[mode=compose]:flex in-data-[mode=compose]:min-h-0 in-data-[mode=compose]:shrink in-data-[mode=compose]:flex-col in-data-[mode=compose]:border-t-0 in-data-[mode=compose]:pt-0">
      {archived
        ? <p data-testid="video-notes-archived" className={ARCHIVED_NOTICE_CLASS}>Read-only while archived. Restore the project before adding or changing notes.</p>
        : <VideoNoteComposer store={session.forms} assetId={session.assetId} clock={session.clock} frameCount={session.frameCount} timecode={session.timecode} post={session.post} onRefresh={session.refresh} markup={session.markup} rich={{ projectId: session.projectId, role: session.role }} {...(pen !== undefined ? { pen } : {})} />}
    </div>

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
