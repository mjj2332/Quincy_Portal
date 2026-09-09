import {
  STAGE_KEYS,
  authorizedBoardRank,
  compareByStreetThenId,
  parseStageTransportKey,
  stageMoveConfirmationReasons,
  stageTransportKeyForRole,
  type ExpectedBoardProject,
  type MoveProjectStageRequest,
  type MoveProjectStageResponse,
  type Role,
  type StageKey,
  type StageMoveConfirmationReason,
  type StageMovePlacement,
  type StageTransportKey,
} from "@quincy/shared";
import type { PipelineStage } from "./stages";

/**
 * The Dashboard's role-safe project summary is a data boundary, so the pure Board
 * interaction model owns it instead of making the query adapter import a screen.
 */
export interface ProjectSummary {
  id: string;
  street: string;
  suburb: string | null;
  postcode: string | null;
  agencyName: string | null;
  agentName: string | null;
  /** `editing` is the role-safe transport presentation of `editing_autohdr`. */
  stageKey: StageKey | "editing";
  shootDate: string | null;
  coverAssetId: string | null;
  receivedCount: number;
  expectedCount: number | null;
  priority: number | null;
  /** Legacy wire field retained for compatibility; Board rendering never reads it. */
  boardPosition?: number;
  /** The one authorized Board projection carried through the web adapter for interactions. */
  authorizedBoardOrder?: Record<string, string[]>;
  /** Private, non-wire rendering rank derived from the authorized Board ID map. */
  boardRank?: number;
  /** Private marker: Board ordering is authoritative even when this card's ID is absent. */
  boardMapPresent?: boolean;
  boardContractEnabled?: boolean;
  boardRevision: number;
  deadlineAt: number | null;
  deadlineLocalCivil: string | null;
  deadlineZone: "Australia/Sydney" | null;
  /**
   * Only currently-assigned, active Editors — never Photographers. No avatar image, so avatars
   * render from initials. Contract-only for now: #82 is the first renderer. Optional so an old
   * cached snapshot or a fixture that predates this field still satisfies the type.
   */
  editors?: { id: string; name: string }[];
}

/** Kept as a local type to avoid making this dependency-free module import a screen helper. */
export type KanbanSortMode = "board" | "priority" | "shootDate-asc" | "shootDate-desc";

export type DroppableData =
  | { kind: "card"; stageKey: StageKey; projectId: string }
  | { kind: "column"; stageKey: StageKey };

/** A revision-free intent. Neighbour revisions are resolved only at activation time. */
export type SemanticGap = { targetStageKey: StageKey; successor: string | "end" };

export type BoardInteractionOrigin = "pointer" | "touch" | "keyboard" | "move-to" | "arrow" | "rail";

export type FocusDescriptor = {
  path: BoardInteractionOrigin;
  projectId: string;
  control: "handle" | "move-to" | "arrow-up" | "arrow-down" | "rail-stage";
  sourceStageKey: StageKey;
  sourceIndex: number;
};

/** The accepted Board snapshot. Optional metadata is pure model state, never query-cache state. */
export type BoardModel = {
  projects: ProjectSummary[];
  authorizedBoardOrder?: Record<string, string[]>;
  provisionalSourceStageKey?: StageKey;
};

export type MovementBaseline = BoardModel;

export type OptimisticOverlay = {
  model: BoardModel;
  movingProjectId: string;
  gap: SemanticGap;
};

export type BoardDragStartSnapshot = {
  model: BoardModel;
  movingProjectId: string;
  sort?: KanbanSortMode;
  /** Display order is a transient presentation input, not a wire placement. */
  displayOrderByStage?: Record<string, string[]>;
};

export type BoardProposal = {
  orders: Record<string, string[]>;
  gap: SemanticGap;
};

export type BoardInteractionState = {
  activeId: string | undefined;
  proposal: SemanticGap | null;
};

export type ProjectKanbanBoardProps = {
  projects: ProjectSummary[];
  activeStages: readonly PipelineStage[];
  canMoveStages: boolean;
  canPrioritize: boolean;
  role?: Role;
  boardMutationEnabled: boolean;
  movementDisabled?: boolean;
  sameStageReorderEnabled?: boolean;
  effectiveKanbanSort: KanbanSortMode;
  pendingMoves: ReadonlySet<string>;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  onBoardMove?: (projectId: string, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) => void;
  /** Compatibility seam for Slice 2 callers; all current Dashboard movement uses onBoardMove. */
  onCrossStageMove?: (projectId: string, gap: SemanticGap, focusDescriptor: FocusDescriptor) => void;
  onBoardPosition: (project: ProjectSummary, direction: "up" | "down") => void;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  onMoveStage: (project: ProjectSummary, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) => void;
  onMoveToProposalChange?: (proposal: SemanticGap | null) => void;
  onInteractionStateChange?: (state: BoardInteractionState) => void;
  onAnnounce?: (message: string | undefined) => void;
  projectHrefFor?: (project: ProjectSummary) => string | undefined;
};

