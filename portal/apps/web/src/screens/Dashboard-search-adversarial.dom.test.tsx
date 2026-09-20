import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardSearchOf } from "@quincy/shared";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { parseStaffLocation } from "../lib/router";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

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
  // #217 build, step 4: `Dashboard.tsx` reads the committed `q` from the route at render; nothing adopts it --
  // `ShellRoute` only syncs the input DRAFT from the location, a `useLayoutEffect` keyed on location + principal
  // (`lib/app-router.tsx`). Mirrored here directly, matching a real arrival (`ShellRoute` always
  // runs ahead of `Dashboard` in production).
  const route = parseStaffLocation(location);
  if (route.kind === "dashboard") syncDashboardSearchDraftFromLocation(dashboardSearchOf(route), "principal-a");
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

// #217 chip-row: the toolbar -> active search -> results reading order, checked the same way in
// List, Kanban, and (Dashboard-calendar.dom.test.tsx) Calendar -- the chip must never be a toolbar
// descendant, and the summary must be the toolbar's very next sibling.
function assertToolbarChipSeparation(host: HTMLDivElement) {
  const toolbar = host.querySelector('[data-testid="dashboard-toolbar"]');
  const summary = host.querySelector('[data-testid="dashboard-search-summary"]');
  const chip = host.querySelector('[data-testid="dashboard-search-chip"]');
  const newShootLink = [...host.querySelectorAll("a")].find((node) => node.textContent === "New shoot");
  expect(toolbar, "no toolbar rendered — the assertions below would be vacuous").not.toBeNull();
  expect(summary, "no search summary rendered — the assertions below would be vacuous").not.toBeNull();
  expect(chip, "no chip rendered — the assertions below would be vacuous").not.toBeNull();
  expect(newShootLink, "no New shoot link rendered — the assertions below would be vacuous").not.toBeUndefined();

  expect(toolbar!.contains(chip!)).toBe(false);
  expect(toolbar!.contains(newShootLink!)).toBe(true);
  expect(toolbar!.nextElementSibling).toBe(summary);
}

/** Every descendant's tag + testid, in document order -- used to prove the toolbar's shape does not change with the query. */
function toolbarShape(toolbar: Element): string[] {
  return [...toolbar.querySelectorAll("*")].map((node) => `${node.tagName}:${node.getAttribute("data-testid") ?? ""}`);
}

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

  // SANCTIONED REWRITE (#217 chip-row): the chip moved out of the toolbar entirely, into a sibling
  // "active search" summary row, so the old "not the same parent as New shoot" assertion no longer
  // states the real contract. The toolbar's own geometry must never depend on the query -- the chip
  // is not inside it at all, and the summary reads as the next thing on the page, not a toolbar
  // child.
  it("keeps the chip out of the toolbar entirely: it renders in a sibling summary row, reading toolbar -> active search -> results (#217 chip-row)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    assertToolbarChipSeparation(host);
  });

  it("holds the toolbar/summary separation in Kanban after switching from a searched List (#217 chip-row)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    assertToolbarChipSeparation(host);

    const kanban = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Kanban");
    expect(kanban, "no Kanban control rendered — the assertion below would be vacuous").not.toBeUndefined();
    await act(async () => {
      kanban!.click();
      await Promise.resolve();
    });
    await settle();

    assertToolbarChipSeparation(host);
  });

  it("keeps the toolbar's children identical, and the summary absent, when there is no search (#217 chip-row) — proves the toolbar's geometry does not depend on the query", async () => {
    await renderAt("/?view=list", {
      projects: full,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
    });
    const toolbarUnsearched = host.querySelector('[data-testid="dashboard-toolbar"]');
    expect(toolbarUnsearched, "no toolbar rendered — the assertions below would be vacuous").not.toBeNull();
    const shapeUnsearched = toolbarShape(toolbarUnsearched!);
    expect(host.querySelector('[data-testid="dashboard-search-summary"]')).toBeNull();

    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    const toolbarSearched = host.querySelector('[data-testid="dashboard-toolbar"]');
    expect(toolbarSearched, "no toolbar rendered — the assertions below would be vacuous").not.toBeNull();
    const shapeSearched = toolbarShape(toolbarSearched!);
    expect(host.querySelector('[data-testid="dashboard-search-summary"]')).not.toBeNull();

    expect(shapeSearched).toEqual(shapeUnsearched);
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

  it("the FIRST /api/projects request on a cold deep link already carries q — never an unfiltered request first (#217 design-fix round 3, item 1)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    const projectCalls = apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    expect(projectCalls.length, "no /api/projects request observed — the assertions below would be vacuous").toBeGreaterThan(0);
    for (const path of projectCalls) {
      expect(path, `an unfiltered /api/projects request went out on a cold q=smith deep link: ${path}`).toContain("q=smith");
    }
  });

  it("clearing the search never resurrects a stale route q into a later request (#217 design-fix round 3, item 1)", async () => {
    await renderAt("/?view=list&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    const clearButton = host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
    expect(clearButton, "no clear button rendered — the assertions below would be vacuous").not.toBeNull();

    const callsBeforeClear = apiGetMock.mock.calls.length;
    await act(async () => {
      clearButton!.click();
      await Promise.resolve();
    });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-search-chip"]'), "chip still shown after clearing").toBeNull();
    const callsAfterClear = apiGetMock.mock.calls.slice(callsBeforeClear).map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    for (const path of callsAfterClear) {
      expect(path, `a request after clearing the search still carried the stale q: ${path}`).not.toContain("q=smith");
    }
  });
});
