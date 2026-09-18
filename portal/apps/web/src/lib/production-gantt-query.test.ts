import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import {
  decodeProductionGanttResponse,
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
