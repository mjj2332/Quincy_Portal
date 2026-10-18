/**
 * #923: what the Dashboard Table and Board paint for a Project and for a Stage group, from data the Dashboard
 * already loads and a "now". Both views get their appearance from these two functions and never derive it
 * again (plan § Shared rules and adapters). Pure; the rules themselves live in `dashboard-appearance.ts`.
 *
 * `checklist` is typed structurally so this module does not wait on the API (#923 S0). A missing `checklist`
 * means unknown: `done` is `null`, never a "No tasks" count.
 */
import { doneCount, dueToday, lateLabel, projectLateness, stageTone, type Instant, type Lateness, type StageTone } from "./dashboard-appearance";

export type AppearanceProject = {
  stageKey: string | null | undefined;
  deadlineAt: string | number | null;
  archivedAt?: string | null;
  checklist?: { completed: number; total: number };
};

export type ProjectAppearance = {
  tone: StageTone;
  lateness: Lateness;
  /** "Late today", "N days late", or `null` when not late. */
  lateLabel: string | null;
  /** The Deadline is later today (Sydney) and the Project isn't late. */
  dueToday: boolean;
  /** "N of M done"; `null` when there is no `checklist` or the Project has no Subtasks. */
  done: ReturnType<typeof doneCount>;
};

export function projectAppearance(p: AppearanceProject, now: Instant): ProjectAppearance {
  const lifecycle = { stageKey: p.stageKey, deadlineAt: p.deadlineAt, archived: p.archivedAt != null };
  const lateness = projectLateness(lifecycle, now);
  return {
    tone: stageTone(p.stageKey),
    lateness,
    lateLabel: lateLabel(lateness),
    dueToday: dueToday(lifecycle, now),
    done: p.checklist ? doneCount(p.checklist) : null,
  };
}

export type StageGroupAppearance = {
  count: number;
  lateCount: number;
  /** The most days late among the late rows; `null` when none is late. */
  oldestDaysLate: number | null;
  /** The summed "N of M done" over rows whose count is known; `null` when none is known (or none has Subtasks). */
  done: ReturnType<typeof doneCount>;
};

export function stageGroupAppearance(rows: readonly AppearanceProject[], now: Instant): StageGroupAppearance {
  let lateCount = 0;
  let oldest: number | null = null;
  let completed = 0;
  let total = 0;
  for (const row of rows) {
    const { lateness } = projectAppearance(row, now);
    if (lateness.late) {
      lateCount += 1;
      oldest = oldest === null ? lateness.daysLate : Math.max(oldest, lateness.daysLate);
    }
    if (row.checklist) {
      completed += row.checklist.completed;
      total += row.checklist.total;
    }
  }
  return { count: rows.length, lateCount, oldestDaysLate: oldest, done: doneCount({ completed, total }) };
}
