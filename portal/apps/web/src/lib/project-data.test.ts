import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import {
  applyProjectMembershipOverlay, beginAssetOptimisticMutation, beginProjectMembershipMutation, classifyProjectAccessError, emptyReview, invalidateProjectResources,
  projectAssetsQueryOptions, projectCollaborationDataGeneration, projectCollaborationSummaryQueryOptions, projectDataKeys, projectDetailQueryOptions, projectQueryRetry,
  clearPrincipalProjectData, purgeProjectCollaborationData, removeProjectData, type ProjectDetail, type ProjectMember,
} from "./project-data";
import { ProjectQueryRuntime } from "./project-query-sync";
import { createQuincyQueryClient } from "./query-client";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { projectCommentsInfiniteQueryOptions } from "./project-comments";

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
    expect(projectDataKeys.commentsRoot("a")).toEqual(["project-data", "a", "comments"]);
    expect(projectDataKeys.commentsRoot("b")).not.toEqual(projectDataKeys.commentsRoot("a"));
    expect(projectDataKeys.comments("a")).toEqual(["project-data", "a", "comments", "pages", { limit: 50 }]);
    expect(projectDataKeys.commentReadMarker("b")).toEqual(["project-data", "b", "comments", "read-marker"]);
    expect(projectDataKeys.comments("a").slice(0, 2)).toEqual(projectDataKeys.project("a"));
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
    expect(classifyProjectAccessError(new ApiError("forbidden", 403), "comments")).toEqual({ scope: "collaboration" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403), "comment-read-marker")).toEqual({ scope: "collaboration" });
    expect(classifyProjectAccessError(new ApiError("missing", 404), "comments")).toEqual({ scope: "project" });
    expect(classifyProjectAccessError(new ApiError("unauthenticated", 401), "comments")).toEqual({ scope: "principal" });
    expect(classifyProjectAccessError(new ApiError("unauthenticated", 401), "comment-read-marker")).toEqual({ scope: "principal" });
    expect(classifyProjectAccessError(new ApiError("missing", 404), "comment-read-marker")).toEqual({ scope: "project" });
    expect(classifyProjectAccessError(new ApiError("forbidden", 403), "collaboration-summary")).toEqual({ scope: "collaboration" });
    expect(classifyProjectAccessError(new ApiError("missing", 404), "collaboration-summary")).toEqual({ scope: "project" });
  });

  it("reads the safe collaboration summary and rejects a response after its generation tombstone", async () => {
    const queryClient = client();
    const options = projectCollaborationSummaryQueryOptions("a/b");
    const summary = { project: { id: "a/b", street: "Marker Lane", stageKey: "raw_review" as const }, members: [] };
    apiGetMock.mockResolvedValueOnce(summary);
    await options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    expect(apiGetMock).toHaveBeenCalledWith("/api/projects/a%2Fb/collaboration-summary", expect.anything());
    let resolve!: (value: typeof summary) => void;
    apiGetMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const request = options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    await purgeProjectCollaborationData(queryClient, "a/b");
    resolve(summary);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(projectCollaborationDataGeneration(queryClient, "a/b")).toBe(1);
    expect(queryClient.getQueryData(projectDataKeys.collaborationSummary("a/b"))).toBeUndefined();
    queryClient.clear();
  });

  it("rejects malformed collaboration summaries instead of fabricating a successful fallback", async () => {
    const queryClient = client();
    const options = projectCollaborationSummaryQueryOptions("p");
    apiGetMock.mockResolvedValueOnce({ project: { id: "p", street: "Missing members", stageKey: "raw_review" }, members: "not-an-array" });
    await expect(options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined })).rejects.toThrow("Invalid collaboration summary response");
    queryClient.clear();
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

