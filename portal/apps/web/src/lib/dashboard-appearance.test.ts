import { describe, expect, it } from "vitest";
import {
  civilDaysBetween,
  doneCount,
  lateLabel,
  PEOPLE_TONE_COUNT,
  personColor,
  personColorIndex,
  personInitials,
  projectLateness,
  stageTone,
  subtaskLateness,
  subtaskPeopleTone,
  subtaskShape,
} from "./dashboard-appearance";

describe("stageTone: one tone and treatment per Stage (#916)", () => {
  it.each([
    ["awaiting_raw", "awaiting_raw", "var(--stage-awaiting-raw)", "hollow-dashed"],
    ["raw_review", "raw_review", "var(--stage-raw-review)", "solid"],
    ["editing", "editing", "var(--stage-editing)", "solid"],
    ["edited_review", "edited_review", "var(--stage-edited-review)", "solid"],
    ["delivered", "delivered", "var(--stage-delivered)", "wash"],
  ] as const)("%s draws as %s in %s, %s", (key, stage, color, treatment) => {
    expect(stageTone(key)).toEqual({ stage, color, treatment });
  });

  it("draws editing_autohdr as Editing (the presentation Stage every role sees)", () => {
    expect(stageTone("editing_autohdr")).toEqual(stageTone("editing"));
  });

  it("falls back to Awaiting RAW for a missing or unknown Stage", () => {
    const awaiting = stageTone("awaiting_raw");
    expect(stageTone(null)).toEqual(awaiting);
    expect(stageTone(undefined)).toEqual(awaiting);
    expect(stageTone("not_a_stage")).toEqual(awaiting);
  });

  it("gives RAW review and Edited review different tones (no shared ochre)", () => {
    expect(stageTone("raw_review").color).not.toBe(stageTone("edited_review").color);
  });
});

// 13:00 on Sun 18 Oct 2026 in Sydney (AEDT, UTC+11).
const NOW = new Date("2026-10-18T02:00:00Z");

describe("projectLateness: a Project is late when its Deadline has passed and it is not Delivered (#916)", () => {
  const project = (over: Partial<Parameters<typeof projectLateness>[0]> = {}) => ({ stageKey: "editing", deadlineAt: null, archived: false, ...over });

  it("an Edited review Project past its Deadline is late, by civil days", () => {
    // 17:00 Fri 16 Oct Sydney.
    expect(projectLateness(project({ stageKey: "edited_review", deadlineAt: Date.parse("2026-10-16T06:00:00Z") }), NOW)).toEqual({ late: true, daysLate: 2 });
  });

  it("reads an ISO Deadline the same as an epoch one", () => {
    expect(projectLateness(project({ deadlineAt: "2026-10-16T06:00:00Z" }), NOW)).toEqual({ late: true, daysLate: 2 });
  });

  it("a Delivered Project past its Deadline is not late", () => {
    expect(projectLateness(project({ stageKey: "delivered", deadlineAt: Date.parse("2026-10-01T00:00:00Z") }), NOW)).toEqual({ late: false });
  });

  it("an archived Project, or one with no Deadline, is not late", () => {
    expect(projectLateness(project({ archived: true, deadlineAt: Date.parse("2026-10-01T00:00:00Z") }), NOW)).toEqual({ late: false });
    expect(projectLateness(project({ deadlineAt: null }), NOW)).toEqual({ late: false });
  });

  it("a Deadline exactly now is not late; one a minute ago is, and reads Late today", () => {
    expect(projectLateness(project({ deadlineAt: NOW.getTime() }), NOW)).toEqual({ late: false });
    const minuteAgo = projectLateness(project({ deadlineAt: NOW.getTime() - 60_000 }), NOW);
    expect(minuteAgo).toEqual({ late: true, daysLate: 0 });
    expect(lateLabel(minuteAgo)).toBe("Late today");
  });

  it("a Deadline later today is not late yet", () => {
    expect(projectLateness(project({ deadlineAt: Date.parse("2026-10-18T06:00:00Z") }), NOW)).toEqual({ late: false });
  });

  it("an unreadable Deadline is not late", () => {
    expect(projectLateness(project({ deadlineAt: "not a date" }), NOW)).toEqual({ late: false });
  });
});

