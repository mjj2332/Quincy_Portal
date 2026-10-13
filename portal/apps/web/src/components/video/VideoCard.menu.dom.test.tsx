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
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "clipboard"); });

describe("which items the menu offers", () => {
  it.each(["editor", "external_editor", "admin"] as const)("%s with links and download sees Open, Create Review link, Download v2, Copy link, in that order, in two groups", async (role) => {
    await mount({ role, parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Open", "Create Review link", "Download v2", "Copy link"]);
    expect(separators()).toHaveLength(1);
  });
  it("offers only Open and Copy link without the links and download parts, still in two groups", async () => {
    await mount({ parts: ["upload"] });
    await openCardMenu(V1);
    expect(items()).toEqual(["Open", "Copy link"]);
    expect(separators()).toHaveLength(1);
  });
  it("on an archived Project drops Create Review link only", async () => {
    await mount({ archived: true, parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Open", "Download v2", "Copy link"]);
  });
  it("gives a Photographer no Download (capability) and no Create Review link", async () => {
    await mount({ role: "photographer", parts: ALL });
    await openCardMenu(V1);
    expect(items()).toEqual(["Open", "Copy link"]);
  });
  it("keeps the trigger when the card's descriptive text is hidden", async () => {
    await mount({ parts: ALL });
    expect(cardMenu(V1)).not.toBeNull();
    expect(cardMenu(V2)).not.toBeNull();
  });
});

describe("Open", () => {
  it("opens the viewer on that film, leaves the selection, and Escape returns focus to that card's ⋯", async () => {
    await mount({ parts: ALL });
    await openCardMenu(V2);
    await pick("video-card-menu-open");
    const deadline = Date.now() + 10_000; while (!viewer() && Date.now() < deadline) await flush(1);
    expect(viewer()).not.toBeNull();
    expect(checkbox("Select Teaser")!.checked).toBe(false);
    await act(async () => { viewer()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(20);
    expect(viewer()).toBeNull();
    expect(document.activeElement).toBe(cardMenu(V2));
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

describe("Copy link", () => {
  it("writes the absolute film deep link with no Version pinned, toasts, closes the menu and returns focus to the ⋯", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); stubClipboard(writeText);
    await mount({ parts: ALL });
    await openCardMenu(V1);
    await pick("video-card-copy-link");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/${PROJECT}?tab=video&video=${V1}`);
    expect(toasts.list).toEqual(["Link copied."]);
    expect(item("video-card-copy-link")).toBeNull();
    expect(document.activeElement).toBe(cardMenu(V1));
    expect(viewer()).toBeNull();
    expect(checkbox("Select Main walkthrough")!.checked).toBe(false);
  });
  it("toasts an error when the write is rejected", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    await mount({ parts: ALL });
    await openCardMenu(V1);
    await pick("video-card-copy-link");
    expect(toasts.list).toEqual(["error: Couldn't copy the link."]);
  });
  it("toasts an error when there is no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await mount({ parts: ALL });
    await openCardMenu(V1);
    await pick("video-card-copy-link");
    expect(toasts.list).toEqual(["error: Couldn't copy the link."]);
  });
});
