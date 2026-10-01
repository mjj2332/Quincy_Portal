import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { DEADLINE_PRESET_TIME, resolveSydneyCivilMinute, type ProjectDeadlineSchedule } from "@quincy/shared";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/reui/field";
import { Input } from "@/components/reui/input";
import { buildShortcuts, civilToCell, joinCivilMinute, parseTypedTime, sameReminderOffsets, splitCivilMinute, sydneyToday, timeSlots, yearBounds, type DateShortcut } from "@/lib/date-time-field";
import { CalendarPane } from "./CalendarPane";
import { FoldChoice } from "./FoldChoice";
import { NextReminder } from "./NextReminder";
import { PopupFrame } from "./PopupFrame";
import { RemindersStrip } from "./RemindersStrip";
import { ShortcutList } from "./ShortcutList";
import { TimeColumn } from "./TimeColumn";

/**
 * #422 — the date-time form of the popup: the #421 shortcuts and calendar, plus a time column of
 * 15-minute slots, a typed time for an exact minute, an Earlier / Later choice that appears only
 * when the Sydney time happens twice, and (when `reminders` is given) the Deadline reminders strip.
 * The draft lives here; nothing is committed until Apply, and Cancel, Escape and an outside press
 * all discard it.
 *
 * Rules the form owns:
 * - A date-only SHORTCUT always sets 17:00. A day picked on the calendar keeps the time already in
 *   the draft, and only takes 17:00 when it has none.
 * - A typed time is `H:MM` / `HH:MM` / `HHMM`, `00:00` to `23:59`, off the grid allowed and never
 *   rounded; anything else disables Apply with an inline message.
 * - A Sydney time inside a daylight-saving gap keeps the selection, says it does not exist and
 *   disables Apply; it is never shifted. A repeated time needs an explicit Earlier / Later, which
 *   is seeded from the stored fold while the civil minute is the stored one and cleared on any
 *   change to the minute.
 * - Apply closes only after `onApply` resolves; a rejection keeps the popup open on the same draft.
 */

/**
 * `fold` is which occurrence of a repeated Sydney minute is stored. Leave it out when the caller has
 * no stored occurrence (an unresolved drag): Earlier / Later then starts unchosen and must be pressed.
 */
export type DateTimeStored = { localCivil: string; fold?: 0 | 1 };
export type Disambiguation = "earlier" | "later";

/** What Apply hands back: `localCivil: null` is "No date". Offsets are present only with `reminders`. */
export type DateTimeApply = { localCivil: string | null; disambiguation?: Disambiguation; reminderOffsetsMinutes?: number[] };

/** A draft to start from, in place of the stored value (a conflict's reload / reapply). */
export type DateTimeSeed = { localCivil: string | null; disambiguation?: Disambiguation; reminderOffsetsMinutes: number[] };

export type DateTimeReminders = {
  offsets: readonly number[];
  /** The stored schedule's next reminder. `undefined` hides the line; `null` says there is none. */
  next?: ProjectDeadlineSchedule["nextOccurrence"];
};

/** The popover content's zone id and body ref, so the popup's header and the content's `aria-describedby` agree. */
export const PopupAnchorContext = createContext<{ zoneId: string; bodyRef: Ref<HTMLDivElement> & { current?: HTMLDivElement | null } } | null>(null);

export type DateTimePopupProps = {
  label: string;
  value: DateTimeStored | null;
  clearable: boolean;
  reminders?: DateTimeReminders;
  seed?: DateTimeSeed;
  /** Changing it starts a fresh draft from `seed` (the popup remounts its draft). */
  seedKey?: string | number;
  /** Facts and actions drawn in the body, below the reminders (summary, Resume). */
  facts?: ReactNode;
  /** Failure and conflict feedback drawn at the foot of the body. */
  feedback?: ReactNode;
  /** Move focus into the popup when it mounts (a popup that mounts after Base UI's own initial focus ran). */
  focusOnMount?: boolean;
  /** A mutation the caller owns is in flight: Apply is disabled until it settles. */
  busy?: boolean;
  onApply: (next: DateTimeApply) => void | Promise<void>;
  onClose: () => void;
};

type Draft = {
  touched: boolean;
  day: string | null;
  /** A valid `HH:mm`, or null while the typed text is not one. */
  time: string | null;
  timeText: string;
  /** "No date" was picked. */
  clear: boolean;
  fold: { minute: string; choice: Disambiguation } | null;
  offsets: number[];
};

