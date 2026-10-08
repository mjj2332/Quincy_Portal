/**
 * #738 - the Timeline's zoom buttons render into the nav row (a portal into `gantt-nav-zoom`), not as a floating
 * box over the lane that covers bar labels. Zoom state stays inside GanttView; this pins placement, the one-step
 * click, and the focusable aria-disabled no-op at the limits (0.5 .. 3, step 0.25). happy-dom has no layout, so the
 * track width (the timeline column's rem min-width) stands in for the zoom level.
 *
 * Guard F (`test-seam.guard.test.ts`): everything is found by `data-testid`, accessible name or text.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { clearToasts } from "../lib/toast-store";
import { ProductionGantt } from "./ProductionGantt";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { mockViewport, type MockViewport } from "@/testing/viewport";

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
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const PROJECT = "11111111-1111-4111-8111-111111111111";
const STREET = "1 Alpha Street";
const isoDate = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };

function project(): GanttProjectRowDto {
  const row = {
    id: "22222222-2222-4222-8222-000000000001", projectId: PROJECT, title: "Row one", done: false, position: 0, assignees: [], otherAssigneeCount: 0, assignmentVersion: 1,
    schedule: { state: "range" as const, version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(isoDate(2)), end: endMoment(isoDate(3)), due: isoDate(3) },
    reminders: subtaskReminders(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
  };
  return {
    id: PROJECT, street: STREET, suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
    shootDate: isoDate(0), shootDateCivil: isoDate(0), createdAt: `${isoDate(0)}T00:00:00.000Z`, barStartDate: isoDate(0),
    // no deadline: the attention reason is "missing_deadline", which an admin's Due cell shows as an action on a wide layout
    deadline: null, deadlineVersion: 1, editors: [], checklist: { completed: 0, total: 1 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [row], total: 1, returned: 1, truncated: false, nextCursor: null },
  };
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let viewport: MockViewport | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mountAt(width: number, coarse = false) {
  viewport = mockViewport({ width, coarse });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} projectHrefFor={(id) => `/projects/${id}`} onOpenProject={() => {}} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation(() => Promise.resolve(adminProductionGanttResponseSchema.parse({
    scope: "active", zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [project()],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  })));
  clearToasts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  client.clear();
  host.remove();
  document.body.replaceChildren();
  viewport?.restore();
  viewport = null;
});

const navZoom = () => host.querySelector<HTMLElement>('[data-testid="gantt-nav-zoom"]')!;
const zoomButton = (name: "Zoom in" | "Zoom out") => navZoom().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
/** The timeline column's min-width, which scales with zoom. */
const trackRem = () => parseFloat(host.querySelector<HTMLElement>('[data-testid="gantt-timeline-column"]')!.style.minWidth);
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await Promise.resolve(); }); await settle(); };

describe("ProductionGantt zoom buttons (#738)", () => {
  it("render inside the nav row, with no floating box in the lane", async () => {
    await mountAt(1280);
    expect(navZoom().querySelector('[data-testid="gantt-zoom"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="gantt-lane-overlay"] [data-testid="gantt-zoom"]')).toBeNull();
    expect(zoomButton("Zoom in")).not.toBeNull();
    expect(zoomButton("Zoom out")).not.toBeNull();
  });

  it("a click moves the zoom by one step (0.25)", async () => {
    await mountAt(1280);
    const base = trackRem();
    await click(zoomButton("Zoom in"));
    expect(trackRem() / base).toBeCloseTo(1.25, 2);
    await click(zoomButton("Zoom out"));
    expect(trackRem() / base).toBeCloseTo(1, 2);
  });

  it("stay focusable and become a no-op at the maximum and the minimum", async () => {
    await mountAt(1280);
    const base = trackRem();
    for (let i = 0; i < 8; i++) await click(zoomButton("Zoom in")); // 1 -> 3
    expect(trackRem() / base).toBeCloseTo(3, 2);
    expect(zoomButton("Zoom in").getAttribute("aria-disabled")).toBe("true");
    expect(zoomButton("Zoom in").hasAttribute("disabled")).toBe(false);
    await click(zoomButton("Zoom in"));
    expect(trackRem() / base).toBeCloseTo(3, 2);
    for (let i = 0; i < 10; i++) await click(zoomButton("Zoom out")); // 3 -> 0.5
    expect(trackRem() / base).toBeCloseTo(0.5, 2);
    expect(zoomButton("Zoom out").getAttribute("aria-disabled")).toBe("true");
    await click(zoomButton("Zoom out"));
    expect(trackRem() / base).toBeCloseTo(0.5, 2);
    expect(zoomButton("Zoom in").hasAttribute("aria-disabled")).toBe(false);
  });

  it("are absent below 1024px", async () => {
    await mountAt(900);
    expect(host.querySelector('[data-testid="gantt-zoom"]')).toBeNull();
  });
});
