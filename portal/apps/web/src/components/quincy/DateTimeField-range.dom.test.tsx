import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeRangeApply, type DateTimeRangePopupProps } from "./DateTimeField";
import { applyPopup, dateTimePopup, pickPopupDay, pickRangeEnd, popupButton, pressInPopup, rangeToggles, typePopupTime } from "@/testing/date-time-popup";

/**
 * Seam E (#423): the range form of the date/time field, through roles, names and aria state only.
 * "Now" is pinned with fake `Date` only: Thu 1 Oct 2026, 13:00 in Sydney.
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

type Value = DateTimeRangePopupProps["value"];
const range = (start: string, end: string, startFold: 0 | 1 = 0, endFold: 0 | 1 = 0): NonNullable<Value> => ({ start: { localCivil: start, fold: startFold }, end: { localCivil: end, fold: endFold } });

async function mount(props: { value?: Value; projectDefault?: Value; onApply?: (next: DateTimeRangeApply) => void | Promise<void> } = {}) {
  const onApply = props.onApply ?? vi.fn();
  await act(async () => {
    root.render(<DateTimeField variant="range" id="subtask" label="Schedule" value={props.value ?? null} projectDefault={props.projectDefault ?? null} onApply={onApply} />);
    await Promise.resolve();
  });
  return onApply as ReturnType<typeof vi.fn>;
}

const trigger = () => host.querySelector<HTMLButtonElement>("button#subtask")!;
const popup = () => dateTimePopup("Schedule")!;
const applyButton = () => popupButton(popup(), "Apply")!;

/** The civil days the calendar currently paints as part of the range. */
function highlighted(from: HTMLElement): string[] {
  return [...from.querySelectorAll<HTMLElement>("[data-day]")]
    .filter((cell) => cell.getAttribute("data-selected") === "true" || [...cell.querySelectorAll("[data-selected-single],[data-range-start],[data-range-middle],[data-range-end]")].some((node) => node.getAttribute("data-selected-single") === "true" || node.getAttribute("data-range-start") === "true" || node.getAttribute("data-range-middle") === "true" || node.getAttribute("data-range-end") === "true"))
    .map((cell) => cell.getAttribute("data-day")!);
}

async function open() {
  await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
}

