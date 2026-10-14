import { act, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectVideoSelection, VideoDto, VideoReviewPart } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The viewer's side of the video deep link (#819): the Version it opens on, what it reports, Copy link, and that a URL write never remounts it. */
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${ids.asset2}`, posterUrl: null, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, streamUrl: `/media/video/${ids.asset1}` })] }) as unknown as VideoDto;

let stub: VideoElementStub; let viewport: MockViewport;
let root: Root | null = null;
let setSelection: (selection: ProjectVideoSelection | null) => void = () => undefined;
const written: Array<ProjectVideoSelection | null> = [];
let listGate: Promise<void> | null = null;
let videoList: () => VideoDto[] = () => [videoOf()];
let client: QueryClient | null = null;
let listFails = false;
let setShown: (shown: boolean) => void = () => undefined;
const clipboard = vi.fn<(text: string) => Promise<void>>();
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const label = () => tid("video-version-label")?.textContent ?? "";

/** Stands in for the shell: the URL's selection is state, and the panel's writes go to it (and are recorded). */
function Probe() { client = useQueryClient(); return null; }
function Harness({ initial, parts }: { initial: ProjectVideoSelection | null; parts: VideoReviewPart[] }) {
  const [selection, set] = useState<ProjectVideoSelection | null>(initial);
  const [shown, show] = useState(true);
  setSelection = set;
  setShown = show;
  return <QuincyQueryProvider principalId={auth.userId} role="editor"><Probe />{shown && <VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts }} deepLink={{ selection, onChange: (next) => { written.push(next); set(next); } }} />}</QuincyQueryProvider>;
}
async function mount(initial: ProjectVideoSelection | null, parts: VideoReviewPart[] = ["download"]) {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) { await listGate; if (listFails) throw new ApiError("Films could not be loaded.", 400); return { videos: videoList() }; } throw new Error(`unrouted ${path}`); });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Harness initial={initial} parts={parts} />); });
  await flush();
  if (initial) {
    const deadline = Date.now() + 10_000;
    while (!dialog()?.querySelector("video")) { if (Date.now() > deadline) throw new Error("the review player never mounted"); await flush(1); }
    await flush(4);
  }
}
async function chooseVersion(prefix: string) {
  const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(prefix))!;
  await act(async () => { option.click(); }); await flush(8);
}

beforeEach(() => {
  stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); apiGetMock.mockReset(); written.length = 0; listFails = false; listGate = null; videoList = () => [videoOf()];
  clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
});

const linkFor = (version: number) => `${window.location.origin}/projects/${PROJECT}?tab=video&video=${ids.video}&version=${version}`;

describe("the viewer's deep link (#819)", () => {
  it("opens on the Version the URL names, and reports nothing while they agree", async () => {
    await mount({ id: ids.video, version: 1 });
    expect(label()).toMatch(/^v1/);
    expect(written).toEqual([]);
  });

  it("opens on the current Version when the URL names none or an unknown one, and reports the Version shown", async () => {
    await mount({ id: ids.video });
    expect(label()).toMatch(/^v2/);
    expect(written).toEqual([{ id: ids.video, version: 2 }]);
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); written.length = 0;
    await mount({ id: ids.video, version: 9 });
    expect(label()).toMatch(/^v2/);
    expect(written).toEqual([{ id: ids.video, version: 2 }]);
  });

  it("Copy link copies the absolute URL for the Version shown, and follows a Version switch", async () => {
    await mount({ id: ids.video, version: 2 });
    await click(tid("copy-text")!);
    expect(clipboard).toHaveBeenLastCalledWith(linkFor(2));
    await chooseVersion("v1");
    expect(written.at(-1)).toEqual({ id: ids.video, version: 1 });
    await click(tid("copy-text")!);
    expect(clipboard).toHaveBeenLastCalledWith(linkFor(1));
  });

  it("puts Copy link between the Version group and Download, with a touch-sized target (a phone folds it into the ⋯ menu instead: VideoReviewViewer.header.dom.test.tsx)", async () => {
    await mount({ id: ids.video, version: 2 });
    const header = dialog()!.querySelector("header")!;
    const order = [tid("video-version-group")!, tid("copy-text")!, tid("video-download")!];
    for (const [index, element] of order.entries()) {
      expect(element, String(index)).not.toBeNull();
      if (index > 0) expect(order[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.contains(element)).toBe(true);
    }
    expect(tid("copy-text")!.className).toContain("pointer-coarse:min-h-11");
  });

  it("keeps Copy link, Download and Compare together in one right-aligned cluster", async () => {
    await mount({ id: ids.video, version: 2 }, ["download", "compare"]);
    const cluster = tid("video-header-actions");
    expect(cluster).not.toBeNull();
    for (const id of ["copy-text", "video-download", "video-compare-toggle"]) expect(tid(id)!.parentElement, id).toBe(cluster);
    expect(cluster!.className).toContain("ml-auto");
  });

  it("takes a change of the URL's Version once, without writing it back", async () => {
    await mount({ id: ids.video, version: 1 });
    await act(async () => { setSelection({ id: ids.video, version: 2 }); }); await flush(6);
    expect(label()).toMatch(/^v2/);
    expect(written).toEqual([]);
  });

  it("an external change to an omitted Version resolves to the current one and rewrites the URL", async () => {
    await mount({ id: ids.video, version: 1 });
    await act(async () => { setSelection({ id: ids.video }); }); await flush(6);
    expect(label()).toMatch(/^v2/);
    expect(written.at(-1)).toEqual({ id: ids.video, version: 2 });
    // Already on the current Version: the unknown Version is still reported back.
    written.length = 0;
    await act(async () => { setSelection({ id: ids.video, version: 9 }); }); await flush(6);
    expect(label()).toMatch(/^v2/);
    expect(written.at(-1)).toEqual({ id: ids.video, version: 2 });
  });

  it("an external Version change while comparing leaves Compare for that Version", async () => {
    await mount({ id: ids.video, version: 2 }, ["compare"]);
    const video = dialog()!.querySelector("video")!;
    await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); }); await flush(2);
    await click(tid("video-compare-toggle")!);
    const deadline = Date.now() + 10_000;
    while (!tid("video-compare")) { if (Date.now() > deadline) throw new Error("never compared"); await flush(1); }
    await act(async () => { setSelection({ id: ids.video, version: 1 }); }); await flush(8);
    expect(tid("video-compare")).toBeNull();
    expect(label()).toMatch(/^v1/);
  });

  it("a failed refresh over a cached list that lacks the film does not strip the link", async () => {
    videoList = () => [];
    await mount(null);
    expect(client).not.toBeNull();
    await act(async () => { setShown(false); }); await flush(2);
    await act(async () => { await client!.invalidateQueries({ refetchType: "none" }); });
    listFails = true;
    await act(async () => { setSelection({ id: ids.video, version: 1 }); setShown(true); }); await flush(20);
    expect(written).not.toContainEqual(null);
    expect(dialog()).toBeNull();
  });

  it("closing a film returns focus to its own card, not the one the viewer was first opened from", async () => {
    const other = { ...videoOf(), id: "55555555-5555-4555-8555-555555555555", title: "Second", versions: videoOf().versions.map((v) => ({ ...v, assetId: v.assetId === ids.asset2 ? "44444444-4444-4444-8444-444444444441" : "44444444-4444-4444-8444-444444444442" })), currentAssetId: "44444444-4444-4444-8444-444444444441" } as VideoDto;
    videoList = () => [videoOf(), other];
    await mount(null);
    const cardA = document.querySelector<HTMLElement>(`[data-testid="video-card-open"][data-video-id="${ids.video}"]`)!;
    await click(cardA);
    const deadline = Date.now() + 10_000;
    while (!dialog()?.querySelector("video")) { if (Date.now() > deadline) throw new Error("the review player never mounted"); await flush(1); }
    await act(async () => { setSelection({ id: other.id, version: 2 }); }); await flush(8);
    const close = [...dialog()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
    await click(close); await flush(8);
    const cardB = document.querySelector<HTMLElement>(`[data-testid="video-card-open"][data-video-id="${other.id}"]`)!;
    expect(document.activeElement).toBe(cardB);
  });

  describe("a Version the cached list lacks while a refresh is in flight", () => {
    const asset3 = "33333333-3333-4333-8333-333333333333";
    const withV3 = (): VideoDto => { const base = videoOf(); return { ...base, currentAssetId: asset3, versions: [versionOf({ assetId: asset3, version: 3, current: true, streamUrl: `/media/video/${asset3}` }), ...base.versions.map((v) => ({ ...v, current: false }))] } as VideoDto; };
    async function openOnStaleCache(refreshed: () => VideoDto[], opts: { cached?: () => VideoDto[]; version?: number; parts?: VideoReviewPart[] } = {}) {
      if (opts.cached) videoList = opts.cached;
      await mount(null, opts.parts);
      await act(async () => { setShown(false); }); await flush(2);
      await act(async () => { await client!.invalidateQueries({ refetchType: "none" }); });
      let release!: () => void;
      listGate = new Promise<void>((resolve) => { release = resolve; });
      videoList = refreshed;
      await act(async () => { setSelection({ id: ids.video, version: opts.version ?? 3 }); setShown(true); }); await flush(6);
      return release;
    }
    const withVersions = (count: number): VideoDto => {
      const all = [1, 2, 3, 4].slice(0, count).map((n) => versionOf({ assetId: `33333333-3333-4333-8333-33333333333${n}`, version: n, current: n === count, streamUrl: `/media/video/${n}` }));
      return { ...videoOf(), currentAssetId: all.at(-1)!.assetId, versions: all.reverse() } as VideoDto;
    };
    const settleOn = async (predicate: () => boolean, what: string) => { const deadline = Date.now() + 10_000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`never ${what} (${label()}; ${JSON.stringify(written)})`); await flush(1); } await flush(4); };
    it.each([["v9", { id: ids.video, version: 9 }], ["an omitted Version", { id: ids.video }]])("a refresh in flight while the URL moves to %s: the settled read's current Version is shown and written", async (_name, next) => {
      videoList = () => [{ ...videoOf(), currentAssetId: ids.asset1, versions: [{ ...videoOf().versions[1]!, current: true }] } as VideoDto];
      await mount({ id: ids.video, version: 1 });
      let release!: () => void;
      listGate = new Promise<void>((resolve) => { release = resolve; });
      videoList = () => [videoOf()];
      await act(async () => { void client!.invalidateQueries(); }); await flush(4);
      await act(async () => { setSelection(next); }); await flush(6);
      expect(written).toEqual([]);
      await act(async () => { release(); });
      await settleOn(() => written.length > 0, "wrote");
      expect(written.at(-1)).toEqual({ id: ids.video, version: 2 });
      expect(label()).toMatch(/^v2/);
    });
    it("a refresh that changes the current Version re-resolves an omitted Version to the new one", async () => {
      videoList = () => [withVersions(2)];
      await mount(null);
      let release!: () => void;
      listGate = new Promise<void>((resolve) => { release = resolve; });
      videoList = () => [withVersions(3)];
      await act(async () => { void client!.invalidateQueries(); }); await flush(4);
      await act(async () => { setSelection({ id: ids.video }); }); await flush(6);
      expect(label()).toMatch(/^v2/);
      expect(written).toEqual([]);
      await act(async () => { release(); });
      await settleOn(() => written.length > 0, "wrote");
      expect(written.at(-1)).toEqual({ id: ids.video, version: 3 });
      expect(label()).toMatch(/^v3/);
    });
    it("Compare side A changed during a refresh stays the reviewer's pick when the refresh returns the requested Version", async () => {
      const release = await openOnStaleCache(() => [withVersions(4)], { cached: () => [withVersions(3)], version: 4, parts: ["compare"] });
      const video = dialog()!.querySelector("video")!;
      await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
      await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); }); await flush(2);
      await click(tid("video-compare-toggle")!);
      await settleOn(() => tid("video-compare-select-a") !== null, "compared");
      const trigger = tid("video-compare-select-a")!;
      await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
      await flush(6);
      await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith("v1"))!.click(); }); await flush(8);
      expect(written.at(-1)).toEqual({ id: ids.video, version: 1 });
      await act(async () => { release(); }); await flush(10);
      expect(written.at(-1)).toEqual({ id: ids.video, version: 1 });
      expect(tid("video-compare")).not.toBeNull();
      expect(tid("video-compare-select-a")!.textContent).toMatch(/v1/);
    });
    it("keeps the requested Version in the URL, and shows it once the settled read has it", async () => {
      const release = await openOnStaleCache(() => [withV3()]);
      expect(written).toEqual([]);
      await act(async () => { release(); });
      const deadline = Date.now() + 10_000;
      while (!label().startsWith("v3")) { if (Date.now() > deadline) throw new Error(`never showed v3 (${label()})`); await flush(1); }
      await flush(4);
      expect(written).toEqual([]);
    });
    it("normalises to the current Version when the settled read still lacks it", async () => {
      const release = await openOnStaleCache(() => [videoOf()]);
      expect(written).toEqual([]);
      await act(async () => { release(); });
      const deadline = Date.now() + 10_000;
      while (written.length === 0) { if (Date.now() > deadline) throw new Error("never normalised"); await flush(1); }
      expect(written.at(-1)).toEqual({ id: ids.video, version: 2 });
      expect(label()).toMatch(/^v2/);
    });
  });

  it("is not remounted by a URL write", async () => {
    await mount({ id: ids.video, version: 2 });
    const viewer = tid("video-review-viewer");
    expect(viewer).not.toBeNull();
    await chooseVersion("v1");
    await act(async () => { setSelection({ id: ids.video, version: 2 }); }); await flush(6);
    await act(async () => { setSelection({ id: ids.video, version: 1 }); }); await flush(6);
    expect(tid("video-review-viewer")).toBe(viewer);
    expect(viewer!.isConnected).toBe(true);
  });

  it("offers no Copy link without a deepLink (harness and other callers)", async () => {
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: [] }} /></QuincyQueryProvider>); });
    await flush();
    const open = tid("video-card-open")!;
    await click(open);
    const deadline = Date.now() + 10_000;
    while (!dialog()?.querySelector("video")) { if (Date.now() > deadline) throw new Error("the review player never mounted"); await flush(1); }
    expect(tid("copy-text")).toBeNull();
  });
});
