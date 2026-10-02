import {
  STAGE_KEYS,
  compareBoardCards,
  parseStageTransportKey,
  stageMoveConfirmationReasons,
  stageTransportKeyForRole,
  type MoveProjectStageRequest,
  type MoveProjectStageResponse,
  type Role,
  type StageKey,
  type StageMoveConfirmationReason,
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
  /**
   * #428: when the Project was archived (an ISO instant), or `null`/absent for an active one. Only
   * an Admin viewing Archived: Include or Only ever receives a non-null value. An archived card is
   * shown but never moved, reordered or re-prioritised.
   */
  archivedAt?: string | null;
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

export type DroppableData =
  | { kind: "card"; stageKey: StageKey; projectId: string }
  | { kind: "column"; stageKey: StageKey };

/**
 * Where a card WILL land in a Stage column (#470): the card it sorts before, or `"end"`. Derived
 * from the fixed Board order for the indicator and the narration; it is never sent to the server.
 */
export type SemanticGap = { targetStageKey: StageKey; successor: string | "end" };

export type BoardInteractionOrigin = "pointer" | "touch" | "keyboard" | "move-to" | "rail";

export type FocusDescriptor = {
  path: BoardInteractionOrigin;
  projectId: string;
  control: "handle" | "move-to" | "rail-stage";
  sourceStageKey: StageKey;
  sourceIndex: number;
};

/** The accepted Board snapshot. Optional metadata is pure model state, never query-cache state. */
export type BoardModel = {
  projects: ProjectSummary[];
  provisionalSourceStageKey?: StageKey;
};

export type MovementBaseline = BoardModel;

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
  /**
   * The principal holds a movement capability (Stage moves or Priority), whether or not movement is
   * switched on right now. Keeps the card's ⋯ menu visible but disabled through a search, a settling
   * refresh or a 503, instead of letting it vanish (#432).
   */
  menuCapable?: boolean;
  pendingMoves: ReadonlySet<string>;
  pendingOrdering: ReadonlySet<string>;
  terminal: boolean;
  /** A drop into another column (#470). A same-column drop never reaches this: the Board refuses it. */
  onBoardMove?: (projectId: string, targetStageKey: StageKey, focusDescriptor: FocusDescriptor) => void;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  /** Move to ▸ a Stage, from the card's menu. Always an append; the Board sorts it into place. */
  onMoveStage: (project: ProjectSummary, targetStageKey: StageKey, focusDescriptor: FocusDescriptor) => void;
  onInteractionStateChange?: (state: BoardInteractionState) => void;
  onAnnounce?: (message: string | undefined) => void;
  projectHrefFor?: (project: ProjectSummary) => string | undefined;
  /** The clock "overdue" is judged against (the Dashboard's `useNow`); the Board falls back to the wall clock. */
  now?: number;
  /** Canonical keys of the Stage columns collapsed to a rail (#432); per viewer, owned by the Dashboard. */
  collapsedStageKeys?: readonly StageKey[];
  onToggleStageCollapsed?: (stageKey: StageKey) => void;
};

type CanonicalStageKey = StageKey;

function canonicalStageKey(value: string): CanonicalStageKey | null {
  if (value === "editing") return "editing_autohdr";
  return (STAGE_KEYS as readonly string[]).includes(value) ? value as StageKey : null;
}

function projectStageKey(project: ProjectSummary): CanonicalStageKey | null {
  return canonicalStageKey(project.stageKey);
}

/**
 * The one Board column order (#470): priority 5 down to 1 then unset, then the oldest Shoot date
 * (missing or invalid last), then street and id. The server builds its authorised map with the same
 * comparator (`compareBoardCards`), so a fetched Board and a locally re-sorted one agree.
 *
 * Priority is always "visible" here: an External Editor's summaries carry `priority: null` for every
 * card, so the tier is simply flat for them, exactly as the server's priority-free map for that role.
 */
export function sortKanbanProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((left, right) => compareBoardCards(left, right, { priorityVisible: true }));
}

/**
 * Where `projectId` would land in `targetStageKey`: its sorted position among that column's cards
 * once it is there. `position` / `count` are 1-based and include the mover.
 */
export function boardLandingSlot(
  projects: ProjectSummary[],
  projectId: string,
  targetStageKey: StageKey | "editing",
): { gap: SemanticGap; position: number; count: number } | null {
  const target = canonicalStageKey(targetStageKey);
  const mover = projects.find((project) => project.id === projectId);
  if (!target || !mover) return null;
  const column = sortKanbanProjects([
    ...projects.filter((project) => project.id !== projectId && projectStageKey(project) === target),
    mover,
  ]);
  const index = column.findIndex((project) => project.id === projectId);
  return {
    gap: { targetStageKey: target, successor: column[index + 1]?.id ?? "end" },
    position: index + 1,
    count: column.length,
  };
}

/**
 * The request for a Stage move: always an append (#470). The Board is sorted by data, so a move
 * names a Stage and nothing else; the server accepts any placement but plans an append regardless.
 */
export function buildMoveRequest(
  model: BoardModel,
  movingProjectId: string,
  targetStageKey: StageKey,
  role: Role,
): MoveProjectStageRequest | { stale: true } {
  const moving = model.projects.find((project) => project.id === movingProjectId);
  if (!moving) return { stale: true };
  return {
    expected: {
      stageKey: moving.stageKey as StageTransportKey,
      boardRevision: moving.boardRevision,
    },
    targetStageKey: stageTransportKeyForRole(targetStageKey, role),
    placement: { kind: "append" },
  };
}

