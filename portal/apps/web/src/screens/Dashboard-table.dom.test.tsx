/**
 * #431 -- the Dashboard Table on the ReUI data-grid; #923 -- its round 4 look (frames 4b, 4c, 4g, 4h). Everything is located by role, accessible
 * name, `th[aria-sort]` or a Quincy `data-testid` (never a vendor `data-slot`: test-seam guard F).
 * Harness = `Dashboard-fill.dom.test.tsx`'s Dashboard mocks plus a real `ProjectQueryRuntime`, so the
 * Deadline popup's `invalidateProjectSurfaces` really refetches.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickPopupDay, popupButton } from "@/testing/date-time-popup";
import { Dashboard } from "./Dashboard";
import { DashboardTable, TableSkeleton, type DashboardTableProps } from "../components/DashboardTable";
import { lateLabel, projectLateness, stageTone } from "../lib/dashboard-appearance";
import type { ProjectSummary } from "../lib/kanban-interaction";
import { chooseGroupBy, columnCheckboxLabels, displayTrigger, groupCheckboxes, openDisplay, toggleColumn } from "./dashboard-display-test-helpers";
import { ApiError } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";
import { tablePrefsKey } from "../lib/dashboard-table-model";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "editor" | "photographer" | "external_editor", caps: new Set<string>() }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
  apiPut: (path: string, body: unknown) => apiPutMock(path, body),
}));
// An External Editor's list goes through a strict DTO decoder; this suite is about the Table, so the
// transport is pass-through and the fixture rows stand in for the converted summaries.
vi.mock("../lib/external-api-response", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/external-api-response")>()),
  externalApiGet: (_surface: string, path: string) => apiGetMock(path),
  externalProjectSummaryToDashboard: (project: unknown) => project,
}));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: auth.role } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: auth.role, capabilities: [...auth.caps], can: (capability: string) => auth.caps.has(capability) }) }));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "editing_autohdr", label: "Editing", displayOrder: 2, active: true },
      { key: "delivered", label: "Delivered", displayOrder: 3, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));
const shellBottom = vi.hoisted(() => vi.fn(() => 0));
vi.mock("../lib/shell-chrome", () => ({ shellChromeBottom: () => shellBottom() }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));
vi.mock("../components/board/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));

type Row = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; stageKey: string; shootDate: string | null;
  coverAssetId: string | null; receivedCount: number; expectedCount: number | null; priority: number | null; boardRevision: number; boardPosition: number;
  deadlineAt: number | null; deadlineLocalCivil: string | null; deadlineZone: "Australia/Sydney" | null; editors: { id: string; name: string }[]; archivedAt?: string | null;
  checklist?: { completed: number; total: number };
};

const FUTURE = Date.parse("2099-01-01T00:00:00.000Z");
const day = (n: number) => FUTURE + n * 86_400_000;
const civil = (n: number) => `2099-01-${String(1 + n).padStart(2, "0")}T09:00`;

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id, street: `${id} Street`, suburb: "Bondi", postcode: "2026", agencyName: "Agency", agentName: "Agent", stageKey: "awaiting_raw", shootDate: null, coverAssetId: null,
    receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, boardPosition: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null, editors: [], ...overrides,
  };
}

/** Five Projects with one distinct value per column, so every sort has one right answer (server order p1..p5). */
function sortFixture(): Row[] {
  return [
    row("p1", { street: "10 Oak St", stageKey: "delivered", agencyName: "Beta", agentName: "Zed", shootDate: "2026-03-01", deadlineAt: day(2), deadlineLocalCivil: civil(2), editors: [{ id: "e1", name: "Zoe" }], priority: 5, receivedCount: 7 }),
    row("p2", { street: "2 Oak St", stageKey: "awaiting_raw", agencyName: "Alpha", agentName: "Amy", shootDate: "2026-01-01", deadlineAt: day(0), deadlineLocalCivil: civil(0), editors: [{ id: "e2", name: "Ann" }], priority: 2, receivedCount: 30 }),
    row("p3", { street: "1 Oak St", stageKey: "editing_autohdr", agencyName: null, agentName: null, shootDate: null, deadlineAt: null, editors: [], priority: null, receivedCount: 9 }),
    row("p4", { street: "5 Elm Rd", stageKey: "awaiting_raw", agencyName: "Beta", agentName: "Ann", shootDate: "2026-02-01", deadlineAt: day(1), deadlineLocalCivil: civil(1), editors: [{ id: "e3", name: "Mia" }], priority: 4, receivedCount: 100 }),
    row("p5", { street: "3 Elm Rd", stageKey: "delivered", agencyName: "Gamma", agentName: null, shootDate: "2026-04-01", deadlineAt: day(3), deadlineLocalCivil: civil(3), editors: [{ id: "e4", name: "Bob" }], priority: 1, receivedCount: 1 }),
  ];
}

const COLUMN_HEADERS = ["Project", "Stage", "Client", "Shoot", "Deadline", "Progress", "Editors", "Priority", "RAW received"];
/** What a new viewer sees (#923): RAW received is off by default. */
const DEFAULT_HEADERS = COLUMN_HEADERS.filter((name) => name !== "RAW received");
/** The server's order, and the default Deadline-ascending order of the same five rows (missing last). */
const SERVER_ORDER = ["p1", "p2", "p3", "p4", "p5"];
const BY_DEADLINE = ["p2", "p4", "p1", "p5", "p3"];
/** The #431 suites run flat with every column; the #923 default suites clear this. */
const FLAT_ALL_COLUMNS = JSON.stringify({ groupBy: "none", hiddenColumns: [] });

let projects: Row[];
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
let consoleError: ReturnType<typeof vi.spyOn>;
let storage: Map<string, string>;
let storageBroken: boolean;
let narrow: boolean;
let currentUser = "user-1";

