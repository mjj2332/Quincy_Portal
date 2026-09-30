import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `size="compact"` (#376) is one quiet line for a feed that already has its composer above it: no
 * centring, no h3 title scale, no title margin. The default output is unchanged (20 consumers).
 */
function EmptyState({ title, tone = "empty", size = "default", children, className, ...props }: {
  title: React.ReactNode;
  tone?: "empty" | "error";
  size?: "default" | "compact";
  children?: React.ReactNode;
  className?: string;
} & React.ComponentProps<"div">) {
  const compact = size === "compact";
  return (
    <div
      data-slot="empty-state"
      className={cn(
        compact ? "px-0 py-[var(--space-3)]" : "px-[var(--space-6)] py-[var(--space-8)]",
        tone === "error"
          ? "text-left ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive"
          : compact ? "text-left" : "text-center",
        className,
      )}
      {...props}
    >
      <strong className={cn(
        compact
          ? "block font-[var(--weight-regular)]"
          : "block mb-[var(--space-3)] font-[var(--weight-regular)] tracking-[var(--tracking-tight)]",
        compact
          ? cn("[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]", tone === "error" ? "text-destructive" : "text-foreground-secondary")
          : tone === "error" ? "[font:var(--type-h3)] text-destructive" : "[font:var(--type-h3)] text-foreground-secondary",
      )}>
        {title}
      </strong>
      {children ? (
        <div className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export { EmptyState };
