import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES, type NotificationType } from "../src/notification-types";
import {
  clampNotificationBody,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_ENRICHMENT,
  parseNotificationSource,
  staffNotificationListItemSchema,
  staffNotificationListResponseSchema,
} from "../src/notification-enrichment";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

describe("NOTIFICATION_ENRICHMENT enumeration", () => {
  it("declares exactly the 13 notification types, sorted", () => {
    expect(Object.keys(NOTIFICATION_ENRICHMENT).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(Object.keys(NOTIFICATION_ENRICHMENT)).toHaveLength(13);
  });

  const exercised: Record<NotificationType, boolean> = Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, false]),
  ) as Record<NotificationType, boolean>;

  it("comment_added: annotation:<uuid>", () => {
    exercised.comment_added = true;
    expect(parseNotificationSource("comment_added", PROJECT_ID, `annotation:${OTHER_ID}`)).toEqual({ kind: "annotation", annotationId: OTHER_ID });
  });
  it("comment_added: malformed and null source keys degrade to none", () => {
    expect(parseNotificationSource("comment_added", PROJECT_ID, "not-an-annotation")).toEqual({ kind: "none" });
    expect(parseNotificationSource("comment_added", PROJECT_ID, null)).toEqual({ kind: "none" });
  });

  it("mentioned: a project comment mention when projectId is set", () => {
    exercised.mentioned = true;
    expect(parseNotificationSource("mentioned", PROJECT_ID, OTHER_ID)).toEqual({ kind: "project_comment_mention", mentionId: OTHER_ID });
  });
  it("mentioned: a notice-board mention when projectId is null", () => {
    expect(parseNotificationSource("mentioned", null, OTHER_ID)).toEqual({ kind: "notice_board_mention", mentionId: OTHER_ID });
  });
  it("mentioned: malformed and null source keys degrade to none", () => {
    expect(parseNotificationSource("mentioned", PROJECT_ID, "not-a-uuid")).toEqual({ kind: "none" });
    expect(parseNotificationSource("mentioned", PROJECT_ID, null)).toEqual({ kind: "none" });
  });

  it("subtask_assigned: subtask-assignment:<uuid>:<int>", () => {
    exercised.subtask_assigned = true;
    expect(parseNotificationSource("subtask_assigned", PROJECT_ID, `subtask-assignment:${OTHER_ID}:3`)).toEqual({ kind: "subtask_assignment", subtaskId: OTHER_ID, version: 3 });
  });
  it("subtask_assigned: malformed and null source keys degrade to none", () => {
    expect(parseNotificationSource("subtask_assigned", PROJECT_ID, `subtask-assignment:${OTHER_ID}`)).toEqual({ kind: "none" });
    expect(parseNotificationSource("subtask_assigned", PROJECT_ID, null)).toEqual({ kind: "none" });
  });

  it("subtask_due_today: subtask-due:<uuid>:<YYYY-MM-DD>", () => {
    exercised.subtask_due_today = true;
    expect(parseNotificationSource("subtask_due_today", PROJECT_ID, `subtask-due:${OTHER_ID}:2026-09-15`)).toEqual({ kind: "subtask_due", subtaskId: OTHER_ID, dueDate: "2026-09-15" });
  });
  it("subtask_due_today: malformed and null source keys degrade to none", () => {
    expect(parseNotificationSource("subtask_due_today", PROJECT_ID, `subtask-due:${OTHER_ID}:15-09-2026`)).toEqual({ kind: "none" });
    expect(parseNotificationSource("subtask_due_today", PROJECT_ID, null)).toEqual({ kind: "none" });
  });

  it("assigned_to_project: a membership uuid source key", () => {
    exercised.assigned_to_project = true;
    expect(parseNotificationSource("assigned_to_project", PROJECT_ID, OTHER_ID)).toEqual({ kind: "membership", membershipId: OTHER_ID });
  });
  it("assigned_to_project: malformed and null source keys degrade to none", () => {
    expect(parseNotificationSource("assigned_to_project", PROJECT_ID, "not-a-uuid")).toEqual({ kind: "none" });
    expect(parseNotificationSource("assigned_to_project", PROJECT_ID, null)).toEqual({ kind: "none" });
  });

  it("project_activity and project_collaboration_activity always resolve via the ledger, sourceKey or not", () => {
    exercised.project_activity = true;
    exercised.project_collaboration_activity = true;
    expect(parseNotificationSource("project_activity", PROJECT_ID, "anything")).toEqual({ kind: "ledger" });
    expect(parseNotificationSource("project_activity", PROJECT_ID, null)).toEqual({ kind: "ledger" });
    expect(parseNotificationSource("project_collaboration_activity", PROJECT_ID, null)).toEqual({ kind: "ledger" });
  });

  const noSourceTypes: NotificationType[] = ["raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "project_deadline_reminder"];
  it("the seven system types (plus mentioned/comment_added covered above) never resolve a source", () => {
    for (const type of noSourceTypes) {
      exercised[type] = true;
      expect(parseNotificationSource(type, PROJECT_ID, "legacy:whatever:123")).toEqual({ kind: "none" });
      expect(parseNotificationSource(type, PROJECT_ID, null)).toEqual({ kind: "none" });
    }
  });

  it("every declared type was exercised by a parse case above", () => {
    expect(Object.entries(exercised).filter(([, done]) => !done).map(([type]) => type)).toEqual([]);
  });
});

