import type { ReviewLinkDto } from "@quincy/shared";
import { Badge } from "../reui/badge";

export const STATUS_LABEL: Record<ReviewLinkDto["status"], string> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const STATUS_VARIANT = { active: "success-light", expired: "warning-light", revoked: "secondary" } as const;

/** A Review link's status as a `reui/badge`: success / warning / secondary (the 11b ledger). */
export function ReviewLinkStatusBadge({ status, className }: { status: ReviewLinkDto["status"]; className?: string }) {
  return <Badge variant={STATUS_VARIANT[status]} size="sm" {...(className ? { className } : {})}>{STATUS_LABEL[status]}</Badge>;
}
