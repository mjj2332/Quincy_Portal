import {
  AutoScrollActivator,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
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
import { PointerSensor } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { isDeadlineOverdue, formatSydneyCivil, type StageKey } from "@quincy/shared";
import { useMemo, useRef, useState, type CSSProperties, type RefCallback } from "react";
import { StatusBadge } from "./atoms";
import { InternalLink } from "./InternalLink";
import { LazyImage } from "./LazyImage";
import {
  announce,
  eligibleTarget,
  focusDescriptorFor,
  proposeMultiContainerDrop,
  semanticGapChanged,
  sortKanbanProjects,
  type BoardDragStartSnapshot,
  type BoardInteractionOrigin,
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

export type KanbanCardProps = {
  project: ProjectSummary;
  canMove: boolean;
  canDragThisCard?: boolean;
  isDragging?: boolean;
  canPrioritize?: boolean;
  canReorder?: boolean;
  movementDisabled?: boolean;
  onPriorityChange?: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition?: (project: ProjectSummary, direction: "up" | "down") => void;
  stageOptions?: readonly PipelineStage[];
  onMoveStage?: (project: ProjectSummary, targetStageKey: ProjectStageKey) => void;
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

/**
 * The card is deliberately presentation-only. Board drag state belongs to the sortable wrapper,
 * and its activator is a sibling button so ordinary anchor behavior remains browser-native.
 */
export function KanbanCard({
  project,
  canMove,
  canDragThisCard = false,
  isDragging = false,
  initialCoverFailed = false,
  canPrioritize = false,
  canReorder = false,
  onPriorityChange,
  onBoardPosition,
  movementDisabled = false,
  stageOptions,
  onMoveStage,
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
  const [moveStageValue, setMoveStageValue] = useState("");
  const moveStageOptions = (stageOptions ?? []).filter((stage) => stage.active);

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
      <label className="sr-only" htmlFor={`move-stage-${project.id}`}>Move {project.street} to Stage</label>
      <select id={`move-stage-${project.id}`} data-focus-key={`move-stage:${project.id}`} aria-label={`Move ${project.street} to Stage`} value={moveStageValue} disabled={movementDisabled} onChange={(event) => {
        const targetStageKey = event.target.value as ProjectStageKey;
        setMoveStageValue("");
        if (targetStageKey && targetStageKey !== project.stageKey) onMoveStage?.(project, targetStageKey);
      }}>
        <option value="">Move Stage…</option>
        {moveStageOptions.map((stage) => <option value={stage.key} key={stage.key}>{stage.label}</option>)}
      </select>
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

function dataForOver(over: Over | { id: UniqueIdentifier; data?: unknown } | null): DroppableData | null {
  return over ? droppableData("data" in over ? over.data : undefined) : null;
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
    const pointerCollisions = pointerCoordinates ? pointerWithin(args) : [];
    const collisions = pointerCollisions.length ? pointerCollisions : pointerCoordinates ? [] : closestCorners(args);
    const stageOrder = new Map(activeStages.map((stage, index) => [semanticStageKey(stage.key), index]));
    const candidateRank = (collision: Collision): [number, number, number, string] => {
      const data = collisionData(collision, eligibleContainers);
      if (!data) return [9, 9, 9, String(collision.id)];
      const stageRank = stageOrder.get(data.stageKey) ?? Number.MAX_SAFE_INTEGER;
      const ids = displayOrders[data.stageKey] ?? [];
      const successorRank = data.kind === "card" ? ids.indexOf(data.projectId) : ids.length;
      return [stageRank, data.kind === "card" ? 0 : 1, successorRank < 0 ? Number.MAX_SAFE_INTEGER : successorRank, String(collision.id)];
    };
    return [...collisions].sort((left, right) => {
      const a = candidateRank(left); const b = candidateRank(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
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
  boardMutationEnabled: boolean;
  movementDisabled?: boolean;
  sameStageReorderEnabled?: boolean;
  pendingMoves: ReadonlySet<string>;
  pendingOrdering: ReadonlySet<string>;
  effectiveKanbanSort: KanbanSortMode;
  onPriorityChange: (project: ProjectSummary, priority: number | null) => void;
  onBoardPosition: (project: ProjectSummary, direction: "up" | "down") => void;
  onMoveStage: (project: ProjectSummary, targetStageKey: ProjectStageKey) => void;
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
  boardMutationEnabled,
  movementDisabled = false,
  sameStageReorderEnabled = false,
  pendingMoves,
  pendingOrdering,
  effectiveKanbanSort,
  onPriorityChange,
  onBoardPosition,
  onMoveStage,
  semanticStageKey: semanticKey,
}: KanbanColumnProps) {
  const displayedIds = displayOrders[semanticKey] ?? [];
  const displayedProjects = displayedIds.map((id) => projects.find((project) => project.id === id)).filter((project): project is ProjectSummary => project !== undefined);
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
                canMove: canMoveStages && !pendingMoves.has(project.id),
                canPrioritize: canPrioritize && projects.some((item) => item.boardMapPresent === true || item.boardRank !== undefined || item.authorizedBoardOrder?.[item.stageKey] !== undefined) && !pendingOrdering.has(project.id),
                canReorder: boardMutationEnabled && sameStageReorderEnabled && !pendingOrdering.has(project.id),
                movementDisabled: movementDisabled || pendingMoves.size > 0 || pendingOrdering.size > 0,
                stageOptions: activeStages,
                onMoveStage,
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
  onMoveStage: (project: ProjectSummary, targetStageKey: ProjectStageKey) => void;
  onInteractionStateChange?: (state: BoardInteractionState) => void;
  onAnnounce?: (message: string | undefined) => void;
};

export function ProjectKanbanBoard({
  projects,
  activeStages,
  canMoveStages,
  canPrioritize,
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
  onInteractionStateChange,
}: ProjectKanbanBoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [proposal, setProposal] = useState<BoardProposal | null>(null);
  const snapshotRef = useRef<DragSnapshot | null>(null);
  const proposalRef = useRef<BoardProposal | null>(null);
  const dndAnnouncementRef = useRef<string | undefined>(undefined);
  const dndOverGapRef = useRef<SemanticGap | null>(null);
  const baseOrders = useMemo(() => visualOrders(projects, activeStages, effectiveKanbanSort), [activeStages, effectiveKanbanSort, projects]);
  const displayOrders = proposal?.orders ?? baseOrders;
  const collisionDetection = useMemo(() => BoardCollisionDetection({
    activeStages,
    displayOrders,
    canMoveStages,
    sameStageReorderEnabled,
    activeProjectId,
  }), [activeProjectId, activeStages, canMoveStages, displayOrders, sameStageReorderEnabled]);
  const movingProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) : undefined;

  const announceFor = (event: "start" | "over-card" | "over-end" | "valid-drop" | "dnd-cancel", gap?: SemanticGap) => {
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
    if (event === "dnd-cancel" || !selectedGap) return announce({ type: "dnd-cancel", street: project.street, sourceStageLabel }, { terminal });
    const destination = stageLabel(activeStages, selectedGap.targetStageKey);
    const position = displayPosition(orders, selectedGap, project.id);
    if (event === "over-card") return announce({ type: "over-card", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
    if (event === "over-end") return announce({ type: "over-end", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
    return announce({ type: "valid-drop", street: project.street, stageLabel: destination, sourceStageLabel, position: position.position, count: position.count }, { terminal });
  };

  const handleDndStart = (event: DragStartEvent) => {
    const id = activeId(event.active);
    const project = projects.find((item) => item.id === id);
    if (!project || movementDisabled || !boardMutationEnabled || (!canMoveStages && !sameStageReorderEnabled) || pendingMoves.has(id) || pendingOrdering.has(id)) return;
    const currentModel = canonicalBoardModel(projects);
    const focusDescriptor = focusDescriptorFor("pointer" satisfies BoardInteractionOrigin, project, currentModel, "handle");
    const snapshot: DragSnapshot = {
      model: currentModel,
      movingProjectId: id,
      sort: effectiveKanbanSort,
      displayOrderByStage: baseOrders,
      focusDescriptor,
      sourceScrollLeft: document.querySelector<HTMLElement>(".kanban")?.scrollLeft ?? 0,
      sourceScrollTop: document.querySelector<HTMLElement>(".kanban")?.scrollTop ?? 0,
    };
    snapshotRef.current = snapshot;
    proposalRef.current = null;
    dndOverGapRef.current = null;
    setActiveProjectId(id);
    setProposal(null);
    onInteractionStateChange?.({ activeId: id, proposal: null });
    const message = announceFor("start");
    dndAnnouncementRef.current = message;
  };

  const handleDndOver = (event: DragOverEvent) => {
    const snapshot = snapshotRef.current;
    const hovered = dataForOver(event.over);
    if (!snapshot || !hovered) {
      proposalRef.current = null;
      setProposal(null);
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

  const clearDragState = () => {
    snapshotRef.current = null;
    proposalRef.current = null;
    dndOverGapRef.current = null;
    setActiveProjectId(undefined);
    setProposal(null);
    onInteractionStateChange?.({ activeId: undefined, proposal: null });
  };

  const handleDndEnd = (event: DragEndEvent) => {
    const snapshot = snapshotRef.current;
    const id = activeId(event.active);
    const hovered = dataForOver(event.over);
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
    const message = valid ? announceFor("valid-drop", frozenGap!) : announceFor("dnd-cancel");
    dndAnnouncementRef.current = message;
    if (valid && snapshot && frozenGap && mover) {
      const kind = sourceStage === frozenGap.targetStageKey ? "same" : "cross";
      if (onBoardMove) onBoardMove(id, frozenGap, kind, snapshot.focusDescriptor);
      else if (kind === "cross") onCrossStageMove?.(id, frozenGap, snapshot.focusDescriptor);
    } else if (snapshot) {
      focusHandle(snapshot.focusDescriptor.projectId);
      restoreBoardScroll(snapshot);
    }
    clearDragState();
  };

  const handleDndCancel = (_event: DragCancelEvent) => {
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
      onDragStart: ({ active }) => terminal ? undefined : dndAnnouncementRef.current ?? (snapshotRef.current && activeId(active) === snapshotRef.current.movingProjectId ? announceFor("start") : undefined),
      onDragOver: ({ over }) => {
        if (terminal) return undefined;
        const gap = proposalRef.current?.gap;
        if (!gap || !semanticGapChanged(dndOverGapRef.current, gap)) return undefined;
        const data = dataForOver(over);
        dndOverGapRef.current = gap;
        return announceFor(data?.kind === "column" ? "over-end" : "over-card", gap);
      },
      onDragEnd: ({ over }) => terminal ? undefined : dndAnnouncementRef.current ?? (over ? announceFor("valid-drop", proposalRef.current?.gap) : announceFor("dnd-cancel")),
      onDragCancel: () => terminal ? undefined : dndAnnouncementRef.current ?? announceFor("dnd-cancel"),
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
          boardMutationEnabled={boardMutationEnabled}
          movementDisabled={movementDisabled}
          sameStageReorderEnabled={sameStageReorderEnabled}
          pendingMoves={pendingMoves}
          pendingOrdering={pendingOrdering}
          effectiveKanbanSort={effectiveKanbanSort}
          onPriorityChange={onPriorityChange}
          onBoardPosition={onBoardPosition}
          onMoveStage={onMoveStage}
          semanticStageKey={semanticStageKey(stage.key)}
        />;
      })}
    </div>
    <DragOverlay className="kanban-overlay" dropAnimation={typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? null : { duration: 180, easing: "ease-out" }}>
      {movingProject ? <KanbanCardPreview project={movingProject} /> : null}
    </DragOverlay>
  </DndContext>;
}
