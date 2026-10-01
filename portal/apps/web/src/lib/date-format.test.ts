// Pin a non-Sydney machine zone: every assertion below must hold for a viewer whose browser zone is
// elsewhere, because the Collaboration tab renders Sydney time for everyone (#376, owner Q3 default).
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import type { ChecklistScheduleDto } from "@quincy/shared";
import {
  dayBucketLabel,
  formatAbsoluteTime,
  formatCivilSchedule,
  formatDayGroupedTime,
  formatDueCivil,
  formatRelativeTime,
  groupByDay,
  sydneyDayKey,
} from "./date-format";

// 2026-09-30 15:00 in Sydney (AEST, +10:00) — before the 4 Oct 2026 DST start.
const NOW = Date.parse("2026-09-30T05:00:00.000Z");
const at = (iso: string) => Date.parse(iso);

describe("formatAbsoluteTime", () => {
  it("renders 'D Mon YYYY, h:mm AM/PM' in Sydney with no seconds", () => {
    expect(formatAbsoluteTime("2026-09-30T05:04:59.000Z")).toBe("30 Sep 2026, 3:04 PM");
    expect(formatAbsoluteTime("2026-09-30T02:00:00.000Z")).toBe("30 Sep 2026, 12:00 PM");
    expect(formatAbsoluteTime("2026-09-29T14:05:00.000Z")).toBe("30 Sep 2026, 12:05 AM");
  });

  it("uses the frozen month table, not ICU ('Sep', never 'Sept')", () => {
    expect(formatAbsoluteTime("2026-09-10T05:00:00.000Z")).toContain("Sep");
    expect(formatAbsoluteTime("2026-09-10T05:00:00.000Z")).not.toContain("Sept");
  });

  it("splits the Sydney day at local midnight, not UTC midnight (13:30Z vs 14:30Z on a non-DST date)", () => {
    expect(formatAbsoluteTime("2026-07-14T13:30:00.000Z")).toBe("14 Jul 2026, 11:30 PM");
    expect(formatAbsoluteTime("2026-07-14T14:30:00.000Z")).toBe("15 Jul 2026, 12:30 AM");
  });

  it("accepts an epoch number", () => {
    expect(formatAbsoluteTime(at("2026-09-30T05:04:00.000Z"))).toBe("30 Sep 2026, 3:04 PM");
  });
});

