import type { GuestSessionResponse } from "@quincy/shared";
import { Button } from "../components/reui/button";

/**
 * "Reviewing as {name or email}" with a "Not you? Sign out" link (#854), shown only to a verified guest, so a shared device never keeps the last person's identity. No confirmation: the cost of a
 * mistaken press is one re-verify. Signing out does not unsubscribe (membership is per email, not per device). `failed` is a sign-out the server could not take; the guest stays signed in.
 * Role tokens only (`text-foreground-secondary`, `text-destructive`): it sits on the notes pane, which is a dark surface (ADR 0024).
 */
export function GuestIdentityRow({ session, pending, failed, bordered, onSignOut }: { session: GuestSessionResponse; pending: boolean; failed: boolean; bordered: boolean; onSignOut: () => void }) {
  if (!session.verified) return null;
  const who = session.name !== null && session.name.trim() !== "" ? session.name : session.email;
  if (who === null) return null;
  return <div data-testid="guest-identity" className={bordered ? "border-t border-border pt-[var(--space-3)]" : ""}>
    <div className="flex flex-wrap items-center justify-between gap-x-[var(--space-3)] pointer-coarse:min-h-11 max-[721px]:min-h-11">
      <span className="min-w-0 text-foreground-secondary [font:var(--type-label)] [overflow-wrap:anywhere]">{`Reviewing as ${who}`}</span>
      <Button type="button" variant="link" size="sm" data-testid="guest-sign-out" disabled={pending} className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={onSignOut}>Not you? Sign out</Button>
    </div>
    {failed && <p role="alert" className="m-0 text-destructive [font:var(--type-label)]">Couldn't sign out. Try again.</p>}
  </div>;
}
