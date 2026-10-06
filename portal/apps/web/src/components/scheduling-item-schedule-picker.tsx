/**
 * #582 / #583 — the item menu's "Edit schedule…" for a checklist item: the Due cell's own picker (`quincy/SubtaskScheduleControl`),
 * anchored to the ITEM (a Timeline bar, a Calendar chip or the day's "+N more"), as an inline session of the controller's schedule
 * editor (`openChecklistScheduleEditor(source, undefined, { inline: true, inlineTarget: "item" })`). It replaces the right-hand sheet
 * both surfaces used (#463 D7). It renders nothing of its own: no trigger, one popover, so no new UI element.
 *
 * One host for both surfaces, so they cannot drift. Rendered at each surface's root beside the item menu, OUTSIDE the vendor tree
 * (which remounts rows and re-keys an item whose Start moved), so it owns nothing the vendor can drop. The write, the version, the
 * lock and gate, the optimistic overlay, Undo and the settle refetch are the controller's; this is presentation. It opens on Start
 * (the Due cell opens on End) and stays mounted with `open={false}` after a close so the popover's exit animation and focus return run.
 *
 * Anchor: a virtual element re-read from `findAnchor(itemKey)` on EVERY call, so it follows scroll and a re-keyed item, and keeps the
 * last rect when the item is momentarily gone (a transient backup, never a cancel). Focus (#463 hand-off, lessons): when the popup
 * closes, focus goes to `findFocusTarget(itemKey)` (default: the anchor) unless it already sits on a connected control outside the
 * popup (an outside press landed on it).
 *
 * #585: a conflict dismissed by Escape or an outside press is kept in the surface's stash (`stashErrorFor`, from
 * `useScheduleConflictStash`), shown here on a reopen and while closed so the retained draft survives; Cancel, Use latest and Save
 * clear it.
 *
 * Reuse ledger: picker — `quincy/SubtaskScheduleControl` over `reui/popover` (its `anchor` passthrough); nothing else is drawn.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subtaskIdFromCalendarEntityId, type CalendarPerson, type ChecklistScheduleDto, type ProjectDefaultRangeDto, type RangeChecklistScheduleInput, type SubtaskRemindersDto } from "@quincy/shared";
import type { ScheduleEditorState } from "../lib/use-scheduling-commands";
import { SubtaskScheduleControl, type LatestSubtaskSummary, type RetainedSchedule, type ScheduleError } from "./quincy/SubtaskScheduleControl";

/** What the notice and the picker read of an item: the Gantt maps it from its row, the Calendar from its DTO (`done: status.completed`). */
export type ScheduleItemSummary = {
  /** The Subtask's id (bare uuid): the key of the retained draft and the stash. */
  id: string;
  title: string;
  done: boolean;
  street: string;
  schedule: ChecklistScheduleDto;
  assignees: CalendarPerson[];
  otherAssigneeCount: number;
  reminders: SubtaskRemindersDto;
  projectDefault: ProjectDefaultRangeDto | null;
};

type NoticeSource = Pick<ScheduleItemSummary, "schedule" | "assignees" | "otherAssigneeCount">;
type StashRow = Pick<ScheduleItemSummary, "title" | "done" | "schedule" | "assignees" | "otherAssigneeCount" | "reminders">;

/**
 * What the picker shows for the controller's editor state: a fold choice, a conflict's latest schedule or item, or the
 * validation sentence. Only fields the controller already validated and decoded (an External Editor's item is the
 * team-filtered DTO, so names and a hidden count are all it can carry).
 */
