// TB8-01 §2.2 item 8's render-gate ABSENCE half: an unauthorized user must never see "Priority"
// as an option in the real Select at all — not just have a would-be selection refused. This
// renders the real (unmocked) Select — unlike Dashboard-kanban-sort-priority-guard.dom.test.tsx,
// which mocks Select to test the guard half — so the assertion is against Select's actual
// rendered option list. Dashboard-kanban-sort.dom.test.tsx's test 8 covers the render-gate
// PRESENCE half (authorized user sees it).
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
// Unauthorized: no `prioritizeProjects` capability, so `canPrioritize` is false and the render
// gate (`canPrioritize && hasAuthorizedBoardMap`) must exclude the "Priority" option.
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "photographer", capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }),
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

describe("Dashboard Kanban sort control — Priority gate (render-gate absence half)", () => {
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

  it("never offers 'Priority' in the real Select's option list to an unauthorized user", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="photographer-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Sort Kanban board"][role="combobox"]')!;
    expect(trigger).not.toBeNull();
    await act(async () => { trigger.click(); await Promise.resolve(); });
    const options = [...document.querySelectorAll<HTMLElement>('[aria-label="Sort Kanban board"][role="listbox"] [role="option"]')];
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((option) => option.textContent === "Priority")).toBe(false);
    expect(options.map((option) => option.textContent)).toEqual(["Board order", "Shoot date ↑", "Shoot date ↓"]);
  });
});
