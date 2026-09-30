// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { nearestScrollContainer } from "./scroll-container";

function chain(overflowY: string | null) {
  const outer = document.createElement("div");
  const middle = document.createElement("div");
  const inner = document.createElement("span");
  if (overflowY) middle.style.overflowY = overflowY;
  outer.append(middle); middle.append(inner);
  document.body.append(outer);
  return { outer, middle, inner };
}

afterEach(() => document.body.replaceChildren());

describe("nearestScrollContainer", () => {
  it.each(["auto", "scroll", "overlay"])("finds an ancestor with overflow-y: %s", (value) => {
    const { middle, inner } = chain(value);
    expect(nearestScrollContainer(inner)).toBe(middle);
  });

  it.each(["visible", "hidden", "clip"])("does not treat overflow-y: %s as a scroller", (value) => {
    const { inner } = chain(value);
    expect(nearestScrollContainer(inner)).toBeNull();
  });

  it("returns null when no ancestor scrolls (the window is the scroller)", () => {
    const { inner } = chain(null);
    expect(nearestScrollContainer(inner)).toBeNull();
  });

  it("does not test the element itself, only its ancestors", () => {
    const { inner } = chain(null);
    inner.style.overflowY = "auto";
    expect(nearestScrollContainer(inner)).toBeNull();
  });

  it("stops at body: a scrolling body or html is the window, not a container", () => {
    const { inner } = chain(null);
    document.body.style.overflowY = "auto";
    document.documentElement.style.overflowY = "auto";
    try {
      expect(nearestScrollContainer(inner)).toBeNull();
    } finally {
      document.body.style.overflowY = "";
      document.documentElement.style.overflowY = "";
    }
  });

  it("picks the NEAREST scroller of several", () => {
    const { outer, middle, inner } = chain("auto");
    outer.style.overflowY = "scroll";
    expect(nearestScrollContainer(inner)).toBe(middle);
  });
});
