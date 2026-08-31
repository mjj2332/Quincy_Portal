import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNoticeBoardPost,
  editNoticeBoardPost,
  noticeBoardDataKeys,
  noticeBoardPostsQueryOptions,
  noticeBoardReadStateQueryOptions,
  type NoticeBoardPost,
  type NoticeBoardReadState,
} from "./notice-board-data";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string, options?: unknown) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    apiGet: (path: string, options?: unknown) => apiGetMock(path, options),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
  };
});

const marker = (id: string, createdAt: string) => ({ throughPostId: id, throughCreatedAt: createdAt, updatedAt: createdAt });
const latest = (postId: string, createdAt: string) => ({ postId, createdAt });
const state = (currentMarker: NoticeBoardReadState["marker"], currentLatest: NoticeBoardReadState["latest"], unreadCount: number): NoticeBoardReadState => ({ marker: currentMarker, latest: currentLatest, unreadCount });
const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });

const oldPost: NoticeBoardPost = { id: "post-old", authorId: "user-a", authorName: "A", body: "Old notice", content: doc("Old notice"), createdAt: "2026-08-31T00:00:00.000Z", editedAt: null };
const createdPost: NoticeBoardPost = { id: "post-created", authorId: "user-a", authorName: "A", body: "Created notice", content: doc("Created notice"), createdAt: "2026-08-31T00:00:02.000Z", editedAt: null };

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function runReadStateQuery(queryClient: QueryClient) {
  const options = noticeBoardReadStateQueryOptions();
  return options.queryFn({ signal: new AbortController().signal, client: queryClient, queryKey: options.queryKey, meta: undefined } as never);
}

function runPostsQuery(queryClient: QueryClient, signal = new AbortController().signal) {
  const options = noticeBoardPostsQueryOptions();
  return options.queryFn({ signal, client: queryClient, queryKey: options.queryKey, meta: undefined } as never);
}

describe("Notice Board read-state ordering", () => {
  let queryClient: QueryClient | undefined;

  afterEach(() => {
    queryClient = undefined;
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
  });

  it("rejects an older marker regardless of request sequence", async () => {
    queryClient = new QueryClient();
    const current = state(marker("post-new", "2026-08-31T00:00:01.000Z"), latest("post-new", "2026-08-31T00:00:01.000Z"), 0);
    const older = state(marker("post-old", "2026-08-31T00:00:00.000Z"), latest("post-old", "2026-08-31T00:00:00.000Z"), 1);
    queryClient.setQueryData(noticeBoardDataKeys.readState, current);
    apiGetMock.mockResolvedValue(older);
    await runReadStateQuery(queryClient);
    expect(queryClient.getQueryData(noticeBoardDataKeys.readState)).toBe(current);
  });

  it("sequence-gates an unmarked-head deletion when the stale response has a newer latest tuple", async () => {
    queryClient = new QueryClient();
    const retainedMarker = marker("post-read", "2026-08-31T00:00:00.000Z");
    const preDelete = state(retainedMarker, latest("post-c", "2026-08-31T00:00:02.000Z"), 2);
    const afterDelete = state(retainedMarker, latest("post-b", "2026-08-31T00:00:01.000Z"), 1);
    let resolveOld!: (value: NoticeBoardReadState) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = runReadStateQuery(queryClient);
    apiGetMock.mockResolvedValueOnce(afterDelete);
    await runReadStateQuery(queryClient);
    resolveOld(preDelete);
    await oldRequest;
    expect(queryClient.getQueryData(noticeBoardDataKeys.readState)).toEqual(afterDelete);
  });

  it("sequence-gates the marked-head deletion resurrection shape", async () => {
    queryClient = new QueryClient();
    const retainedMarker = marker("post-marked", "2026-08-31T00:00:02.000Z");
    const preDelete = state(retainedMarker, latest("post-marked", "2026-08-31T00:00:02.000Z"), 1);
    const afterDelete = state(retainedMarker, latest("post-previous", "2026-08-31T00:00:01.000Z"), 0);
    let resolveOld!: (value: NoticeBoardReadState) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = runReadStateQuery(queryClient);
    apiGetMock.mockResolvedValueOnce(afterDelete);
    await runReadStateQuery(queryClient);
    resolveOld(preDelete);
    await oldRequest;
    expect(queryClient.getQueryData(noticeBoardDataKeys.readState)).toEqual(afterDelete);
  });

  it("sequence-gates a stale head across two rapid deletions after marked-head deletion", async () => {
    queryClient = new QueryClient();
    const retainedMarker = marker("post-marked", "2026-08-31T00:00:04.000Z");
    const preDelete = state(retainedMarker, latest("post-p", "2026-08-31T00:00:03.000Z"), 3);
    const afterFirstDelete = state(retainedMarker, latest("post-o", "2026-08-31T00:00:02.000Z"), 2);
    const afterSecondDelete = state(retainedMarker, latest("post-n", "2026-08-31T00:00:01.000Z"), 1);
    let resolveOld!: (value: NoticeBoardReadState) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = runReadStateQuery(queryClient);
    apiGetMock.mockResolvedValueOnce(afterFirstDelete).mockResolvedValueOnce(afterSecondDelete);
    await runReadStateQuery(queryClient);
    await runReadStateQuery(queryClient);
    resolveOld(preDelete);
    await oldRequest;
    expect(queryClient.getQueryData(noticeBoardDataKeys.readState)).toEqual(afterSecondDelete);
  });

  it("keeps a newer marker when an older GET settles later", async () => {
    queryClient = new QueryClient();
    const older = state(marker("post-old", "2026-08-31T00:00:00.000Z"), latest("post-old", "2026-08-31T00:00:00.000Z"), 1);
    const newer = state(marker("post-new", "2026-08-31T00:00:01.000Z"), latest("post-new", "2026-08-31T00:00:01.000Z"), 0);
    let resolveOld!: (value: NoticeBoardReadState) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = runReadStateQuery(queryClient);
    apiGetMock.mockResolvedValueOnce(newer);
    await runReadStateQuery(queryClient);
    resolveOld(older);
    await oldRequest;
    expect(queryClient.getQueryData(noticeBoardDataKeys.readState)).toEqual(newer);
  });
});

