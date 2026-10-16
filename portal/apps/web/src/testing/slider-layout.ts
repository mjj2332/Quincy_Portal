/**
 * Layout for the player's scrubber in happy-dom (PR 2 fix round 2, the scrubber thumb): Base UI's slider places an edge-aligned thumb from the control's and the thumb's
 * measured widths, and hides it (`visibility: hidden`) while that measurement is not a number. Here an element inside a `hidden` box measures 0 wide (as `display: none` does),
 * anything else a control 300px wide or a thumb 16px wide. The ResizeObserver never reports, which is what the iPhone showed: a thumb measured inside the hidden transport was
 * not measured again when the transport came back, so it stayed invisible until the frame changed.
 */
export function installSliderLayout(): () => void {
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
  const observer = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const width = this.closest("[hidden]") !== null ? 0 : this.matches('[data-slot="slider-thumb"]') ? 16 : 300;
    const height = width === 0 ? 0 : 16;
    return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  return () => {
    Object.defineProperty(Element.prototype, "getBoundingClientRect", rect);
    if (observer) Object.defineProperty(globalThis, "ResizeObserver", observer); else delete (globalThis as Record<string, unknown>).ResizeObserver;
  };
}

/** Whether the scrubber's thumb is drawn: it is in the document and Base UI has placed it (no `visibility: hidden`). */
export function scrubberThumbShown(scope: ParentNode = document): boolean {
  const thumb = scope.querySelector<HTMLElement>('[data-testid="video-scrubber"] [data-slot="slider-thumb"]');
  return thumb !== null && thumb.style.visibility !== "hidden" && thumb.closest("[hidden]") === null;
}
