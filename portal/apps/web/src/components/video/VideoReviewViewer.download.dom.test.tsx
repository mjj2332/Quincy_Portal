import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoVersionDownloadUrl, type Role, type VideoDto, type VideoReviewPart } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Staff Version download (#818): the viewer's Download anchor, its Part and capability gate, and its life across Version switches and Compare. */
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${ids.asset2}`, posterUrl: null, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, streamUrl: `/media/video/${ids.asset1}` })] }) as unknown as VideoDto;

let stub: VideoElementStub; let viewport: MockViewport;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const playerVideo = () => dialog()?.querySelector("video") ?? null;
async function mount(parts: VideoReviewPart[], role: Role = "editor") {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts }} /></QuincyQueryProvider>); });
  await flush();
}
async function openViewer() {
  const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Open review")!;
  open.focus(); await click(open);
  const deadline = Date.now() + 10_000;
  while (!playerVideo()) { if (Date.now() > deadline) throw new Error("the review player never mounted"); await flush(1); }
  await flush(4);
}
async function chooseVersion(prefix: string) {
  const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(prefix))!;
  await act(async () => { option.click(); }); await flush(8);
}

beforeEach(() => {
  stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); apiGetMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("the viewer's Download control (#818)", () => {
  it("is a download anchor to the shown Version's route, labelled with the Version number", async () => {
    await mount(["download"]); await openViewer();
    const link = tid("video-download") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(videoVersionDownloadUrl(PROJECT, ids.asset2));
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("aria-label")).toBe("Download version 2");
    expect(link.textContent).toContain("Download");
    expect(link.className).toContain("pointer-coarse:min-h-11");
    expect(link.className).not.toContain("max-[721px]:hidden");
  });

  it("follows the Version switch", async () => {
    await mount(["download"]); await openViewer();
    await chooseVersion("v1");
    const link = tid("video-download") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(videoVersionDownloadUrl(PROJECT, ids.asset1));
    expect(link.getAttribute("aria-label")).toBe("Download version 1");
  });

  it("is absent when the part is off, and for a role without the capability", async () => {
    await mount(["notes"]); await openViewer();
    expect(tid("video-download")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount(["download"], "photographer"); await openViewer();
    expect(tid("video-download")).toBeNull();
  });

  it("stays visible on a phone", async () => {
    await viewport.set({ width: 390 });
    await mount(["download"]); await openViewer();
    expect(tid("video-download")).not.toBeNull();
  });

  it("is hidden while comparing and back in the single view", async () => {
    await mount(["download", "compare"]); await openViewer();
    const video = playerVideo()!;
    await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); }); await flush(2);
    expect(tid("video-download")).not.toBeNull();
    await click(tid("video-compare-toggle")!);
    const deadline = Date.now() + 10_000;
    while (!tid("video-compare")) { if (Date.now() > deadline) throw new Error("never compared"); await flush(1); }
    expect(tid("video-download")).toBeNull();
    await click(tid("video-compare-toggle")!); await flush(4);
    expect(tid("video-download")).not.toBeNull();
  });
});