function detailBody(id: string) {
  const found = projects.find((project) => project.id === id)!;
  return {
    id, street: found.street, suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "editing", rawFolderPath: null, rawFolderLink: null,
    boardRevision: 1, contractEnabled: true, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [],
    deadlineSchedule: {
      version: 1,
      deadline: found.deadlineLocalCivil ? { localCivil: found.deadlineLocalCivil, zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant: new Date(found.deadlineAt!).toISOString() } : null,
      reminderOffsetsMinutes: [], state: found.deadlineLocalCivil ? "scheduled" : "unset", nextOccurrence: null, canResume: false,
    },
  };
}

function projectsResponse() {
  const byStage: Record<string, string[]> = {};
  for (const project of projects) (byStage[project.stageKey] ??= []).push(project.id);
  return { projects, board: { contractEnabled: true, orderedProjectIdsByStage: byStage } };
}

beforeEach(() => {
  auth.role = "admin";
  auth.caps = new Set(["adminBackend", "createProject", "prioritizeProjects", "editProject", "moveProjectStage"]);
  currentUser = "user-1";
  narrow = false;
  projects = sortFixture();
  apiGetMock.mockReset().mockImplementation(async (path: string) => {
    const detail = /^\/api\/projects\/([^/?]+)$/.exec(path);
    if (detail) return detailBody(detail[1]!);
    return projectsResponse();
  });
  apiPostMock.mockReset().mockImplementation(async (path, body) => {
    // The mock server keeps what it was told, so the confirming refetch agrees with the response.
    const priority = (body as { priority: number | null }).priority;
    const saved = projects.find((project) => path === `/api/projects/${project.id}/priority`);
    if (saved) { saved.priority = priority; saved.boardRevision = 2; }
    return { priority, boardRevision: 2 };
  });
  apiPutMock.mockReset().mockResolvedValue({ changed: true, current: detailBody("p2").deadlineSchedule, eventIntent: null, publicationIds: [] });
  storage = new Map([[tablePrefsKey("user-1"), FLAT_ALL_COLUMNS]]);
  storageBroken = false;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => { if (storageBroken) throw new Error("denied"); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (storageBroken) throw new Error("denied"); storage.set(key, value); },
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === "(max-width: 721px)", media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  confirmStore.resolve(false);
  await act(async () => { root.unmount(); await Promise.resolve(); });
  runtime.dispose();
  queryClient.clear();
  host.remove();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  __resetDashboardSearchStoreForTest();
  consoleError.mockRestore();
});

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

function tree() {
  return (
    <ProjectQueryRuntimeProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <Dashboard currentUserId={currentUser} role={auth.role} authorizationEpoch={0} />
      </QueryClientProvider>
    </ProjectQueryRuntimeProvider>
  );
}

async function renderTable() {
  await act(async () => { root.render(tree()); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] [role="tab"]')].find((button) => button.textContent === "Table")!;
  await act(async () => { tab.click(); await Promise.resolve(); });
  await settle();
}

async function rerender() {
  await act(async () => { root.render(tree()); await Promise.resolve(); });
  await settle();
}

const table = () => host.querySelector<HTMLElement>('[aria-label="Projects table"]')!;
const headers = () => [...table().querySelectorAll<HTMLElement>("thead th")];
const headerNames = () => headers().map((th) => th.textContent?.trim());
const th = (name: string) => headers().find((cell) => cell.textContent?.trim() === name)!;
const rowIds = () => [...table().querySelectorAll<HTMLAnchorElement>('[data-testid="project-table-row-link"]')].map((link) => decodeURIComponent(link.getAttribute("href")!.split("/").pop()!));
const rowFor = (id: string) => table().querySelector<HTMLAnchorElement>(`[data-testid="project-table-row-link"][href="/projects/${id}"]`)!.closest("tr")!;
const groupTriggers = () => [...table().querySelectorAll<HTMLElement>('[data-testid="project-table-group-trigger"]')];
const groupLabels = () => [...table().querySelectorAll<HTMLElement>('[data-testid="project-table-group-label"]')].map((label) => label.textContent?.trim());
const groupCounts = () => [...table().querySelectorAll('[data-testid="project-table-group-count"]')].map((badge) => badge.textContent);

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
  await settle(1);
}

async function sortBy(name: string) {
  await click(th(name).querySelector("button")!);
}

describe("the Table's structure (#431)", () => {
  it("is a table, in a labelled section, with the nine columns in order, sorted by Deadline ascending (#923)", async () => {
    await renderTable();
    expect(table().tagName).toBe("SECTION");
    expect(table().querySelector("table")).not.toBeNull();
    expect(table().querySelector('[role="grid"]')).toBeNull();
    expect(headerNames()).toEqual(COLUMN_HEADERS);
    // Progress has no sort, so no aria-sort at all.
    expect(headers().map((cell) => cell.getAttribute("aria-sort"))).toEqual(COLUMN_HEADERS.map((name) => (name === "Deadline" ? "ascending" : name === "Progress" ? null : "none")));
    expect(rowIds()).toEqual(BY_DEADLINE);
  });

  it("renders every row, not the grid's default page of ten", async () => {
    projects = Array.from({ length: 23 }, (_, index) => row(`r${String(index).padStart(2, "0")}`));
    await renderTable();
    expect(rowIds()).toHaveLength(23);
  });

  it("fills each cell from the Project", async () => {
    projects = [row("p1", {
      street: "10 Oak St", suburb: "Bondi", postcode: "2026", agencyName: "Beta", agentName: "Zed", stageKey: "editing_autohdr", shootDate: "2026-03-01", deadlineAt: day(2), deadlineLocalCivil: civil(2),
      editors: [{ id: "e1", name: "Zoe Editor" }], priority: 3, receivedCount: 12, expectedCount: 40, archivedAt: null,
    })];
    await renderTable();
    const tr = rowFor("p1");
    const link = tr.querySelector<HTMLAnchorElement>('[data-testid="project-table-row-link"]')!;
    expect(link.textContent).toBe("10 Oak St");
    expect(link.getAttribute("href")).toBe("/projects/p1");
    expect(tr.textContent).toContain("Bondi");
    expect(tr.textContent).not.toContain("2026 ·");
    expect(tr.textContent).toContain("Editing");
    expect(tr.textContent).toContain("Beta");
    expect(tr.textContent).toContain("Zed");
    expect(tr.textContent).toContain("1 Mar 2026");
    expect(tr.querySelector('[data-testid="project-table-deadline-trigger"]')?.getAttribute("aria-label")).toBe("Deadline for 10 Oak St: Sat 3 Jan · 09:00");
    expect(tr.querySelector('[aria-label="Zoe Editor"]')).not.toBeNull();
    expect(tr.querySelector('[data-testid="project-table-raw"]')?.textContent).toBe("12/40");
    expect(tr.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("aria-label")).toBe("3 stars");
  });

  it("marks an archived Project with a badge", async () => {
    projects = [row("p1", { archivedAt: "2026-01-01T00:00:00.000Z" })];
    await renderTable();
    expect(rowFor("p1").querySelector('[data-testid="project-table-archived"]')?.textContent).toBe("Archived");
  });
});

