import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  resolveSydneyCivilMinute,
  type SydneyCivilResolution,
} from "@quincy/shared";

export type FullCalendarCallbackValue = {
  allDay: boolean;
  date: Date;
  dateStr: string;
};

export type SydneyCivilCallbackOutput =
  | { allDay: true; date: string }
  | { allDay: false; date: string; localCivil: string; utcOffsetMinutes: number };

function resolutionForInstant(localCivil: string, instant: string): SydneyCivilResolution {
  const resolution = resolveSydneyCivilMinute(localCivil);
  if (resolution.ok) return resolution.value;

  if (resolution.code !== "repeated_local_time") {
    throw new RangeError(`FullCalendar returned an unresolvable Sydney time: ${resolution.code}.`);
  }

  for (const disambiguation of ["earlier", "later"] as const) {
    const candidate = resolveSydneyCivilMinute(localCivil, disambiguation);
    if (candidate.ok && candidate.value.instant.slice(0, 16) === instant.slice(0, 16)) return candidate.value;
  }

  throw new RangeError("FullCalendar returned an instant that does not match either Sydney fold occurrence.");
}

/**
 * Convert FullCalendar's callback values without consulting the browser's local zone.
 * Date is used only as the instant supplied by FullCalendar; civil formatting and offset
 * resolution remain owned by @quincy/shared.
 */
export function fullCalendarCallbackToSydneyCivil(value: FullCalendarCallbackValue): SydneyCivilCallbackOutput {
  if (value.allDay) {
    if (!isSydneyCalendarDate(value.dateStr)) throw new RangeError("FullCalendar returned an invalid all-day Sydney date.");
    return { allDay: true, date: value.dateStr };
  }

  const date = value.date.toISOString();
  const localCivil = formatSydneyCivilMinute(date);
  if (localCivil === "Invalid date") throw new RangeError("FullCalendar returned an invalid timed date.");
  const resolution = resolutionForInstant(localCivil, date);
  return { allDay: false, date, localCivil, utcOffsetMinutes: resolution.utcOffsetMinutes };
}
