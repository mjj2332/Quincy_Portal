/**
 * #463 — the two additive consumer seams the Timeline's item menu needs, driven through the REAL
 * bar. Quincy-authored, not a ReUI vendored file (ADR 0009).
 *
 * - `onEventContextMenu(occurrence, e)`: a right-click on a bar tells the consumer. The vendor never
 *   prevents the native menu itself. It stays quiet during a live drag or Adjust session, when the
 *   `renderEventMenu` ContextMenu owns the right-click, and when the setting is unset.
 * - `eventPopup` (view config): a bar whose consumer opens a menu from it says so
 *   (`aria-haspopup="menu"`, `aria-expanded`) instead of announcing itself as a pressed toggle, and
 *   keeps its application role while Adjust holds the keyboard. Unset, the bar keeps `aria-pressed`.
 * - The Enter that commits a keyboard Adjust session fires no `onEventClick` (it is the consumer's
 *   menu-open path, so a commit must never open it).
 *
 * Seams: bars are found by their visible title, never by a vendor-authored `data-slot` (guard F).
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, useGanttSelector } from "@/components/reui/gantt/gantt";
import { GanttBar } from "@/components/reui/gantt/gantt-bar";
import type { GanttEvent, GanttOccurrence, GanttSegment } from "@/components/reui/gantt/gantt-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
});

const START = new Date("2026-03-02T09:00:00.000Z");
const END = new Date("2026-03-02T10:00:00.000Z");
const EVENTS: GanttEvent[] = [{ id: "bar-1", title: "Gantt shoot", start: START, end: END }];

function BarHost({ eventId }: { eventId: string }) {
  const instance = useGantt();
  const occurrence = useGanttSelector((): GanttOccurrence | null => instance.api.getOccurrences().find((occ) => occ.eventId === eventId) ?? null);
  if (!occurrence) return null;
  const segment: GanttSegment = { occurrence, day: occurrence.start, isStart: true, isEnd: true, continuesBefore: false, continuesAfter: false };
  return <div key={occurrence.key}><GanttBar segment={segment} /></div>;
}

async function mount(props: Record<string, unknown> = {}, children: ReactNode = <BarHost eventId="bar-1" />) {
  await act(async () => {
    root.render(<Gantt events={EVENTS} date={START} timeZone="UTC" {...props}>{children}</Gantt>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function bar(): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Gantt shoot"));
  if (!found) throw new Error("no bar");
  return found as HTMLButtonElement;
}

async function contextmenu(target: HTMLElement): Promise<MouseEvent> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 12, clientY: 8 });
  await act(async () => { target.dispatchEvent(event); await Promise.resolve(); });
  return event;
}

async function keydown(el: HTMLElement, key: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Promise.resolve(); });
}

describe("onEventContextMenu (#463)", () => {
  it("reports the right-clicked occurrence and leaves the native menu to the consumer", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu });
    const event = await contextmenu(bar());
    expect(onEventContextMenu).toHaveBeenCalledTimes(1);
    const [occurrence, received] = onEventContextMenu.mock.calls[0] as [GanttOccurrence, React.MouseEvent];
    expect(occurrence.eventId).toBe("bar-1");
    expect(received.clientX).toBe(12);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when the setting is unset", async () => {
    await mount();
    const event = await contextmenu(bar());
    expect(event.defaultPrevented).toBe(false);
  });

  it("swallows a touch-origin contextmenu even while a drag or Adjust guard returns early, and leaves a mouse one alone", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu });
    act(() => bar().focus());
    await keydown(bar(), " ");
    expect(bar().getAttribute("data-adjusting")).toBe("true");
    const touch = new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch" });
    await act(async () => { bar().dispatchEvent(touch); await Promise.resolve(); });
    expect(touch.defaultPrevented, "the touch long-press's native menu is prevented").toBe(true);
    const mouse = await contextmenu(bar());
    expect(mouse.defaultPrevented).toBe(false);
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });

  it("does not report during a live keyboard Adjust session", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu });
    act(() => bar().focus());
    await keydown(bar(), " ");
    expect(bar().getAttribute("data-adjusting")).toBe("true");
    await contextmenu(bar());
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });

  it("does not report when renderEventMenu's own ContextMenu owns the right-click", async () => {
    const onEventContextMenu = vi.fn();
    await mount({ onEventContextMenu, renderEventMenu: () => <div role="menuitem">Custom</div> });
    await contextmenu(bar());
    expect(onEventContextMenu).not.toHaveBeenCalled();
  });
});

describe("eventPopup (#463)", () => {
  it("swaps the pressed toggle for a menu popup state that follows the consumer's open item", async () => {
    await mount({ eventPopup: { isOpen: () => false } });
    expect(bar().getAttribute("aria-haspopup")).toBe("menu");
    expect(bar().getAttribute("aria-expanded")).toBe("false");
    expect(bar().hasAttribute("aria-pressed")).toBe(false);
    await mount({ eventPopup: { isOpen: () => true } });
    expect(bar().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the pressed toggle when the setting is unset", async () => {
    await mount();
    expect(bar().getAttribute("aria-pressed")).toBe("false");
    expect(bar().hasAttribute("aria-haspopup")).toBe(false);
    expect(bar().hasAttribute("aria-expanded")).toBe(false);
  });

  it("drops the popup state while Adjust owns the bar, so its application role stays clean", async () => {
    await mount({ eventPopup: { isOpen: () => false } });
    act(() => bar().focus());
    await keydown(bar(), " ");
    expect(bar().getAttribute("role")).toBe("application");
    expect(bar().hasAttribute("aria-haspopup")).toBe(false);
    expect(bar().hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("the Adjust commit (#463)", () => {
  it("an Enter that commits a keyboard Adjust session fires no onEventClick", async () => {
    const onEventClick = vi.fn();
    const onEventUpdate = vi.fn(() => "deferred" as const);
    await mount({ onEventClick, onEventUpdate });
    act(() => bar().focus());
    await keydown(bar(), " ");
    await keydown(bar(), "ArrowRight");
    await keydown(bar(), "Enter");
    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(onEventClick).not.toHaveBeenCalled();
  });
});
