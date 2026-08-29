import { describe, expect, it } from "vitest";
import {
  STAGE_MOVE_CONFIRMATION_REASONS,
  STAGE_PRESENTATION_KEYS,
  STAGE_SEQUENCE,
  moveProjectStageConflictResponseSchema,
  moveProjectStageRequestSchema,
  moveProjectStageRequestSchemaForProject,
  moveProjectStageResponseSchema,
  parseStageTransportKey,
  projectStageDtoForRole,
  stageMoveConfirmationReasons,
  stageTransportKeyForRole,
} from "../src/stage-move";

const targetProjectId = "11111111-1111-4111-8111-111111111111";
const beforeProjectId = "22222222-2222-4222-8222-222222222222";
const afterProjectId = "33333333-3333-4333-8333-333333333333";

const validRequest = {
  expected: { stageKey: "raw_review", boardRevision: 2 },
  targetStageKey: "editing",
  placement: {
    kind: "between" as const,
    before: { projectId: beforeProjectId, boardRevision: 4 },
    after: { projectId: afterProjectId, boardRevision: 7 },
  },
  confirmation: { reasons: ["editing_boundary" as const] },
};

describe("TB5A Stage transport", () => {
  it("uses the internal Editing key only for Admin and neutralizes it for staff and External Editor", () => {
    expect(STAGE_PRESENTATION_KEYS).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"]);
    expect(stageTransportKeyForRole("editing_autohdr", "admin")).toBe("editing_autohdr");
    expect(stageTransportKeyForRole("editing_autohdr", "editor")).toBe("editing");
    expect(stageTransportKeyForRole("editing_autohdr", "external_editor")).toBe("editing");
    expect(stageTransportKeyForRole("editing_autohdr", "photographer")).toBe("editing");
    expect(parseStageTransportKey("editing_autohdr", "admin")).toBe("editing_autohdr");
    expect(parseStageTransportKey("editing", "admin")).toBe("editing_autohdr");
    expect(parseStageTransportKey("editing", "editor")).toBe("editing_autohdr");
    expect(parseStageTransportKey("editing", "external_editor")).toBe("editing_autohdr");
    expect(parseStageTransportKey("editing_autohdr", "editor")).toBeNull();
    expect(parseStageTransportKey("editing_autohdr", "external_editor")).toBeNull();
    expect(parseStageTransportKey("not-a-stage", "admin")).toBeNull();
  });

  it("projects a configured stage DTO through the same role-safe transport helper", () => {
    const stage = { key: "editing_autohdr" as const, label: "Editing · autoHDR", displayOrder: 3, active: true };
    expect(projectStageDtoForRole(stage, "admin")).toEqual(stage);
    expect(projectStageDtoForRole(stage, "editor")).toEqual({ ...stage, key: "editing" });
    expect(projectStageDtoForRole(stage, "external_editor")).toEqual({ ...stage, key: "editing" });
  });
});

describe("TB5A Stage confirmation classification", () => {
  it("keeps the fixed sequence and reason order", () => {
    expect(STAGE_SEQUENCE).toEqual(["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"]);
    expect(STAGE_MOVE_CONFIRMATION_REASONS).toEqual(["backward", "skipped_forward", "delivered_boundary", "editing_boundary"]);
    expect(stageMoveConfirmationReasons("awaiting_raw", "awaiting_raw")).toEqual([]);
    expect(stageMoveConfirmationReasons("awaiting_raw", "raw_review")).toEqual([]);
    expect(stageMoveConfirmationReasons("raw_review", "awaiting_raw")).toEqual(["backward"]);
    expect(stageMoveConfirmationReasons("raw_review", "editing_autohdr")).toEqual(["editing_boundary"]);
    expect(stageMoveConfirmationReasons("awaiting_raw", "edited_review")).toEqual(["skipped_forward"]);
    expect(stageMoveConfirmationReasons("edited_review", "delivered")).toEqual(["delivered_boundary"]);
    expect(stageMoveConfirmationReasons("editing_autohdr", "delivered")).toEqual(["skipped_forward", "delivered_boundary", "editing_boundary"]);
    expect(stageMoveConfirmationReasons("delivered", "editing_autohdr")).toEqual(["backward", "delivered_boundary", "editing_boundary"]);
    expect(stageMoveConfirmationReasons("delivered", "awaiting_raw")).toEqual(["backward", "delivered_boundary"]);
  });
});

describe("TB5A strict Stage move request and response schemas", () => {
  it("accepts the contract, normalizes a both-null between placement, and rejects strict extras", () => {
    expect(moveProjectStageRequestSchema.parse(validRequest)).toEqual(validRequest);
    expect(moveProjectStageRequestSchema.parse({
      ...validRequest,
      placement: { kind: "between", before: null, after: null },
    }).placement).toEqual({ kind: "append" });
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, extra: true }).success).toBe(false);
  });

  it("rejects invalid UUIDs, unsafe revisions, duplicate reasons, and repeated neighbours", () => {
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: -1 } }).success).toBe(false);
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, placement: { ...validRequest.placement, before: { ...validRequest.placement.before!, projectId: "not-a-uuid" } } }).success).toBe(false);
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, confirmation: { reasons: ["editing_boundary", "editing_boundary"] } }).success).toBe(false);
    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, placement: { ...validRequest.placement, after: { ...validRequest.placement.before! } } }).success).toBe(false);
  });

  it("rejects a neighbour equal to the route target through the target-aware schema", () => {
    expect(moveProjectStageRequestSchemaForProject(targetProjectId).safeParse({
      ...validRequest,
      placement: { ...validRequest.placement, before: { projectId: targetProjectId, boardRevision: 1 } },
    }).success).toBe(false);
    expect(moveProjectStageRequestSchemaForProject(targetProjectId).safeParse(validRequest).success).toBe(true);
  });

  it("validates the success and 409 conflict response contracts", () => {
    const response = {
      changed: true,
      project: { projectId: targetProjectId, stageKey: "editing", boardRevision: 3 },
      board: { sourceStageKey: "raw_review", targetStageKey: "editing", orderedVisibleProjectIds: [targetProjectId, beforeProjectId] },
    };
    expect(moveProjectStageResponseSchema.safeParse(response).success).toBe(true);
    expect(moveProjectStageConflictResponseSchema.safeParse({ error: "Conflict", code: "project_stage_conflict", current: response.project }).success).toBe(true);
    expect(moveProjectStageConflictResponseSchema.safeParse({ error: "Conflict", code: "project_stage_conflict", current: { ...response.project, projectId: "not-a-uuid" } }).success).toBe(false);
  });
});
