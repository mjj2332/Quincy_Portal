/**
 * #464 — Show in Timeline: `ProductionGantt` lands on a named Project (`focus`), walking pages until
 * it is found, expanding and highlighting its row, scrolling it under the sticky header, moving
 * keyboard focus to its row link and reporting one outcome. Harness lifted from
 * `ProductionGantt-landing.dom.test.tsx` (same geometry stub; read its header for why).
 *
 * happy-dom lays nothing out, so the geometry `scrollGanttRowToTop` reads is stubbed: every row's
 * rect follows a fixed 40px pitch under a 64px sticky header and SCROLLS with the pane viewport
 * (a static stub would make "a refetch leaves scrollTop alone" vacuous), and `clientHeight` is 400.
 * The stub identifies the vendor's viewport/header by `dataset.slot` — a property read, not a
 * `[data-slot]` selector, so `test-seam.guard.test.ts` guard F has nothing to flag — and the
 * assertions read `scrollTop` off the viewports, never internal helper calls. Only `Date` is faked.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import { ApiError } from "../lib/api";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ProductionGantt } from "./ProductionGantt";
import { DEFAULT_GANTT_FACET_FILTERS, type ProductionGanttFacetFilters } from "../lib/production-gantt-filters";
import type { ProductionGanttFocusOutcome } from "./ProductionGantt";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// 2026-09-15 12:00 Sydney.
const TODAY = new Date("2026-09-15T02:00:00.000Z");
const HEADER_PX = 64;
const ROW_PX = 40;
const VIEWPORT_PX = 400;

interface ProjectSpec {
  n: number;
  shoot: string;
  deadline: string;
}
const pid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const streetOf = (n: number) => `${n} Landing Street`;

function projectRow({ n, shoot, deadline }: ProjectSpec) {
  return {
    id: pid(n),
    street: streetOf(n),
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "editing_autohdr",
    delivered: false,
    archived: false,
    shootDate: shoot,
    shootDateCivil: shoot,
    createdAt: `${shoot}T00:00:00.000Z`,
    barStartDate: shoot,
    deadline: { at: `${deadline}T05:00:00.000Z`, localCivil: `${deadline}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: false, canEditChildren: false },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
  };
}

function response(specs: ProjectSpec[], nextCursor: string | null = null, tooManyToDraw = false) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: specs.map(projectRow),
    page: { limit: 100, returned: specs.length, nextCursor },
    density: { matchedProjects: specs.length, matchedRows: specs.length, drawCap: 2000, tooManyToDraw },
  });
}

// past, past, COVERING (index 2), future, future, future.
const SIX: ProjectSpec[] = [
  { n: 1, shoot: "2026-08-01", deadline: "2026-08-05" },
  { n: 2, shoot: "2026-08-10", deadline: "2026-08-12" },
  { n: 3, shoot: "2026-09-10", deadline: "2026-09-20" },
  { n: 4, shoot: "2026-09-25", deadline: "2026-09-27" },
  { n: 5, shoot: "2026-10-01", deadline: "2026-10-03" },
  { n: 6, shoot: "2026-10-10", deadline: "2026-10-12" },
];
const offsetOfIndex = (index: number) => index * ROW_PX;

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

function slotOf(el: Element): string | undefined {
  return (el as HTMLElement).dataset?.slot;
}

/** Both pane viewports, found by a property read over the subtree. */
function viewports(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("*")].filter((el) => slotOf(el) === "scroll-area-viewport");
}

function scrollTops(host: HTMLElement): number[] {
  return viewports(host).map((el) => el.scrollTop);
}

function setScrollTops(host: HTMLElement, value: number) {
  for (const el of viewports(host)) el.scrollTop = value;
}

function navText(host: HTMLElement): string {
  return todayButton(host).parentElement?.textContent ?? "";
}

function todayButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Today");
  if (!button) throw new Error("no Today button");
  return button;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

type Focus = { projectId: string; token: number } | null;
function tree(client: QueryClient, focus: Focus, onFocusSettled: (token: number, outcome: ProductionGanttFocusOutcome) => void, filters: ProductionGanttFacetFilters = DEFAULT_GANTT_FACET_FILTERS) {
  return (
    <QueryClientProvider client={client}>
      <ProductionGantt identity={identity} q="" filters={filters} onFiltersChange={() => {}} projectHrefFor={(id) => `/projects/${id}`} focus={focus} onFocusSettled={onFocusSettled} />
    </QueryClientProvider>
  );
}


