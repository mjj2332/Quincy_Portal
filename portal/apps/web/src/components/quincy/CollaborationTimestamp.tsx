import { cn } from "@/lib/utils";
import { formatAbsoluteTime, formatDayGroupedTime, formatRelativeTime } from "@/lib/date-format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { META_TEXT } from "./Eyebrow";

/**
 * A Collaboration-tab timestamp (#376): the visible text is the short form, the absolute date is in
 * a tooltip (`reui/tooltip`, which portals into the sheet's overlay slot so it stays inside the
 * focus trap) and, for assistive tech, in an `sr-only` sibling.
 *
 * The trigger is a `<time>`, not a button: it is deliberately NOT focusable, so a thread of fifty
 * comments does not add fifty tab stops. Keyboard and touch users get the same absolute date from
 * the `sr-only` text (and the `dateTime` attribute); the tooltip is the pointer affordance.
 *
 * `mode="relative"`: "5m ago" / "Yesterday" / "12 Sep" (comments). `mode="dayGrouped"`: "5m ago"
 * today, "3:04 PM" otherwise (a feed under a day heading). `now` comes from `useNow()` so the
 * whole list ticks together.
 */
export function CollaborationTimestamp({ instant, now, mode, className }: {
  instant: string | number;
  now: number;
  mode: "relative" | "dayGrouped";
  className?: string;
}) {
  const iso = typeof instant === "number" ? new Date(instant).toISOString() : instant;
  const absolute = formatAbsoluteTime(instant);
  const visible = mode === "relative" ? formatRelativeTime(instant, now) : formatDayGroupedTime(instant, now);
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<time dateTime={iso} className={cn(META_TEXT, "!normal-case", className)} />}>{visible}</TooltipTrigger>
        <TooltipContent>{absolute}</TooltipContent>
      </Tooltip>
      <span className="sr-only" data-testid="collaboration-timestamp-absolute">, {absolute}</span>
    </>
  );
}
