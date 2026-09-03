import * as React from "react";
import { cn } from "@/lib/utils";

type TabItem = { value: string; label: React.ReactNode; count?: number };

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

function TabStrip({ items, value, onValueChange, idPrefix, label, className }: {
  items: TabItem[];
  value: string;
  onValueChange: (next: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  function move(delta: number) {
    const index = items.findIndex((item) => item.value === value);
    if (index < 0) return;
    // `noUncheckedIndexedAccess` makes this access possibly-undefined; it never is in practice
    // (the modulo stays in range), but the guard is required to compile.
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;
    onValueChange(next.value);
    refs.current[next.value]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowLeft") {
      event.preventDefault(); move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = items[0];
      if (first) { onValueChange(first.value); refs.current[first.value]?.focus(); }
    } else if (event.key === "End") {
      event.preventDefault();
      const last = items[items.length - 1];
      if (last) { onValueChange(last.value); refs.current[last.value]?.focus(); }
    }
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      data-slot="tab-strip"
      onKeyDown={onKeyDown}
      className={cn(
        "flex flex-wrap gap-[var(--space-5)]",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.value}`}
            // Only the selected panel is mounted, so only the selected tab may claim one.
            // `undefined` omits the attribute entirely; `""` would emit a broken IDREF. (§8)
            aria-controls={selected ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            ref={(node) => { refs.current[item.value] = node; }}
            onClick={() => onValueChange(item.value)}
            className={cn(TAB_BASE, selected ? TAB_SELECTED : TAB_IDLE)}
          >
            {item.label}
            {/* A whitespace-only text node between flex items is discarded by flex layout, so this is
                visually inert — the `gap-[var(--space-2)]` above still supplies the separation. It
                exists so `textContent` and the accessible name read "DLQ 0", not "DLQ0". */}
            {typeof item.count === "number" ? <>{" "}<span className={TAB_COUNT}>{item.count}</span></> : null}
          </button>
        );
      })}
    </div>
  );
}

export { TabStrip, TAB_BASE, TAB_IDLE, TAB_SELECTED };
export type { TabItem };
