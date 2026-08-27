import { describe, expect, it } from "vitest";
import {
  CHECKLIST_SCHEDULE_ZONE,
  normalizeChecklistSchedule,
  serializeChecklistSchedule,
  type ChecklistScheduleStorage,
} from "../src/checklist-schedule";
import { resolveSydneyCivilMinute, resolveSydneyCivilMinuteExhaustive } from "../src/sydney-civil-time";

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
  it("keeps the O(1) resolver equal to the exhaustive reference corpus", () => {
    const corpus = [
      "2026-08-27T09:15",
      "1894-01-01T12:00", // Sydney LMT (+10:04:52) boundary
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
        expect(resolveSydneyCivilMinute(civil, disambiguation), `${civil}/${disambiguation}`).toEqual(resolveSydneyCivilMinuteExhaustive(civil, disambiguation));
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