describe("subtaskLateness: a Subtask is late when its due (range end) has passed and it is not complete (#916)", () => {
  // 09:00 Wed 14 Oct Sydney.
  const due = Date.parse("2026-10-13T22:00:00Z");

  it("an open Subtask past its due is late, by civil days", () => {
    expect(subtaskLateness({ dueAt: due, complete: false }, NOW)).toEqual({ late: true, daysLate: 4 });
  });

  it("a completed Subtask past its due is not late", () => {
    expect(subtaskLateness({ dueAt: due, complete: true }, NOW)).toEqual({ late: false });
  });

  it("a Subtask due later is not late", () => {
    expect(subtaskLateness({ dueAt: Date.parse("2026-10-20T00:00:00Z"), complete: false }, NOW)).toEqual({ late: false });
  });
});

describe("civilDaysBetween counts Sydney calendar days, not 24-hour blocks (#916)", () => {
  it("across the AEDT start (Sun 4 Oct 2026, a 23-hour day)", () => {
    // Noon Sat 3 Oct (AEST) to noon Mon 5 Oct (AEDT): 47 real hours, 2 civil days.
    expect(civilDaysBetween(Date.parse("2026-10-03T02:00:00Z"), Date.parse("2026-10-05T01:00:00Z"))).toBe(2);
    // 23:30 Sat 3 Oct to 23:30 Sun 4 Oct: 23 real hours, 1 civil day.
    expect(civilDaysBetween(Date.parse("2026-10-03T13:30:00Z"), Date.parse("2026-10-04T12:30:00Z"))).toBe(1);
  });

  it("across the AEDT end (Sun 5 Apr 2026, a 25-hour day)", () => {
    // 00:30 Sat 4 Apr (AEDT) to 23:59 Sun 5 Apr (AEST): over 48 real hours, 1 civil day.
    expect(civilDaysBetween(Date.parse("2026-04-03T13:30:00Z"), Date.parse("2026-04-05T13:59:00Z"))).toBe(1);
  });

  it("is zero within one civil day and counts across a month end", () => {
    expect(civilDaysBetween(Date.parse("2026-10-17T13:01:00Z"), Date.parse("2026-10-18T12:59:00Z"))).toBe(0);
    expect(civilDaysBetween(Date.parse("2026-09-30T02:00:00Z"), Date.parse("2026-10-02T02:00:00Z"))).toBe(2);
  });
});

describe("lateLabel (#916)", () => {
  it("names the civil days late, and nothing when not late", () => {
    expect(lateLabel({ late: true, daysLate: 0 })).toBe("Late today");
    expect(lateLabel({ late: true, daysLate: 1 })).toBe("1 day late");
    expect(lateLabel({ late: true, daysLate: 3 })).toBe("3 days late");
    expect(lateLabel({ late: false })).toBeNull();
  });
});

describe("subtaskShape: a same-day range draws as a diamond (#916)", () => {
  // Wed 14 Oct 2026, Sydney (AEDT, UTC+11).
  const at = (hhmm: string, day = 14) => `2026-10-${day}T${hhmm}:00+11:00`;

  it("a working-day range (09:00 to 17:00) is a diamond", () => {
    expect(subtaskShape({ start: at("09:00"), end: at("17:00") })).toBe("diamond");
  });

  it("a range under an hour (09:00 to 09:30) is a diamond", () => {
    expect(subtaskShape({ start: at("09:00"), end: at("09:30") })).toBe("diamond");
  });

  it("a range crossing midnight (22:00 to 02:00) is a bar", () => {
    expect(subtaskShape({ start: at("22:00"), end: at("02:00", 15) })).toBe("bar");
  });

  it("a range ending at 00:00 ends on the next day, so it is a bar", () => {
    expect(subtaskShape({ start: at("22:00"), end: at("00:00", 15) })).toBe("bar");
  });

  it("a multi-day range is a bar", () => {
    expect(subtaskShape({ start: at("09:00"), end: at("17:00", 16) })).toBe("bar");
  });
});

