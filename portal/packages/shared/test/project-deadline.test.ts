import { describe, expect, it } from "vitest";
import { automaticDeadlineFor, planDeadlineOccurrences, deadlineFireAt, effectiveDeadlineLocalCivil, formatSydneyCivil, isDeadlineOverdue, normalizeReminderOffsets, resolveSydneyCivilTime } from "../src/project-deadline";

describe("Sydney Deadline civil time", () => {
  it("resolves ordinary civil time and round-trips it", () => {
    const result = resolveSydneyCivilTime("2026-08-27T09:15");
    expect(result).toMatchObject({ ok: true, value: { instant: "2026-08-26T23:15:00.000Z", utcOffsetMinutes: 600, fold: 0 } });
    if (result.ok) expect(formatSydneyCivil(result.value.instant)).toBe("2026-08-27T09:15");
  });

  it("rejects the Sydney spring-forward gap", () => {
    expect(resolveSydneyCivilTime("2026-10-04T02:30")).toMatchObject({ ok: false, code: "deadline_nonexistent_local_time" });
  });

  it("requires and applies explicit repeated-time disambiguation", () => {
    expect(resolveSydneyCivilTime("2026-04-05T02:30")).toMatchObject({ ok: false, code: "deadline_repeated_local_time", choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }] });
    expect(resolveSydneyCivilTime("2026-04-05T02:30", "earlier")).toMatchObject({ ok: true, value: { instant: "2026-04-04T15:30:00.000Z", utcOffsetMinutes: 660, fold: 0 } });
    expect(resolveSydneyCivilTime("2026-04-05T02:30", "later")).toMatchObject({ ok: true, value: { instant: "2026-04-04T16:30:00.000Z", utcOffsetMinutes: 600, fold: 1 } });
  });

  it("uses absolute duration arithmetic across an offset change", () => {
    const resolved = resolveSydneyCivilTime("2026-10-04T09:00");
    expect(resolved).toMatchObject({ ok: true, value: { instant: "2026-10-03T22:00:00.000Z", utcOffsetMinutes: 660, fold: 0 } });
    if (resolved.ok) {
      const fireAt = deadlineFireAt(resolved.value.epochMs, 1440);
      expect(new Date(fireAt).toISOString()).toBe("2026-10-02T22:00:00.000Z");
      expect(formatSydneyCivil(fireAt)).toBe("2026-10-03T08:00");
      expect(resolveSydneyCivilTime(formatSydneyCivil(fireAt))).toMatchObject({ ok: true, value: { utcOffsetMinutes: 600 } });
    }
  });

  it("rejects malformed/calendar values and normalizes bounded offsets", () => {
    for (const value of ["2026-02-29T09:00", "2026-01-01T24:00", "2026-1-01T09:00", "not-a-date"]) expect(resolveSydneyCivilTime(value)).toMatchObject({ ok: false, code: "deadline_invalid_local_time" });
    expect(normalizeReminderOffsets([60, 1440, 60, 240])).toEqual([1440, 240, 60]);
    expect(() => normalizeReminderOffsets([0])).toThrow();
    expect(() => normalizeReminderOffsets([-1])).toThrow();
    expect(() => normalizeReminderOffsets([1.5])).toThrow();
    expect(() => normalizeReminderOffsets([43201])).toThrow();
    expect(() => normalizeReminderOffsets([1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow();
  });

  it("formats and compares instants without using the host timezone", () => {
    expect(formatSydneyCivil("2026-08-26T23:15:00.000Z")).toBe("2026-08-27T09:15");
    expect(isDeadlineOverdue(Date.parse("2026-08-26T23:15:00.000Z"), Date.parse("2026-08-26T23:16:00.000Z"))).toBe(true);
    expect(isDeadlineOverdue(null, Date.now())).toBe(false);
  });
});

describe("effectiveDeadlineLocalCivil", () => {
  it("returns the stored local civil while a Deadline is set", () => {
    expect(effectiveDeadlineLocalCivil({ deadlineAt: 1_790_000_000_000, deadlineLocalCivil: "2026-09-30T17:00" })).toBe("2026-09-30T17:00");
  });

  it("returns null while no Deadline is set, ignoring a stale local civil", () => {
    expect(effectiveDeadlineLocalCivil({ deadlineAt: null, deadlineLocalCivil: "2026-09-30T17:00" })).toBeNull();
    expect(effectiveDeadlineLocalCivil({ deadlineAt: null, deadlineLocalCivil: null })).toBeNull();
  });
});

describe("automaticDeadlineFor", () => {
  const cases: Array<[string, string, string, number, string]> = [
    // [shoot date, weekday, Deadline civil, offset, instant]
    ["2026-06-01", "Mon", "2026-06-02T17:00", 600, "2026-06-02T07:00:00.000Z"],
    ["2026-06-02", "Tue", "2026-06-03T17:00", 600, "2026-06-03T07:00:00.000Z"],
    ["2026-06-03", "Wed", "2026-06-04T17:00", 600, "2026-06-04T07:00:00.000Z"],
    ["2026-06-04", "Thu", "2026-06-05T17:00", 600, "2026-06-05T07:00:00.000Z"],
    ["2026-06-05", "Fri", "2026-06-08T17:00", 600, "2026-06-08T07:00:00.000Z"],
    ["2026-06-06", "Sat", "2026-06-08T17:00", 600, "2026-06-08T07:00:00.000Z"],
    ["2026-06-07", "Sun", "2026-06-08T17:00", 600, "2026-06-08T07:00:00.000Z"],
    // DST start (Sydney, 2026-10-04): the Friday before lands on a Monday after the clocks moved.
    ["2026-10-02", "Fri", "2026-10-05T17:00", 660, "2026-10-05T06:00:00.000Z"],
    ["2026-10-03", "Sat", "2026-10-05T17:00", 660, "2026-10-05T06:00:00.000Z"],
    ["2026-10-04", "Sun (DST start day)", "2026-10-05T17:00", 660, "2026-10-05T06:00:00.000Z"],
    ["2026-10-01", "Thu", "2026-10-02T17:00", 600, "2026-10-02T07:00:00.000Z"],
    // DST end (Sydney, 2026-04-05)
    ["2026-04-03", "Fri", "2026-04-06T17:00", 600, "2026-04-06T07:00:00.000Z"],
    ["2026-04-04", "Sat", "2026-04-06T17:00", 600, "2026-04-06T07:00:00.000Z"],
    ["2026-04-05", "Sun (DST end day)", "2026-04-06T17:00", 600, "2026-04-06T07:00:00.000Z"],
    ["2026-04-02", "Thu", "2026-04-03T17:00", 660, "2026-04-03T06:00:00.000Z"],
    // Rollovers and leap day
    ["2026-12-31", "Thu", "2027-01-01T17:00", 660, "2027-01-01T06:00:00.000Z"],
    ["2027-12-31", "Fri", "2028-01-03T17:00", 660, "2028-01-03T06:00:00.000Z"],
    ["2028-02-28", "Mon", "2028-02-29T17:00", 660, "2028-02-29T06:00:00.000Z"],
    ["2028-02-29", "Tue", "2028-03-01T17:00", 660, "2028-03-01T06:00:00.000Z"],
  ];
  it.each(cases)("%s (%s) is due %s", (shootDate, _weekday, localCivil, offset, instant) => {
    const result = automaticDeadlineFor(shootDate);
    expect(result).toMatchObject({ localCivil, utcOffsetMinutes: offset, fold: 0, instant });
    expect(result?.epochMs).toBe(Date.parse(instant));
  });

  it("returns null for anything that is not a canonical calendar date", () => {
    for (const value of [null, undefined, "", "TBC", "2026-02-30", "2026-13-01", "26-06-01", "2026-6-1", " 2026-06-01", "1 June 2026"]) expect(automaticDeadlineFor(value)).toBeNull();
  });
});

describe("planDeadlineOccurrences", () => {
  const DEADLINE = Date.parse("2026-10-05T06:00:00.000Z");
  const HOUR = 3_600_000;
  it("plans pending advance reminders plus Due now for a future Deadline", () => {
    expect(planDeadlineOccurrences(DEADLINE, [1440, 60], DEADLINE - 48 * HOUR).map((o) => [o.kind, o.offsetMinutes, o.status, o.terminalReason])).toEqual([["advance", 1440, "pending", null], ["advance", 60, "pending", null], ["due_now", 0, "pending", null]]);
  });
  it("skips elapsed advance reminders, and keeps an elapsed Due now pending for a person's save", () => {
    const planned = planDeadlineOccurrences(DEADLINE, [1440, 60], DEADLINE + HOUR);
    expect(planned.map((o) => [o.offsetMinutes, o.status, o.terminalReason])).toEqual([[1440, "skipped", "elapsed_at_save"], [60, "skipped", "elapsed_at_save"], [0, "pending", null]]);
  });
  it("skips an elapsed Due now too when asked, so a backdated Automatic Deadline never fires at once", () => {
    const planned = planDeadlineOccurrences(DEADLINE, [1440, 240, 60], DEADLINE + HOUR, { skipElapsedDueNow: true });
    expect(planned.every((o) => o.status === "skipped" && o.terminalReason === "elapsed_at_save")).toBe(true);
    expect(planDeadlineOccurrences(DEADLINE, [60], DEADLINE - HOUR / 2, { skipElapsedDueNow: true }).at(-1)).toMatchObject({ kind: "due_now", status: "pending" });
  });
});
