import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../reui/button";
import type { StatusTone } from "./StatusPill";

/**
 * The phone review header (#879, D3, P1): back, the title with the Version chip under it, the approve button and ⋯, and nothing else. Staff and Guest reviewers compose the same bar;
 * what goes in each slot is the screen's (role gating stays there). The title slot keeps a floor so a crowded bar truncates it last.
 */
export function ReviewPhoneBar({ back, title, chip, approve, actions }: { back: ReactNode; title: ReactNode; chip: ReactNode; approve?: ReactNode; actions?: ReactNode }) {
  return <header data-testid="review-phone-bar" className="flex min-h-12 flex-nowrap items-center gap-x-[var(--space-2)] border-b border-border bg-card px-[var(--space-3)] py-[var(--space-1)] text-card-foreground">
    {back}
    <div className="flex min-w-0 flex-1 flex-col items-start justify-center">
      {title}
      {chip}
    </div>
    {approve}
    {actions}
  </header>;
}

const DOT: Record<StatusTone, string> = {
  positive: "bg-signal-positive", caution: "bg-signal-caution", critical: "bg-signal-critical", info: "bg-signal-info", neutral: "bg-border",
};

/**
 * The Version chip (D3): `v3 · latest` and a chevron on a ghost button that opens the Versions sheet. Staff get the Review status as a dot on it (its words are spoken: "Review status: …");
 * guests get no dot. Reuse: `reui/button` (ghost), the `quincy/StatusPill` tone tokens for the dot.
 */
export function VersionChip({ label, tone, statusLabel, onClick, className, buttonRef }: { buttonRef?: Ref<HTMLButtonElement>; label: string; tone?: StatusTone | undefined; statusLabel?: string | undefined; onClick: () => void; className?: string }) {
  return <Button ref={buttonRef} type="button" variant="ghost" size="sm" data-testid="video-version-chip" aria-haspopup="dialog" className={cn("-ms-[var(--space-2)] h-auto min-h-11 max-w-full gap-[var(--space-1)] px-[var(--space-2)] py-0 text-foreground-secondary [font:var(--type-label)]", className)} onClick={onClick}>
    {tone !== undefined && <span aria-hidden="true" data-testid="video-version-chip-dot" data-tone={tone} className={cn("size-2 flex-none rounded-full", DOT[tone])} />}
    {statusLabel !== undefined && <span className="sr-only">{`Review status: ${statusLabel}. `}</span>}
    <span className="truncate">{label}</span>
    <ChevronDown aria-hidden="true" className="size-3.5 flex-none" />
  </Button>;
}
