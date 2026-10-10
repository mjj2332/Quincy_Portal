import { describe, expect, it } from "vitest";
import { defaultExpiryDay, expiryDayToIso } from "./review-link-expiry";

// 2026-10-10 03:00 UTC = 14:00 Sydney (AEDT, +11).
const NOW = Date.UTC(2026, 9, 10, 3, 0, 0);

describe("Review link expiry", () => {
  it("defaults to thirty Sydney days out", () => {
    expect(defaultExpiryDay(NOW)).toBe("2026-11-09");
  });
  it("ends the chosen day at 23:59 Sydney, as an ISO instant", () => {
    const result = expiryDayToIso("2026-11-09", NOW);
    expect(result).toEqual({ ok: true, iso: "2026-11-09T12:59:00.000Z" });
  });
  it("refuses today late in the evening (under an hour left) before the server would", () => {
    const lateEvening = Date.UTC(2026, 9, 10, 12, 30, 0); // 23:30 Sydney
    const result = expiryDayToIso("2026-10-10", lateEvening);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/at least an hour/);
  });
  it("accepts today when more than an hour remains", () => {
    expect(expiryDayToIso("2026-10-10", NOW).ok).toBe(true);
  });
  it("refuses a day more than 365 days out", () => {
    const result = expiryDayToIso("2027-10-12", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/at most a year/);
  });
  it("refuses a malformed day", () => {
    expect(expiryDayToIso("not-a-day", NOW).ok).toBe(false);
  });
});
