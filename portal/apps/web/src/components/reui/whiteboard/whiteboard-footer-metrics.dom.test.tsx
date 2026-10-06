/**
 * #564: the footer's measured height was written into `--wb-control-size`, which the footer's own controls
 * read, so a phone-width 44px stuck after the window widened. The hook may measure the footer's width only;
 * the control size follows the board's phone layout in CSS (`data-phone-layout`, set from `isPhoneLayout`).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFooterMetrics } from "./whiteboard-footer-metrics";
import { WHITEBOARD_THEME } from "./whiteboard-theme";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
let observers: Array<() => void> = [];

beforeEach(() => {
  observers = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) { observers.push(cb); }
    observe() {}
    disconnect() {}
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root!.unmount(); }); host.remove(); root = null; });

function Probe({ board, footer }: { board: HTMLElement; footer: HTMLElement }) {
  useFooterMetrics({ current: board }, footer);
  return null;
}

const sized = (width: number, height: number) => {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
  return el;
};

describe("footer metrics (#564)", () => {
  it("1280 -> 390 -> 1280: never writes --wb-control-size, so the desktop size returns", async () => {
    const board = document.createElement("div");
    const footer = sized(300, 32);
    await act(async () => { root!.render(<Probe board={board} footer={footer} />); });
    expect(board.style.getPropertyValue("--wb-footer-width")).toBe("300px");
    expect(board.style.getPropertyValue("--wb-control-size")).toBe("");

    // Phone width: the footer's controls are 44px tall.
    Object.defineProperty(footer, "offsetWidth", { value: 160, configurable: true });
    Object.defineProperty(footer, "offsetHeight", { value: 44, configurable: true });
    await act(async () => { observers.forEach((cb) => cb()); });
    expect(board.style.getPropertyValue("--wb-footer-width")).toBe("160px");
    expect(board.style.getPropertyValue("--wb-control-size")).toBe("");

    // Widened again: nothing left behind to hold 44px.
    Object.defineProperty(footer, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(footer, "offsetHeight", { value: 32, configurable: true });
    await act(async () => { observers.forEach((cb) => cb()); });
    expect(board.style.getPropertyValue("--wb-footer-width")).toBe("300px");
    expect(board.style.getPropertyValue("--wb-control-size")).toBe("");
  });

  it("the size comes from the phone-layout attribute, not a viewport query", () => {
    expect(WHITEBOARD_THEME).toContain("data-[phone-layout]:[--wb-control-size:44px]");
    expect(WHITEBOARD_THEME).not.toContain("721px]:[--wb-control-size");
    expect(WHITEBOARD_THEME).not.toMatch(/(^|\s)\[--wb-control-size:/);
  });
});
