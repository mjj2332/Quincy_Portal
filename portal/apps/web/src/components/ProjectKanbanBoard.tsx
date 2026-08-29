import {
  AutoScrollActivator,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Collision,
  type CollisionDetection,
  type DataRef,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DroppableContainer,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type Announcements,
  type Over,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { isDeadlineOverdue, formatSydneyCivil, type Role, type StageKey } from "@quincy/shared";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefCallback } from "react";
import { AnchoredPopover, useAnchoredPopover } from "./AnchoredPopover";
import { StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { LazyImage } from "./LazyImage";
import {
  announce,
  eligibleTarget,
  focusDescriptorFor,
  moveToPositionOptions,
  proposeMultiContainerDrop,
  semanticGapChanged,
  sortKanbanProjects,
  type BoardDragStartSnapshot,
  type BoardModel,
  type BoardProposal,
  boardGapChangesOrder,
  type DroppableData,
  type FocusDescriptor,
  type ProjectSummary,
  type SemanticGap,
  type KanbanSortMode,
} from "../lib/kanban-interaction";
import type { ProjectStageKey, PipelineStage } from "../lib/stages";

export type BoardInteractionState = {
  activeId: string | undefined;
  proposal: SemanticGap | null;
};

const reducedMotionMediaQuery = "(prefers-reduced-motion: reduce)";

function getPrefersReducedMotionSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(reducedMotionMediaQuery).matches;
}

function subscribeToPrefersReducedMotion(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mediaQuery = window.matchMedia(reducedMotionMediaQuery);
  const onChange = () => onStoreChange();
  if (typeof mediaQuery.addEventListener === "function") mediaQuery.addEventListener("change", onChange);
  else mediaQuery.addListener(onChange);
  return () => {
    if (typeof mediaQuery.removeEventListener === "function") mediaQuery.removeEventListener("change", onChange);
    else mediaQuery.removeListener(onChange);
  };
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeToPrefersReducedMotion, getPrefersReducedMotionSnapshot, () => false);
}

type BoardMoveHandler = (project: ProjectSummary, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) => void;

export type KanbanCardProps = {
  project: ProjectSummary;
  canMove: boolean;
  canMoveStages?: boolean;
  canDragThisCard?: boolean;
  isDragging?: boolean;
  canPrioritize?: boolean;
  canReorder?: boolean;
  movementDisabled?: boolean;
  boardModel?: BoardModel;
  role?: Role;
  effectiveKanbanSort?: KanbanSortMode;
  onPriorityChange?: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition?: (project: ProjectSummary, direction: "up" | "down") => void;
  stageOptions?: readonly PipelineStage[];
  onMoveStage?: BoardMoveHandler;
  onMoveToProposalChange?: (proposal: SemanticGap | null) => void;
  dragHandleAttributes?: DraggableAttributes;
  dragHandleListeners?: DraggableSyntheticListeners;
  setDragHandleRef?: RefCallback<HTMLButtonElement>;
  setCardRef?: RefCallback<HTMLDivElement>;
  cardStyle?: CSSProperties;
  initialCoverFailed?: boolean;
};

function CoverMedia({
  project,
  className = "",
  inlinePlaceholder = false,
  retryToken,
  onFailedChange,
}: {
  project: ProjectSummary;
  className?: string;
  inlinePlaceholder?: boolean;
  retryToken?: number;
  onFailedChange?: (failed: boolean) => void;
}) {
  if (project.coverAssetId) {
    return <LazyImage className={className} preload="background" assetId={project.coverAssetId} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  }
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return inlinePlaceholder
    ? <span className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</span>
    : <div className={`project-cover-placeholder ${className}`} aria-hidden="true">{content}</div>;
}

function location(project: ProjectSummary) {
  return [project.suburb, project.postcode].filter(Boolean).join(" · ") || "Location pending";
}

function deadlineLabel(project: ProjectSummary) {
  return project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt)).replace("T", " ");
}

function moveToStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

