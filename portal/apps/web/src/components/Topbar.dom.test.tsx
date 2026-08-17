import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(host: HTMLElement) {
  await act(async () => { root!.render(<Topbar activeView="dashboard" canAccessAdmin={false} user={{ name: "Ada", email: "ada@example.test" }} notificationPollMs={1_000} />); await Promise.resolve(); await Promise.resolve(); });
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiGetMock.mockReset();
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  apiGetMock.mockResolvedValue({ notifications: [{ id: "n-1", projectId: "p-1", type: "raw_ready", title: "RAW ready for review", body: "12 King Street has RAW images ready for review.", readAt: null, createdAt: "2026-07-28T00:00:00.000Z" }], unreadCount: 1 });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Topbar notifications", () => {
  it("polls on a configurable interval and supports open, focus, escape, outside click, and read", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    expect(apiGetMock).toHaveBeenCalledWith("/api/notifications?limit=25");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    const trigger = host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!;
    await click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const item = host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(item);
    await click(item);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/n-1/read", {});

    await click(trigger);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("dismisses an unread notification optimistically without marking it read", async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    apiDeleteMock.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: RAW ready for review"]')!);
    expect(host.querySelector('[aria-label="Dismiss notification: RAW ready for review"]')).toBeNull();
    expect(host.querySelector(".topbar__notification-empty")).not.toBeNull();
    expect(host.querySelector(".topbar__notification-badge")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!.getAttribute("aria-label")).toBe("Notifications");
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notifications/n-1");
    expect(apiPostMock).not.toHaveBeenCalled();
    resolveDelete?.({ ok: true });
  });

  it("does not decrement unread count when dismissing an already-read notification", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-unread", projectId: "p-1", type: "raw_ready", title: "Unread notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-read", projectId: "p-1", type: "raw_ready", title: "Read notification", body: null, readAt: "2026-07-28T01:00:00.000Z", createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 1 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Read notification"]')!);
    expect(host.querySelector('[aria-label="Dismiss notification: Unread notification"]')).not.toBeNull();
    expect(host.querySelector(".topbar__notification-badge")?.textContent).toBe("1");
    expect(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!.getAttribute("aria-label")).toBe("1 unread notifications");
  });

  it("hands focus to the next dismiss button, then the open menu when it becomes empty", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 2 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: First notification"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const secondDismiss = host.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-2"]')!;
    expect(document.activeElement).toBe(secondDismiss);
    await click(secondDismiss);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    expect(menu).not.toBeNull();
    expect(host.querySelector(".topbar__notification-empty")).not.toBeNull();
  });

  it("links every project notification, opening collaboration only for collaboration notifications, then marks them read without waiting", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "project-mention", projectId, type: "mentioned", title: "You were mentioned", body: "Comment", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "board-mention", projectId: null, type: "mentioned", title: "You were mentioned", body: "Notice", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-subtask", projectId, type: "subtask_assigned", title: "Subtask assigned", body: "Checklist", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-due", projectId, type: "subtask_due_today", title: "Due today", body: "Checklist", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-raw", projectId, type: "raw_ready", title: "RAW", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-edited", projectId, type: "edited_landed", title: "Edited", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-editing", projectId, type: "sent_to_editing", title: "Editing", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-stalled", projectId, type: "autohdr_stalled", title: "Stalled", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-delivered", projectId, type: "delivered", title: "Delivered", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-comment", projectId, type: "comment_added", title: "Comment", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-assigned", projectId, type: "assigned_to_project", title: "Assigned", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
    ], unreadCount: 11 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host); await click(host.querySelector<HTMLButtonElement>(".topbar__notification-trigger")!);
    const links = host.querySelectorAll<HTMLAnchorElement>(`a[href="/projects/${projectId}?collaboration=open"]`);
    expect(links).toHaveLength(3); expect([...links].map((link) => link.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("You were mentioned"), expect.stringContaining("Subtask assigned"), expect.stringContaining("Due today")]));
    expect(host.querySelectorAll(`a[href="/projects/${projectId}"]`)).toHaveLength(7);
    const link = links[0]!;
    expect(link.getAttribute("role")).toBe("menuitem");
    expect([...host.querySelectorAll("button.topbar__notification-item")].map((button) => button.textContent)).toEqual([expect.stringContaining("You were mentioned")]);
    expect(host.querySelectorAll("button.topbar__notification-item")).toHaveLength(1);
    await click(link);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/project-mention/read", {});
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