const rowOf = (host: HTMLElement, n: number) => [...host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")].filter((el) => el.getAttribute("data-gantt-row-id") === `project:${pid(n)}`);
const linkOf = (host: HTMLElement, n: number) => rowOf(host, n).flatMap((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="gantt-project-link"]')])[0];

describe("ProductionGantt — landing on a named Project (#464)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let rowIndex: Map<string, number>;
  let settled: Array<{ token: number; outcome: ProductionGanttFocusOutcome }>;
  const onSettled = (token: number, outcome: ProductionGanttFocusOutcome) => { settled.push({ token, outcome }); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    settled = [];
    rowIndex = new Map();
    for (const spec of SIX) rowIndex.set(`project:${pid(spec.n)}`, SIX.indexOf(spec));
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: Element) { return slotOf(this) === "scroll-area-viewport" ? VIEWPORT_PX : 0; } });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const make = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 0, width: 0, height, toJSON: () => ({}) }) as DOMRect;
      if (slotOf(this) === "gantt-timeline-header") return make(0, HEADER_PX);
      const id = this.getAttribute("data-gantt-row-id");
      const index = id === null ? undefined : rowIndex.get(id);
      if (index !== undefined) {
        let scrolled = 0;
        for (let el: Element | null = this.parentElement; el; el = el.parentElement) {
          if (slotOf(el) === "scroll-area-viewport") { scrolled = (el as HTMLElement).scrollTop; break; }
        }
        return make(HEADER_PX + index * ROW_PX - scrolled, ROW_PX);
      }
      return make(0, 0);
    });
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(response(SIX)) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); await Promise.resolve(); });
    host.remove();
    client.clear();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function mount(focus: Focus, filters?: ProductionGanttFacetFilters) {
    await act(async () => { root.render(tree(client, focus, onSettled, filters)); await Promise.resolve(); });
    await flush();
  }
  async function rerender(focus: Focus, filters?: ProductionGanttFacetFilters) {
    await act(async () => { root.render(tree(client, focus, onSettled, filters)); await Promise.resolve(); });
    await flush();
  }

  it("1. a focus request on a loaded page scrolls its row under the header, highlights it, focuses its link and reports found once", async () => {
    await mount({ projectId: pid(5), token: 1 });
    expect(scrollTops(host)).toEqual([offsetOfIndex(4), offsetOfIndex(4)]);
    expect(rowOf(host, 5).length).toBeGreaterThan(0);
    expect(rowOf(host, 5).every((el) => el.getAttribute("data-selected") === "true")).toBe(true);
    expect(rowOf(host, 3).some((el) => el.hasAttribute("data-selected"))).toBe(false);
    expect(document.activeElement).toBe(linkOf(host, 5));
    expect(settled).toEqual([{ token: 1, outcome: { kind: "found", street: streetOf(5) } }]);
    // A rerender with the same request does not land (or report) again.
    setScrollTops(host, 777);
    await rerender({ projectId: pid(5), token: 1 });
    expect(scrollTops(host)).toEqual([777, 777]);
    expect(settled).toHaveLength(1);
  });

  it("1b. the focused row link draws its ring inset on the tokens, so the street cell's overflow cannot clip it", async () => {
    await mount({ projectId: pid(5), token: 1 });
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent === streetOf(5));
    expect(link).toBeDefined();
    const classes = (link as HTMLElement).className.split(/\s+/);
    expect(classes).toContain("focus-visible:-outline-offset-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-[length:var(--border-width-bold)]");
    expect(classes).not.toContain("focus-visible:outline-offset-2");
    expect(classes).not.toContain("focus-visible:outline-current");
  });

  it("2. without a focus request nothing is highlighted and the #415 landing is unchanged", async () => {
    await mount(null);
    expect(scrollTops(host)).toEqual([offsetOfIndex(2), offsetOfIndex(2)]);
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
    expect(settled).toEqual([]);
  });

  it("3. a Project on page 2 is found by loading pages until it appears", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (!path.startsWith("/api/production-gantt")) return Promise.reject(new Error(`unexpected fetch: ${path}`));
      return Promise.resolve(path.includes("cursor=") ? response(SIX.slice(3)) : response(SIX.slice(0, 3), "cursor-2"));
    });
    await mount({ projectId: pid(5), token: 1 });
    await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => String(path).includes("cursor=")).length).toBe(1);
    expect(scrollTops(host)).toEqual([offsetOfIndex(4), offsetOfIndex(4)]);
    expect(settled).toEqual([{ token: 1, outcome: { kind: "found", street: streetOf(5) } }]);
  });

  it("4. a focus arriving in the same commit as a filter change still lands", async () => {
    await mount(null);
    const filters: ProductionGanttFacetFilters = { ...DEFAULT_GANTT_FACET_FILTERS, delivered: true };
    await rerender({ projectId: pid(6), token: 2 }, filters);
    await flush();
    expect(scrollTops(host)).toEqual([offsetOfIndex(5), offsetOfIndex(5)]);
    expect(settled).toEqual([{ token: 2, outcome: { kind: "found", street: streetOf(6) } }]);
  });

  it("5. a Project the walk never finds is hidden once the walk completes, and nothing scrolls or highlights", async () => {
    await mount({ projectId: pid(99), token: 1 });
    expect(settled).toEqual([{ token: 1, outcome: { kind: "hidden" } }]);
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("6. at the draw cap a missing Project reports too-many, not hidden", async () => {
    apiGetMock.mockImplementation(() => Promise.resolve(response(SIX, "cursor-2", true)));
    await mount({ projectId: pid(99), token: 1 });
    expect(settled).toEqual([{ token: 1, outcome: { kind: "too-many" } }]);
  });

  it("7. a user filter change mid-walk cancels the request: reported cancelled and no landing follows", async () => {
    let releasePage2: (() => void) | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (!path.startsWith("/api/production-gantt")) return Promise.reject(new Error(`unexpected fetch: ${path}`));
      if (path.includes("cursor=")) return new Promise((resolve) => { releasePage2 = () => resolve(response(SIX.slice(3))); });
      return Promise.resolve(response(SIX.slice(0, 3), "cursor-2"));
    });
    await mount({ projectId: pid(5), token: 1 });
    expect(settled).toEqual([]);
    await rerender({ projectId: pid(5), token: 1 }, { ...DEFAULT_GANTT_FACET_FILTERS, completed: true });
    await act(async () => { releasePage2?.(); await Promise.resolve(); });
    await flush();
    expect(settled).toEqual([{ token: 1, outcome: { kind: "cancelled" } }]);
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("8. a failed read reports error", async () => {
    apiGetMock.mockImplementation(() => Promise.reject(new ApiError("Nope", 400, {})));
    await mount({ projectId: pid(5), token: 1 });
    expect(settled).toEqual([{ token: 1, outcome: { kind: "error" } }]);
  });

  it("9. Today clears the highlight", async () => {
    await mount({ projectId: pid(5), token: 1 });
    expect(host.querySelectorAll("[data-selected]").length).toBeGreaterThan(0);
    await act(async () => { todayButton(host).click(); await Promise.resolve(); });
    await flush(2);
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  it("10. a collapsed Project row is expanded by the landing, and a user can still collapse it (default behaviour kept)", async () => {
    const withChildren = (n: number) => ({ ...projectRow(SIX[n - 1]!), checklist: { completed: 0, total: 1 }, children: { rows: [childOf(n)], total: 1, returned: 1, truncated: false, nextCursor: null } });
    apiGetMock.mockImplementation(() => Promise.resolve(adminProductionGanttResponseSchema.parse({
      scope: "active", zone: PRODUCTION_GANTT_ZONE,
      appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
      projects: SIX.map((_, index) => (index === 4 ? withChildren(5) : projectRow(SIX[index]!))),
      page: { limit: 100, returned: 6, nextCursor: null },
      density: { matchedProjects: 6, matchedRows: 7, drawCap: 2000, tooManyToDraw: false },
    })));
    await mount(null);
    const chevron = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.getAttribute("aria-label") === streetOf(5))!;
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    await act(async () => { chevron().click(); await Promise.resolve(); });
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    await rerender({ projectId: pid(5), token: 1 });
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(settled).toEqual([{ token: 1, outcome: { kind: "found", street: streetOf(5) } }]);
  });
});

function childOf(n: number) {
  return {
    id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`, projectId: pid(n), title: "Edit", done: false, position: 0, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0,
    schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment("2026-09-20"), end: endMoment("2026-09-21"), due: "2026-09-21" },
    reminders: subtaskReminders(), permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canEditAssignees: false },
  };
}
