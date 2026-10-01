import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField } from "./DateTimeField";
import "@/testing/dom-polyfills";

/**
 * Seam E (#421): the date field + popup, driven through roles, names and aria state only — never a
 * data-slot or a class. "Now" is pinned with fake `Date` only, so Base UI's timers keep running.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") }); // Thu 1 Oct, 13:00 Sydney
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

type Props = { value?: string | null; clearable?: boolean; onApply?: (next: string | null) => void | Promise<void>; now?: string };

async function mount({ value = null, clearable = true, onApply = vi.fn(), now }: Props = {}) {
  if (now) vi.setSystemTime(new Date(now));
  await act(async () => { root.render(<DateTimeField variant="date" id="shoot" label="Shoot date" value={value} clearable={clearable} onApply={onApply} />); await Promise.resolve(); });
  return onApply;
}

const trigger = () => host.querySelector<HTMLButtonElement>("button#shoot")!;
const popup = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Shoot date"]');
const buttons = () => [...(popup()?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
const buttonNamed = (name: string) => buttons().find((button) => button.textContent?.startsWith(name) || button.getAttribute("aria-label") === name);
const dayButton = (ariaLabelPart: string) => buttons().find((button) => button.getAttribute("aria-label")?.includes(ariaLabelPart));
const select = (name: string) => popup()!.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;

async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
}
async function press(name: string) {
  await act(async () => { buttonNamed(name)!.click(); await Promise.resolve(); });
  await settle();
}
async function clickEl(el: Element) {
  await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); });
  await settle();
}
async function setSelect(el: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}
async function pressKey(el: Element, key: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Promise.resolve(); });
  await settle();
}
async function pressOutside() {
  await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
}
const selectedDay = () => buttons().find((button) => button.getAttribute("aria-selected") === "true" || button.closest('[aria-selected="true"]'));
const pressedShortcut = () => buttons().find((button) => button.getAttribute("aria-pressed") === "true")?.textContent ?? null;

describe("DateTimeField trigger", () => {
  it("shows a canonical day formatted, and is named by its label and value", async () => {
    await mount({ value: "2026-09-17" });
    expect(trigger().textContent).toContain("Thu 17 Sep 2026");
    const names = trigger().getAttribute("aria-labelledby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(names.join(" ")).toBe("Shoot date Thu 17 Sep 2026");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the placeholder when empty and unparsed text verbatim", async () => {
    await mount({ value: null });
    expect(trigger().textContent).toContain("Select a date");
    await mount({ value: "Thursday, 17 Sep, 2026" });
    expect(trigger().textContent).toContain("Thursday, 17 Sep, 2026");
  });
});

describe("DateTimeField popup", () => {
  it("opens a named non-modal dialog showing Australia/Sydney, with no time column", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    expect(popup()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(popup()!.textContent).toContain("Australia/Sydney");
    expect(popup()!.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(popup()!.getAttribute("aria-describedby")!)?.textContent).toBe("Australia/Sydney");
    expect(popup()!.querySelector('[role="listbox"]')).toBeNull();
    expect(popup()!.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("highlights the stored day and shows its month", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    expect(select("Month").value).toBe("8");
    expect(select("Year").value).toBe("2026");
    expect(dayButton("17")?.closest("[aria-selected]")?.getAttribute("aria-selected") ?? dayButton("17")?.getAttribute("aria-selected")).toBe("true");
  });

  it("builds Today / Tomorrow / Later this week / Next week / No date for a Thursday", async () => {
    await mount({ value: null });
    await open();
    const labels = buttons().map((button) => button.textContent ?? "");
    expect(labels.some((text) => text.startsWith("Today"))).toBe(true);
    expect(labels.some((text) => text.startsWith("Tomorrow"))).toBe(true);
    expect(labels.some((text) => text.startsWith("Later this week"))).toBe(false); // Thursday: hidden
    expect(labels.some((text) => text.startsWith("Next week"))).toBe(true);
    expect(labels.some((text) => text.startsWith("No date"))).toBe(true);
  });

  it("offers Later this week on a Monday and picks that week's Thursday", async () => {
    const onApply = await mount({ value: null, now: "2026-09-28T02:00:00Z" });
    await open();
    await press("Later this week");
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-10-01");
  });

  it("hides No date unless the field is clearable", async () => {
    await mount({ value: "2026-09-17", clearable: false });
    await open();
    expect(buttonNamed("No date")).toBeUndefined();
  });

  it.each([
    ["Today", "2026-10-01"],
    ["Tomorrow", "2026-10-02"],
    ["Next week", "2026-10-05"],
  ])("%s picks the expected Sydney day on Apply", async (name, expected) => {
    const onApply = await mount({ value: null });
    await open();
    await press(name);
    expect(pressedShortcut()?.startsWith(name)).toBe(true);
    expect(onApply).not.toHaveBeenCalled(); // a shortcut never commits
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith(expected);
    expect(popup()).toBeNull();
  });

  it("uses the Sydney day, not the UTC day, at 13:30Z", async () => {
    const onApply = await mount({ value: null, now: "2026-10-05T13:30:00Z" }); // Tue 6 Oct in Sydney
    await open();
    await press("Today");
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-10-06");
  });

  it("crosses a year boundary on 31 Dec", async () => {
    const onApply = await mount({ value: null, now: "2026-12-31T02:00:00Z" });
    await open();
    await press("Tomorrow");
    expect(select("Year").value).toBe("2027");
    expect(select("Month").value).toBe("0");
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2027-01-01");
  });

  it("makes Next week equal Tomorrow on a Sunday", async () => {
    const onApply = await mount({ value: null, now: "2026-10-04T02:00:00Z" });
    await open();
    await press("Next week");
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-10-05");
  });

  it("No date clears the field", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    await press("No date");
    expect(selectedDay()).toBeUndefined();
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it("clicking a day then Apply commits it; clicking the selected day again does not clear it", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    await clickEl(dayButton("17")!);
    await clickEl(dayButton("17")!);
    expect(dayButton("17")?.closest("[aria-selected]")?.getAttribute("aria-selected") ?? dayButton("17")?.getAttribute("aria-selected")).toBe("true");
    await clickEl(dayButton("22")!);
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-09-22");
  });
});

describe("DateTimeField navigation", () => {
  it("Previous and Next month move the grid", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    await press("Next month");
    expect(select("Month").value).toBe("9");
    await press("Previous month");
    await press("Previous month");
    expect(select("Month").value).toBe("7");
  });

  it("the month and year selects move the grid", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    await setSelect(select("Month"), "1");
    expect(select("Month").value).toBe("1");
    await setSelect(select("Year"), "2027");
    expect(select("Year").value).toBe("2027");
  });

  it("offers the stored value's year even when it is outside today's +-10", async () => {
    await mount({ value: "2005-03-02" });
    await open();
    expect([...select("Year").options].map((option) => option.value)).toContain("2005");
  });

  it("moves day focus with the arrow keys and PageDown, and a focused day commits", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    const day = dayButton("17")!;
    await act(async () => { day.focus(); await Promise.resolve(); });
    await pressKey(day, "ArrowRight");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("18");
    await pressKey(document.activeElement!, "PageDown");
    expect(select("Month").value).toBe("9");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("18");
    // Enter / Space on a native button is a click in a browser; a synthetic keydown is not.
    await clickEl(document.activeElement!);
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-10-18");
  });
});

describe("DateTimeField Apply, Cancel and focus", () => {
  it("Cancel discards the draft and returns focus to the trigger; reopening shows the original", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    await press("Tomorrow");
    await press("Cancel");
    expect(onApply).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await open();
    expect(pressedShortcut()).toBeNull();
    expect(select("Month").value).toBe("8");
  });

  it("Escape discards the draft and returns focus to the trigger", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    await press("Tomorrow");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await settle();
    expect(popup()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("an outside press discards the draft", async () => {
    const onApply = await mount({ value: "2026-09-17" });
    await open();
    await press("Tomorrow");
    await pressOutside();
    expect(popup()).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("Apply returns focus to the trigger", async () => {
    await mount({ value: null });
    await open();
    await press("Today");
    await press("Apply");
    expect(document.activeElement).toBe(trigger());
  });

  it("stays open with the draft when onApply rejects", async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce(undefined);
    await mount({ value: null, onApply });
    await open();
    await press("Tomorrow");
    await press("Apply");
    expect(popup()).not.toBeNull();
    expect(pressedShortcut()?.startsWith("Tomorrow")).toBe(true);
    await press("Apply");
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(popup()).toBeNull();
  });
});

describe("DateTimeField with unparsed text", () => {
  it("Apply without picking closes and does not call onApply", async () => {
    const onApply = await mount({ value: "Thursday, 17 Sep, 2026" });
    await open();
    expect(selectedDay()).toBeUndefined();
    await press("Apply");
    expect(onApply).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
    expect(trigger().textContent).toContain("Thursday, 17 Sep, 2026");
  });

  it("picking a day replaces it with an ISO day", async () => {
    const onApply = await mount({ value: "Thursday, 17 Sep, 2026" });
    await open();
    await press("Tomorrow");
    await press("Apply");
    expect(onApply).toHaveBeenCalledWith("2026-10-02");
  });
});

describe("DateTimeField stateful host", () => {
  it("shows the applied value on the trigger", async () => {
    function Host() {
      const [value, setValue] = useState<string | null>(null);
      return <DateTimeField variant="date" id="shoot" label="Shoot date" value={value} clearable onApply={setValue} />;
    }
    await act(async () => { root.render(<Host />); await Promise.resolve(); });
    await open();
    await press("Tomorrow");
    await press("Apply");
    expect(trigger().textContent).toContain("Fri 2 Oct 2026");
  });
});

describe("DateTimeField focus and header contract (#421 review)", () => {
  it("keeps focus on the Month and Year selects after they change the grid", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    const month = select("Month");
    await act(async () => { month.focus(); await Promise.resolve(); });
    await setSelect(month, "1");
    await settle();
    expect(select("Month").value).toBe("1");
    expect(document.activeElement).toBe(select("Month"));
    const year = select("Year");
    await act(async () => { year.focus(); await Promise.resolve(); });
    await setSelect(year, "2027");
    await settle();
    expect(select("Year").value).toBe("2027");
    expect(document.activeElement).toBe(select("Year"));
  });

  it("opens with focus on the selected day when there is one", async () => {
    await mount({ value: "2026-09-17" });
    await open();
    expect(popup()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toContain("17");
  });

  it("opens with focus on the first shortcut when nothing is selected, without marking it pressed", async () => {
    await mount({ value: null });
    await open();
    expect(document.activeElement?.textContent).toMatch(/^Today/);
    expect(pressedShortcut()).toBeNull();
  });

  it("marks a shortcut pressed only when the selection is that shortcut's day", async () => {
    await mount({ value: "2026-10-01" }); // today
    await open();
    expect(pressedShortcut()?.startsWith("Today")).toBe(true);
    await press("Tomorrow");
    expect(pressedShortcut()?.startsWith("Tomorrow")).toBe(true);
    await clickEl(dayButton("22")!);
    expect(pressedShortcut()).toBeNull();
  });

  it("titles the popup with the field label and keeps Australia/Sydney visible beneath it", async () => {
    await mount({ value: null });
    await open();
    const zone = document.getElementById(popup()!.getAttribute("aria-describedby")!)!;
    expect(zone.textContent).toBe("Australia/Sydney");
    expect(popup()!.textContent?.indexOf("Shoot date")).toBeLessThan(popup()!.textContent!.indexOf("Australia/Sydney"));
  });
});

