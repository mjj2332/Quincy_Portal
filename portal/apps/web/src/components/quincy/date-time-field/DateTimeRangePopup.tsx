import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEADLINE_PRESET_TIME, SUBTASK_START_PRESET_TIME, resolveSydneyCivilMinute } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { ButtonGroup } from "@/components/reui/button-group";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/reui/field";
import { Input } from "@/components/reui/input";
import { cn } from "@/lib/utils";
import { civilToCell, joinCivilMinute, parseTypedTime, sameReminderOffsets, splitCivilMinute, sydneyToday, timeSlots, yearBounds } from "@/lib/date-time-field";
import { buildRangeShortcuts, dayLabel, type DateTimeRangeValue } from "@/lib/date-time-range";
import { CalendarPane } from "./CalendarPane";
import { FoldChoice } from "./FoldChoice";
import { NextReminder } from "./NextReminder";
import { PopupAnchorContext, type DateTimeReminders, type Disambiguation } from "./DateTimePopup";
import { PopupFrame } from "./PopupFrame";
import { RemindersStrip } from "./RemindersStrip";
import { ShortcutList } from "./ShortcutList";
import { TimeColumn } from "./TimeColumn";

/**
 * #423 — the range form of the date/time popup (ADR 0016): a start and an end, each a Sydney civil
 * minute, on one calendar. A Start | End toggle picks which end the calendar, the time column, the
 * typed time and the Earlier / Later choice edit; the shortcuts (Today, Tomorrow, This week, Next
 * week and, when the caller has one, Project default) set both ends at once. There is no "No date":
 * a Subtask always has a range. The draft lives here and nothing is committed until Apply.
 *
 * #425: when `reminders` is given the popup also edits the Subtask's reminder set with the Deadline's own strip (`RemindersStrip`):
 * the offsets are part of the draft, a toggle alone is an edit, and Apply hands them back beside the range. The next-reminder
 * line states the SAVED schedule and goes quiet once the draft departs from it; a caller with nothing saved yet (a new Subtask's
 * composer) leaves `reminders.next` undefined, which hides the line.
 *
 * Rules the form owns:
 * - A shortcut applies the presets (09:00 start, 17:00 end) or the Project default. A day picked on
 *   the calendar keeps the time already on that end and only takes its preset (09:00 start, 17:00
 *   end) when it has none.
 * - Picking a day while Start is active sets the start, moves the end onto that day when it would
 *   otherwise be before it, and hands the toggle to End. Picking while End is active sets the end;
 *   a day before the start restarts the range there (both ends on it) and stays on End, so the next
 *   click extends it.
 * - A typed time is `H:MM` / `HH:MM` / `HHMM`, `00:00` to `23:59`, off the grid allowed.
 * - A Sydney time inside a daylight-saving gap says so and disables Apply; a repeated time needs an
 *   explicit Earlier / Later per end, seeded from the stored fold while the minute is the stored one.
 * - Apply is disabled until both ends are complete and the start is before the end BY INSTANT
 *   (judged on the resolved folds, the rule the server enforces). A range under a day is fine.
 * - Apply closes only after `onApply` resolves; a rejection keeps the popup open on the same draft.
 */

export type DateTimeRangeApply = {
  start: { localCivil: string; disambiguation?: Disambiguation };
  end: { localCivil: string; disambiguation?: Disambiguation };
  /** Present only when the popup was given `reminders`. */
  reminderOffsetsMinutes?: number[];
};

/** A draft to start from in place of the stored value (a conflict's reapply). Without offsets the stored ones are kept. */
export type DateTimeRangeSeed = DateTimeRangeApply;

