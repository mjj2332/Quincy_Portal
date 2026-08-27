import { describe, expect, it } from "vitest";
import {
  CHECKLIST_SCHEDULE_ZONE,
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
function independentCivil(date: Date) {
  const parts = Object.fromEntries(INDEPENDENT_SYDNEY_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function independentResolve(localCivil: string, disambiguation?: "earlier" | "later"): IndependentResult {
  const localEpoch = independentParse(localCivil);
  if (localEpoch === null) return { ok: false, code: "invalid_local_time", message: "Enter a valid Sydney date and time to the minute." };
  const candidates: IndependentCandidate[] = [];
  for (let offset = -840; offset <= 840; offset += 1) {
    const epochMs = localEpoch - offset * 60_000;
    if (independentCivil(new Date(epochMs)) === localCivil) candidates.push({ localCivil, instant: new Date(epochMs).toISOString(), epochMs, utcOffsetMinutes: offset, fold: 0 });
  }
  const unique = [...new Map(candidates.map((value) => [value.epochMs, value])).values()].sort((a, b) => a.epochMs - b.epochMs);
  if (unique.length === 0) return { ok: false, code: "nonexistent_local_time", message: "That Sydney time does not exist because the clocks move forward." };
  if (unique.length > 2) return { ok: false, code: "resolver_defect", message: "Sydney time resolution returned an unexpected number of matches." };
  if (unique.length === 2 && !disambiguation) return { ok: false, code: "repeated_local_time", message: "That Sydney time occurs twice. Choose Earlier or Later.", choices: [{ disambiguation: "earlier", utcOffsetMinutes: unique[0]!.utcOffsetMinutes }, { disambiguation: "later", utcOffsetMinutes: unique[1]!.utcOffsetMinutes }] };
  const selected = unique.length === 1 ? unique[0]! : unique[disambiguation === "later" ? 1 : 0]!;
  selected.fold = unique.length === 2 && disambiguation === "later" ? 1 : 0;
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

  it("partitions legacy rows into unscheduled, due-only, or unresolved states", () => {
    expect(serializeChecklistSchedule(storage())).toMatchObject({ state: "unscheduled", version: 0 });
    expect(serializeChecklistSchedule(storage({ dueDate: "2026-08-27" }))).toMatchObject({ state: "due_only", due: "2026-08-27", end: { kind: "date", resolution: "stored" } });
    expect(serializeChecklistSchedule(storage({ dueDate: "2026-08-27T09:15" }))).toMatchObject({ state: "due_only", end: { kind: "timed", resolution: "derived_unambiguous" } });
    expect(serializeChecklistSchedule(storage({ dueDate: "2026-10-04T02:30" })).error).toMatchObject({ reason: "nonexistent_local_time" });
    expect(serializeChecklistSchedule(storage({ dueDate: "2026-04-05T02:30" })).error).toMatchObject({ reason: "repeated_local_time", foldChoices: [{ disambiguation: "earlier" }, { disambiguation: "later" }] });
    expect(serializeChecklistSchedule(storage({ dueDate: "not-a-date" }))).toMatchObject({ state: "legacy_unresolved", error: { reason: "invalid_literal" } });
  });

  it("serializes every versioned shape fail-closed", () => {
    expect(serializeChecklistSchedule(storage({ scheduleVersion: 1, scheduleZone: null }))).toMatchObject({ state: "unscheduled", zone: CHECKLIST_SCHEDULE_ZONE });
    expect(serializeChecklistSchedule(storage({ scheduleVersion: 0, scheduleZone: CHECKLIST_SCHEDULE_ZONE }))).toMatchObject({ state: "invalid", error: { reason: "shape_mismatch" } });

    const due = normalizeChecklistSchedule({ state: "due_only", end: { kind: "date", localCivil: "2026-08-27" } }, 1);
    expect(due.ok).toBe(true);
    if (due.ok) expect(serializeChecklistSchedule(due.value)).toMatchObject({ state: "due_only", version: 1, end: { kind: "date" } });

    const range = normalizeChecklistSchedule({ state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } }, 1);
    expect(range.ok).toBe(true);
    if (range.ok) expect(serializeChecklistSchedule(range.value)).toMatchObject({ state: "range", version: 1, start: { localCivil: "2026-08-27" }, end: { localCivil: "2026-08-28" } });

    expect(serializeChecklistSchedule(storage({ scheduleVersion: 1, scheduleZone: CHECKLIST_SCHEDULE_ZONE, dueDate: "2026-08-27", scheduleEndKind: "date", scheduleEndAt: 1 }))).toMatchObject({ state: "invalid", error: { reason: "resolution_mismatch" } });
    expect(serializeChecklistSchedule(storage({ scheduleVersion: 1, scheduleZone: CHECKLIST_SCHEDULE_ZONE, dueDate: "2026-08-27", scheduleStartKind: "date", scheduleStartCivil: "2026-08-28", scheduleEndKind: "date" }))).toMatchObject({ state: "invalid", error: { reason: "ordering_invalid" } });
    expect(serializeChecklistSchedule(storage({ scheduleVersion: 1, scheduleZone: "UTC", dueDate: "2026-08-27", scheduleEndKind: "date" }))).toMatchObject({ state: "invalid", error: { reason: "shape_mismatch" } });
  });

  it("keeps the warmed 20-row serializer inside the measured CPU ceiling", () => {
    const rows = Array.from({ length: 20 }, (_, index) => storage({ dueDate: `2026-08-${String(index + 1).padStart(2, "0")}T09:15` }));
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
