import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installLocalStorageShim } from "../testing/local-storage";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import type { GuestApi } from "./guest-api";
import { VideoListScreen } from "./GuestScreens";

/**
 * #933 fix round 1: when the Video rows chunk cannot load (a deploy replaced it), a guest sees neutral words and Reload, never the staff Portal's "The Portal may have been
 * updated" notice. The module's import fails here as a stale chunk does in a browser.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../components/quincy/VideoRows", () => { throw new TypeError("Failed to fetch dynamically imported module: https://quincy.test/assets/VideoRows-OLD.js"); });

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
  vi.spyOn(console, "error").mockImplementation(() => {});
  shim = installLocalStorageShim(); resetUiPrefMemory(); viewport = mockViewport({ width: 1440 });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<VideoListScreen api={{} as GuestApi} verify={{ request: () => {} }} title="Smith house" videos={[videoOf(1), videoOf(2)]} session={SESSION} onSession={() => {}} onOpen={() => {}} onUnavailable={() => {}} identity={null} />);
  });
  await flush();
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; host.remove(); viewport.restore(); shim.restore(); vi.restoreAllMocks(); });

describe("the guest Video rows chunk failing to load", () => {
  it("says the list could not be loaded, with Reload, in words a guest can use", async () => {
    await act(async () => { byId("video-layout-rows")!.click(); });
    for (let i = 0; i < 100 && !byId("view-load-error"); i += 1) await flush();
    const notice = byId("view-load-error")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("The list could not be loaded.");
    expect(notice.textContent).not.toMatch(/Portal|updated/);
    expect([...notice.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Reload"]);
  });
});
