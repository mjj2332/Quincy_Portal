import type { GuestVersionDto } from "@quincy/shared";
import { Badge } from "../components/reui/badge";

/**
 * This link's latest decision on a Version, and whether staff Released it (#741 14-ui-guest). Both are read straight off the Version DTO: the decision is informational (ADR 0021 section 5)
 * and a Release is the studio's, so a guest's own decision never shows as "Released". Renders nothing for a Version with neither.
 */
export function GuestDeliveryChips({ version }: { version: Pick<GuestVersionDto, "decision" | "released"> }) {
  if (version.decision === null && !version.released) return null;
  return <>
    {version.decision !== null && <Badge variant={version.decision.value === "approved" ? "success-light" : "warning-light"} size="default" data-testid="guest-decision-chip">{version.decision.value === "approved" ? "Approved" : "Changes requested"}</Badge>}
    {version.released && <Badge variant="info-light" size="default" data-testid="guest-released-chip">Released</Badge>}
  </>;
}
