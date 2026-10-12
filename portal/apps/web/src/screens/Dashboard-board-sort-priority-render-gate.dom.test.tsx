// #830: the Board's sort is every viewer's choice of date, and Priority no longer orders cards. The former
// Priority render-gate, re-stated: a user without `prioritizeProjects` gets the same Sort radios as an
// Admin, no explanation line, and cards ordered by Shoot date whatever their priority.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { displayMenu, openDisplay, sortRadios } from "./dashboard-display-test-helpers";

// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Board's horizontal
// scroll, `board/board.tsx`) calls on a timer after mount. The no-op stub means "no active
// animations"; see `reui/gantt/gantt-adjust-ghost-marker.dom.test.tsx` for the same polyfill.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
// Unauthorized: no `prioritizeProjects` capability.
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "photographer", capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true }],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testNow = new Date("2026-08-27T00:00:00.000Z");

describe("Dashboard Kanban sort control — Priority gate (#830)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: testNow });
    window.history.replaceState(null, "", "/");
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({ projects: [{
      id: "project-1", street: "1 Test Street", suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate: "2026-01-01", coverAssetId: null, receivedCount: 7,
      expectedCount: null, priority: 1, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
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

  it("offers the same Shoot date / Deadline choice to a user without Priority, with no explanation line, and orders by Shoot date not priority", async () => {
    const mk = (id: string, street: string, priority: number, shootDate: string) => ({
      id, street, suburb: null, postcode: null, agencyName: null, agentName: null,
      stageKey: "awaiting_raw", shootDate, coverAssetId: null, receivedCount: 0,
      expectedCount: null, priority, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null, boardRevision: 0,
    });
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({ projects: [mk("a", "1 Alpha Street", 5, "2026-09-01"), mk("b", "2 Bravo Street", 1, "2026-01-01")] }) : Promise.resolve({ stages: [] }));
    await act(async () => { root!.render(<Dashboard currentUserId="photographer-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="board-card"]')).not.toBeNull());
    expect([...document.querySelectorAll('[data-testid="board-card"]')].map((card) => card.textContent?.includes("Alpha") ? "alpha" : "bravo")).toEqual(["bravo", "alpha"]);
    await openDisplay();
    expect(sortRadios().map((radio) => radio.textContent)).toEqual(["Shoot date", "Deadline"]);
    expect(displayMenu()!.textContent).not.toMatch(/priority|Sorted by/i);
  });
});
