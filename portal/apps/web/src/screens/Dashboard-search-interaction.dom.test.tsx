// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision
// geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser
// focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance
// items. Mirrors Dashboard-stage-interactions.dom.test.tsx's own harness.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import {
  __resetDashboardSearchStoreForTest,
  clearDashboardSearch,
  commitDashboardSearchNow,
  setDashboardSearchDraft,
} from "../lib/dashboard-search-store";

function ClientCapture({ onClient }: { onClient: (client: QueryClient) => void }) {
  onClient(useQueryClient());
  return null;
}

/**
 * #217 fix round 1, item 1 (Sol's diff review, blocker). Root cause: `searchActive` had been
 * folded into `interactionBlocked` (Dashboard.tsx), which meant the project-accept effect only
 * ever queued while a search was active -- searched results never displaced the pre-search list.
 * Removing `searchActive` from `interactionBlocked` restores the accept path for a searched
 * `queryProjects`, the same way an unsearched load already worked.
 */

const authState = vi.hoisted(() => ({ role: "admin" as const }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: authState.role, capabilities: ["moveProjectStage", "prioritizeProjects"], can: (capability: string) => capability === "moveProjectStage" || capability === "prioritizeProjects" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [
      { key: "awaiting_raw" as const, label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review" as const, label: "RAW review", displayOrder: 2, active: true },
      { key: "editing_autohdr" as const, label: "Editing · autoHDR", displayOrder: 3, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));

function summary(id: string, street: string, stageKey: ProjectSummary["stageKey"], boardPosition: number): ProjectSummary {
  return {
    id, street, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey, shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null,
    boardPosition, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  } as ProjectSummary;
}

const fullBoard = {
  projects: [
    summary("source", "Source Street", "awaiting_raw", 1),
    summary("before", "Before Street", "raw_review", 1),
    summary("target", "Target Street", "raw_review", 2),
  ],
  board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source"], raw_review: ["before", "target"] } },
};

const smithOnlyBoard = {
  projects: [summary("target", "Target Street", "raw_review", 1)],
  board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["target"] } },
};

function addresses(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="kanban2-card-address"], [data-testid="project-list-row"] span')].map((element) => element.textContent ?? "");
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

let root: Root;
let host: HTMLElement;

describe("Dashboard search results (#217 fix round 1, item 1)", () => {
  beforeEach(() => {
    authState.role = "admin";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/projects")) return Promise.resolve({});
      return Promise.resolve(path.includes("q=smith") ? smithOnlyBoard : fullBoard);
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  it("a committed search replaces the List through the same accept path as an unsearched load", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    expect(addresses(host)).toEqual(expect.arrayContaining(["Source Street", "Before Street", "Target Street"]));

    await act(async () => { setDashboardSearchDraft("smith"); commitDashboardSearchNow(); });
    await flush();

    expect(addresses(host)).toEqual(["Target Street"]);
    expect(addresses(host)).not.toContain("Source Street");
  });

  it("clearing the search restores the full list", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await act(async () => { setDashboardSearchDraft("smith"); commitDashboardSearchNow(); });
    await flush();
    expect(addresses(host)).toEqual(["Target Street"]);

    await act(async () => { clearDashboardSearch(); });
    await flush();
    expect(addresses(host)).toEqual(expect.arrayContaining(["Source Street", "Before Street", "Target Street"]));
  });

  it("a background refetch while searching still updates the list", async () => {
    let queryClient: QueryClient | undefined;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Dashboard currentUserId="admin-1" role="admin" /><ClientCapture onClient={(c) => { queryClient = c; }} /></QueryClientProvider>);
      await Promise.resolve();
    });
    await flush();
    await act(async () => { setDashboardSearchDraft("smith"); commitDashboardSearchNow(); });
    await flush();
    expect(addresses(host)).toEqual(["Target Street"]);

    // A server-side change surfaces on the next background poll -- `invalidateQueries` is the same
    // underlying mechanism a focus/interval refetch triggers, exercised directly rather than
    // fighting `staleTime: 15_000` with a real or fake clock.
    apiGetMock.mockImplementation((path) => {
      if (!path.startsWith("/api/projects")) return Promise.resolve({});
      return Promise.resolve({ projects: [summary("target", "Renamed Target Street", "raw_review", 1)], board: smithOnlyBoard.board });
    });
    await act(async () => { await queryClient!.invalidateQueries({ predicate: (query) => query.queryKey[0] === "dashboard-projects" }); });
    await flush();
    expect(addresses(host)).toEqual(["Renamed Target Street"]);
  });
});