type CanonicalStageKey = StageKey;

function canonicalStageKey(value: string): CanonicalStageKey | null {
  if (value === "editing") return "editing_autohdr";
  return (STAGE_KEYS as readonly string[]).includes(value) ? value as StageKey : null;
}

function projectStageKey(project: ProjectSummary): CanonicalStageKey | null {
  return canonicalStageKey(project.stageKey);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isCanonicalShootDate(value: string | null): value is string {
  if (value === null) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function sortKanbanProjectsByShootDate(
  projects: ProjectSummary[],
  mode: "shootDate-asc" | "shootDate-desc",
): ProjectSummary[] {
  const direction = mode === "shootDate-asc" ? 1 : -1;
  return [...projects].sort((left, right) => {
    const leftDate = isCanonicalShootDate(left.shootDate) ? left.shootDate : null;
    const rightDate = isCanonicalShootDate(right.shootDate) ? right.shootDate : null;
    if (leftDate === null || rightDate === null) {
      if (leftDate === rightDate) return compareByStreetThenId(left, right);
      return leftDate === null ? 1 : -1;
    }
    if (leftDate !== rightDate) return direction * (leftDate < rightDate ? -1 : 1);
    return compareByStreetThenId(left, right);
  });
}

export function sortKanbanProjects(projects: ProjectSummary[], sort: KanbanSortMode = "board"): ProjectSummary[] {
  const boardRank = (project: ProjectSummary): number => {
    const canonical = canonicalStageKey(project.stageKey);
    const order = canonical
      ? project.authorizedBoardOrder?.[canonical] ?? project.authorizedBoardOrder?.[project.stageKey]
      : project.authorizedBoardOrder?.[project.stageKey];
    if (order !== undefined) {
      const rank = order.indexOf(project.id);
      return rank < 0 ? Number.POSITIVE_INFINITY : rank;
    }
    return project.boardRank ?? Number.POSITIVE_INFINITY;
  };
  if (sort === "priority") return [...projects].sort((left, right) =>
    (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0)
    || (left.priority ?? 0) - (right.priority ?? 0)
    || boardRank(left) - boardRank(right)
    || left.id.localeCompare(right.id));
  if (sort !== "board") return sortKanbanProjectsByShootDate(projects, sort);
  const hasAuthorizedMap = projects.some((project) => project.boardMapPresent === true
    || project.boardRank !== undefined
    || project.authorizedBoardOrder?.[canonicalStageKey(project.stageKey) ?? project.stageKey] !== undefined
    || project.authorizedBoardOrder?.[project.stageKey] !== undefined);
  if (hasAuthorizedMap) {
    return [...projects].sort((left, right) => boardRank(left) - boardRank(right) || left.id.localeCompare(right.id));
  }
  // Pre-contract servers do not provide a board map. Their list order is the only
  // authoritative order available; never infer render order from the private position field.
  return [...projects];
}

function projectById(projects: ProjectSummary[]): Map<string, ProjectSummary> {
  return new Map(projects.map((project) => [project.id, project]));
}

export function authorizedOrderForStage(projects: ProjectSummary[], stageKey: StageKey): string[] | undefined;
export function authorizedOrderForStage(projects: ProjectSummary[], stageKey: string): string[] | undefined;
export function authorizedOrderForStage(projects: ProjectSummary[], stageKey: string): string[] | undefined {
  return projects.find((project) => project.authorizedBoardOrder?.[stageKey] !== undefined)?.authorizedBoardOrder?.[stageKey];
}

function expectedNeighbour(projectId: string, projects: Map<string, ProjectSummary>): ExpectedBoardProject | null {
  const project = projects.get(projectId);
  return project ? { projectId, boardRevision: project.boardRevision } : null;
}

/** Build the exact visible neighbour tuple from the authorized map, never from boardPosition. */
export function cardDropPlacement(
  movingProjectId: string,
  targetProjectId: string,
  targetStageKey: string,
  edge: "before" | "after",
  projects: ProjectSummary[],
): StageMovePlacement | null {
  const order = authorizedOrderForStage(projects, targetStageKey);
  if (!order) return null;
  const withoutMoving = order.filter((projectId) => projectId !== movingProjectId);
  const targetIndex = withoutMoving.indexOf(targetProjectId);
  if (targetIndex < 0) return null;
  const insertionIndex = edge === "before" ? targetIndex : targetIndex + 1;
  if (insertionIndex >= withoutMoving.length) return { kind: "append" };
  const byId = projectById(projects);
  const before = insertionIndex > 0 ? expectedNeighbour(withoutMoving[insertionIndex - 1]!, byId) : null;
  const after = expectedNeighbour(withoutMoving[insertionIndex]!, byId);
  if (insertionIndex > 0 && !before) return null;
  if (!after) return null;
  return { kind: "between", before, after };
}

/** Build the exact adjacent placement used by the arrow/keyboard controls. */
export function adjacentBoardPlacement(
  movingProjectId: string,
  targetStageKey: string,
  direction: "up" | "down",
  projects: ProjectSummary[],
): StageMovePlacement | null {
  const gap = adjacentBoardGap(movingProjectId, targetStageKey, direction, projects);
  if (!gap) return null;
  const moving = projects.find((project) => project.id === movingProjectId);
  const authorizedBoardOrder = projects.find((project) => project.authorizedBoardOrder !== undefined)?.authorizedBoardOrder;
  if (!moving || !authorizedBoardOrder) return null;
  const resolved = resolveSemanticGap(gap, { projects, authorizedBoardOrder }, movingProjectId);
  return "stale" in resolved ? null : resolved.placement;
}

/** Returns the revision-free gap used by an adjacent Board arrow. */
export function adjacentBoardGap(
  movingProjectId: string,
  targetStageKey: string,
  direction: "up" | "down",
  projects: ProjectSummary[],
): SemanticGap | null {
  const order = authorizedOrderForStage(projects, targetStageKey);
  if (!order) return null;
  const movingIndex = order.indexOf(movingProjectId);
  const withoutMoving = order.filter((projectId) => projectId !== movingProjectId);
  if (movingIndex < 0) return null;
  const currentIndex = withoutMoving.slice(0, movingIndex).length;
  const desiredIndex = direction === "up"
    ? Math.max(0, currentIndex - 1)
    : Math.min(withoutMoving.length, currentIndex + 1);
  if (desiredIndex === currentIndex) return null;
  return { targetStageKey: canonicalStageKey(targetStageKey) ?? targetStageKey as StageKey, successor: withoutMoving[desiredIndex] ?? "end" };
}

function cloneOrders(orders: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(orders).map(([stageKey, ids]) => [stageKey, [...ids]]));
}

function canonicalOrders(orders: Record<string, readonly string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [stageKey, ids] of Object.entries(orders)) {
    const canonical = canonicalStageKey(stageKey);
    if (canonical) result[canonical] = [...ids];
  }
  return result;
}

