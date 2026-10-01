import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardSearchOf } from "@quincy/shared";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { parseStaffLocation } from "../lib/router";
import { __resetDashboardSearchStoreForTest, syncDashboardSearchDraftFromLocation } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #363: the List body now sits in Base UI's ScrollArea, which calls `getAnimations()` on a timer
// after mount; happy-dom lacks it. The no-op stub means "no active animations".
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

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

// #217 chip-row, reshaped by #427: the page reads header (title, summary, New shoot) -> view bar
// (tabs, search, Display) -> view region, checked the same way in Table, Board and
// (Dashboard-calendar.dom.test.tsx) Calendar. The search field lives in the view bar only; the summary
// lives in the header only; neither depends on the query for where it sits.
function assertHeaderBarSeparation(host: HTMLDivElement) {
  const header = host.querySelector('[data-testid="dashboard-header"]');
  const summary = host.querySelector('[data-testid="dashboard-summary"]');
  const bar = host.querySelector('[data-testid="dashboard-view-bar"]');
  const field = host.querySelector('[data-testid="dashboard-search"]');
  const region = host.querySelector('[data-testid="dashboard-view-region"]');
  const newShootLink = [...host.querySelectorAll("a")].find((node) => node.textContent === "New shoot");
  expect(header, "no header rendered — the assertions below would be vacuous").not.toBeNull();
  expect(summary, "no summary rendered — the assertions below would be vacuous").not.toBeNull();
  expect(bar, "no view bar rendered — the assertions below would be vacuous").not.toBeNull();
  expect(field, "no search field rendered — the assertions below would be vacuous").not.toBeNull();
  expect(region, "no view region rendered — the assertions below would be vacuous").not.toBeNull();
  expect(newShootLink, "no New shoot link rendered — the assertions below would be vacuous").not.toBeUndefined();

  expect(header!.contains(summary!)).toBe(true);
  expect(header!.contains(newShootLink!)).toBe(true);
  expect(header!.contains(field!)).toBe(false);
  expect(bar!.contains(field!)).toBe(true);
  expect(bar!.contains(summary!)).toBe(false);
  expect(header!.compareDocumentPosition(bar!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(bar!.compareDocumentPosition(region!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

/** Every descendant's tag, testid, focus key and label, in document order -- used to prove the page chrome's shape does not change with the query. The in-field Clear button (and the addon wrapping it) exists only while the field holds text, so it is the one element left out. */
function chromeShape(container: Element): string[] {
  return [...container.querySelectorAll("*")]
    .filter((node) => node.closest('[aria-label="Clear search"]') === null
      && !(node.querySelector('[aria-label="Clear search"]') !== null && node.querySelector("input") === null))
    .map((node) => [
      node.tagName,
      node.getAttribute("data-testid") ?? "",
      node.getAttribute("data-focus-key") ?? "",
      node.getAttribute("aria-label") ?? "",
    ].join(":"));
}

const summaryText = (host: HTMLElement) => host.querySelector('[data-testid="dashboard-summary"]')?.textContent ?? "";

describe("Dashboard search presentation and navigation adversarial probes (#217)", () => {
  it("hides the stats strip and reports exact matching/total counts in the header summary", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    expect(host.querySelector('[aria-label="Project summary"]')).toBeNull();
    expect(summaryText(host)).toContain("1 of 3 active Projects");
  });

  it("shows a plain count when an older response has no search counts", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
    });

    const text = summaryText(host);
    expect(text).toContain("1 active Project");
    expect(text).not.toContain(" of ");
  });

  it("pluralises to the singular when the total is exactly one match", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 1 },
    });

    expect(summaryText(host)).toContain("1 of 1 active Project");
    expect(summaryText(host)).not.toContain("Projects");
  });

  it("renders the user's query exactly as typed in the field, and never echoes it into the header", async () => {
    await renderAt("/?view=table&q=Probe", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "Probe", matching: 1, total: 3 },
    });

    expect(host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')?.value).toBe("Probe");
    expect(host.querySelector('[data-testid="dashboard-header"]')!.textContent).not.toContain("Probe");
  });

  it("keeps an accessible name on the in-field clear button, inside the search field (#427, was the chip's clear target)", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    const clearButton = host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
    expect(clearButton, "no clear button rendered — the assertions below would be vacuous").not.toBeNull();
    expect(clearButton!.tagName).toBe("BUTTON");
    expect(clearButton!.getAttribute("type")).toBe("button");
    expect(host.querySelector('[data-testid="dashboard-search-field"]')!.contains(clearButton!)).toBe(true);
  });

  it("lays the page out header -> view bar -> region, with the summary in the header and the search in the bar (#217 chip-row, #427)", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });

    assertHeaderBarSeparation(host);
  });

  it("holds the header/bar separation in Board after switching from a searched Table (#217 chip-row, #427)", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    assertHeaderBarSeparation(host);

    const kanban = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === "Board");
    expect(kanban, "no Board tab rendered — the assertion below would be vacuous").not.toBeUndefined();
    await act(async () => {
      kanban!.click();
      await Promise.resolve();
    });
    await settle();

    // Prove the switch happened -- otherwise this would merely repeat the Table assertion.
    expect(window.location.search).toContain("view=board");
    assertHeaderBarSeparation(host);
  });

  it("keeps the header and view bar's children identical with and without a search (#217 chip-row, #427) — proves the page chrome's geometry does not depend on the query", async () => {
    await renderAt("/?view=table", {
      projects: full,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
    });
    const barUnsearched = host.querySelector('[data-testid="dashboard-view-bar"]');
    const headerUnsearched = host.querySelector('[data-testid="dashboard-header"]');
    expect(barUnsearched, "no view bar rendered — the assertions below would be vacuous").not.toBeNull();
    expect(headerUnsearched, "no header rendered — the assertions below would be vacuous").not.toBeNull();
    const barShapeUnsearched = chromeShape(barUnsearched!);
    const headerShapeUnsearched = chromeShape(headerUnsearched!);
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();

    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    expect(host.querySelector('button[aria-label="Clear search"]')).not.toBeNull();

    expect(chromeShape(host.querySelector('[data-testid="dashboard-view-bar"]')!)).toEqual(barShapeUnsearched);
    expect(chromeShape(host.querySelector('[data-testid="dashboard-header"]')!)).toEqual(headerShapeUnsearched);
  });

  it("titles a zero-result search 'No matches.', not the unsearched empty-Dashboard copy (#217 design-review, item 9)", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: [],
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: [] } },
      search: { query: "smith", matching: 0, total: 3 },
    });

    const emptyStateTitle = host.querySelector("strong")?.textContent;
    expect(emptyStateTitle).toBe("No matches.");
    expect(host.textContent).toContain("No projects match this search.");
  });

  it("preserves q when switching views from a searched Dashboard", async () => {
    await renderAt("/?view=table&q=smith", {
      projects: match,
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["a", "b", "c"] } },
      search: { query: "smith", matching: 1, total: 3 },
    });
    const kanban = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === "Board");
    expect(kanban).not.toBeUndefined();
    await act(async () => {
      kanban!.click();
      await Promise.resolve();
    });

    expect(window.location.search).toBe("?view=board&q=smith");
  });

  it("the FIRST /api/projects request on a cold deep link already carries q — never an unfiltered request first (#217 design-fix round 3, item 1)", async () => {
    await renderAt("/?view=table&q=smith", {
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
    await renderAt("/?view=table&q=smith", {
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

    expect(host.querySelector('button[aria-label="Clear search"]'), "clear button still shown after clearing").toBeNull();
    expect(summaryText(host), "summary still names the search after clearing").not.toContain(" of ");
    const callsAfterClear = apiGetMock.mock.calls.slice(callsBeforeClear).map(([path]) => path).filter((path) => path.startsWith("/api/projects"));
    for (const path of callsAfterClear) {
      expect(path, `a request after clearing the search still carried the stale q: ${path}`).not.toContain("q=smith");
    }
  });
});
