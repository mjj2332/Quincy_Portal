/**
 * #221 design re-review: the resize chip read "Oct 3, 9:00 AM - Oct 9, 12:00 AM - 6 days". An end
 * at exactly midnight is exclusive, so "Oct 9, 12:00 AM" named the wrong last day.
 */
import { describe, expect, it } from "vitest";
import { enAU } from "date-fns/locale";
import { DEFAULT_GANTT_I18N, mergeGanttI18n } from "./gantt-i18n";

const fmt = DEFAULT_GANTT_I18N.functions.formatEventTime;

describe("formatEventTime, multi-day timed ranges", () => {
  it("names the last day, without a time, when the end is exactly midnight", () => {
    expect(fmt(new Date(2026, 9, 3, 9, 0), new Date(2026, 9, 9, 0, 0), false, enAU)).toBe("Oct 3, 9:00 AM - Oct 8");
  });

  it("keeps the end time when the end is not midnight", () => {
    expect(fmt(new Date(2026, 9, 3, 9, 0), new Date(2026, 9, 9, 17, 0), false, enAU)).toBe("Oct 3, 9:00 AM - Oct 9, 5:00 PM");
  });
});

describe("per-group create row names (#344)", () => {
  it("names the group in the row and input, and carries the empty-title copy", () => {
    expect(DEFAULT_GANTT_I18N.functions.addTaskIn("1 Writes Street")).toBe("Add task in 1 Writes Street");
    expect(DEFAULT_GANTT_I18N.functions.createTaskTitleIn("1 Writes Street")).toBe("New task title in 1 Writes Street");
    expect(DEFAULT_GANTT_I18N.labels.createTaskEmpty).toBe("Enter a task title.");
  });

  it("re-binds addTaskIn to an overridden addTask label; an explicit function override still wins", () => {
    expect(mergeGanttI18n({ labels: { addTask: "New task" } }).functions.addTaskIn("X")).toBe("New task in X");
    expect(mergeGanttI18n({ functions: { addTaskIn: (t) => `+ ${t}` } }).functions.addTaskIn("X")).toBe("+ X");
  });
});
