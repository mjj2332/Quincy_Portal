/**
 * #292 — a stale lazy chunk (a deploy replaced the hashed file this tab still asks for) must stay
 * inside the Dashboard's view region: the header, toolbar and view switcher keep working, the
 * user can leave for Kanban, and coming back shows the same notice (React `lazy` caches the
 * rejection). Harness copied from `Dashboard-gantt.dom.test.tsx`.
 *
 * Rejection seam: the mocked module's export is a getter that throws the Chromium chunk-load
 * TypeError, so the Dashboard's own `import(...).then((module) => module.ProductionGantt)` rejects
 * — the real `lazy` path, not a component that throws during render. There is deliberately no
 * `beforeEach` that warms the mocked module: reading the export would throw there.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
vi.mock("../components/ProductionGantt", () => ({
  get ProductionGantt(): never {
    throw new TypeError("Failed to fetch dynamically imported module: https://quincy.test/assets/ProductionGantt-OLD.js");
  },
}));
vi.mock("../components/ProductionEventCalendar", () => ({
  get ProductionEventCalendar(): never {
    throw new TypeError("Failed to fetch dynamically imported module: https://quincy.test/assets/ProductionEventCalendar-OLD.js");
  },
}));

function projectResponse() {
  return {
    projects: [{ id: "33333333-3333-4333-8333-333333333333", street: "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["33333333-3333-4333-8333-333333333333"] } },
  };
}

describe("Dashboard contains a stale lazy view chunk (#292)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authRole.value = "admin";
    apiGetMock.mockReset();
    apiGetMock.mockImplementation(() => Promise.resolve(projectResponse()));
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    // React 19 reports every caught error to console.error; the boundary must not hide it.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    confirmStore.resolve(false);
    if (root) act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    consoleError.mockRestore();
  });

  async function settle() {
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }

  async function render() {
    await act(async () => { root.render(<Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} />); await Promise.resolve(); await Promise.resolve(); });
    await settle();
  }

  function switcherButtons() {
    return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')];
  }

  function switcherButton(label: string): HTMLButtonElement | undefined {
    return switcherButtons().find((button) => button.textContent === label);
  }

  async function clickView(label: string) {
    await act(async () => { switcherButton(label)!.click(); await Promise.resolve(); });
    await settle();
  }

  function expectShellIntact() {
    expect(host.querySelector("h1")?.textContent).toBe("Projects");
    expect(host.querySelector('[data-testid="dashboard-toolbar"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Dashboard view"]')).toBeTruthy();
    expect(switcherButtons().length).toBeGreaterThan(0);
    for (const button of switcherButtons()) expect(button.disabled).toBe(false);
  }

  function viewLoadError() {
    return host.querySelector<HTMLElement>('[data-testid="view-load-error"]');
  }

  it.each([
    ["Timeline", "ProductionGantt-OLD.js", "Reload to open the timeline."],
    ["Calendar", "ProductionEventCalendar-OLD.js", "Reload to open the calendar."],
  ])("keeps a stale %s chunk inside the view region, and shows it again on return", async (label, chunk, copy) => {
    await render();
    expect(switcherButton("Board")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeTruthy();

    await clickView(label);
    expect(viewLoadError()?.getAttribute("data-kind")).toBe("chunk");
    expect(viewLoadError()?.textContent).toContain(copy);
    expect(switcherButton(label)?.getAttribute("aria-selected")).toBe("true");
    expectShellIntact();
    expect(consoleError).toHaveBeenCalled();
    // The chunk that failed is the one named in the error.
    expect(consoleError.mock.calls.flat().map(String).join("\n")).toContain(chunk);

    await clickView("Board");
    expect(viewLoadError()).toBeNull();
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeTruthy();
    expectShellIntact();

    // React `lazy` caches the rejection: the same notice, not a fresh load.
    await clickView(label);
    expect(viewLoadError()?.getAttribute("data-kind")).toBe("chunk");
    expectShellIntact();
  });
});
