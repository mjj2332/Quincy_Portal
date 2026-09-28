/**
 * #288 — the ONE advisory out-of-range rule for a checklist schedule, shared by the Dashboard Gantt
 * and the Production Calendar. Warn, never block: nothing here ever rejects a write.
 *
 * Each surface builds a `ScheduleBounds` from its own DTO — `ganttScheduleBounds`
 * (`production-gantt-scheduling.ts`) from a `GanttProjectRowDto`, `calendarScheduleBounds` below from
 * the `bounds=1` response's `ProductionCalendarProjectBounds` — both through `scheduleBoundsFrom`, so
 * the lower bound (shoot date, else the Sydney civil date the project was created) and the deadline
 * are derived identically. `scheduleWindowWarnings` then applies the same comparisons to either, and
 * `scheduleWarningText` renders the same sentence for the drop hint, the live announcement and the
 * toast.
 *
 * Time rule: every compared value is Sydney civil, compared lexicographically on
 * `YYYY-MM-DD[THH:mm]`. The lower bound is a civil DATE compare; the deadline compares by date when
 * either side is date-kind, else by minute.
 *
 * Imports only `@quincy/shared`.
 */
import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  type InitialChecklistScheduleInput,
  type ProductionCalendarProjectBounds,
} from "@quincy/shared";

export type SchedulingWarningCode = "subtask_before_project_shoot" | "subtask_before_project_created" | "subtask_after_project_deadline";
export type SchedulingWarning = { code: SchedulingWarningCode; message: string; endpoint: "start" | "end" };

/** Never null itself; a call site that may lack bounds uses `ScheduleBounds | null`. */
export type ScheduleBounds = {
  /** `kind: "created"` is display-only — never written anywhere. */
  lower: { civilDate: string; kind: "shoot" | "created" } | null;
  deadlineLocalCivil: string | null;
};

// ---------------------------------------------------------------------------
// Sydney civil helpers
// ---------------------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in Sydney, or null for an invalid instant. */
export function sydneyCivilMinute(instant: Date | string): string | null {
  const value = formatSydneyCivilMinute(instant instanceof Date ? instant.getTime() : instant);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && isSydneyCalendarDate(value.slice(0, 10)) ? value : null;
}

/** "YYYY-MM-DD" in Sydney, or null for an invalid instant. */
export function sydneyCivilDate(instant: Date | string): string | null {
  return sydneyCivilMinute(instant)?.slice(0, 10) ?? null;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Lower bound: the shoot date if present, else the Sydney civil date of `createdAt`, else none. */
export function scheduleBoundsFrom(input: { shootDateCivil: string | null; createdAt: string | null; deadlineLocalCivil: string | null }): ScheduleBounds {
  let lower: ScheduleBounds["lower"] = null;
  if (input.shootDateCivil) {
    lower = { civilDate: input.shootDateCivil, kind: "shoot" };
  } else if (input.createdAt) {
    const created = sydneyCivilDate(input.createdAt);
    lower = created ? { civilDate: created, kind: "created" } : null;
  }
  return { lower, deadlineLocalCivil: input.deadlineLocalCivil };
}

export function calendarScheduleBounds(entry: ProductionCalendarProjectBounds): ScheduleBounds {
  return scheduleBoundsFrom({ shootDateCivil: entry.shootDate, createdAt: entry.createdAt, deadlineLocalCivil: entry.deadlineLocalCivil });
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** `civil`'s DATE before the lower bound's civil date. */
export function beforeLowerBound(civil: string, lower: ScheduleBounds["lower"]): boolean {
  return lower !== null && civil.slice(0, 10) < lower.civilDate;
}

/** By date when EITHER side is date-kind (a date-only deadline has no `T`), else by minute. */
export function endsAfterDeadline(end: { kind: string; localCivil: string }, deadlineLocalCivil: string | null): boolean {
  if (!deadlineLocalCivil) return false;
  const byDate = end.kind === "date" || !deadlineLocalCivil.includes("T");
  const endCivil = byDate ? end.localCivil.slice(0, 10) : end.localCivil;
  const boundCivil = byDate ? deadlineLocalCivil.slice(0, 10) : deadlineLocalCivil;
  return endCivil > boundCivil;
}

/**
 * Advisory only. A `range` checks its START against the lower bound, a `due_only` its end (its only
 * endpoint); both check the end against the deadline. `null` bounds (none known) → `[]`.
 */
export function scheduleWindowWarnings(schedule: InitialChecklistScheduleInput, bounds: ScheduleBounds | null): SchedulingWarning[] {
  if (!bounds || schedule.state === "unscheduled") return [];
  const dueOnly = schedule.state === "due_only";
  const warnings: SchedulingWarning[] = [];

  if (bounds.lower) {
    const endpoint = dueOnly ? schedule.end : schedule.start;
    if (beforeLowerBound(endpoint.localCivil, bounds.lower)) {
      const shoot = bounds.lower.kind === "shoot";
      warnings.push({
        code: shoot ? "subtask_before_project_shoot" : "subtask_before_project_created",
        message: `${dueOnly ? "Due" : "Starts"} before ${shoot ? "the shoot date" : "the project was created"}.`,
        endpoint: dueOnly ? "end" : "start",
      });
    }
  }

  if (endsAfterDeadline(schedule.end, bounds.deadlineLocalCivil)) {
    warnings.push({ code: "subtask_after_project_deadline", message: `${dueOnly ? "Due" : "Ends"} after the project deadline.`, endpoint: "end" });
  }

  return warnings;
}

/** The warnings as one sentence run (e.g. "Starts before the shoot date. Ends after the project deadline."), or `null`. */
export function scheduleWarningText(warnings: SchedulingWarning[]): string | null {
  return warnings.length === 0 ? null : warnings.map((warning) => warning.message).join(" ");
}