export function scheduleErrorFromEditor(editor: { source: NoticeSource; validationError?: ScheduleEditorState["validationError"]; latestItem?: ScheduleEditorState["latestItem"] }): ScheduleError<LatestSubtaskSummary> | undefined {
  const failure = editor.validationError;
  if (!failure) return undefined;
  if (failure.endpoint && failure.choices) return { endpoint: failure.endpoint, choices: failure.choices };
  if (failure.code === "subtask_item_conflict" || failure.code === "subtask_schedule_version_conflict") {
    const item = editor.latestItem;
    return {
      current: editor.source.schedule,
      ...(item?.reminders ? { currentReminders: item.reminders } : {}),
      // The latest-item notice is for an item conflict only; a schedule conflict keeps the schedule notice, now naming the reminders (#425).
      ...(item && failure.code === "subtask_item_conflict" ? { currentSubtask: { title: item.title, done: item.done, assignees: item.assignees ?? editor.source.assignees, otherAssigneeCount: item.otherAssigneeCount ?? editor.source.otherAssigneeCount, schedule: item.schedule, ...(item.reminders ? { reminders: item.reminders } : {}) } } : {}),
    };
  }
  return { message: failure.message };
}

/**
 * What a dismissed conflict leaves behind (#585): the two fields of the controller's editor state the notice is built from.
 * A surface holds one per Subtask above its vendor tree, because Escape and an outside press end the controller's session
 * (it would otherwise hold the lock and the accept gate over a closed picker) while the draft itself stays in `retained`.
 */
export type ScheduleConflictStash = Pick<ScheduleEditorState, "validationError" | "latestItem"> & {
  /** The Subtask's Project, so the Gantt can tell "the row was removed" (its Project is loaded in full and lacks it) from "not loaded yet". */
  projectId: string;
};

/**
 * The notice a reopened picker shows for a dismissed conflict. The row is the live one (a refetch or a conflict body may have
 * moved it past the 409), so the schedule named is the row's own. A stashed latest item is rebuilt from that row (title, Done,
 * assignees, schedule, reminders): none of those but the schedule carries a version, so the stash's copy could be stale in a
 * way no marker reveals. Only when the row's schedule is OLDER than the stashed item (a row not yet adopted) is the item kept.
 */
export function scheduleErrorFromStash(stash: ScheduleConflictStash, row: StashRow): ScheduleError<LatestSubtaskSummary> | undefined {
  const stashed = stash.latestItem;
  const latestItem = stashed && row.schedule.version >= stashed.schedule.version
    ? { ...stashed, title: row.title, done: row.done, assignees: row.assignees, otherAssigneeCount: row.otherAssigneeCount, schedule: row.schedule, reminders: row.reminders }
    : stashed;
  return scheduleErrorFromEditor({ source: row, validationError: stash.validationError, latestItem });
}

/**
 * "Save's own close is not a Cancel", shared by the Gantt's Due cell and the item picker (#582) so the two cannot drift. Save, Use latest
 * and Cancel each already tell the controller (and the surface's conflict stash) what they mean; the popover then calls
 * `setOpen(false)` as well, which must not be read as a dismissal. Each arms one pass-through; `closed` is what a `false` from
 * the popover calls: it swallows that one close, else it is a passive dismissal (Escape, an outside press, narrowing), which
 * ends the controller's session through `onDismiss` but keeps a conflicted draft and its notice (#585). Only Save, Use latest
 * and Cancel clear the stash (`onClear`), so the rule stays #423's: only Cancel and Use latest discard. The Checklist caller
 * passes no `onDiscard`, and its Escape never reaches a controller.
 */
export function useSchedulePickerClose({ onSubmit, onCancel, onDismiss, onClear }: { onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void; onCancel: () => void; onDismiss: () => void; onClear: () => void }) {
  const closeHandledRef = useRef(false);
  return {
    closed: () => {
      if (closeHandledRef.current) { closeHandledRef.current = false; return; }
      onDismiss();
    },
    onSave: (request: { schedule: RangeChecklistScheduleInput; reminderOffsetsMinutes?: number[] }) => { closeHandledRef.current = true; onClear(); onSubmit(request.schedule, request.reminderOffsetsMinutes); },
    onUseLatest: () => { closeHandledRef.current = true; onClear(); onCancel(); },
    onDiscard: () => { closeHandledRef.current = true; onClear(); onCancel(); },
  };
}

