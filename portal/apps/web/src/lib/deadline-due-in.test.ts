import { describe, expect, it } from "vitest";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { dueIn } from "./deadline-due-in";

const NOW = Date.parse("2027-01-01T00:00:00.000Z");

function schedule(overrides: Partial<ProjectDeadlineSchedule> = {}): ProjectDeadlineSchedule {
  return {
    version: 0,
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
