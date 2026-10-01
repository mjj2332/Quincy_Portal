import { describe, expect, it } from "vitest";
import { adoptChecklistResult } from "./scheduling-policy";
import { decodeChecklistMutationResponse } from "./production-calendar-query";
import { oneDayEvent, oneDaySchedule } from "../testing/production-calendar-fixtures";
import type { CalendarPerson, ChecklistCalendarEventDto, ProductionCalendarRangeResponse } from "@quincy/shared";
import { startMoment } from "@/testing/subtask-schedule";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const admin: CalendarPerson = { id: ADMIN_ID, name: "Zelda Adminsson", roleLabel: "Admin", isExternal: false, active: true };
const team: CalendarPerson = { id: TEAM_ID, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true };
const dateAt = startMoment("2026-08-19");

describe("an External Editor's schedule save never reveals a hidden assignee (#370)", () => {
  // Subtask [non-team Admin A, team member B]: the Calendar GET hides A, so the source shows B and "+1".
  const source = oneDayEvent(dateAt, { assignees: [team], otherAssigneeCount: 1 }) as ChecklistCalendarEventDto;
  const response = { range: {} as never, events: [source] } as unknown as ProductionCalendarRangeResponse;
  const schedule = oneDaySchedule(dateAt, 4);
  const body = (over: object) => ({
    id: "33333333-3333-4333-8333-333333333333", title: "Select hero images", done: false, position: 1024,
    assignees: [team], otherAssigneeCount: 1,
    assignmentVersion: 2, dueDate: "2026-08-20", schedule, reminders: { offsetsMinutes: [1440], nextOccurrence: null },
    createdBy: team, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", ...over,
  });

  it("adopts the team-filtered list and count from the mutation response, not the scalar", () => {
    const result = decodeChecklistMutationResponse("external_editor", body({}));
    const next = adoptChecklistResult(response, source, result).events[0] as ChecklistCalendarEventDto;
    const wire = JSON.stringify(next);
    expect(wire).not.toContain(ADMIN_ID);
    expect(wire).not.toContain("Zelda");
    expect(next.assignees.map((person) => person.name)).toEqual(["Maya Editor"]);
    expect(next.otherAssigneeCount).toBe(1);
    expect(next.assignees.map((person) => person.id)).toEqual([TEAM_ID]);
  });
});
