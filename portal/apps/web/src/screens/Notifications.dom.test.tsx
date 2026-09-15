import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifications } from "./Notifications";

/**
 * `/settings/notifications` (#115) — the full page `NotificationBell`'s footer links to. Shares
 * `useNotificationFeed` and `NotificationList`/`NotificationEmptyState` with the Bell (both
 * already covered by their own suites), so this file covers only what is specific to the page:
 * page-scale rendering, the "Load more" foot's four states, the Preferences link, mark-all, both
 * empty states, an external (staff-enrichment-free) payload, and the page's own dismiss-focus
 * handoff.
 */

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiDeleteMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiDelete: (path: string) => apiDeleteMock(path),
  };
});

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render() {
  await act(async () => { root!.render(<Notifications />); await Promise.resolve(); await Promise.resolve(); });
}

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

type NotificationOverrides = Partial<{
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
  projectStreet: string | null;
  coverAssetId: string | null;
  actor: { id: string; name: string } | null;
  subject: { kind: "asset" | "subtask" | "project_comment" | "notice_board_post"; label: string } | null;
  assetId: string | null;
}>;

function notification(overrides: NotificationOverrides = {}) {
  return {
    id: "n-1",
    projectId: null,
    type: "mentioned",
    title: "First notification",
    body: null,
    readAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    projectStreet: null,
    coverAssetId: null,
    actor: null,
    subject: null,
    assetId: null,
    ...overrides,
  };
}

function response(notifications: unknown[], unreadCount: number, nextCursor: string | null = null) {
  return { notifications, unreadCount, nextCursor };
}

