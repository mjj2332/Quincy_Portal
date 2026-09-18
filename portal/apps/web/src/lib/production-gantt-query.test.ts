import { describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { PRODUCTION_GANTT_ZONE, type GanttChecklistRowDto, type GanttProjectRowDto, type ProductionGanttResponse } from "@quincy/shared";
import {
  decodeProductionGanttResponse,
  flattenGanttProjectPages,
  mergeGanttChildPage,
  productionGanttInfiniteQueryOptions,
  productionGanttKey,
  removeProductionGanttQueries,
} from "./production-gantt-query";
import { invalidateProjectSurfaces } from "./project-data";
import { ProjectQueryRuntime } from "./project-query-sync";

const principal = "11111111-1111-4111-8111-111111111111";
const editorId = "22222222-2222-4222-8222-222222222222";

function baseResponse() {
  return {
    scope: "active" as const,
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [],
    page: { limit: 100, returned: 0, nextCursor: null as string | null },
    density: { matchedProjects: 0, matchedRows: 0, drawCap: 2000, tooManyToDraw: false },
  };
}

function project(id: string, overrides: Partial<GanttProjectRowDto> = {}): GanttProjectRowDto {
  return {
    id,
    street: `${id} Street`,
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "awaiting_raw",
    delivered: false,
    shootDate: null,
    shootDateCivil: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    barStartDate: "2026-08-01",
    deadline: null,
    deadlineVersion: 0,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    ...overrides,
  };
}

function page(projects: GanttProjectRowDto[]): ProductionGanttResponse {
  return { ...baseResponse(), projects, page: { limit: 100, returned: projects.length, nextCursor: null } };
}

function checklistRow(id: string, overrides: Partial<GanttChecklistRowDto> = {}): GanttChecklistRowDto {
  return {
    id,
    projectId: "p1",
    title: `${id} title`,
    done: false,
    position: 0,
    assignee: null,
    schedule: { state: "unscheduled", version: 1, zone: "Australia/Sydney", start: null, end: null, due: null },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
    ...overrides,
  };
}

describe("production gantt query family", () => {
  it("composes the authorization, scope, and filter key in order, with the principal load-bearing at index 1", () => {
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 4 };
    const filters = { q: "smith street", editorIds: [editorId], stageKeys: ["editing" as const], delivered: true, completed: true };
    const key = productionGanttKey(identity, "active", filters);
    expect(key[0]).toBe("production-gantt");
    expect(key[1]).toBe(principal);
    expect(key).toEqual(["production-gantt", principal, "admin", 4, "active", filters]);
    const otherFilters = { ...filters, editorIds: [] };
    expect(productionGanttKey(identity, "active", otherFilters)).not.toEqual(key);
  });

  it("removes every filtered variant for one principal and leaves other principals", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const filters = { q: "", editorIds: [], stageKeys: [], delivered: false, completed: false };
    client.setQueryData(productionGanttKey(identity, "active", filters), { value: 1 });
    client.setQueryData(productionGanttKey(identity, "active", { ...filters, delivered: true }), { value: 2 });
    client.setQueryData(productionGanttKey({ ...identity, principalId: editorId }, "active", filters), { value: 3 });
    removeProductionGanttQueries(client, principal);
    expect(client.getQueryCache().findAll({ queryKey: ["production-gantt", principal] })).toHaveLength(0);
    expect(client.getQueryCache().findAll({ queryKey: ["production-gantt", editorId] })).toHaveLength(1);
  });

  it("getNextPageParam reads page.nextCursor, undefined when null", () => {
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const options = productionGanttInfiniteQueryOptions(identity);
    expect(options.getNextPageParam({ ...baseResponse(), page: { limit: 100, returned: 1, nextCursor: "abc" } })).toBe("abc");
    expect(options.getNextPageParam(baseResponse())).toBeUndefined();
  });

  it("initialPageParam is undefined (no cursor on the first page)", () => {
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    expect(productionGanttInfiniteQueryOptions(identity).initialPageParam).toBeUndefined();
  });

  it("select is a stable, module-scope function reference across separate options calls (fix-218-r3 #1)", () => {
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const first = productionGanttInfiniteQueryOptions(identity);
    const second = productionGanttInfiniteQueryOptions(identity);
    expect(second.select).toBe(first.select);
  });

  it("keeps the selected data's referential identity across a re-render with unchanged pages (fix-218-r3 #1)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const filters = { q: "", editorIds: [], stageKeys: [], delivered: false, completed: false };
    const queryKey = productionGanttKey(identity, "active", filters);
    const infiniteData = { pages: [page([project("a")])], pageParams: [undefined] };
    client.setQueryData(queryKey, infiniteData);

    // First "render": mount the observer with a fresh options object (as the hook does on every
    // render), and read the selected data.
    const optionsA = productionGanttInfiniteQueryOptions(identity, filters);
    const observer = new InfiniteQueryObserver(client, optionsA as never);
    const firstResult = observer.getCurrentResult();
    const firstProjects = firstResult.data!.projects;

    // Second "render": a brand-new options object (new object identity, same `select` reference
    // because it is hoisted to module scope) with the same, unchanged query data.
    const optionsB = productionGanttInfiniteQueryOptions(identity, filters);
    observer.setOptions(optionsB as never);
    const secondResult = observer.getCurrentResult();

    expect(secondResult.data!.projects).toBe(firstProjects);
  });

  it("selects exactly one role decoder with no permissive fallback, and photographers throw", () => {
    const admin = { ...baseResponse(), projects: [] };
    expect(decodeProductionGanttResponse("admin", admin)).toEqual(admin);
    expect(decodeProductionGanttResponse("editor", admin)).toEqual(admin);
    expect(decodeProductionGanttResponse("external_editor", admin)).toEqual(admin);
    expect(() => decodeProductionGanttResponse("photographer", admin)).toThrow(/domain/);
  });

  it("invalidateProjectSurfaces({ gantt: true, producer: 'gantt' }) broadcasts but does not invalidate the in-tab gantt query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "gantt-producer-coordinator");
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const filters = { q: "", editorIds: [], stageKeys: [], delivered: false, completed: false };
    const ganttKey = productionGanttKey(identity, "active", filters);
    queryClient.setQueryData(ganttKey, baseResponse());
    const observer = new QueryObserver(queryClient, { queryKey: ganttKey, queryFn: () => Promise.resolve(baseResponse()), staleTime: Infinity });
    const stop = observer.subscribe(() => undefined);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const publish = vi.spyOn(runtime, "publish");

    await invalidateProjectSurfaces(queryClient, { projectId: "p", resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: true, producer: "gantt" });

    const keysHit = invalidate.mock.calls.map(([options]) => JSON.stringify((options as { queryKey: unknown }).queryKey));
    expect(keysHit).not.toContain(JSON.stringify(ganttKey));
    expect(publish.mock.calls.filter(([message]) => message.type === "production-gantt-invalidated")).toHaveLength(1);

    stop();
    runtime.dispose();
    queryClient.clear();
  });

  it("invalidateProjectSurfaces({ gantt: true }) with no producer does invalidate the in-tab gantt query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "gantt-non-producer");
    const identity = { principalId: principal, role: "admin" as const, authorizationEpoch: 0 };
    const filters = { q: "", editorIds: [], stageKeys: [], delivered: false, completed: false };
    const ganttKey = productionGanttKey(identity, "active", filters);
    queryClient.setQueryData(ganttKey, baseResponse());
    const observer = new QueryObserver(queryClient, { queryKey: ganttKey, queryFn: () => Promise.resolve(baseResponse()), staleTime: Infinity });
    const stop = observer.subscribe(() => undefined);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await invalidateProjectSurfaces(queryClient, { projectId: "p", resources: [{ kind: "detail" }], dashboard: false, calendar: false, gantt: true });

    const keysHit = invalidate.mock.calls.map(([options]) => JSON.stringify((options as { queryKey: unknown }).queryKey));
    expect(keysHit).toContain(JSON.stringify(ganttKey));

    stop();
    runtime.dispose();
    queryClient.clear();
  });
});