describe("formatRelativeTime", () => {
  it("reads Just now / Nm ago / Nh ago inside the same Sydney day", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  });

  it("reads Yesterday for the previous Sydney day even when under 24 hours ago", () => {
    expect(formatRelativeTime(NOW - 16 * 3_600_000, NOW)).toBe("Yesterday");
    expect(formatRelativeTime(at("2026-09-29T05:00:00.000Z"), NOW)).toBe("Yesterday");
  });

  it("reads 'D Mon' within the same Sydney year and 'D Mon YYYY' otherwise", () => {
    expect(formatRelativeTime(at("2026-09-12T05:00:00.000Z"), NOW)).toBe("12 Sep");
    expect(formatRelativeTime(at("2025-09-12T05:00:00.000Z"), NOW)).toBe("12 Sep 2025");
  });

  it("uses the Sydney year boundary, not the UTC one", () => {
    const newYearsDay = at("2026-12-31T14:30:00.000Z"); // 1 Jan 2027, 01:30 in Sydney
    const later = at("2027-03-01T00:00:00.000Z");
    expect(formatRelativeTime(newYearsDay, later)).toBe("1 Jan");
  });

  it("treats a future timestamp within 60s as skew (Just now) and anything further as absolute", () => {
    expect(formatRelativeTime(NOW + 30_000, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("Just now");
    expect(formatRelativeTime(NOW + 120_000, NOW)).toBe(formatAbsoluteTime(NOW + 120_000));
  });

  it("handles the DST-start day (4 Oct 2026, 23h long): yesterday is still the civil previous day", () => {
    const now = at("2026-10-04T03:00:00.000Z"); // 4 Oct 14:00 AEDT
    expect(formatRelativeTime(at("2026-10-03T12:00:00.000Z"), now)).toBe("Yesterday"); // 3 Oct 23:00 AEST
    expect(formatRelativeTime(at("2026-10-03T16:30:00.000Z"), now)).toBe("10h ago"); // 4 Oct 03:30 AEDT, same civil day
  });
});

describe("formatDayGroupedTime", () => {
  it("is the notification timestamp: relative today, 12-hour Sydney clock on other days", () => {
    expect(formatDayGroupedTime("2026-09-30T04:55:00.000Z", NOW)).toBe("5m ago");
    expect(formatDayGroupedTime("2026-09-29T05:04:00.000Z", NOW)).toBe("3:04 PM");
  });
});

describe("day grouping helpers", () => {
  it("keys and labels by Sydney day", () => {
    expect(sydneyDayKey("2026-07-14T14:30:00.000Z")).toBe("2026-07-15");
    expect(dayBucketLabel("2026-09-30", NOW)).toBe("Today");
    expect(dayBucketLabel("2026-09-29", NOW)).toBe("Yesterday");
    expect(dayBucketLabel("2026-09-09", NOW)).toBe("9 Sep 2026");
  });

  it("groupByDay is newest-first, keeps in-bucket order, and never mutates", () => {
    const items = [
      { id: "a", when: "2026-09-29T05:00:00.000Z" },
      { id: "b", when: "2026-09-30T04:00:00.000Z" },
      { id: "c", when: "2026-09-29T01:00:00.000Z" },
    ];
    const snapshot = JSON.stringify(items);
    const buckets = groupByDay(items, (item) => item.when, NOW);
    expect(buckets.map((bucket) => [bucket.key, bucket.label, bucket.items.map((item) => item.id)])).toEqual([
      ["2026-09-30", "Today", ["b"]],
      ["2026-09-29", "Yesterday", ["a", "c"]],
    ]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

describe("no output carries seconds", () => {
  it("never matches h:mm:ss", () => {
    const instants = [NOW, NOW - 30_000, NOW - 3_600_000, NOW - 86_400_000, NOW - 40 * 86_400_000, NOW - 400 * 86_400_000, NOW + 200_000];
    for (const instant of instants) {
      for (const text of [formatAbsoluteTime(instant), formatRelativeTime(instant, NOW), formatDayGroupedTime(new Date(instant).toISOString(), NOW)]) {
        expect(text).not.toMatch(/:\d\d:\d\d/);
      }
    }
  });
});

describe("formatCivilSchedule", () => {
  const ep = (localCivil: string) => ({ localCivil }) as ChecklistScheduleDto["start"];
  const dto = (start: ChecklistScheduleDto["start"], end: ChecklistScheduleDto["end"]) => ({ state: "range", version: 1, start, end }) as unknown as ChecklistScheduleDto;

  it("names both moments in 24-hour time, and a one-day range's day once", () => {
    expect(formatCivilSchedule(dto(ep("2026-10-08T09:00"), ep("2026-10-08T17:00")))).toBe("Thu 8 Oct 09:00 → 17:00");
    expect(formatCivilSchedule(dto(ep("2026-10-08T13:00"), ep("2026-10-08T14:00")))).toBe("Thu 8 Oct 13:00 → 14:00");
    expect(formatCivilSchedule(dto(ep("2026-10-08T09:00"), ep("2026-10-10T17:00")))).toBe("Thu 8 Oct 09:00 → Sat 10 Oct 17:00");
    expect(formatCivilSchedule(dto(ep("2026-10-08T13:00"), ep("2026-10-09T09:00")))).toBe("Thu 8 Oct 13:00 → Fri 9 Oct 09:00");
  });
});

describe("formatDueCivil (#372)", () => {
  it("names a date end as 'Fri 2 Oct' and a timed end with its Sydney wall time, whatever the machine zone", () => {
    expect(formatDueCivil("2026-10-02")).toBe("Fri 2 Oct");
    expect(formatDueCivil("2026-10-02T17:00")).toBe("Fri 2 Oct · 17:00");
    // The weekday is the civil date's own, not a device-zone reinterpretation of midnight.
    expect(formatDueCivil("2026-10-04")).toBe("Sun 4 Oct");
    expect(formatDueCivil("2026-12-31T00:05")).toBe("Thu 31 Dec · 00:05");
  });
});
