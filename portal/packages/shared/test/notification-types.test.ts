import { describe, expect, it } from "vitest";
import {
  isCautionNotificationType,
  NOTIFICATION_CAUTION_TYPES,
  NOTIFICATION_TYPES,
  NOTIFICATION_WORKSPACE_TAB,
  notificationWorkspaceTab,
} from "../src/notification-types";

describe("caution notification types", () => {
  it("names exactly the stalled-AutoHDR and deadline-reminder types as caution", () => {
    expect(NOTIFICATION_CAUTION_TYPES).toEqual(["autohdr_stalled", "project_deadline_reminder"]);
  });

  it("recognises only the two caution types, not an ordinary or unknown one", () => {
    expect(isCautionNotificationType("autohdr_stalled")).toBe(true);
    expect(isCautionNotificationType("project_deadline_reminder")).toBe(true);
    expect(isCautionNotificationType("mentioned")).toBe(false);
    expect(isCautionNotificationType("some_unknown_type")).toBe(false);
  });
});

describe("#337 notification type → Workspace tab", () => {
  it("maps every declared notification type — a new type without a mapping fails here", () => {
    expect(Object.keys(NOTIFICATION_WORKSPACE_TAB).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("follows the issue's table row by row", () => {
    // Independent of the implementation map: written out from #337's table.
    const expected: Record<string, string> = {
      raw_ready: "raw",
      sent_to_editing: "raw",
      autohdr_stalled: "raw",
      edited_landed: "edited",
      delivered: "edited",
      comment_added: "collaboration",
      assigned_to_project: "collaboration",
      project_deadline_reminder: "collaboration",
      project_activity: "collaboration",
      mentioned: "collaboration",
      subtask_assigned: "collaboration",
      subtask_due_today: "collaboration",
      project_collaboration_activity: "collaboration",
    };
    expect({ ...NOTIFICATION_WORKSPACE_TAB }).toEqual(expected);
    for (const type of NOTIFICATION_TYPES) expect(notificationWorkspaceTab(type), type).toBe(expected[type]);
  });

  it("returns undefined for a stored type the app no longer declares, including prototype keys", () => {
    expect(notificationWorkspaceTab("some_unknown_type")).toBeUndefined();
    expect(notificationWorkspaceTab("toString")).toBeUndefined();
    expect(notificationWorkspaceTab("__proto__")).toBeUndefined();
    expect(notificationWorkspaceTab("constructor")).toBeUndefined();
  });
});
