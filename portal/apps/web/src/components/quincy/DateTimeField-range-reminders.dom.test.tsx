import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeRangeApply, type DateTimeRangePopupProps } from "./DateTimeField";
import { applyPopup, dateTimePopup, pickPopupDay, popupButton, pressInPopup, typePopupTime } from "@/testing/date-time-popup";

/**
 * Seam E (#425): the reminders strip in the range variant of the date/time field, the Subtask's own set. Through roles, names
 * and aria state only. "Now" is pinned with fake `Date` only: Thu 1 Oct 2026, 13:00 in Sydney.
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
type Props = { offsets?: number[] | null; next?: Next; onApply?: (next: DateTimeRangeApply) => void | Promise<void>; seed?: DateTimeRangePopupProps["seed"]; seedKey?: number };
const VALUE: NonNullable<DateTimeRangePopupProps["value"]> = { start: { localCivil: "2026-11-03T09:00", fold: 0 }, end: { localCivil: "2026-11-07T17:00", fold: 0 } };

function element(props: Props) {
  const { offsets = [1440], next, onApply = vi.fn(), seed, seedKey } = props;
  return <DateTimeField variant="range" id="subtask" label="Schedule" value={VALUE} projectDefault={null} reminders={offsets === null ? undefined : { offsets, ...(next !== undefined ? { next } : {}) }} seed={seed} seedKey={seedKey} onApply={onApply} />;
}

async function mount(props: Props = {}) {
  const onApply = props.onApply ?? vi.fn();
  await act(async () => { root.render(element({ ...props, onApply })); await Promise.resolve(); });
  return onApply as ReturnType<typeof vi.fn>;
}

const trigger = () => host.querySelector<HTMLButtonElement>("button#subtask")!;
const popup = () => dateTimePopup("Schedule")!;
const chip = (label: string) => [...popup().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
const applyButton = () => popupButton(popup(), "Apply")!;
async function click(el: Element) { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); }
async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
}
const typeCustom = async (text: string) => act(async () => { const input = popup().querySelector<HTMLInputElement>('input[type="number"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });

describe("DateTimeField range: reminders strip", () => {
  it("shows the stored offsets, the (n/8) count and an always-on Due now", async () => {
    await mount({ offsets: [1440, 60] });
    await open();
    expect(popup().textContent).toContain("(2/8)");
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
    await mount({ offsets: null });
    await open();
    expect(popup().textContent).not.toContain("Advance reminders");
  });

  it("a reminders toggle alone enables Apply and hands the offsets back with the unchanged range", async () => {
    const onApply = await mount({ offsets: [1440] });
    await open();
    // Untouched: Apply only closes.
    await click(chip("4 hours")!);
    expect(applyButton().disabled).toBe(false);
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-11-03T09:00" }, end: { localCivil: "2026-11-07T17:00" }, reminderOffsetsMinutes: [1440, 240] });
    expect(dateTimePopup("Schedule")).toBeNull();
  });

  it("toggling a chip on and back off leaves the draft equal to the stored set, and Apply still sends it", async () => {
    const onApply = await mount({ offsets: [1440] });
    await open();
    await click(chip("4 hours")!);
    await click(chip("4 hours")!);
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ reminderOffsetsMinutes: [1440] }));
  });

  it("sends the offsets together with a range change", async () => {
    const onApply = await mount({ offsets: [1440] });
    await open();
    await pressInPopup(popup(), "Today");
    await click(chip("1 day")!);
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-10-01T09:00" }, end: { localCivil: "2026-10-01T17:00" }, reminderOffsetsMinutes: [] });
  });

  it("adds a custom offset as a pressed chip, keeps offsets unique and descending, and removes it by pressing it", async () => {
    const onApply = await mount({ offsets: [60] });
    await open();
    await click(chip("+ custom")!);
    expect(popup().querySelector<HTMLInputElement>('input[type="number"]')!.labels?.[0]?.textContent).toBe("Custom reminder minutes");
    await typeCustom("90");
    await click(popupButton(popup(), "Add")!);
    expect(chip("90 minutes")?.getAttribute("aria-pressed")).toBe("true");
    expect(popup().textContent).toContain("(2/8)");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ reminderOffsetsMinutes: [90, 60] }));
  });

  it.each([["0"], ["43201"], ["1.5"], ["60"], [""]])("will not add custom minutes %j", async (typed) => {
    await mount({ offsets: [60] });
    await open();
    await click(chip("+ custom")!);
    await typeCustom(typed);
    expect(popupButton(popup(), "Add")!.disabled).toBe(true);
  });

  it("stops at eight advance reminders: the ninth cannot be chosen", async () => {
    await mount({ offsets: [1440, 240, 60, 50, 40, 30, 20, 10] });
    await open();
    expect(popup().textContent).toContain("(8/8)");
    expect(chip("+ custom")!.disabled).toBe(true);
    // The unpressed preset chips are disabled at the cap; pressed ones can still be removed.
    expect(chip("1 day")!.disabled).toBe(false);
    await click(chip("1 day")!);
    expect(popup().textContent).toContain("(7/8)");
    expect(chip("+ custom")!.disabled).toBe(false);
  });

  it("states the saved next reminder and never a prediction", async () => {
    await mount({ offsets: [1440], next: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-11-01T22:00:00.000Z" } });
    await open();
    expect(popup().textContent).toContain("Currently saved: next reminder");
    expect(popup().textContent).toContain("1 day · Mon 2 Nov · 09:00");
    await click(chip("4 hours")!);
    expect(popup().textContent).toContain("1 day ·");
    expect(popup().textContent).not.toContain("4 hours ·");
  });

  it("hides the next-reminder line when the caller has no saved schedule to state (a new Subtask)", async () => {
    await mount({ offsets: [1440] });
    await open();
    expect(popup().textContent).not.toContain("next reminder");
  });

  it("says None, or No pending reminders, when there is no next reminder", async () => {
    await mount({ offsets: [], next: null });
    await open();
    expect(popup().textContent).toContain("None");
  });

  it("quietens the saved line once the range departs from the stored one, not only the offsets", async () => {
    await mount({ offsets: [1440], next: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-11-01T22:00:00.000Z" } });
    await open();
    const line = () => [...popup().querySelectorAll<HTMLElement>("span")].find((node) => node.textContent?.startsWith("1 day ·"))!;
    expect(line().className).not.toContain("text-foreground-secondary");
    await pickPopupDay(popup(), "2026-11-09");
    await typePopupTime(popup(), "10:00");
    expect(line().className).toContain("text-foreground-secondary");
  });

  it("Cancel discards the draft offsets without applying", async () => {
    const onApply = await mount({ offsets: [1440] });
    await open();
    await click(chip("4 hours")!);
    await pressInPopup(popup(), "Cancel");
    expect(onApply).not.toHaveBeenCalled();
    await open();
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("starts from a seeded draft (a conflict's reapply): the retained range and the retained offsets", async () => {
    const onApply = await mount({ offsets: [1440], seed: { start: { localCivil: "2026-11-04T09:00" }, end: { localCivil: "2026-11-08T17:00" }, reminderOffsetsMinutes: [240, 60] }, seedKey: 1 });
    await open();
    expect(chip("1 day")!.getAttribute("aria-pressed")).toBe("false");
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("1 hour")!.getAttribute("aria-pressed")).toBe("true");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-11-04T09:00" }, end: { localCivil: "2026-11-08T17:00" }, reminderOffsetsMinutes: [240, 60] });
  });

  it("a seed with no offsets keeps the stored ones, so an old retained draft is never wiped", async () => {
    const onApply = await mount({ offsets: [1440, 60], seed: { start: { localCivil: "2026-11-04T09:00" }, end: { localCivil: "2026-11-08T17:00" } }, seedKey: 1 });
    await open();
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ reminderOffsetsMinutes: [1440, 60] }));
  });

  it("never sends offsets when the field has no reminders (the Project default composer without one stays range-only)", async () => {
    const onApply = await mount({ offsets: null });
    await open();
    await pressInPopup(popup(), "Today");
    await applyPopup(popup());
    expect(onApply.mock.calls[0]![0]).not.toHaveProperty("reminderOffsetsMinutes");
  });
});