function initialDraft(value: DateTimeStored | null, reminders: DateTimeReminders | undefined, seed: DateTimeSeed | undefined): Draft {
  const localCivil = seed ? seed.localCivil : value?.localCivil ?? null;
  const parts = localCivil ? splitCivilMinute(localCivil) : { day: null, time: null };
  const choice: Disambiguation | undefined = seed ? seed.disambiguation : value?.fold === undefined ? undefined : value.fold === 1 ? "later" : "earlier";
  return {
    // A seeded draft (a conflict's reapply) differs from the stored value by design, so it is already dirty.
    touched: seed !== undefined,
    day: parts.day,
    time: parts.time,
    timeText: parts.time ?? "",
    // A reapplied rejected clear is a seeded null.
    clear: seed !== undefined && seed.localCivil === null,
    fold: localCivil && choice ? { minute: localCivil, choice } : null,
    offsets: [...(seed ? seed.reminderOffsetsMinutes : reminders?.offsets ?? [])],
  };
}

const TIME_ERROR = "Enter a time as HH:MM, from 00:00 to 23:59.";
const SLOTS = timeSlots();

function DateTimeDraft({ label, value, clearable, reminders, seed, facts, feedback, focusOnMount, busy = false, onApply, onClose }: Omit<DateTimePopupProps, "seedKey">) {
  const anchor = useContext(PopupAnchorContext);
  const ownId = useId();
  const ownBodyRef = useRef<HTMLDivElement>(null);
  const zoneId = anchor?.zoneId ?? ownId;
  const bodyRef = (anchor?.bodyRef ?? ownBodyRef) as React.RefObject<HTMLDivElement | null>;
  const timeId = useId();

  // Sydney's today, read once when the popup opens so it cannot change under the user.
  const [today] = useState(() => sydneyToday());
  const [draft, setDraft] = useState<Draft>(() => initialDraft(value, reminders, seed));
  const [month, setMonth] = useState(() => civilToCell(draft.day ?? today));
  const [applying, setApplying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useLayoutEffect(() => {
    if (!focusOnMount) return;
    const body = bodyRef.current;
    (body?.querySelector<HTMLElement>('[aria-selected="true"] button') ?? body?.querySelector<HTMLElement>("button"))?.focus();
    // Mount only: Base UI owns focus for the cached-detail case, this covers a late mount.
  }, []);

  // Any change to the civil minute drops an Earlier / Later choice made for the old one.
  const change = (patch: Partial<Draft>) => setDraft((current) => {
    const next = { ...current, touched: true, ...patch };
    if (!("fold" in patch) && joinCivilMinute(current.day, current.time) !== joinCivilMinute(next.day, next.time)) next.fold = null;
    return next;
  });

  const civil = joinCivilMinute(draft.day, draft.time);
  const resolution = civil ? resolveSydneyCivilMinute(civil) : null;
  const gap = resolution !== null && !resolution.ok && resolution.code === "nonexistent_local_time";
  const choices = resolution !== null && !resolution.ok && resolution.code === "repeated_local_time" ? resolution.choices : null;
  const activeChoice = choices && draft.fold && draft.fold.minute === civil ? draft.fold.choice : undefined;
  const timeInvalid = draft.timeText.trim() !== "" && !parseTypedTime(draft.timeText).ok;

  // Which grid slots do not exist on the picked day (the forward-clock gap).
  const skipped = useMemo(() => {
    if (!draft.day) return new Set<string>();
    const day = draft.day;
    return new Set(SLOTS.filter((slot) => {
      const result = resolveSydneyCivilMinute(`${day}T${slot}`);
      return !result.ok && result.code === "nonexistent_local_time";
    }));
  }, [draft.day]);

  const shortcuts = buildShortcuts({ today, clearable });
  const activeId = shortcuts.find((shortcut) => {
    const resolved = shortcut.resolve();
    return resolved === null ? draft.clear : !draft.clear && resolved === draft.day;
  })?.id ?? null;
  const bounds = yearBounds(today, draft.day ?? value?.localCivil.slice(0, 10) ?? null);

  const pickDay = (day: string, source: "shortcut" | "grid") => {
    const time = source === "shortcut" ? DEADLINE_PRESET_TIME : draft.time ?? DEADLINE_PRESET_TIME;
    change({ day, time, timeText: time, clear: false });
    setMonth(civilToCell(day));
  };
  const pickShortcut = (shortcut: DateShortcut) => {
    const resolved = shortcut.resolve();
    if (resolved === null) { change({ day: null, time: null, timeText: "", clear: true }); return; }
    pickDay(resolved, "shortcut");
  };
  const pickSlot = (slot: string) => change({ time: slot, timeText: slot, clear: false });
  const typeTime = (text: string) => {
    const parsed = parseTypedTime(text);
    change({ timeText: text, time: parsed.ok ? parsed.time : null, clear: false });
  };

  const blocked = draft.touched && !draft.clear && (civil === null || timeInvalid || gap || (choices !== null && activeChoice === undefined));

  const apply = async () => {
    if (!draft.touched) { onClose(); return; }
    const payload: DateTimeApply = draft.clear
      ? { localCivil: null }
      : { localCivil: civil, ...(activeChoice ? { disambiguation: activeChoice } : {}), ...(reminders ? { reminderOffsetsMinutes: draft.offsets } : {}) };
    setApplying(true);
    try {
      await onApply(payload);
      // A save can outlive its popup (Escape mid-save, then reopened): only the instance that
      // started it may close.
      if (mounted.current) onClose();
    } catch {
      // The caller owns the failure message; stay open with the draft so the user can retry.
      if (mounted.current) setApplying(false);
    }
  };

  // The next-reminder line states the SAVED schedule; it goes quiet once the draft departs from it.
  const savedOffsets = reminders?.offsets ?? [];
  const savedLineStale = draft.touched && (
    draft.clear
    || civil !== (value?.localCivil ?? null)
    || !sameReminderOffsets(draft.offsets, savedOffsets)
  );

  const hint = draft.touched && !draft.clear && civil === null && !timeInvalid ? "Pick a date and a time." : null;

  return (
    <PopupFrame label={label} zoneId={zoneId} bodyRef={bodyRef} applying={applying} applyDisabled={blocked || busy} onCancel={onClose} onApply={() => { void apply(); }}>
      <div className="flex flex-col gap-[var(--space-4)]">
        <div className="flex flex-col gap-[var(--space-4)] sm:flex-row">
          <ShortcutList shortcuts={shortcuts} activeId={activeId} onPick={pickShortcut} />
          <CalendarPane
            selection={{ mode: "single", day: draft.day }}
            today={today}
            month={month}
            onMonthChange={setMonth}
            onPickDay={(day) => pickDay(day, "grid")}
            startYear={bounds.startYear}
            endYear={bounds.endYear}
          />
          <div className="flex min-w-0 flex-col gap-[var(--space-2)] sm:w-28 sm:shrink-0">
            <TimeColumn selected={draft.time && SLOTS.includes(draft.time) ? draft.time : null} skipped={skipped} onPick={pickSlot} />
          </div>
        </div>
        <Field data-invalid={timeInvalid || undefined}>
          <FieldLabel htmlFor={timeId}>Time</FieldLabel>
          <Input id={timeId} inputMode="numeric" autoComplete="off" placeholder="HH:MM" value={draft.timeText} aria-invalid={timeInvalid || undefined} aria-describedby={`${timeId}-help`} onChange={(event) => typeTime(event.target.value)} />
          <FieldDescription id={`${timeId}-help`} className="text-[length:var(--text-xs)]">Any minute, for example 17:07, or pick a slot.</FieldDescription>
          {timeInvalid && <FieldError>{TIME_ERROR}</FieldError>}
          {gap && resolution && !resolution.ok && <FieldError>{resolution.message}</FieldError>}
          {hint && <FieldDescription className="text-[length:var(--text-xs)]">{hint}</FieldDescription>}
        </Field>
        {choices && <FoldChoice choices={choices} selected={activeChoice} onSelect={(choice) => civil && change({ fold: { minute: civil, choice } })} />}
        {reminders && <RemindersStrip offsets={draft.offsets} onChange={(offsets) => change({ offsets })} />}
        {reminders && reminders.next !== undefined && <NextReminder saved stale={savedLineStale} next={reminders.next} hasReminders={reminders.offsets.length > 0} />}
        {facts}
        {feedback}
      </div>
    </PopupFrame>
  );
}

export function DateTimePopup({ seedKey, ...props }: DateTimePopupProps) {
  return <DateTimeDraft key={seedKey} {...props} />;
}
