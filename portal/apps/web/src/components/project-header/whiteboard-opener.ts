/**
 * #914 — where focus goes when the Project whiteboard closes. The header can draw the whiteboard's button in more than one place
 * (the status cluster, the condensed bar, the phone project bar, Project info's action), so the board no longer returns focus to
 * the first match in the document: the button that opened it records itself here. When that button has gone (it was the
 * condensed copy, or Project info's action, which closed with its sheet), focus goes to the header's own button.
 */
let lastOpener: HTMLElement | null = null;

export const WHITEBOARD_OPEN_TESTID = "project-whiteboard-open";

/** Record the element that opened the board; `null` when the opener will not survive (Project info's action). */
export function noteWhiteboardOpener(element: HTMLElement | null) {
  lastOpener = element;
}

export function whiteboardReturnTarget(): HTMLElement | null {
  const opener = lastOpener;
  lastOpener = null;
  if (opener?.isConnected && !opener.closest("[inert]")) return opener;
  return document.querySelector<HTMLElement>(`[data-testid="${WHITEBOARD_OPEN_TESTID}"]`);
}
