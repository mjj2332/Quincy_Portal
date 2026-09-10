import { useCallback, useMemo } from "react";
import type { StageKey } from "@quincy/shared";
import { StatusBadge } from "../atoms";
import { Kanban, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanOverlay, type KanbanMoveEvent } from "../reui/kanban";
import {
  eligibleTarget,
  focusDescriptorFor,
  sortKanbanProjects,
  type ProjectKanbanBoardProps,
  type ProjectSummary,
  type SemanticGap,
} from "../../lib/kanban-interaction";
import type { ProjectStageKey } from "../../lib/stages";
import { usePrefersReducedMotion } from "../../lib/use-media-query";
import { KanbanCard2 } from "./card";

/** `editing` is the role-safe presentation of `editing_autohdr` — see `ProjectKanbanBoard.tsx`. */
function semanticStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

/**
 * A second Board, reachable at `view=kanban2` (#80), built from the ReUI `kanban-board-3` block.
 * Stage columns in Admin order, cards showing street + cover photo, and cross-column drag moving
 * Stage (#80); Priority stars (#81) and Editor avatars / Deadline / RAW (#82) have since shipped
 * and are rendered. Same-column reordering and exact drop placement remain unported — every
 * cross-stage drop appends — and are #99, not this Board's current behaviour by choice.
 *
 * Column reordering is removed entirely (#76 "Column behaviour") — every column below is a plain
 * `KanbanColumn` with `disabled`, so it registers as a drop target (needed so an EMPTY column can
 * still receive a card) without ever being draggable itself, and no `KanbanColumnHandle` is
 * rendered anywhere.
 *
 * Props are intentionally the exact `ProjectKanbanBoardProps` type from `lib/kanban-interaction`,
 * so the Dashboard's priority and stage coordinators are unchanged (#80 acceptance criteria).
 * `canPrioritize`, `pendingOrdering` and `onPriorityChange` are consumed as of #81. The remainder
 * (`onBoardPosition`, `sameStageReorderEnabled`, `onMoveStage`, `onMoveToProposalChange`,
 * `onInteractionStateChange`, `onAnnounce`) are still accepted for contract parity and unused:
 * the first two belong to same-column reordering (#99), the rest to the focus, announcement and
 * drag-lifecycle work still outstanding on #98.
 *
 * The coarse-pointer column track is widened to 252px (#81): five 44px star targets need 220px,
 * and a 244px track leaves a 220px card — exactly zero slack — while the old 240px mobile track
 * overflowed by 4px. Mouse geometry is untouched, and 252px still fits five columns at 1280px.
 */
