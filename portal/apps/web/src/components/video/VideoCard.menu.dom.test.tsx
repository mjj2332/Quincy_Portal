import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoVersionDownloadUrl } from "@quincy/shared";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { A2, PROJECT, TEASER, V1, V2, WALK, all, checkbox, flush, mount, q, state, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #866: the Video card's "⋯" menu: Open, Create Review link, Download, Copy link. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("../../lib/toast-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toast-store")>();
  return { ...actual, pushToast: (message: string, tone?: "success" | "error" | "caution") => { toasts.list.push(tone === "error" ? `error: ${message}` : message); return 0; } };
});
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

let stub: VideoElementStub;
let storage: ReturnType<typeof installLocalStorageShim>;
const ALL = ["upload", "links", "download"];
const cardMenu = (videoId: string) => q(`[data-testid="video-card-menu"][data-video-id="${videoId}"]`);
const items = () => all('[role="menuitem"]').map((el) => el.textContent);
const separators = () => all('[role="separator"]');
const item = (testId: string) => q<HTMLElement>(`[data-testid="${testId}"]`);
const viewer = () => q('[data-testid="video-review-viewer"]');
async function openCardMenu(videoId: string) {
  await act(async () => { cardMenu(videoId)!.focus(); await Promise.resolve(); });
  await act(async () => { cardMenu(videoId)!.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(20);
}
async function pick(testId: string) { await act(async () => { item(testId)!.click(); await Promise.resolve(); }); await flush(20); }
function stubClipboard(writeText: (text: string) => Promise<void>) { Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true }); }

beforeEach(() => {
  stub = installVideoElementStub(); storage = installLocalStorageShim(); resetUiPrefMemory();
  state.links = []; state.videos = [WALK, TEASER]; toasts.list = [];
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    if (path.endsWith("/social-overlays")) return { available: [], selected: [], resolved: [], revision: "0".repeat(64) };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "clipboard"); });

describe("which items the menu offers (D23)", () => {
  it.each(["editor", "external_editor", "admin"] as const)("%s with links and download sees Upload new Version…, Rename…, Download v2, Versions, Review links, in that order, with no separator without Delete", async (role) => {
    await mount({ role, parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Upload new Version…", "Rename…", "Download v2", "Versions (2)", "Review links"]);
    expect(separators()).toHaveLength(0);
  });
  it("offers only Upload new Version…, Rename… and Versions without the links and download parts", async () => {
    await mount({ parts: ["upload"] });
    await openCardMenu(V1);
    expect(items()).toEqual(["Upload new Version…", "Rename…", "Versions (2)"]);
  });
  it("has no Copy link, Social preview or Open: those stay in the viewer (D5)", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V1);
    expect(item("video-card-copy-link")).toBeNull();
    expect(item("video-card-social-preview")).toBeNull();
    expect(item("video-card-menu-open")).toBeNull();
  });
  it("on an archived Project drops Rename (and Create Review link inside its submenu)", async () => {
    await mount({ archived: true, parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Upload new Version…", "Download v2", "Versions (2)", "Review links"]);
  });
  it("gives a Photographer no Download (capability), no Rename and no Review links", async () => {
    await mount({ role: "photographer", parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Upload new Version…", "Versions (2)"]);
  });
  it("hides Upload new Version… while a Version is uploading", async () => {
    state.videos = [{ ...WALK, uploading: { reservationId: "22222222-2222-4222-8222-222222222222", version: 3, uploader: { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-09T08:00:00.000Z" } } as typeof WALK, TEASER];
    await mount({ parts: ALL });
    await openCardMenu(V1);
    expect(items()).not.toContain("Upload new Version…");
  });
  it("keeps the trigger on every tile", async () => {
    await mount({ parts: ALL });
    expect(cardMenu(V1)).not.toBeNull();
    expect(cardMenu(V2)).not.toBeNull();
  });
});

describe("Upload new Version…", () => {
  it("opens the file picker from the menu item's own click (iOS needs it in the same tick)", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V1);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await pick("video-card-upload-version");
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("Versions submenu", () => {
  it("lists every Version, newest first, and a pick opens the viewer (the menu hands focus off)", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V1);
    await pick("video-card-versions");
    expect(all('[data-testid^="video-card-version-"]').map((el) => el.textContent)).toEqual(["v2", "v1"]);
    await pick("video-card-version-1");
    const deadline = Date.now() + 10_000; while (!viewer() && Date.now() < deadline) await flush(1);
    expect(viewer()).not.toBeNull();
    expect(checkbox("Select Main walkthrough")!.checked).toBe(false);
  });
});

describe("Download", () => {
  it("is an attachment anchor to the film's current Version (v2, not v1) with a v-numbered label", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V1);
    const link = item("video-card-download")!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(videoVersionDownloadUrl(PROJECT, A2));
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.textContent).toBe("Download v2");
  });
  it("leaves the selection alone when picked", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V2);
    item("video-card-download")!.addEventListener("click", (event) => event.preventDefault());
    await pick("video-card-download");
    expect(checkbox("Select Teaser")!.checked).toBe(false);
    expect(viewer()).toBeNull();
  });
});
