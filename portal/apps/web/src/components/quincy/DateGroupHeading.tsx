import { cn } from "@/lib/utils";
import { Eyebrow } from "./Eyebrow";

// A label beside a hairline rule that fills the remaining width — the Notifications page's day
// heading, shared with the Activity feed (#378). The component owns the row layout; the consumer
// owns vertical spacing (Notifications reads at page scale, the Activity feed sits in a sheet).
const HEADING_LAYOUT = "flex items-center gap-[var(--space-4)]";
const HEADING_RULE = "flex-1 [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border";

export function DateGroupHeading({ id, label, className }: { id: string; label: string; className?: string }) {
  return (
    <h3 id={id} className={cn(HEADING_LAYOUT, className)}>
      <Eyebrow>{label}</Eyebrow>
      <span aria-hidden="true" className={HEADING_RULE} />
    </h3>
  );
}
