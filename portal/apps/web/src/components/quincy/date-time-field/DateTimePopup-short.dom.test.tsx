import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeApply } from "../DateTimeField";
import { POPUP_SHORT_QUERY, POPUP_STACKED_QUERY } from "@/lib/date-time-field";
import { applyPopup, dateTimePopup, popupDraft, popupTimeInput, typePopupTime } from "@/testing/date-time-popup";

/**
 * #686: at a short viewport height (landscape phone) the time-slot list is not rendered, the popup title scrolls with the
 * body, and the calendar comes before the shortcuts. Per-query `matchMedia` stub: only the queries named by a test match.
 * "Now" is Thu 1 Oct 2026, 13:00 in Sydney.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let original: typeof window.matchMedia;
const matching = new Set<string>();
const listeners = new Set<() => void>();

function setMatching(...queries: string[]) {
  matching.clear();
  for (const query of queries) matching.add(query);
  for (const listener of listeners) listener();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") });
  original = window.matchMedia;
  matching.clear();
  window.matchMedia = ((query: string) => ({
    get matches() { return matching.has(query); },
    media: query,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
    addListener: (listener: () => void) => { listeners.add(listener); },
    removeListener: (listener: () => void) => { listeners.delete(listener); },
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  document.body.replaceChildren();
  window.matchMedia = original;
  listeners.clear();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

async function open(onApply: (next: DateTimeApply) => void = vi.fn(), value: { localCivil: string } | null = { localCivil: "2026-10-15T09:00" }) {
  await act(async () => {
    root.render(<DateTimeField variant="date-time" id="deadline" label="Deadline" value={value} clearable={false} onApply={onApply} />);
    await Promise.resolve();
  });
  await act(async () => { host.querySelector<HTMLButtonElement>("button#deadline")!.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  return dateTimePopup("Deadline")!;
}

const slots = (popup: HTMLElement) => popup.querySelector('[role="group"][aria-label="Time slots"]');
const body = (popup: HTMLElement) => popup.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const grid = (popup: HTMLElement) => popup.querySelector('[role="grid"]')!;
const shortcuts = (popup: HTMLElement) => popup.querySelector('[role="list"][aria-label="Date shortcuts"]')!;
const title = (popup: HTMLElement) => [...popup.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent === "Deadline")!;

describe("DateTimePopup at a short height (#686)", () => {
  it("renders no time-slot list; the typed time stays and applies any minute", async () => {
    setMatching(POPUP_SHORT_QUERY);
    const onApply = vi.fn();
    const popup = await open(onApply);
    expect(slots(popup)).toBeNull();
    expect(popup.textContent).not.toContain("or pick a slot");
    await typePopupTime(popup, "17:07");
    await applyPopup(popup);
    expect(onApply).toHaveBeenCalledWith({ localCivil: "2026-10-15T17:07" });
  });

  it("the title and zone scroll with the body instead of being pinned above it", async () => {
    setMatching(POPUP_SHORT_QUERY);
    const popup = await open();
    expect(title(popup)).toBeDefined();
    expect(body(popup).contains(title(popup))).toBe(true);
    expect(popup.querySelector(`#${CSS.escape(popup.getAttribute("aria-describedby") ?? "none")}`)).not.toBeNull();
  });

  it("stacked and short: the calendar comes before the shortcuts", async () => {
    setMatching(POPUP_SHORT_QUERY, POPUP_STACKED_QUERY);
    const popup = await open();
    expect(follows(grid(popup), shortcuts(popup))).toBe(true);
  });

  it("tall: the slot list, the shortcuts-first order and the pinned title are unchanged", async () => {
    setMatching(POPUP_STACKED_QUERY);
    const popup = await open();
    expect(slots(popup)).not.toBeNull();
    expect(follows(shortcuts(popup), grid(popup))).toBe(true);
    expect(body(popup).contains(title(popup))).toBe(false);
    expect(popup.textContent).toContain("or pick a slot");
  });

  it("flipping short to tall while open keeps the draft", async () => {
    setMatching(POPUP_SHORT_QUERY);
    const popup = await open();
    await typePopupTime(popup, "17:07");
    await act(async () => { setMatching(); await Promise.resolve(); });
    await settle();
    const after = dateTimePopup("Deadline")!;
    expect(slots(after)).not.toBeNull();
    expect(popupTimeInput(after).value).toBe("17:07");
    expect(popupDraft(after)).toEqual({ day: "2026-10-15", time: "17:07" });
  });
});

describe("an empty field late in the month (#686)", () => {
  const LATE = new Date("2026-10-28T02:00:00Z"); // Wed 28 Oct, 13:00 in Sydney
  const focusedDay = () => (document.activeElement as HTMLElement | null)?.closest("td[data-day]")?.getAttribute("data-day") ?? null;

  it("short: opening focus lands on today, not the calendar's first control", async () => {
    vi.setSystemTime(LATE);
    setMatching(POPUP_SHORT_QUERY, POPUP_STACKED_QUERY);
    await open(vi.fn(), null);
    expect(focusedDay()).toBe("2026-10-28");
  });

  it("tall: opening focus is unchanged", async () => {
    vi.setSystemTime(LATE);
    setMatching(POPUP_STACKED_QUERY);
    await open(vi.fn(), null);
    expect(focusedDay()).toBeNull();
  });
});
