import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import {
  beginAssetOptimisticMutation, classifyProjectAccessError, emptyReview, invalidateProjectResources,
  projectAssetsQueryOptions, projectDataKeys, projectDetailQueryOptions, projectQueryRetry,
  clearPrincipalProjectData, removeProjectData, type ProjectDetail,
} from "./project-data";
import { ProjectQueryRuntime } from "./project-query-sync";
import { createQuincyQueryClient } from "./query-client";
import type { WorkspaceAsset } from "../components/PhotoGrid";

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiGet: apiGetMock }));

function client(gcTime = Infinity) { return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime } } }); }
function asset(id: string, patch: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return { id, collectionId: "c", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-08-25T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, ...patch };
}
function detail(id: string): ProjectDetail { return { id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [] }; }

afterEach(() => { vi.restoreAllMocks(); apiGetMock.mockReset(); });

describe("project data key and request seam", () => {
  it("keeps every project and collection coordinate in exact tuples", () => {
    expect(projectDataKeys.root).toEqual(["project-data"]);
    expect(projectDataKeys.detail("a")).toEqual(["project-data", "a", "detail"]);
    expect(projectDataKeys.assets("a", "raw")).toEqual(["project-data", "a", "assets", "raw"]);
    expect(projectDataKeys.assets("b", "copy")).not.toEqual(projectDataKeys.assets("a", "copy"));
    expect(["raw", "edited", "video", "floorplan", "copy"].map((kind) => projectDataKeys.assets("a", kind as never))).toHaveLength(5);
  });

  it("URL-encodes project/collection values and forwards React Query's signal", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient); const signal = new AbortController().signal;
    const detailOptions = projectDetailQueryOptions("a/b");
    const assetsOptions = projectAssetsQueryOptions("a/b", "floorplan");
    apiGetMock.mockResolvedValueOnce(detail("a/b")).mockResolvedValueOnce({ assets: [] });
    await detailOptions.queryFn({ signal, client: queryClient, queryKey: detailOptions.queryKey, meta: undefined });
    await assetsOptions.queryFn({ signal, client: queryClient, queryKey: assetsOptions.queryKey, meta: undefined });
    expect(apiGetMock.mock.calls[0]).toEqual(["/api/projects/a%2Fb", { signal }]);
    expect(apiGetMock.mock.calls[1]).toEqual(["/api/projects/a%2Fb/assets?collection=floorplan", { signal }]);
    runtime.dispose(); queryClient.clear();
  });

  it("classifies retryable and terminal failures without treating abort as an API error", () => {
    expect(projectQueryRetry(0, Object.assign(new Error("cancel"), { name: "AbortError" }))).toBe(false);
    expect(projectQueryRetry(0, new ApiError("offline", 0))).toBe(true);
    expect(projectQueryRetry(1, new ApiError("offline", 0))).toBe(true);
    expect(projectQueryRetry(2, new ApiError("offline", 0))).toBe(false);
    expect(projectQueryRetry(0, new ApiError("bad request", 400))).toBe(false);
    expect(projectQueryRetry(0, new ApiError("timeout", 408))).toBe(true);
    expect(projectQueryRetry(0, new ApiError("rate", 429))).toBe(true);
    expect(projectQueryRetry(0, new ApiError("server", 500))).toBe(true);
    expect(projectQueryRetry(0, new ApiError("unauthenticated", 401))).toBe(false);
    expect(projectQueryRetry(0, new ApiError("forbidden", 403))).toBe(false);
    expect(projectQueryRetry(0, new ApiError("missing", 404))).toBe(false);
  });

  it("uses the approved stale/GC defaults and keeps polling observer fields out of option factories", () => {
    const queryClient = createQuincyQueryClient();
    expect(queryClient.getDefaultOptions().queries).toMatchObject({ staleTime: 15_000, gcTime: 5 * 60_000, refetchOnMount: true, refetchOnWindowFocus: true, refetchOnReconnect: true, structuralSharing: true });
    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    expect(projectDetailQueryOptions("p")).not.toHaveProperty("refetchInterval");
    expect(projectAssetsQueryOptions("p", "raw")).not.toHaveProperty("refetchInterval");
    queryClient.clear();
  });

  it("separates detail, capability, membership, and missing-resource access loss", () => {
    expect(classifyProjectAccessError(new ApiError("unauthenticated", 401), "detail")).toEqual({ scope: "principal" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403), "detail")).toEqual({ scope: "project" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403, { capability: "viewEdited" }), "assets", "edited")).toEqual({ scope: "collection", collectionKind: "edited" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403, { capability: "viewRaw" }), "assets", "edited")).toEqual({ scope: "project" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403), "assets", "raw")).toEqual({ scope: "project" });
    expect(classifyProjectAccessError(new ApiError("missing", 404), "assets", "raw")).toEqual({ scope: "project" });
  });

  it("keeps reversed project and collection responses in their exact cache entries", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient);
    const pending = new Map<string, (value: unknown) => void>();
    const signals = new Map<string, AbortSignal>();
    apiGetMock.mockImplementation((path: string, init?: { signal?: AbortSignal }) => new Promise((resolve) => { pending.set(path, resolve); signals.set(path, init?.signal!); }));
    const projectA = queryClient.fetchQuery({ ...projectDetailQueryOptions("A"), staleTime: 0 }).catch(() => undefined);
    const projectB = queryClient.fetchQuery({ ...projectDetailQueryOptions("B"), staleTime: 0 });
    await queryClient.cancelQueries({ queryKey: projectDataKeys.detail("A"), exact: true });
    expect(signals.get("/api/projects/A")?.aborted).toBe(true);
    pending.get("/api/projects/B")!(detail("B")); await projectB;
    pending.get("/api/projects/A")!(detail("A")); await projectA;
    expect(queryClient.getQueryData<ProjectDetail>(projectDataKeys.detail("A"))).toBeUndefined();
    expect(queryClient.getQueryData<ProjectDetail>(projectDataKeys.detail("B"))?.id).toBe("B");

    const raw = queryClient.fetchQuery({ ...projectAssetsQueryOptions("A", "raw"), staleTime: 0 });
    const edited = queryClient.fetchQuery({ ...projectAssetsQueryOptions("A", "edited"), staleTime: 0 });
    pending.get("/api/projects/A/assets?collection=edited")!({ assets: [asset("edited")] }); await edited;
    pending.get("/api/projects/A/assets?collection=raw")!({ assets: [asset("raw")] }); await raw;
    expect(queryClient.getQueryData<WorkspaceAsset[]>(projectDataKeys.assets("A", "raw"))?.[0]?.id).toBe("raw");
    expect(queryClient.getQueryData<WorkspaceAsset[]>(projectDataKeys.assets("A", "edited"))?.[0]?.id).toBe("edited");
    runtime.dispose(); queryClient.clear();
  });

  it("invalidates only the requested exact resources, including the RAW-delete Edited exception", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient);
    const detailKey = projectDataKeys.detail("p"); const rawKey = projectDataKeys.assets("p", "raw"); const editedKey = projectDataKeys.assets("p", "edited");
    queryClient.setQueryData(detailKey, detail("p")); queryClient.setQueryData(rawKey, []); queryClient.setQueryData(editedKey, []);
    await invalidateProjectResources(queryClient, { projectId: "p", resources: [{ kind: "detail" }] });
    expect(queryClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated).toBe(true);
    expect(queryClient.getQueryCache().find({ queryKey: rawKey, exact: true })?.state.isInvalidated).toBe(false);
    expect(queryClient.getQueryCache().find({ queryKey: editedKey, exact: true })?.state.isInvalidated).toBe(false);
    await invalidateProjectResources(queryClient, { projectId: "p", resources: [{ kind: "assets", collectionKind: "raw" }, { kind: "assets", collectionKind: "edited" }, { kind: "detail" }] });
    expect(queryClient.getQueryCache().find({ queryKey: rawKey, exact: true })?.state.isInvalidated).toBe(true);
    expect(queryClient.getQueryCache().find({ queryKey: editedKey, exact: true })?.state.isInvalidated).toBe(true);
    runtime.dispose(); queryClient.clear();
  });
});

