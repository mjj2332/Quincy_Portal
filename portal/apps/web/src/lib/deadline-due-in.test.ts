import { describe, expect, it } from "vitest";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { deadlineCountdown, dueIn } from "./deadline-due-in";

const NOW = Date.parse("2027-01-01T00:00:00.000Z");

function schedule(overrides: Partial<ProjectDeadlineSchedule> = {}): ProjectDeadlineSchedule {
  return {
    version: 0,
    source: null,
    deadline: null,
    reminderOffsetsMinutes: [],
    state: "unset",
    nextOccurrence: null,
    canResume: false,
    ...overrides,
  };
}

function deadlineAt(instant: string): ProjectDeadlineSchedule["deadline"] {
  return { localCivil: "2027-01-05T09:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant };
}

describe("dueIn", () => {
  it("is null when there is no deadline", () => {
    expect(dueIn(schedule(), NOW)).toBeNull();
  });

  it("is null when reminders are inactive because the project is Delivered", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 10_000).toISOString()), state: "inactive_delivered" });
    expect(dueIn(withDeadline, NOW)).toBeNull();
  });

  it("is null when reminders are inactive because the project is archived", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 10_000).toISOString()), state: "inactive_archived" });
    expect(dueIn(withDeadline, NOW)).toBeNull();
  });

  it("is critical Overdue when the schedule's own state says overdue, even if the instant is still in the future", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 10_000).toISOString()), state: "overdue" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "critical", label: "Overdue" });
  });

  it("is critical Overdue when the instant has already passed, regardless of state", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW - 1).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "critical", label: "Overdue" });
  });

  it("is neutral at exactly 72 hours remaining", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 72 * 60 * 60 * 1000).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "neutral", label: "Due in 3d" });
  });

  it("is caution one millisecond short of 72 hours remaining", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 72 * 60 * 60 * 1000 - 1).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "caution", label: "Due in 2d" });
  });

  it("labels in hours at exactly 1 hour remaining", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 60 * 60 * 1000).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "caution", label: "Due in 1h" });
  });

  it("labels in minutes at 59 minutes remaining", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 59 * 60 * 1000).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "caution", label: "Due in 59m" });
  });

  it("floors 30 seconds remaining up to a minimum of 1 minute", () => {
    const withDeadline = schedule({ deadline: deadlineAt(new Date(NOW + 30 * 1000).toISOString()), state: "scheduled" });
    expect(dueIn(withDeadline, NOW)).toEqual({ tone: "caution", label: "Due in 1m" });
  });
});

describe("deadlineCountdown (#914)", () => {
  const at = (localCivil: string, instant: string): ProjectDeadlineSchedule["deadline"] => ({ localCivil, zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant });

  it("is null when there is nothing to badge", () => {
    expect(deadlineCountdown(schedule(), NOW)).toBeNull();
    expect(deadlineCountdown(schedule({ deadline: deadlineAt("2027-01-05T00:00:00.000Z"), state: "inactive_archived" }), NOW)).toBeNull();
  });

  it("reads the days left inside the caution window, and a neutral count outside it", () => {
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-03T11:00", "2027-01-03T00:00:00.000Z"), state: "scheduled" }), NOW)).toEqual({ tone: "caution", label: "Due in 2d", short: "2d" });
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-06T11:00", "2027-01-06T00:00:00.000Z"), state: "scheduled" }), NOW)).toEqual({ tone: "neutral", label: "Due in 5d", short: "5d" });
  });

  it("reads Today on the due day in Sydney, even while the viewer's UTC date is the day before", () => {
    // NOW is 11:00 on 1 Jan in Sydney.
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-01T17:00", "2027-01-01T06:00:00.000Z"), state: "scheduled" }), NOW)).toEqual({ tone: "caution", label: "Due today", short: "Today" });
    // 01:00 on 1 Jan in Sydney is still 31 Dec in UTC.
    const earlySydney = Date.parse("2026-12-31T14:00:00.000Z");
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-01T17:00", "2027-01-01T06:00:00.000Z"), state: "scheduled" }), earlySydney)?.short).toBe("Today");
    // The next Sydney day is not today, though it is only hours away.
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-02T09:00", "2027-01-01T22:00:00.000Z"), state: "scheduled" }), NOW)?.short).toBe("22h");
  });

  it("reads how long ago it fell due once overdue, critical", () => {
    expect(deadlineCountdown(schedule({ deadline: at("2027-01-01T08:00", "2026-12-31T21:00:00.000Z"), state: "overdue" }), NOW)).toEqual({ tone: "critical", label: "Overdue", short: "Overdue 3h" });
  });
});
