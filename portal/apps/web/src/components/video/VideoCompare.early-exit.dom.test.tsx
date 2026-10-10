import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { frameSeekSeconds, type VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This file must press Compare with the compare chunk NOT yet loaded (module state is per file), so it holds the one case.
const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

const ids = { video: "88888888-8888-4888-8888-888888888888", a: "77777777-7777-4777-8777-777777777777", b: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.a, version: 2, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${ids.a}`, posterUrl: null, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, title: "Walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.a, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.b, version: 1, current: false, streamUrl: `/media/video/${ids.b}` })] }) as VideoDto;

let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }

beforeEach(() => { stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); apiGetMock.mockReset(); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); });

it("leaving compare before its chunk has loaded reopens the single player on the frame compare was entered at", async () => {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoCollectionPanel projectId="11111111-1111-4111-8111-111111111111" role="editor" review={{ open: true, parts: ["compare"] as never }} /></QuincyQueryProvider>); });
  await flush();
  const open = [...document.querySelectorAll("button")].find((b) => b.textContent === "Open review")!;
  await act(async () => { open.click(); });
  const deadline = Date.now() + 10_000;
  while (!document.querySelector('[role="dialog"] video')) { if (Date.now() > deadline) throw new Error("the viewer never mounted"); await flush(1); }
  await flush(4);
  const player = document.querySelector<HTMLVideoElement>('[role="dialog"] video')!;
  await act(async () => { stub.loadMetadata(player, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(player); stub.presentFrame(player, 0); });
  await act(async () => { stub.presentFrame(player, 120 / 25); });
  const toggle = document.querySelector<HTMLElement>('[data-testid="video-compare-toggle"]')!;
  // Compare and straight back out in one tick: the lazy chunk has not rendered, so there is no compare view to ask for A's frame.
  await act(async () => { toggle.click(); });
  await act(async () => { document.querySelector<HTMLElement>('[data-testid="video-compare-toggle"]')!.click(); });
  await flush(4);
  expect(document.querySelector('[data-testid="video-compare"]')).toBeNull();
  const again = document.querySelector<HTMLVideoElement>('[role="dialog"] video')!;
  stub.writes.length = 0;
  await act(async () => { stub.loadMetadata(again, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
  expect(stub.writes).toEqual([frameSeekSeconds(120, { num: 25, den: 1 })]);
});
