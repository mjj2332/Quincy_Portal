// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance items.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

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
      stageKey: "awaiting_raw", shootDate: "2026-01-01", coverAssetId: null, receivedCount: 7,
      expectedCount: null, priority: 1, boardPosition: 0, deadlineAt: Date.parse("2027-01-14T22:00:00.000Z"), deadlineLocalCivil: "2027-01-15T09:00", deadlineZone: "Australia/Sydney",
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
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="Move project up"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).not.toBeNull();
    const priority = document.querySelector('select[aria-label="Priority"]');
    expect(priority).not.toBeNull();

    const sortTrigger = document.querySelector<HTMLButtonElement>('[aria-label="Sort Kanban board"][role="combobox"]');
    expect(sortTrigger).not.toBeNull();
    await act(async () => {
      sortTrigger!.click();
      await Promise.resolve();
    });
    const shootDateOption = [...document.querySelectorAll<HTMLElement>('[aria-label="Sort Kanban board"][role="listbox"] [role="option"]')]
      .find((option) => option.textContent === "Shoot date ↑");
    expect(shootDateOption).not.toBeUndefined();
    await act(async () => {
      shootDateOption!.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).toBeNull();
    expect(document.querySelector('select[aria-label="Priority"]')).toBe(priority);
  });

  it("keeps Priority available while the Board mutation flag is off", async () => {
    apiGetMock.mockImplementationOnce((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-flag-off", street: "Flag Off Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null,
      priority: 1, boardPosition: 0, boardRevision: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
    }], board: { contractEnabled: false, orderedProjectIdsByStage: { awaiting_raw: ["project-flag-off"] } } }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());
    expect(document.querySelector('select[aria-label="Priority"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="kanban-card-footer"]')?.textContent).toContain("Priority 1");
    expect(document.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move project down"]')).toBeNull();
    expect(document.querySelector('[aria-label="Move Flag Off Street to…"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Move Flag Off Street"]')?.disabled).toBe(true);
  });

  it("renders the Sydney deadline on Kanban cards and keeps RAW out of the card footer", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());
    const card = document.querySelector('[data-testid="kanban-card"]')!;
    expect(card.querySelector('[data-testid="kanban-card-deadline"]')?.textContent).toContain("Due 2027-01-15 09:00 Sydney");
    expect(card.querySelector('[data-testid="kanban-card-footer"]')?.textContent).not.toContain("RAW");
    expect(card.querySelector('[data-testid="kanban-card-deadline"]')?.getAttribute("dateTime")).toBe("2027-01-14T22:00:00.000Z");
    expect(card.getAttribute("href")).toBe("/projects/project-1");
    expect(card.getAttribute("target")).toBeNull();

    await act(async () => { (document.querySelector('[aria-label="Dashboard view"] button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="project-list-row"]')?.getAttribute("href")).toBe("/projects/project-1");
    expect(document.querySelector('[data-testid="project-list-row-raw"]')?.textContent).toBe("7");
  });

  it("renders the current overdue label and keeps archived Dashboard scope List-only", async () => {
    apiGetMock.mockImplementation((path) => path === "/api/projects" || path === "/api/projects?archived=1" ? Promise.resolve({ projects: [{
      id: "archived-project", street: "Archived Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 4, expectedCount: null, priority: null,
      boardPosition: 10, deadlineAt: Date.parse("2020-01-01T00:00:00.000Z"), deadlineLocalCivil: "2020-01-01T11:00", deadlineZone: "Australia/Sydney", boardRevision: 1,
    }], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["archived-project"] } } }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="kanban-card"] [data-testid="kanban-card-deadline"]')?.textContent).toContain("Overdue 2020-01-01 11:00 Sydney");

    await act(async () => { (document.querySelector('[aria-label="Project status"] button:last-child') as HTMLButtonElement).click(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="project-list-row"]')).not.toBeNull());
    expect(document.querySelector('[aria-label="Project pipeline board"]')).toBeNull();
    expect(document.querySelector('[aria-label="Dashboard view"]')).toBeNull();
  });

  // TB8-01 §2.2 — the ten release-blocking accessibility tests for the Select primitive that
  // replaced the bare native <select> for Kanban sort. Touch/phone geometry (item 10) is a
  // best-effort structural proxy here (happy-dom has no real layout engine); real reachability at
  // 390×844 is the Agy real-browser pass §2.2 also requires.
  describe("Sort Select accessibility contract", () => {
    async function renderBoard() {
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());
    }
    function trigger() { return document.querySelector<HTMLButtonElement>('[aria-label="Sort Kanban board"][role="combobox"]')!; }
    function listbox() { return document.querySelector<HTMLElement>('[aria-label="Sort Kanban board"][role="listbox"]'); }
    function options() { return [...document.querySelectorAll<HTMLElement>('[aria-label="Sort Kanban board"][role="listbox"] [role="option"]')]; }

    it("1. opens on trigger click and closes on a second click", async () => {
      await renderBoard();
      expect(listbox()).toBeNull();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      expect(listbox()).not.toBeNull();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      expect(listbox()).toBeNull();
    });

    // Space-to-open on the trigger was probed directly, four separate times with different
    // dispatch strategies (keydown alone, keydown+keyup, with/without `code: "Space"`) — all
    // consistently do not open the popup here, unlike ArrowDown (2b, below) and Enter-to-commit
    // (test 4), both of which DO work under direct dispatch. Base UI's Popup imports
    // `InteractionType` from `@base-ui/utils/useEnhancedClickHandler`, which floating-ui uses to
    // distinguish real pointer/keyboard interaction by timing; unlike `openOnArrowKeyDown`'s plain
    // state toggle, Space-to-open plausibly goes through that timing-sensitive path, which
    // happy-dom's synthetic event dispatch does not reproduce. Escalated to the plan's QA
    // acceptance section as a required real-browser verification item (same as Escape's
    // focus-return, test 5) rather than asserted here as if it passed.

    it("2b. ArrowDown on the focused trigger opens the popup (no prior click)", async () => {
      await renderBoard();
      trigger().focus();
      expect(listbox()).toBeNull();
      await act(async () => { trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(listbox()).not.toBeNull();
      const highlighted = options().find((option) => option.getAttribute("data-highlighted") !== null);
      expect(highlighted).not.toBeUndefined();
    });

    it("2c. ArrowDown, once open, moves the highlight forward", async () => {
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      const before = options().find((option) => option.getAttribute("data-highlighted") !== null || option.getAttribute("aria-selected") === "true");
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); });
      const after = options().find((option) => option.getAttribute("data-highlighted") !== null);
      expect(after).not.toBeUndefined();
      expect(after).not.toBe(before);
    });

    it("2d. ArrowUp, once open, moves the highlight backward", async () => {
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); await Promise.resolve(); });
      const atEnd = options().find((option) => option.getAttribute("data-highlighted") !== null);
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); await Promise.resolve(); });
      const afterUp = options().find((option) => option.getAttribute("data-highlighted") !== null);
      expect(afterUp).not.toBeUndefined();
      expect(afterUp).not.toBe(atEnd);
      expect(afterUp).toBe(options().at(-2));
    });

    it("3. Home/End jump to the first and last option", async () => {
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(options().at(-1)?.getAttribute("data-highlighted")).not.toBeNull();
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(options()[0]?.getAttribute("data-highlighted")).not.toBeNull();
    });

    it("4. Enter commits the highlighted option and closes the popup", async () => {
      // Base UI's Select.Item is a non-native `role="option"` element (useButton with
      // `native: false`); useButton.mjs's non-native branch explicitly synthesizes a click on a
      // real Enter keydown (dispatchClickWithModifiers), so this is a genuine JS-level code path,
      // not deferred to native <button> browser semantics — it works under direct dispatch as
      // long as the event targets the highlighted item itself (verified directly; dispatching on
      // the list/listbox container instead does not reach the item's own listener).
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); await Promise.resolve(); });
      const highlighted = options().find((option) => option.getAttribute("data-highlighted") !== null)!;
      expect(highlighted.textContent).toBe("Shoot date ↓");
      await act(async () => { highlighted.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(listbox()).toBeNull();
      expect(trigger().textContent).toContain("Shoot date ↓");
    });

    it("5. Escape closes the popup without selecting a new value", async () => {
      // Escape's close-without-select half is verified directly here. Focus returning to the
      // trigger afterward depends on Base UI's floating-ui focus-management (a `document.activeElement`
      // move), which does not reproduce under happy-dom even after flushing every microtask and
      // fake-timer tick available (probed directly, several strategies, all landing focus on an
      // unrelated ancestor element instead of the trigger) — unlike Enter-to-commit above, this one
      // is plausibly a genuine DOM-focus-timing gap in the test environment, not a mistaken
      // substitution. Tracked as a required real-browser QA item in the plan's acceptance criterion
      // 18, not silently treated as covered here.
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      const before = trigger().textContent;
      await act(async () => { listbox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(listbox()).toBeNull();
      expect(trigger().textContent).toBe(before);
    });

    it("6. outside click dismisses without selecting", async () => {
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      const before = trigger().textContent;
      await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      expect(listbox()).toBeNull();
      expect(trigger().textContent).toBe(before);
    });

    it("7. disabled blocks opening entirely — no popover, no focus trap", async () => {
      // The interactionBlocked path itself (drag/pending-move in progress) is covered end-to-end
      // in Dashboard-stage-interactions.dom.test.tsx ("locks Kanban sorting…"). This asserts the
      // primitive-level contract: a disabled trigger never opens on click.
      await renderBoard();
      trigger().disabled = true;
      await act(async () => { trigger().click(); await Promise.resolve(); });
      expect(listbox()).toBeNull();
    });

    it("8. Priority gate — render-gate presence half: rendered when authorized", async () => {
      // This proves only that the option IS offered to an authorized user. The render-gate
      // ABSENCE half (an unauthorized user never sees it) is Dashboard-kanban-sort-priority-render-gate.dom.test.tsx,
      // and the client-side guard half — `selectKanbanSort`'s `next === "priority" &&
      // (!canPrioritize || !hasAuthorizedBoardMap)` check at Dashboard.tsx:636 — is
      // Dashboard-kanban-sort-priority-guard.dom.test.tsx, which mocks Select to invoke
      // onValueChange("priority") past the render gate so the guard itself (not just Select's own
      // option filtering) is what's proven to refuse it. All three together are §2.2 item 8.
      await renderBoard();
      await act(async () => { trigger().click(); await Promise.resolve(); });
      expect(options().some((option) => option.textContent === "Priority")).toBe(true);
    });

    it("9. selected value is exposed on the trigger", async () => {
      await renderBoard();
      expect(trigger().textContent).toContain("Board order");
      await act(async () => { trigger().click(); await Promise.resolve(); });
      const priority = options().find((option) => option.textContent === "Priority")!;
      await act(async () => { priority.click(); await Promise.resolve(); });
      expect(trigger().textContent).toContain("Priority");
    });

    it("10. touch target geometry at 390×844 — trigger and options carry the 44px minimum-target classes", async () => {
      window.innerWidth = 390;
      window.innerHeight = 844;
      await renderBoard();
      expect(trigger().className).toContain("min-h-[44px]");
      await act(async () => { trigger().click(); await Promise.resolve(); });
      expect(options().every((option) => option.className.includes("min-h-[44px]"))).toBe(true);
      // Full popover-within-viewport geometry needs a real layout engine (Base UI's Positioner
      // collision/flip handling) — not verified here; pending the Agy real-browser pass (plan
      // acceptance criterion 17), which has not yet run for this candidate.
    });
  });


  // #98 §2.2, on the Board that is still the default. `setProjectPriority` queues a dashboard
  // refresh whose `captureFocusForRefresh()` is called with NO arguments, recording
  // `{ key: null, fallbackStageKey: undefined }`. The restore effect used to skip tier 1 and tier 2
  // and run tier 3 — `[data-focus-key="board"]`.focus() — pulling focus to the Board root after a
  // write the user made from a control that simply carries no focus key.
  //
  // This asserts only that the steal is gone, because focus cannot be *kept* on this Board:
  // `ProjectKanbanBoard.tsx:575` folds `!pendingOrdering.has(project.id)` into `canPrioritize`, so
  // the old Board unmounts its own Priority `<select>` while the write is in flight and remounts a
  // different node afterwards. That is a second, separate defect of the old Board — deliberately not
  // reproduced on the new Board, where `priorityEditable` omits `pendingOrdering` and the equivalent
  // assertion in `Dashboard-kanban2-parity.dom.test.tsx` does require focus to survive intact.
  it("does not pull focus to the Board root after a Priority write (#98)", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban-card"]')).not.toBeNull());

    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Priority"]');
    expect(select, "no Priority control rendered — every assertion below would be vacuous").not.toBeNull();
    // Anchor: tier 3's target must exist, or this could pass because there was nothing to steal to.
    expect(document.querySelector('[data-focus-key="board"]'), "no tier-3 target — the steal could not be observed").not.toBeNull();

    select!.focus();
    expect(document.activeElement).toBe(select);

    select!.value = "3";
    await act(async () => { select!.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); await Promise.resolve(); });

    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/project-1/priority", { priority: 3 });
    expect(
      document.activeElement?.getAttribute("data-focus-key"),
      "the post-write refresh pulled focus to the Board root",
    ).not.toBe("board");
  });
});
