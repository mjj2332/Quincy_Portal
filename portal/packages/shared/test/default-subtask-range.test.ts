import { describe, expect, it } from "vitest";
import { defaultSubtaskRange, defaultSubtaskRangeDto, notBeforeNow, projectDefaultAsOf, projectDefaultRangeSchema, type DefaultSubtaskRangeInput } from "../src/default-subtask-range";
import { normalizeChecklistSchedule, SUBTASK_END_PRESET_TIME, SUBTASK_START_PRESET_TIME } from "../src/checklist-schedule";

// 2026-06-30T15:00Z is 2026-07-01 01:00 in Sydney: the UTC and Sydney dates differ.
const CREATED_SPLIT = Date.UTC(2026, 5, 30, 15);
// 2026-07-01T02:00Z is 2026-07-01 12:00 in Sydney: the UTC and Sydney dates agree.
const CREATED_PLAIN = Date.UTC(2026, 6, 1, 2);
// Before every date in the matrix, so those rows exercise the base rule only.
const NOW = Date.UTC(2026, 2, 1);

type Row = { name: string; input: DefaultSubtaskRangeInput; start: string; end: string; endDisambiguation?: "earlier" | "later" };

const deadline = (localCivil: string, fold: 0 | 1 = 0) => ({ localCivil, fold });

