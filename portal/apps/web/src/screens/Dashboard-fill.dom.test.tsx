/**
 * #363 -- the Dashboard's title block is gone (a screen-reader h1 remains) and every view sits in
 * one flex region that fills the space under the toolbar. happy-dom cannot lay out, so this pins
 * the structure and Tailwind utilities; the browser pass measures the pixels. Harness copied from
 * `Dashboard-view-load-error.dom.test.tsx`, with working Gantt/Calendar stubs.
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
vi.mock("../components/ProductionGantt", () => ({ ProductionGantt: () => <div data-testid="gantt-stub" /> }));
vi.mock("../components/ProductionEventCalendar", () => ({ ProductionEventCalendar: () => <div data-testid="calendar-stub" /> }));

function projectResponse() {
  return {
    projects: [{ id: "33333333-3333-4333-8333-333333333333", street: "3 Board Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["33333333-3333-4333-8333-333333333333"] } },
  };
}

describe("Dashboard fills the viewport (#363)", () => {
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

  function switcherButton(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === label);
  }

  async function clickView(label: string) {
    await act(async () => { switcherButton(label)!.click(); await Promise.resolve(); });
    await settle();
  }

  const region = () => host.querySelector<HTMLElement>('[data-testid="dashboard-view-region"]')!;
  const classesOf = (element: Element | null) => {
    if (!element) throw new Error("element missing");
    return [...element.classList];
  };

  it("drops the title block but keeps a screen-reader h1", async () => {
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Projects");
    expect(host.textContent).not.toContain("Quincy Portal · production desk");
    expect(host.querySelector("main hr")).toBeNull();
  });

  it("wraps every view in a filling region that excludes the chrome", async () => {
    await render();
    expect(region()).not.toBeNull();
    for (const token of ["flex-1", "flex-col", "min-w-0", "min-h-[20rem]"]) expect(classesOf(region())).toContain(token);
    expect(region().contains(host.querySelector('[data-testid="dashboard-view-bar"]'))).toBe(false);
    expect(region().contains(host.querySelector('[data-testid="dashboard-live-region"]'))).toBe(false);
  });

  it("puts each view inside the region", async () => {
    await render();
    expect(region().contains(host.querySelector('[data-testid="dashboard-board"]'))).toBe(true);
    await clickView("Table");
    expect(host.querySelector('[aria-label="Projects list"]')).not.toBeNull();
    expect(region().contains(host.querySelector('[aria-label="Projects list"]'))).toBe(true);
    await clickView("Timeline");
    expect(region().contains(host.querySelector('[data-testid="gantt-stub"]'))).toBe(true);
    await clickView("Calendar");
    expect(region().contains(host.querySelector('[data-testid="calendar-stub"]'))).toBe(true);
  });

  it("fills the region while loading", async () => {
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    await render();
    // The shared Filter's own sr-only live status (#428) precedes the region; the skeleton is the one inside it.
    const skeleton = region().querySelector<HTMLElement>('[role="status"]')!;
    expect(skeleton).not.toBeNull();
    for (const token of ["flex-1", "min-h-0"]) expect(classesOf(skeleton)).toContain(token);
  });

  it("List keeps its header outside a scrolling body", async () => {
    await render();
    await clickView("Table");
    const list = host.querySelector<HTMLElement>('[aria-label="Projects list"]')!;
    for (const token of ["flex", "flex-col", "flex-1", "min-h-0"]) expect(classesOf(list)).toContain(token);
    const header = list.querySelector('[data-testid="project-list-header"]');
    const viewport = list.querySelector('[data-slot="scroll-area-viewport"]');
    expect(header).not.toBeNull();
    expect(viewport).not.toBeNull();
    const rows = [...list.querySelectorAll('[data-testid="project-list-row"]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(viewport!.contains(row)).toBe(true);
    expect(viewport!.contains(header)).toBe(false);
  });
});
