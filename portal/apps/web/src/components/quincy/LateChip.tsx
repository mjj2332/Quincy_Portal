import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * #923: the late chip, lifted from the Timeline's bar trailing (`ProductionGanttBarContent.tsx`, frame 3a
 * `.chipbad`) so the Table and Board draw the same one (frames 4b/4e `.late`). Text, not colour alone: the
 * caller passes the wording from `lateLabel` ("2 days late") or a group's "N late", and the late colour is
 * 4.5:1 or better on the surface paper. Pass only what `lib/dashboard-project-appearance.ts` called late.
 */
export function LateChip({ size = "default", className, children, ...props }: ComponentProps<"span"> & {
  /**
   * `rail` is the Board's collapsed-column form: a 24px-wide vertical chip, its text reading bottom to top.
   * `line` is 20px tall (4g `.late`, `height:20px`) for the phone list's 20px Deadline line, where the 24px chip
   * made every late row 4px taller than its line (#923 polish). The Table grid and the Board keep `default`.
   */
  size?: "default" | "rail" | "line";
}) {
  return (
    <span
      data-testid="late-chip"
      data-size={size}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm border-[length:var(--border-width-hair)] border-late bg-card text-xs text-late",
        size === "rail"
          ? "w-6 rotate-180 justify-center px-0 py-[var(--space-2)] [writing-mode:vertical-rl]"
          : size === "line"
            ? "h-5 px-[var(--space-2)]"
            : "h-6 px-[var(--space-2)]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
