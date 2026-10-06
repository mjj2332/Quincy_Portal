import { afterEach, describe, expect, it } from "vitest";
import { shellAwarePopupPadding } from "./date-time-field";

/** #597: the popup's top padding is sheet-relative while a Project sheet is open, shell-relative otherwise. */
function shellHeader(bottom: number) {
  const el = document.createElement("header");
  el.className = "shell-header";
  el.getBoundingClientRect = () => ({ bottom, top: 0, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.append(el);
}
/** By default a sheet that fills the viewport horizontally and below `top` (the <=720px shape). */
function sheet(top: number, state: "data-open" | "data-closed" = "data-open", inset: { left: number; right: number; bottom: number } = { left: 0, right: 0, bottom: 0 }) {
  const el = document.createElement("div");
  el.setAttribute("data-slot", "sheet-content");
  el.setAttribute(state, "");
  const rect = { top, left: inset.left, right: window.innerWidth - inset.right, bottom: window.innerHeight - inset.bottom };
  el.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: top, width: rect.right - rect.left, height: rect.bottom - top, toJSON() {} }) as DOMRect;
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
  it("derives all four edges from an inset sheet's rect (#629)", () => {
    shellHeader(50);
    sheet(24, "data-open", { left: 24, right: 24, bottom: 24 });
    expect(shellAwarePopupPadding()).toEqual({ top: 40, right: 40, bottom: 40, left: 40 });
  });
  it("stays 16 on the sides of a sheet that fills the viewport (<=720px)", () => {
    sheet(0);
    expect(shellAwarePopupPadding()).toEqual({ top: 16, right: 16, bottom: 16, left: 16 });
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
