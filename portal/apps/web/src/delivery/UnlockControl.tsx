import { Badge } from "../components/reui/badge";
import { Button } from "../components/reui/button";
import { Spinner } from "../components/reui/spinner";
import { useSecondsUntil } from "./delivery-hooks";
import type { UnlockState } from "./delivery-model";

export const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

export const REQUESTED_TEXT = "Requested. The studio will be in touch.";
export const FAILED_TEXT = "Couldn't send. Try again.";
const waitText = (seconds: number) => `Too many requests. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;

/** The "Premium" mark on a paid extra. Signal-on-inverse tokens, so it reads on the lightbox's dark surface and on the page. */
export function PremiumBadge({ overPhoto = false }: { overPhoto?: boolean }) {
  // Over a photo (a tile, the lightbox) the 10% tint is unreadable, so the mark is solid; in a document row or beside a placeholder it stays tinted.
  return <Badge variant={overPhoto ? "warning" : "warning-light"} data-testid="delivery-premium-badge">Premium</Badge>;
}

/**
 * "Request unlock" for one locked item, and what came of it (#787 slice 9). The state is the caller's (keyed by handle, held above the tabs and the lightbox), so it survives both; `onRequest` sends nothing by itself.
 * The status line is one persistent live region, so a screen reader hears "Requested" rather than a control appearing. A rate-limit wait is an absolute deadline: it keeps counting across a tab change.
 */
export function UnlockControl({ label, state, onRequest, className }: { label: string; state: UnlockState; onRequest: () => void; className?: string }) {
  const seconds = useSecondsUntil(state.kind === "limited" ? state.until : null);
  const waiting = state.kind === "limited" && seconds > 0;
  const requested = state.kind === "requested";
  const sending = state.kind === "sending";
  const message = requested ? REQUESTED_TEXT : waiting ? waitText(seconds) : state.kind === "failed" ? FAILED_TEXT : "";
  return <div data-testid="delivery-unlock" className={className ?? "grid gap-[var(--space-1)]"}>
    {!requested && <Button type="button" variant="outline" size="sm" aria-label={`Request unlock: ${label}`} disabled={sending || waiting} className={`w-fit ${TOUCH}`} onClick={onRequest}>
      {sending && <Spinner aria-hidden className="size-3" />}{sending ? "Sending" : "Request unlock"}
    </Button>}
    <p aria-live="polite" data-testid="delivery-unlock-status" className="m-0 [font:var(--type-label)] text-foreground-secondary">{message}</p>
  </div>;
}
