/**
 * #528 — the bottom edge of the sticky shell header (the 50px top bar, lower by the impersonation
 * banner while one is showing). Base UI measures a popup's `collisionPadding` from the VIEWPORT, not
 * from the header, so a popup that shifts or flips upward paints over the top bar unless its top
 * padding includes this. 0 when no header is rendered (a dialog or sheet covers it, a test).
 */
export function shellChromeBottom(): number {
  if (typeof document === "undefined") return 0;
  const header = document.querySelector<HTMLElement>(".shell-header");
  return header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
}
