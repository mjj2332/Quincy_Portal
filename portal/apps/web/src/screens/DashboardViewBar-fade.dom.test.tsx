/**
 * #652 -- the view tab row scrolls sideways at phone widths (the "Timeline" tab clips at 320) and gives no cue.
 * It reports which side has more content through `data-fade` (`useScrollFade`). Asserts the attribute, never a class.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardViewBar } from "./DashboardViewBar";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

describe("DashboardViewBar tab row scroll fade (#652)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let sizes = { scrollWidth: 0, clientWidth: 0 };
  const originals = {
    scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  };

  beforeEach(() => {
    __resetDashboardSearchStoreForTest();
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => sizes.scrollWidth });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => sizes.clientWidth });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    for (const key of ["scrollWidth", "clientWidth"] as const) {
      if (originals[key]) Object.defineProperty(HTMLElement.prototype, key, originals[key]!);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  async function mount() {
    await act(async () => {
      root.render(<DashboardViewBar renderedView="table" canViewProductionCalendar disabled={false} onSelectView={() => undefined} principalId="u1" searchFocusRequest={null} onSearchFocusHandled={() => undefined} />);
      await Promise.resolve();
    });
    return host.querySelector('[aria-label="Dashboard view"]')!.closest<HTMLElement>("[data-fade]");
  }

  it("is none when every tab fits", async () => {
    sizes = { scrollWidth: 300, clientWidth: 300 };
    expect((await mount())?.getAttribute("data-fade")).toBe("none");
  });

  it("is end when the row overflows and rests at its start", async () => {
    sizes = { scrollWidth: 420, clientWidth: 300 };
    expect((await mount())?.getAttribute("data-fade")).toBe("end");
  });

  it("is both once scrolled into the middle, and start at the end", async () => {
    sizes = { scrollWidth: 420, clientWidth: 300 };
    const scroller = (await mount())!;
    await act(async () => { scroller.scrollLeft = 50; scroller.dispatchEvent(new Event("scroll", { bubbles: true })); await Promise.resolve(); });
    expect(scroller.getAttribute("data-fade")).toBe("both");
    await act(async () => { scroller.scrollLeft = 120; scroller.dispatchEvent(new Event("scroll", { bubbles: true })); await Promise.resolve(); });
    expect(scroller.getAttribute("data-fade")).toBe("start");
  });
});