/**
 * The draft and the conflict notice a surface keeps ABOVE its vendor tree (#585, lifted from `ProductionGantt` for #583 so the Calendar
 * keeps them too): `retainedFor(id)` is the draft a failed save keeps, one per Subtask; `stash` holds what a dismissed conflict leaves
 * (Escape, an outside press, narrowing); `dismiss()` stashes a conflicted session then cancels it in the same handler. Everything resets
 * on `generationKey` (the Gantt's chart generation, the Calendar's reset key). `drop(ids)` forgets a Subtask's draft and stash (a
 * confirmed removal); `clear(id)` drops only the stash (Save, Use latest, Cancel).
 */
export function useScheduleConflictStash({ generationKey, scheduleEditor, cancelScheduleEditor }: { generationKey: string; scheduleEditor: ScheduleEditorState | null; cancelScheduleEditor: () => void }) {
  const retainedSchedules = useRef(new Map<string, RetainedSchedule>());
  const retainedFor = useCallback((id: string) => {
    let retained = retainedSchedules.current.get(id);
    if (!retained) { retained = { draft: null, baseVersion: null }; retainedSchedules.current.set(id, retained); }
    return retained;
  }, []);
  const [stash, setStash] = useState<ReadonlyMap<string, ScheduleConflictStash>>(() => new Map());
  useEffect(() => { retainedSchedules.current.clear(); setStash((current) => (current.size ? new Map() : current)); }, [generationKey]);
  const clear = useCallback((id: string) => {
    setStash((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const drop = useCallback((ids: readonly string[]) => {
    for (const id of ids) retainedSchedules.current.delete(id);
    setStash((current) => {
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);
  // The generation the open editor session began under: a dismissal from an outgoing session (the chart was replaced, a filter changed
  // while it was open) must not repopulate a stash the generation reset just cleared. Set when a session starts, not on every render.
  const generationRef = useRef(generationKey);
  const editorOpen = scheduleEditor !== null;
  useEffect(() => { if (editorOpen) generationRef.current = generationKey; }, [editorOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // A passive close of an inline picker (Escape, an outside press, narrowing): a conflict is stashed under its Subtask, then the
  // session ends exactly as a Cancel does. Both updates run in one handler, so there is no frame with neither set.
  const dismiss = useCallback(() => {
    const editor = scheduleEditor;
    if (editor?.validationError && generationRef.current === generationKey) {
      const id = subtaskIdFromCalendarEntityId(editor.source.id);
      if (id) setStash((current) => new Map(current).set(id, { validationError: editor.validationError, latestItem: editor.latestItem, projectId: editor.source.project.id }));
    }
    cancelScheduleEditor();
  }, [scheduleEditor, cancelScheduleEditor, generationKey]);
  // The notice for a Subtask's picker: the editor's own error first (a fresh 409), else the stash (a reopened session has no validationError).
  const stashErrorFor = useCallback((row: StashRow & { id: string }) => {
    const entry = stash.get(row.id);
    return entry ? scheduleErrorFromStash(entry, row) : undefined;
  }, [stash]);
  return { retainedFor, stash, clear, drop, dismiss, stashErrorFor };
}

export type SchedulingItemSchedulePickerProps = {
  /** The controller's session while it targets the item menu (`inlineTarget: "item"`), else null. */
  editor: ScheduleEditorState | null;
  /** The surface's key for the item the session is for (the Timeline's `task:<id>`, the Calendar's event id); null with no session. */
  itemKey: string | null;
  /** The live item and its Project's street and default, read from the surface's data (null when the item left it). */
  lookup: (itemKey: string) => ScheduleItemSummary | null;
  /** The element the picker sits on now (the chip, the bar, the day's "+N more"), or null while none is drawn. The last rect is kept meanwhile. */
  findAnchor: (itemKey: string) => HTMLElement | null;
  /** Where focus returns when the popup closes; defaults to `findAnchor`. */
  findFocusTarget?: (itemKey: string) => HTMLElement | null;
  retainedFor: (subtaskId: string) => RetainedSchedule;
  /** True while the surface is not live (a write settling, the gate held) and this picker holds no session: as the Due cell's `!(live || owner)`, it keeps the retained draft through a pending Apply so a 409 or fold error reopens on it. */
  busy: boolean;
  onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void;
  onCancel: () => void;
  /** #585: a passive close (Escape, an outside press): ends the session but stashes a conflict. */
  onDismiss: () => void;
  /** #585: the notice a dismissed conflict leaves for an item (the surface's stash, against the live item). */
  stashErrorFor: (item: ScheduleItemSummary) => ScheduleError<LatestSubtaskSummary> | undefined;
  /** #585: drops the Subtask's stashed conflict (Save, Use latest, Cancel). */
  onClear: (subtaskId: string) => void;
};

const EMPTY_RECT = { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;

export function SchedulingItemSchedulePicker({ editor, itemKey, lookup, findAnchor, findFocusTarget, retainedFor, busy, onSubmit, onCancel, onDismiss, stashErrorFor, onClear }: SchedulingItemSchedulePickerProps) {
  // What the popover last showed, kept so its exit animation has content after the session (and its item) is gone.
  const shownRef = useRef<{ key: string; item: ScheduleItemSummary } | null>(null);
  const close = useSchedulePickerClose({ onSubmit, onCancel, onDismiss, onClear: () => { if (shownRef.current) onClear(shownRef.current.item.id); } });
  const found = editor && itemKey ? lookup(itemKey) : null;
  if (editor && itemKey && found) shownRef.current = { key: itemKey, item: found };
  const shown = shownRef.current;
  const key = shown?.key ?? null;

  const findAnchorRef = useRef(findAnchor);
  findAnchorRef.current = findAnchor;
  const findFocusTargetRef = useRef(findFocusTarget);
  findFocusTargetRef.current = findFocusTarget;
  const lastRect = useRef<DOMRect>(EMPTY_RECT);
  const anchor = useMemo(() => {
    if (!key) return undefined;
    return {
      get contextElement() { return findAnchorRef.current(key) ?? undefined; },
      getBoundingClientRect: () => {
        const element = findAnchorRef.current(key);
        if (element?.isConnected) lastRect.current = element.getBoundingClientRect();
        return lastRect.current;
      },
    };
  }, [key]);

  const finalFocus = useCallback(() => {
    const active = document.activeElement;
    const outside = active instanceof HTMLElement && active !== document.body && active.isConnected && !active.closest('[data-slot="popover-content"]');
    if (outside) return false;
    if (!key) return true;
    return (findFocusTargetRef.current ?? findAnchorRef.current)(key) ?? true;
  }, [key]);

  if (!shown || !anchor) return null;
  const { item } = shown;
  return (
    <SubtaskScheduleControl<LatestSubtaskSummary>
      owner={`item-${item.id}`}
      label={`Schedule for ${item.title}, ${item.street}`}
      value={item.schedule}
      open={editor !== null}
      setOpen={(next) => { if (!next) close.closed(); }}
      busy={busy}
      // The editor's own error first (a fresh 409); else the surface's stash, which a reopened session lacks and which stays while closed (#585).
      error={(editor ? scheduleErrorFromEditor(editor) : undefined) ?? stashErrorFor(item)}
      retained={retainedFor(item.id)}
      onSave={close.onSave}
      onUseLatest={close.onUseLatest}
      onUseLatestItem={close.onUseLatest}
      onDiscard={close.onDiscard}
      projectDefault={item.projectDefault}
      reminders={{ offsets: item.reminders.offsetsMinutes, next: item.reminders.nextOccurrence }}
      anchor={anchor}
      finalFocus={finalFocus}
    />
  );
}
