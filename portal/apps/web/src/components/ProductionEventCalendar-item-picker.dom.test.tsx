/**
 * #583 — the Calendar's item menu "Edit schedule…" opens the date/time picker directly, anchored to the chip, with no side sheet,
 * as #582 did for the Gantt bar. Through the REAL vendored event calendar (no `vi.mock` of the tree), like the item-menu suite.
 *
 * Covers the picker's own life (one popover, opens on Start, Cancel / Escape / outside press, the write), the #585 dismissed
 * conflict on this surface (the draft and the "Latest schedule" notice survive a dismissal; Cancel and Use latest discard),
 * narrow widths and an Agenda row replaced while the picker is open. Where the picker sits when the chip is folded under
 * "+N more" and where focus goes lives in the "+N more" describe below.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto, ChecklistCalendarEventDto, ProductionCalendarSubview } from "@quincy/shared";
import { checklistMutationBody, dated, oneDayEvent, oneDaySchedule, PROJECT_ID, PROJECT_STREET, rangeEvent, rangeResponse, timed } from "../testing/production-calendar-fixtures";
import { applyPopup, dateTimePopup, pickPopupDay, popupButton, pressInPopup, rangeToggles } from "../testing/date-time-popup";
import { calendarState, createHarness, flush, json, stubCalendarFetch, stubMedia, type CalendarFetch, type Harness } from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

const TASK_TITLE = "Select hero images";
const PICKER_NAME = `Schedule for ${TASK_TITLE}, ${PROJECT_STREET}`;
const task = (over: Parameters<typeof oneDayEvent>[1] = {}) => oneDayEvent(dated("2026-08-12"), over);

let h: Harness;
let gate: ReturnType<typeof vi.fn<(blocked: boolean) => void>>;
beforeEach(() => { gate = vi.fn<(blocked: boolean) => void>(); h = createHarness(); });
afterEach(() => { h.teardown(); });

const gateStates = () => gate.mock.calls.map(([blocked]) => blocked);
const picker = () => dateTimePopup(PICKER_NAME);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label) ?? null;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount(subview: ProductionCalendarSubview, events: CalendarEventDto[], patch?: Parameters<typeof stubCalendarFetch>[0]["patch"]): Promise<CalendarFetch> {
  const fetch = stubCalendarFetch({ range: rangeResponse({ events, subview, projectBounds: [{ projectId: PROJECT_ID, shootDate: "2026-08-01", createdAt: "2026-07-01T00:00:00.000Z", deadlineLocalCivil: "2026-08-14T17:00", deadlineFold: 0 }] }), patch: patch ?? (() => json(checklistMutationBody(events[0] as ChecklistCalendarEventDto, oneDaySchedule(dated("2026-08-12"), 4)))) });
  await h.render(calendarState(subview), { onOpenProject: () => undefined, projectHrefFor: (id) => `/projects/${id}`, onAcceptGateChange: gate });
  return fetch;
}

/** A chip by its accessible name ("<title>, <time>"), in any view. */
function chip(title = TASK_TITLE): HTMLButtonElement {
  const found = [...h.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${title}, `) && button.getAttribute("aria-hidden") !== "true");
  if (!found) throw new Error(`no chip named "${title}"`);
  return found;
}
async function keydown(element: Element, key: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
}
async function activate(element: HTMLElement) {
  await act(async () => { element.focus(); await Promise.resolve(); });
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(30);
}
async function pick(label: string) {
  await act(async () => { menuItem(label)!.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(60);
}
async function openPicker() {
  await activate(chip());
  await pick("Edit schedule…");
  await flush(3);
}
async function escape() {
  await keydown(document.activeElement ?? document.body, "Escape");
  await flush(60);
}
const patchBody = (call: { body: unknown }) => (call.body as { schedule: { expectedVersion: number; schedule: unknown; reminderOffsetsMinutes?: number[] } }).schedule;

describe("ProductionEventCalendar Edit schedule… opens the chip's own picker (#583)", () => {
  for (const subview of ["month", "week", "day", "days", "agenda"] as const) {
    it(`a ${subview}-view chip: exactly one picker, no sheet, opening on Start with the Project default and a reminder chip; the gate is held`, async () => {
      await mount(subview, [task()]);
      await openPicker();
      expect(picker()).not.toBeNull();
      expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1);
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(byTestId("event-calendar-schedule-editor")).toBeNull();
      expect(rangeToggles(picker()!).active).toBe("Start");
      expect(popupButton(picker()!, "Project default"), "the Project default shortcut").toBeDefined();
      expect(gateStates().at(-1)).toBe(true);
    });
  }

  describe("opening focus lands inside the picker, on the Start day, past the menu's restore timer", () => {
    const sleep = (ms: number) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
    function expectOnPickerButton(when: string) {
      const active = document.activeElement as HTMLElement | null;
      expect(picker(), when).not.toBeNull();
      expect(active && picker()!.contains(active), `inside the picker, ${when}`).toBe(true);
      expect(active, `not the dialog itself, ${when}`).not.toBe(picker());
      expect(active!.tagName, `a button, ${when}`).toBe("BUTTON");
    }
    for (const subview of ["month", "week", "agenda"] as const) {
      it(`pointer, ${subview}`, async () => {
        await mount(subview, [task()]);
        await openPicker();
        expectOnPickerButton("settled");
        await sleep(250); await flush(3);
        expectOnPickerButton("after 250ms");
        await sleep(400);
        expectOnPickerButton("after 650ms");
      });
      it(`keyboard, ${subview}`, async () => {
        await mount(subview, [task()]);
        const target = chip();
        await act(async () => { target.focus(); await Promise.resolve(); });
        await keydown(target, "Enter");
        await act(async () => { target.click(); await Promise.resolve(); await Promise.resolve(); });
        await flush(30);
        await keydown(document.activeElement!, "ArrowDown");
        await flush(3);
        const row = document.activeElement as HTMLElement;
        expect(row.textContent).toBe("Edit schedule…");
        await keydown(row, "Enter");
        await act(async () => { row.click(); await Promise.resolve(); await Promise.resolve(); });
        await flush(60);
        expectOnPickerButton("settled");
        await sleep(650);
        expectOnPickerButton("after 650ms");
      });
    }
  });

  it("Cancel sends no PATCH, releases the gate and puts focus back on the chip", async () => {
    const fetch = await mount("week", [task()]);
    await openPicker();
    await pressInPopup(picker()!, "Cancel");
    await flush(3);
    expect(picker()).toBeNull();
    expect(fetch.patches()).toHaveLength(0);
    expect(gateStates().at(-1)).toBe(false);
    expect(document.activeElement).toBe(chip());
  });

  it("Escape sends no PATCH, releases the gate and puts focus back on the chip", async () => {
    const fetch = await mount("week", [task()]);
    await openPicker();
    await escape();
    expect(picker()).toBeNull();
    expect(fetch.patches()).toHaveLength(0);
    expect(gateStates().at(-1)).toBe(false);
    expect(document.activeElement).toBe(chip());
  });

  it("an untouched Apply sends no PATCH; an edited Apply is ONE PATCH at the opening version", async () => {
    const fetch = await mount("week", [task({ version: 3 })]);
    await openPicker();
    await applyPopup(picker()!);
    await flush(30);
    expect(fetch.patches(), "an untouched Apply is a no-op").toHaveLength(0);
    expect(picker()).toBeNull();
    await openPicker();
    await pickPopupDay(picker()!, "2026-08-14");
    await applyPopup(picker()!);
    await flush(60);
    expect(fetch.patches()).toHaveLength(1);
    const sent = patchBody(fetch.patches()[0]!);
    expect(sent.expectedVersion).toBe(3);
    expect(sent.reminderOffsetsMinutes, "an unchanged reminder set is left out").toBeUndefined();
  });

  it("an outside press onto a real control keeps focus there: the controller does not pull it back to the chip (ifLost)", async () => {
    const fetch = await mount("week", [task()]);
    await openPicker();
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Elsewhere";
    document.body.append(outside);
    await act(async () => {
      outside.focus();
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    await flush(700);
    expect(picker()).toBeNull();
    expect(fetch.patches()).toHaveLength(0);
    expect(document.activeElement, "the pressed control keeps focus past the controller's and the menu's restore timers").toBe(outside);
    outside.remove();
  });

  it("stays a picker (no sheet) at 720px and at 640px", async () => {
    for (const width of ["(max-width: 720px)", "(max-width: 641px)"]) {
      stubMedia([width, "(max-width: 1100px)"]);
      await mount("month", [task()]);
      await openPicker();
      expect(picker(), width).not.toBeNull();
      expect(byTestId("event-calendar-schedule-editor"), width).toBeNull();
      await pressInPopup(picker()!, "Cancel");
      await flush(60);
      await h.unmount();
    }
  });

  describe("a save conflict keeps the draft; Escape and an outside press keep it past a dismissal (#585 on this surface)", () => {
    const conflict = () => json({ code: "subtask_schedule_version_conflict", message: "conflict" }, 409);
    async function conflicted() {
      const fetch = await mount("week", [task({ version: 3 })], conflict);
      await openPicker();
      await pickRangeDay("2026-08-15");
      await flush(80);
      return fetch;
    }
    async function pickRangeDay(day: string) {
      await pickPopupDay(picker()!, day);
      await applyPopup(picker()!);
    }
    const noticeShown = () => picker()?.textContent?.includes("Latest schedule") ?? false;

    it("the picker reopens on the draft with the notice, and the gate stays held", async () => {
      const fetch = await conflicted();
      expect(fetch.patches()).toHaveLength(1);
      expect(picker()).not.toBeNull();
      expect(noticeShown()).toBe(true);
      expect(gateStates().at(-1)).toBe(true);
    });

    it("Escape ends the session (gate released) but a reopen via Edit schedule… shows the draft and the notice", async () => {
      await conflicted();
      await escape();
      expect(picker()).toBeNull();
      expect(gateStates().at(-1)).toBe(false);
      await openPicker();
      expect(noticeShown()).toBe(true);
      expect(rangeToggles(picker()!).start).toContain("Sat 15 Aug");
    });

    it("an outside press does the same", async () => {
      await conflicted();
      const outside = document.createElement("button");
      outside.type = "button";
      document.body.append(outside);
      await act(async () => {
        outside.focus();
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        await Promise.resolve();
      });
      await flush(30);
      outside.remove();
      expect(picker()).toBeNull();
      expect(gateStates().at(-1)).toBe(false);
      await openPicker();
      expect(noticeShown()).toBe(true);
    });

    it("a reapply after a dismissal is ONE more PATCH, at the latest version", async () => {
      const fetch = await conflicted();
      await escape();
      await openPicker();
      await applyPopup(picker()!);
      await flush(80);
      expect(fetch.patches()).toHaveLength(2);
      expect(patchBody(fetch.patches()[1]!).expectedVersion).toBe(3);
    });

    it("Cancel discards: the next open has neither the draft nor the notice", async () => {
      await conflicted();
      await pressInPopup(picker()!, "Cancel");
      await flush(60);
      expect(gateStates().at(-1)).toBe(false);
      await openPicker();
      expect(noticeShown()).toBe(false);
      expect(rangeToggles(picker()!).start).toContain("Wed 12 Aug");
    });

    it("Use latest schedule discards the draft with no second write", async () => {
      const fetch = await conflicted();
      await pressInPopup(picker()!, "Use latest schedule (discard draft)");
      await flush(60);
      expect(fetch.patches()).toHaveLength(1);
      expect(gateStates().at(-1)).toBe(false);
      await openPicker();
      expect(noticeShown()).toBe(false);
    });
  });
});

describe("ProductionEventCalendar bar picker through an Agenda re-key (#583)", () => {
  it("returns focus to the replacement row when the edited item's start moved and Escape closes the picker", async () => {
    let events = [task()];
    stubCalendarFetch({ range: () => json(rangeResponse({ events, subview: "agenda" })) });
    await h.render(calendarState("agenda"), { onOpenProject: () => undefined, projectHrefFor: (id) => `/projects/${id}`, onAcceptGateChange: gate });
    const before = chip();
    await activate(before);
    await pick("Edit schedule…");
    await flush(3);
    expect(picker()).not.toBeNull();
    events = [oneDayEvent(dated("2026-08-14"))];
    await act(async () => { await h.client.invalidateQueries({ queryKey: ["production-calendar"] }); });
    await flush(60);
    expect(picker(), "a re-keyed row does not cancel the session").not.toBeNull();
    await escape();
    await flush(700);
    const after = chip();
    expect(after.isConnected).toBe(true);
    expect(after, "the item's row was replaced").not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect(menu()).toBeNull();
  });
});

describe("ProductionEventCalendar picker for a chip folded under '+N more' (#583)", () => {
  const DAYS = ["2026-08-12", "2026-08-13"] as const;
  /** Two crowded days, and a multi-day item that is folded under BOTH days' "+N more", so its id alone cannot name the right button. */
  function crowded(): CalendarEventDto[] {
    const events: CalendarEventDto[] = [];
    for (const day of DAYS) for (let i = 0; i < 8; i += 1) events.push({ ...oneDayEvent(dated(day), { id: `checklist:00000000-0000-4000-8000-0000000000${day.slice(8)}${i}` }), title: `Task ${day.slice(8)}-${i}` } as CalendarEventDto);
    for (let i = 0; i < 4; i += 1) events.push({ ...rangeEvent(timed("2026-08-12T10:00"), timed("2026-08-13T11:00"), { id: `checklist:00000000-0000-4000-8000-00000000009${i}` }), title: `Multi ${i}` } as CalendarEventDto);
    return events;
  }
  const MULTI = "Multi 3";
  const multiName = `Schedule for ${MULTI}, ${PROJECT_STREET}`;
  const multiPicker = () => dateTimePopup(multiName);
  const moreButton = (day: string) => {
    const marker = [...h.host.querySelectorAll<HTMLElement>("[data-more-day]")].find((element) => element.getAttribute("data-more-day") === day);
    const button = marker?.closest<HTMLButtonElement>("button");
    if (!button) throw new Error(`no "+N more" for ${day}`);
    return button;
  };

  async function pickMultiFrom(day: string) {
    const trigger = moreButton(day);
    await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    const inPopover = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith(`${MULTI}, `) && button.closest('[role="dialog"]'));
    expect(inPopover, `${MULTI} is in ${day}'s overflow list`).toBeDefined();
    await activate(inPopover!);
    await pick("Edit schedule…");
    await flush(3);
  }

  for (const day of DAYS) {
    it(`the picker anchors to ${day}'s "+N more", not the other day's, and Cancel returns focus to it`, async () => {
      const fetch = await mount("month", crowded());
      const [a, b] = [moreButton(DAYS[0]), moreButton(DAYS[1])];
      const reads = { [DAYS[0]]: vi.fn(() => new DOMRect(10, 10, 40, 20)), [DAYS[1]]: vi.fn(() => new DOMRect(300, 10, 40, 20)) };
      a.getBoundingClientRect = reads[DAYS[0]]!;
      b.getBoundingClientRect = reads[DAYS[1]]!;
      await pickMultiFrom(day);
      expect(multiPicker(), "the picker for the folded multi-day item").not.toBeNull();
      const other = DAYS.find((candidate) => candidate !== day)!;
      expect(reads[day]!.mock.calls.length, `the picker read ${day}'s button`).toBeGreaterThan(0);
      expect(reads[other]!.mock.calls.length, `the picker never read ${other}'s button`).toBe(0);
      await pressInPopup(multiPicker()!, "Cancel");
      await flush(60);
      expect(fetch.patches()).toHaveLength(0);
      expect(document.activeElement, "focus returns to the originating day's button").toBe(moreButton(day));
      await flush(700);
      expect(document.activeElement, "and stays there past the menu's restore timers").toBe(moreButton(day));
    });
  }
});