describe("sorting (#431)", () => {
  const ASC: Record<string, string[]> = {
    Project: ["p3", "p2", "p5", "p4", "p1"],
    Stage: ["p2", "p4", "p3", "p1", "p5"],
    Client: ["p2", "p4", "p1", "p5", "p3"],
    Shoot: ["p2", "p4", "p1", "p5", "p3"],
    Editors: ["p2", "p5", "p4", "p1", "p3"],
    Priority: ["p5", "p2", "p4", "p1", "p3"],
    "RAW received": ["p5", "p1", "p3", "p2", "p4"],
  };
  const DESC: Record<string, string[]> = {
    Project: ["p1", "p4", "p5", "p2", "p3"],
    Stage: ["p1", "p5", "p3", "p2", "p4"],
    Client: ["p5", "p1", "p4", "p2", "p3"],
    Shoot: ["p5", "p1", "p4", "p2", "p3"],
    Editors: ["p1", "p4", "p5", "p2", "p3"],
    Priority: ["p1", "p4", "p2", "p5", "p3"],
    "RAW received": ["p4", "p2", "p3", "p1", "p5"],
  };

  it.each(Object.keys(ASC))("%s runs ascending, descending, then back to the server's order; a missing value is last both ways", async (name) => {
    await renderTable();
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("ascending");
    expect(th("Deadline").getAttribute("aria-sort")).toBe("none");
    expect(rowIds()).toEqual(ASC[name]);
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("descending");
    expect(rowIds()).toEqual(DESC[name]);
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("none");
    expect(rowIds()).toEqual(SERVER_ORDER);
  });

  it("Deadline starts ascending (#923), then runs descending, then back to the server's order", async () => {
    await renderTable();
    expect(th("Deadline").getAttribute("aria-sort")).toBe("ascending");
    expect(rowIds()).toEqual(BY_DEADLINE);
    await sortBy("Deadline");
    expect(th("Deadline").getAttribute("aria-sort")).toBe("descending");
    expect(rowIds()).toEqual(["p5", "p1", "p4", "p2", "p3"]);
    await sortBy("Deadline");
    expect(th("Deadline").getAttribute("aria-sort")).toBe("none");
    expect(rowIds()).toEqual(SERVER_ORDER);
  });

  it("Progress has no header sort (frame 4b)", async () => {
    await renderTable();
    expect(th("Progress").querySelector("button")).toBeNull();
  });

  it("sorts Stage by pipeline order and keeps tied rows in the server's order", async () => {
    await renderTable();
    await sortBy("Stage");
    // Awaiting RAW (p2, p4), Editing (p3), Delivered (p1, p5): not alphabetical, ties in server order.
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p1", "p5"]);
  });

  it("only one column is sorted at a time", async () => {
    await renderTable();
    await sortBy("Priority");
    await sortBy("Project");
    expect(th("Project").getAttribute("aria-sort")).toBe("ascending");
    expect(th("Priority").getAttribute("aria-sort")).toBe("none");
  });
});

describe("Group by (#431)", () => {
  it("None is one table with no group headers", async () => {
    await renderTable();
    expect(groupTriggers()).toHaveLength(0);
    expect(table().querySelectorAll("table")).toHaveLength(1);
  });

  it("Stage: pipeline order, empty Stages omitted, counts, group rows inside ONE table under one header (#923, 4b)", async () => {
    projects = sortFixture().filter((project) => project.id !== "p3");
    await renderTable();
    await chooseGroupBy("Stage");
    expect(groupLabels()).toEqual(["Awaiting RAW", "Delivered"]);
    expect(groupCounts()).toEqual(["2", "2"]);
    expect(table().querySelectorAll("table")).toHaveLength(1);
    expect(table().querySelectorAll("thead")).toHaveLength(1);
    // Delivered starts collapsed.
    expect(rowIds()).toEqual(["p2", "p4"]);
    expect(groupTriggers()[0]!.closest("tr")).not.toBeNull();
  });

  it("Client: A to Z (case-insensitive), No client last", async () => {
    await renderTable();
    await chooseGroupBy("Client");
    expect(groupLabels()).toEqual(["Alpha", "Beta", "Gamma", "No client"]);
    expect(groupCounts()).toEqual(["1", "2", "1", "1"]);
    // Within Beta, Deadline ascending: p4 (day 1) before p1 (day 2).
    expect(rowIds()).toEqual(["p2", "p4", "p1", "p5", "p3"]);
  });

  it("Delivered starts collapsed and every other Stage expanded; a toggle hides or shows its rows and says so with aria-expanded (#923)", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
    expect(rowIds()).toEqual(["p2", "p4", "p3"]);
    await click(groupTriggers()[0]!);
    expect(groupTriggers()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).toEqual(["p3"]);
    await click(groupTriggers()[2]!);
    expect(groupTriggers()[2]!.getAttribute("aria-expanded")).toBe("true");
    expect(rowIds()).toEqual(["p3", "p1", "p5"]);
    await click(groupTriggers()[0]!);
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p1", "p5"]);
  });

  it("changing Group by starts that Group by's defaults again", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    await click(groupTriggers()[0]!);
    expect(rowIds()).toEqual(["p3"]);
    await chooseGroupBy("Client");
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "true"]);
    await chooseGroupBy("Stage");
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
    expect(rowIds()).toHaveLength(3);
  });

  it("sorts within each group under the table's one header", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    await click(groupTriggers()[2]!);
    await sortBy("Project");
    // Awaiting RAW: 2 Oak, 5 Elm. Editing: 1 Oak. Delivered: 3 Elm before 10 Oak.
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p5", "p1"]);
    expect(headers().filter((cell) => cell.textContent?.trim() === "Project").map((cell) => cell.getAttribute("aria-sort"))).toEqual(["ascending"]);
  });

  it("back to None returns to one table", async () => {
    await renderTable();
    await chooseGroupBy("Client");
    await chooseGroupBy("None");
    expect(groupTriggers()).toHaveLength(0);
    expect(table().querySelectorAll("table")).toHaveLength(1);
    expect(rowIds()).toHaveLength(5);
  });

  it("counts follow the rows the filtered list returns", async () => {
    projects = [row("p1", { stageKey: "awaiting_raw" }), row("p2", { stageKey: "awaiting_raw" })];
    await renderTable();
    await chooseGroupBy("Stage");
    expect(groupCounts()).toEqual(["2"]);
  });
});

