import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "./api";

const order: string[] = [];
const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPatch: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDeleteWithBody: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), ...api }));
vi.mock("./project-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-data")>();
  return {
    ...actual,
    recordProjectArchivedRefusal: vi.fn(async (...args: Parameters<typeof actual.recordProjectArchivedRefusal>) => { order.push("record"); await actual.recordProjectArchivedRefusal(...args); order.push("recorded"); }),
    invalidateProjectSurfaces: vi.fn(async (client: QueryClient, input: Parameters<typeof actual.invalidateProjectSurfaces>[1]) => { order.push(`invalidate:${input.resources.map((r) => r.kind).join(",")}`); }),
  };
});
import { projectDataKeys } from "./project-data";
import { classifyVideoNoteError, createVideoNote, deleteVideoNote, editVideoNote, listVideoNotes, replyToVideoNote, setVideoNoteResolution } from "./video-notes-data";

const P = "11111111-1111-4111-8111-111111111111";
const A = "77777777-7777-4777-8777-777777777777";
const B = "66666666-6666-4666-8666-666666666666";
const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia", roleLabel: "Editor", isExternal: false, active: true };
let n = 0;
const thread = (over: Record<string, unknown> = {}): VideoNoteThreadDto => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, assetId: A, parentId: null, author: { kind: "staff", person }, authorRole: "editor", visibility: "internal",
  startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "hi", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:00.000Z", editedAt: null, copiedFrom: null, replies: [], ...over,
}) as VideoNoteThreadDto;

let client: QueryClient;
const ctx = (assetId = A, role: "editor" | "external_editor" = "editor") => ({ queryClient: client, projectId: P, assetId, role });
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); order.length = 0; Object.values(api).forEach((mock) => mock.mockReset()); });
afterEach(() => { client.clear(); });

