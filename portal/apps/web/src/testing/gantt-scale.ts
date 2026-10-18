import { act } from "react";

/**
 * #919: the Dashboard Timeline opens at Week (frame 3a). A DOM test whose fixtures or pointer
 * geometry were written against the old Month default switches the scale the way a user does: the
 * nav's "Select view" menu, then the scale's item. Found by accessible name and role, never by the
 * vendor's `data-slot` (`test-seam.guard.test.ts` guard F).
 */
export async function showGanttScale(host: HTMLElement, label: "Day" | "Week" | "Month" | "Quarter" | "Year"): Promise<void> {
  const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Select view");
  if (!trigger) throw new Error("no Select view trigger");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    trigger.click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find((element) => element.textContent?.trim().startsWith(label));
  if (!item) throw new Error(`no "${label}" scale item`);
  await act(async () => {
    item.click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
