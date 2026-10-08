import { afterEach, describe, expect, it, vi } from "vitest"
import { bindGatedWheelZoom } from "./gantt-wheel-zoom"

function setup(opts: { webkit: boolean }) {
  if (opts.webkit) (window as unknown as Record<string, unknown>).GestureEvent = class {}
  const host = document.createElement("div")
  const tree = document.createElement("div")
  tree.setAttribute("data-gantt-tree-column", "")
  const treeChild = document.createElement("span")
  tree.appendChild(treeChild)
  const lane = document.createElement("div")
  host.append(tree, lane)
  document.body.appendChild(host)
  const onWheel = vi.fn()
  const onGesture = vi.fn()
  const unbind = bindGatedWheelZoom(host, { onWheel, onGesture })
  return { host, tree, treeChild, lane, onWheel, onGesture, unbind }
}

function wheel(target: Element, init: WheelEventInit = {}) {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}
const key = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, init))

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).GestureEvent
  document.body.innerHTML = ""
})

describe("bindGatedWheelZoom with GestureEvent (WebKit)", () => {
  it("does not listen for wheel until Control or Meta is held", () => {
    const s = setup({ webkit: true })
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).not.toHaveBeenCalled()
    key("keydown", { key: "Control", ctrlKey: true })
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    s.unbind()
  })

  it("attaches on Meta too, and detaches on keyup", () => {
    const s = setup({ webkit: true })
    key("keydown", { key: "Meta", metaKey: true })
    wheel(s.lane, { metaKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    key("keyup", { key: "Meta" })
    wheel(s.lane, { metaKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    s.unbind()
  })

  it("keeps listening when one modifier is released but the other is still held", () => {
    const s = setup({ webkit: true })
    key("keydown", { key: "Control", ctrlKey: true })
    key("keydown", { key: "Meta", ctrlKey: true, metaKey: true })
    key("keyup", { key: "Meta", ctrlKey: true })
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    s.unbind()
  })

  it("detaches on window blur and on visibilitychange", () => {
    const s = setup({ webkit: true })
    key("keydown", { key: "Control", ctrlKey: true })
    window.dispatchEvent(new Event("blur"))
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).not.toHaveBeenCalled()
    key("keydown", { key: "Control", ctrlKey: true })
    document.dispatchEvent(new Event("visibilitychange"))
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).not.toHaveBeenCalled()
    s.unbind()
  })

  it("unbind detaches everything, even while the modifier is held", () => {
    const s = setup({ webkit: true })
    key("keydown", { key: "Control", ctrlKey: true })
    s.unbind()
    wheel(s.lane, { ctrlKey: true })
    key("keydown", { key: "Control", ctrlKey: true })
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).not.toHaveBeenCalled()
  })

  it("registers the wheel listener as non-passive only while attached", () => {
    const host = document.createElement("div")
    ;(window as unknown as Record<string, unknown>).GestureEvent = class {}
    const spy = vi.spyOn(host, "addEventListener")
    const unbind = bindGatedWheelZoom(host, { onWheel: vi.fn(), onGesture: vi.fn() })
    expect(spy.mock.calls.filter((c) => c[0] === "wheel")).toHaveLength(0)
    key("keydown", { key: "Control", ctrlKey: true })
    const wheelCalls = spy.mock.calls.filter((c) => c[0] === "wheel")
    expect(wheelCalls).toHaveLength(1)
    expect(wheelCalls[0]![2]).toEqual({ passive: false })
    unbind()
  })

  it("skips targets inside the tree column", () => {
    const s = setup({ webkit: true })
    key("keydown", { key: "Control", ctrlKey: true })
    const e = wheel(s.treeChild, { ctrlKey: true })
    expect(s.onWheel).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    s.unbind()
  })

  it("forwards pinch as a scale ratio between gesturechange events and prevents default", () => {
    const s = setup({ webkit: true })
    const start = new Event("gesturestart", { bubbles: true, cancelable: true })
    s.lane.dispatchEvent(start)
    expect(start.defaultPrevented).toBe(true)
    const g1 = Object.assign(new Event("gesturechange", { bubbles: true, cancelable: true }), {
      scale: 1.2,
      clientX: 50,
    })
    s.lane.dispatchEvent(g1)
    expect(g1.defaultPrevented).toBe(true)
    expect(s.onGesture).toHaveBeenLastCalledWith(1.2, 50)
    const g2 = Object.assign(new Event("gesturechange", { bubbles: true, cancelable: true }), {
      scale: 1.8,
      clientX: 60,
    })
    s.lane.dispatchEvent(g2)
    expect(s.onGesture.mock.calls[1]![0]).toBeCloseTo(1.5)
    s.unbind()
  })

  it("leaves pinch inside the tree column to the browser", () => {
    const s = setup({ webkit: true })
    const g = Object.assign(new Event("gesturechange", { bubbles: true, cancelable: true }), { scale: 1.2 })
    s.treeChild.dispatchEvent(g)
    expect(g.defaultPrevented).toBe(false)
    expect(s.onGesture).not.toHaveBeenCalled()
    s.unbind()
  })
})

describe("bindGatedWheelZoom without GestureEvent (Chromium)", () => {
  it("listens always, with no keydown, and skips the tree column", () => {
    const s = setup({ webkit: false })
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    wheel(s.treeChild, { ctrlKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
    s.unbind()
    wheel(s.lane, { ctrlKey: true })
    expect(s.onWheel).toHaveBeenCalledTimes(1)
  })
})
