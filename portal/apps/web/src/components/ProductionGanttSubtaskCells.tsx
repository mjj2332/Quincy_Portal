/**
 * #372 (range end) — the Gantt's Due cell for a Subtask row: the end of its range, and for a viewer who may edit the
 * schedule (`permissions.canOpenScheduleEditor`) the Checklist's own range picker (`quincy/SubtaskScheduleControl`)
 * opened on End. Plain props, and nothing imported from `reui/gantt/`: `ProductionGantt.tsx` is the only file allowed to
 * reach the vendor scheduling tree (`ProductionGantt.import-boundary.guard.test.ts`).
 *
 * The cell owns presentation only. The write, the version it is made at, the lock, the optimistic bar, Undo and the
 * settle refetch belong to the scheduling controller (`use-scheduling-commands`), which `ProductionGantt` drives through
 * `openChecklistScheduleEditor(source, undefined, { inline: true })` (the default `inlineTarget: "due-cell"`; the item menu's bar picker, #582, is `"item"` and drawn by `ProductionGanttScheduleEditorPopover`) / `submitScheduleEditor` / `cancelScheduleEditor`;
 * `open` is derived from the controller's editor session, never held here.
 *
 * Reminders (#425): the picker's strip is `RemindersStrip` inside `DateTimeRangePopup`, fed from `row.reminders`; no new element here.
 *
 * Reuse ledger: trigger — `reui/button` `size="xs" variant="ghost"` with the Project Due cell's `CELL_TRIGGER`; picker —
 * `quincy/SubtaskScheduleControl` (the Checklist's `ScheduleControl`, moved whole); read-only value — plain `<time>`;
 * the wrapper that keeps a press or key off the row — a plain `<span>` carrying `stopPropagation` (the People cell's pattern).
 */
import { useRef } from "react";
import type { GanttChecklistRowDto, ProjectDefaultRangeDto, RangeChecklistScheduleInput } from "@quincy/shared";
import { formatDueCivil } from "../lib/date-format";
import type { ScheduleEditorState } from "../lib/use-scheduling-commands";
import { cn } from "../lib/utils";
import { CELL_TRIGGER } from "./ProductionGanttProjectCells";
import { SubtaskScheduleControl, type LatestSubtaskSummary, type RetainedSchedule, type ScheduleError } from "./quincy/SubtaskScheduleControl";
import { Button } from "./reui/button";

/** Keeps a click, press or key on the Due cell (or its portaled picker, which bubbles through the React tree) off the row it sits in. */
export const stopRowGesture = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * What the picker shows for the controller's editor state: a fold choice, a conflict's latest schedule or item, or the
 * validation sentence. Only fields the controller already validated and decoded (an External Editor's item is the
 * team-filtered DTO, so names and a hidden count are all it can carry).
 */
