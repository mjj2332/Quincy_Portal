import { act } from "react";

/**
 * Shared DOM-test helpers for the Dashboard's Display menu (#427): a `reui/dropdown-menu` radio
 * group opened from an outline "Display" button in the view bar. Queries go by role and accessible
 * name — never by vendor `data-slot` (test-seam F).
 */

export function displayTrigger(scope: ParentNode = document): HTMLButtonElement | null {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Display") ?? null;
}

/** The Display menu's popup, or null while closed. */
export function displayMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]');
}

/** The sort radio items currently rendered in the open menu. */
export function sortRadios(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
}

export function sortRadioLabels(): (string | null)[] {
  return sortRadios().map((radio) => radio.textContent);
}

export function checkedSortLabel(): string | null | undefined {
  return sortRadios().find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
}

export async function openDisplay(scope: ParentNode = document): Promise<void> {
  if (displayMenu()) return;
  const trigger = displayTrigger(scope);
  if (!trigger) throw new Error("Missing Display trigger");
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  if (!displayMenu()) throw new Error("The Display menu did not open");
}

/** Opens the menu if needed and picks a sort. A radio item leaves the menu open (the ReUI block's
 * behaviour, and what the later Display sections need), so this closes it with Escape afterwards. */
export async function chooseSort(label: string, scope: ParentNode = document): Promise<void> {
  await openDisplay(scope);
  const radio = sortRadios().find((item) => item.textContent === label);
  if (!radio) throw new Error(`Missing Display sort option ${label}`);
  await act(async () => { radio.click(); await Promise.resolve(); await Promise.resolve(); });
  await closeDisplay();
}

export async function closeDisplay(): Promise<void> {
  const menu = displayMenu();
  if (!menu) return;
  await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
}
