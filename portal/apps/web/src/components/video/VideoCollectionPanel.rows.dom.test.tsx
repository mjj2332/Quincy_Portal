import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { USER, all, flush, id, mia, mount, press, q, refused, state, unmount, videoOf } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/**
 * #938: the staff Video tab's list layout, driven through the panel the way a person meets it: the Tiles / List switch in the toolbar (kept in the per-person video-grid preference),
 * a Video row per film with the facts of its newest live Version, opening the review as a tile does, the toolbar's sort and filter over the rows, and the phone's two-line rows.
 * The row's presentation API is pinned in `components/quincy/VideoRows.dom.test.tsx`.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" as string | null }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: auth.userId ? { user: { id: auth.userId, role: "editor" } } : null, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

const sam = { id: id(902), name: "Sam Okafor", roleLabel: "Editor", isExternal: false, active: true };
/** Two Versions; the current (v2) was uploaded by Sam on `at`, the older (v1) by Mia. */
const film = (n: number, title: string, over: { status?: VideoDto["reviewStatus"]; at?: string; notes?: number | null; durationMs?: number } = {}): VideoDto => {
  const base = videoOf(id(500 + n), title, [[id(600 + n), 2, true], [id(700 + n), 1, false]]);
  return {
    ...base, reviewStatus: over.status ?? "in_review", latestNoteCount: over.notes ?? null,
    versions: base.versions.map((v) => v.current
      ? { ...v, createdAt: over.at ?? "2026-10-09T01:00:00.000Z", uploadedBy: sam, durationMs: over.durationMs ?? 92_000, hasPoster: true, posterUrl: `/media/video/${v.assetId}/poster` }
      : { ...v, createdAt: "2026-01-01T00:00:00.000Z", uploadedBy: mia, durationMs: 10_000 }),
  } as VideoDto;
};
const KITCHEN = film(1, "Kitchen walkthrough", { at: "2026-10-05T00:00:00.000Z", notes: 3 });
const TEASER = film(2, "Teaser", { at: "2026-10-07T00:00:00.000Z", status: "published", durationMs: 3_725_000 });
const ALPHA = film(3, "Alpha", { at: "2026-10-03T00:00:00.000Z", status: "approved_internal" });

const KEY = `quincy:ui:video-grid:${USER}`;
const tid = (testId: string) => q(`[data-testid="${testId}"]`);
const rows = () => all('[data-testid="video-row"]');
const rowTitles = () => rows().map((row) => row.querySelector('[data-testid="video-row-open"]')?.textContent);
const rowOpen = (title: string) => all<HTMLButtonElement>('[data-testid="video-row-open"]').find((b) => b.textContent === title)!;
const viewer = () => q('[role="dialog"]');
async function chooseList() { await press(tid("video-layout-rows")); }
async function waitForViewer() {
  const deadline = Date.now() + 10_000; // the lazy viewer chunk: wait on the clock, not a tick count
  while (!viewer()) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); }
  await flush(4);
}
async function key(k: string, target: Element) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
}
async function pickOption(testId: string, label: string) {
  const trigger = tid(testId)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = all('[role="option"]').find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}