export function scheduleErrorFromEditor(editor: Pick<ScheduleEditorState, "source" | "validationError" | "latestItem">): ScheduleError<LatestSubtaskSummary> | undefined {
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
 * "Save's own close is not a Cancel", shared by the Due cell and the bar's picker (#582) so the two cannot drift. Save and Use
 * latest already tell the controller what they mean; the popover then calls `setOpen(false)` as well, which must not be read as a
 * Cancel (that would release the lock under a request in flight). `onSave`/`onUseLatest` arm one pass-through; `closed` is what a
 * `false` from the popover calls: it swallows that one close, else cancels (every close but Save and Use latest is a controller Cancel, so a conflicted draft does not survive Escape or an outside press on the Gantt yet: #585; the Checklist caller keeps #423's Cancel-only discard).
 */
export function useSchedulePickerClose({ onSubmit, onCancel }: { onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void; onCancel: () => void }) {
  const closeHandledRef = useRef(false);
  return {
    closed: () => {
      if (closeHandledRef.current) { closeHandledRef.current = false; return; }
      onCancel();
    },
    onSave: (request: { schedule: RangeChecklistScheduleInput; reminderOffsetsMinutes?: number[] }) => { closeHandledRef.current = true; onSubmit(request.schedule, request.reminderOffsetsMinutes); },
    onUseLatest: () => { closeHandledRef.current = true; onCancel(); },
  };
}

export type GanttSubtaskDueCellProps = {
  row: GanttChecklistRowDto;
  /** True while the controller's editor session belongs to THIS row. */
  editorOpen: boolean;
  /**
   * True while another command, a settle refetch, lost access or a bar gesture freezes the chart. The owning editor's
   * own fields are never disabled by its own session: the caller passes `false` for the owner.
   */
  disabled: boolean;
  error?: ScheduleError<LatestSubtaskSummary>;
  /** The draft a failed save keeps; the caller holds it above the vendor tree's rows, which remount. */
  retained: RetainedSchedule;
  onOpen: () => void;
  /** The offsets ride along only when the draft set differs from the saved one (#425); absent keeps the stored set. */
  onSubmit: (schedule: RangeChecklistScheduleInput, reminderOffsetsMinutes?: number[]) => void;
  onCancel: () => void;
  /** The Project's default range, for the picker's "Project default" shortcut (#423). */
  projectDefault?: ProjectDefaultRangeDto | null;
};

// Tone: a Subtask date is always neutral. The Gantt never marks Subtask rows overdue (production-gantt-scheduling.ts sets
// `overdue: false`; only the Project deadline carries a server-computed `overdue`), so this cell does not either.
// Frozen state: `focusableWhenDisabled` renders `aria-disabled`, not `disabled`, so the dimming keys on aria-disabled.
export function GanttSubtaskDueCell({ row, editorOpen, disabled, error, retained, onOpen, onSubmit, onCancel, projectDefault = null }: GanttSubtaskDueCellProps) {
  const end = row.schedule.end;
  const text = formatDueCivil(end.localCivil);
  const close = useSchedulePickerClose({ onSubmit, onCancel });
  if (!row.permissions.canOpenScheduleEditor) {
    return <time data-testid="gantt-subtask-due" dateTime={end.instant ?? end.localCivil} className="truncate text-foreground">{text}</time>;
  }
  return (
    <span data-testid="gantt-subtask-due" className="flex min-w-0 flex-1 items-center" onClick={stopRowGesture} onPointerDown={stopRowGesture} onMouseDown={stopRowGesture} onKeyDown={stopRowGesture}>
      <SubtaskScheduleControl<LatestSubtaskSummary>
        owner={`gantt-${row.id}`}
        label={`Schedule for ${row.title}`}
        value={row.schedule}
        open={editorOpen}
        setOpen={(next) => {
          if (next) {
            if (!disabled) onOpen();
            return;
          }
          close.closed();
        }}
        // The owner's own session is not "busy"; a frozen chart is.
        busy={disabled}
        error={error}
        retained={retained}
        onSave={close.onSave}
        onUseLatest={close.onUseLatest}
        onUseLatestItem={close.onUseLatest}
        initialFocus="end"
        projectDefault={projectDefault}
        reminders={{ offsets: row.reminders.offsetsMinutes, next: row.reminders.nextOccurrence }}
        trigger={({ disabled: triggerDisabled, onClick, ...props }) => (
          <Button
            {...props}
            type="button"
            size="xs"
            variant="ghost"
            className={cn(CELL_TRIGGER, "text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50")}
            data-testid="gantt-subtask-due-trigger"
            aria-label={`Due for ${row.title}: ${text}`}
            disabled={triggerDisabled}
            // Stays focusable while frozen: the trigger holds focus across a Save (the popover hands focus back to it), and a
            // disabled button would drop it to the page.
            focusableWhenDisabled
            onClick={(event) => { if (!triggerDisabled) onClick?.(event); }}
          >
            <time dateTime={end.instant ?? end.localCivil} className="truncate">{text}</time>
          </Button>
        )}
      />
    </span>
  );
}
