import { Badge } from "../reui/badge";
import { Button } from "../quincy/Button";
import { STATUS_LABEL } from "./ReviewLinkStatusBadge";
import type { ReviewLinkChip } from "./use-review-links-ui";

const MAX_CHIPS = 2;
const VARIANT = { active: "success-light", expired: "warning-light", revoked: "secondary" } as const;
const name = (chip: ReviewLinkChip) => chip.label ?? "Untitled link";

/** At most two `reui/badge` chips on a Video's card ("Smith family · Active"), then "+N" (#741 60e). Each opens that link's detail; "+N" opens the list. */
export function ReviewLinkChips({ chips, onOpenChip, onOpenAll }: { chips: ReviewLinkChip[]; onOpenChip: (linkId: string) => void; onOpenAll: () => void }) {
  const shown = chips.slice(0, MAX_CHIPS);
  const rest = chips.length - shown.length;
  const target = "-ml-[var(--space-1)] px-[var(--space-1)] pointer-coarse:min-h-11 max-[721px]:min-h-11";
  return <div data-testid="video-card-link-chips" className="flex flex-wrap items-center gap-x-[var(--space-1)]">
    {shown.map((chip) => <Button key={chip.id} type="button" variant="text" className={target} aria-label={`Review link ${name(chip)}, ${STATUS_LABEL[chip.status]}`} onClick={() => onOpenChip(chip.id)}>
      <Badge variant={VARIANT[chip.status]} size="sm" className="max-w-[16rem] truncate">{`${name(chip)} · ${STATUS_LABEL[chip.status]}`}</Badge>
    </Button>)}
    {rest > 0 && <Button type="button" variant="text" className={target} aria-label={`${rest} more Review links`} onClick={onOpenAll}><Badge variant="outline" size="sm">{`+${rest}`}</Badge></Button>}
  </div>;
}