export function ProjectKanbanBoard2({
  projects,
  activeStages,
  canMoveStages,
  canPrioritize = false,
  boardMutationEnabled,
  movementDisabled = false,
  effectiveKanbanSort,
  pendingMoves,
  pendingOrdering,
  terminal,
  onBoardMove,
  onPriorityChange,
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
  const reducedMotion = usePrefersReducedMotion();

  // Matches the old Board (`ProjectKanbanBoard.tsx:579`): movement is locked while ANY move or
  // ordering write is in flight, not just for the card that started it — a second interaction
  // must not be able to start mid-write.
  const movementLocked = movementDisabled || pendingMoves.size > 0 || pendingOrdering.size > 0;
  const dragDisabled = movementLocked || terminal || !boardMutationEnabled || !canMoveStages;
  // Priority deliberately does NOT depend on `boardMutationEnabled`: that is the Board *movement*
  // flag, and the shipped contract is that Priority stays editable while movement is off. Gating
  // it on that flag was this Board's own regression (#98).
  //
  // The map-evidence predicate mirrors `ProjectKanbanBoard.tsx:575`. The Dashboard already folds
  // the identical check into the `canPrioritize` prop at both render sites, so this is a second
  // evaluation of it today — but only because the old Board enforces it too, and #83 deletes the
  // old Board. Whatever this Board enforces becomes the only enforcement, so the guarantee is kept
  // here rather than allowed to disappear silently at cutover.
  //
  // Deliberate divergence from the old Board: `pendingOrdering` is NOT folded in. `PriorityStars`
  // already disables its own commits and sets `aria-busy` while a write is pending, and removing a
  // control the user has focused mid-write is worse than leaving it busy. Note also that the
  // Dashboard rejects a second Priority write for the *same* project, not globally.
  //
  // A non-editable viewer still *sees* a set priority (read-only), and sees nothing at all where
  // none is set; `PriorityStars` owns that split.
  const hasAuthorizedBoardMap = projects.some(
    (item) => item.boardMapPresent === true || item.boardRank !== undefined || item.authorizedBoardOrder?.[item.stageKey] !== undefined,
  );
  const priorityEditable = canPrioritize && hasAuthorizedBoardMap && !terminal;

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
      className="kanban2 grid grid-flow-col auto-cols-[minmax(244px,1fr)] max-[641px]:auto-cols-[minmax(252px,1fr)] pointer-coarse:auto-cols-[minmax(252px,1fr)] gap-[var(--border-width-hair)] bg-border border border-[length:var(--border-width-hair)] border-border overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]"
      aria-label="Project pipeline board (kanban2)"
    >
      {activeStages.map((stage, stageIndex) => {
        const stageProjects = columns[stage.key] ?? [];
        return (
          // `disabled` is deliberate — it keeps every column (even an empty one) a valid drop
          // target — but `reui/kanban.tsx` turns a disabled `KanbanColumn` into `opacity-50`
          // unconditionally, washing out every column on this Board. `opacity-100` here is
          // appended last, so tailwind-merge resolves the conflict in our favour; no vendor
          // edit, and no genuine drag-ghost to preserve (column dragging is disabled entirely,
          // so `isSortableDragging` is never true here). Confirmed live: every kanban2 column
          // rendered at `getComputedStyle(...).opacity === "0.5"` before this fix.
          <KanbanColumn key={stage.key} value={stage.key} disabled className="bg-[var(--paper-050)] min-w-0 opacity-100" data-testid="kanban2-column">
            <div className="flex items-center gap-[var(--space-3)] p-[var(--space-4)] border-b border-b-border bg-[var(--bg-canvas)]">
              <span className="flex-none [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] tabular-nums text-foreground-secondary" aria-hidden="true">{String(stageIndex + 1).padStart(2, "0")}</span>
              <StatusBadge stageKey={stage.key} />
              <span className="flex-none tabular-nums text-sm text-foreground-secondary">{stageProjects.length}</span>
            </div>
            <KanbanColumnContent value={stage.key} className="flex flex-col gap-[var(--space-3)] p-[var(--space-3)] min-h-[120px] flex-1">
              {stageProjects.length === 0 && <div className="py-[var(--space-5)] [font-family:var(--font-display)] text-lg text-center text-foreground-secondary">—</div>}
              {stageProjects.map((project) => (
                // Same `opacity-50` defect as the column above, but now on every OTHER card too
                // once the pending-write lock (above) disables movement board-wide during a
                // single write. `data-[disabled=true]:opacity-100` is a variant selector, higher
                // specificity than the vendor's bare `.opacity-50`, so it wins only while
                // genuinely disabled — the real `isSortableDragging` drag ghost (a plain
                // `opacity-50`, not gated on `data-disabled`) is untouched.
                <KanbanItem key={project.id} value={project.id} className="data-[disabled=true]:opacity-100" disabled={dragDisabled || pendingMoves.has(project.id)}>
                  <KanbanCard2
                    project={project}
                    projectHref={projectHrefFor?.(project)}
                    dragDisabled={dragDisabled || pendingMoves.has(project.id)}
                    canPrioritize={priorityEditable}
                    priorityPending={pendingOrdering?.has(project.id) ?? false}
                    onPriorityChange={onPriorityChange}
                  />
                </KanbanItem>
              ))}
            </KanbanColumnContent>
          </KanbanColumn>
        );
      })}
      {/* Spread conditionally, never pass `dropAnimation={undefined}` explicitly: `KanbanOverlay`
          spreads `{...props}` after its own `dropAnimation` default, so an explicit `undefined`
          here would still win the spread and silently restore dnd-kit's own default animation for
          every user, defeating the reduced-motion preference entirely. */}
      <KanbanOverlay {...(reducedMotion ? { dropAnimation: null } : {})}>
        {({ value }) => {
          const project = projects.find((item) => item.id === String(value));
          return project ? <KanbanCard2 project={project} isOverlay /> : null;
        }}
      </KanbanOverlay>
    </Kanban>
  );
}
