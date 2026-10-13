import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { USER, all, flush, id, mount, press, q, state, unmount, videoOf } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #865: the Video collection's toolbar (Appearance, Sort, Status filter), driven through the panel the way a person meets it. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" as string | null }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: auth.userId ? { user: { id: auth.userId, role: "editor" } } : null, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

const film = (n: number, title: string, over: { status?: VideoDto["reviewStatus"]; at?: string; older?: string } = {}): VideoDto => {
  const base = videoOf(id(500 + n), title, [[id(600 + n), 2, true], [id(700 + n), 1, false]]);
  const at = over.at ?? "2026-10-09T01:00:00.000Z";
  return { ...base, reviewStatus: over.status ?? "in_review", versions: base.versions.map((v) => ({ ...v, createdAt: v.current ? at : over.older ?? "2026-01-01T00:00:00.000Z", hasPoster: true, posterUrl: `/media/video/${v.assetId}/poster` })) } as VideoDto;
};
const OLD_RECUT = film(1, "Film 10", { at: "2026-10-01T00:00:00.000Z", older: "2026-12-30T00:00:00.000Z" });
const NEWEST = film(2, "Film 2", { at: "2026-10-05T00:00:00.000Z", status: "published" });
const MIDDLE = film(3, "Alpha", { at: "2026-10-03T00:00:00.000Z", status: "approved_internal" });
const titles = () => all('[data-testid="video-card"]').map((card) => card.querySelector("h3")?.textContent);
const tid = (testId: string) => q(`[data-testid="${testId}"]`);
let storage: ReturnType<typeof installLocalStorageShim>;
const KEY = `quincy:ui:video-grid:${USER}`;

async function openSelect(testId: string) {
  const trigger = tid(testId)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
}
async function pickOption(testId: string, label: string) {
  await openSelect(testId);
  const option = all('[role="option"]').find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}
async function openAppearance() { await press(tid("video-grid-appearance")); await flush(4); }

beforeEach(() => {
  storage = installLocalStorageShim(); resetUiPrefMemory(); auth.userId = USER;
  state.links = []; state.videos = [OLD_RECUT, NEWEST, MIDDLE];
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the toolbar", () => {
  it("is absent with no films", async () => {
    state.videos = [];
    await mount();
    expect(tid("video-grid-toolbar")).toBeNull();
    expect(q("h3")).toBeNull();
  });

  it("sorts by upload date, newest first, by the latest live Version (a re-cut old film does not rise on an older Version's date)", async () => {
    await mount();
    expect(titles()).toEqual(["Film 2", "Alpha", "Film 10"]);
  });

  it("sorts by name with numbers in order, and flips direction explicitly", async () => {
    await mount();
    await pickOption("video-grid-sort", "Name");
    await pickOption("video-grid-sort", "Name");
    expect(titles()).toEqual(["Alpha", "Film 2", "Film 10"]);
    await press(tid("video-grid-dir"));
    expect(titles()).toEqual(["Film 10", "Film 2", "Alpha"]);
    expect(tid("video-grid-dir")!.getAttribute("aria-label")).toMatch(/Z.A|A.Z/);
  });

  it("sorts by Review status: In review, Approved (internal), Published", async () => {
    await mount();
    await pickOption("video-grid-sort", "Review status");
    await press(tid("video-grid-dir"));
    const first = titles();
    await press(tid("video-grid-dir"));
    const second = titles();
    expect([first, second]).toContainEqual(["Film 10", "Alpha", "Film 2"]);
  });

  it.each([["In review", ["Film 10"]], ["Approved (internal)", ["Alpha"]], ["Published", ["Film 2"]]] as const)("filters to %s and says how many are shown", async (label, expected) => {
    await mount();
    await pickOption("video-grid-status", label);
    expect(titles()).toEqual(expected);
    expect(tid("video-grid-count")!.textContent).toBe("Showing 1 of 3 films");
    await press(tid("video-grid-show-all"));
    expect(titles()).toHaveLength(3);
    expect(tid("video-grid-count")).toBeNull();
  });

  it("explains a filter that matches nothing and offers Show all films", async () => {
    state.videos = [NEWEST];
    await mount();
    await pickOption("video-grid-status", "In review");
    expect(titles()).toEqual([]);
    expect(q("[data-testid=\"video-collection-body\"]")!.textContent).toContain("No films match this filter.");
    expect(q("[data-testid=\"video-collection-body\"]")!.textContent).not.toContain("No films yet.");
    await press(tid("video-grid-show-all"));
    expect(titles()).toEqual(["Film 2"]);
  });
});

