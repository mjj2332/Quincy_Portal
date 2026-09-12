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
  moveToPositionOptions,
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
    editors: [],
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

  it("uses street and id tie-breaks and ignores Priority and Board position in shoot-date views", () => {
    const equalDateRows = [
      project("b", "awaiting_raw", { street: "10 King Street", shootDate: "2026-01-01" }),
      project("a", "awaiting_raw", { street: "10 King Street", shootDate: "2026-01-01" }),
      project("accent", "awaiting_raw", { street: "10 Élan Street", shootDate: "2026-01-01" }),
      project("other", "awaiting_raw", { street: "2 Apple Street", shootDate: "2026-01-01" }),
    ];
    expect(sortKanbanProjects(equalDateRows, "shootDate-asc").map((row) => row.id)).toEqual(["accent", "a", "b", "other"]);

    const viewRows = [
      project("priority-first", "awaiting_raw", { priority: 1, boardPosition: 0, shootDate: "2026-03-01" }),
      project("unprioritized-earlier", "awaiting_raw", { priority: null, boardPosition: 50, shootDate: "2026-01-01" }),
    ];
    expect(sortKanbanProjects(viewRows, "shootDate-asc").map((row) => row.id)).toEqual(["unprioritized-earlier", "priority-first"]);
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
    const boardRequest = buildMoveRequest(model, "source", gap, "admin");
    const priorityRequest = buildMoveRequest(model, "source", gap, "admin");
    const shootDateRequest = buildMoveRequest(model, "source", gap, "admin");
    expect(boardRequest).toEqual(priorityRequest);
    expect(priorityRequest).toEqual(shootDateRequest);
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "first" }, model, "source")).toEqual({
      placement: { kind: "between", before: null, after: { projectId: "first", boardRevision: 8 } },
    });
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "end" }, model, "source")).toEqual({ placement: { kind: "append" } });
    expect(resolveSemanticGap({ targetStageKey: "raw_review", successor: "vanished" }, model, "source")).toEqual({ stale: true });
    expect(buildMoveRequest(model, "source", { targetStageKey: "raw_review", successor: "vanished" }, "admin")).toEqual({ stale: true });

    const freshModel = board(model.projects.map((item) => item.id === "middle" ? { ...item, boardRevision: 77 } : item), {
      awaiting_raw: ["source"], raw_review: ["first", "middle", "last"],
    });
    expect(buildMoveRequest(freshModel, "source", gap, "admin")).toEqual({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "middle", boardRevision: 77 } },
    });
  });

  it("resolves same-Stage gaps to board-position neighbour revisions", () => {
    const model = movementBoard();
    const gap = { targetStageKey: "raw_review" as const, successor: "last" };
    expect(isSameStagePlacementChange({ gap, movingProject: model.projects.find((item) => item.id === "middle")! })).toBe(true);
    expect(reorderIntentFromGap({ targetStageKey: "raw_review", successor: "last" }, model, "middle", "admin")).toEqual({
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "first", boardRevision: 8 }, after: { projectId: "last", boardRevision: 10 } },
    });
    expect(reorderIntentFromGap({ targetStageKey: "raw_review", successor: "first" }, model, "source", "admin")).toEqual({ stale: true });
    expect(adjacentBoardGap("middle", "raw_review", "down", model.projects)).toEqual({ targetStageKey: "raw_review", successor: "end" });

    const editingModel = board([
      project("editing-mover", "editing", { boardRevision: 12 }),
    ], { editing_autohdr: ["editing-mover"] });
    expect(reorderIntentFromGap({ targetStageKey: "editing_autohdr", successor: "end" }, editingModel, "editing-mover", "editor")).toEqual({
      targetStageKey: "editing",
      placement: { kind: "append" },
    });
  });

  it("serializes canonical Editing targets for each role at the move-request boundary", () => {
    const model = board([
      project("source", "awaiting_raw", { boardRevision: 3 }),
    ], { awaiting_raw: ["source"] });
    const gap = { targetStageKey: "editing_autohdr" as const, successor: "end" as const };
    expect(resolveSemanticGap(gap, model, "source")).toEqual({ placement: { kind: "append" } });
    expect(buildMoveRequest(model, "source", gap, "editor")).toEqual({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "editing",
      placement: { kind: "append" },
    });
    expect(buildMoveRequest(model, "source", gap, "admin")).toMatchObject({ targetStageKey: "editing_autohdr" });

    const namedSuccessorOutsideTarget = board([
      project("source", "awaiting_raw", { boardRevision: 3 }),
      project("other", "raw_review", { boardRevision: 8 }),
    ], { awaiting_raw: ["source"], raw_review: ["other"] });
    expect(resolveSemanticGap({ targetStageKey: "editing_autohdr", successor: "other" }, namedSuccessorOutsideTarget, "source")).toEqual({ stale: true });
    expect(resolveSemanticGap(gap, { projects: [project("source", "awaiting_raw", { boardRevision: 3 })] }, "source")).toEqual({ stale: true });
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
    ], { awaiting_raw: ["source"] });
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

  it("builds role-safe Move-to position options with End first and visible successors only", () => {
    const mover = project("mover", "awaiting_raw", { boardRevision: 3 });
    const visible = project("visible", "raw_review", { street: "Visible Street", boardRevision: 8 });
    const model = board([mover, visible], {
      awaiting_raw: ["mover"],
      raw_review: ["hidden", "visible"],
    });
    const caps = {
      canMoveProjectStage: true,
      canPrioritize: true,
      sort: "board" as const,
      activeStageKeys: ["awaiting_raw", "raw_review"] as const,
      stageLabels: { awaiting_raw: "Awaiting RAW", raw_review: "RAW review" },
    };
    expect(moveToPositionOptions(model, "mover", "raw_review", "admin", caps)).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Visible Street — position 1", successor: "visible" },
    ]);
    expect(moveToPositionOptions(model, "mover", "awaiting_raw", "editor", caps)).toEqual([]);
    expect(moveToPositionOptions(model, "mover", "awaiting_raw", "admin", { ...caps, sort: "priority" })).toEqual([]);
    const externalModel = board([
      project("external-mover", "editing", { boardRevision: 12 }),
      visible,
    ], { editing_autohdr: ["external-mover"], raw_review: ["hidden", "visible"] });
    expect(moveToPositionOptions(externalModel, "external-mover", "raw_review", "external_editor", caps)).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Visible Street — position 1", successor: "visible" },
    ]);

    const keylessTargetModel = board([mover], { awaiting_raw: ["mover"] });
    expect(moveToPositionOptions(keylessTargetModel, "mover", "raw_review", "admin", caps)).toEqual([
      { label: "End of RAW review", successor: "end" },
    ]);
  });

  // #83. The old Board listed the VISUAL successor ("uses the visual successor when Priority
  // sorting changes the canonical Board order"), and the cutover suite caught the replacement
  // listing canonical Board order instead — so "Before X — position 1" named the card the user saw
  // third. Only the order of the list moves: the successor ids stay the same, because placement is
  // semantic and `resolveSemanticGap` resolves them against the authorized map either way.
  it("lists cross-Stage Move-to options in the displayed order when the Board is not in Board sort", () => {
    const mover = project("mover", "awaiting_raw", { boardRevision: 3 });
    // shootDate is deliberately set so that the shoot-date order ("date-first", "board-first",
    // "priority-first") differs from BOTH the canonical Board order ("board-first", "priority-first",
    // "date-first") and the Priority order ("priority-first", "date-first", "board-first") below — a
    // Priority-only implementation of the #83 fix would still pass without this.
    const boardFirst = project("board-first", "raw_review", { street: "Board First", priority: 5, boardRevision: 1, shootDate: "2026-03-03" });
    const priorityFirst = project("priority-first", "raw_review", { street: "Priority First", priority: 1, boardRevision: 2, shootDate: "2026-03-05" });
    const dateFirst = project("date-first", "raw_review", { street: "Date First", priority: 2, boardRevision: 4, shootDate: "2026-03-01" });
    const model = board([mover, boardFirst, priorityFirst, dateFirst], {
      awaiting_raw: ["mover"],
      raw_review: ["board-first", "priority-first", "date-first"],
    });
    const caps = {
      canMoveProjectStage: true,
      canPrioritize: true,
      sort: "board" as const,
      activeStageKeys: ["awaiting_raw", "raw_review"] as const,
      stageLabels: { awaiting_raw: "Awaiting RAW", raw_review: "RAW review" },
    };

    // Board sort: canonical Board order, unchanged.
    expect(moveToPositionOptions(model, "mover", "raw_review", "admin", caps)).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Board First — position 1", successor: "board-first" },
      { label: "Before Priority First — position 2", successor: "priority-first" },
      { label: "Before Date First — position 3", successor: "date-first" },
    ]);

    // Priority sort: the column renders Priority First, Date First, Board First — so does the list.
    expect(moveToPositionOptions(model, "mover", "raw_review", "admin", { ...caps, sort: "priority" })).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Priority First — position 1", successor: "priority-first" },
      { label: "Before Date First — position 2", successor: "date-first" },
      { label: "Before Board First — position 3", successor: "board-first" },
    ]);

    // shootDate-asc sort: the column renders Date First, Board First, Priority First — so does the
    // list. This order matches neither the Board order nor the Priority order above.
    expect(moveToPositionOptions(model, "mover", "raw_review", "admin", { ...caps, sort: "shootDate-asc" })).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Date First — position 1", successor: "date-first" },
      { label: "Before Board First — position 2", successor: "board-first" },
      { label: "Before Priority First — position 3", successor: "priority-first" },
    ]);

    // shootDate-desc sort: the reverse.
    expect(moveToPositionOptions(model, "mover", "raw_review", "admin", { ...caps, sort: "shootDate-desc" })).toEqual([
      { label: "End of RAW review", successor: "end" },
      { label: "Before Priority First — position 1", successor: "priority-first" },
      { label: "Before Board First — position 2", successor: "board-first" },
      { label: "Before Date First — position 3", successor: "date-first" },
    ]);

    // Still fails closed with no authorized map: a sort cannot conjure positions the map withheld.
    const keyless = board([mover, boardFirst, priorityFirst, dateFirst], { awaiting_raw: ["mover"] });
    expect(moveToPositionOptions(keyless, "mover", "raw_review", "admin", { ...caps, sort: "priority" })).toEqual([
      { label: "End of RAW review", successor: "end" },
    ]);
  });

  it("overlays only authorized arrays and the mover Stage, keeps revisions, and rolls back completely", () => {
    const baseline = movementBoard();
    const overlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "raw_review", successor: "middle" }, "admin");
    expect(overlay.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 3 });
    expect(overlay.authorizedBoardOrder).toEqual({ awaiting_raw: [], raw_review: ["first", "source", "middle", "last"] });
    expect(overlay.projects.every((item) => JSON.stringify(item.authorizedBoardOrder) === JSON.stringify(overlay.authorizedBoardOrder))).toBe(true);
    expect(overlay.projects.find((item) => item.id === "first")?.boardRevision).toBe(8);
    expect(rollbackToBaseline(baseline)).toEqual(baseline);
    expect(JSON.stringify(rollbackToBaseline(baseline))).toBe(JSON.stringify(baseline));

    const editorOverlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "editing_autohdr", successor: "end" }, "editor");
    expect(editorOverlay.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "editing" });
  });

  it("uses the authoritative target array, provisional source, and settled priority-first snap", () => {
    const baseline = board([
      project("source", "awaiting_raw", { priority: null, boardRevision: 3 }),
      project("first", "raw_review", { priority: 1, boardRevision: 8 }),
      project("last", "raw_review", { priority: null, boardRevision: 10 }),
    ], { awaiting_raw: ["source"], raw_review: ["first", "last"] });
    const overlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "raw_review", successor: "first" }, "admin");
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

  it("carries the widened summary's assigned Editors through a Stage move untouched", () => {
    const editors = [{ id: "editor-1", name: "Assigned Editor" }];
    const baseline = board([
      project("source", "awaiting_raw", { boardRevision: 3, editors }),
      project("first", "raw_review", { boardRevision: 8 }),
    ], { awaiting_raw: ["source"], raw_review: ["first"] });
    const overlay = applyOptimisticOverlay(baseline, "source", { targetStageKey: "raw_review", successor: "first" }, "admin");
    expect(overlay.projects.find((item) => item.id === "source")?.editors).toEqual(editors);

    const response: MoveProjectStageResponse = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["first", "source"] },
    };
    const settled = reconcileAuthoritativeResponse(baseline, "source", response);
    expect(settled.model.projects.find((item) => item.id === "source")?.editors).toEqual(editors);
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

  it("returns deterministic focus descriptors and outcome targets/fallbacks for every origin", () => {
    const model = movementBoard();
    const source = model.projects.find((item) => item.id === "source")!;
    const pointer = focusDescriptorFor("pointer", source, model);
    expect(pointer).toMatchObject({ path: "pointer", projectId: "source", control: "handle", sourceStageKey: "awaiting_raw", sourceIndex: 0 });
    expect(focusDescriptorFor("move-to", source, model).control).toBe("move-to");
    expect(focusDescriptorFor("arrow", source, model, "arrow-down").control).toBe("arrow-down");
    expect(focusDescriptorFor("rail", source, model).control).toBe("rail-stage");
    const origins = [
      ["pointer", pointer],
      ["keyboard", focusDescriptorFor("keyboard", source, model)],
      ["move-to", focusDescriptorFor("move-to", source, model)],
      ["arrow", focusDescriptorFor("arrow", source, model, "arrow-down")],
    ] as const;
    const outcomes = ["success", "dnd-cancel", "modal-cancel", "conflict", "503", "drop-outside", "no-op", "invalid-keyboard-target", "post-success-refetch-failure"] as const;
    for (const [, descriptor] of origins) {
      for (const outcome of outcomes) expect(focusTargetAfter(outcome, descriptor, model)).toEqual({ control: descriptor.control, projectId: "source" });
    }
    for (const [, descriptor] of origins) expect(focusTargetAfter("stale-move-to", descriptor, model)).toEqual({ control: "move-to", projectId: "source" });
    expect(focusTargetAfter("rail", focusDescriptorFor("rail", source, model), model)).toEqual({ control: "rail-stage", projectId: "source" });
    const missing = { ...pointer, projectId: "gone" };
    expect(focusTargetAfter("conflict", missing, model)).toEqual({ fallback: "stage-heading" });
    expect(focusTargetAfter("rail", missing, model)).toEqual({ fallback: "board" });
    const movedWithoutSource = { ...model, projects: model.projects.filter((project) => project.id !== "source") };
    expect(focusTargetAfter("success", missing, movedWithoutSource, "raw_review")).toEqual({ fallback: "stage-heading" });
  });

  it("documents all eight engine-neutral guarded manipulation rules", () => {
    expect(QuincyGuardedDirectManipulationPolicy).toHaveLength(8);
    expect(QuincyGuardedDirectManipulationPolicy[0]).toBe("explicit source capability and authorized projection");
    expect(QuincyGuardedDirectManipulationPolicy[7]).toContain("never send client-classified reasons");
    expect(authorizedOrderForStage(movementBoard().projects, "raw_review")).toEqual(["first", "middle", "last"]);
  });
});
