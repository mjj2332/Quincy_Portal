import type { ComponentType } from "react";
import { Calendar, CalendarDays, CalendarPlus, Clock, RotateCcw, Sun, X } from "lucide-react";
import { RING_IN } from "@/components/AnchoredPopover";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/reui/item";
import { cn } from "@/lib/utils";

/**
 * schedule-10's shortcut rows: `reui/item` size xs rendered as a real button, an icon in a bridged
 * signal colour, the label and the weekday it resolves to. A shortcut only produces a civil day;
 * the caller decides what that means (it sets the draft, it never commits).
 */
const ICONS: Record<string, { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; tone: string }> = {
  today: { icon: Sun, tone: "text-signal-caution-text" },
  tomorrow: { icon: Clock, tone: "text-signal-info" },
  "later-this-week": { icon: Calendar, tone: "text-primary" },
  "next-week": { icon: CalendarPlus, tone: "text-signal-positive" },
  "no-date": { icon: X, tone: "text-foreground-secondary" },
  // #423: the range form's rows. Today / Tomorrow / Next week reuse the single-day glyphs.
  "this-week": { icon: CalendarDays, tone: "text-primary" },
  "project-default": { icon: RotateCcw, tone: "text-foreground-secondary" },
};

/** The shortcut group's accessible name; `PopupFrame` and its tests find the group by it (#630), not by the vendor slot. */
export const SHORTCUTS_LABEL = "Date shortcuts";

export type ShortcutRow = { id: string; label: string; sublabel: string };

export function ShortcutList<TRow extends ShortcutRow>({ shortcuts, activeId, onPick }: {
  shortcuts: readonly TRow[];
  /** The shortcut whose resolved value equals the draft, if any. */
  activeId: TRow["id"] | null;
  /** The pressed button is handed over so a caller that re-renders the grid can keep focus on it. */
  onPick: (shortcut: TRow, button: HTMLElement) => void;
}) {
  return (
    <ItemGroup aria-label={SHORTCUTS_LABEL} className="grid grid-cols-2 gap-[var(--space-1)] min-[721px]:flex min-[721px]:w-44 min-[721px]:shrink-0">
      {shortcuts.map((shortcut) => {
        const { icon: Icon, tone } = ICONS[shortcut.id] ?? ICONS.today!;
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
            onClick={(event) => onPick(shortcut, event.currentTarget)}
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
