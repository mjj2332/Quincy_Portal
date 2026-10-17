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

const DAY_MS = DAY_HOURS * HOUR_MS;

/** The Sydney civil date (`YYYY-MM-DD`) of an instant: the Deadline's own zone (its `localCivil` is a Sydney wall-clock). */
function sydneyDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function span(ms: number): string {
  const hours = ms / HOUR_MS;
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (hours >= 1) return `${Math.floor(hours)}h`;
  return `${Math.max(1, Math.floor(ms / (60 * 1000)))}m`;
}

export type DeadlineCountdown = DeadlineDueIn & { /** The chip's Badge text: "2d", "Today", "Overdue 3h". */ short: string };

/**
 * #914 — the Deadline chip's countdown (prototype D1/D4/D6). The tones are `dueIn`'s (caution under 72h, critical once overdue);
 * on the due day, judged in Sydney (the Deadline's zone, not the viewer's), it reads "Today". `label` is the long form for the
 * accessible name and the phone project bar. `null` exactly when `dueIn` is.
 */
export function deadlineCountdown(schedule: ProjectDeadlineSchedule, nowMs: number): DeadlineCountdown | null {
  const due = dueIn(schedule, nowMs);
  if (!due || !schedule.deadline) return null;
  const instant = new Date(schedule.deadline.instant).getTime();
  if (due.tone === "critical") return { ...due, short: instant < nowMs ? `Overdue ${span(nowMs - instant)}` : "Overdue" };
  if (schedule.deadline.localCivil.slice(0, 10) === sydneyDate(nowMs)) return { tone: "caution", label: "Due today", short: "Today" };
  return { ...due, short: span(instant - nowMs) };
}