export type EligibleTargetCapabilities = {
  canMoveProjectStage: boolean;
  activeStageKeys: readonly StageKey[];
};

/** A move is eligible only into a DIFFERENT, active Stage: a Stage column's order is not the user's to change. */
export function eligibleTarget(
  targetStageKey: StageKey,
  model: BoardModel,
  movingProjectId: string,
  caps: EligibleTargetCapabilities,
): boolean {
  const mover = model.projects.find((project) => project.id === movingProjectId);
  const targetStage = canonicalStageKey(targetStageKey);
  if (!mover || !targetStage || !caps.activeStageKeys.some((key) => canonicalStageKey(key) === targetStage)) return false;
  const sourceStage = projectStageKey(mover);
  if (!sourceStage || sourceStage === targetStage) return false;
  return caps.canMoveProjectStage;
}

/**
 * Optimistic overlay: only the mover's Stage changes (#470). The card renders at its sorted slot in
 * the target column, which is where the server will put it; no position is invented. The caller
 * retains `baseline`; this never changes the input and leaves every boardRevision untouched.
 */
export function applyOptimisticOverlay(
  baseline: MovementBaseline,
  movingProjectId: string,
  targetStageKey: StageKey,
  role: Role,
): BoardModel {
  const moving = baseline.projects.find((project) => project.id === movingProjectId);
  if (!moving || !projectStageKey(moving)) return rollbackToBaseline(baseline);
  const roleSafeStage: ProjectSummary["stageKey"] = stageTransportKeyForRole(targetStageKey, role);
  return {
    ...rollbackToBaseline(baseline),
    projects: baseline.projects.map((project) => project.id === movingProjectId ? { ...project, stageKey: roleSafeStage } : { ...project }),
    provisionalSourceStageKey: undefined,
  };
}

export function reconcileAuthoritativeResponse(
  baseline: MovementBaseline,
  movingProjectId: string,
  response: MoveProjectStageResponse,
): { model: BoardModel; sourceProvisional: boolean } {
  const moving = baseline.projects.find((project) => project.id === movingProjectId);
  if (!moving || response.project.projectId !== movingProjectId) return { model: rollbackToBaseline(baseline), sourceProvisional: false };
  const sourceStage = canonicalStageKey(response.board.sourceStageKey) ?? projectStageKey(moving);
  const targetStage = canonicalStageKey(response.board.targetStageKey);
  if (!sourceStage || !targetStage) return { model: rollbackToBaseline(baseline), sourceProvisional: false };
  const sourceProvisional = sourceStage !== targetStage;
  const responseStage = response.project.stageKey;
  const nextProjects = baseline.projects.map((project) => project.id === movingProjectId
    ? { ...project, stageKey: responseStage, boardRevision: response.project.boardRevision }
    : { ...project });
  // The column order is derived from the data (`sortKanbanProjects`) at render; the response's deprecated
  // `orderedVisibleProjectIds` is never read (#475).
  const model: BoardModel = {
    ...baseline,
    projects: nextProjects,
    provisionalSourceStageKey: sourceProvisional ? sourceStage : undefined,
  };
  return { model, sourceProvisional };
}

export function rollbackToBaseline(baseline: MovementBaseline): BoardModel {
  return { ...baseline, projects: baseline.projects.map((project) => ({ ...project })) };
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
): boolean {
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
  const sourceIndex = sortKanbanProjects(model.projects.filter((candidate) => projectStageKey(candidate) === sourceStageKey))
    .findIndex((candidate) => candidate.id === project.id);
  const resolvedControl = control ?? (origin === "move-to"
    ? "move-to"
    : origin === "rail"
      ? "rail-stage"
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
  | "over-stage"
  | "valid-drop"
  | "dnd-cancel"
  | "drop-outside"
  | "same-stage-refused"
  | "invalid-keyboard-target"
  | "stale-move-to"
  | "confirmation-required"
  | "modal-cancel"
  | "cross-stage-success"
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
    case "over-stage": return `${street} is over ${stageLabel}; it will land at position ${position} of ${count}.`;
    case "valid-drop": return `Dropped ${street} in ${stageLabel}, position ${position} of ${count}. Saving.`;
    case "dnd-cancel":
    case "drop-outside":
    case "invalid-keyboard-target": return `Cancelled moving ${street}. It remains in ${sourceStageLabel}.`;
    case "same-stage-refused": return `${street} stays in ${sourceStageLabel}. Columns are sorted by priority and shoot date.`;
    case "stale-move-to": return "That position changed. Reloading the latest Board; no move was made.";
    case "confirmation-required": return `Move needs confirmation. ${street} remains in ${sourceStageLabel}.`;
    case "modal-cancel": return `Stage move cancelled. ${street} remains in ${sourceStageLabel}.`;
    case "cross-stage-success": return `Moved ${street} to ${stageLabel}, position ${position} of ${count}.`;
    case "no-change": return `${street} is already in ${stageLabel}, position ${position} of ${count}.`;
    case "post-success-refetch-failure": return "The move was saved, but the latest Board could not be loaded. Refresh to continue.";
    case "conflict": return "Could not move "
      + `${street} because the Board changed elsewhere. Reloading the latest Board; no retry was made.`;
    case "contract-off": return "Board interactions are temporarily unavailable while the Board contract is disabled.";
    case "maintenance": return "Board interactions are temporarily unavailable while the Board is being updated.";
  }
}

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
