import { useId } from "react";
import { Switch } from "../components/reui/switch";
import { useSubscription, type GuestSubscription } from "./guest-subscription";

/**
 * The quiet row at the foot of the notes panel (#741 15b): the verified guest's own "Email me updates about this review" switch. The value is the guest's last choice (the store) or, before
 * they make one, what the session said. It flips at once; a failed PUT puts it back and says so here. `readOnly` (an archived Project) disables it.
 */
export function GuestSubscriptionRow({ store, initial, readOnly, onToggle }: { store: GuestSubscription; initial: boolean; readOnly: boolean; onToggle: (next: boolean, previous: boolean) => void }) {
  const state = useSubscription(store);
  const id = useId();
  const checked = state.value ?? initial;
  return <div data-testid="guest-subscription" className="border-t border-border pt-[var(--space-3)]">
    <div className="flex items-center justify-between gap-[var(--space-3)] pointer-coarse:min-h-11 max-[721px]:min-h-11">
      <label htmlFor={id} className="text-foreground-secondary [font:var(--type-label)]">Email me updates about this review</label>
      <Switch id={id} checked={checked} disabled={readOnly || state.pending} onCheckedChange={(next) => { onToggle(next, checked); }} />
    </div>
    {state.failed && <p role="alert" className="m-0 text-destructive-wash-foreground [font:var(--type-label)]">That didn't go through. Try again.</p>}
  </div>;
}
