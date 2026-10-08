/**
 * #728 (PR3 of #722) - the gated ctrl/meta wheel-zoom listener.
 *
 * A non-passive wheel listener makes the browser wait for script before it scrolls, so it must not
 * sit on the scroller in the steady state. This helper owns the ONLY non-passive wheel listener in
 * the Gantt:
 *
 * - With `GestureEvent` (WebKit): the wheel listener is attached while Control or Meta is physically
 *   held. Held state lives at module level (capture-phase window keydown/keyup, so an input that
 *   stops propagation cannot hide it) and survives a rebind; blur and visibilitychange clear it. A pinch arrives
 *   as gesturestart/gesturechange instead and is forwarded as a scale ratio.
 * - Without `GestureEvent` (Chromium and others): a pinch arrives as ctrl+wheel with no keydown, so
 *   the listener stays attached.
 *
 * WebKit pinch limitation: `gesturestart` is NOT cancelled (we cannot know yet whether the zoom will be
 * consumed), and `gesturechange` is cancelled only when the callback consumed the step. A pinch
 * rejected at a zoom limit therefore reaches the browser, but whether Safari can hand an already-begun
 * gesture to page zoom mid-gesture is unverified on a real device.
 *
 * Targets inside the tree column are skipped so the browser's page zoom still works there.
 */

const TREE_COLUMN = "[data-gantt-tree-column]"

export interface GatedWheelZoomHandlers {
  onWheel: (e: WheelEvent) => void
  /**
   * `ratio` is the scale change since the previous gesture event; `clientX` anchors the zoom.
   * Return true when the step was applied (the gesture is then cancelled), false to leave it to the browser.
   */
  onGesture: (ratio: number, clientX: number) => boolean
}

function inTreeColumn(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TREE_COLUMN) !== null
}

interface GestureLike extends Event {
  scale: number
  clientX: number
}

// Modifier state is module-level so it outlives any one binding (a scale change rebinds the host).
let modifierHeld = false
let trackerInstalled = false
const modifierListeners = new Set<() => void>()

function setHeld(next: boolean) {
  if (next === modifierHeld) return
  modifierHeld = next
  for (const fn of [...modifierListeners]) fn()
}

function installModifierTracker() {
  if (trackerInstalled) return
  trackerInstalled = true
  // Capture phase: a focused input that calls stopPropagation() must not hide the modifier.
  window.addEventListener("keydown", (e) => setHeld(e.key === "Control" || e.key === "Meta" || e.ctrlKey || e.metaKey), true)
  window.addEventListener("keyup", (e) => setHeld(e.ctrlKey || e.metaKey), true)
  window.addEventListener("blur", () => setHeld(false))
  document.addEventListener("visibilitychange", () => setHeld(false))
}

export function bindGatedWheelZoom(host: HTMLElement, handlers: GatedWheelZoomHandlers): () => void {
  const wheel = (e: WheelEvent) => {
    if (inTreeColumn(e.target)) return
    handlers.onWheel(e)
  }
  let attached = false
  const attach = () => {
    if (attached) return
    attached = true
    host.addEventListener("wheel", wheel, { passive: false })
  }
  const detach = () => {
    if (!attached) return
    attached = false
    host.removeEventListener("wheel", wheel)
  }

  if (!("GestureEvent" in window)) {
    attach()
    return detach
  }

  installModifierTracker()
  const sync = () => (modifierHeld ? attach() : detach())
  modifierListeners.add(sync)
  sync()

  let lastScale = 1
  const onGestureStart = (e: Event) => {
    if (inTreeColumn(e.target)) return
    lastScale = 1
  }
  const onGestureChange = (e: Event) => {
    if (inTreeColumn(e.target)) return
    const g = e as GestureLike
    const ratio = lastScale > 0 ? g.scale / lastScale : 1
    lastScale = g.scale
    if (handlers.onGesture(ratio, g.clientX)) e.preventDefault()
  }

  host.addEventListener("gesturestart", onGestureStart)
  host.addEventListener("gesturechange", onGestureChange)
  return () => {
    modifierListeners.delete(sync)
    detach()
    host.removeEventListener("gesturestart", onGestureStart)
    host.removeEventListener("gesturechange", onGestureChange)
  }
}
