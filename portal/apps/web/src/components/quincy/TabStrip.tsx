import * as React from "react";

import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/reui/tabs";

type TabItem = { value: string; label: React.ReactNode; count?: number };

// Carried across verbatim from `components/ui/tabs.tsx:6-24` — this is Quincy's underline-tab
// visual treatment, not nova's boxed segmented control. `min-h-[38px] max-[721px]:min-h-[44px]`
// is the 44px touch target (WCAG 2.5.5 Enhanced / HIG, not a spacing token) and
// `-mb-[var(--border-width-hair)]` laps the strip's own bottom rule.
const TAB_BASE =
  "relative -mb-[var(--border-width-hair)] inline-flex items-center gap-[var(--space-2)] " +
  "min-h-[38px] max-[721px]:min-h-[44px] px-0 pt-[var(--space-2)] pb-[11px] " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "bg-transparent border-0 [border-bottom-style:solid] border-b-[length:var(--border-width-mid)] " +
  "cursor-pointer [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] " +
  "transition-[color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

const TAB_IDLE = "border-b-transparent text-foreground-secondary hover:text-foreground hover:border-b-border-hover";
const TAB_SELECTED = "border-b-primary text-foreground";

const TAB_COUNT = "[font-variant-numeric:tabular-nums] [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] text-foreground-secondary";

// `@/components/reui/tabs`'s `TabsList`/`TabsTrigger` carry nova's boxed segmented-control
// look (rounded container, fixed heights, an active background + shadow, a line-indicator
// pseudo-element). TAB_BASE/TAB_IDLE/TAB_SELECTED above replace it with Quincy's underline
// tabs, but a handful of nova's classes are gated behind modifiers (`group-data-*:`,
// `data-active:`) that an unmodified override can't reach — those need an exact-modifier
// counter-class to cancel. (The line-indicator `after:` pseudo-element needs no cancelling: its
// opacity only ever leaves 0 under `group-data-[variant=line]/tabs-list:`, and this list never
// sets `variant="line"`.)
const TAB_LIST_RESET =
  "flex w-full items-center justify-start gap-[var(--space-5)] rounded-none bg-transparent p-0 " +
  "group-data-horizontal/tabs:h-auto " +
  "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border";

const TAB_TRIGGER_RESET =
  "h-auto flex-none justify-start rounded-none " +
  "focus-visible:ring-0 " +
  "data-active:bg-transparent dark:data-active:bg-transparent " +
  "group-data-[variant=default]/tabs-list:data-active:shadow-none";

function TabStrip({ items, value, onValueChange, idPrefix, label, className }: {
  items: TabItem[];
  value: string;
  onValueChange: (next: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  return (
    <Tabs
      data-slot="tab-strip"
      value={value}
      onValueChange={(next) => onValueChange(next)}
      // `Tabs` (reui's `Tabs.Root`) wraps its children in a `group/tabs flex gap-2
      // data-horizontal:flex-col` div. `contents` takes that wrapper out of layout so Admin's
      // tab strip doesn't gain a stray flex container around it.
      className="contents"
    >
      <TabsList
        role="tablist"
        aria-label={label}
        // Base UI's roving-tabindex defaults to focus-only arrow keys (`activateOnFocus` is
        // false by default) — Enter/Space would be needed to select. The hand-rolled
        // `move()`/`onKeyDown` this replaces both focused *and* selected on Left/Right/Home/End,
        // so `activateOnFocus` is turned on to keep that behaviour.
        activateOnFocus
        className={cn(TAB_LIST_RESET, className)}
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              id={`${idPrefix}-tab-${item.value}`}
              className={cn(TAB_TRIGGER_RESET, TAB_BASE, selected ? TAB_SELECTED : TAB_IDLE)}
            >
              {item.label}
              {/* A whitespace-only text node between flex items is discarded by flex layout, so this is
                  visually inert — the `gap-[var(--space-2)]` above still supplies the separation. It
                  exists so `textContent` and the accessible name read "DLQ 0", not "DLQ0". */}
              {typeof item.count === "number" ? <>{" "}<span className={TAB_COUNT}>{item.count}</span></> : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

export { TabStrip, TAB_BASE, TAB_IDLE, TAB_SELECTED };
export type { TabItem };