describe("video notes data (#741 5b)", () => {
  it("lists through the staff schema, and through the External parser for an External editor", async () => {
    const t = thread();
    api.apiGet.mockResolvedValue({ notes: [t] });
    expect(await listVideoNotes(P, A, "editor")).toEqual([t]);
    expect(api.apiGet).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/notes`, undefined);
    expect(await listVideoNotes(P, A, "external_editor")).toEqual([t]);
    api.apiGet.mockResolvedValue({ notes: [{ ...t, internalOnly: true }] });
    await expect(listVideoNotes(P, A, "external_editor")).rejects.toThrow();
    await expect(listVideoNotes(P, A, "editor")).rejects.toThrow();
  });

  it("an External write response is parsed with the video-note-thread schema: an extra key throws", async () => {
    const t = thread();
    client.setQueryData(projectDataKeys.videoNotes(P, A), []);
    api.apiPost.mockResolvedValue({ ...t, leaked: 1 });
    await expect(createVideoNote(ctx(A, "external_editor"), { startFrame: 10, visibility: "internal", body: "x" })).rejects.toThrow();
    api.apiPost.mockResolvedValue(t);
    await expect(createVideoNote(ctx(A, "external_editor"), { startFrame: 10, visibility: "internal", body: "x" })).resolves.toEqual(t);
  });

  it("create posts the exact body and patches the cached list in order", async () => {
    const later = thread({ startFrame: 50 }); const first = thread({ startFrame: 5 });
    client.setQueryData(projectDataKeys.videoNotes(P, A), [later]);
    api.apiPost.mockResolvedValue(first);
    await createVideoNote(ctx(), { startFrame: 5, endFrame: 9, visibility: "public", body: "note" });
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A}/notes`, { startFrame: 5, endFrame: 9, visibility: "public", body: "note" });
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))!.map((t) => t.id)).toEqual([first.id, later.id]);
    expect(order).toContain("invalidate:video-notes");
  });

  it("a write that lands after a Version switch patches the Version it was made on", async () => {
    client.setQueryData(projectDataKeys.videoNotes(P, A), []); client.setQueryData(projectDataKeys.videoNotes(P, B), []);
    let finish!: (value: unknown) => void;
    api.apiPost.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = createVideoNote(ctx(A), { startFrame: 1, visibility: "internal", body: "x" });
    const t = thread({ assetId: A });
    finish(t);
    await pending;
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))).toHaveLength(1);
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, B))).toHaveLength(0);
  });

  it("does not turn a list that was never loaded into a one-note list", async () => {
    api.apiPost.mockResolvedValue(thread());
    await createVideoNote(ctx(), { startFrame: 1, visibility: "internal", body: "x" });
    expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toBeUndefined();
  });

  it("reply, edit, resolve send their documented bodies to their routes", async () => {
    const t = thread();
    client.setQueryData(projectDataKeys.videoNotes(P, A), [t]);
    api.apiPost.mockResolvedValue(t); api.apiPatch.mockResolvedValue(t); api.apiPut.mockResolvedValue(t);
    await replyToVideoNote(ctx(), t.id, "re");
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-notes/${t.id}/replies`, { body: "re" });
    await editVideoNote(ctx(), t.id, { expectedRevision: 3, body: "b", startFrame: 2, endFrame: null });
    expect(api.apiPatch).toHaveBeenCalledWith(`/api/projects/${P}/video-notes/${t.id}`, { expectedRevision: 3, body: "b", startFrame: 2, endFrame: null });
    await setVideoNoteResolution(ctx(), t.id, true);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/video-notes/${t.id}/resolution`, { resolved: true });
  });

  it("delete: a tombstone thread replaces the root, null removes it, and a reply's thread is found by its root", async () => {
    const root = thread(); const other = thread({ startFrame: 99 });
    client.setQueryData(projectDataKeys.videoNotes(P, A), [root, other]);
    api.apiDeleteWithBody.mockResolvedValue({ thread: { ...root, deleted: true, body: "", replies: [] } });
    await deleteVideoNote(ctx(), root, 1);
    expect(api.apiDeleteWithBody).toHaveBeenCalledWith(`/api/projects/${P}/video-notes/${root.id}`, { expectedRevision: 1 });
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))!.find((t) => t.id === root.id)!.deleted).toBe(true);
    api.apiDeleteWithBody.mockResolvedValue({ thread: null });
    await deleteVideoNote(ctx(), other, 1);
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))!.map((t) => t.id)).toEqual([root.id]);
  });

  it("an archived 409 records the refusal BEFORE it invalidates the Project detail", async () => {
    client.setQueryData(projectDataKeys.detail(P), { id: P, archivedAt: null });
    api.apiPost.mockRejectedValue(new ApiError("Archived", 409, { code: "project_archived" }));
    await expect(createVideoNote(ctx(), { startFrame: 1, visibility: "internal", body: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["record", "recorded", "invalidate:detail"]);
    expect((client.getQueryData(projectDataKeys.detail(P)) as { archivedAt: string | null }).archivedAt).toBeTruthy();
  });

  it("a note_conflict writes the server's thread into the cache and classifies as a conflict with it", async () => {
    const stale = thread({ body: "old", revision: 1 }); const fresh = { ...stale, body: "new", revision: 2 };
    client.setQueryData(projectDataKeys.videoNotes(P, A), [stale]);
    const error = new ApiError("changed", 409, { code: "note_conflict", thread: fresh });
    api.apiPatch.mockRejectedValue(error);
    await expect(editVideoNote(ctx(), stale.id, { expectedRevision: 1, body: "mine" })).rejects.toBe(error);
    expect(client.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))![0]!.revision).toBe(2);
    expect(classifyVideoNoteError(error)).toMatchObject({ kind: "conflict", thread: { revision: 2 } });
  });

  it("classifies the documented errors", () => {
    expect(classifyVideoNoteError(new ApiError("x", 409, { code: "project_archived" })).kind).toBe("archived");
    expect(classifyVideoNoteError(new ApiError("This note was deleted.", 409, { code: "note_deleted" })).kind).toBe("deleted");
    expect(classifyVideoNoteError(new ApiError("Note not found", 404, { error: "Note not found" })).kind).toBe("gone");
    expect(classifyVideoNoteError(new ApiError("Project not found", 404, { error: "Project not found" })).kind).toBe("access");
    expect(classifyVideoNoteError(new ApiError("bad", 422, { code: "frame_out_of_range", frameCount: 300 }))).toMatchObject({ kind: "range", frameCount: 300 });
    expect(classifyVideoNoteError(new ApiError("offline", 0)).kind).toBe("network");
    expect(classifyVideoNoteError(new ApiError("boom", 500)).kind).toBe("other");
    expect(classifyVideoNoteError(new Error("zod")).kind).toBe("other");
  });
  it("classifies a 403 that is not the authorship refusal as access, and the authorship refusal as an ordinary error", () => {
    expect(classifyVideoNoteError(new ApiError("Forbidden", 403)).kind).toBe("access");
    expect(classifyVideoNoteError(new ApiError("Forbidden: you are not assigned to this Project", 403)).kind).toBe("access");
    expect(classifyVideoNoteError(new ApiError("Forbidden: only the author can edit this note", 403)).kind).toBe("other");
  });
});

