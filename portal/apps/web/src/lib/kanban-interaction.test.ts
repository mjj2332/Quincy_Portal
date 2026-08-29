import { describe, expect, it } from "vitest";
import type { MoveProjectStageResponse } from "@quincy/shared";
import {
  QuincyGuardedDirectManipulationPolicy,
  adjacentBoardPlacement,
  adjacentBoardGap,
  announce,
  applyOptimisticOverlay,
  authorizedOrderForStage,
  buildMoveRequest,
  cardDropPlacement,
  classifyBoardMoveFailure,
  eligibleTarget,
  focusDescriptorFor,
  focusTargetAfter,
  isSameStagePlacementChange,
  optimismSafeBeforeResponse,
  proposeMultiContainerDrop,
  proposedOrdersForHover,
  reconcileAuthoritativeResponse,
  resolveSemanticGap,
  reorderIntentFromGap,
  rollbackToBaseline,
  semanticGapChanged,
  sortKanbanProjects,
  transitionMovementSettle,
  type BoardAnnouncementEvent,
  type BoardModel,
  type BoardDragStartSnapshot,
  type ProjectSummary,
} from "./kanban-interaction";

function project(id: string, stageKey: ProjectSummary["stageKey"] = "awaiting_raw", overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    street: `${id} Street`,
    suburb: null,
    postcode: null,
    agencyName: null,
    agentName: null,
    stageKey,
    shootDate: null,
    coverAssetId: null,
    receivedCount: 0,
    expectedCount: null,
    priority: null,
    boardRevision: 0,
    deadlineAt: null,
    deadlineLocalCivil: null,
    deadlineZone: null,
    ...overrides,
  };
}

function board(
  projects: ProjectSummary[],
  authorizedBoardOrder: Record<string, string[]> = {},
): BoardModel {
  const withOrder = projects.map((item) => ({
    ...item,
    authorizedBoardOrder,
    boardMapPresent: true,
  }));
  return { projects: withOrder, authorizedBoardOrder };
}

function movementBoard(): BoardModel {
  return board([
    project("source", "awaiting_raw", { boardRevision: 3 }),
    project("first", "raw_review", { boardRevision: 8 }),
    project("middle", "raw_review", { boardRevision: 9 }),
    project("last", "raw_review", { boardRevision: 10 }),
  ], {
    awaiting_raw: ["source"],
    raw_review: ["first", "middle", "last"],
  });
}

