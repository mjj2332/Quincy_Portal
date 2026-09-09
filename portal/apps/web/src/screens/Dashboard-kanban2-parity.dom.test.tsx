// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision
// geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser
// focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance
// items.
//
// This file is the `view=kanban2` Dashboard seam for #98: nothing else in the repo renders the
// Dashboard at `view=kanban2`, so every gap in #98 that is a Dashboard-level behaviour (not a
// standalone-Board behaviour covered by `kanban2/board.dom.test.tsx`) was unpinned until this file
// existed. Routing is read-only history (`lib/staff-history.ts`) — `useNavigate`/`<Link>` do
// nothing — so, like every other Dashboard DOM test, this sets the URL directly with
// `window.history.replaceState` before render and restores it afterward.
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
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 1, active: true },
    ],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function projectFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, street: `${id} Street`, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null,
    priority: null, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
    boardRevision: 0,
    ...overrides,
  };
}

describe("Dashboard at view=kanban2 (#98)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?view=kanban2");
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
      projects: [projectFixture("kb2-source")],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"] } },
    }) : Promise.resolve({ stages: [] }));
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
    window.history.replaceState(null, "", "/");
  });

  it("renders the new Board, not the old one, when the route requests view=kanban2", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());
    // Anti-vacuity anchor for the whole file: a Board that silently fell back to the old
    // implementation would still satisfy a bare "kanban2-column exists" check if that id ever
    // leaked onto the old Board, so this also asserts the old Board's own test id is absent.
    expect(document.querySelector('[data-testid="kanban-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("kb2-source Street");
  });
});