describe("column visibility (#431)", () => {
  it("hides a column from the Display menu, keeps the menu open, and remembers it for this viewer", async () => {
    await renderTable();
    await toggleColumn("Editors");
    expect(headerNames()).not.toContain("Editors");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(JSON.parse(storage.get(tablePrefsKey("user-1"))!)).toEqual({ groupBy: "none", hiddenColumns: ["editors"], showDelivered: true });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS.filter((name) => name !== "Editors"));
  });

  it("does not show another viewer's choice", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "client", hiddenColumns: ["editors"] }));
    currentUser = "user-2";
    await renderTable();
    expect(headerNames()).toEqual(DEFAULT_HEADERS);
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
  });

  it("restores a stored Group by and hidden columns", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "stage", hiddenColumns: ["raw", "editors"] }));
    await renderTable();
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    expect(headerNames()).toEqual(["Project", "Stage", "Client", "Shoot", "Deadline", "Progress", "Priority"]);
    expect(headerNames()).not.toContain("RAW received");
    expect(headerNames()).not.toContain("Editors");
  });

  it("reads a corrupt stored value as the defaults", async () => {
    storage.set(tablePrefsKey("user-1"), "{not json");
    await renderTable();
    expect(headerNames()).toEqual(DEFAULT_HEADERS);
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
  });

  it("survives storage that throws", async () => {
    storageBroken = true;
    await renderTable();
    expect(headerNames()).toEqual(DEFAULT_HEADERS);
    await toggleColumn("Client");
    expect(headerNames()).not.toContain("Client");
  });

  it("never offers Project in the menu, and Project stays even if a stored value names it", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "none", hiddenColumns: ["address", "stage"] }));
    await renderTable();
    await openDisplay();
    expect(columnCheckboxLabels()).not.toContain("Project");
    expect(headerNames()).toContain("Project");
    expect(headerNames()).not.toContain("Stage");
  });

  it("gives an External Editor no Priority or Progress column and no menu entry for them", async () => {
    auth.role = "external_editor";
    auth.caps = new Set();
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS.filter((name) => name !== "Priority" && name !== "Progress"));
    await openDisplay();
    expect(columnCheckboxLabels()).not.toContain("Priority");
    expect(columnCheckboxLabels()).not.toContain("Progress");
  });

  it("keeps Group by visible beside the column items", async () => {
    await renderTable();
    await openDisplay();
    expect(displayTrigger()!.disabled).toBe(false);
    expect(columnCheckboxLabels()).toEqual(["Stage", "Client", "Shoot", "Deadline", "Progress", "Editors", "Priority", "RAW received"]);
  });
});

describe("narrow screens: the phone list (#923, frame 4g)", () => {
  const PAST = Date.parse("2020-01-01T00:00:00.000Z");
  const list = () => table().querySelector<HTMLElement>('[data-testid="project-table-phone-list"]');
  const phoneRow = (id: string) => table().querySelector<HTMLAnchorElement>(`[data-testid="project-table-row-link"][href="/projects/${id}"]`)!.closest("li")!;

  it("is a list grouped by Stage, not a grid, and leaves the saved choice untouched; the Display menu says why", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "stage", hiddenColumns: ["deadline"] }));
    const before = storage.get(tablePrefsKey("user-1"));
    narrow = true;
    await renderTable();
    expect(table().querySelector("table")).toBeNull();
    expect(list()).not.toBeNull();
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    expect(groupCounts()).toEqual(["2", "1", "2"]);
    // Delivered starts collapsed here too.
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
    expect(rowIds()).toEqual(["p2", "p4", "p3"]);
    await click(groupTriggers()[2]!);
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p1", "p5"]);
    await openDisplay();
    expect(document.querySelector('[data-testid="table-display-narrow-note"]')?.textContent).toContain("list");
    expect(storage.get(tablePrefsKey("user-1"))).toBe(before);
  });

  it("each row shows the thumb, street, suburb, Deadline with its late chip, and the editors", async () => {
    narrow = true;
    projects = [row("p1", { street: "5/11 Bank Street", suburb: "North Sydney", deadlineAt: PAST, deadlineLocalCivil: "2020-01-01T11:00", editors: [{ id: "e1", name: "Mia Chen" }] })];
    await renderTable();
    const item = phoneRow("p1");
    expect(item.querySelector('[data-testid="project-table-row-link"]')!.textContent).toBe("5/11 Bank Street");
    expect(item.textContent).toContain("North Sydney");
    expect(item.querySelector('[data-testid="project-table-deadline-trigger"]')).not.toBeNull();
    expect(item.querySelector('[data-testid="late-chip"]')!.textContent).toBe(lateLabel(projectLateness({ stageKey: "awaiting_raw", deadlineAt: PAST, archived: false }, Date.now())));
    expect(item.querySelector('[aria-label="Mia Chen"]')).not.toBeNull();
    expect(item.getAttribute("data-late")).toBe("true");
  });

  it("Group by None is one flat list with the count footer", async () => {
    narrow = true;
    await renderTable();
    expect(groupTriggers()).toHaveLength(0);
    expect(rowIds()).toEqual(BY_DEADLINE);
    expect(table().querySelector('[data-testid="project-table-footer"]')!.textContent).toBe("5 projects");
  });
});

