import { describe, expect, it } from "vitest";
import { schedulingItemActions, type SchedulingItemActionsInput } from "./scheduling-item-actions";

const base: SchedulingItemActionsInput = { kind: "deadline", canOpenProject: true, canReschedule: true, canEditSchedule: false, live: true };
const ids = (input: Partial<SchedulingItemActionsInput>) => schedulingItemActions({ ...base, ...input }).map((action) => action.id);
const labels = (input: Partial<SchedulingItemActionsInput>) => schedulingItemActions({ ...base, ...input }).map((action) => action.label);

describe("schedulingItemActions (#463)", () => {
  it("offers an admin Deadline Open project and Reschedule…", () => {
    expect(labels({})).toEqual(["Open project", "Reschedule…"]);
    expect(ids({})).toEqual(["open-project", "reschedule"]);
  });

  it("offers a Deadline the user cannot move Open project only", () => {
    expect(ids({ canReschedule: false })).toEqual(["open-project"]);
  });

  it("offers a checklist item Edit schedule… when the schedule editor is allowed", () => {
    expect(labels({ kind: "checklist", canReschedule: false, canEditSchedule: true })).toEqual(["Open project", "Edit schedule…"]);
    expect(ids({ kind: "checklist", canReschedule: false, canEditSchedule: false })).toEqual(["open-project"]);
  });

  it("never offers Reschedule… on a checklist item or Edit schedule… on a Deadline", () => {
    expect(ids({ kind: "checklist", canReschedule: true, canEditSchedule: true })).toEqual(["open-project", "edit-schedule"]);
    expect(ids({ kind: "deadline", canReschedule: true, canEditSchedule: true })).toEqual(["open-project", "reschedule"]);
  });

  it("gives an External Editor shape (no Deadline right, a schedule right) the schedule action only beside Open project", () => {
    expect(ids({ kind: "deadline", canReschedule: false, canEditSchedule: false })).toEqual(["open-project"]);
    expect(ids({ kind: "checklist", canReschedule: false, canEditSchedule: true })).toEqual(["open-project", "edit-schedule"]);
  });

  it("disables every action while the surface is not live, and keeps them listed", () => {
    const actions = schedulingItemActions({ ...base, live: false });
    expect(actions.map((action) => action.id)).toEqual(["open-project", "reschedule"]);
    expect(actions.every((action) => action.disabled)).toBe(true);
  });

  it("enables every action while live", () => {
    expect(schedulingItemActions(base).every((action) => !action.disabled)).toBe(true);
  });

  it("omits Open project when there is no way to open a project", () => {
    expect(ids({ canOpenProject: false })).toEqual(["reschedule"]);
    expect(ids({ canOpenProject: false, canReschedule: false })).toEqual([]);
  });
});
