/**
 * #255 / #254 / #430 -- the Gantt's request filters and legend in a real render: each Show change
 * (Display, #430) or shared-Filter change changes the `/api/production-gantt` request, and the
 * legend follows the filters, built from the role-aware stage options, not the colour map. The
 * Filter and Display triggers live in the Dashboard's view bar, outside this lazy view; the
 * wrapper below stands in for them (same test ids) so the empty state's focus and scroll hand-off
 * is tested here, and `Dashboard-gantt.dom.test.tsx` covers the real controls and the URL round trip.
 *
 * `onFiltersChange` is wired to local state, standing in for the Dashboard's URL round trip. Same
 * rendering technique as `ProductionGantt-readonly.dom.test.tsx`: `apiGet` mocked, no vendor
 * `[data-slot]` selectors.
 */
import { act, useState, type SetStateAction } from "react";
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
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [],
    page: { limit: 100, returned: 0, nextCursor: null },
    density: { matchedProjects: 0, matchedRows: 0, drawCap: 2000, tooManyToDraw: false },
  });
}

function ganttResponse() {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        street: "1 Filter Street",
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "raw_review",
        delivered: false,
        archived: false,
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

/** Sets the URL facet, as the Dashboard would after a navigation, a shared-Filter edit or a Display toggle. */
let setFacet: (next: SetStateAction<ProductionGanttFacetFilters>) => void = () => {};

function ControlledGantt({ initial = DEFAULT_GANTT_FACET_FILTERS, q = "", onFiltersChange, onShownProjectsChange }: { initial?: ProductionGanttFacetFilters; q?: string; onFiltersChange?: (next: ProductionGanttFacetFilters) => void; onShownProjectsChange?: (count: number | null) => void }) {
  const [filters, setFilters] = useState(initial);
  setFacet = setFilters;
  // Stand-ins for the Dashboard view bar's Filter and Display triggers (the Gantt reaches them by test id).
  return (
    <>
      <button type="button" data-testid="dashboard-filter-trigger">Filter</button>
      <button type="button" data-testid="dashboard-display-trigger">Display</button>
      <ProductionGantt
        identity={identity}
        q={q}
        filters={filters}
        {...(onShownProjectsChange ? { onShownProjectsChange } : {})}
        focusFilterTrigger={() => filterTrigger().focus({ preventScroll: true })}
        focusDisplayTrigger={() => displayTrigger().focus({ preventScroll: true })}
        onFiltersChange={(next) => {
          onFiltersChange?.(next);
          setFilters(next);
        }}
      />
    </>
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

function filterTrigger(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-testid="dashboard-filter-trigger"]')!;
}

function displayTrigger(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-testid="dashboard-display-trigger"]')!;
}

/** A Show change as the Timeline's Display makes it: only the changed facet, everything else kept. */
async function setShow(changes: Pick<Partial<ProductionGanttFacetFilters>, "delivered" | "completed">) {
  await act(async () => { setFacet((previous) => ({ ...previous, ...changes })); });
  await settle();
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

  async function render(initial?: ProductionGanttFacetFilters, onFiltersChange?: (next: ProductionGanttFacetFilters) => void, q?: string, onShownProjectsChange?: (count: number | null) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ControlledGantt {...(initial ? { initial } : {})} {...(onFiltersChange ? { onFiltersChange } : {})} {...(q !== undefined ? { q } : {})} {...(onShownProjectsChange ? { onShownProjectsChange } : {})} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await settle();
  }

  it("#260: reports the server's filtered project count for the search chip, and null on unmount", async () => {
    const shown = vi.fn<(count: number | null) => void>();
    await render(undefined, undefined, "Schedule", shown);
    await waitFor(() => expect(shown).toHaveBeenLastCalledWith(1));
    await act(async () => { root.unmount(); await Promise.resolve(); });
    expect(shown).toHaveBeenLastCalledWith(null);
    root = createRoot(host);
  });

  it("sends the shared Filter's stages, priority and archived mode with every request (#428)", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["raw_review"], priorities: ["5", "none"], archived: "include" });
    expect(lastListQuery().get("stages")).toBe("raw_review");
    expect(lastListQuery().get("priority")).toBe("5,none");
    expect(lastListQuery().get("archived")).toBe("include");
  });

  it("changes the /api/production-gantt request when delivered or completed is toggled", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["awaiting_raw", "raw_review"] });
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("completed")).toBeNull();

    await setShow({ delivered: true });
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("completed")).toBeNull();

    await setShow({ completed: true });
    expect(lastListQuery().get("completed")).toBe("1");
    expect(lastListQuery().get("delivered")).toBe("1");
    expect(lastListQuery().get("stages")).toBe("awaiting_raw,raw_review");

    await setShow({ delivered: false });
    expect(lastListQuery().get("delivered")).toBeNull();
    expect(lastListQuery().get("completed")).toBe("1");
    expect(lastListQuery().get("editors")).toBeNull();
  });

  it("keeps focus on the Display control in use while the new filter's first page is pending", async () => {
    await render();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();

    let resolvePending: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("delivered=1")) return new Promise((resolve) => { resolvePending = resolve; });
      return Promise.resolve(ganttResponse());
    });

    // The Display trigger lives outside the view; a Show change must not take focus from it.
    displayTrigger().focus();
    await setShow({ delivered: true });
    expect(host.querySelector('[data-testid="production-gantt-loading"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="production-gantt"]')).toBeNull();
    expect(document.activeElement).toBe(displayTrigger());
    // The legend stays mounted through the pending page.
    expect(host.querySelector('[data-testid="production-gantt-legend"]')).not.toBeNull();

    await act(async () => {
      resolvePending?.(ganttResponse());
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="production-gantt"]')).not.toBeNull();
    expect(document.activeElement).toBe(displayTrigger());
  });

  it("keeps the legend mounted through an error state too", async () => {
    await render();
    // A 4xx is not retried (`projectQueryRetry`), so the error state lands without a retry delay.
    apiGetMock.mockImplementation((path: string) => (path.includes("completed=1") ? Promise.reject(new ApiError("boom", 400)) : Promise.resolve(ganttResponse())));
    displayTrigger().focus();
    await setShow({ completed: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The production schedule is unavailable.");
    expect(host.querySelector('[data-testid="production-gantt-legend"]')).not.toBeNull();
    expect(document.activeElement).toBe(displayTrigger());
  });

  it("shows no Delivered legend entry until delivered projects are shown", async () => {
    await render();
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review"]);
    expect(legendLabels(host)).not.toContain("Delivered");

    await setShow({ delivered: true });
    expect(legendKeys(host)).toEqual(["awaiting_raw", "raw_review", "editing", "edited_review", "delivered"]);
    expect(legendLabels(host)).toContain("Delivered");
  });

  it("restricts the legend to the selected stages", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["raw_review"] });
    expect(legendKeys(host)).toEqual(["raw_review"]);

    // The shared Filter's Stage = Delivered arrives with delivered projects on (#255), so its legend entry follows.
    await act(async () => { setFacet({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["raw_review", "delivered"], delivered: true }); });
    await waitFor(() => expect(legendKeys(host)).toEqual(["raw_review", "delivered"]));
  });

  it("#257: draws legend labels in the secondary text role, and hatches only the Edited review swatch", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, delivered: true });
    const legend = host.querySelector<HTMLElement>('[data-testid="production-gantt-legend"]')!;
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    // `text-muted-foreground` (greige-400) read too faint beside the swatches at 11px.
    expect(tokens(legend)).toContain("text-foreground-secondary");
    expect(tokens(legend)).not.toContain("text-muted-foreground");
    const hatched = [...legend.querySelectorAll("[data-stage-key]")].filter((entry) => {
      const swatch = entry.querySelector('[data-testid="stage-swatch"]');
      expect(swatch, entry.getAttribute("data-stage-key")!).not.toBeNull();
      return swatch!.getAttribute("data-pattern") === "hatch";
    });
    expect(hatched.map((entry) => entry.getAttribute("data-stage-key"))).toEqual(["edited_review"]);
  });

  it("labels every legend entry with a real stage label, never a raw key", async () => {
    await render({ ...DEFAULT_GANTT_FACET_FILTERS, delivered: true });
    const labels = legendLabels(host);
    expect(labels).toEqual(["Awaiting RAW", "RAW review", "Editing", "Edited review", "Delivered"]);
    for (const raw of ["awaiting_raw", "raw_review", "editing", "editing_autohdr", "edited_review", "delivered"]) expect(labels).not.toContain(raw);
  });

  it("#429: sends the shared Filter's People and My tasks facets on the list request, and no longer asks for option facets", async () => {
    await render();
    expect(lastListQuery().has("facets")).toBe(false);
    expect(lastListQuery().get("dm")).toBe("1");
  });

  it("carries the draw-cap banner copy that points at the filters above", async () => {
    apiGetMock.mockImplementation(() => {
      const response = ganttResponse();
      return Promise.resolve({ ...response, density: { ...response.density, tooManyToDraw: true } });
    });
    await render();
    expect(host.querySelector('[data-testid="production-gantt-too-many"]')?.textContent).toBe("Too many projects match these filters to draw at once — narrow the filters above to see the rest.");
    // The controls the banner points at (Filter, Display) are in the Dashboard's view bar, above the view.
    expect(filterTrigger().isConnected).toBe(true);
  });

  describe("empty state", () => {
    // No test for "an empty first page with more to come": the server cannot send one. It sets
    // `nextCursor` only when the page is full — `workers/app/src/routes/production-gantt.ts:789`
    // (`truncatedPage = projectRows.length > parsed.limit`) and `:809-811` (a cursor only when
    // `truncatedPage`) — so a page with no projects always carries `nextCursor: null`. The
    // component's `!hasNextPage` guard on the empty state stays, as defence against a future server.
    function emptyState(): HTMLElement | null {
      return host.querySelector<HTMLElement>('[data-testid="production-gantt-empty"]');
    }

    function clearButton(scope: HTMLElement): HTMLButtonElement | undefined {
      return [...scope.querySelectorAll("button")].find((button) => button.textContent === "Clear filters");
    }

    const deliveredStageOnly: ProductionGanttFacetFilters = { ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["delivered"], delivered: false };

    it("says no projects match the filters, keeps the legend mounted and draws no chart", async () => {
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
      // The legend stays mounted around it.
      expect(host.querySelector('[data-testid="production-gantt-legend"]')).not.toBeNull();
    });

    function showDeliveredButton(scope: HTMLElement): HTMLButtonElement | undefined {
      return [...scope.querySelectorAll("button")].find((button) => button.textContent === "Show delivered projects");
    }

    it("#270: offers Show delivered projects for Stage = Delivered with delivered hidden, keeping the other filters", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("stages=delivered") && !path.includes("delivered=1") ? emptyGanttResponse() : ganttResponse()));
      const onFiltersChange = vi.fn<(next: ProductionGanttFacetFilters) => void>();
      await render({ ...deliveredStageOnly, completed: true }, onFiltersChange);
      const empty = emptyState()!;
      expect(clearButton(empty)).toBeDefined();
      const show = showDeliveredButton(empty);
      expect(show).toBeDefined();

      await act(async () => { show!.click(); });
      await settle();
      expect(onFiltersChange).toHaveBeenCalledTimes(1);
      expect(onFiltersChange).toHaveBeenCalledWith({ ...deliveredStageOnly, delivered: true, completed: true });
      expect(emptyState()).toBeNull();
      // The button unmounted with the empty state; focus lands on Display (the setting it flipped), not <body>.
      expect(document.activeElement).toBe(displayTrigger());
    });

    it("#270: offers no Show delivered projects when the empty state has another cause", async () => {
      apiGetMock.mockImplementation(() => Promise.resolve(emptyGanttResponse()));
      await render({ ...DEFAULT_GANTT_FACET_FILTERS, stageKeys: ["editing"] });
      expect(clearButton(emptyState()!)).toBeDefined();
      expect(showDeliveredButton(emptyState()!)).toBeUndefined();
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

    it("moves focus to the Dashboard's Filter trigger when the empty state's Clear filters unmounts with it", async () => {
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
        const trigger = filterTrigger();
        expect(document.activeElement).toBe(trigger);

        const triggerFocus = focusSpy.mock.contexts.flatMap((context, index) => (context === trigger ? [focusSpy.mock.calls[index]] : []));
        expect(triggerFocus).toEqual([[{ preventScroll: true }]]);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(trigger);
        // Instant (default) behaviour, so reduced-motion users get no animated scroll.
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
        // The scroll-margin that clears the sticky shell header is on the real triggers; `Dashboard-gantt.dom.test.tsx` asserts it.
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
      const atScroll: { emptyState: boolean; loading: boolean }[] = [];
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {
        atScroll.push({
          emptyState: emptyState() !== null,
          loading: host.querySelector('[data-testid="production-gantt-loading"]') !== null,
        });
      });
      try {
        await act(async () => { button.click(); });
        await settle();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(atScroll).toEqual([{ emptyState: false, loading: true }]);
      } finally {
        scrollIntoView.mockRestore();
      }
    });

    it("does not scroll for a filter change that did not come from the empty state's Clear filters", async () => {
      apiGetMock.mockImplementation((path: string) => Promise.resolve(path.includes("completed=1") ? emptyGanttResponse() : ganttResponse()));
      await render({ ...DEFAULT_GANTT_FACET_FILTERS, completed: true });
      expect(emptyState()).not.toBeNull();
      const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
      try {
        // The Filter's own Clear: same destination (default filters), different path.
        await act(async () => { setFacet(DEFAULT_GANTT_FACET_FILTERS); });
        await settle();
        expect(emptyState()).toBeNull();
        expect(scrollIntoView).not.toHaveBeenCalled();

        // And an empty-state Clear leaves nothing armed: one scroll, then none for a later Display edit.
        await setShow({ completed: true });
        const again = clearButton(emptyState()!)!;
        await act(async () => { again.click(); });
        await settle();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        await setShow({ completed: false });
        await setShow({ completed: true });
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