describe("project membership mutation ledger", () => {
  const member = (id: string, userId: string, roleOnProject: ProjectMember["roleOnProject"]): ProjectMember => ({ id, userId, roleOnProject, name: userId, email: `${userId}@example.test`, globalRole: roleOnProject, active: true, assignedSubtaskCount: 0 });

  function summaryMemberKeys(queryClient: QueryClient, projectId = "p") {
    const summary = queryClient.getQueryData<{ members: Array<Record<string, unknown>> }>(projectDataKeys.collaborationSummary(projectId));
    return summary?.members.map((item) => Object.keys(item).sort());
  }

  async function seedSummaryAndDetail(queryClient: QueryClient, projectId = "p") {
    const existing = member("cycle-existing", "existing", "editor");
    queryClient.setQueryData(projectDataKeys.detail(projectId), { ...detail(projectId), members: [existing] });
    queryClient.setQueryData(projectDataKeys.collaborationSummary(projectId), { project: { id: projectId, street: projectId, stageKey: "raw_review" as const }, members: [] });
    return existing;
  }

  it("keeps collaboration-summary membership caches to their exact five-field contract at every ledger settlement", async () => {
    const scenarios: Array<{ name: string; start: (queryClient: QueryClient) => Promise<{ mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>>; membership: ProjectMember }>; settle: (mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>>, membership: ProjectMember) => Promise<void> }> = [
      { name: "optimistic add", start: async (queryClient) => { const membership = member("cycle-optimistic", "new-user", "photographer"); return { mutation: await beginProjectMembershipMutation(queryClient, "p", "photographer", "new-user", "add", membership), membership }; }, settle: async () => undefined },
      { name: "successful commit", start: async (queryClient) => { const membership = member("cycle-commit", "new-user", "photographer"); return { mutation: await beginProjectMembershipMutation(queryClient, "p", "photographer", "new-user", "add", membership), membership }; }, settle: async (mutation, membership) => mutation.commit(membership) },
      { name: "rollback", start: async (queryClient) => { const existing = await seedSummaryAndDetail(queryClient); return { mutation: await beginProjectMembershipMutation(queryClient, "p", "editor", "existing", "remove", null), membership: existing }; }, settle: async (mutation) => mutation.fail() },
      { name: "conflict replacement", start: async (queryClient) => { const membership = member("cycle-conflict", "new-user", "photographer"); return { mutation: await beginProjectMembershipMutation(queryClient, "p", "photographer", "new-user", "add", membership), membership }; }, settle: async (mutation, membership) => mutation.conflict(membership) },
    ];
    for (const scenario of scenarios) {
      const queryClient = client(); new ProjectQueryRuntime(queryClient);
      if (scenario.name !== "rollback") await seedSummaryAndDetail(queryClient);
      const { mutation, membership } = await scenario.start(queryClient);
      await scenario.settle(mutation, membership);
      const keys = summaryMemberKeys(queryClient);
      expect(keys, scenario.name).toEqual([["active", "id", "name", "roleOnProject", "userId"]]);
      expect(keys?.flat()).not.toContain("email");
      expect(keys?.flat()).not.toContain("globalRole");
      queryClient.clear();
    }
  });

  it("keeps different optimistic cells independent when one canonical refetch lands first", async () => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient);
    const project: ProjectDetail = { ...detail("p"), members: [member("cycle-a", "a", "photographer")] };
    queryClient.setQueryData(projectDataKeys.detail("p"), project);
    const optimisticA = member("optimistic-a", "a", "photographer");
    const optimisticB = member("optimistic-b", "b", "editor");
    const [first, second] = await Promise.all([
      beginProjectMembershipMutation(queryClient, "p", "photographer", "a", "add", optimisticA),
      beginProjectMembershipMutation(queryClient, "p", "editor", "b", "add", optimisticB),
    ]);
    expect(queryClient.getQueryData<ProjectDetail>(projectDataKeys.detail("p"))?.members.map((item) => item.userId).sort()).toEqual(["a", "b"]);
    await first!.commit(member("cycle-a", "a", "photographer"));
    const landed: ProjectDetail = { ...project, members: [member("cycle-a", "a", "photographer")] };
    const overlay = applyProjectMembershipOverlay(landed, [
      { id: 2, cell: "editor:b", roleOnProject: "editor", userId: "b", intent: "add", base: null, optimistic: optimisticB, status: "pending", committed: undefined, cleared: 0 },
    ]);
    expect(overlay.members.map((item) => item.userId).sort()).toEqual(["a", "b"]);
    await second!.fail();
    expect(queryClient.getQueryData<ProjectDetail>(projectDataKeys.detail("p"))?.members.map((item) => item.userId).sort()).toEqual(["a"]);
    queryClient.clear();
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

  it.each([401, 403, 404] as const)("blocks a late collaboration-summary response after a %s access loss", async (status) => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient);
    const key = projectDataKeys.collaborationSummary("p");
    const summary = { project: { id: "p", street: "Private Lane", stageKey: "raw_review" as const }, members: [] };
    queryClient.setQueryData(key, summary);
    let resolve!: (value: typeof summary) => void;
    apiGetMock.mockReturnValueOnce(new Promise<typeof summary>((done) => { resolve = done; }));
    const options = projectCollaborationSummaryQueryOptions("p");
    const request = options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    await Promise.resolve();
    if (status === 401) await clearPrincipalProjectData(queryClient);
    else await purgeProjectCollaborationData(queryClient, "p");
    resolve(summary);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(queryClient.getQueryData(key)).toBeUndefined();
    queryClient.clear();
  });

  it.each([401, 403, 404] as const)("blocks a late comments response after a %s access loss", async (status) => {
    const queryClient = client(); new ProjectQueryRuntime(queryClient);
    const key = projectDataKeys.comments("p");
    const page = { project: { id: "p", street: "Private Lane" }, comments: [] };
    queryClient.setQueryData(key, { pages: [page], pageParams: [null] });
    let resolve!: (value: typeof page) => void;
    apiGetMock.mockReturnValueOnce(new Promise<typeof page>((done) => { resolve = done; }));
    const options = projectCommentsInfiniteQueryOptions("p");
    const request = options.queryFn({ pageParam: null, direction: "forward", signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    await Promise.resolve();
    if (status === 401) await clearPrincipalProjectData(queryClient);
    else await purgeProjectCollaborationData(queryClient, "p");
    resolve(page);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(queryClient.getQueryData(key)).toBeUndefined();
    queryClient.clear();
  });
});
