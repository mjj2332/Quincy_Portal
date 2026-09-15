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
    actor: null,
    subject: null,
    assetId: null,
    ...overrides,
  };
}

const NOOP = () => {};

function renderList(items: NotificationListItem[], props: Partial<{ now: number; showThumbnails: boolean; scale: "panel" | "page" }> = {}) {
  const now = props.now ?? new Date("2026-09-15T09:00:00+10:00").getTime();
  const buckets = groupNotifications(items, now);
  // A neutral container: the list renders a `<section>` per bucket, each with its own `<ul>`,
  // so the harness must not add a list element of its own around them.
  return render(
    <div>
      <NotificationList
        buckets={buckets}
        now={now}
        showThumbnails={props.showThumbnails ?? true}
        scale={props.scale ?? "panel"}
        onActivate={NOOP}
        onDismiss={NOOP}
      />
    </div>,
  );
}

/** Each bucket's heading, read through its `aria-labelledby` relationship rather than a tag name. */
function bucketLabels(): (string | null)[] {
  return [...host.querySelectorAll<HTMLElement>("[data-notification-bucket]")].map((section) =>
    document.getElementById(section.getAttribute("aria-labelledby")!)!.textContent);
}

describe("NotificationList", () => {
  it("renders Today, Yesterday and dated headings in bucket order", async () => {
    const now = new Date("2026-09-15T09:00:00+10:00").getTime();
    await renderList([
      item({ id: "a", createdAt: "2026-09-15T01:00:00+10:00" }),
      item({ id: "b", createdAt: "2026-09-14T10:00:00+10:00" }),
      item({ id: "c", createdAt: "2026-09-13T10:00:00+10:00" }),
    ], { now });
    expect(bucketLabels()).toEqual(["Today", "Yesterday", "13 Sep 2026"]);
    expect([...host.querySelectorAll("[data-notification-bucket]")].map((section) => section.getAttribute("data-notification-bucket")))
      .toEqual(["2026-09-15", "2026-09-14", "2026-09-13"]);
  });

  it("keeps a late-evening Sydney notification under Yesterday, not Today", async () => {
    const now = new Date("2026-09-15T00:15:00+10:00").getTime(); // 2026-09-14T14:15:00.000Z
    await renderList([item({ id: "a", createdAt: "2026-09-14T23:30:00+10:00" })], { now });
    expect(bucketLabels()).toEqual(["Yesterday"]);
  });

  it("exposes the title as the link's name, with body and timestamp as sibling row content", async () => {
    await renderList([item({ title: "Row title", body: "Row body" })]);
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const link = row.querySelector<HTMLElement>('[data-testid="rail-notification-item"]')!;
    expect(link.textContent).toBe("Row title");
    const body = row.querySelector<HTMLElement>("[data-notification-body]")!;
    expect(body.textContent).toBe("Row body");
    expect(link.contains(body)).toBe(false);
    expect(link.contains(row.querySelector("[data-notification-meta]"))).toBe(false);
    const time = row.querySelector("[data-notification-meta] time")!;
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
    const rowFor = (id: string) => rows.find((row) => row.querySelector(`[data-notification-dismiss="${id}"]`))!;
    const titleClasses = (row: HTMLElement) => row.querySelector('[data-testid="rail-notification-item"]')!.className.split(/\s+/);
    for (const id of ["stalled", "reminder"]) {
      const row = rowFor(id);
      expect(row.getAttribute("data-notification-tone")).toBe("caution");
      // The `!` is load-bearing for the same reason as `!outline-none` in the component:
      // `tokens/base.css`'s unlayered `a { color: inherit }` beats an ordinary utility, so a bare
      // `text-warning` would lose and a caution link would read as an ordinary row.
      expect(titleClasses(row)).toContain("!text-warning");
      expect(titleClasses(row)).not.toContain("!text-foreground");
      expect(titleClasses(row).some((cls) => cls.includes("text-signal-caution"))).toBe(false);
    }
    const ordinaryRow = rowFor("ordinary");
    expect(ordinaryRow.getAttribute("data-notification-tone")).toBeNull();
    expect(titleClasses(ordinaryRow)).toContain("!text-foreground");
    expect(titleClasses(ordinaryRow)).not.toContain("!text-warning");
  });

  it("omits the metadata separator when the street is absent", async () => {
    await renderList([item({ projectStreet: null })]);
    const meta = host.querySelector("[data-notification-meta]")!;
    expect(meta.textContent?.startsWith(" · ")).toBe(false);
    expect(meta.textContent?.includes("·")).toBe(false);
  });

  it("renders an actor's initials in the leading slot and requests the specific asset over the cover", async () => {
    await renderList([
      item({
        id: "comment",
        title: "Morgan Reyes commented on IMG_0042.jpg",
        actor: { id: "u-1", name: "Morgan Reyes" },
        assetId: "asset-comment",
        coverAssetId: "asset-cover",
      }),
    ]);
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const leading = row.querySelector<HTMLElement>("[data-notification-leading][data-notification-actor]")!;
    expect(leading).not.toBeNull();
    expect(leading.getAttribute("aria-hidden")).toBe("true");
    expect(leading.textContent).toBe("MR");
    expect(lazyImage.calls).toEqual([{ assetId: "asset-comment", alt: "" }]);
    const link = row.querySelector<HTMLElement>('[data-testid="rail-notification-item"]')!;
    expect(link.textContent).toBe("Morgan Reyes commented on IMG_0042.jpg");
  });

  it("shows an actor's initials and falls back to the cover when the row has no specific asset", async () => {
    await renderList([
      item({
        id: "assigned",
        actor: { id: "u-2", name: "Alex Chen" },
        assetId: null,
        coverAssetId: "asset-cover",
      }),
    ]);
    const leading = host.querySelector<HTMLElement>("[data-notification-leading][data-notification-actor]")!;
    expect(leading.textContent).toBe("AC");
    expect(lazyImage.calls).toEqual([{ assetId: "asset-cover", alt: "" }]);
  });

  it("keeps an empty 28px leading slot with no text and no avatar for a system row (actor null)", async () => {
    await renderList([item({ id: "system", actor: null })]);
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const leading = row.firstElementChild as HTMLElement;
    expect(leading.getAttribute("data-notification-leading")).toBe("true");
    expect(leading.hasAttribute("data-notification-actor")).toBe(false);
    expect(leading.textContent).toBe("");
    expect(leading.children.length).toBe(0);
    expect(leading.className).toContain("size-[28px]");
  });

  it("clamps the body to two lines", async () => {
    await renderList([item({ body: "A very long body that should be visually clamped to two lines by CSS." })]);
    const body = host.querySelector<HTMLElement>("[data-notification-body]")!;
    expect(body.className).toContain("line-clamp-[2]");
  });

  it("lays out four tracks with thumbnails and three without", async () => {
    await renderList([item()], { showThumbnails: true, scale: "panel" });
    const withThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withThumb.className).toContain("grid-cols-[28px_minmax(0,1fr)_64px_44px]");

    await renderList([item()], { showThumbnails: false, scale: "panel" });
    const withoutThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withoutThumb.className).toContain("grid-cols-[28px_minmax(0,1fr)_44px]");
  });
});

