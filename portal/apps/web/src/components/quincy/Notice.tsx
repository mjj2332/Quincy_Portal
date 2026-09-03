import * as React from "react";

import { cn } from "@/lib/utils";

const NOTICE_BASE =
  "p-[var(--space-3)] border-solid border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

const NOTICE_TONE = {
  critical: "border-signal-critical/35 bg-signal-critical/7 text-signal-critical",
  positive: "border-signal-positive/35 bg-signal-positive/8 text-signal-positive",
};

type NoticeTone = keyof typeof NOTICE_TONE;

function Notice({ tone = "critical", className, ...props }: React.ComponentProps<"div"> & { tone?: NoticeTone }) {
  return <div data-slot="notice" className={cn(NOTICE_BASE, NOTICE_TONE[tone], className)} {...props} />;
}

export { Notice, NOTICE_BASE, NOTICE_TONE };
export type { NoticeTone };
