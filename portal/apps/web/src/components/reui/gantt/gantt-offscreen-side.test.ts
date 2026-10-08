import { describe, expect, it } from "vitest"
import { offscreenSide } from "./gantt-track-geometry"

const row = (startPx: number, endPx: number) => ({ startPx, endPx })

describe("offscreenSide (#734)", () => {
  it("is null while anything painted is in the lane", () => {
    expect(offscreenSide(row(300, 400), 200, 700)).toBeNull()
  })

  it("is start / end when the whole painted extent has left the lane", () => {
    expect(offscreenSide(row(10, 100), 200, 700)).toBe("start")
    expect(offscreenSide(row(800, 900), 200, 700)).toBe("end")
  })

  it("a painted extent that still reaches into the lane holds the chip back", () => {
    expect(offscreenSide(row(10, 250), 200, 700)).toBeNull()
    expect(offscreenSide(row(650, 900), 200, 700)).toBeNull()
  })

  it("a milestone (start = end) behaves like a bar", () => {
    expect(offscreenSide(row(100, 100), 200, 700)).toBe("start")
    expect(offscreenSide(row(300, 300), 200, 700)).toBeNull()
  })

  it("keeps the 2px sub-pixel allowance at the boundary", () => {
    expect(offscreenSide(row(10, 202), 200, 700)).toBe("start")
    expect(offscreenSide(row(10, 203), 200, 700)).toBeNull()
    expect(offscreenSide(row(698, 900), 200, 700)).toBe("end")
    expect(offscreenSide(row(697, 900), 200, 700)).toBeNull()
  })
})
