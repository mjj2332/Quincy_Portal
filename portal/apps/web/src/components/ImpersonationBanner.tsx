import { useState, type JSX } from "react";
import { ROLE_LABELS, type Role } from "@quincy/shared";
import { stopImpersonating, useSession } from "../lib/auth";
import { locationStore } from "../lib/router";
import { buttonClasses } from "./quincy/Button";

export type ImpersonationBannerProps = {
  user: { name: string; role: Role };
  invalidated: boolean;
};

const EXIT_ERROR = "Could not automatically exit. Sign out completely and sign back in as Admin to restore your session.";

// The banner is a fixed ink strip above the shell header. Its height is `--impersonation-banner-height`
// (tokens/spacing.css), the one value every `.app--impersonating` offset in app.css reads too.
// It sits below `--z-dialog` on purpose (#531): the long-lived sheets start under it, while a dialog
// or alert still covers it, so Exit is never mouse-reachable behind a focus-trapped modal.
const BANNER = "fixed inset-x-0 top-0 z-[76] flex items-center " +
  "gap-[var(--space-3)] h-[var(--impersonation-banner-height)] overflow-hidden px-[var(--space-6)] " +
  "bg-surface-inverse text-on-inverse [--focus-ring:var(--text-on-inverse)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)]";

const IDENTITY = "impersonation-banner__identity min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

// Exit sits on ink, so every colour `VARIANT.text` sets has to be inverted — including the
// disabled colour from BASE and the ghost hover fill: `hover:bg-muted` would paint a cream pill
// behind the paper label (#541). The banner is not a `data-surface="inverse"` scope, so inverse.css
// does not remap `--muted`; `hover:bg-transparent` replaces it via twMerge, and the muted→full
// on-inverse text change is the hover feedback. The focus ring is inverted at the surface, not here: BANNER sets
// `--focus-ring` to the paper text role, so the global `:focus-visible` ring (and the rest-state
// `outline-color` from base.css, #532) is already paper on this ink strip. No outline override is
// needed on the button. `cn` is twMerge-backed, so these later utilities replace the earlier ones
// within each variant key (§2.1).
const EXIT = buttonClasses("text", {
  className: "!text-on-inverse-muted hover:bg-transparent hover:not-disabled:!text-on-inverse " +
    "disabled:!text-on-inverse-muted disabled:bg-transparent disabled:border-transparent",
});

const ERROR = "flex-[1_1_160px] min-w-0 overflow-hidden " +
  "text-signal-critical normal-case tracking-normal text-ellipsis whitespace-nowrap " +
  "[font:var(--weight-regular)_var(--text-xs)/1.35_var(--font-sans)]";

export function ImpersonationBanner({ user, invalidated }: ImpersonationBannerProps): JSX.Element {
  const session = useSession();
  const [isExiting, setIsExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exit() {
    if (isExiting) return;
    setIsExiting(true);
    setError(null);
    try {
      await stopImpersonating();
      await session.refetch();
      locationStore().replace("/");
    } catch {
      setError(EXIT_ERROR);
      setIsExiting(false);
    }
  }

  return <aside className={BANNER} aria-label="Impersonation status" data-invalidated={invalidated ? "true" : undefined}>
    <span className={IDENTITY}>Acting as {user.name} ({ROLE_LABELS[user.role]}) · </span>
    <button className={EXIT} type="button" disabled={isExiting} onClick={() => void exit()} data-testid="impersonation-exit">Exit</button>
    {error && <span className={ERROR} role="alert" title={error}>{error}</span>}
  </aside>;
}
