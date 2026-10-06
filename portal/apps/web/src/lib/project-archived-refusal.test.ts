import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { keepCachedArchiveState, projectDataKeys, recordProjectArchivedRefusal } from "./project-data";

const projectId = "p1";
const detailKey = projectDataKeys.detail(projectId);
const summaryKey = projectDataKeys.collaborationSummary(projectId);

describe("recordProjectArchivedRefusal (#566)", () => {
  it("writes only the keys that hold data", async () => {
    const client = new QueryClient();
    await recordProjectArchivedRefusal(client, projectId);
    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect(client.getQueryData(summaryKey)).toBeUndefined();
    client.setQueryData(summaryKey, { project: { id: projectId, archived: false }, members: [] });
    await recordProjectArchivedRefusal(client, projectId);
    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect((client.getQueryData(summaryKey) as { project: { archived: boolean } }).project.archived).toBe(true);
  });

  it("marks an un-archived detail archived with a timestamp, and keeps an existing archivedAt as it was", async () => {
    const client = new QueryClient();
    client.setQueryData(detailKey, { id: projectId, archivedAt: null, members: [] });
    await recordProjectArchivedRefusal(client, projectId);
    expect(typeof (client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("string");
    client.setQueryData(detailKey, { id: projectId, archivedAt: "2026-01-01T00:00:00.000Z", members: [] });
    await recordProjectArchivedRefusal(client, projectId);
    expect((client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the write over a read that began before it, and a later invalidation still marks the entry invalidated", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(detailKey, { id: projectId, archivedAt: null, members: [] });
    let release!: () => void;
    const pre = client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise((resolve) => { release = () => resolve({ id: projectId, archivedAt: null, members: [] }); }), staleTime: 0 }).catch(() => undefined);
    await recordProjectArchivedRefusal(client, projectId);
    release(); await pre;
    expect(typeof (client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("string");
    await client.invalidateQueries({ queryKey: detailKey, exact: true, refetchType: "none" });
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  // The window where the first read's retryer has resolved but the query has not published is a microtask or two wide, so try each offset.
  it.each([0, 1, 2, 3, 4, 5, 6])("keeps the write over a read that resolved %i ticks before the refusal, whatever stage cancelling finds it in", async (ticks) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(detailKey, { id: projectId, archivedAt: null, members: [] });
    let release!: () => void;
    const pre = client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise((resolve) => { release = () => resolve({ id: projectId, archivedAt: null, members: [] }); }), staleTime: 0 }).catch(() => undefined);
    release();
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
    const recorded = recordProjectArchivedRefusal(client, projectId);
    // The next read (GET2) starts, as the invalidation after the refusal would, and is still in flight.
    await recorded;
    void client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise(() => undefined), staleTime: 0 });
    await pre; await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeof (client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("string");
  });
});

// Microtask ticks after which the first read's retryer has resolved but the query has not yet published its result.
const RETRYER_RESOLVED_TICKS = 5;

describe("keepCachedArchiveState (#566)", () => {
  it("keeps a cached archive over a Save response that says un-archived", () => {
    expect(keepCachedArchiveState({ archivedAt: "2026-01-01T00:00:00.000Z" }, { id: "p", archivedAt: null })).toEqual({ id: "p", archivedAt: "2026-01-01T00:00:00.000Z" });
  });
  it("passes the response through when the cache is not archived or the response is archived", () => {
    expect(keepCachedArchiveState({ archivedAt: null }, { id: "p", archivedAt: null })).toEqual({ id: "p", archivedAt: null });
    expect(keepCachedArchiveState(undefined, { id: "p", archivedAt: null })).toEqual({ id: "p", archivedAt: null });
    expect(keepCachedArchiveState({ archivedAt: null }, { id: "p", archivedAt: "2026-02-02" })).toEqual({ id: "p", archivedAt: "2026-02-02" });
  });
  it("Restore un-archives: it reaches the cache through a refetch, which this guard does not touch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(detailKey, { id: projectId, archivedAt: "2026-01-01T00:00:00.000Z", members: [] });
    await client.fetchQuery({ queryKey: detailKey, queryFn: () => Promise.resolve({ id: projectId, archivedAt: null, members: [] }), staleTime: 0 });
    expect((client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBeNull();
  });
});
