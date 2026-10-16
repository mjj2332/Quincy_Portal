/**
 * #880: Chromium's focus fixup, which jsdom lacks. When an ancestor of the focused element gains `inert`, Chromium drops the focus to <body> within a frame or two (measured in a
 * Chromium probe: `active=b` when `inert` is set, `BODY` two frames later), and the keys typed next land outside any dialog. jsdom keeps the focus where it was, so a test of
 * "the controls hide while one of them has the focus" passes for the wrong reason without this. jsdom already drops the focus to <body> when the focused element is removed.
 */
export function installInertFocusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.closest("[inert]")) active.blur();
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert"] });
  return () => { observer.disconnect(); };
}

/** Space as a browser delivers it: keydown on the focused element, then (if nothing prevented it) a focused button's own activation, which a browser runs on keyup. */
export function pressSpace(): void {
  const target = document.activeElement ?? document.body;
  const down = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  if (!down.defaultPrevented && target instanceof HTMLButtonElement && !target.disabled) target.click();
  target.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true, cancelable: true }));
}
