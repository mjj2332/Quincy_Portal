import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
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
    await click(trigger);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
