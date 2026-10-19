import { describe, expect, it } from "vitest";
import { dueToday, stageTone } from "./dashboard-appearance";
import { projectAppearance, stageGroupAppearance, type AppearanceProject } from "./dashboard-project-appearance";

/** Mon 19 Oct 2026, 12:00 in Sydney (AEDT, UTC+11). */
const NOW = Date.parse("2026-10-19T01:00:00Z");
const TODAY_17 = Date.parse("2026-10-19T06:00:00Z");
const TODAY_09 = Date.parse("2026-10-18T22:00:00Z");
const DAY = 86_400_000;

const project = (over: Partial<AppearanceProject> = {}): AppearanceProject => ({ stageKey: "editing", deadlineAt: NOW + 2 * DAY, archivedAt: null, ...over });

describe("projectAppearance: the tone per Stage (#923)", () => {
  it.each(["awaiting_raw", "raw_review", "editing", "editing_autohdr", "edited_review", "delivered"])("%s takes stageTone's tone", (stageKey) => {
    expect(projectAppearance(project({ stageKey }), NOW).tone).toEqual(stageTone(stageKey));
  });

  it("draws editing_autohdr as Editing", () => {
    expect(projectAppearance(project({ stageKey: "editing_autohdr" }), NOW).tone.stage).toBe("editing");
  });
});

describe("projectAppearance: late and due today", () => {
  it("is late, with a label, when the Deadline has passed", () => {
    const a = projectAppearance(project({ deadlineAt: NOW - 3 * DAY }), NOW);
    expect(a.lateness).toEqual({ late: true, daysLate: 3 });
    expect(a.lateLabel).toBe("3 days late");
    expect(a.dueToday).toBe(false);
  });

  it("calls Edited review late (it is not a terminal Stage)", () => {
    expect(projectAppearance(project({ stageKey: "edited_review", deadlineAt: NOW - DAY }), NOW).lateLabel).toBe("1 day late");
  });

  it("never calls Delivered or archived late", () => {
    expect(projectAppearance(project({ stageKey: "delivered", deadlineAt: NOW - 5 * DAY }), NOW).lateness).toEqual({ late: false });
    const archived = projectAppearance(project({ deadlineAt: NOW - 5 * DAY, archivedAt: "2026-10-01T00:00:00Z" }), NOW);
    expect(archived.lateness).toEqual({ late: false });
    expect(archived.lateLabel).toBeNull();
  });

  it("is due today (and not late) for a Deadline later today", () => {
    const a = projectAppearance(project({ deadlineAt: TODAY_17 }), NOW);
    expect(a.dueToday).toBe(true);
    expect(a.lateLabel).toBeNull();
  });

  it("is late today, not due today, for a Deadline earlier today", () => {
    const a = projectAppearance(project({ deadlineAt: NOW - 3_600_000 }), NOW);
    expect(a.dueToday).toBe(false);
    expect(a.lateLabel).toBe("Late today");
  });

  it("uses the Sydney civil day: 09:00 Sydney today is today, 22:00Z the day before", () => {
    expect(dueToday({ stageKey: "editing", deadlineAt: TODAY_09 + 4 * 3_600_000, archived: false }, TODAY_09)).toBe(true);
  });

  it("is not due today for tomorrow or no Deadline", () => {
    expect(projectAppearance(project({ deadlineAt: NOW + DAY }), NOW).dueToday).toBe(false);
    expect(projectAppearance(project({ deadlineAt: null }), NOW).dueToday).toBe(false);
  });
});

describe("projectAppearance: done", () => {
  it("is null without a checklist (unknown), and for a Project with no Subtasks", () => {
    expect(projectAppearance(project(), NOW).done).toBeNull();
    expect(projectAppearance(project({ checklist: { completed: 0, total: 0 } }), NOW).done).toBeNull();
  });

  it("counts a partial and a full checklist", () => {
    expect(projectAppearance(project({ checklist: { completed: 2, total: 5 } }), NOW).done).toEqual({ done: 2, total: 5, label: "2 of 5 done" });
    expect(projectAppearance(project({ checklist: { completed: 3, total: 3 } }), NOW).done?.label).toBe("3 of 3 done");
  });
});

describe("stageGroupAppearance", () => {
  it("counts rows, late rows, the oldest lateness and sums the known done counts", () => {
    const rows = [
      project({ deadlineAt: NOW - 2 * DAY, checklist: { completed: 1, total: 4 } }),
      project({ deadlineAt: NOW - 9 * DAY, checklist: { completed: 2, total: 3 } }),
      project({ deadlineAt: NOW + DAY }),
    ];
    expect(stageGroupAppearance(rows, NOW)).toEqual({ count: 3, lateCount: 2, oldestDaysLate: 9, done: { done: 3, total: 7, label: "3 of 7 done" } });
  });

  it("has no oldest lateness when nothing is late, and a null done when no count is known", () => {
    const g = stageGroupAppearance([project(), project({ stageKey: "delivered", deadlineAt: NOW - DAY })], NOW);
    expect(g).toEqual({ count: 2, lateCount: 0, oldestDaysLate: null, done: null });
  });

  it("handles an empty group", () => {
    expect(stageGroupAppearance([], NOW)).toEqual({ count: 0, lateCount: 0, oldestDaysLate: null, done: null });
  });
});
