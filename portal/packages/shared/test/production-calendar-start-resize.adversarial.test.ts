import { describe, expect, it } from "vitest";
import { mapChecklistStartResizeToCommand, PRODUCTION_CALENDAR_ZONE, resolveSydneyCivilMinute, type ChecklistCalendarEventDto } from "../src/index";

const project = { id: "11111111-1111-4111-8111-111111111111", street: "1 Example Street", stageKey: "editing" as const, checklist: { completed: 0, total: 1 }, delivered: false };

function endpoint(localCivil: string, disambiguation?: "earlier" | "later") {
  if (!localCivil.includes("T")) return { kind: "date" as const, localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const };
  const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (!resolved.ok) throw new Error(`Fixture time did not resolve: ${localCivil}`);
  return { kind: "timed" as const, localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" as const };
}

function event(start: string, end: string, startChoice?: "earlier" | "later", endChoice?: "earlier" | "later"): ChecklistCalendarEventDto {
  const startEndpoint = endpoint(start, startChoice);
  const endEndpoint = endpoint(end, endChoice);
  return {
    id: "checklist:one", kind: "checklist", title: "Select hero images", project, assignee: null,
    timing: startEndpoint.kind === "date" ? { allDay: true, start, end: end } : { allDay: false, start: startEndpoint.instant, end: endEndpoint.instant },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startEndpoint, end: endEndpoint, due: end },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

describe("mapChecklistStartResizeToCommand adversarial cases", () => {
  it("rejects timed zero-length and backwards ranges after civil-time resolution", () => {
    const target = { subview: "week" as const, targetDate: "2026-08-27", targetCivilMinute: "2026-08-27T10:00" };
    expect(mapChecklistStartResizeToCommand({ event: event("2026-08-27T09:00", "2026-08-27T10:00"), target })).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
    expect(mapChecklistStartResizeToCommand({ event: event("2026-08-27T09:00", "2026-08-27T10:00"), target: { ...target, targetCivilMinute: "2026-08-27T10:01" } })).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
  });

  it("allows a same-day date-only range but rejects a mixed date/timed range", () => {
    const sameDay = mapChecklistStartResizeToCommand({ event: event("2026-08-27", "2026-08-29"), target: { subview: "month", targetDate: "2026-08-29" } });
    expect(sameDay).toMatchObject({ ok: true, value: { schedule: { start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } } } });

    const mixed = mapChecklistStartResizeToCommand({ event: event("2026-08-27", "2026-08-29T09:00"), target: { subview: "month", targetDate: "2026-08-28" } });
    expect(mixed).toMatchObject({ ok: false, error: { code: "subtask_schedule_mixed_endpoint_kinds" } });
  });

  it("rejects equal civil text when fold choices put the new start after the preserved end", () => {
    const source = event("2026-04-05T01:00", "2026-04-05T02:30", undefined, "earlier");
    const resized = mapChecklistStartResizeToCommand({ event: source, target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T02:30" }, disambiguation: "later" });
    expect(resized).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
  });

  it("accepts the explicit start edge and preserves the end fold metadata", () => {
    const source = event("2026-04-05T01:00", "2026-04-05T02:30", undefined, "later");
    const resized = mapChecklistStartResizeToCommand({ event: source, edge: "start", target: { subview: "week", targetDate: "2026-04-05", targetCivilMinute: "2026-04-05T01:30", edge: "start" } });
    expect(resized).toMatchObject({ ok: true, value: { schedule: { start: { localCivil: "2026-04-05T01:30" }, end: { localCivil: "2026-04-05T02:30", disambiguation: "later" } } } });
  });
});
