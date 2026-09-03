import * as React from "react";

import { cn } from "@/lib/utils";

function EmptyState({ title, tone = "empty", children, className, ...props }: {
  title: React.ReactNode;
  tone?: "empty" | "error";
  children?: React.ReactNode;
  className?: string;
} & React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "px-[var(--space-6)] py-[var(--space-8)]",
        tone === "error"
          ? "text-left ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive"
          : "text-center",
        className,
      )}
      {...props}
    >
      <strong className={cn(
        "block mb-[var(--space-3)] font-[var(--weight-regular)] tracking-[var(--tracking-tight)]",
        tone === "error" ? "[font:var(--type-h3)] text-destructive" : "[font:var(--type-h3)] text-foreground-secondary",
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
