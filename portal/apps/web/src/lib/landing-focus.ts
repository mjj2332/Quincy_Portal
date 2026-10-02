/**
 * #464 — move focus for a "Show in Calendar / Timeline" landing, but only once the Project sheet
 * that launched it has left the DOM. The sheet is a focus trap for as long as its popup is mounted
 * (including while it is closing): focus given to the Dashboard in that window is pulled straight
 * back into the popup and then dropped to <body> when it unmounts. `resolve` is read at the moment
 * focus is given, so a view that re-rendered meanwhile is not focused through a stale element.
 */
const SHEET = '[data-testid="project-sheet"]';

export function focusLanding(resolve: () => HTMLElement | null, options: { preventScroll?: boolean } = {}): void {
  const give = () => resolve()?.focus({ ...options, focusVisible: true } as FocusOptions);
  if (!document.querySelector(SHEET)) { give(); return; }
  const observer = new MutationObserver(() => {
    if (document.querySelector(SHEET)) return;
    observer.disconnect();
    give();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
