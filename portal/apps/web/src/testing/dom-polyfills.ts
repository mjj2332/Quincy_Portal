/**
 * DOM-suite polyfills for what happy-dom lacks and Base UI reaches for.
 *
 * `Element.getAnimations()`: Base UI's ScrollArea viewport calls it from a timer after mount, and a
 * popup's unmount waits on it. happy-dom has none, so without this a mounted ScrollArea (the date
 * popup's time column, #422) throws an unhandled error 100ms after its test ends. Several DOM files
 * already carry this same two-line stub for the Board and the Dashboard list. It is imported (for
 * its side effect) by `testing/date-time-popup.ts` rather than installed suite-wide: with the stub
 * present, a closing popup's unmount waits a tick on `Promise.all([])`, which other suites
 * (NotificationBell) assert synchronously against. A browser always has the real method.
 */
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
