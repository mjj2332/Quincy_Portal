import { describe, expect, it } from "vitest";
import type { CalendarPerson, GanttChecklistRowDto, GanttProjectRowDto } from "@quincy/shared";
import { adoptGanttChecklist, adoptGanttChecklistRow } from "./production-gantt-port";
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
    assignee: person(1),
    assignees: [person(1)],
    otherAssigneeCount: 0,
    assignmentVersion: 2,
    schedule: schedule(4),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...overrides,
  } as GanttChecklistRowDto;
}

function result(overrides: Partial<ChecklistMutationResult> = {}): ChecklistMutationResult {
  return { id: row().id, title: "Edit", done: false, assignee: person(1), assignees: [person(1)], position: 0, schedule: schedule(4), scheduleVersion: 4, ...overrides };
}

describe("adoptGanttChecklistRow — assignees (#372)", () => {
  it("adopts the list, first assignee, hidden count and version when the result's assignmentVersion is higher", () => {
    const next = adoptGanttChecklistRow(row(), result({ assignees: [person(2), person(3)], assignee: person(2), otherAssigneeCount: 1, assignmentVersion: 3 }));
    expect(next.assignees.map((p) => p.id)).toEqual([person(2).id, person(3).id]);
    expect(next.assignee?.id).toBe(person(2).id);
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
