import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../reui/button";
import type { StatusTone } from "./StatusPill";

/**
 * The phone review header (#879, D3, P1): back, the title with the Version chip under it, the approve button and ⋯, and nothing else. Staff and Guest reviewers compose the same bar;
 * what goes in each slot is the screen's (role gating stays there). The title slot keeps a floor so a crowded bar truncates it last.
 * #879 PR 3a: P1's 56pt bar (`HEADER_H`): `--space-7 + --space-2` tall with no vertical padding, `--space-1` gutters and gaps. The controls in it are drawn smaller than 44px
 * (the chip, Approve) and reach 44px with a transparent pseudo-element (`PHONE_BAR_TEXT_BUTTON`), all inside the bar.
 */
/** A text control in the bar (kit.jsx `ibtn sm`: the staff and Guest Approve): drawn 32px tall, with a 44px hit area from a transparent pseudo-element. */
export const PHONE_BAR_TEXT_BUTTON = "relative min-h-8 px-[var(--space-2)] after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";

/**
 * `step` (#936, staff only): the compact previous / next buttons, before Approve. `position` ("2 of 5") sits after the chip on the title's second line, since the bar has no room
 * for it beside the buttons at 390pt. The guest passes neither, and its bar is unchanged.
 */
export function ReviewPhoneBar({ back, title, chip, step, position, approve, actions }: { back: ReactNode; title: ReactNode; chip: ReactNode; step?: ReactNode; position?: string; approve?: ReactNode; actions?: ReactNode }) {
  return <header data-testid="review-phone-bar" className="flex h-[calc(var(--space-7)+var(--space-2))] flex-none flex-nowrap items-center gap-x-[var(--space-1)] border-b border-border bg-card px-[var(--space-1)] text-card-foreground">
    {back}
    {/* No leading control (a guest on a one-video link): P1/P2 always lead with the 44px back, and the bar's `--space-1` gutter alone left the title ~4pt from the edge (#879 PR 3a round 2). */}
    <div data-testid="review-phone-bar-title" className={cn("flex min-w-0 flex-1 flex-col items-start justify-center", back == null && "ps-[var(--space-3)]")}>
      {title}
      {position === undefined ? chip : <div className="flex max-w-full items-center gap-[var(--space-1)]">
        {chip}
        <span data-testid="review-phone-bar-position" className="flex-none whitespace-nowrap text-xs text-foreground-secondary tabular-nums">{position}</span>
      </div>}
    </div>
    {step}
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
 * #879 PR 3a: drawn as P1's 12px line (`h-5`), its 44px hit area a transparent `after:` reaching up over the title above it (which is not interactive), so the title and the chip stack in the 56pt bar.
 */
export function VersionChip({ label, tone, statusLabel, onClick, className, buttonRef }: { buttonRef?: Ref<HTMLButtonElement>; label: string; tone?: StatusTone | undefined; statusLabel?: string | undefined; onClick: () => void; className?: string }) {
  return <Button ref={buttonRef} type="button" variant="ghost" size="sm" data-testid="video-version-chip" aria-haspopup="dialog" className={cn("relative -ms-[var(--space-2)] h-5 flex-none whitespace-nowrap gap-[var(--space-1)] px-[var(--space-2)] py-0 text-xs text-foreground-secondary normal-case tracking-normal after:absolute after:inset-x-0 after:-top-[var(--space-5)] after:bottom-0 after:content-['']", className)} onClick={onClick}>
    {tone !== undefined && <span aria-hidden="true" data-testid="video-version-chip-dot" data-tone={tone} className={cn("size-2 flex-none rounded-full", DOT[tone])} />}
    {statusLabel !== undefined && <span className="sr-only">{`Review status: ${statusLabel}. `}</span>}
    <span>{label}</span>
    <ChevronDown aria-hidden="true" className="size-3 flex-none" />
  </Button>;
}