function modelOrders(model: BoardModel): Record<string, string[]> {
  const fromModel = model.authorizedBoardOrder
    ?? model.projects.find((project) => project.authorizedBoardOrder !== undefined)?.authorizedBoardOrder;
  const orders = fromModel ? canonicalOrders(fromModel) : {};
  // A complete authorized map normally contains every visible Stage. Keeping a defensive
  // visible fallback makes transient proposals useful for fixtures and pre-contract snapshots;
  // wire placement uses authorizedModelOrders below and fails closed without that map.
  for (const project of model.projects) {
    const stageKey = projectStageKey(project);
    if (!stageKey || orders[stageKey]) continue;
    orders[stageKey] = model.projects
      .filter((candidate) => projectStageKey(candidate) === stageKey)
      .map((candidate) => candidate.id);
  }
  return orders;
}

function authorizedModelOrders(model: BoardModel): Record<string, string[]> | undefined {
  const fromModel = model.authorizedBoardOrder
    ?? model.projects.find((project) => project.authorizedBoardOrder !== undefined)?.authorizedBoardOrder;
  return fromModel ? canonicalOrders(fromModel) : undefined;
}

function orderForCanonicalStage(orders: Record<string, string[]>, stageKey: StageKey): string[] | undefined {
  return orders[stageKey];
}

function attachOrders(model: BoardModel, orders: Record<string, string[]>): BoardModel {
  const attachedOrders = cloneOrders(orders);
  const hadMap = model.authorizedBoardOrder !== undefined
    || model.projects.some((project) => project.authorizedBoardOrder !== undefined);
  const projects = model.projects.map((project) => {
    const stageKey = projectStageKey(project);
    const rank = stageKey ? authorizedBoardRank(project.id, stageKey, attachedOrders) : undefined;
    return {
      ...project,
      authorizedBoardOrder: cloneOrders(attachedOrders),
      boardRank: rank,
      boardMapPresent: hadMap || Object.keys(attachedOrders).length > 0,
    };
  });
  return { ...model, projects, authorizedBoardOrder: attachedOrders };
}

function visibleDisplayOrders(snapshot: BoardDragStartSnapshot): Record<string, string[]> {
  if (snapshot.displayOrderByStage) return canonicalOrders(snapshot.displayOrderByStage);
  const orders = modelOrders(snapshot.model);
  if (!snapshot.sort || snapshot.sort === "board") return orders;
  const result: Record<string, string[]> = {};
  for (const stageKey of Object.keys(orders)) {
    const stageProjects = snapshot.model.projects.filter((project) => projectStageKey(project) === stageKey);
    result[stageKey] = sortKanbanProjects(stageProjects, snapshot.sort).map((project) => project.id);
  }
  return result;
}