describe("video notes data: access errors are handled where the write is made (#741 5b form-state re-plan)", () => {
  const writes: Array<[string, (c: ReturnType<typeof ctx>) => Promise<unknown>, keyof typeof api]> = [
    ["create", (c) => createVideoNote(c, { startFrame: 1, visibility: "internal", body: "x" }), "apiPost"],
    ["reply", (c) => replyToVideoNote(c, "r", "x"), "apiPost"],
    ["edit", (c) => editVideoNote(c, "r", { expectedRevision: 1, body: "x" }), "apiPatch"],
    ["resolve", (c) => setVideoNoteResolution(c, "r", true), "apiPut"],
    ["delete", (c) => deleteVideoNote(c, { id: "r", parentId: null }, 1), "apiDeleteWithBody"],
  ];
  it.each(writes)("a 401 on %s ends the originating principal's data with no component mounted", async (_name, write, method) => {
    client.setQueryData(projectDataKeys.videoNotes(P, A), [thread()]);
    api[method].mockRejectedValue(new ApiError("Unauthorized", 401));
    await expect(write(ctx())).rejects.toBeInstanceOf(ApiError);
    await vi.waitFor(() => { expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toBeUndefined(); });
  });

  it.each(writes)("a non-note 404 or an access 403 on %s re-asks the gate and the Project", async (_name, write, method) => {
    api[method].mockRejectedValueOnce(new ApiError("Project not found", 404, { error: "Project not found" }));
    await expect(write(ctx())).rejects.toBeInstanceOf(ApiError);
    expect(order).toContain("invalidate:video-review,detail");
    order.length = 0;
    api[method].mockRejectedValueOnce(new ApiError("Forbidden", 403));
    await expect(write(ctx())).rejects.toBeInstanceOf(ApiError);
    expect(order).toContain("invalidate:video-review,detail");
  });

  it("a note gone or deleted elsewhere re-reads the Version's list before the caller sees the refusal", async () => {
    api.apiPatch.mockRejectedValueOnce(new ApiError("This note was deleted.", 409, { code: "note_deleted" }));
    await expect(editVideoNote(ctx(), "r", { expectedRevision: 1, body: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(order).toContain("invalidate:video-notes");
    order.length = 0;
    api.apiPatch.mockRejectedValueOnce(new ApiError("Note not found", 404, { error: "Note not found" }));
    await expect(editVideoNote(ctx(), "r", { expectedRevision: 1, body: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(order).toEqual(["invalidate:video-notes"]);
  });

  it("an authorship 403 stays an ordinary error: it neither ends the data nor re-asks the gate", async () => {
    client.setQueryData(projectDataKeys.videoNotes(P, A), [thread()]);
    api.apiPatch.mockRejectedValue(new ApiError("Forbidden: only the author can edit this note", 403));
    await expect(editVideoNote(ctx(), "r", { expectedRevision: 1, body: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(order).not.toContain("invalidate:video-review,detail");
    expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toBeDefined();
  });

  it("a retired principal's late 401 or late success touches nothing a fresh client owns, and cannot repopulate its own cache", async () => {
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fresh.setQueryData(projectDataKeys.videoNotes(P, A), [thread({ body: "fresh" })]);
    client.setQueryData(projectDataKeys.videoNotes(P, A), []);
    let finish!: (value: unknown) => void;
    api.apiPost.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const late = createVideoNote(ctx(), { startFrame: 1, visibility: "internal", body: "x" });
    api.apiPatch.mockRejectedValueOnce(new ApiError("Unauthorized", 401));
    await expect(editVideoNote(ctx(), "r", { expectedRevision: 1, body: "x" })).rejects.toBeInstanceOf(ApiError); // the old session ends
    await vi.waitFor(() => { expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toBeUndefined(); });
    client.setQueryData(projectDataKeys.videoNotes(P, A), []); // a screen still mounted on the retired client re-creates the entry
    finish(thread({ body: "late" }));
    await late;
    expect(client.getQueryData(projectDataKeys.videoNotes(P, A))).toEqual([]);
    expect(fresh.getQueryData<VideoNoteThreadDto[]>(projectDataKeys.videoNotes(P, A))!.map((t) => t.body)).toEqual(["fresh"]);
    fresh.clear();
  });
});