function MoveToControl({ project, model, activeStages, role, sort, canMoveStages, canPrioritize, movementDisabled, onMoveStage, onMoveToProposalChange }: {
  project: ProjectSummary;
  model: BoardModel;
  activeStages: readonly PipelineStage[];
  role: Role;
  sort: KanbanSortMode;
  canMoveStages: boolean;
  canPrioritize: boolean;
  movementDisabled: boolean;
  onMoveStage?: BoardMoveHandler;
  onMoveToProposalChange?: (proposal: SemanticGap | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetStageKey, setTargetStageKey] = useState<StageKey | null>(null);
  const [successor, setSuccessor] = useState<string | "end" | null>(null);
  const focusDescriptorRef = useRef<FocusDescriptor | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setTargetStageKey(null);
    setSuccessor(null);
    onMoveToProposalChange?.(null);
    triggerRef.current?.focus();
  }, [onMoveToProposalChange]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-end" });
  const stageLabels = useMemo(() => Object.fromEntries(activeStages.map((stage) => [moveToStageKey(stage.key), stage.label])), [activeStages]);
  const caps = useMemo(() => ({
    canMoveProjectStage: canMoveStages,
    canPrioritize,
    sort,
    activeStageKeys: activeStages.map((stage) => moveToStageKey(stage.key)),
    stageLabels,
  }), [activeStages, canMoveStages, canPrioritize, sort, stageLabels]);
  // Move-to stage and position options transitively carry the same sort-specific interaction
  // identity through `caps.sort`.
  const boardStageOptions = useMemo(() => {
    const seen = new Set<StageKey>();
    return activeStages.filter((stage) => {
      const key = moveToStageKey(stage.key);
      if (seen.has(key)) return false;
      seen.add(key);
      return moveToPositionOptions(model, project.id, key, role, caps).length > 0;
    });
  }, [activeStages, caps, model, project.id, role]);
  const positions = targetStageKey === null ? [] : moveToPositionOptions(model, project.id, targetStageKey, role, caps);
  const targetLabel = targetStageKey === null ? "" : stageLabels[targetStageKey] ?? targetStageKey;
  const dialogId = `move-to-dialog-${project.id}`;

  const openMoveTo = () => {
    focusDescriptorRef.current = focusDescriptorFor("move-to", project, model, "move-to");
    setTargetStageKey(null);
    setSuccessor(null);
    onMoveToProposalChange?.(null);
    setOpen(true);
  };
  const confirmMoveTo = () => {
    if (targetStageKey === null || successor === null) return;
    const descriptor = focusDescriptorRef.current ?? focusDescriptorFor("move-to", project, model, "move-to");
    const kind = moveToStageKey(project.stageKey) === targetStageKey ? "same" : "cross";
    close();
    onMoveStage?.(project, { targetStageKey, successor }, kind, descriptor);
  };

  return <>
    <button
      ref={(node) => { floating.refs.setReference(node); triggerRef.current = node; }}
      type="button"
      className="kcard-move-to"
      data-focus-key={`move-to:${project.id}`}
      aria-label={`Move ${project.street} to…`}
      aria-expanded={open}
      aria-controls={open ? dialogId : undefined}
      disabled={movementDisabled || boardStageOptions.length === 0}
      onKeyDown={floating.onKeyDown}
      onClick={openMoveTo}
    >Move to…</button>
    {open && <AnchoredPopover className="kanban-move-popover" context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} modal onKeyDown={floating.onKeyDown}>
      <div id={dialogId} className="kanban-move-popover__content" role="dialog" aria-label={`Move ${project.street} to…`} data-step={targetStageKey === null ? "stage" : "position"}>
        <div className="ey">{targetStageKey === null ? "Choose a Stage" : `Choose a position in ${targetLabel}`}</div>
        {targetStageKey === null ? <div className="kanban-move-popover__stages" role="radiogroup" aria-label={`Target Stage for ${project.street}`}>
          {boardStageOptions.map((stage) => {
            const key = moveToStageKey(stage.key);
            return <button key={key} type="button" role="radio" aria-checked={false} className="kanban-move-popover__option" onClick={() => { setTargetStageKey(key); setSuccessor(null); }}>{stage.label}</button>;
          })}
        </div> : <>
          <div className="kanban-move-popover__positions" role="listbox" aria-label={`Position in ${targetLabel}`}>
            {positions.map((option) => <button key={option.successor} type="button" role="option" aria-selected={successor === option.successor} className="kanban-move-popover__option" onClick={() => { setSuccessor(option.successor); onMoveToProposalChange?.({ targetStageKey, successor: option.successor }); }}>{option.label}</button>)}
          </div>
          <div className="kanban-move-popover__actions">
            <button type="button" className="button button--secondary" onClick={() => { setTargetStageKey(null); setSuccessor(null); onMoveToProposalChange?.(null); }}>Back</button>
            <button type="button" className="button button--secondary" onClick={close}>Cancel</button>
            <button type="button" className="button" disabled={successor === null} onClick={confirmMoveTo}>Move project</button>
          </div>
        </>}
      </div>
    </AnchoredPopover>}
  </>;
}

/**
 * The card is deliberately presentation-only. Board drag state belongs to the sortable wrapper,
 * and its activator is a sibling button so ordinary anchor behavior remains browser-native.
 */
