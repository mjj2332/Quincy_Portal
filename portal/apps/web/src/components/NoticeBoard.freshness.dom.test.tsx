import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { createQuincyQueryClient } from "../lib/query-client";
import { createNoticeBoardPost, noticeBoardDataKeys, useNoticeBoardPresentation, type NoticeBoardReadState } from "../lib/notice-board-data";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body) };
});

const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
const marker = (id: string, createdAt: string) => ({ throughPostId: id, throughCreatedAt: createdAt, updatedAt: createdAt });
const oldPost: NoticeBoardPost = { id: "post-old", authorId: "user-a", authorName: "A", body: "Old notice", content: doc("Old notice"), createdAt: "2026-08-31T00:00:00.000Z", editedAt: null };
const newPost: NoticeBoardPost = { id: "post-new", authorId: "user-b", authorName: "B", body: "New notice", content: doc("New notice"), createdAt: "2026-08-31T00:00:01.000Z", editedAt: null };
const state = (unreadCount: number, marker: NoticeBoardReadState["marker"] = null, latest = newPost): NoticeBoardReadState => ({ marker, latest: latest ? { postId: latest.id, createdAt: latest.createdAt } : null, unreadCount });

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  private readonly callback: IntersectionObserverCallback;
  private target: Element | null = null;
  constructor(callback: IntersectionObserverCallback) { this.callback = callback; TestIntersectionObserver.instances.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  emit(intersecting: boolean) {
    if (!this.target) return;
    const bounds = { width: 200, height: 40, top: 20, right: 220, bottom: 60, left: 20, x: 20, y: 20, toJSON: () => ({}) } as DOMRectReadOnly;
    const entry = { target: this.target, isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0, boundingClientRect: bounds, intersectionRect: intersecting ? bounds : { ...bounds, width: 0, height: 0 } } as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

let root: Root | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(<QueryClientProvider client={queryClient!}>{value}</QueryClientProvider>); for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
  await flush();
}

async function flush() {
  await act(async () => { for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); } });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  await flush();
}

async function typeIntoEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.focus(); editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function selectEditorText(editor: HTMLElement, start: number, end: number) {
  await act(async () => {
    editor.focus();
    const textNode = editor.querySelector("p")?.firstChild;
    if (!textNode) throw new Error("Editor has no text node to select.");
    const range = document.createRange();
    range.setStart(textNode, start); range.setEnd(textNode, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve();
  });
}

function selectionSnapshot(editor: HTMLElement) {
  const selection = window.getSelection()!;
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
    insideEditor: editor.contains(selection.anchorNode),
  };
}

function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host); return host;
}

function emit(intersecting: boolean) { TestIntersectionObserver.instances.at(-1)?.emit(intersecting); }

