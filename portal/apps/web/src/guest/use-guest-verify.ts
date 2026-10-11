import { useCallback, useRef, useState } from "react";
import type { GuestSessionResponse } from "@quincy/shared";

/**
 * What an action wants done once the guest has verified. `active` says whether the action that asked is still wanted (a cancelled decision is not); `done` runs exactly once when the dialog
 * closes: `true` after a verification the action is still waiting on, `false` on Cancel, on being replaced, or when the action is no longer active.
 */
export type VerifyRequest = { active: () => boolean; done: (verified: boolean) => void };
/** The page's one verify dialog. `request()` with nothing only opens it (a write found the session unverified); a request also becomes the one continuation. */
export type GuestVerify = { request: (req?: VerifyRequest) => void };

/**
 * The one owner of the verify dialog and its single continuation slot for the whole guest page (#741 14-ui-guest), so two actions that both find the session unverified share one dialog. A request from an
 * action that is no longer active neither replaces the continuation nor opens anything. A request from an active action replaces the pending one, which is told it was not verified.
 */
export function useGuestVerify(onSession: (next: GuestSessionResponse) => void, onUnavailable: () => void) {
  const [open, setOpen] = useState(false);
  const pending = useRef<VerifyRequest | null>(null);
  const request = useCallback((req?: VerifyRequest) => {
    const held = pending.current;
    if (req !== undefined) {
      if (!req.active()) return;
      pending.current = req;
      if (held !== null && held !== req) held.done(false);
    } else if (held !== null && !held.active()) {
      pending.current = null;
      held.done(false);
    }
    setOpen(true);
  }, []);
  const finish = useCallback((verified: boolean) => {
    const held = pending.current;
    pending.current = null;
    setOpen(false);
    if (held !== null) held.done(verified && held.active());
  }, []);
  const verify = useRef<GuestVerify>({ request });
  verify.current.request = request;
  return {
    verify: verify.current,
    dialog: {
      open,
      onOpenChange: (next: boolean) => { if (next) setOpen(true); else finish(false); },
      onVerified: (next: GuestSessionResponse) => { onSession(next); finish(true); },
      onGone: () => { finish(false); onUnavailable(); },
    },
  };
}
