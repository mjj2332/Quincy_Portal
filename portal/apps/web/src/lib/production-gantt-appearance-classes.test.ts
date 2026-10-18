/**
 * #916 / #919: the Timeline bar classes (frame 3a). Each class owns every state the vendored bar shell
 * tints (rest, `hover:`, `data-selected:`, `data-completed:` and their pairs), per the lesson "A
 * consumer `eventClassName` must override every state the vendor tints; tailwind-merge only drops
 * same-variant utilities". These pin the strings; `ProductionGantt-appearance.dom.test.tsx` reads the
 * MERGED class off rendered bars.
 */
import { describe, expect, it } from "vitest";
import { stageTone, type Lateness, type PeopleTone } from "./dashboard-appearance";
import { ganttProjectBarClass, ganttTaskBarClass, type GanttTaskAppearance } from "./production-gantt-appearance-classes";

const NOT_LATE: Lateness = { late: false };
const PERSON: PeopleTone = { kind: "person", personId: "u1", color: "var(--people-1)", initials: "AN" };
const task = (overrides: Partial<GanttTaskAppearance> = {}): GanttTaskAppearance => ({
  tone: stageTone("editing"),
  lateness: NOT_LATE,
  shape: "bar",
  people: PERSON,
  complete: false,
  ...overrides,
});
const classes = (value: string) => value.split(/\s+/).filter(Boolean);
/** Every background the class sets, per variant chain (the part before the last `:`). */
function backgroundsByVariant(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const cls of classes(value)) {
    const cut = cls.lastIndexOf(":");
    const utility = cls.slice(cut + 1);
    if (utility.startsWith("bg-")) map.set(cls.slice(0, cut + 1), utility);
  }
  return map;
}
const VENDOR_BG_STATES = ["", "hover:", "data-selected:", "data-completed:", "data-completed:hover:", "data-completed:data-selected:"];

describe("ganttProjectBarClass (frame 3a project bars)", () => {
  it.each(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"] as const)("%s owns the fill in every state the vendor tints", (stage) => {
    const bgs = backgroundsByVariant(ganttProjectBarClass({ tone: stageTone(stage), lateness: NOT_LATE, done: null }, { milestone: false }));
    for (const state of VENDOR_BG_STATES) expect(bgs.has(state), `${stage}: ${state || "rest"}`).toBe(true);
  });

  it("solid: the stage tone itself, paper-000 label (4.71:1 on RAW review, where paper-050 is 4.44:1)", () => {
    const value = ganttProjectBarClass({ tone: stageTone("raw_review"), lateness: NOT_LATE, done: null }, { milestone: false });
    expect(classes(value)).toEqual(expect.arrayContaining(["bg-(--gantt-event-color)", "text-[var(--paper-000)]"]));
  });

  it("hollow-dashed (Awaiting RAW): the surface paper inside a dashed edge in the tone", () => {
    const value = classes(ganttProjectBarClass({ tone: stageTone("awaiting_raw"), lateness: NOT_LATE, done: null }, { milestone: false }));
    expect(value).toEqual(expect.arrayContaining(["bg-card", "border-dashed", "text-foreground"]));
  });

  it("wash (Delivered): a quiet tint of the tone inside a solid edge", () => {
    const value = classes(ganttProjectBarClass({ tone: stageTone("delivered"), lateness: NOT_LATE, done: null }, { milestone: false }));
    expect(value.some((cls) => cls.startsWith("bg-[color-mix(in_oklab,var(--gantt-event-color)_16%"))).toBe(true);
    expect(value).not.toContain("border-dashed");
  });

  it("hides the vendor's progress fill (the frame draws none; 'N of M done' is in the tree)", () => {
    expect(ganttProjectBarClass({ tone: stageTone("editing"), lateness: NOT_LATE, done: null }, { milestone: false })).toContain("[&>[data-slot=gantt-bar-progress]]:hidden");
  });

  it("an inverted-Deadline milestone keeps the vendor's own milestone look: no class", () => {
    expect(ganttProjectBarClass({ tone: stageTone("editing"), lateness: NOT_LATE, done: null }, { milestone: true })).toBe("");
  });

  it("never carries the old Edited review hatch", () => {
    expect(ganttProjectBarClass({ tone: stageTone("edited_review"), lateness: NOT_LATE, done: null }, { milestone: false })).not.toMatch(/repeating-linear-gradient/);
  });
});

describe("ganttTaskBarClass (frame 3a Subtask bars)", () => {
  it("owns the fill in every state the vendor tints", () => {
    const bgs = backgroundsByVariant(ganttTaskBarClass(task()));
    for (const state of VENDOR_BG_STATES) expect(bgs.has(state), state || "rest").toBe(true);
  });

  it("open: the surface paper inside a 1.5px edge in the parent Project's stage tone", () => {
    expect(classes(ganttTaskBarClass(task()))).toEqual(expect.arrayContaining(["bg-card", "border-[length:var(--border-width-mid)]", "border-(--gantt-event-color)"]));
  });

  it("done (owner decision D2): paper-100 fill, a solid --text-muted edge, in rest and every completed state", () => {
    const value = classes(ganttTaskBarClass(task({ complete: true })));
    expect(value).toEqual(expect.arrayContaining([
      "data-completed:bg-muted",
      "data-completed:hover:bg-muted",
      "data-completed:data-selected:bg-muted",
      "data-completed:border-(--text-muted)",
      "data-completed:data-selected:border-(--text-muted)",
      "data-completed:border-solid",
    ]));
  });

  it("late: a 2px --late edge", () => {
    expect(classes(ganttTaskBarClass(task({ lateness: { late: true, daysLate: 2 } })))).toEqual(expect.arrayContaining(["border-[length:var(--border-width-bold)]", "border-(--late)"]));
  });

  it("unassigned: a dashed edge (frame 3a `.tbar.unas`)", () => {
    expect(classes(ganttTaskBarClass(task({ people: { kind: "unassigned" } })))).toContain("border-dashed");
    expect(classes(ganttTaskBarClass(task()))).not.toContain("border-dashed");
  });

  it("diamond: the shell sheds its fill, edge and grips at Week and coarser only (a bar at Day zoom, D4)", () => {
    const value = classes(ganttTaskBarClass(task({ shape: "diamond" })));
    expect(value).toEqual(expect.arrayContaining(["not-in-data-[scale=day]:bg-transparent!", "not-in-data-[scale=day]:border-0!", "not-in-data-[scale=day]:overflow-visible", "not-in-data-[scale=day]:[&_[data-slot=gantt-resize-handle]]:hidden"]));
    expect(classes(ganttTaskBarClass(task())).some((cls) => cls.startsWith("not-in-data-[scale=day]:"))).toBe(false);
  });
});
