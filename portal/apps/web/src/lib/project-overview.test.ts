import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "./project-data";
import { overviewPresentation } from "./project-overview";

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "project-1", street: "12 Example Street", suburb: "Surry Hills", postcode: "2010", agencyName: "Quincy Realty", agentName: "Ari Agent",
  shootDate: "2026-09-01", timeWindow: "Morning", priority: 3, stageKey: "editing_autohdr", rawFolderPath: null, rawFolderLink: null,
  productionNotes: "Leave the lights on.", boardRevision: 1, contractEnabled: true, coverAssetId: null, effectiveCoverAssetId: null,
  collections: [{ id: "collection-1", kind: "raw", status: "received", expectedCount: 10, receivedCount: 10 }],
  members: [{ id: "member-1", userId: "user-1", roleOnProject: "editor", name: "Eli Editor", email: "eli@example.test", globalRole: "editor", active: true, assignedSubtaskCount: 1 }],
  deadlineSchedule: {
    version: 2,
    deadline: { localCivil: "2026-09-02T17:00", zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 0, instant: "2026-09-02T07:00:00.000Z" },
    reminderOffsetsMinutes: [1440, 60], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-09-01T07:00:00.000Z" }, canResume: false,
  },
  ...overrides,
});

describe("overviewPresentation", () => {
  it("presents internal Priority and role-safe detail fields", () => {
    const source = detail();
    const presentation = overviewPresentation(source, "editor");

    expect(presentation.priority).toBe(3);
    expect(presentation.stageKey).toBe("editing");
    expect(presentation.address).toEqual({ street: source.street, suburb: source.suburb, postcode: source.postcode });
    expect(presentation.summary).toMatchObject({ shootDate: source.shootDate, timeWindow: source.timeWindow, agencyName: source.agencyName, agentName: source.agentName, productionNotes: source.productionNotes });
    expect(presentation.team).toBe(source.members);
    expect(presentation.deadline).toEqual({ deadline: source.deadlineSchedule.deadline, state: source.deadlineSchedule.state, nextOccurrence: source.deadlineSchedule.nextOccurrence, reminderOffsetsMinutes: source.deadlineSchedule.reminderOffsetsMinutes, skippedReminderOffsetsMinutes: undefined });
  });

  it("omits internal Priority when it is null", () => {
    expect(Object.prototype.hasOwnProperty.call(overviewPresentation(detail({ priority: null }), "admin"), "priority")).toBe(false);
  });

  it("never presents Priority to an External Editor, even if the detail is incorrectly widened", () => {
    const presentation = overviewPresentation(detail({ priority: 1 }), "external_editor");
    expect(Object.prototype.hasOwnProperty.call(presentation, "priority")).toBe(false);
  });

  it("keeps a neutral editing Stage neutral for every non-admin role", () => {
    expect(overviewPresentation(detail({ stageKey: "editing" }), "external_editor").stageKey).toBe("editing");
    expect(overviewPresentation(detail({ stageKey: "editing_autohdr" }), "admin").stageKey).toBe("editing_autohdr");
  });
});
