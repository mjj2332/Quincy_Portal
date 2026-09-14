export const SYDNEY_TIME_ZONE = "Australia/Sydney" as const;

export type SydneyCivilDisambiguation = "earlier" | "later";

export type SydneyCivilResolution = {
  localCivil: string;
  instant: string;
  epochMs: number;
  utcOffsetMinutes: number;
  fold: 0 | 1;
};

export type SydneyCivilResolutionError =
  | { ok: false; code: "invalid_local_time"; message: string }
  | { ok: false; code: "nonexistent_local_time"; message: string }
  | { ok: false; code: "repeated_local_time"; message: string; choices: Array<{ disambiguation: SydneyCivilDisambiguation; utcOffsetMinutes: number }> }
  | { ok: false; code: "resolver_defect"; message: string };

export type SydneyCivilResolutionResult = { ok: true; value: SydneyCivilResolution } | SydneyCivilResolutionError;

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const SYDNEY_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: SYDNEY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type ParsedCivil = { year: number; month: number; day: number; hour: number; minute: number; localEpoch: number };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function epochFromCivil(year: number, month: number, day: number, hour: number, minute: number): number {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, 0, 0);
  return value.getTime();
}

function parseCivil(localCivil: string): ParsedCivil | null {
  const match = CIVIL_RE.exec(localCivil);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute, localEpoch: epochFromCivil(year, month, day, hour, minute) };
}

function partsFor(date: Date): Record<string, string> {
  return Object.fromEntries(SYDNEY_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
}

export type SydneyCivilParts = { year: number; month: number; day: number; hour: number; minute: number };

/**
 * The Sydney wall-clock fields of an instant, as numbers — the one `formatToParts` read every
 * caller that needs a Sydney calendar day (deadlines, the calendar, notification day buckets)
 * shares, so none of them re-declares the formatter or parses a locale string back apart.
 */
export function sydneyCivilParts(date: Date): SydneyCivilParts {
  const values = partsFor(date);
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

function offsetAt(epochMs: number): number {
  const projected = partsFor(new Date(epochMs));
  const projectedEpoch = epochFromCivil(Number(projected.year), Number(projected.month), Number(projected.day), Number(projected.hour), Number(projected.minute));
  return Math.round((projectedEpoch - epochMs) / 60_000);
}

/**
 * Keep this intentionally compatible with the Deadline implementation. In
 * particular, Intl emits years below 1000 without left-padding them, and the
 * differential reference relies on that exact round-trip behavior.
 */
function roundTripCivil(date: Date): string {
  const values = partsFor(date);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function candidate(localCivil: string, localEpoch: number, offsetMinutes: number): SydneyCivilResolution | null {
  const epochMs = localEpoch - offsetMinutes * 60_000;
  const instant = new Date(epochMs);
  if (roundTripCivil(instant) !== localCivil) return null;
  return { localCivil, epochMs, instant: instant.toISOString(), utcOffsetMinutes: offsetMinutes, fold: 0 };
}

function finishCandidates(candidates: SydneyCivilResolution[], disambiguation?: SydneyCivilDisambiguation): SydneyCivilResolutionResult {
  const unique = [...new Map(candidates.map((value) => [value.epochMs, value])).values()].sort((a, b) => a.epochMs - b.epochMs);
  if (unique.length === 0) return { ok: false, code: "nonexistent_local_time", message: "That Sydney time does not exist because the clocks move forward." };
  if (unique.length > 2) return { ok: false, code: "resolver_defect", message: "Sydney time resolution returned an unexpected number of matches." };
  if (unique.length === 2 && !disambiguation) {
    return {
      ok: false,
      code: "repeated_local_time",
      message: "That Sydney time occurs twice. Choose Earlier or Later.",
      choices: [
        { disambiguation: "earlier", utcOffsetMinutes: unique[0]!.utcOffsetMinutes },
        { disambiguation: "later", utcOffsetMinutes: unique[1]!.utcOffsetMinutes },
      ],
    };
  }
  const selected = unique.length === 1 ? unique[0]! : unique[disambiguation === "later" ? 1 : 0]!;
  selected.fold = unique.length === 2 && disambiguation === "later" ? 1 : 0;
  return { ok: true, value: selected };
}

/**
 * Resolve a Sydney wall-clock minute in O(1) candidate checks.
 *
 * A projection of the naive civil-as-UTC instant gives a provisional offset.
 * Probe the actual zone offsets around its corresponding instant rather than
 * assuming that historical neighboring offsets are an hour apart. The
 * bounded three-probe set covers Sydney transitions such as the 1895 change
 * from rounded LMT (+604) to +600, while the round-trip set remains O(1).
 */
export function resolveSydneyCivilMinute(localCivil: string, disambiguation?: SydneyCivilDisambiguation): SydneyCivilResolutionResult {
  const parsed = parseCivil(localCivil);
  if (!parsed) return { ok: false, code: "invalid_local_time", message: "Enter a valid Sydney date and time to the minute." };
  const provisionalOffset = offsetAt(parsed.localEpoch);
  const provisionalInstant = parsed.localEpoch - provisionalOffset * 60_000;
  const probeRadius = 6 * 60 * 60_000;
  const offsets = [...new Set([
    provisionalOffset,
    offsetAt(provisionalInstant - probeRadius),
    offsetAt(provisionalInstant + probeRadius),
  ])];
  const candidates = offsets.map((offset) => candidate(localCivil, parsed.localEpoch, offset)).filter((value): value is SydneyCivilResolution => value !== null);
  return finishCandidates(candidates, disambiguation);
}

export function isSydneyCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Boolean(daysInMonth && day >= 1 && day <= daysInMonth);
}

export function formatSydneyCivilMinute(instant: string | number): string {
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) return "Invalid date";
  return roundTripCivil(date);
}
