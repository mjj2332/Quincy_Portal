import { useContext, useId, useRef, useState, type ComponentProps, type Ref } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Field, FieldLabel } from "@/components/reui/field";
import { FIELD_BOX } from "@/components/reui/input";
import { PopoverContent, Popover, PopoverTrigger } from "@/components/reui/popover";
import { isSydneyCalendarDate } from "@quincy/shared";
import { formatCivilDay } from "@/lib/date-format";
import { buildShortcuts, civilToCell, sydneyToday, yearBounds } from "@/lib/date-time-field";
import { cn } from "@/lib/utils";
import { CalendarPane } from "./date-time-field/CalendarPane";
import { DateTimePopup, PopupAnchorContext, type DateTimeApply, type DateTimePopupProps, type DateTimeStored } from "./date-time-field/DateTimePopup";
import { PopupFrame } from "./date-time-field/PopupFrame";
import { ShortcutList } from "./date-time-field/ShortcutList";

export { DateTimePopup, PopupAnchorContext };
export type { DateTimeApply, DateTimePopupProps, DateTimeSeed, DateTimeStored } from "./date-time-field/DateTimePopup";

/**
 * #421 — the Portal's single date/time field: one clickable field showing the current value, which
 * opens a popup modelled on ReUI `schedule-10`, on `frame`. `variant: "date"` is the date-only form
 * (the shoot date stays a civil day, no time column); #422 adds `"date-time"` (a Sydney civil
 * minute, with a time column, Earlier / Later and the Deadline reminders strip) and #423 the range.
 *
 * `value` is the STORED value: for `date`, a canonical `YYYY-MM-DD`, null, or unparsed text an
 * importer left (a Tonomo shoot date), displayed verbatim and replaced only when the user picks a
 * day (Apply with nothing picked closes without calling `onApply`); for `date-time`, the stored
 * civil minute and its fold, or null.
 *
 * The popup is non-modal, unmounts on close (no `keepMounted`, like `ProjectHeaderDeadline`) so a
 * draft never outlives it, and leaves focus return to Base UI (lessons: TB8-02, no custom refocus).
 * Cancel, Escape and an outside press all discard the draft.
 *
 * A surface that brings its own trigger (the project header, the Timeline cell) composes
 * `Popover` + `DateTimePopoverContent` + `DateTimePopup` directly instead of this field.
 */
type CommonProps = {
  id: string;
  label: string;
  /** Raises the popup's layer, for a field inside a dialog (see `reui/popover`'s positionerClassName). */
  positionerClassName?: string;
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
};

export type DateTimeFieldProps =
  | (CommonProps & {
      variant: "date";
      value: string | null;
      /** Commit the picked day (null clears). Rejecting keeps the popup open on the same draft. */
      onApply: (next: string | null) => void | Promise<void>;
    })
  | (CommonProps & {
      variant: "date-time";
      value: DateTimeStored | null;
      reminders?: DateTimePopupProps["reminders"];
      seed?: DateTimePopupProps["seed"];
      seedKey?: DateTimePopupProps["seedKey"];
      facts?: DateTimePopupProps["facts"];
      feedback?: DateTimePopupProps["feedback"];
      /** Commit the draft (`localCivil: null` clears). Rejecting keeps the popup open on the same draft. */
      onApply: (next: DateTimeApply) => void | Promise<void>;
    });

type Draft = { touched: false } | { touched: true; day: string | null };

function DatePopup({ label, value, clearable, onApply, onClose }: {
  label: string;
  value: string | null;
  clearable: boolean;
  onApply: (next: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  // Sydney's today, read once when the popup opens so it cannot change under the user.
  const [today] = useState(() => sydneyToday());
  const storedDay = value && isSydneyCalendarDate(value) ? value : null;
  const [draft, setDraft] = useState<Draft>({ touched: false });
  const [month, setMonth] = useState(() => civilToCell(storedDay ?? today));
  const [applying, setApplying] = useState(false);
  const anchor = usePopupAnchor();

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
    <PopupFrame label={label} zoneId={anchor.zoneId} bodyRef={anchor.bodyRef} applying={applying} onCancel={onClose} onApply={() => { void apply(); }}>
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
    </PopupFrame>
  );
}

function usePopupAnchor(): { zoneId: string; bodyRef: Ref<HTMLDivElement> } {
  const fallbackId = useId();
  const fallbackRef = useRef<HTMLDivElement>(null);
  return useContext(PopupAnchorContext) ?? { zoneId: fallbackId, bodyRef: fallbackRef };
}

/**
 * The popover content every date popup sits in: a named, non-modal dialog described by the zone,
 * opening focus on the selected day (so no shortcut reads as selected) else the first control.
 * Provides the zone id and body ref the popup's frame needs.
 */
export function DateTimePopoverContent({ label, className, children, ...props }: Omit<ComponentProps<typeof PopoverContent>, "aria-label" | "aria-describedby" | "initialFocus"> & { label: string }) {
  const zoneId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <PopoverContent
      align="start"
      collisionPadding={16}
      {...props}
      aria-label={label}
      aria-describedby={zoneId}
      initialFocus={() => bodyRef.current?.querySelector<HTMLElement>('[aria-selected="true"] button') ?? bodyRef.current?.querySelector<HTMLElement>("button") ?? true}
      className={cn("w-auto max-w-[calc(100vw-2*var(--space-4))] gap-0 overflow-hidden rounded-[var(--radius-card)] p-0", className)}
    >
      <PopupAnchorContext.Provider value={{ zoneId, bodyRef }}>{children}</PopupAnchorContext.Provider>
    </PopoverContent>
  );
}

export function DateTimeField(props: DateTimeFieldProps) {
  const { id, label, clearable = false, placeholder = "Select a date", disabled } = props;
  const [open, setOpen] = useState(false);
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const display = props.variant === "date"
    ? (props.value ? (isSydneyCalendarDate(props.value) ? formatCivilDay(props.value) : props.value) : null)
    : (props.value ? `${formatCivilDay(props.value.localCivil.slice(0, 10))} · ${props.value.localCivil.slice(11, 16)}` : null);

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
        <DateTimePopoverContent label={label} positionerClassName={props.positionerClassName}>
          {props.variant === "date"
            ? <DatePopup label={label} value={props.value} clearable={clearable} onApply={props.onApply} onClose={() => setOpen(false)} />
            : <DateTimePopup label={label} value={props.value} clearable={clearable} reminders={props.reminders} seed={props.seed} seedKey={props.seedKey} facts={props.facts} feedback={props.feedback} onApply={props.onApply} onClose={() => setOpen(false)} />}
        </DateTimePopoverContent>
      </Popover>
    </Field>
  );
}
