import { z } from "zod";
import { type Role } from "./capabilities";
import { STAGE_KEYS, type StageKey } from "./stages";

export const STAGE_PRESENTATION_KEYS = [
  "awaiting_raw",
  "raw_review",
  "editing",
  "edited_review",
  "delivered",
] as const;
export type StagePresentationKey = (typeof STAGE_PRESENTATION_KEYS)[number];

export type StageTransportKey = StageKey | "editing";

export const STAGE_TRANSPORT_KEYS = [...STAGE_KEYS, "editing"] as const;
const stageTransportKeySchema = z.enum(STAGE_TRANSPORT_KEYS);

/** A pipeline stage as stored/configured by the internal Stage administration surface. */
export type PipelineStage = {
  key: StageKey;
  label: string;
  displayOrder: number;
  active: boolean;
};

export type RoleSafeStageDto = Omit<PipelineStage, "key"> & { key: StageTransportKey };

export function stageTransportKeyForRole(stage: StageKey, role: "admin"): StageKey;
export function stageTransportKeyForRole(stage: StageKey, role: Exclude<Role, "admin">): StagePresentationKey;
export function stageTransportKeyForRole(stage: StageKey, role: Role): StageTransportKey;
export function stageTransportKeyForRole(stage: StageKey, role: Role): StageTransportKey {
  return role === "admin" || stage !== "editing_autohdr" ? stage : "editing";
}

export function parseStageTransportKey(value: unknown, role: Role): StageKey | null {
  if (typeof value !== "string") return null;
  if (value === "editing") return "editing_autohdr";
  if (!stageTransportKeySchema.safeParse(value).success) return null;
  if (value === "editing_autohdr" && role !== "admin") return null;
  return value as StageKey;
}

export function projectStageDtoForRole(stage: PipelineStage, role: Role): RoleSafeStageDto {
  return { ...stage, key: stageTransportKeyForRole(stage.key, role) };
}

export const STAGE_SEQUENCE = [
  "awaiting_raw",
  "raw_review",
  "editing_autohdr",
  "edited_review",
  "delivered",
] as const satisfies readonly StageKey[];

export const STAGE_MOVE_CONFIRMATION_REASONS = [
  "backward",
  "skipped_forward",
  "delivered_boundary",
  "editing_boundary",
] as const;
export type StageMoveConfirmationReason = (typeof STAGE_MOVE_CONFIRMATION_REASONS)[number];

export function stageMoveConfirmationReasons(from: StageKey, to: StageKey): StageMoveConfirmationReason[] {
  if (from === to) return [];
  const fromIndex = STAGE_SEQUENCE.indexOf(from);
  const toIndex = STAGE_SEQUENCE.indexOf(to);
  const reasons = new Set<StageMoveConfirmationReason>();
  if (toIndex < fromIndex) reasons.add("backward");
  if (toIndex > fromIndex + 1) reasons.add("skipped_forward");
  if ((from === "delivered") !== (to === "delivered")) reasons.add("delivered_boundary");
  if ((from === "editing_autohdr") !== (to === "editing_autohdr")) reasons.add("editing_boundary");
  return STAGE_MOVE_CONFIRMATION_REASONS.filter((reason) => reasons.has(reason));
}

const uuidSchema = z.string().uuid();
export const boardRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type StageMovePlacement = { kind: "append" };

const stageMovePlacementSchema = z.object({ kind: z.literal("append") }).strict();

const confirmationReasonsSchema = z.array(z.enum(STAGE_MOVE_CONFIRMATION_REASONS))
  .max(STAGE_MOVE_CONFIRMATION_REASONS.length)
  .refine((reasons) => new Set(reasons).size === reasons.length, "Confirmation reasons must be unique");
const confirmationSchema = z.object({ reasons: confirmationReasonsSchema }).strict();

export type MoveProjectStageRequest = {
  expected: {
    stageKey: StageTransportKey;
    boardRevision: number;
  };
  targetStageKey: StageTransportKey;
  placement: StageMovePlacement;
  confirmation?: {
    reasons: StageMoveConfirmationReason[];
  };
};

/** Strict body contract. The route target is supplied separately, so target-aware checks use the factory below. */
export const moveProjectStageRequestSchema = z.object({
  expected: z.object({
    stageKey: stageTransportKeySchema,
    boardRevision: boardRevisionSchema,
  }).strict(),
  targetStageKey: stageTransportKeySchema,
  placement: stageMovePlacementSchema,
  confirmation: confirmationSchema.optional(),
}).strict();

export type StageMoveProjectState = {
  projectId: string;
  stageKey: StageTransportKey;
  boardRevision: number;
};

export type StageMoveBoardState = {
  sourceStageKey: StageTransportKey;
  targetStageKey: StageTransportKey;
  /** Deprecated (#475): the web derives the order itself. Still sent for stale tabs until #476 removes it. */
  orderedVisibleProjectIds?: string[];
};

export type MoveProjectStageResponse = {
  changed: boolean;
  project: StageMoveProjectState;
  board: StageMoveBoardState;
};

export const stageMoveProjectStateSchema = z.object({
  projectId: uuidSchema,
  stageKey: stageTransportKeySchema,
  boardRevision: boardRevisionSchema,
}).strict();

export const stageMoveBoardStateSchema = z.object({
  sourceStageKey: stageTransportKeySchema,
  targetStageKey: stageTransportKeySchema,
  orderedVisibleProjectIds: z.array(uuidSchema).optional(),
}).strict();

export const moveProjectStageResponseSchema = z.object({
  changed: z.boolean(),
  project: stageMoveProjectStateSchema,
  board: stageMoveBoardStateSchema,
}).strict();

export type StageMoveConflictResponse = {
  error: string;
  code: "project_stage_conflict";
  current: StageMoveProjectState | null;
};

export const stageMoveConflictResponseSchema = z.object({
  error: z.string().min(1),
  code: z.literal("project_stage_conflict"),
  current: stageMoveProjectStateSchema.nullable(),
}).strict();

export type MoveProjectStageConflictResponse = StageMoveConflictResponse;
export const moveProjectStageConflictResponseSchema = stageMoveConflictResponseSchema;
export type ProjectStageConflictResponse = StageMoveConflictResponse;
export const projectStageConflictResponseSchema = stageMoveConflictResponseSchema;

export type StageConfirmationRequiredResponse = {
  error: "Confirmation is required for this Stage move.";
  code: "stage_confirmation_required";
  requiredConfirmation: {
    fromStageKey: StageTransportKey;
    toStageKey: StageTransportKey;
    reasons: StageMoveConfirmationReason[];
  };
  current: StageMoveProjectState;
};

export const stageConfirmationRequiredResponseSchema = z.object({
  error: z.literal("Confirmation is required for this Stage move."),
  code: z.literal("stage_confirmation_required"),
  requiredConfirmation: z.object({
    fromStageKey: stageTransportKeySchema,
    toStageKey: stageTransportKeySchema,
    reasons: confirmationReasonsSchema,
  }).strict(),
  current: stageMoveProjectStateSchema,
}).strict();

