/**
 * #923 S2 — the Dashboard's one-row header (frames 4a, 4a-t, 4a-s, and the phone row of 4f / 4g).
 *
 * The bar picks its layout from its own width (`viewBarLayout`), so these tests drive the width the
 * bar measures (`getBoundingClientRect`) and the viewport (`happyDOM.setViewport`, which is what
 * `matchMedia` answers from). Queries go by role and accessible name, never vendor `data-slot`.
 */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardViewBar, VIEW_TAB_ID, viewBarLayout } from "./DashboardViewBar";
import { __resetDashboardSearchStoreForTest, setDashboardSearchDraft } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

function setViewportWidth(width: number) {
  (window as unknown as { happyDOM: { setViewport(viewport: { width: number }): void } }).happyDOM.setViewport({ width });
}

let host: HTMLDivElement;
let root: Root;
let barWidth = 0;
const originalRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  __resetDashboardSearchStoreForTest();
  setViewportWidth(1440);
  barWidth = 0;
  vi.stubGlobal("ResizeObserver", undefined);
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = originalRect.call(this);
    if (this.getAttribute("data-testid") !== "dashboard-view-bar") return rect;
    return { ...rect.toJSON(), width: barWidth, right: barWidth, x: 0, left: 0, toJSON: () => ({}) } as DOMRect;
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  __resetDashboardSearchStoreForTest();
});

type Props = ComponentProps<typeof DashboardViewBar>;

async function mount(overrides: Partial<Props> = {}) {
  const props: Props = {
    renderedView: "board",
    canViewProductionCalendar: true,
    canCreateProject: true,
    disabled: false,
    onSelectView: () => undefined,
    principalId: "u1",
    searchFocusRequest: null,
    onSearchFocusHandled: () => undefined,
    display: <span>Display content</span>,
    filterTrigger: <button type="button" data-testid="dashboard-filter-trigger">Filter</button>,
    ...overrides,
  };
  await act(async () => { root.render(<DashboardViewBar {...props} />); await Promise.resolve(); });
  return props;
}

const bar = () => host.querySelector<HTMLElement>('[data-testid="dashboard-view-bar"]')!;
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const searchField = () => host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]');
const searchToggle = () => host.querySelector<HTMLButtonElement>('[data-testid="dashboard-search-toggle"]');
const newShoot = () => [...host.querySelectorAll("a")].find((node) => node.textContent?.trim() === "New shoot");
const displayButton = () => host.querySelector<HTMLButtonElement>('[data-testid="dashboard-display-trigger"]');
const picker = () => host.querySelector<HTMLButtonElement>('[data-testid="dashboard-view-picker"]');

describe("viewBarLayout — which row the bar draws at its own width (4a, 4a-t, 4a-s, 4f)", () => {
  it("is full at 1440 and down to 60rem, tablet below it, compact below 54rem", () => {
    expect(viewBarLayout(1288, { phone: false, narrowShell: false })).toBe("full");
    expect(viewBarLayout(960, { phone: false, narrowShell: false })).toBe("full");
    expect(viewBarLayout(872, { phone: false, narrowShell: false }), "1024 with the rail: 4a-t").toBe("tablet");
    expect(viewBarLayout(863, { phone: false, narrowShell: false })).toBe("compact");
    expect(viewBarLayout(620, { phone: false, narrowShell: false }), "772 with the rail").toBe("compact");
  });

  it("makes room for the nav trigger and the bell in a narrow shell: New shoot loses its label where they would not fit", () => {
    expect(viewBarLayout(672, { phone: false, narrowShell: true }), "768, no rail").toBe("compact");
    expect(viewBarLayout(626, { phone: false, narrowShell: true }), "722, no rail").toBe("tight");
  });

  it("is the phone row on a phone, whatever the width, and full before the bar has been measured", () => {
    expect(viewBarLayout(358, { phone: true, narrowShell: true })).toBe("phone");
    expect(viewBarLayout(0, { phone: false, narrowShell: false })).toBe("full");
  });
});

