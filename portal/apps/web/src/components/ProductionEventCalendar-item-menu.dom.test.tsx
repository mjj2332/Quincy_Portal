/**
 * #463 — the item menu on the Production Calendar, through the REAL vendored event calendar (no
 * `vi.mock` of the tree): a chip click, Enter, or a right-click opens a menu with Open project and
 * Reschedule… / Edit schedule…; a drag never does; Space still starts keyboard Adjust (ADR 0009).
 * The selection strip it replaced is gone. Not-live and the controller's other follow-ups are pinned in
 * `ProductionEventCalendar-reconciliation.dom.test.tsx`, on the shared fake.
 *
 * Guard F: chips are found by their accessible name, the menu by role, dialogs by Quincy test ids.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto, ProductionCalendarSubview } from "@quincy/shared";
import { dated, deadlineEvent, oneDayEvent, PROJECT_ID, PROJECT_STREET, rangeResponse, type FixtureRole } from "../testing/production-calendar-fixtures";
import { calendarState, createHarness, flush, stubCalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const deadline = (over: Parameters<typeof deadlineEvent>[1] = {}) => deadlineEvent("2026-08-12T10:00", over);
const task = (over: Parameters<typeof oneDayEvent>[1] = {}) => oneDayEvent(dated("2026-08-12"), over);
const TASK_TITLE = "Select hero images";

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

async function mount(subview: ProductionCalendarSubview, events: CalendarEventDto[], props: { role?: FixtureRole; onOpenProject?: (id: string) => void } = {}) {
  stubCalendarFetch({ range: rangeResponse({ events, subview, role: props.role }) });
  await h.render(calendarState(subview), { role: props.role, onOpenProject: props.onOpenProject ?? (() => undefined), projectHrefFor: (id) => `/projects/${id}` });
}

/** A chip by its accessible name ("<title>, <time>"), in any view — the agenda row carries no Quincy tag. */
function chip(title: string): HTMLButtonElement {
  const found = [...h.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${title}, `) && button.getAttribute("aria-hidden") !== "true");
  if (!found) throw new Error(`no chip named "${title}"`);
  return found;
}
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) => node.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label) ?? null;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function activate(element: HTMLElement) {
  await act(async () => { element.focus(); await Promise.resolve(); });
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(30);
}
async function keydown(element: Element, key: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
}
async function pick(label: string) {
  await act(async () => { menuItem(label)!.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(60);
}

describe("ProductionEventCalendar item menu (#463)", () => {
  for (const subview of ["month", "week", "day", "days", "agenda"] as const) {
    it(`a ${subview}-view Deadline chip opens Open project and Reschedule…, a task chip Open project and Edit schedule…`, async () => {
      await mount(subview, [deadline(), task()]);
      await activate(chip(PROJECT_STREET));
      expect(menuLabels()).toEqual(["Open project", "Reschedule…"]);
      expect(menu()!.textContent).toContain(`Deadline · ${PROJECT_STREET}`);
      await keydown(document.activeElement!, "Escape");
      await flush(60);
      expect(menu()).toBeNull();
      await activate(chip(TASK_TITLE));
      expect(menuLabels()).toEqual(["Open project", "Edit schedule…"]);
      expect(menu()!.textContent).toContain(`${TASK_TITLE} · ${PROJECT_STREET}`);
    });
  }

  it("shows the overlap caution in the menu, where the strip used to", async () => {
    const overlapping = { ...task(), status: { ...task().status, sameAssigneeOverlap: true } } as CalendarEventDto;
    await mount("week", [overlapping]);
    await activate(chip(TASK_TITLE));
    expect(menu()!.textContent).toContain("Overlaps another task");
  });

  it("draws no selection strip, and the chip is a menu button, not a pressed toggle", async () => {
    await mount("week", [deadline()]);
    await activate(chip(PROJECT_STREET));
    expect(byTestId("event-calendar-selected")).toBeNull();
    expect(byTestId("event-calendar-selected-clear")).toBeNull();
    expect(chip(PROJECT_STREET).getAttribute("aria-haspopup")).toBe("menu");
    expect(chip(PROJECT_STREET).getAttribute("aria-expanded")).toBe("true");
    expect(chip(PROJECT_STREET).hasAttribute("aria-pressed")).toBe(false);
  });

  it("Open project calls onOpenProject with the chip focused", async () => {
    const focusedAtCall: Array<Element | null> = [];
    await mount("week", [deadline()], { onOpenProject: () => { focusedAtCall.push(document.activeElement); } });
    await activate(chip(PROJECT_STREET));
    await pick("Open project");
    expect(focusedAtCall).toEqual([chip(PROJECT_STREET)]);
  });

  it("Reschedule… opens the move dialog, and Cancel returns focus to the chip", async () => {
    await mount("week", [deadline()]);
    await activate(chip(PROJECT_STREET));
    await pick("Reschedule…");
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    await act(async () => { byTestId("event-calendar-move-cancel")!.click(); await Promise.resolve(); });
    await flush(500);
    expect(document.activeElement).toBe(chip(PROJECT_STREET));
  });

  it("Edit schedule… opens the schedule sheet", async () => {
    await mount("week", [task()]);
    await activate(chip(TASK_TITLE));
    await pick("Edit schedule…");
    expect(byTestId("event-calendar-schedule-editor")).not.toBeNull();
  });

  it("gives an External Editor Open project and Edit schedule… on a task", async () => {
    const base = task();
    const external = { ...base, project: { ...base.project, stageKey: "editing" as const }, assignees: [{ ...base.assignees[0]!, isExternal: true, roleLabel: "External Editor" }] } as CalendarEventDto;
    await mount("week", [external], { role: "external_editor" });
    await activate(chip(TASK_TITLE));
    expect(menuLabels()).toEqual(["Open project", "Edit schedule…"]);
  });

  it("gives a user who may not move the Deadline Open project only", async () => {
    await mount("week", [deadline({ canDrag: false, stageKey: "editing" })], { role: "editor" });
    await activate(chip(PROJECT_STREET));
    expect(menuLabels()).toEqual(["Open project"]);
  });

  it("offers no Open project when the surface was given no way to open one", async () => {
    stubCalendarFetch({ range: rangeResponse({ events: [deadline()], subview: "week" }) });
    await h.render(calendarState("week"), {});
    await activate(chip(PROJECT_STREET));
    expect(menuLabels()).toEqual(["Reschedule…"]);
  });

  it("a right-click opens the same menu and prevents the browser's", async () => {
    await mount("week", [deadline()]);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 });
    await act(async () => { chip(PROJECT_STREET).dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Open project", "Reschedule…"]);
  });

  it("a click whose pointer travelled opens nothing (a drag never opens the menu)", async () => {
    await mount("week", [deadline()]);
    const target = chip(PROJECT_STREET);
    await act(async () => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 10, clientY: 10 })); await Promise.resolve(); });
    await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 60, clientY: 70 })); await Promise.resolve(); });
    await flush(30);
    expect(menu()).toBeNull();
  });

  it("Enter opens the menu (a native click), with the first row focused", async () => {
    await mount("week", [deadline()]);
    const target = chip(PROJECT_STREET);
    await act(async () => { target.focus(); await Promise.resolve(); });
    await keydown(target, "Enter");
    await activate(target); // the click a browser fires on Enter
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(menuItem("Open project"));
  });

  it("Space on an adjustable chip starts keyboard Adjust and opens no menu; Enter commits it with no menu either", async () => {
    await mount("week", [deadline()]);
    const target = chip(PROJECT_STREET);
    await act(async () => { target.focus(); await Promise.resolve(); });
    await keydown(target, " ");
    expect(target.getAttribute("data-adjusting")).toBe("true");
    expect(menu()).toBeNull();
    await keydown(target, "ArrowDown");
    await keydown(document.activeElement ?? target, "Enter");
    await flush(30);
    expect(menu()).toBeNull();
  });

  it("Space on a chip nothing can adjust is left to the browser: a native click opens the menu", async () => {
    await mount("agenda", [deadline()]);
    const target = chip(PROJECT_STREET);
    await act(async () => { target.focus(); await Promise.resolve(); });
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(space); await Promise.resolve(); });
    expect(space.defaultPrevented).toBe(false);
    await activate(target); // the click a browser fires on Space's keyup
    expect(menu()).not.toBeNull();
  });
});

describe("ProductionEventCalendar item menu in the month '+N more' popover (#463, owner decision 4)", () => {
  const many = (): CalendarEventDto[] => Array.from({ length: 8 }, (_, index) => task({ id: `checklist:00000000-0000-4000-8000-00000000000${index}` }) as CalendarEventDto)
    .map((event, index) => ({ ...event, title: `Crowded task ${index}` }) as CalendarEventDto);
  const more = () => [...h.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => /^\+\d+ more/.test(button.textContent ?? ""));

  it("keeps the popover: a chip inside it opens the menu, one Escape closes only the menu, the popover stays", async () => {
    await mount("month", many());
    const trigger = more();
    expect(trigger, "the dense day folds some chips under +N more").toBeDefined();
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    const inPopover = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.getAttribute("aria-label")?.startsWith("Crowded task") && button.closest('[role="dialog"]'));
    expect(inPopover.length).toBeGreaterThan(0);
    await activate(inPopover[0]!);
    expect(menu()).not.toBeNull();
    await keydown(document.activeElement ?? document.body, "Escape");
    await flush(60);
    expect(menu()).toBeNull();
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.getAttribute("aria-label")?.startsWith("Crowded task") && button.closest('[role="dialog"]'))).toBe(true);
  });
});
