/**
 * #922 — frame 3d's key row on the Calendar (`design/prototypes/dashboard-views/`, "Dashboard views v3",
 * `.keyrow` under the nav bar). The shared `StageKeyRow` (#919), fed by the Timeline's own entry builder
 * (`ganttKeyEntries`): every role-aware Stage is a chip (#254), pressed for the Stages the Calendar's
 * request shows, and a press hands the Dashboard one Filter write (`onFilterChange`, its `writeFilter`,
 * which keeps the Delivered pair — #270 / #430). The trailing key names the Deadline chip; there is no
 * Shoot symbol (the Calendar draws no shoot events — plan, frame-3d conflicts).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardFilterStageScope, dashboardFilterTreeOf, type DashboardCalendarState, type DashboardFilter } from "@quincy/shared";
import { rangeResponse } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, stubCalendarFetch, stubMedia, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("../lib/stages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/stages")>()),
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
      { key: "editing", label: "Editing", displayOrder: 3, active: true },
      { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
      { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));

const EVERY = ["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"];

function keyBand(): HTMLElement {
  const band = document.querySelector<HTMLElement>('[data-testid="event-calendar-key"]');
  if (!band) throw new Error("no Calendar key row");
  return band;
}
function keyChips(): HTMLButtonElement[] {
  return [...keyBand().querySelectorAll<HTMLButtonElement>('[data-testid="stage-key-row"] button[data-stage-key]')];
}
const keyKeys = () => keyChips().map((chip) => chip.getAttribute("data-stage-key")!);
const pressedKeys = () => keyChips().filter((chip) => chip.getAttribute("aria-pressed") === "true").map((chip) => chip.getAttribute("data-stage-key")!);
function keyChip(key: string): HTMLButtonElement {
  const chip = keyChips().find((candidate) => candidate.getAttribute("data-stage-key") === key);
  if (!chip) throw new Error(`no key chip for ${key}`);
  return chip;
}
const stagesOf = (filter: DashboardFilter) => dashboardFilterStageScope(dashboardFilterTreeOf(filter));

function week(overrides: Partial<DashboardCalendarState> = {}): DashboardCalendarState {
  return { ...calendarState("week"), ...overrides };
}

let h: Harness;
beforeEach(() => { h = createHarness(); stubCalendarFetch({ range: rangeResponse() }); });
afterEach(() => { h.teardown(); });

describe("the Calendar's Stage key row (#922, frame 3d)", () => {
  it("sits under the nav bar and above the grid, one chip per role-aware Stage", async () => {
    await h.render(week());
    const band = keyBand();
    const nav = document.querySelector('[data-testid="event-calendar-zone"]')!;
    const grid = document.querySelector('[data-testid="event-calendar-fake-content"]')!;
    expect(nav.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(band.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keyKeys()).toEqual(EVERY);
  });

  it("presses the Stages the Calendar shows: Delivered only while delivered Projects are shown", async () => {
    await h.render(week());
    expect(pressedKeys()).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review"]);
    await h.rerender(week({ showDeliveredProjects: true }));
    expect(pressedKeys()).toEqual(EVERY);
    await h.rerender(week({ stageKeys: ["raw_review"] }));
    expect(keyKeys()).toEqual(EVERY);
    expect(pressedKeys()).toEqual(["raw_review"]);
  });

  it("a chip press is one Filter write through onFilterChange", async () => {
    const writes: DashboardFilter[] = [];
    await h.render(week({ stageKeys: ["raw_review"] }), { onFilterChange: (next) => writes.push(next) });
    await act(async () => { keyChip("editing").click(); });
    expect(writes).toHaveLength(1);
    expect(stagesOf(writes[0]!)).toEqual(["raw_review", "editing"]);

    // The Dashboard writes it back as the new request; pressing a pressed Stage removes it.
    await h.rerender(week({ stageKeys: ["raw_review", "editing"] }), { onFilterChange: (next) => writes.push(next) });
    await act(async () => { keyChip("raw_review").click(); });
    expect(writes).toHaveLength(2);
    expect(stagesOf(writes[1]!)).toEqual(["editing"]);
  });

  it("disables every chip, titled \"Edit Stage in Filter\", while the Stage rule sits in an OR", async () => {
    const writes: DashboardFilter[] = [];
    await h.render(week({ tree: { kind: "group", op: "or", children: [{ kind: "leaf", field: "stages", values: ["raw_review"] }, { kind: "leaf", field: "mine" }] } }), { onFilterChange: (next) => writes.push(next) });
    expect(keyChips()).toHaveLength(5);
    for (const chip of keyChips()) {
      expect(chip.disabled, chip.getAttribute("data-stage-key")!).toBe(true);
      expect(chip.getAttribute("title")).toBe("Edit Stage in Filter");
    }
  });

  it("ends with the Deadline symbol in 12px meta type, and no Shoot symbol", async () => {
    await h.render(week());
    const deadline = keyBand().querySelector<HTMLElement>('[data-testid="event-calendar-key-deadline"]');
    expect(deadline?.textContent).toBe("Deadline");
    expect(deadline?.className).toMatch(/(?<![\w-])text-xs(?![\w-])/);
    expect(keyBand().textContent).not.toMatch(/Shoot/);
  });

  it("is drawn on the phone toolbar too", async () => {
    h.teardown();
    h = createHarness();
    stubMedia(["(max-width: 720px)", "(pointer: coarse)", "(max-width: 1100px)"]);
    stubCalendarFetch({ range: rangeResponse() });
    await h.render(week({ subview: "agenda" }));
    expect(keyKeys()).toEqual(EVERY);
    const controls = document.querySelector('[data-testid="event-calendar-controls"]')!;
    expect(controls.compareDocumentPosition(keyBand()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
