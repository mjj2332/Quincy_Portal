import { Check } from "lucide-react";
import type { GuestVersionDto } from "@quincy/shared";
import { Badge } from "../components/reui/badge";

/**
 * This link's latest decision on a Version, and whether staff Released it (#741 14-ui-guest). Both are read straight off the Version DTO: the decision is informational (ADR 0021 section 5)
 * and a Release is the studio's, so a guest's own decision never shows as "Released". Renders nothing for a Version with neither.
 */
export function GuestDeliveryChips({ version }: { version: Pick<GuestVersionDto, "decision" | "released"> }) {
  if (version.decision === null && !version.released) return null;
  return <>
    {version.decision !== null && <DecisionBadge decision={version.decision} />}
    {version.released && <ReleasedBadge />}
  </>;
}

/**
 * The decision on its own (#879 PR 3b): a phone guest sees it in the header's Approve slot once one is recorded (P2), with P1's check before "Approved".
 */
export function DecisionBadge({ decision, icon = false }: { decision: NonNullable<GuestVersionDto["decision"]>; icon?: boolean }) {
  const approved = decision.value === "approved";
  return <Badge variant={approved ? "success-light" : "warning-light"} size="default" data-testid="guest-decision-chip">
    {icon && approved && <Check aria-hidden="true" />}{approved ? "Approved" : "Changes requested"}
  </Badge>;
}

/** "Released", on its own: the first item of the phone's quiet line at the end of the notes (#879 PR 3b). */
export function ReleasedBadge() {
  return <Badge variant="info-light" size="default" data-testid="guest-released-chip">Released</Badge>;
}
