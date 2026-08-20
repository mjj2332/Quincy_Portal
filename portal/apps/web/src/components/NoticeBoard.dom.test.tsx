import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";

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
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockResolvedValue(newPost);
  apiDeleteMock.mockResolvedValue({ ok: true });
  apiPatchMock.mockResolvedValue({ ...oldPost, body: "Edited", content: doc("Edited"), editedAt: "2026-07-28T00:01:00.000Z" });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("NoticeBoard disclosure and polling", () => {
  it("starts expanded, persists the toggle, and switches polling modes without overlap", async () => {
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("latest")) return Promise.resolve({ id: newPost.id, createdAt: newPost.createdAt });
      listCalls += 1;
      return Promise.resolve({ posts: [oldPost] });
    });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const toggle = host.querySelector<HTMLButtonElement>(".notice-board__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts?limit=50");
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    await advance(25_000);
    expect(listCalls).toBe(2);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("latest"))).toBe(false);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts/latest");
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:v2")).toBe("false");
    const latestCalls = apiGetMock.mock.calls.filter(([path]) => path.includes("latest")).length;
    await advance(60_000);
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("latest"))).toHaveLength(latestCalls + 1);
    expect(listCalls).toBe(2);

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

  it("shows unread activity from the collapsed latest cursor", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    apiGetMock.mockResolvedValue({ id: newPost.id, createdAt: newPost.createdAt });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("marks messages seen on a successful expanded list tick before collapsing", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "true");
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    let listCalls = 0;
    apiGetMock.mockImplementation((path) => {
      if (path.includes("latest")) return Promise.resolve({ id: newPost.id, createdAt: newPost.createdAt });
      listCalls += 1;
      return Promise.resolve({ posts: listCalls === 1 ? [oldPost] : [newPost, oldPost] });
    });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    await advance(25_000);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-a")).toBe(newPost.id);
    await click(host.querySelector(".notice-board__toggle")!);
    expect(host.querySelector('[aria-label="New notice"]')).toBeNull();
  });

  it("keeps a stale unread badge when the fresh expand fetch fails", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false");
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    apiGetMock.mockImplementation((path) => path.includes("latest")
      ? Promise.resolve({ id: newPost.id, createdAt: newPost.createdAt })
      : Promise.reject(new Error("offline")));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
    await click(host.querySelector(".notice-board__toggle")!);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("scopes the seen cursor per account and only offers author controls", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", newPost.id);
    window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "true");
    apiGetMock.mockResolvedValue({ posts: [newPost, { ...oldPost, authorId: "user-a" }] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-b" />);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-b")).toBe(newPost.id);
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