const rows: Row[] = [
  { name: "shoot date 09:00 through the Deadline at its own time", input: { shootDate: "2026-11-02", deadline: deadline("2026-11-06T15:30"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-02T09:00", end: "2026-11-06T15:30", endDisambiguation: "earlier" },
  { name: "missing shoot date falls back to the Sydney creation date, not the UTC date", input: { shootDate: null, deadline: null, projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-07-01T09:00", end: "2026-07-01T17:00" },
  { name: "undefined shoot date falls back to the creation date", input: { shootDate: undefined, deadline: deadline("2026-07-09T10:00"), projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-07-01T09:00", end: "2026-07-09T10:00", endDisambiguation: "earlier" },
  { name: "non-canonical shoot text falls back", input: { shootDate: "Thursday, 17 Sep, 2026", deadline: deadline("2026-07-09T10:00"), projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-07-01T09:00", end: "2026-07-09T10:00", endDisambiguation: "earlier" },
  { name: "impossible shoot date falls back", input: { shootDate: "2026-02-30", deadline: null, projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-07-01T09:00", end: "2026-07-01T17:00" },
  { name: "empty shoot date falls back", input: { shootDate: "", deadline: null, projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-07-01T09:00", end: "2026-07-01T17:00" },
  { name: "missing Deadline makes 09:00 to 17:00 on the shoot date", input: { shootDate: "2026-11-02", deadline: null, projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-02T09:00", end: "2026-11-02T17:00" },
  { name: "malformed Deadline counts as missing", input: { shootDate: "2026-11-02", deadline: deadline("soon"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-02T09:00", end: "2026-11-02T17:00" },
  { name: "a legacy date-only Deadline takes the end preset", input: { shootDate: "2026-11-02", deadline: deadline("2026-11-05"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-02T09:00", end: "2026-11-05T17:00", endDisambiguation: "earlier" },
  { name: "a Deadline on the shoot day after 09:00 is a same-day range", input: { shootDate: "2026-11-06", deadline: deadline("2026-11-06T12:30"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-06T09:00", end: "2026-11-06T12:30", endDisambiguation: "earlier" },
  { name: "a Deadline before the shoot date starts at 09:00 on the Deadline's day", input: { shootDate: "2026-11-10", deadline: deadline("2026-11-06T15:00"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-06T09:00", end: "2026-11-06T15:00", endDisambiguation: "earlier" },
  { name: "a Deadline at 09:00 on a day before the shoot date starts the day before", input: { shootDate: "2026-11-10", deadline: deadline("2026-11-06T09:00"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-05T09:00", end: "2026-11-06T09:00", endDisambiguation: "earlier" },
  { name: "a Deadline before 09:00 on the shoot day starts the day before", input: { shootDate: "2026-11-06", deadline: deadline("2026-11-06T07:15"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-11-05T09:00", end: "2026-11-06T07:15", endDisambiguation: "earlier" },
  { name: "the day before crosses a month and a leap day", input: { shootDate: "2028-03-05", deadline: deadline("2028-03-01T08:00"), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2028-02-29T09:00", end: "2028-03-01T08:00", endDisambiguation: "earlier" },
  { name: "a Deadline before the fallback creation date starts at 09:00 on the Deadline's day", input: { shootDate: null, deadline: deadline("2026-06-20T16:00"), projectCreatedAt: CREATED_SPLIT, now: NOW }, start: "2026-06-20T09:00", end: "2026-06-20T16:00", endDisambiguation: "earlier" },
  { name: "the stored fold of the Deadline travels as the end disambiguation", input: { shootDate: "2026-04-03", deadline: deadline("2026-04-05T02:30", 1), projectCreatedAt: CREATED_PLAIN, now: NOW }, start: "2026-04-03T09:00", end: "2026-04-05T02:30", endDisambiguation: "later" },
];

describe("defaultSubtaskRange matrix", () => {
  it("presets are the issue's 09:00 start and 17:00 end", () => {
    expect([SUBTASK_START_PRESET_TIME, SUBTASK_END_PRESET_TIME]).toEqual(["09:00", "17:00"]);
  });

  it.each(rows)("$name", ({ input, start, end, endDisambiguation }) => {
    const range = defaultSubtaskRange(input);
    expect(range).toEqual({ state: "range", start: { localCivil: start }, end: { localCivil: end, ...(endDisambiguation ? { disambiguation: endDisambiguation } : {}) } });
    const normalized = normalizeChecklistSchedule(range, 1);
    expect(normalized.ok, JSON.stringify(normalized)).toBe(true);
    if (normalized.ok) expect(normalized.value.scheduleStartKind).toBe("timed");
  });
});

describe("defaultSubtaskRange input guard", () => {
  it("throws on a non-finite creation time", () => {
    expect(() => defaultSubtaskRange({ shootDate: null, deadline: null, projectCreatedAt: Number.NaN, now: NOW })).toThrow(RangeError);
  });
});

describe("defaultSubtaskRangeDto", () => {
  it("carries the Deadline's fold on the end only", () => {
    expect(defaultSubtaskRangeDto({ shootDate: "2026-04-03", deadline: deadline("2026-04-05T02:30", 1), projectCreatedAt: CREATED_PLAIN, now: NOW })).toEqual({ start: { localCivil: "2026-04-03T09:00", fold: 0 }, end: { localCivil: "2026-04-05T02:30", fold: 1 } });
    expect(defaultSubtaskRangeDto({ shootDate: "2026-11-02", deadline: null, projectCreatedAt: CREATED_PLAIN, now: NOW })).toEqual({ start: { localCivil: "2026-11-02T09:00", fold: 0 }, end: { localCivil: "2026-11-02T17:00", fold: 0 } });
  });
  it("the schema accepts exactly that shape", () => {
    const dto = defaultSubtaskRangeDto({ shootDate: "2026-11-02", deadline: null, projectCreatedAt: CREATED_PLAIN, now: NOW });
    expect(projectDefaultRangeSchema.safeParse(dto).success).toBe(true);
    expect(projectDefaultRangeSchema.safeParse({ ...dto, extra: 1 }).success).toBe(false);
    expect(projectDefaultRangeSchema.safeParse({ ...dto, end: { localCivil: "2026-11-02", fold: 0 } }).success).toBe(false);
  });
});

// Sydney is UTC+11 in October (AEDT) and UTC+10 in April after the fold.
const sydney = (y: number, m: number, d: number, h: number, min = 0, offset = 11) => Date.UTC(y, m - 1, d, h - offset, min);

describe("defaultSubtaskRange never ends in the past (#736)", () => {
  const base = { projectCreatedAt: Date.UTC(2026, 7, 1) };
  const range = (start: string, end: string, disambiguation?: "earlier" | "later") => ({ state: "range", start: { localCivil: start }, end: { localCivil: end, ...(disambiguation ? { disambiguation } : {}) } });

  it("a past shoot with no Deadline becomes today 09:00 to 17:00", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: sydney(2026, 10, 8, 10) })).toEqual(range("2026-10-08T09:00", "2026-10-08T17:00"));
  });
  it("exactly 17:00 and after 17:00 mean tomorrow", () => {
    const tomorrow = range("2026-10-09T09:00", "2026-10-09T17:00");
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: sydney(2026, 10, 8, 17) })).toEqual(tomorrow);
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: sydney(2026, 10, 8, 18) })).toEqual(tomorrow);
  });
  it("one minute before 17:00 is still today", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: sydney(2026, 10, 8, 16, 59) })).toEqual(range("2026-10-08T09:00", "2026-10-08T17:00"));
  });
  it("a past Deadline is pushed too", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: deadline("2026-09-02T12:00"), now: sydney(2026, 10, 8, 10) })).toEqual(range("2026-10-08T09:00", "2026-10-08T17:00"));
  });
  it("a past Deadline with a future shoot date is pushed (the Deadline end is what counts)", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-11-20", deadline: deadline("2026-10-01T12:00"), now: sydney(2026, 10, 8, 10) })).toEqual(range("2026-10-08T09:00", "2026-10-08T17:00"));
  });
  it("a past start with a future end is kept", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-10-01", deadline: deadline("2026-10-20T12:00"), now: sydney(2026, 10, 8, 10) })).toEqual(range("2026-10-01T09:00", "2026-10-20T12:00", "earlier"));
  });
  it("a future shoot date is untouched", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-11-20", deadline: null, now: sydney(2026, 10, 8, 10) })).toEqual(range("2026-11-20T09:00", "2026-11-20T17:00"));
  });
  it("2026-10-08T13:30Z is 9 October in Sydney", () => {
    expect(defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: Date.UTC(2026, 9, 8, 13, 30) })).toEqual(range("2026-10-09T09:00", "2026-10-09T17:00"));
  });
  it("honours the Deadline's fold around the 5 April 2026 02:30 repeat", () => {
    // 02:30 happens twice: 15:30Z on 4 Apr (+11, earlier) and 16:30Z (+10, later).
    const input = { ...base, shootDate: "2026-04-03", deadline: deadline("2026-04-05T02:30", 1) };
    const between = Date.UTC(2026, 3, 4, 16, 0);
    expect(defaultSubtaskRange({ ...input, now: between })).toEqual(range("2026-04-03T09:00", "2026-04-05T02:30", "later"));
    expect(defaultSubtaskRange({ ...input, deadline: deadline("2026-04-05T02:30", 0), now: between })).toEqual(range("2026-04-05T09:00", "2026-04-05T17:00"));
    expect(defaultSubtaskRange({ ...input, now: Date.UTC(2026, 3, 4, 16, 31) })).toEqual(range("2026-04-05T09:00", "2026-04-05T17:00"));
  });
  it("throws on a non-finite now", () => {
    expect(() => defaultSubtaskRange({ ...base, shootDate: null, deadline: null, now: Number.NaN })).toThrow(RangeError);
    expect(() => notBeforeNow(range("2026-01-01T09:00", "2026-01-01T17:00") as never, Number.NaN)).toThrow(RangeError);
  });
  it("push(push(r, t1), t2) equals push(r, t2) for t2 >= t1", () => {
    const r = defaultSubtaskRange({ ...base, shootDate: "2026-08-30", deadline: null, now: NOW });
    const times = [sydney(2026, 9, 1, 8), sydney(2026, 9, 1, 17), sydney(2026, 9, 1, 23), sydney(2026, 10, 8, 10), sydney(2026, 10, 8, 17), sydney(2026, 10, 9, 3), sydney(2026, 12, 25, 12)];
    for (const [i, t1] of times.entries()) for (const t2 of times.slice(i)) expect(notBeforeNow(notBeforeNow(r, t1), t2)).toEqual(notBeforeNow(r, t2));
  });
  it("projectDefaultAsOf applies the same rule to the wire shape", () => {
    const dto = { start: { localCivil: "2026-08-30T09:00", fold: 0 as const }, end: { localCivil: "2026-08-30T17:00", fold: 0 as const } };
    expect(projectDefaultAsOf(dto, sydney(2026, 8, 30, 10))).toBe(dto);
    expect(projectDefaultAsOf(dto, sydney(2026, 10, 8, 10))).toEqual({ start: { localCivil: "2026-10-08T09:00", fold: 0 }, end: { localCivil: "2026-10-08T17:00", fold: 0 } });
    expect(projectDefaultAsOf(dto, sydney(2026, 10, 8, 17))).toEqual({ start: { localCivil: "2026-10-09T09:00", fold: 0 }, end: { localCivil: "2026-10-09T17:00", fold: 0 } });
  });

  it("projectDefaultAsOf reads a cached end on the repeated hour by its fold (Sol #736)", () => {
    // DST ends 2027-04-04 03:00 AEDT: 02:30 occurs at 15:30Z (fold 0) and again at 16:30Z (fold 1).
    const at = Date.parse("2027-04-03T16:00:00Z");
    const earlier = { start: { localCivil: "2027-04-03T09:00", fold: 0 as const }, end: { localCivil: "2027-04-04T02:30", fold: 0 as const } };
    const later = { start: earlier.start, end: { localCivil: "2027-04-04T02:30", fold: 1 as const } };
    expect(projectDefaultAsOf(earlier, at)).toEqual({ start: { localCivil: "2027-04-04T09:00", fold: 0 }, end: { localCivil: "2027-04-04T17:00", fold: 0 } });
    expect(projectDefaultAsOf(later, at)).toBe(later);
  });
});
