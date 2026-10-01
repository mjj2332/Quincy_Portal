import { describe, expect, it } from "vitest";
import {
  CHECKLIST_SCHEDULE_ZONE,
  ChecklistScheduleStorageError,
  normalizeChecklistSchedule,
  serializeChecklistSchedule,
  type ChecklistScheduleStorage,
} from "../src/checklist-schedule";
import { resolveSydneyCivilMinute } from "../src/sydney-civil-time";

const INDEPENDENT_SYDNEY_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type IndependentCandidate = { localCivil: string; instant: string; epochMs: number; utcOffsetMinutes: number; fold: 0 | 1 };
type IndependentResult =
  | { ok: true; value: IndependentCandidate }
  | { ok: false; code: "invalid_local_time" | "nonexistent_local_time" | "resolver_defect"; message: string }
  | { ok: false; code: "repeated_local_time"; message: string; choices: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }> };

function independentLeapYear(year: number) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
function independentEpoch(year: number, month: number, day: number, hour: number, minute: number) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, 0, 0);
  return value.getTime();
}
function independentParse(localCivil: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localCivil);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); const hour = Number(match[4]); const minute = Number(match[5]);
  const daysInMonth = [31, independentLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59) return null;
  return independentEpoch(year, month, day, hour, minute);
}
const independentCivilCache = new Map<number, string>();
function independentCivil(epochMs: number) {
  const cached = independentCivilCache.get(epochMs);
  if (cached !== undefined) return cached;
  const date = new Date(epochMs);
  const parts = Object.fromEntries(INDEPENDENT_SYDNEY_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
  const civil = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  independentCivilCache.set(epochMs, civil);
  return civil;
}
const independentUniqueCache = new Map<string, readonly Readonly<IndependentCandidate>[] | null>();
function independentUnique(localCivil: string): readonly Readonly<IndependentCandidate>[] | null {
  const cached = independentUniqueCache.get(localCivil);
  if (cached !== undefined) return cached;
  const localEpoch = independentParse(localCivil);
  if (localEpoch === null) {
    independentUniqueCache.set(localCivil, null);
    return null;
  }
  const candidates: IndependentCandidate[] = [];
  for (let offset = -840; offset <= 840; offset += 1) {
    const epochMs = localEpoch - offset * 60_000;
    if (independentCivil(epochMs) === localCivil) candidates.push({ localCivil, instant: new Date(epochMs).toISOString(), epochMs, utcOffsetMinutes: offset, fold: 0 });
  }
  const unique = [...new Map(candidates.map((value) => [value.epochMs, value])).values()]
    .sort((a, b) => a.epochMs - b.epochMs)
    .map((value) => Object.freeze(value));
  independentUniqueCache.set(localCivil, unique);
  return unique;
}
function independentResolve(localCivil: string, disambiguation?: "earlier" | "later"): IndependentResult {
  const localEpoch = independentParse(localCivil);
  if (localEpoch === null) return { ok: false, code: "invalid_local_time", message: "Enter a valid Sydney date and time to the minute." };
  const unique = independentUnique(localCivil)!;
  if (unique.length === 0) return { ok: false, code: "nonexistent_local_time", message: "That Sydney time does not exist because the clocks move forward." };
  if (unique.length > 2) return { ok: false, code: "resolver_defect", message: "Sydney time resolution returned an unexpected number of matches." };
  if (unique.length === 2 && !disambiguation) return { ok: false, code: "repeated_local_time", message: "That Sydney time occurs twice. Choose Earlier or Later.", choices: [{ disambiguation: "earlier", utcOffsetMinutes: unique[0]!.utcOffsetMinutes }, { disambiguation: "later", utcOffsetMinutes: unique[1]!.utcOffsetMinutes }] };
  const base = unique.length === 1 ? unique[0]! : unique[disambiguation === "later" ? 1 : 0]!;
  const selected: IndependentCandidate = { ...base, fold: unique.length === 2 && disambiguation === "later" ? 1 : 0 };
  return { ok: true, value: selected };
}

function storage(overrides: Partial<ChecklistScheduleStorage> = {}): ChecklistScheduleStorage {
  return {
    dueDate: null,
    scheduleStartKind: null,
    scheduleStartCivil: null,
    scheduleStartAt: null,
    scheduleStartUtcOffsetMinutes: null,
    scheduleStartFold: null,
    scheduleEndKind: null,
    scheduleEndAt: null,
    scheduleEndUtcOffsetMinutes: null,
    scheduleEndFold: null,
    scheduleZone: null,
    scheduleVersion: 0,
    ...overrides,
  };
}

describe("TB4D checklist schedule resolver and discriminator", () => {
  it("keeps the O(1) resolver bit-identical to an independent Intl scan", () => {
    const corpus = [
      "2026-08-27T09:15",
      "1894-01-01T12:00", // Sydney LMT (+10:04:52) boundary
      // Sydney's 1895 transition rounds LMT to +604 minutes before moving
      // back to +600; these minutes exercise both sides of that short fold.
      ...["1894-12-31", "1895-01-01", "1895-01-31", "1895-02-01"].flatMap((date) => ["00:00", "00:01", "12:00", "23:58", "23:59"].map((time) => `${date}T${time}`)),
      ...["23:55", "23:56", "23:57", "23:58", "23:59"].map((time) => `1895-01-31T${time}`),
      "0999-01-01T12:00", // Intl's unpadded-year compatibility boundary
      "9999-12-31T23:59", // far-future transition-free date
      ...["2026-10-04", "2026-04-05"].flatMap((date) => Array.from({ length: 5 * 60 }, (_, index) => {
        const hour = Math.floor(index / 60).toString().padStart(2, "0");
        const minute = (index % 60).toString().padStart(2, "0");
        return `${date}T${hour}:${minute}`;
      })),
      "2026-02-29T09:00", "2026-01-01T24:00", "2026-1-01T09:00", "not-a-date",
    ];
    for (const civil of corpus) {
      for (const disambiguation of [undefined, "earlier", "later"] as const) {
        expect(resolveSydneyCivilMinute(civil, disambiguation), `${civil}/${disambiguation}`).toEqual(independentResolve(civil, disambiguation));
      }
    }
  }, 20_000);

  const timedRange = (start: string, end: string) => {
    const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: start }, end: { localCivil: end } }, 1);
    if (!result.ok) throw new Error("fixture must normalize");
    return result.value;
  };

  it("serializes a stored range with resolved offsets and no endpoint kind", () => {
    const dto = serializeChecklistSchedule(timedRange("2026-08-27T09:00", "2026-08-27T10:30"));
    expect(dto).toEqual({
      state: "range", version: 1, zone: CHECKLIST_SCHEDULE_ZONE, due: "2026-08-27T10:30",
      start: { localCivil: "2026-08-27T09:00", instant: "2026-08-26T23:00:00.000Z", utcOffsetMinutes: 600, fold: 0, resolution: "stored" },
      end: { localCivil: "2026-08-27T10:30", instant: "2026-08-27T00:30:00.000Z", utcOffsetMinutes: 600, fold: 0, resolution: "stored" },
    });
  });

  it("accepts any start before end by instant, including under a day", () => {
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-08-27T09:00" }, end: { localCivil: "2026-08-27T09:01" } }, 1)).toMatchObject({ ok: true });
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-08-27T09:00" }, end: { localCivil: "2026-08-27T09:00" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-08-27T10:00" }, end: { localCivil: "2026-08-27T09:00" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
  });

  it("orders by instant across the autumn fold, not by civil text", () => {
    // 2026-04-05 02:30 happens twice: the later 02:30 is after a 03:00-less civil comparison would say.
    const result = normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, end: { localCivil: "2026-04-05T03:00" } }, 1);
    expect(result).toMatchObject({ ok: true, value: { scheduleStartFold: 1, scheduleStartUtcOffsetMinutes: 600 } });
    const inverted = normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, end: { localCivil: "2026-04-05T02:45", disambiguation: "earlier" } }, 1);
    expect(inverted).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_order" } });
  });

  it("names the endpoint of a date-only end and asks for a time", () => {
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-08-27T09:00" }, end: { localCivil: "2026-08-28" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_time_required", endpoint: "end" } });
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-08-27" }, end: { localCivil: "2026-08-28T17:00" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_time_required", endpoint: "start" } });
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-02-30" }, end: { localCivil: "2026-08-28T17:00" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_invalid_local_time", endpoint: "start" } });
  });

  it("reports gaps and repeated times against their endpoint", () => {
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-10-04T02:30" }, end: { localCivil: "2026-10-04T17:00" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_nonexistent_local_time", endpoint: "start" } });
    expect(normalizeChecklistSchedule({ state: "range", start: { localCivil: "2026-04-05T09:00" }, end: { localCivil: "2026-04-05T02:30" } }, 1)).toMatchObject({ ok: false, error: { code: "subtask_schedule_repeated_local_time", endpoint: "end" } });
  });

  it("throws ChecklistScheduleStorageError for every storage that is not a valid moment range", () => {
    const reasonOf = (row: ChecklistScheduleStorage) => {
      try { serializeChecklistSchedule(row); } catch (error) { expect(error).toBeInstanceOf(ChecklistScheduleStorageError); return (error as ChecklistScheduleStorageError).reason; }
      throw new Error("expected the serializer to throw");
    };
    expect(reasonOf(storage())).toBe("not_a_range");
    expect(reasonOf(storage({ dueDate: "2026-08-27" }))).toBe("not_a_range");
    expect(reasonOf(storage({ dueDate: "2026-08-27T09:15" }))).toBe("not_a_range");
    expect(reasonOf(storage({ scheduleVersion: 1 }))).toBe("not_a_range");
    const timed = timedRange("2026-04-05T09:00", "2026-04-05T10:00");
    expect(reasonOf({ ...timed, scheduleZone: "UTC" })).toBe("not_a_range");
    // A surviving date-only row is a defect after migration 0052.
    expect(reasonOf({ ...timed, scheduleStartKind: "date", scheduleEndKind: "date" })).toBe("not_a_range");
    expect(reasonOf({ ...timed, scheduleEndFold: 1 })).toBe("resolution_mismatch");
    expect(reasonOf({ ...timed, scheduleEndUtcOffsetMinutes: 660 })).toBe("resolution_mismatch");
    expect(reasonOf({ ...timed, scheduleEndAt: null })).toBe("resolution_mismatch");
    expect(reasonOf({ ...timed, scheduleStartCivil: "2026-04-05" })).toBe("resolution_mismatch");
    const later = timedRange("2026-08-27T10:00", "2026-08-27T11:00");
    const earlier = timedRange("2026-08-27T09:00", "2026-08-27T09:30");
    expect(reasonOf({ ...later, dueDate: earlier.dueDate, scheduleEndAt: earlier.scheduleEndAt, scheduleEndUtcOffsetMinutes: earlier.scheduleEndUtcOffsetMinutes, scheduleEndFold: earlier.scheduleEndFold })).toBe("ordering_invalid");
  });

  it("does not carry row content in the storage error message", () => {
    expect(() => serializeChecklistSchedule(storage({ dueDate: "2026-08-27T09:15" }))).toThrow(/^Subtask schedule storage is not a valid range \(not_a_range\)\.$/);
  });

  it("rejects a non-range input at runtime as well as in the type", () => {
    for (const input of [{ state: "unscheduled" }, { state: "due_only", end: { localCivil: "2026-08-27T09:00" } }]) {
      const result = normalizeChecklistSchedule(input as never, 1);
      expect(result).toMatchObject({ ok: false, error: { code: "subtask_schedule_not_a_range" } });
    }
  });

  it("keeps the warmed 20-row serializer inside the measured CPU ceiling", () => {
    const rows = Array.from({ length: 20 }, (_, index) => timedRange(`2026-08-${String(index + 1).padStart(2, "0")}T09:15`, `2026-08-${String(index + 1).padStart(2, "0")}T10:15`));
    for (let warmup = 0; warmup < 10; warmup += 1) rows.forEach(serializeChecklistSchedule);
    const samples: number[] = [];
    for (let repetition = 0; repetition < 100; repetition += 1) {
      const start = performance.now();
      rows.forEach(serializeChecklistSchedule);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.info(`TB4D serializer benchmark: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms, 20 rows, Node ${process.version}`);
    expect(p95).toBeLessThan(10);
  });
});