describe("Notice Board posts ordering", () => {
  let queryClient: QueryClient | undefined;

  afterEach(() => {
    queryClient = undefined;
    apiGetMock.mockReset();
    apiPostMock.mockReset();
  });

  it("fences a stale regular query fetch behind a create settlement", async () => {
    queryClient = new QueryClient();
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const poll = runPostsQuery(queryClient);
    apiPostMock.mockResolvedValue({
      post: createdPost,
      readState: state(marker(createdPost.id, createdPost.createdAt), latest(createdPost.id, createdPost.createdAt), 0),
    });
    await createNoticeBoardPost(queryClient, createdPost.content);
    resolvePoll({ posts: [oldPost] });
    await poll;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([createdPost]);
  });

  it("lets a pending create own a regular query fetch that resolves before the mutation", async () => {
    queryClient = new QueryClient();
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    const create = { post: createdPost, readState: state(marker(createdPost.id, createdPost.createdAt), latest(createdPost.id, createdPost.createdAt), 0) };
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const createRequest = createNoticeBoardPost(queryClient, createdPost.content);
    await flushMicrotasks();
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    let pollSettled = false;
    const poll = runPostsQuery(queryClient).then(() => { pollSettled = true; });
    resolvePoll({ posts: [oldPost] });
    await Promise.resolve(); await Promise.resolve();
    expect(pollSettled).toBe(false);

    resolveCreate(create);
    await createRequest;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([createdPost]);
    await poll;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([createdPost]);
  });

  it("retains a successful create fence for a competing fetch that resolves afterward", async () => {
    queryClient = new QueryClient();
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    const create = { post: createdPost, readState: state(marker(createdPost.id, createdPost.createdAt), latest(createdPost.id, createdPost.createdAt), 0) };
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const createRequest = createNoticeBoardPost(queryClient, createdPost.content);
    await flushMicrotasks();
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const poll = runPostsQuery(queryClient);
    resolveCreate(create);
    await createRequest;
    resolvePoll({ posts: [oldPost] });
    await poll;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([createdPost]);
  });

  it("lets a pending edit own a regular query fetch that resolves before the mutation", async () => {
    queryClient = new QueryClient();
    queryClient.setQueryData(noticeBoardDataKeys.posts, [oldPost]);
    const editedPost = { ...oldPost, body: "Edited notice", content: doc("Edited notice"), editedAt: "2026-08-31T00:01:00.000Z" };
    let resolveEdit!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    const edit = { post: editedPost, readState: state(null, null, 0) };
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve; }));
    const editRequest = editNoticeBoardPost(queryClient, oldPost.id, editedPost.content);
    await flushMicrotasks();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    let pollSettled = false;
    const poll = runPostsQuery(queryClient).then(() => { pollSettled = true; });
    resolvePoll({ posts: [oldPost] });
    await Promise.resolve(); await Promise.resolve();
    expect(pollSettled).toBe(false);

    resolveEdit(edit);
    await editRequest;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]).toEqual(editedPost);
    await poll;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]).toEqual(editedPost);
  });

  it("releases a competing fetch to the normal sequence gate after a failed create", async () => {
    queryClient = new QueryClient();
    let rejectCreate!: (reason: Error) => void;
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    apiPostMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const createRequest = createNoticeBoardPost(queryClient, createdPost.content);
    await flushMicrotasks();
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const poll = runPostsQuery(queryClient);
    resolvePoll({ posts: [oldPost] });
    await Promise.resolve();
    rejectCreate(new Error("create failed"));
    await expect(createRequest).rejects.toThrow("create failed");
    await poll;
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([oldPost]);
  });

  it("discards an aborted fetch after it waits on a create settlement", async () => {
    queryClient = new QueryClient();
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    let resolvePoll!: (value: { posts: NoticeBoardPost[] }) => void;
    const create = { post: createdPost, readState: state(marker(createdPost.id, createdPost.createdAt), latest(createdPost.id, createdPost.createdAt), 0) };
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const createRequest = createNoticeBoardPost(queryClient, createdPost.content);
    await flushMicrotasks();

    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const controller = new AbortController();
    const poll = runPostsQuery(queryClient, controller.signal);
    resolvePoll({ posts: [oldPost] });
    await flushMicrotasks();
    controller.abort();
    resolveCreate(create);
    await createRequest;

    await expect(poll).rejects.toMatchObject({ name: "AbortError" });
    expect(queryClient.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([createdPost]);
  });
});
