import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationFeed, type UseNotificationFeedOptions } from "./use-notifications";
import type { NotificationListItem } from "./notification-list";

/**
 * #115's data-layer hook — lifted verbatim in behaviour out of `NotificationBell.dom.test.tsx`'s
 * own fetch/poll/mark-read/dismiss coverage (see that file), plus the paged-mode surface
 * (`loadMore`/`hasMore`/`loadingMore`/`loadMoreError`) that ticket adds. `Harness` below renders the
 * hook's result into plain DOM so each behaviour is driven the same way the Bell drives it: a real
 * `.click()` on a button wired to the hook function under test.
 */

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiDeleteMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
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

async function render(value: React.ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

function row(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
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

function response(notifications: NotificationListItem[], unreadCount: number, nextCursor: string | null = null) {
  return { notifications, unreadCount, nextCursor };
}

function Harness(options: UseNotificationFeedOptions) {
  const feed = useNotificationFeed(options);
  return (
    <div>
      <output data-testid="unread-count">{feed.unreadCount}</output>
      <output data-testid="has-more">{String(feed.hasMore)}</output>
      <output data-testid="loading-more">{String(feed.loadingMore)}</output>
      <output data-testid="load-more-error">{String(feed.loadMoreError)}</output>
      <ul data-testid="ids">
        {feed.notifications.map((item) => <li key={item.id} data-testid={`id-${item.id}`}>{item.id}</li>)}
      </ul>
      <button data-testid="load-more" onClick={() => feed.loadMore()}>Load more</button>
      <button data-testid="mark-all-read" onClick={() => feed.markAllRead()}>Mark all read</button>
      {feed.notifications.map((item) => (
        <button key={item.id} data-testid={`dismiss-${item.id}`} onClick={() => feed.dismiss(item)}>
          Dismiss {item.id}
        </button>
      ))}
      {feed.notifications.map((item) => (
        <button key={item.id} data-testid={`read-${item.id}`} data-read={String(item.readAt !== null)} onClick={() => feed.markRead(item)}>
          Read {item.id}
        </button>
      ))}
    </div>
  );
}

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
  vi.useRealTimers();
});

