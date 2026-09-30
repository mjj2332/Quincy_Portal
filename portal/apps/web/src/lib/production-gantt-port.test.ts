import { describe, expect, it } from "vitest";
import type { CalendarPerson, GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import { adoptGanttChecklist, adoptGanttChecklistRow, adoptGanttChecklistSchedule, adoptGanttChildRows, adoptGanttChildSchedule } from "./production-gantt-port";
import type { ChecklistMutationResult } from "./scheduling-types";

const person = (n: number): CalendarPerson => ({ id: `33333333-3333-4333-8333-00000000000${n}`, name: `Person ${n}`, roleLabel: "Editor", isExternal: false, active: true });
const endpoint = (civil: string) => ({ kind: "date" as const, localCivil: civil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const schedule = (version: number, civil = "2026-06-10") => ({ state: "range" as const, version, zone: "Australia/Sydney" as const, start: endpoint(civil), end: endpoint(civil), due: civil });

function row(overrides: Partial<GanttChecklistRowDto> = {}): GanttChecklistRowDto {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    title: "Edit",
    done: false,
    position: 0,
    assignees: [person(1)],
    otherAssigneeCount: 0,
    assignmentVersion: 2,
    schedule: schedule(4),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...overrides,
  } as GanttChecklistRowDto;
}

function result(overrides: Partial<ChecklistMutationResult> = {}): ChecklistMutationResult {
  return { id: row().id, title: "Edit", done: false, assignees: [person(1)], position: 0, schedule: schedule(4), scheduleVersion: 4, ...overrides };
}

describe("adoptGanttChecklistRow — assignees (#372)", () => {
  it("adopts the list, hidden count and version when the result's assignmentVersion is higher", () => {
    const next = adoptGanttChecklistRow(row(), result({ assignees: [person(2), person(3)], otherAssigneeCount: 1, assignmentVersion: 3 }));
    expect(next.assignees.map((p) => p.id)).toEqual([person(2).id, person(3).id]);
    expect(next.otherAssigneeCount).toBe(1);
    expect(next.assignmentVersion).toBe(3);
    // The schedule rule is independent: the schedule version did not move, so the schedule is untouched.
    expect(next.schedule.version).toBe(4);
  });

  it("ignores a result whose assignmentVersion is equal or lower", () => {
    const current = row({ assignmentVersion: 5 });
    expect(adoptGanttChecklistRow(current, result({ assignees: [person(2)], assignmentVersion: 5 }))).toBe(current);
    expect(adoptGanttChecklistRow(current, result({ assignees: [person(2)], assignmentVersion: 4 }))).toBe(current);
  });

  it("ignores a result that carries no assignee data (an older or schedule-only response)", () => {
    const current = row();
    expect(adoptGanttChecklistRow(current, result({ assignees: null }))).toBe(current);
    expect(adoptGanttChecklistRow(current, result({ assignees: [person(2)] }))).toBe(current);
  });

  it("a staff result (a full list, no hidden count) clears the hidden count", () => {
    const current = row({ otherAssigneeCount: 3 });
    const next = adoptGanttChecklistRow(current, result({ assignees: [person(2)], assignmentVersion: 9 }));
    expect(next.otherAssigneeCount).toBe(0);
    expect(next.assignees).toHaveLength(1);
  });

  it("adopts a newer schedule and a newer assignee list independently", () => {
    const newerScheduleOnly = adoptGanttChecklistRow(row(), result({ schedule: schedule(5, "2026-06-11"), scheduleVersion: 5, done: true }));
    expect(newerScheduleOnly.schedule.version).toBe(5);
    expect(newerScheduleOnly.done).toBe(true);
    expect(newerScheduleOnly.assignees.map((p) => p.id)).toEqual([person(1).id]);
    const both = adoptGanttChecklistRow(row(), result({ schedule: schedule(5, "2026-06-11"), scheduleVersion: 5, assignees: [person(2)], assignmentVersion: 3 }));
    expect(both.schedule.version).toBe(5);
    expect(both.assignees.map((p) => p.id)).toEqual([person(2).id]);
    // An older schedule with a newer list: the list lands, the schedule does not roll forward or back.
    const olderSchedule = adoptGanttChecklistRow(row(), result({ schedule: schedule(3, "2026-06-01"), scheduleVersion: 3, assignees: [person(2)], assignmentVersion: 3 }));
    expect(olderSchedule.schedule.version).toBe(4);
    expect(olderSchedule.assignees.map((p) => p.id)).toEqual([person(2).id]);
  });

  it("copies the people instead of aliasing the result", () => {
    const incoming = [person(2)];
    const next = adoptGanttChecklistRow(row(), result({ assignees: incoming, assignmentVersion: 3 }));
    expect(next.assignees[0]).not.toBe(incoming[0]);
  });
});

describe("adoptGanttChecklist — assignees (#372)", () => {
  it("replaces only the matching row and returns the baseline itself when nothing changes", () => {
    const other = row({ id: "44444444-4444-4444-8444-444444444444" });
    const project = { id: "11111111-1111-4111-8111-111111111111", children: { rows: [row(), other], total: 2, returned: 2, truncated: false, nextCursor: null } } as unknown as GanttProjectRowDto;
    const baseline = { projects: [project] };
    const changed = adoptGanttChecklist(baseline, result({ assignees: [person(2)], assignmentVersion: 3 }));
    expect(changed.projects[0]!.children.rows[0]!.assignees.map((p) => p.id)).toEqual([person(2).id]);
    expect(changed.projects[0]!.children.rows[1]).toBe(other);
    expect(adoptGanttChecklist(baseline, result({ assignees: [person(2)], assignmentVersion: 2 }))).toBe(baseline);
  });
});

describe("adoptGanttChildRows — later-page rows (#372)", () => {
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const state = (rows: GanttChecklistRowDto[]) => ({ rows, seedSignature: "sig", complete: false });

  it("carries a saved assignee list into the page-2+ row's own baseline, leaving other rows and projects alone", () => {
    const other = row({ id: "44444444-4444-4444-8444-444444444444" });
    const otherProject = state([row()]);
    const current = { [PROJECT]: state([row(), other]), "other-project": otherProject };
    const next = adoptGanttChildRows(current, PROJECT, result({ assignees: [person(2), person(3)], otherAssigneeCount: 1, assignmentVersion: 3 }));
    const adopted = next[PROJECT]!.rows[0]!;
    expect(adopted.assignees.map((p) => p.id)).toEqual([person(2).id, person(3).id]);
    expect(adopted.otherAssigneeCount).toBe(1);
    expect(adopted.assignmentVersion).toBe(3);
    expect(next[PROJECT]!.rows[1]).toBe(other);
    expect(next[PROJECT]!.seedSignature).toBe("sig");
    expect(next["other-project"]).toBe(otherProject);
  });

  it("is version-wins: an equal or older result, an unknown project and a result for no row return the same state object", () => {
    const current = { [PROJECT]: state([row({ assignmentVersion: 5 })]) };
    expect(adoptGanttChildRows(current, PROJECT, result({ assignees: [person(2)], assignmentVersion: 5 }))).toBe(current);
    expect(adoptGanttChildRows(current, PROJECT, result({ assignees: [person(2)], assignmentVersion: 4 }))).toBe(current);
    expect(adoptGanttChildRows(current, "unknown", result({ assignees: [person(2)], assignmentVersion: 9 }))).toBe(current);
    expect(adoptGanttChildRows(current, PROJECT, result({ id: "55555555-5555-4555-8555-555555555555", assignees: [person(2)], assignmentVersion: 9 }))).toBe(current);
  });
});

describe("adoptGanttChecklistSchedule — a schedule-only conflict body (#372)", () => {
  it("adopts a strictly newer schedule and changes no title, Done or assignee metadata", () => {
    const current = row({ done: true, title: "Keep me" });
    const next = adoptGanttChecklistSchedule(current, schedule(5, "2026-06-12"));
    expect(next.schedule.version).toBe(5);
    expect(next.schedule.end.localCivil).toBe("2026-06-12");
    expect(next.done).toBe(true);
    expect(next.title).toBe("Keep me");
    expect(next.assignees).toBe(current.assignees);
    expect(next.assignmentVersion).toBe(current.assignmentVersion);
  });

  it("ignores an equal or older schedule and returns the row itself", () => {
    const current = row();
    expect(adoptGanttChecklistSchedule(current, schedule(4, "2026-06-12"))).toBe(current);
    expect(adoptGanttChecklistSchedule(current, schedule(3, "2026-06-12"))).toBe(current);
  });

  it("adoptGanttChildSchedule patches only the named row in a continuation page, and is a no-op for anything not newer", () => {
    const other = row({ id: "22222222-2222-4222-8222-999999999999", title: "Other" });
    const state = { rows: [row(), other], keep: "seed" };
    const next = adoptGanttChildSchedule({ p1: state }, "p1", row().id, schedule(6, "2026-06-13"));
    expect(next.p1!.rows[0]!.schedule.version).toBe(6);
    expect(next.p1!.rows[1]).toBe(other);
    expect(next.p1!.keep).toBe("seed");
    const untouched = { p1: state };
    expect(adoptGanttChildSchedule(untouched, "p1", row().id, schedule(4))).toBe(untouched);
    expect(adoptGanttChildSchedule(untouched, "missing", row().id, schedule(9))).toBe(untouched);
  });
});
