import { useId, useRef, useState, type Ref } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Field, FieldLabel } from "@/components/reui/field";
import { FIELD_BOX } from "@/components/reui/input";
import { Button } from "@/components/reui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/reui/popover";
import { isSydneyCalendarDate, SYDNEY_TIME_ZONE } from "@quincy/shared";
import { formatCivilDay } from "@/lib/date-format";
import { buildShortcuts, civilToCell, sydneyToday, yearBounds } from "@/lib/date-time-field";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./Eyebrow";
import { CalendarPane } from "./date-time-field/CalendarPane";
import { ShortcutList } from "./date-time-field/ShortcutList";

/**
 * #421 — the Portal's single date/time field: one clickable field showing the current value, which
 * opens a popup modelled on ReUI `schedule-10`, on `frame`. This is the date-only form (the shoot
 * date stays a civil day, no time column); #422 adds the time column and reminders and #423 the
 * range as further `variant`s.
 *
 * `value` is the STORED value: a canonical `YYYY-MM-DD`, null, or unparsed text an importer left
 * (a Tonomo shoot date). Unparsed text displays verbatim and is only replaced when the user picks
 * a day: Apply with nothing picked closes without calling `onApply`.
 *
 * The popup is non-modal, unmounts on close (no `keepMounted`, like `ProjectHeaderDeadline`) so a
 * draft never outlives it, and leaves focus return to Base UI (lessons: TB8-02, no custom refocus).
 * Cancel, Escape and an outside press all discard the draft.
 */
export type DateTimeFieldProps = {
  variant: "date";
  id: string;
  label: string;
  value: string | null;
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Commit the picked day (null clears). Rejecting keeps the popup open on the same draft. */
  onApply: (next: string | null) => void | Promise<void>;
};

type Draft = { touched: false } | { touched: true; day: string | null };

function DatePopup({ label, value, clearable, zoneId, bodyRef, onApply, onClose }: {
  label: string;
  value: string | null;
  clearable: boolean;
  zoneId: string;
  bodyRef: Ref<HTMLDivElement>;
  onApply: DateTimeFieldProps["onApply"];
  onClose: () => void;
}) {
  // Sydney's today, read once when the popup opens so it cannot change under the user.
  const [today] = useState(() => sydneyToday());
  const storedDay = value && isSydneyCalendarDate(value) ? value : null;
  const [draft, setDraft] = useState<Draft>({ touched: false });
  const [month, setMonth] = useState(() => civilToCell(storedDay ?? today));
  const [applying, setApplying] = useState(false);

  const selectedDay = draft.touched ? draft.day : storedDay;
  const shortcuts = buildShortcuts({ today, clearable });
  // Pressed only when the selection IS that shortcut's day; "No date" only once explicitly picked.
  const activeId = shortcuts.find((shortcut) => {
    const resolved = shortcut.resolve();
    return resolved === null ? draft.touched && draft.day === null : resolved === selectedDay;
  })?.id ?? null;
  const bounds = yearBounds(today, selectedDay ?? storedDay);

  const pick = (day: string | null) => {
    setDraft({ touched: true, day });
    if (day) setMonth(civilToCell(day));
  };

  const apply = async () => {
    if (!draft.touched) { onClose(); return; }
    setApplying(true);
    try {
      await onApply(draft.day);
      onClose();
    } catch {
      // The caller owns the failure message; stay open with the draft so the user can retry.
      setApplying(false);
    }
  };

  return (
    <Frame ref={bodyRef} spacing="sm" className="max-h-[var(--available-height)] min-h-0">
      <FrameHeader>
        <FrameTitle><Eyebrow>{label}</Eyebrow></FrameTitle>
        <FrameDescription id={zoneId} className="text-[length:var(--text-xs)]">{SYDNEY_TIME_ZONE}</FrameDescription>
      </FrameHeader>
      {/* The body scrolls; the footer below stays pinned so Cancel / Apply are always visible. */}
      <FramePanel className="min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-[var(--space-4)] sm:flex-row">
          <ShortcutList shortcuts={shortcuts} activeId={activeId} onPick={(shortcut) => pick(shortcut.resolve())} />
          <CalendarPane
            selection={{ mode: "single", day: selectedDay }}
            today={today}
            month={month}
            onMonthChange={setMonth}
            onPickDay={pick}
            startYear={bounds.startYear}
            endYear={bounds.endYear}
          />
        </div>
      </FramePanel>
      <FrameFooter className="shrink-0 flex-row justify-end gap-[var(--space-2)]">
        <Button type="button" variant="outline" disabled={applying} onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={applying} onClick={() => { void apply(); }}>Apply</Button>
      </FrameFooter>
    </Frame>
  );
}

export function DateTimeField({ id, label, value, clearable = false, placeholder = "Select a date", disabled, onApply }: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const zoneId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const display = value ? (isSydneyCalendarDate(value) ? formatCivilDay(value) : value) : null;

  return (
    <Field>
      <FieldLabel id={labelId} htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          type="button"
          disabled={disabled}
          aria-labelledby={`${labelId} ${valueId}`}
          // A <button> always matches :read-only, which would paint FIELD_BOX's read-only skin.
          className={cn(FIELD_BOX, "flex cursor-pointer items-center justify-between gap-[var(--space-2)] text-left [&:read-only:not(select)]:bg-[var(--field-bg)] [&:read-only:not(select)]:text-foreground")}
        >
          <span id={valueId} className={cn("min-w-0 [overflow-wrap:anywhere]", display === null && "text-muted-foreground")}>{display ?? placeholder}</span>
          <CalendarIcon aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label={label}
          aria-describedby={zoneId}
          collisionPadding={16}
          // Open on the selected day when there is one (so no shortcut reads as selected), else the first shortcut.
          initialFocus={() => bodyRef.current?.querySelector<HTMLElement>('[aria-selected="true"] button') ?? bodyRef.current?.querySelector<HTMLElement>("button") ?? true}
          className="w-auto max-w-[calc(100vw-2*var(--space-4))] gap-0 overflow-hidden rounded-[var(--radius-card)] p-0"
        >
          <DatePopup label={label} value={value} clearable={clearable} zoneId={zoneId} bodyRef={bodyRef} onApply={onApply} onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </Field>
  );
}