// #115 — the full-page `/settings/notifications` scale (a later package mounts it); every seam
// this file already covers at `scale="panel"` above must resolve identically here, plus the
// bigger boxes and the page's own rule-form bucket head.
describe("NotificationList — page scale (#115)", () => {
  it("gives the leading slot the page's 32px box and stamps the row with data-notification-scale", async () => {
    await renderList([item()], { scale: "page" });
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    const leading = row.querySelector<HTMLElement>("[data-notification-leading]")!;
    expect(leading.className).toContain("size-[32px]");
    expect(row.getAttribute("data-notification-scale")).toBe("page");
  });

  it("gives the thumbnail a 96×64 box at page scale", async () => {
    await renderList([item({ coverAssetId: "asset-1" })], { scale: "page", showThumbnails: true });
    const thumb = host.querySelector<HTMLElement>("[data-notification-thumb]")!;
    expect(thumb.className).toContain("w-[96px]");
    expect(thumb.className).toContain("h-[64px]");
  });

  it("lays out the page's grid tracks with and without a thumbnail", async () => {
    await renderList([item()], { scale: "page", showThumbnails: true });
    const withThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withThumb.className).toContain("grid-cols-[32px_minmax(0,1fr)_96px_44px]");

    await renderList([item()], { scale: "page", showThumbnails: false });
    const withoutThumb = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(withoutThumb.className).toContain("grid-cols-[32px_minmax(0,1fr)_44px]");
  });

  it("renders a rule-form bucket head at page scale — a hairline span, not the panel's banded strip", async () => {
    await renderList([item()], { scale: "page" });
    const section = host.querySelector<HTMLElement>("[data-notification-bucket]")!;
    const heading = section.querySelector("h3")!;
    expect(heading.className).not.toContain("bg-secondary");
    const rule = heading.querySelector('span[aria-hidden="true"]');
    expect(rule).not.toBeNull();
    expect(rule!.tagName).toBe("SPAN");
    expect(rule!.className).toContain("border-t-");
  });

  it("gives the title, body and meta the page's roomier text sizes", async () => {
    await renderList([item({ title: "Row title", body: "Row body" })], { scale: "page" });
    const link = host.querySelector<HTMLElement>('[data-testid="rail-notification-item"]')!;
    expect(link.className).toContain("text-[length:var(--text-base)]");
    const body = host.querySelector<HTMLElement>("[data-notification-body]")!;
    expect(body.className).toContain("text-sm");
    const meta = host.querySelector<HTMLElement>("[data-notification-meta]")!;
    expect(meta.className).toContain("text-xs");
  });

  it("keeps every existing seam present at page scale too", async () => {
    await renderList([
      item({ id: "with-cover", title: "With cover", coverAssetId: "asset-1", body: "Body copy" }),
    ], { scale: "page", showThumbnails: true });
    const row = host.querySelector<HTMLElement>('[data-testid="rail-notification-row"]')!;
    expect(row.querySelector("[data-notification-leading]")).not.toBeNull();
    expect(row.querySelector('[data-testid="rail-notification-item"]')).not.toBeNull();
    expect(row.querySelector("[data-notification-body]")).not.toBeNull();
    expect(row.querySelector("[data-notification-meta]")).not.toBeNull();
    expect(row.querySelector("[data-notification-thumb]")).not.toBeNull();
    expect(row.querySelector('[data-notification-dismiss="with-cover"]')).not.toBeNull();
    expect(host.querySelector('[role="list"]')).not.toBeNull();
  });
});
