import { Badge } from "@/components/reui/badge";

/**
 * #509 — the "Automatic" provenance marker on a Deadline that no person has confirmed (#484). An
 * outline `reui/badge` in secondary text, so it reads as provenance and the due-in `StatusPill`
 * keeps the only filled emphasis. Sentence case on purpose: the badge's small-caps is switched
 * off, and the visible word stays "Automatic" so the trigger's accessible name still contains it
 * (WCAG 2.5.3 Label in Name). Not a live region: it is provenance, not a status change.
 *
 * Shared by the Project header (live trigger and archived read-only value) and New shoot, so the
 * three stay identical. Tests find it by `data-testid`, a Quincy seam, not the vendor `data-slot`.
 */
export function AutomaticDeadlineMark() {
  return <Badge
    variant="outline"
    radius="full"
    data-testid="automatic-deadline-mark"
    className="normal-case tracking-normal text-foreground-secondary"
  >Automatic</Badge>;
}

/** The writable Deadline popover's explanation: what "Automatic" means and what Apply does. */
export const AUTOMATIC_DEADLINE_APPLY_NOTE =
  "Automatic: the first weekday after the shoot, at 17:00. It moves with the shoot date until you Apply.";

/** The read-only Deadline popover's explanation (there is no Apply). */
export const AUTOMATIC_DEADLINE_NOTE =
  "Automatic: the first weekday after the shoot, at 17:00. It moves with the shoot date until someone saves it.";

/** The New shoot Deadline field's explanation while it shows the automatic preview. */
export const AUTOMATIC_DEADLINE_NEW_SHOOT_NOTE =
  "Automatic: the first weekday after the shoot, at 17:00. Change it to set your own.";
