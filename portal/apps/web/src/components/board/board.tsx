import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { StageKey } from "@quincy/shared";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { Kanban, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanOverlay, type KanbanMoveEvent } from "../reui/kanban";
import {
  announce,
  boardLandingSlot,
  eligibleTarget,
  focusDescriptorFor,
  sortKanbanProjects,
  type ProjectKanbanBoardProps,
  type ProjectSummary,
  type SemanticGap,
} from "../../lib/kanban-interaction";
import { boardAnimateLayoutChanges, flipDeltas, playFlip, type FlipSnapshot } from "../../lib/kanban-flip";
import type { KanbanSortMode } from "../../screens/dashboard-helpers";
import { useStarClickGuard } from "../../lib/star-click-guard";
import type { PipelineStage, ProjectStageKey } from "../../lib/stages";
import { useMediaQuery, usePrefersReducedMotion } from "../../lib/use-media-query";
import { stageGroupAppearance } from "../../lib/dashboard-project-appearance";
import { ScrollArea, ScrollBar } from "../reui/scroll-area";
import { Button } from "../reui/button";
import { Toggle } from "../reui/toggle";
import { EmptyState } from "../quincy/EmptyState";
import { LateChip } from "../quincy/LateChip";
import { StageLabel } from "../quincy/StageLabel";
import { StageToneSwatch } from "../quincy/StageKeyRow";
import { columnLabelKey, stageTone } from "../../lib/dashboard-appearance";
import { InternalLink } from "../InternalLink";
import { KanbanCard2 } from "./card";
import { cardMoveTo, moveToChoices } from "./card-actions";
import type { CardMenuConfig } from "./card-menu";
import { BOARD_PHONE_QUERY, COLUMN_SIZE_CLASS, COLUMN_SURFACE_CLASS, RAIL_SIZE_CLASS, semanticStageKey } from "./board-layout";

/**
 * Keyboard drag keys (#432): Space picks a card up, so Enter is free to open it (the card's link is
 * the drag handle). Module-level and lowercase on purpose: the Kanban root memoises its sensor
 * options on this object's identity, and `design-system-guards.test.ts` scans SCREAMING_CASE consts.
 */
const boardKeyboardCodes = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] };

/**
 * A Stage column is sorted by data (#470), so a card dragged over one must not shift the cards that
 * are already in it: the landing slot is shown by the drop indicator instead. dnd-kit reads `null`
 * as "no transform". Module-level and lowercase for the same reason as `boardKeyboardCodes`.
 */
const boardNoShiftStrategy = () => null;

/** Frame 4h "empty": each empty column says so in its own words (Awaiting RAW's carries New shoot). */
const EMPTY_COLUMN_COPY: Record<StageKey, string> = {
  awaiting_raw: "No shoots waiting for RAW.",
  raw_review: "No RAW to review.",
  editing_autohdr: "Nothing in editing.",
  edited_review: "Nothing waiting for review.",
  delivered: "Nothing delivered yet.",
};

/**
 * #923 D3: "+ New shoot" in Awaiting RAW only, for a viewer with `createProject`, to `/projects/new` with no
 * Stage preset. `slot` is frame 4e's `.addc`, the dashed full-width row at the column's end; otherwise it is
 * the empty column's action (frame 4h). Outside the column's `SortableContext` list either way. Control height
 * (38px, 44px on a phone), not the frame's 34px (#923 session defaults). Sentence case, as both frames write it,
 * not the Button's uppercase eyebrow (#923 pass round 2, row 3).
 */
function NewShootLink({ slot }: { slot: boolean }) {
  return (
    <Button
      variant="outline"
      nativeButton={false}
      render={<InternalLink to="/projects/new" data-testid="board-column-new-shoot" />}
      className={`normal-case tracking-[var(--tracking-normal)] ${slot ? "w-full border-dashed bg-transparent text-xs text-foreground-secondary" : "mt-[var(--space-2)]"}`}
    >
      <Plus aria-hidden="true" />
      New shoot
    </Button>
  );
}

/**
 * Frame 4f: the phone Board's Stage pills (`reui/toggle` chip), one per column with its swatch and count. A pill
 * SCROLLS the strip to its column; every column stays mounted, so no droppable mounts or unmounts, and the pills
 * are disabled for the whole of a drag. Swiping the strip moves the pressed pill (`onScroll` in the Board).
 * No inline padding and no rule of its own (#923 pass round 2, row 7): the first pill starts on the column's
 * edge, and the column's top border is the one line between them.
 */
function StagePills({ stages, counts, active, disabled, onSelect }: {
  stages: readonly PipelineStage[];
  counts: Record<string, number>;
  active: string | null;
  disabled: boolean;
  onSelect: (stageKey: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Stages"
      data-testid="board-stage-pills"
      className="hidden max-[721px]:flex shrink-0 gap-[var(--space-2)] overflow-x-auto py-[var(--space-3)] [scrollbar-width:none]"
    >
      {stages.map((stage) => {
        const pressed = stage.key === active;
        return (
          <Toggle
            key={stage.key}
            variant="chip"
            size="chip"
            pressed={pressed}
            disabled={disabled}
            data-stage-key={stage.key}
            data-picked={pressed ? "" : undefined}
            className="shrink-0"
            // Pressing the shown Stage again keeps it: a pill always names the column in view.
            onPressedChange={(next) => { if (next) onSelect(stage.key); }}
          >
            <StageLabel stageKey={columnLabelKey(stage.key)} label={stage.label} />
            <span className="font-mono text-xs tabular-nums text-foreground-secondary">{counts[stage.key] ?? 0}</span>
          </Toggle>
        );
      })}
    </div>
  );
}

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
      data-testid="board-drop-indicator"
      aria-hidden="true"
    />
  );
}

