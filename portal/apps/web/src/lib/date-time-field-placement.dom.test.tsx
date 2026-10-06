import { afterEach, describe, expect, it } from "vitest";
import { shellAwarePopupPadding } from "./date-time-field";

/** #597: the popup's top padding is sheet-relative while a Project sheet is open, shell-relative otherwise. */
function rectAt(el: HTMLElement, top: number) {
  el.getBoundingClientRect = () => ({ bottom: top + 40, top, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON() {} }) as DOMRect;
}
function shellHeader(bottom: number) {
  const el = document.createElement("header");
  el.className = "shell-header";
  el.getBoundingClientRect = () => ({ bottom, top: 0, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.append(el);
}
function sheet(top: number, state: "data-open" | "data-closed" = "data-open") {
  const el = document.createElement("div");
  el.setAttribute("data-slot", "sheet-content");
  el.setAttribute(state, "");
  rectAt(el, top);
  document.body.append(el);
  return el;
}

afterEach(() => document.body.replaceChildren());

describe("shellAwarePopupPadding with a Project sheet (#597)", () => {
  it("is the shell header's bottom plus the gap with no sheet open", () => {
    shellHeader(50);
    expect(shellAwarePopupPadding()).toEqual({ top: 66, right: 16, bottom: 16, left: 16 });
  });
  it("is the open sheet's top plus the gap, instead of the header", () => {
    shellHeader(50);
    sheet(24);
    expect(shellAwarePopupPadding()).toEqual({ top: 40, right: 16, bottom: 16, left: 16 });
  });
  it("takes the last (topmost) open sheet", () => {
    sheet(10);
    sheet(30);
    expect(shellAwarePopupPadding().top).toBe(46);
  });
  it("ignores a sheet that is closing or closed", () => {
    shellHeader(50);
    sheet(24, "data-closed");
    expect(shellAwarePopupPadding().top).toBe(66);
  });
});
