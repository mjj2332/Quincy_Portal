/**
 * #921 (frame 3c): the phone row's meta line and the Key drawer's Colour by slot. The meta reads the drawn bar's own
 * appearance, so it can never disagree with the bar; the slot is where #920's Colour by switch goes (D7).
 */
process.env.TZ = "America/Los_Angeles";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GanttChecklistRowDto, GanttProjectRowDto, StagePresentationKey } from "@quincy/shared";
import { stageTone } from "../lib/dashboard-appearance";
import { GanttKeyDrawer, phoneRowMeta, phoneRowProjectId, type GanttPhoneRow } from "./ProductionGanttPhone";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

// Thu 17 Sep 2026, 12:00 in Sydney.
const NOW = new Date("2026-09-17T02:00:00.000Z");
const FRI_18 = new Date("2026-09-18T07:00:00.000Z");
const LABELS: Record<string, string> = { editing: "Editing · autoHDR", raw_review: "RAW review" };
const stageLabelFor = (key: StagePresentationKey) => LABELS[key];

const projectDto = { id: "p-1", stageKey: "editing_autohdr" } as unknown as GanttProjectRowDto;
const taskDto = { id: "t-1", projectId: "p-1", done: false, assignees: [], otherAssigneeCount: 0 } as unknown as GanttChecklistRowDto;

function projectRow(lateness: { late: false } | { late: true; daysLate: number }, end = FRI_18): GanttPhoneRow {
  const appearance = { tone: stageTone("editing_autohdr"), lateness, done: null };
  return { kind: "project", dto: projectDto, end, data: { kind: "project", dto: projectDto, appearance } as never };
}
function taskRow(opts: { late?: number; complete?: boolean; end?: Date }): GanttPhoneRow {
  const lateness = opts.late === undefined ? { late: false as const } : { late: true as const, daysLate: opts.late };
  const appearance = { tone: stageTone("editing_autohdr"), lateness, shape: "bar", people: { kind: "unassigned" }, complete: opts.complete ?? false };
  return { kind: "task", dto: taskDto, end: opts.end ?? FRI_18, data: { kind: "task", dto: taskDto, appearance } as never };
}

describe("phoneRowMeta (frame 3c `.pm`)", () => {
  it("a Project reads its Stage's short name and its Deadline's day", () => {
    expect(phoneRowMeta(projectRow({ late: false }), NOW, stageLabelFor)).toEqual({ text: "Editing · due Fri 18", late: false });
  });
  it("a Project due today says so", () => {
    expect(phoneRowMeta(projectRow({ late: false }, new Date("2026-09-17T08:00:00.000Z")), NOW, stageLabelFor)!.text).toBe("Editing · due today");
  });
  it("a late Project reads its late label, in the late colour", () => {
    expect(phoneRowMeta(projectRow({ late: true, daysLate: 2 }), NOW, stageLabelFor)).toEqual({ text: "2 days late", late: true });
    expect(phoneRowMeta(projectRow({ late: true, daysLate: 0 }), NOW, stageLabelFor)!.text).toBe("Late today");
  });
  it("a Subtask reads Due, Done or its late label", () => {
    expect(phoneRowMeta(taskRow({}), NOW, stageLabelFor)).toEqual({ text: "Due Fri 18", late: false });
    expect(phoneRowMeta(taskRow({ complete: true }), NOW, stageLabelFor)).toEqual({ text: "Done", late: false });
    expect(phoneRowMeta(taskRow({ late: 1 }), NOW, stageLabelFor)).toEqual({ text: "1 day late", late: true });
  });
  it("a row with no bar has no meta (its attention reason speaks instead)", () => {
    expect(phoneRowMeta({ kind: "project", dto: projectDto }, NOW, stageLabelFor)).toBeNull();
  });
  it("a tap on a Subtask opens its parent Project", () => {
    expect(phoneRowProjectId(taskRow({}).data!)).toBe("p-1");
    expect(phoneRowProjectId(projectRow({ late: false }).data!)).toBe("p-1");
  });
});

describe("GanttKeyDrawer", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); await Promise.resolve(); });
    document.body.replaceChildren();
  });

  it("holds the Colour by switch in its slot once the host passes one", async () => {
    await act(async () => {
      root.render(<GanttKeyDrawer entries={[]} onToggle={() => {}} colourBySlot={<span data-testid="colour-by-slot">Colour by</span>} />);
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="production-gantt-key-button"]')!.click(); await Promise.resolve(); });
    const drawer = document.querySelector('[data-testid="production-gantt-key-drawer"]')!;
    expect(drawer.querySelector('[data-testid="colour-by-slot"]')).not.toBeNull();
    expect(drawer.querySelector('[data-testid="stage-key-row"]')).not.toBeNull();
  });
});
