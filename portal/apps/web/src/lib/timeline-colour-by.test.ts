/**
 * #916 / #920: the Timeline's Colour by preference and the People-mode helpers (frame 3b,
 * `design/prototypes/dashboard-views`, "Dashboard views v3").
 */
import { describe, expect, it } from "vitest";
import { normalizeColourBy, peopleKeyEntries, peopleProjectSpanLabel, TIMELINE_COLOUR_BY_KEY } from "./timeline-colour-by";

describe("normalizeColourBy", () => {
  it("keeps the two choices and falls back to Stage for anything else", () => {
    expect(normalizeColourBy("people")).toBe("people");
    expect(normalizeColourBy("stage")).toBe("stage");
    for (const junk of [undefined, null, "", "People", 1, {}, ["people"]]) expect(normalizeColourBy(junk)).toBe("stage");
  });

  it("is a per-browser UI preference under the quincy:ui namespace", () => {
    expect(TIMELINE_COLOUR_BY_KEY).toBe("quincy:ui:dashboard:timeline:colour-by");
  });
});

describe("peopleProjectSpanLabel (frame 3b: a neutral Project bar shows shoot -> Deadline)", () => {
  // Mon 14 Sep 2026 00:00 Sydney (+10) and Fri 18 Sep 2026 17:00 Sydney.
  const shoot = new Date("2026-09-13T14:00:00.000Z");
  const deadline = new Date("2026-09-18T07:00:00.000Z");

  it("names both civil days", () => {
    expect(peopleProjectSpanLabel({ start: shoot, end: deadline, hollowStart: false, todayKey: "2026-09-15" })).toBe("Mon 14 → Fri 18");
  });

  it("says today when the Deadline falls on today", () => {
    expect(peopleProjectSpanLabel({ start: shoot, end: deadline, hollowStart: false, todayKey: "2026-09-18" })).toBe("Mon 14 → today");
  });

  it("names only the Deadline when there is no shoot date", () => {
    expect(peopleProjectSpanLabel({ start: shoot, end: deadline, hollowStart: true, todayKey: "2026-09-15" })).toBe("Due Fri 18");
    expect(peopleProjectSpanLabel({ start: shoot, end: deadline, hollowStart: true, todayKey: "2026-09-18" })).toBe("Due today");
  });

  it("reads the Sydney day, not the device's (a 23:30 UTC instant is the next Sydney day)", () => {
    expect(peopleProjectSpanLabel({ start: new Date("2026-09-14T23:30:00.000Z"), end: new Date("2026-09-15T23:30:00.000Z"), hollowStart: false, todayKey: "2026-09-01" })).toBe("Tue 15 → Wed 16");
  });
});

describe("peopleKeyEntries (frame 3b key row: open Subtasks per person, plus Unassigned)", () => {
  const anika = { id: "u-anika", name: "Anika Nair" };
  const rob = { id: "u-rob", name: "Rob Keane" };
  const jess = { id: "u-jess", name: "Jess Moore" };
  const task = (assignees: { id: string; name: string }[], done = false, otherAssigneeCount = 0) => ({ assignees, otherAssigneeCount, done });

  it("counts open Subtasks per named assignee, busiest first, then by name; a person with none open still shows", () => {
    const key = peopleKeyEntries([
      task([jess], true),
      task([rob]),
      task([anika]),
      task([anika]),
      task([rob, anika]),
      task([rob], true),
    ]);
    expect(key.people.map((entry) => [entry.label, entry.open])).toEqual([
      ["Anika Nair", 3],
      ["Rob Keane", 2],
      ["Jess Moore", 0],
    ]);
    expect(key.people[0]).toMatchObject({ personId: "u-anika", initials: "AN", color: expect.stringMatching(/^var\(--people-[1-8]\)$/) });
  });

  it("counts open unassigned Subtasks; a hidden assignee is neither a person nor unassigned", () => {
    const key = peopleKeyEntries([task([]), task([], true), task([]), task([], false, 1)]);
    expect(key.people).toEqual([]);
    expect(key.unassignedOpen).toBe(2);
  });
});
