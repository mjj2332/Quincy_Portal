import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import "../../testing/dom-polyfills";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoReviewViewer } from "./VideoReviewViewer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The review viewer's one-line top bar (#877 S2): the title truncates, and a phone folds Copy link / Download / Create Review link into one ⋯ menu. */
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/clipboard", () => ({ copyText: copyMock }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${ids.asset2}`, posterUrl: null, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, streamUrl: `/media/video/${ids.asset1}` })] }) as unknown as VideoDto;

let stub: VideoElementStub; let viewport: MockViewport; let shim: ReturnType<typeof installLocalStorageShim>;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 6) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const onCreate = vi.fn();
async function mount(props: { deepLink?: boolean; download?: boolean; reviewLinks?: boolean } = {}) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoReviewViewer
      video={videoOf()}
      onClose={() => {}}
      {...(props.deepLink ? { deepLink: { settled: true, href: (v: number) => `https://quincy.test/p/${PROJECT}?v=${v}`, onVersionShown: () => {} } } : {})}
      {...(props.download ? { download: { projectId: PROJECT } } : {})}
      {...(props.reviewLinks ? { reviewLinks: { onCreate } } : {})}
    /></QuincyQueryProvider>);
  });
  await flush();
}
const trigger = () => tid("video-header-menu");
async function openMenu() {
  await act(async () => { trigger()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger()!.click(); });
  await flush(6);
}

beforeEach(() => {
  shim = installLocalStorageShim(); resetUiPrefMemory();
  stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); copyMock.mockReset(); onCreate.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); viewport.restore(); shim.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("the one-line top bar (#877 S2)", () => {
  it("is one non-wrapping row: the title truncates and still names the dialog, and the start-TC description is gone", async () => {
    await mount();
    const header = document.querySelector<HTMLElement>('[data-testid="video-review-viewer"] header')!;
    expect(header.className).toContain("flex-nowrap");
    const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = document.getElementById(popup.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Main walkthrough");
    expect(title.className).toContain("truncate");
    expect(title.getAttribute("title")).toBe("Main walkthrough");
    expect(popup.hasAttribute("aria-describedby")).toBe(false);
    expect(tid("video-start-tc")).toBeNull();
  });

  it("desktop keeps Copy link, Download and Create Review link inline, with no ⋯ menu", async () => {
    await mount({ deepLink: true, download: true, reviewLinks: true });
    expect(trigger()).toBeNull();
    expect(tid("copy-text")).not.toBeNull();
    expect(tid("video-download")).not.toBeNull();
    expect(tid("video-create-review-link")).not.toBeNull();
  });

  describe("on a phone", () => {
    beforeEach(() => { viewport.restore(); viewport = mockViewport({ width: 390 }); });

    it("folds the three into one ⋯ menu, none inline", async () => {
      await mount({ deepLink: true, download: true, reviewLinks: true });
      expect(tid("copy-text")).toBeNull();
      expect(tid("video-download")).toBeNull();
      expect(tid("video-create-review-link")).toBeNull();
      expect(trigger()!.getAttribute("aria-label")).toBe("Video actions");
      await openMenu();
      expect(tid("video-menu-copy-link")).not.toBeNull();
      const link = tid("video-download") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(videoVersionDownloadUrl(PROJECT, ids.asset2));
      expect(link.hasAttribute("download")).toBe(true);
      expect(tid("video-create-review-link")).not.toBeNull();
    });

    it("Copy link copies the Version's link; Create Review link hands over the Version on screen", async () => {
      await mount({ deepLink: true, reviewLinks: true });
      await openMenu();
      await act(async () => { tid("video-menu-copy-link")!.click(); });
      expect(copyMock).toHaveBeenCalledWith(`https://quincy.test/p/${PROJECT}?v=2`);
      await openMenu();
      await act(async () => { tid("video-create-review-link")!.click(); });
      expect(onCreate).toHaveBeenCalledWith(ids.asset2);
    });

    it("Create Review link does not hand focus back to the ⋯ trigger (the dialog it opens owns focus)", async () => {
      await mount({ reviewLinks: true });
      // The links dialog takes focus when it opens; stand in for it with the viewer popup itself (a node outside the modal dialog could not hold focus).
      onCreate.mockImplementation(() => { document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]')!.focus(); });
      await openMenu();
      await act(async () => { tid("video-create-review-link")!.click(); });
      await flush(6);
      expect(document.activeElement).not.toBe(trigger());
    });

    it("control: Copy link, which opens nothing, gives focus back to the ⋯ trigger", async () => {
      await mount({ deepLink: true });
      await openMenu();
      await act(async () => { tid("video-menu-copy-link")!.click(); });
      await flush(6);
      expect(document.activeElement).toBe(trigger());
    });

    it("each item keeps its own condition, and the trigger is absent when nothing is allowed", async () => {
      await mount({ download: true });
      await openMenu();
      expect(tid("video-menu-copy-link")).toBeNull();
      expect(tid("video-create-review-link")).toBeNull();
      expect(tid("video-download")).not.toBeNull();
      await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
      await mount();
      expect(trigger()).toBeNull();
    });
  });
});
