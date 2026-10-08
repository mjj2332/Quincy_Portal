/**
 * #738 - `GanttView`'s `zoomControlTarget`: an element portals the zoom buttons into it, `undefined` keeps
 * the floating box in the lane overlay, `null` renders neither (the consumer's target is not mounted yet).
 * Guard F: found by `data-testid` and accessible name.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Gantt } from "./gantt"
import { GanttView } from "./gantt-view"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []

let host: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ""
})

async function mount(target: HTMLElement | null | undefined, onZoomChange = vi.fn()) {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <Gantt resources={[{ id: "r1", title: "Row 1" }]} events={[]} date={new Date("2026-03-02T00:00:00Z")} scale="week" timeZone="UTC" zoomControl zoom={1} onZoomChange={onZoomChange}>
        <GanttView zoomControlTarget={target} />
      </Gantt>,
    )
    await Promise.resolve()
  })
  return onZoomChange
}

describe("GanttView zoomControlTarget (#738)", () => {
  it("portals the buttons into the provided element, not the lane overlay", async () => {
    const target = document.createElement("div")
    document.body.appendChild(target)
    const onZoomChange = await mount(target)
    expect(target.querySelector('[data-testid="gantt-zoom"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="gantt-lane-overlay"] [data-testid="gantt-zoom"]')).toBeNull()
    await act(async () => { target.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click(); await Promise.resolve() })
    expect(onZoomChange).toHaveBeenLastCalledWith(1.25)
    await act(async () => { target.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!.click(); await Promise.resolve() })
    expect(onZoomChange).toHaveBeenLastCalledWith(0.75)
  })

  it("undefined keeps the floating box in the lane overlay", async () => {
    await mount(undefined)
    expect(host.querySelector('[data-testid="gantt-lane-overlay"] [data-testid="gantt-zoom"]')).not.toBeNull()
  })

  it("null renders no zoom buttons anywhere", async () => {
    await mount(null)
    expect(document.querySelector('[data-testid="gantt-zoom"]')).toBeNull()
    expect(document.querySelector('button[aria-label="Zoom in"]')).toBeNull()
  })
})
