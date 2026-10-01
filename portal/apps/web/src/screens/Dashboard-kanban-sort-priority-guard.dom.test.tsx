// TB8-01 §2.2 item 8's guard half: `selectBoardSort`'s client-side check
// (`next === "priority" && (!canPrioritize || !hasAuthorizedBoardMap)`) must refuse a "priority"
// value even if it somehow reaches the radio group's `onValueChange` — not merely rely on the
// option being un-rendered. Since the real menu only ever offers rendered options (an unauthorized
// user can never click "Priority" because it isn't in the list), this file mocks the
// `reui/dropdown-menu` radio group to a bare button that invokes `onValueChange("priority")`
// directly, bypassing whatever items were actually rendered, so the assertion is against
// Dashboard's own guard — not against the view bar's list-filtering, which
// Dashboard-kanban-sort.dom.test.tsx (test 8) and -render-gate cover as the render halves.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Board's horizontal
// scroll, `kanban2/board.tsx`) calls on a timer after mount. The no-op stub means "no active
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
// Unauthorized: no `prioritizeProjects` capability, so `canPrioritize` is false and the guard's
// `!canPrioritize` branch is the one under test.
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "photographer", capabilities: ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true }],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));
vi.mock("../components/reui/dropdown-menu", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
    DropdownMenuContent: passthrough,
    DropdownMenuGroup: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuRadioItem: () => null,
    DropdownMenuRadioGroup: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
      <button aria-label="mock sort" type="button" onClick={() => onValueChange("priority")}>mock sort trigger</button>
    ),
  };
});

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const testNow = new Date("2026-08-27T00:00:00.000Z");

describe("Dashboard Kanban sort control — Priority gate guard (negative case)", () => {
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

  it("refuses a 'priority' value from an unauthorized user even when it reaches onValueChange directly", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="photographer-1" />); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(100); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card"]')).not.toBeNull());
    const mockTrigger = document.querySelector<HTMLButtonElement>('[aria-label="mock sort"]')!;
    expect(mockTrigger).not.toBeNull();
    // The initial mount already persists the default "board" mode (initializeKanbanSortMode's
    // write-back), so the guard's effect must be checked as "stays unchanged", not "stays unset".
    const before = window.localStorage.getItem("quincy:dashboard:kanbanSort");
    expect(before).toBe("board");
    await act(async () => { mockTrigger.click(); await Promise.resolve(); });
    // The guard returns before setBoardSort/the localStorage write, so this staying "board"
    // (rather than becoming "priority") is direct evidence Dashboard's own guard — not the menu's
    // rendering — refused the value.
    expect(window.localStorage.getItem("quincy:dashboard:kanbanSort")).toBe(before);
  });
});
