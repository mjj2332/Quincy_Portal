import { projectActivityDeepLink, type ProjectActivityType, type StageKey } from "@quincy/shared";
import { BOARD_CONTRACT_FLAG } from "./board-schema-variant";
import { buildProjectActivityStatements } from "./project-activity";
export type PreparedStatementBundle<TIndexes> = { statements: D1PreparedStatement[]; indexes: TIndexes; };
export type StageWinnerIndexes = { winner: number; auditMarker: number; };
export type ActivityBundleIndexes = { activity: number; broadOutbox: number; broadLedger: number; };
export type DeadlineSuppressionIndexes = { occurrences: number; ledgers: number; outboxes: number; };
export type LifecycleSet<T extends string> = readonly [T, ...T[]];
export type ClosedSet<T extends string> = readonly [T, ...T[]];
export type GuardedTransitionPrerequisite = { kind: "none"; } | { kind: "raw_reconciliation"; projectId: string; claimId: string | null; claimStates: LifecycleSet<"running">; shootDate: string | null; } | { kind: "autohdr_handoff"; projectId: string; handoffId: string; jobId: string | null; generation: number; connectionId: string; expectedStates: LifecycleSet<"starting" | "started">; expectedPriorToken: number | null; } | { kind: "autohdr_mapping"; projectId: string; mappingId: string; handoffId: string; generation: number; connectionId: string; mappingStates: LifecycleSet<"active">; handoffStates: LifecycleSet<"starting" | "started">; expectedPriorToken: number | null; } | {
  kind: "autohdr_final_claim";
  projectId: string;
  collectionId: string;
  sourcePathKey: string;
  currentAssetId: string;
  handoffId: string;
  mappingId: string;
  fetchClaimId: string;
  fetchJobId: string;
  generation: number;
  connectionId: string;
  mappingStates: LifecycleSet<"active">;
  handoffStates: LifecycleSet<"started">;
  fetchStates: LifecycleSet<"starting" | "running">;
  manifestVersion: number;
  finalPathKey: string;
  expectedPriorToken: number;
} | { kind: "autohdr_job"; mode: "entry"; projectId: string; jobId: string; jobKind: "autohdr" | "autohdr_api_send"; generation: number; jobStates: LifecycleSet<"running" | "done">; expectedPriorToken: number | null; } | { kind: "autohdr_job"; mode: "completion"; projectId: string; jobId: string; jobKind: "fetch_edited"; jobStates: LifecycleSet<"queued" | "running" | "done">; sourceJobId: string; sourceJobKinds: ClosedSet<"autohdr" | "autohdr_api_send">; sourceJobStates: LifecycleSet<"queued" | "running" | "done">; generation: number; expectedPriorToken: number; };
export type ClosedPathClaimPlan = { kind: "reactivate" | "insert"; claimId: string; candidate: "final" | "finals"; path: string; pathKey: string; };
export type ClosedAutomaticCoupling = { kind: "none"; } | { kind: "handoff_start"; handoffId: string; connectionId: string; generation: number; } | { kind: "job_entry_provenance"; jobId: string; jobKind: "autohdr" | "autohdr_api_send"; generation: number; jobStates: LifecycleSet<"running" | "done">; } | { kind: "autohdr_api_finalize"; jobId: string; uid: string; assetCount: number; finalizedAuditId: string; } | { kind: "repeat_claim"; retiredHandoffId: string; retiredMappingId: string; handoffId: string; mappingId: string; jobId: string; workflowId: string; generation: number; connectionId: string; selectionHash: string; expectedFinalHandoffState: "started"; pathClaims: readonly [ClosedPathClaimPlan, ClosedPathClaimPlan]; } | { kind: "implicit_claim"; handoffId: string; mappingId: string; jobId: string; workflowId: string; connectionId: string; targetPath: string; targetPathKey: string; } | { kind: "backfill_claim"; handoffId: string; mappingId: string; jobId: string; workflowId: string; connectionId: string; generation: number; targetPath: string; targetPathKey: string; folderId: string; } | { kind: "implicit_claim_collision"; handoffId: string; mappingId: string; jobId: string; workflowId: string; connectionId: string; targetPath: string; targetPathKey: string; diagnostic: string; collisionOwnerProjectId: string; };
export type WorkflowTailIndexes = ({ kind: "none"; } | { kind: "raw_reconciliation"; prerequisiteMarker?: number; } | { kind: "autohdr_handoff_entry"; prerequisiteMarker: number; } | { kind: "autohdr_mapping_entry"; prerequisiteMarker: number; handoffState: number; mappingState: number; } | { kind: "autohdr_final_completion"; prerequisiteMarker: number; handoffState: number; mappingState: number; finalClaimState: number; } | { kind: "autohdr_job_entry"; prerequisiteMarker: number; jobState: number; } | { kind: "autohdr_job_completion"; prerequisiteMarker: number; sourceEntryJob: number; completionJobState: number; }) & { editingEntryToken?: number; };
export type HandoffStartBundle = PreparedStatementBundle<{ handoffStart: number; }> & {
  kind: "handoff_start";
  coupling: Extract<ClosedAutomaticCoupling, { kind: "handoff_start"; }>;
};
export type EditingEntryTokenTailIndexes = { editingEntryToken: number; };
export type TerminalAssertionIndexes = { terminalAssertion: number; };
export type OwnershipAssertionIndexes = { ownershipAssertion: number; };
export type AutoHdrApiFinalizeIndexes = { payloadUpdate: number; finalizedAudit: number; ownershipAssertion: number; };
export type JobEntryProvenanceBundle = PreparedStatementBundle<{ payloadUpdate: number; ownershipAssertion?: number; }> & {
  kind: "job_entry_provenance";
  coupling: Extract<ClosedAutomaticCoupling, { kind: "job_entry_provenance"; }>;
};
export type ClosedOwnershipBundle = (PreparedStatementBundle<{ retireMapping: number; retireHandoff: number; tombstonePaths: number; insertJob: number; insertHandoff: number; insertMapping: number; pathClaims: readonly [number, number]; ownershipAssertion?: number; }> & { kind: "repeat_claim"; coupling: Extract<ClosedAutomaticCoupling, { kind: "repeat_claim"; }>; }) | (PreparedStatementBundle<{ job: number; handoff: number; mapping: number; pathClaim: number; ownershipAssertion?: number; }> & { kind: "implicit_claim"; coupling: Extract<ClosedAutomaticCoupling, { kind: "implicit_claim"; }>; }) | (PreparedStatementBundle<{ job: number; handoff: number; mapping: number; pathClaim: number; ownershipAssertion?: number; }> & { kind: "backfill_claim"; coupling: Extract<ClosedAutomaticCoupling, { kind: "backfill_claim"; }>; }) | (PreparedStatementBundle<{ job: number; handoff: number; mapping: number; ownershipAssertion: number; }> & { kind: "implicit_claim_collision"; coupling: Extract<ClosedAutomaticCoupling, { kind: "implicit_claim_collision"; }>; });
export type ComposedStageBundleIndexes = {
  stage: StageWinnerIndexes;
  activity?: ActivityBundleIndexes;
  deadline?: DeadlineSuppressionIndexes;
  preWinner?: Record<string, number | readonly [number, number] | undefined>;
  state?: { handoffStart: number; };
  workflow: WorkflowTailIndexes;
  token?: EditingEntryTokenTailIndexes;
  terminal?: TerminalAssertionIndexes;
};
export type CommittedStageFinalizerIntent = { publicationIds: string[]; legacyWorkflowNotification?: "raw_ready" | "sent_to_editing" | "edited_landed"; };
export type ExpectedTargetPlacementRow = { projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number; };
export type ExpectedTargetCompactionRow = ExpectedTargetPlacementRow & { newBoardPosition: number; };
export type ChangedCompactionRow = { projectId: string; oldStageKey: StageKey; oldBoardPosition: number; oldBoardRevision: number; newBoardPosition: number; isTarget: 0 | 1; };
export type StageWinnerInput = {
  db: D1Database;
  projectId: string;
  from?: StageKey;
  to?: StageKey;
  sourceStageKey?: StageKey;
  targetStageKey?: StageKey;
  oldBoardRevision?: number;
  targetOldBoardRevision?: number;
  expectedTargetJson?: string;
  expectedTarget?: readonly ExpectedTargetPlacementRow[] | readonly ExpectedTargetCompactionRow[];
  expectedTargetRowCount?: number;
  workflowPremise?: GuardedTransitionPrerequisite;
  auditId: string;
  actorId?: string | null;
  action?: string;
  auditAction?: string;
  meta?: Record<string, unknown>;
  auditMetaJson?: string;
  auditMeta?: Record<string, unknown>;
  now?: number;
  updatedAt?: number;
};
export type NonCompactingStageWinnerInput = StageWinnerInput & { placement: "append" | "exact"; boardPosition?: number; exactBoardPosition?: number; position?: number; };
export type CompactingStageWinnerInput = StageWinnerInput & { expectedTargetJson?: string; expectedTarget?: readonly ExpectedTargetCompactionRow[]; changedPlanJson?: string; changedPlan?: readonly ChangedCompactionRow[]; expectedChangedRowCount?: number; };
export type StageWinnerResultRow = { projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number; };
export type StageFinalizerWinnerResult = { kind: "winner"; row: StageWinnerResultRow; auditId: string; publicationIds?: readonly string[]; legacyWorkflowNotification?: CommittedStageFinalizerIntent["legacyWorkflowNotification"]; } | { kind: "loser" | "no_op" | "conflict" | "inconsistent"; };
const EXPECTED_KEYS = {
  none: ["kind"],
  raw_reconciliation: ["kind", "projectId", "claimId", "claimStates", "shootDate"],
  autohdr_handoff: ["kind", "projectId", "handoffId", "jobId", "generation", "connectionId", "expectedStates", "expectedPriorToken"],
  autohdr_mapping: ["kind", "projectId", "mappingId", "handoffId", "generation", "connectionId", "mappingStates", "handoffStates", "expectedPriorToken"],
  autohdr_final_claim: ["kind", "projectId", "collectionId", "sourcePathKey", "currentAssetId", "handoffId", "mappingId", "fetchClaimId", "fetchJobId", "generation", "connectionId", "mappingStates", "handoffStates", "fetchStates", "manifestVersion", "finalPathKey", "expectedPriorToken"],
  autohdr_job_entry: ["kind", "mode", "projectId", "jobId", "jobKind", "generation", "jobStates", "expectedPriorToken"],
  autohdr_job_completion: ["kind", "mode", "projectId", "jobId", "jobKind", "jobStates", "sourceJobId", "sourceJobKinds", "sourceJobStates", "generation", "expectedPriorToken"]
} as const;
export const COUPLING_EXPECTED_KEYS = {
  none: ["kind"],
  handoff_start: ["kind", "handoffId", "connectionId", "generation"],
  job_entry_provenance: ["kind", "jobId", "jobKind", "generation", "jobStates"],
  autohdr_api_finalize: ["kind", "jobId", "uid", "assetCount", "finalizedAuditId"],
  repeat_claim: ["kind", "retiredHandoffId", "retiredMappingId", "handoffId", "mappingId", "jobId", "workflowId", "generation", "connectionId", "selectionHash", "expectedFinalHandoffState", "pathClaims"],
  implicit_claim: ["kind", "handoffId", "mappingId", "jobId", "workflowId", "connectionId", "targetPath", "targetPathKey"],
  backfill_claim: ["kind", "handoffId", "mappingId", "jobId", "workflowId", "connectionId", "generation", "targetPath", "targetPathKey", "folderId"],
  implicit_claim_collision: ["kind", "handoffId", "mappingId", "jobId", "workflowId", "connectionId", "targetPath", "targetPathKey", "diagnostic", "collisionOwnerProjectId"]
} as const;
function assertExactKeys(discriminator: string, object: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(object); if (actual.length !== expected.length || expected.some((key, index) => actual[index] !== key)) throw new Error(`Guarded document key mismatch for ${discriminator}: expected ${expected.join(",")}; got ${actual.join(",")}`); for (const key of expected) if (object[key] === undefined) throw new Error(`Guarded document ${discriminator}.${key} is undefined`); }
function assertKeySet(discriminator: string, object: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(object); if (actual.length !== expected.length || expected.some(key => !actual.includes(key))) throw new Error(`Guarded document key mismatch for ${discriminator}: expected ${expected.join(",")}; got ${actual.join(",")}`); for (const key of expected) if (object[key] === undefined) throw new Error(`Guarded document ${discriminator}.${key} is undefined`); }
function nonEmpty(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new Error(`Guarded document ${name} must be a non-empty string`); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Guarded document ${name} must be one of ${allowed.join(",")}`); return value as T; }
function safeInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Guarded document ${name} must be a non-negative safe integer`); return value; }
function nullableSafeInteger(value: unknown, name: string): number | null { return value === null ? null : safeInteger(value, name); }
function lifecycle<T extends string>(value: unknown, allowed: readonly T[], name: string): LifecycleSet<T> { if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || value.some(entry => typeof entry !== "string" || !allowed.includes(entry as T))) throw new Error(`Guarded document ${name} must be a non-empty set of allowed lifecycle values`); return allowed.filter(entry => value.includes(entry)) as unknown as LifecycleSet<T>; }
function closedSet<T extends string>(value: unknown, allowed: readonly T[], name: string): ClosedSet<T> { return lifecycle(value, allowed, name); }
export function compileGuardedTransitionPrerequisite(input: GuardedTransitionPrerequisite): string {
  const discriminator = input.kind === "autohdr_job" ? `autohdr_job_${input.mode}` : input.kind;
  const premiseKeys = EXPECTED_KEYS as Record<string, readonly string[]>;
  assertKeySet(discriminator, input as unknown as Record<string, unknown>, premiseKeys[discriminator]!);
  let canonical: Record<string, unknown>;
  switch (input.kind) {
    case "none":
      canonical = { kind: "none" };
      break;
    case "raw_reconciliation":
      canonical = { kind: input.kind, projectId: nonEmpty(input.projectId, "projectId"), claimId: input.claimId === null ? null : nonEmpty(input.claimId, "claimId"), claimStates: lifecycle(input.claimStates, ["running"], "claimStates"), shootDate: input.shootDate === null ? null : nonEmpty(input.shootDate, "shootDate") };
      break;
    case "autohdr_handoff":
      canonical = {
        kind: input.kind,
        projectId: nonEmpty(input.projectId, "projectId"),
        handoffId: nonEmpty(input.handoffId, "handoffId"),
        jobId: input.jobId === null ? null : nonEmpty(input.jobId, "jobId"),
        generation: safeInteger(input.generation, "generation"),
        connectionId: nonEmpty(input.connectionId, "connectionId"),
        expectedStates: lifecycle(input.expectedStates, ["starting", "started"], "expectedStates"),
        expectedPriorToken: nullableSafeInteger(input.expectedPriorToken, "expectedPriorToken")
      };
      break;
    case "autohdr_mapping":
      canonical = {
        kind: input.kind,
        projectId: nonEmpty(input.projectId, "projectId"),
        mappingId: nonEmpty(input.mappingId, "mappingId"),
        handoffId: nonEmpty(input.handoffId, "handoffId"),
        generation: safeInteger(input.generation, "generation"),
        connectionId: nonEmpty(input.connectionId, "connectionId"),
        mappingStates: lifecycle(input.mappingStates, ["active"], "mappingStates"),
        handoffStates: lifecycle(input.handoffStates, ["starting", "started"], "handoffStates"),
        expectedPriorToken: nullableSafeInteger(input.expectedPriorToken, "expectedPriorToken")
      };
      break;
    case "autohdr_final_claim":
      canonical = {
        kind: input.kind,
        projectId: nonEmpty(input.projectId, "projectId"),
        collectionId: nonEmpty(input.collectionId, "collectionId"),
        sourcePathKey: nonEmpty(input.sourcePathKey, "sourcePathKey"),
        currentAssetId: nonEmpty(input.currentAssetId, "currentAssetId"),
        handoffId: nonEmpty(input.handoffId, "handoffId"),
        mappingId: nonEmpty(input.mappingId, "mappingId"),
        fetchClaimId: nonEmpty(input.fetchClaimId, "fetchClaimId"),
        fetchJobId: nonEmpty(input.fetchJobId, "fetchJobId"),
        generation: safeInteger(input.generation, "generation"),
        connectionId: nonEmpty(input.connectionId, "connectionId"),
        mappingStates: lifecycle(input.mappingStates, ["active"], "mappingStates"),
        handoffStates: lifecycle(input.handoffStates, ["started"], "handoffStates"),
        fetchStates: lifecycle(input.fetchStates, ["starting", "running"], "fetchStates"),
        manifestVersion: safeInteger(input.manifestVersion, "manifestVersion"),
        finalPathKey: nonEmpty(input.finalPathKey, "finalPathKey"),
        expectedPriorToken: safeInteger(input.expectedPriorToken, "expectedPriorToken")
      };
      break;
    case "autohdr_job":
      canonical = input.mode === "entry" ? {
        kind: input.kind,
        mode: input.mode,
        projectId: nonEmpty(input.projectId, "projectId"),
        jobId: nonEmpty(input.jobId, "jobId"),
        jobKind: oneOf(input.jobKind, ["autohdr", "autohdr_api_send"], "jobKind"),
        generation: safeInteger(input.generation, "generation"),
        jobStates: lifecycle(input.jobStates, ["running", "done"], "jobStates"),
        expectedPriorToken: nullableSafeInteger(input.expectedPriorToken, "expectedPriorToken")
      } : {
        kind: input.kind,
        mode: input.mode,
        projectId: nonEmpty(input.projectId, "projectId"),
        jobId: nonEmpty(input.jobId, "jobId"),
        jobKind: oneOf(input.jobKind, ["fetch_edited"], "jobKind"),
        jobStates: lifecycle(input.jobStates, ["queued", "running", "done"], "jobStates"),
        sourceJobId: nonEmpty(input.sourceJobId, "sourceJobId"),
        sourceJobKinds: closedSet(input.sourceJobKinds, ["autohdr", "autohdr_api_send"], "sourceJobKinds"),
        sourceJobStates: lifecycle(input.sourceJobStates, ["queued", "running", "done"], "sourceJobStates"),
        generation: safeInteger(input.generation, "generation"),
        expectedPriorToken: safeInteger(input.expectedPriorToken, "expectedPriorToken")
      };
      break;
  }
  assertExactKeys(discriminator, canonical, premiseKeys[discriminator]!);
  return JSON.stringify(canonical);
}
export function compileClosedAutomaticCoupling(input: ClosedAutomaticCoupling): string {
  assertKeySet(input.kind, input as unknown as Record<string, unknown>, COUPLING_EXPECTED_KEYS[input.kind]);
  let canonical: Record<string, unknown>;
  switch (input.kind) {
    case "none":
      canonical = { kind: "none" };
      break;
    case "handoff_start":
      canonical = { kind: input.kind, handoffId: nonEmpty(input.handoffId, "handoffId"), connectionId: nonEmpty(input.connectionId, "connectionId"), generation: safeInteger(input.generation, "generation") };
      break;
    case "job_entry_provenance":
      canonical = { kind: input.kind, jobId: nonEmpty(input.jobId, "jobId"), jobKind: oneOf(input.jobKind, ["autohdr", "autohdr_api_send"], "jobKind"), generation: safeInteger(input.generation, "generation"), jobStates: lifecycle(input.jobStates, ["running", "done"], "jobStates") };
      break;
    case "autohdr_api_finalize":
      canonical = { kind: input.kind, jobId: nonEmpty(input.jobId, "jobId"), uid: nonEmpty(input.uid, "uid"), assetCount: safeInteger(input.assetCount, "assetCount"), finalizedAuditId: nonEmpty(input.finalizedAuditId, "finalizedAuditId") };
      break;
    case "repeat_claim":
      {
        if (input.pathClaims.length !== 2) throw new Error("repeat_claim requires exactly two path claims");
        const seen = new Set<string>();
        const pathClaims = input.pathClaims.map(claim => {
          assertKeySet("repeat_claim.pathClaim", claim as unknown as Record<string, unknown>, ["kind", "claimId", "candidate", "path", "pathKey"]);
          const kind = oneOf(claim.kind, ["reactivate", "insert"], "pathClaims.kind");
          const claimId = nonEmpty(claim.claimId, "pathClaims.claimId");
          const candidate = oneOf(claim.candidate, ["final", "finals"], "pathClaims.candidate");
          const path = nonEmpty(claim.path, "pathClaims.path");
          const pathKey = nonEmpty(claim.pathKey, "pathClaims.pathKey");
          if (seen.has(pathKey)) throw new Error("repeat_claim pathKeys must be distinct");
          seen.add(pathKey);
          return { kind, claimId, candidate, path, pathKey };
        });
        canonical = {
          kind: input.kind,
          retiredHandoffId: nonEmpty(input.retiredHandoffId, "retiredHandoffId"),
          retiredMappingId: nonEmpty(input.retiredMappingId, "retiredMappingId"),
          handoffId: nonEmpty(input.handoffId, "handoffId"),
          mappingId: nonEmpty(input.mappingId, "mappingId"),
          jobId: nonEmpty(input.jobId, "jobId"),
          workflowId: nonEmpty(input.workflowId, "workflowId"),
          generation: safeInteger(input.generation, "generation"),
          connectionId: nonEmpty(input.connectionId, "connectionId"),
          selectionHash: nonEmpty(input.selectionHash, "selectionHash"),
          expectedFinalHandoffState: oneOf(input.expectedFinalHandoffState, ["started"], "expectedFinalHandoffState"),
          pathClaims
        };
        break;
      }
    case "implicit_claim":
      canonical = { kind: input.kind, handoffId: nonEmpty(input.handoffId, "handoffId"), mappingId: nonEmpty(input.mappingId, "mappingId"), jobId: nonEmpty(input.jobId, "jobId"), workflowId: nonEmpty(input.workflowId, "workflowId"), connectionId: nonEmpty(input.connectionId, "connectionId"), targetPath: nonEmpty(input.targetPath, "targetPath"), targetPathKey: nonEmpty(input.targetPathKey, "targetPathKey") };
      break;
    case "backfill_claim":
      canonical = {
        kind: input.kind,
        handoffId: nonEmpty(input.handoffId, "handoffId"),
        mappingId: nonEmpty(input.mappingId, "mappingId"),
        jobId: nonEmpty(input.jobId, "jobId"),
        workflowId: nonEmpty(input.workflowId, "workflowId"),
        connectionId: nonEmpty(input.connectionId, "connectionId"),
        generation: safeInteger(input.generation, "generation"),
        targetPath: nonEmpty(input.targetPath, "targetPath"),
        targetPathKey: nonEmpty(input.targetPathKey, "targetPathKey"),
        folderId: nonEmpty(input.folderId, "folderId")
      };
      break;
    case "implicit_claim_collision":
      canonical = {
        kind: input.kind,
        handoffId: nonEmpty(input.handoffId, "handoffId"),
        mappingId: nonEmpty(input.mappingId, "mappingId"),
        jobId: nonEmpty(input.jobId, "jobId"),
        workflowId: nonEmpty(input.workflowId, "workflowId"),
        connectionId: nonEmpty(input.connectionId, "connectionId"),
        targetPath: nonEmpty(input.targetPath, "targetPath"),
        targetPathKey: nonEmpty(input.targetPathKey, "targetPathKey"),
        diagnostic: nonEmpty(input.diagnostic, "diagnostic"),
        collisionOwnerProjectId: nonEmpty(input.collisionOwnerProjectId, "collisionOwnerProjectId")
      };
      break;
  }
  assertExactKeys(input.kind, canonical, COUPLING_EXPECTED_KEYS[input.kind]);
  return JSON.stringify(canonical);
}
const json = (param: number, path: string) => `json_extract(?${param}, '$.${path}')`;
const jsonArray = (param: number, path: string) => `json_each(json_extract(?${param}, '$.${path}'))`;
function workflowPremiseSql(input: GuardedTransitionPrerequisite, premiseParam: number, projectParam: number, oldRevisionParam: number): string {
  if (input.kind === "none") return "1";
  if (input.kind === "raw_reconciliation") { return String.raw`EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?${projectParam}
    AND p.archived_at IS NULL
    AND p.shoot_date IS ${json(premiseParam, "shootDate")}
)
AND (
  ${json(premiseParam, "claimId")} IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = ${json(premiseParam, "claimId")}
      AND rc.project_id = ?${projectParam}
      AND rc.state IN (
        SELECT value
        FROM ${jsonArray(premiseParam, "claimStates")}
      )
  )
)`; }
  if (input.kind === "autohdr_handoff") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(premiseParam, "handoffId")}
    AND h.project_id = ?${projectParam}
    AND h.connection_id = ${json(premiseParam, "connectionId")}
    AND h.generation = ${json(premiseParam, "generation")}
    AND h.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "expectedStates")}
    )
    AND h.editing_entry_board_revision IS ${json(premiseParam, "expectedPriorToken")}
    AND (
      ${json(premiseParam, "jobId")} IS NULL
      OR h.job_id = ${json(premiseParam, "jobId")}
    )
)`; }
  if (input.kind === "autohdr_mapping") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = ${json(premiseParam, "mappingId")}
    AND m.project_id = ?${projectParam}
    AND m.handoff_id = ${json(premiseParam, "handoffId")}
    AND m.connection_id = ${json(premiseParam, "connectionId")}
    AND m.generation = ${json(premiseParam, "generation")}
    AND m.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "mappingStates")}
    )
    AND h.project_id = ?${projectParam}
    AND h.connection_id = ${json(premiseParam, "connectionId")}
    AND h.generation = ${json(premiseParam, "generation")}
    AND h.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "handoffStates")}
    )
    AND h.editing_entry_board_revision IS ${json(premiseParam, "expectedPriorToken")}
)`; }
  if (input.kind === "autohdr_final_claim") { return String.raw`EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = ${json(premiseParam, "mappingId")}
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = ${json(premiseParam, "fetchClaimId")}
   AND f.project_id = ?${projectParam}
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = ${json(premiseParam, "collectionId")}
    AND esc.source_path_key = ${json(premiseParam, "sourcePathKey")}
    AND esc.current_asset_id = ${json(premiseParam, "currentAssetId")}
    AND esc.handoff_id = ${json(premiseParam, "handoffId")}
    AND c.project_id = ?${projectParam}
    AND c.kind = 'edited'
    AND h.project_id = ?${projectParam}
    AND h.connection_id = ${json(premiseParam, "connectionId")}
    AND h.generation = ${json(premiseParam, "generation")}
    AND h.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "handoffStates")}
    )
    AND h.manifest_version = ${json(premiseParam, "manifestVersion")}
    AND h.editing_entry_board_revision = ?${oldRevisionParam}
    AND h.editing_entry_board_revision IS ${json(premiseParam, "expectedPriorToken")}
    AND m.project_id = ?${projectParam}
    AND m.connection_id = ${json(premiseParam, "connectionId")}
    AND m.generation = ${json(premiseParam, "generation")}
    AND m.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "mappingStates")}
    )
    AND m.final_path_key = ${json(premiseParam, "finalPathKey")}
    AND f.connection_id = ${json(premiseParam, "connectionId")}
    AND f.mapping_generation = ${json(premiseParam, "generation")}
    AND f.job_id = ${json(premiseParam, "fetchJobId")}
    AND f.state IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "fetchStates")}
    )
)`; }
  if (input.mode === "entry") { return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(premiseParam, "jobId")}
    AND j.kind = ${json(premiseParam, "jobKind")}
    AND j.project_id = ?${projectParam}
    AND j.status IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "jobStates")}
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?${projectParam}
    AND CAST(json_extract(j.payload_json, '$.generation') AS INTEGER) =
        ${json(premiseParam, "generation")}
    AND j.stage_entry_board_revision IS ${json(premiseParam, "expectedPriorToken")}
)`; }
  return String.raw`EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source ON source.id = ${json(premiseParam, "sourceJobId")}
  WHERE completion.id = ${json(premiseParam, "jobId")}
    AND completion.kind = ${json(premiseParam, "jobKind")}
    AND completion.project_id = ?${projectParam}
    AND completion.status IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "jobStates")}
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?${projectParam}
    AND json_extract(completion.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(completion.payload_json, '$.stageEntryGeneration') =
        ${json(premiseParam, "generation")}
    AND source.kind IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "sourceJobKinds")}
    )
    AND source.project_id = ?${projectParam}
    AND source.status IN (
      SELECT value
      FROM ${jsonArray(premiseParam, "sourceJobStates")}
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?${projectParam}
    AND json_extract(source.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(source.payload_json, '$.stageEntryGeneration') =
        ${json(premiseParam, "generation")}
    AND source.stage_entry_board_revision = ?${oldRevisionParam}
    AND source.stage_entry_board_revision IS ${json(premiseParam, "expectedPriorToken")}
)`;
}
function genericWorkflowPremiseSql(premiseParam: number, projectParam: number, oldRevisionParam: number): string { const kind = json(premiseParam, "kind"); return String.raw`(${kind} = 'none')
OR (
  ${kind} = 'raw_reconciliation'
  AND ${workflowPremiseSql({ kind: "raw_reconciliation", projectId: "", claimId: null, claimStates: ["running"], shootDate: null }, premiseParam, projectParam, oldRevisionParam)}
)
OR (
  ${kind} = 'autohdr_handoff'
  AND ${workflowPremiseSql({ kind: "autohdr_handoff", projectId: "", handoffId: "", jobId: null, generation: 0, connectionId: "", expectedStates: ["starting"], expectedPriorToken: null }, premiseParam, projectParam, oldRevisionParam)}
)
OR (
  ${kind} = 'autohdr_mapping'
  AND ${workflowPremiseSql({ kind: "autohdr_mapping", projectId: "", mappingId: "", handoffId: "", generation: 0, connectionId: "", mappingStates: ["active"], handoffStates: ["starting"], expectedPriorToken: null }, premiseParam, projectParam, oldRevisionParam)}
)
OR (
  ${kind} = 'autohdr_final_claim'
  AND ${workflowPremiseSql({
  kind: "autohdr_final_claim",
  projectId: "",
  collectionId: "",
  sourcePathKey: "",
  currentAssetId: "",
  handoffId: "",
  mappingId: "",
  fetchClaimId: "",
  fetchJobId: "",
  generation: 0,
  connectionId: "",
  mappingStates: ["active"],
  handoffStates: ["started"],
  fetchStates: ["starting"],
  manifestVersion: 0,
  finalPathKey: "",
  expectedPriorToken: 0
}, premiseParam, projectParam, oldRevisionParam)}
)
OR (
  ${kind} = 'autohdr_job'
  AND ${json(premiseParam, "mode")} = 'entry'
  AND ${workflowPremiseSql({
  kind: "autohdr_job",
  mode: "entry",
  projectId: "",
  jobId: "",
  jobKind: "autohdr",
  generation: 0,
  jobStates: ["running"],
  expectedPriorToken: null
}, premiseParam, projectParam, oldRevisionParam)}
)
OR (
  ${kind} = 'autohdr_job'
  AND ${json(premiseParam, "mode")} = 'completion'
  AND ${workflowPremiseSql({
  kind: "autohdr_job",
  mode: "completion",
  projectId: "",
  jobId: "",
  jobKind: "fetch_edited",
  jobStates: ["queued"],
  sourceJobId: "",
  sourceJobKinds: ["autohdr"],
  sourceJobStates: ["queued"],
  generation: 0,
  expectedPriorToken: 0
}, premiseParam, projectParam, oldRevisionParam)}
)`; }
export function workflowPremiseCte(premiseParam: number, projectParam: number, oldRevisionParam: number): string { return String.raw`workflow_premise AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE ${genericWorkflowPremiseSql(premiseParam, projectParam, oldRevisionParam)}
)`; }
function jobEntryProvenancePostconditionSql(param: number, expectedEntryRevision?: string): string {
  const token = expectedEntryRevision === undefined ? "" : `\n    AND j.stage_entry_board_revision = ${expectedEntryRevision}`;
  return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = ${json(param, "jobKind")}
    AND j.project_id = ?1
    AND j.status IN (
      SELECT value
      FROM ${jsonArray(param, "jobStates")}
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') = ${json(param, "generation")}
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') = ${json(param, "jobId")}
    AND json_extract(j.payload_json, '$.stageEntryGeneration') = ${json(param, "generation")}${token}
)`;
}
function workflowDurablePostconditionSql(premise: GuardedTransitionPrerequisite, param = 4): string {
  if (premise.kind === "none") return "1";
  if (premise.kind === "autohdr_job" && premise.mode === "entry") return jobEntryProvenancePostconditionSql(param, "?3 + 1");
  if (premise.kind === "raw_reconciliation") { return String.raw`EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?1
    AND p.shoot_date IS ${json(param, "shootDate")}
)
AND (
  ${json(param, "claimId")} IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = ${json(param, "claimId")}
      AND rc.project_id = ?1
      AND rc.state IN (
        SELECT value
        FROM ${jsonArray(param, "claimStates")}
      )
  )
)`; }
  if (premise.kind === "autohdr_handoff") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
    AND (
      ${json(param, "jobId")} IS NULL
      OR h.job_id = ${json(param, "jobId")}
    )
)`; }
  if (premise.kind === "autohdr_mapping") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = ${json(param, "mappingId")}
    AND m.project_id = ?1
    AND m.handoff_id = ${json(param, "handoffId")}
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = ${json(param, "generation")}
    AND m.state IN (
      SELECT value
      FROM ${jsonArray(param, "mappingStates")}
    )
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
)`; }
  if (premise.kind === "autohdr_final_claim") { return String.raw`EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = ${json(param, "mappingId")}
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = ${json(param, "fetchClaimId")}
   AND f.project_id = ?1
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = ${json(param, "collectionId")}
    AND esc.source_path_key = ${json(param, "sourcePathKey")}
    AND esc.current_asset_id = ${json(param, "currentAssetId")}
    AND esc.handoff_id = ${json(param, "handoffId")}
    AND c.project_id = ?1
    AND c.kind = 'edited'
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.state IN (
      SELECT value
      FROM ${jsonArray(param, "handoffStates")}
    )
    AND h.manifest_version = ${json(param, "manifestVersion")}
    AND h.editing_entry_board_revision = ?3
    AND m.project_id = ?1
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = ${json(param, "generation")}
    AND m.state IN (
      SELECT value
      FROM ${jsonArray(param, "mappingStates")}
    )
    AND m.final_path_key = ${json(param, "finalPathKey")}
    AND f.connection_id = ${json(param, "connectionId")}
    AND f.mapping_generation = ${json(param, "generation")}
    AND f.job_id = ${json(param, "fetchJobId")}
    AND f.state IN (
      SELECT value
      FROM ${jsonArray(param, "fetchStates")}
    )
)`; }
  return String.raw`EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source ON source.id = ${json(param, "sourceJobId")}
  WHERE completion.id = ${json(param, "jobId")}
    AND completion.kind = ${json(param, "jobKind")}
    AND completion.project_id = ?1
    AND completion.status IN (
      SELECT value
      FROM ${jsonArray(param, "jobStates")}
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?1
    AND json_extract(completion.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(completion.payload_json, '$.stageEntryGeneration') =
        ${json(param, "generation")}
    AND source.kind IN (
      SELECT value
      FROM ${jsonArray(param, "sourceJobKinds")}
    )
    AND source.project_id = ?1
    AND source.status IN (
      SELECT value
      FROM ${jsonArray(param, "sourceJobStates")}
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?1
    AND json_extract(source.payload_json, '$.stageEntrySourceJobId') = source.id
    AND json_extract(source.payload_json, '$.stageEntryGeneration') =
        ${json(param, "generation")}
    AND source.stage_entry_board_revision = ?3
)`;
}
function couplingPostconditionSql(coupling: ClosedAutomaticCoupling, param: number): string {
  if (coupling.kind === "none") return "1";
  if (coupling.kind === "handoff_start") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.state = 'started'
    AND h.started_at IS NOT NULL
)`; }
  if (coupling.kind === "job_entry_provenance") return jobEntryProvenancePostconditionSql(param);
  if (coupling.kind === "autohdr_api_finalize") { return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = 'autohdr_api_send'
    AND j.project_id = ?1
    AND j.status IN ('running', 'done')
    AND j.error IS NULL
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') = 1
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') = ${json(param, "jobId")}
    AND json_extract(j.payload_json, '$.stageEntryGeneration') = 1
    AND json_extract(j.payload_json, '$.phase') = 'finalized'
    AND json_extract(j.payload_json, '$.uid') = ${json(param, "uid")}
)
AND EXISTS (
  SELECT 1
  FROM audit_log a
  WHERE a.id = ${json(param, "finalizedAuditId")}
    AND a.action = 'project.autohdr_api_send.finalized'
    AND a.target_type = 'project'
    AND a.target_id = ?1
    AND json_valid(a.meta_json)
    AND json_extract(a.meta_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(a.meta_json, '$.jobId') = ${json(param, "jobId")}
    AND json_extract(a.meta_json, '$.uid') = ${json(param, "uid")}
    AND json_extract(a.meta_json, '$.assetCount') = ${json(param, "assetCount")}
    AND json_extract(a.meta_json, '$.retrievalEnabled') = 0
)`; }
  if (coupling.kind === "repeat_claim") { return String.raw`EXISTS (
  SELECT 1
  FROM autohdr_output_mappings old_m
  WHERE old_m.id = ${json(param, "retiredMappingId")}
    AND old_m.handoff_id = ${json(param, "retiredHandoffId")}
    AND old_m.project_id = ?1
    AND old_m.state = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs old_h
  WHERE old_h.id = ${json(param, "retiredHandoffId")}
    AND old_h.project_id = ?1
    AND old_h.state = 'retired'
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims old_pc
  WHERE old_pc.mapping_id = ${json(param, "retiredMappingId")}
    AND old_pc.state IN ('active', 'pending', 'blocked')
)
AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = 'autohdr'
    AND j.status = 'queued'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.handoffId') = ${json(param, "handoffId")}
    AND json_extract(j.payload_json, '$.generation') = ${json(param, "generation")}
    AND json_extract(j.payload_json, '$.connectionId') = ${json(param, "connectionId")}
    AND json_extract(j.payload_json, '$.retiredHandoffId') = ${json(param, "retiredHandoffId")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.job_id = ${json(param, "jobId")}
    AND h.workflow_id = ${json(param, "workflowId")}
    AND h.selection_hash = ${json(param, "selectionHash")}
    AND h.state = ${json(param, "expectedFinalHandoffState")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = ${json(param, "mappingId")}
    AND m.project_id = ?1
    AND m.handoff_id = ${json(param, "handoffId")}
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = ${json(param, "generation")}
    AND m.state = 'pending_discovery'
)
AND (
  SELECT COUNT(*)
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = ${json(param, "mappingId")}
    AND pc.handoff_id = ${json(param, "handoffId")}
    AND pc.project_id = ?1
    AND pc.connection_id = ${json(param, "connectionId")}
    AND pc.state = 'pending'
) = 2
AND COALESCE(json_array_length(${json(param, "pathClaims")}), 0) = 2
AND NOT EXISTS (
  SELECT 1
  FROM ${jsonArray(param, "pathClaims")} expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM autohdr_path_claims pc
    WHERE pc.mapping_id = ${json(param, "mappingId")}
      AND pc.handoff_id = ${json(param, "handoffId")}
      AND pc.project_id = ?1
      AND pc.connection_id = ${json(param, "connectionId")}
      AND pc.path_key = json_extract(expected.value, '$.pathKey')
      AND pc.state = 'pending'
  )
)`; }
  if (coupling.kind === "implicit_claim") { return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') = ${json(param, "targetPath")}
    AND json_extract(j.payload_json, '$.isCollision') = 0
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = 1
    AND h.job_id = ${json(param, "jobId")}
    AND h.workflow_id = ${json(param, "workflowId")}
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = ${json(param, "mappingId")}
    AND m.project_id = ?1
    AND m.handoff_id = ${json(param, "handoffId")}
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = 1
    AND m.state = 'active'
    AND m.final_path_key = ${json(param, "targetPathKey")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = ${json(param, "mappingId")}
    AND pc.handoff_id = ${json(param, "handoffId")}
    AND pc.project_id = ?1
    AND pc.connection_id = ${json(param, "connectionId")}
    AND pc.path_key = ${json(param, "targetPathKey")}
    AND pc.state = 'active'
)`; }
  if (coupling.kind === "backfill_claim") { return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.backfill') = 1
    AND json_extract(j.payload_json, '$.targetPath') = ${json(param, "targetPath")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = ${json(param, "generation")}
    AND h.job_id = ${json(param, "jobId")}
    AND h.workflow_id = ${json(param, "workflowId")}
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = ${json(param, "mappingId")}
    AND m.project_id = ?1
    AND m.handoff_id = ${json(param, "handoffId")}
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = ${json(param, "generation")}
    AND m.state = 'active'
    AND m.final_path_key = ${json(param, "targetPathKey")}
    AND m.folder_id = ${json(param, "folderId")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = ${json(param, "mappingId")}
    AND pc.handoff_id = ${json(param, "handoffId")}
    AND pc.project_id = ?1
    AND pc.connection_id = ${json(param, "connectionId")}
    AND pc.path_key = ${json(param, "targetPathKey")}
    AND pc.folder_id = ${json(param, "folderId")}
    AND pc.state = 'active'
)`; }
  return String.raw`EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ${json(param, "jobId")}
    AND j.kind = 'autohdr'
    AND j.project_id = ?1
    AND j.status = 'failed'
    AND j.error = ${json(param, "diagnostic")}
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') = ${json(param, "targetPath")}
    AND json_extract(j.payload_json, '$.isCollision') = 1
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = ${json(param, "handoffId")}
    AND h.project_id = ?1
    AND h.connection_id = ${json(param, "connectionId")}
    AND h.generation = 1
    AND h.job_id = ${json(param, "jobId")}
    AND h.workflow_id = ${json(param, "workflowId")}
    AND h.state = 'retired'
    AND h.last_error = ${json(param, "diagnostic")}
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = ${json(param, "mappingId")}
    AND m.project_id = ?1
    AND m.handoff_id = ${json(param, "handoffId")}
    AND m.connection_id = ${json(param, "connectionId")}
    AND m.generation = 1
    AND m.state = 'blocked_collision'
    AND m.final_path_key = ${json(param, "targetPathKey")}
    AND m.diagnostic = ${json(param, "diagnostic")}
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = ${json(param, "mappingId")}
     OR (
       pc.connection_id = ${json(param, "connectionId")}
       AND pc.path_key = ${json(param, "targetPathKey")}
       AND pc.project_id = ?1
     )
)`;
}
function terminalAssertionSql(workflow: GuardedTransitionPrerequisite, coupling: ClosedAutomaticCoupling): string { return String.raw`WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS destination_stage,
    ?3 AS old_board_revision,
    ?4 AS premise_doc,
    ?5 AS stage_audit_id,
    ?6 AS winner_required,
    ?7 AS asserted_at,
    ?8 AS coupling_doc
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'stage.auto_advance.bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT COALESCE(json_valid(i.premise_doc), 0)
  OR NOT COALESCE(json_valid(i.coupling_doc), 0)
  OR (
    (
      i.winner_required = 1
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
    )
    OR (
      EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM projects p
          WHERE p.id = i.project_id
            AND p.stage_key = i.destination_stage
            AND p.board_revision = i.old_board_revision + 1
            AND p.archived_at IS NULL
        )
        OR NOT COALESCE((` + workflowDurablePostconditionSql(workflow) + String.raw`), 0)
        OR NOT COALESCE((` + couplingPostconditionSql(coupling, 8) + String.raw`), 0)
      )
    )
  );
`; }
function ownershipAssertionSql(coupling: ClosedAutomaticCoupling = { kind: "none" }): string { return String.raw`WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS asserted_at,
    ?3 AS coupling_doc,
    ?4 AS destination_stage
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'automatic.closed_bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT COALESCE(json_valid(i.coupling_doc), 0)
  OR NOT COALESCE(
    EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = i.project_id
        AND p.stage_key = i.destination_stage
        AND p.archived_at IS NULL
    ),
    0
  )
  OR NOT COALESCE((` + couplingPostconditionSql(coupling, 3) + String.raw`), 0);
`; }
export const NORMATIVE_TERMINAL_ASSERTION_SQL = terminalAssertionSql({ kind: "none" }, { kind: "none" });
export const NORMATIVE_OWNERSHIP_ASSERTION_SQL = ownershipAssertionSql();
export const NON_COMPACTING_EXACT_SQL = String.raw`WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
${workflowPremiseCte(10, 5, 7)},
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?2
      AND enabled = 1
  )
  AND json_valid(?1)
  AND (SELECT COUNT(*) FROM expected_target) = ?3
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?4
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
  )
  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ) = ?3
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?4
      AND p.archived_at IS NULL
      AND p.id <> ?5
      AND e.project_id IS NULL
  )
  AND EXISTS (SELECT 1 FROM workflow_premise)
)
UPDATE projects AS p
SET
  stage_key = ?4,
  board_position = ?8,
  board_revision = p.board_revision + 1,
  updated_at = ?9
FROM fence
WHERE p.id = ?5
  AND p.stage_key = ?6
  AND p.board_revision = ?7
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
`;
export const APPEND_STAGE_BOTTOM_SQL = String.raw`SELECT COALESCE(MAX(board_position) + 1024, 0)
FROM projects
WHERE stage_key = ?1
  AND archived_at IS NULL
  AND id <> ?2
`;
export const NON_COMPACTING_APPEND_SQL = String.raw`WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
${workflowPremiseCte(10, 5, 7)},
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?2
      AND enabled = 1
  )
  AND json_valid(?1)
  AND (SELECT COUNT(*) FROM expected_target) = ?3
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?4
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
  )
  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ) = ?3
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?3
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?5
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?4
      AND p.archived_at IS NULL
      AND p.id <> ?5
      AND e.project_id IS NULL
  )
  AND EXISTS (SELECT 1 FROM workflow_premise)
)
UPDATE projects AS p
SET
  stage_key = ?4,
  board_position = (
    SELECT COALESCE(MAX(board_position) + 1024, 0)
    FROM projects
    WHERE stage_key = ?4
      AND archived_at IS NULL
      AND id <> ?5
  ),
  board_revision = p.board_revision + 1,
  updated_at = ?9
FROM fence
WHERE p.id = ?5
  AND p.stage_key = ?6
  AND p.board_revision = ?7
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
`;
export const COMPACTING_SQL = String.raw`WITH
expected_target AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.stageKey') AS stage_key,
    json_type(value, '$.stageKey') AS stage_key_type,
    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
    json_type(value, '$.boardPosition') AS board_position_type,
    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
    json_type(value, '$.boardRevision') AS board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type
  FROM json_each(
    CASE WHEN json_valid(?1) THEN ?1 ELSE '[]' END
  )
),
changed_plan AS (
  SELECT
    json_extract(value, '$.projectId') AS project_id,
    json_type(value, '$.projectId') AS project_id_type,
    json_extract(value, '$.oldStageKey') AS old_stage_key,
    json_type(value, '$.oldStageKey') AS old_stage_key_type,
    CAST(json_extract(value, '$.oldBoardPosition') AS REAL) AS old_board_position,
    json_type(value, '$.oldBoardPosition') AS old_board_position_type,
    CAST(json_extract(value, '$.oldBoardRevision') AS INTEGER) AS old_board_revision,
    json_type(value, '$.oldBoardRevision') AS old_board_revision_type,
    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
    json_type(value, '$.newBoardPosition') AS new_board_position_type,
    CAST(json_extract(value, '$.isTarget') AS INTEGER) AS is_target,
    json_type(value, '$.isTarget') AS is_target_type
  FROM json_each(
    CASE WHEN json_valid(?2) THEN ?2 ELSE '[]' END
  )
),
required_changed AS (
  SELECT ?7 AS project_id
  UNION ALL
  SELECT project_id
  FROM expected_target
  WHERE new_board_position IS NOT board_position
),
planned_destination AS (
  SELECT project_id, new_board_position
  FROM expected_target
  UNION ALL
  SELECT project_id, new_board_position
  FROM changed_plan
  WHERE is_target = 1
),
ordered_destination AS (
  SELECT
    project_id,
    new_board_position,
    ROW_NUMBER() OVER (
      ORDER BY new_board_position, project_id
    ) - 1 AS desired_rank
  FROM planned_destination
),
${workflowPremiseCte(11, 7, 9)},
fence AS MATERIALIZED (
  SELECT 1 AS ok
  WHERE EXISTS (
    SELECT 1
    FROM feature_flags
    WHERE key = ?3
      AND enabled = 1
  )
  AND json_valid(?1)
  AND json_valid(?2)

  AND (SELECT COUNT(*) FROM expected_target) = ?5
  AND (SELECT COUNT(DISTINCT project_id) FROM expected_target) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target
    WHERE project_id_type <> 'text'
       OR stage_key_type <> 'text'
       OR stage_key IS NOT ?6
       OR board_position_type NOT IN ('integer', 'real')
       OR board_revision_type <> 'integer'
       OR board_revision < 0
       OR board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
  )

  AND (
    SELECT COUNT(*)
    FROM projects
    WHERE stage_key = ?6
      AND archived_at IS NULL
      AND id <> ?7
  ) = ?5
  AND (
    SELECT COUNT(*)
    FROM expected_target e
    JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.stage_key = e.stage_key
      AND p.board_position IS e.board_position
      AND p.board_revision = e.board_revision
      AND p.archived_at IS NULL
  ) = ?5
  AND NOT EXISTS (
    SELECT 1
    FROM expected_target e
    LEFT JOIN projects p
      ON p.id = e.project_id
     AND p.id <> ?7
    WHERE p.id IS NULL
       OR p.stage_key IS NOT e.stage_key
       OR p.board_position IS NOT e.board_position
       OR p.board_revision IS NOT e.board_revision
       OR p.archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM projects p
    LEFT JOIN expected_target e
      ON e.project_id = p.id
    WHERE p.stage_key = ?6
      AND p.archived_at IS NULL
      AND p.id <> ?7
      AND e.project_id IS NULL
  )

  AND (SELECT COUNT(*) FROM changed_plan) = ?4
  AND (SELECT COUNT(DISTINCT project_id) FROM changed_plan) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE project_id_type <> 'text'
       OR old_stage_key_type <> 'text'
       OR old_board_position_type NOT IN ('integer', 'real')
       OR old_board_revision_type <> 'integer'
       OR old_board_revision < 0
       OR old_board_revision > 9007199254740991
       OR new_board_position_type NOT IN ('integer', 'real')
       OR is_target_type <> 'integer'
       OR is_target NOT IN (0, 1)
  )
  AND (
    SELECT COUNT(*)
    FROM changed_plan
    WHERE is_target = 1
  ) = 1
  AND EXISTS (
    SELECT 1
    FROM changed_plan
    WHERE is_target = 1
      AND project_id = ?7
      AND old_stage_key = ?8
      AND old_board_revision = ?9
  )

  AND (SELECT COUNT(*) FROM required_changed) = ?4
  AND NOT EXISTS (
    SELECT 1
    FROM required_changed r
    LEFT JOIN changed_plan c
      ON c.project_id = r.project_id
    WHERE c.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    LEFT JOIN required_changed r
      ON r.project_id = c.project_id
    WHERE r.project_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM changed_plan c
    WHERE c.is_target = 0
      AND NOT EXISTS (
        SELECT 1
        FROM expected_target e
        WHERE e.project_id = c.project_id
          AND e.stage_key = c.old_stage_key
          AND e.board_position IS c.old_board_position
          AND e.board_revision = c.old_board_revision
          AND e.new_board_position IS c.new_board_position
      )
  )

  AND (SELECT COUNT(*) FROM planned_destination) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT project_id)
    FROM planned_destination
  ) = ?5 + 1
  AND (
    SELECT COUNT(DISTINCT new_board_position)
    FROM planned_destination
  ) = ?5 + 1
  AND NOT EXISTS (
    SELECT 1
    FROM ordered_destination
    WHERE new_board_position IS NOT CAST(desired_rank * 1024 AS REAL)
  )

  AND (
    SELECT COUNT(*)
    FROM changed_plan c
    JOIN projects p
      ON p.id = c.project_id
    WHERE p.stage_key = c.old_stage_key
      AND p.board_position IS c.old_board_position
      AND p.board_revision = c.old_board_revision
      AND p.archived_at IS NULL
  ) = ?4
  AND EXISTS (SELECT 1 FROM workflow_premise)
)
UPDATE projects AS p
SET
  stage_key = CASE
    WHEN c.is_target = 1 THEN ?6
    ELSE p.stage_key
  END,
  board_position = c.new_board_position,
  board_revision = p.board_revision + 1,
  updated_at = ?10
FROM changed_plan c, fence
WHERE p.id = c.project_id
  AND p.stage_key = c.old_stage_key
  AND p.board_position IS c.old_board_position
  AND p.board_revision = c.old_board_revision
  AND p.archived_at IS NULL
RETURNING
  id,
  stage_key,
  board_position,
  board_revision;
`;
const AUDIT_MARKER_SQL = String.raw`INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  ?1,
  ?2,
  ?3,
  'project',
  ?4,
  ?5,
  ?6
WHERE changes() = ?7
RETURNING id;
`;
const HANDOFF_EDITING_ENTRY_TOKEN_SQL = String.raw`UPDATE autohdr_handoffs
SET
  editing_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND project_id = ?1
  AND connection_id = ?4
  AND generation = ?5
  AND state = ?6
  AND editing_entry_board_revision IS ?7
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?8
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  generation,
  editing_entry_board_revision;
`;
const JOB_EDITING_ENTRY_TOKEN_SQL = String.raw`UPDATE jobs
SET
  stage_entry_board_revision = (
    SELECT board_revision
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  ),
  updated_at = ?2
WHERE id = ?3
  AND kind = ?4
  AND project_id = ?1
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.projectId') = ?1
  AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ?5
  AND stage_entry_board_revision IS ?6
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?7
  )
  AND EXISTS (
    SELECT 1
    FROM projects
    WHERE id = ?1
      AND stage_key = 'editing_autohdr'
      AND archived_at IS NULL
  )
RETURNING
  id,
  project_id,
  stage_entry_board_revision;
`;
function jsonRows(jsonValue: string | undefined, rows: readonly unknown[] | undefined): { json: string; count: number; } {
  if (jsonValue !== undefined) {
    let count = 0;
    try { const parsed: unknown = JSON.parse(jsonValue); count = Array.isArray(parsed) ? parsed.length : 0; } catch {}
    return { json: jsonValue, count };
  }
  const value = rows ?? [];
  return { json: JSON.stringify(value), count: value.length };
}
function stageValues(input: StageWinnerInput): { from: StageKey; to: StageKey; oldRevision: number; } {
  const from = input.sourceStageKey ?? input.from;
  const to = input.targetStageKey ?? input.to;
  const oldRevision = input.oldBoardRevision ?? input.targetOldBoardRevision;
  if (!from || !to || oldRevision === undefined) throw new Error("Stage winner requires source/destination Stage and old board revision");
  return { from, to, oldRevision };
}
function auditValues(input: StageWinnerInput, from: StageKey, to: StageKey, changedRows: number): [string, string | null, string, string, string, number, number] {
  return [input.auditId, input.actorId ?? null, input.auditAction ?? input.action ?? "stage.auto_advance", input.projectId, input.auditMetaJson ?? JSON.stringify(input.auditMeta ?? input.meta ?? { from, to, changedRows }), input.updatedAt ?? input.now ?? Date.now(), changedRows];
}
function winnerBundle(winner: D1PreparedStatement, audit: D1PreparedStatement): PreparedStatementBundle<StageWinnerIndexes> {
  return {
    statements: [winner, audit],
    indexes: { winner: 0, auditMarker: 1 }
  };
}
export function buildNonCompactingStageWinner(input: NonCompactingStageWinnerInput): PreparedStatementBundle<StageWinnerIndexes> {
  const { from, to, oldRevision } = stageValues(input);
  const expected = jsonRows(input.expectedTargetJson, input.expectedTarget);
  const count = input.expectedTargetRowCount ?? expected.count;
  const updatedAt = input.updatedAt ?? input.now ?? Date.now();
  const premise = compileGuardedTransitionPrerequisite(input.workflowPremise ?? { kind: "none" });
  const position = input.boardPosition ?? input.exactBoardPosition ?? input.position;
  if (input.placement === "exact" && position === undefined) throw new Error("Exact Stage placement requires boardPosition");
  const values = input.placement === "append" ? [expected.json, BOARD_CONTRACT_FLAG, count, to, input.projectId, from, oldRevision, null, updatedAt, premise] : [expected.json, BOARD_CONTRACT_FLAG, count, to, input.projectId, from, oldRevision, position, updatedAt, premise];
  return winnerBundle(input.db.prepare(input.placement === "append" ? NON_COMPACTING_APPEND_SQL : NON_COMPACTING_EXACT_SQL).bind(...values), input.db.prepare(AUDIT_MARKER_SQL).bind(...auditValues(input, from, to, 1)));
}
export function buildCompactingStageWinner(input: CompactingStageWinnerInput): PreparedStatementBundle<StageWinnerIndexes> {
  const { from, to, oldRevision } = stageValues(input);
  const expected = jsonRows(input.expectedTargetJson, input.expectedTarget);
  const changed = jsonRows(input.changedPlanJson, input.changedPlan);
  const expectedCount = input.expectedTargetRowCount ?? expected.count;
  const changedCount = input.expectedChangedRowCount ?? changed.count;
  const updatedAt = input.updatedAt ?? input.now ?? Date.now();
  const premise = compileGuardedTransitionPrerequisite(input.workflowPremise ?? { kind: "none" });
  return winnerBundle(input.db.prepare(COMPACTING_SQL).bind(expected.json, changed.json, BOARD_CONTRACT_FLAG, changedCount, expectedCount, to, input.projectId, from, oldRevision, updatedAt, premise), input.db.prepare(AUDIT_MARKER_SQL).bind(...auditValues(input, from, to, changedCount)));
}
export type StageActivityBundleInput = { db: D1Database; projectId: string; activityId: string; actorId: string; occurredAt?: number; createdAt?: number; winnerAuditId: string; excludeRecipientId?: string; };
export function buildStageActivityBundle(input: StageActivityBundleInput): PreparedStatementBundle<ActivityBundleIndexes> {
  const occurredAt = input.occurredAt ?? Date.now();
  const activityType: ProjectActivityType = "project.stage.changed";
  const activity = buildProjectActivityStatements({
    db: input.db,
    winnerAuditId: input.winnerAuditId,
    excludeRecipientId: input.excludeRecipientId,
    createdAt: input.createdAt ?? occurredAt,
    intent: {
      schemaVersion: 1,
      activity: {
        id: input.activityId,
        type: activityType,
        projectId: input.projectId,
        actorId: input.actorId,
        actorKind: "user",
        occurredAt,
        source: { kind: "project_stage", id: input.activityId, key: `project-stage:${input.projectId}:transition:${input.activityId}` },
        safePayload: {},
        deepLink: projectActivityDeepLink(activityType, input.projectId)
      },
      broadDelivery: { registryKey: activityType, sourceActivityId: input.activityId, coalesce: null }
    }
  });
  return {
    statements: activity.statements,
    indexes: { activity: activity.activityIndex, broadOutbox: activity.broadOutboxIndex, broadLedger: activity.broadLedgerIndex }
  };
}
export type ProjectDeadlineSuppressionReason = "project_delivered" | "project_archived";
export type DeadlineSuppressionBundleInput = { db: D1Database; projectId: string; now?: number; reason: ProjectDeadlineSuppressionReason; auditId: string; };
export function buildDeadlineSuppressionBundle(input: DeadlineSuppressionBundleInput): PreparedStatementBundle<DeadlineSuppressionIndexes> {
  const now = input.now ?? Date.now();
  const message = `Deadline reminder suppressed: ${input.reason}.`;
  const occurrences = input.db.prepare(`UPDATE project_deadline_occurrences
     SET status = 'superseded', terminal_reason = ?, fired_at = NULL, updated_at = ?
     WHERE project_id = ?
       AND status = 'pending'
       AND EXISTS (
         SELECT 1
         FROM projects p
         WHERE p.id = project_deadline_occurrences.project_id
           AND ((? = 'project_archived' AND p.archived_at IS NOT NULL)
             OR (? = 'project_delivered' AND p.stage_key = 'delivered'))
       )
       AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`).bind(input.reason, now, input.projectId, input.reason, input.reason, input.auditId);
  const ledgers = input.db.prepare(`UPDATE notification_delivery_ledger
     SET status = 'suppressed', last_error_code = 'reauthorization_suppressed',
         last_error = ?, updated_at = ?
     WHERE event_type = 'project.deadline.reminder'
       AND status = 'pending'
       AND EXISTS (
         SELECT 1
         FROM notification_outbox o
         WHERE o.id = notification_delivery_ledger.outbox_id
           AND o.project_id = ?
           AND o.event_type = 'project.deadline.reminder'
           AND o.source_key IN (
             SELECT id
             FROM project_deadline_occurrences
             WHERE project_id = ?
           )
       )
       AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`).bind(message, now, input.projectId, input.projectId, input.auditId);
  const outboxes = input.db.prepare(`UPDATE notification_outbox
     SET status = 'suppressed', lease_token = NULL, lease_expires_at = NULL,
         completed_at = ?, last_error_code = 'reauthorization_suppressed',
         last_error = ?, updated_at = ?
     WHERE project_id = ?
       AND event_type = 'project.deadline.reminder'
       AND status IN ('pending', 'queued')
       AND NOT EXISTS (
         SELECT 1
         FROM notification_delivery_ledger
         WHERE outbox_id = notification_outbox.id
           AND status IN ('pending', 'processing')
       )
       AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`).bind(now, message, now, input.projectId, input.auditId);
  return {
    statements: [occurrences, ledgers, outboxes],
    indexes: { occurrences: 0, ledgers: 1, outboxes: 2 }
  };
}
type WorkflowTailInput = GuardedTransitionPrerequisite & { db: D1Database; auditId: string; now?: number; };
const AUDIT_EXISTS = "AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND action = 'stage.auto_advance' AND target_type = 'project' AND target_id = ?)";
function requireProject(input: WorkflowTailInput): string { if (input.kind === "none") return ""; if (!("projectId" in input)) throw new Error("Workflow tail requires projectId"); return input.projectId; }
function marker(db: D1Database, sqlText: string, values: unknown[]): D1PreparedStatement { return db.prepare(sqlText).bind(...values); }
export function buildHandoffStartTail(input: { db: D1Database; projectId: string; handoffId: string; connectionId: string; generation: number; expectedStates: LifecycleSet<"starting" | "started">; auditId?: string; updatedAt?: number; }): HandoffStartBundle {
  const states = JSON.stringify(lifecycle(input.expectedStates, ["starting", "started"], "expectedStates"));
  const gated = input.auditId === undefined ? "" : "AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?7 AND action = 'stage.auto_advance' AND target_type = 'project' AND target_id = ?1)";
  const values = input.auditId === undefined ? [input.projectId, input.updatedAt ?? Date.now(), input.handoffId, input.connectionId, input.generation, states] : [input.projectId, input.updatedAt ?? Date.now(), input.handoffId, input.connectionId, input.generation, states, input.auditId];
  return {
    statements: [input.db.prepare(`UPDATE autohdr_handoffs SET state = 'started', started_at = COALESCE(started_at, ?2), updated_at = ?2 WHERE id = ?3 AND project_id = ?1 AND connection_id = ?4 AND generation = ?5 AND state IN (SELECT value FROM json_each(?6)) ${gated} RETURNING id, project_id, connection_id, generation, state, started_at, editing_entry_board_revision;`).bind(...values)],
    indexes: { handoffStart: 0 },
    kind: "handoff_start",
    coupling: { kind: "handoff_start", handoffId: input.handoffId, connectionId: input.connectionId, generation: input.generation }
  };
}
export type EditingEntryTokenTailInput = { db: D1Database; owner: "handoff"; projectId: string; handoffId: string; connectionId: string; generation: number; state: string; expectedPriorToken: number | null; auditId: string; updatedAt?: number; } | { db: D1Database; owner: "job"; projectId: string; jobId: string; jobKind: string; generation: number; expectedPriorToken: number | null; auditId: string; updatedAt?: number; };
export function buildEditingEntryTokenTail(input: EditingEntryTokenTailInput): PreparedStatementBundle<EditingEntryTokenTailIndexes> {
  const now = input.updatedAt ?? Date.now();
  const statement = input.owner === "handoff" ? input.db.prepare(HANDOFF_EDITING_ENTRY_TOKEN_SQL).bind(input.projectId, now, input.handoffId, input.connectionId, input.generation, input.state, input.expectedPriorToken, input.auditId) : input.db.prepare(JOB_EDITING_ENTRY_TOKEN_SQL).bind(input.projectId, now, input.jobId, input.jobKind, input.generation, input.expectedPriorToken, input.auditId);
  return {
    statements: [statement],
    indexes: { editingEntryToken: 0 }
  };
}
export type WorkflowTailKind = WorkflowTailIndexes["kind"];
export function buildWorkflowTail(input: WorkflowTailInput, kind: WorkflowTailKind): PreparedStatementBundle<WorkflowTailIndexes> {
  const projectId = requireProject(input);
  if (kind === "none") return {
    statements: [],
    indexes: { kind: "none" }
  };
  if (kind === "raw_reconciliation") {
    if (input.kind !== "raw_reconciliation") throw new Error("raw_reconciliation tail requires its matching prerequisite");
    if (input.claimId === null) return {
      statements: [],
      indexes: { kind }
    };
    return {
      statements: [marker(input.db, `SELECT
  rc.id,
  rc.project_id,
  rc.state
FROM raw_reconciliation_claims rc
WHERE rc.id = ?1
  AND rc.project_id = ?2
  AND rc.state IN (SELECT value FROM json_each(?3))
  AND EXISTS (
    SELECT 1
    FROM projects p
    WHERE p.id = rc.project_id
      AND p.shoot_date IS ?4
  )
  AND EXISTS (
    SELECT 1
    FROM audit_log a
    WHERE a.id = ?5
      AND a.action = 'stage.auto_advance'
      AND a.target_type = 'project'
      AND a.target_id = ?2
  );`, [input.claimId, projectId, JSON.stringify(input.claimStates), input.shootDate, input.auditId])],
      indexes: { kind, prerequisiteMarker: 0 }
    };
  }
  if (kind === "autohdr_handoff_entry") {
    if (input.kind !== "autohdr_handoff") throw new Error("autohdr_handoff_entry tail requires its matching prerequisite");
    return {
      statements: [marker(input.db, `SELECT id, project_id, connection_id, generation, state FROM autohdr_handoffs WHERE id = ?1 AND project_id = ?2 AND connection_id = ?3 AND generation = ?4 AND state = 'started' ${AUDIT_EXISTS};`, [input.handoffId, projectId, input.connectionId, input.generation, input.auditId, projectId])],
      indexes: { kind, prerequisiteMarker: 0 }
    };
  }
  if (kind === "autohdr_mapping_entry") {
    if (input.kind !== "autohdr_mapping") throw new Error("autohdr_mapping_entry tail requires its matching prerequisite");
    return {
      statements: [marker(input.db, `SELECT id, state FROM autohdr_handoffs WHERE id = ?1 AND project_id = ?2 AND connection_id = ?3 AND generation = ?4 AND state = 'started' ${AUDIT_EXISTS};`, [input.handoffId, projectId, input.connectionId, input.generation, input.auditId, projectId]), marker(input.db, `SELECT id, state FROM autohdr_output_mappings WHERE id = ?1 AND project_id = ?2 AND handoff_id = ?3 AND connection_id = ?4 AND generation = ?5 AND state IN (SELECT value FROM json_each(?6)) ${AUDIT_EXISTS};`, [input.mappingId, projectId, input.handoffId, input.connectionId, input.generation, JSON.stringify(input.mappingStates), input.auditId, projectId])],
      indexes: { kind, prerequisiteMarker: 0, handoffState: 0, mappingState: 1 }
    };
  }
  if (kind === "autohdr_final_completion") {
    if (input.kind !== "autohdr_final_claim") throw new Error("autohdr_final_completion tail requires its matching prerequisite");
    return {
      statements: [marker(input.db, `SELECT id FROM edited_source_claims WHERE collection_id = ?1 AND source_path_key = ?2 AND current_asset_id = ?3 AND handoff_id = ?4 AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?5 AND handoff_id = ?4) ${AUDIT_EXISTS};`, [input.collectionId, input.sourcePathKey, input.currentAssetId, input.handoffId, input.mappingId, input.auditId, input.projectId]), marker(input.db, `SELECT id, state, editing_entry_board_revision FROM autohdr_handoffs WHERE id = ?1 AND project_id = ?2 AND connection_id = ?3 AND generation = ?4 AND state IN (SELECT value FROM json_each(?5)) ${AUDIT_EXISTS};`, [input.handoffId, input.projectId, input.connectionId, input.generation, JSON.stringify(input.handoffStates), input.auditId, input.projectId]), marker(input.db, `SELECT id, state FROM autohdr_output_mappings WHERE id = ?1 AND project_id = ?2 AND handoff_id = ?3 AND connection_id = ?4 AND generation = ?5 AND state IN (SELECT value FROM json_each(?6)) ${AUDIT_EXISTS};`, [input.mappingId, input.projectId, input.handoffId, input.connectionId, input.generation, JSON.stringify(input.mappingStates), input.auditId, input.projectId]), marker(input.db, `SELECT id, current_asset_id FROM edited_source_claims WHERE collection_id = ?1 AND source_path_key = ?2 AND current_asset_id = ?3 AND handoff_id = ?4 ${AUDIT_EXISTS};`, [input.collectionId, input.sourcePathKey, input.currentAssetId, input.handoffId, input.auditId, input.projectId])],
      indexes: { kind, prerequisiteMarker: 0, handoffState: 1, mappingState: 2, finalClaimState: 3 }
    };
  }
  if (kind === "autohdr_job_entry") {
    if (input.kind !== "autohdr_job" || input.mode !== "entry") throw new Error("autohdr_job_entry tail requires its matching prerequisite");
    return {
      statements: [marker(input.db, `SELECT id, status FROM jobs WHERE id = ?1 AND kind = ?2 AND project_id = ?3 AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ?3 AND CAST(json_extract(payload_json, '$.generation') AS INTEGER) = ?4 AND status IN (SELECT value FROM json_each(?5)) ${AUDIT_EXISTS};`, [input.jobId, input.jobKind, projectId, input.generation, JSON.stringify(input.jobStates), input.auditId, projectId])],
      indexes: { kind, prerequisiteMarker: 0, jobState: 0 }
    };
  }
  if (input.kind !== "autohdr_job" || input.mode !== "completion") throw new Error("autohdr_job_completion tail requires its matching prerequisite");
  return {
    statements: [marker(input.db, `SELECT id FROM jobs WHERE id = ?1 AND kind = ?2 AND project_id = ?3 AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ?3 AND json_extract(payload_json, '$.stageEntrySourceJobId') = ?5 AND CAST(COALESCE(json_extract(payload_json, '$.stageEntryGeneration'), json_extract(payload_json, '$.generation')) AS INTEGER) = ?6 ${AUDIT_EXISTS};`, [input.jobId, input.jobKind, projectId, input.sourceJobId, input.sourceJobId, input.generation, input.auditId, projectId]), marker(input.db, `SELECT
  id,
  project_id,
  stage_entry_board_revision
FROM jobs
WHERE id = ?1
  AND project_id = ?2
  AND kind IN (SELECT value FROM json_each(?3))
  AND json_valid(payload_json)
  AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ?2
  AND json_extract(payload_json, '$.stageEntrySourceJobId') = id
  AND CAST(
    COALESCE(
      json_extract(payload_json, '$.stageEntryGeneration'),
      json_extract(payload_json, '$.generation')
    ) AS INTEGER
  ) = ?4
  AND stage_entry_board_revision IS NOT NULL
  ${AUDIT_EXISTS};`, [input.sourceJobId, projectId, JSON.stringify(input.sourceJobKinds), input.generation, input.auditId, projectId]), marker(input.db, `SELECT id, status FROM jobs WHERE id = ?1 AND kind = ?2 AND project_id = ?3 AND json_valid(payload_json) AND CAST(COALESCE(json_extract(payload_json, '$.stageEntryGeneration'), json_extract(payload_json, '$.generation')) AS INTEGER) = ?4 AND status IN (SELECT value FROM json_each(?5)) ${AUDIT_EXISTS};`, [input.jobId, input.jobKind, projectId, input.generation, JSON.stringify(input.jobStates), input.auditId, projectId])],
    indexes: { kind, prerequisiteMarker: 0, sourceEntryJob: 1, completionJobState: 2 }
  };
}
export function buildTerminalAssertionBundle(input: { db: D1Database; projectId: string; destinationStage: StageKey; oldBoardRevision: number; premise: GuardedTransitionPrerequisite; coupling?: ClosedAutomaticCoupling; auditId: string; winnerRequired: boolean; assertedAt: number; }): PreparedStatementBundle<TerminalAssertionIndexes> {
  const coupling = input.coupling ?? { kind: "none" as const };
  return {
    statements: [input.db.prepare(terminalAssertionSql(input.premise, coupling)).bind(input.projectId, input.destinationStage, input.oldBoardRevision, compileGuardedTransitionPrerequisite(input.premise), input.auditId, input.winnerRequired ? 1 : 0, input.assertedAt, compileClosedAutomaticCoupling(coupling))],
    indexes: { terminalAssertion: 0 }
  };
}
export function buildOwnershipAssertionBundle(input: { db: D1Database; projectId: string; destinationStage: StageKey; coupling: ClosedAutomaticCoupling; assertedAt: number; }): PreparedStatementBundle<OwnershipAssertionIndexes> {
  return {
    statements: [input.db.prepare(ownershipAssertionSql(input.coupling)).bind(input.projectId, input.assertedAt, compileClosedAutomaticCoupling(input.coupling), input.destinationStage)],
    indexes: { ownershipAssertion: 0 }
  };
}
export function buildJobEntryProvenanceBundle(input: { db: D1Database; projectId: string; jobId: string; jobKind: "autohdr" | "autohdr_api_send"; generation: number; updatedAt: number; }): JobEntryProvenanceBundle {
  const coupling = { kind: "job_entry_provenance" as const, jobId: input.jobId, jobKind: input.jobKind, generation: input.generation, jobStates: ["running", "done"] as ["running", "done"] };
  return {
    statements: [input.db.prepare("UPDATE jobs SET payload_json = json_set(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.projectId', ?, '$.generation', ?, '$.stageEntrySourceJobId', ?, '$.stageEntryGeneration', ?), updated_at = ? WHERE id = ? AND kind = ? AND project_id = ? AND status IN ('running', 'done')").bind(input.projectId, input.generation, input.jobId, input.generation, input.updatedAt, input.jobId, input.jobKind, input.projectId)],
    indexes: { payloadUpdate: 0 },
    kind: "job_entry_provenance",
    coupling
  };
}
export function buildAutoHdrApiFinalizeBundle(input: { db: D1Database; projectId: string; destinationStage: StageKey; jobId: string; uid: string; assetCount: number; finalizedAuditId: string; payloadJson: string; actorId?: string | null; assertedAt: number; }): PreparedStatementBundle<AutoHdrApiFinalizeIndexes> & {
  kind: "autohdr_api_finalize";
  coupling: Extract<ClosedAutomaticCoupling, { kind: "autohdr_api_finalize"; }>;
} {
  const coupling = { kind: "autohdr_api_finalize" as const, jobId: input.jobId, uid: input.uid, assetCount: input.assetCount, finalizedAuditId: input.finalizedAuditId };
  const finalizedMetaJson = JSON.stringify({ provider: "autohdr_api_v4", jobId: input.jobId, uid: input.uid, assetCount: input.assetCount, retrievalEnabled: false });
  const payloadUpdate = input.db.prepare("UPDATE jobs SET error = NULL, payload_json = ?1, updated_at = ?2 WHERE id = ?3 AND kind = 'autohdr_api_send' AND project_id = ?4 AND status IN ('running', 'done') RETURNING id, project_id, status, payload_json;").bind(input.payloadJson, input.assertedAt, input.jobId, input.projectId);
  const finalizedAudit = input.db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'project.autohdr_api_send.finalized', 'project', ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id = ?6 AND j.kind = 'autohdr_api_send' AND j.project_id = ?3 AND j.status IN ('running', 'done') AND j.payload_json = ?7) ON CONFLICT(id) DO NOTHING RETURNING id;").bind(input.finalizedAuditId, input.actorId ?? null, input.projectId, finalizedMetaJson, input.assertedAt, input.jobId, input.payloadJson);
  const assertion = buildOwnershipAssertionBundle({ db: input.db, projectId: input.projectId, destinationStage: input.destinationStage, coupling, assertedAt: input.assertedAt });
  return {
    statements: [payloadUpdate, finalizedAudit, ...assertion.statements],
    indexes: { payloadUpdate: 0, finalizedAudit: 1, ownershipAssertion: 2 },
    kind: "autohdr_api_finalize",
    coupling
  };
}
export function buildWorkflowCheckBundle(input: { db: D1Database; projectId: string; destinationStage: StageKey; oldBoardRevision: number; workflow: GuardedTransitionPrerequisite; }): PreparedStatementBundle<{ workflowCheck: number; }> {
  return {
    statements: [input.db.prepare(`SELECT 1 WHERE COALESCE((${workflowDurablePostconditionSql(input.workflow)}), 0)`).bind(input.projectId, input.destinationStage, input.oldBoardRevision, compileGuardedTransitionPrerequisite(input.workflow))],
    indexes: { workflowCheck: 0 }
  };
}
export function composeStageBundle(input: {
  preWinner?: PreparedStatementBundle<Record<string, number | readonly [number, number] | undefined>>;
  stage: PreparedStatementBundle<StageWinnerIndexes>;
  state?: HandoffStartBundle;
  activity?: PreparedStatementBundle<ActivityBundleIndexes>;
  deadline?: PreparedStatementBundle<DeadlineSuppressionIndexes>;
  workflow: PreparedStatementBundle<WorkflowTailIndexes>;
  token?: PreparedStatementBundle<EditingEntryTokenTailIndexes>;
  terminal?: PreparedStatementBundle<TerminalAssertionIndexes>;
}): PreparedStatementBundle<ComposedStageBundleIndexes> {
  const statements: D1PreparedStatement[] = [];
  function append<T extends Record<string, unknown>>(bundle: PreparedStatementBundle<T>): T {
    const offset = statements.length;
    statements.push(...bundle.statements);
    const indexes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bundle.indexes)) { if (value === undefined) continue; indexes[key] = typeof value === "number" ? value + offset : value; }
    return indexes as T;
  }
  const preWinner = input.preWinner ? append(input.preWinner) : undefined;
  const stage = append(input.stage);
  const state = input.state ? append(input.state) : undefined;
  const workflow = append(input.workflow);
  const token = input.token ? append(input.token) : undefined;
  const activity = input.activity ? append(input.activity) : undefined;
  const deadline = input.deadline ? append(input.deadline) : undefined;
  const terminal = input.terminal ? append(input.terminal) : undefined;
  return {
    statements,
    indexes: {
      ...(preWinner ? { preWinner } : {}),
      stage,
      ...(state ? { state } : {}),
      ...(input.activity ? { activity } : {}),
      ...(input.deadline ? { deadline } : {}),
      workflow,
      ...(token ? { token } : {}),
      ...(terminal ? { terminal } : {})
    }
  };
}
export function deriveStageFinalizerIntent(winnerResults: readonly StageFinalizerWinnerResult[]): CommittedStageFinalizerIntent | undefined {
  const validWinner = (result: StageFinalizerWinnerResult): result is Extract<StageFinalizerWinnerResult, { kind: "winner"; }> =>( result.kind === "winner" && Boolean(result.auditId) && Boolean(result.row?.projectId) && Boolean(result.row?.stageKey) && Number.isFinite(result.row.boardPosition) && Number.isInteger(result.row.boardRevision) && result.row.boardRevision >= 0 && (result.publicationIds === undefined || result.publicationIds.every(id => typeof id === "string" && id.length > 0)) && (result.legacyWorkflowNotification === undefined || ["raw_ready", "sent_to_editing", "edited_landed"].includes(result.legacyWorkflowNotification)));
  if (winnerResults.length === 0 || winnerResults.some(result => !validWinner(result))) return undefined;
  const first = winnerResults[0];
  if (!first || !validWinner(first)) return undefined;
  for (const result of winnerResults.slice(1)) {
    if (!validWinner(result) || result.auditId !== first.auditId || result.row.projectId !== first.row.projectId || result.row.stageKey !== first.row.stageKey || result.row.boardPosition !== first.row.boardPosition || result.row.boardRevision !== first.row.boardRevision || result.legacyWorkflowNotification !== first.legacyWorkflowNotification) { return undefined; }
  }
  return {
    publicationIds: [...new Set(winnerResults.flatMap(result => validWinner(result) ? result.publicationIds ?? [] : []))],
    ...(first.legacyWorkflowNotification ? { legacyWorkflowNotification: first.legacyWorkflowNotification } : {})
  };
}
export const NORMATIVE_NON_COMPACTING_EXACT_SQL = NON_COMPACTING_EXACT_SQL;
export const NORMATIVE_NON_COMPACTING_APPEND_SQL = NON_COMPACTING_APPEND_SQL;
export const NORMATIVE_COMPACTING_SQL = COMPACTING_SQL;
export const NORMATIVE_AUDIT_MARKER_SQL = AUDIT_MARKER_SQL;
export const NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL = HANDOFF_EDITING_ENTRY_TOKEN_SQL;
export const NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL = JOB_EDITING_ENTRY_TOKEN_SQL;
