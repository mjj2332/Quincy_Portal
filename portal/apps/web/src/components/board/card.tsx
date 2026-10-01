import { useRef, useState } from "react";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { ContextMenu, ContextMenuTrigger } from "../reui/context-menu";
import { Frame, FramePanel } from "../reui/frame";
import { AvatarStack } from "../quincy/AvatarStack";
import { InternalLink } from "../InternalLink";
import { LazyImage } from "../LazyImage";
import { KanbanItemHandle } from "../reui/kanban";
import { PriorityStars } from "../quincy/PriorityStars";
import { formatSydneyCivil } from "@quincy/shared";
import { deadlineTriggerText } from "../ProjectHeaderDeadline";
import { isOverdueProject } from "../../lib/dashboard-summary";
import { formatDashboardDate } from "../../screens/dashboard-helpers";
import type { ProjectSummary } from "../../lib/kanban-interaction";
import { CardActionsMenu, CardContextMenuContent, type CardMenuBinding, type CardMenuConfig } from "./card-menu";
import type { CardActionId } from "./card-actions";
import { MoveToDialog } from "./move-to-control";

/**
 * The Board card (#432), composed on ReUI `frame` the way `solution-crm-7/board-card.tsx` is: a
 * ghost `Frame` holding one `FramePanel`. Contents, exactly: cover photo, street (no suburb), Shoot
 * date, Deadline (red when overdue), Priority stars and Editor avatars. The RAW count is gone.
 *
 * The whole card is the drag handle, but NOT by wrapping it in `KanbanItemHandle` the way the block
 * does. dnd-kit's handle attributes default to `role="button"`, and a `role="button"` ancestor
 * prunes the stars' nested `role="radiogroup"` from the accessibility tree (#81, `docs/lessons.md`).
 * Instead the card's single `InternalLink` IS the handle, stretched over the whole panel with an
 * `after:` overlay, so a press anywhere on the card lands on it. The stars and the card's controls
 * are siblings of the link, raised above the overlay with `z-[1]` — outside the handle, so pressing
 * them can never start a drag (structural, no `stopPropagation`).
 */

export function CoverMedia({
  project,
  retryToken,
  onFailedChange,
  placeholderClassName,
}: {
  project: ProjectSummary;
  retryToken?: number;
  onFailedChange?: (failed: boolean) => void;
  /** Extra classes for the letter placeholder (the Table sizes it for a 48px box). */
  placeholderClassName?: string;
}) {
  if (project.coverAssetId) {
    return <LazyImage className="size-full object-cover" src={`/media/asset/${encodeURIComponent(project.coverAssetId)}/thumb`} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  }
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return <div className={`project-cover-placeholder size-full${placeholderClassName ? ` ${placeholderClassName}` : ""}`} aria-hidden="true">{content}</div>;
}

export type KanbanCard2Props = {
  project: ProjectSummary;
  projectHref?: string;
  isOverlay?: boolean;
  dragDisabled?: boolean;
  /** Admin-only (#81). False renders priority read-only, or not at all when unset. */
  canPrioritize?: boolean;
  /** True while a priority write for this Project is in flight. */
  priorityPending?: boolean;
  onPriorityChange?: (project: ProjectSummary, priority: number | null) => void;
  /** The clock "overdue" is judged against (the Dashboard's `useNow`); defaults to the wall clock. */
  now?: number;
  /**
   * Registers this card's link (its drag handle) with the Board, which refocuses it on the paths
   * dnd-kit no longer covers (see `board.tsx`'s `restoreFocus: false`). A ref rather than a
   * `querySelector('[data-focus-key=…]')` so the Board's focus path carries no DOM-query coupling.
   */
  handleRef?: (projectId: string, element: HTMLAnchorElement | null) => void;
  /**
   * The ⋯ menu and the right-click menu (#432), built from one descriptor list. Never rendered in the
   * drag overlay, which must carry no interactive element (#98), nor on an Archived card.
   */
  menu?: CardMenuConfig;
};

/**
 * dnd-kit's `attributes` go onto the link through `KanbanItemHandle`. All but `aria-describedby`
 * (the screen-reader instructions) are wrong for a link: `role="button"` would replace its link
 * semantics, `tabIndex` is redundant, and `aria-disabled` / `aria-pressed` describe a button. A
 * present-but-`undefined` prop overrides the merged default (Base UI `mergeProps`); pinned by a test.
 */
