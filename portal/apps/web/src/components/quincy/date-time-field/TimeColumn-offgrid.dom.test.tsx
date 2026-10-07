// B4 (#656 browser pass): an off-grid stored time (17:07) must leave the 17:15 slot as the only Tab stop, with no slot pressed,
// through the real single and range popups.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField } from "../DateTimeField";
import { dateTimePopup } from "@/testing/date-time-popup";

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

async function open() {
  await act(async () => { host.querySelector<HTMLButtonElement>("button#f")!.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
const slots = () => [...dateTimePopup("Schedule")!.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Time slots"] button')];

describe("an off-grid stored time keeps the next slot as the one Tab stop", () => {
  it("single popup", async () => {
    await act(async () => { root.render(<DateTimeField variant="date-time" id="f" label="Schedule" value={{ localCivil: "2026-10-05T17:07" }} clearable={false} onApply={() => {}} />); await Promise.resolve(); });
    await open();
    expect(slots().filter((b) => b.tabIndex === 0).map((b) => b.textContent?.trim())).toEqual(["17:15"]);
    expect(slots().filter((b) => b.getAttribute("aria-pressed") === "true")).toEqual([]);
  });
  it("range popup", async () => {
    const value = { start: { localCivil: "2026-10-05T17:07", fold: 0 as const }, end: { localCivil: "2026-10-06T18:00", fold: 0 as const } };
    await act(async () => { root.render(<DateTimeField variant="range" id="f" label="Schedule" value={value} projectDefault={null} onApply={() => {}} />); await Promise.resolve(); });
    await open();
    expect(slots().filter((b) => b.tabIndex === 0).map((b) => b.textContent?.trim())).toEqual(["17:15"]);
    expect(slots().filter((b) => b.getAttribute("aria-pressed") === "true")).toEqual([]);
  });
});