export function KanbanCard({
  project,
  canMove,
  canMoveStages = canMove,
  canDragThisCard = false,
  isDragging = false,
  initialCoverFailed = false,
  canPrioritize = false,
  canReorder = false,
  onPriorityChange,
  onBoardPosition,
  movementDisabled = false,
  boardModel,
  role = "admin",
  effectiveKanbanSort = "board",
  stageOptions,
  onMoveStage,
  onMoveToProposalChange,
  dragHandleAttributes,
  dragHandleListeners,
  setDragHandleRef,
  setCardRef,
  cardStyle,
}: KanbanCardProps) {
  const overdue = isDeadlineOverdue(project.deadlineAt);
  const projectDeadlineLabel = deadlineLabel(project);
  const [coverFailed, setCoverFailed] = useState(initialCoverFailed);
  const [coverRetry, setCoverRetry] = useState(0);
  const activeStageOptions = (stageOptions ?? []).filter((stage) => stage.active);
  const moveModel = boardModel ?? { projects: [project], ...(project.authorizedBoardOrder ? { authorizedBoardOrder: project.authorizedBoardOrder } : {}) };

  return <div ref={setCardRef} style={cardStyle} className={`kcard-wrap ${isDragging ? "is-dragging" : ""}`}>
    <InternalLink className="kcard" to={`/projects/${encodeURIComponent(project.id)}`}>
      <div className="kcard__media"><CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} /></div>
      <div className="kcard__b">
        <div className="kcard__addr serif">{project.street}</div>
        <div className="kcard__meta">{location(project)}</div>
        <div className="kcard__meta">{project.agencyName || "Agency pending"}</div>
        <div className="kcard__foot">
          {projectDeadlineLabel && <time className={overdue ? "project-deadline__overdue" : ""} dateTime={new Date(project.deadlineAt!).toISOString()}>{overdue ? "Overdue" : "Due"} {projectDeadlineLabel} Sydney</time>}
          {project.priority !== null && <span className="ey">Priority {project.priority}</span>}
        </div>
      </div>
    </InternalLink>
    <button
      ref={setDragHandleRef}
      type="button"
      className="kcard-drag-handle"
      data-focus-key={`move-handle:${project.id}`}
      aria-label={`Move ${project.street}`}
      disabled={!canDragThisCard}
      {...dragHandleAttributes}
      {...dragHandleListeners}
    >
      <span aria-hidden="true">⠿</span>
    </button>
    {canPrioritize && <div className="kcard-controls" aria-label={`Order controls for ${project.street}`}>
      <label className="sr-only" htmlFor={`priority-${project.id}`}>Priority</label>
      <select id={`priority-${project.id}`} value={project.priority ?? ""} aria-label="Priority" onChange={(event) => onPriorityChange?.(project, event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">—</option>
        {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value}</option>)}
      </select>
      {canReorder && <>
        <button type="button" className="kcard-controls__arrow" data-focus-key={`arrow-up:${project.id}`} aria-label="Move project up" disabled={movementDisabled} onClick={() => onBoardPosition?.(project, "up")}>↑</button>
        <button type="button" className="kcard-controls__arrow" data-focus-key={`arrow-down:${project.id}`} aria-label="Move project down" disabled={movementDisabled} onClick={() => onBoardPosition?.(project, "down")}>↓</button>
      </>}
    </div>}
    {canMove && <div className="kcard-stage-control">
      <MoveToControl project={project} model={moveModel} activeStages={activeStageOptions} role={role} sort={effectiveKanbanSort} canMoveStages={canMoveStages} canPrioritize={canPrioritize} movementDisabled={movementDisabled} onMoveStage={onMoveStage} onMoveToProposalChange={onMoveToProposalChange} />
    </div>}
    {coverFailed && <button className="kcard__retry button button--secondary" type="button" onClick={() => { setCoverFailed(false); setCoverRetry((current) => current + 1); }}>Retry cover image</button>}
  </div>;
}

export function KanbanCardPreview({ project }: { project: ProjectSummary }) {
  const overdue = isDeadlineOverdue(project.deadlineAt);
  const projectDeadlineLabel = deadlineLabel(project);
  return <div className="kanban-card-preview kcard-wrap" aria-hidden="true">
    <div className="kcard__media"><CoverMedia project={project} /></div>
    <div className="kcard__b">
      <div className="kcard__addr serif">{project.street}</div>
      <div className="kcard__meta">{location(project)}</div>
      <div className="kcard__meta">{project.agencyName || "Agency pending"}</div>
      <div className="kcard__foot">
        {projectDeadlineLabel && <time className={overdue ? "project-deadline__overdue" : ""} dateTime={new Date(project.deadlineAt!).toISOString()}>{overdue ? "Overdue" : "Due"} {projectDeadlineLabel} Sydney</time>}
        {project.priority !== null && <span className="ey">Priority {project.priority}</span>}
      </div>
    </div>
  </div>;
}

type SortableKanbanCardProps = Omit<KanbanCardProps, "project" | "isDragging" | "canDragThisCard" | "dragHandleAttributes" | "dragHandleListeners" | "setDragHandleRef" | "setCardRef" | "cardStyle"> & {
  project: ProjectSummary;
  canDragThisCard: boolean;
  isDragging: boolean;
  semanticStageKey: StageKey;
};

function SortableKanbanCard({ project, semanticStageKey, canDragThisCard, isDragging, ...props }: SortableKanbanCardProps) {
  const sortable = useSortable({
    id: project.id,
    data: { kind: "card", stageKey: semanticStageKey, projectId: project.id } satisfies DroppableData,
    disabled: !canDragThisCard,
  });
  const style: CSSProperties = {
    transform: DndCSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return <KanbanCard
    {...props}
    project={project}
    canDragThisCard={canDragThisCard}
    isDragging={isDragging || sortable.isDragging}
    setCardRef={sortable.setNodeRef}
    cardStyle={style}
    dragHandleAttributes={sortable.attributes}
    dragHandleListeners={sortable.listeners}
    setDragHandleRef={sortable.setActivatorNodeRef}
  />;
}

function semanticStageKey(stageKey: ProjectStageKey): StageKey {
  return stageKey === "editing" ? "editing_autohdr" : stageKey;
}

function dataValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("current" in value)) return value;
  return (value as { current?: unknown }).current;
}

