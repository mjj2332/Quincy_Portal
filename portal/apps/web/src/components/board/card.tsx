import { useRef, useState, type CSSProperties } from "react";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { ContextMenu, ContextMenuTrigger } from "../reui/context-menu";
import { Frame, FramePanel } from "../reui/frame";
import { AvatarStack } from "../quincy/AvatarStack";
import { DoneProgress } from "../quincy/DoneProgress";
import { LateChip } from "../quincy/LateChip";
import { InternalLink } from "../InternalLink";
import { LazyImage } from "../LazyImage";
import { KanbanItemHandle } from "../reui/kanban";
import { PriorityStars } from "../quincy/PriorityStars";
import { formatSydneyCivil } from "@quincy/shared";
import { civilDayText, deadlineTriggerText } from "../ProjectHeaderDeadline";
import { projectAppearance, type ProjectAppearance } from "../../lib/dashboard-project-appearance";
import type { ProjectSummary } from "../../lib/kanban-interaction";
import { CardActionsMenu, CardContextMenuContent, type CardMenuBinding, type CardMenuConfig } from "./card-menu";

/**
 * The Board card (#432), composed on ReUI `frame` the way `solution-crm-7/board-card.tsx` is: a
 * ghost `Frame` holding one `FramePanel`. Since #923 it is frame 4e's compact card everywhere
 * (`design/prototypes/dashboard-views`, "Dashboard views v4", `cardCompact`; 4d is not built):
 *
 * - a 3px edge in the Stage tone across the top (`.card::before`), dashed for Awaiting RAW;
 * - row 1: a 44x30 thumb, the street over "Suburb · Shoot Tue 20 Oct", and the ⋯;
 * - row 2: the Deadline, in the late colour with the "N days late" chip once late, or "Today · 17:00" behind a dot;
 * - "N of M done" over a bar in the Stage tone, only when the API sent a `checklist` (#923 D1);
 * - the footer: the stars, then the Editor avatars.
 *
 * Every colour and every late or done figure comes from `projectAppearance` (#923 plan § Shared rules), never
 * derived here. No dashed "No editor" avatar (#82, D4), no RAW count.
 *
 * The whole card is the drag handle, but NOT by wrapping it in `KanbanItemHandle` the way the block
 * does. dnd-kit's handle attributes default to `role="button"`, and a `role="button"` ancestor
 * prunes the stars' nested `role="radiogroup"` from the accessibility tree (#81, `docs/lessons.md`).
 * Instead the card's single `InternalLink` IS the handle, stretched over the whole panel with an
 * `after:` overlay (it resolves against `FramePanel`, the nearest positioned ancestor, so nothing between
 * them may be positioned), so a press anywhere on the card lands on it. The stars and the ⋯ are
 * siblings of the link, raised above the overlay with `z-[1]`: outside the handle, so pressing
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
  /** The clock lateness and "today" are judged against (the Dashboard's `useNow`); defaults to the wall clock. */
  now?: number;
  /**
   * Registers this card's link (its drag handle) with the Board, which refocuses it on the paths
   * dnd-kit no longer covers (see `board.tsx`'s `restoreFocus: false`). A ref rather than a
   * `querySelector('[data-focus-key=…]')` so the Board's focus path carries no DOM-query coupling.
   */
  handleRef?: (projectId: string, element: HTMLAnchorElement | null) => void;
  /**
   * The ⋯ menu and the right-click menu (#432, #470): Move to ▸ Stage, from one config. Never rendered in the
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

/** Frame 4e `.card.k-late`: a late card's edge takes a share of the late colour over the hairline. */
const LATE_PANEL_CLASS = "[--frame-panel-border-color:color-mix(in_srgb,var(--late)_35%,var(--border))]";

/** The card's top edge (`.card::before`): solid in the Stage tone, or dashed for Awaiting RAW's hollow tone. */
function StageEdge({ tone }: { tone: ProjectAppearance["tone"] }) {
  const dashed = tone.treatment === "hollow-dashed";
  return (
    <span
      aria-hidden="true"
      data-testid="board-card-edge"
      data-treatment={dashed ? "hollow-dashed" : "solid"}
      className={`pointer-events-none absolute inset-x-0 top-0 z-[1] border-t-[length:var(--border-width-rule)] border-(--card-tone) ${dashed ? "border-dashed" : "border-solid"}`}
      style={{ "--card-tone": tone.color } as CSSProperties}
    />
  );
}

