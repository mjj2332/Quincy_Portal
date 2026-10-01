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
  return need([...popup.querySelectorAll<HTMLInputElement>("input")].find((input) => /^((Start|End) )?[Tt]ime$/.test(input.labels?.[0]?.textContent ?? "")), "Time input");
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

/** #423 — the range form: presses the Start or End toggle, which decides which end the calendar and time edit. */
export async function pickRangeEnd(popup: HTMLElement, which: "Start" | "End") {
  const toggle = need([...popup.querySelectorAll<HTMLButtonElement>('[aria-label="Edit which end"] button')].find((button) => button.textContent?.startsWith(which)), `${which} toggle`);
  await act(async () => { toggle.click(); await Promise.resolve(); });
  await settle();
}

/** Which end is active, and the text each end shows on its toggle ("Not set" while empty). */
export function rangeToggles(popup: HTMLElement): { active: "Start" | "End" | null; start: string; end: string } {
  const buttons = [...popup.querySelectorAll<HTMLButtonElement>('[aria-label="Edit which end"] button')];
  const pressed = buttons.find((button) => button.getAttribute("aria-pressed") === "true");
  const text = (which: string) => buttons.find((button) => button.textContent?.startsWith(which))?.textContent?.slice(which.length) ?? "";
  return { active: pressed ? (pressed.textContent?.startsWith("Start") ? "Start" : "End") : null, start: text("Start"), end: text("End") };
}

/** #423 — opens a field's popup by the suffix its trigger id carries (`-schedule`), for a field embedded in a sheet or dialog. */
export async function openFieldPopup(label: string, scope: ParentNode = document): Promise<HTMLElement> {
  const suffix = `-${label.toLowerCase()}`;
  const trigger = need(
    [...scope.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find((button) => button.id.endsWith(suffix)),
    `${label} field trigger`,
  );
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  return need(dateTimePopup(label), `${label} popup`);
}

/** Presses Earlier or Later in the repeated-time choice of one end of a range popup. */
export async function pressRangeFold(popup: HTMLElement, which: "Start" | "End", choice: "Earlier" | "Later") {
  const group = need(popup.querySelector<HTMLElement>(`[aria-label="Which Sydney time, ${which.toLowerCase()}"]`), `${which} fold choice`);
  const button = need([...group.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.startsWith(choice)), `${which} ${choice}`);
  await act(async () => { button.click(); await Promise.resolve(); });
  await settle();
}

/** Which of Earlier / Later is pressed for one end of a range popup, or null when neither is. */
export function rangeFoldPressed(popup: HTMLElement, which: "Start" | "End"): "Earlier" | "Later" | null {
  const group = popup.querySelector<HTMLElement>(`[aria-label="Which Sydney time, ${which.toLowerCase()}"]`);
  const pressed = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.getAttribute("aria-pressed") === "true");
  return pressed ? (pressed.textContent?.startsWith("Earlier") ? "Earlier" : "Later") : null;
}

/** The text a range popup's Start | End toggle shows for a civil day and time: `Thu 8 Oct · 13:00`. */
export function rangeMoment(day: string, time: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1];
  return `${weekday} ${date} ${monthName} · ${time}`;
}
