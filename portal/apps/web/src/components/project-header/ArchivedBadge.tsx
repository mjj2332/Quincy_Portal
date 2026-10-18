import { ArchiveIcon } from "lucide-react";
import { Badge } from "@/components/reui/badge";
import { cn } from "../../lib/utils";

/** #914 D6 (`.bdg.neutral` with the archive icon): the Archived marker, in the desktop status cluster and on the phone project bar. */
export function ArchivedBadge({ className, ...props }: { className?: string; "data-testid"?: string }) {
  return <Badge variant="secondary" size="xl" {...props} className={cn("normal-case tracking-normal gap-[var(--space-1)] [&_svg]:size-3.5", className)}><ArchiveIcon aria-hidden="true" />Archived</Badge>;
}
