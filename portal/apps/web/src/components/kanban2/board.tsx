import { useCallback, useMemo } from "react";
import type { StageKey } from "@quincy/shared";
import { StatusBadge } from "../atoms";
import { Kanban, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanOverlay, type KanbanMoveEvent } from "../reui/kanban";
import {
  eligibleTarget,
  focusDescriptorFor,
  sortKanbanProjects,
  type ProjectSummary,
  type SemanticGap,
} from "../../lib/kanban-interaction";
import type { ProjectStageKey } from "../../lib/stages";
import type { ProjectKanbanBoardProps } from "../ProjectKanbanBoard";
import { KanbanCard2 } from "./card";

/** `editing` is the role-safe presentation of `editing_autohdr` — see `ProjectKanbanBoard.tsx`. */
function semanticStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

/**
 * A second Board, reachable at `view=kanban2` (#80), built from the ReUI `kanban-board-3` block.
 * Scope for this ticket is Stage columns in Admin order, cards showing street + cover photo, and
 * cross-column drag moving Stage. Priority stars (#81) and Editor avatars/Deadline/RAW (#82) are
 * explicitly out of scope; their card slots are left unfilled rather than invented.
 *
 * Column reordering is removed entirely (#76 "Column behaviour") — every column below is a plain
 * `KanbanColumn` with `disabled`, so it registers as a drop target (needed so an EMPTY column can
 * still receive a card) without ever being draggable itself, and no `KanbanColumnHandle` is
 * rendered anywhere.
 *
 * Props are intentionally the exact `ProjectKanbanBoardProps` type the existing Board exports, so
 * the Dashboard's priority and stage coordinators are unchanged (#80 acceptance criteria). Props
 * that only exist for out-of-scope features (`canPrioritize`, `onPriorityChange`,
 * `onBoardPosition`, `sameStageReorderEnabled`, `onMoveStage`, `onMoveToProposalChange`,
 * `onInteractionStateChange`, `onAnnounce`) are accepted for contract parity and intentionally
 * unused here — same-column reordering and priority are not this ticket's scope.
 */
export function ProjectKanbanBoard2({
  projects,
  activeStages,
  canMoveStages,
  boardMutationEnabled,
  movementDisabled = false,
  effectiveKanbanSort,
  pendingMoves,
  terminal,
  onBoardMove,
  projectHrefFor,
}: ProjectKanbanBoardProps) {
  const columns = useMemo(() => {
    const record: Record<string, ProjectSummary[]> = {};
    for (const stage of activeStages) {
      const key = semanticStageKey(stage.key);
      record[stage.key] = sortKanbanProjects(
        projects.filter((project) => semanticStageKey(project.stageKey as ProjectStageKey) === key),
        effectiveKanbanSort,
      );
    }
    return record;
  }, [activeStages, effectiveKanbanSort, projects]);

  const getItemValue = useCallback((project: ProjectSummary) => project.id, []);
  // Kanban's `onValueChange` is only reachable via its own internal reorder paths; in `onMove`
  // mode (below) none of them ever fire — see `components/reui/kanban.tsx`'s `handleDragEnd`.
  const noopValueChange = useCallback(() => undefined, []);

  const dragDisabled = movementDisabled || terminal || !boardMutationEnabled || !canMoveStages;

  const handleMove = useCallback(({ event, activeContainer, overContainer }: KanbanMoveEvent) => {
    if (dragDisabled) return;
    const sourceSemantic = semanticStageKey(activeContainer as ProjectStageKey);
    const targetSemantic = semanticStageKey(overContainer as ProjectStageKey);
    if (sourceSemantic === targetSemantic) return; // same-column reordering is not this ticket's scope
    const projectId = String(event.active.id);
    const project = projects.find((item) => item.id === projectId);
    if (!project || pendingMoves.has(projectId)) return;
    const model = { projects };
    const gap: SemanticGap = { targetStageKey: targetSemantic, successor: "end" };
    const caps = {
      canMoveProjectStage: canMoveStages,
      canPrioritize: false,
      sort: effectiveKanbanSort,
      activeStageKeys: activeStages.map((stage) => semanticStageKey(stage.key)),
    };
    if (!eligibleTarget(gap, model, projectId, caps)) return;
    const keyboardOrigin = event.activatorEvent?.type === "keydown";
    const focusDescriptor = focusDescriptorFor(keyboardOrigin ? "keyboard" : "pointer", project, model, "handle");
    onBoardMove?.(projectId, gap, "cross", focusDescriptor);
  }, [activeStages, canMoveStages, dragDisabled, effectiveKanbanSort, onBoardMove, pendingMoves, projects]);

  return (
    <Kanban
      value={columns}
      onValueChange={noopValueChange}
      getItemValue={getItemValue}
      onMove={handleMove}
      className="kanban2 grid grid-flow-col auto-cols-[minmax(244px,1fr)] max-[641px]:auto-cols-[minmax(240px,1fr)] gap-[var(--border-width-hair)] bg-border border border-[length:var(--border-width-hair)] border-border overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]"
      aria-label="Project pipeline board (kanban2)"
    >
      {activeStages.map((stage, stageIndex) => {
        const stageProjects = columns[stage.key] ?? [];
        return (
          <KanbanColumn key={stage.key} value={stage.key} disabled className="bg-[var(--paper-050)] min-w-0" data-testid="kanban2-column">
            <div className="flex items-center gap-[var(--space-3)] p-[var(--space-4)] border-b border-b-border bg-[var(--bg-canvas)]">
              <span className="flex-none [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] tabular-nums text-foreground-secondary" aria-hidden="true">{String(stageIndex + 1).padStart(2, "0")}</span>
              <StatusBadge stageKey={stage.key} />
              <span className="flex-none tabular-nums text-sm text-foreground-secondary">{stageProjects.length}</span>
            </div>
            <KanbanColumnContent value={stage.key} className="flex flex-col gap-[var(--space-3)] p-[var(--space-3)] min-h-[120px] flex-1">
              {stageProjects.length === 0 && <div className="py-[var(--space-5)] [font-family:var(--font-display)] text-lg text-center text-foreground-secondary">—</div>}
              {stageProjects.map((project) => (
                <KanbanItem key={project.id} value={project.id} disabled={dragDisabled || pendingMoves.has(project.id)}>
                  <KanbanCard2 project={project} projectHref={projectHrefFor?.(project)} dragDisabled={dragDisabled || pendingMoves.has(project.id)} />
                </KanbanItem>
              ))}
            </KanbanColumnContent>
          </KanbanColumn>
        );
      })}
      <KanbanOverlay>
        {({ value }) => {
          const project = projects.find((item) => item.id === String(value));
          return project ? <KanbanCard2 project={project} isOverlay /> : null;
        }}
      </KanbanOverlay>
    </Kanban>
  );
}
