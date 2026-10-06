import { useEffect, useRef, type ComponentProps, type ComponentPropsWithRef, type ReactNode } from "react";
import { POPOVER_LABEL } from "../AnchoredPopover";
import { formatCivilSchedule } from "../../lib/date-format";
import { deadlineOffsetLabel, type ChecklistScheduleDto, type ProjectDefaultRangeDto, type RangeChecklistScheduleInput, type SubtaskRemindersDto } from "@quincy/shared";
import { cn } from "../../lib/utils";
import { META_TEXT } from "./Eyebrow";
import { Notice } from "./Notice";
import { StatusPill } from "./StatusPill";
import { buttonClasses } from "./Button";
import { META_TRIGGER } from "./icon-button";
import { Popover, PopoverTrigger } from "../reui/popover";
import { DateTimePopoverContent } from "./DateTimeField";
import { sameReminderOffsets } from "@/lib/date-time-field";
import { DateTimeRangePopup, type DateTimeRangeApply } from "./date-time-field/DateTimeRangePopup";
import type { DateTimeReminders } from "./date-time-field/DateTimePopup";
import type { ProjectSubtask } from "../../lib/project-data";

const formatSchedule = formatCivilSchedule;
type Subtask = ProjectSubtask;

// TB8-07 §5.4 — the composer trigger's compact-arm treatment. `META_TRIGGER`, not
// `ICON_BUTTON`/`IconButton`: the schedule/assignee triggers can hold a value chip
// (a formatted schedule string or an assignee's initials), same as the row triggers
// §5.2 gives `META_TRIGGER` to. A fixed-width glyph button would overflow. This
// The composer's trigger differs from the row's only in carrying a visible border:
// it sits in a control row rather than in a hovered list row, so it needs its own
// edge. Both arms are `META_TRIGGER` now; the hover-reveal both used to depend on
// is gone (§5.2).
const COMPOSER_TRIGGER_CLASSES = cn(META_TRIGGER, "border-solid border-[length:var(--border-width-hair)] border-border");

// A Subtask is always a range, and every end is a moment (ADR 0016), so the editor saves only that shape.
// `reminderOffsetsMinutes` rides along only when the draft set differs from the saved one the popup showed (#425); absent keeps the stored set server-side, so a range-only edit never clobbers a set changed elsewhere.
export type RangeScheduleRequest = { expectedVersion: number; schedule: RangeChecklistScheduleInput; reminderOffsetsMinutes?: number[] };
/** What the latest-item notice reads of a Subtask: the Checklist hands its whole item, the Gantt a summary of its own decoded conflict body. */
export type LatestSubtaskSummary = { title: string; done: boolean; assignees: Array<{ name: string }>; otherAssigneeCount?: number; schedule: ChecklistScheduleDto; reminders?: SubtaskRemindersDto };

/** "1 day, 1 hour, Due now": the stored advance offsets, then the always-on Due now. */
export function formatReminderSet(offsets: readonly number[]): string {
  return [...offsets.map((offset) => deadlineOffsetLabel(offset)), "Due now"].join(", ");
}
export type ScheduleError<TItem extends LatestSubtaskSummary = Subtask> = {
  endpoint?: "start" | "end";
  choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
  current?: ChecklistScheduleDto;
  /** The latest reminders a schedule conflict carries (#425), so a reapply and the strip start from what the server has now. */
  currentReminders?: SubtaskRemindersDto;
  currentSubtask?: TItem;
  /** A caller-supplied validation sentence (the Gantt's controller names why a range is refused); shown in place of the generic one. */
  message?: string;
};

export type SubtaskPopoverKind = "schedule" | "actions";
export function subtaskPopoverId(owner: string, kind: SubtaskPopoverKind) { return `subtask-popover-${owner}-${kind}`; }

// The draft a failed schedule save retains (what Apply handed over), and the version it was opened against. #377 moves a row between the
// open list and the "Completed" group when Done toggles, which remounts its ScheduleControl, so SubtaskChecklist owns one of these per item id.
export type RetainedSchedule = { draft: DateTimeRangeApply | null; baseVersion: number | null };

/** What a caller-supplied `trigger` must spread onto its element so the popover anchors, opens and announces itself. */
export type SubtaskScheduleTriggerProps = ComponentPropsWithRef<"button">;

