import { useContext, useId, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Field, FieldDescription, FieldLabel } from "@/components/reui/field";
import { FIELD_BOX } from "@/components/reui/input";
import { PopoverContent, Popover, PopoverTrigger } from "@/components/reui/popover";
import { isSydneyCalendarDate } from "@quincy/shared";
import { formatCivilDay, formatCivilRange } from "@/lib/date-format";
import { buildShortcuts, DATE_TIME_POPUP_EDGE_GAP, popupPaddingWithTopAtLeast, civilToCell, resolveDateTimePopupPlacement, sydneyToday, yearBounds, type PopupCollisionAvoidance, type PopupCollisionPadding } from "@/lib/date-time-field";
import { useMediaQuery } from "@/lib/use-media-query";
import { useReresolveOnResize } from "@/lib/use-reresolve-on-resize";
import { cn } from "@/lib/utils";
import { CalendarPane } from "./date-time-field/CalendarPane";
import { DateTimePopup, PopupAnchorContext, type DateTimeApply, type DateTimePopupProps, type DateTimeStored } from "./date-time-field/DateTimePopup";
import { DateTimeRangePopup, type DateTimeRangeApply, type DateTimeRangePopupProps } from "./date-time-field/DateTimeRangePopup";
import { PopupFrame } from "./date-time-field/PopupFrame";
import { ShortcutList } from "./date-time-field/ShortcutList";

