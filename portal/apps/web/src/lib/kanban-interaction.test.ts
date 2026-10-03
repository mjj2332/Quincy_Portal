import { describe, expect, it } from "vitest";
import type { MoveProjectStageResponse } from "@quincy/shared";
import {
  QuincyGuardedDirectManipulationPolicy,
  announce,
  applyOptimisticOverlay,
  boardLandingSlot,
  buildMoveRequest,
  classifyBoardMoveFailure,
  eligibleTarget,
  focusDescriptorFor,
  focusTargetAfter,
  optimismSafeBeforeResponse,
  reconcileAuthoritativeResponse,
  rollbackToBaseline,
  sortKanbanProjects,
  transitionMovementSettle,
  type BoardAnnouncementEvent,
  type BoardModel,
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

function board(projects: ProjectSummary[]): BoardModel {
  return { projects: projects.map((item) => ({ ...item })) };
}

function movementBoard(): BoardModel {
  return board([
    project("source", "awaiting_raw", { boardRevision: 3 }),
    project("first", "raw_review", { boardRevision: 8 }),
    project("middle", "raw_review", { boardRevision: 9 }),
    project("last", "raw_review", { boardRevision: 10 }),
  ]);
}

describe("Kanban interaction model", () => {
  it("sorts by priority 5 to 1 then unset, then oldest shoot date (#470, #475)", () => {
    const rows = [
      project("none-early", "awaiting_raw", { shootDate: "2026-01-01",  }),
      project("p1", "awaiting_raw", { priority: 1, shootDate: "2026-01-02",  }),
      project("p5-late", "awaiting_raw", { priority: 5, shootDate: "2026-12-31",  }),
      project("p5-early", "awaiting_raw", { priority: 5, shootDate: "2026-02-01",  }),
    ];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["p5-early", "p5-late", "p1", "none-early"]);
  });

  it("puts unusable shoot dates last within a tier, then breaks ties by street and id", () => {
    const rows = [
      project("undated", "awaiting_raw", { street: "A Street", shootDate: null }),
      project("invalid", "awaiting_raw", { street: "B Street", shootDate: "2025-02-29" }),
      project("b", "awaiting_raw", { street: "10 King Street", shootDate: "2026-01-01" }),
      project("a", "awaiting_raw", { street: "10 King Street", shootDate: "2026-01-01" }),
      project("accent", "awaiting_raw", { street: "10 Élan Street", shootDate: "2026-01-01" }),
      project("other", "awaiting_raw", { street: "2 Apple Street", shootDate: "2026-01-01" }),
    ];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["accent", "a", "b", "other", "undated", "invalid"]);
  });

  it("does not mutate its input and is independent of input order", () => {
    const rows = [project("b", "awaiting_raw", { priority: 1 }), project("a", "awaiting_raw", { priority: 2 })];
    const copy = [...rows];
    expect(sortKanbanProjects(rows).map((row) => row.id)).toEqual(["a", "b"]);
    expect(rows).toEqual(copy);
    expect(sortKanbanProjects([...rows].reverse()).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("computes the landing slot by sorting the mover into the target column", () => {
    const model = board([
      project("mover", "awaiting_raw", { priority: 3, boardRevision: 3 }),
      project("p5", "raw_review", { priority: 5 }),
      project("p3-early", "raw_review", { priority: 3, shootDate: "2026-01-01" }),
      project("p1", "raw_review", { priority: 1 }),
    ]);
    // The mover has no shoot date, so it sorts after the dated p3 and before p1.
    expect(boardLandingSlot(model.projects, "mover", "raw_review")).toEqual({
      gap: { targetStageKey: "raw_review", successor: "p1" }, position: 3, count: 4,
    });
    const top = board([
      project("mover", "awaiting_raw", { priority: 5, shootDate: "2026-01-01" }),
      project("a", "raw_review", { priority: 5, shootDate: "2026-02-01" }),
    ]);
    expect(boardLandingSlot(top.projects, "mover", "raw_review")).toMatchObject({ gap: { successor: "a" }, position: 1, count: 2 });
    const bottom = board([project("mover", "awaiting_raw"), project("a", "raw_review", { priority: 1 })]);
    expect(boardLandingSlot(bottom.projects, "mover", "raw_review")).toEqual({ gap: { targetStageKey: "raw_review", successor: "end" }, position: 2, count: 2 });
    const empty = board([project("mover", "awaiting_raw")]);
    expect(boardLandingSlot(empty.projects, "mover", "raw_review")).toEqual({ gap: { targetStageKey: "raw_review", successor: "end" }, position: 1, count: 1 });
    expect(boardLandingSlot(empty.projects, "missing", "raw_review")).toBeNull();
  });

  it("maps the Editing transport spelling when computing a landing slot", () => {
    const model = board([project("mover", "awaiting_raw"), project("e", "editing", { priority: 1 })]);
    expect(boardLandingSlot(model.projects, "mover", "editing_autohdr")).toMatchObject({ position: 2, count: 2 });
  });

  it("builds an append request carrying the source CAS and role-safe target", () => {
    const model = movementBoard();
    expect(buildMoveRequest(model, "source", "raw_review", "admin")).toEqual({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "append" },
    });
    expect(buildMoveRequest(model, "source", "editing_autohdr", "editor")).toMatchObject({ targetStageKey: "editing", placement: { kind: "append" } });
    expect(buildMoveRequest(model, "source", "editing_autohdr", "admin")).toMatchObject({ targetStageKey: "editing_autohdr" });
    expect(buildMoveRequest(model, "vanished", "raw_review", "admin")).toEqual({ stale: true });
  });

  it("is eligible only for a cross-Stage move into an active Stage by a principal who may move Stages", () => {
    const model = movementBoard();
    const caps = { canMoveProjectStage: true, activeStageKeys: ["awaiting_raw", "raw_review"] as const };
    expect(eligibleTarget("raw_review", model, "source", caps)).toBe(true);
    expect(eligibleTarget("awaiting_raw", model, "source", caps)).toBe(false);
    expect(eligibleTarget("delivered", model, "source", caps)).toBe(false);
    expect(eligibleTarget("raw_review", model, "source", { ...caps, canMoveProjectStage: false })).toBe(false);
    expect(eligibleTarget("raw_review", model, "vanished", caps)).toBe(false);
  });

  it("overlays only the mover's Stage, keeps revisions, and rolls back completely", () => {
    const baseline = movementBoard();
    const overlay = applyOptimisticOverlay(baseline, "source", "raw_review", "admin");
    expect(overlay.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 3 });
    expect(overlay.projects.find((item) => item.id === "first")?.boardRevision).toBe(8);
    // The card renders at its sorted slot, not at a requested one: the overlay carries no position.
    expect(sortKanbanProjects(overlay.projects.filter((item) => item.stageKey === "raw_review")).map((item) => item.id)).toEqual(["first", "last", "middle", "source"]);
    expect(rollbackToBaseline(baseline)).toEqual(baseline);
    expect(JSON.stringify(rollbackToBaseline(baseline))).toBe(JSON.stringify(baseline));
    expect(baseline.projects.find((item) => item.id === "source")?.stageKey).toBe("awaiting_raw");

    const editorOverlay = applyOptimisticOverlay(baseline, "source", "editing_autohdr", "editor");
    expect(editorOverlay.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "editing" });
    expect(applyOptimisticOverlay(baseline, "vanished", "raw_review", "admin")).toEqual(rollbackToBaseline(baseline));
  });

  it("a settled move sets the mover's Stage and revision from the response and reports the provisional source; the column order comes from the data, not from orderedVisibleProjectIds", () => {
    const baseline = movementBoard();
    const response: MoveProjectStageResponse = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 11 },
      // A deprecated field a stale server still sends. It disagrees with the data on purpose and must not reorder the column.
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["source", "last", "middle", "first"] },
    };
    const settled = reconcileAuthoritativeResponse(baseline, "source", response);
    expect(settled.sourceProvisional).toBe(true);
    expect(settled.model.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 11 });
    expect(settled.model.projects.find((item) => item.id === "first")?.boardRevision).toBe(8);
    expect(sortKanbanProjects(settled.model.projects.filter((item) => item.stageKey === "raw_review")).map((item) => item.id)).toEqual(["first", "last", "middle", "source"]);
    // The response omits the deprecated field entirely: the same settle.
    const bare = reconcileAuthoritativeResponse(baseline, "source", { ...response, board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review" } });
    expect(bare.sourceProvisional).toBe(true);
    expect(bare.model.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review", boardRevision: 11 });
    const unchanged = reconcileAuthoritativeResponse(baseline, "source", { ...response, changed: false });
    expect(unchanged.model.projects.find((item) => item.id === "source")).toMatchObject({ stageKey: "raw_review" });
  });

  it("carries the widened summary's assigned Editors through a Stage move untouched", () => {
    const editors = [{ id: "editor-1", name: "Assigned Editor" }];
    const baseline = board([
      project("source", "awaiting_raw", { boardRevision: 3, editors }),
      project("first", "raw_review", { boardRevision: 8 }),
    ]);
    const overlay = applyOptimisticOverlay(baseline, "source", "raw_review", "admin");
    expect(overlay.projects.find((item) => item.id === "source")?.editors).toEqual(editors);

    const response: MoveProjectStageResponse = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["first", "source"] },
    };
    const settled = reconcileAuthoritativeResponse(baseline, "source", response);
    expect(settled.model.projects.find((item) => item.id === "source")?.editors).toEqual(editors);
  });

  it("allows only safe ordinary forward cross-Stage optimism", () => {
    expect(optimismSafeBeforeResponse("awaiting_raw", "raw_review", "editor")).toBe(true);
    expect(optimismSafeBeforeResponse("raw_review", "awaiting_raw", "editor")).toBe(false);
    expect(optimismSafeBeforeResponse("awaiting_raw", "editing", "editor")).toBe(false);
    expect(optimismSafeBeforeResponse("edited_review", "delivered", "editor")).toBe(false);
    expect(optimismSafeBeforeResponse("raw_review", "editing", "editor")).toBe(false);
    expect(optimismSafeBeforeResponse("not-a-stage", "raw_review", "editor")).toBe(false);
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
      [{ type: "over-stage" }, "12 Kings Road is over RAW review; it will land at position 2 of 4."],
      [{ type: "valid-drop" }, "Dropped 12 Kings Road in RAW review, position 2 of 4. Saving."],
      [{ type: "dnd-cancel" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "drop-outside" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "same-stage-refused" }, "12 Kings Road stays in Awaiting RAW. Columns are sorted by priority and shoot date."],
      [{ type: "invalid-keyboard-target" }, "Cancelled moving 12 Kings Road. It remains in Awaiting RAW."],
      [{ type: "stale-move-to" }, "That position changed. Reloading the latest Board; no move was made."],
      [{ type: "confirmation-required" }, "Move needs confirmation. 12 Kings Road remains in Awaiting RAW."],
      [{ type: "modal-cancel" }, "Stage move cancelled. 12 Kings Road remains in Awaiting RAW."],
      [{ type: "cross-stage-success" }, "Moved 12 Kings Road to RAW review, position 2 of 4."],
      [{ type: "no-change" }, "12 Kings Road is already in RAW review, position 2 of 4."],
      [{ type: "post-success-refetch-failure" }, "The move was saved, but the latest Board could not be loaded. Refresh to continue."],
      [{ type: "conflict" }, "Could not move 12 Kings Road because the Board changed elsewhere. Reloading the latest Board; no retry was made."],
      [{ type: "contract-off" }, "Board interactions are temporarily unavailable while the Board contract is disabled."],
      [{ type: "maintenance" }, "Board interactions are temporarily unavailable while the Board is being updated."],
    ];
    for (const [event, expected] of cases) expect(announce(event, ctx)).toBe(expected);
    expect(announce({ type: "cross-stage-success" }, { ...ctx, terminal: true })).toBeUndefined();
  });

  it("returns deterministic focus descriptors and outcome targets/fallbacks for every origin", () => {
    const model = movementBoard();
    const source = model.projects.find((item) => item.id === "source")!;
    const pointer = focusDescriptorFor("pointer", source, model);
    expect(pointer).toMatchObject({ path: "pointer", projectId: "source", control: "handle", sourceStageKey: "awaiting_raw", sourceIndex: 0 });
    expect(focusDescriptorFor("move-to", source, model).control).toBe("move-to");
    expect(focusDescriptorFor("rail", source, model).control).toBe("rail-stage");
    const origins = [
      ["pointer", pointer],
      ["keyboard", focusDescriptorFor("keyboard", source, model)],
      ["move-to", focusDescriptorFor("move-to", source, model)],
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
  });
});