describe("asset mutation ledger", () => {
  it("composes different assets and keeps the successful sibling after one failure", async () => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient);
    const key = projectDataKeys.assets("p", "raw"); queryClient.setQueryData(key, [asset("a"), asset("b")]);
    const [first, second] = await Promise.all([
      beginAssetOptimisticMutation(queryClient, "p", "raw", "a", { selected: true }),
      beginAssetOptimisticMutation(queryClient, "p", "raw", "b", { selected: true }),
    ]);
    expect(queryClient.getQueryData<WorkspaceAsset[]>(key)?.map((item) => item.selected)).toEqual([true, true]);
    await first!.commit(); await second!.fail();
    expect(queryClient.getQueryData<WorkspaceAsset[]>(key)?.map((item) => item.selected)).toEqual([true, false]);
  });

  it("rolls back only one field when concurrent fields on one asset settle differently", async () => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient);
    const key = projectDataKeys.assets("p", "raw"); queryClient.setQueryData(key, [asset("a")]);
    const [rating, decision] = await Promise.all([
      beginAssetOptimisticMutation(queryClient, "p", "raw", "a", { stars: 5 }),
      beginAssetOptimisticMutation(queryClient, "p", "raw", "a", { decision: "approved" }),
    ]);
    await rating!.fail(); await decision!.commit();
    const current = queryClient.getQueryData<WorkspaceAsset[]>(key)![0]!;
    expect(current.review).toEqual({ ...emptyReview(), decision: "approved" });
  });

  it("defers the one confirming exact invalidation until all sibling tokens settle", async () => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient); const key = projectDataKeys.assets("p", "raw"); queryClient.setQueryData(key, [asset("a"), asset("b")]);
    const [first, second] = await Promise.all([beginAssetOptimisticMutation(queryClient, "p", "raw", "a", { selected: true }), beginAssetOptimisticMutation(queryClient, "p", "raw", "b", { selected: true })]);
    await invalidateProjectResources(queryClient, { projectId: "p", resources: [{ kind: "assets", collectionKind: "raw" }] });
    expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated).toBe(false);
    await first!.commit(); expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated).toBe(false);
    await second!.commit(); expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated).toBe(true);
  });
});

describe("tombstone purge", () => {
  it("removes inactive project data and rejects a response that resolves after removal", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient); const key = projectDataKeys.detail("p"); queryClient.setQueryData(key, detail("p"));
    let resolve!: (value: ProjectDetail) => void; apiGetMock.mockReturnValue(new Promise<ProjectDetail>((done) => { resolve = done; }));
    const options = projectDetailQueryOptions("p"); const request = options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    await removeProjectData(queryClient, "p"); resolve(detail("p"));
    await expect(request).rejects.toMatchObject({ status: 404 });
    expect(runtime.removedProjectIds.has("p")).toBe(true); expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("clears every cached project resource after a migrated-query 401 terminal", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient);
    queryClient.setQueryData(projectDataKeys.detail("p"), detail("p")); queryClient.setQueryData(projectDataKeys.assets("p", "raw"), []); queryClient.setQueryData(projectDataKeys.assets("other", "edited"), []);
    await clearPrincipalProjectData(queryClient);
    expect(runtime.principalTerminal).toBe(true); expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    runtime.dispose();
  });
});