export { DateTimePopup, PopupAnchorContext };
export type { DateTimeRangeApply, DateTimeRangePopupProps } from "./date-time-field/DateTimeRangePopup";
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
  /** Which edge of the field the popup aligns to; "end" for a field near a container's left edge. Defaults to "start". */
  popupAlign?: "start" | "end";
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Inline status shown inside the trigger after the value (e.g. an "Automatic" pill). It is part of the trigger's accessible name. */
  adornment?: ReactNode;
  /** Helper or status text under the trigger, wired to it as its accessible description. */
  description?: ReactNode;
  /** Set when `description` is a live status (a note that appears after an action) rather than static help. */
  descriptionRole?: "status";
  /** Replaces the popup's collision policy (see `resolveDateTimePopupPlacement`); omitted keeps the default. */
  popupCollisionAvoidance?: PopupCollisionAvoidance;
  /** Replaces the popup's 16px viewport padding. A function is called each time the popup opens (after the DOM has committed), never while it is closed. */
  popupCollisionPadding?: PopupCollisionPadding | (() => PopupCollisionPadding);
  /**
   * Scrolls the field's row to the top of the viewport (below the padding's top edge) as the popup opens, and keeps
   * the popup from rising above the trigger, so the popup never cuts through the field's own label (#537).
   * For a popup too tall to sit below its field, which shifts over it (New shoot's Deadline).
   */
  popupPinTopToField?: boolean;
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
      busy?: DateTimePopupProps["busy"];
      /** Commit the draft (`localCivil: null` clears). Rejecting keeps the popup open on the same draft. */
      onApply: (next: DateTimeApply) => void | Promise<void>;
    })
  | (Omit<CommonProps, "clearable"> & {
      variant: "range";
      /** The stored range, or null while a draft has none yet. A Subtask's range is never cleared. */
      value: DateTimeRangePopupProps["value"];
      projectDefault: DateTimeRangePopupProps["projectDefault"];
      openOn?: DateTimeRangePopupProps["openOn"];
      seed?: DateTimeRangePopupProps["seed"];
      seedKey?: DateTimeRangePopupProps["seedKey"];
      reminders?: DateTimeRangePopupProps["reminders"];
      facts?: DateTimeRangePopupProps["facts"];
      feedback?: DateTimeRangePopupProps["feedback"];
      /** Commit both ends. Rejecting keeps the popup open on the same draft. */
      onApply: (next: DateTimeRangeApply) => void | Promise<void>;
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
export function DateTimePopoverContent({ label, className, children, popupCollisionAvoidance, popupCollisionPadding, ...props }: Omit<ComponentProps<typeof PopoverContent>, "aria-label" | "aria-describedby" | "initialFocus" | "collisionAvoidance" | "collisionPadding"> & { label: string; popupCollisionAvoidance?: PopupCollisionAvoidance; popupCollisionPadding?: PopupCollisionPadding }) {
  const zoneId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Below sm the popup may cover its trigger: "shift" on y gives --available-height the whole
  // viewport (minus padding) instead of the sliver above or below the field (#447).
  const narrow = useMediaQuery("(width < 40rem)");
  // ~530-680px tall: if it fits neither side, stay above/below and scroll the body rather than opening sideways.
  const { collisionAvoidance, collisionPadding } = resolveDateTimePopupPlacement({ narrow, avoidance: popupCollisionAvoidance, padding: popupCollisionPadding });
  return (
    <PopoverContent
      align="start"
      collisionPadding={collisionPadding as ComponentProps<typeof PopoverContent>["collisionPadding"]}
      collisionAvoidance={collisionAvoidance}
      {...props}
      aria-label={label}
      aria-describedby={zoneId}
      // preventScroll: Base UI's own focus() would scroll a short body past the month navigation and presets (#528).
      initialFocus={() => {
        const target = bodyRef.current?.querySelector<HTMLElement>('[data-initial-focus="true"]') ?? bodyRef.current?.querySelector<HTMLElement>('[aria-selected="true"] button') ?? bodyRef.current?.querySelector<HTMLElement>("button");
        if (!target) return true;
        target.focus({ preventScroll: true });
        return false;
      }}
      className={cn("w-auto max-w-[calc(100vw-2*var(--space-4))] gap-0 overflow-hidden rounded-[var(--radius-card)] p-0", className)}
    >
      <PopupAnchorContext.Provider value={{ zoneId, bodyRef }}>{children}</PopupAnchorContext.Provider>
    </PopoverContent>
  );
}

/**
 * #537 — the field's row (label, trigger, description) is scrolled to the top of the viewport, below
 * `padding.top`, and the returned padding keeps the popup from rising above the trigger, so the label
 * above it stays whole. The scroll is instant: the popup measures the trigger on this same open.
 */
function pinnedToField(trigger: HTMLElement | null, padding: PopupCollisionPadding): PopupCollisionPadding {
  const row = trigger?.parentElement;
  if (!trigger || !row) return padding;
  const edges = popupPaddingWithTopAtLeast(padding, 0);
  row.style.scrollMarginTop = `${edges.top}px`;
  row.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
  row.style.scrollMarginTop = "";
  return popupPaddingWithTopAtLeast(edges, trigger.getBoundingClientRect().top);
}

export function DateTimeField(props: DateTimeFieldProps) {
  const { id, label, placeholder = "Select a date", disabled } = props;
  const clearable = props.variant === "range" ? false : (props.clearable ?? false);
  const [open, setOpen] = useState(false);
  // Resolved per open, not at field mount: the content element exists while closed, and a cold load has no shell header yet (#528).
  const [openPadding, setOpenPadding] = useState<PopupCollisionPadding | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = (next: boolean) => {
    if (next) {
      const resolved = typeof props.popupCollisionPadding === "function" ? props.popupCollisionPadding() : props.popupCollisionPadding;
      setOpenPadding(props.popupPinTopToField ? pinnedToField(triggerRef.current, resolved ?? DATE_TIME_POPUP_EDGE_GAP) : resolved);
    }
    setOpen(next);
  };
  // #602: a viewport resize while open re-reads a padding callback. Never with `popupPinTopToField`: re-pinning scrolls the page.
  const padFn = typeof props.popupCollisionPadding === "function" ? props.popupCollisionPadding : undefined;
  useReresolveOnResize(open && padFn !== undefined && !props.popupPinTopToField, () => padFn!(), setOpenPadding);
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const adornmentId = `${id}-adornment`;
  const descriptionId = `${id}-description`;
  const hasAdornment = props.adornment !== undefined && props.adornment !== null && props.adornment !== false;
  const hasDescription = props.description !== undefined && props.description !== null && props.description !== false;
  const display = props.variant === "date"
    ? (props.value ? (isSydneyCalendarDate(props.value) ? formatCivilDay(props.value) : props.value) : null)
    : props.variant === "range"
      ? (props.value ? formatCivilRange(props.value) : null)
      : (props.value ? `${formatCivilDay(props.value.localCivil.slice(0, 10))} · ${props.value.localCivil.slice(11, 16)}` : null);

  return (
    <Field>
      <FieldLabel id={labelId} htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          ref={triggerRef}
          id={id}
          type="button"
          disabled={disabled}
          aria-labelledby={hasAdornment ? `${labelId} ${valueId} ${adornmentId}` : `${labelId} ${valueId}`}
          aria-describedby={hasDescription ? descriptionId : undefined}
          // A <button> always matches :read-only, which would paint FIELD_BOX's read-only skin.
          className={cn(FIELD_BOX, "flex cursor-pointer items-center justify-between gap-[var(--space-2)] text-left [&:read-only:not(select)]:bg-[var(--field-bg)] [&:read-only:not(select)]:text-foreground")}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
            <span id={valueId} className={cn("min-w-0 [overflow-wrap:anywhere]", display === null && "text-muted-foreground")}>{display ?? placeholder}</span>
            {hasAdornment && <span id={adornmentId} className="-my-[var(--space-1)] shrink-0" data-testid="datetime-adornment">{props.adornment}</span>}
          </span>
          <CalendarIcon aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
        </PopoverTrigger>
        <DateTimePopoverContent label={label} align={props.popupAlign ?? "start"} positionerClassName={props.positionerClassName} popupCollisionAvoidance={props.popupCollisionAvoidance} popupCollisionPadding={openPadding}>
          {props.variant === "date"
            ? <DatePopup label={label} value={props.value} clearable={clearable} onApply={props.onApply} onClose={() => setOpen(false)} />
            : props.variant === "range"
              ? <DateTimeRangePopup label={label} value={props.value} projectDefault={props.projectDefault} openOn={props.openOn} seed={props.seed} seedKey={props.seedKey} reminders={props.reminders} facts={props.facts} feedback={props.feedback} onApply={props.onApply} onClose={() => setOpen(false)} />
              : <DateTimePopup label={label} value={props.value} clearable={clearable} reminders={props.reminders} seed={props.seed} seedKey={props.seedKey} facts={props.facts} feedback={props.feedback} busy={props.busy} onApply={props.onApply} onClose={() => setOpen(false)} />}
        </DateTimePopoverContent>
      </Popover>
      {hasDescription && <FieldDescription id={descriptionId} role={props.descriptionRole}>{props.description}</FieldDescription>}
    </Field>
  );
}
