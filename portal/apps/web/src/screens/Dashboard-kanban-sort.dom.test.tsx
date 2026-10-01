// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance items.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { checkedSortLabel, chooseSort, displayMenu, displayTrigger, openDisplay, sortRadioLabels, sortRadios } from "./dashboard-display-test-helpers";

// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Board's horizontal
// scroll, `kanban2/board.tsx`) calls on a timer after mount. The no-op stub means "no active
// animations"; see `reui/gantt/gantt-adjust-ghost-marker.dom.test.tsx` for the same polyfill.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
// With `getAnimations` defined, Base UI's `useAnimationsFinished` stops unmounting a closing popup
// synchronously and waits on the (empty) animation list asynchronously, which the Sort Select's
// close assertions below do not flush. Base UI's own switch keeps closes synchronous, exactly as they
// were when `getAnimations` was missing.
(globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean }).BASE_UI_ANIMATIONS_DISABLED = true;

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["prioritizeProjects", "moveProjectStage", "adminBackend"], can: (capability: string) => capability === "prioritizeProjects" || capability === "moveProjectStage" || capability === "adminBackend" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true }],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testNow = new Date("2026-08-27T00:00:00.000Z");

describe("Dashboard Kanban sort control", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: testNow });
    window.history.replaceState(null, "", "/");
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-1", street: "1 Test Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: "2026-01-01", coverAssetId: null, receivedCount: 12,
      expectedCount: 40, priority: 1, boardPosition: 0, deadlineAt: Date.parse("2027-01-14T22:00:00.000Z"), deadlineLocalCivil: "2027-01-15T09:00", deadlineZone: "Australia/Sydney",
      boardRevision: 0,
    }], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["project-1"] } } }) : Promise.resolve({ stages: [] }));
    apiPostMock.mockReset().mockResolvedValue({ changed: true, project: { stageKey: "awaiting_raw", boardRevision: 1 } });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("hides only reorder arrows when shoot-date sorting is selected", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="Move 1 Test Street up"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Move 1 Test Street down"]')).not.toBeNull();
    const priority = document.querySelector('[aria-label="Priority for 1 Test Street"]');
    expect(priority).not.toBeNull();

    await chooseSort("Shoot date ↑");

    expect(document.querySelector('[aria-label="Move 1 Test Street up"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move 1 Test Street down"]')).toBeNull();
    expect(document.querySelector('[aria-label="Priority for 1 Test Street"]')).toBe(priority);
  });

  it("renders the Sydney deadline and exposes RAW on the Kanban card", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    const card = document.querySelector('[data-testid="kanban2-card"]')!;
    expect(card.querySelector('[data-testid="kanban2-card-deadline"]')?.textContent).toContain("Due 2027-01-15 09:00 Sydney");
    const raw = card.querySelector('[data-testid="kanban2-card-raw"]')!;
    expect(raw.querySelector('[aria-hidden="true"]')?.textContent).toBe("12/40");
    expect(raw.querySelector('[aria-hidden="true"] + span')?.textContent).toBe("12 of 40 RAW files received");
    expect(card.querySelector('[data-testid="kanban2-card-deadline"]')?.getAttribute("dateTime")).toBe("2027-01-14T22:00:00.000Z");
    expect(card.getAttribute("href")).toBe("/projects/project-1");
    expect(card.getAttribute("target")).toBeNull();

    await act(async () => { (document.querySelector('[aria-label="Dashboard view"] [role="tab"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="project-list-row"]')?.getAttribute("href")).toBe("/projects/project-1");
    expect(document.querySelector('[data-testid="project-list-row-raw"]')?.textContent).toBe("12");
  });

  it("renders the current overdue label and keeps archived Dashboard scope List-only", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/projects" || path === "/api/projects?archived=1" ? Promise.resolve({ projects: [{
      id: "archived-project", street: "Archived Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 4, expectedCount: null, priority: null,
      boardPosition: 10, deadlineAt: Date.parse("2020-01-01T00:00:00.000Z"), deadlineLocalCivil: "2020-01-01T11:00", deadlineZone: "Australia/Sydney", boardRevision: 1,
    }], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["archived-project"] } } }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="kanban2-card"] [data-testid="kanban2-card-deadline"]')?.textContent).toContain("Overdue 2020-01-01 11:00 Sydney");

    await act(async () => { (document.querySelector('[aria-label="Project status"] button:last-child') as HTMLButtonElement).click(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="project-list-row"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="Project pipeline board"]')).toBeNull();
    // The tabs stay (until #428 moves the scope switch); an archived scope shows Table.
    const tabs = [...document.querySelectorAll<HTMLElement>('[aria-label="Dashboard view"] [role="tab"]')];
    expect(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Table");
    expect(displayTrigger()).toBeNull();
  });

  // The Display menu replaced the Kanban sort `Select` (#427). The old `Select`'s ten release-blocking
  // accessibility tests are carried over here for the menu: open/close, keyboard, commit, dismissal,
  // the disabled lock, the Priority gate and touch-target geometry. Real-browser focus timing stays
  // a design-reviewer/Agy item (happy-dom has no real focus management for floating popups).
  describe("Display menu accessibility contract", () => {
    async function renderBoard() {
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    }
    const trigger = () => displayTrigger()!;

    it("1. opens on trigger click and closes on a second click", async () => {
      await renderBoard();
      expect(displayMenu()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      await openDisplay();
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
      expect(displayMenu()).toBeNull();
    });

    it("2. the menu is a labelled group of radio items, one checked (the current sort)", async () => {
      await renderBoard();
      await openDisplay();
      expect(sortRadioLabels()).toEqual(["Board order", "Priority", "Shoot date ↑", "Shoot date ↓"]);
      expect(sortRadios().filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);
      expect(checkedSortLabel()).toBe("Board order");
      expect(document.querySelector('[role="menu"]')!.textContent).toContain("Sort Board");
    });

    it("3. ArrowDown on the focused trigger opens the menu", async () => {
      await renderBoard();
      trigger().focus();
      await act(async () => { trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
      expect(displayMenu()).not.toBeNull();
    });

    it("4. choosing an option commits it and checks it", async () => {
      await renderBoard();
      await chooseSort("Shoot date ↓");
      expect(window.localStorage.getItem("quincy:dashboard:kanbanSort")).toBe("shootDate-desc");
      await openDisplay();
      expect(checkedSortLabel()).toBe("Shoot date ↓");
    });

    it("5. Escape closes the menu without selecting a new value", async () => {
      await renderBoard();
      await openDisplay();
      await act(async () => { displayMenu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
      expect(displayMenu()).toBeNull();
      expect(window.localStorage.getItem("quincy:dashboard:kanbanSort")).toBe("board");
    });

    it("6. outside click dismisses without selecting", async () => {
      await renderBoard();
      await openDisplay();
      await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
      expect(displayMenu()).toBeNull();
      expect(window.localStorage.getItem("quincy:dashboard:kanbanSort")).toBe("board");
    });

    it("7. disabled blocks opening entirely", async () => {
      // The interactionBlocked path itself (drag/pending-move in progress) is covered end-to-end in
      // Dashboard-stage-interactions.dom.test.tsx; this asserts the control-level contract.
      await renderBoard();
      trigger().disabled = true;
      await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
      expect(displayMenu()).toBeNull();
    });

    it("8. Priority gate, presence half: offered when authorized", async () => {
      // The absence half is Dashboard-kanban-sort-priority-render-gate.dom.test.tsx; the handler
      // half is Dashboard-kanban-sort-priority-guard.dom.test.tsx.
      await renderBoard();
      await openDisplay();
      expect(sortRadioLabels()).toContain("Priority");
    });

    it("9. the selected value is exposed as the checked radio", async () => {
      await renderBoard();
      await chooseSort("Priority");
      await openDisplay();
      expect(checkedSortLabel()).toBe("Priority");
    });

    it("10. touch target geometry — the trigger carries the 44px minimum-target class at phone width", async () => {
      window.innerWidth = 390;
      window.innerHeight = 844;
      await renderBoard();
      expect(trigger().className).toContain("max-[721px]:min-h-[44px]");
      // Full popup-within-viewport geometry needs a real layout engine: the Agy real-browser pass.
    });

    it("11. only the Board tab offers Display", async () => {
      await renderBoard();
      expect(displayTrigger()).not.toBeNull();
      const tabs = [...document.querySelectorAll<HTMLElement>('[aria-label="Dashboard view"] [role="tab"]')];
      await act(async () => { tabs.find((tab) => tab.textContent === "Table")!.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(displayTrigger()).toBeNull();
    });

    it("12. the radio items are exactly the sort modes the Board understands", async () => {
      await renderBoard();
      await openDisplay();
      expect(sortRadios()).toHaveLength(4);
    });
  });


  // #98 §2.2. PriorityStars owns the focused radio while its write is pending; the new Board keeps
  // that node mounted because `priorityEditable` deliberately omits `pendingOrdering`. This is the
  // Dashboard sort-suite pin that the post-write refresh does not steal focus to the Board root.
  it("keeps focus on the Priority star after its write refreshes the Board (#98)", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());

    const group = document.querySelector<HTMLElement>('[aria-label="Priority for 1 Test Street"]');
    expect(group, "no Priority control rendered — every assertion below would be vacuous").not.toBeNull();
    // Anchor: tier 3's target must exist, or this could pass because there was nothing to steal to.
    expect(document.querySelector('[data-focus-key="board"]'), "no tier-3 target — the steal could not be observed").not.toBeNull();

    const third = group!.querySelectorAll<HTMLElement>('[role="radio"]')[2];
    expect(third, "fewer than three Priority stars rendered").not.toBeUndefined();
    third!.focus();
    expect(document.activeElement).toBe(third);

    await act(async () => { third!.click(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); await Promise.resolve(); });

    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/project-1/priority", { priority: 3 });
    expect(document.contains(third!), "the Priority control was unmounted mid-write — focus cannot survive that").toBe(true);
    expect(
      document.activeElement === third!,
      `focus moved to ${document.activeElement?.getAttribute("data-focus-key") ?? document.activeElement?.tagName} after the Priority write`,
    ).toBe(true);
  });
});