describe("opening a Project (#431)", () => {
  const link = (id: string) => rowFor(id).querySelector<HTMLAnchorElement>('[data-testid="project-table-row-link"]')!;

  // Only a Project id that parses as a staff route is intercepted (`safeStaffDestination`).
  const UUID = "10000000-0000-4000-8000-000000000001";
  async function clickLink(init: MouseEventInit = {}) {
    projects = [row(UUID)];
    await renderTable();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
    await act(async () => { link(UUID).dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
    await settle(1);
    return event;
  }

  it("a plain click on the row link is an SPA navigation to the Project URL", async () => {
    const event = await clickLink();
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe(`/projects/${UUID}`);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])("a click with %j is left to the browser", async (init) => {
    const event = await clickLink(init);
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens through the link alone: the row carries no click handler of its own", async () => {
    await renderTable();
    // A click on a plain cell does not navigate (the link's overlay is a layout fact the browser pass measures).
    await click(rowFor("p2").querySelectorAll("td")[1]!);
    expect(window.location.pathname).toBe("/");
  });

  it("the link sits in the Address cell and nothing interactive sits inside it", async () => {
    await renderTable();
    const anchor = link("p2");
    expect(anchor.closest("td")).toBe(rowFor("p2").querySelector("td"));
    expect(anchor.querySelector("button, a, [role=radio], input")).toBeNull();
  });
});

describe("Priority stars (#431)", () => {
  const star = (id: string, label: string) => rowFor(id).querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`)!;
  const group = (id: string) => rowFor(id).querySelector<HTMLElement>('[role="radiogroup"]');

  it("a star click saves the Priority and does not open the Project", async () => {
    await renderTable();
    await click(star("p2", "4 stars"));
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/p2/priority", { priority: 4 });
    expect(window.location.pathname).toBe("/");
    expect(star("p2", "4 stars").getAttribute("aria-checked")).toBe("true");
  });

  it("rolls back and announces when the save fails", async () => {
    apiPostMock.mockRejectedValueOnce(new Error("Offline"));
    await renderTable();
    await click(star("p2", "4 stars"));
    await settle();
    expect(star("p2", "2 stars").getAttribute("aria-checked")).toBe("true");
    expect(star("p2", "4 stars").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("Priority for 2 Oak St was not saved: Offline.");
    expect(window.location.pathname).toBe("/");
  });

  it("is read-only for an archived Project", async () => {
    projects = [row("p1", { priority: 3, archivedAt: "2026-01-01T00:00:00.000Z" }), row("p2", { priority: 3 })];
    await renderTable();
    expect(group("p1")).toBeNull();
    expect(rowFor("p1").querySelector('[role="img"][aria-label="Priority 3 of 5 stars"]')).not.toBeNull();
    expect(group("p2")).not.toBeNull();
  });

  it("is read-only without the Priority capability", async () => {
    auth.caps = new Set(["adminBackend"]);
    await renderTable();
    expect(table().querySelector('[role="radiogroup"]')).toBeNull();
    expect(rowFor("p2").querySelector('[role="img"][aria-label="Priority 2 of 5 stars"]')).not.toBeNull();
  });

  it("is read-only once the principal is terminal", async () => {
    await renderTable();
    expect(group("p2")).not.toBeNull();
    await act(async () => { runtime.markPrincipalTerminal(); await Promise.resolve(); });
    await settle();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });
});

describe("the Deadline cell (#431)", () => {
  const trigger = (id: string) => rowFor(id).querySelector<HTMLButtonElement>('[data-testid="project-table-deadline-trigger"]');
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Deadline"]');

  async function openDeadline(id: string) {
    await click(trigger(id)!);
    for (let i = 0; i < 20 && !(dialog() && popupButton(dialog()!, "Apply")); i++) await settle(1);
    expect(dialog()).not.toBeNull();
  }

  it("saves through the same editor as the Project page, and the popup never navigates", async () => {
    await renderTable();
    expect(trigger("p2")!.getAttribute("aria-label")).toBe("Deadline for 2 Oak St: Thu 1 Jan · 09:00");
    await openDeadline("p2");
    expect(apiGetMock).toHaveBeenCalledWith("/api/projects/p2");
    // Pressing around inside the popup (a portal child of the row in React's tree) must not open the Project.
    await pickPopupDay(dialog()!, "2099-01-05");
    await click(dialog()!);
    expect(window.location.pathname).toBe("/");
    await act(async () => { popupButton(dialog()!, "Apply")!.click(); await Promise.resolve(); });
    await settle();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock.mock.calls[0]![0]).toBe("/api/projects/p2/deadline");
    expect(apiPutMock.mock.calls[0]![1]).toMatchObject({ expectedVersion: 1, deadline: { localCivil: "2099-01-05T09:00" } });
    expect(window.location.pathname).toBe("/");
  });

  it("reads the shell-aware padding once per open, never while closed or at mount (#597)", async () => {
    shellBottom.mockClear();
    await renderTable();
    expect(shellBottom).not.toHaveBeenCalled();
    await openDeadline("p2");
    expect(shellBottom).toHaveBeenCalledTimes(1);
  });

  it("handles a 409 conflict once, leaving the popup open", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("stale", 409, { code: "deadline_version_conflict", current: detailBody("p2").deadlineSchedule }));
    await renderTable();
    await openDeadline("p2");
    await pickPopupDay(dialog()!, "2099-01-06");
    await act(async () => { popupButton(dialog()!, "Apply")!.click(); await Promise.resolve(); });
    await settle();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("puts \"overdue\" in the accessible name of an overdue Deadline", async () => {
    projects = [row("p1", { deadlineAt: Date.parse("2020-01-01T00:00:00.000Z"), deadlineLocalCivil: "2020-01-01T11:00" })];
    await renderTable();
    expect(trigger("p1")!.getAttribute("aria-label")).toBe("Deadline for p1 Street: Wed 1 Jan · 11:00 (overdue)");
    // The tone must be a utility that exists (`--color-signal-critical`); `signal-text-tokens.guard.test.ts`
    // proves every `text-signal-*` in src resolves, so a typo here cannot ship as a silent no-op.
    expect(trigger("p1")!.classList.contains("text-signal-critical")).toBe(true);
    expect(trigger("p1")!.classList.contains("text-foreground")).toBe(false);
  });

  it("is plain text without the edit capability, for a delivered Project, and for an archived one", async () => {
    auth.caps = new Set(["adminBackend", "prioritizeProjects"]);
    await renderTable();
    expect(table().querySelector('[data-testid="project-table-deadline-trigger"]')).toBeNull();
    expect(rowFor("p2").querySelector('time[data-testid="project-table-deadline"]')).not.toBeNull();
    auth.caps = new Set(["adminBackend", "prioritizeProjects", "editProject"]);
    await rerender();
    expect(trigger("p2")).not.toBeNull();
    expect(trigger("p1")).toBeNull(); // p1 is delivered
    projects = [row("p9", { deadlineAt: day(1), deadlineLocalCivil: civil(1), archivedAt: "2026-01-01T00:00:00.000Z" })];
    await act(async () => { await queryClient.invalidateQueries(); });
    await settle();
    expect(trigger("p9")).toBeNull();
  });

  it("shows an inert dash and no trigger when there is no Deadline", async () => {
    await renderTable();
    const cell = rowFor("p3").querySelector('[data-testid="project-table-deadline"]')!;
    expect(cell.textContent).toContain("—");
    expect(cell.textContent).toContain("No deadline");
    expect(trigger("p3")).toBeNull();
  });
});

describe("rows survive a Dashboard re-render (#431)", () => {
  it("keeps the same Address link node when volatile props change", async () => {
    await renderTable();
    const before = table().querySelector('[data-testid="project-table-row-link"]');
    await click(star("p2", "4 stars"));
    await settle();
    expect(table().querySelector('[data-testid="project-table-row-link"]')).toBe(before);
  });

  function star(id: string, label: string) {
    return rowFor(id).querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`)!;
  }
});

