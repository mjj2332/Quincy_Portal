import { describe, expect, it } from "vitest"
import { findScroller, scrollerGeometry, trackGeometry, treeInset } from "./gantt-track-geometry"

function fakeScroller(init: {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
  direction?: "ltr" | "rtl"
}) {
  const el = document.createElement("div")
  el.style.direction = init.direction ?? "ltr"
  Object.defineProperty(el, "scrollLeft", { value: init.scrollLeft, configurable: true })
  Object.defineProperty(el, "clientWidth", { value: init.clientWidth, configurable: true })
  Object.defineProperty(el, "scrollWidth", { value: init.scrollWidth, configurable: true })
  return el
}

describe("trackGeometry", () => {
  it("LTR: start is scrollLeft, widths are the raw client/scroll widths at inset 0", () => {
    const g = trackGeometry(fakeScroller({ scrollLeft: 120, clientWidth: 800, scrollWidth: 3000 }))
    expect(g).toEqual({ start: 120, visibleWidth: 800, trackWidth: 3000 })
  })

  it("RTL: a negative scrollLeft reports a positive distance from the inline-start edge", () => {
    const g = trackGeometry(
      fakeScroller({ scrollLeft: -450, clientWidth: 800, scrollWidth: 3000, direction: "rtl" })
    )
    expect(g.start).toBe(450)
    expect(g.visibleWidth).toBe(800)
    expect(g.trackWidth).toBe(3000)
  })

  it("keeps fractional widths and positions exact", () => {
    const g = trackGeometry(
      fakeScroller({ scrollLeft: 10.5, clientWidth: 799.25, scrollWidth: 2999.75 })
    )
    expect(g).toEqual({ start: 10.5, visibleWidth: 799.25, trackWidth: 2999.75 })
  })

  it("subtracts a tree inset from the widths but never from start", () => {
    const g = trackGeometry(
      fakeScroller({ scrollLeft: 100, clientWidth: 1000.5, scrollWidth: 4000.5 }),
      396
    )
    expect(g).toEqual({ start: 100, visibleWidth: 604.5, trackWidth: 3604.5 })
  })
})

describe("findScroller", () => {
  it("finds the [data-gantt-scroller] element under a root, or null", () => {
    const root = document.createElement("div")
    expect(findScroller(root)).toBeNull()
    expect(findScroller(null)).toBeNull()
    const s = document.createElement("div")
    s.setAttribute("data-gantt-scroller", "")
    root.append(s)
    expect(findScroller(root)).toBe(s)
  })
})

describe("scrollerGeometry (#727)", () => {
  it("uses --gantt-tree-inset (the width the sticky tree column is given) as the inset", () => {
    const scroller = fakeScroller({ scrollLeft: 100, clientWidth: 1000.5, scrollWidth: 4000.5 });
    // the inset is the number that sizes the column (inherited from the Gantt body), not its rect
    const body = document.createElement("div");
    body.style.setProperty("--gantt-tree-inset", "396.25px");
    body.append(scroller);
    document.body.append(body);
    expect(treeInset(scroller)).toBe(396.25);
    expect(scrollerGeometry(scroller)).toEqual({ start: 100, visibleWidth: 604.25, trackWidth: 3604.25 });
    body.remove();
  });

  it("is the plain geometry (inset 0) when there is no tree column or the variable is unset", () => {
    const scroller = fakeScroller({ scrollLeft: -450, clientWidth: 800, scrollWidth: 3000, direction: "rtl" });
    expect(treeInset(scroller)).toBe(0);
    expect(scrollerGeometry(scroller)).toEqual({ start: 450, visibleWidth: 800, trackWidth: 3000 });
  });
});
