import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationFeed, type UseNotificationFeedOptions } from "./use-notifications";
import { writeSnapshot } from "./notification-write-tracker";
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

// A settle-and-reconcile chain (write → barrier release → reconcile fetch → apply) is several
// microtask hops deeper than a single `click`'s own two ticks. Tests that manually resolve a
// controlled write/fetch promise flush generously afterwards with this instead of guessing a tick
// count that happens to be exactly enough.
async function flush(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
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
    apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
    await render(<Harness poll={null} />);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("2");
    // #115: the write barrier's reconcile issues a second GET once markAllRead's write settles, even
    // for a single mounted instance — this mocks the server having applied the write by then.
    apiGetMock.mockResolvedValueOnce(response(
      [row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" }), row({ id: "n-2", readAt: "2026-07-28T01:00:00.000Z" })],
      0,
    ));
    await click(host.querySelector('[data-testid="mark-all-read"]')!);
    expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/read-all", {});
  });

  describe("write barrier + reconcile (#115)", () => {
    it("a poll started before a write and landing after it (write still pending) is dropped; the reconcile refetch applies server state", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={1_000} />);

      let resolvePoll!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      let resolveWrite!: (value: unknown) => void;
      apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      await click(host.querySelector('[data-testid="read-n-1"]')!);
      expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");

      // The poll queued before the write lands while the write is still pending — dropped, not applied.
      await act(async () => { resolvePoll(response([row({ id: "n-1" })], 1)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");

      // Once the write settles, the reconcile refetch applies the server's confirmed state.
      apiGetMock.mockResolvedValue(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" })], 0));
      await act(async () => { resolveWrite({ ok: true }); });
      await flush();
      expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
    });

    it("a poll started before a write that settles before the stale poll lands is dropped (generation changed); the reconcile response is applied", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={1_000} />);

      let resolvePoll!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      // The reconcile fetch triggered once the write below settles gets this response — a fresh
      // unread row the poll queued before the write never saw.
      apiGetMock.mockResolvedValueOnce(response(
        [row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" }), row({ id: "n-2" })],
        1,
      ));
      await click(host.querySelector('[data-testid="read-n-1"]')!);
      await flush();
      expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");

      // The poll queued before the write finally lands — dropped, since generation moved since it started.
      await act(async () => { resolvePoll(response([row({ id: "n-1" })], 1)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");
    });

    it("a load more that lands during a pending write drops its rows and, once the write reconciles, re-runs exactly once with the reconciled cursor", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
      await render(<Harness poll={null} paged />);

      let resolveLoadMore!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLoadMore = resolve; }));
      await click(host.querySelector('[data-testid="load-more"]')!);
      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("true");

      let resolveWrite!: (value: unknown) => void;
      apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");

      // The stale page lands while the write is still pending — dropped, loadingMore stays true.
      await act(async () => { resolveLoadMore(response([row({ id: "n-2" })], 1, null)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="id-n-2"]')).toBeNull();
      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("true");

      // The write settles: reconcile applies server state, then automatically re-runs loadMore with
      // the fresh cursor exactly once.
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" })], 0, "cursor-2"));
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-3" })], 0, null));
      await act(async () => { resolveWrite({ ok: true }); });
      await flush();

      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("false");
      expect(host.querySelector('[data-testid="id-n-2"]')).toBeNull();
      expect(host.querySelector('[data-testid="id-n-3"]')).not.toBeNull();
      expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-2");
    });

    it("a load more that lands after the reconcile already applied re-runs immediately instead of waiting for a refetch the page never makes", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
      await render(<Harness poll={null} paged />);

      let resolveLoadMore!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLoadMore = resolve; }));
      await click(host.querySelector('[data-testid="load-more"]')!);

      // The write and its reconcile both complete while the page request is still out.
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" })], 0, "cursor-2"));
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      await flush();

      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-3" })], 0, null));
      await act(async () => { resolveLoadMore(response([row({ id: "n-2" })], 1, null)); await Promise.resolve(); });
      await flush();

      expect(host.querySelector('[data-testid="id-n-2"]')).toBeNull();
      expect(host.querySelector('[data-testid="id-n-3"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("false");
      expect(apiGetMock).toHaveBeenLastCalledWith("/api/notifications?limit=25&cursor=cursor-2");
    });

    it("a load more parked on a reconcile that fails ends busy and reports the error", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1, "cursor-1"));
      await render(<Harness poll={null} paged />);

      let resolveLoadMore!: (value: unknown) => void;
      apiGetMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLoadMore = resolve; }));
      await click(host.querySelector('[data-testid="load-more"]')!);

      let resolveWrite!: (value: unknown) => void;
      apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      await act(async () => { resolveLoadMore(response([row({ id: "n-2" })], 1, null)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("true");

      apiGetMock.mockRejectedValueOnce(new Error("offline"));
      await act(async () => { resolveWrite({ ok: true }); });
      await flush();

      expect(host.querySelector('[data-testid="loading-more"]')?.textContent).toBe("false");
      expect(host.querySelector('[data-testid="load-more-error"]')?.textContent).toBe("true");
    });

    it("after read-all settles, a later response containing a new unread row shows it unread with count 1", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={1_000} />);

      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" })], 0));
      await click(host.querySelector('[data-testid="mark-all-read"]')!);
      await flush();
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");

      apiGetMock.mockResolvedValueOnce(response(
        [row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" }), row({ id: "n-2", createdAt: "2026-07-28T02:00:00.000Z" })],
        1,
      ));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="read-n-2"]')?.getAttribute("data-read")).toBe("false");
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");
    });

    it("a hung write releases the barrier at 15s and the reconcile runs", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={null} />);

      apiPostMock.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await click(host.querySelector('[data-testid="read-n-1"]')!);
      expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("true");

      // The write never actually reached the server, so the reconcile's response shows it still unread.
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("false");
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");
    });

    it("two polls resolving out of order: the older response does not overwrite the newer", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={1_000} />);

      const resolvers: ((value: unknown) => void)[] = [];
      apiGetMock.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(resolvers).toHaveLength(2);
      const [resolveFirst, resolveSecond] = resolvers as [(value: unknown) => void, (value: unknown) => void];

      // The newer poll (the second one) lands first.
      await act(async () => { resolveSecond(response([row({ id: "n-1" }), row({ id: "n-2" })], 2)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();

      // The older poll lands after — dropped, since a newer request already superseded it.
      await act(async () => { resolveFirst(response([row({ id: "n-1" })], 1)); await Promise.resolve(); await Promise.resolve(); });
      expect(host.querySelector('[data-testid="id-n-2"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("2");
    });

    it("a poll tick while a write is pending issues no GET", async () => {
      vi.useFakeTimers();
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={1_000} />);

      apiPostMock.mockImplementationOnce(() => new Promise(() => { /* stays pending past the tracker's own 15s timeout */ }));
      await click(host.querySelector('[data-testid="read-n-1"]')!);

      const getsBefore = apiGetMock.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(apiGetMock.mock.calls.length).toBe(getsBefore);

      // Let the tracker's own timeout release the barrier so this write does not stay `pending`
      // forever and drop every later test's head fetches in this file (`pending`/`generation` are
      // module-global, not reset per test).
      await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    });

    it("unmounting mid-write produces no setter warnings and the barrier still returns to 0", async () => {
      apiGetMock.mockResolvedValueOnce(response([row({ id: "n-1" })], 1));
      await render(<Harness poll={null} />);

      let resolveWrite!: (value: unknown) => void;
      apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
      await click(host.querySelector('[data-testid="read-n-1"]')!);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await act(async () => { root!.unmount(); await Promise.resolve(); });
      root = null;

      await act(async () => { resolveWrite({ ok: true }); });
      await flush();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(writeSnapshot().pending).toBe(0);
      errorSpy.mockRestore();
    });

    describe("across two mounted instances (the page and the Bell)", () => {
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

      async function mountSecond(value: React.ReactNode) {
        await act(async () => { secondRoot.render(value); await Promise.resolve(); await Promise.resolve(); });
      }

      it("the page's mark-all-read write settling refetches the Bell, which shows the write's result only after it settles", async () => {
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
        await render(<Harness poll={null} paged />);
        await mountSecond(<Harness poll={25_000} />);

        let resolveWrite!: (value: unknown) => void;
        apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
        const getsBefore = apiGetMock.mock.calls.length;
        await click(host.querySelector('[data-testid="mark-all-read"]')!);
        // The write is still pending — no GET issued by either instance yet, and the Bell has not
        // applied anything.
        expect(apiGetMock.mock.calls.length).toBe(getsBefore);
        expect(secondHost.querySelector('[data-testid="unread-count"]')?.textContent).toBe("2");

        apiGetMock.mockResolvedValue(response(
          [row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" }), row({ id: "n-2", readAt: "2026-07-28T01:00:00.000Z" })],
          0,
        ));
        await act(async () => { resolveWrite({ ok: true }); });
        await flush();
        expect(secondHost.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
        expect(apiGetMock.mock.calls.length).toBeGreaterThan(getsBefore);
      });

      it("an instance mounted while another instance's write is pending shows only the post-settle fetch", async () => {
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" })], 1));
        await render(<Harness poll={null} paged />);

        let resolveWrite!: (value: unknown) => void;
        apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
        await click(host.querySelector('[data-testid="mark-all-read"]')!);

        // The Bell mounts while that write is still pending — its own initial head fetch lands but
        // is dropped, so it never shows the pre-settle state.
        await mountSecond(<Harness poll={25_000} />);
        expect(secondHost.querySelectorAll('[data-testid="ids"] li')).toHaveLength(0);

        apiGetMock.mockResolvedValue(response([row({ id: "n-1", readAt: "2026-07-28T01:00:00.000Z" })], 0));
        await act(async () => { resolveWrite({ ok: true }); });
        await flush();
        expect(secondHost.querySelector('[data-testid="id-n-1"]')).not.toBeNull();
        expect(secondHost.querySelector('[data-testid="unread-count"]')?.textContent).toBe("0");
      });

      it("a failed write reconciles both instances to server state, including a failed dismiss restoring the row", async () => {
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" })], 1));
        await render(<Harness poll={null} paged />);
        await mountSecond(<Harness poll={25_000} />);

        // markRead fails — both instances reconcile to the row still being unread. (The write and
        // its reconcile both resolve fast here with no manually-controlled promise, so by the time
        // `click` returns the reconcile may already be applied — only the final, settled state is
        // asserted, not an intermediate optimistic one.)
        apiPostMock.mockRejectedValueOnce(new Error("network error"));
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" })], 1)); // the server never applied it
        await click(host.querySelector('[data-testid="read-n-1"]')!);
        await flush();
        expect(host.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("false");
        expect(host.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");
        expect(secondHost.querySelector('[data-testid="read-n-1"]')?.getAttribute("data-read")).toBe("false");
        expect(secondHost.querySelector('[data-testid="unread-count"]')?.textContent).toBe("1");

        // dismiss fails — both instances reconcile the row back into the list.
        apiDeleteMock.mockRejectedValueOnce(new Error("network error"));
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" })], 1)); // the server never deleted it
        await click(host.querySelector('[data-testid="dismiss-n-1"]')!);
        await flush();
        expect(host.querySelector('[data-testid="id-n-1"]')).not.toBeNull();
        expect(secondHost.querySelector('[data-testid="id-n-1"]')).not.toBeNull();
      });

      it("two overlapping writes settling in either order produce exactly one reconcile GET per instance, none while either is pending", async () => {
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" }), row({ id: "n-2" })], 2));
        await render(<Harness poll={null} paged />);
        await mountSecond(<Harness poll={25_000} />);

        let resolveRead!: (value: unknown) => void;
        apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
        let resolveDismiss!: (value: unknown) => void;
        apiDeleteMock.mockImplementationOnce(() => new Promise((resolve) => { resolveDismiss = resolve; }));

        await click(host.querySelector('[data-testid="read-n-1"]')!);
        await click(host.querySelector('[data-testid="dismiss-n-2"]')!);

        const getsBefore = apiGetMock.mock.calls.length;
        await act(async () => { resolveRead({ ok: true }); });
        await flush();
        // One write is still pending — no reconcile GET yet from either instance.
        expect(apiGetMock.mock.calls.length).toBe(getsBefore);

        await act(async () => { resolveDismiss({ ok: true }); });
        await flush();
        // Both writes have now settled — exactly one reconcile GET per mounted instance.
        expect(apiGetMock.mock.calls.length).toBe(getsBefore + 2);
      });

      it("a hung write that later resolves triggers exactly one more reconcile GET per instance beyond its own timeout reconcile", async () => {
        vi.useFakeTimers();
        apiGetMock.mockResolvedValue(response([row({ id: "n-1" })], 1));
        await render(<Harness poll={null} paged />);
        await mountSecond(<Harness poll={25_000} />);

        let resolveWrite!: (value: unknown) => void;
        apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
        await click(host.querySelector('[data-testid="read-n-1"]')!);

        const getsBeforeTimeout = apiGetMock.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        expect(apiGetMock.mock.calls.length).toBe(getsBeforeTimeout + 2);

        const getsAfterTimeout = apiGetMock.mock.calls.length;
        await act(async () => { resolveWrite({ ok: true }); });
        await flush();
        expect(apiGetMock.mock.calls.length).toBe(getsAfterTimeout + 2);
      });
    });
  });
});
