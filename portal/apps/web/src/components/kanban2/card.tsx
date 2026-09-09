import { useState } from "react";
import { Card, CardContent } from "../reui/card";
import { InternalLink } from "../InternalLink";
import { LazyImage } from "../LazyImage";
import { buttonClasses } from "../quincy/Button";
import { KanbanItemHandle } from "../reui/kanban";
import type { ProjectSummary } from "../../lib/kanban-interaction";

/**
 * Card slot mapping (issue #76): "company logo" -> the Project's cover photo, "company name" ->
 * street. Every other kanban-board-3 slot (deal value, next step, owner avatar, star rating,
 * counts) belongs to a later ticket (#81 priority stars, #82 Editor avatars/Deadline/RAW) and is
 * deliberately left unfilled rather than invented here.
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

export type KanbanCard2Props = {
  project: ProjectSummary;
  projectHref?: string;
  isOverlay?: boolean;
  dragDisabled?: boolean;
};

/**
 * Composed on the `card` surface (#76 "Block and surface"). Quincy's `--radius-card` is 0, so
 * the corners render square — that is correct, not a porting defect.
 */
export function KanbanCard2({ project, projectHref, isOverlay = false, dragDisabled = false }: KanbanCard2Props) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRetry, setCoverRetry] = useState(0);

  return (
    <Card size="sm" className="relative gap-0 p-0 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm" data-testid="kanban2-card-wrap">
      <InternalLink className="block no-underline text-inherit" data-testid="kanban2-card" to={projectHref ?? `/projects/${encodeURIComponent(project.id)}`}>
        <div className="aspect-video overflow-hidden bg-[var(--ink-800)]">
          <CoverMedia project={project} retryToken={coverRetry} onFailedChange={setCoverFailed} />
        </div>
        <CardContent className="p-[var(--space-3)]">
          <div className="serif text-base tracking-tight leading-snug [text-wrap:pretty]" data-testid="kanban2-card-address">{project.street}</div>
        </CardContent>
      </InternalLink>
      {!isOverlay && (
        // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token — matching the
        // existing Board's handle (`ProjectKanbanBoard.tsx`).
        <KanbanItemHandle
          className="absolute top-[var(--space-2)] right-[var(--space-2)] z-[2] size-9 max-[641px]:size-11 pointer-coarse:size-11 inline-grid place-items-center border border-[color-mix(in_srgb,var(--ink-900)_18%,transparent)] rounded-[var(--radius-sm)] bg-[color-mix(in_srgb,var(--paper-000)_88%,transparent)] text-foreground-secondary text-[20px] leading-none [touch-action:none] focus-visible:!outline-2 focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-2"
          cursor={!dragDisabled}
          render={<button type="button" data-testid="kanban2-card-handle" aria-label={`Move ${project.street}`} disabled={dragDisabled} />}
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
