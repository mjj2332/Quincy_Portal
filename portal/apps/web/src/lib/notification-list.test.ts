// Set before any import that touches `Date` — V8 reads `TZ` lazily and caches it on first use,
// so a run-machine timezone other than Sydney's must be pinned here rather than trusted to the
// `TZ=America/Los_Angeles` prefix on the command line alone (this file must also pass bare).
process.env.TZ = "America/Los_Angeles";

import { describe, expect, it } from "vitest";
import {
  dayBucketLabel,
  dismissFocusTarget,
  filterNotifications,
  formatNotificationTimestamp,
  groupNotifications,
  sydneyDayKey,
  type NotificationListItem,
} from "./notification-list";

function item(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
  return {
    id: "n-1",
    projectId: null,
    type: "mentioned",
    title: "Title",
    body: null,
    readAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    projectStreet: null,
    coverAssetId: null,
    ...overrides,
  };
}

describe("sydneyDayKey", () => {
  it("keeps a late-evening Sydney notification under the same-day key, not the UTC date", () => {
    // 2026-09-14T23:30+10:00 is 2026-09-14T13:30:00.000Z — same UTC calendar date as the Sydney one.
    expect(sydneyDayKey("2026-09-14T23:30:00+10:00")).toBe("2026-09-14");
  });

  it("resolves an early-morning UTC instant to the Sydney day that already started", () => {
    // 2026-09-15T00:15+10:00 (Sydney) is 2026-09-14T14:15:00.000Z.
    expect(sydneyDayKey("2026-09-14T14:15:00.000Z")).toBe("2026-09-15");
  });
});

describe("dayBucketLabel", () => {
  it("labels the same Sydney day as now 'Today'", () => {
    const now = new Date("2026-09-15T00:15:00+10:00").getTime();
    expect(dayBucketLabel(sydneyDayKey(now), now)).toBe("Today");
  });

  it("keeps a late-evening Sydney item under Yesterday, not Today, across the UTC date line", () => {
    const now = new Date("2026-09-15T00:15:00+10:00").getTime(); // 2026-09-14T14:15:00.000Z
    const createdKey = sydneyDayKey("2026-09-14T23:30:00+10:00"); // same UTC date as `now`, prior Sydney day
    expect(dayBucketLabel(createdKey, now)).toBe("Yesterday");
  });

  it("labels the October DST-start yesterday correctly", () => {
    const now = new Date("2026-10-05T00:15:00+11:00").getTime();
    expect(dayBucketLabel(sydneyDayKey(now), now)).toBe("Today");
    expect(dayBucketLabel("2026-10-04", now)).toBe("Yesterday");
  });

  it("labels the April DST-end 25-hour day's yesterday correctly", () => {
    const now = new Date("2026-04-06T00:15:00+10:00").getTime();
    expect(dayBucketLabel("2026-04-05", now)).toBe("Yesterday");
  });

  it("rolls Yesterday over a month/year boundary", () => {
    const now = new Date("2027-01-01T00:15:00+11:00").getTime();
    expect(dayBucketLabel(sydneyDayKey(now), now)).toBe("Today");
    expect(dayBucketLabel("2026-12-31", now)).toBe("Yesterday");
  });

  it("labels an older date day-first with the frozen month table", () => {
    const now = new Date("2027-01-01T00:15:00+11:00").getTime();
    expect(dayBucketLabel("2026-12-30", now)).toBe("30 Dec 2026");
  });

  it("labels a same-year older date day-first", () => {
    const now = new Date("2026-09-15T12:00:00+10:00").getTime();
    expect(dayBucketLabel("2026-09-09", now)).toBe("9 Sep 2026");
  });
});

describe("groupNotifications", () => {
  const now = new Date("2026-09-15T09:00:00+10:00").getTime();

  it("groups by Sydney day, newest bucket first, preserving item order within a bucket", () => {
    const items = [
      item({ id: "a", createdAt: "2026-09-15T01:00:00+10:00" }),
      item({ id: "b", createdAt: "2026-09-14T10:00:00+10:00" }),
      item({ id: "c", createdAt: "2026-09-15T02:00:00+10:00" }),
      item({ id: "d", createdAt: "2026-09-13T10:00:00+10:00" }),
    ];
    const buckets = groupNotifications(items, now);
    expect(buckets.map((bucket) => bucket.label)).toEqual(["Today", "Yesterday", "13 Sep 2026"]);
    expect(buckets[0]!.notifications.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(buckets[1]!.notifications.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("omits empty buckets and never produces one for a day with no notifications", () => {
    const items = [item({ id: "a", createdAt: "2026-09-15T01:00:00+10:00" })];
    const buckets = groupNotifications(items, now);
    expect(buckets).toHaveLength(1);
  });

  it("does not mutate its input array", () => {
    const items = [
      item({ id: "a", createdAt: "2026-09-15T01:00:00+10:00" }),
      item({ id: "b", createdAt: "2026-09-14T01:00:00+10:00" }),
    ];
    const copy = items.map((entry) => ({ ...entry }));
    groupNotifications(items, now);
    expect(items).toEqual(copy);
  });
});

describe("filterNotifications", () => {
  it("returns unread items only, preserving order", () => {
    const items = [
      item({ id: "a", readAt: null }),
      item({ id: "b", readAt: "2026-09-14T00:00:00Z" }),
      item({ id: "c", readAt: null }),
    ];
    expect(filterNotifications(items, "unread").map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(filterNotifications(items, "all").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("dismissFocusTarget", () => {
  const visible = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];

  it("targets the next id when one exists", () => {
    expect(dismissFocusTarget(visible, "a")).toBe("b");
  });

  it("falls back to the previous id when the dismissed row was last", () => {
    expect(dismissFocusTarget(visible, "c")).toBe("b");
  });

  it("returns null when the dismissed row was the only one", () => {
    expect(dismissFocusTarget([item({ id: "a" })], "a")).toBeNull();
  });
});

describe("formatNotificationTimestamp", () => {
  it("shows 'Just now' under a minute, clamping small future clock skew", () => {
    const created = "2026-09-15T09:00:00+10:00";
    const now = new Date(created).getTime() - 500; // now slightly BEFORE created — clock skew
    expect(formatNotificationTimestamp(created, now)).toBe("Just now");
  });

  it("shows minutes ago under an hour", () => {
    const created = new Date("2026-09-15T09:00:00+10:00").getTime();
    const now = created + 5 * 60_000;
    expect(formatNotificationTimestamp(new Date(created).toISOString(), now)).toBe("5m ago");
  });

  it("shows hours ago within the same Sydney day", () => {
    const created = new Date("2026-09-15T09:00:00+10:00").getTime();
    const now = created + 3 * 60 * 60_000;
    expect(formatNotificationTimestamp(new Date(created).toISOString(), now)).toBe("3h ago");
  });

  it("shows a Sydney clock time, 12-hour with uppercase AM/PM, for a different day", () => {
    const created = new Date("2026-09-14T16:20:00+10:00").getTime();
    const now = new Date("2026-09-15T09:00:00+10:00").getTime();
    expect(formatNotificationTimestamp(new Date(created).toISOString(), now)).toBe("4:20 PM");
  });

  it("renders midnight and noon correctly (12-hour wraparound)", () => {
    const now = new Date("2026-09-16T09:00:00+10:00").getTime();
    expect(formatNotificationTimestamp(new Date("2026-09-15T00:05:00+10:00").toISOString(), now)).toBe("12:05 AM");
    expect(formatNotificationTimestamp(new Date("2026-09-15T12:05:00+10:00").toISOString(), now)).toBe("12:05 PM");
  });
});
