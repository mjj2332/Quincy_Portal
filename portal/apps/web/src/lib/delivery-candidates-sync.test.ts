import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invalidateProjectResources, invalidateProjectSurfaces, projectDataKeys } from "./project-data";
import { createProjectDataInvalidationMessage, ProjectQueryRuntime, type ProjectDataResource } from "./project-query-sync";

/**
 * The Delivery tab's candidates (#787 slice 10 round 4) are what Publish would accept, so anything that changes Assets, Videos or the Video Trash changes them too. That is decided where
 * resource invalidation fans out, locally and on a received cross-tab message, so a new writer inherits it.
 */
const P = "11111111-1111-4111-8111-111111111111";
let client: QueryClient; let runtime: ProjectQueryRuntime; let reads: Mock<() => Promise<{ candidates: never[] }>>; let observer: QueryObserver<unknown, Error, unknown, unknown, readonly unknown[]>; let stop: () => void;
beforeEach(async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); runtime = new ProjectQueryRuntime(client, "this-tab");
  reads = vi.fn(async () => ({ candidates: [] as never[] }));
  observer = new QueryObserver<unknown, Error, unknown, unknown, readonly unknown[]>(client, { queryKey: projectDataKeys.deliveryCandidates(P), queryFn: reads, staleTime: 60_000 });
  stop = observer.subscribe(() => undefined);
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
});
afterEach(() => { stop(); runtime.dispose(); client.clear(); });

const CHANGES: Array<[string, ProjectDataResource]> = [
  ["edited assets", { kind: "assets", collectionKind: "edited" }], ["floorplan assets", { kind: "assets", collectionKind: "floorplan" }], ["copy assets", { kind: "assets", collectionKind: "copy" }],
  ["videos", { kind: "videos" }], ["video trash", { kind: "video-trash" }],
];
describe("a local invalidation", () => {
  it.each(CHANGES)("of %s also refetches the candidates", async (_name, resource) => {
    await invalidateProjectResources(client, { projectId: P, resources: [resource] }, false);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
  });
  it("through invalidateProjectSurfaces does too", async () => {
    await invalidateProjectSurfaces(client, { projectId: P, resources: [{ kind: "assets", collectionKind: "edited" }], dashboard: false, calendar: false, gantt: false });
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
  });
  it("of something that cannot change them (activity, detail, RAW assets) leaves them alone", async () => {
    await invalidateProjectResources(client, { projectId: P, resources: [{ kind: "activity" }, { kind: "detail" }, { kind: "assets", collectionKind: "raw" }] }, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
describe("a message from another tab", () => {
  const receive = (resource: ProjectDataResource, projectId = P) => (runtime as unknown as { receive: (value: unknown) => void }).receive({ ...createProjectDataInvalidationMessage(projectId, [resource]), sourceTabId: "other-tab" });
  it.each(CHANGES)("about %s also refetches the candidates", async (_name, resource) => {
    receive(resource);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
  });
  it("about another Project does not", async () => {
    receive({ kind: "assets", collectionKind: "edited" }, "22222222-2222-4222-8222-222222222222");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe("a read already in flight when the change lands cannot become the cache", () => {
  type Reply = { candidates: Array<{ assetId: string }> };
  let release: Array<(value: Reply) => void>; let starts: number; let fresh: QueryObserver<Reply, Error, Reply, Reply, readonly unknown[]>; let off: () => void;
  const OTHER = "33333333-3333-4333-8333-333333333333";
  beforeEach(() => {
    release = []; starts = 0;
    fresh = new QueryObserver<Reply, Error, Reply, Reply, readonly unknown[]>(client, { queryKey: projectDataKeys.deliveryCandidates(OTHER), staleTime: 60_000, queryFn: () => { starts += 1; return new Promise<Reply>((resolve) => { release.push(resolve); }); } });
    off = fresh.subscribe(() => undefined);
  });
  afterEach(() => off());
  const settleBoth = async () => {
    await vi.waitFor(() => expect(starts).toBe(2)); // the change started a second read
    release[1]!({ candidates: [{ assetId: "after" }] });
    release[0]!({ candidates: [{ assetId: "before" }] }); // the snapshot taken before the change lands late
    await vi.waitFor(() => expect(client.getQueryData<Reply>(projectDataKeys.deliveryCandidates(OTHER))?.candidates[0]?.assetId).toBe("after"));
  };
  it("after a local invalidation of Assets", async () => {
    await vi.waitFor(() => expect(starts).toBe(1));
    void invalidateProjectResources(client, { projectId: OTHER, resources: [{ kind: "assets", collectionKind: "edited" }] }, false);
    await settleBoth();
  });
  it("after a message from another tab", async () => {
    await vi.waitFor(() => expect(starts).toBe(1));
    (runtime as unknown as { receive: (value: unknown) => void }).receive({ ...createProjectDataInvalidationMessage(OTHER, [{ kind: "video-trash" }]), sourceTabId: "other-tab" });
    await settleBoth();
  });
});