function droppableData(value: DataRef | unknown): DroppableData | null {
  const candidate = dataValue(value);
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  if (record.kind === "card" && typeof record.stageKey === "string" && typeof record.projectId === "string") {
    return { kind: "card", stageKey: record.stageKey as StageKey, projectId: record.projectId };
  }
  if (record.kind === "column" && typeof record.stageKey === "string") return { kind: "column", stageKey: record.stageKey as StageKey };
  return null;
}

function activeId(active: Active | { id: UniqueIdentifier; data?: unknown }): string {
  return String(active.id);
}

function dataForActive(active: Active | { id: UniqueIdentifier; data?: unknown }): DroppableData | null {
  return droppableData("data" in active ? active.data : undefined);
}

function dataForOver(over: Over | { id: UniqueIdentifier; data?: unknown } | null, collisions?: Collision[] | null): DroppableData | null {
  if (!over) return null;
  const direct = droppableData("data" in over ? over.data : undefined);
  if (direct) return direct;
  const collision = collisions?.find((candidate) => candidate.id === over.id);
  return collision ? collisionData(collision, []) : null;
}

function cloneOrders(orders: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(orders).map(([stageKey, ids]) => [stageKey, [...ids]]));
}

function canonicalBoardModel(projects: ProjectSummary[]): BoardModel {
  const snapshotProjects = projects.map((project) => ({
    ...project,
    ...(project.authorizedBoardOrder ? { authorizedBoardOrder: cloneOrders(project.authorizedBoardOrder) } : {}),
  }));
  const authorizedBoardOrder = snapshotProjects.find((project) => project.authorizedBoardOrder !== undefined)?.authorizedBoardOrder;
  return authorizedBoardOrder ? { projects: snapshotProjects, authorizedBoardOrder: cloneOrders(authorizedBoardOrder) } : { projects: snapshotProjects };
}

function visualOrders(projects: ProjectSummary[], activeStages: readonly PipelineStage[], sort: KanbanSortMode): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const stage of activeStages) {
    const key = semanticStageKey(stage.key);
    if (result[key]) continue;
    result[key] = sortKanbanProjects(projects.filter((project) => semanticStageKey(project.stageKey) === key), sort).map((project) => project.id);
  }
  return result;
}

function displayPosition(orders: Record<string, string[]>, gap: SemanticGap, movingProjectId: string): { position: number; count: number } {
  const ids = orders[gap.targetStageKey] ?? [];
  const index = ids.indexOf(movingProjectId);
  return { position: index < 0 ? ids.length : index + 1, count: ids.length };
}

function stageLabel(activeStages: readonly PipelineStage[], key: StageKey): string {
  return activeStages.find((stage) => semanticStageKey(stage.key) === key)?.label ?? key;
}

function collisionData(collision: Collision, droppableContainers: DroppableContainer[]): DroppableData | null {
  const container = collision.data?.droppableContainer ?? droppableContainers.find((candidate) => candidate.id === collision.id);
  return container ? droppableData(container.data) : null;
}