describe("the wide row (4a)", () => {
  it("is one row: the view tabs, then New shoot, the one search field, Filter and Display, in that order", async () => {
    await mount();
    expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(["Table", "Board", "Calendar", "Timeline"]);
    expect(host.querySelectorAll('[data-testid="dashboard-search"]')).toHaveLength(1);
    const order = [tabs()[0]!, newShoot()!, searchField()!, host.querySelector('[data-testid="dashboard-filter-trigger"]')!, displayButton()!];
    for (let index = 1; index < order.length; index++) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${index}`).toBeTruthy();
    }
    expect(searchToggle(), "the search is a field, not an icon, when it fits").toBeNull();
    expect(picker()).toBeNull();
  });

  it("offers New shoot only to a viewer who can create a Project, as a link to /projects/new", async () => {
    await mount();
    expect(newShoot()?.getAttribute("href")).toBe("/projects/new");
    await mount({ canCreateProject: false });
    expect(newShoot()).toBeUndefined();
  });

  it("draws the frame's sentence-case 14px controls on Quincy's control height", async () => {
    await mount();
    for (const control of [newShoot()!, displayButton()!]) {
      expect(control.className).toContain("normal-case");
      expect(control.className).toContain("[font:var(--type-label)]");
      expect(control.className).toContain("h-[38px]");
    }
  });

  it("has no nav trigger or bell outside a narrow shell", async () => {
    await mount();
    expect(host.querySelector('[data-testid="shell-header-sheet-trigger"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-notifications"]')).toBeNull();
  });

  it("narrows the search to 200px at the tablet width (4a-t)", async () => {
    barWidth = 900;
    await mount();
    expect(host.querySelector('[data-testid="dashboard-search-field"]')!.className).toContain("w-[12.5rem]");
    expect(searchToggle()).toBeNull();
  });
});

describe("the compact row (4a-s)", () => {
  beforeEach(() => { barWidth = 700; });

  it("shows only the current view's tab label; the others are icons that keep their name", async () => {
    await mount();
    const labels = tabs().map((tab) => [tab.textContent?.trim(), tab.querySelector("[data-tab-label]")?.classList.contains("sr-only")]);
    expect(labels).toEqual([["Table", true], ["Board", false], ["Calendar", true], ["Timeline", true]]);
  });

  it("collapses the search to an icon; the icon opens the one field and focuses it inside its own click", async () => {
    await mount();
    expect(host.querySelectorAll('[data-testid="dashboard-search"]')).toHaveLength(1);
    expect(host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!.hidden).toBe(true);
    expect(searchToggle()!.getAttribute("aria-expanded")).toBe("false");
    // iOS raises the keyboard only for a focus made inside the tap, on a field that is not hidden at
    // that moment (happy-dom focuses a `hidden` field anyway, so check the row when focus lands).
    let during: Element | null = null;
    let rowHiddenAtFocus: HTMLElement["hidden"] | null = null;
    const row = host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!;
    searchField()!.addEventListener("focus", () => { rowHiddenAtFocus = row.hidden; }, { once: true });
    await act(async () => { searchToggle()!.click(); during = document.activeElement; });
    expect(during, "focused within the tap, so iOS raises the keyboard").toBe(searchField());
    expect(rowHiddenAtFocus, "the row was unhidden before the focus call").toBe(false);
    expect(host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!.hidden).toBe(false);
    expect(searchToggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape in the empty field closes it and returns focus to the icon", async () => {
    await mount();
    await act(async () => { searchToggle()!.click(); });
    await act(async () => { searchField()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!.hidden).toBe(true);
    expect(document.activeElement).toBe(searchToggle());
  });

  it("stays open while the field holds a search, so the query is never hidden behind the icon", async () => {
    setDashboardSearchDraft("smith", "u1");
    await mount();
    expect(host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!.hidden).toBe(false);
    expect(searchField()!.value).toBe("smith");
  });

  it("opens for a ⌘K request so the field can take the focus", async () => {
    const onSearchFocusHandled = vi.fn();
    await mount({ searchFocusRequest: { signal: 1 }, onSearchFocusHandled });
    expect(onSearchFocusHandled).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(searchField());
    expect(host.querySelector<HTMLElement>('[data-testid="dashboard-search-row"]')!.hidden).toBe(false);
  });
});

describe("the phone row (4f, 4g)", () => {
  beforeEach(() => { setViewportWidth(390); barWidth = 358; });

  it("replaces the tabs with a view picker that labels the view region and names the current view", async () => {
    await mount({ renderedView: "board" });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(picker()!.id).toBe(VIEW_TAB_ID("board"));
    expect(picker()!.getAttribute("aria-label")).toBe("View: Board");
  });

  it("offers the views the role may see and chooses through onSelectView, the current one included", async () => {
    const onSelectView = vi.fn();
    await mount({ renderedView: "board", onSelectView, canViewProductionCalendar: false });
    await act(async () => { picker()!.click(); await Promise.resolve(); await Promise.resolve(); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Table", "Board"]);
    expect(items.find((item) => item.getAttribute("aria-checked") === "true")?.textContent?.trim()).toBe("Board");
    await act(async () => { items[0]!.click(); await Promise.resolve(); });
    expect(onSelectView).toHaveBeenLastCalledWith("table");
    await act(async () => { picker()!.click(); await Promise.resolve(); await Promise.resolve(); });
    const board = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === "Board")!;
    await act(async () => { board.click(); await Promise.resolve(); });
    expect(onSelectView).toHaveBeenLastCalledWith("board");
  });

  it("draws the actions as 44px icons that keep their names, New shoot last, and the search behind its icon", async () => {
    await mount();
    expect(displayButton()!.querySelector("[data-control-label]")!.classList.contains("sr-only")).toBe(true);
    expect(newShoot()!.querySelector("[data-control-label]")!.classList.contains("sr-only")).toBe(true);
    expect(displayButton()!.compareDocumentPosition(newShoot()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(searchToggle()).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="dashboard-search"]')).toHaveLength(1);
  });

  it("locks the picker while a board move or calendar write is in flight", async () => {
    await mount({ disabled: true });
    expect(picker()!.disabled || picker()!.getAttribute("aria-disabled") === "true").toBe(true);
  });
});

it("keeps the bar's rule on the row the tabs stand on", async () => {
  await mount();
  expect(bar().querySelector('[data-testid="dashboard-view-row"]')!.className).toContain("border-b-border");
});
