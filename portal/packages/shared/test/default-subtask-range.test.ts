import { describe, expect, it } from "vitest";
import { defaultSubtaskRange } from "../src/default-subtask-range";
import { normalizeChecklistSchedule } from "../src/checklist-schedule";

// 2026-06-30T15:00Z is 2026-07-01 01:00 in Sydney: the UTC and Sydney dates differ.
const CREATED_SPLIT = Date.UTC(2026, 5, 30, 15);
// 2026-07-01T02:00Z is 2026-07-01 12:00 in Sydney: the UTC and Sydney dates agree.
const CREATED_PLAIN = Date.UTC(2026, 6, 1, 2);

const date = (localCivil: string) => ({ kind: "date" as const, localCivil });
const timed = (localCivil: string) => ({ kind: "timed" as const, localCivil });

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

describe("defaultSubtaskRange input guard", () => {
  it("throws on a non-finite creation time", () => {
    expect(() => defaultSubtaskRange({ shootDate: null, deadlineLocalCivil: null, projectCreatedAt: Number.NaN })).toThrow(RangeError);
  });
});