function BoardCollisionDetection({ activeStages, displayOrders, canMoveStages, sameStageReorderEnabled, activeProjectId }: {
  activeStages: readonly PipelineStage[];
  displayOrders: Record<string, string[]>;
  canMoveStages: boolean;
  sameStageReorderEnabled: boolean;
  activeProjectId: string | undefined;
}): CollisionDetection {
  const collisionTieEpsilon = 1;
  return ({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates }) => {
    const activeData = dataForActive(active);
    const sourceStage = activeData?.kind === "card" ? activeData.stageKey : undefined;
    const eligibleContainers = droppableContainers.filter((container) => {
      const data = droppableData(container.data);
      if (!data) return false;
      if (data.kind === "card" && data.projectId === activeProjectId) return false;
      if (sourceStage === data.stageKey) return sameStageReorderEnabled;
      return canMoveStages;
    });
    const args = { active, collisionRect, droppableRects, droppableContainers: eligibleContainers, pointerCoordinates };
    const stageOrder = new Map(activeStages.map((stage, index) => [semanticStageKey(stage.key), index]));
    const candidateRank = (collision: Collision): [number, number, number, string] => {
      const data = collisionData(collision, eligibleContainers);
      if (!data) return [9, 9, 9, String(collision.id)];
      const stageRank = stageOrder.get(data.stageKey) ?? Number.MAX_SAFE_INTEGER;
      const ids = displayOrders[data.stageKey] ?? [];
      const successorRank = data.kind === "card" ? ids.indexOf(data.projectId) : ids.length;
      return [stageRank, data.kind === "card" ? 0 : 1, successorRank < 0 ? Number.MAX_SAFE_INTEGER : successorRank, String(collision.id)];
    };
    const sortByCandidateRank = (left: Collision, right: Collision) => {
      const a = candidateRank(left); const b = candidateRank(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
    };
    if (pointerCoordinates !== null) {
      const pointerCollisions = pointerWithin(args);
      return pointerCollisions.length ? [...pointerCollisions].sort(sortByCandidateRank) : [];
    }
    const collisions = closestCorners(args);
    return [...collisions].sort((left, right) => {
      const leftValue = typeof left.data?.value === "number" ? left.data.value : null;
      const rightValue = typeof right.data?.value === "number" ? right.data.value : null;
      if (leftValue !== null && rightValue !== null && Math.abs(leftValue - rightValue) > collisionTieEpsilon) return leftValue - rightValue;
      if (leftValue !== null && rightValue === null) return -1;
      if (leftValue === null && rightValue !== null) return 1;
      return sortByCandidateRank(left, right);
    });
  };
}

type DragSnapshot = BoardDragStartSnapshot & {
  focusDescriptor: FocusDescriptor;
  sourceScrollLeft: number;
  sourceScrollTop: number;
};

function focusHandle(projectId: string) {
  const focusKey = `move-handle:${projectId}`;
  const target = [...document.querySelectorAll<HTMLButtonElement>("button[data-focus-key]")].find((button) => button.getAttribute("data-focus-key") === focusKey);
  target?.focus();
}

function restoreBoardScroll(snapshot: DragSnapshot) {
  const board = document.querySelector<HTMLElement>(".kanban");
  if (!board) return;
  board.scrollLeft = snapshot.sourceScrollLeft;
  board.scrollTop = snapshot.sourceScrollTop;
}

type KanbanColumnProps = {
  stage: PipelineStage;
  activeStages: readonly PipelineStage[];
  displayOrders: Record<string, string[]>;
  projects: ProjectSummary[];
  activeProjectId: string | undefined;
  proposal: BoardProposal | null;
  canMoveStages: boolean;
  canPrioritize: boolean;
  role: Role;
  boardModel: BoardModel;
  boardMutationEnabled: boolean;
  movementDisabled?: boolean;
  sameStageReorderEnabled?: boolean;
  pendingMoves: ReadonlySet<string>;
  pendingOrdering: ReadonlySet<string>;
  effectiveKanbanSort: KanbanSortMode;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition: (project: ProjectSummary, direction: "up" | "down") => void;
  onMoveStage: BoardMoveHandler;
  onMoveToProposalChange: (proposal: SemanticGap | null) => void;
  semanticStageKey: StageKey;
};

function KanbanColumn({
  stage,
  activeStages,
  displayOrders,
  projects,
  activeProjectId,
  proposal,
  canMoveStages,
  canPrioritize,
  role,
  boardModel,
  boardMutationEnabled,
  movementDisabled = false,
  sameStageReorderEnabled = false,
  pendingMoves,
  pendingOrdering,
  effectiveKanbanSort,
  onPriorityChange,
  onBoardPosition,
  onMoveStage,
  onMoveToProposalChange,
  semanticStageKey: semanticKey,
}: KanbanColumnProps) {
  const displayedIds = displayOrders[semanticKey] ?? [];
  const displayedProjects = displayedIds.map((id) => projects.find((project) => project.id === id)).filter((project): project is ProjectSummary => project !== undefined);
  const moveToModel = useMemo(() => ({ ...boardModel, authorizedBoardOrder: cloneOrders(displayOrders) }), [boardModel, displayOrders]);
  const { setNodeRef: setColumnBodyRef, isOver } = useDroppable({ id: `column:${stage.key}`, data: { kind: "column", stageKey: semanticKey } satisfies DroppableData });
  const indicatorAfter = proposal?.gap.targetStageKey === semanticKey && proposal.gap.successor === "end";
  const stageIsOver = activeProjectId !== undefined && (isOver || proposal?.gap.targetStageKey === semanticKey);

  return <section className={`kcol ${stageIsOver ? "is-over" : ""}`}>
    <div className="kcol__head" data-focus-key={`stage-heading:${semanticKey}`} tabIndex={-1}><span className="row gap2"><StatusBadge stageKey={stage.key} /></span><span className="cnt">{displayedProjects.length}</span></div>
    <SortableContext items={displayedIds} strategy={verticalListSortingStrategy}>
      <div ref={setColumnBodyRef} className="kcol__body" data-droppable-id={`column:${stage.key}`}>
        {displayedProjects.length === 0 && <div className="kcol__empty">—</div>}
        {displayedProjects.map((project) => {
          const isDropBefore = proposal?.gap.targetStageKey === semanticKey && proposal.gap.successor === project.id;
          const displayProject = proposal?.gap.targetStageKey === semanticKey && project.id === activeProjectId ? { ...project, stageKey: stage.key } : project;
          const movementPending = pendingMoves.has(project.id) || pendingOrdering.has(project.id);
          return <div key={project.id}>
            {isDropBefore && <div className="kcard-wrap--drop-indicator" aria-hidden="true" />}
            <SortableKanbanCard
              {...{
                canMove: (canMoveStages || sameStageReorderEnabled) && !pendingMoves.has(project.id),
                canMoveStages,
                canPrioritize: canPrioritize && projects.some((item) => item.boardMapPresent === true || item.boardRank !== undefined || item.authorizedBoardOrder?.[item.stageKey] !== undefined) && !pendingOrdering.has(project.id),
                canReorder: boardMutationEnabled && sameStageReorderEnabled && !pendingOrdering.has(project.id),
                movementDisabled: movementDisabled || pendingMoves.size > 0 || pendingOrdering.size > 0,
                stageOptions: activeStages,
                boardModel: moveToModel,
                role,
                effectiveKanbanSort,
                onMoveStage,
                onMoveToProposalChange,
                onPriorityChange,
                onBoardPosition,
              }}
              project={displayProject}
              semanticStageKey={semanticKey}
              canDragThisCard={!movementDisabled && !pendingMoves.size && !pendingOrdering.size && boardMutationEnabled && (canMoveStages || sameStageReorderEnabled) && !movementPending}
              isDragging={activeProjectId === project.id}
            />
          </div>;
        })}
        {indicatorAfter && <div className="kcard-wrap--drop-indicator" aria-hidden="true" />}
      </div>
    </SortableContext>
  </section>;
}

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
  onMoveStage: BoardMoveHandler;
  onMoveToProposalChange?: (proposal: SemanticGap | null) => void;
  onInteractionStateChange?: (state: BoardInteractionState) => void;
  onAnnounce?: (message: string | undefined) => void;
};