describe("person colour: stable per user id over the people tokens (#916)", () => {
  it("is FNV-1a 32-bit of the id, mod 8 (published FNV test vectors)", () => {
    expect(PEOPLE_TONE_COUNT).toBe(8);
    // FNV-1a 32: "" = 0x811c9dc5, "a" = 0xe40c292c, "foobar" = 0xbf9cf968.
    expect(personColorIndex("")).toBe(0x811c9dc5 % 8);
    expect(personColorIndex("a")).toBe(0xe40c292c % 8);
    expect(personColorIndex("foobar")).toBe(0xbf9cf968 % 8);
  });

  it("pins real-shaped ids to their token, so a colour never moves between releases", () => {
    expect({
      E1: personColor("11111111-1111-4111-8111-111111111111"),
      E2: personColor("22222222-2222-4222-8222-222222222222"),
      E3: personColor("0b6f3c1e-9d2a-4c55-8e7f-3a1b2c3d4e5f"),
      E4: personColor("c3a9e2d4-1f0b-4a6e-9b8c-7d5e4f3a2b1c"),
    }).toEqual({ E1: "var(--people-4)", E2: "var(--people-2)", E3: "var(--people-2)", E4: "var(--people-7)" });
  });

  it("gives the same id the same colour every call", () => {
    const id = "c3a9e2d4-1f0b-4a6e-9b8c-7d5e4f3a2b1c";
    expect(personColor(id)).toBe(personColor(id));
  });
});

describe("personInitials (#916)", () => {
  it("takes the first and last word's initial, upper-cased", () => {
    expect(personInitials("ada")).toBe("A");
    expect(personInitials("  Grace  Brewster Hopper ")).toBe("GH");
    expect(personInitials("")).toBeNull();
  });
});

describe("subtaskPeopleTone: whose colour a Subtask bar takes in Colour by People (#916)", () => {
  const ada = { id: "11111111-1111-4111-8111-111111111111", name: "Ada Lovelace" };
  const grace = { id: "22222222-2222-4222-8222-222222222222", name: "Grace Hopper" };
  const alan = { id: "c3a9e2d4-1f0b-4a6e-9b8c-7d5e4f3a2b1c", name: "Alan Turing" };

  it("no assignee is Unassigned", () => {
    expect(subtaskPeopleTone({ assignees: [], otherAssigneeCount: 0 })).toEqual({ kind: "unassigned" });
  });

  it("exactly one named assignee is that person's colour and initials", () => {
    expect(subtaskPeopleTone({ assignees: [ada], otherAssigneeCount: 0 })).toEqual({ kind: "person", personId: ada.id, color: "var(--people-4)", initials: "AL" });
  });

  it("one named assignee plus a hidden one is shared, never credited to the one", () => {
    expect(subtaskPeopleTone({ assignees: [ada], otherAssigneeCount: 1 })).toEqual({
      kind: "shared",
      people: [{ personId: ada.id, initials: "AL", color: "var(--people-4)" }],
      hiddenCount: 1,
    });
  });

  it("only hidden assignees is shared with no named people", () => {
    expect(subtaskPeopleTone({ assignees: [], otherAssigneeCount: 2 })).toEqual({ kind: "shared", people: [], hiddenCount: 2 });
  });

  it("several assignees is shared, every one listed in assignment order", () => {
    expect(subtaskPeopleTone({ assignees: [ada, grace, alan], otherAssigneeCount: 0 })).toEqual({
      kind: "shared",
      people: [
        { personId: ada.id, initials: "AL", color: "var(--people-4)" },
        { personId: grace.id, initials: "GH", color: "var(--people-2)" },
        { personId: alan.id, initials: "AT", color: "var(--people-7)" },
      ],
      hiddenCount: 0,
    });
  });
});

describe("doneCount: a Project's N of M done (#916)", () => {
  it("is nothing for a Project with no Subtasks", () => {
    expect(doneCount({ completed: 0, total: 0 })).toBeNull();
  });

  it("counts some and all done", () => {
    expect(doneCount({ completed: 3, total: 5 })).toEqual({ done: 3, total: 5, label: "3 of 5 done" });
    expect(doneCount({ completed: 5, total: 5 })).toEqual({ done: 5, total: 5, label: "5 of 5 done" });
  });
});
