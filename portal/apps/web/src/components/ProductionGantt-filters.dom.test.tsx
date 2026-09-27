/**
 * #255 / #254 — the Gantt's filters bar (`ProductionGanttFiltersBar`, a ReUI `Filters` chip row)
 * and legend in a real render: each edit changes the `/api/production-gantt` request, the control
 * the user just used keeps focus while the new filter's first page is pending (the bar sits in one
 * always-mounted root above the loading slot), and the legend follows the filters — built from the
 * role-aware stage options, not the colour map. The bar's own chip mechanics (unfinished chips,
 * re-seeding, Duplicate/Negate, keyboard) are covered in `ProductionGanttFiltersBar.dom.test.tsx`.
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

function ControlledGantt({ initial = DEFAULT_GANTT_FACET_FILTERS, q = "", onFiltersChange }: { initial?: ProductionGanttFacetFilters; q?: string; onFiltersChange?: (next: ProductionGanttFacetFilters) => void }) {
  const [filters, setFilters] = useState(initial);
  return (
    <ProductionGantt
      identity={identity}
      q={q}
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

function bar(host: HTMLElement): HTMLElement {
  const element = host.querySelector<HTMLElement>('[data-testid="production-gantt-filters"]');
  if (!element) throw new Error("no Gantt filters bar");
  return element;
}

function toolbar(host: HTMLElement): HTMLElement {
  const element = bar(host).querySelector<HTMLElement>('[role="toolbar"][aria-label="Gantt filters"]');
  if (!element) throw new Error("no Gantt filters toolbar");
  return element;
}

function chipNames(host: HTMLElement): string[] {
  return [...toolbar(host).querySelectorAll('[role="group"]')].map((chip) => chip.getAttribute("aria-label") ?? "");
}

function addTrigger(host: HTMLElement): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>('[data-testid="production-gantt-filters-add"]');
  if (!element) throw new Error("no add-filter trigger");
  return element;
}

function optionNames(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((candidate) => candidate.textContent?.trim() ?? "");
}

function option(name: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.trim() === name);
  if (!match) throw new Error(`no option "${name}" in [${optionNames().join(", ")}]`);
  return match;
}

/** Real-timer poll — Base UI's open-state transitions land a tick removed from the triggering render. */
async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

/** Adds a chip through the bar: the picker's field, its one condition, then the named values. The
 * value menu stays open (a multi-select commits per toggle), so further `toggle`s land in it. */
async function addFilter(host: HTMLElement, field: "Stage" | "Show", values: string[]) {
  await click(addTrigger(host));
  await waitFor(() => option(field));
  await click(option(field));
  const condition = field === "Stage" ? "is any of" : "includes";
  await waitFor(() => expect(optionNames()).toEqual([condition]));
  await click(option(condition));
  for (const value of values) await toggle(value);
}

/** Toggles one value in the open value menu. */
async function toggle(value: string) {
  await waitFor(() => option(value));
  await click(option(value));
  await settle();
}