const LINK_ATTRIBUTE_OVERRIDES = {
  role: undefined,
  tabIndex: undefined,
  "aria-pressed": undefined,
  "aria-roledescription": undefined,
  "aria-disabled": undefined,
} as const;

export function KanbanCard2({ project, projectHref, isOverlay = false, dragDisabled = false, canPrioritize = false, priorityPending = false, onPriorityChange, now, handleRef, menu }: KanbanCard2Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);
  // Delivered and archived Projects are never overdue (the Portal's rule, `isOverdueProject`), so a
  // column's overdue count and the header's agree.
  const overdue = isOverdueProject(project, now ?? Date.now());
  // The same text the Dashboard table's Deadline cell shows ("Thu 8 Oct · 17:00"), from the same
  // studio civil string; `formatSydneyCivil` only covers a summary that predates `deadlineLocalCivil`.
  const projectDeadlineLabel = project.deadlineAt === null ? null : deadlineTriggerText(project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt));
  const archived = Boolean(project.archivedAt);
  const hasEditors = (project.editors?.length ?? 0) > 0;
  const href = projectHref ?? `/projects/${encodeURIComponent(project.id)}`;
  const menuConfig = !archived && menu && menu.actions.length > 0 ? menu : null;
  // Move to… hand-off: the item only records the intent; the dialog opens once the menu has finished
  // closing, so the menu's own focus return to the ⋯ trigger cannot land on top of it.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [moveToOpen, setMoveToOpen] = useState(false);
  const pendingMoveTo = useRef(false);
  const binding: CardMenuBinding | null = menuConfig && {
    actions: menuConfig.actions,
    disabled: menuConfig.disabled,
    triggerRef: setTrigger,
    // Withheld while Move to… is pending: the dialog takes focus, and gives it back to the ⋯ trigger
    // itself when it closes, so the menu's own return must not land on top of it.
    returnFocus: () => !pendingMoveTo.current,
    onSelect: (id: CardActionId) => {
      if (id === "move-to") pendingMoveTo.current = true;
      else menuConfig.onReorder(id === "move-up" ? "up" : "down");
    },
    onClosed: () => {
      // `pendingMoveTo` stays set until the dialog closes: the menu's focus-return decision
      // (`returnFocus`) runs as it UNMOUNTS, which is after this callback.
      if (pendingMoveTo.current) setMoveToOpen(true);
    },
  };
  // Base UI opens its context menu on a 500ms touch long-press, which would open over a live drag
  // (the card's own long-press is the drag, 250ms). Touch gets the ⋯ menu instead.
  const lastTouchAt = useRef(0);

  const deadline = projectDeadlineLabel && (
    <time
      className={`block text-sm tabular-nums ${overdue ? "text-signal-critical" : "text-foreground"}`}
      data-testid="board-card-deadline"
      dateTime={new Date(project.deadlineAt!).toISOString()}
    >
      {overdue ? "Overdue" : "Due"} {projectDeadlineLabel}
    </time>
  );
  const shoot = project.shootDate !== null && (
    <div className="text-sm tabular-nums text-foreground-secondary" data-testid="board-card-shoot">Shoot {formatDashboardDate(project.shootDate)}</div>
  );
  const cover = (
    <div className="aspect-video overflow-hidden bg-[var(--ink-800)]" data-testid="board-card-cover">
      <CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} />
    </div>
  );

  if (isOverlay) {
    // The floating overlay follows the pointer/keyboard focus but is not itself a real card: it must
    // carry no interactive element at all (#98), so it renders the same visual content in a plain,
    // non-hit-testing, assistive-tech-hidden wrapper instead of the link.
    return (
      <Frame variant="ghost" className="relative p-0" data-testid="board-card-wrap">
        <FramePanel className="flex flex-col p-0 shadow-xs">
          <div className="pointer-events-none" data-testid="board-card-overlay" aria-hidden="true">
            {cover}
            <div className="flex flex-col gap-[var(--space-1)] p-[var(--space-3)]">
              {archived && <Badge variant="secondary" size="sm" className="self-start">Archived</Badge>}
              <div className="serif text-base tracking-tight leading-snug [text-wrap:pretty]" data-testid="board-card-address">{project.street}</div>
              {shoot}
              {deadline}
              {hasEditors && <div className="mt-[var(--space-2)] flex items-center justify-end" data-testid="board-card-meta"><AvatarStack people={project.editors!} personNoun="Editor" emptyLabel="No Editor assigned" /></div>}
            </div>
          </div>
        </FramePanel>
      </Frame>
    );
  }

  return (
    // The context-menu trigger is an ANCESTOR of the drag handle, never inside it: Base UI stops
    // touchstart propagation on its trigger, which would starve a handle nested beneath it.
    <ContextMenu disabled={binding === null} onOpenChangeComplete={(open) => { if (!open) binding?.onClosed(); }}>
      <ContextMenuTrigger
        render={<Frame variant="ghost" className="relative select-none p-0" data-testid="board-card-wrap" />}
        onTouchStart={(event) => {
          lastTouchAt.current = Date.now();
          event.preventBaseUIHandler();
        }}
        onContextMenu={(event) => {
          const nativeEvent = event.nativeEvent as MouseEvent & { pointerType?: string };
          const fromTouch = nativeEvent.pointerType === "touch" || Date.now() - lastTouchAt.current < 1000;
          if (fromTouch || menuConfig?.dragActive) {
            event.preventBaseUIHandler();
            event.preventDefault();
          }
        }}
      >
        <FramePanel className="flex flex-col p-0 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm">
          {cover}
          {binding && <CardActionsMenu projectId={project.id} street={project.street} menu={binding} />}
          <div className="flex flex-col gap-[var(--space-1)] p-[var(--space-3)]">
            {/* #428: the Archived filter's Include mode draws archived Projects beside active ones. The card is
                immovable (the Board gates it, `board.tsx`); the link still opens it. */}
            {archived && <Badge variant="secondary" size="sm" className="self-start" data-testid="board-card-archived">Archived</Badge>}
            <KanbanItemHandle
              // The street is the card's accessible name and the stretched hit area (`after:`), whose own
              // focus ring is drawn on the pseudo-element so it frames the whole card, not just the text.
              className="serif text-base tracking-tight leading-snug [text-wrap:pretty] no-underline text-inherit [touch-action:manipulation] after:absolute after:inset-0 focus-visible:!outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ink-900)] focus-visible:after:-outline-offset-2"
              cursor={!dragDisabled}
              {...LINK_ATTRIBUTE_OVERRIDES}
              render={<InternalLink ref={(element: HTMLAnchorElement | null) => handleRef?.(project.id, element)} to={href} data-testid="board-card" data-focus-key={`card:${project.id}`} />}
            >
              <span data-testid="board-card-address">{project.street}</span>
            </KanbanItemHandle>
            {shoot}
            {deadline}
          </div>
          {/* The star row is a sibling *outside* the link (#81): interactive controls cannot be <a>
              descendants — invalid HTML, and a click would navigate. Raised above the link's overlay. */}
          {/* One centre line for stars and avatars: no per-child bottom padding. The interactive stars' 36px cells are flush with the card's
              bottom edge; the read-only row and a stars-less row take the bottom gap from the footer instead. */}
          <div className={`relative z-[1] flex items-center justify-between ${canPrioritize ? "" : "pb-[var(--space-3)]"}`} data-testid="board-card-footer-slot">
            <PriorityStars
              priority={project.priority}
              street={project.street}
              canPrioritize={canPrioritize}
              pending={priorityPending}
              onPriorityChange={(next) => onPriorityChange?.(project, next)}
            />
            {/* #82: `editors` is already Editor-only, active-only and server-ordered (#79) — no client-side
                filter or sort. No Editors, no avatar slot: an empty dashed circle alone on a row read as
                a defect on most cards. */}
            {hasEditors && <div className="ml-auto px-[var(--space-3)]" data-testid="board-card-meta"><AvatarStack people={project.editors!} personNoun="Editor" emptyLabel="No Editor assigned" /></div>}
          </div>
          {coverFailed && (
            <Button
              type="button"
              variant="secondary"
              className="relative z-[1] mx-[var(--space-3)] mb-[var(--space-3)]"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCoverFailed(false); setCoverRetry((current) => current + 1); }}
            >
              Retry cover image
            </Button>
          )}
        </FramePanel>
      </ContextMenuTrigger>
      {binding && <CardContextMenuContent menu={binding} />}
      {menuConfig && <MoveToDialog project={project} open={moveToOpen} anchor={trigger} onClose={() => { pendingMoveTo.current = false; setMoveToOpen(false); }} {...menuConfig.moveTo} />}
    </ContextMenu>
  );
}