export type DateTimeRangePopupProps = {
  label: string;
  value: DateTimeRangeValue | null;
  /** The "Project default" shortcut's range; `null` hides the shortcut. */
  projectDefault: DateTimeRangeValue | null;
  /** Which end is active when the popup mounts. */
  openOn?: "start" | "end";
  seed?: DateTimeRangeSeed;
  /** Changing it starts a fresh draft from `seed` (the popup remounts its draft). */
  seedKey?: string | number;
  /** The Subtask's reminder set (#425): the strip, and the saved next-reminder line when `next` is given. Omit it for a range-only popup. */
  reminders?: DateTimeReminders;
  /** Facts and actions drawn in the body, below the reminders. */
  facts?: ReactNode;
  /** Failure and conflict feedback drawn at the foot of the body. */
  feedback?: ReactNode;
  /** A one-line notice pinned under the Start/End toggle, so it stays in view while the body scrolls. Give it no live role. */
  banner?: ReactNode;
  /** Move focus into the popup when it mounts. */
  focusOnMount?: boolean;
  onApply: (next: DateTimeRangeApply) => void | Promise<void>;
  onClose: () => void;
  /** The Cancel button, when it must differ from closing after Apply (a host that keeps a failed draft). Defaults to `onClose`. */
  onCancel?: () => void;
};

type End = "start" | "end";

type EndDraft = {
  day: string | null;
  /** A valid `HH:mm`, or null while the typed text is not one. */
  time: string | null;
  timeText: string;
  fold: { minute: string; choice: Disambiguation } | null;
};

type Draft = { touched: boolean; active: End; start: EndDraft; end: EndDraft; offsets: number[] };

function endDraft(localCivil: string | null, choice: Disambiguation | undefined): EndDraft {
  const parts = localCivil ? splitCivilMinute(localCivil) : { day: null, time: null };
  return { day: parts.day, time: parts.time, timeText: parts.time ?? "", fold: localCivil && choice ? { minute: localCivil, choice } : null };
}

const foldChoice = (fold: 0 | 1): Disambiguation => (fold === 1 ? "later" : "earlier");

function initialDraft(value: DateTimeRangeValue | null, seed: DateTimeRangeSeed | undefined, openOn: End, reminders: DateTimeReminders | undefined): Draft {
  const stored = [...(reminders?.offsets ?? [])];
  if (seed) {
    return { touched: true, active: openOn, offsets: seed.reminderOffsetsMinutes ? [...seed.reminderOffsetsMinutes] : stored, start: endDraft(seed.start.localCivil, seed.start.disambiguation), end: endDraft(seed.end.localCivil, seed.end.disambiguation) };
  }
  return {
    touched: false,
    active: openOn,
    offsets: stored,
    start: endDraft(value?.start.localCivil ?? null, value ? foldChoice(value.start.fold) : undefined),
    end: endDraft(value?.end.localCivil ?? null, value ? foldChoice(value.end.fold) : undefined),
  };
}

const TIME_ERROR = "Enter a time as HH:MM, from 00:00 to 23:59.";
const SLOTS = timeSlots();
const TITLES: Record<End, string> = { start: "Start", end: "End" };

type Resolved = {
  civil: string | null;
  gap: string | null;
  choices: ReturnType<typeof choicesOf>;
  chosen: Disambiguation | undefined;
  epochMs: number | null;
};

function choicesOf(resolution: ReturnType<typeof resolveSydneyCivilMinute> | null) {
  return resolution !== null && !resolution.ok && resolution.code === "repeated_local_time" ? resolution.choices : null;
}

function resolveEnd(draft: EndDraft): Resolved {
  const civil = joinCivilMinute(draft.day, draft.time);
  const resolution = civil ? resolveSydneyCivilMinute(civil) : null;
  const gap = resolution !== null && !resolution.ok && resolution.code === "nonexistent_local_time" ? resolution.message : null;
  const choices = choicesOf(resolution);
  const chosen = choices && draft.fold && draft.fold.minute === civil ? draft.fold.choice : undefined;
  let epochMs: number | null = null;
  if (civil && resolution) {
    if (resolution.ok) epochMs = resolution.value.epochMs;
    else if (chosen) {
      const picked = resolveSydneyCivilMinute(civil, chosen);
      if (picked.ok) epochMs = picked.value.epochMs;
    }
  }
  return { civil, gap, choices, chosen, epochMs };
}

