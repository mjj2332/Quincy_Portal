import { act } from "react";
import "./dom-polyfills";

/**
 * #422 — drives the date-time popup from a DOM test, through roles, names and aria state only.
 * It replaces the native "Deadline date" / "Deadline time" inputs the Deadline tests used to type
 * into. The popup is a non-modal dialog portalled to `document.body`, named by its field label.
 */

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

export function dateTimePopup(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`date-time popup: ${what} not found`);
  return value;
}

export function popupButton(popup: HTMLElement, name: string): HTMLButtonElement | undefined {
  const buttons = [...popup.querySelectorAll<HTMLButtonElement>("button")];
  // Exact name first; a shortcut row's text also carries its weekday ("TomorrowFri").
  return buttons.find((button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name)
    ?? buttons.find((button) => button.textContent?.trim().startsWith(name));
}

export async function pressInPopup(popup: HTMLElement, name: string) {
  const button = need(popupButton(popup, name), `button "${name}"`);
  await act(async () => { button.click(); await Promise.resolve(); });
  await settle();
}

async function setNativeSelect(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

/** Picks a civil day (`YYYY-MM-DD`) on the popup's calendar, moving month and year first. */
export async function pickPopupDay(popup: HTMLElement, day: string) {
  const [year, month] = day.split("-");
  const yearSelect = need(popup.querySelector<HTMLSelectElement>('select[aria-label="Year"]'), "Year select");
  if (yearSelect.value !== String(Number(year))) await setNativeSelect(yearSelect, String(Number(year)));
  const monthSelect = need(popup.querySelector<HTMLSelectElement>('select[aria-label="Month"]'), "Month select");
  if (monthSelect.value !== String(Number(month) - 1)) await setNativeSelect(monthSelect, String(Number(month) - 1));
  const cell = need(popup.querySelector<HTMLElement>(`[data-day="${day}"]`), `day ${day}`);
  const button = need(cell.querySelector<HTMLButtonElement>("button"), `day ${day} button`);
  await act(async () => { button.click(); await Promise.resolve(); });
  await settle();
}

export function popupTimeInput(popup: HTMLElement): HTMLInputElement {
  return need([...popup.querySelectorAll<HTMLInputElement>("input")].find((input) => input.labels?.[0]?.textContent === "Time"), "Time input");
}

/** Types an exact time into the popup's Time input. */
export async function typePopupTime(popup: HTMLElement, time: string) {
  const input = popupTimeInput(popup);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, time);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

/** Picks a day and a time in an open popup (the draft only; nothing is applied). */
export async function pickPopupDateTime(popup: HTMLElement, localCivil: string) {
  const [day, time] = localCivil.split("T");
  await pickPopupDay(popup, day!);
  await typePopupTime(popup, time!);
}

/** The day and time the popup's draft currently shows. */
export function popupDraft(popup: HTMLElement): { day: string | null; time: string } {
  const selected = popup.querySelector<HTMLElement>('[aria-selected="true"]');
  return { day: selected?.getAttribute("data-day") ?? null, time: popupTimeInput(popup).value };
}

export async function applyPopup(popup: HTMLElement) {
  await pressInPopup(popup, "Apply");
}

/**
 * Opens the Move / Reschedule Deadline dialog's date-time field (#422) and returns its popup. The
 * dialog embeds the field, so there is one trigger button, named by the "Deadline" label.
 */
export async function openMoveDialogField(dialog: ParentNode = document): Promise<HTMLElement> {
  const trigger = need(
    [...dialog.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find((button) => button.id.endsWith("-deadline")),
    "Deadline field trigger",
  );
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  return need(dateTimePopup("Deadline"), "Deadline popup");
}

/**
 * Sets the Move dialog's draft in one go: opens the field, picks the day and (when given) types
 * the time, and applies it to the DIALOG's draft. The dialog's own "Save Deadline" is still the
 * caller's to press.
 */
export async function setMoveDialogDeadline(draft: { day: string; time?: string }, dialog: ParentNode = document) {
  const popup = await openMoveDialogField(dialog);
  await pickPopupDay(popup, draft.day);
  if (draft.time) await typePopupTime(popup, draft.time);
  await applyPopup(popup);
}
