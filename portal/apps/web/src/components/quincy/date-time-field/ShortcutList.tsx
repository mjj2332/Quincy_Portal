import type { ComponentType } from "react";
import { Calendar, CalendarPlus, Clock, Sun, X } from "lucide-react";
import { RING_IN } from "@/components/AnchoredPopover";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/reui/item";
import type { DateShortcut } from "@/lib/date-time-field";
import { cn } from "@/lib/utils";

/**
 * schedule-10's shortcut rows: `reui/item` size xs rendered as a real button, an icon in a bridged
 * signal colour, the label and the weekday it resolves to. A shortcut only produces a civil day;
 * the caller decides what that means (it sets the draft, it never commits).
 */
const ICONS: Record<DateShortcut["id"], { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; tone: string }> = {
  today: { icon: Sun, tone: "text-signal-caution-text" },
  tomorrow: { icon: Clock, tone: "text-signal-info" },
  "later-this-week": { icon: Calendar, tone: "text-primary" },
  "next-week": { icon: CalendarPlus, tone: "text-signal-positive" },
  "no-date": { icon: X, tone: "text-foreground-secondary" },
};

export function ShortcutList({ shortcuts, activeId, onPick }: {
  shortcuts: readonly DateShortcut[];
  /** The shortcut whose resolved day equals the draft, if any. */
  activeId: DateShortcut["id"] | null;
  onPick: (shortcut: DateShortcut) => void;
}) {
  return (
    <ItemGroup className="grid grid-cols-2 gap-[var(--space-1)] sm:flex sm:w-44 sm:shrink-0">
      {shortcuts.map((shortcut) => {
        const { icon: Icon, tone } = ICONS[shortcut.id];
        return (
          <Item
            key={shortcut.id}
            size="xs"
            render={<button type="button" />}
            aria-pressed={activeId === shortcut.id}
            className={cn(
              // One fixed height so a row without a sublabel ("No date") matches the rest, and one
              // inward ring (RING_IN): Item's own ring would double the global focus outline. Item's
              // base `outline-none` sets `--tw-outline-style: none`, which RING_IN's width utility
              // reads, and twMerge drops RING_IN's bare `!outline`, so `!outline-solid` restores the
              // style: without it the ring has a width and a colour and draws nothing.
              "min-h-[52px] min-w-0 flex-nowrap text-left hover:bg-muted focus-visible:ring-0 aria-pressed:border-border aria-pressed:bg-muted",
              RING_IN,
              "focus-visible:!outline-solid",
            )}
            onClick={() => onPick(shortcut)}
          >
            <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
            <ItemContent className="min-w-0">
              <ItemTitle className="truncate">{shortcut.label}</ItemTitle>
              {shortcut.sublabel && <ItemDescription className="text-[length:var(--text-2xs)]">{shortcut.sublabel}</ItemDescription>}
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