export function ProjectKanbanBoard({
  projects,
  activeStages,
  canMoveStages,
  canPrioritize,
  role = "admin",
  boardMutationEnabled,
  movementDisabled = false,
  sameStageReorderEnabled = false,
  effectiveKanbanSort,
  pendingMoves,
  pendingOrdering,
  terminal,
  onBoardMove,
  onCrossStageMove,
  onBoardPosition,
  onPriorityChange,
  onMoveStage,
  onMoveToProposalChange,
  onInteractionStateChange,
  onAnnounce,
}: ProjectKanbanBoardProps) {
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // A press-and-hold on the handle starts a touch drag; quick touches elsewhere remain scrolling/flinging.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [proposal, setProposal] = useState<BoardProposal | null>(null);
  const snapshotRef = useRef<DragSnapshot | null>(null);
  const proposalRef = useRef<BoardProposal | null>(null);
  const dndAnnouncementRef = useRef<string | undefined>(undefined);
  const dndDropSuppressedRef = useRef(false);
  const dndOverGapRef = useRef<SemanticGap | null>(null);
  const interactionTerminalRef = useRef(false);
  // Derived interaction identity per the Option-A ruling: the network key stays authorization
  // scoped, while display arrays and every dnd consumer rebuild for the effective sort.
  const baseOrders = useMemo(() => visualOrders(projects, activeStages, effectiveKanbanSort), [activeStages, effectiveKanbanSort, projects]);
  const boardModel = useMemo(() => canonicalBoardModel(projects), [projects]);
  const displayOrders = proposal?.orders ?? baseOrders;
  const collisionDetection = useMemo(() => BoardCollisionDetection({
    activeStages,
    displayOrders,
    canMoveStages,
    sameStageReorderEnabled,
    activeProjectId,
  }), [activeProjectId, activeStages, canMoveStages, displayOrders, sameStageReorderEnabled]);
  const movingProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) : undefined;

  const clearDragState = useCallback((clearAnnouncement = false) => {
    snapshotRef.current = null;
    proposalRef.current = null;
    dndOverGapRef.current = null;
    dndDropSuppressedRef.current = clearAnnouncement;
    if (clearAnnouncement) dndAnnouncementRef.current = undefined;
    setActiveProjectId(undefined);
    setProposal(null);
    onInteractionStateChange?.({ activeId: undefined, proposal: null });
  }, [onInteractionStateChange]);

  useLayoutEffect(() => {
    if (!terminal || interactionTerminalRef.current) return;
    interactionTerminalRef.current = true;
    clearDragState(true);
  }, [clearDragState, terminal]);

  const announceFor = (event: "start" | "over-card" | "over-end" | "valid-drop" | "dnd-cancel" | "drop-outside" | "unchanged-gap" | "invalid-keyboard-target", gap?: SemanticGap) => {
    if (interactionTerminalRef.current || terminal) return undefined;
    const snapshot = snapshotRef.current;
    const project = snapshot?.model.projects.find((item) => item.id === snapshot.movingProjectId);
    if (!snapshot || !project) return undefined;
    const sourceStage = semanticStageKey(project.stageKey);
    const selectedGap = gap ?? proposalRef.current?.gap;
    const orders = proposalRef.current?.orders ?? snapshot.displayOrderByStage ?? {};
    const sourceStageLabel = stageLabel(activeStages, sourceStage);
    if (event === "start") {
      const sourceOrder = orders[sourceStage] ?? [];
      return announce({ type: "start", street: project.street, stageLabel: sourceStageLabel, sourceStageLabel, position: Math.max(1, sourceOrder.indexOf(project.id) + 1), count: sourceOrder.length }, { terminal });
    }
    if (event === "dnd-cancel" || event === "drop-outside" || event === "unchanged-gap" || event === "invalid-keyboard-target" || !selectedGap) {
      return announce({ type: event === "dnd-cancel" || !selectedGap ? "dnd-cancel" : event, street: project.street, sourceStageLabel }, { terminal });
    }
    const destination = stageLabel(activeStages, selectedGap.targetStageKey);
    const position = displayPosition(orders, selectedGap, project.id);
    if (event === "over-card") return announce({ type: "over-card", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
    if (event === "over-end") return announce({ type: "over-end", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
    return announce({ type: "valid-drop", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
  };

  const handleDndStart = (event: DragStartEvent) => {
    const id = activeId(event.active);
    const project = projects.find((item) => item.id === id);
    if (!project || terminal || movementDisabled || !boardMutationEnabled || (!canMoveStages && !sameStageReorderEnabled) || pendingMoves.has(id) || pendingOrdering.has(id)) return;
    // A terminal latch is intentionally cleared only by a new eligible drag. A late dnd-kit
    // callback after a purge can therefore never revive the private snapshot on its own.
    interactionTerminalRef.current = false;
    const currentModel = canonicalBoardModel(projects);
    const keyboardOrigin = event.activatorEvent?.type === "keydown";
    const focusDescriptor = focusDescriptorFor(keyboardOrigin ? "keyboard" : "pointer", project, currentModel, "handle");
    const snapshot: DragSnapshot = {
      model: currentModel,
      movingProjectId: id,
      // The drag-start snapshot is part of the derived interaction identity and must freeze the
      // sort-specific display order used for this interaction.
      sort: effectiveKanbanSort,
      displayOrderByStage: baseOrders,
      focusDescriptor,
      sourceScrollLeft: document.querySelector<HTMLElement>(".kanban")?.scrollLeft ?? 0,
      sourceScrollTop: document.querySelector<HTMLElement>(".kanban")?.scrollTop ?? 0,
    };
    snapshotRef.current = snapshot;
    proposalRef.current = null;
    dndOverGapRef.current = null;
    dndDropSuppressedRef.current = false;
    setActiveProjectId(id);
    setProposal(null);
    onInteractionStateChange?.({ activeId: id, proposal: null });
    const message = announceFor("start");
    dndAnnouncementRef.current = message;
  };

  const handleDndOver = (event: DragOverEvent) => {
    if (interactionTerminalRef.current || terminal) return;
    const snapshot = snapshotRef.current;
    const hovered = dataForOver(event.over, event.collisions);
    if (!snapshot || !hovered) {
      proposalRef.current = null;
      setProposal(null);
      dndOverGapRef.current = null;
      onInteractionStateChange?.({ activeId: activeProjectId, proposal: null });
      return;
    }
    const mover = snapshot.model.projects.find((project) => project.id === snapshot.movingProjectId);
    const sourceStage = mover ? semanticStageKey(mover.stageKey) : null;
    const eligible = sourceStage !== null
      && (sourceStage !== hovered.stageKey ? canMoveStages : sameStageReorderEnabled)
      && eligibleTarget(hovered.kind === "column" ? { targetStageKey: hovered.stageKey, successor: "end" } : { targetStageKey: hovered.stageKey, successor: hovered.projectId }, snapshot.model, snapshot.movingProjectId, {
        canMoveProjectStage: canMoveStages,
        canPrioritize,
        sort: effectiveKanbanSort,
        activeStageKeys: [...new Set(activeStages.map((stage) => semanticStageKey(stage.key)))],
      });
    const next = eligible ? proposeMultiContainerDrop(snapshot, hovered) : null;
    const previousGap = proposalRef.current?.gap;
    proposalRef.current = next;
    setProposal(next);
    onInteractionStateChange?.({ activeId: snapshot.movingProjectId, proposal: next?.gap ?? null });
    if (!next || !semanticGapChanged(previousGap, next.gap)) return;
    const message = announceFor(hovered.kind === "column" ? "over-end" : "over-card", next.gap);
    dndAnnouncementRef.current = message;
  };

  const handleDndEnd = (event: DragEndEvent) => {
    if (interactionTerminalRef.current || terminal) return;
    const snapshot = snapshotRef.current;
    const id = activeId(event.active);
    const hovered = dataForOver(event.over, event.collisions);
    const mover = snapshot?.model.projects.find((project) => project.id === id);
    const sourceStage = mover ? semanticStageKey(mover.stageKey) : null;
    const overGap = hovered ? (hovered.kind === "column" ? { targetStageKey: hovered.stageKey, successor: "end" as const } : { targetStageKey: hovered.stageKey, successor: hovered.projectId }) : null;
    const frozenGap = hovered
      ? proposalRef.current?.gap && overGap && !semanticGapChanged(proposalRef.current.gap, overGap)
        ? proposalRef.current.gap
        : overGap
      : null;
    const valid = Boolean(snapshot && mover && frozenGap && (sourceStage !== frozenGap.targetStageKey ? canMoveStages : sameStageReorderEnabled) && eligibleTarget(frozenGap, snapshot.model, id, {
      canMoveProjectStage: canMoveStages,
      canPrioritize,
      sort: effectiveKanbanSort,
      activeStageKeys: [...new Set(activeStages.map((stage) => semanticStageKey(stage.key)))],
    }) && (sourceStage !== frozenGap.targetStageKey || boardGapChangesOrder(frozenGap, snapshot.model, id)));
    const sameStage = sourceStage !== null && frozenGap?.targetStageKey === sourceStage;
    const invalidKeyboardTarget = Boolean(snapshot && mover && sameStage && !sameStageReorderEnabled && snapshot.focusDescriptor.path === "keyboard");
    const unchangedGap = Boolean(snapshot && valid === false && frozenGap && sameStage && !boardGapChangesOrder(frozenGap, snapshot.model, id));
    const announcementEvent = valid
      ? "valid-drop"
      : invalidKeyboardTarget
        ? "invalid-keyboard-target"
        : unchangedGap
          ? "unchanged-gap"
          : "drop-outside";
    const message = announceFor(announcementEvent, frozenGap ?? undefined);
    dndAnnouncementRef.current = valid ? message : undefined;
    dndDropSuppressedRef.current = !valid;
    if (valid && snapshot && frozenGap && mover) {
      const kind = sourceStage === frozenGap.targetStageKey ? "same" : "cross";
      if (onBoardMove) onBoardMove(id, frozenGap, kind, snapshot.focusDescriptor);
      else if (kind === "cross") onCrossStageMove?.(id, frozenGap, snapshot.focusDescriptor);
    } else if (snapshot) {
      focusHandle(snapshot.focusDescriptor.projectId);
      restoreBoardScroll(snapshot);
      if (!valid) onAnnounce?.(message);
    }
    clearDragState();
  };

  const handleDndCancel = (_event: DragCancelEvent) => {
    if (interactionTerminalRef.current || terminal) return;
    const snapshot = snapshotRef.current;
    const message = announceFor("dnd-cancel");
    dndAnnouncementRef.current = message;
    if (snapshot) {
      focusHandle(snapshot.focusDescriptor.projectId);
      restoreBoardScroll(snapshot);
    }
    clearDragState();
  };

  const accessibility: { restoreFocus: false; announcements: Announcements; screenReaderInstructions: { draggable: string } } = {
    restoreFocus: false,
    announcements: {
      onDragStart: ({ active }) => interactionTerminalRef.current || terminal ? undefined : dndAnnouncementRef.current ?? (snapshotRef.current && activeId(active) === snapshotRef.current.movingProjectId ? announceFor("start") : undefined),
      onDragOver: ({ over }) => {
        if (interactionTerminalRef.current || terminal) return undefined;
        const gap = proposalRef.current?.gap;
        if (!gap || !semanticGapChanged(dndOverGapRef.current, gap)) return undefined;
        const data = dataForOver(over);
        dndOverGapRef.current = gap;
        return announceFor(data?.kind === "column" ? "over-end" : "over-card", gap);
      },
      onDragEnd: ({ over }) => interactionTerminalRef.current || terminal || dndDropSuppressedRef.current ? undefined : dndAnnouncementRef.current ?? (over ? announceFor("valid-drop", proposalRef.current?.gap) : announceFor("dnd-cancel")),
      onDragCancel: () => interactionTerminalRef.current || terminal ? undefined : dndAnnouncementRef.current ?? announceFor("dnd-cancel"),
    },
    screenReaderInstructions: {
      draggable: "To pick up a project, focus its Move project handle and press Space. Use the arrow keys to move within or between Stages. Press Space again to drop, or Escape to cancel. You can also use Move to… without dragging.",
    },
  };
  const dndHandlers = { handleDndStart, handleDndOver, handleDndEnd, handleDndCancel };
  const dndContextProps = {
    sensors,
    collisionDetection,
    accessibility,
    autoScroll: { activator: AutoScrollActivator.Pointer, layoutShiftCompensation: true, threshold: { x: 0.2, y: 0.2 } },
    measuring: { droppable: { strategy: MeasuringStrategy.Always } },
    onDragStart: dndHandlers.handleDndStart,
    onDragOver: dndHandlers.handleDndOver,
    onDragEnd: dndHandlers.handleDndEnd,
    onDragCancel: dndHandlers.handleDndCancel,
  };

  return <DndContext {...dndContextProps}>
    <div className="kanban" data-focus-key="board" tabIndex={-1} aria-label="Project pipeline board">
      {activeStages.map((stage) => {
        return <KanbanColumn
          key={stage.key}
          stage={stage}
          activeStages={activeStages}
          displayOrders={displayOrders}
          projects={projects}
          activeProjectId={activeProjectId}
          proposal={proposal}
          canMoveStages={canMoveStages}
          canPrioritize={canPrioritize}
          role={role}
          boardModel={boardModel}
          boardMutationEnabled={boardMutationEnabled}
          movementDisabled={movementDisabled}
          sameStageReorderEnabled={sameStageReorderEnabled}
          pendingMoves={pendingMoves}
          pendingOrdering={pendingOrdering}
          effectiveKanbanSort={effectiveKanbanSort}
          onPriorityChange={onPriorityChange}
          onBoardPosition={onBoardPosition}
          onMoveStage={onMoveStage}
          onMoveToProposalChange={onMoveToProposalChange ?? (() => undefined)}
          semanticStageKey={semanticStageKey(stage.key)}
        />;
      })}
    </div>
    <DragOverlay className="kanban-overlay" dropAnimation={reducedMotion ? null : { duration: 180, easing: "ease-out" }}>
      {movingProject ? <KanbanCardPreview project={movingProject} /> : null}
    </DragOverlay>
  </DndContext>;
}
