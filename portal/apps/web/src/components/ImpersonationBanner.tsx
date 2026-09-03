import { useState, type JSX } from "react";
import type { Role } from "@quincy/shared";
import { stopImpersonating, useSession } from "../lib/auth";
import { locationStore } from "../lib/router";
import { buttonClasses } from "./ui/button";

export type ImpersonationBannerProps = {
  user: { name: string; role: Role };
  invalidated: boolean;
};

const EXIT_ERROR = "Could not automatically exit. Sign out completely and sign back in as Admin to restore your session.";

// The banner is a fixed ink strip above the topbar. Its 42px height is load-bearing: five
// app.css rules offset the topbar, rail, worktools, viewer and collaboration wrap by exactly
// 42px under `.app--impersonating` (app.css:39-43, :823, :1074-1075). Do not change it here.
const BANNER = "impersonation-banner fixed inset-x-0 top-0 z-[76] flex items-center " +
  "gap-[var(--space-3)] h-[42px] overflow-hidden px-[var(--space-6)] " +
  "bg-surface-inverse text-on-inverse " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)]";

const IDENTITY = "impersonation-banner__identity min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

// Exit sits on ink, so every colour `VARIANT.text` sets has to be inverted — including the
// disabled colour from BASE and the focus ring, which is `--ring` → `--ink-900`: an ink ring on
// an ink strip is as invisible as the ink label was (E-11, E-12). `cn` is twMerge-backed, so
// these later utilities replace the earlier ones within each variant key (§2.1).
//
// `focus-visible:!outline-on-inverse` needs the important modifier, and the reason is the §2.2
// cascade rule, not specificity: `styles/tokens/base.css:25` declares a GLOBAL
// `:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring); }`, and
// `index.css:8` imports `base.css` outside any layer. That unlayered *shorthand* resets
// `outline-color` and beats an ordinary layered `outline-*` utility, so without the `!` the ring
// stays `--focus-ring` (ink) on an ink strip — E-12 unfixed. This is the same trap as §2.2, met
// through a token file rather than through `app.css`.
const EXIT = buttonClasses("text", {
  className: "!text-on-inverse-muted hover:not-disabled:!text-on-inverse " +
    "disabled:!text-on-inverse-muted disabled:bg-transparent disabled:border-transparent " +
    "focus-visible:!outline-on-inverse",
});

const ERROR = "impersonation-banner__error flex-[1_1_160px] min-w-0 overflow-hidden " +
  "text-signal-critical normal-case tracking-normal text-ellipsis whitespace-nowrap " +
  "[font:var(--weight-regular)_var(--text-xs)/1.35_var(--font-sans)]";

function roleTitle(role: ImpersonationBannerProps["user"]["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

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
    <span className={IDENTITY}>Acting as {user.name} ({roleTitle(user.role)}) · </span>
    <button className={EXIT} type="button" disabled={isExiting} onClick={() => void exit()}>Exit</button>
    {error && <span className={ERROR} role="alert" title={error}>{error}</span>}
  </aside>;
}
