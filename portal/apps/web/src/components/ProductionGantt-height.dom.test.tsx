/**
 * #363 -- the Gantt fills the Dashboard's view region instead of a fixed 36rem: every wrapper
 * between the always-mounted root and the vendored `Gantt` is a flexed, `min-h-0` column item.
 * happy-dom cannot lay out, so this pins the class contract; the browser pass measures the pixels.
 * Harness copied from `ProductionGantt-filters.dom.test.tsx`.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
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

function ControlledGantt() {
  const [filters, setFilters] = useState<ProductionGanttFacetFilters>(DEFAULT_GANTT_FACET_FILTERS);
  return (
    <ProductionGantt
      identity={identity}
      q=""
      filters={filters}
      onFiltersChange={setFilters}
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


const FILL = ["flex-1", "min-h-0"];

function classesOf(element: Element | null): string[] {
  if (!element) throw new Error("element missing");
  return [...element.classList];
}

describe("ProductionGantt -- fills the height (#363)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiGetMock.mockReset();
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

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ControlledGantt />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await settle();
  }

  it("flexes the root, the chart body and the vendored Gantt, with no fixed height", async () => {
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse()) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
    await render();
    const root = host.querySelector('[data-testid="production-gantt-root"]');
    const body = host.querySelector('[data-testid="production-gantt"]');
    // The vendored Gantt is the chart body's last child; selecting it by the vendor's own
    // `data-slot` is forbidden by testing/test-seam.guard.test.ts (guard F).
    const gantt = body?.lastElementChild ?? null;
    expect(gantt, "no vendored Gantt rendered").not.toBeNull();
    for (const element of [root, body, gantt]) {
      const classes = classesOf(element);
      for (const token of FILL) expect(classes).toContain(token);
    }
    expect(classesOf(gantt)).not.toContain("h-[36rem]");
    const filters = host.querySelector('[data-testid="production-gantt-filters"]')!;
    expect(filters).not.toBeNull();
    expect(host.querySelector('[data-testid="production-gantt"]')!.contains(filters)).toBe(false);
  });

  it("fills the region while pending", async () => {
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    await render();
    const loading = host.querySelector('[data-testid="production-gantt-loading"]')!;
    for (const token of FILL) expect(classesOf(loading)).toContain(token);
    for (const token of FILL) expect(classesOf(loading.lastElementChild)).toContain(token);
  });
});
