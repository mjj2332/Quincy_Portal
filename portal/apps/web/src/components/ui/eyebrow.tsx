import * as React from "react";

import { cn } from "@/lib/utils";

export function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary",
        className,
      )}
      {...props}
    />
  );
}
