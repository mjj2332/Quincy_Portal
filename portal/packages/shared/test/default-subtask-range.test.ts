import { describe, expect, it } from "vitest";
import { defaultSubtaskRange } from "../src/default-subtask-range";
import { normalizeChecklistSchedule } from "../src/checklist-schedule";

// 2026-06-30T15:00Z is 2026-07-01 01:00 in Sydney: the UTC and Sydney dates differ.
const CREATED_SPLIT = Date.UTC(2026, 5, 30, 15);
// 2026-07-01T02:00Z is 2026-07-01 12:00 in Sydney: the UTC and Sydney dates agree.
const CREATED_PLAIN = Date.UTC(2026, 6, 1, 2);

const date = (localCivil: string) => ({ kind: "date" as const, localCivil });
const timed = (localCivil: string, disambiguation?: "earlier" | "later") => ({ kind: "timed" as const, localCivil, ...(disambiguation ? { disambiguation } : {}) });

type Row = {
  name: string;
  input: Parameters<typeof defaultSubtaskRange>[0];
  start: ReturnType<typeof date> | ReturnType<typeof timed>;
  end: ReturnType<typeof date> | ReturnType<typeof timed>;
};

const rows: Row[] = [
  { name: "shoot date and timed Deadline give date ends", input: { shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00", projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-02"), end: date("2026-11-06") },
  { name: "missing shoot date falls back to the Sydney creation date, not the UTC date", input: { shootDate: null, deadlineLocalCivil: null, projectCreatedAt: CREATED_SPLIT }, start: date("2026-07-01"), end: date("2026-07-01") },
  { name: "undefined shoot date falls back to the creation date", input: { shootDate: undefined, deadlineLocalCivil: "2026-07-09T10:00", projectCreatedAt: CREATED_SPLIT }, start: date("2026-07-01"), end: date("2026-07-09") },
  { name: "non-canonical shoot text falls back", input: { shootDate: "Thursday, 17 Sep, 2026", deadlineLocalCivil: "2026-07-09T10:00", projectCreatedAt: CREATED_SPLIT }, start: date("2026-07-01"), end: date("2026-07-09") },
  { name: "impossible shoot date falls back", input: { shootDate: "2026-02-30", deadlineLocalCivil: null, projectCreatedAt: CREATED_SPLIT }, start: date("2026-07-01"), end: date("2026-07-01") },
  { name: "empty shoot date falls back", input: { shootDate: "", deadlineLocalCivil: null, projectCreatedAt: CREATED_SPLIT }, start: date("2026-07-01"), end: date("2026-07-01") },
  { name: "missing Deadline makes a one-day range on the shoot date", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-02"), end: date("2026-11-02") },
  { name: "malformed Deadline counts as missing", input: { shootDate: "2026-11-02", deadlineLocalCivil: "soon", projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-02"), end: date("2026-11-02") },
  { name: "date-only Deadline is accepted", input: { shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-05", projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-02"), end: date("2026-11-05") },
  { name: "Deadline before the shoot date collapses to one day on the Deadline", input: { shootDate: "2026-11-10", deadlineLocalCivil: "2026-11-06T09:00", projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-06"), end: date("2026-11-06") },
  { name: "Deadline before the fallback creation date collapses to the Deadline", input: { shootDate: null, deadlineLocalCivil: "2026-06-20T09:00", projectCreatedAt: CREATED_SPLIT }, start: date("2026-06-20"), end: date("2026-06-20") },
  { name: "Deadline equal to the shoot date is one day", input: { shootDate: "2026-11-06", deadlineLocalCivil: "2026-11-06T23:00", projectCreatedAt: CREATED_PLAIN }, start: date("2026-11-06"), end: date("2026-11-06") },
  { name: "existing date due after the shoot date keeps the due as end and ignores the Deadline", input: { shootDate: "2026-11-02", deadlineLocalCivil: "2026-12-25T10:00", projectCreatedAt: CREATED_PLAIN, existingDueEnd: date("2026-11-20") }, start: date("2026-11-02"), end: date("2026-11-20") },
  { name: "existing date due before the shoot date collapses to the due", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: date("2026-10-28") }, start: date("2026-10-28"), end: date("2026-10-28") },
  { name: "existing date due with missing shoot date starts on the Sydney creation date", input: { shootDate: null, deadlineLocalCivil: null, projectCreatedAt: CREATED_SPLIT, existingDueEnd: date("2026-07-20") }, start: date("2026-07-01"), end: date("2026-07-20") },
  { name: "existing date due equal to the shoot date is one day", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: date("2026-11-02") }, start: date("2026-11-02"), end: date("2026-11-02") },
  { name: "existing timed due after the shoot date starts at 00:00 on the shoot date", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-11-20T15:30") }, start: timed("2026-11-02T00:00"), end: timed("2026-11-20T15:30") },
  { name: "existing timed due before the shoot date collapses to a day ending on the due", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-10-28T15:30") }, start: timed("2026-10-28T00:00"), end: timed("2026-10-28T15:30") },
  { name: "existing timed due exactly at 00:00 that collapses starts 00:00 on the preceding day", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-10-28T00:00") }, start: timed("2026-10-27T00:00"), end: timed("2026-10-28T00:00") },
  { name: "existing timed due at 00:00 on the shoot date collapses to the preceding day", input: { shootDate: "2026-11-02", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-11-02T00:00") }, start: timed("2026-11-01T00:00"), end: timed("2026-11-02T00:00") },
  { name: "preceding-day collapse crosses a month boundary", input: { shootDate: "2026-12-05", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-12-01T00:00") }, start: timed("2026-11-30T00:00"), end: timed("2026-12-01T00:00") },
  { name: "existing timed due with missing shoot date starts on the creation date", input: { shootDate: null, deadlineLocalCivil: null, projectCreatedAt: CREATED_SPLIT, existingDueEnd: timed("2026-07-20T09:00") }, start: timed("2026-07-01T00:00"), end: timed("2026-07-20T09:00") },
];

describe("defaultSubtaskRange matrix", () => {
  it.each(rows)("$name", ({ input, start, end }) => {
    const range = defaultSubtaskRange(input);
    expect(range).toEqual({ state: "range", start, end });
    const normalized = normalizeChecklistSchedule(range, 1);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value.state).toBe("range");
      expect(normalized.value.scheduleStartKind).toBe(normalized.value.scheduleEndKind);
    }
  });
});

describe("defaultSubtaskRange daylight saving", () => {
  it("resolves a 00:00 start on the day daylight saving begins at +10:00 and the end at +11:00", () => {
    const range = defaultSubtaskRange({ shootDate: "2026-10-04", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-10-05T09:00") });
    const normalized = normalizeChecklistSchedule(range, 1);
    expect(normalized.ok && normalized.value.scheduleStartUtcOffsetMinutes).toBe(600);
    expect(normalized.ok && normalized.value.scheduleEndUtcOffsetMinutes).toBe(660);
    expect(normalized.ok && normalized.value.scheduleStartFold).toBe(0);
  });

  it("resolves a 00:00 start on the day daylight saving ends at +11:00", () => {
    const range = defaultSubtaskRange({ shootDate: "2026-04-05", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-04-06T09:00") });
    const normalized = normalizeChecklistSchedule(range, 1);
    expect(normalized.ok && normalized.value.scheduleStartUtcOffsetMinutes).toBe(660);
    expect(normalized.ok && normalized.value.scheduleEndUtcOffsetMinutes).toBe(600);
  });

  it("keeps the disambiguation of a repeated existing end", () => {
    const range = defaultSubtaskRange({ shootDate: "2026-04-05", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-04-05T02:30", "later") });
    expect(range).toEqual({ state: "range", start: timed("2026-04-05T00:00"), end: timed("2026-04-05T02:30", "later") });
    const normalized = normalizeChecklistSchedule(range, 1);
    expect(normalized.ok && normalized.value.scheduleEndFold).toBe(1);
  });

  it("collapses a timed range whose midnight start would equal a repeated end's day start", () => {
    const range = defaultSubtaskRange({ shootDate: "2026-04-10", deadlineLocalCivil: null, projectCreatedAt: CREATED_PLAIN, existingDueEnd: timed("2026-04-05T02:30", "earlier") });
    expect(range).toEqual({ state: "range", start: timed("2026-04-05T00:00"), end: timed("2026-04-05T02:30", "earlier") });
    expect(normalizeChecklistSchedule(range, 1).ok).toBe(true);
  });
});

describe("defaultSubtaskRange with an unusable existing end", () => {
  it.each([
    ["invalid date literal", date("2026-13-40")],
    ["invalid timed literal", timed("nope")],
    ["nonexistent timed end", timed("2026-10-04T02:30")],
    ["repeated timed end without a disambiguation", timed("2026-04-05T02:30")],
  ])("ignores a %s and uses the plain default", (_name, existingDueEnd) => {
    expect(defaultSubtaskRange({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00", projectCreatedAt: CREATED_PLAIN, existingDueEnd }))
      .toEqual({ state: "range", start: date("2026-11-02"), end: date("2026-11-06") });
  });

  it("throws on a non-finite creation time", () => {
    expect(() => defaultSubtaskRange({ shootDate: null, deadlineLocalCivil: null, projectCreatedAt: Number.NaN })).toThrow(RangeError);
  });
});
