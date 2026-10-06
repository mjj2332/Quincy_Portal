import { act } from "react";

/**
 * Drives the Discussion "⋯" menu (#376): opens the trigger named for `authorName`'s comment,
 * activates the `Edit` / `Delete` item, then waits out the menu's exit transition so the popup is
 * unmounted before the next assertion. Edit and Delete used to be inline text buttons.
 */
export async function chooseCommentAction(scope: ParentNode, authorName: string, label: "Edit" | "Delete") {
  const trigger = scope.querySelector<HTMLElement>(`[aria-label="Actions for comment by ${authorName}"]`);
  if (!trigger) throw new Error(`No comment actions trigger for ${authorName}`);
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`No "${label}" item in the comment actions menu`);
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

/**
 * Comment Delete asks in an alert dialog (#568): `chooseCommentAction(..., "Delete")` only opens it. These finish the choice
 * and wait out the dialog's exit transition so focus has settled before the next assertion.
 */
export async function confirmCommentDelete() {
  const action = document.querySelector<HTMLElement>('[data-testid="comment-delete-confirm-action"]');
  if (!action) throw new Error("No comment Delete confirmation is open");
  await act(async () => { action.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 300)); });
}
export async function cancelCommentDelete() {
  const cancel = document.querySelector<HTMLElement>('[data-testid="comment-delete-cancel"]');
  if (!cancel) throw new Error("No comment Delete confirmation is open");
  await act(async () => { cancel.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 300)); });
}
