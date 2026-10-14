import * as React from "react";

import { cn } from "@/lib/utils";

const NOTICE_BASE =
  "p-[var(--space-3)] border-solid border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

const NOTICE_TONE = {
  critical: "border-signal-critical/35 bg-signal-critical/7 text-destructive-wash-foreground",
  positive: "border-signal-positive/35 bg-signal-positive/8 text-success-foreground",
  // Text takes the darkened ochre, border and wash keep the brand value — the same split
  // `StatusPill` makes, and for the same reason: `--signal-caution` is the one signal too
  // light to carry small text (see `--signal-caution-text` in tokens/colors.css).
  // `--warning-foreground` resolves to `--signal-caution-text` (6.65:1 on `--paper-000`) on paper and to the on-inverse amber on a dark viewer; the tone text roles re-scope with the surface (ADR 0024).
  caution: "border-signal-caution/35 bg-signal-caution/7 text-warning-foreground",
};

type NoticeTone = keyof typeof NOTICE_TONE;

function Notice({ tone = "critical", className, ...props }: React.ComponentProps<"div"> & { tone?: NoticeTone }) {
  return <div data-slot="notice" className={cn(NOTICE_BASE, NOTICE_TONE[tone], className)} {...props} />;
}

export { Notice, NOTICE_BASE, NOTICE_TONE };
export type { NoticeTone };