describe("flattenGanttProjectPages (fix-218-r2 #1: live-data pagination contract)", () => {
  it("dedupes a project across pages, keeping the later page's data and position", () => {
    const early = project("dup", { barStartDate: "2026-08-01", street: "Old Street" });
    const late = project("dup", { barStartDate: "9999-01-01", street: "New Street" });
    const flattened = flattenGanttProjectPages([page([early, project("a")]), page([project("b"), late])]);
    expect(flattened.map((p) => p.id)).toEqual(["a", "b", "dup"]);
    const kept = flattened.find((p) => p.id === "dup")!;
    expect(kept).toBe(late);
    expect(kept.street).toBe("New Street");
  });

  it("leaves order untouched when there are no duplicates", () => {
    const flattened = flattenGanttProjectPages([page([project("a"), project("b")]), page([project("c")])]);
    expect(flattened.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for no pages", () => {
    expect(flattenGanttProjectPages([])).toEqual([]);
  });
});

describe("flattenGanttProjectPages incremental memo (fix-218-r3 #2: O(n), not O(n^2 / pageSize))", () => {
  it("is a pure function: the same pages array yields the same content on repeat calls", () => {
    const pages = [page([project("a"), project("b")]), page([project("c")])];
    const first = flattenGanttProjectPages(pages);
    const second = flattenGanttProjectPages(pages);
    expect(second).toEqual(first);
    expect(second.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("merges correctly when pages grow by immutable append (the real useInfiniteQuery shape)", () => {
    let pages: ProductionGanttResponse[] = [];
    pages = [...pages, page([project("a"), project("b")])];
    let flattened = flattenGanttProjectPages(pages);
    expect(flattened.map((p) => p.id)).toEqual(["a", "b"]);

    pages = [...pages, page([project("c")])];
    flattened = flattenGanttProjectPages(pages);
    expect(flattened.map((p) => p.id)).toEqual(["a", "b", "c"]);

    // A duplicate arriving on the newly appended page still wins per the latest-page-wins rule.
    pages = [...pages, page([project("a", { street: "Moved" })])];
    flattened = flattenGanttProjectPages(pages);
    expect(flattened.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(flattened.find((p) => p.id === "a")!.street).toBe("Moved");
  });

  it("never serves stale merged rows when a refetch replaces an earlier page (same length, new objects)", () => {
    const firstPageV1 = page([project("a", { street: "A v1" })]);
    const secondPage = page([project("b")]);
    const before = flattenGanttProjectPages([firstPageV1, secondPage]);
    expect(before.find((p) => p.id === "a")!.street).toBe("A v1");

    // A fresh walk (e.g. after an invalidation) rebuilds page one with new data; the pages array
    // is a new object at every index, so this must NOT reuse the earlier accumulator.
    const firstPageV2 = page([project("a", { street: "A v2" })]);
    const after = flattenGanttProjectPages([firstPageV2, secondPage]);
    expect(after.find((p) => p.id === "a")!.street).toBe("A v2");
    expect(after.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("walks each row exactly once across 200 sequential page arrivals (linear, not quadratic)", () => {
    let visits = 0;
    let pages: ProductionGanttResponse[] = [];
    let result: GanttProjectRowDto[] = [];
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const rows = Array.from({ length: 100 }, (_, rowIndex) => project(`p${pageIndex}-${rowIndex}`));
      pages = [...pages, page(rows)];
      result = flattenGanttProjectPages(pages, () => {
        visits += 1;
      });
    }
    expect(result).toHaveLength(20_000);
    // 200 pages x 100 rows, each row visited exactly once across the whole 200-call walk: O(n),
    // not the O(n^2 / pageSize) re-walk-every-accumulated-row behaviour this memo replaces.
    expect(visits).toBe(20_000);
  });
});

describe("mergeGanttChildPage (fix-218-r2 #1: same contract for a project's children)", () => {
  it("dedupes a child across pages, keeping the later page's data and position", () => {
    const early = checklistRow("dup", { position: 0, title: "Old title" });
    const late = checklistRow("dup", { position: 50, title: "New title" });
    const afterFirst = mergeGanttChildPage([], { projectId: "p1", children: { rows: [early, checklistRow("a")], total: 2, returned: 2, truncated: false, nextCursor: null } });
    const merged = mergeGanttChildPage(afterFirst, { projectId: "p1", children: { rows: [checklistRow("b"), late], total: 2, returned: 2, truncated: false, nextCursor: null } });
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "dup"]);
    const kept = merged.find((r) => r.id === "dup")!;
    expect(kept).toBe(late);
    expect(kept.title).toBe("New title");
  });

  it("leaves order untouched when there are no duplicates", () => {
    const afterFirst = mergeGanttChildPage([], { projectId: "p1", children: { rows: [checklistRow("a"), checklistRow("b")], total: 3, returned: 2, truncated: true, nextCursor: "x" } });
    const merged = mergeGanttChildPage(afterFirst, { projectId: "p1", children: { rows: [checklistRow("c")], total: 3, returned: 1, truncated: false, nextCursor: null } });
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("mergeGanttChildPage incremental memo (fix-218-r3 #2: O(n), not O(n^2 / pageSize))", () => {
  it("never serves stale merged rows when the caller resets existingRows (fresh accumulation)", () => {
    const afterFirst = mergeGanttChildPage([], { projectId: "p1", children: { rows: [checklistRow("a", { title: "A v1" })], total: 1, returned: 1, truncated: false, nextCursor: null } });
    expect(afterFirst.find((r) => r.id === "a")!.title).toBe("A v1");

    // Caller resets its own state (e.g. re-expanding after a refetch) and starts a fresh walk
    // from an empty accumulator, not the previous chain's `afterFirst`.
    const fresh = mergeGanttChildPage([], { projectId: "p1", children: { rows: [checklistRow("a", { title: "A v2" })], total: 1, returned: 1, truncated: false, nextCursor: null } });
    expect(fresh.find((r) => r.id === "a")!.title).toBe("A v2");
  });

  it("walks each row exactly once across 200 sequential child-page arrivals (linear, not quadratic)", () => {
    let visits = 0;
    let existingRows: GanttChecklistRowDto[] = [];
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const rows = Array.from({ length: 100 }, (_, rowIndex) => checklistRow(`c${pageIndex}-${rowIndex}`, { position: pageIndex * 100 + rowIndex }));
      const isLast = pageIndex === 199;
      existingRows = mergeGanttChildPage(
        existingRows,
        { projectId: "p1", children: { rows, total: 20_000, returned: 100, truncated: !isLast, nextCursor: isLast ? null : "x" } },
        () => {
          visits += 1;
        },
      );
    }
    expect(existingRows).toHaveLength(20_000);
    expect(visits).toBe(20_000);
  });
});
