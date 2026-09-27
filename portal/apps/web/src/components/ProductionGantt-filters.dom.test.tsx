/**
 * #255 / #254 — the Gantt's filter panel and legend in a real render: each toggle changes the
 * `/api/production-gantt` request, the checkbox the user just clicked keeps focus while the new
 * filter's first page is pending (the panel sits in one always-mounted root above the loading
 * slot), and the legend follows the filters — built from the role-aware stage options, not the
 * colour map.
 *
 * `onFiltersChange` is wired to local state here, standing in for the Dashboard's URL round trip
 * (`Dashboard-gantt.dom.test.tsx` covers that half). Same rendering technique as
 * `ProductionGantt-readonly.dom.test.tsx`: `apiGet` mocked, no vendor `[data-slot]` selectors.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import { ApiError } from "../lib/api";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS, type ProductionGanttFacetFilters } from "../lib/production-gantt-filters";
import { ProductionGantt } from "./ProductionGantt";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
      { key: "editing", label: "Editing", displayOrder: 3, active: true },
      { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
      { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const TODAY = new Date();
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

function emptyGanttResponse() {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [],
    page: { limit: 100, returned: 0, nextCursor: null },
    density: { matchedProjects: 0, matchedRows: 0, drawCap: 2000, tooManyToDraw: false },
  });
}

function ganttResponse() {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        street: "1 Filter Street",
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "raw_review",
        delivered: false,
        shootDate: isoDate(0),
        shootDateCivil: isoDate(0),
        createdAt: isoDate(0) + "T00:00:00.000Z",
        barStartDate: isoDate(0),
        deadline: { at: `${isoDate(5)}T05:00:00.000Z`, localCivil: `${isoDate(5)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
        deadlineVersion: 1,
        editors: [],
        checklist: { completed: 0, total: 0 },
        permissions: { canEditDeadline: true, canEditChildren: true },
        children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
      },
    ],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  });
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

function ControlledGantt({ initial = DEFAULT_GANTT_FACET_FILTERS, onFiltersChange }: { initial?: ProductionGanttFacetFilters; onFiltersChange?: (next: ProductionGanttFacetFilters) => void }) {
  const [filters, setFilters] = useState(initial);
  return (
    <ProductionGantt
      identity={identity}
      q=""
      filters={filters}
      onFiltersChange={(next) => {
        onFiltersChange?.(next);
        setFilters(next);
      }}
    />
  );
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function panel(host: HTMLElement): HTMLElement {
  const section = host.querySelector<HTMLElement>('[aria-label="Gantt filters"]');
  if (!section) throw new Error("no Gantt filter panel");
  return section;
}

function checkbox(host: HTMLElement, legend: string, label: string): HTMLInputElement {
  const fieldset = [...panel(host).querySelectorAll("fieldset")].find((candidate) => candidate.querySelector("legend")?.textContent === legend);
  const match = fieldset && [...fieldset.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  const input = match?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${legend} / ${label} checkbox`);
  return input;
}

function projectListPaths(): string[] {
  return apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/production-gantt?") && !path.includes("childrenOf="));
}

function lastListQuery(): URLSearchParams {
  const path = projectListPaths().at(-1);
  if (!path) throw new Error("no project-list request");
  return new URLSearchParams(path.slice(path.indexOf("?") + 1));
}

function legendKeys(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="production-gantt-legend"] [data-stage-key]')].map((entry) => entry.getAttribute("data-stage-key")!);
}

function legendLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="production-gantt-legend"] [data-stage-key]')].map((entry) => entry.textContent ?? "");
}

describe("ProductionGantt — filters and legend (#255, #254)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse()) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
  });

  async function render(initial?: ProductionGanttFacetFilters, onFiltersChange?: (next: ProductionGanttFacetFilters) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ControlledGantt {...(initial ? { initial } : {})} {...(onFiltersChange ? { onFiltersChange } : {})} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await settle();
  }

  it("renders only the three Gantt controls", async () => {
    await render();
    expect([...panel(host).querySelectorAll("fieldset legend")].map((legend) => legend.textContent)).toEqual(["Stages", "Show"]);
    expect(panel(host).querySelectorAll("input[type=checkbox]")).toHaveLength(5 + 2);
  });

  it("changes the /api/production-gantt request when a stage, delivered or completed is toggled", async () => {
    await render();
    expect(lastListQuery().get("stages")).toBeNull();
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("completed")).toBeNull();

    await act(async () => { checkbox(host, "Stages", "RAW review").click(); });
    await settle();
    expect(lastListQuery().get("stages")).toBe("raw_review");

    await act(async () => { checkbox(host, "Stages", "Awaiting RAW").click(); });
    await settle();
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");

    await act(async () => { checkbox(host, "Show", "Show delivered projects").click(); });
    await settle();
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("completed")).toBeNull();

    await act(async () => { checkbox(host, "Show", "Show completed checklist items").click(); });
    await settle();
    expect(lastListQuery().get("completed")).toBe("1");
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");

    await act(async () => { checkbox(host, "Show", "Show delivered projects").click(); });
    await settle();
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("editors")).toBeNull();
  });

  it("keeps focus on the clicked checkbox while the new filter's first page is pending", async () => {
    await render();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();

    let resolvePending: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("delivered=1")) return new Promise((resolve) => { resolvePending = resolve; });
      return Promise.resolve(ganttResponse());
    });

    const toggle = checkbox(host, "Show", "Show delivered projects");
    await act(async () => {
      toggle.focus();
      toggle.click();
      await Promise.resolve();
    });
    await settle();

    // Pending: the chart slot shows the skeleton, but the panel — and the very same checkbox node —
    // stayed mounted and focused.
    expect(host.querySelector('[data-testid="production-gantt-loading"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="production-gantt"]')).toBeNull();
    expect(toggle.isConnected).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(checkbox(host, "Show", "Show delivered projects")).toBe(toggle);

    await act(async () => {
      resolvePending?.(ganttResponse());
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps the panel mounted through an error state too", async () => {
    await render();
    // A 4xx is not retried (`projectQueryRetry`), so the error state lands without a retry delay.
    apiGetMock.mockImplementation((path: string) => (path.includes("completed=1") ? Promise.reject(new ApiError("boom", 400)) : Promise.resolve(ganttResponse())));
    const toggle = checkbox(host, "Show", "Show completed checklist items");
    await act(async () => {
      toggle.focus();
      toggle.click();
    });
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The production schedule is unavailable.");
    expect(toggle.isConnected).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("shows no Delivered legend entry until delivered projects are shown", async () => {
    await render();
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review"]);
    expect(legendLabels(host)).not.toContain("Delivered");

    await act(async () => { checkbox(host, "Show", "Show delivered projects").click(); });
    await settle();
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"]);
    expect(legendLabels(host)).toContain("Delivered");
  });

  it("restricts the legend to the selected stages", async () => {
    await render();
    await act(async () => { checkbox(host, "Stages", "RAW review").click(); });
    await settle();
    expect(legendKeys(host)).toEqual(["raw_review"]);

    await act(async () => { checkbox(host, "Stages", "Delivered").click(); });
    await settle();
    // Delivered is selected as a stage but delivered projects are still hidden.
    expect(legendKeys(host)).toEqual(["raw_review"]);

    await act(async () => { checkbox(host, "Show", "Show delivered projects").click(); });
    await settle();
    expect(legendKeys(host)).toEqual(["raw_review", "delivered"]);
  });

  it("labels every legend entry with a real stage label, never a raw key", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, delivered: true });
    const labels = legendLabels(host);
    expect(labels).toEqual(["Awaiting RAW", "RAW review", "Editing", "Edited review", "Delivered"]);
    for (const raw of ["awaiting_raw", "raw_review", "editing", "editing_autohdr", "edited_review", "delivered"]) expect(labels).not.toContain(raw);
  });

  it("carries the draw-cap banner copy that points at the filters above", async () => {
    apiGetMock.mockImplementation(() => {
      const response = ganttResponse();
      return Promise.resolve({ ...response, density: { ...response.density, tooManyToDraw: true } });
    });
    await render();
    expect(host.querySelector('[data-testid="production-gantt-too-many"]')?.textContent).toBe("Too many projects match these filters to draw at once — narrow the filters above to see the rest.");
    // The filters the banner points at are actually on screen.
    expect(panel(host).querySelectorAll("input[type=checkbox]").length).toBeGreaterThan(0);
  });

  describe("empty state", () => {
    function emptyState(): HTMLElement | null {
      return host.querySelector<HTMLElement>('[data-testid="production-gantt-empty"]');
    }

    function clearButton(scope: HTMLElement): HTMLButtonElement | undefined {
      return [...scope.querySelectorAll("button")].find((button) => button.textContent === "Clear filters");
    }

    const deliveredStageOnly: ProductionGanttFacetFilters = { ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["delivered"], delivered: false };

    it("says no projects match the filters, keeps the panel mounted and draws no chart", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("stages=delivered") ? emptyGanttResponse() : ganttResponse()));
      await render(deliveredStageOnly);
      expect(lastListQuery().get("stages")).toBe("delivered");

      const empty = emptyState();
      expect(empty).not.toBeNull();
      expect(empty!.getAttribute("role")).toBe("status");
      expect(empty!.textContent).toContain("No projects match these filters.");
      expect(empty!.textContent).toContain("Change or clear the filters above to see more projects.");
      // The empty state sits inside the chart slot and is the only thing in it: no Gantt mounted.
      const chartSlot = host.querySelector('[data-testid="production-gantt"]');
      expect(chartSlot).not.toBeNull();
      expect([...chartSlot!.children]).toEqual([empty]);
      // The panel and legend stay mounted around it.
      expect(checkbox(host, "Stages", "Delivered").checked).toBe(true);
      expect(host.querySelector('[data-testid="production-gantt-legend"]')).not.toBeNull();
    });

    it("clears the filters from the empty state's Clear filters button", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("stages=delivered") ? emptyGanttResponse() : ganttResponse()));
      const onFiltersChange = vi.fn<(next: ProductionGanttFacetFilters) => void>();
      await render(deliveredStageOnly, onFiltersChange);
      const button = clearButton(emptyState()!);
      expect(button).toBeDefined();

      await act(async () => { button!.click(); });
      await settle();
      expect(onFiltersChange).toHaveBeenCalledTimes(1);
      expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_GANTT_FACET_FILTERS);
      // Cleared filters load projects again, so the chart replaces the empty state.
      expect(lastListQuery().get("stages")).toBeNull();
      expect(emptyState()).toBeNull();
    });

    it("says there are no projects to schedule, with no Clear button, when the filters are default", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(emptyGanttResponse()));
      await render();
      const empty = emptyState();
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe("No projects to schedule.");
      expect(clearButton(empty!)).toBeUndefined();
    });

    it("stays out of the way while projects are listed", async () => {
      await render();
      expect(emptyState()).toBeNull();
    });
  });
});