function normalizeSnapshot(
  snapshotOrModel: BoardDragStartSnapshot | BoardModel,
  movingProjectIdOrHovered: string | DroppableData,
  maybeHovered?: DroppableData,
  sort?: KanbanSortMode,
): BoardDragStartSnapshot | null {
  if ("movingProjectId" in snapshotOrModel) return snapshotOrModel;
  if (typeof movingProjectIdOrHovered !== "string" || !maybeHovered) return null;
  return { model: snapshotOrModel, movingProjectId: movingProjectIdOrHovered, sort };
}

/**
 * Computes a transient multi-container proposal. A card hit means the visual gap immediately
 * before that card; a column hit means the end of that column. The return contains no revisions.
 */
export function proposeMultiContainerDrop(
  snapshot: BoardDragStartSnapshot,
  hovered: DroppableData,
): BoardProposal | null;
export function proposeMultiContainerDrop(
  model: BoardModel,
  movingProjectId: string,
  hovered: DroppableData,
  sort?: KanbanSortMode,
): BoardProposal | null;
export function proposeMultiContainerDrop(
  snapshotOrModel: BoardDragStartSnapshot | BoardModel,
  movingProjectIdOrHovered: string | DroppableData,
  maybeHovered?: DroppableData,
  sort?: KanbanSortMode,
): BoardProposal | null {
  const snapshot = normalizeSnapshot(snapshotOrModel, movingProjectIdOrHovered, maybeHovered, sort);
  if (!snapshot) return null;
  const mover = snapshot.model.projects.find((project) => project.id === snapshot.movingProjectId);
  if (!mover) return null;
  if (hoveredIsMover(movingProjectIdOrHovered, maybeHovered, snapshot.movingProjectId)) return null;
  const hovered = "movingProjectId" in snapshotOrModel ? movingProjectIdOrHovered as DroppableData : maybeHovered!;
  const orders = visibleDisplayOrders(snapshot);
  const withoutMover = Object.fromEntries(Object.entries(orders).map(([stageKey, ids]) => [
    stageKey,
    ids.filter((projectId) => projectId !== snapshot.movingProjectId),
  ]));
  const targetOrder = withoutMover[hovered.stageKey] ? [...withoutMover[hovered.stageKey]!] : [];
  const gap: SemanticGap = hovered.kind === "column"
    ? { targetStageKey: hovered.stageKey, successor: "end" }
    : { targetStageKey: hovered.stageKey, successor: hovered.projectId };
  const insertionIndex = gap.successor === "end" ? targetOrder.length : targetOrder.indexOf(gap.successor);
  if (gap.successor !== "end" && insertionIndex < 0) return null;
  targetOrder.splice(insertionIndex, 0, snapshot.movingProjectId);
  withoutMover[hovered.stageKey] = targetOrder;
  return { orders: withoutMover, gap };
}

function hoveredIsMover(
  movingProjectIdOrHovered: string | DroppableData,
  maybeHovered: DroppableData | undefined,
  movingProjectId: string,
): boolean {
  const hovered = typeof movingProjectIdOrHovered === "string" ? maybeHovered : movingProjectIdOrHovered;
  return hovered?.kind === "card" && hovered.projectId === movingProjectId;
}

export function proposedOrdersForHover(
  snapshot: BoardDragStartSnapshot,
  hovered: DroppableData,
): Record<string, string[]> | null;
export function proposedOrdersForHover(
  model: BoardModel,
  movingProjectId: string,
  hovered: DroppableData,
  sort?: KanbanSortMode,
): Record<string, string[]> | null;
export function proposedOrdersForHover(
  snapshotOrModel: BoardDragStartSnapshot | BoardModel,
  movingProjectIdOrHovered: string | DroppableData,
  maybeHovered?: DroppableData,
  sort?: KanbanSortMode,
): Record<string, string[]> | null {
  const proposal = typeof movingProjectIdOrHovered === "string"
    ? proposeMultiContainerDrop(snapshotOrModel as BoardModel, movingProjectIdOrHovered, maybeHovered!, sort)
    : proposeMultiContainerDrop(snapshotOrModel as BoardDragStartSnapshot, movingProjectIdOrHovered);
  return proposal?.orders ?? null;
}

/** Alias named for the Board's presentation-level vocabulary. */
export const proposeBoardDrop = proposeMultiContainerDrop;

export function resolveSemanticGap(
  gap: SemanticGap,
  model: BoardModel,
  movingProjectId: string,
): { placement: StageMovePlacement } | { stale: true } {
  const mover = model.projects.find((project) => project.id === movingProjectId);
  if (!mover) return { stale: true };
  const orders = authorizedModelOrders(model);
  if (!orders) return { stale: true };
  const targetOrder = orderForCanonicalStage(orders, gap.targetStageKey) ?? [];
  const targetIds = targetOrder.filter((projectId) => projectId !== movingProjectId);
  if (gap.successor === "end") return { placement: { kind: "append" } };
  if (gap.successor === movingProjectId || !projectById(model.projects).has(gap.successor)) return { stale: true };
  const successorIndex = targetIds.indexOf(gap.successor);
  if (successorIndex < 0) return { stale: true };
  const byId = projectById(model.projects);
  const before = successorIndex > 0 ? expectedNeighbour(targetIds[successorIndex - 1]!, byId) : null;
  const after = expectedNeighbour(targetIds[successorIndex]!, byId);
  if ((successorIndex > 0 && !before) || !after) return { stale: true };
  const targetStage = projectStageKey(byId.get(gap.successor)!);
  if (targetStage !== gap.targetStageKey) return { stale: true };
  return { placement: { kind: "between", before, after } };
}