type FlipScopeProps = {
  /** Every column's card order; the FLIP measures only when this changes. */
  orderKey: string;
  /** False while a drag is live. */
  enabled: boolean;
  /** False under reduced motion: moves are still measured and reported, but not played. */
  animate: boolean;
  rootRef: RefObject<HTMLElement | null>;
  /** A change of sort mode snaps into place: the FLIP neither measures nor plays across it (#830). */
  sortMode: KanbanSortMode;
  /**
   * Called with the ids of the cards that moved, when any did — played or not, because the
   * misclick guard it arms matters most exactly when the card jumps.
   */
  onMoved: (movedIds: string[]) => void;
  children: ReactNode;
};

function measureCards(root: HTMLElement): FlipSnapshot {
  const snapshot: FlipSnapshot = new Map();
  for (const element of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const rect = element.getBoundingClientRect();
    snapshot.set(element.dataset.flipId!, { column: element.dataset.flipColumn ?? "", left: rect.left, top: rect.top });
  }
  return snapshot;
}

/**
 * The Board's reorder FLIP (#304; the maths and the DOM writes are `lib/kanban-flip.ts`). A class
 * because `getSnapshotBeforeUpdate` is the only React hook that reads the DOM after a render but
 * BEFORE it is committed — the "first" positions. Positions saved from the previous commit would be
 * stale after any scroll or image load in between.
 *
 * Measured unless both commits were eligible: the drop commit (drag live in the previous one) belongs
 * to dnd-kit's overlay drop animation.
 */
class FlipScope extends Component<FlipScopeProps> {
  private flights = new Map<string, () => void>();

  override getSnapshotBeforeUpdate(previous: FlipScopeProps): FlipSnapshot | null {
    const root = this.props.rootRef.current;
    if (!root || previous.orderKey === this.props.orderKey) return null;
    if (previous.sortMode !== this.props.sortMode) return null;
    if (!previous.enabled || !this.props.enabled) return null;
    // Mid-flight cards are measured WITH their transform: a second re-sort starts from where the
    // card is on screen, not from where the first one was heading.
    return measureCards(root);
  }

  override componentDidUpdate(previous: FlipScopeProps, _state: unknown, before: FlipSnapshot | null) {
    const root = this.props.rootRef.current;
    if (previous.sortMode !== this.props.sortMode) this.land();
    if (!before || !root) return;
    this.land();
    const deltas = flipDeltas(before, measureCards(root));
    if (deltas.length === 0) return;
    if (this.props.animate) {
      const farthest = deltas.reduce((best, delta) => (Math.hypot(delta.dx, delta.dy) > Math.hypot(best.dx, best.dy) ? delta : best));
      for (const delta of deltas) {
        const element = root.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(delta.id)}"]`);
        if (element) this.flights.set(delta.id, playFlip(element, delta.dx, delta.dy, delta === farthest));
      }
    }
    this.props.onMoved(deltas.map((delta) => delta.id));
  }

  override componentWillUnmount() { this.land(); }

  /** Snaps every card still in flight to rest, so the next measurement reads its real slot. */
  private land() {
    for (const cancel of this.flights.values()) cancel();
    this.flights.clear();
  }

  override render() { return this.props.children; }
}

/**
 * The Dashboard's Board, rendered at `view=kanban` (and at the Dashboard's default) since #83's
 * cutover, built from the ReUI `kanban-board-3` block (originally #80). Stage columns in Admin
 * order, cards showing street + cover photo, and cross-column drag moving Stage (#80); Priority
 * stars (#81) and Editor avatars / Deadline / RAW (#82) have since shipped and are rendered. A
 * cross-Stage drop lands exactly where it was released — before the card it was dropped on, or at
 * the end for a column drop — and a card can be reordered within its own Stage by anyone holding
 * Priority access while the Board is in Board sort (#99).
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
 * Layout follows ReUI's `tempo-tasks` Kanban board, sized to frame 4e since #923 (`COLUMN_SIZE_CLASS`): each
 * column is its own bordered surface separated by a `--space-4` gap, fluid over a 280px floor inside a
 * full-width horizontal scroll area, with a collapsed Stage (Delivered, by default) resting as a 48px rail. On a
 * phone (frame 4f) a column is the viewport's width and snaps, the Stage pills above scroll the strip, and no
 * Stage rests as a rail (#923 S5).
 */
export type ProjectKanbanBoard2Props = ProjectKanbanBoardProps & {
  /** The viewer holds `createProject`: Awaiting RAW offers "+ New shoot" (#923 D3). */
  canCreateProject?: boolean;
};

