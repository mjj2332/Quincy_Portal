import { useState, type JSX } from "react";
import type { Role } from "@quincy/shared";
import { stopImpersonating, useSession } from "../lib/auth";
import { locationStore } from "../lib/router";

export type ImpersonationBannerProps = {
  user: { name: string; role: Role };
  invalidated: boolean;
};

const EXIT_ERROR = "Could not automatically exit. Sign out completely and sign back in as Admin to restore your session.";

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

  return <aside className="impersonation-banner" aria-label="Impersonation status" data-invalidated={invalidated ? "true" : undefined}>
    <span className="impersonation-banner__identity">Acting as {user.name} ({roleTitle(user.role)}) · </span>
    <button className="button button--text" type="button" disabled={isExiting} onClick={() => void exit()}>Exit</button>
    {error && <span className="impersonation-banner__error" role="alert" title={error}>{error}</span>}
  </aside>;
}