describe("DateTimeField range trigger and popup", () => {
  it("shows the stored range, both ends in 24-hour time", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    expect(trigger().textContent).toContain("Tue 3 Nov 09:00 → Sat 7 Nov 17:00");
  });

  it("names a one-day range's day once", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-03T17:00") });
    expect(trigger().textContent).toContain("Tue 3 Nov 09:00 → 17:00");
  });

  it("opens on Start with both ends shown on the toggle", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    await open();
    expect(rangeToggles(popup())).toMatchObject({ active: "Start", start: "3/11 09:00", end: "7/11 17:00" });
  });

  it("applies Next week as Monday 09:00 to Sunday 17:00", async () => {
    const onApply = await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    await open();
    await pressInPopup(popup(), "Next week");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-10-05T09:00" }, end: { localCivil: "2026-10-11T17:00" } });
  });

  it("shows the Project default shortcut only when there is one", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    await open();
    expect(popupButton(popup(), "Project default")).toBeUndefined();
  });

  it("applies the Project default when pressed", async () => {
    const onApply = await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00"), projectDefault: range("2026-12-01T09:00", "2026-12-04T17:00") });
    await open();
    await pressInPopup(popup(), "Project default");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ start: expect.objectContaining({ localCivil: "2026-12-01T09:00" }), end: expect.objectContaining({ localCivil: "2026-12-04T17:00" }) }));
  });

  it("moves the calendar highlight with the draft after a shortcut and after Start/End edits", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    await open();
    expect(highlighted(popup())).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]);
    await pressInPopup(popup(), "Today");
    expect(rangeToggles(popup())).toMatchObject({ start: "1/10 09:00", end: "1/10 17:00" });
    expect(highlighted(popup())).toEqual(["2026-10-01"]);
    await pickPopupDay(popup(), "2026-10-20");
    await pickPopupDay(popup(), "2026-10-23");
    expect(highlighted(popup())).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    await pickRangeEnd(popup(), "Start");
    await pickPopupDay(popup(), "2026-10-21");
    expect(highlighted(popup())).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    await pickRangeEnd(popup(), "End");
    await pickPopupDay(popup(), "2026-10-22");
    expect(highlighted(popup())).toEqual(["2026-10-21", "2026-10-22"]);
  });

  it("picks the start, hands over to End, and keeps the preset times for a fresh range", async () => {
    const onApply = await mount();
    await open();
    await pickPopupDay(popup(), "2026-10-20");
    expect(rangeToggles(popup()).active).toBe("End");
    await pickPopupDay(popup(), "2026-10-23");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-10-20T09:00" }, end: { localCivil: "2026-10-23T17:00" } });
  });

  it("a day before the start restarts the range there while End is active", async () => {
    await mount();
    await open();
    await pickPopupDay(popup(), "2026-10-20");
    await pickPopupDay(popup(), "2026-10-15");
    expect(rangeToggles(popup())).toMatchObject({ active: "End", start: "15/10 09:00", end: "15/10 17:00" });
  });

  it("types the time of the active end only", async () => {
    const onApply = await mount({ value: range("2026-11-03T09:00", "2026-11-03T17:00") });
    await open();
    await pickRangeEnd(popup(), "End");
    await typePopupTime(popup(), "18:07");
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2026-11-03T09:00" }, end: { localCivil: "2026-11-03T18:07" } });
  });

  it("disables Apply when the start is not before the end, and allows a range under a day", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-03T17:00") });
    await open();
    await typePopupTime(popup(), "17:00");
    expect(applyButton().disabled).toBe(true);
    expect(popup().textContent).toContain("Start must be before end.");
    await typePopupTime(popup(), "16:30");
    expect(applyButton().disabled).toBe(false);
  });

  it("names a daylight-saving gap on the active end and blocks Apply", async () => {
    await mount({ value: range("2026-10-04T09:00", "2026-10-05T17:00") });
    await open();
    await typePopupTime(popup(), "02:30");
    expect(applyButton().disabled).toBe(true);
    expect(popup().textContent).toMatch(/does not exist/i);
  });

  it("asks Earlier or Later for a repeated end and judges the order by instant", async () => {
    const onApply = await mount({ value: range("2027-04-04T01:00", "2027-04-04T05:00") });
    await open();
    await pickRangeEnd(popup(), "End");
    await typePopupTime(popup(), "02:30");
    expect(applyButton().disabled).toBe(true);
    await pressInPopup(popup(), "Later (UTC+10:00)");
    await pickRangeEnd(popup(), "Start");
    await typePopupTime(popup(), "02:45");
    // 02:45 earlier (UTC+11:00) is before 02:30 later (UTC+10:00): fine.
    await pressInPopup(popup(), "Earlier (UTC+11:00)");
    expect(applyButton().disabled).toBe(false);
    await applyPopup(popup());
    expect(onApply).toHaveBeenCalledWith({ start: { localCivil: "2027-04-04T02:45", disambiguation: "earlier" }, end: { localCivil: "2027-04-04T02:30", disambiguation: "later" } });
  });

  it("keeps the popup open on the same draft when Apply is rejected", async () => {
    await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00"), onApply: vi.fn().mockRejectedValue(new Error("nope")) });
    await open();
    await pressInPopup(popup(), "Today");
    await applyPopup(popup());
    expect(dateTimePopup("Schedule")).not.toBeNull();
    expect(rangeToggles(popup()).start).toBe("1/10 09:00");
  });

  it("closes without applying when nothing changed", async () => {
    const onApply = await mount({ value: range("2026-11-03T09:00", "2026-11-07T17:00") });
    await open();
    await applyPopup(popup());
    expect(onApply).not.toHaveBeenCalled();
    expect(dateTimePopup("Schedule")).toBeNull();
  });
});
