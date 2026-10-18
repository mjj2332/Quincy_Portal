import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimePopup } from "./DateTimePopup";

/**
 * #914 M5 (settled decision): the phone Deadline view draws the date and the time as native `<input type="date">` and
 * `<input type="time">` (iOS opens its own pickers, so no keyboard comes up), feeding the same draft as the other layouts: the same
 * reminders, Earlier / Later and Apply rules. Save deadline and Clear are its footer, pinned below the body.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

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

async function mount(props: { onApply?: (next: unknown) => void | Promise<void>; onClose?: () => void; clearable?: boolean; localCivil?: string | null } = {}) {
  const onApply = props.onApply ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const localCivil = props.localCivil === undefined ? "2026-10-15T09:00" : props.localCivil;
  await act(async () => {
    root.render(<DateTimePopup label="Deadline" layout="phone" value={localCivil ? { localCivil } : null} clearable={props.clearable ?? true} reminders={{ offsets: [1440] }} onApply={onApply} onClose={onClose} />);
    await Promise.resolve();
  });
  return { onApply, onClose };
}

const input = (label: string) => [...host.querySelectorAll<HTMLInputElement>("input")].find((element) => element.labels?.[0]?.textContent === label) ?? null;
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === name) ?? null;

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function press(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

describe("DateTimePopup phone layout (#914 M5)", () => {
  it("draws native date and time fields seeded from the stored value, and no calendar, time slots or shortcuts", async () => {
    await mount();
    expect(input("Date")?.type).toBe("date");
    expect(input("Date")?.value).toBe("2026-10-15");
    expect(input("Time")?.type).toBe("time");
    expect(input("Time")?.value).toBe("09:00");
    expect(host.querySelector('[role="grid"]')).toBeNull();
    expect(host.querySelector('[aria-label="Time slots"]')).toBeNull();
    expect(host.querySelector('[role="list"]')).toBeNull();
    // The same reminders strip as every layout.
    expect(host.querySelector('[role="group"][aria-label="Advance reminders"]')).not.toBeNull();
  });

  it("saves the draft with Save deadline: the picked date and time and the reminders", async () => {
    const { onApply, onClose } = await mount();
    expect(button("Cancel")).toBeNull();
    expect(button("Apply")).toBeNull();
    await type(input("Date")!, "2026-10-20");
    await type(input("Time")!, "17:30");
    await press(button("Save deadline")!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2026-10-20T17:30", reminderOffsetsMinutes: [1440] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes 17:00 for a date picked with no time, and Save stays disabled with no date", async () => {
    const { onApply } = await mount({ localCivil: null, clearable: false });
    expect(button("Clear")).toBeNull();
    await type(input("Date")!, "2026-10-20");
    expect(input("Time")!.value).toBe("17:00");
    await type(input("Date")!, "");
    expect(button("Save deadline")!.disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("clears the stored deadline with Clear", async () => {
    const { onApply, onClose } = await mount();
    await press(button("Clear")!);
    expect(onApply).toHaveBeenCalledWith({ localCivil: null });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
