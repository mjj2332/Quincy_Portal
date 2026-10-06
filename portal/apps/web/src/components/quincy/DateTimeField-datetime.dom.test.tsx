import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeApply, type DateTimeStored } from "./DateTimeField";
import { applyPopup, dateTimePopup, pickPopupDateTime, pickPopupDay, popupButton, popupDraft, popupTimeInput, pressInPopup, typePopupTime } from "@/testing/date-time-popup";

/**
 * Seam E (#422): the date-time form of the date/time field, driven through roles, names and aria
 * state only. "Now" is pinned with fake `Date` only, so Base UI's timers keep running:
 * Thu 1 Oct 2026, 13:00 in Sydney.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

type Next = { kind: "advance" | "due_now"; offsetMinutes: number; firesAt: string } | null;
type Props = {
  value?: DateTimeStored | null;
  clearable?: boolean;
  offsets?: number[] | null;
  next?: Next;
  onApply?: (next: DateTimeApply) => void | Promise<void>;
  seed?: { localCivil: string | null; disambiguation?: "earlier" | "later"; reminderOffsetsMinutes: number[] };
  seedKey?: number;
};

function element(props: Props) {
  const { value = null, clearable = true, offsets = [], next, onApply = vi.fn(), seed, seedKey } = props;
  return <DateTimeField variant="date-time" id="deadline" label="Deadline" value={value} clearable={clearable} reminders={offsets === null ? undefined : { offsets, ...(next !== undefined ? { next } : {}) }} seed={seed} seedKey={seedKey} onApply={onApply} />;
}

async function mount(props: Props = {}) {
  const onApply = props.onApply ?? vi.fn();
  await act(async () => { root.render(element({ ...props, onApply })); await Promise.resolve(); });
  return onApply as ReturnType<typeof vi.fn>;
}

const trigger = () => host.querySelector<HTMLButtonElement>("button#deadline")!;
const popup = () => dateTimePopup("Deadline");
const slotButtons = () => [...popup()!.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Time slots"] button')];
const slot = (time: string) => slotButtons().find((button) => button.textContent?.startsWith(time));
const chip = (label: string) => [...popup()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);

async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
}
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); });
  await settle();
}
async function pressOutside() {
  await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
}
const stored = (localCivil: string, fold: 0 | 1 = 0): DateTimeStored => ({ localCivil, fold });
const applyButton = () => popupButton(popup()!, "Apply")!;

describe("DateTimeField date-time trigger and popup", () => {
  it("shows the stored day and time, named by its label and value", async () => {
    await mount({ value: stored("2027-01-15T09:00") });
    expect(trigger().textContent).toContain("Fri 15 Jan 2027 · 09:00");
    const names = trigger().getAttribute("aria-labelledby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(names.join(" ")).toBe("Deadline Fri 15 Jan 2027 · 09:00");
  });

  it("opens a Sydney popup with a 15-minute time column and no native date or time input", async () => {
    await mount({ value: stored("2027-01-15T09:00") });
    await open();
    expect(popup()).not.toBeNull();
    expect(popup()!.textContent).toContain("Australia/Sydney");
    const slots = slotButtons().map((button) => button.textContent);
    expect(slots).toHaveLength(96);
    expect(slots[0]).toBe("00:00");
    expect(slots[1]).toBe("00:15");
    expect(slots[95]).toBe("23:45");
    expect(popup()!.querySelector('input[type="date"], input[type="time"], input[type="datetime-local"]')).toBeNull();
    expect(slot("09:00")!.getAttribute("aria-pressed")).toBe("true");
    expect(slotButtons().filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("offers no Earlier / Later for an ordinary time", async () => {
    await mount({ value: stored("2027-01-15T09:00") });
    await open();
    expect(popup()!.querySelector('[role="group"][aria-label="Which Sydney time"]')).toBeNull();
  });
});

describe("DateTimeField date-time: picking a time", () => {
  it("applies a slot with the stored day", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await click(slot("14:30")!);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T14:30" });
    expect(popup()).toBeNull();
  });

  it("accepts an exact off-grid time as typed, never rounding it", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await typePopupTime(popup()!, "17:07");
    expect(slotButtons().some((button) => button.getAttribute("aria-pressed") === "true")).toBe(false);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T17:07" });
  });

  it.each([["0905", "09:05"], ["9:05", "09:05"], ["0000", "00:00"]])("normalises typed %s to %s", async (typed, expected) => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await typePopupTime(popup()!, typed);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: `2027-01-15T${expected}` });
  });

  it.each(["24:00", "17:07:30", "12:60", "5pm", "7"])("rejects typed %j and blocks Apply with a message", async (typed) => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await typePopupTime(popup()!, typed);
    expect(popup()!.querySelector('[role="alert"]')?.textContent).toContain("HH:MM");
    expect(popupTimeInput(popup()!).getAttribute("aria-invalid")).toBe("true");
    expect(applyButton().disabled).toBe(true);
    await click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
    expect(popup()).not.toBeNull();
  });

  it("recovers when the typed time becomes valid again", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await typePopupTime(popup()!, "24:00");
    await typePopupTime(popup()!, "23:59");
    expect(popup()!.querySelector('[role="alert"]')).toBeNull();
    expect(applyButton().disabled).toBe(false);
  });
});

describe("DateTimeField date-time: the 17:00 rule", () => {
  it("a date-only shortcut always sets 17:00, even over an existing time", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await pressInPopup(popup()!, "Tomorrow");
    expect(popupTimeInput(popup()!).value).toBe("17:00");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2026-10-02T17:00" });
  });

  it("a calendar day with no time yet takes 17:00", async () => {
    const onApply = await mount({ value: null, offsets: null });
    await open();
    await pickPopupDay(popup()!, "2027-01-15");
    expect(popupTimeInput(popup()!).value).toBe("17:00");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T17:00" });
  });

  it("a calendar day keeps the time already in the draft", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    await pickPopupDay(popup()!, "2027-01-22");
    expect(popupTimeInput(popup()!).value).toBe("09:00");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-22T09:00" });
  });

  it("a calendar day keeps a time typed before it was picked", async () => {
    const onApply = await mount({ value: null, offsets: null });
    await open();
    await typePopupTime(popup()!, "08:20");
    await pickPopupDay(popup()!, "2027-01-15");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T08:20" });
  });

  it("holds Apply until a day exists when only a time was picked", async () => {
    await mount({ value: null, offsets: null });
    await open();
    await click(slot("10:00")!);
    expect(applyButton().disabled).toBe(true);
    expect(popup()!.textContent).toContain("Pick a date and a time.");
  });
});

describe("DateTimeField date-time: Sydney daylight saving", () => {
  it("asks Earlier or Later only for a repeated time, names each offset and blocks Apply until chosen", async () => {
    const onApply = await mount({ value: null, offsets: null });
    await open();
    await pickPopupDateTime(popup()!, "2026-04-05T02:30");
    const group = popup()!.querySelector('[role="group"][aria-label="Which Sydney time"]')!;
    expect(group).not.toBeNull();
    const choices = [...group.querySelectorAll("button")].map((button) => button.textContent);
    expect(choices).toEqual(["Earlier (UTC+11:00)", "Later (UTC+10:00)"]);
    expect([...group.querySelectorAll("button")].every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(applyButton().disabled).toBe(true);
    await pressInPopup(popup()!, "Later (UTC+10:00)");
    expect(applyButton().disabled).toBe(false);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2026-04-05T02:30", disambiguation: "later" });
  });

  it("seeds the choice from the stored fold while the civil minute is unchanged", async () => {
    const onApply = await mount({ value: stored("2026-04-05T02:30", 1), offsets: null });
    await open();
    const group = popup()!.querySelector('[role="group"][aria-label="Which Sydney time"]')!;
    expect(group.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Later (UTC+10:00)");
    await click(slot("03:00")!);
    expect(popup()!.querySelector('[role="group"][aria-label="Which Sydney time"]')).toBeNull();
    // Back on the stored minute the stored fold is gone: it reset when the minute changed.
    await click(slot("02:30")!);
    expect(popup()!.querySelector('[role="group"][aria-label="Which Sydney time"] button[aria-pressed="true"]')).toBeNull();
    expect(applyButton().disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("applies the stored fold untouched on a reminder-free reapply of the same minute", async () => {
    const onApply = await mount({ value: stored("2026-04-05T02:30", 1), offsets: null });
    await open();
    await click(slot("02:45")!);
    await click(slot("02:30")!);
    await pressInPopup(popup()!, "Earlier (UTC+11:00)");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2026-04-05T02:30", disambiguation: "earlier" });
  });

  it("keeps a gap time selected, says it does not exist, disables its slots and blocks Apply", async () => {
    const onApply = await mount({ value: null, offsets: null });
    await open();
    await pickPopupDateTime(popup()!, "2026-10-04T02:30");
    expect(popupDraft(popup()!)).toEqual({ day: "2026-10-04", time: "02:30" });
    expect(popup()!.querySelector('[role="alert"]')?.textContent).toContain("does not exist");
    expect(slot("02:30")!.disabled).toBe(true);
    expect(slot("02:00")!.disabled).toBe(true);
    expect(slot("03:00")!.disabled).toBe(false);
    expect(slot("01:45")!.disabled).toBe(false);
    expect(applyButton().disabled).toBe(true);
    await click(applyButton());
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("DateTimeField date-time: reminders", () => {
  it("shows the stored offsets, the (n/8) count and an always-on Due now", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: [1440, 60] });
    await open();
    expect(popup()!.textContent).toContain("(2/8)");
    expect(chip("1 day")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("false");
    expect(chip("1 hour")!.getAttribute("aria-pressed")).toBe("true");
    const dueNow = chip("Due now")!;
    expect(dueNow.getAttribute("aria-pressed")).toBe("true");
    expect(dueNow.disabled).toBe(true);
    await click(dueNow);
    expect(chip("Due now")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("omits the strip when the field has no reminders", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: null });
    await open();
    expect(popup()!.textContent).not.toContain("Advance reminders");
  });

  it("applies a reminder-only change with the stored time", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: [1440] });
    await open();
    await click(chip("4 hours")!);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T09:00", reminderOffsetsMinutes: [1440, 240] });
  });

  it("adds a custom offset as a pressed chip, keeps offsets unique and descending, and removes it by pressing it", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: [60] });
    await open();
    await click(chip("+ custom")!);
    expect(popup()!.querySelector<HTMLInputElement>('input[type="number"]')!.labels?.[0]?.textContent).toBe("Custom reminder minutes");
    const setValue = async (text: string) => act(async () => { const input = popup()!.querySelector<HTMLInputElement>('input[type="number"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    await setValue("90");
    await click(popupButton(popup()!, "Add")!);
    expect(chip("90 minutes")?.getAttribute("aria-pressed")).toBe("true");
    expect(popup()!.textContent).toContain("(2/8)");
    expect(document.activeElement).toBe(chip("+ custom"));
    await click(chip("90 minutes")!);
    expect(chip("90 minutes")).toBeUndefined();
    expect(document.activeElement).toBe(chip("+ custom"));
    await click(chip("+ custom")!);
    await setValue("90");
    await click(popupButton(popup()!, "Add")!);
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-01-15T09:00", reminderOffsetsMinutes: [90, 60] });
  });

  it.each([["0"], ["43201"], ["1.5"], ["60"], [""]])("will not add custom minutes %j", async (typed) => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: [60] });
    await open();
    await click(chip("+ custom")!);
    const input = popup()!.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, typed); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    expect(popupButton(popup()!, "Add")!.disabled).toBe(true);
  });

  it("stops at eight advance reminders", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: [1440, 240, 60, 50, 40, 30, 20, 10] });
    await open();
    expect(popup()!.textContent).toContain("(8/8)");
    expect(chip("+ custom")!.disabled).toBe(true);
  });

  it("states the stored next reminder and never a prediction", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: [1440], next: { kind: "advance", offsetMinutes: 1440, firesAt: "2027-01-13T22:00:00.000Z" } });
    await open();
    expect(popup()!.textContent).toContain("Currently saved: next reminder");
    expect(popup()!.textContent).toContain("1 day · Thu 14 Jan · 09:00");
    await click(chip("4 hours")!);
    expect(popup()!.textContent).toContain("1 day ·");
    expect(popup()!.textContent).not.toContain("4 hours ·");
  });

  it("says None, or No pending reminders, when there is no next reminder", async () => {
    await mount({ value: stored("2027-01-15T09:00"), offsets: [], next: null });
    await open();
    expect(popup()!.textContent).toContain("None");
  });
});

describe("DateTimeField date-time: clear, cancel and rejection", () => {
  it("No date clears, bypassing time validation", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00"), offsets: [1440] });
    await open();
    await typePopupTime(popup()!, "24:00");
    await pressInPopup(popup()!, "No date");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: null });
  });

  it("offers no No date unless clearable", async () => {
    await mount({ value: stored("2027-01-15T09:00"), clearable: false });
    await open();
    expect(popupButton(popup()!, "No date")).toBeUndefined();
  });

  it("Apply with nothing changed closes without calling onApply", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00") });
    await open();
    await applyPopup(popup()!);
    expect(onApply).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("Cancel, Escape and an outside press discard the draft and return focus to the trigger", async () => {
    const onApply = await mount({ value: stored("2027-01-15T09:00") });
    await open();
    await click(slot("14:30")!);
    await pressInPopup(popup()!, "Cancel");
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await open();
    expect(slot("09:00")!.getAttribute("aria-pressed")).toBe("true");
    await click(slot("14:30")!);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await settle();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await open();
    await click(slot("14:30")!);
    await pressOutside();
    expect(popup()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("stays open with the same draft when onApply rejects, and closes when the retry succeeds", async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce(undefined);
    await mount({ value: stored("2027-01-15T09:00"), offsets: [1440], onApply });
    await open();
    await click(slot("14:30")!);
    await click(chip("4 hours")!);
    await applyPopup(popup()!);
    expect(popup()).not.toBeNull();
    expect(slot("14:30")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("true");
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({ localCivil: "2027-01-15T14:30", reminderOffsetsMinutes: [1440, 240] });
    expect(popup()).toBeNull();
  });

  it("does not close a reopened popup when a save that outlived its popup finally resolves", async () => {
    let finish: () => void = () => {};
    const onApply = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mount({ value: stored("2027-01-15T09:00"), onApply });
    await open();
    await click(slot("14:30")!);
    await act(async () => { popupButton(popup()!, "Apply")!.click(); await Promise.resolve(); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await settle();
    expect(popup()).toBeNull();
    await open();
    expect(popup()).not.toBeNull();
    await act(async () => { finish(); await Promise.resolve(); });
    await settle();
    expect(popup()).not.toBeNull();
  });
});

describe("DateTimeField date-time: seeding a draft", () => {
  it("starts from the seed, already dirty, and restarts when seedKey changes", async () => {
    const onApply = vi.fn();
    await mount({ value: stored("2027-01-15T09:00"), offsets: [1440], onApply, seed: { localCivil: "2027-02-20T10:00", reminderOffsetsMinutes: [240] }, seedKey: 1 });
    await open();
    expect(popupDraft(popup()!)).toEqual({ day: "2027-02-20", time: "10:00" });
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("1 day")!.getAttribute("aria-pressed")).toBe("false");
    await click(slot("11:00")!);
    await act(async () => { root.render(element({ value: stored("2027-01-15T09:00"), offsets: [1440], onApply, seed: { localCivil: "2027-03-03T08:00", reminderOffsetsMinutes: [60] }, seedKey: 2 })); await Promise.resolve(); });
    await settle();
    expect(popupDraft(popup()!)).toEqual({ day: "2027-03-03", time: "08:00" });
    await applyPopup(popup()!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2027-03-03T08:00", reminderOffsetsMinutes: [60] });
  });

  it("does not reseed an open draft when the stored value changes under it", async () => {
    const onApply = vi.fn();
    await mount({ value: stored("2027-01-15T09:00"), onApply });
    await open();
    await click(slot("14:30")!);
    await act(async () => { root.render(element({ value: stored("2027-02-20T10:00"), onApply })); await Promise.resolve(); });
    await settle();
    expect(slot("14:30")!.getAttribute("aria-pressed")).toBe("true");
  });
  it("gives the time grid a short h-36 window below sm and centres the selected slot in it (#447)", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this instanceof HTMLButtonElement && this.closest('[role="group"]') ? slotButtons().indexOf(this) * 30 : 0;
      return { top, bottom: top + 30, left: 0, right: 0, width: 0, height: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(144);
    const offset = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
    try {
      await mount({ value: stored("2027-01-15T17:00") });
      await open();
      const group = popup()!.querySelector('[role="group"][aria-label="Time slots"]')!;
      const viewport = group.parentElement!;
      expect(viewport.parentElement!.classList.contains("h-36")).toBe(true);
      expect(viewport.parentElement!.classList.contains("sm:h-72")).toBe(true);
      // Below sm the grid's own scrollbar is hidden and its edges fade like the body's (#447).
      const rootClass = viewport.parentElement!.className;
      expect(rootClass).toContain("max-sm:*:data-[slot=scroll-area-scrollbar]:hidden");
      expect(rootClass).toContain("max-sm:*:data-[slot=scroll-area-viewport]:mask-t-from-");
      expect(rootClass).toContain("max-sm:*:data-[slot=scroll-area-viewport]:mask-b-from-");
      // 17:00 is slot 68: top 2040, centred in 144px => 2040 - 72 + 15.
      expect(viewport.scrollTop).toBe(1983);
    } finally { rect.mockRestore(); client.mockRestore(); offset.mockRestore(); }
  });

  it("re-centres the selected slot when the time grid is resized, with the selection unchanged (#447)", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this instanceof HTMLButtonElement && this.closest('[role="group"]') ? slotButtons().indexOf(this) * 30 : 0;
      return { top, bottom: top + 30, left: 0, right: 0, width: 0, height: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    let height = 144;
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    const offset = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
    const callbacks: Array<() => void> = [];
    const disconnected = vi.fn();
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      // Floating UI observes the popup too; only the slot viewport's callback is ours.
      observe(el: Element) { if (el.querySelector(':scope > [role="group"][aria-label="Time slots"]')) callbacks.push(this.cb); }
      unobserve() {}
      disconnect() { disconnected(); }
    } as unknown as typeof ResizeObserver;
    try {
      await mount({ value: stored("2027-01-15T17:00") });
      await open();
      const viewport = popup()!.querySelector('[role="group"][aria-label="Time slots"]')!.parentElement!;
      expect(viewport.scrollTop).toBe(1983);
      // Crossing the sm breakpoint changes the window (144px grid -> 288px column) and the layout.
      viewport.scrollTop = 0;
      height = 288;
      await act(async () => { callbacks.forEach((cb) => (cb as (...a: unknown[]) => void)([], undefined)); });
      expect(viewport.scrollTop).toBe(2040 - 144 + 15);
      await act(async () => { root.unmount(); await Promise.resolve(); });
      expect(disconnected).toHaveBeenCalled();
      root = createRoot(host);
    } finally { globalThis.ResizeObserver = original; rect.mockRestore(); client.mockRestore(); offset.mockRestore(); }
  });

  it("keeps the eyebrow to one truncated line while the popup name stays the full label (#447)", async () => {
    await mount({ value: stored("2027-01-15T09:00") });
    await open();
    const dialog = popup()!;
    expect(dialog.getAttribute("aria-label")).toBe("Deadline");
    const eyebrow = [...dialog.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "Deadline")!;
    expect(eyebrow.classList.contains("truncate")).toBe(true);
    expect(eyebrow.getAttribute("title")).toBe("Deadline");
  });

  it("asks whether the viewport is narrow to decide how the popup is positioned (#447)", async () => {
    // collisionAvoidance is a Positioner prop with no DOM trace; the geometry is left to the browser pass.
    const queries: string[] = [];
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => { queries.push(query); return { matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }; }) as unknown as typeof window.matchMedia;
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      expect(queries).toContain("(width < 40rem)");
    } finally { window.matchMedia = original; }
  });

  it("focuses the selected day without scrolling the popup body, so the month navigation stays in view (#528)", async () => {
    const calls: Array<{ el: Element; options: FocusOptions | undefined }> = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) { calls.push({ el: this, options }); return original.call(this, options); };
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
    } finally { HTMLElement.prototype.focus = original; }
    const selected = popup()!.querySelector<HTMLElement>('[aria-selected="true"] button')!;
    expect(document.activeElement).toBe(selected);
    const focusing = calls.filter((call) => call.el === selected);
    expect(focusing.length).toBeGreaterThan(0);
    expect(focusing.every((call) => call.options?.preventScroll === true)).toBe(true);
  });

  it("scrolls the field's row into view before the popup reads its padding, and pins the popup top to the trigger (#537)", async () => {
    const order: string[] = [];
    const scroll = vi.fn(function (this: Element) { order.push("scroll"); });
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll as unknown as typeof Element.prototype.scrollIntoView;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = this.id === "deadline" ? 180 : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    });
    const padding = vi.fn(() => { order.push("padding"); return { top: 66, right: 16, bottom: 16, left: 16 }; });
    try {
      await act(async () => { root.render(<DateTimeField variant="date-time" id="deadline" label="Deadline" value={null} popupCollisionPadding={padding} popupPinTopToField onApply={vi.fn()} />); await Promise.resolve(); });
      await open();
      expect(order).toEqual(["padding", "scroll"]);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.instances[0]).toBe(trigger().parentElement);
      expect(scroll).toHaveBeenCalledWith({ block: "start", inline: "nearest", behavior: "instant" });
    } finally { Element.prototype.scrollIntoView = originalScroll; rect.mockRestore(); }
  });

  it("does not scroll the page on open unless asked to pin to the field (#537)", async () => {
    const scroll = vi.fn();
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll as unknown as typeof Element.prototype.scrollIntoView;
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      expect(scroll).not.toHaveBeenCalled();
    } finally { Element.prototype.scrollIntoView = originalScroll; }
  });

  it("opens with a selected day that sits in the body's bottom fade scrolled clear of it (#537)", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      let box = { top: 0, bottom: 0, height: 0 };
      if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: 100, bottom: 500, height: 400 };
      else if ((this as HTMLElement).style?.height === "var(--fade-size)") box = { top: 0, bottom: 32, height: 32 };
      else if (this.closest('[aria-selected="true"]') && this.tagName === "BUTTON") { const top = 454 - (this.closest('[data-slot="scroll-area-viewport"]') as HTMLElement).scrollTop; box = { top, bottom: top + 36, height: 36 }; } // follows scrollTop: the opening focus re-solves from where the body is
      return { ...box, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      const viewport = popup()!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      // Band is 468..500 and the day ends at 490: the least scroll that clears it is 22.
      expect(viewport.scrollTop).toBe(22);
    } finally { rect.mockRestore(); scrollHeight.mockRestore(); clientHeight.mockRestore(); }
  });

  it("clears a day picked inside the bottom fade, though nothing resized and the body was already scrolled (#537)", async () => {
    // The day buttons' rects follow a mutable "top", so picking one moves the selection to a new place.
    const tops = new Map<string, number>([["2027-01-15", 200], ["2027-01-20", 454]]);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      let box = { top: 0, bottom: 0, height: 0 };
      const day = this.tagName === "BUTTON" ? this.closest<HTMLElement>('[aria-selected="true"]')?.getAttribute("data-day") : null;
      if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: 100, bottom: 500, height: 400 };
      else if (this.style?.height === "var(--fade-size)") box = { top: 0, bottom: 32, height: 32 };
      else if (day && tops.has(day)) { const top = tops.get(day)! - (this.closest('[data-slot="scroll-area-viewport"]') as HTMLElement).scrollTop; box = { top, bottom: top + 36, height: 36 }; }
      return { ...box, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      const viewport = popup()!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      expect(viewport.scrollTop).toBe(0); // the stored day is clear of the fade
      await pickPopupDay(popup()!, "2027-01-20");
      expect(viewport.scrollTop).toBe(22); // 454 + 36 = 490, over a band of 468..500
    } finally { rect.mockRestore(); scrollHeight.mockRestore(); clientHeight.mockRestore(); }
  });

  it("clears a day picked under the TOP fade after the person scrolled the body themselves (#537)", async () => {
    // Doc positions: the stored day is mid-body, the picked one 10px under the top edge once scrolled to 100.
    const docTop = new Map<string, number>([["2027-01-15", 300], ["2027-01-20", 110]]);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      let box = { top: 0, bottom: 0, height: 0 };
      const viewport = this.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const day = this.tagName === "BUTTON" ? this.closest<HTMLElement>('[aria-selected="true"]')?.getAttribute("data-day") : null;
      if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: 100, bottom: 500, height: 400 };
      else if (this.style?.height === "var(--fade-size)") box = { top: 0, bottom: 32, height: 32 };
      else if (day && viewport && docTop.has(day)) { const top = 100 + docTop.get(day)! - viewport.scrollTop; box = { top, bottom: top + 36, height: 36 }; }
      return { ...box, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      const viewport = popup()!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      expect(viewport.scrollTop).toBe(0);
      viewport.scrollTop = 100; // the person scrolls
      await pickPopupDay(popup()!, "2027-01-20");
      // Top band is 32 at scrollTop 100; the day sits 10px below the top, so 22 up.
      expect(viewport.scrollTop).toBe(78);
    } finally { rect.mockRestore(); scrollHeight.mockRestore(); clientHeight.mockRestore(); }
  });

  it("never auto-scrolls on resize once the person has scrolled, even after a selection (#537)", async () => {
    const docTop = new Map<string, number>([["2027-01-15", 150], ["2027-01-20", 200]]);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      let box = { top: 0, bottom: 0, height: 0 };
      const viewport = this.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const day = this.tagName === "BUTTON" ? this.closest<HTMLElement>('[aria-selected="true"]')?.getAttribute("data-day") : null;
      if (this.getAttribute("data-slot") === "scroll-area-viewport") box = { top: 100, bottom: 500, height: 400 };
      else if (this.style?.height === "var(--fade-size)") box = { top: 0, bottom: 32, height: 32 };
      else if (day && viewport && docTop.has(day)) { const top = 100 + docTop.get(day)! - viewport.scrollTop; box = { top, bottom: top + 36, height: 36 }; }
      return { ...box, left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON() {} } as DOMRect;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    const callbacks: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(el: Element) { if (el.getAttribute("data-slot") === "scroll-area-viewport" && !el.querySelector(':scope > [role="group"][aria-label="Time slots"]')) callbacks.push(this.cb); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await mount({ value: stored("2027-01-15T09:00") });
      await open();
      const viewport = popup()!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      viewport.scrollTop = 100; // the person scrolls
      await pickPopupDay(popup()!, "2027-01-20"); // visible and clear: a selection nudge that changes nothing
      expect(viewport.scrollTop).toBe(100);
      await act(async () => { callbacks.forEach((cb) => cb()); });
      expect(callbacks.length).toBeGreaterThan(0);
      expect(viewport.scrollTop).toBe(100); // not reset to 0
    } finally { globalThis.ResizeObserver = original; rect.mockRestore(); scrollHeight.mockRestore(); clientHeight.mockRestore(); }
  });

  it("reads a collision-padding callback on each open, not at mount, so a late shell header counts (#528)", async () => {
    // Stands in for the shell header's bottom edge (`shellChromeBottom`, tested on its own): 0 until the header renders.
    let headerBottom = 0;
    const padding = vi.fn(() => ({ top: headerBottom + 16 }));
    await act(async () => { root.render(<DateTimeField variant="date-time" id="deadline" label="Deadline" value={null} popupCollisionPadding={padding} onApply={vi.fn()} />); await Promise.resolve(); });
    // Cold mount: no shell header yet, and the closed field must not have asked.
    expect(padding).not.toHaveBeenCalled();
    headerBottom = 50;
    await open();
    expect(padding).toHaveBeenCalledTimes(1);
    expect(padding).toHaveReturnedWith({ top: 66 });
    await click(popupButton(popup()!, "Cancel")!);
    expect(popup()).toBeNull();
    headerBottom = 92; // impersonation banner appears
    await open();
    expect(padding).toHaveBeenCalledTimes(2);
    expect(padding).toHaveLastReturnedWith({ top: 108 });
  });
});
