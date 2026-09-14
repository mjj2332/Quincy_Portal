import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TYPES } from "@quincy/shared";
import { NotificationList } from "./NotificationList";
import { groupNotifications, type NotificationListItem } from "../../lib/notification-list";

/**
 * #114's pure presentation module — `NotificationBell.dom.test.tsx` covers the popover/tab/poll
 * chrome around this; here it is exercised as a standalone component with plain props, the same
 * split `board.dom.test.tsx` draws between drag machinery and card markup.
 */

const lazyImage = vi.hoisted(() => ({
  calls: [] as Array<{ assetId: string; alt: string }>,
}));

// #83's precedent (`kanban2/board.dom.test.tsx`): a double that records what it was asked to
// render rather than exercising the real scheduler/observer machinery, which this file has no
// need to drive.
vi.mock("../LazyImage", () => ({
  LazyImage: (props: { preload: string; assetId: string; alt: string }) => {
    lazyImage.calls.push({ assetId: props.assetId, alt: props.alt });
    return null;
  },
}));

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: React.ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  lazyImage.calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

function item(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
  return {
    id: "n-1",
    projectId: null,
    type: "mentioned",
    title: "Title",
    body: null,
    readAt: null,
    createdAt: "2026-09-15T01:00:00.000Z",
    projectStreet: null,
    coverAssetId: null,
    ...overrides,
  };
}

const NOOP = () => {};

function renderList(items: NotificationListItem[], props: Partial<{ now: number; showThumbnails: boolean }> = {}) {
  const now = props.now ?? new Date("2026-09-15T09:00:00+10:00").getTime();
  const buckets = groupNotifications(items, now);
  return render(
    <ul>
      <NotificationList
        buckets={buckets}
        now={now}
        showThumbnails={props.showThumbnails ?? true}
        onActivate={NOOP}
        onDismiss={NOOP}
      />
    </ul>,
  );
}

