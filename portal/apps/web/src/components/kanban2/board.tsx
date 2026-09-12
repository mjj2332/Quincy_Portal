import { useCallback, useMemo, useRef, useState } from "react";
import type { StageKey } from "@quincy/shared";
import { StatusBadge } from "../atoms";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { Kanban, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanOverlay, type KanbanMoveEvent } from "../reui/kanban";
import {
  announce,
  boardGapChangesOrder,
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
import { MoveToControl } from "./move-to-control";

/** `editing` is the role-safe presentation of `editing_autohdr` — see `ProjectKanbanBoard.tsx`. */
function semanticStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

const ARROW_CLASSES = "flex-none w-9 max-[641px]:w-11 pointer-coarse:w-11 min-h-[30px] max-[641px]:min-h-11 pointer-coarse:min-h-11 p-0 border-0 border-r border-r-border bg-card text-foreground-secondary text-sm leading-none cursor-pointer hover:not-disabled:bg-[var(--paper-100)] hover:not-disabled:text-foreground disabled:bg-surface-sunken disabled:cursor-not-allowed focus-visible:!outline-2 focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px]";

/**
 * Where a dropped card will land (#99). Absolutely positioned inside the gap and ZERO-layout, and
 * that is load-bearing rather than cosmetic: the primitive hard-codes
 * `MeasuringStrategy.Always`, so an in-flow indicator would shift the cards it sits between,
 * re-measure every droppable, move the collision target, move the indicator — and flip-flop.
 * Styling matches the old Board's indicator.
 */
function DropIndicator({ className }: { className: string }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 h-[3px] rounded-[2px] bg-[var(--signal-positive)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--signal-positive)_20%,transparent)] ${className}`}
      data-testid="kanban2-drop-indicator"
      aria-hidden="true"
    />
  );
}

/**
 * A second Board, reachable at `view=kanban2` (#80), built from the ReUI `kanban-board-3` block.
 * Stage columns in Admin order, cards showing street + cover photo, and cross-column drag moving
 * Stage (#80); Priority stars (#81) and Editor avatars / Deadline / RAW (#82) have since shipped
 * and are rendered. A cross-Stage drop lands exactly where it was released — before the card it
 * was dropped on, or at the end for a column drop — and a card can be reordered within its own
 * Stage by anyone holding Priority access while the Board is in Board sort (#99).
 *
 * Column reordering is removed entirely (#76 "Column behaviour") — every column below is a plain
 * `KanbanColumn` with `disabled`, so it registers as a drop target (needed so an EMPTY column can
 * still receive a card) without ever being draggable itself, and no `KanbanColumnHandle` is
 * rendered anywhere.
 *
 * Props are intentionally the exact `ProjectKanbanBoardProps` type from `lib/kanban-interaction`,
 * so the Dashboard's priority and stage coordinators are unchanged (#80 acceptance criteria).
 * `canPrioritize`, `pendingOrdering` and `onPriorityChange` are consumed as of #81,
 * `onInteractionStateChange` and `onAnnounce` as of #98, and `sameStageReorderEnabled`,
 * `onBoardPosition` (the arrows), `onMoveStage` and `onMoveToProposalChange` (Move to…) as of #99.
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
  sameStageReorderEnabled = false,
  boardMutationEnabled,
  movementDisabled = false,
  effectiveKanbanSort,
  pendingMoves,
  pendingOrdering,
  terminal,
  onBoardMove,
  onPriorityChange,
  onAnnounce,
  onInteractionStateChange,
  onBoardPosition,
  onMoveStage,
  onMoveToProposalChange,
  role,
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

  /**
   * The exact drop gap for a card released at `overIndex` in `overContainer` (#99). Placement is
   * semantic — "before project X" — never an index, so the index the primitive reports is turned
   * into a successor id here.
   *
   * The mover is removed BEFORE indexing, and that is the whole point, not a tidy-up. `overIndex` is
   * the hovered card's index in the column as rendered, mover included. Cross-Stage and dragging UP
   * within a column, removal shifts nothing and the successor is the hovered card: the card lands
   * before it. Dragging DOWN within a column, removal shifts every later index by one, so the
   * successor is the card AFTER the hovered one: the card lands after it, which is what the user
   * saw. Reading `event.over.id` as the successor instead lands every downward move one slot early.
   * A column hit reports `overIndex === length`, which falls off the end to `"end"`.
   */
  const gapFor = useCallback((projectId: string, overContainer: string, overIndex: number) => {
    const withoutMover = (columns[overContainer] ?? []).filter((item) => item.id !== projectId);
    const successor = withoutMover[overIndex]?.id ?? "end";
    const position = successor === "end" ? withoutMover.length + 1 : withoutMover.findIndex((item) => item.id === successor) + 1;
    return {
      gap: { targetStageKey: semanticStageKey(overContainer as ProjectStageKey), successor } satisfies SemanticGap,
      position,
      count: withoutMover.length + 1,
    };
  }, [columns]);

  /**
   * Whether a drop into `gap` would be accepted — shared by the drop, the narration and the
   * indicator so none of them promises a landing another refuses. Mirrors the old Board's verdict
   * (`ProjectKanbanBoard.tsx:795-800`) and the Dashboard's own checks (`runBoardMovement`), which
   * re-validate anyway: each capability gates its own kind of drop, `eligibleTarget` enforces the
   * rest (a same-Stage move needs Priority access and Board sort), and a same-Stage gap that leaves
   * the order unchanged — dropping a card back into its own slot — is `"unchanged"`, not a write.
   */
  const dropVerdict = useCallback((project: ProjectSummary, gap: SemanticGap, sameStage: boolean): "ok" | "refused" | "unchanged" => {
    if (!(sameStage ? sameStageReorderEnabled : canMoveStages)) return "refused";
    const model = { projects };
    if (!eligibleTarget(gap, model, project.id, {
      canMoveProjectStage: canMoveStages,
      canPrioritize,
      sort: effectiveKanbanSort,
      activeStageKeys: activeStages.map((stage) => semanticStageKey(stage.key)),
    })) return "refused";
    if (sameStage && !boardGapChangesOrder(gap, model, project.id)) return "unchanged";
    return "ok";
  }, [activeStages, canMoveStages, canPrioritize, effectiveKanbanSort, projects, sameStageReorderEnabled]);

  const getItemValue = useCallback((project: ProjectSummary) => project.id, []);
  // Kanban's `onValueChange` is only reachable via its own internal reorder paths; in `onMove`
  // mode (below) none of them ever fire — see `components/reui/kanban.tsx`'s `handleDragEnd`.
  const noopValueChange = useCallback(() => undefined, []);
  const reducedMotion = usePrefersReducedMotion();

  // Matches the old Board (`ProjectKanbanBoard.tsx:579`): movement is locked while ANY move or
  // ordering write is in flight, not just for the card that started it — a second interaction
  // must not be able to start mid-write.
  const movementLocked = movementDisabled || pendingMoves.size > 0 || pendingOrdering.size > 0;
  // Either capability is enough to pick a card up (`ProjectKanbanBoard.tsx:575,592`): a
  // prioritize-only principal reorders within a Stage without being able to change it. Which drops
  // each capability permits is decided per drop, in `handleMove`.
  const dragDisabled = movementLocked || terminal || !boardMutationEnabled || !(canMoveStages || sameStageReorderEnabled);
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
  // Same-Stage reordering by any non-drag path — the arrows and Move to…'s same-Stage positions.
  // `sameStageReorderEnabled` already folds in the movement flag, map evidence and Board sort.
  const canReorder = canPrioritize && sameStageReorderEnabled && !terminal;

  // `restoreFocus: false` (below) hands focus back to us, so the Board keeps a handle registry and
  // refocuses the card the user was carrying. dnd-kit's own `RestoreFocus` only ever fired for
  // KEYBOARD drags and called a bare `.focus()`, which is why turning it off is also a scroll fix.
  const handleRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const registerHandle = useCallback((projectId: string, element: HTMLButtonElement | null) => {
    if (element) handleRefs.current.set(projectId, element);
    else handleRefs.current.delete(projectId);
  }, []);
  const activeProjectRef = useRef<string | undefined>(undefined);
  const lastAnnouncedGapRef = useRef<string | undefined>(undefined);
  const [dropProposal, setDropProposal] = useState<SemanticGap | null>(null);
  // True while any drag is live. The non-drag controls are disabled for its duration: otherwise a
  // keyboard user can pick up card A, Tab to card B's arrow or Move to…, and reorder the column out
  // from under A's drag. A Board-side lock, not a Dashboard guard — the Dashboard still sees the drag
  // as active while the drop's own `onMove` runs, so a guard there would refuse every real drop.
  const [dragActive, setDragActive] = useState(false);
  // The Move-to chooser's chosen position (#99), drawn with the same indicator as a drag. Forwarded
  // to the Dashboard too, which treats a live proposal as an interaction and holds refreshes for it.
  const [moveToProposal, setMoveToProposal] = useState<SemanticGap | null>(null);
  const shownProposal = dropProposal ?? moveToProposal;
  const handleMoveToProposal = useCallback((proposal: SemanticGap | null) => {
    setMoveToProposal(proposal);
    onMoveToProposalChange?.(proposal);
  }, [onMoveToProposalChange]);
  const boardModel = useMemo(() => ({ projects }), [projects]);
  const controlsDisabled = (projectId: string) => dragDisabled || dragActive || pendingMoves.has(projectId);

  /**
   * Only for the paths that do NOT hand off to the Dashboard. Never on the valid path: the
   * Dashboard's restore effect owns that, and at that moment every handle is `disabled` by the
   * pending-write lock, so a `.focus()` here would land on BODY instead.
   *
   * `projectId` is passed explicitly by callers that run AFTER the lifecycle clear. The primitive
   * calls `onDragEnd` before `onMove`, so by the time a rejecting `onMove` asks for the handle,
   * `activeProjectRef` has already been reset — reading it there silently refocuses nothing. (This
   * is not hypothetical: it regressed the same-Stage rejection test the moment the barrier landed.)
   */
  const refocusHandle = useCallback((projectId: string | undefined = activeProjectRef.current) => {
    if (!projectId) return;
    handleRefs.current.get(projectId)?.focus({ preventScroll: true });
  }, []);

  const announceRejection = useCallback((type: "dnd-cancel" | "drop-outside" | "unchanged-gap" | "invalid-keyboard-target", projectId: string | undefined) => {
    if (!onAnnounce) return;
    const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
    if (!project) return;
    const sourceStageLabel = activeStages.find((stage) => semanticStageKey(stage.key) === semanticStageKey(project.stageKey as ProjectStageKey))?.label ?? "";
    // `announce` returns undefined when terminal, and the Dashboard drops undefined — so terminal
    // suppression is free rather than a second branch here.
    onAnnounce(announce({ type, street: project.street, sourceStageLabel }, { terminal }));
  }, [activeStages, onAnnounce, projects, terminal]);

  const handleMove = useCallback(({ event, activeContainer, overContainer, overIndex }: KanbanMoveEvent) => {
    const projectId = String(event.active.id);
    const keyboardOrigin = event.activatorEvent?.type === "keydown";
    // Every `return` below is a REJECTED drop, and a rejected drop must say so and give the handle
    // back — dnd-kit's default announcement ("was dropped over droppable area raw_review") is both
    // wrong and in the other live region, which is why they are all suppressed in `accessibility`.
    const reject = (type: "dnd-cancel" | "unchanged-gap" | "invalid-keyboard-target") => {
      announceRejection(type, projectId);
      refocusHandle(projectId);
    };
    if (dragDisabled) return reject("dnd-cancel");
    const project = projects.find((item) => item.id === projectId);
    if (!project || pendingMoves.has(projectId)) return reject("dnd-cancel");
    const sameStage = semanticStageKey(activeContainer as ProjectStageKey) === semanticStageKey(overContainer as ProjectStageKey);
    const { gap } = gapFor(projectId, overContainer, overIndex);
    const verdict = dropVerdict(project, gap, sameStage);
    if (verdict !== "ok") return reject(verdict === "unchanged" ? "unchanged-gap" : keyboardOrigin ? "invalid-keyboard-target" : "dnd-cancel");
    const focusDescriptor = focusDescriptorFor(keyboardOrigin ? "keyboard" : "pointer", project, { projects }, "handle");
    // `"same"` routes to the Dashboard's `/board-position` branch, where a confirmation is forbidden;
    // `"cross"` to `/stage`, where the 409 confirmation round trip is the normal path.
    onBoardMove?.(projectId, gap, sameStage ? "same" : "cross", focusDescriptor);
  }, [announceRejection, dragDisabled, dropVerdict, gapFor, onBoardMove, pendingMoves, projects, refocusHandle]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    activeProjectRef.current = String(event.active.id);
    setDragActive(true);
    // Opens the Dashboard's refresh barrier: it blocks ACCEPTANCE of replacement data while a drag
    // is live (a fetch may still run), and disables the view control so the Board cannot be swapped
    // mid-drag. No drag-start eligibility guard is needed, unlike the old Board: `dragDisabled`
    // already disables every item and every handle, so a drag cannot start while movement is locked.
    onInteractionStateChange?.({ activeId: String(event.active.id), proposal: null });
  }, [onInteractionStateChange]);

  /**
   * Clearing the barrier in drag-end is SAFE here, and this is the documented trap worth being
   * explicit about. The primitive calls `onDragEnd` BEFORE `onMove`, so it looks as though this
   * clears state that `handleMove` still needs. It does not: this is a parent `setState`, and
   * `handleMove` runs later in the same synchronous `handleDragEnd` invocation from a closure that
   * already captured `projects`, `columns`, `pendingMoves` and `dragDisabled`. React cannot
   * re-render or flush effects mid-handler.
   *
   * Clearing only in `onMove` is the actual bug: `onMove` never fires for a drop outside any column
   * or an unresolved container, so `activeId` would stay set, the barrier would latch forever, every
   * refetch would queue permanently and the view control would stay disabled for the rest of the
   * session. Clear in drag-end AND cancel; never only in `onMove`.
   */
  const clearInteraction = useCallback(() => {
    activeProjectRef.current = undefined;
    lastAnnouncedGapRef.current = undefined;
    setDropProposal(null);
    setDragActive(false);
    onInteractionStateChange?.({ activeId: undefined, proposal: null });
  }, [onInteractionStateChange]);

  /**
   * The gap a hover over `overId` would commit, or `undefined` where a drop there would be refused —
   * so the narration and the indicator never promise a landing `handleMove` would reject. Shares
   * `gapFor` with `handleMove`, so all three describe one gap.
   */
  const hoverTarget = useCallback((projectId: string, overId: string) => {
    if (dragDisabled) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    const overStageKey = Object.keys(columns).find((key) => key === overId || (columns[key] ?? []).some((item) => item.id === overId));
    if (!overStageKey) return undefined;
    const siblings = columns[overStageKey] ?? [];
    // Mirrors the primitive's own `overIndex` (`reui/kanban.tsx` `handleDragEnd`).
    const overIndex = overId === overStageKey ? siblings.length : siblings.findIndex((item) => item.id === overId);
    const target = gapFor(projectId, overStageKey, overIndex);
    const sameStage = semanticStageKey(overStageKey as ProjectStageKey) === semanticStageKey(project.stageKey as ProjectStageKey);
    // A gap the drop would refuse — including the card's own current slot — is not offered at all.
    if (dropVerdict(project, target.gap, sameStage) !== "ok") return undefined;
    const stageLabel = activeStages.find((item) => item.key === overStageKey)?.label ?? "";
    return { project, stageLabel, ...target };
  }, [activeStages, columns, dragDisabled, dropVerdict, gapFor, projects]);

  /**
   * Draws the drop indicator (#99), through the vendored `onDragOver` pass-through — the only hover
   * hook that exists (`useDndMonitor` was rejected: the tests drive captured handlers, so a monitor
   * would never fire there). Only the indicator changes on hover; the rendered column arrays never
   * do, because rewriting them mid-hover re-measures every droppable and loops.
   *
   * Bails out on an unchanged gap, because dragOver fires on every collision update.
   */
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const target = event.over ? hoverTarget(String(event.active.id), String(event.over.id)) : undefined;
    const next = target?.gap ?? null;
    setDropProposal((current) => (
      current?.targetStageKey === next?.targetStageKey && current?.successor === next?.successor ? current : next
    ));
  }, [hoverTarget]);

  // An outside drop never reaches `onMove` (the primitive resolves no container), so it is the one
  // rejection that has to be handled here.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over) {
      announceRejection("drop-outside", activeProjectRef.current);
      refocusHandle();
    }
    clearInteraction();
  }, [announceRejection, clearInteraction, refocusHandle]);

  const handleDragCancel = useCallback(() => {
    announceRejection("dnd-cancel", activeProjectRef.current);
    refocusHandle();
    clearInteraction();
  }, [announceRejection, clearInteraction, refocusHandle]);

  const accessibility = useMemo(() => ({
    // dnd-kit's `RestoreFocus` fires only for keyboard drags and calls a bare `.focus()`, which can
    // scroll the Board; the Board refocuses the handle itself instead, with `preventScroll`.
    restoreFocus: false as const,
    announcements: {
      // Quincy copy in dnd-kit's live region for the two events it is the right region for.
      onDragStart: ({ active }: { active: { id: string | number } }) => {
        const project = projects.find((item) => item.id === String(active.id));
        if (!project) return undefined;
        const stage = activeStages.find((item) => semanticStageKey(item.key) === semanticStageKey(project.stageKey as ProjectStageKey));
        const siblings = columns[stage?.key ?? ""] ?? [];
        return announce({
          type: "start",
          street: project.street,
          stageLabel: stage?.label ?? "",
          position: siblings.findIndex((item) => item.id === project.id) + 1,
          count: siblings.length,
        }, { terminal });
      },
      // The hover narration. It describes the SAME gap `handleMove` would commit, via the same
      // `gapFor`, so what is spoken is where the card lands: "over-card" with its position for a
      // card hit, "over-end" for a column hit. De-duplicated by semantic gap, not by container — a
      // stationary hover fires this repeatedly and a live region would read it every time, but
      // moving from one card to the next within a Stage is a new position and must be spoken.
      onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
        const target = over ? hoverTarget(String(active.id), String(over.id)) : undefined;
        // Leaving for a refused gap forgets the last one, so coming back to it is spoken again — the
        // indicator redraws there, and the narration must not stay silent while it does.
        if (!target) {
          lastAnnouncedGapRef.current = undefined;
          return undefined;
        }
        const { project, gap, position, count, stageLabel } = target;
        const gapKey = `${gap.targetStageKey}|${gap.successor}`;
        if (gapKey === lastAnnouncedGapRef.current) return undefined;
        lastAnnouncedGapRef.current = gapKey;
        return announce({
          type: gap.successor === "end" ? "over-end" : "over-card",
          street: project.street,
          stageLabel,
          position,
          count,
        }, { terminal });
      },
      // Deliberately silent, and this is mandatory rather than stylistic: the Board's own rejection
      // copy goes to the DASHBOARD's live region via `onAnnounce`. Leaving dnd-kit's defaults here
      // would have two regions narrating the same drop, and contradicting each other on a rejection.
      onDragEnd: () => undefined,
      onDragCancel: () => undefined,
    },
    screenReaderInstructions: {
      draggable: "To pick up a project, focus its Move project handle and press Space. Use the arrow keys to move between Stages and positions. Press Space again to drop, or Escape to cancel. To choose a Stage and position without dragging, use Move to… on the card.",
    },
  }), [activeStages, columns, hoverTarget, projects, terminal]);

  return (
    <Kanban
      value={columns}
      onValueChange={noopValueChange}
      getItemValue={getItemValue}
      onMove={handleMove}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={accessibility}
      className="kanban2 grid grid-flow-col auto-cols-[minmax(244px,1fr)] max-[641px]:auto-cols-[minmax(252px,1fr)] pointer-coarse:auto-cols-[minmax(252px,1fr)] gap-[var(--border-width-hair)] bg-border border border-[length:var(--border-width-hair)] border-border overflow-x-auto overscroll-x-contain [scrollbar-gutter:stable]"
      aria-label="Project pipeline board"
      // The Dashboard's focus-restore effect (`Dashboard.tsx:409-424`) resolves three tiers by
      // `[data-focus-key]`: the moved card's control, then its Stage heading, then the Board root.
      // This Board published none of them, so every restore fell through to a no-op. `tabIndex={-1}`
      // is load-bearing — without it the div is not focusable and tier 3 silently does nothing.
      data-focus-key="board"
      tabIndex={-1}
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
          //
          // The column heading's `data-focus-key` uses `semanticStageKey`, not `stage.key`: the
          // Dashboard's `fallbackStageKey` is always a canonical `StageKey` (via
          // `focusDescriptorFor` or `canonicalStageKey`), so a presentation spelling — an Editor
          // sees `editing` for `editing_autohdr` — would never match, and tier 2 would fall
          // through to the Board root. The old Board does the same (`ProjectKanbanBoard.tsx:560`).
          <KanbanColumn key={stage.key} value={stage.key} disabled className="bg-[var(--paper-050)] min-w-0 opacity-100" data-testid="kanban2-column">
            <div className="flex items-center gap-[var(--space-3)] p-[var(--space-4)] border-b border-b-border bg-[var(--bg-canvas)] focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]" data-focus-key={`stage-heading:${semanticStageKey(stage.key)}`} tabIndex={-1}>
              <span className="flex-none [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] tabular-nums text-foreground-secondary" aria-hidden="true">{String(stageIndex + 1).padStart(2, "0")}</span>
              <StatusBadge stageKey={stage.key} />
              <span className="flex-none tabular-nums text-sm text-foreground-secondary">{stageProjects.length}</span>
            </div>
            <KanbanColumnContent value={stage.key} className="relative flex flex-col gap-[var(--space-3)] p-[var(--space-3)] min-h-[120px] flex-1">
              {stageProjects.length === 0 && <div className="py-[var(--space-5)] [font-family:var(--font-display)] text-lg text-center text-foreground-secondary">—</div>}
              {stageProjects.map((project) => (
                // Same `opacity-50` defect as the column above, but now on every OTHER card too
                // once the pending-write lock (above) disables movement board-wide during a
                // single write. `data-[disabled=true]:opacity-100` is a variant selector, higher
                // specificity than the vendor's bare `.opacity-50`, so it wins only while
                // genuinely disabled — the real `isSortableDragging` drag ghost (a plain
                // `opacity-50`, not gated on `data-disabled`) is untouched.
                <KanbanItem key={project.id} value={project.id} className="relative data-[disabled=true]:opacity-100" disabled={dragDisabled || pendingMoves.has(project.id)}>
                  {shownProposal?.successor === project.id && <DropIndicator className="top-[calc(var(--space-3)/-2)] -translate-y-1/2" />}
                  <KanbanCard2
                    project={project}
                    projectHref={projectHrefFor?.(project)}
                    dragDisabled={dragDisabled || pendingMoves.has(project.id)}
                    canPrioritize={priorityEditable}
                    priorityPending={pendingOrdering?.has(project.id) ?? false}
                    onPriorityChange={onPriorityChange}
                    handleRef={registerHandle}
                    controls={<div className="flex items-stretch border-t border-t-border">
                      {canReorder && <>
                        {/* Adjacent one-slot nudges (#99), through the Dashboard's `adjacentBoardGap` and
                            `/board-position`. Deliberately NOT disabled at a column's edge: the Dashboard
                            restores focus to `arrow-up:<id>` after the move settles, and a disabled target
                            would drop focus on the floor. An edge press is a silent no-op there instead.
                            44px coarse-pointer targets, as on the handle. */}
                        <button type="button" className={ARROW_CLASSES} data-focus-key={`arrow-up:${project.id}`} aria-label={`Move ${project.street} up`} disabled={controlsDisabled(project.id)} onClick={() => onBoardPosition(project, "up")}><span aria-hidden="true">↑</span></button>
                        <button type="button" className={ARROW_CLASSES} data-focus-key={`arrow-down:${project.id}`} aria-label={`Move ${project.street} down`} disabled={controlsDisabled(project.id)} onClick={() => onBoardPosition(project, "down")}><span aria-hidden="true">↓</span></button>
                      </>}
                      <MoveToControl
                        project={project}
                        model={boardModel}
                        activeStages={activeStages}
                        // Fail closed: without a role, same-Stage positions (Admin-only) are withheld.
                        role={role ?? "editor"}
                        sort={effectiveKanbanSort}
                        canMoveStages={canMoveStages}
                        canReorder={canReorder}
                        disabled={controlsDisabled(project.id)}
                        onMoveStage={onMoveStage}
                        onProposalChange={handleMoveToProposal}
                      />
                    </div>}
                  />
                </KanbanItem>
              ))}
              {shownProposal?.successor === "end" && shownProposal.targetStageKey === semanticStageKey(stage.key) && (
                <DropIndicator className="bottom-[calc(var(--space-3)/2)] translate-y-1/2" />
              )}
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
