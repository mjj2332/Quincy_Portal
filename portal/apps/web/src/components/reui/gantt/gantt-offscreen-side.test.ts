import { describe, expect, it } from "vitest"
import { offscreenSide } from "./gantt-track-geometry"

const row = (startPx: number, endPx: number, leadPx = 0, trailPx = 0) => ({ startPx, endPx, leadPx, trailPx })

describe("offscreenSide (#734)", () => {
  it("is null while the bar is visible", () => {
    expect(offscreenSide(row(300, 400), 200, 700)).toBeNull()
  })

  it("is start / end when a bar with no external label has left the lane", () => {
    expect(offscreenSide(row(10, 100), 200, 700)).toBe("start")
    expect(offscreenSide(row(800, 900), 200, 700)).toBe("end")
  })

  it("an inside label (0 overhang) changes nothing", () => {
    expect(offscreenSide(row(10, 100, 0, 0), 200, 700)).toBe("start")
  })

  it("an after-label that still reaches into the lane holds the start chip back", () => {
    // bar ends at 100 (left of 200) but its label runs 150px further, to 250
    expect(offscreenSide(row(10, 100, 0, 150), 200, 700)).toBeNull()
    // once the label has also gone, the chip appears
    expect(offscreenSide(row(10, 100, 0, 90), 200, 700)).toBe("start")
  })

  it("a before-label that still reaches into the lane holds the end chip back", () => {
    // bar starts at 800 (right of 700) but its label begins 150px earlier, at 650
    expect(offscreenSide(row(800, 900, 150, 0), 200, 700)).toBeNull()
    expect(offscreenSide(row(800, 900, 90, 0), 200, 700)).toBe("end")
  })

  it("only the label on the far side of the bar matters", () => {
    // a start-side chip ignores a before-label, an end-side chip ignores an after-label
    expect(offscreenSide(row(10, 100, 500, 0), 200, 700)).toBe("start")
    expect(offscreenSide(row(800, 900, 0, 500), 200, 700)).toBe("end")
  })

  it("a milestone (start = end) behaves like a bar", () => {
    expect(offscreenSide(row(100, 100, 0, 80), 200, 700)).toBe("start")
    expect(offscreenSide(row(100, 100, 0, 120), 200, 700)).toBeNull()
  })

  it("keeps the 2px sub-pixel allowance at the boundary", () => {
    expect(offscreenSide(row(10, 202), 200, 700)).toBe("start")
    expect(offscreenSide(row(10, 203), 200, 700)).toBeNull()
    expect(offscreenSide(row(698, 900), 200, 700)).toBe("end")
    expect(offscreenSide(row(697, 900), 200, 700)).toBeNull()
  })
})