const loadMoreButton = () => document.querySelector<HTMLButtonElement>('[data-testid="notifications-load-more"]')!;
const markAllButton = () => document.querySelector<HTMLButtonElement>('[data-testid="notifications-mark-all"]')!;

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("Notifications", () => {
  it("renders day buckets at page scale", async () => {
    apiGetMock.mockResolvedValue(response([notification()], 1, null));
    await render();
    const bucket = host.querySelector('[data-notification-bucket]');
    expect(bucket).not.toBeNull();
    expect(bucket!.querySelector('h3')).not.toBeNull();
    const row = bucket!.querySelector('[data-notification-scale]');
    expect(row!.getAttribute("data-notification-scale")).toBe("page");
  });

  it("links Preferences at the moved path", async () => {
    apiGetMock.mockResolvedValue(response([], 0, null));
    await render();
    const link = host.querySelector('[data-testid="notifications-preferences-link"]');
    expect(link?.getAttribute("href")).toBe("/settings/notifications/preferences");
  });

  it("appends a loadMore page, merging a Sydney day spanning the boundary into ONE bucket with ONE heading", async () => {
    // Same fixture as `notification-list.test.ts`'s own "spans two pages" case.
    apiGetMock.mockResolvedValueOnce(response([notification({ id: "a", createdAt: "2026-09-15T08:00:00+10:00" })], 1, "cursor-1"));
    await render();
    expect(loadMoreButton().textContent).toBe("Load more");

    apiGetMock.mockResolvedValueOnce(response([notification({ id: "b", createdAt: "2026-09-15T00:30:00+10:00" })], 1, null));
    await click(loadMoreButton());

    expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-1");
    expect(host.querySelector('[data-notification-dismiss="a"]')).not.toBeNull();
    expect(host.querySelector('[data-notification-dismiss="b"]')).not.toBeNull();
    const buckets = host.querySelectorAll('[data-notification-bucket]');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.querySelectorAll('h3')).toHaveLength(1);
  });

  it("stays mounted, aria-disabled, at the end of the feed, and keeps focus on the button", async () => {
    apiGetMock.mockResolvedValue(response([notification()], 1, null));
    await render();
    const button = loadMoreButton();
    expect(button.textContent).toBe("No more notifications");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    const callsBefore = apiGetMock.mock.calls.length;
    button.focus();
    await click(button);
    expect(apiGetMock.mock.calls.length).toBe(callsBefore);
    expect(document.activeElement).toBe(button);
  });

  it("shows Loading… with aria-busy while a page is in flight", async () => {
    apiGetMock.mockResolvedValueOnce(response([notification({ id: "a" })], 1, "cursor-1"));
    await render();

    let resolvePage: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    await act(async () => { loadMoreButton().click(); await Promise.resolve(); });
    expect(loadMoreButton().textContent).toBe("Loading…");
    expect(loadMoreButton().getAttribute("aria-busy")).toBe("true");

    await act(async () => { resolvePage!(response([notification({ id: "b" })], 1, null)); await Promise.resolve(); await Promise.resolve(); });
    expect(loadMoreButton().textContent).toBe("No more notifications");
  });

  it("shows Try again on a failed loadMore and retries with the same cursor", async () => {
    apiGetMock.mockResolvedValueOnce(response([notification({ id: "a" })], 1, "cursor-1"));
    await render();

    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    await click(loadMoreButton());
    expect(loadMoreButton().textContent).toBe("Try again");
    expect(host.querySelector('[data-notification-dismiss="b"]')).toBeNull();

    apiGetMock.mockResolvedValueOnce(response([notification({ id: "b" })], 1, null));
    await click(loadMoreButton());
    expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-1");
    expect(loadMoreButton().textContent).toBe("No more notifications");
    expect(host.querySelector('[data-notification-dismiss="b"]')).not.toBeNull();
  });

  it("zeroes the Unread tab's count and disables Mark all read after marking all read", async () => {
    apiGetMock.mockResolvedValue(response([notification({ id: "a" }), notification({ id: "b" })], 2, null));
    await render();
    const unreadTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Unread"))!;
    expect(unreadTab.textContent).toBe("Unread 2");
    expect(markAllButton().getAttribute("aria-disabled")).toBeNull();

    await click(markAllButton());
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/read-all", {});
    const unreadTabAfter = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Unread"))!;
    expect(unreadTabAfter.textContent).toBe("Unread 0");
    expect(markAllButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the All-tab empty state with no notifications", async () => {
    apiGetMock.mockResolvedValue(response([], 0, null));
    await render();
    const empty = host.querySelector('[data-testid="rail-notifications-empty"]');
    expect(empty?.getAttribute("data-notification-empty")).toBe("all");
    expect(empty?.textContent).toContain("No notifications.");
  });

  it("shows the Unread-tab empty state when every row is already read", async () => {
    apiGetMock.mockResolvedValue(response([notification({ readAt: "2026-07-28T00:00:00.000Z" })], 0, null));
    await render();
    const unreadTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Unread"))!;
    await click(unreadTab);
    const empty = host.querySelector('[data-testid="rail-notifications-empty"]');
    expect(empty?.getAttribute("data-notification-empty")).toBe("unread");
    expect(empty?.textContent).toContain("You’re all caught up.");
  });

  it("renders a payload lacking actor/subject/assetId, the external wire shape", async () => {
    const external = {
      id: "ext-1",
      projectId: null,
      type: "other",
      title: "External notification",
      body: null,
      readAt: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      projectStreet: null,
      coverAssetId: null,
      // actor/subject/assetId deliberately absent — the shape `routes/notifications.ts` sends on
      // its external branch.
    };
    apiGetMock.mockResolvedValue(response([external], 1, null));
    await render();
    expect(host.textContent).toContain("External notification");
  });

  it("hands dismiss focus to the next row's dismiss button", async () => {
    apiGetMock.mockResolvedValue(response([
      notification({ id: "n-1", title: "First notification", createdAt: "2026-07-28T02:00:00.000Z" }),
      notification({ id: "n-2", title: "Second notification", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], 2, null));
    await render();

    await click(host.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!);
    const secondDismiss = host.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-2"]');
    expect(secondDismiss).not.toBeNull();
    expect(document.activeElement).toBe(secondDismiss);
  });
});