/** Same-Stage movement is a Board-position command, never a Stage command. */
export function isSameStagePlacementChange(
  input: { gap: SemanticGap; movingProject: ProjectSummary },
): boolean {
  const movingStage = projectStageKey(input.movingProject);
  return movingStage !== null
    && movingStage === canonicalStageKey(input.gap.targetStageKey)
    && input.gap.successor !== input.movingProject.id;
}

/** Resolves a same-Stage gap to the exact neighbour revisions required by /board-position. */
export function reorderIntentFromGap(
  gap: SemanticGap,
  model: BoardModel,
  movingProjectId: string,
  role: Role,
): { targetStageKey: StageTransportKey; placement: StageMovePlacement } | { stale: true } {
  const movingProject = model.projects.find((project) => project.id === movingProjectId);
  if (!movingProject || !isSameStagePlacementChange({ gap, movingProject })) return { stale: true };
  const currentStageKey = projectStageKey(movingProject);
  if (!currentStageKey) return { stale: true };
  const resolved = resolveSemanticGap(gap, model, movingProjectId);
  if ("stale" in resolved) return resolved;
  return {
    targetStageKey: stageTransportKeyForRole(currentStageKey, role),
    placement: resolved.placement,
  };
}

/** Detects a same-Stage gap which leaves the canonical Board order unchanged. */
export function boardGapChangesOrder(
  gap: SemanticGap,
  model: BoardModel,
  movingProjectId: string,
): boolean {
  const moving = model.projects.find((project) => project.id === movingProjectId);
  if (!moving || projectStageKey(moving) !== canonicalStageKey(gap.targetStageKey)) return true;
  const order = modelOrders(model)[canonicalStageKey(gap.targetStageKey) ?? gap.targetStageKey] ?? [];
  const withoutMoving = order.filter((projectId) => projectId !== movingProjectId);
  const currentIndex = order.indexOf(movingProjectId);
  if (gap.successor === movingProjectId) return false;
  const targetIndex = gap.successor === "end" ? withoutMoving.length : withoutMoving.indexOf(gap.successor);
  return currentIndex < 0 || targetIndex < 0 || targetIndex !== withoutMoving.slice(0, currentIndex).length;
}

export function buildMoveRequest(
  model: BoardModel,
  movingProjectId: string,
  gap: SemanticGap,
  role: Role,
): MoveProjectStageRequest | { stale: true } {
  const moving = model.projects.find((project) => project.id === movingProjectId);
  if (!moving) return { stale: true };
  const resolved = resolveSemanticGap(gap, model, movingProjectId);
  if ("stale" in resolved) return resolved;
  return {
    expected: {
      stageKey: moving.stageKey as StageTransportKey,
      boardRevision: moving.boardRevision,
    },
    targetStageKey: stageTransportKeyForRole(gap.targetStageKey, role),
    placement: resolved.placement,
  };
}

export type EligibleTargetCapabilities = {
  canMoveProjectStage: boolean;
  canPrioritize: boolean;
  sort: KanbanSortMode;
  activeStageKeys: readonly StageKey[];
};

export type MoveToPositionOption = {
  label: string;
  successor: string | "end";
};

export type MoveToPositionCapabilities = EligibleTargetCapabilities & {
  stageLabel?: string;
  stageLabels?: Readonly<Record<string, string>>;
};