const storedRange = (value: ChecklistScheduleDto | null): ProjectDefaultRangeDto | null => value
  ? { start: { localCivil: value.start.localCivil, fold: value.start.fold }, end: { localCivil: value.end.localCivil, fold: value.end.fold } }
  : null;

export function SubtaskScheduleControl<TItem extends LatestSubtaskSummary = Subtask>({ owner, label, value, open, setOpen, onSave, onUseLatest, onUseLatestItem, busy, compact = false, error, defaultLabel, retained: retainedProp, trigger, anchor, finalFocus, initialFocus = "first", projectDefault = null, reminders, readOnly = false }: { owner: string; label: string; value: ChecklistScheduleDto | null; defaultLabel?: string; open: boolean; setOpen: (open: boolean) => void; onSave: (value: RangeScheduleRequest) => void; onUseLatest?: (value: ChecklistScheduleDto, reminders?: SubtaskRemindersDto) => void; onUseLatestItem?: (value: TItem) => void; busy: boolean; compact?: boolean; error?: ScheduleError<TItem>; retained?: RetainedSchedule;
  /** Replaces the built-in trigger (the Gantt's Due cell). The popover keeps `aria-label={label}` either way. */
  trigger?: (props: SubtaskScheduleTriggerProps) => ReactNode;
  /** External-anchor mode (#582): no trigger renders at all and the popup sits on this element or virtual element, read live by the positioner. Mutually exclusive with `trigger`. */
  anchor?: ComponentProps<typeof DateTimePopoverContent>["anchor"];
  /** Where focus goes when an external-anchor popup closes (there is no trigger to return it to). Needs `anchor`. */
  finalFocus?: ComponentProps<typeof DateTimePopoverContent>["finalFocus"];
  /** Which end the popup opens on: the Start (the Checklist), or the End (the Gantt's Due cell). */
  initialFocus?: "first" | "end";
  /** The Project's default range, for the popup's "Project default" shortcut; null hides it. */
  projectDefault?: ProjectDefaultRangeDto | null;
  /** The Subtask's reminder set for the popup's strip (#425). `next` undefined hides the saved next-reminder line (a new Subtask). Omit for a range-only popup. */
  reminders?: DateTimeReminders;
  /** The schedule as a plain pill with no trigger and no popup: an archived Project's Checklist (#450). */
  readOnly?: boolean }) {
  const ownRetained = useRef<RetainedSchedule>({ draft: null, baseVersion: null });
  const retained = retainedProp ?? ownRetained.current;
  // A failed save keeps the draft Apply handed over, because the conflict is shown after the popup closes and the user must be able
  // to reopen it and reapply the retained draft. While the popup is open its own draft belongs to it; a refetch never replaces it.
  useEffect(() => {
    if (open) {
      if (retained.baseVersion === null) retained.baseVersion = value?.version ?? 0;
      return;
    }
    if (busy || error) return;
    retained.baseVersion = null;
    retained.draft = null;
  }, [open, value, busy, error, retained]);
  const id = subtaskPopoverId(owner, "schedule");
  const stored = storedRange(value) ?? projectDefault;
  const seed = error && retained.draft ? retained.draft : undefined;
  // After a conflict the saved set is the latest one the server reported, not the stale row's.
  const latestReminders = error?.currentReminders ?? error?.currentSubtask?.reminders;
  const popupReminders: DateTimeReminders | undefined = reminders && (latestReminders ? { offsets: latestReminders.offsetsMinutes, next: latestReminders.nextOccurrence } : reminders);
  const apply = (next: DateTimeRangeApply) => {
    // Retain the offsets only when this save intends to change them (they differ from the set the popup showed). Otherwise a reapply after
    // someone else changed the set would resend our stale copy; stripping them lets the reopened popup show the latest set and the reapply leave it out.
    const changesOffsets = !!next.reminderOffsetsMinutes && !(popupReminders && sameReminderOffsets(next.reminderOffsetsMinutes, popupReminders.offsets));
    const { reminderOffsetsMinutes: _unused, ...rangeOnly } = next;
    retained.draft = changesOffsets ? next : rangeOnly;
    onSave({ expectedVersion: error?.current?.version ?? retained.baseVersion ?? value?.version ?? 0, schedule: { state: "range", start: next.start, end: next.end }, ...(changesOffsets ? { reminderOffsetsMinutes: next.reminderOffsetsMinutes } : {}) });
  };
  const discard = () => { retained.baseVersion = null; retained.draft = null; };
  const triggerClass = compact ? COMPOSER_TRIGGER_CLASSES : META_TRIGGER;
  const valueText = value ? formatSchedule(value) : defaultLabel;
  const feedback = <>
    {error && !error.current && !error.currentSubtask && <Notice tone="critical" role="alert">{error.message ?? "The schedule could not be saved. Review the highlighted fields."}</Notice>}
    {error?.currentSubtask ? <Notice tone="caution" role="status" className="grid gap-[var(--space-2)] text-[length:var(--text-xs)]"><strong>Latest checklist item · schedule v{error.currentSubtask.schedule.version}</strong><dl className="grid gap-[var(--space-1)] m-0"><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Title</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.title}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Done</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.done ? "Complete" : "Open"}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Assignees</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{error.currentSubtask.assignees.length ? error.currentSubtask.assignees.map((person) => person.name).join(", ") : "Unassigned"}{error.currentSubtask.otherAssigneeCount ? ` and ${error.currentSubtask.otherAssigneeCount} other${error.currentSubtask.otherAssigneeCount === 1 ? "" : "s"}` : ""}</dd></div><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Schedule</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatSchedule(error.currentSubtask.schedule)}</dd></div>{error.currentSubtask.reminders && <div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Reminders</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatReminderSet(error.currentSubtask.reminders.offsetsMinutes)}</dd></div>}</dl><div className="flex flex-wrap gap-[var(--space-2)]"><button type="button" className={buttonClasses("secondary")} disabled={busy} onClick={() => { onUseLatestItem?.(error.currentSubtask!); setOpen(false); }}>Use latest item (discard draft)</button></div><span className={cn(META_TEXT, "!normal-case")}>Apply reapplies your retained schedule draft; Cancel discards it.</span></Notice> : error?.current && <Notice tone="caution" role="status" className="grid gap-[var(--space-2)] text-[length:var(--text-xs)]"><strong>Latest schedule · v{error.current.version}</strong><dl className="grid gap-[var(--space-1)] m-0"><div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Schedule</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatSchedule(error.current)}</dd></div>{error.currentReminders && <div className="flex items-baseline justify-between gap-[var(--space-3)]"><dt className={POPOVER_LABEL}>Reminders</dt><dd className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground">{formatReminderSet(error.currentReminders.offsetsMinutes)}</dd></div>}</dl><div className="flex flex-wrap gap-[var(--space-2)]"><button type="button" className={buttonClasses("secondary")} disabled={busy} onClick={() => { onUseLatest?.(error.current!, error.currentReminders); setOpen(false); }}>Use latest schedule (discard draft)</button></div><span className={cn(META_TEXT, "!normal-case")}>Apply reapplies your retained schedule draft; Cancel discards it.</span></Notice>}
  </>;
  if (readOnly) return valueText ? <StatusPill tone="neutral" className="min-w-0"><span className="sr-only">Schedule </span><span className="block truncate min-w-0">{valueText}</span></StatusPill> : null;
  if (anchor !== undefined && trigger) throw new Error("SubtaskScheduleControl: `anchor` and `trigger` are mutually exclusive");
  return <Popover open={open} onOpenChange={setOpen}>
    {anchor === undefined && <PopoverTrigger
      disabled={busy}
      aria-controls={open ? id : undefined}
      render={(props) => trigger
        ? trigger({ ...props, disabled: busy } as SubtaskScheduleTriggerProps) as React.ReactElement
        : <button {...props} type="button" className={triggerClass} aria-label={compact && defaultLabel ? `${label}: ${valueText}` : label} disabled={busy}>
          {valueText ? <StatusPill tone="neutral" className="min-w-0"><span className="sr-only">Schedule </span><span className="block truncate min-w-0">{valueText}</span></StatusPill> : <span aria-hidden="true">◷</span>}
        </button>}
    />}
    <DateTimePopoverContent label={label} id={id} anchor={anchor} finalFocus={finalFocus}>
      <DateTimeRangePopup
        label={label}
        value={stored}
        projectDefault={projectDefault}
        openOn={initialFocus === "end" ? "end" : "start"}
        seed={seed}
        seedKey={seed ? JSON.stringify(seed) : "stored"}
        reminders={popupReminders}
        feedback={feedback}
        onApply={apply}
        onClose={() => setOpen(false)}
        onCancel={() => { discard(); setOpen(false); }}
      />
    </DateTimePopoverContent>
  </Popover>;
}
