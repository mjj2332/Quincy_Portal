import * as React from "react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/reui/badge";

// Nova supplies the shape (Badge's box/typography, here forced to a pill via `radius="full"`);
// Quincy supplies the tones. Nova's own semantic variants aren't reused for status colour:
// `styles/tokens/reui.css` records that `destructive-light` reads `--destructive-foreground`,
// which is warm paper shared with two live consumers, and that none of
// `--success/--info/--warning/--invert` are declared for `[data-surface="inverse"]`. Reconciling
// those is tracked as a #57 entry for Stage C, not done here.

// Written as an explicit literal union, not `keyof typeof PILL_TONE`: the latter is a genuine
// circular type reference once PILL_TONE itself is annotated `Record<StatusTone, string>`
// (TS2502/TS2456) — the two cannot be defined in terms of each other in either order.
type StatusTone = "positive" | "caution" | "critical" | "info" | "neutral";

const PILL_TONE: Record<StatusTone, string> = {
  positive: "text-signal-positive border-signal-positive/45 bg-signal-positive/8",
  // Text uses the darkened ochre, border and wash keep the brand value — see
  // `--signal-caution-text` in tokens/colors.css for why this tone alone needs the split.
  // `--signal-caution-text` measures 6.65:1 on `--paper-000`.
  caution:  "text-signal-caution-text border-signal-caution/45 bg-signal-caution/8",
  critical: "text-signal-critical border-signal-critical/45 bg-signal-critical/8",
  info:     "text-signal-info border-signal-info/45 bg-signal-info/8",
  neutral:  "text-foreground-secondary border-border bg-surface-sunken",
};

function StatusPill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return (
    <Badge
      data-slot="status-pill"
      radius="full"
      className={cn(PILL_TONE[tone], className)}
      {...props}
    />
  );
}

export { StatusPill };
export type { StatusTone };
