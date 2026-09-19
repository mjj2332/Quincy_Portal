import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarEventDto, type ProjectCalendarUnscheduledEntryDto, type ProjectDeadlineCalendarEventDto } from "@quincy/shared";
import { applyUndo, buildChecklistUndoTicket, buildDeadlineUndoTicket } from "./scheduling-undo";
import { projectDeadlinePlaceholder } from "./scheduling-policy";

afterEach(() => vi.unstubAllGlobals());

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_ID = "22222222-2222-4222-8222-222222222222";
const person = { id: PERSON_ID, name: "Editor", roleLabel: "Editor", isExternal: false, active: true };
const project = () => ({ id: PROJECT_ID, street: "1 Example Street", stageKey: "editing" as const, checklist: { completed: 1, total: 3 }, delivered: false });

const dateEndpoint = (localCivil: string) => ({ kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });

function checklistEvent(version: number, start: string, end: string): ChecklistCalendarEventDto<"editing"> {
  const schedule = { state: "range" as const, version, zone: PRODUCTION_CALENDAR_ZONE, start: dateEndpoint(start), end: dateEndpoint(end), due: end };
  return {
    id: `checklist:${PERSON_ID}`,
    kind: "checklist",
    title: "Select hero images",
    project: project(),
    assignee: person,
    timing: { allDay: true, start, end },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule,
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function deadlineEvent(version: number, deadlineLocalCivil: string, reminderOffsetsMinutes: number[], instant = "2026-08-26T23:00:00.000Z"): ProjectDeadlineCalendarEventDto<"editing"> {
  return {
    id: `project-deadline:${PROJECT_ID}`,
    kind: "project_deadline",
    title: "Deadline",
    project: project(),
    timing: { allDay: false, start: instant, end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil,
    deadlineVersion: version,
    reminderOffsetsMinutes,
  };
}

describe("buildChecklistUndoTicket", () => {
  it("builds a checklist ticket at the returned version restoring the prior schedule", () => {
    const before = checklistEvent(4, "2026-08-27", "2026-08-27");
    const ticket = buildChecklistUndoTicket(before, { id: before.id, title: before.title, done: false, assignee: person, position: 0, schedule: { ...before.schedule, version: 5, start: dateEndpoint("2026-08-29"), end: dateEndpoint("2026-08-29"), due: "2026-08-29" }, scheduleVersion: 5 });
    expect(ticket).toEqual({
      kind: "checklist",
      projectId: PROJECT_ID,
      subtaskId: before.id,
      expectedVersion: 5,
      request: { expectedVersion: 5, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-27" } } },
    });
  });

  it("returns null when the forward edit changed nothing", () => {
    const before = checklistEvent(4, "2026-08-27", "2026-08-27");
    const ticket = buildChecklistUndoTicket(before, { id: before.id, title: before.title, done: false, assignee: person, position: 0, schedule: before.schedule, scheduleVersion: 4 });
    expect(ticket).toBeNull();
  });
});

describe("buildDeadlineUndoTicket", () => {
  it("builds a deadline ticket restoring civil + reminder offsets", () => {
    const before = deadlineEvent(8, "2026-08-27T09:00", [1440, 60]);
    const ticket = buildDeadlineUndoTicket(before, { version: 9, deadline: { localCivil: "2026-08-29T09:00", instant: "2026-08-28T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] });
    expect(ticket).toEqual({
      kind: "deadline",
      projectId: PROJECT_ID,
      expectedVersion: 9,
      request: { expectedVersion: 9, deadline: { localCivil: "2026-08-27T09:00" }, reminderOffsetsMinutes: [1440, 60] },
    });
  });

  it("returns null when the forward edit changed nothing", () => {
    const before = deadlineEvent(8, "2026-08-27T09:00", [1440, 60]);
    const ticket = buildDeadlineUndoTicket(before, { version: 8, deadline: { localCivil: "2026-08-27T09:00", instant: "2026-08-26T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] });
    expect(ticket).toBeNull();
  });

  it("does not send a disambiguation for a non-ambiguous civil time", () => {
    const before = deadlineEvent(8, "2026-08-27T09:00", [1440, 60], "2026-08-26T23:00:00.000Z");
    const ticket = buildDeadlineUndoTicket(before, { version: 9, deadline: { localCivil: "2026-08-29T09:00", instant: "2026-08-28T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] });
    expect(ticket?.kind).toBe("deadline");
    if (ticket?.kind !== "deadline") throw new Error("expected a deadline ticket");
    expect(ticket.request.deadline).toEqual({ localCivil: "2026-08-27T09:00" });
  });

  it("round-trips the earlier fold occurrence of the April DST repeat (2026-04-05T02:30)", () => {
    const before = deadlineEvent(8, "2026-04-05T02:30", [1440, 60], "2026-04-04T15:30:00.000Z");
    const ticket = buildDeadlineUndoTicket(before, { version: 9, deadline: { localCivil: "2026-04-06T09:00", instant: "2026-04-05T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] });
    expect(ticket).toMatchObject({ request: { deadline: { localCivil: "2026-04-05T02:30", disambiguation: "earlier" } } });
  });

  it("round-trips the later fold occurrence of the April DST repeat (2026-04-05T02:30)", () => {
    const before = deadlineEvent(8, "2026-04-05T02:30", [1440, 60], "2026-04-04T16:30:00.000Z");
    const ticket = buildDeadlineUndoTicket(before, { version: 9, deadline: { localCivil: "2026-04-06T09:00", instant: "2026-04-05T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] });
    expect(ticket).toMatchObject({ request: { deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" } } });
  });
});

describe("applyUndo", () => {
  const checklistTicket = { kind: "checklist" as const, projectId: PROJECT_ID, subtaskId: `checklist:${PERSON_ID}`, expectedVersion: 5, request: { expectedVersion: 5, schedule: { state: "range" as const, start: { kind: "date" as const, localCivil: "2026-08-27" }, end: { kind: "date" as const, localCivil: "2026-08-27" } } } };
  const deadlineTicket = { kind: "deadline" as const, projectId: PROJECT_ID, expectedVersion: 9, request: { expectedVersion: 9, deadline: { localCivil: "2026-08-27T09:00" }, reminderOffsetsMinutes: [1440, 60] } };

  it("sends the exact PATCH body (incl. expectedVersion) to the same subtask endpoint the forward edit used, and only reports conflict when that exact body was sent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${PROJECT_ID}/subtasks/${encodeURIComponent(checklistTicket.subtaskId)}`);
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body)) as { schedule?: { expectedVersion?: unknown } };
      expect(body).toEqual({ schedule: checklistTicket.request });
      // Conditional on the request, not unconditional: a dropped or corrupted expectedVersion
      // would not match here, the mock would fall through to the 400 below, and the "conflict"
      // assertion would then fail on the outcome instead of the mock silently agreeing.
      if (body.schedule?.expectedVersion !== checklistTicket.expectedVersion) {
        return new Response(JSON.stringify({ message: "unexpected body" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "stale", code: "subtask_schedule_version_conflict" }), { status: 409, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyUndo(checklistTicket);
    expect(outcome).toEqual({ ok: false, reason: "conflict" });
  });

  it("sends the exact PUT body (incl. expectedVersion) to the same deadline endpoint the forward edit used, and only reports conflict when that exact body was sent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${PROJECT_ID}/deadline`);
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body)) as { expectedVersion?: unknown };
      expect(body).toEqual(deadlineTicket.request);
      if (body.expectedVersion !== deadlineTicket.expectedVersion) {
        return new Response(JSON.stringify({ message: "unexpected body" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "stale", code: "deadline_version_conflict" }), { status: 409, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyUndo(deadlineTicket);
    expect(outcome).toEqual({ ok: false, reason: "conflict" });
  });

  it("reports failed on a 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyUndo(checklistTicket);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  it("succeeds and hits the same endpoint the forward edit used, with the exact PUT body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${PROJECT_ID}/deadline`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual(deadlineTicket.request);
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyUndo(deadlineTicket);
    expect(outcome).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // §216 fix round 5 item 5: undoing a project-deadline PLACEMENT from unscheduled — `before` is
  // `projectDeadlinePlaceholder(entry)`, not a real deadline event — must send the versioned CLEAR
  // request (`deadline: null`, no `reminderOffsetsMinutes`), never `deadline: { localCivil: "Not
  // scheduled" }`.
  it("sends the exact clear PUT body (deadline: null, no reminderOffsetsMinutes) when undoing a placement from unscheduled", async () => {
    const entry: ProjectCalendarUnscheduledEntryDto = {
      id: `project-deadline:${PROJECT_ID}`, kind: "project_deadline", reason: "unscheduled", title: "Deadline",
      project: project(), permissions: { canDrag: true, canResize: false }, deadlineVersion: 8, reminderOffsetsMinutes: [],
    };
    const before = projectDeadlinePlaceholder(entry);
    const ticket = buildDeadlineUndoTicket(before, { version: 9, deadline: { localCivil: "2026-08-27T09:00", instant: "2026-08-26T23:00:00.000Z" }, reminderOffsetsMinutes: [] });
    expect(ticket).toEqual({ kind: "deadline", projectId: PROJECT_ID, expectedVersion: 9, request: { expectedVersion: 9, deadline: null } });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/projects/${PROJECT_ID}/deadline`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 9, deadline: null });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await applyUndo(ticket!);
    expect(outcome).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
