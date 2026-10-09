import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto } from "@quincy/shared";
import { frameSeekSeconds } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { ProjectSheet } from "../quincy/ProjectSheet";
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
const videoOf = (): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 30000, den: 1001 }, tcNominalFps: 30, tcDropFrame: true, startTimecodeFrames: null, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(role: Role = "editor") {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: [] }} /></QuincyQueryProvider>); });
  await flush();
}
async function mountInSheet(role: Role = "editor") {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoOf()] }; throw new Error(`unrouted ${path}`); });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><ProjectSheet open kind="project" sheetKey="p:1" backdropHref="/" onRequestClose={() => {}}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts: [] }} /></ProjectSheet></QuincyQueryProvider>); });
  await flush();
}
const openButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Open review")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const playerVideo = () => dialog()?.querySelector("video") ?? null;
async function openViewer() {
  openButton().focus();
  await act(async () => { openButton().click(); });
  // The first open loads the lazy chunk.
  for (let i = 0; i < 60 && !dialog(); i += 1) await flush(1);
  await flush(4);
}
async function key(k: string, target: Element, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
}

beforeEach(() => { stub = installVideoElementStub(); apiGetMock.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("VideoReviewViewer (#741 4d-ii)", () => {
  it("opens from the card as a dialog named by the film, playing the newest Version", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await openViewer();
    const open = dialog()!;
    expect(open).not.toBeNull();
    const labelledBy = open.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)?.textContent).toBe("Main walkthrough");
    expect(playerVideo()!.getAttribute("src")).toBe(`/media/video/${ids.asset2}`);
    expect(open.textContent).toContain("1920×1080 · 25 fps · start TC 01:00:00:00");
    expect(open.getAttribute("data-surface")).toBe("inverse");
    expect(open.querySelector("[data-testid=video-readout]")!.textContent).toMatch(/^01:00:00:00 \//);
  });

  it("an External collaborator gets the same player", async () => {
    await mount("external_editor");
    await openViewer();
    expect(playerVideo()).not.toBeNull();
    expect(dialog()!.querySelector("a[href]")).toBeNull();
    expect(playerVideo()!.hasAttribute("controls")).toBe(false);
  });

  it("Escape closes it and focus goes back to the Open review button", async () => {
    await mount();
    await openViewer();
    const opener = openButton();
    await key("Escape", dialog()!);
    await flush(12);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the Video button closes it and returns focus too", async () => {
    await mount();
    await openViewer();
    const back = [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === "Video")!;
    expect(back.className).toContain("pointer-coarse:min-h-11");
    await act(async () => { back.click(); });
    await flush(12);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(openButton());
  });

  it("the shortcuts belong to the dialog: they work inside it and not outside, and stop when it closes", async () => {
    await mount();
    await openViewer();
    await act(async () => { stub.loadMetadata(playerVideo()!, { duration: 12 }); });
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 0); });
    stub.calls.length = 0;
    await key(" ", document.body);
    expect(stub.calls).toEqual([]);
    await key(" ", dialog()!);
    expect(stub.calls).toEqual(["play"]);
    await key(" ", dialog()!);
    await key("Escape", dialog()!);
    await flush(12);
    stub.calls.length = 0;
    await key(" ", document.body);
    expect(stub.calls).toEqual([]);
  });

  it("Space pressed as soon as the dialog is open starts the film once it can play (focus is not parked on a button that eats Space)", async () => {
    await mount();
    await openViewer();
    const focused = document.activeElement!;
    expect(dialog()!.contains(focused)).toBe(true);
    expect(focused.closest("button, a[href], [role=button]")).toBeNull();
    stub.calls.length = 0;
    await key(" ", focused);
    await act(async () => { stub.loadMetadata(playerVideo()!, { duration: 12 }); });
    expect(stub.calls).toContain("play");
    expect(dialog()).not.toBeNull();
  });

  it("keyboard open: focusing Open review preloads the player, so the dialog and its focus land in the Enter's own tick (a Space typed next is not lost on the button)", async () => {
    await mount();
    await act(async () => { openButton().focus(); });
    await flush(30);
    await act(async () => { openButton().click(); });
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());
  });

  it("desktop layout: the row is exactly the free height (no wrap, no overflow) and the details rail scrolls itself, so the picture shrinks instead of the controls leaving the window", async () => {
    await mount();
    await openViewer();
    const aside = dialog()!.querySelector<HTMLElement>("aside")!;
    const row = aside.parentElement!;
    for (const token of ["min-[721px]:flex-nowrap", "min-[721px]:overflow-hidden"]) expect(row.className).toContain(token);
    for (const token of ["min-[721px]:min-h-0", "min-[721px]:overflow-y-auto"]) expect(aside.className).toContain(token);
    expect(row.firstElementChild!.className).toContain("min-h-0");
  });

  it("lists every Version in the switcher and the chosen Version's details beside the player", async () => {
    await mount();
    await openViewer();
    const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
    expect(trigger.className).toContain("pointer-coarse:min-h-11");
    expect(document.querySelector(`label[for="${trigger.id}"]`)?.textContent).toBe("Version");
    expect(trigger.textContent).toContain("v2 · latest · Mia Chen · 9 Oct 2026");
    const aside = dialog()!.querySelector('aside[aria-label="Version details"]')!;
    expect(aside.textContent).toContain("Mia Chen");
    expect(aside.textContent).toContain("120 MB");
    expect(aside.textContent).toContain("01:00:00:00");
  });

  it("a long uploader name cannot push the Version control past the header: the group and trigger may shrink and the label truncates, at the 44px touch height", async () => {
    await mount();
    await openViewer();
    const byId = (id: string) => dialog()!.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    expect(byId("video-version-group").className).toContain("min-w-0");
    expect(byId("video-version-group").className).toContain("max-w-full");
    expect(byId("video-version-trigger").className).toContain("min-w-0");
    expect(byId("video-version-trigger").className).not.toContain("min-w-[200px]");
    expect(byId("video-version-trigger").className).toContain("pointer-coarse:min-h-11");
    expect(byId("video-version-label").className).toContain("truncate");
  });

  it("lays the details column out like the Lightbox panel: heading aligned with the rows, label muted above, value in primary", async () => {
    await mount();
    await openViewer();
    const aside = dialog()!.querySelector('aside[aria-label="Version details"]')!;
    expect(aside.querySelector("h3")!.className).toContain("px-2.5");
    const title = aside.querySelector('[data-testid="video-detail-label"]')!;
    const description = aside.querySelector('[data-testid="video-detail-value"]')!;
    expect(title.className).toContain("text-foreground-secondary");
    expect(description.className).toContain("text-foreground");
    expect(description.className).not.toContain("text-muted-foreground");
    const startTc = dialog()!.querySelector('[data-testid="video-start-tc"]')!;
    expect(startTc.className).toContain("whitespace-nowrap");
    expect(startTc.textContent).toMatch(/^start TC /);
  });

  it("the Version popup renders inside the player dialog, above it, not in the Project sheet's overlay slot", async () => {
    await mountInSheet();
    await openViewer();
    const viewer = document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]')!;
    const trigger = viewer.querySelector<HTMLElement>('[role="combobox"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      trigger.click();
    });
    await flush(4);
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    expect(viewer.contains(listbox)).toBe(true);
    expect(document.querySelector('[data-testid="project-sheet-overlay-slot"]')!.contains(listbox)).toBe(false);
    const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.length).toBe(2);
    for (const option of options) {
      expect(option.className).toContain("pointer-coarse:min-h-11");
      expect(option.className).toContain("max-[721px]:min-h-11");
    }
  });

  it("switching Version pauses the old one and opens the new one paused at frame 0, with its own timecode", async () => {
    await mount();
    await openViewer();
    const first = playerVideo()!;
    await act(async () => { stub.loadMetadata(first, { duration: 12 }); });
    await act(async () => { stub.finishSeek(first); stub.presentFrame(first, 0); });
    await key(" ", dialog()!);
    expect(first.paused).toBe(false);

    const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
    await flush(6);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith("v1"))!;
    expect(option).toBeDefined();
    await act(async () => { option.click(); });
    await flush(8);

    const second = playerVideo()!;
    expect(second).not.toBe(first);
    expect(first.paused).toBe(true);
    expect(second.getAttribute("src")).toBe(`/media/video/${ids.asset1}`);
    expect(second.paused).toBe(true);
    expect(dialog()!.querySelector("[data-testid=video-readout]")!.textContent).toMatch(/^00:00:00;00 \//);
    await act(async () => { stub.loadMetadata(second, { duration: 12 }); });
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(0, { num: 30000, den: 1001 }));
  });
});