function PresentationProbe({ onSuccess }: { onSuccess: () => void }) {
  const presentation = useNoticeBoardPresentation({
    principalId: "user-a",
    open: true,
    posts: [oldPost],
    readState: undefined,
    onError: vi.fn(),
    onSuccess,
  });
  return <div ref={presentation.anchorRef} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  focusManager.setFocused(true);
  TestIntersectionObserver.instances = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 40, top: 20, right: 220, bottom: 60, left: 20, x: 20, y: 20, toJSON: () => ({}) } as DOMRect);
  queryClient = createQuincyQueryClient();
  apiGetMock.mockReset(); apiPostMock.mockReset(); apiDeleteMock.mockReset(); apiPatchMock.mockReset();
  apiDeleteMock.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null;
  document.body.replaceChildren();
  focusManager.setFocused(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Notice Board presentation freshness", () => {
  it("requires a fresh intersecting presentation fetch before advancing the marker", async () => {
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(1));
      listCalls += 1; return Promise.resolve({ posts: [newPost] });
    });
    apiPatchMock.mockResolvedValue(state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(apiPatchMock).not.toHaveBeenCalled();
    emit(true); await flush();
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/read-marker", { throughPostId: newPost.id });
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).toBeNull();
  });

  it("does not treat cached posts as presentation proof", async () => {
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    queryClient!.setQueryData(noticeBoardDataKeys.posts, [oldPost]);
    queryClient!.setQueryData(noticeBoardDataKeys.readState, state(1, null, oldPost));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-post"]')).not.toBeNull();
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("lets a visible posts poll prove the newly rendered head", async () => {
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, { throughPostId: oldPost.id, throughCreatedAt: oldPost.createdAt, updatedAt: oldPost.createdAt }, newPost));
      listCalls += 1;
      return Promise.resolve({ posts: listCalls <= 2 ? [oldPost] : [newPost, oldPost] });
    });
    apiPatchMock.mockResolvedValue(state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }, newPost));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    apiPatchMock.mockClear();
    await advance(30_000);
    expect(host.querySelector('[data-slot="notice-board-post"]')?.textContent).toContain("New notice");
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/read-marker", { throughPostId: newPost.id });
  });

  it("polls read state and updates a collapsed badge without patching", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve(state(1)); }
      return Promise.resolve({ posts: [] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
    const before = readStateCalls; await advance(30_000);
    expect(readStateCalls).toBeGreaterThan(before);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("commits the local delete regression and clears the stale badge", async () => {
    let listCalls = 0;
    let readStateCalls = 0;
    let deletionObserved = false;
    const beforeDelete = state(1, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }, newPost);
    const afterDelete = state(0, beforeDelete.marker, oldPost);
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) {
        readStateCalls += 1;
        return Promise.resolve(deletionObserved ? afterDelete : beforeDelete);
      }
      listCalls += 1;
      return Promise.resolve({ posts: listCalls === 1 ? [newPost, oldPost] : [oldPost] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-b" />);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
    deletionObserved = true;
    await click(host.querySelector('[data-slot="notice-board-delete"]')!);
    expect(apiDeleteMock).toHaveBeenCalledWith(`/api/notice-board/posts/${newPost.id}`);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)).toEqual(afterDelete);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).toBeNull();
    expect(host.querySelector('[data-slot="notice-board-post"]')?.textContent).toContain("Old notice");
  });

  it("commits another device's deletion on a later collapsed read-state poll", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    let readStateCalls = 0;
    let deletionObserved = false;
    const beforeDelete = state(1, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }, newPost);
    const afterDelete = state(0, beforeDelete.marker, oldPost);
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) {
        readStateCalls += 1;
        return Promise.resolve(deletionObserved ? afterDelete : beforeDelete);
      }
      return Promise.resolve({ posts: [] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
    deletionObserved = true;
    await advance(30_000);
    expect(readStateCalls).toBeGreaterThan(1);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)).toEqual(afterDelete);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); });
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).toBeNull();
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("accepts an idempotent qualifying PATCH through the surviving head", async () => {
    const afterDelete = state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }, oldPost);
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(afterDelete)
      : Promise.resolve({ posts: [oldPost] }));
    apiPatchMock.mockResolvedValue(afterDelete);
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/read-marker", { throughPostId: oldPost.id });
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)).toEqual(afterDelete);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).toBeNull();
  });

  it("keeps an edit draft visible when its saved post disappears remotely", async () => {
    let postDeletedElsewhere = false;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, null, oldPost));
      return Promise.resolve({ posts: postDeletedElsewhere ? [] : [oldPost] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Draft after remote delete");
    postDeletedElsewhere = true;
    await queryClient!.invalidateQueries({ queryKey: noticeBoardDataKeys.posts, exact: true, refetchType: "active" });
    await flush();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Your draft is still here");
    expect(host.querySelector<HTMLElement>('[contenteditable="true"]')?.textContent).toContain("Draft after remote delete");
  });

  it("preserves both composer state and selection through polling, focus, mutation, and failure", async () => {
    const remotelyEdited = { ...oldPost, body: "Remote edit", content: doc("Remote edit"), editedAt: "2026-08-31T00:01:00.000Z" };
    let remoteEdit = false;
    let failPresentation = false;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost));
      if (failPresentation) return Promise.reject(new Error("temporary list failure"));
      return Promise.resolve({ posts: [remoteEdit ? remotelyEdited : oldPost] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Keep this edit draft");
    const editorsAfterEdit = host.querySelectorAll<HTMLElement>('[contenteditable="true"]');
    const editEditor = editorsAfterEdit[0]!;
    const createEditor = editorsAfterEdit[editorsAfterEdit.length - 1]!;
    await typeIntoEditor(createEditor, "Keep this create draft");
    await selectEditorText(createEditor, 0, 4);
    const createEditorSelection = selectionSnapshot(createEditor);

    const assertEditComposerPreserved = () => {
      const currentEditEditor = host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"] [contenteditable="true"]');
      if (!currentEditEditor) throw new Error("Edit composer editor is missing.");
      expect(currentEditEditor).toBe(editEditor);
      expect(currentEditEditor.textContent).toContain("Keep this edit draft");
    };
    const assertCreateComposerPreserved = () => {
      const currentCreateEditor = host.querySelector<HTMLElement>('form[data-slot="notice-board-composer"] [contenteditable="true"]');
      if (!currentCreateEditor) throw new Error("Create composer editor is missing.");
      expect(currentCreateEditor).toBe(createEditor);
      expect(currentCreateEditor.textContent).toContain("Keep this create draft");
      expect(selectionSnapshot(currentCreateEditor)).toEqual(createEditorSelection);
    };
    const assertActiveDraftsPreserved = () => {
      assertEditComposerPreserved();
      assertCreateComposerPreserved();
    };

    remoteEdit = true;
    await advance(30_000);
    assertActiveDraftsPreserved();
    focusManager.setFocused(false); await flush();
    focusManager.setFocused(true); await flush();
    assertActiveDraftsPreserved();

    await click(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')!);
    expect(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')?.getAttribute("aria-expanded")).toBe("false");
    assertActiveDraftsPreserved();
    await click(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')!);
    expect(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    assertActiveDraftsPreserved();

    apiPatchMock.mockResolvedValue({ post: remotelyEdited, readState: state(0, marker(oldPost.id, oldPost.createdAt), remotelyEdited) });
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    assertCreateComposerPreserved();

    failPresentation = true;
    emit(false); await flush(); emit(true); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("temporary list failure");
    expect(host.querySelector<HTMLButtonElement>('[data-slot="notice-board-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    assertCreateComposerPreserved();
    failPresentation = false;
    emit(false); await flush(); emit(true); await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    assertCreateComposerPreserved();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Remote edit");
  });

  it("clears a presentation error after a failed marker PATCH recovers", async () => {
    let patchCalls = 0;
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(state(1, null, newPost))
      : Promise.resolve({ posts: [newPost] }));
    apiPatchMock.mockImplementation(() => {
      patchCalls += 1;
      return patchCalls === 1
        ? Promise.reject(new Error("marker temporarily unavailable"))
        : Promise.resolve(state(0, marker(newPost.id, newPost.createdAt), newPost));
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(patchCalls).toBe(1);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.unreadCount).toBe(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("marker temporarily unavailable");

    emit(false); await flush(); emit(true); await flush();
    expect(patchCalls).toBe(2);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.unreadCount).toBe(0);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a mutation error visible through a successful presentation cycle", async () => {
    const created = { ...newPost, authorId: "user-a", body: "Created", content: doc("Created") };
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost))
      : Promise.resolve({ posts: [oldPost] }));
    apiPostMock.mockRejectedValueOnce(new Error("publish failed"));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Created");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("publish failed");

    const listCallsBeforeRecovery = apiGetMock.mock.calls.filter(([path]) => path === "/api/notice-board/posts?limit=50").length;
    emit(false); await flush(); emit(true); await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => path === "/api/notice-board/posts?limit=50").length).toBeGreaterThan(listCallsBeforeRecovery);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("publish failed");

    apiPostMock.mockResolvedValueOnce({ post: created, readState: state(0, marker(created.id, created.createdAt), created) });
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves read state and retries after a read-target-changed 409", async () => {
    let patchCalls = 0;
    let targetChanged = false;
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(targetChanged ? state(1, null, oldPost) : state(1, null, newPost))
      : Promise.resolve({ posts: targetChanged ? [oldPost] : [newPost] }));
    apiPatchMock.mockImplementation((_path, body) => {
      patchCalls += 1;
      if (!targetChanged) {
        targetChanged = true;
        return Promise.reject(new ApiError("The notice changed.", 409, { code: "notice_board_read_target_changed" }));
      }
      expect(body).toEqual({ throughPostId: oldPost.id });
      return Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost));
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(patchCalls).toBeGreaterThanOrEqual(1);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.marker).toBeNull();
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.unreadCount).toBe(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    emit(false); await flush(); emit(true); await flush();
    expect(patchCalls).toBeGreaterThan(1);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.marker?.throughPostId).toBe(oldPost.id);
    expect(queryClient!.getQueryData<NoticeBoardReadState>(noticeBoardDataKeys.readState)?.unreadCount).toBe(0);
  });

  it("does not let an in-flight presentation fetch overwrite an edit settlement", async () => {
    let listCalls = 0;
    let resolveStale!: (value: { posts: NoticeBoardPost[] }) => void;
    const edited = { ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-08-31T00:01:00.000Z" };
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost));
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ posts: [oldPost] });
      if (listCalls === 2) return new Promise((resolve) => { resolveStale = resolve; });
      return Promise.resolve({ posts: [edited] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(listCalls).toBeGreaterThanOrEqual(2);
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Edited");
    apiPatchMock.mockResolvedValue({ post: edited, readState: state(0, marker(oldPost.id, oldPost.createdAt), edited) });
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Edited");
    resolveStale({ posts: [oldPost] }); await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Edited");
  });

  it("blocks edit button and keyboard submission while a create is in flight", async () => {
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    const created = { ...newPost, authorId: "user-a", body: "Created", content: doc("Created") };
    const edited = { ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-08-31T00:01:00.000Z" };
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost))
      : Promise.resolve({ posts: [oldPost] }));
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    apiPatchMock.mockResolvedValue({ post: edited, readState: state(0, marker(oldPost.id, oldPost.createdAt), edited) });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    const editEditor = host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"] [contenteditable="true"]')!;
    const createEditor = host.querySelector<HTMLElement>('form[data-slot="notice-board-composer"] [contenteditable="true"]')!;
    await typeIntoEditor(editEditor, "Edited");
    await typeIntoEditor(createEditor, "Created");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    const saveButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    expect(saveButton.disabled).toBe(true);
    await click(saveButton);
    await keydown(editEditor, "Enter", { metaKey: true });
    expect(apiPatchMock).not.toHaveBeenCalled();

    resolveCreate({ post: created, readState: state(0, marker(created.id, created.createdAt), created) });
    await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("blocks create button and keyboard submission while an edit is in flight", async () => {
    let resolveEdit!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    const edited = { ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-08-31T00:01:00.000Z" };
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost))
      : Promise.resolve({ posts: [oldPost] }));
    apiPostMock.mockResolvedValue({ post: { ...newPost, authorId: "user-a" }, readState: state(0, marker(newPost.id, newPost.createdAt), newPost) });
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve; }));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    const createEditor = host.querySelector<HTMLElement>('form[data-slot="notice-board-composer"] [contenteditable="true"]')!;
    await typeIntoEditor(createEditor, "Created");
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    const editEditor = host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"] [contenteditable="true"]')!;
    await typeIntoEditor(editEditor, "Edited");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    const postButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!;
    expect(postButton.disabled).toBe(true);
    await click(postButton);
    await keydown(createEditor, "Enter", { ctrlKey: true });
    expect(apiPostMock).not.toHaveBeenCalled();

    resolveEdit({ post: edited, readState: state(0, marker(oldPost.id, oldPost.createdAt), edited) });
    await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("discards a presentation fetch and success callback after unmount while waiting on a mutation", async () => {
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    let resolvePresentation!: (value: { posts: NoticeBoardPost[] }) => void;
    const created = { ...newPost, authorId: "user-a", body: "Created", content: doc("Created") };
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePresentation = resolve; }));
    const onSuccess = vi.fn();
    mount();
    await render(<PresentationProbe onSuccess={onSuccess} />);
    const createRequest = createNoticeBoardPost(queryClient!, created.content);
    await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    emit(true); await flush();
    resolvePresentation({ posts: [oldPost] });
    await flush();
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    resolveCreate({ post: created, readState: state(0, marker(created.id, created.createdAt), created) });
    await createRequest;
    await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)).toEqual([created]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not let an in-flight presentation fetch overwrite a create settlement", async () => {
    let listCalls = 0;
    let resolveStale!: (value: { posts: NoticeBoardPost[] }) => void;
    const created = { ...newPost, authorId: "user-a", body: "Created", content: doc("Created") };
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, null, oldPost));
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ posts: [oldPost] });
      if (listCalls === 2) return new Promise((resolve) => { resolveStale = resolve; });
      return Promise.resolve({ posts: [created, oldPost] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(listCalls).toBeGreaterThanOrEqual(2);
    apiPostMock.mockResolvedValue({ post: created, readState: state(0, marker(created.id, created.createdAt), created) });
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Created");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Created");
    resolveStale({ posts: [oldPost] }); await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Created");
  });

  it("lets a pending create own a direct presentation refresh that resolves first", async () => {
    let listCalls = 0;
    let resolvePresentation!: (value: { posts: NoticeBoardPost[] }) => void;
    let resolveCreate!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    const created = { ...newPost, authorId: "user-a", body: "Created", content: doc("Created") };
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost));
      listCalls += 1;
      return listCalls === 1
        ? Promise.resolve({ posts: [oldPost] })
        : new Promise((resolve) => { resolvePresentation = resolve; });
    });
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Created");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    emit(false); await flush();
    emit(true); await flush();
    expect(listCalls).toBe(2);
    resolvePresentation({ posts: [oldPost] });
    await flush();
    resolveCreate({ post: created, readState: state(0, marker(created.id, created.createdAt), created) });
    await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Created");
  });

  it("lets a pending edit own a direct presentation refresh that resolves first", async () => {
    let listCalls = 0;
    let resolvePresentation!: (value: { posts: NoticeBoardPost[] }) => void;
    let resolveEdit!: (value: { post: NoticeBoardPost; readState: NoticeBoardReadState }) => void;
    const edited = { ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-08-31T00:01:00.000Z" };
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(0, marker(oldPost.id, oldPost.createdAt), oldPost));
      listCalls += 1;
      return listCalls === 1
        ? Promise.resolve({ posts: [oldPost] })
        : new Promise((resolve) => { resolvePresentation = resolve; });
    });
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve; }));
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Edited");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    emit(false); await flush();
    emit(true); await flush();
    expect(listCalls).toBe(2);
    resolvePresentation({ posts: [oldPost] });
    await flush();
    resolveEdit({ post: edited, readState: state(0, marker(oldPost.id, oldPost.createdAt), edited) });
    await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.body).toBe("Edited");
  });

  it("does not patch while hidden, unfocused, or off viewport, and refreshes on return", async () => {
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(1));
      listCalls += 1; return Promise.resolve({ posts: [newPost] });
    });
    apiPatchMock.mockResolvedValue(state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange")); await flush();
    expect(listCalls).toBeGreaterThanOrEqual(2); expect(apiPatchMock).toHaveBeenCalledTimes(1);

    queryClient!.setQueryData(noticeBoardDataKeys.readState, state(1));
    apiPatchMock.mockClear(); focusManager.setFocused(false); await flush(); emit(true); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    focusManager.setFocused(true); await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    queryClient!.setQueryData(noticeBoardDataKeys.readState, state(1));
    apiPatchMock.mockClear(); emit(false); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    emit(true); await flush(); expect(apiPatchMock).toHaveBeenCalledTimes(1);
    void host;
  });

  it("learns new posts and another device's marker without a reload", async () => {
    let listCalls = 0; let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve(readStateCalls === 1 ? state(0, null, oldPost) : state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }, newPost)); }
      listCalls += 1; return Promise.resolve({ posts: listCalls === 1 ? [oldPost] : [newPost, oldPost] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await advance(30_000);
    await flush();
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.id).toBe(newPost.id);
    await click(host.querySelector('[data-slot="notice-board-toggle"]')!);
    await advance(30_000);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).toBeNull();
  });

  it("settles create and edit envelopes into both caches without a read-state follow-up", async () => {
    let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve(state(0, null, oldPost)); }
      return Promise.resolve({ posts: [oldPost] });
    });
    const created = { ...newPost, authorId: "user-a" };
    apiPostMock.mockResolvedValue({ post: created, readState: state(0, { throughPostId: created.id, throughCreatedAt: created.createdAt, updatedAt: created.createdAt }, created) });
    apiPatchMock.mockResolvedValue({ post: { ...oldPost, body: "Edited", content: doc("Edited") }, readState: state(0, null, oldPost) });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    const initialReadStateCalls = readStateCalls;
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Created notice");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(readStateCalls).toBe(initialReadStateCalls);
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.[0]?.id).toBe(created.id);
    await click(host.querySelector('[data-slot="notice-board-edit"]')!);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Edited");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(readStateCalls).toBe(initialReadStateCalls);
    expect(queryClient!.getQueryData<NoticeBoardPost[]>(noticeBoardDataKeys.posts)?.some((post) => post.body === "Edited")).toBe(true);
  });

  it("invalidates and refetches both exact keys after delete", async () => {
    let listCalls = 0; let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve(state(0, null, oldPost)); }
      listCalls += 1; return Promise.resolve({ posts: listCalls === 1 ? [oldPost] : [] });
    });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await click(host.querySelector('[data-slot="notice-board-delete"]')!);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(readStateCalls).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-slot="notice-board-post"]')).toBeNull();
  });

  it("lets only the current successful presentation generation advance", async () => {
    let listCalls = 0;
    let resolveOld!: (value: { posts: NoticeBoardPost[] }) => void;
    let resolveCurrent!: (value: { posts: NoticeBoardPost[] }) => void;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve(state(1));
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ posts: [oldPost] });
      if (listCalls === 2) return new Promise((resolve) => { resolveOld = resolve; });
      return new Promise((resolve) => { resolveCurrent = resolve; });
    });
    apiPatchMock.mockResolvedValue(state(0, { throughPostId: newPost.id, throughCreatedAt: newPost.createdAt, updatedAt: newPost.createdAt }));
    mount(); await render(<NoticeBoard currentUserId="user-a" />);
    emit(true); await flush();
    emit(false); await flush(); emit(true); await flush();
    expect(listCalls).toBeGreaterThanOrEqual(3);
    resolveOld({ posts: [oldPost] }); await flush();
    expect(apiPatchMock).not.toHaveBeenCalled();
    resolveCurrent({ posts: [newPost] }); await flush();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/read-marker", { throughPostId: newPost.id });
  });
});

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
  await flush();
}

async function keydown(editor: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers })); await Promise.resolve(); });
  await flush();
}
