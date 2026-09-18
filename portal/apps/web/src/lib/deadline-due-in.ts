import type { ProjectDeadlineSchedule } from "@quincy/shared";

export type DeadlineDueInTone = "critical" | "caution" | "neutral";

export type DeadlineDueIn = { tone: DeadlineDueInTone; label: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;
const CAUTION_THRESHOLD_HOURS = 72;

/**
 * #205 — the countdown badge shown next to the Deadline trigger in `ProjectHeaderDeadline.tsx`.
 * `null` whenever there is nothing worth badging: no deadline set at all, or the schedule's own
 * `state` says reminders are inactive (Delivered/archived) — a stale countdown on a schedule that
 * cannot fire is misleading, not informative.
 */
export function dueIn(schedule: ProjectDeadlineSchedule, nowMs: number): DeadlineDueIn | null {
  if (!schedule.deadline) return null;
  if (schedule.state === "inactive_delivered" || schedule.state === "inactive_archived") return null;

  const instant = new Date(schedule.deadline.instant).getTime();
  if (schedule.state === "overdue" || instant <= nowMs) return { tone: "critical", label: "Overdue" };

  const remainingMs = instant - nowMs;
  const remainingHours = remainingMs / HOUR_MS;
  const tone: DeadlineDueInTone = remainingHours < CAUTION_THRESHOLD_HOURS ? "caution" : "neutral";

  if (remainingHours >= DAY_HOURS) return { tone, label: `Due in ${Math.floor(remainingHours / DAY_HOURS)}d` };
  if (remainingHours >= 1) return { tone, label: `Due in ${Math.floor(remainingHours)}h` };
  const remainingMinutes = remainingMs / (60 * 1000);
  return { tone, label: `Due in ${Math.max(1, Math.floor(remainingMinutes))}m` };
}