describe("Kanban interaction model", () => {
  it("uses the authorized Board rank, not raw boardPosition, and preserves canonical sort tie-breaks", () => {
    const rows = [
      project("late", "awaiting_raw", { boardPosition: 0, boardRank: 2, boardMapPresent: true }),
      project("early", "awaiting_raw", { boardPosition: 999, boardRank: 1, boardMapPresent: true }),
      project("missing", "awaiting_raw", { boardPosition: -100, boardRank: undefined, boardMapPresent: true }),
    ];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["early", "late", "missing"]);

    const priorityRows = [
      project("null-b", "awaiting_raw", { priority: null, boardPosition: -100, authorizedBoardOrder: { awaiting_raw: ["null-a", "null-b"] } }),
      project("priority-2", "awaiting_raw", { priority: 2, boardPosition: -100, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2", "same-priority-late"] } }),
      project("priority-1", "awaiting_raw", { priority: 1, boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2", "same-priority-late"] } }),
      project("same-priority-late", "awaiting_raw", { priority: 2, boardPosition: -999, authorizedBoardOrder: { awaiting_raw: ["priority-1", "priority-2", "same-priority-late"] } }),
      project("null-a", "awaiting_raw", { priority: null, boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["null-a", "null-b"] } }),
    ];
    expect(sortKanbanProjects(priorityRows, "priority").map((row) => row.id)).toEqual([
      "priority-1", "priority-2", "same-priority-late", "null-a", "null-b",
    ]);
  });

  it("keeps shoot-date asc/desc as local views with unusable dates last", () => {
    const rows = [
      project("late", "awaiting_raw", { street: "A Street", shootDate: "2026-03-02", boardPosition: 0 }),
      project("early", "awaiting_raw", { street: "Z Street", shootDate: "2026-02-01", boardPosition: 999 }),
      project("invalid", "awaiting_raw", { street: "B Street", shootDate: "not-a-date", boardPosition: -999 }),
      project("undated", "awaiting_raw", { street: "C Street", shootDate: null, boardPosition: -999 }),
    ];
    expect(sortKanbanProjects(rows, "shootDate-asc").map((row) => row.id)).toEqual(["early", "late", "invalid", "undated"]);
    expect(sortKanbanProjects(rows, "shootDate-desc").map((row) => row.id)).toEqual(["late", "early", "invalid", "undated"]);
  });

  it("builds first, middle, last, append, and stale exact card placements", () => {
    const rows = movementBoard().projects;
    expect(cardDropPlacement("source", "first", "raw_review", "before", rows)).toEqual({
      kind: "between", before: null, after: { projectId: "first", boardRevision: 8 },
    });
    expect(cardDropPlacement("source", "middle", "raw_review", "before", rows)).toEqual({
      kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "middle", boardRevision: 9 },
    });
    expect(cardDropPlacement("source", "last", "raw_review", "after", rows)).toEqual({ kind: "append" });
    expect(cardDropPlacement("source", "last", "raw_review", "before", rows)).toEqual({
      kind: "between", before: { projectId: "middle", boardRevision: 9 }, after: { projectId: "last", boardRevision: 10 },
    });
    expect(cardDropPlacement("source", "missing", "raw_review", "before", rows)).toBeNull();
    expect(cardDropPlacement("source", "first", "unknown_stage", "before", rows)).toBeNull();
    expect(cardDropPlacement("source", "middle", "raw_review", "before", rows.filter((item) => item.id !== "first"))).toBeNull();

    expect(adjacentBoardPlacement("last", "raw_review", "up", rows)).toEqual({
      kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "middle", boardRevision: 9 },
    });
    expect(adjacentBoardPlacement("last", "raw_review", "down", rows)).toBeNull();
    expect(adjacentBoardPlacement("first", "raw_review", "up", rows)).toBeNull();
    expect(adjacentBoardPlacement("middle", "raw_review", "up", rows)).toEqual({
      kind: "between", before: null, after: { projectId: "first", boardRevision: 8 },
    });
    expect(adjacentBoardPlacement("middle", "unknown_stage", "up", rows)).toBeNull();
    expect(adjacentBoardPlacement("middle", "raw_review", "up", rows.filter((item) => item.id !== "first"))).toBeNull();
  });

  it("resolves the same revision-free semantic gap independent of display sort", () => {
    const model = movementBoard();
    const gap = { targetStageKey: "raw_review" as const, successor: "middle" };
    const boardRequest = buildMoveRequest(model, "source", gap);
    const priorityRequest = buildMoveRequest(model, "source", gap);
    const shootDateRequest = buildMoveRequest(model, "source", gap);
    expect(boardRequest).toEqual(priorityRequest);
    expect(priorityRequest).toEqual(shootDateRequest);
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "first" }, model, "source")).toEqual({
      placement: { kind: "between", before: null, after: { projectId: "first", boardRevision: 8 } },
    });
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "end" }, model, "source")).toEqual({ placement: { kind: "append" } });
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "vanished" }, model, "source")).toEqual({ stale: true });
    expect(buildMoveRequest(model, "source", { targetStageKey: "raw_review", successor: "vanished" })).toEqual({ stale: true });

    const freshModel = board(model.projects.map((item) => item.id === "middle" ? { ...item, boardRevision: 77 } : item), {
      awaiting_raw: ["source"], raw_review: ["first", "middle", "last"],
    });
    expect(buildMoveRequest(freshModel, "source", gap)).toEqual({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "middle", boardRevision: 77 } },
    });
  });

  it("resolves same-Stage gaps to board-position neighbour revisions", () => {
    const model = movementBoard();
    const gap = { targetStageKey: "raw_review" as const, successor: "last" };
    expect(isSameStagePlacementChange({ gap, movingProject: model.projects.find((item) => item.id === "middle")! })).toBe(true);
    expect(reorderIntentFromGap({ targetStageKey: "raw_review", successor: "last" }, model, "middle")).toEqual({
      placement: { kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "last", boardRevision: 10 } },
    });
    expect(reorderIntentFromGap({ targetStageKey: "raw_review", successor: "first" }, model, "source")).toEqual({ stale: true });
    expect(adjacentBoardGap("middle", "raw_review", "down", model.projects)).toEqual({ targetStageKey: "raw_review", successor: "end" });
  });

  it("proposes card, column-body, and empty-column drops while removing the mover from source", () => {
    const model = movementBoard();
    const snapshot: BoardDragStartSnapshot = { model, movingProjectId: "source", sort: "board" };
    expect(proposeMultiContainerDrop(snapshot, { kind: "card", stageKey: "raw_review", projectId: "middle" })).toEqual({
      gap: { targetStageKey: "raw_review", successor: "middle" },
      orders: { awaiting_raw: [], raw_review: ["first", "source", "middle", "last"] },
    });
    expect(proposedOrdersForHover(snapshot, { kind: "column", stageKey: "raw_review" })).toEqual({
      awaiting_raw: [], raw_review: ["first", "middle", "last", "source"],
    });
    const empty = board([
      project("source", "awaiting_raw", { boardRevision: 3 }),
    ], { awaiting_raw: ["source"], raw_review: [] });
    expect(proposedOrdersForHover({ model: empty, movingProjectId: "source" }, { kind: "column", stageKey: "raw_review" })).toEqual({
      awaiting_raw: [], raw_review: ["source"],
    });
    expect(proposedOrdersForHover(snapshot, { kind: "card", stageKey: "awaiting_raw", projectId: "source" })).toBeNull();
  });

  it("applies cross-Stage and same-Stage eligibility from capabilities and active Stages", () => {
    const model = movementBoard();
    const baseCaps = { canMoveProjectStage: true, canPrioritize: false, sort: "board" as const, activeStageKeys: ["awaiting_raw", "raw_review"] as const };
    expect(eligibleTarget({ targetStageKey: "raw_review", successor: "end" }, model, "source", baseCaps)).toBe(true);
    expect(eligibleTarget({ targetStageKey: "awaiting_raw", successor: "end" }, model, "source", baseCaps)).toBe(false);
    expect(eligibleTarget({ targetStageKey: "awaiting_raw", successor: "source" }, model, "source", { ...baseCaps, canPrioritize: true })).toBe(false);
    expect(eligibleTarget({ targetStageKey: "awaiting_raw", successor: "end" }, model, "source", { ...baseCaps, canPrioritize: true })).toBe(true);
    expect(eligibleTarget({ targetStageKey: "delivered", successor: "end" }, model, "source", { ...baseCaps, canPrioritize: true, sort: "board" })).toBe(false);
    expect(eligibleTarget({ targetStageKey: "awaiting_raw", successor: "end" }, model, "source", { ...baseCaps, canPrioritize: true, sort: "priority" })).toBe(false);
  });

  it("overlays only authorized arrays and the mover Stage, keeps revisions, and rolls back completely", () => {
    const baseline = movementBoard();
    const overlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "raw_review", successor: "middle" });
    expect(overlay.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 3 });
    expect(overlay.authorizedBoardOrder).toEqual({ awaiting_raw: [], raw_review: ["first", "source", "middle", "last"] });
    expect(overlay.projects.every((item) => JSON.stringify(item.authorizedBoardOrder) === JSON.stringify(overlay.authorizedBoardOrder))).toBe(true);
    expect(overlay.projects.find((item) => item.id === "first")?.boardRevision).toBe(8);
    expect(rollbackToBaseline(baseline)).toEqual(baseline);
    expect(JSON.stringify(rollbackToBaseline(baseline))).toBe(JSON.stringify(baseline));
  });

  it("uses the authoritative target array, provisional source, and settled priority-first snap", () => {
    const baseline = board([
      project("source", "awaiting_raw", { priority: null, boardRevision: 3 }),
      project("first", "raw_review", { priority: 1, boardRevision: 8 }),
      project("last", "raw_review", { priority: null, boardRevision: 10 }),
    ], { awaiting_raw: ["source"], raw_review: ["first", "last"] });
    const overlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "raw_review", successor: "first" });
    expect(sortKanbanProjects(overlay.projects.filter((item) => item.stageKey === "raw_review"), "priority").map((item) => item.id)).toEqual(["first", "source", "last"]);

    const response: MoveProjectStageResponse = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 11 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["first", "last", "source"] },
    };
    const settled = reconcileAuthoritativeResponse(baseline, "source", response);
    expect(settled.sourceProvisional).toBe(true);
    expect(settled.model.authorizedBoardOrder?.raw_review).toEqual(["first", "last", "source"]);
    expect(settled.model.authorizedBoardOrder?.awaiting_raw).toEqual([]);
    expect(settled.model.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 11 });
    expect(sortKanbanProjects(settled.model.projects.filter((item) => item.stageKey === "raw_review"), "priority").map((item) => item.id)).toEqual(["first", "last", "source"]);

    const unchanged = reconcileAuthoritativeResponse(baseline, "source", { ...response, changed: false });
    expect(unchanged.model.authorizedBoardOrder?.raw_review).toEqual(["first", "last", "source"]);
  });

  it("allows same-Stage optimism and only allows safe ordinary forward cross-Stage optimism", () => {
    expect(optimismSafeBeforeResponse("raw_review", "raw_review", "editor", true)).toBe(true);
    expect(optimismSafeBeforeResponse("awaiting_raw", "raw_review", "editor", false)).toBe(true);
    expect(optimismSafeBeforeResponse("raw_review", "awaiting_raw", "editor", false)).toBe(false);
    expect(optimismSafeBeforeResponse("awaiting_raw", "editing", "editor", false)).toBe(false);
    expect(optimismSafeBeforeResponse("edited_review", "delivered", "editor", false)).toBe(false);
    expect(optimismSafeBeforeResponse("raw_review", "editing", "editor", false)).toBe(false);
    expect(optimismSafeBeforeResponse("not-a-stage", "raw_review", "editor", false)).toBe(false);
    expect(optimismSafeBeforeResponse("not-a-stage", "also-not-a-stage", "editor", true)).toBe(true);
  });

  it("reconciles same-Stage responses as authoritative without a provisional source", () => {
    const baseline = movementBoard();
    const response: MoveProjectStageResponse = {
      changed: true,
      project: { projectId: "middle", stageKey: "raw_review", boardRevision: 11 },
      board: { sourceStageKey: "raw_review", targetStageKey: "raw_review", orderedVisibleProjectIds: ["middle", "first", "last"] },
    };
    const settled = reconcileAuthoritativeResponse(baseline, "middle", response);
    expect(settled.sourceProvisional).toBe(false);
    expect(settled.model.authorizedBoardOrder?.raw_review).toEqual(["middle", "first", "last"]);
    expect(settled.model.projects.find((item) => item.id === "middle")).toMatchObject({ boardRevision: 11, stageKey: "raw_review" });
  });

  it("keeps the settle barrier through a failed refetch and clears it only on success", () => {
    const initial = { pending: false, recoveryReason: null };
    const pending = transitionMovementSettle(initial, { type: "winner" });
    expect(pending).toEqual({ pending: true, recoveryReason: null });
    expect(transitionMovementSettle(pending, { type: "refetch-failed", reason: "Refresh failed." })).toEqual({ pending: true, recoveryReason: "Refresh failed." });
    expect(transitionMovementSettle(pending, { type: "refetch-succeeded" })).toEqual(initial);
    expect(transitionMovementSettle(transitionMovementSettle(initial, { type: "winner" }), { type: "refetch-succeeded" })).toEqual(initial);
  });

  it("classifies generic 409 codes as full rollback, one refetch, and no retry", () => {
    for (const code of ["project_archived_read_only", "inactive_destination", "stage_contract_reload_required"] as const) {
      expect(classifyBoardMoveFailure({ status: 409, details: { code } })).toEqual({
        code, action: "rollback-and-refetch", refetch: true, retry: false,
      });
    }
    expect(classifyBoardMoveFailure({ status: 409, details: { code: "project_stage_conflict" } })).toBeNull();
  });

  it("builds exact announcement copy, displayed positions, changed:false copy, and terminal suppression", () => {
    const ctx = { terminal: false, street: "12 Kings Road", stageLabel: "RAW review", sourceStageLabel: "Awaiting RAW", position: 2, count: 4 };
    const cases: Array<[BoardAnnouncementEvent, string]> = [
      [{ type: "start" }, "Picked up 12 Kings Road. Current Stage: RAW review. Position 2 of 4."],
      [{ type: "over-card" }, "12 Kings Road is over RAW review, position 2 of 4."],
      [{ type: "over-end" }, "12 Kings Road is over the end of RAW review, position 2 of 4."],
      [{ type: "valid-drop" }, "Dropped 12 Kings Road in RAW review, position 2 of 4. Saving."],
      [{ type: "dnd-cancel" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "drop-outside" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "unchanged-gap" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "invalid-keyboard-target" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "stale-move-to" }, "That position changed. Reloading the latest Board; no move was made."],
      [{ type: "confirmation-required" }, "Move needs confirmation. 12 Kings Road remains in Awaiting RAW."],
      [{ type: "modal-cancel" }, "Stage move cancelled. 12 Kings Road remains in Awaiting RAW."],
      [{ type: "cross-stage-success" }, "Moved 12 Kings Road to RAW review, position 2 of 4."],
      [{ type: "same-stage-success" }, "Reordered 12 Kings Road in RAW review, position 2 of 4."],
      [{ type: "no-change" }, "12 Kings Road is already in RAW review, position 2 of 4."],
      [{ type: "post-success-refetch-failure" }, "The move was saved, but the latest Board could not be loaded. Refresh to continue."],
      [{ type: "conflict" }, "Could not move 12 Kings Road because the Board changed elsewhere. Reloading the latest Board; no retry was made."],
      [{ type: "contract-off" }, "Board interactions are temporarily unavailable while the Board contract is disabled."],
      [{ type: "maintenance" }, "Board interactions are temporarily unavailable while the Board is being updated."],
    ];
    for (const [event, expected] of cases) expect(announce(event, ctx)).toBe(expected);
    expect(announce({ type: "cross-stage-success" }, { ...ctx, terminal: true })).toBeUndefined();
    expect(semanticGapChanged(undefined, { targetStageKey: "raw_review", successor: "first" })).toBe(true);
    expect(semanticGapChanged({ targetStageKey: "raw_review", successor: "first" }, { targetStageKey: "raw_review", successor: "first" })).toBe(false);
    expect(semanticGapChanged({ targetStageKey: "raw_review", successor: "first" }, { targetStageKey: "raw_review", successor: "end" })).toBe(true);
  });

  it("returns deterministic focus descriptors and outcome targets/fallbacks", () => {
    const model = movementBoard();
    const source = model.projects.find((item) => item.id === "source")!;
    const pointer = focusDescriptorFor("pointer", source, model);
    expect(pointer).toMatchObject({ path: "pointer", projectId: "source", control: "handle", sourceStageKey: "awaiting_raw", sourceIndex: 0 });
    expect(focusDescriptorFor("move-to", source, model).control).toBe("move-to");
    expect(focusDescriptorFor("arrow", source, model, "arrow-down").control).toBe("arrow-down");
    expect(focusDescriptorFor("rail", source, model).control).toBe("rail-stage");
    expect(focusTargetAfter("success", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("dnd-cancel", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("modal-cancel", focusDescriptorFor("move-to", source, model), model)).toEqual({ control: "move-to", projectId: "source" });
    expect(focusTargetAfter("drop-outside", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("no-op", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("invalid-keyboard-target", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("stale-move-to", pointer, model)).toEqual({ control: "move-to", projectId: "source" });
    expect(focusTargetAfter("conflict", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("503", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    expect(focusTargetAfter("post-success-refetch-failure", pointer, model)).toEqual({ control: "handle", projectId: "source" });
    const missing = { ...pointer, projectId: "gone" };
    expect(focusTargetAfter("conflict", missing, model)).toEqual({ fallback: "stage-heading" });
    expect(focusTargetAfter("rail", missing, model)).toEqual({ fallback: "board" });
  });

  it("documents all eight engine-neutral guarded manipulation rules", () => {
    expect(QuincyGuardedDirectManipulationPolicy).toHaveLength(8);
    expect(QuincyGuardedDirectManipulationPolicy[0]).toBe("explicit source capability and authorized projection");
    expect(QuincyGuardedDirectManipulationPolicy[7]).toContain("never send client-classified reasons");
    expect(authorizedOrderForStage(movementBoard().projects, "raw_review")).toEqual(["first", "middle", "last"]);
  });
});
