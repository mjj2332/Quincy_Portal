import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authState = vi.hoisted(() => ({ role: "admin" as const }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "principal-a", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({
    role: authState.role,
    capabilities: authState.role === "admin" ? ["adminBackend", "createProject", "moveProjectStage", "prioritizeProjects"] : [],
    can: (capability: string) => authState.role === "admin" && ["adminBackend", "createProject", "moveProjectStage", "prioritizeProjects"].includes(capability),
  }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [{ key: "raw_review", label: "RAW review", displayOrder: 1, active: true }],
    presentationStageKey: (key: string) => key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/kanban2/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));

function project(id: string, street: string): ProjectSummary {
  return {
    id,
    street,
    suburb: null,
    postcode: null,
    agencyName: null,
    agentName: null,
    stageKey: "raw_review",
    shootDate: null,
    coverAssetId: null,
    receivedCount: 0,
    expectedCount: null,
    priority: null,
    editors: [],
    boardRank: 0,
    boardMapPresent: true,
    authorizedBoardOrder: { raw_review: [id] },
    boardContractEnabled: true,
    boardRevision: 1,
    deadlineAt: null,
    deadlineLocalCivil: null,
    deadlineZone: null,
  } as ProjectSummary;
}

const full = [project("a", "Alpha Street"), project("b", "Beta Street"), project("c", "Gamma Street")];
const match = [project("b", "Beta Street")];

let host: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(location: string, response: Record<string, unknown>) {
  window.history.replaceState(null, "", location);
  apiGetMock.mockImplementation((path) => Promise.resolve(path.includes("q=smith") ? response : { projects: full, board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } } }));
  await act(async () => {
    root.render(<Dashboard currentUserId="principal-a" role={authState.role} />);
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  authState.role = "admin";
  apiGetMock.mockReset();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  __resetDashboardSearchStoreForTest();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
});

describe("Dashboard search presentation and navigation adversarial probes (#217)", () => {
  it("hides the stats strip and reports exact matching/total counts in the search chip", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    expect(host.querySelector('[aria-label="Project summary"]')).toBeNull();
    expect(host.querySelector('[data-testid="dashboard-search-chip"]')?.textContent).toContain("1 of 3 projects · 'smith'");
  });

  it("shows a search-only chip when an older response has no counts", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
    });

    const chip = host.querySelector('[data-testid="dashboard-search-chip"]')?.textContent ?? "";
    expect(chip).toBe("'smith'");
    expect(chip).not.toContain(" of ");
  });

  it("pluralises to the singular when the total is exactly one match", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 1 },
    });

    expect(host.querySelector('[data-testid="dashboard-search-chip"]')?.textContent).toContain("1 of 1 project · 'smith'");
  });

  it("renders the user's query exactly as typed, not uppercased by the Badge's own caps styling", async () => {
    await renderAt("/?view=list&q=Probe", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "Probe", matching: 1, total: 3 },
    });

    const queryNode = host.querySelector('[data-testid="dashboard-search-chip-query"]');
    expect(queryNode?.textContent).toBe("'Probe'");
    expect(queryNode?.className).toContain("normal-case");
  });

  it("expands the chip's clear target past its 12px glyph, keeping an accessible name (#217 design-review, item 2)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    const clearButton = host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
    expect(clearButton, "no clear button rendered — the assertions below would be vacuous").not.toBeNull();
    expect(clearButton!.className).toContain("relative");
    expect(clearButton!.className).toContain("after:absolute");
    expect(clearButton!.className).toContain("after:-inset-2");
  });

  it("keeps 'New shoot' out of the chip's cluster, so its position does not slide with query length (#217 design-review, item 3)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    const chip = host.querySelector('[data-testid="dashboard-search-chip"]');
    const newShoot = [...host.querySelectorAll("a")].find((node) => node.textContent === "New shoot");
    expect(chip, "no chip rendered — the assertions below would be vacuous").not.toBeNull();
    expect(newShoot, "no New shoot link rendered — the assertions below would be vacuous").not.toBeUndefined();
    expect(chip!.parentElement).not.toBe(newShoot!.parentElement);
    // The chip is the first child of its own cluster -- the one that also holds the
    // scope/view/sort controls, not the one that holds "New shoot".
    expect(chip!.parentElement!.firstElementChild).toBe(chip);
  });

  it("titles a zero-result search 'No matches.', not the unsearched empty-Dashboard copy (#217 design-review, item 9)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: [],
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: [] } },
      search: { query: "smith", matching: 0, total: 3 },
    });

    const emptyStateTitle = host.querySelector("strong")?.textContent;
    expect(emptyStateTitle).toBe("No matches.");
    expect(host.textContent).toContain("No projects match this search.");
  });

  it("preserves q when switching views from a searched Dashboard", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    const kanban = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban");
    expect(kanban).not.toBeUndefined();
    await act(async () => {
      kanban!.click();
      await Promise.resolve();
    });

    expect(window.location.search).toBe("?view=kanban&q=smith");
  });
});