describe("useNotificationFeed", () => {
  it("requests the first page with no cursor param", async () => {
    apiGetMock.mockResolvedValue(response([row()], 1));
    await render(<Harness poll={null} />);
    expect(apiGetMock).toHaveBeenCalledWith("/api/notifications?limit=25");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("never sets an interval when poll is null", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue(response([], 0));
    await render(<Harness poll={null} />);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("polls again after the configured interval when poll is a number", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue(response([], 0));
    await render(<Harness poll={1_000} />);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("sends the returned cursor on loadMore and appends the new page", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", createdAt: "2026-07-28T02:00:00.000Z" })], 1, "cursor-1"));
    await render(<Harness poll={null} paged />);
    expect(host.querySelector('[data-testid="has-more"]')?.textContent).toBe("true");

    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-2", createdAt: "2026-07-28T01:00:00.000Z" })], 1, null));
    await click(host.querySelector('[data-testid="load-more"]')!);

    expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-1");
    expect(host.querySelector('[data-testid="id-n-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="has-more"]')?.textContent).toBe("false");
  });

  it("leaves unreadCount alone on loadMore so an optimistic mark-read in flight is not undone", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 5, "cursor-1"));
    await render(<Harness poll={null} paged />);
    await click(host.querySelector('[data-testid="mark-all-read"]')!);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");

    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-2" })], 5, null));
    await click(host.querySelector('[data-testid="load-more"]')!);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
  });

  it("issues one request for two loadMore calls before a rerender", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
    await render(<Harness poll={null} paged />);
    const before = apiGetMock.mock.calls.length;
    apiGetMock.mockResolvedValue(response([row({ id: "n-2" })], 1, null));
    await act(async () => {
      const button = host.querySelector<HTMLButtonElement>('[data-testid="load-more"]')!;
      button.click(); button.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(apiGetMock.mock.calls.length - before).toBe(1);
  });

  it("drops a row dismissed while a poll was in flight instead of resurrecting it", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
    await render(<Harness poll={1000} />);
    let resolvePoll: ((value: unknown) => void) | undefined;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await click(host.querySelector('[data-testid="dismiss-n-1"]')!);
    await act(async () => { resolvePoll!(response([row({ id: "n-1" })], 1)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="id-n-1"]')).toBeNull();
    vi.useRealTimers();
  });

  it("reports hasMore false when the response's nextCursor is null", async () => {
    apiGetMock.mockResolvedValue(response([row()], 1, null));
    await render(<Harness poll={null} paged />);
    expect(host.querySelector('[data-testid="has-more"]')?.textContent).toBe("false");
  });

  it("keeps the cursor and sets loadMoreError when loadMore fails, so a retry targets the same page", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
    await render(<Harness poll={null} paged />);

    apiGetMock.mockRejectedValueOnce(new Error("network error"));
    await click(host.querySelector('[data-testid="load-more"]')!);
    expect(host.querySelector('[data-testid="load-more-error"]')?.textContent).toBe("true");
    expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("false");
    // Only the original row is still present — the failed page never merged.
    expect(host.querySelectorAll('[data-testid="ids"] li')).toHaveLength(1);

    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-2" })], 1, null));
    await click(host.querySelector('[data-testid="load-more"]')!);
    // The retry re-sent the SAME cursor the failed attempt kept.
    expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-1");
    expect(host.querySelector('[data-testid="load-more-error"]')?.textContent).toBe("false");
    expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
  });

  it("dismisses a notification and removes it even after a second page has been appended", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", createdAt: "2026-07-28T02:00:00.000Z" })], 1, "cursor-1"));
    await render(<Harness poll={null} paged />);

    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-2", createdAt: "2026-07-28T01:00:00.000Z" })], 1, null));
    await click(host.querySelector('[data-testid="load-more"]')!);
    expect(host.querySelector('[data-testid="id-n-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();

    await click(host.querySelector('[data-testid="dismiss-n-1"]')!);
    expect(host.querySelector('[data-testid="id-n-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notifications/n-1");
  });

  it("does not resurrect a dismissed row when a later page contains a stale duplicate", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
    await render(<Harness poll={null} paged />);

    await click(host.querySelector('[data-testid="dismiss-n-1"]')!);
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" }), row({ id: "n-2" })], 1, null));
    await click(host.querySelector('[data-testid="load-more"]')!);

    expect(host.querySelector('[data-testid="id-n-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
  });

  it("zeroes unreadCount on markAllRead", async () => {
    apiGetMock.mockResolvedValue(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
    await render(<Harness poll={null} />);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("2");
    await click(host.querySelector('[data-testid="mark-all-read"]')!);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/read-all", {});
  });

  describe("across instances mounted in the same tab (the page and the Bell)", () => {
    let secondHost: HTMLElement;
    let secondRoot: Root;

    beforeEach(() => {
      secondHost = document.createElement("div");
      document.body.appendChild(secondHost);
      secondRoot = createRoot(secondHost);
    });

    afterEach(async () => {
      await act(async () => { secondRoot.unmount(); await Promise.resolve(); });
    });

    async function renderBoth(rows: NotificationListItem[], unreadCount: number) {
      apiGetMock.mockResolvedValue(response(rows, unreadCount));
      await render(<Harness poll={null} paged />);
      await act(async () => { secondRoot.render(<Harness poll={25_000} />); await Promise.resolve(); await Promise.resolve(); });
    }

    const count = (scope: HTMLElement) => scope.querySelector('[data-testid="unread-count"]')?.textContent;

    it("zeroes the other instance's unreadCount and rows on markAllRead", async () => {
      await renderBoth([row({ id: "n-1" }), row({ id: "n-2" })], 2);
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      expect(count(secondHost)).toBe("0");
      expect(secondHost.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });

    it("marks the same row read in the other instance and decrements its count once", async () => {
      await renderBoth([row({ id: "n-1" }), row({ id: "n-2" })], 2);
      await click(host.querySelector('[data-testid="read-n-1"]')!);
      expect(count(host)).toBe("1");
      expect(count(secondHost)).toBe("1");
      expect(secondHost.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");
      await click(secondHost.querySelector('[data-testid="read-n-1"]')!);
      expect(count(host)).toBe("1");
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });

    it("decrements the other instance's count for an unread row it has not loaded", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
      await render(<Harness poll={null} paged />);
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 2));
      await act(async () => { secondRoot.render(<Harness poll={25_000} />); await Promise.resolve(); await Promise.resolve(); });
      await click(host.querySelector('[data-testid="dismiss-n-2"]')!);
      expect(count(secondHost)).toBe("1");
    });

    it("removes a dismissed row from the other instance and keeps a later poll from resurrecting it", async () => {
      vi.useFakeTimers();
      await renderBoth([row({ id: "n-1" }), row({ id: "n-2", readAt: "2026-07-28T01:00:00.000Z" })], 1);
      await click(host.querySelector('[data-testid="dismiss-n-2"]')!);
      expect(secondHost.querySelector('[data-testid="id-n-2"]')).toBeNull();
      expect(count(secondHost)).toBe("1");
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
      expect(secondHost.querySelector('[data-testid="id-n-2"]')).toBeNull();
      expect(apiDeleteMock).toHaveBeenCalledTimes(1);
    });

    it("does not let a Bell poll that was in flight restore the count a page mark-all-read cleared", async () => {
      vi.useFakeTimers();
      await renderBoth([row({ id: "n-1" }), row({ id: "n-2" })], 2);
      let resolvePoll!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      expect(count(secondHost)).toBe("0");
      await act(async () => { resolvePoll(response([row({ id: "n-1" }), row({ id: "n-2" })], 2)); await Promise.resolve(); await Promise.resolve(); });
      expect(count(secondHost)).toBe("0");
      expect(secondHost.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");
    });

    it("lets the receiver's own read copy decide, so a stale page row does not decrement the Bell twice", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
      await render(<Harness poll={null} paged />);
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" }), row({ id: "n-2" })], 1));
      await act(async () => { secondRoot.render(<Harness poll={25_000} />); await Promise.resolve(); await Promise.resolve(); });
      await click(host.querySelector('[data-testid="read-n-1"]')!);
      expect(count(host)).toBe("1");
      expect(count(secondHost)).toBe("1");
    });
  });

  it("marks rows from a loadMore that was in flight during markAllRead as read", async () => {
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 2, "cursor-1"));
    await render(<Harness poll={null} paged />);
    let resolvePage!: (value: unknown) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    await click(host.querySelector('[data-testid="load-more"]')!);
    await click(host.querySelector('[data-testid="mark-all-read"]')!);
    await act(async () => { resolvePage(response([row({ id: "n-2" })], 2, null)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="read-n-2"]')?.getAttribute("data-read")).toBe("true");
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
  });

  it("keeps replaying after a failed request so a later in-flight response still honours a mutation", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
    await render(<Harness poll={1_000} />);
    apiGetMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    let resolvePoll!: (value: unknown) => void;
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await click(host.querySelector('[data-testid="dismiss-n-1"]')!);
    await act(async () => { resolvePoll(response([row({ id: "n-1" }), row({ id: "n-2" })], 2)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="id-n-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");
  });
});
