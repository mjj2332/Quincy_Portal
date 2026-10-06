/**
 * #431 -- the Dashboard Table on the ReUI data-grid. Everything is located by role, accessible
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
import { chooseGroupBy, columnCheckboxLabels, displayTrigger, openDisplay, toggleColumn } from "./dashboard-display-test-helpers";
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

const COLUMN_HEADERS = ["Address", "Stage", "Client", "Shoot date", "Deadline", "Editors", "Priority", "RAW received"];

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
  storage = new Map();
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
const groupLabels = () => groupTriggers().map((trigger) => trigger.textContent?.replace(/^[−+]/, "").replace(/\d+$/, "").trim());
const groupCounts = () => [...table().querySelectorAll('[data-testid="project-table-group-count"]')].map((badge) => badge.textContent);

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
  await settle(1);
}

async function sortBy(name: string) {
  await click(th(name).querySelector("button")!);
}

describe("the Table's structure (#431)", () => {
  it("is a table, in a labelled section, with the eight columns in order and nothing sorted", async () => {
    await renderTable();
    expect(table().tagName).toBe("SECTION");
    expect(table().querySelector("table")).not.toBeNull();
    expect(table().querySelector('[role="grid"]')).toBeNull();
    expect(headerNames()).toEqual(COLUMN_HEADERS);
    expect(headers().map((cell) => cell.getAttribute("aria-sort"))).toEqual(Array(8).fill("none"));
    expect(rowIds()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
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
    expect(tr.textContent).toContain("Bondi · 2026");
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
    Address: ["p3", "p2", "p5", "p4", "p1"],
    Stage: ["p2", "p4", "p3", "p1", "p5"],
    Client: ["p2", "p4", "p1", "p5", "p3"],
    "Shoot date": ["p2", "p4", "p1", "p5", "p3"],
    Deadline: ["p2", "p4", "p1", "p5", "p3"],
    Editors: ["p2", "p5", "p4", "p1", "p3"],
    Priority: ["p5", "p2", "p4", "p1", "p3"],
    "RAW received": ["p5", "p1", "p3", "p2", "p4"],
  };
  const DESC: Record<string, string[]> = {
    Address: ["p1", "p4", "p5", "p2", "p3"],
    Stage: ["p1", "p5", "p3", "p2", "p4"],
    Client: ["p5", "p1", "p4", "p2", "p3"],
    "Shoot date": ["p5", "p1", "p4", "p2", "p3"],
    Deadline: ["p5", "p1", "p4", "p2", "p3"],
    Editors: ["p1", "p4", "p5", "p2", "p3"],
    Priority: ["p1", "p4", "p2", "p5", "p3"],
    "RAW received": ["p4", "p2", "p3", "p1", "p5"],
  };

  it.each(COLUMN_HEADERS)("%s runs ascending, descending, then back to the server's order; a missing value is last both ways", async (name) => {
    await renderTable();
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("ascending");
    expect(rowIds()).toEqual(ASC[name]);
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("descending");
    expect(rowIds()).toEqual(DESC[name]);
    await sortBy(name);
    expect(th(name).getAttribute("aria-sort")).toBe("none");
    expect(rowIds()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
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
    await sortBy("Address");
    expect(th("Address").getAttribute("aria-sort")).toBe("ascending");
    expect(th("Priority").getAttribute("aria-sort")).toBe("none");
  });
});

describe("Group by (#431)", () => {
  it("None is one table with no group headers", async () => {
    await renderTable();
    expect(groupTriggers()).toHaveLength(0);
    expect(table().querySelectorAll("table")).toHaveLength(1);
  });

  it("Stage: pipeline order, empty Stages omitted, counts, one header row per group", async () => {
    projects = sortFixture().filter((project) => project.id !== "p3");
    await renderTable();
    await chooseGroupBy("Stage");
    expect(groupLabels()).toEqual(["Awaiting RAW", "Delivered"]);
    expect(groupCounts()).toEqual(["2", "2"]);
    expect(table().querySelectorAll("table")).toHaveLength(2);
    expect(table().querySelectorAll("thead")).toHaveLength(2);
    expect(rowIds()).toEqual(["p2", "p4", "p1", "p5"]);
  });

  it("Client: A to Z (case-insensitive), No client last", async () => {
    await renderTable();
    await chooseGroupBy("Client");
    expect(groupLabels()).toEqual(["Alpha", "Beta", "Gamma", "No client"]);
    expect(groupCounts()).toEqual(["1", "2", "1", "1"]);
    expect(rowIds()).toEqual(["p2", "p1", "p4", "p5", "p3"]);
  });

  it("every group starts expanded; collapsing hides its rows and says so with aria-expanded", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "true"]);
    await click(groupTriggers()[0]!);
    expect(groupTriggers()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).toEqual(["p3", "p1", "p5"]);
    await click(groupTriggers()[0]!);
    expect(groupTriggers()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p1", "p5"]);
  });

  it("changing Group by starts every group expanded again", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    await click(groupTriggers()[0]!);
    expect(rowIds()).toEqual(["p3", "p1", "p5"]);
    await chooseGroupBy("Client");
    expect(groupTriggers().map((trigger) => trigger.getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "true"]);
    await chooseGroupBy("Stage");
    expect(groupTriggers()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(rowIds()).toHaveLength(5);
  });

  it("sorts within each group, and a header sort is shared by every group's header", async () => {
    await renderTable();
    await chooseGroupBy("Stage");
    await sortBy("Address");
    // Awaiting RAW: 2 Oak, 5 Elm. Editing: 1 Oak. Delivered: 3 Elm before 10 Oak.
    expect(rowIds()).toEqual(["p2", "p4", "p3", "p5", "p1"]);
    expect(headers().filter((cell) => cell.textContent?.trim() === "Address").map((cell) => cell.getAttribute("aria-sort"))).toEqual(["ascending", "ascending", "ascending"]);
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
    expect(JSON.parse(storage.get(tablePrefsKey("user-1"))!)).toEqual({ groupBy: "none", hiddenColumns: ["editors"] });
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS.filter((name) => name !== "Editors"));
  });

  it("does not show another viewer's choice", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "stage", hiddenColumns: ["raw"] }));
    currentUser = "user-2";
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS);
    expect(groupTriggers()).toHaveLength(0);
  });

  it("restores a stored Group by and hidden columns", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "stage", hiddenColumns: ["raw", "editors"] }));
    await renderTable();
    expect(groupLabels()).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    expect(headerNames()).toEqual(Array(3).fill(["Address", "Stage", "Client", "Shoot date", "Deadline", "Priority"]).flat());
    expect(headerNames()).not.toContain("RAW received");
    expect(headerNames()).not.toContain("Editors");
  });

  it("reads a corrupt stored value as the defaults", async () => {
    storage.set(tablePrefsKey("user-1"), "{not json");
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS);
  });

  it("survives storage that throws", async () => {
    storageBroken = true;
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS);
    await toggleColumn("Client");
    expect(headerNames()).not.toContain("Client");
  });

  it("never offers Address in the menu, and Address stays even if a stored value names it", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "none", hiddenColumns: ["address", "stage"] }));
    await renderTable();
    await openDisplay();
    expect(columnCheckboxLabels()).not.toContain("Address");
    expect(headerNames()).toContain("Address");
    expect(headerNames()).not.toContain("Stage");
  });

  it("gives an External Editor no Priority column and no menu entry for it", async () => {
    auth.role = "external_editor";
    auth.caps = new Set();
    await renderTable();
    expect(headerNames()).toEqual(COLUMN_HEADERS.filter((name) => name !== "Priority"));
    await openDisplay();
    expect(columnCheckboxLabels()).not.toContain("Priority");
  });

  it("keeps Group by visible beside the column items", async () => {
    await renderTable();
    await openDisplay();
    expect(displayTrigger()!.disabled).toBe(false);
    expect(columnCheckboxLabels()).toEqual(["Stage", "Client", "Shoot date", "Deadline", "Editors", "Priority", "RAW received"]);
  });
});

describe("narrow screens (#431)", () => {
  it("shows only Address and Deadline, leaves the saved choice untouched, and the Display menu says why", async () => {
    storage.set(tablePrefsKey("user-1"), JSON.stringify({ groupBy: "none", hiddenColumns: ["deadline"] }));
    const before = storage.get(tablePrefsKey("user-1"));
    narrow = true;
    await renderTable();
    expect(headerNames()).toEqual(["Address", "Deadline"]);
    await openDisplay();
    expect(document.querySelector('[data-testid="table-display-narrow-note"]')?.textContent).toContain("Address and Deadline");
    expect(storage.get(tablePrefsKey("user-1"))).toBe(before);
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

  it("S3: group headings get unique ids even when two labels sanitise alike", async () => {
    projects = [row("p1", { agencyName: "A&B" }), row("p2", { agencyName: "A B" })];
    await renderTable();
    await chooseGroupBy("Client");
    const sections = [...table().querySelectorAll('[data-testid="project-table-group"]')];
    expect(sections).toHaveLength(2);
    const ids = sections.map((section) => section.getAttribute("aria-labelledby")!);
    expect(new Set(ids).size).toBe(2);
    for (const [index, id] of ids.entries()) expect(document.getElementById(id)).toBe(sections[index]!.querySelector("h3"));
  });

  it("D7: the group marker is a chevron that rotates when open; the heading is not the column header's fill", async () => {
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
    expect(trigger.closest("h3")!.classList.contains("bg-secondary")).toBe(false);
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

  it("D4: the cover letter fallback is sized for the 48px box, not the Board card", async () => {
    await renderTable();
    const letter = [...rowFor("p1").querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find((node) => node.textContent === "1")!;
    expect(letter.className).toContain("text-[length:var(--text-lg)]");
  });
});