export function DateTimeRangeDraft({ label, value, projectDefault, openOn = "start", seed, reminders, facts, feedback, banner, focusOnMount, onApply, onClose, onCancel }: Omit<DateTimeRangePopupProps, "seedKey">) {
  const anchor = useContext(PopupAnchorContext);
  const ownId = useId();
  const ownBodyRef = useRef<HTMLDivElement>(null);
  const zoneId = anchor?.zoneId ?? ownId;
  const bodyRef = (anchor?.bodyRef ?? ownBodyRef) as React.RefObject<HTMLDivElement | null>;
  const timeId = useId();

  // Sydney's today, read once when the popup opens so it cannot change under the user.
  const [today] = useState(() => sydneyToday());
  const [draft, setDraft] = useState<Draft>(() => initialDraft(value, seed, openOn, reminders));
  const [month, setMonth] = useState(() => civilToCell((openOn === "end" ? draft.end.day : draft.start.day) ?? draft.start.day ?? today));
  const [applying, setApplying] = useState(false);
  // Spoken when the active end changes, so the handoff after a start pick is not silent.
  const [announcement, setAnnouncement] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useLayoutEffect(() => {
    if (!focusOnMount) return;
    const body = bodyRef.current;
    (body?.querySelector<HTMLElement>('[data-initial-focus="true"]') ?? body?.querySelector<HTMLElement>('[aria-selected="true"] button') ?? body?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    // Mount only: Base UI owns focus for the ordinary open, this covers a late mount.
  }, []);

  // Any change to an end's minute drops an Earlier / Later choice made for the old one.
  const change = (which: End, patch: Partial<EndDraft>, rest: Partial<Draft> = {}) => setDraft((current) => {
    const next: EndDraft = { ...current[which], ...patch };
    if (!("fold" in patch) && joinCivilMinute(current[which].day, current[which].time) !== joinCivilMinute(next.day, next.time)) next.fold = null;
    return { ...current, touched: true, ...rest, [which]: next };
  });

  const active = draft.active;
  const resolved = { start: resolveEnd(draft.start), end: resolveEnd(draft.end) };
  const current = draft[active];
  const timeInvalid = current.timeText.trim() !== "" && !parseTypedTime(current.timeText).ok;

  const skipped = useMemo(() => {
    if (!current.day) return new Set<string>();
    const day = current.day;
    return new Set(SLOTS.filter((slot) => {
      const result = resolveSydneyCivilMinute(`${day}T${slot}`);
      return !result.ok && result.code === "nonexistent_local_time";
    }));
  }, [current.day]);

  const shortcuts = buildRangeShortcuts({ today, projectDefault });
  const foldOf = (which: End): 0 | 1 => (resolved[which].chosen === "later" ? 1 : 0);
  const activeId = shortcuts.find((shortcut) => {
    const range = shortcut.resolve();
    return resolved.start.civil === range.start.localCivil && resolved.end.civil === range.end.localCivil && foldOf("start") === range.start.fold && foldOf("end") === range.end.fold;
  })?.id ?? null;

  const bounds = yearBounds(today, draft.start.day ?? draft.end.day ?? value?.start.localCivil.slice(0, 10) ?? null);
  const endBounds = yearBounds(today, draft.end.day);
  const startYear = Math.min(bounds.startYear, endBounds.startYear);
  const endYear = Math.max(bounds.endYear, endBounds.endYear);

  const pickDay = (day: string) => {
    if (draft.active === "start") setAnnouncement("Editing end");
    setDraft((state) => {
      const start = { ...state.start };
      const end = { ...state.end };
      const reset = (which: EndDraft, preset: string) => {
        const time = which.time ?? preset;
        return { ...which, day, time, timeText: which.time ? which.timeText : time };
      };
      let nextActive: End = state.active;
      let nextStart = start;
      let nextEnd = end;
      if (state.active === "start") {
        nextStart = reset(start, SUBTASK_START_PRESET_TIME);
        if (end.day === null || end.day < day) nextEnd = reset(end, DEADLINE_PRESET_TIME);
        nextActive = "end";
      } else if (start.day === null) {
        nextStart = reset(start, SUBTASK_START_PRESET_TIME);
        nextEnd = reset(end, DEADLINE_PRESET_TIME);
      } else if (day < start.day) {
        nextStart = reset(start, SUBTASK_START_PRESET_TIME);
        nextEnd = reset(end, DEADLINE_PRESET_TIME);
      } else {
        nextEnd = reset(end, DEADLINE_PRESET_TIME);
      }
      const dropFold = (before: EndDraft, after: EndDraft): EndDraft => (joinCivilMinute(before.day, before.time) === joinCivilMinute(after.day, after.time) ? after : { ...after, fold: null });
      return { touched: true, active: nextActive, offsets: state.offsets, start: dropFold(state.start, nextStart), end: dropFold(state.end, nextEnd) };
    });
    setMonth(civilToCell(day));
  };

  const pickShortcut = (shortcut: ReturnType<typeof buildRangeShortcuts>[number], button: HTMLElement) => {
    // #598: moving the grid to another month removes the focused day; keep focus on the preset instead of letting it fall to the popup.
    button.focus({ preventScroll: true });
    const range = shortcut.resolve();
    const startParts = splitCivilMinute(range.start.localCivil);
    const endParts = splitCivilMinute(range.end.localCivil);
    setDraft((state) => ({
      touched: true,
      active: state.active,
      offsets: state.offsets,
      start: { day: startParts.day, time: startParts.time, timeText: startParts.time ?? "", fold: { minute: range.start.localCivil, choice: foldChoice(range.start.fold) } },
      end: { day: endParts.day, time: endParts.time, timeText: endParts.time ?? "", fold: { minute: range.end.localCivil, choice: foldChoice(range.end.fold) } },
    }));
    // #598: the grid follows the end being edited (as setActive does), not always the start.
    const shownDay = draft.active === "end" ? (endParts.day ?? startParts.day) : startParts.day;
    if (shownDay) setMonth(civilToCell(shownDay));
  };

  const pickSlot = (slot: string) => change(active, { time: slot, timeText: slot });
  const typeTime = (text: string) => {
    const parsed = parseTypedTime(text);
    change(active, { timeText: text, time: parsed.ok ? parsed.time : null });
  };
  const setActive = (which: End) => {
    setAnnouncement(`Editing ${which}`);
    setDraft((state) => ({ ...state, active: which }));
    const day = draft[which].day;
    if (day) setMonth(civilToCell(day));
  };

  const complete = resolved.start.civil !== null && resolved.end.civil !== null;
  const unresolvedFold = (["start", "end"] as const).some((which) => resolved[which].choices !== null && resolved[which].chosen === undefined);
  const gapped = resolved.start.gap !== null || resolved.end.gap !== null;
  const order = resolved.start.epochMs !== null && resolved.end.epochMs !== null && resolved.start.epochMs >= resolved.end.epochMs ? "Start must be before end." : null;
  const blocked = draft.touched && (!complete || timeInvalid || gapped || unresolvedFold || order !== null);
  const hint = draft.touched && !complete && !timeInvalid ? "Pick a start and an end, each with a date and a time." : null;

  const apply = async () => {
    if (!draft.touched) { onClose(); return; }
    if (resolved.start.civil === null || resolved.end.civil === null) return;
    const payload: DateTimeRangeApply = {
      start: { localCivil: resolved.start.civil, ...(resolved.start.chosen ? { disambiguation: resolved.start.chosen } : {}) },
      end: { localCivil: resolved.end.civil, ...(resolved.end.chosen ? { disambiguation: resolved.end.chosen } : {}) },
      ...(reminders ? { reminderOffsetsMinutes: draft.offsets } : {}),
    };
    setApplying(true);
    try {
      await onApply(payload);
      // A save can outlive its popup (Escape mid-save, then reopened): only the instance that started it may close.
      if (mounted.current) onClose();
    } catch {
      // The caller owns the failure message; stay open with the draft so the user can retry.
    } finally {
      // A host that keeps the popup open after a settled Apply (the Timeline cell's conflict review) must not leave it busy.
      if (mounted.current) setApplying(false);
    }
  };

  // The next-reminder line states the SAVED schedule; it goes quiet once the draft departs from it (either end's minute, or the offsets).
  const savedLineStale = reminders !== undefined && draft.touched && (
    resolved.start.civil !== (value?.start.localCivil ?? null)
    || resolved.end.civil !== (value?.end.localCivil ?? null)
    || !sameReminderOffsets(draft.offsets, reminders.offsets)
  );

  const momentText = (which: End) => {
    const { civil } = resolved[which];
    if (!civil) return "Not set";
    const parts = splitCivilMinute(civil);
    return parts.day && parts.time ? `${dayLabel(civil)} · ${parts.time}` : civil;
  };

  return (
    <PopupFrame
      label={label}
      zoneId={zoneId}
      bodyRef={bodyRef}
      applying={applying}
      applyDisabled={blocked}
      reveal={`button[data-range-${active}="true"], button[data-selected-single="true"]`}
      onCancel={onCancel ?? onClose}
      onApply={() => { void apply(); }}
      pinned={(
        <div className="flex flex-col gap-[var(--space-2)]">
          <ButtonGroup aria-label="Edit which end" className="w-full">
            {(["start", "end"] as const).map((which) => (
              <Button
                key={which}
                type="button"
                variant="outline"
                className="flex-1 flex-col items-start gap-0 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary"
                aria-pressed={active === which}
                data-initial-focus={openOn === which && openOn === "end" ? "true" : undefined}
                onClick={() => setActive(which)}
              >
                <span>{TITLES[which]}</span>
                <span className={cn("text-[length:var(--text-2xs)]", active === which ? "text-primary-foreground" : "text-foreground-secondary")}>{momentText(which)}</span>
              </Button>
            ))}
          </ButtonGroup>
          {banner}
          <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
          {order && <FieldError>{order}</FieldError>}
        </div>
      )}
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <div className="flex flex-col gap-[var(--space-4)] min-[721px]:flex-row">
          <ShortcutList shortcuts={shortcuts} activeId={activeId} onPick={pickShortcut} />
          <CalendarPane
            selection={{ mode: "range", start: draft.start.day, end: draft.end.day, activeEnd: active }}
            today={today}
            month={month}
            onMonthChange={setMonth}
            onPickDay={pickDay}
            startYear={startYear}
            endYear={endYear}
          />
          <div className="flex min-w-0 flex-col gap-[var(--space-2)] min-[721px]:w-28 min-[721px]:shrink-0">
            <TimeColumn selected={current.time} skipped={skipped} onPick={pickSlot} />
          </div>
        </div>
        <Field data-invalid={timeInvalid || undefined} data-time-boundary="">
          <FieldLabel htmlFor={timeId}>{TITLES[active]} time</FieldLabel>
          <Input id={timeId} inputMode="numeric" autoComplete="off" placeholder="HH:MM" value={current.timeText} aria-invalid={timeInvalid || undefined} aria-describedby={`${timeId}-help`} onChange={(event) => typeTime(event.target.value)} />
          <FieldDescription id={`${timeId}-help`} className="text-[length:var(--text-xs)]">Any minute, for example 17:07, or pick a slot.</FieldDescription>
          {timeInvalid && <FieldError>{TIME_ERROR}</FieldError>}
          {(["start", "end"] as const).map((which) => resolved[which].gap && <FieldError key={which}>{TITLES[which]}: {resolved[which].gap}</FieldError>)}
          {hint && <FieldDescription className="text-[length:var(--text-xs)]">{hint}</FieldDescription>}
        </Field>
        {(["start", "end"] as const).map((which) => {
          const choices = resolved[which].choices;
          const civil = resolved[which].civil;
          return choices && civil ? <FoldChoice key={which} subject={TITLES[which]} choices={choices} selected={resolved[which].chosen} onSelect={(choice) => change(which, { fold: { minute: civil, choice } })} /> : null;
        })}
        {reminders && <RemindersStrip offsets={draft.offsets} onChange={(offsets) => setDraft((state) => ({ ...state, touched: true, offsets }))} />}
        {reminders && reminders.next !== undefined && <NextReminder saved stale={savedLineStale} next={reminders.next} hasReminders={reminders.offsets.length > 0} />}
        {facts}
        {feedback}
      </div>
    </PopupFrame>
  );
}

export function DateTimeRangePopup({ seedKey, ...props }: DateTimeRangePopupProps) {
  return <DateTimeRangeDraft key={seedKey} {...props} />;
}
