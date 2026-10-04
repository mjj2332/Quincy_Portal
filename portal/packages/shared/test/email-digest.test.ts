import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_DIGEST_CADENCE,
  EMAIL_DIGEST_CADENCES,
  digestSlotAt,
  isDigestExemptType,
  isDigestSlotDue,
} from "../src/email-digest";

/** Sydney is UTC+10 (AEST) until 2026-10-04 02:00 local, then UTC+11 (AEDT) until 2027-04-04 03:00 local. */
const utc = (iso: string) => Date.parse(iso);

describe("email digest cadence", () => {
  it("defaults to twice daily and lists the four cadences", () => {
    expect(DEFAULT_EMAIL_DIGEST_CADENCE).toBe("twice_daily");
    expect([...EMAIL_DIGEST_CADENCES]).toEqual(["immediate", "hourly", "twice_daily", "daily"]);
  });

  it("treats the three reminder types as exempt and everything else as digestable", () => {
    for (const type of ["subtask_reminder", "subtask_due_today", "project_deadline_reminder"]) expect(isDigestExemptType(type)).toBe(true);
    for (const type of ["mentioned", "comment_added", "assigned_to_project", "raw_ready", "subtask_assigned", "project_activity"]) expect(isDigestExemptType(type)).toBe(false);
  });

  it("runs hourly and immediate cadences every hour", () => {
    for (const hour of [0, 5, 13, 22]) {
      const at = utc(`2026-07-01T${String(hour).padStart(2, "0")}:00:00Z`);
      expect(isDigestSlotDue("hourly", at)).toBe(true);
      expect(isDigestSlotDue("immediate", at)).toBe(true);
    }
  });

  it("sends twice daily at 08:00 and 14:00 Sydney in winter (UTC+10)", () => {
    expect(isDigestSlotDue("twice_daily", utc("2026-07-01T22:00:00Z"))).toBe(true); // 08:00 AEST 2 Jul
    expect(isDigestSlotDue("twice_daily", utc("2026-07-02T04:00:00Z"))).toBe(true); // 14:00 AEST
    expect(isDigestSlotDue("twice_daily", utc("2026-07-02T05:00:00Z"))).toBe(false);
    expect(isDigestSlotDue("twice_daily", utc("2026-07-01T21:00:00Z"))).toBe(false);
  });

  it("sends daily only at 08:00 Sydney", () => {
    expect(isDigestSlotDue("daily", utc("2026-07-01T22:00:00Z"))).toBe(true);
    expect(isDigestSlotDue("daily", utc("2026-07-02T04:00:00Z"))).toBe(false);
  });

  it("follows Sydney daylight time across the October start and the April end", () => {
    // Before DST starts (2026-10-03): 08:00 AEST = 22:00Z the day before.
    expect(isDigestSlotDue("daily", utc("2026-10-02T22:00:00Z"))).toBe(true);
    // After DST starts (2026-10-04 02:00 local): 08:00 AEDT = 21:00Z the day before.
    expect(isDigestSlotDue("daily", utc("2026-10-04T21:00:00Z"))).toBe(true);
    expect(isDigestSlotDue("daily", utc("2026-10-04T22:00:00Z"))).toBe(false);
    expect(isDigestSlotDue("twice_daily", utc("2026-10-05T03:00:00Z"))).toBe(true); // 14:00 AEDT
    // After DST ends (2027-04-04 03:00 local): 08:00 AEST = 22:00Z the day before.
    expect(isDigestSlotDue("daily", utc("2027-04-04T22:00:00Z"))).toBe(true);
    expect(isDigestSlotDue("daily", utc("2027-04-04T21:00:00Z"))).toBe(false);
  });

  it("runs every day of the week", () => {
    // 2026-07-04 is a Saturday, 2026-07-05 a Sunday (Sydney).
    expect(isDigestSlotDue("daily", utc("2026-07-03T22:00:00Z"))).toBe(true);
    expect(isDigestSlotDue("daily", utc("2026-07-04T22:00:00Z"))).toBe(true);
  });

  it("keys a slot by the UTC hour so a repeated wall-clock hour stays distinct", () => {
    expect(digestSlotAt(utc("2026-07-01T22:00:07Z"))).toBe(utc("2026-07-01T22:00:00Z"));
    expect(digestSlotAt(utc("2026-07-01T22:59:59.999Z"))).toBe(utc("2026-07-01T22:00:00Z"));
  });
});
