/**
 * #669 (from #664) — happy-dom has no `FloatingFocusManager`, so stand in for the Project sheet's
 * `restoreFocus: "popup"`: when the watched popup leaves the DOM and focus is homeless (on <body>),
 * the sheet takes it back one frame later. A trigger that already holds focus is left alone, as the
 * real manager leaves it. A pass against this emulation is not proof against the real sheet: the
 * browser pass is (docs/lessons.md, "A focus test can pass because something else restored focus").
 * Returns the disconnect function.
 */
export function emulateSheetRestoreFocus(getPopup: () => HTMLElement | null): () => void {
  let had = false;
  const observer = new MutationObserver(() => {
    const present = getPopup() !== null;
    if (had && !present) {
      const active = document.activeElement;
      if (!active || active === document.body) requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]')?.focus());
    }
    had = present;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