describe("review fixes (#431)", () => {
  const PAST = Date.parse("2020-01-01T00:00:00.000Z");
  const pastRow = (id: string, over: Partial<Row> = {}) => row(id, { deadlineAt: PAST, deadlineLocalCivil: "2020-01-01T11:00", ...over });

  it("D9: a delivered Project with a past Deadline is not overdue (no red, no spoken word)", async () => {
    auth.caps = new Set(["adminBackend", "prioritizeProjects"]);
    projects = [pastRow("p1", { stageKey: "delivered" }), pastRow("p2", { stageKey: "awaiting_raw" })];
    await renderTable();
    const delivered = rowFor("p1").querySelector<HTMLElement>('time[data-testid="project-table-deadline"]')!;
    expect(delivered.textContent).not.toContain("overdue");
    expect(delivered.classList.contains("text-signal-critical")).toBe(false);
    const active = rowFor("p2").querySelector<HTMLElement>('time[data-testid="project-table-deadline"]')!;
    expect(active.textContent).toContain("(overdue)");
    expect(active.classList.contains("text-signal-critical")).toBe(true);
  });

  it("D2: the read-only Deadline and the editable trigger share the Shoot date's text size", async () => {
    projects = [row("p1", { shootDate: "2026-03-01", deadlineAt: day(1), deadlineLocalCivil: civil(1) }), row("p2", { stageKey: "delivered", deadlineAt: day(1), deadlineLocalCivil: civil(1) })];
    await renderTable();
    const size = "text-[length:var(--text-sm)]";
    expect(rowFor("p1").querySelector('[data-testid="project-table-deadline-trigger"]')!.className).toContain(size);
    expect(rowFor("p2").querySelector('time[data-testid="project-table-deadline"]')!.className).toContain(size);
  });

  it("S2: only interactive Deadline and Priority controls ride above the row link; read-only content lets the click through", async () => {
    auth.caps = new Set(["adminBackend", "editProject"]); // no prioritizeProjects: stars are read-only
    projects = [row("p1", { deadlineAt: day(1), deadlineLocalCivil: civil(1), priority: 3 }), row("p2", { stageKey: "delivered", deadlineAt: day(1), deadlineLocalCivil: civil(1), priority: 3 }), row("p3")];
    await renderTable();
    // `lifted`: the control sits in a wrapper with `z-[1]`, i.e. above the row link's ::after overlay.
    const lifted = (element: Element | null) => {
      for (let node = element; node && node !== table(); node = node.parentElement) if (node.classList.contains("z-[1]")) return true;
      return false;
    };
    // editable Deadline is lifted; read-only timestamp and the empty dash are not
    expect(lifted(rowFor("p1").querySelector('[data-testid="project-table-deadline-trigger"]'))).toBe(true);
    expect(lifted(rowFor("p2").querySelector('time[data-testid="project-table-deadline"]'))).toBe(false);
    expect(lifted(rowFor("p3").querySelector('[data-testid="project-table-deadline"]'))).toBe(false);
    // read-only stars are not lifted
    expect(lifted(rowFor("p1").querySelector('[data-testid="project-table-priority"]'))).toBe(false);
    auth.caps = new Set(["adminBackend", "editProject", "prioritizeProjects"]);
    await rerender();
    expect(lifted(rowFor("p1").querySelector('[data-testid="project-table-priority"]'))).toBe(true);
  });

  it("D3: the card-padding cancelling margins apply to the read-only stars only", async () => {
    projects = [row("p1", { priority: 3 })];
    await renderTable();
    const wrapper = () => rowFor("p1").querySelector<HTMLElement>('[data-testid="project-table-priority"]')!;
    expect(wrapper().classList.contains("-mx-[var(--space-3)]")).toBe(false);
    expect(wrapper().classList.contains("-mb-[var(--space-3)]")).toBe(false);
    auth.caps = new Set(["adminBackend", "editProject"]);
    await rerender();
    expect(wrapper().classList.contains("-mx-[var(--space-3)]")).toBe(true);
  });

  it("S3: two Client groups whose labels sanitise alike are still two groups with their own toggles", async () => {
    projects = [row("p1", { agencyName: "A&B" }), row("p2", { agencyName: "A B" })];
    await renderTable();
    await chooseGroupBy("Client");
    expect(groupLabels()).toEqual(["A B", "A&B"]);
    await click(groupTriggers()[0]!);
    expect(rowIds()).toEqual(["p1"]);
  });

  it("D7: the group marker is a chevron that rotates when open", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    const trigger = groupTriggers()[0]!;
    const chevron = () => trigger.querySelector("svg")!;
    expect(trigger.textContent).not.toMatch(/[+−]/);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(chevron().classList.contains("rotate-90")).toBe(true);
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(chevron().classList.contains("rotate-90")).toBe(false);
  });

  it("the Client cell and the Client group agree on the empty label", async () => {
    projects = [row("p1", { agencyName: null })];
    await renderTable();
    expect(rowFor("p1").textContent).toContain("No client");
    expect(rowFor("p1").textContent).not.toContain("Agency pending");
  });

  it("S1: the ungrouped scroll area is a bounded flex chain, so the viewport (not the clipped container) scrolls", async () => {
    await renderTable();
    // Every box between the <table> and the section must be a bounded flex column (container and
    // wrapper at least), or the viewport grows to content height and the container clips it.
    let bounded = 0;
    for (let node = table().querySelector("table")!.parentElement; node && node !== table(); node = node.parentElement) {
      if (/\bmin-h-0\b/.test(node.className) && /\bflex-col\b/.test(node.className)) bounded += 1;
    }
    expect(bounded).toBeGreaterThanOrEqual(2);
  });

  it("D4: the cover letter fallback is sized for the 44x30 thumb (#923), not the Board card", async () => {
    await renderTable();
    const letter = [...rowFor("p1").querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find((node) => node.textContent === "1")!;
    expect(letter.className).toContain("text-[length:var(--text-sm)]");
  });
});

