/**
 * #728 (PR3 of #722) - the gated ctrl/meta wheel-zoom listener.
 *
 * A non-passive wheel listener makes the browser wait for script before it scrolls, so it must not
 * sit on the scroller in the steady state. This helper owns the ONLY non-passive wheel listener in
 * the Gantt:
 *
 * - With `GestureEvent` (WebKit): the wheel listener is attached while Control or Meta is physically
 *   held (window keydown attaches; keyup, window blur and visibilitychange detach). A pinch arrives
 *   as gesturestart/gesturechange instead and is forwarded as a scale ratio.
 * - Without `GestureEvent` (Chromium and others): a pinch arrives as ctrl+wheel with no keydown, so
 *   the listener stays attached.
 *
 * Targets inside the tree column are skipped so the browser's page zoom still works there.
 */

const TREE_COLUMN = "[data-gantt-tree-column]"

export interface GatedWheelZoomHandlers {
  onWheel: (e: WheelEvent) => void
  /** `ratio` is the scale change since the previous gesture event; `clientX` anchors the zoom. */
  onGesture: (ratio: number, clientX: number) => void
}

function inTreeColumn(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TREE_COLUMN) !== null
}

interface GestureLike extends Event {
  scale: number
  clientX: number
}

export function bindGatedWheelZoom(host: HTMLElement, handlers: GatedWheelZoomHandlers): () => void {
  const wheel = (e: WheelEvent) => {
    if (inTreeColumn(e.target)) return
    handlers.onWheel(e)
  }
  const attachWheel = () => host.addEventListener("wheel", wheel, { passive: false })
  const detachWheel = () => host.removeEventListener("wheel", wheel)

  if (!("GestureEvent" in window)) {
    attachWheel()
    return detachWheel
  }

  let attached = false
  const attach = () => {
    if (attached) return
    attached = true
    attachWheel()
  }
  const detach = () => {
    if (!attached) return
    attached = false
    detachWheel()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta" || e.ctrlKey || e.metaKey) attach()
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) detach()
  }
  const onVisibility = () => detach()

  let lastScale = 1
  const onGestureStart = (e: Event) => {
    if (inTreeColumn(e.target)) return
    e.preventDefault()
    lastScale = 1
  }
  const onGestureChange = (e: Event) => {
    if (inTreeColumn(e.target)) return
    e.preventDefault()
    const g = e as GestureLike
    const ratio = lastScale > 0 ? g.scale / lastScale : 1
    lastScale = g.scale
    handlers.onGesture(ratio, g.clientX)
  }

  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)
  window.addEventListener("blur", detach)
  document.addEventListener("visibilitychange", onVisibility)
  host.addEventListener("gesturestart", onGestureStart)
  host.addEventListener("gesturechange", onGestureChange)
  return () => {
    detach()
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("keyup", onKeyUp)
    window.removeEventListener("blur", detach)
    document.removeEventListener("visibilitychange", onVisibility)
    host.removeEventListener("gesturestart", onGestureStart)
    host.removeEventListener("gesturechange", onGestureChange)
  }
}