describe("appearance", () => {
  it("sets the card size (Small 240, Medium 320, Large 480)", async () => {
    await mount();
    const grid = () => tid("video-card-grid")!;
    expect(grid().getAttribute("data-size")).toBe("M");
    await openAppearance();
    await press(tid("video-grid-size-S"));
    expect(grid().getAttribute("data-size")).toBe("S");
    await press(tid("video-grid-size-L"));
    expect(grid().getAttribute("data-size")).toBe("L");
  });

  it("swaps only object-fit for Fit and Fill", async () => {
    await mount();
    const poster = () => q("[data-testid=\"video-card\"] img")!;
    expect(poster().className).toContain("object-contain");
    await openAppearance();
    await press(tid("video-grid-thumb-fill"));
    expect(poster().className).toContain("object-cover");
    expect(poster().className).not.toContain("object-contain");
    await press(tid("video-grid-thumb-fit"));
    expect(poster().className).toContain("object-contain");
  });

  it("hides descriptive text with card info off, keeping title, pill, Open review and the poster badges", async () => {
    await mount();
    const card = () => q("[data-testid=\"video-card\"]")!;
    expect(card().querySelector('[data-testid="video-card-meta"]')).not.toBeNull();
    await openAppearance();
    await press(tid("video-grid-info"));
    expect(card().querySelector('[data-testid="video-card-meta"]')).toBeNull();
    expect(card().querySelector('[data-testid="video-card-versions-row"]')).toBeNull();
    expect(card().querySelector("h3")).not.toBeNull();
    expect(card().querySelector('[data-testid="video-card-review-status"]')).not.toBeNull();
    expect(card().querySelector('[data-testid="video-card-open"]')).not.toBeNull();
    expect(card().querySelector('[data-testid="video-card-poster"]')!.textContent).toContain("v2");
  });
});

describe("persistence", () => {
  async function choose() { await pickOption("video-grid-status", "Published"); await openAppearance(); await press(tid("video-grid-size-L")); }

  it("restores the choices on a fresh mount, per person", async () => {
    await mount(); await choose();
    expect(JSON.parse(storage.values.get(KEY)!)).toMatchObject({ status: "published", size: "L" });
    await unmount();
    await mount();
    expect(titles()).toEqual(["Film 2"]);
    expect(tid("video-card-grid")!.getAttribute("data-size")).toBe("L");
    await unmount();
    auth.userId = "55555555-5555-4555-8555-555555555555";
    await mount();
    expect(titles()).toHaveLength(3);
    expect(tid("video-card-grid")!.getAttribute("data-size")).toBe("M");
  });

  it("writes nothing until the person is known", async () => {
    auth.userId = null;
    await mount();
    await pickOption("video-grid-status", "Published");
    expect([...storage.values.keys()].filter((k) => k.includes("video-grid"))).toEqual([]);
  });

  it("falls back to defaults on junk JSON", async () => {
    storage.values.set(KEY, "{not json");
    await mount();
    expect(titles()).toHaveLength(3);
    expect(tid("video-card-grid")!.getAttribute("data-size")).toBe("M");
  });

  it("keeps working in memory when storage is blocked", async () => {
    storage.restore(); storage = installLocalStorageShim({ blockWrites: true });
    await mount();
    await pickOption("video-grid-status", "Published");
    expect(titles()).toEqual(["Film 2"]);
  });
});
