import { cn } from "@/lib/utils";
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

/** What one unlock state means on screen, shared by the button (`UnlockControl`) and the locked film tile's line (`UnlockLine`). A rate-limit wait is an absolute deadline: it keeps counting across a tab change. */
export type UnlockView = { requested: boolean; sending: boolean; waiting: boolean; /** Nothing to send now: sending, waiting out a 429, or already requested. */ inert: boolean; message: string };
export function useUnlockView(state: UnlockState): UnlockView {
  const seconds = useSecondsUntil(state.kind === "limited" ? state.until : null);
  const waiting = state.kind === "limited" && seconds > 0;
  const requested = state.kind === "requested";
  const sending = state.kind === "sending";
  const message = requested ? REQUESTED_TEXT : waiting ? waitText(seconds) : state.kind === "failed" ? FAILED_TEXT : "";
  return { requested, sending, waiting, inert: requested || sending || waiting, message };
}

/** The status line: one persistent live region, so a screen reader hears "Requested" rather than a control appearing. */
const UnlockStatus = ({ message }: { message: string }) => <p aria-live="polite" data-testid="delivery-unlock-status" className="m-0 [font:var(--type-label)] text-foreground-secondary">{message}</p>;

/**
 * "Request unlock" for one locked item, and what came of it (#787 slice 9). The state is the caller's (keyed by handle, held above the tabs and the lightbox), so it survives both; `onRequest` sends nothing by itself.
 * The photo tile, the lightbox and a document row use this button. A locked film tile does not: its tile is the control, and it draws `UnlockLine` instead (#882, V1/V3).
 */
export function UnlockControl({ label, state, onRequest, className }: { label: string; state: UnlockState; onRequest: () => void; className?: string }) {
  const { requested, sending, waiting, message } = useUnlockView(state);
  return <div data-testid="delivery-unlock" className={className ?? "grid gap-[var(--space-1)]"}>
    {!requested && <Button type="button" variant="outline" size="sm" aria-label={`Request unlock: ${label}`} disabled={sending || waiting} className={`w-fit ${TOUCH}`} onClick={onRequest}>
      {sending && <Spinner aria-hidden className="size-3" />}{sending ? "Sending" : "Request unlock"}
    </Button>}
    <UnlockStatus message={message} />
  </div>;
}

/**
 * The locked film tile's unlock line (#882, prototype V1/V3; adapted from `UnlockControl`, whose other callers render as before). It holds no control: the whole tile is the one control
 * (`VideoTile` `caption`), so a tap on this line is a tap on the tile. Until requested it is the tile's visible affordance, an underlined "Request unlock" ("Sending" while it sends), hidden from a
 * screen reader because the tile's own name already says it; the status beneath is the same live region and copy as `UnlockControl`, so a failure ("Couldn't send. Try again.") and a rate-limit
 * wait read as they do on a photo. Once requested (V3) only the status is left: "Requested. The studio will be in touch." in the secondary colour.
 */
export function UnlockLine({ view }: { view: UnlockView }) {
  // The live region stays mounted while empty; the gap applies only when it has something to say, so the idle line sits on the tile's bottom padding as in V1.
  return <div data-testid="delivery-unlock" className={cn("grid", !view.requested && view.message !== "" && "gap-[var(--space-1)]")}>
    {!view.requested && <span data-testid="delivery-unlock-action" aria-hidden="true" className={cn("inline-flex w-fit items-center gap-[var(--space-1)] [font:var(--type-label)]", view.inert ? "text-foreground-secondary" : "text-foreground underline underline-offset-2")}>
      {view.sending && <Spinner aria-hidden className="size-3" />}{view.sending ? "Sending" : "Request unlock"}
    </span>}
    <UnlockStatus message={view.message} />
  </div>;
}
