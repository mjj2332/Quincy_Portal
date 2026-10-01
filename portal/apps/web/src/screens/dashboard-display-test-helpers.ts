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

/** The open menu's group labelled `label` ("Sort", "Group by", "Columns", "Layers", "Show"), or null. Menus hold several groups since #431. */
export function displayGroup(label: string): HTMLElement | null {
  const groups = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="group"]')];
  return groups.find((group) => {
    const labelledBy = group.getAttribute("aria-labelledby");
    const heading = labelledBy ? document.getElementById(labelledBy) : null;
    return heading?.textContent?.trim() === label;
  }) ?? null;
}

/** The radio items of one group. */
export function groupRadios(label: string): HTMLElement[] {
  return [...(displayGroup(label)?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
}

/** The sort radio items currently rendered in the open menu. */
export function sortRadios(): HTMLElement[] {
  return groupRadios("Sort");
}

export function groupByRadios(): HTMLElement[] {
  return groupRadios("Group by");
}

/** The checkbox items of one group ("Layers", "Show", "Columns"), in menu order. */
export function groupCheckboxes(label: string): HTMLElement[] {
  return [...(displayGroup(label)?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
}

/** Toggles one named checkbox item in a group; the menu stays open. */
export async function toggleGroupCheckbox(group: string, label: string, scope: ParentNode = document): Promise<void> {
  await openDisplay(scope);
  const item = groupCheckboxes(group).find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`Missing Display ${group} option ${label}`);
  await act(async () => { item.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
}

/** The Table menu's column checkbox items, in menu order. */
export function columnCheckboxes(): HTMLElement[] {
  return [...(displayGroup("Columns")?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
}

export function columnCheckboxLabels(): (string | null)[] {
  return columnCheckboxes().map((item) => item.textContent);
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
  await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
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

/** Opens the menu if needed and picks a Group by value. The menu stays open afterwards (a radio item does not close it). */
export async function chooseGroupBy(label: string, scope: ParentNode = document): Promise<void> {
  await openDisplay(scope);
  const radio = groupByRadios().find((item) => item.textContent === label);
  if (!radio) throw new Error(`Missing Display Group by option ${label}`);
  await act(async () => { radio.click(); await Promise.resolve(); await Promise.resolve(); });
}

/** Toggles one column's checkbox item; the menu stays open, which is the point of a checkbox item. */
export async function toggleColumn(label: string, scope: ParentNode = document): Promise<void> {
  await openDisplay(scope);
  const item = columnCheckboxes().find((candidate) => candidate.textContent === label);
  if (!item) throw new Error(`Missing Display column option ${label}`);
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
}

export async function closeDisplay(): Promise<void> {
  const menu = displayMenu();
  if (!menu) return;
  await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
}
