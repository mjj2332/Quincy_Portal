import { describe, expect, it } from "vitest";
import {
  EXTERNAL_LEGACY_NOTIFICATION_POLICY,
  EXTERNAL_PROJECT_ACTIVITY_POLICY,
  externalProjectActivityAudience,
  projectExternalActivityPayload,
} from "../src/external-project-policy";
import { PROJECT_ACTIVITY_TYPES } from "../src/project-activity";
import { NOTIFICATION_TYPES } from "../src/notification-types";
import { externalProjectDetailSchema, externalProjectListResponseSchema, externalProjectSummarySchema } from "../src/external-project-dto";
import { externalEditedUploadCreateRequestSchema } from "../src/external-upload";
import { externalNotificationChannels, externalNotificationCopy } from "../src/external-notification";
import { stageTransportKeyForRole } from "../src/stage-move";

describe("TB4E external policy and DTO boundaries", () => {
  it("is exhaustive independently of the internal activity registry metadata", () => {
    expect(Object.keys(EXTERNAL_PROJECT_ACTIVITY_POLICY).sort()).toEqual([...PROJECT_ACTIVITY_TYPES].sort());
    expect(Object.values(EXTERNAL_PROJECT_ACTIVITY_POLICY).every((policy) => policy.decision !== "suppressed" || policy.reason)).toBe(true);
    expect(externalProjectActivityAudience("project.priority.changed")).toBe("internal");
    expect(externalProjectActivityAudience("project.comment.created")).toBe("internal-and-external");
  });

  it("keeps the legacy notification policy exhaustive and suppresses unsafe project fields", () => {
    expect(Object.keys(EXTERNAL_LEGACY_NOTIFICATION_POLICY).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(projectExternalActivityPayload("project.comment.created", { commentId: "comment" })).toEqual({ type: "project.comment.created", payload: { commentId: "comment" } });
    expect(projectExternalActivityPayload("project.comment.created", { commentId: "comment", body: "private" } as never)).toBeNull();
  });

  it("uses only an explicit external copy/channel entry", () => {
    expect(externalNotificationCopy({ type: "project.comment.created" })).toEqual({ title: "Project discussion updated", body: "The assigned project discussion was updated." });
    expect(externalNotificationChannels("project.comment.created")).toEqual(["in_app"]);
    expect(externalNotificationCopy({ type: "project.priority.changed" })).toBeNull();
    expect(externalNotificationChannels("project.priority.changed")).toEqual([]);
    expect(externalNotificationCopy({ type: "future.unknown" })).toBeNull();
    expect(externalNotificationChannels("future.unknown")).toEqual([]);
  });

  it("rejects DTO widening and non-edited upload requests at the shared boundary", () => {
    const summary = {
      id: "11111111-1111-4111-8111-111111111111",
      address: { street: "TB4E Street", suburb: null, postcode: null },
      agencyDisplayName: null,
      agentDisplayName: null,
      shootDate: null,
      timeWindow: null,
      stageKey: "edited_review",
      boardRevision: 0,
      deadline: null,
      productionNotes: null,
      services: [],
      cover: null,
      editors: [],
    };
    expect(externalProjectSummarySchema.safeParse({ ...summary, secret: "nope" }).success).toBe(false);
    expect(externalProjectSummarySchema.safeParse(summary).success).toBe(true);
    // Editors are allowed on the external summary, including internal staff — the schema does
    // not distinguish a global role, only the `{ id, name }` shape and no avatar URL.
    const withEditors = { ...summary, editors: [{ id: "22222222-2222-4222-8222-222222222222", name: "Internal Editor" }] };
    expect(externalProjectSummarySchema.safeParse(withEditors).success).toBe(true);
    expect(externalProjectSummarySchema.safeParse({ ...summary, editors: [{ id: summary.id, name: "X", avatarUrl: "https://example.test/a.png" }] }).success).toBe(false);
    expect(externalProjectSummarySchema.parse(summary).editors).toEqual([]);
    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "editing" }).success).toBe(true);
    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "editing_autohdr" }).success).toBe(false);
    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "unknown-stage" }).success).toBe(false);
    const externalEditing = stageTransportKeyForRole("editing_autohdr", "external_editor");
    expect(externalEditing).toBe("editing");
    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: externalEditing }).success).toBe(true);
    const detail = {
      ...summary,
      boardRevision: 4,
      contractEnabled: false,
      editedUploadAvailable: false,
      collections: [],
      members: [],
    };
    expect(externalProjectDetailSchema.safeParse(detail).success).toBe(true);
    const list = {
      projects: [summary],
      board: { contractEnabled: false, orderedProjectIdsByStage: { edited_review: [summary.id] } },
    };
    expect(externalProjectListResponseSchema.safeParse(list).success).toBe(true);

    // These probes represent fields that are useful internally but must never cross the
    // external boundary, even if a route accidentally spreads a wider project row.
    for (const field of ["priority", "boardPosition", "hiddenProjectIds", "hiddenCount"] as const) {
      const value = field === "hiddenProjectIds" ? [summary.id] : field === "hiddenCount" ? 1 : 0;
      expect(externalProjectListResponseSchema.safeParse({ ...list, projects: [{ ...summary, [field]: value }] }).success).toBe(false);
      expect(externalProjectDetailSchema.safeParse({ ...detail, [field]: value }).success).toBe(false);
    }
    expect(externalProjectListResponseSchema.safeParse({ ...list, projects: [{ ...summary, stageKey: "editing_autohdr" }] }).success).toBe(false);
    expect(externalProjectDetailSchema.safeParse({ ...detail, stageKey: "editing_autohdr" }).success).toBe(false);
    expect(externalEditedUploadCreateRequestSchema.safeParse({ projectId: summary.id, collection: "raw", filename: "image.jpg", bytes: 10 }).success).toBe(false);
    expect(externalEditedUploadCreateRequestSchema.safeParse({ projectId: summary.id, collection: "edited", filename: "image.jpg", bytes: 10 }).success).toBe(true);
  });
});
