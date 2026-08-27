import { describe, expect, it } from "vitest";
import { deadlineFireAt, formatSydneyCivil, isDeadlineOverdue, normalizeReminderOffsets, resolveSydneyCivilTime } from "../src/project-deadline";

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