describe("NotificationList", () => {
  it("renders Today, Yesterday and dated headings in bucket order", async () => {
    const now = new Date("2026-09-15T09:00:00+10:00").getTime();
    await renderList([
      item({ id: "a", createdAt: "2026-09-15T01:00:00+10:00" }),
      item({ id: "b", createdAt: "2026-09-14T10:00:00+10:00" }),
      item({ id: "c", createdAt: "2026-09-13T10:00:00+10:00" }),
    ], { now });
    const headings = [...host.querySelectorAll("h3")].map((h3) => h3.textContent);
    expect(headings).toEqual(["Today", "Yesterday", "13 Sep 2026"]);
  });

  it("keeps a late-evening Sydney notification under Yesterday, not Today", async () => {
    const now = new Date("2026-09-15T00:15:00+10:00").getTime(); // 2026-09-14T14:15:00.000Z
    await renderList([item({ id: "a", createdAt: "2026-09-14T23:30:00+10:00" })], { now });
    const headings = [...host.querySelectorAll("h3")].map((h3) => h3.textContent);
    expect(headings).toEqual(["Yesterday"]);
  });

  it("exposes the title as the link's name, with body and timestamp as sibling row content", async () => {
    await renderList([item({ title: "Row title", body: "Row body" })]);
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const link = row.querySelector<HTMLElement>('[data-testid="rail-notification-item"]')!;
    expect(link.textContent).toBe("Row title");
    const body = row.querySelector("small")!.previousElementSibling;
    expect(body?.textContent).toBe("Row body");
    expect(link.contains(body)).toBe(false);
    const time = row.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2026-09-15T01:00:00.000Z");
  });

  it("renders ordinary list items without any menu role", async () => {
    await renderList([item()]);
    expect(host.querySelector('[role="menuitem"]')).toBeNull();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector('[role="list"]')).not.toBeNull();
  });

  it("reserves the 28px leading slot as the first child of every row", async () => {
    await renderList([item()]);
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const leading = row.firstElementChild!;
    // React stringifies a custom `data-*` attribute's boolean value rather than treating it as
    // one of the handful of native boolean attributes (`disabled`, `checked`, …) that collapse to
    // presence/absence — so this reads "true", not "".
    expect(leading.getAttribute("data-notification-leading")).toBe("true");
    expect(leading.getAttribute("aria-hidden")).toBe("true");
    expect(leading.className).toContain("size-[28px]");
  });

  it("renders no type icon in any row", async () => {
    for (const type of [...NOTIFICATION_TYPES, "some_unknown_type"]) {
      await renderList([item({ type })]);
      const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
      expect(row.querySelectorAll("svg")).toHaveLength(0);
    }
  });

  it("renders the project cover as every row's thumbnail and a placeholder when there is none", async () => {
    await renderList([
      item({ id: "with-cover", title: "With cover", coverAssetId: "asset-1" }),
      item({ id: "without-cover", title: "Without cover", coverAssetId: null }),
    ]);
    expect(lazyImage.calls).toEqual([{ assetId: "asset-1", alt: "" }]);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="rail-notification-row"]')];
    const withoutCover = rows.find((row) => row.textContent?.includes("Without cover"))!;
    expect(withoutCover.querySelector('[data-testid="rail-notification-thumb-placeholder"]')).not.toBeNull();
  });

  it("renders no thumbnail and requests no image when showThumbnails is false", async () => {
    await renderList([item({ coverAssetId: "asset-1" })], { showThumbnails: false });
    expect(host.querySelector("[data-notification-thumb]")).toBeNull();
    expect(lazyImage.calls).toEqual([]);
  });

  it("hides the thumbnail from assistive technology", async () => {
    await renderList([item({ coverAssetId: "asset-1" })]);
    const thumb = host.querySelector('[data-notification-thumb]')!;
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(lazyImage.calls[0]?.alt).toBe("");
  });

  it("keeps dismiss visible, 44px, enabled and in normal Tab order without hovering", async () => {
    await renderList([item()]);
    const dismiss = host.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!;
    expect(dismiss.hasAttribute("hidden")).toBe(false);
    expect(dismiss.disabled).toBe(false);
    expect(dismiss.tabIndex).toBe(0);
    expect(dismiss.className).toContain("size-[44px]");
  });

  it("marks only unread rows with data-unread, and no hover rule exists on the leading rule alone", async () => {
    await renderList([
      item({ id: "unread", readAt: null }),
      item({ id: "read", readAt: "2026-09-14T00:00:00.000Z" }),
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="rail-notification-row"]')];
    const unreadRow = rows.find((row) => row.hasAttribute("data-unread"))!;
    const readRow = rows.find((row) => !row.hasAttribute("data-unread"))!;
    expect(unreadRow.className).toContain("data-[unread]:border-l-primary");
    expect(unreadRow.className).toContain("hover:bg-secondary");
    // Hover tints; it never paints a leading rule of its own — a hovered read row must not look unread.
    expect(readRow.className).not.toMatch(/hover:border-l/);
    expect(readRow.className).toContain("data-[unread]:border-l-primary");
    expect(readRow.hasAttribute("data-unread")).toBe(false);
  });

  it("tones only the two caution types with the caution text token", async () => {
    await renderList([
      item({ id: "stalled", type: "autohdr_stalled" }),
      item({ id: "reminder", type: "project_deadline_reminder" }),
      item({ id: "ordinary", type: "mentioned" }),
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="rail-notification-row"]')];
    const stalledRow = rows.find((row) => row.querySelector('[data-notification-dismiss="stalled"]'))!;
    const ordinaryRow = rows.find((row) => row.querySelector('[data-notification-dismiss="ordinary"]'))!;
    expect(stalledRow.getAttribute("data-notification-tone")).toBe("caution");
    const stalledTitle = stalledRow.querySelector('[data-testid="rail-notification-item"]')!;
    expect(stalledTitle.className).toContain("text-warning");
    expect(stalledTitle.className).not.toContain("text-signal-caution");
    expect(ordinaryRow.getAttribute("data-notification-tone")).toBeNull();
  });

  it("omits the metadata separator when the street is absent", async () => {
    await renderList([item({ projectStreet: null })]);
    const meta = host.querySelector("small")!;
    expect(meta.textContent?.startsWith(" · ")).toBe(false);
    expect(meta.textContent?.includes("·")).toBe(false);
  });

  it("lays out four tracks with thumbnails and three without", async () => {
    await renderList([item()], { showThumbnails: true });
    const withThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withThumb.className).toContain("grid-cols-[28px_minmax(0,1fr)_64px_44px]");

    await renderList([item()], { showThumbnails: false });
    const withoutThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withoutThumb.className).toContain("grid-cols-[28px_minmax(0,1fr)_44px]");
  });
});
