import * as React from "react";

import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/quincy/Eyebrow";

function SectionHead({ eyebrow, id, children, actions, className }: {
  eyebrow?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="section-head"
      className={cn(
        "flex flex-wrap items-end justify-between gap-[var(--space-4)]",
        "[border-top-style:solid] border-t-[length:var(--border-width-rule)] border-t-primary",
        "pt-[var(--space-4)] mb-[var(--space-5)]",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="block mb-[var(--space-2)]">{eyebrow}</Eyebrow> : null}
        <h2 id={id} className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground text-pretty">
          {children}
        </h2>
      </div>
      {actions ? <div className="flex items-center gap-[var(--space-3)] shrink-0">{actions}</div> : null}
    </div>
  );
}

export { SectionHead };
