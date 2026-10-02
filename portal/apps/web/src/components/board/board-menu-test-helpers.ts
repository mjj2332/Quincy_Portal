import { act } from "react";

/**
 * Shared DOM-test helpers for the Board card's ⋯ menu, right-click menu and Move to submenu (#470).
 * Queries go by role, accessible name and test id — never by vendor `data-slot` (test-seam F), and
 * with literal selectors only (guard B), so each finder filters rather than building a selector.
 */

/** The card's ⋯ trigger, by project id (null when the card has no menu). */
export function cardMenuTrigger(scope: ParentNode, projectId: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll<HTMLButtonElement>('[data-testid="board-card-menu"]')].find((node) => node.getAttribute("data-focus-key") === `card-menu:${projectId}`) ?? null;
}

/** The open menu's items, in order, whichever menu (⋯ or right-click) is open. */
export function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

export function menuItem(label: string): HTMLElement | null {
  return menuItems().find((node) => node.textContent === label) ?? null;
}

export function isMenuItemDisabled(item: HTMLElement): boolean {
  return item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled");
}

async function flushTimers(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); });
}

export async function openCardMenu(scope: ParentNode, projectId: string): Promise<void> {
  const trigger = cardMenuTrigger(scope, projectId);
  if (!trigger) throw new Error(`Missing ⋯ trigger for ${projectId}`);
  await openMenuFrom(trigger);
}

export async function openMenuFrom(trigger: HTMLElement): Promise<void> {
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  if (!document.querySelector('[role="menu"]')) throw new Error("The card menu did not open");
}

/** Right-clicks a card's frame (the element carrying `board-card-wrap`). */
export async function openContextMenu(frame: Element): Promise<void> {
  await act(async () => {
    frame.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 2 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!document.querySelector('[role="menu"]')) throw new Error("The context menu did not open");
}

export async function chooseMenuItem(label: string): Promise<void> {
  const item = menuItem(label);
  if (!item) throw new Error(`Missing menu item ${label}`);
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await flushTimers();
}

/** The "Move to" submenu trigger (a menuitem with a popup), whichever menu is open. */
export function moveToTrigger(): HTMLElement | null {
  return menuItems().find((node) => node.textContent === "Move to") ?? null;
}

/** The Stage choices of the open Move to submenu, in order. */
export function stageRadios(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

export function stageRadio(label: string): HTMLElement | null {
  return stageRadios().find((node) => node.textContent === label) ?? null;
}

/** Opens the Move to submenu of the menu that is already open, and waits for its Stage choices. */
export async function openMoveToSubmenu(): Promise<void> {
  const trigger = moveToTrigger();
  if (!trigger) throw new Error("Missing the Move to submenu trigger");
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  for (let attempt = 0; attempt < 20 && stageRadios().length === 0; attempt += 1) await flushTimers();
  if (stageRadios().length === 0) throw new Error("The Move to submenu did not open");
}

/** Opens a card's ⋯ menu, then its Move to submenu. */
export async function openMoveTo(scope: ParentNode, projectId: string): Promise<void> {
  await openCardMenu(scope, projectId);
  await openMoveToSubmenu();
}

/** Opens a card's ⋯ menu, opens Move to, and picks a Stage. */
export async function moveToStage(scope: ParentNode, projectId: string, label: string): Promise<void> {
  await openMoveTo(scope, projectId);
  const radio = stageRadio(label);
  if (!radio) throw new Error(`Missing Stage choice ${label}`);
  await act(async () => { radio.click(); await Promise.resolve(); await Promise.resolve(); });
  await flushTimers();
}

/** Escapes whatever menu is open and waits for it to unmount, so the next render starts clean. */
export async function closeMenus(): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 20 && document.querySelector('[role="menu"]'); attempt += 1) await flushTimers();
}

/** Opens the menu from an explicit ⋯ trigger, then its Move to submenu. */
export async function openMoveToFrom(trigger: HTMLElement): Promise<void> {
  await openMenuFrom(trigger);
  await openMoveToSubmenu();
}
