import { useState, type ReactNode } from "react";
import { isDeadlineOverdue } from "@quincy/shared";
import { Card, CardContent } from "../reui/card";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "../reui/avatar";
import { InternalLink } from "../InternalLink";
import { LazyImage } from "../LazyImage";
import { buttonClasses } from "../quincy/Button";
import { KanbanItemHandle } from "../reui/kanban";
import { PriorityStars } from "../quincy/PriorityStars";
import { deadlineLabel } from "../../lib/deadline-label";
import { initials } from "../../lib/initials";
import type { ProjectSummary } from "../../lib/kanban-interaction";

/**
 * Card slot mapping (issue #76): "company logo" -> the Project's cover photo, "company name" ->
 * street, "deal value" -> Deadline, "owner avatar" -> the Editor stack, "counts" -> received/
 * expected RAW (#82). Star rating (#81) and the block's "next step" slot remain deliberately
 * unfilled — the latter is dropped rather than invented, per #76/#82.
 *
 * The drag handle is a small sibling button, not the whole card: `ProjectKanbanBoard.tsx`'s own
 * `KanbanCard` carries the same split deliberately, "so ordinary anchor behavior remains
 * browser-native" — dnd-kit's pointer sensor sits on the handle only, leaving `InternalLink`'s
 * click-to-navigate alone.
 */

function CoverMedia({
  project,
  retryToken,
  onFailedChange,
}: {
  project: ProjectSummary;
  retryToken?: number;
  onFailedChange?: (failed: boolean) => void;
}) {
  if (project.coverAssetId) {
    return <LazyImage className="size-full object-cover" preload="background" assetId={project.coverAssetId} alt={`Preview of ${project.street}`} retryToken={retryToken} onFailedChange={onFailedChange} />;
  }
  const content = project.street.trim().charAt(0).toUpperCase() || "Q";
  return <div className="project-cover-placeholder size-full" aria-hidden="true">{content}</div>;
}

/**
 * RAW counts (#82). Branches on `expectedCount === null`, not truthiness — `expectedCount: 0` is
 * meaningful and must still render `0/0`. The visible string and the spoken one are split because
 * "12/40" is read aloud as "twelve slash forty" (NVDA) or "twelve forty" (VoiceOver); the idiom
 * matches `SubtaskChecklist.tsx`'s assignee-initials pattern (`aria-hidden` glyph + `sr-only` text
 * as siblings).
 */
function rawCounts(project: ProjectSummary): { visible: string; spoken: string } {
  const { receivedCount, expectedCount } = project;
  if (expectedCount === null) {
    return { visible: `${receivedCount}`, spoken: `${receivedCount} RAW files received, expected count unknown` };
  }
  return { visible: `${receivedCount}/${expectedCount}`, spoken: `${receivedCount} of ${expectedCount} RAW files received` };
}

const EDITOR_STACK_LIMIT = 3;

/**
 * Editor avatar stack (#82). `editors` is already Editor-only, active-only and server-ordered
 * (#79) — no client-side filter or sort. `role="img"` on each avatar is load-bearing: `aria-label`
 * on a roleless `<span>` is dropped by every major screen reader. The full list beyond the first
 * three is deliberately not reachable from the card — the linked Project detail is the authority.
 */
