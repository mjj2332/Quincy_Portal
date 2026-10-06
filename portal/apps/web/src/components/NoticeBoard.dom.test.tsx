import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";
import { createQuincyQueryClient } from "../lib/query-client";
import { ApiError } from "../lib/api";
import { cancelNoticeDelete, chooseNoticeAction, confirmNoticeDelete } from "../testing/notice-menu";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }] });
const oldPost: NoticeBoardPost = { id: "post-old", authorId: "user-a", authorName: "A", body: "Old notice", content: doc("Old notice"), createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };
const newPost: NoticeBoardPost = { id: "post-new", authorId: "user-b", authorName: "B", body: "New notice", content: doc("New notice"), createdAt: "2026-07-28T00:00:01.000Z", editedAt: null };
let root: Root | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => { root!.render(<QueryClientProvider client={queryClient!}>{value}</QueryClientProvider>); for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
  await flush();
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1); await Promise.resolve(); await Promise.resolve(); });
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
}

async function typeIntoEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.focus();
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function appendToEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.querySelector("p")!.append(document.createTextNode(text));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}
async function selectText(editor: HTMLElement, node: Node, start: number, end: number) {
  await act(async () => {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function selectOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function keydown(editor: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers }));
    await Promise.resolve(); await Promise.resolve();
  });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } });
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  focusManager.setFocused(true);
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  apiPatchMock.mockReset();
  queryClient = createQuincyQueryClient();
  apiPostMock.mockResolvedValue({ post: newPost, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
  apiDeleteMock.mockResolvedValue({ ok: true });
  apiPatchMock.mockResolvedValue({ post: { ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-07-28T00:01:00.000Z" }, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  queryClient?.clear(); queryClient = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("NoticeBoard disclosure and polling", () => {
  it("posts a task list and renders its posted indicator without a checkbox control", async () => {
    const content = { type: "doc" as const, content: [{ type: "taskList" as const, content: [{ type: "taskItem" as const, attrs: { checked: false }, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Notice task" }] }] }] }] };
    apiGetMock.mockResolvedValue({ posts: [] }); apiPostMock.mockResolvedValue({ post: { ...newPost, body: "Notice task", content }, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await typeIntoEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "Notice task");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Checklist"]')!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content });
    expect(host.querySelector('[data-slot="notice-board-post"] input')).toBeNull();
    apiPostMock.mockClear(); apiPatchMock.mockClear();
    await click(host.querySelector('[data-slot="notice-board-post"] [data-testid="rich-text-task-indicator"]')!);
    expect(apiPostMock).not.toHaveBeenCalled(); expect(apiPatchMock).not.toHaveBeenCalled();
    expect(host.querySelector('[data-slot="notice-board-post"] [data-testid="rich-text-task-status"]')?.textContent).toBe("Not completed");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Edit")).toBe(false);
  });

  it("posts and renders a Section heading through the shared composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "Notice section" }] }] };
    apiGetMock.mockResolvedValue({ posts: [] }); apiPostMock.mockResolvedValue({ post: { ...newPost, body: "Notice section", content }, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Notice section");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Heading"]')!);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === "Section")!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content });
    expect(host.querySelector('[data-slot="notice-board-post"] h2')?.textContent).toBe("Notice section");
  });

  it("posts newly underlined and struck-through notice content through the composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Marked notice", marks: [{ type: "strike" as const }, { type: "underline" as const }] }] }] };
    apiGetMock.mockResolvedValue({ posts: [] }); apiPostMock.mockResolvedValue({ post: { ...newPost, body: "Marked notice", content }, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Marked notice");
    await selectText(editor, editor.querySelector("p")!.firstChild!, 0, "Marked notice".length);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Underline"]')!);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Strikethrough"]')!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content });
    expect(host.querySelector("u")?.textContent).toBe("Marked notice"); expect(host.querySelector("s")?.textContent).toBe("Marked notice");
  });

  it("renders and preserves underline and strike through an author edit", async () => {
    const marked = { ...oldPost, content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [
      { type: "text" as const, text: "Under", marks: [{ type: "underline" as const }] },
      { type: "text" as const, text: " strike", marks: [{ type: "strike" as const }] },
    ] }] } };
    apiGetMock.mockResolvedValue({ posts: [marked] });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    await flush();
    expect(host.querySelector('[data-slot="notice-board-post"] u')?.textContent).toBe("Under"); expect(host.querySelector('[data-slot="notice-board-post"] s')?.textContent).toBe(" strike");
    await chooseNoticeAction(host, "A", "Edit", advance);
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/notice-board/posts/${marked.id}`, { content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] } });
  });

  it("always renders in full and keeps polling the list and read state without overlap", async () => {
    let listCalls = 0; let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve({ marker: null, latest: { postId: oldPost.id, createdAt: oldPost.createdAt }, unreadCount: 0 }); }
      listCalls += 1;
      return Promise.resolve({ posts: [oldPost] });
    });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('button[aria-expanded]:not([data-toolbar-item]):not([data-testid="notice-board-actions"])')).toBeNull();
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts?limit=50");
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    await advance(30_000);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(readStateCalls).toBeGreaterThanOrEqual(1);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
  });

  it("ignores a previously stored collapse key: the board renders its content and never writes it", async () => {
    const KEY = "quincy:dashboard:noticeboard:v2";
    const values = new Map<string, string>([[KEY, "false"]]);
    const setItemSpy = vi.fn((key: string, value: string) => { values.set(key, String(value)); });
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null, setItem: setItemSpy,
      removeItem: (key: string) => { values.delete(key); }, clear: () => { values.clear(); },
    } });
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const host = mount();
    await render(<StrictMode><NoticeBoard currentUserId="user-a" /></StrictMode>);
    expect(host.querySelector('[data-slot="notice-board-composer"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="notice-board-post"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('[data-slot="notice-board-panel"]')?.hidden).toBe(false);
    expect(setItemSpy.mock.calls.some(([key]) => key === KEY)).toBe(false);
  });

  it("ignores a value stored under the old, pre-rename collapse key and leaves it untouched", async () => {
    const OLD_KEY = "quincy:dashboard:noticeboard";
    const values = new Map<string, string>([[OLD_KEY, "false"]]);
    const getItemSpy = vi.fn((key: string) => values.get(key) ?? null);
    const setItemSpy = vi.fn((key: string, value: string) => { values.set(key, String(value)); });
    const removeItemSpy = vi.fn((key: string) => { values.delete(key); });
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: getItemSpy, setItem: setItemSpy, removeItem: removeItemSpy, clear: () => { values.clear(); },
    } });
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-composer"]')).not.toBeNull();
    expect(getItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(setItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(removeItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(values.get(OLD_KEY)).toBe("false");
    expect(values.has("quincy:dashboard:noticeboard:v2")).toBe(false);
  });

  it("shows unread activity from the authoritative read state", async () => {
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve({ marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 1 })
      : Promise.resolve({ posts: [] }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
  });

  it("does not write a seen cursor when an expanded list tick succeeds", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) return Promise.resolve({ marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 1 });
      listCalls += 1;
      return Promise.resolve({ posts: listCalls === 1 ? [oldPost] : [newPost, oldPost] });
    });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await advance(30_000);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-a")).toBe(oldPost.id);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
  });

  it("keeps a stale unread badge when the list fetch fails", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve({ marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 1 })
      : Promise.reject(new Error("offline")));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[data-slot="notice-board-unread-indicator"]')).not.toBeNull();
  });

  it("leaves legacy seen keys untouched and only offers author controls", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", newPost.id);
    apiGetMock.mockResolvedValue({ posts: [newPost, { ...oldPost, authorId: "user-a" }] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-b" />);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-b")).toBeNull();
    expect(host.querySelectorAll('[data-testid="notice-board-actions"]')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Actions for notice by A"]')).toBeNull();
    await chooseNoticeAction(host, "B", "Delete", advance);
    // Choosing Delete only asks: nothing is sent until the dialog is confirmed.
    expect(apiDeleteMock).not.toHaveBeenCalled();
    await confirmNoticeDelete(advance);
    expect(apiDeleteMock).toHaveBeenCalledTimes(1);
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
  });

  it("opens an author edit composer and cancels without sending a PATCH", async () => {
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    expect(host.textContent).toContain("Save");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("saves an edited notice's link preview cards as their ids alone, though the editor holds what the cards show (#497)", async () => {
    const card = { type: "linkPreview" as const, attrs: { previewId: "22222222-2222-4222-8222-222222222222", url: "https://example.test/a", title: "A page", description: "About it", siteName: "Example", imageMediaId: null } };
    const withCard: NoticeBoardPost = { ...oldPost, content: { ...doc("Old notice"), content: [...doc("Old notice").content, card] } };
    apiGetMock.mockImplementation(async (path: string) => path.includes("read-state") ? { marker: null, latest: null, unreadCount: 0 } : { posts: [withCard], hasMore: false, nextCursor: null });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    expect(host.querySelector('[data-testid="link-preview-card-editor"]')).not.toBeNull();
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    const sent = apiPatchMock.mock.calls.at(-1)![1] as { content: { content: Array<{ type: string; attrs?: unknown }> } };
    expect(sent.content.content.find((block) => block.type === "linkPreview")).toEqual({ type: "linkPreview", attrs: { previewId: card.attrs.previewId } });
  });

  it("cannot remove a card while a Save is pending: Remove is disabled, a click leaves the card, and the saved post still has it (#497)", async () => {
    const card = { type: "linkPreview" as const, attrs: { previewId: "22222222-2222-4222-8222-222222222222", url: "https://example.test/a", title: "A page", description: "About it", siteName: "Example", imageMediaId: null } };
    const withCard: NoticeBoardPost = { ...oldPost, content: { ...doc("Old notice"), content: [...doc("Old notice").content, card] } };
    apiGetMock.mockImplementation(async (path: string) => path.includes("read-state") ? { marker: null, latest: null, unreadCount: 0 } : { posts: [withCard], hasMore: false, nextCursor: null });
    let finish!: (value: unknown) => void;
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    const remove = host.querySelector<HTMLButtonElement>('[data-testid="link-preview-remove"]')!;
    expect(remove.disabled).toBe(true);
    await click(remove);
    expect(host.querySelectorAll('[data-testid="link-preview-card-editor"]')).toHaveLength(1);
    await act(async () => { finish({ post: { ...withCard, editedAt: "2026-07-28T00:01:00.000Z" }, readState: { marker: null, latest: null, unreadCount: 0 } }); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    expect(host.querySelectorAll('[data-testid="link-preview-card"]')).toHaveLength(1);
  });

  it("hides Edit/Delete on the post being edited, keeps them on other posts, and restores them on Cancel", async () => {
    apiGetMock.mockResolvedValue({ posts: [{ ...newPost, authorId: "user-a" }, oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    // located by author name (A = oldPost, B = newPost), which stays rendered while the body is being edited
    const postFor = (id: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="notice-board-post"]')]
      .find((article) => article.querySelector("header span")?.textContent === (id === oldPost.id ? oldPost.authorName : newPost.authorName))!;
    const buttonsIn = (article: HTMLElement) => [...article.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent);
    await chooseNoticeAction(host, "A", "Edit", advance);
    const editing = host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"]')!.closest<HTMLElement>('[data-slot="notice-board-post"]')!;
    expect(editing.querySelector('[data-testid="notice-board-actions"]')).toBeNull();
    expect(buttonsIn(editing)).toEqual(expect.arrayContaining(["Cancel", "Save"]));
    // the other authored post keeps its own trigger
    expect(postFor(newPost.id).querySelector('[data-testid="notice-board-actions"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="notice-board-actions"]')).toHaveLength(1);
    await click([...editing.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    const restored = postFor(oldPost.id);
    expect(restored.querySelector('[data-testid="notice-board-actions"]')).not.toBeNull();
    expect(buttonsIn(restored)).not.toContain("Save");
    expect(host.querySelectorAll('[data-testid="notice-board-actions"]')).toHaveLength(2);
    // Cancel hands focus back to the trigger that opened the edit.
    expect(document.activeElement).toBe(restored.querySelector('[data-testid="notice-board-actions"]'));
  });

  it("leaves focus in the editor after Edit from the menu, never on another notice's trigger (#523)", async () => {
    apiGetMock.mockResolvedValue({ posts: [{ ...newPost, authorId: "user-a" }, oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    await act(async () => { await advance(500); });
    const editing = host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"]')!.closest<HTMLElement>('[data-slot="notice-board-post"]')!;
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-testid="notice-board-actions"]')).toBeNull();
    expect(editing.querySelector('[contenteditable="true"]')?.contains(active)).toBe(true);
  });

  describe("delete confirmation (#523)", () => {
    const ownNewPost: NoticeBoardPost = { ...newPost, authorId: "user-a", authorName: "B" };
    // The composer also asks `/embedded-media/settings` (#495); it is not a list fetch.
    const isSettings = (path: string) => path.includes("embedded-media/settings");
    const listing = (posts: NoticeBoardPost[]) => (path: string) => Promise.resolve(isSettings(path) ? { heic: false } : path.includes("read-") ? { marker: null, latest: null, unreadCount: 0 } : { posts, hasMore: false, nextCursor: null });
    const dialog = () => document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm"]');
    const triggerOf = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[aria-label="Actions for notice by ${name}"]`);

    it("opens the dialog on Delete without calling the API, naming the notice, with focus on Cancel", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      expect(apiDeleteMock).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(dialog()!.textContent).toContain("Delete notice?");
      const confirmAction = document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm-action"]')!;
      expect(confirmAction.textContent).toBe("Delete");
      const labelledBy = dialog()!.getAttribute("aria-labelledby");
      expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe("Delete notice?");
      expect(confirmAction.hasAttribute("aria-label")).toBe(false);
      expect(dialog()!.textContent).toContain("“Old notice”");
      expect(document.activeElement).toBe(document.querySelector('[data-testid="notice-delete-cancel"]'));
    });

    it("uses AA-contrast secondary text for the description, not the muted default", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      const description = document.getElementById(dialog()!.getAttribute("aria-describedby")!)!;
      expect(description.className).toContain("text-foreground-secondary");
    });

    it("lets the \u22ef trigger overhang the header instead of stretching the row", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      const cls = triggerOf(host, "A")!.className;
      expect(cls).toContain("-my-[calc((28px_-_1.2*var(--text-xs))/2)]");
      expect(cls).toContain("max-[721px]:-my-[calc((44px_-_1.2*var(--text-xs))/2)]");
      // The phone overhang leaves under 2px of padding, so the focus ring is drawn inside the box (design review r2).
      expect(cls).toContain("max-[721px]:focus-visible:!-outline-offset-2");
    });

    it("Cancel and Escape send no DELETE and return focus to that notice's trigger", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      await cancelNoticeDelete(advance);
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(triggerOf(host, "A"));
      await chooseNoticeAction(host, "A", "Delete", advance);
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); await Promise.resolve(); });
      await advance(300);
      expect(dialog()).toBeNull();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(triggerOf(host, "A"));
    });

    it("confirming deletes exactly once and moves focus to the next surviving trigger, never body", async () => {
      let posts = [ownNewPost, oldPost];
      apiGetMock.mockImplementation((path) => listing(posts)(path));
      apiDeleteMock.mockImplementation(async () => { posts = [oldPost]; return { ok: true }; });
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "B", "Delete", advance);
      await confirmNoticeDelete(advance);
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
      expect(host.textContent).not.toContain("New notice");
      expect(dialog()).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(triggerOf(host, "A"));
    });

    it("falls back to the composer when no other notice of yours survives, never body", async () => {
      let posts = [oldPost];
      apiGetMock.mockImplementation((path) => listing(posts)(path));
      apiDeleteMock.mockImplementation(async () => { posts = []; return { ok: true }; });
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      await confirmNoticeDelete(advance);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement!.closest('[data-slot="notice-board-composer"]')).not.toBeNull();
      expect(document.activeElement!.getAttribute("contenteditable")).toBe("true");
    });

    it("holds the dialog while deleting: Deleting…, both buttons disabled, Escape ignored, composer locked", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      let finish!: (value: unknown) => void;
      apiDeleteMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      await act(async () => { document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm-action"]')!.click(); await Promise.resolve(); });
      const action = document.querySelector<HTMLButtonElement>('[data-testid="notice-delete-confirm-action"]')!;
      expect(action.textContent).toBe("Deleting…");
      expect(action.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[data-testid="notice-delete-cancel"]')!.disabled).toBe(true);
      expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!.disabled).toBe(true);
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })); await Promise.resolve(); });
      await advance(300);
      expect(dialog()).not.toBeNull();
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      await act(async () => { finish({ ok: true }); await Promise.resolve(); await Promise.resolve(); });
      await advance(300);
    });

    it("keeps the dialog open on a failed delete, shows the message beside the action, and allows Cancel", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      apiDeleteMock.mockRejectedValue(new ApiError("Forbidden: only the author can delete this post.", 403));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      await confirmNoticeDelete(advance);
      const error = document.querySelector('[data-testid="notice-delete-error"]')!;
      expect(dialog()).not.toBeNull();
      expect(error.getAttribute("role")).toBe("alert");
      expect(error.textContent).toBe("Forbidden: only the author can delete this post.");
      expect(document.activeElement).toBe(error);
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog()!.contains(document.activeElement)).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[data-testid="notice-delete-confirm-action"]')!.disabled).toBe(false);
      expect(host.querySelector('[data-slot="notice-board-panel"] > [role="alert"]')).toBeNull();
      await cancelNoticeDelete(advance);
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(triggerOf(host, "A"));
    });

    it("treats a 404 as already gone: closes, refetches, shows no error", async () => {
      let listCalls = 0;
      apiGetMock.mockImplementation((path) => { if (!path.includes("read-") && !isSettings(path)) listCalls += 1; return listing(listCalls > 1 ? [] : [oldPost])(path); });
      apiDeleteMock.mockRejectedValue(new ApiError("Not found", 404));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      const before = listCalls;
      await chooseNoticeAction(host, "A", "Delete", advance);
      await confirmNoticeDelete(advance);
      expect(dialog()).toBeNull();
      expect(listCalls).toBeGreaterThan(before);
      expect(document.querySelector('[data-testid="notice-delete-error"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector('[data-slot="notice-board-post"]')).toBeNull();
    });

    it("opens the menu from the keyboard on Edit, so a stray Enter starts an edit and never deletes", async () => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      const trigger = triggerOf(host, "A")!;
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })); await Promise.resolve(); await Promise.resolve(); });
      await advance(50);
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
      expect(document.activeElement).toBe(items[0]);
      await act(async () => { items[0]!.click(); await Promise.resolve(); await Promise.resolve(); });
      await advance(200);
      expect(apiDeleteMock).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();
      expect(document.activeElement!.closest('[data-slot="notice-board-edit-composer"]')).not.toBeNull();
      expect(document.activeElement!.getAttribute("contenteditable")).toBe("true");
    });

    it("deletes only the captured id on a double-click or repeated Enter on the confirm action", async () => {
      apiGetMock.mockImplementation(listing([ownNewPost, oldPost]));
      let finish!: (value: unknown) => void;
      apiDeleteMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "B", "Delete", advance);
      const action = document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm-action"]')!;
      // Two activations inside one task, before React re-renders the disabled state.
      await act(async () => { action.click(); action.click(); await Promise.resolve(); });
      // Repeated Enter: the browser turns each keydown on a focused button into a click.
      await act(async () => {
        for (let press = 0; press < 3; press += 1) { action.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })); action.click(); }
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
      await act(async () => { finish({ ok: true }); await Promise.resolve(); await Promise.resolve(); });
      await advance(10_000);
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(dialog()).toBeNull();
    });

    it.each([["Enter", "Enter"], ["Space", " "]])("%s on the Delete menu item opens the dialog and never deletes", async (_name, key) => {
      apiGetMock.mockImplementation(listing([oldPost]));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      const trigger = triggerOf(host, "A")!;
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })); await Promise.resolve(); await Promise.resolve(); });
      await advance(50);
      const deleteItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete")!;
      await act(async () => { deleteItem.focus(); await Promise.resolve(); });
      await act(async () => {
        deleteItem.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
        deleteItem.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key }));
        await Promise.resolve(); await Promise.resolve();
      });
      await advance(300);
      expect(apiDeleteMock).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-testid="notice-delete-cancel"]'));
    });

    it("confirm after a refetch reorders the list sends only the captured id", async () => {
      let posts = [ownNewPost, oldPost];
      apiGetMock.mockImplementation((path) => listing(posts)(path));
      apiDeleteMock.mockImplementation(async () => { posts = posts.filter((post) => post.id !== "post-new"); return { ok: true }; });
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "B", "Delete", advance);
      // Another session reorders the list while the dialog is open: A is now first, B second.
      posts = [{ ...oldPost, authorId: "user-a" }, ownNewPost];
      await act(async () => { await queryClient!.refetchQueries({ queryKey: ["notice-board", "posts"] }); });
      await advance(50);
      expect(dialog()).not.toBeNull();
      expect(dialog()!.textContent).toContain("“New notice”");
      await confirmNoticeDelete(advance);
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
      expect(host.textContent).toContain("Old notice");
      expect(host.textContent).not.toContain("New notice");
    });

    it("confirm after a refetch removed the target sends only the captured id and treats 404 as done", async () => {
      let posts = [ownNewPost, oldPost];
      apiGetMock.mockImplementation((path) => listing(posts)(path));
      apiDeleteMock.mockRejectedValue(new ApiError("Not found", 404));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "B", "Delete", advance);
      posts = [{ ...oldPost, authorId: "user-a" }]; // deleted elsewhere while the dialog is open
      await act(async () => { await queryClient!.refetchQueries({ queryKey: ["notice-board", "posts"] }); });
      await advance(50);
      expect(dialog()).not.toBeNull();
      await confirmNoticeDelete(advance);
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
      expect(dialog()).toBeNull();
      expect(document.querySelector('[data-testid="notice-delete-error"]')).toBeNull();
      expect(document.activeElement).toBe(triggerOf(host, "A"));
    });

    it("deleting the last notice moves focus to the previous surviving trigger", async () => {
      let posts = [ownNewPost, oldPost];
      apiGetMock.mockImplementation((path) => listing(posts)(path));
      apiDeleteMock.mockImplementation(async () => { posts = [ownNewPost]; return { ok: true }; });
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Delete", advance);
      await confirmNoticeDelete(advance);
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(triggerOf(host, "B"));
    });

    it("a successful delete never focuses the deleted notice when the following posts refetch fails", async () => {
      let posts = [ownNewPost, oldPost];
      let listDown = false;
      apiGetMock.mockImplementation((path) => (listDown && !path.includes("read-") ? Promise.reject(new ApiError("Unavailable", 503)) : listing(posts)(path)));
      apiDeleteMock.mockImplementation(async () => { listDown = true; return { ok: true }; });
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "B", "Delete", advance);
      await act(async () => { document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm-action"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
      await advance(10_000);
      await advance(300);
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      expect(dialog()).toBeNull();
      // the cached list no longer holds the deleted notice, and focus is on the survivor
      expect(host.textContent).not.toContain("New notice");
      expect(triggerOf(host, "B")).toBeNull();
      expect(document.activeElement).toBe(triggerOf(host, "A"));
    });

    it("blocks create and edit while a delete is pending", async () => {
      apiGetMock.mockImplementation(listing([ownNewPost, oldPost]));
      let finish!: (value: unknown) => void;
      apiDeleteMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await typeIntoEditor(host.querySelector<HTMLElement>('[data-slot="notice-board-composer"] [contenteditable="true"]')!, "Blocked draft");
      await chooseNoticeAction(host, "B", "Delete", advance);
      await act(async () => { document.querySelector<HTMLElement>('[data-testid="notice-delete-confirm-action"]')!.click(); await Promise.resolve(); });
      // create: a submit that bypasses the disabled button is refused by the shared lock
      await act(async () => { host.querySelector<HTMLFormElement>('[data-slot="notice-board-composer"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(apiPostMock).not.toHaveBeenCalled();
      // edit: the other notice's menu items are disabled and Edit starts nothing
      const trigger = triggerOf(host, "A")!;
      await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
      const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Edit");
      if (edit) { expect(edit.getAttribute("aria-disabled")).toBe("true"); await act(async () => { edit.click(); await Promise.resolve(); }); }
      expect(host.querySelector('[data-slot="notice-board-edit-composer"]')).toBeNull();
      expect(apiPatchMock).not.toHaveBeenCalled();
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
      await act(async () => { finish({ ok: true }); await Promise.resolve(); await Promise.resolve(); });
      await advance(10_000);
    });

    it("blocks Delete while a save or a post is pending", async () => {
      apiGetMock.mockImplementation(listing([ownNewPost, oldPost]));
      let finishPatch!: (value: unknown) => void;
      apiPatchMock.mockImplementation(() => new Promise((resolve) => { finishPatch = resolve; }));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await chooseNoticeAction(host, "A", "Edit", advance);
      await typeIntoEditor(host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"] [contenteditable="true"]')!, "Saving");
      await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      const trigger = triggerOf(host, "B")!;
      await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
      const del = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete");
      if (del) { expect(del.getAttribute("aria-disabled")).toBe("true"); await act(async () => { del.click(); await Promise.resolve(); }); }
      await advance(300);
      expect(dialog()).toBeNull();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      await act(async () => { finishPatch({ post: { ...oldPost, body: "Saving", content: doc("Saving"), editedAt: "2026-07-28T00:01:00.000Z" }, readState: { marker: null, latest: null, unreadCount: 0 } }); await Promise.resolve(); await Promise.resolve(); });
      await advance(300);
      expect(queryClient!.isFetching({ queryKey: ["notice-board", "posts"] })).toBe(0);
    });

    it("blocks Delete while a new post is pending", async () => {
      apiGetMock.mockImplementation(listing([ownNewPost]));
      let finishPost!: (value: unknown) => void;
      apiPostMock.mockImplementation(() => new Promise((resolve) => { finishPost = resolve; }));
      const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
      await typeIntoEditor(host.querySelector<HTMLElement>('[data-slot="notice-board-composer"] [contenteditable="true"]')!, "Pending post");
      await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
      expect(apiPostMock).toHaveBeenCalledTimes(1);
      const trigger = triggerOf(host, "B")!;
      await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
      const del = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete");
      if (del) { expect(del.getAttribute("aria-disabled")).toBe("true"); await act(async () => { del.click(); await Promise.resolve(); }); }
      await advance(300);
      expect(dialog()).toBeNull();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      await act(async () => { finishPost({ post: { ...newPost, id: "post-created", authorId: "user-a" }, readState: { marker: null, latest: null, unreadCount: 0 } }); await Promise.resolve(); await Promise.resolve(); });
      await advance(300);
    });
  });

  it.each([
    ["from the upper notice to the lower", "B", "A"],
    ["from the lower notice to the upper", "A", "B"],
  ])("switching edits %s leaves focus in the new editor, and Cancel then restores only its own trigger", async (_name, first, second) => {
    apiGetMock.mockResolvedValue({ posts: [{ ...newPost, authorId: "user-a" }, oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, first, "Edit", advance);
    await chooseNoticeAction(host, second, "Edit", advance);
    await advance(300);
    const editorOf = (name: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="notice-board-post"]')]
      .find((article) => article.querySelector("header span")?.textContent === name)!.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"] [contenteditable="true"]');
    expect(document.activeElement).toBe(editorOf(second));
    expect(document.activeElement!.getAttribute("contenteditable")).toBe("true");
    // the first notice's trigger is back, but never took focus
    const firstTrigger = host.querySelector<HTMLElement>(`[aria-label="Actions for notice by ${first}"]`)!;
    expect(firstTrigger).not.toBeNull();
    expect(document.activeElement).not.toBe(firstTrigger);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="notice-board-edit-composer"] button')].find((button) => button.textContent === "Cancel")!;
    await click(cancel);
    expect(document.activeElement).toBe(host.querySelector(`[aria-label="Actions for notice by ${second}"]`));
  });

  it("renders rich lists and safe external links", async () => {
    const formatted: NoticeBoardPost = {
      ...oldPost,
      content: {
        type: "doc",
        content: [
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet" }, { type: "hardBreak" }, { type: "text", text: "continued" }] }] }] },
          { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] }] },
          { type: "paragraph", content: [{ type: "text", text: "Studio", marks: [{ type: "link", href: "https://example.test/guide" }] }] },
        ],
      },
    };
    apiGetMock.mockResolvedValue({ posts: [formatted] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-b" />);
    expect(host.querySelector('[data-slot="notice-board-post"] ul')?.textContent).toContain("Bullet");
    expect(host.querySelector('[data-slot="notice-board-post"] ul br')).not.toBeNull();
    expect(host.querySelector('[data-slot="notice-board-post"] ol')?.textContent).toContain("First");
    const link = host.querySelector<HTMLAnchorElement>('[data-slot="notice-board-post"] a[href="https://example.test/guide"]')!;
    expect(link).not.toBeNull();
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("posts the typed rich-text document payload", async () => {
    apiGetMock.mockResolvedValue({ posts: [] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "A typed notice");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content: doc("A typed notice") });
  });

  it("saves an author edit with the edited rich-text PATCH payload", async () => {
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Saved edit");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/posts/post-old", { content: doc("Saved edit") });
  });

  it("retains a stored flat-href link when an author edits unrelated notice text", async () => {
    const href = "https://example.test/notice-link";
    const content = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [
      { type: "text" as const, text: "Linked", marks: [{ type: "link" as const, href }] },
      { type: "text" as const, text: " notice" },
    ] }] };
    apiGetMock.mockResolvedValue({ posts: [{ ...oldPost, content }] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await chooseNoticeAction(host, "A", "Edit", advance);
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notice-board/posts/post-old", { content: {
      type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "Linked", marks: [{ type: "link", href }] },
        { type: "text", text: " notice!" },
      ] }],
    } });
  });

  it("selects a mention with the keyboard and includes it in the submitted document", async () => {
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve({ posts: [] }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "hi @Nor");
    await flush();
    const listbox = host.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    expect(editor.getAttribute("role")).toBe("combobox");
    expect(editor.getAttribute("aria-controls")).toBe(listbox.id);
    expect(editor.getAttribute("aria-activedescendant")).toBe(listbox.querySelector('[role="option"]')?.id);
    await keydown(editor, "ArrowDown");
    await keydown(editor, "Enter");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", {
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "hi " },
            { type: "mention", attrs: { id: "user-mention", label: "Nora Mention" } },
            { type: "text", text: " " },
          ],
        }],
      },
    });
  });

  it("accepts a bare @ mention with Enter without adding a paragraph", async () => {
    apiGetMock.mockImplementation((path) => path.includes("mentionable-users")
      ? Promise.resolve({ users: [{ id: "user-mention", name: "Nora Mention", role: "editor" }] })
      : Promise.resolve({ posts: [] }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "@");
    await flush();
    await keydown(editor, "Enter");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", {
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "user-mention", label: "Nora Mention" } },
            { type: "text", text: " " },
          ],
        }],
      },
    });
  });

  it("submits with Cmd or Ctrl+Enter without adding a paragraph", async () => {
    apiGetMock.mockResolvedValue({ posts: [] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Submit this");
    await keydown(editor, "Enter", { metaKey: true });
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content: doc("Submit this") });
    expect(editor.querySelectorAll("p")).toHaveLength(1);
    apiPostMock.mockClear();
    await typeIntoEditor(editor, "Submit with Ctrl");
    await keydown(editor, "Enter", { ctrlKey: true });
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content: doc("Submit with Ctrl") });
    expect(editor.querySelectorAll("p")).toHaveLength(1);
  });

  it("keeps the draft and shows an error when publishing fails", async () => {
    apiGetMock.mockResolvedValue({ posts: [] });
    apiPostMock.mockRejectedValue(new Error("Publishing is unavailable."));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Draft survives");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Publishing is unavailable.");
    expect(editor.textContent).toContain("Draft survives");
  });
});
