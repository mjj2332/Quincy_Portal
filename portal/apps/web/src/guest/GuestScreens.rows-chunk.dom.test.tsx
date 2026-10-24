import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installLocalStorageShim } from "../testing/local-storage";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import type { GuestApi } from "./guest-api";
import { VideoListScreen } from "./GuestScreens";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

// Records when the Video rows module (the ReUI data-grid, TanStack Table) is first evaluated: the owner's condition for using it on guest pages is that a guest who keeps
// tiles never loads it (#933 owner decision, `guest-boundary.guard.test.ts`). A static import from the guest tree would evaluate it with this file's own imports.
const rowsModule = vi.hoisted(() => ({ loaded: false }));
vi.mock("../components/quincy/VideoRows", async (importOriginal) => { rowsModule.loaded = true; return importOriginal(); });
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));

const SESSION = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false, markup: false } }, verified: false, email: null, name: null, notifications: null, media: { heic: false } } as unknown as GuestSessionResponse;
const videoOf = (n: number): GuestVideoDto => ({
  id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, title: `Film ${n}`, premium: false, unlocked: true,
  versions: [{ assetId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, hasAudio: true, posterUrl: `/p/${n}`, streamUrl: `/s/${n}`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null }],
} as unknown as GuestVideoDto);

let root: Root | null = null;
let host: HTMLElement;
let viewport: MockViewport;
let shim: ReturnType<typeof installLocalStorageShim>;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(async () => {
  shim = installLocalStorageShim(); resetUiPrefMemory(); viewport = mockViewport({ width: 1440 });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<VideoListScreen api={{} as GuestApi} verify={{ request: () => {} }} title="Smith house" videos={[videoOf(1), videoOf(2)]} session={SESSION} onSession={() => {}} onOpen={() => {}} onUnavailable={() => {}} identity={null} />);
  });
  await flush();
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; host.remove(); viewport.restore(); shim.restore(); });

describe("the guest Video rows chunk (#940)", () => {
  it("is not loaded while the guest keeps tiles, and is loaded behind a skeleton when they pick the list", async () => {
    expect(byId("guest-video-grid")).not.toBeNull();
    expect(rowsModule.loaded).toBe(false);
    await act(async () => { byId("video-layout-rows")!.click(); });
    expect(byId("guest-video-rows-loading")?.getAttribute("role")).toBe("status");
    for (let i = 0; i < 100 && !byId("guest-video-list-row"); i += 1) await flush();
    expect(rowsModule.loaded).toBe(true);
    expect(byId("guest-video-rows-loading")).toBeNull();
    expect(byId("guest-video-list-row")).not.toBeNull();
  });
});