/** "Suburb · Shoot Tue 20 Oct", either half alone, or nothing with neither. */
function metaLine(project: ProjectSummary): string | null {
  const parts = [project.suburb?.trim() || null, project.shootDate ? `Shoot ${civilDayText(project.shootDate)}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function KanbanCard2({ project, projectHref, isOverlay = false, dragDisabled = false, canPrioritize = false, priorityPending = false, onPriorityChange, now, handleRef, menu }: KanbanCard2Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);
  // Delivered and archived Projects are never late (the module's rule), so the card and its column agree.
  const appearance = projectAppearance(project, now ?? Date.now());
  const late = appearance.lateness.late;
  // The studio civil string ("2026-10-19T17:00"); `formatSydneyCivil` only covers a summary that predates `deadlineLocalCivil`.
  const deadlineCivil = project.deadlineAt === null ? null : (project.deadlineLocalCivil ?? formatSydneyCivil(project.deadlineAt));
  const archived = Boolean(project.archivedAt);
  const hasEditors = (project.editors?.length ?? 0) > 0;
  const href = projectHref ?? `/projects/${encodeURIComponent(project.id)}`;
  const menuConfig = !archived && menu ? menu : null;
  // A chosen Stage is a MOVE: the optimistic overlay remounts this card in another column while the
  // menu is still closing, so the menu's own focus return to this card's ⋯ trigger would land on a
  // node that is leaving. It is withheld, and the Dashboard's restore effect focuses the ⋯ in the
  // card's new column instead. Reset once the menu has finished closing.
  const chose = useRef(false);
  const binding: CardMenuBinding | null = menuConfig && {
    menu: menuConfig,
    returnFocus: () => !chose.current,
    onChoose: (stageKey) => {
      chose.current = true;
      menuConfig.onMoveStage(stageKey);
    },
    onClosed: () => { chose.current = false; },
  };
  // Base UI opens its context menu on a 500ms touch long-press, which would open over a live drag
  // (the card's own long-press is the drag, 250ms). Touch gets the ⋯ menu instead.
  const lastTouchAt = useRef(0);

  const today = appearance.dueToday && deadlineCivil !== null;
  // Frame 4e `.cd`: the date alone on screen; "Due" is for a screen reader. "Today · 17:00" for a Deadline later today.
  const deadline = deadlineCivil !== null && (
    <div className="flex flex-wrap items-center gap-2">
      <time
        className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm tabular-nums ${late ? "text-late" : "text-foreground"}`}
        data-testid="board-card-deadline"
        data-today={today ? "true" : undefined}
        dateTime={new Date(project.deadlineAt!).toISOString()}
      >
        <span className="sr-only" data-testid="board-card-deadline-prefix">Due </span>
        {today && <span aria-hidden="true" data-testid="board-card-today-dot" className="size-1.5 shrink-0 rounded-full bg-foreground" />}
        {today ? `Today · ${deadlineCivil.slice(11, 16)}` : deadlineTriggerText(deadlineCivil)}
      </time>
      {appearance.lateLabel !== null && <LateChip>{appearance.lateLabel}</LateChip>}
    </div>
  );
  const meta = metaLine(project);
  const metaText = meta !== null && <span className="truncate text-xs text-foreground-secondary" data-testid="board-card-shoot">{meta}</span>;
  // Frame 4e `.cv.th`: 44x30, the 4px corner.
  const cover = (
    <div className="h-7.5 w-11 shrink-0 overflow-hidden rounded-sm bg-[var(--ink-800)]" data-testid="board-card-cover">
      <CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} placeholderClassName="!text-sm" />
    </div>
  );
  // #923 D1: progress only when the API sent `checklist`; `{0,0}` is "No tasks", absent is nothing.
  const progress = project.checklist !== undefined && (
    <DoneProgress done={appearance.done} tone={appearance.tone} known={project.checklist !== undefined} />
  );
  const avatars = hasEditors && (
    // #82: `editors` is already Editor-only, active-only and server-ordered (#79). No Editors, no avatar slot (D4).
    <div className="ml-auto flex shrink-0 items-center" data-testid="board-card-meta"><AvatarStack people={project.editors!} personNoun="Editor" emptyLabel="No Editor assigned" /></div>
  );
  const panelClass = `flex flex-col gap-2 px-3 pt-3 pb-0 shadow-xs ${late ? LATE_PANEL_CLASS : ""}`;

  if (isOverlay) {
    // The floating overlay follows the pointer/keyboard focus but is not itself a real card: it must
    // carry no interactive element at all (#98), so it renders the same visual content in a plain,
    // non-hit-testing, assistive-tech-hidden wrapper instead of the link.
    return (
      <Frame variant="ghost" className="relative p-0" data-testid="board-card-wrap" data-late={late ? "true" : undefined}>
        <FramePanel className={panelClass}>
          <StageEdge tone={appearance.tone} />
          <div className="pointer-events-none flex flex-col gap-2 pb-3" data-testid="board-card-overlay" aria-hidden="true">
            {archived && <Badge variant="secondary" size="sm" className="self-start">Archived</Badge>}
            <div className="flex min-w-0 items-center gap-2.5">
              {cover}
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-sm" data-testid="board-card-address">{project.street}</span>
                {metaText}
              </div>
            </div>
            {deadline}
            {progress}
            {avatars && <div className="flex items-center">{avatars}</div>}
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
        render={<Frame variant="ghost" className="relative select-none p-0" data-testid="board-card-wrap" data-late={late ? "true" : undefined} />}
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
        <FramePanel className={`${panelClass} transition-[border-color,box-shadow] hover:shadow-sm`}>
          <StageEdge tone={appearance.tone} />
          {/* #428: the Archived filter's Include mode draws archived Projects beside active ones. The card is
              immovable (the Board gates it, `board.tsx`); the link still opens it. */}
          {archived && <Badge variant="secondary" size="sm" className="self-start" data-testid="board-card-archived">Archived</Badge>}
          <div className="flex min-w-0 items-center gap-2.5" data-testid="board-card-title-row">
            {cover}
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <KanbanItemHandle
                // The street is the card's accessible name and the stretched hit area (`after:`), whose own
                // focus ring is drawn on the pseudo-element so it frames the whole card, not just the text.
                className="truncate text-sm no-underline text-inherit [touch-action:manipulation] after:absolute after:inset-0 focus-visible:!outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--focus-ring)] after:-outline-offset-2 focus-visible:after:-outline-offset-2"
                cursor={!dragDisabled}
                {...LINK_ATTRIBUTE_OVERRIDES}
                render={<InternalLink ref={(element: HTMLAnchorElement | null) => handleRef?.(project.id, element)} to={href} data-testid="board-card" data-focus-key={`card:${project.id}`} />}
              >
                <span data-testid="board-card-address">{project.street}</span>
              </KanbanItemHandle>
              {metaText}
            </div>
            {binding && <CardActionsMenu projectId={project.id} street={project.street} binding={binding} />}
          </div>
          {deadline}
          {progress}
          {/* The footer is a sibling *outside* the link (#81): interactive controls cannot be <a> descendants
              (invalid HTML, and a click would navigate). Raised above the link's overlay. Frame 4e puts "N of M
              done" in this row too, but the stars keep their 36px (44px on touch) cells (ADR 0003, #923 D4): 180px
              plus the avatars leaves no room for it in a working column, so it sits on its own row above. The
              interactive cells sit flush with the card's bottom edge; a read-only or stars-less row takes the
              bottom gap instead. */}
          <div className={`relative z-[1] flex items-center gap-2 ${canPrioritize ? "" : "pb-3"}`} data-testid="board-card-footer-slot">
            <PriorityStars
              priority={project.priority}
              street={project.street}
              canPrioritize={canPrioritize}
              pending={priorityPending}
              onPriorityChange={(next) => onPriorityChange?.(project, next)}
            />
            {avatars}
          </div>
          {coverFailed && (
            <Button
              type="button"
              variant="secondary"
              className="relative z-[1] mb-3"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCoverFailed(false); setCoverRetry((current) => current + 1); }}
            >
              Retry cover image
            </Button>
          )}
        </FramePanel>
      </ContextMenuTrigger>
      {binding && <CardContextMenuContent binding={binding} />}
    </ContextMenu>
  );
}
