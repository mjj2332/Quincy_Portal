import { describe, expect, it } from "vitest";
import { isCautionNotificationType, NOTIFICATION_CAUTION_TYPES } from "../src/notification-types";

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
