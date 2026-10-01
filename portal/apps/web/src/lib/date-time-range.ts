import { SUBTASK_END_PRESET_TIME, SUBTASK_START_PRESET_TIME, resolveSydneyCivilMinute, type ProjectDefaultRangeDto } from "@quincy/shared";
import { addCivilDays, civilWeekday } from "@/lib/date-time-field";

/**
 * #423 — the pure rules behind the range form of `quincy/DateTimeField` (ADR 0016): the shortcut
 * rows and the Project default a Subtask range starts from. A range is two Sydney civil minutes,
 * each with the fold it was stored with. Weeks run Monday to Sunday, as in the single-day shortcuts.
 */

/** A range as the popup holds it: two civil minutes (`YYYY-MM-DDTHH:mm`) and their folds. */
export type DateTimeRangeValue = ProjectDefaultRangeDto;

export type RangeShortcutId = "today" | "tomorrow" | "this-week" | "next-week" | "project-default";

export type RangeShortcut = {
  id: RangeShortcutId;
  label: string;
  sublabel: string;
  resolve: () => DateTimeRangeValue;
};

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dayLabel(civil: string): string {
  const [, month = "1", day = "1"] = civil.slice(0, 10).split("-");
  return `${WEEKDAY_NAMES[civilWeekday(civil.slice(0, 10)) - 1]} ${Number(day)} ${MONTH_NAMES[Number(month) - 1]}`;
}

/** One day at the presets: 09:00 to 17:00. */
function presetDay(start: string, end: string = start): DateTimeRangeValue {
  return { start: { localCivil: `${start}T${SUBTASK_START_PRESET_TIME}`, fold: 0 }, end: { localCivil: `${end}T${SUBTASK_END_PRESET_TIME}`, fold: 0 } };
}

/**
 * The shortcut rows for a popup opened on Sydney day `today`. A shortcut sets a whole range at the
 * presets (it replaces both ends, and the times with them): Today and Tomorrow are one 09:00 to
 * 17:00 day, This week runs today 09:00 to Sunday 17:00, Next week Monday 09:00 to Sunday 17:00.
 * "Project default" re-copies the Project's current span and is absent when there is none. There is
 * no "No date": a Subtask always has a range.
 */
export function buildRangeShortcuts({ today, projectDefault }: { today: string; projectDefault: DateTimeRangeValue | null }): RangeShortcut[] {
  const iso = civilWeekday(today);
  const tomorrow = addCivilDays(today, 1);
  const thisSunday = addCivilDays(today, 7 - iso);
  const nextMonday = addCivilDays(today, 8 - iso);
  const nextSunday = addCivilDays(nextMonday, 6);
  const rows: RangeShortcut[] = [
    { id: "today", label: "Today", sublabel: dayLabel(today).split(" ")[0]!, resolve: () => presetDay(today) },
    { id: "tomorrow", label: "Tomorrow", sublabel: dayLabel(tomorrow).split(" ")[0]!, resolve: () => presetDay(tomorrow) },
    { id: "this-week", label: "This week", sublabel: `${dayLabel(today).split(" ")[0]} to Sun`, resolve: () => presetDay(today, thisSunday) },
    { id: "next-week", label: "Next week", sublabel: `${dayLabel(nextMonday)} to ${dayLabel(nextSunday)}`, resolve: () => presetDay(nextMonday, nextSunday) },
  ];
  if (projectDefault) {
    rows.push({ id: "project-default", label: "Project default", sublabel: `${dayLabel(projectDefault.start.localCivil)} to ${dayLabel(projectDefault.end.localCivil)}`, resolve: () => projectDefault });
  }
  return rows;
}

/**
 * The Project default as a client holds it, derived from a Project's own facts (the Timeline row and
 * the Calendar bounds carry these; the Checklist's list response carries the finished range). The
 * same rule as `defaultSubtaskRange` in `@quincy/shared`: this only names the inputs.
 */
export function deadlineFoldOf(localCivil: string, atInstant: string): 0 | 1 {
  const earlier = resolveSydneyCivilMinute(localCivil, "earlier");
  return earlier.ok && earlier.value.instant !== atInstant ? 1 : 0;
}
