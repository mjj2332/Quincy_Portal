import * as React from "react";
import { cn } from "@/lib/utils";

const PILL_BASE =
  "inline-flex items-center whitespace-nowrap px-[var(--space-2)] py-[4px] " +
  "rounded-[var(--radius-pill)] border-solid border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]";

// Written as an explicit literal union, not `keyof typeof PILL_TONE`: the latter is a genuine
// circular type reference once PILL_TONE itself is annotated `Record<StatusTone, string>`
// (TS2502/TS2456) — the two cannot be defined in terms of each other in either order.
type StatusTone = "positive" | "caution" | "critical" | "info" | "neutral";

const PILL_TONE: Record<StatusTone, string> = {
  positive: "text-signal-positive border-signal-positive/45 bg-signal-positive/8",
  // Text uses the darkened ochre, border and wash keep the brand value — see
  // `--signal-caution-text` in tokens/colors.css for why this tone alone needs the split.
  caution:  "text-signal-caution-text border-signal-caution/45 bg-signal-caution/8",
  critical: "text-signal-critical border-signal-critical/45 bg-signal-critical/8",
  info:     "text-signal-info border-signal-info/45 bg-signal-info/8",
  neutral:  "text-foreground-secondary border-border bg-surface-sunken",
};

function StatusPill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return <span data-slot="status-pill" className={cn(PILL_BASE, PILL_TONE[tone], className)} {...props} />;
}

export { StatusPill, PILL_BASE };
export type { StatusTone };
