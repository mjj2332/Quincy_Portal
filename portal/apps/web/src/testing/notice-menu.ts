import { act } from "react";

type Advance = (milliseconds: number) => Promise<unknown>;

// The Notice board suites run on fake timers, so the wait goes through the caller's own `advance`.
const settle = (advance: Advance, ms = 200) => act(async () => { await advance(ms); });

/**
 * Drives the Notice board "⋯" menu (#523): opens the trigger named for `authorName`'s notice,
 * activates the `Edit` / `Delete` item, then waits out the menu's exit transition. The menu and the
 * confirmation dialog render in a portal, so items are looked up in `document`, not in `scope`.
 */
export async function chooseNoticeAction(scope: ParentNode, authorName: string, label: "Edit" | "Delete", advance: Advance) {
  const trigger = scope.querySelector<HTMLElement>(`[aria-label="Actions for notice by ${authorName}"]`);
  if (!trigger) throw new Error(`No notice actions trigger for ${authorName}`);
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`No "${label}" item in the notice actions menu`);
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle(advance);
}

const pressDialog = async (testId: string, advance: Advance) => {
  const button = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`No ${testId} in the notice delete dialog`);
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle(advance);
};

/** Presses "Delete notice" in the confirmation dialog, then lets the request and the exit settle. */
export const confirmNoticeDelete = (advance: Advance) => pressDialog("notice-delete-confirm-action", advance);
/** Presses "Cancel" in the confirmation dialog. */
export const cancelNoticeDelete = (advance: Advance) => pressDialog("notice-delete-cancel", advance);
