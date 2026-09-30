import { UserPlus } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * The editable empty state of an assignee control: a dashed circle on the visible `--border` (the
 * `--border-hairline` of `AvatarStack`'s own empty circle was near-invisible, ~1.7:1) with an add-person icon, the
 * dashed-trigger idiom of `project-header-popover.ts`. Decorative: the control that wraps it carries the accessible name.
 * Extracted from `ProductionGanttProjectCells` so the Project team trigger and `SubtaskAssigneePicker` share one glyph.
 */
export function EmptyAssigneeGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="empty-assignee-glyph"
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-foreground-secondary", className)}
    >
      <UserPlus className="size-3.5" strokeWidth={1.5} />
    </span>
  );
}
