import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import {
  advanceProjectCommentReadMarker,
  prependProjectComment,
  projectCommentReadStateQueryOptions,
  projectCommentsInfiniteQueryOptions,
  refreshProjectCommentsHead,
  removeProjectComment,
  replaceProjectComment,
  type Comment,
  type ProjectCommentReadState,
  type ProjectCommentReadAttemptRegistrar,
} from "./project-comments";
import { projectDataKeys } from "./project-data";
import { ProjectQueryRuntime } from "./project-query-sync";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPatchMock = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiGet: apiGetMock, apiPatch: apiPatchMock }));

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
function comment(id: string, createdAt = "2026-08-25T00:00:00.000Z"): Comment { return { id, author: { id: "u1", name: "User One" }, body: id, content: doc(id), createdAt, editedAt: null }; }
function page(ids: string[], nextCursor?: string) { return { project: { id: projectId, street: "Marker Lane" }, comments: ids.map((id, index) => comment(id, `2026-08-25T00:0${index}:00.000Z`)), ...(nextCursor ? { nextCursor } : {}) }; }
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); }
function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { apiGetMock.mockReset(); apiPatchMock.mockReset(); });

describe("project comment Query adapter", () => {
  it("uses exact project keys, URL encoding, cursor page params, and the transport signal", async () => {
    const queryClient = client(); const signal = new AbortController().signal;
    const started: string[] = []; const settled: string[] = [];
    const registrar: ProjectCommentReadAttemptRegistrar = { start: () => { started.push("first"); return { fetchAttemptId: "attempt-1", startedGeneration: null }; }, settle: (_attempt, head) => { settled.push(head ?? "empty"); } };
    const options = projectCommentsInfiniteQueryOptions("a/b", registrar);
    apiGetMock.mockResolvedValueOnce(page(["newest"])).mockResolvedValueOnce(page(["older"]));
    await options.queryFn({ pageParam: null, signal, client: queryClient, queryKey: options.queryKey, meta: undefined } as never);
    await options.queryFn({ pageParam: "cursor/a", signal, client: queryClient, queryKey: options.queryKey, meta: undefined } as never);
    expect(options.queryKey).toEqual(["project-data", "a/b", "comments", "pages", { limit: 50 }]);
    expect(projectDataKeys.comments(projectId)).toEqual(["project-data", projectId, "comments", "pages", { limit: 50 }]);
    expect(apiGetMock.mock.calls).toEqual([
      ["/api/projects/a%2Fb/comments?limit=50", { signal }],
      ["/api/projects/a%2Fb/comments?limit=50&before=cursor%2Fa", { signal }],
    ]);
    expect(started).toEqual(["first"]); expect(settled).toEqual(["newest"]);
    queryClient.clear();
  });

  it("keeps fetch attempt and generation proof in the registrar only, never in cached pages", async () => {
    const queryClient = client();
    const registrar: ProjectCommentReadAttemptRegistrar = { start: () => ({ fetchAttemptId: "proof-only", startedGeneration: "generation-only" }), settle: () => undefined };
    apiGetMock.mockResolvedValue(page(["newest", "second"], "older"));
    await queryClient.fetchInfiniteQuery({ ...projectCommentsInfiniteQueryOptions(projectId, registrar), staleTime: Infinity });
    const cached = queryClient.getQueryData(projectDataKeys.comments(projectId));
    expect(cached).toBeDefined();
    expect(JSON.stringify(cached)).not.toMatch(/fetchAttemptId|startedGeneration|registrar/);
    expect(cached).toEqual({ pages: [page(["newest", "second"], "older")], pageParams: [null] });
    queryClient.clear();
  });

  it("refreshes one head page, retaining unchanged older references and resetting on a boundary change", async () => {
    const queryClient = client();
    const registrar: ProjectCommentReadAttemptRegistrar = { start: () => ({ fetchAttemptId: crypto.randomUUID(), startedGeneration: null }), settle: () => undefined };
    const older = page(["older-1"], "older-2");
    queryClient.setQueryData(projectDataKeys.comments(projectId), { pages: [page(["newest"], "cursor-1"), older], pageParams: [null, "cursor-1"] });
    const before = queryClient.getQueryData<{ pages: unknown[] }>(projectDataKeys.comments(projectId))!;
    apiGetMock.mockResolvedValueOnce(page(["newest"], "cursor-1"));
    await refreshProjectCommentsHead(queryClient, projectId, registrar, new AbortController().signal);
    const unchanged = queryClient.getQueryData<{ pages: unknown[] }>(projectDataKeys.comments(projectId))!;
    expect(unchanged.pages[1]).toBe(before.pages[1]); expect(unchanged.pages).toHaveLength(2);
    apiGetMock.mockResolvedValueOnce(page(["newer"], "cursor-new"));
    await refreshProjectCommentsHead(queryClient, projectId, registrar, new AbortController().signal);
    const reset = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(projectDataKeys.comments(projectId))!;
    expect(reset.pages).toEqual([page(["newer"], "cursor-new")]); expect(reset.pageParams).toEqual([null]);
    queryClient.clear();
  });

  it("uses the read-marker key and exact encoded GET/PATCH resource", async () => {
    const queryClient = client(); const signal = new AbortController().signal;
    const options = projectCommentReadStateQueryOptions("a/b");
    apiGetMock.mockResolvedValue({ projectId: "a/b", marker: null, latest: null, unreadCount: 0 });
    await options.queryFn({ signal, client: queryClient, queryKey: options.queryKey, meta: undefined });
    expect(apiGetMock).toHaveBeenCalledWith("/api/projects/a%2Fb/comment-read-marker", { signal });
    apiGetMock.mockClear();
    apiPatchMock.mockResolvedValue({ projectId: "a/b", marker: null, latest: null, unreadCount: 0 });
    await advanceProjectCommentReadMarker("a/b", "target/id");
    expect(options.queryKey).toEqual(["project-data", "a/b", "comments", "read-marker"]);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/a%2Fb/comment-read-marker", { throughCommentId: "target/id" });
    expect(apiGetMock).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("does not let a stale read-state GET overwrite a newer PATCH response", async () => {
    const queryClient = client();
    const staleGet = deferredPromise<ProjectCommentReadState>();
    const stale = { projectId, marker: null, latest: { commentId: "old-head", createdAt: "2026-08-25T00:00:00.000Z" }, unreadCount: 3 };
    const newer = { projectId, marker: { throughCommentId: "new-head", throughCreatedAt: "2026-08-25T00:01:00.000Z", updatedAt: "2026-08-25T00:01:01.000Z" }, latest: { commentId: "new-head", createdAt: "2026-08-25T00:01:00.000Z" }, unreadCount: 0 };
    apiGetMock.mockReturnValueOnce(staleGet.promise);
    const readRequest = queryClient.fetchQuery({ ...projectCommentReadStateQueryOptions(projectId), staleTime: 0 });
    await Promise.resolve();

    apiPatchMock.mockResolvedValueOnce(newer);
    const patchResponse = await advanceProjectCommentReadMarker(projectId, "new-head");
    queryClient.setQueryData(projectDataKeys.commentReadMarker(projectId), patchResponse);
    staleGet.resolve(stale);
    await readRequest;

    expect(queryClient.getQueryData(projectDataKeys.commentReadMarker(projectId))).toEqual(newer);
    queryClient.clear();
  });

  it("rejects preflight and post-network tombstoned comment responses", async () => {
    const queryClient = client(); const runtime = new ProjectQueryRuntime(queryClient);
    runtime.markProjectRemoved(projectId);
    const options = projectCommentsInfiniteQueryOptions(projectId);
    await expect(options.queryFn({ pageParam: null, signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined } as never)).rejects.toMatchObject({ status: 404, details: { code: "project-data-removed" } });
    expect(apiGetMock).not.toHaveBeenCalled();
    runtime.dispose(); queryClient.clear();

    const second = client(); const secondRuntime = new ProjectQueryRuntime(second); let resolve!: (value: unknown) => void;
    apiGetMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const request = projectCommentsInfiniteQueryOptions(projectId).queryFn({ pageParam: null, signal: new AbortController().signal, client: second, queryKey: projectDataKeys.comments(projectId), meta: undefined } as never);
    secondRuntime.markProjectRemoved(projectId); resolve(page(["late"]));
    await expect(request).rejects.toBeInstanceOf(ApiError);
    secondRuntime.dispose(); second.clear();
  });

  it("dedupes cache helpers without dropping loaded pages", () => {
    const queryClient = client(); const first = page(["a", "b"]); const second = page(["c"]);
    queryClient.setQueryData(projectDataKeys.comments(projectId), { pages: [first, second], pageParams: [null, "older"] });
    prependProjectComment(queryClient, projectId, comment("new"));
    expect(queryClient.getQueryData<{ pages: Array<{ comments: Comment[] }> }>(projectDataKeys.comments(projectId))?.pages.flatMap((item) => item.comments).map((item) => item.id)).toEqual(["new", "a", "b", "c"]);
    replaceProjectComment(queryClient, projectId, comment("c", "2026-08-25T01:00:00.000Z"));
    expect(queryClient.getQueryData<{ pages: Array<{ comments: Comment[] }> }>(projectDataKeys.comments(projectId))?.pages[1]?.comments[0]?.createdAt).toBe("2026-08-25T01:00:00.000Z");
    removeProjectComment(queryClient, projectId, "a");
    expect(queryClient.getQueryData<{ pages: Array<{ comments: Comment[] }> }>(projectDataKeys.comments(projectId))?.pages.flatMap((item) => item.comments).map((item) => item.id)).toEqual(["new", "b", "c"]);
    queryClient.clear();
  });
});
