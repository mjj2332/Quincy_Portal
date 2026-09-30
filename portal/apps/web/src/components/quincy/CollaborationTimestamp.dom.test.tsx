import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { TooltipProvider } from "../reui/tooltip";
import { formatAbsoluteTime, formatDayGroupedTime, formatRelativeTime } from "../../lib/date-format";
import { CollaborationTimestamp } from "./CollaborationTimestamp";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTANT = "2026-09-30T05:04:00.000Z";
const NOW = Date.parse("2026-09-30T05:20:00.000Z");

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return host;
}
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    await Promise.resolve();
  });
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 40 && !predicate(); index += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("CollaborationTimestamp", () => {
  it("renders exactly one <time dateTime> with the relative text visible", async () => {
    const host = await mount(<CollaborationTimestamp instant={INSTANT} now={NOW} mode="relative" />);
    const times = host.querySelectorAll("time");
    expect(times).toHaveLength(1);
    expect(times[0]!.getAttribute("datetime")).toBe(INSTANT);
    expect(times[0]!.textContent).toBe(formatRelativeTime(INSTANT, NOW));
    expect(times[0]!.textContent).toBe("16m ago");
  });

  it("dayGrouped mode shows the day-grouped clock text", async () => {
    const host = await mount(<CollaborationTimestamp instant={INSTANT} now={NOW + 2 * 86_400_000} mode="dayGrouped" />);
    expect(host.querySelector("time")!.textContent).toBe(formatDayGroupedTime(INSTANT, NOW + 2 * 86_400_000));
  });

  it("carries the absolute date for assistive tech as sr-only text", async () => {
    const host = await mount(<CollaborationTimestamp instant={INSTANT} now={NOW} mode="relative" />);
    const hidden = host.querySelector('[data-testid="collaboration-timestamp-absolute"]');
    expect(hidden?.textContent).toContain(formatAbsoluteTime(INSTANT));
    expect(formatAbsoluteTime(INSTANT)).toBe("30 Sep 2026, 3:04 PM");
  });

  it("is not a tab stop: no extra focus target per comment", async () => {
    const host = await mount(<CollaborationTimestamp instant={INSTANT} now={NOW} mode="relative" />);
    const time = host.querySelector("time")!;
    expect(time.getAttribute("tabindex")).toBeNull();
    expect(host.querySelectorAll("a[href], button, [tabindex]")).toHaveLength(0);
  });

  it("hover opens a tooltip with the absolute text, inside the overlay container when one is provided", async () => {
    const slot = document.createElement("div");
    slot.setAttribute("data-testid", "overlay-slot");
    document.body.append(slot);
    const host = await mount(<TooltipProvider delay={0}><OverlayContainerContext.Provider value={slot}><CollaborationTimestamp instant={INSTANT} now={NOW} mode="relative" /></OverlayContainerContext.Provider></TooltipProvider>);
    await hover(host.querySelector("time")!);
    await until(() => slot.textContent?.includes("30 Sep 2026, 3:04 PM") ?? false);
    expect(slot.textContent).toContain("30 Sep 2026, 3:04 PM");
  });
});
