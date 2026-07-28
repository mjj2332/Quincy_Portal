import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

const oldPost: NoticeBoardPost = { id: "post-old", authorId: "user-a", authorName: "A", body: "Old notice", createdAt: "2026-07-28T00:00:00.000Z" };
const newPost: NoticeBoardPost = { id: "post-new", authorId: "user-b", authorName: "B", body: "New notice", createdAt: "2026-07-28T00:00:01.000Z" };
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
  apiPostMock.mockResolvedValue(newPost);
  apiDeleteMock.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("NoticeBoard disclosure and polling", () => {
  it("starts collapsed, persists the toggle, and switches polling modes without overlap", async () => {
    apiGetMock.mockImplementation((path) => path.includes("latest")
      ? Promise.resolve({ id: newPost.id, createdAt: newPost.createdAt })
      : Promise.resolve({ posts: [oldPost] }));
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    const toggle = host.querySelector<HTMLButtonElement>(".notice-board__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts/latest");
    await advance(60_000);
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("latest"))).toHaveLength(2);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(apiGetMock).toHaveBeenCalledWith("/api/notice-board/posts?limit=50");
    const latestCalls = apiGetMock.mock.calls.filter(([path]) => path.includes("latest")).length;
    await advance(25_000);
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("latest"))).toHaveLength(latestCalls);
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("posts?limit"))).toHaveLength(2);

    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    const remounted = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(remounted.querySelector<HTMLButtonElement>(".notice-board__toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows unread activity from the collapsed latest cursor", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", oldPost.id);
    apiGetMock.mockResolvedValue({ id: newPost.id, createdAt: newPost.createdAt });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-a" />);
    expect(host.querySelector('[aria-label="New notice"]')).not.toBeNull();
  });

  it("marks messages seen on a successful expanded list tick before collapsing", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard", "true");
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

  it("scopes the seen cursor per account and only offers author deletes", async () => {
    window.localStorage.setItem("quincy:dashboard:noticeboard:seen:user-a", newPost.id);
    window.localStorage.setItem("quincy:dashboard:noticeboard", "true");
    apiGetMock.mockResolvedValue({ posts: [newPost, { ...oldPost, authorId: "user-a" }] });
    const host = mount();
    await render(<NoticeBoard currentUserId="user-b" />);
    expect(window.localStorage.getItem("quincy:dashboard:noticeboard:seen:user-b")).toBe(newPost.id);
    expect(host.querySelectorAll(".notice-board__delete")).toHaveLength(1);
    await click(host.querySelector(".notice-board__delete")!);
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notice-board/posts/post-new");
  });
});
