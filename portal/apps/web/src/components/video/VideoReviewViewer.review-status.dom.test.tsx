import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { ProjectSheet } from "../quincy/ProjectSheet";
import "../../testing/dom-polyfills";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import { VideoReviewStatusPill } from "./VideoReviewStatusPill";
import { ApiError } from "../../lib/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, reviewStatus: "in_review", uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 30000, den: 1001 }, tcNominalFps: 30, tcDropFrame: true, startTimecodeFrames: null, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;


let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const withStatus = (video: VideoDto, over: Partial<VideoDto> & { stored?: Record<string, "in_review" | "approved_internal"> } = {}): VideoDto => {
  const { stored, ...rest } = over;
  return { ...video, ...rest, versions: video.versions.map((v) => ({ ...v, reviewStatus: stored?.[v.assetId] ?? v.reviewStatus })) } as VideoDto;
};
let current: VideoDto = videoOf();
async function mount(role: Role = "editor", { archived = false, video = current }: { archived?: boolean; video?: VideoDto } = {}) {
  current = video;
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [current] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  void archived;
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: [] }} {...(archived ? { archived: true } : {})} /></QuincyQueryProvider>); });
  await flush();
}
const openButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Open review")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function openViewer() {
  await act(async () => { openButton().click(); });
  const deadline = Date.now() + 10_000;
  while (!dialog()) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); }
  await flush(6);
}
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pill = () => tid("video-review-status");
const options = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="video-review-status-option-"]')];
const optionOf = (status: string) => tid(`video-review-status-option-${status}`);
async function openMenu() { await act(async () => { pill()!.click(); await Promise.resolve(); }); await flush(3); }

beforeEach(() => { stub = installVideoElementStub(); apiGetMock.mockReset(); apiPutMock.mockReset(); current = videoOf(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the Review status pill in the viewer header (#863)", () => {
  it.each([
    ["In review", { reviewStatus: "in_review" }],
    ["Approved (internal)", { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } }],
    ["Published", { reviewStatus: "published" }],
  ] as const)("labels the Video %s", async (label, over) => {
    await mount("admin", { video: withStatus(videoOf(), over as never) });
    await openViewer();
    expect(pill()!.textContent).toContain(label);
    expect(dialog()!.contains(pill())).toBe(true);
  });

  it("says which older Version is published beside a Video that is not", async () => {
    await mount("admin", { video: withStatus(videoOf(), { olderPublishedVersion: 1 }) });
    await openViewer();
    expect(pill()!.textContent).toContain("In review");
    expect(tid("video-review-status-older")!.textContent).toBe("v1 published");
  });

  it("offers an Admin both statuses under the latest Version, with the current one checked", async () => {
    await mount("admin", { video: withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } }) });
    await openViewer(); await openMenu();
    expect(options().map((o) => o.textContent)).toEqual(["In review", "Approved (internal)"]);
    expect(optionOf("approved_internal")!.getAttribute("aria-checked")).toBe("true");
    expect(optionOf("in_review")!.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Latest v2");
  });

  it("offers an External only In review: Approved (internal) is absent, not disabled", async () => {
    await mount("external_editor", { video: withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } }) });
    await openViewer(); await openMenu();
    expect(options().map((o) => o.textContent)).toEqual(["In review"]);
    expect(optionOf("approved_internal")).toBeNull();
  });

  it("is a plain read-only pill while Published and in an archived Project (no menu)", async () => {
    await mount("admin", { video: withStatus(videoOf(), { reviewStatus: "published" }) });
    await openViewer();
    expect(pill()!.tagName).not.toBe("BUTTON");
    expect(pill()!.textContent).toContain("Published");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount("admin", { archived: true });
    await openViewer();
    expect(pill()!.tagName).not.toBe("BUTTON");
  });

  it("sends the choice for the latest Version with the status the pill showed, and shows the answer", async () => {
    await mount("admin");
    await openViewer(); await openMenu();
    const answered = withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } });
    apiPutMock.mockResolvedValue({ video: answered });
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [answered] }; throw new Error(`unrouted ${path}`); });
    await act(async () => { optionOf("approved_internal")!.click(); });
    await flush(6);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/review-status`, { reviewStatus: "approved_internal", expectedStatus: "in_review" });
    expect(pill()!.textContent).toContain("Approved (internal)");
  });

  it("explains a refusal in place and takes the server's fresh Video", async () => {
    await mount("admin");
    await openViewer(); await openMenu();
    const fresh = withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } });
    apiPutMock.mockRejectedValue(new ApiError("changed", 409, { code: "review_status_conflict", video: fresh }));
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [fresh] }; throw new Error(`unrouted ${path}`); });
    await act(async () => { optionOf("approved_internal")!.click(); });
    await flush(6);
    expect(tid("video-review-status-error")!.textContent).toMatch(/changed while you were looking/);
    expect(pill()!.textContent).toContain("Approved (internal)");
  });

  it("is disabled while an older Version is on show: it reports the Video, not the cut being watched", async () => {
    await mount("admin", { video: withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } }) });
    await openViewer();
    expect((pill() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { tid("video-version-trigger")!.click(); }); await flush(3);
    const older = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith("v1") || o.textContent?.includes("Version 1"));
    expect(older).toBeTruthy();
    await act(async () => { older!.click(); }); await flush(4);
    expect(pill()!.textContent).toContain("Approved (internal)");
    expect((pill() as HTMLButtonElement).disabled).toBe(true);
    expect(tid("video-review-status-hint")!.textContent).toMatch(/latest version/i);
  });
});

describe("VideoReviewStatusPill in Compare", () => {
  it("is disabled while comparing", async () => {
    const video = videoOf();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="admin"><VideoReviewStatusPill video={video} version={video.versions[0]!} comparing projectId={PROJECT} role="admin" archived={false} /></QuincyQueryProvider>); });
    expect((pill() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="admin"><VideoReviewStatusPill video={video} version={video.versions[0]!} comparing={false} projectId={PROJECT} role="admin" archived={false} /></QuincyQueryProvider>); });
    expect((pill() as HTMLButtonElement).disabled).toBe(false);
  });
});