function EditorStack({ editors }: { editors?: { id: string; name: string }[] }) {
  const list = editors ?? [];
  if (list.length === 0) {
    return (
      <span
        role="img"
        aria-label="No Editor assigned"
        className="inline-block size-6 shrink-0 rounded-full border border-dashed border-[var(--border-hairline)] bg-transparent"
      />
    );
  }
  const shown = list.slice(0, EDITOR_STACK_LIMIT);
  const overflow = list.length - shown.length;
  return (
    // Static, non-interactive avatars — the 44px touch-target contract does not apply here and
    // should not be "fixed" by a future pass.
    <AvatarGroup>
      {shown.map((editor) => {
        const name = editor.name.trim();
        const empty = name === "";
        return (
          <Avatar key={editor.id} size="sm" role="img" aria-label={empty ? "Editor (name unavailable)" : name}>
            <AvatarFallback aria-hidden="true">{empty ? "?" : initials(editor.name)}</AvatarFallback>
          </Avatar>
        );
      })}
      {overflow > 0 && (
        <AvatarGroupCount role="img" aria-label={`${overflow} more Editor${overflow === 1 ? "" : "s"}`}>
          <span aria-hidden="true">+{overflow}</span>
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  );
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
  /**
   * Registers this card's drag handle with the Board, which refocuses it on the paths dnd-kit no
   * longer covers (see `board.tsx`'s `restoreFocus: false`). A ref rather than a
   * `querySelector('[data-focus-key=…]')` so the Board's focus path carries no DOM-query coupling.
   */
  handleRef?: (projectId: string, element: HTMLButtonElement | null) => void;
  /**
   * The Board's non-drag Move-to control (#99). A slot rather than a component the card builds, so
   * the card stays presentation-only. Never rendered in the drag overlay, which must carry no
   * interactive element (#98).
   */
  moveTo?: ReactNode;
};

/**
 * Composed on the `card` surface (#76 "Block and surface"). Quincy's `--radius-card` is 0, so
 * the corners render square — that is correct, not a porting defect.
 */
export function KanbanCard2({ project, projectHref, isOverlay = false, dragDisabled = false, canPrioritize = false, priorityPending = false, onPriorityChange, handleRef, moveTo }: KanbanCard2Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);
  const overdue = isDeadlineOverdue(project.deadlineAt);
  const projectDeadlineLabel = deadlineLabel(project);
  const raw = rawCounts(project);

  const cardBody = (
    <>
      <div className="aspect-video overflow-hidden bg-[var(--ink-800)]">
        <CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} />
      </div>
      <CardContent className="p-[var(--space-3)]">
        <div className="serif text-base tracking-tight leading-snug [text-wrap:pretty]" data-testid="kanban2-card-address">{project.street}</div>
        {projectDeadlineLabel && (
          // Prominence is bought with contrast and position, not size (#82) — the street stays
          // the card's title; this is the only line below it at full `foreground`.
          <time
            className={`block mt-[var(--space-1)] text-sm tabular-nums ${overdue ? "text-[var(--signal-critical)]" : "text-foreground"}`}
            data-testid="kanban2-card-deadline"
            dateTime={new Date(project.deadlineAt!).toISOString()}
          >
            {overdue ? "Overdue" : "Due"} {projectDeadlineLabel} Sydney
          </time>
        )}
        <div className="flex items-center justify-between gap-[var(--space-2)] mt-[var(--space-3)] text-xs text-foreground-secondary" data-testid="kanban2-card-meta">
          <span className="text-xs tabular-nums text-foreground-secondary" data-testid="kanban2-card-raw">
            <span aria-hidden="true">{raw.visible}</span>
            <span className="sr-only">{raw.spoken}</span>
          </span>
          <EditorStack editors={project.editors} />
        </div>
      </CardContent>
    </>
  );

  return (
    <Card size="sm" className="relative gap-0 p-0 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm" data-testid="kanban2-card-wrap">
      {isOverlay ? (
        // The floating overlay follows the pointer/keyboard focus but is not itself a real card:
        // it must carry no interactive element at all (#98), so it renders the same visual content
        // in a plain, non-hit-testing, assistive-tech-hidden wrapper instead of `InternalLink`.
        <div className="block pointer-events-none no-underline text-inherit" data-testid="kanban2-card-overlay" aria-hidden="true">
          {cardBody}
        </div>
      ) : (
        <InternalLink className="block no-underline text-inherit" data-testid="kanban2-card" to={projectHref ?? `/projects/${encodeURIComponent(project.id)}`}>
          {cardBody}
        </InternalLink>
      )}
      {/* The star row is a sibling *outside* the anchor (#81): interactive controls cannot be <a>
          descendants — invalid HTML, and a click would navigate. In the drag overlay it is
          presentation-only, so it is dropped entirely rather than rendered non-focusable. */}
      <div data-testid="kanban2-card-footer-slot">
        {!isOverlay && (
          <PriorityStars
            priority={project.priority}
            street={project.street}
            canPrioritize={canPrioritize}
            pending={priorityPending}
            onPriorityChange={(next) => onPriorityChange?.(project, next)}
          />
        )}
      </div>
      {!isOverlay && moveTo}
      {!isOverlay && (
        // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token — matching the
        // existing Board's handle (`ProjectKanbanBoard.tsx`).
        <KanbanItemHandle
          className="absolute top-[var(--space-2)] right-[var(--space-2)] z-[2] size-9 max-[641px]:size-11 pointer-coarse:size-11 inline-grid place-items-center border border-[color-mix(in_srgb,var(--ink-900)_18%,transparent)] rounded-[var(--radius-sm)] bg-[color-mix(in_srgb,var(--paper-000)_88%,transparent)] text-foreground-secondary text-[20px] leading-none [touch-action:none] focus-visible:!outline-2 focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-2"
          cursor={!dragDisabled}
          render={<button ref={(element) => handleRef?.(project.id, element)} type="button" data-testid="kanban2-card-handle" data-focus-key={`move-handle:${project.id}`} aria-label={`Move ${project.street}`} disabled={dragDisabled} />}
        >
          <span aria-hidden="true">⠿</span>
        </KanbanItemHandle>
      )}
      {coverFailed && !isOverlay && (
        <button
          type="button"
          className={buttonClasses("secondary", { className: "mx-[var(--space-3)] mb-[var(--space-3)]" })}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); setCoverFailed(false); setCoverRetry((current) => current + 1); }}
        >
          Retry cover image
        </button>
      )}
    </Card>
  );
}