describe("clampNotificationBody", () => {
  it("leaves a short body untouched", () => {
    expect(clampNotificationBody("Short body")).toBe("Short body");
  });

  it("leaves a body exactly at the limit untouched", () => {
    const body = "a".repeat(NOTIFICATION_BODY_MAX);
    expect(clampNotificationBody(body)).toBe(body);
    expect(clampNotificationBody(body)).toHaveLength(NOTIFICATION_BODY_MAX);
  });

  it("clamps a 10k-char body to 280 chars ending in an ellipsis", () => {
    const body = "a".repeat(10_000);
    const clamped = clampNotificationBody(body);
    expect(clamped).toHaveLength(NOTIFICATION_BODY_MAX);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.slice(0, -1)).toBe("a".repeat(NOTIFICATION_BODY_MAX - 1));
  });
});

describe("staffNotificationListItemSchema", () => {
  const base = {
    id: PROJECT_ID,
    projectId: PROJECT_ID,
    type: "comment_added" as const,
    title: "A title",
    body: "A body",
    readAt: null,
    createdAt: new Date().toISOString(),
    projectStreet: "Street",
    coverAssetId: null,
    actor: null,
    subject: null,
    assetId: null,
  };

  it("accepts a fully-populated row", () => {
    expect(staffNotificationListItemSchema.parse({
      ...base,
      actor: { id: OTHER_ID, name: "Ada" },
      subject: { kind: "asset", label: "frame.jpg" },
      assetId: OTHER_ID,
    })).toMatchObject({ actor: { name: "Ada" } });
  });

  it("accepts a stored type this build does not know, like the external schema does", () => {
    expect(staffNotificationListItemSchema.parse({ ...base, type: "retired_type" }).type).toBe("retired_type");
    expect(parseNotificationSource("retired_type", null, "annotation:" + OTHER_ID)).toEqual({ kind: "none" });
  });

  it("rejects an unknown field", () => {
    expect(() => staffNotificationListItemSchema.parse({ ...base, extra: "nope" })).toThrow();
  });

  it("rejects an unknown field on the nested actor and subject objects", () => {
    expect(() => staffNotificationListItemSchema.parse({ ...base, actor: { id: OTHER_ID, name: "Ada", initials: "A" } })).toThrow();
    expect(() => staffNotificationListItemSchema.parse({ ...base, subject: { kind: "asset", label: "frame.jpg", extra: 1 } })).toThrow();
  });

  it("rejects an unknown field on the response wrapper", () => {
    expect(() => staffNotificationListResponseSchema.parse({
      notifications: [base],
      unreadCount: 0,
      extra: "nope",
    })).toThrow();
  });
});
