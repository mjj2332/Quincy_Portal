/**
 * fix-220-sol1 #1, #2, #3 — a real render proving `ProductionGantt.tsx`'s child-pagination rework:
 * the eager per-project remaining-children walk merges pages as before (S7's own MUST), a failed
 * continuation keeps its partial rows and surfaces a retry instead of silently marking the project
 * complete, and a query-key change (here: `q`) clears every accumulated per-project child page
 * rather than splicing a superseded generation's rows into fresh data.
 *
 * Same rendering technique as `ProductionGantt-readonly.dom.test.tsx` beside this file — `apiGet` is
 * mocked (never a real `fetch`, per `src/testing/no-unmocked-fetch.ts`), and bars are located by
 * their own rendered text/aria-label, never a vendor `[data-slot]` (`test-seam.guard.test.ts` guard
 * F forbids that outside `components/reui/`).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, productionGanttChildPageSchema, PRODUCTION_GANTT_ZONE, type GanttChecklistRowDto, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ProductionGantt } from "./ProductionGantt";

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

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea viewport (composed by
// `<GanttView>`) calls it on a timer. Same polyfill `ProductionGantt-readonly.dom.test.tsx` uses.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_STREET = "1 Pagination Street";

const TODAY = new Date();
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}
const SHOOT_DATE = isoDate(0);
const DEADLINE_DATE = isoDate(5);

function task(id: string, title: string, position: number): GanttChecklistRowDto {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    done: false,
    position,
    assignee: null,
    schedule: {
      state: "due_only",
      version: 1,
      zone: PRODUCTION_GANTT_ZONE,
      start: null,
      end: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
      due: isoDate(2),
    },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
  };
}

function projectRow(overrides: {
  street?: string;
  rows: GanttChecklistRowDto[];
  total: number;
  truncated: boolean;
  nextCursor: string | null;
}): GanttProjectRowDto {
  return {
    id: PROJECT_ID,
    street: overrides.street ?? PROJECT_STREET,
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "editing_autohdr",
    delivered: false,
    shootDate: SHOOT_DATE,
    shootDateCivil: SHOOT_DATE,
    createdAt: SHOOT_DATE + "T00:00:00.000Z",
    barStartDate: SHOOT_DATE,
    deadline: { at: `${DEADLINE_DATE}T05:00:00.000Z`, localCivil: `${DEADLINE_DATE}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: overrides.total },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: overrides.rows, total: overrides.total, returned: overrides.rows.length, truncated: overrides.truncated, nextCursor: overrides.nextCursor },
  };
}

function listResponse(project: GanttProjectRowDto) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [project],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  });
}

function childPageResponse(rows: GanttChecklistRowDto[], total: number, truncated: boolean, nextCursor: string | null) {
  return productionGanttChildPageSchema.parse({
    projectId: PROJECT_ID,
    children: { rows, total, returned: rows.length, truncated, nextCursor },
  });
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

async function settle() {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function findByText(host: HTMLElement, text: string): Element | undefined {
  return [...host.querySelectorAll("button, span")].find((candidate) => candidate.textContent === text || candidate.getAttribute("aria-label")?.includes(text));
}

describe("ProductionGantt — child-page pagination (fix-220-sol1 #1, #2, #3)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    apiGetMock.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
  });

  async function renderWithQuery(q: string) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProductionGantt identity={identity} q={q} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
  }

  it("eagerly walks a truncated project's remaining child pages and merges them into the rendered rows (#3 eager walk, #2 merge)", async () => {
    const page1Task = task("22222222-2222-4222-8222-000000000001", "Page one task", 0);
    const page2Task = task("22222222-2222-4222-8222-000000000002", "Page two task", 1);

    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        return Promise.resolve(childPageResponse([page2Task], 2, false, null));
      }
      return Promise.resolve(listResponse(projectRow({ rows: [page1Task], total: 2, truncated: true, nextCursor: "cursor-1" })));
    });

    await renderWithQuery("");

    expect(findByText(host, "Page one task")).toBeDefined();
    expect(findByText(host, "Page two task")).toBeDefined();
    expect(host.querySelector('[data-testid="gantt-children-retry"]')).toBeNull();
  });

  it("keeps partial rows and surfaces a retry on a failed continuation, instead of marking the project complete (#2)", async () => {
    const page1Task = task("22222222-2222-4222-8222-000000000003", "Kept page one task", 0);
    const page2Task = task("22222222-2222-4222-8222-000000000004", "Recovered page two task", 1);

    let childRequestCount = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        childRequestCount += 1;
        if (childRequestCount === 1) return Promise.reject(new Error("network blip"));
        return Promise.resolve(childPageResponse([page2Task], 2, false, null));
      }
      return Promise.resolve(listResponse(projectRow({ rows: [page1Task], total: 2, truncated: true, nextCursor: "cursor-1" })));
    });

    await renderWithQuery("");

    // The failed continuation never wiped the page-1 row, and never silently marked the project
    // complete — the retry affordance is the visible proof an error is being surfaced, not
    // swallowed.
    expect(findByText(host, "Kept page one task")).toBeDefined();
    expect(findByText(host, "Recovered page two task")).toBeUndefined();
    const retryButton = host.querySelector('[data-testid="gantt-children-retry"]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await settle();

    expect(findByText(host, "Recovered page two task")).toBeDefined();
    expect(host.querySelector('[data-testid="gantt-children-retry"]')).toBeNull();
  });

  it("clears accumulated child rows on a query-key change (q), never splicing a superseded generation's rows into fresh data (#1)", async () => {
    const oldPage1Task = task("22222222-2222-4222-8222-000000000005", "Stale generation task one", 0);
    const oldPage2Task = task("22222222-2222-4222-8222-000000000006", "Stale generation task two", 1);
    const freshTask = task("22222222-2222-4222-8222-000000000007", "Fresh generation task", 0);

    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        return Promise.resolve(childPageResponse([oldPage2Task], 2, false, null));
      }
      if (path.includes("q=new")) {
        // Same project id can legitimately reappear under a different filter — its OWN fresh
        // embedded page here carries neither stale task, and is already complete (not truncated),
        // so nothing should trigger a further child-page fetch for it.
        return Promise.resolve(listResponse(projectRow({ rows: [freshTask], total: 1, truncated: false, nextCursor: null })));
      }
      return Promise.resolve(listResponse(projectRow({ rows: [oldPage1Task], total: 2, truncated: true, nextCursor: "cursor-1" })));
    });

    await renderWithQuery("");
    expect(findByText(host, "Stale generation task one")).toBeDefined();
    expect(findByText(host, "Stale generation task two")).toBeDefined();

    await renderWithQuery("new");

    expect(findByText(host, "Fresh generation task")).toBeDefined();
    expect(findByText(host, "Stale generation task one")).toBeUndefined();
    expect(findByText(host, "Stale generation task two")).toBeUndefined();
    expect(host.querySelector('[data-testid="gantt-children-retry"]')).toBeNull();
  });

  // fix-220-sol1b: generation scoping (fix-220-sol1 #1, tested above) only catches a query-KEY
  // change. These three cases cover the companion defect — a refetch under the SAME query key (a
  // poll, another tab's mutation) that changes a project's embedded first page — which the
  // convergence contract at `packages/shared/src/production-gantt.ts:149-165` requires a fresh walk
  // to eventually reflect.

  it("re-reconciles an already-walked project when its embedded first page changes under the SAME query key (fix-220-sol1b #1)", async () => {
    const page1Task = task("22222222-2222-4222-8222-000000000008", "Stale embedded task", 0);
    const page2Task = task("22222222-2222-4222-8222-000000000009", "Stale continuation task", 1);
    const freshTask = task("22222222-2222-4222-8222-00000000000a", "Fresh embedded task", 0);

    let refetched = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        return Promise.resolve(childPageResponse([page2Task], 2, false, null));
      }
      if (refetched) {
        return Promise.resolve(listResponse(projectRow({ rows: [freshTask], total: 1, truncated: false, nextCursor: null })));
      }
      return Promise.resolve(listResponse(projectRow({ rows: [page1Task], total: 2, truncated: true, nextCursor: "cursor-1" })));
    });

    await renderWithQuery("");
    expect(findByText(host, "Stale embedded task")).toBeDefined();
    expect(findByText(host, "Stale continuation task")).toBeDefined();

    // Same identity, same filters, same query key — a poll or another tab's checklist edit, not a
    // `q`/filter/identity change.
    refetched = true;
    await act(async () => {
      await client.refetchQueries();
    });
    await settle();

    expect(findByText(host, "Fresh embedded task")).toBeDefined();
    expect(findByText(host, "Stale embedded task")).toBeUndefined();
    expect(findByText(host, "Stale continuation task")).toBeUndefined();
    expect(host.querySelector('[data-testid="gantt-children-retry"]')).toBeNull();
  });

  it("costs nothing on an identical refetch — no additional child-page fetch when the embedded first page is unchanged (fix-220-sol1b #2)", async () => {
    let childRequestCount = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        childRequestCount += 1;
        return Promise.resolve(childPageResponse([task("22222222-2222-4222-8222-00000000000c", "Idempotent continuation task", 1)], 2, false, null));
      }
      // A fresh object every call (mirroring a real re-parsed response), same content every time.
      return Promise.resolve(
        listResponse(projectRow({ rows: [task("22222222-2222-4222-8222-00000000000b", "Idempotent embedded task", 0)], total: 2, truncated: true, nextCursor: "cursor-1" })),
      );
    });

    await renderWithQuery("");
    expect(findByText(host, "Idempotent embedded task")).toBeDefined();
    expect(findByText(host, "Idempotent continuation task")).toBeDefined();
    expect(childRequestCount).toBe(1);

    await act(async () => {
      await client.refetchQueries();
    });
    await settle();

    // No re-walk: the identical embedded page must not cost a second child-page fetch.
    expect(childRequestCount).toBe(1);
    expect(findByText(host, "Idempotent embedded task")).toBeDefined();
    expect(findByText(host, "Idempotent continuation task")).toBeDefined();
  });

  it("aborts an in-flight chain on re-seed and discards its late response, never letting it overwrite the fresh state (fix-220-sol1b #3)", async () => {
    const page1Task = task("22222222-2222-4222-8222-00000000000d", "In-flight seed task", 0);
    const staleContinuationTask = task("22222222-2222-4222-8222-00000000000e", "Stale continuation task", 1);
    const freshTask = task("22222222-2222-4222-8222-00000000000f", "Reseeded fresh task", 0);

    let refetched = false;
    let childRequestCount = 0;
    let resolveStaleChildPage: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("childrenOf=")) {
        childRequestCount += 1;
        if (childRequestCount === 1) {
          // Never resolves on its own — held open so the reseed below races an in-flight chain.
          return new Promise((resolve) => {
            resolveStaleChildPage = resolve;
          });
        }
        return Promise.resolve(childPageResponse([], 1, false, null));
      }
      if (refetched) {
        return Promise.resolve(listResponse(projectRow({ rows: [freshTask], total: 1, truncated: false, nextCursor: null })));
      }
      return Promise.resolve(listResponse(projectRow({ rows: [page1Task], total: 2, truncated: true, nextCursor: "cursor-1" })));
    });

    await renderWithQuery("");
    // The continuation for page one is still in flight — never resolved yet.
    expect(findByText(host, "In-flight seed task")).toBeDefined();
    expect(findByText(host, "Reseeded fresh task")).toBeUndefined();

    refetched = true;
    await act(async () => {
      await client.refetchQueries();
    });
    await settle();

    // The re-seed landed while the old chain was still in flight — it must win outright.
    expect(findByText(host, "Reseeded fresh task")).toBeDefined();
    expect(findByText(host, "In-flight seed task")).toBeUndefined();
    expect(host.querySelector('[data-testid="gantt-children-retry"]')).toBeNull();

    // Now let the OLD (aborted) chain's response land late.
    await act(async () => {
      resolveStaleChildPage?.(childPageResponse([staleContinuationTask], 2, false, null));
      await Promise.resolve();
    });
    await settle();

    // The stale response must never have written into the re-seeded state.
    expect(findByText(host, "Stale continuation task")).toBeUndefined();
    expect(findByText(host, "Reseeded fresh task")).toBeDefined();
    expect(findByText(host, "In-flight seed task")).toBeUndefined();
  });
});