/** Closes whatever menu is open, as Escape does. */
async function escape() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Opens a chip's value menu from its value segment (named by the value it shows). */
async function openValue(host: HTMLElement, shown: string) {
  const segment = [...toolbar(host).querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === shown);
  if (!segment) throw new Error(`no value segment "${shown}"`);
  await click(segment);
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

  async function render(initial?: ProductionGanttFacetFilters, onFiltersChange?: (next: ProductionGanttFacetFilters) => void, q?: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ControlledGantt {...(initial ? { initial } : {})} {...(onFiltersChange ? { onFiltersChange } : {})} {...(q !== undefined ? { q } : {})} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await settle();
  }

  it("offers only the two Gantt fields: Stage (the five role-aware stages) and Show (delivered, completed)", async () => {
    await render();
    expect(chipNames(host)).toEqual([]);
    await click(addTrigger(host));
    await waitFor(() => expect(optionNames()).toEqual(["Stage", "Show"]));
    await click(option("Stage"));
    await waitFor(() => expect(optionNames()).toEqual(["is any of"]));
    await click(option("is any of"));
    await waitFor(() => expect(optionNames()).toEqual(["Awaiting RAW", "RAW review", "Editing", "Edited review", "Delivered"]));
    await escape();
    await click(addTrigger(host));
    await waitFor(() => option("Show"));
    await click(option("Show"));
    await waitFor(() => expect(optionNames()).toEqual(["includes"]));
    await click(option("includes"));
    await waitFor(() => expect(optionNames()).toEqual(["Delivered projects", "Completed checklist items"]));
  });

  it("changes the /api/production-gantt request when a stage, delivered or completed is toggled", async () => {
    await render();
    expect(lastListQuery().get("stages")).toBeNull();
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("completed")).toBeNull();

    await addFilter(host, "Stage", ["RAW review"]);
    expect(lastListQuery().get("stages")).toBe("raw_review");

    await toggle("Awaiting RAW");
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");
    await escape();

    await addFilter(host, "Show", ["Delivered projects"]);
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("completed")).toBeNull();

    await toggle("Completed checklist items");
    expect(lastListQuery().get("completed")).toBe("1");
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");

    await toggle("Delivered projects");
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("completed")).toBe("1");
    expect(lastListQuery().get("editors")).toBeNull();
    await escape();
    expect(chipNames(host)).toEqual(["Stage is any of 2 selected", "Show includes Completed checklist items"]);
  });

  it("keeps focus on the control in use while the new filter's first page is pending", async () => {
    await render();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();

    let resolvePending: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("delivered=1")) return new Promise((resolve) => { resolvePending = resolve; });
      return Promise.resolve(ganttResponse());
    });

    await addFilter(host, "Show", ["Delivered projects"]);
    const focused = document.activeElement as HTMLElement;
    // The option the user just toggled, in the still-open value menu.
    expect(focused).toBe(option("Delivered projects"));

    // Pending: the chart slot shows the skeleton, but the bar — its chip, its open value menu and
    // the very control that has focus — stayed mounted and focused.
    expect(host.querySelector('[data-testid="production-gantt-loading"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="production-gantt"]')).toBeNull();
    expect(focused.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(optionNames()).toEqual(["Delivered projects", "Completed checklist items"]);
    expect(chipNames(host)).toEqual(["Show includes Delivered projects"]);

    await act(async () => {
      resolvePending?.(ganttResponse());
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();
    expect(document.activeElement).toBe(focused);
  });

  it("keeps the bar mounted through an error state too", async () => {
    await render();
    // A 4xx is not retried (`projectQueryRetry`), so the error state lands without a retry delay.
    apiGetMock.mockImplementation((path: string) => (path.includes("completed=1") ? Promise.reject(new ApiError("boom", 400)) : Promise.resolve(ganttResponse())));
    await addFilter(host, "Show", ["Completed checklist items"]);
    const focused = document.activeElement as HTMLElement;
    expect(focused).toBe(option("Completed checklist items"));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The production schedule is unavailable.");
    expect(focused.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(chipNames(host)).toEqual(["Show includes Completed checklist items"]);
  });

  it("shows no Delivered legend entry until delivered projects are shown", async () => {
    await render();
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review"]);
    expect(legendLabels(host)).not.toContain("Delivered");

    await addFilter(host, "Show", ["Delivered projects"]);
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"]);
    expect(legendLabels(host)).toContain("Delivered");
  });

  it("restricts the legend to the selected stages", async () => {
    await render();
    await addFilter(host, "Stage", ["RAW review"]);
    expect(legendKeys(host)).toEqual(["raw_review"]);

    await toggle("Delivered");
    // Delivered is selected as a stage but delivered projects are still hidden.
    expect(legendKeys(host)).toEqual(["raw_review"]);
    await escape();

    await addFilter(host, "Show", ["Delivered projects"]);
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
    // The filters the banner points at are actually on screen, above the chart slot.
    expect(toolbar(host)).not.toBeNull();
    expect(addTrigger(host).isConnected).toBe(true);
  });

  describe("empty state", () => {
    function emptyState(): HTMLElement | null {
      return host.querySelector<HTMLElement>('[data-testid="production-gantt-empty"]');
    }

    function clearButton(scope: HTMLElement): HTMLButtonElement | undefined {
      return [...scope.querySelectorAll("button")].find((button) => button.textContent === "Clear filters");
    }

    const deliveredStageOnly: ProductionGanttFacetFilters = { ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["delivered"], delivered: false };

    it("says no projects match the filters, keeps the bar mounted and draws no chart", async () => {
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
      // The bar and legend stay mounted around it.
      expect(chipNames(host)).toEqual(["Stage is any of Delivered"]);
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
      // The bar re-seeds from the cleared URL.
      expect(chipNames(host)).toEqual([]);
    });

    it("moves focus to the filters bar's Add filter trigger when the empty state's Clear filters unmounts with it", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("stages=delivered") ? emptyGanttResponse() : ganttResponse()));
      await render(deliveredStageOnly);
      const button = clearButton(emptyState()!)!;
      button.focus();
      expect(document.activeElement).toBe(button);
      // E4 (390×844): the browser's own focus scroll left the focus target clipped at the viewport's
      // bottom edge. Focus must not scroll on its own; the trigger is scrolled to the top instead,
      // below the sticky shell header (its scroll-margin-top).
      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});

      try {
        await act(async () => { button.click(); });
        await settle();
        expect(emptyState()).toBeNull();
        const trigger = addTrigger(host);
        expect(document.activeElement).toBe(trigger);
        // The bar is empty again, so the trigger is the labelled one, and a real tab stop.
        expect(trigger.textContent).toBe("Add filter");
        expect(trigger.tabIndex).toBe(0);

        const triggerFocus = focusSpy.mock.contexts.flatMap((context, index) => (context === trigger ? [focusSpy.mock.calls[index]] : []));
        expect(triggerFocus).toEqual([[{ preventScroll: true }]]);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(trigger);
        // Instant (default) behaviour, so reduced-motion users get no animated scroll.
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
        // Clears the sticky shell header rather than landing underneath it.
        expect(trigger.className).toContain("scroll-mt-[calc(var(--shell-header-height)+var(--space-4))]");
      } finally {
        focusSpy.mockRestore();
        scrollIntoView.mockRestore();
      }
    });

    it("scrolls the trigger only after the cleared filters have rendered, not from the click itself (browser pass F, 390x844)", async () => {
      // A slow first page for the cleared filters, so the loading slot is what the scroll lands on.
      apiGetMock.mockImplementation((path: string) => (path.includes("stages=delivered") ? Promise.resolve(emptyGanttResponse()) : new Promise(() => {})));
      await render(deliveredStageOnly);
      const button = clearButton(emptyState()!)!;
      // Pass F: scrolling synchronously in the click handler measured the OLD layout (the short empty
      // state), so at 390x844 the trigger ended 7px below the viewport. Record what the page says at
      // the moment of the scroll.
      const atScroll: { emptyState: boolean; loading: boolean; chips: string[] }[] = [];
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {
        atScroll.push({
          emptyState: emptyState() !== null,
          loading: host.querySelector('[data-testid="production-gantt-loading"]') !== null,
          chips: chipNames(host),
        });
      });
      try {
        await act(async () => { button.click(); });
        await settle();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(atScroll).toEqual([{ emptyState: false, loading: true, chips: [] }]);
      } finally {
        scrollIntoView.mockRestore();
      }
    });

    it("does not scroll for a filter change that did not come from the empty state's Clear filters", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("stages=") ? emptyGanttResponse() : ganttResponse()));
      await render(deliveredStageOnly);
      expect(emptyState()).not.toBeNull();
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
      try {
        // The bar's own Clear: same destination (default filters), different path.
        const barClear = [...bar(host).querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Clear");
        expect(barClear).toBeDefined();
        await act(async () => { barClear!.click(); });
        await settle();
        expect(emptyState()).toBeNull();
        expect(chipNames(host)).toEqual([]);
        expect(scrollIntoView).not.toHaveBeenCalled();

        // And an empty-state Clear leaves nothing armed: one scroll, then none for a later bar edit.
        await addFilter(host, "Stage", ["Editing"]);
        await settle();
        const again = clearButton(emptyState()!)!;
        await act(async () => { again.click(); });
        await settle();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        await addFilter(host, "Stage", ["Editing"]);
        await settle();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      } finally {
        scrollIntoView.mockRestore();
      }
    });

    it("says there are no projects to schedule, with no Clear button, when the filters are default", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(emptyGanttResponse()));
      await render();
      const empty = emptyState();
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe("No projects to schedule.");
      expect(clearButton(empty!)).toBeUndefined();
    });

    it("says no projects match the search, with no Clear button, when only a search is active", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(emptyGanttResponse()));
      await render(undefined, undefined, "zzzz");
      expect(lastListQuery().get("q")).toBe("zzzz");
      const empty = emptyState();
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe("No projects match this search.");
      expect(clearButton(empty!)).toBeUndefined();
    });

    it("stays out of the way while projects are listed", async () => {
      await render();
      expect(emptyState()).toBeNull();
    });
  });
});
