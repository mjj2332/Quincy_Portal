/**
 * #582 — the Timeline item menu's "Edit schedule…" for a checklist bar: the Due cell's own picker
 * (`quincy/SubtaskScheduleControl`), anchored to the BAR, as an inline session of the controller's schedule editor
 * (`openChecklistScheduleEditor(source, undefined, { inline: true, inlineTarget: "item" })`). It replaces the right-hand sheet
 * the Timeline used at every width (#463 D7). It renders nothing of its own: no trigger, one popover, so no new UI element.
 *
 * Rendered at the Gantt root beside the item menu, OUTSIDE the vendor tree (which remounts rows and re-keys a bar whose Start
 * moved), so it owns nothing the vendor can drop. The write, the version, the lock and gate, the optimistic bar, Undo and the
 * settle refetch are the controller's, exactly as for the Due cell; this is presentation. It opens on Start (the Due cell opens
 * on End) and stays mounted with `open={false}` after a close so the popover's exit animation and focus return run.
 *
 * Anchor: a virtual element re-read from `findBar("task:<id>")` on EVERY call, so it follows scroll and a re-keyed bar, and keeps
 * the last rect when the bar is momentarily gone. Focus (#463 hand-off, lessons): when the popup closes, focus goes back to the
 * bar unless it already sits on a connected control outside the popup (an outside press landed on it).
 *
 * Reuse ledger: picker — `quincy/SubtaskScheduleControl` over `reui/popover` (its `anchor` passthrough); nothing else is drawn.
 */
import { useCallback, useMemo, useRef } from "react";
import type { GanttChecklistRowDto, ProjectDefaultRangeDto, RangeChecklistScheduleInput } from "@quincy/shared";
import { SHELL_AWARE_SHIFT_AVOIDANCE, shellAwarePopupPadding } from "../lib/date-time-field";
import type { ScheduleEditorState } from "../lib/use-scheduling-commands";
import { scheduleErrorFromEditor, useSchedulePickerClose } from "./ProductionGanttSubtaskCells";
import { SubtaskScheduleControl, type LatestSubtaskSummary, type RetainedSchedule } from "./quincy/SubtaskScheduleControl";

type Shown = { subtaskId: string; row: GanttChecklistRowDto; street: string; projectDefault: ProjectDefaultRangeDto | null };

export type ProductionGanttScheduleEditorPopoverProps = {
  /** The controller's session while it targets the item menu (`inlineTarget: "item"`), else null. */
  editor: ScheduleEditorState | null;
  /** The Subtask the session is for (null with no session). */
  subtaskId: string | null;
  /** The live row and its Project's street and default, read from the chart's data (null when the row left it). */
  lookup: (subtaskId: string) => { row: GanttChecklistRowDto; street: string; projectDefault: ProjectDefaultRangeDto | null } | null;
  /** The bar's element now (`findBar("task:<id>")`), or null while it is not drawn. */
  findBar: (key: string) => HTMLElement | null;
  retainedFor: (subtaskId: string) => RetainedSchedule;
  /** True while the chart is not live (a write settling, the gate held) and this picker holds no session: as the Due cell's `!(live || owner)`, it keeps the retained draft through a pending Apply so a 409 or fold error reopens on it. */
  busy: boolean;
  onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void;
  onCancel: () => void;
};

const EMPTY_RECT = { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;

export function ProductionGanttScheduleEditorPopover({ editor, subtaskId, lookup, findBar, retainedFor, busy, onSubmit, onCancel }: ProductionGanttScheduleEditorPopoverProps) {
  const close = useSchedulePickerClose({ onSubmit, onCancel });
  // What the popover last showed, kept so its exit animation has content after the session (and its row) is gone.
  const shownRef = useRef<Shown | null>(null);
  const found = editor && subtaskId ? lookup(subtaskId) : null;
  if (editor && subtaskId && found) shownRef.current = { subtaskId, ...found };
  const shown = shownRef.current;
  const key = shown ? `task:${shown.subtaskId}` : null;

  const findBarRef = useRef(findBar);
  findBarRef.current = findBar;
  const lastRect = useRef<DOMRect>(EMPTY_RECT);
  const anchor = useMemo(() => {
    if (!key) return undefined;
    return {
      get contextElement() { return findBarRef.current(key) ?? undefined; },
      getBoundingClientRect: () => {
        const bar = findBarRef.current(key);
        if (bar?.isConnected) lastRect.current = bar.getBoundingClientRect();
        return lastRect.current;
      },
    };
  }, [key]);

  const finalFocus = useCallback(() => {
    const active = document.activeElement;
    const outside = active instanceof HTMLElement && active !== document.body && active.isConnected && !active.closest('[data-slot="popover-content"]');
    if (outside) return false;
    return (key ? findBarRef.current(key) : null) ?? true;
  }, [key]);

  if (!shown || !anchor) return null;
  const { row, street, projectDefault } = shown;
  return (
    <SubtaskScheduleControl<LatestSubtaskSummary>
      owner={`gantt-bar-${row.id}`}
      label={`Schedule for ${row.title}, ${street}`}
      value={row.schedule}
      open={editor !== null}
      setOpen={(next) => { if (!next) close.closed(); }}
      busy={busy}
      error={editor ? scheduleErrorFromEditor(editor) : undefined}
      retained={retainedFor(row.id)}
      onSave={close.onSave}
      onUseLatest={close.onUseLatest}
      onUseLatestItem={close.onUseLatest}
      projectDefault={projectDefault}
      reminders={{ offsets: row.reminders.offsetsMinutes, next: row.reminders.nextOccurrence }}
      anchor={anchor}
      finalFocus={finalFocus}
      popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE}
      popupCollisionPadding={shellAwarePopupPadding}
    />
  );
}
