import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import "../../testing/dom-polyfills";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
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
let impactRead: () => Promise<unknown> = async () => ({});
async function mount(role: Role = "editor", { archived = false, video = current }: { archived?: boolean; video?: VideoDto } = {}) {
  current = video;
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [current] };
    if (path.endsWith("/removal-impact")) return impactRead();
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: [] };
    if (path.endsWith("/decisions")) return { versions: [] };
    if (path.includes("/notes")) return { notes: [] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  void archived;
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: ["trash"] as never }} {...(archived ? { archived: true } : {})} /></QuincyQueryProvider>); });
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


/** Closing the viewer: the "Video" back button in its header. */
async function closeViewer() {
  const back = [...dialog()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
  await act(async () => { back.click(); });
  await flush(8);
  if (dialog()) throw new Error("the viewer did not close");
}
const errorLine = () => tid("video-review-status-error");
const impactOf = (notes: number) => ({ lastVersion: false, uploading: false, notes, decisions: 0, release: false, links: [] });

/** #874: a late answer lands on UI that has moved on. The data layer converges; the local presentation applies nothing. */
describe("late responses (#874)", () => {
  it("a refusal after the viewer closed shows no error, keeps the fresh Video, and the reopened pill is neither pending nor in error", async () => {
    await mount("admin");
    await openViewer(); await openMenu();
    const fresh = withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } });
    let refuse!: () => void;
    apiPutMock.mockImplementation(() => new Promise((_, reject) => { refuse = () => reject(new ApiError("changed", 409, { code: "review_status_conflict", video: fresh })); }));
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [fresh] }; throw new Error(`unrouted ${path}`); });
    await act(async () => { optionOf("approved_internal")!.click(); });
    await flush(3);
    await closeViewer();
    expect(dialog()).toBeNull();
    await act(async () => { refuse(); });
    await flush(6);
    expect(errorLine()).toBeNull();
    await openViewer();
    expect(errorLine()).toBeNull();
    expect(pill()!.textContent).toContain("Approved (internal)");
    expect((pill() as HTMLButtonElement).disabled).toBe(false);
  });

  it("a success after the viewer closed shows the answered status on reopen, with no error", async () => {
    await mount("admin");
    await openViewer(); await openMenu();
    const answered = withStatus(videoOf(), { reviewStatus: "approved_internal", stored: { [ids.asset2]: "approved_internal" } });
    let accept!: () => void;
    apiPutMock.mockImplementation(() => new Promise((resolve) => { accept = () => resolve({ video: answered }); }));
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [answered] }; throw new Error(`unrouted ${path}`); });
    await act(async () => { optionOf("approved_internal")!.click(); });
    await flush(3);
    await closeViewer();
    await act(async () => { accept(); });
    await flush(6);
    await openViewer();
    expect(errorLine()).toBeNull();
    expect(pill()!.textContent).toContain("Approved (internal)");
  });

  it("the Version menu keeps the second Version's impact when the first Version's read answers late", async () => {
    await mount("admin");
    await openViewer();
    const reads: Array<(value: unknown) => void> = [];
    impactRead = () => (reads.length === 0 ? new Promise((resolve) => { reads.push(resolve); }) : Promise.resolve(impactOf(3)));
    const startRemove = async () => {
      const deadline = Date.now() + 5_000;
      while (!document.querySelector('[aria-label="Version actions"]') && Date.now() < deadline) await flush(1);
      await act(async () => { document.querySelector<HTMLElement>('[aria-label="Version actions"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === "Remove version…")!;
      await act(async () => { item.click(); await Promise.resolve(); });
      await flush(4);
    };
    await startRemove();
    expect(tid("video-remove-dialog")).not.toBeNull();
    await act(async () => { tid("video-remove-cancel")!.click(); });
    await flush(4);
    await act(async () => { tid("video-version-trigger")!.click(); }); await flush(3);
    const older = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith("v1") || o.textContent?.includes("Version 1"))!;
    await act(async () => { older.click(); }); await flush(4);
    await startRemove();
    await waitForText("3 notes");
    await act(async () => { reads[0]!(impactOf(9)); });
    await flush(6);
    expect(tid("video-remove-impact")!.textContent).toContain("3 notes");
    expect(tid("video-remove-impact")!.textContent).not.toContain("9 notes");
  });
});
async function waitForText(text: string) {
  const deadline = Date.now() + 5_000;
  while (!document.body.textContent?.includes(text) && Date.now() < deadline) await flush(1);
}