function fallbackStageLabel(stageKey: StageKey): string {
  if (stageKey === "editing_autohdr") return "Editing";
  return stageKey.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * Returns the complete, role-safe position menu for the non-drag Move-to action.
 * The authorized order is only a source of candidate IDs; the visible project map
 * is the allow-list that prevents hidden projects leaking into the menu.
 */
export function moveToPositionOptions(
  model: BoardModel,
  movingProjectId: string,
  targetStageKey: StageKey,
  role: Role,
  caps: MoveToPositionCapabilities,
): MoveToPositionOption[] {
  const moving = model.projects.find((project) => project.id === movingProjectId);
  const target = canonicalStageKey(targetStageKey);
  if (!moving || !target || !caps.activeStageKeys.some((key) => canonicalStageKey(key) === target)) return [];
  const source = projectStageKey(moving);
  if (!source) return [];
  const sameStage = source === target;
  if (sameStage && !(role === "admin" && caps.canPrioritize && caps.sort === "board")) return [];
  if (!sameStage && !caps.canMoveProjectStage) return [];

  const order = authorizedModelOrders(model)?.[target] ?? [];
  const visibleById = projectById(model.projects);
  const visibleSuccessors = order.filter((projectId) => {
    if (projectId === movingProjectId) return false;
    const candidate = visibleById.get(projectId);
    return candidate !== undefined && projectStageKey(candidate) === target;
  });
  const label = caps.stageLabels?.[target] ?? caps.stageLabel ?? fallbackStageLabel(target);
  return [
    { label: `End of ${label}`, successor: "end" },
    ...visibleSuccessors.map((successor, index) => ({
      label: `Before ${visibleById.get(successor)!.street} — position ${index + 1}`,
      successor,
    })),
  ];
}

export function eligibleTarget(
  gap: SemanticGap,
  model: BoardModel,
  movingProjectId: string,
  caps: EligibleTargetCapabilities,
): boolean {
  const mover = model.projects.find((project) => project.id === movingProjectId);
  const targetStage = canonicalStageKey(gap.targetStageKey);
  if (!mover || !targetStage || gap.successor === movingProjectId || !caps.activeStageKeys.some((key) => canonicalStageKey(key) === targetStage)) return false;
  const sourceStage = projectStageKey(mover);
  if (!sourceStage) return false;
  if (sourceStage === targetStage) return caps.canPrioritize && caps.sort === "board";
  return caps.canMoveProjectStage;
}

/**
 * Applies the five-step optimistic overlay to accepted data. The caller retains `baseline`;
 * this function never changes the input and deliberately leaves every boardRevision untouched.
 */
export function applyOptimisticOverlay(
  baseline: MovementBaseline,
  movingProjectId: string,
  gap: SemanticGap,
  role: Role,
): BoardModel {
  const moving = baseline.projects.find((project) => project.id === movingProjectId);
  if (!moving) return rollbackToBaseline(baseline);
  const orders = modelOrders(baseline);
  const sourceStage = projectStageKey(moving);
  if (!sourceStage) return rollbackToBaseline(baseline);
  for (const stageKey of Object.keys(orders)) orders[stageKey] = orders[stageKey]!.filter((projectId) => projectId !== movingProjectId);
  const target = orders[gap.targetStageKey] ?? [];
  const insertionIndex = gap.successor === "end" ? target.length : target.indexOf(gap.successor);
  if (gap.successor !== "end" && insertionIndex < 0) return rollbackToBaseline(baseline);
  target.splice(insertionIndex, 0, movingProjectId);
  orders[gap.targetStageKey] = target;
  const nextProjects = baseline.projects.map((project) => {
    if (project.id !== movingProjectId) return { ...project };
    const roleSafeStage: ProjectSummary["stageKey"] = stageTransportKeyForRole(gap.targetStageKey, role);
    return { ...project, stageKey: roleSafeStage };
  });
  return attachOrders({ ...baseline, projects: nextProjects, provisionalSourceStageKey: undefined }, orders);
}

export function reconcileAuthoritativeResponse(
  baseline: MovementBaseline,
  movingProjectId: string,
  response: MoveProjectStageResponse,
): { model: BoardModel; sourceProvisional: boolean } {
  const moving = baseline.projects.find((project) => project.id === movingProjectId);
  if (!moving || response.project.projectId !== movingProjectId) return { model: rollbackToBaseline(baseline), sourceProvisional: false };
  const orders = modelOrders(baseline);
  const sourceStage = canonicalStageKey(response.board.sourceStageKey) ?? projectStageKey(moving);
  const targetStage = canonicalStageKey(response.board.targetStageKey);
  if (!sourceStage || !targetStage) return { model: rollbackToBaseline(baseline), sourceProvisional: false };
  orders[targetStage] = [...response.board.orderedVisibleProjectIds];
  const sourceProvisional = sourceStage !== targetStage;
  if (sourceProvisional) orders[sourceStage] = (orders[sourceStage] ?? []).filter((projectId) => projectId !== movingProjectId);
  const responseStage = response.project.stageKey;
  const nextProjects = baseline.projects.map((project) => project.id === movingProjectId
    ? { ...project, stageKey: responseStage, boardRevision: response.project.boardRevision }
    : { ...project });
  const model = attachOrders({
    ...baseline,
    projects: nextProjects,
    provisionalSourceStageKey: sourceProvisional ? sourceStage : undefined,
  }, orders);
  return { model, sourceProvisional };
}

export function rollbackToBaseline(baseline: MovementBaseline): BoardModel {
  return {
    ...baseline,
    projects: baseline.projects.map((project) => ({
      ...project,
      ...(project.authorizedBoardOrder ? { authorizedBoardOrder: cloneOrders(project.authorizedBoardOrder) } : {}),
    })),
    ...(baseline.authorizedBoardOrder ? { authorizedBoardOrder: cloneOrders(baseline.authorizedBoardOrder) } : {}),
  };
}

function normalizeStageTransport(value: unknown, role: Role): StageKey | null {
  const parsed = parseStageTransportKey(value, role);
  if (!parsed) return null;
  const transport = stageTransportKeyForRole(parsed, role);
  return canonicalStageKey(transport) ?? parsed;
}

/**
 * This is a display-timing classifier only. It never creates or returns confirmation reasons;
 * the server remains the sole authority for confirmation and the retry payload.
 */
export function optimismSafeBeforeResponse(
  fromStageKey: StageTransportKey | string,
  toStageKey: StageTransportKey | string,
  role: Role,
  isSameStage: boolean,
): boolean {
  if (isSameStage) return true;
  const from = normalizeStageTransport(fromStageKey, role);
  const to = normalizeStageTransport(toStageKey, role);
  if (!from || !to) return false;
  return stageMoveConfirmationReasons(from, to).length === 0;
}

export type MovementSettleState = {
  pending: boolean;
  recoveryReason: string | null;
};

export type MovementSettleEvent =
  | { type: "winner" }
  | { type: "refetch-succeeded" }
  | { type: "refetch-failed"; reason: string }
  | { type: "terminal" };

/** Pure settle-barrier transition table used by the Dashboard command boundary. */
export function transitionMovementSettle(state: MovementSettleState, event: MovementSettleEvent): MovementSettleState {
  if (event.type === "winner") return { pending: true, recoveryReason: null };
  if (event.type === "refetch-failed") return state.pending ? { pending: true, recoveryReason: event.reason } : state;
  if (event.type === "refetch-succeeded" || event.type === "terminal") return { pending: false, recoveryReason: null };
  return state;
}

export type BoardMoveRollbackCode = "project_archived_read_only" | "inactive_destination" | "stage_contract_reload_required";

export type BoardMoveFailureClassification = {
  code: BoardMoveRollbackCode;
  action: "rollback-and-refetch";
  refetch: true;
  retry: false;
};

function failureCode(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if ("code" in value) return value.code;
  if ("details" in value && value.details && typeof value.details === "object" && "code" in value.details) return value.details.code;
  return undefined;
}

export function classifyBoardMoveFailure(value: unknown): BoardMoveFailureClassification | null {
  const code = failureCode(value);
  if (code !== "project_archived_read_only" && code !== "inactive_destination" && code !== "stage_contract_reload_required") return null;
  return { code, action: "rollback-and-refetch", refetch: true, retry: false };
}

export const classifyBoardMoveError = classifyBoardMoveFailure;

export type FocusOutcome =
  | "success"
  | "dnd-cancel"
  | "modal-cancel"
  | "conflict"
  | "503"
  | "rail"
  | "drop-outside"
  | "no-op"
  | "stale-move-to"
  | "invalid-keyboard-target"
  | "post-success-refetch-failure";

function hasProject(model: BoardModel, projectId: string): boolean {
  return model.projects.some((project) => project.id === projectId);
}

function hasStage(model: BoardModel, stageKey: StageKey): boolean {
  return model.projects.some((project) => projectStageKey(project) === stageKey);
}

export function focusDescriptorFor(
  origin: BoardInteractionOrigin,
  project: ProjectSummary,
  model: BoardModel,
  control?: FocusDescriptor["control"],
): FocusDescriptor {
  const sourceStageKey = projectStageKey(project) ?? "awaiting_raw";
  const order = orderForCanonicalStage(modelOrders(model), sourceStageKey);
  const sourceIndex = order?.indexOf(project.id) ?? -1;
  const resolvedControl = control ?? (origin === "move-to"
    ? "move-to"
    : origin === "rail"
      ? "rail-stage"
      : origin === "arrow"
        ? "arrow-up"
        : "handle");
  return { path: origin, projectId: project.id, control: resolvedControl, sourceStageKey, sourceIndex };
}

export function focusTargetAfter(
  outcome: FocusOutcome,
  descriptor: FocusDescriptor,
  model: BoardModel,
  settledStageKey?: StageKey,
): { control: FocusDescriptor["control"]; projectId: string } | { fallback: "stage-heading" | "board" } {
  const railOutcome = descriptor.path === "rail" || outcome === "rail";
  if (railOutcome) return hasProject(model, descriptor.projectId)
    ? { control: "rail-stage", projectId: descriptor.projectId }
    : { fallback: "board" };
  if (outcome === "stale-move-to") return hasProject(model, descriptor.projectId)
    ? { control: "move-to", projectId: descriptor.projectId }
    : { fallback: "board" };
  const control = descriptor.control;
  if (hasProject(model, descriptor.projectId)) return { control, projectId: descriptor.projectId };
  const fallbackStage = outcome === "success" || outcome === "post-success-refetch-failure"
    ? settledStageKey ?? descriptor.sourceStageKey
    : descriptor.sourceStageKey;
  return hasStage(model, fallbackStage) ? { fallback: "stage-heading" } : { fallback: "board" };
}

export type BoardAnnouncementEventType =
  | "start"
  | "over-card"
  | "over-end"
  | "valid-drop"
  | "dnd-cancel"
  | "drop-outside"
  | "unchanged-gap"
  | "invalid-keyboard-target"
  | "stale-move-to"
  | "confirmation-required"
  | "modal-cancel"
  | "cross-stage-success"
  | "same-stage-success"
  | "no-change"
  | "post-success-refetch-failure"
  | "conflict"
  | "contract-off"
  | "maintenance";

type AnnouncementValues = Partial<Pick<BoardAnnouncementContext, "street" | "stageLabel" | "sourceStageLabel" | "position" | "count">>
  & { reasons?: StageMoveConfirmationReason[] };

export type BoardAnnouncementEvent = {
  [EventType in BoardAnnouncementEventType]: { type: EventType } & AnnouncementValues
}[BoardAnnouncementEventType];

export type BoardAnnouncementContext = {
  terminal: boolean;
  street?: string;
  stageLabel?: string;
  sourceStageLabel?: string;
  position?: number;
  count?: number;
};

function announcementValue(event: BoardAnnouncementEvent, ctx: BoardAnnouncementContext): Required<Pick<BoardAnnouncementContext, "street" | "stageLabel" | "sourceStageLabel" | "position" | "count">> {
  return {
    street: ctx.street ?? event.street ?? "",
    stageLabel: ctx.stageLabel ?? event.stageLabel ?? "",
    sourceStageLabel: ctx.sourceStageLabel ?? event.sourceStageLabel ?? "",
    position: ctx.position ?? event.position ?? 0,
    count: ctx.count ?? event.count ?? 0,
  };
}

/** Builds all Quincy copy, and suppresses it entirely after a terminal/purge transition. */
export function announce(event: BoardAnnouncementEvent, ctx: BoardAnnouncementContext): string | undefined {
  if (ctx.terminal) return undefined;
  const { street, stageLabel, sourceStageLabel, position, count } = announcementValue(event, ctx);
  switch (event.type) {
    case "start": return `Picked up ${street}. Current Stage: ${stageLabel}. Position ${position} of ${count}.`;
    case "over-card": return `${street} is over ${stageLabel}, position ${position} of ${count}.`;
    case "over-end": return `${street} is over the end of ${stageLabel}, position ${position} of ${count}.`;
    case "valid-drop": return `Dropped ${street} in ${stageLabel}, position ${position} of ${count}. Saving.`;
    case "dnd-cancel":
    case "drop-outside":
    case "unchanged-gap":
    case "invalid-keyboard-target": return `Cancelled moving ${street}. It remains in ${sourceStageLabel}.`;
    case "stale-move-to": return "That position changed. Reloading the latest Board; no move was made.";
    case "confirmation-required": return `Move needs confirmation. ${street} remains in ${sourceStageLabel}.`;
    case "modal-cancel": return `Stage move cancelled. ${street} remains in ${sourceStageLabel}.`;
    case "cross-stage-success": return `Moved ${street} to ${stageLabel}, position ${position} of ${count}.`;
    case "same-stage-success": return `Reordered ${street} in ${stageLabel}, position ${position} of ${count}.`;
    case "no-change": return `${street} is already in ${stageLabel}, position ${position} of ${count}.`;
    case "post-success-refetch-failure": return "The move was saved, but the latest Board could not be loaded. Refresh to continue.";
    case "conflict": return "Could not move "
      + `${street} because the Board changed elsewhere. Reloading the latest Board; no retry was made.`;
    case "contract-off": return "Board interactions are temporarily unavailable while the Board contract is disabled.";
    case "maintenance": return "Board interactions are temporarily unavailable while the Board is being updated.";
  }
}

export function semanticGapChanged(previous: SemanticGap | null | undefined, next: SemanticGap): boolean {
  return previous?.targetStageKey !== next.targetStageKey || previous.successor !== next.successor;
}

export const shouldAnnounceSemanticGap = semanticGapChanged;

/**
 * Quincy Guarded Direct Manipulation Policy is deliberately engine-neutral. TB5C consumes this
 * policy, not this module's helpers or any drag engine.
 */
export const QuincyGuardedDirectManipulationPolicy = [
  "explicit source capability and authorized projection",
  "immutable interaction-start snapshot plus optimistic proposal",
  "guarded authoritative domain mutation using the source's concurrency token",
  "stale rollback to authoritative state with no automatic retry",
  "defer/reconcile incoming refresh while manipulation/confirmation/mutation is active, with access-loss purge taking precedence",
  "keyboard manipulation and a complete non-drag action",
  "deterministic focus restoration and start/proposal/drop/cancel/conflict announcements",
  "confirmation-gated optimism — never render an optimistic proposal before a required confirmation resolves; if the server demands confirmation, roll the proposal back synchronously before the modal opens; never send client-classified reasons",
] as const;

export type QuincyGuardedDirectManipulationPolicy = typeof QuincyGuardedDirectManipulationPolicy;
