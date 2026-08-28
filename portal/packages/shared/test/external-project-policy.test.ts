import { describe, expect, it } from "vitest";
import {
  EXTERNAL_LEGACY_NOTIFICATION_POLICY,
  EXTERNAL_PROJECT_ACTIVITY_POLICY,
  externalProjectActivityAudience,
  projectExternalActivityPayload,
} from "../src/external-project-policy";
import { PROJECT_ACTIVITY_TYPES } from "../src/project-activity";
import { NOTIFICATION_TYPES } from "../src/notification-types";
import { externalProjectSummarySchema } from "../src/external-project-dto";
import { externalEditedUploadCreateRequestSchema } from "../src/external-upload";

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

  it("rejects DTO widening and non-edited upload requests at the shared boundary", () => {
    const summary = {
      id: "11111111-1111-4111-8111-111111111111",
      address: { street: "TB4E Street", suburb: null, postcode: null },
      agencyDisplayName: null,
      agentDisplayName: null,
      shootDate: null,
      timeWindow: null,
      stageKey: "edited_review",
      deadline: null,
      productionNotes: null,
      services: [],
      cover: null,
    };
    expect(externalProjectSummarySchema.safeParse({ ...summary, secret: "nope" }).success).toBe(false);
    expect(externalProjectSummarySchema.safeParse(summary).success).toBe(true);
    expect(externalEditedUploadCreateRequestSchema.safeParse({ projectId: summary.id, collection: "raw", filename: "image.jpg", bytes: 10 }).success).toBe(false);
    expect(externalEditedUploadCreateRequestSchema.safeParse({ projectId: summary.id, collection: "edited", filename: "image.jpg", bytes: 10 }).success).toBe(true);
  });
});
