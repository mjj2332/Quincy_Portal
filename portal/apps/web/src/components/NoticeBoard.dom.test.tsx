import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";
import { createQuincyQueryClient } from "../lib/query-client";

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
    expect(host.querySelector(".notice-board__post input")).toBeNull();
    apiPostMock.mockClear(); apiPatchMock.mockClear();
    await click(host.querySelector(".notice-board__post .rich-text__task-indicator")!);
    expect(apiPostMock).not.toHaveBeenCalled(); expect(apiPatchMock).not.toHaveBeenCalled();
    expect(host.querySelector(".notice-board__post .rich-text__task-content .sr-only")?.textContent).toBe("Not completed");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Edit")).toBe(false);
  });

  it("posts and renders a Section heading through the shared composer", async () => {
    const content = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "Notice section" }] }] };
    apiGetMock.mockResolvedValue({ posts: [] }); apiPostMock.mockResolvedValue({ post: { ...newPost, body: "Notice section", content }, readState: { marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 0 } });
    const host = mount(); await render(<NoticeBoard currentUserId="user-a" />);
    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await typeIntoEditor(editor, "Notice section");
    await selectOption(host.querySelector<HTMLSelectElement>('[aria-label="Heading"]')!, "2");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Post notice")!);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notice-board/posts", { content });
    expect(host.querySelector(".notice-board__post h2")?.textContent).toBe("Notice section");
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
    expect(host.querySelector(".notice-board__post u")?.textContent).toBe("Under"); expect(host.querySelector(".notice-board__post s")?.textContent).toBe(" strike");
    await click(host.querySelector<HTMLButtonElement>(".notice-board__edit")!);
    await appendToEditor(host.querySelector<HTMLElement>('[contenteditable="true"]')!, "!");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/notice-board/posts/${marked.id}`, { content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Under", marks: [{ type: "underline" }] },
      { type: "text", text: " strike!", marks: [{ type: "strike" }] },
    ] }] } });
  });

  it("starts expanded, persists the toggle, and switches polling modes without overlap", async () => {
    let listCalls = 0; let readStateCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("read-marker")) { readStateCalls += 1; return Promise.resolve({ marker: null, latest: { postId: oldPost.id, createdAt: oldPost.createdAt }, unreadCount: 0 }); }
      listCalls += 1;
      return Promise.resolve({ posts: [oldPost] });
    });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const toggle = host.querySelector<HTMLButtonElement>(".notice-board__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts?limit=50");
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    await advance(30_000);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(readStateCalls).toBeGreaterThanOrEqual(1);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    const listCallsBeforeCollapse = listCalls; const readStateCallsBeforeCollapse = readStateCalls;
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:v2")).toBe("false");
    await advance(60_000);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    expect(listCalls).toBe(listCallsBeforeCollapse);
    expect(readStateCalls).toBeGreaterThan(readStateCallsBeforeCollapse);

    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    const remounted = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(remounted.querySelector<HTMLButtonElement>(".notice-board__toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not write the collapse key on mount when no preference is stored, even under StrictMode", async () => {
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const values = new Map<string, string>();
    const setItemSpy = vi.fn((key: string, value: string) => { values.set(key, String(value)); });
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: setItemSpy,
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    } });
    const host = mount();
    await render(<StrictMode><NoticeBoard currentUserId="user-a" /></StrictMode>);
    const toggle = host.querySelector<HTMLButtonElement>(".notice-board__toggle")!;
    expect(toggle).not.toBeNull();
    expect(setItemSpy.mock.calls.some(([key]) => key === "quincy:dashboard:noticeboard:v2")).toBe(false);

    await click(toggle);
    const collapseWrites = setItemSpy.mock.calls.filter(([key]) => key === "quincy:dashboard:noticeboard:v2");
    expect(collapseWrites).toHaveLength(1);
    expect(collapseWrites[0]![1]).toBe("false");
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
    expect(host.querySelector<HTMLButtonElement>(".notice-board__toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(getItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(setItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(removeItemSpy.mock.calls.some(([key]) => key === OLD_KEY)).toBe(false);
    expect(values.get(OLD_KEY)).toBe("false");
    expect(values.has("quincy:dashboard:noticeboard:v2")).toBe(false);
  });

  it("shows unread activity from the authoritative collapsed read state", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve({ marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 1 })
      : Promise.resolve({ posts: [] }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("does not write a seen cursor when an expanded list tick succeeds", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "true");
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
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("keeps a stale unread badge when the fresh expand fetch fails", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    apiGetMock.mockImplementation((path) => path.includes("read-marker")
      ? Promise.resolve({ marker: null, latest: { postId: newPost.id, createdAt: newPost.createdAt }, unreadCount: 1 })
      : Promise.reject(new Error("offline")));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
    await click(host.querySelector(".notice-board__toggle")!);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("leaves legacy seen keys untouched and only offers author controls", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", newPost.id);
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "true");
    apiGetMock.mockResolvedValue({ posts: [newPost, { ...oldPost, authorId: "user-a" }] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-b" />);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-b")).toBeNull();
    expect(host.querySelectorAll(".notice-board__delete")).toHaveLength(1);
    expect(host.querySelectorAll(".notice-board__edit")).toHaveLength(1);
    await click(host.querySelector(".notice-board__delete")!);
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
  });

  it("opens an author edit composer and cancels without sending a PATCH", async () => {
    apiGetMock.mockResolvedValue({ posts: [oldPost] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await click(host.querySelector(".notice-board__edit")!);
    expect(host.textContent).toContain("Save");
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!);
    expect(apiPatchMock).not.toHaveBeenCalled();
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
    expect(host.querySelector(".notice-board__post ul")?.textContent).toContain("Bullet");
    expect(host.querySelector(".notice-board__post ul br")).not.toBeNull();
    expect(host.querySelector(".notice-board__post ol")?.textContent).toContain("First");
    const link = host.querySelector<HTMLAnchorElement>('.notice-board__post a[href="https://example.test/guide"]')!;
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
    await click(host.querySelector(".notice-board__edit")!);
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
    await click(host.querySelector(".notice-board__edit")!);
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