// ---------------------------------------------------------------------------------------------
// #923: round 4 -- the appearance module drives every late, due-today and done fact
// ---------------------------------------------------------------------------------------------

const PAST_A = Date.parse("2020-01-01T00:00:00.000Z");
const PAST_B = Date.parse("2020-03-01T00:00:00.000Z");
const lateText = (deadlineAt: number) => lateLabel(projectLateness({ stageKey: "awaiting_raw", deadlineAt, archived: false }, Date.now()));
const daysLate = (deadlineAt: number) => {
  const lateness = projectLateness({ stageKey: "awaiting_raw", deadlineAt, archived: false }, Date.now());
  return lateness.late ? lateness.daysLate : 0;
};

function roundFourFixture(): Row[] {
  return [
    row("a1", { stageKey: "awaiting_raw", deadlineAt: PAST_A, deadlineLocalCivil: "2020-01-01T11:00", checklist: { completed: 1, total: 4 } }),
    row("a2", { stageKey: "awaiting_raw", deadlineAt: PAST_B, deadlineLocalCivil: "2020-03-01T11:00", checklist: { completed: 2, total: 2 } }),
    row("a3", { stageKey: "awaiting_raw", deadlineAt: day(1), deadlineLocalCivil: civil(1) }),
    row("e1", { stageKey: "editing_autohdr", deadlineAt: day(2), deadlineLocalCivil: civil(2), checklist: { completed: 0, total: 0 } }),
    row("d1", { stageKey: "delivered", deadlineAt: PAST_A, deadlineLocalCivil: "2020-01-01T11:00" }),
  ];
}

