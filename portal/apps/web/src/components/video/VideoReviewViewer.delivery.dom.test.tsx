import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto } from "@quincy/shared";
import { frameSeekSeconds } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { ProjectSheet } from "../quincy/ProjectSheet";
import "../../testing/dom-polyfills";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 30000, den: 1001 }, tcNominalFps: 30, tcDropFrame: true, startTimecodeFrames: null, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(parts: Array<"delivery" | "notes">, role: Role = "editor") {
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [videoOf()] };
    if (path.endsWith("/decisions")) return { versions: [{ assetId: ids.asset2, version: 2, events: [], release: null }, { assetId: ids.asset1, version: 1, events: [], release: null }] };
    if (path.includes("/notes")) return { notes: [] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts }} /></QuincyQueryProvider>); });
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
async function panelLoaded() { const deadline = Date.now() + 10_000; while (!panel()) { if (Date.now() > deadline) throw new Error("the delivery panel never mounted"); await flush(1); } await flush(4); }
const panel = () => document.querySelector('[data-testid="video-delivery"]');

beforeEach(() => { stub = installVideoElementStub(); apiGetMock.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("VideoReviewViewer delivery panel (#741 14-ui-staff)", () => {
  it("shows nothing about decisions, Release or premium with the delivery part off, and never asks for the decisions", async () => {
    await mount([]);
    await openViewer();
    expect(panel()).toBeNull();
    expect(document.body.textContent).not.toMatch(/Release|Premium film/);
    expect(apiGetMock.mock.calls.some(([path]) => path.endsWith("/decisions"))).toBe(false);
  });

  it("shows the panel under the player with the delivery part on, for the Version being shown", async () => {
    await mount(["delivery"]);
    await openViewer();
    await panelLoaded();
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain("Delivery · v2");
    expect(apiGetMock.mock.calls.some(([path]) => path.endsWith("/decisions"))).toBe(true);
  });

  it("sits beside the notes panel when notes are on too", async () => {
    await mount(["delivery", "notes"]);
    await openViewer();
    await panelLoaded();
    expect(panel()).not.toBeNull();
    expect(document.querySelector('[data-testid="video-details-button"]')).not.toBeNull();
  });
});