let storage: ReturnType<typeof installLocalStorageShim>;
let stub: VideoElementStub;
let viewport: MockViewport | null = null;
beforeEach(() => {
  storage = installLocalStorageShim(); resetUiPrefMemory(); auth.userId = USER; stub = installVideoElementStub();
  state.links = []; state.videos = [KITCHEN, TEASER, ALPHA];
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { await unmount(); viewport?.restore(); viewport = null; resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the Tiles / List switch", () => {
  it("starts on tiles, switches to Video rows and back, and keeps the choice in the person's video-grid preference", async () => {
    await mount();
    const group = tid("video-layout-toggle")!;
    expect(group.closest('[data-testid="video-grid-toolbar"]')).not.toBeNull();
    expect(group.getAttribute("aria-label")).toBe("Layout");
    expect(all('[data-testid="video-card"]')).toHaveLength(3);
    expect(tid("video-rows")).toBeNull();
    await chooseList();
    expect(all('[data-testid="video-card"]')).toHaveLength(0);
    expect(rows()).toHaveLength(3);
    expect(JSON.parse(storage.values.get(KEY)!)).toMatchObject({ layout: "rows", sort: "uploaded", dir: "desc", status: "all" });
    // A fresh mount (another visit) comes back on the list.
    await unmount(); resetUiPrefMemory();
    await mount();
    expect(rows()).toHaveLength(3);
    await press(tid("video-layout-tiles"));
    expect(all('[data-testid="video-card"]')).toHaveLength(3);
    expect(JSON.parse(storage.values.get(KEY)!).layout).toBe("tiles");
  });

  it("signed out, the choice stands for this mount and writes nothing", async () => {
    auth.userId = null;
    await mount();
    await chooseList();
    expect(rows()).toHaveLength(3);
    expect([...storage.values.keys()].filter((k) => k.startsWith("quincy:ui:video-grid"))).toEqual([]);
  });
});

describe("the Video rows", () => {
  beforeEach(() => { storage.values.set(KEY, JSON.stringify({ layout: "rows" })); });

  it("show each film's poster, title and Version, status, open notes, duration, upload date and uploader, all of its newest live Version", async () => {
    await mount();
    expect(tid("video-rows")!.getAttribute("aria-label")).toBe("Films");
    // #939 adds the tick (Review link selection is on here) and the "⋯" columns at the ends; their own cases are in VideoCollectionPanel.row-actions.dom.test.tsx.
    expect([...document.querySelectorAll("th")].map((th) => th.textContent?.trim())).toEqual(["Select", "Poster", "Title", "Status", "Notes", "Duration", "Uploaded", "Uploader", "Actions"]);
    const kitchen = rows().find((row) => row.textContent?.includes("Kitchen walkthrough"))!;
    expect(kitchen.getAttribute("data-video-id")).toBe(KITCHEN.id);
    const cells = [...kitchen.querySelectorAll("td")].slice(1, -1);
    expect(cells[0]!.querySelector("img")!.getAttribute("src")).toBe(`/media/video/${id(601)}/poster`);
    expect(cells[1]!.textContent).toContain("v2");
    expect(cells[2]!.textContent).toContain("In review");
    expect(cells[3]!.textContent).toContain("3 open notes on v2");
    expect(cells[4]!.textContent).toBe("1:32");
    expect(cells[5]!.textContent).toBe("5 Oct 2026");
    expect(cells[6]!.textContent).toContain("Sam Okafor");
    expect(cells[6]!.textContent).not.toContain("Mia Chen");
    expect(cells[6]!.querySelector('[data-testid="initials-avatar"]')!.textContent).toBe("SO");
    const teaser = rows().find((row) => row.textContent?.includes("Teaser"))!;
    expect([...teaser.querySelectorAll("td")][5]!.textContent).toBe("1:02:05");
    expect([...teaser.querySelectorAll("td")][3]!.textContent).toContain("Published");
  });

  it("the row's open control is the film's title with the tile's summary as its description, and its title carries the full-title tooltip", async () => {
    await mount();
    const open = rowOpen("Kitchen walkthrough");
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("data-video-id")).toBe(KITCHEN.id);
    expect(open.hasAttribute("data-title-text")).toBe(true);
    expect(document.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("v2, 1:32, 3 open notes on v2, In review");
    Object.defineProperty(open, "scrollWidth", { configurable: true, get: () => 420 });
    Object.defineProperty(open, "clientWidth", { configurable: true, get: () => 180 });
    await act(async () => { open.focus(); await Promise.resolve(); });
    const deadline = Date.now() + 1000;
    while (q('[data-testid="truncated-title-tip"]')?.textContent !== "Kitchen walkthrough") {
      if (Date.now() > deadline) throw new Error("no title tooltip");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  });

  it("a click opens the review on the newest Version, and closing it returns focus to that row's open control", async () => {
    await mount();
    const open = rowOpen("Teaser");
    open.focus();
    await press(open);
    await waitForViewer();
    expect(document.getElementById(viewer()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Teaser");
    expect(viewer()!.querySelector("video")!.getAttribute("src")).toBe(`/media/video/${id(602)}`);
    await key("Escape", viewer()!);
    await flush(12);
    expect(viewer()).toBeNull();
    expect(document.activeElement).toBe(rowOpen("Teaser"));
  });

  it("Enter on the open control opens the review too", async () => {
    await mount();
    const open = rowOpen("Alpha");
    open.focus();
    // A native button turns Enter into a click; the DOM does not, so the test sends both as a browser would.
    await key("Enter", open);
    await press(open);
    await waitForViewer();
    expect(document.getElementById(viewer()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Alpha");
  });

  it("follow the toolbar's sort and Review status filter, as the tiles do", async () => {
    await mount();
    expect(rowTitles()).toEqual(["Teaser", "Kitchen walkthrough", "Alpha"]);
    await pickOption("video-grid-sort", "Name");
    expect(rowTitles()).toEqual(["Alpha", "Kitchen walkthrough", "Teaser"]);
    await pickOption("video-grid-status", "Published");
    expect(rowTitles()).toEqual(["Teaser"]);
    expect(tid("video-grid-count")!.textContent).toBe("Showing 1 of 3 films");
  });

  it("a filter that matches nothing shows the same empty state as the tiles, with no list", async () => {
    state.videos = [KITCHEN];
    await mount();
    await pickOption("video-grid-status", "Published");
    expect(tid("video-rows")).toBeNull();
    expect(document.body.textContent).toContain("No films match this filter.");
  });

  it("no films: the same empty state, and no switch", async () => {
    state.videos = [];
    await mount();
    expect(tid("video-layout-toggle")).toBeNull();
    expect(tid("video-rows")).toBeNull();
    expect(document.body.textContent).toContain("No films yet.");
  });

  it("a list that fails to load shows the same error and Retry, and no list", async () => {
    apiGetMock.mockImplementation(async (path) => {
      if (path.endsWith("/review-links")) return { links: [] };
      throw refused(400, { error: "Films could not be loaded." });
    });
    await mount();
    await flush(20);
    expect(tid("video-rows")).toBeNull();
    expect(q('[role="alert"]')?.textContent).toContain("Films could not be loaded.");
  });
});

describe("the Video rows on a phone", () => {
  beforeEach(() => { storage.values.set(KEY, JSON.stringify({ layout: "rows" })); });

  it("are two-line rows: poster, title, then Version · duration · status; no uploader, date or notes", async () => {
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
    await mount();
    expect(q('[data-testid="video-rows"] table')).toBeNull();
    const kitchen = rows().find((row) => row.textContent?.includes("Kitchen walkthrough"))!;
    expect(kitchen.tagName).toBe("LI");
    expect(kitchen.querySelector("img")).not.toBeNull();
    expect(kitchen.querySelector('[data-testid="video-row-meta"]')!.textContent).toBe("v2 · 1:32 · In review");
    expect(kitchen.textContent).not.toContain("Sam Okafor");
    expect(kitchen.textContent).not.toContain("5 Oct 2026");
  });
});