describe("a new viewer's Table (#923, frame 4b)", () => {
  beforeEach(() => { storage.clear(); });

  it("is grouped by Stage under one header, with Delivered collapsed and RAW received hidden", async () => {
    await renderTable();
    expect(table().querySelectorAll("table")).toHaveLength(1);
    expect(table().querySelectorAll("thead")).toHaveLength(1);
    expect(headerNames()).toEqual(DEFAULT_HEADERS);
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
    expect(rowIds()).toEqual(["p2", "p4", "p3"]);
  });

  it("a group row carries its swatch, count, late count, oldest lateness and summed task progress", async () => {
    projects = roundFourFixture();
    await renderTable();
    const groupRow = groupTriggers()[0]!.closest("tr")!;
    expect(groupRow.querySelector('[data-testid="stage-key-swatch"]')!.getAttribute("data-treatment")).toBe(stageTone("awaiting_raw").treatment);
    expect(groupRow.querySelector('[data-testid="project-table-group-count"]')!.textContent).toBe("3");
    expect(groupRow.querySelector('[data-testid="project-table-group-late"]')!.textContent).toBe("2 late");
    expect(groupRow.textContent).toContain(`Oldest late: ${daysLate(PAST_A)} days`);
    expect(groupRow.textContent).toContain("3 of 6 done");
    // Editing: no late rows, so no chip and no oldest line; its only row has no Subtasks.
    const editing = groupTriggers()[1]!.closest("tr")!;
    expect(editing.querySelector('[data-testid="project-table-group-late"]')).toBeNull();
    expect(editing.textContent).not.toContain("Oldest late");
    expect(editing.textContent).not.toContain("done");
  });

  it("a late row is marked data-late and carries lateLabel's chip; a Delivered row with a past Deadline is not late", async () => {
    projects = roundFourFixture();
    await renderTable();
    await click(groupTriggers()[2]!);
    const project = (id: string) => rowFor(id).querySelector<HTMLElement>('[data-testid="project-table-project"]')!;
    expect(project("a1").getAttribute("data-late")).toBe("true");
    expect(rowFor("a1").querySelector('[data-testid="late-chip"]')!.textContent).toBe(lateText(PAST_A));
    expect(project("a3").getAttribute("data-late")).toBe("false");
    expect(rowFor("a3").querySelector('[data-testid="late-chip"]')).toBeNull();
    expect(project("d1").getAttribute("data-late")).toBe("false");
    expect(rowFor("d1").querySelector('[data-testid="late-chip"]')).toBeNull();
  });

  it("the Stage cell is the module's swatch and the sentence-case name, autoHDR as a suffix", async () => {
    projects = roundFourFixture();
    await renderTable();
    const stage = rowFor("e1").querySelector<HTMLElement>('[data-testid="stage-label"]')!;
    expect(stage.getAttribute("data-stage")).toBe(stageTone("editing_autohdr").stage);
    expect(stage.querySelector<HTMLElement>('[data-testid="stage-key-swatch"]')!.style.getPropertyValue("--swatch-color")).toBe(stageTone("editing_autohdr").color);
    expect(stage.textContent).toBe("Editing· autoHDR");
    expect(rowFor("a1").querySelector('[data-testid="stage-label"]')!.textContent).toBe("Awaiting RAW");
  });

  it("Progress: N of M done with a bar, No tasks for none, and nothing when the count is unknown", async () => {
    projects = roundFourFixture();
    await renderTable();
    const progress = (id: string) => rowFor(id).querySelector<HTMLElement>('[data-testid="done-progress"]');
    // The first child is the label; Base UI adds a visually hidden span inside the bar itself.
    expect(progress("a1")!.firstElementChild!.textContent).toBe("1 of 4 done");
    expect(progress("a1")!.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(progress("e1")!.textContent).toBe("No tasks");
    expect(progress("a3")).toBeNull();
  });
});

describe("the Table component (#923: now, Show Delivered, footer, skeleton)", () => {
  const NOW = Date.parse("2026-10-19T02:00:00.000Z"); // 13:00 in Sydney
  const asProjects = (rows: Row[]) => rows as unknown as ProjectSummary[];

  function direct(props: Partial<DashboardTableProps> = {}) {
    const all: DashboardTableProps = {
      projects: asProjects(sortFixture()), role: "admin", groupBy: "none", hiddenColumns: [], canPrioritize: false, pendingOrdering: new Set(), terminal: false,
      onPriorityChange: () => undefined, projectHrefFor: (id) => `/projects/${id}`, now: NOW, showDelivered: true, ...props,
    };
    return (
      <ProjectQueryRuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}><DashboardTable {...all} /></QueryClientProvider>
      </ProjectQueryRuntimeProvider>
    );
  }
  async function renderDirect(props: Partial<DashboardTableProps> = {}) {
    await act(async () => { root.render(direct(props)); await Promise.resolve(); });
    await settle(1);
  }
  const footer = () => table().querySelector('[data-testid="project-table-footer"]')?.textContent ?? null;

  it("flat: the footer counts the rows, and says Display hid Delivered when it did (frame 4c)", async () => {
    await renderDirect();
    expect(footer()).toBe("5 projects");
    await renderDirect({ showDelivered: false });
    expect(rowIds()).toEqual(["p2", "p4", "p3"]);
    expect(footer()).toBe("3 of 5 projects · Delivered hidden by Display");
  });

  it("grouped: Show Delivered off drops the Delivered group, and there is no footer", async () => {
    await renderDirect({ groupBy: "stage", showDelivered: false });
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing"]);
    expect(footer()).toBeNull();
  });

  it("everything hidden by Display says so instead of an empty grid", async () => {
    await renderDirect({ projects: asProjects([row("d1", { stageKey: "delivered" })]), showDelivered: false });
    expect(table().textContent).toContain("Delivered projects are hidden by Display.");
  });

  it("reads lateness from the `now` it is given, and a tick keeps the same row nodes", async () => {
    const deadline = Date.parse("2026-10-19T06:00:00.000Z"); // 17:00 in Sydney, today
    const projectsNow = asProjects([row("t1", { deadlineAt: deadline, deadlineLocalCivil: "2026-10-19T17:00" })]);
    await renderDirect({ projects: projectsNow });
    expect(rowFor("t1").querySelector('[data-testid="project-table-due-today"]')).not.toBeNull();
    expect(rowFor("t1").querySelector('[data-testid="late-chip"]')).toBeNull();
    const link = rowFor("t1").querySelector('[data-testid="project-table-row-link"]');
    await renderDirect({ projects: projectsNow, now: Date.parse("2026-10-19T07:00:00.000Z") });
    expect(rowFor("t1").querySelector('[data-testid="late-chip"]')!.textContent).toBe("Late today");
    expect(rowFor("t1").querySelector('[data-testid="project-table-due-today"]')).toBeNull();
    expect(rowFor("t1").querySelector('[data-testid="project-table-row-link"]')).toBe(link);
  });

  it("TableSkeleton: a status in the Table's shape, with the loading words for a screen reader (4h)", async () => {
    await act(async () => { root.render(<TableSkeleton label="Loading projects." />); await Promise.resolve(); });
    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.getAttribute("data-testid")).toBe("table-skeleton");
    expect(status.textContent).toContain("Loading projects.");
    expect(status.querySelectorAll('[data-testid="table-skeleton-row"]').length).toBeGreaterThanOrEqual(5);
  });

  it("Show Delivered sits in the Table's Display menu once the Dashboard wires it", async () => {
    await renderTable();
    await openDisplay();
    // Wiring `onShowDeliveredChange` is the Dashboard's (#923 S5); until then the group is absent, never a dead checkbox.
    expect(groupCheckboxes("Show").every((item) => item.textContent === "Delivered Projects")).toBe(true);
  });
});
