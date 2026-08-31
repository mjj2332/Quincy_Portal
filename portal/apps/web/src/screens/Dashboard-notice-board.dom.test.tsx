import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "photographer", capabilities: ["viewRaw", "viewNoticeBoard"], can: (capability: string) => capability === "viewNoticeBoard" }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

describe("Dashboard notice-board capability gate", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (path === "/api/projects") return Promise.resolve({ projects: [] });
      if (path.startsWith("/api/notice-board/read-marker")) return Promise.resolve({ marker: null, latest: null, unreadCount: 0 });
      if (path.startsWith("/api/notice-board/posts")) return Promise.resolve({ posts: [] });
      return Promise.resolve({ stages: [] });
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    document.body.replaceChildren();
  });

  it("renders NoticeBoard for a photographer", async () => {
    await render(<Dashboard currentUserId="photographer-1" />);
    expect(document.querySelector('[aria-label="Notice board"]')).not.toBeNull();
  });
});