export function ProjectKanbanBoard2({
  projects,
  activeStages,
  canMoveStages,
  canPrioritize = false,
  menuCapable = false,
  boardMutationEnabled,
  movementDisabled = false,
  pendingMoves,
  pendingOrdering,
  terminal,
  sortMode,
  onBoardMove,
  onPriorityChange,
  onAnnounce,
  onInteractionStateChange,
  onMoveStage,
  role,
  projectHrefFor,
  now,
  collapsedStageKeys,
  onToggleStageCollapsed,
  canCreateProject = false,
}: ProjectKanbanBoard2Props) {
  const columns = useMemo(() => {
    const record: Record<string, ProjectSummary[]> = {};
    for (const stage of activeStages) {
      const key = semanticStageKey(stage.key);
      record[stage.key] = sortKanbanProjects(
        projects.filter((project) => semanticStageKey(project.stageKey as ProjectStageKey) === key),
        sortMode,
        key,
      );
    }
    return record;
  }, [activeStages, projects, sortMode]);

  /**
   * Where a card released over `overContainer` would land (#470): its sorted slot among that Stage's
   * cards, never the slot it was released on. The hovered card plays no part, so every hit anywhere
   * in a target column — a card, the column itself, its rail — yields the same slot.
   */
  const landingFor = useCallback((projectId: string, overContainer: string) => (
    boardLandingSlot(projects, projectId, semanticStageKey(overContainer as ProjectStageKey), sortMode)
  ), [projects, sortMode]);

  /**
   * Whether a drop into `overContainer` would be accepted — shared by the drop, the narration and
   * the indicator so none of them promises a landing another refuses. A same-Stage drop is its own
   * verdict because it is refused with its own words: the column's order is not the user's to change.
   */
  const dropVerdict = useCallback((project: ProjectSummary, overContainer: string): "ok" | "same-stage" | "refused" => {
    const target = semanticStageKey(overContainer as ProjectStageKey);
    if (semanticStageKey(project.stageKey as ProjectStageKey) === target) return "same-stage";
    return eligibleTarget(target, { projects }, project.id, {
      canMoveProjectStage: canMoveStages,
      activeStageKeys: activeStages.map((stage) => semanticStageKey(stage.key)),
    }) ? "ok" : "refused";
  }, [activeStages, canMoveStages, projects]);

  const getItemValue = useCallback((project: ProjectSummary) => project.id, []);
  // Kanban's `onValueChange` is only reachable via its own internal reorder paths; in `onMove`
  // mode (below) none of them ever fire — see `components/reui/kanban.tsx`'s `handleDragEnd`.
  const noopValueChange = useCallback(() => undefined, []);
  const reducedMotion = usePrefersReducedMotion();
  const orderKey = useMemo(
    () => activeStages.map((stage) => `${stage.key}:${(columns[stage.key] ?? []).map((item) => item.id).join(",")}`).join("|"),
    [activeStages, columns],
  );

  // A move is single-writer, so ANY pending move locks every card. A pending priority write does
  // NOT (#306): it locks only the card being saved, per card, via `orderingPending(id)` below
  // (#98 locked the whole Board, which froze every other card for the length of one star click).
  const movementLocked = movementDisabled || pendingMoves.size > 0;
  const orderingPending = (projectId: string) => pendingOrdering?.has(projectId) ?? false;
  // A card can only be dragged to another Stage (#470), so picking one up needs the Stage-move
  // capability.
  const dragDisabled = movementLocked || terminal || !boardMutationEnabled || !canMoveStages;
  // Priority deliberately does NOT depend on `boardMutationEnabled`: that is the Board *movement*
  // flag, and the shipped contract is that Priority stays editable while movement is off. Gating
  // it on that flag was this Board's own regression (#98).
  //
  // Priority no longer depends on any server order map (#475): the order is derived from the data.
  //
  // `pendingOrdering` is NOT folded in here. `PriorityStars` already disables its own commits and
  // sets `aria-busy` while a write is pending, and removing a control the user has focused
  // mid-write is worse than leaving it busy. Note also that the Dashboard rejects a second
  // Priority write for the *same* project, not globally.
  //
  // A non-editable viewer still *sees* a set priority (read-only), and sees nothing at all where
  // none is set; `PriorityStars` owns that split.
  const priorityEditable = canPrioritize && !terminal;

  // `restoreFocus: false` (below) hands focus back to us, so the Board keeps a handle registry and
  // refocuses the card the user was carrying. dnd-kit's own `RestoreFocus` only ever fired for
  // KEYBOARD drags and called a bare `.focus()`, which is why turning it off is also a scroll fix.
  const handleRefs = useRef(new Map<string, HTMLAnchorElement | null>());
  const registerHandle = useCallback((projectId: string, element: HTMLAnchorElement | null) => {
    if (element) handleRefs.current.set(projectId, element);
    else handleRefs.current.delete(projectId);
  }, []);
  const activeProjectRef = useRef<string | undefined>(undefined);
  const lastAnnouncedGapRef = useRef<string | undefined>(undefined);
  // Unmount cleanup needs the LATEST callback, not whichever render happened to mount this Board —
  // updated every render, the `move-to-control.tsx` pattern.
  const onInteractionStateChangeRef = useRef(onInteractionStateChange);
  useEffect(() => { onInteractionStateChangeRef.current = onInteractionStateChange; });
  // dnd-kit does not detach an active sensor when DndContext unmounts, so a drag left running when
  // this board unmounts (Back, a rail link) can still deliver drag end, and `onMove` would issue a
  // move from a board that is gone. The Dashboard's `activeId` outlives this board, and drag
  // end/cancel never fire, so release it here, and fence every dnd-kit handler against firing
  // after unmount.
  const unmountedRef = useRef(false);
  // The click that follows a drag (#432). The card's link is its drag handle, so releasing a drag
  // over it dispatches a `click` on that anchor. dnd-kit's own post-drag suppression only
  // `stopPropagation`s it, which leaves the anchor's DEFAULT action — a full page load to the
  // Project — running. A window capture listener swallows it outright (`preventDefault` +
  // `stopPropagation`, so `InternalLink`'s own handler never sees it either). Armed for the drag,
  // released ~100ms after it ends, because the click lands after pointer-up.
  const boardRef = useRef<HTMLDivElement | null>(null);
  // Collapse/Expand unmounts the focused button (the rail and the header are different trees), so
  // focus would fall to <body>. The click records which counterpart should receive it; once the
  // toggled state has rendered, that button exists and takes focus.
  const toggleButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingToggleFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const target = pendingToggleFocus.current && toggleButtons.current.get(pendingToggleFocus.current);
    if (!target) return;
    pendingToggleFocus.current = null;
    target.focus({ preventScroll: true });
  });
  const clickGuardRef = useRef<{ swallow: (event: MouseEvent) => void; timer: number | undefined } | null>(null);
  const disarmClickGuard = useCallback(() => {
    const guard = clickGuardRef.current;
    if (!guard) return;
    if (guard.timer !== undefined) window.clearTimeout(guard.timer);
    window.removeEventListener("click", guard.swallow, true);
    clickGuardRef.current = null;
  }, []);
  const armClickGuard = useCallback(() => {
    disarmClickGuard();
    // Only a click that lands on a link inside the Board — the one thing that can navigate. The Board's
    // other controls, the 409 confirmation modal (portalled) and the rest of the page stay clickable
    // in the ~100ms the guard is up. (A drag that ends over another card clicks their common
    // ancestor, never an anchor, so only a release back over the card's own link gets here.)
    const swallow = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !boardRef.current?.contains(event.target) || !event.target.closest("a")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    clickGuardRef.current = { swallow, timer: undefined };
  }, [disarmClickGuard]);
  const releaseClickGuard = useCallback(() => {
    const guard = clickGuardRef.current;
    if (!guard) return;
    if (guard.timer !== undefined) window.clearTimeout(guard.timer);
    guard.timer = window.setTimeout(disarmClickGuard, 100);
  }, [disarmClickGuard]);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      disarmClickGuard();
      if (activeProjectRef.current !== undefined) {
        activeProjectRef.current = undefined;
        onInteractionStateChangeRef.current?.({ activeId: undefined, proposal: null });
      }
    };
  }, [disarmClickGuard]);
  const [dropProposal, setDropProposal] = useState<SemanticGap | null>(null);
  // True while any drag is live. The non-drag controls are disabled for its duration: otherwise a
  // keyboard user can pick up card A, Tab to card B's arrow or Move to…, and reorder the column out
  // from under A's drag. A Board-side lock, not a Dashboard guard — the Dashboard still sees the drag
  // as active while the drop's own `onMove` runs, so a guard there would refuse every real drop.
  const [dragActive, setDragActive] = useState(false);

  // #923 S5: on a phone (frame 4f) every column is drawn in full, Delivered included, so a Stage pill always lands
  // on real cards and never on the 48px rail; the phone column header has no collapse control. The stored choice
  // (`collapsedStageKeys`) is the viewer's wide-screen preference and is left exactly as it is. A width that
  // crosses the breakpoint mid-drag waits for the drop: swapping a rail for a column would mount droppables under
  // `MeasuringStrategy.Always`, the loop lessons.md bans.
  const phoneNow = useMediaQuery(BOARD_PHONE_QUERY);
  const [phone, setPhone] = useState(phoneNow);
  if (!dragActive && phone !== phoneNow) setPhone(phoneNow);

  // Frame 4f's phone pills (#923). The pressed pill names the column at the strip's start: a press scrolls there,
  // a swipe moves the pill. While a press's own smooth scroll runs, the swipe sync stands down, or the pill would
  // step through every column the scroll passes.
  const [pickedStage, setPickedStage] = useState<string | null>(null);
  const activePill = pickedStage !== null && activeStages.some((stage) => stage.key === pickedStage) ? pickedStage : (activeStages[0]?.key ?? null);
  const pillScrollTimer = useRef<number | undefined>(undefined);
  const settlePillScroll = useCallback((delay: number) => {
    window.clearTimeout(pillScrollTimer.current);
    pillScrollTimer.current = window.setTimeout(() => { pillScrollTimer.current = undefined; }, delay);
  }, []);
  useEffect(() => () => window.clearTimeout(pillScrollTimer.current), []);
  // Each column registers its element here through the `render` element's ref (merged with dnd-kit's own by
  // `KanbanColumn`'s `useRender`), so the pills never search the DOM by test id.
  const columnElements = useRef(new Map<string, HTMLElement>());
  const columnRef = (stageKey: string) => (element: HTMLElement | null) => {
    if (element) columnElements.current.set(stageKey, element);
    else columnElements.current.delete(stageKey);
  };
  const columnElement = (stageKey: string) => columnElements.current.get(stageKey) ?? null;
  const selectPill = (stageKey: string) => {
    setPickedStage(stageKey);
    settlePillScroll(600);
    columnElement(stageKey)?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "start" });
  };
  const syncPillToScroll = (viewport: HTMLElement) => {
    // The pills exist on a phone only; a wide Board's horizontal scroll has nothing to sync.
    if (!phone || dragActive) return;
    if (pillScrollTimer.current !== undefined) {
      settlePillScroll(150);
      return;
    }
    const start = viewport.getBoundingClientRect().left;
    let nearest: { key: string; distance: number } | null = null;
    for (const stage of activeStages) {
      const element = columnElement(stage.key);
      if (!element) continue;
      const distance = Math.abs(element.getBoundingClientRect().left - start);
      if (!nearest || distance < nearest.distance) nearest = { key: stage.key, distance };
    }
    if (nearest) setPickedStage(nearest.key);
  };

  // The misclick guard (#304): wraps `onPriorityChange`, armed by the FLIP below.
  const starClickGuard = useStarClickGuard(onPriorityChange);
  const shownProposal = dropProposal;
  const boardModel = useMemo(() => ({ projects }), [projects]);
  // #428: an archived Project's card is read-only — never dragged, nudged or moved from its menu.
  const archivedIds = new Set(projects.filter((project) => project.archivedAt).map((project) => project.id));
  // The Stage choices of each card's Move to submenu. Depend on the projects and the principal, never
  // on a drag or its hover, so they are not recomputed while one is live.
  const moveToByCard = useMemo(() => {
    const byCard = new Map<string, ReturnType<typeof moveToChoices>>();
    for (const item of projects) {
      if (item.archivedAt) continue;
      byCard.set(item.id, moveToChoices(item, boardModel, activeStages, canMoveStages));
    }
    return byCard;
  }, [activeStages, boardModel, canMoveStages, projects]);
  const controlsDisabled = (projectId: string) => dragDisabled || dragActive || archivedIds.has(projectId) || pendingMoves.has(projectId) || orderingPending(projectId);

  /**
   * The card's ⋯ and right-click menus (#432, #470): Move to ▸ Stage, one config for both so they
   * cannot drift. Disabled under search, a pending write or a live drag. An Archived card has no menu.
   */
  const menuFor = (project: ProjectSummary): CardMenuConfig | undefined => {
    if (project.archivedAt) return undefined;
    const disabled = controlsDisabled(project.id);
    const choices = moveToByCard.get(project.id) ?? [];
    const moveTo = cardMoveTo({
      // `menuCapable`: the principal has a movement capability that is switched off RIGHT NOW (a search,
      // a refresh settling, a 503). The ⋯ stays, with Move to disabled, instead of vanishing and reappearing.
      canMoveTo: canMoveStages || menuCapable,
      disabled,
      choices,
    });
    if (!moveTo) return undefined;
    return {
      disabled,
      dragActive,
      choices,
      moveToDisabled: moveTo.disabled,
      onMoveStage: (stageKey) => onMoveStage(project, stageKey, focusDescriptorFor("move-to", project, boardModel, sortMode, "move-to")),
    };
  };

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

  const announceRejection = useCallback((type: "dnd-cancel" | "drop-outside" | "same-stage-refused" | "invalid-keyboard-target", projectId: string | undefined) => {
    if (!onAnnounce) return;
    const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
    if (!project) return;
    const sourceStageLabel = activeStages.find((stage) => semanticStageKey(stage.key) === semanticStageKey(project.stageKey as ProjectStageKey))?.label ?? "";
    // `announce` returns undefined when terminal, and the Dashboard drops undefined — so terminal
    // suppression is free rather than a second branch here.
    onAnnounce(announce({ type, street: project.street, sourceStageLabel }, { terminal, sortMode }));
  }, [activeStages, onAnnounce, projects, sortMode, terminal]);

  const handleMove = useCallback(({ event, overContainer }: KanbanMoveEvent) => {
    if (unmountedRef.current) return;
    const projectId = String(event.active.id);
    const keyboardOrigin = event.activatorEvent?.type === "keydown";
    // Every `return` below is a REJECTED drop, and a rejected drop must say so and give the handle
    // back — dnd-kit's default announcement ("was dropped over droppable area raw_review") is both
    // wrong and in the other live region, which is why they are all suppressed in `accessibility`.
    const reject = (type: "dnd-cancel" | "same-stage-refused" | "invalid-keyboard-target") => {
      announceRejection(type, projectId);
      refocusHandle(projectId);
    };
    if (dragDisabled) return reject("dnd-cancel");
    const project = projects.find((item) => item.id === projectId);
    // An archived Project is read-only (#428): its card is not draggable, and a drop that arrives anyway is refused.
    if (!project || project.archivedAt || pendingMoves.has(projectId) || orderingPending(projectId)) return reject("dnd-cancel");
    const verdict = dropVerdict(project, overContainer);
    if (verdict === "same-stage") return reject("same-stage-refused");
    if (verdict !== "ok") return reject(keyboardOrigin ? "invalid-keyboard-target" : "dnd-cancel");
    const focusDescriptor = focusDescriptorFor(keyboardOrigin ? "keyboard" : "pointer", project, { projects }, sortMode, "handle");
    // Always an append: the Board is sorted by data, so a drop names a Stage and nothing else.
    onBoardMove?.(projectId, semanticStageKey(overContainer as ProjectStageKey), focusDescriptor);
  }, [announceRejection, dragDisabled, dropVerdict, onBoardMove, pendingMoves, pendingOrdering, projects, refocusHandle, sortMode]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (unmountedRef.current) return;
    activeProjectRef.current = String(event.active.id);
    armClickGuard();
    setDragActive(true);
    // Opens the Dashboard's refresh barrier: it blocks ACCEPTANCE of replacement data while a drag
    // is live (a fetch may still run), and disables the view control so the Board cannot be swapped
    // mid-drag. No drag-start eligibility guard is needed, unlike the old Board: `dragDisabled`
    // already disables every item and every handle, so a drag cannot start while movement is locked.
    onInteractionStateChange?.({ activeId: String(event.active.id), proposal: null });
  }, [armClickGuard, onInteractionStateChange]);

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
    releaseClickGuard();
    activeProjectRef.current = undefined;
    lastAnnouncedGapRef.current = undefined;
    setDropProposal(null);
    setDragActive(false);
    onInteractionStateChange?.({ activeId: undefined, proposal: null });
  }, [onInteractionStateChange, releaseClickGuard]);

  /**
   * The landing slot a hover over `overId` would commit, or `undefined` where a drop there would be
   * refused (a card's own Stage included) — so the narration and the indicator never promise a
   * landing `handleMove` would reject. Shares `landingFor` and `dropVerdict` with the drop.
   */
  const hoverTarget = useCallback((projectId: string, overId: string) => {
    if (dragDisabled) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    const overStageKey = Object.keys(columns).find((key) => key === overId || (columns[key] ?? []).some((item) => item.id === overId));
    if (!overStageKey) return undefined;
    if (dropVerdict(project, overStageKey) !== "ok") return undefined;
    const target = landingFor(projectId, overStageKey);
    if (!target) return undefined;
    const stageLabel = activeStages.find((item) => item.key === overStageKey)?.label ?? "";
    return { project, stageLabel, ...target };
  }, [activeStages, columns, dragDisabled, dropVerdict, landingFor, projects]);

  /**
   * Draws the drop indicator (#99), through the vendored `onDragOver` pass-through — the only hover
   * hook that exists (`useDndMonitor` was rejected: the tests drive captured handlers, so a monitor
   * would never fire there). Only the indicator changes on hover; the rendered column arrays never
   * do, because rewriting them mid-hover re-measures every droppable and loops.
   *
   * Bails out on an unchanged slot, because dragOver fires on every collision update.
   */
  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (unmountedRef.current) return;
    const target = event.over ? hoverTarget(String(event.active.id), String(event.over.id)) : undefined;
    const next = target?.gap ?? null;
    setDropProposal((current) => (
      current?.targetStageKey === next?.targetStageKey && current?.successor === next?.successor ? current : next
    ));
  }, [hoverTarget]);

  // An outside drop never reaches `onMove` (the primitive resolves no container), so it is the one
  // rejection that has to be handled here.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (unmountedRef.current) return;
    if (!event.over) {
      announceRejection("drop-outside", activeProjectRef.current);
      refocusHandle();
    }
    clearInteraction();
  }, [announceRejection, clearInteraction, refocusHandle]);

  const handleDragCancel = useCallback(() => {
    if (unmountedRef.current) return;
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
        }, { terminal, sortMode });
      },
      // The hover narration. It describes the SAME slot the drop would land in, via the same
      // `landingFor`. De-duplicated by slot, not by container — a stationary hover fires this
      // repeatedly and a live region would read it every time — and the slot does not depend on
      // which card is hovered, so moving between cards of one Stage stays silent.
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
          type: "over-stage",
          street: project.street,
          stageLabel,
          position,
          count,
        }, { terminal, sortMode });
      },
      // Deliberately silent, and this is mandatory rather than stylistic: the Board's own rejection
      // copy goes to the DASHBOARD's live region via `onAnnounce`. Leaving dnd-kit's defaults here
      // would have two regions narrating the same drop, and contradicting each other on a rejection.
      onDragEnd: () => undefined,
      onDragCancel: () => undefined,
    },
    screenReaderInstructions: {
      draggable: "To pick up a project, focus its card and press Space. Use the arrow keys to move it. Press Space to drop, Escape to cancel. Press Enter to open it. For more actions, use the card's Actions menu.",
    },
  }), [activeStages, columns, hoverTarget, projects, sortMode, terminal]);

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
      keyboardCodes={boardKeyboardCodes}
      className="flex min-h-0 min-w-0 w-full flex-1 flex-col"
    >
      <StagePills
        stages={activeStages}
        counts={Object.fromEntries(activeStages.map((stage) => [stage.key, (columns[stage.key] ?? []).length]))}
        active={activePill}
        disabled={dragActive}
        onSelect={selectPill}
      />
      {/* Horizontal scroll, composed as ReUI `tempo-tasks`' `BoardScrollArea`: Base UI's ScrollArea
          primitives (the same pattern as `reui/gantt/gantt-view.tsx`) with the installed
          `reui/scroll-area.tsx` `ScrollBar`. The installed `ScrollArea` wrapper cannot be used: it
          renders its children INSIDE the Viewport, whose inline `overflow: scroll` would make the
          Viewport the bar's sticky scroll container, pinning it to the Board's own bottom — off-screen
          behind a tall column, the defect this fixes. Here the bar is the Viewport's sibling inside
          Root, so `position: sticky` resolves against the page and the bar stays at the bottom of the
          screen while the Board is in view. `sticky` goes through `style`, not a class: Base UI sets
          `position: absolute` inline and merges the consumer's `style` last. The DndContext (the
          `Kanban` root above) still wraps the scroll area and `KanbanOverlay`; dnd-kit auto-scroll
          finds the Viewport as a scrollable ancestor.

          In the Dashboard's fill mode (#363) the Root is a bounded column: the Viewport takes the height
          and the bar is an in-flow row beneath it, so `position: sticky` is inert, and the bar still sits
          at the bottom of the visible Board. */}
      <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col has-[>[data-slot=scroll-area-viewport]:focus-visible]:outline has-[>[data-slot=scroll-area-viewport]:focus-visible]:outline-[length:var(--border-width-bold)] has-[>[data-slot=scroll-area-viewport]:focus-visible]:outline-[var(--focus-ring)] outline-offset-0 has-[>[data-slot=scroll-area-viewport]:focus-visible]:outline-offset-0">
        <ScrollAreaPrimitive.Viewport
          data-slot="scroll-area-viewport"
          data-testid="board-scroll-viewport"
          // #923 frame 4f: on a phone each column snaps to the strip's start. The snap is off for the whole of a drag,
          // or it would fight dnd-kit's auto-scroll; scroll-snap is not layout, so nothing in-flow changes.
          data-dragging={dragActive ? "true" : undefined}
          onScroll={(event) => syncPillToScroll(event.currentTarget)}
          className="@container min-h-0 w-full flex-1 focus-visible:!outline-none max-[721px]:snap-x max-[721px]:snap-mandatory data-[dragging=true]:snap-none"
        >
          <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="h-full w-max min-w-full">
            <FlipScope orderKey={orderKey} sortMode={sortMode} enabled={!dragActive} animate={!reducedMotion} rootRef={boardRef} onMoved={starClickGuard.onCardsMoved}>
              <div
                ref={boardRef}
                {...starClickGuard.boardHandlers}
                className="board-columns flex items-stretch gap-[var(--space-4)] w-max min-w-full h-full"
                aria-label="Project pipeline board"
                // The Dashboard's focus-restore effect (`Dashboard.tsx:409-424`) resolves three tiers by
                // `[data-focus-key]`: the moved card's control, then its Stage heading, then the Board root.
                // This Board published none of them, so every restore fell through to a no-op. `tabIndex={-1}`
                // is load-bearing — without it the div is not focusable and tier 3 silently does nothing.
                data-focus-key="board"
                tabIndex={-1}
              >
                {activeStages.map((stage) => {
                  const stageProjects = columns[stage.key] ?? [];
                  const stageKey = semanticStageKey(stage.key);
                  const collapsed = !phone && (collapsedStageKeys?.includes(stageKey) ?? false);
                  // #923: the column's count and "N late" are the appearance module's group summary, so they agree
                  // with the cards (Delivered and archived Projects are never late).
                  const group = stageGroupAppearance(stageProjects, now ?? Date.now());
                  const columnId = `board-column-${stageKey}`;
                  const offersNewShoot = canCreateProject && stageKey === "awaiting_raw";
                  // The collapse control: a ghost icon button, disabled for the whole of a drag (toggling
                  // droppables mid-drag under `MeasuringStrategy.Always` is the loop lessons.md bans).
                  const toggle = (label: string, expanded: boolean) => onToggleStageCollapsed && !phone && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="max-[641px]:size-11 pointer-coarse:size-11 aria-expanded:bg-transparent aria-expanded:hover:bg-muted"
                      aria-label={`${label} ${stage.label}`}
                      aria-expanded={expanded}
                      aria-controls={columnId}
                      data-testid={expanded ? "board-column-collapse" : "board-column-expand"}
                      disabled={dragActive}
                      ref={(element) => { if (element) toggleButtons.current.set(`${stageKey}:${expanded}`, element); else toggleButtons.current.delete(`${stageKey}:${expanded}`); }}
                      onClick={() => { pendingToggleFocus.current = `${stageKey}:${!expanded}`; onToggleStageCollapsed(stageKey); }}
                    >
                      {expanded ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </Button>
                  );
                  if (collapsed) {
                    // The rail (block's `DealLane`): still a drop target (a drop appends to the Stage's end)
                    // but with no `KanbanColumnContent`, so its cards are unmounted while collapsed.
                    const receiving = shownProposal?.targetStageKey === stageKey;
                    return (
                      <KanbanColumn key={stage.key} id={columnId} value={stage.key} render={<div ref={columnRef(stage.key)} />} disabled className={`${RAIL_SIZE_CLASS} ${COLUMN_SURFACE_CLASS} ${receiving ? "border-[var(--ink-900)]" : ""}`} data-testid="board-column" data-stage-key={stage.key} data-collapsed="true">
                        {/* Frame 4e `.kcol.rest`: the toggle, the Stage swatch, then the name and count reading upwards. */}
                        <div className="flex h-full flex-col items-center gap-[var(--space-3)] py-[var(--space-2)] focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--focus-ring)] outline-offset-[-2px] focus-visible:!outline-offset-[-2px]" data-focus-key={`stage-heading:${stageKey}`} tabIndex={-1}>
                          {toggle("Expand", false)}
                          <StageToneSwatch tone={stageTone(stage.key)} />
                          <span className="flex rotate-180 items-center gap-[var(--space-2)] whitespace-nowrap text-sm text-foreground [writing-mode:vertical-rl]">
                            {stage.label}
                            <span className="font-mono text-xs tabular-nums text-foreground-secondary" data-testid="board-column-count">{group.count}</span>
                          </span>
                          {group.lateCount > 0 && <LateChip size="rail" data-testid="board-column-late">{group.lateCount} late</LateChip>}
                        </div>
                      </KanbanColumn>
                    );
                  }
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
                    // through to the Board root. The Board this replaced keyed its headings the same way.
                    <KanbanColumn key={stage.key} id={columnId} value={stage.key} render={<div ref={columnRef(stage.key)} />} disabled className={`${COLUMN_SIZE_CLASS} ${COLUMN_SURFACE_CLASS} ${shownProposal?.targetStageKey === stageKey ? "border-[var(--ink-900)]" : ""}`} data-testid="board-column" data-stage-key={stage.key}>
                      {/* Frame 4e `.kh`: one 44px row, the Stage swatch and name, the count, "N late", then the toggle. */}
                      <div className="flex shrink-0 flex-col border-b border-b-border focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--focus-ring)] outline-offset-[-2px] focus-visible:!outline-offset-[-2px]" data-focus-key={`stage-heading:${stageKey}`} tabIndex={-1}>
                        <div className="flex min-h-11 min-w-0 items-center gap-[var(--space-2)] whitespace-nowrap ps-[var(--space-3)] pe-[var(--space-2)]" data-testid="board-column-title-row">
                          <StageLabel stageKey={columnLabelKey(stage.key)} label={stage.label} className="min-w-0 shrink" />
                          <span className="shrink-0 font-mono text-xs tabular-nums text-foreground-secondary" data-testid="board-column-count">{group.count}</span>
                          {group.lateCount > 0 && <LateChip data-testid="board-column-late" className="shrink-0">{group.lateCount} late</LateChip>}
                          <span className="ms-auto flex-none">{toggle("Collapse", true)}</span>
                        </div>
                      </div>
                      {/* #923 pass round 2, row 9: Base UI's scrollbar overlays the list's end edge, so a column that
                          scrolls (`data-has-overflow-y` on the Root) widens the list's end padding into a gutter for it. */}
                      <ScrollArea className="group/column-scroll min-h-0 flex-1">
                        <KanbanColumnContent value={stage.key} strategy={boardNoShiftStrategy} className="relative flex flex-col gap-[var(--space-3)] p-[var(--space-3)] group-data-[has-overflow-y]/column-scroll:pe-[var(--space-5)] min-h-[120px]" data-testid="board-column-list">
                          {stageProjects.length === 0 && (
                            <EmptyState size="compact" title={EMPTY_COLUMN_COPY[stageKey]} data-testid="board-column-empty" className="px-[var(--space-1)]">
                              {offersNewShoot ? <NewShootLink slot={false} /> : null}
                            </EmptyState>
                          )}
                          {stageProjects.map((project) => (
                            // Same `opacity-50` defect as the column above, but now on every OTHER card too
                            // once the pending-write lock (above) disables movement board-wide during a
                            // single write. `data-[disabled=true]:opacity-100` is a variant selector, higher
                            // specificity than the vendor's bare `.opacity-50`, so it wins only while
                            // genuinely disabled — the real `isSortableDragging` drag ghost (a plain
                            // `opacity-50`, not gated on `data-disabled`) is untouched.
                            <KanbanItem key={project.id} value={project.id} animateLayoutChanges={boardAnimateLayoutChanges} className="relative data-[disabled=true]:opacity-100" disabled={dragDisabled || Boolean(project.archivedAt) || pendingMoves.has(project.id) || orderingPending(project.id)}>
                              {shownProposal?.successor === project.id && <DropIndicator className="top-[calc(var(--space-3)/-2)] -translate-y-1/2" />}
                              {/* The FLIP's own node (#304): never `KanbanItem`, whose transform React and
                                  dnd-kit own. The drop indicator stays outside it, so it never flies. */}
                              <div data-flip-id={project.id} data-flip-column={stage.key} className="relative">
                                <KanbanCard2
                                  project={project}
                                  projectHref={projectHrefFor?.(project)}
                                  dragDisabled={dragDisabled || Boolean(project.archivedAt) || pendingMoves.has(project.id) || orderingPending(project.id)}
                                  canPrioritize={priorityEditable && !project.archivedAt}
                                  priorityPending={orderingPending(project.id)}
                                  onPriorityChange={starClickGuard.handlePriorityChange}
                                  now={now}
                                  handleRef={registerHandle}
                                  menu={menuFor(project)}
                                />
                              </div>
                            </KanbanItem>
                          ))}
                          {shownProposal?.successor === "end" && shownProposal.targetStageKey === semanticStageKey(stage.key) && (
                            <DropIndicator className="bottom-[calc(var(--space-3)/2)] translate-y-1/2" />
                          )}
                        </KanbanColumnContent>
                        {offersNewShoot && stageProjects.length > 0 && <div className="px-[var(--space-3)] pb-[var(--space-3)] group-data-[has-overflow-y]/column-scroll:pe-[var(--space-5)]"><NewShootLink slot /></div>}
                      </ScrollArea>
                    </KanbanColumn>
                  );
                })}
              </div>
            </FlipScope>
          </ScrollAreaPrimitive.Content>
        </ScrollAreaPrimitive.Viewport>
        {/* Paper (`--bg-canvas`) behind the bar so cards never show through it while it is stuck
            over them; the thumb is `--border-strong` ink rather than the registry's faint
            `bg-border`, so it reads clearly on paper. Base UI only mounts it while the Board
            overflows sideways — no empty track on a wide screen. */}
        <ScrollBar
          orientation="horizontal"
          style={{ position: "sticky" }}
          data-testid="board-scrollbar"
          className="z-10 bg-[var(--bg-canvas)] [&>[data-slot=scroll-area-thumb]]:bg-[var(--border-strong)]"
        />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
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
