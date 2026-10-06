import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { projectDataKeys, recordProjectArchivedRefusal } from "./project-data";

const projectId = "p1";
const detailKey = projectDataKeys.detail(projectId);
const summaryKey = projectDataKeys.collaborationSummary(projectId);

describe("recordProjectArchivedRefusal (#566)", () => {
  it("writes only the keys that hold data", () => {
    const client = new QueryClient();
    recordProjectArchivedRefusal(client, projectId);
    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect(client.getQueryData(summaryKey)).toBeUndefined();
    client.setQueryData(summaryKey, { project: { id: projectId, archived: false }, members: [] });
    recordProjectArchivedRefusal(client, projectId);
    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect((client.getQueryData(summaryKey) as { project: { archived: boolean } }).project.archived).toBe(true);
  });

  it("marks an un-archived detail archived with a timestamp, and keeps an existing archivedAt as it was", () => {
    const client = new QueryClient();
    client.setQueryData(detailKey, { id: projectId, archivedAt: null, members: [] });
    recordProjectArchivedRefusal(client, projectId);
    expect(typeof (client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("string");
    client.setQueryData(detailKey, { id: projectId, archivedAt: "2026-01-01T00:00:00.000Z", members: [] });
    recordProjectArchivedRefusal(client, projectId);
    expect((client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the write over a read that began before it, and a later invalidation still marks the entry invalidated", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(detailKey, { id: projectId, archivedAt: null, members: [] });
    let release!: () => void;
    const pre = client.fetchQuery({ queryKey: detailKey, queryFn: () => new Promise((resolve) => { release = () => resolve({ id: projectId, archivedAt: null, members: [] }); }), staleTime: 0 }).catch(() => undefined);
    recordProjectArchivedRefusal(client, projectId);
    release(); await pre;
    expect(typeof (client.getQueryData(detailKey) as { archivedAt: unknown }).archivedAt).toBe("string");
    await client.invalidateQueries({ queryKey: detailKey, exact: true, refetchType: "none" });
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });
});
