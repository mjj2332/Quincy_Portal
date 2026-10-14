import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { buildMp4, videoTrack } from "../../../../../packages/shared/src/testing/mp4-builder";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { TEASER, V1, WALK, all, buttonIn, checkbox, flush, linkOf, mount, press, q, state, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #884: the poster-first Video tile as a person meets it in the collection: what it shows, what opens it, the tick, the drop, and the drop's guard rails. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});

let stub: VideoElementStub;
let storage: ReturnType<typeof installLocalStorageShim>;
const tid = (testId: string) => q(`[data-testid="${testId}"]`);
const tileOf = (title: string) => all('[data-testid="video-card"]').find((c) => c.querySelector('[data-testid="video-card-open"]')?.textContent === title)!;
const openOf = (title: string) => tileOf(title).querySelector<HTMLElement>('[data-testid="video-card-open"]')!;
const viewer = () => tid("video-review-viewer");
const selectedBar = () => tid("review-link-selection-bar");
async function waitViewer() { const deadline = Date.now() + 10_000; while (!viewer() && Date.now() < deadline) await flush(1); await flush(4); }
const checked = (title: string) => checkbox(`Select ${title}`)!.checked;
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
async function dropOn(el: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  await act(async () => { el.dispatchEvent(event); });
  await flush(12);
}
async function dragEnter(el: Element) {
  const event = new Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
  await act(async () => { el.dispatchEvent(event); });
}
const goodFile = async (name = "recut.mp4") => { const source = buildMp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }); return new File([new Uint8Array(await source.read(0, source.size))], name, { type: "video/mp4" }); };
const withNotes = (video: VideoDto, latestNoteCount: number | null): VideoDto => ({ ...video, latestNoteCount });

beforeEach(() => {
  stub = installVideoElementStub(); storage = installLocalStorageShim(); resetUiPrefMemory();
  state.links = []; state.videos = [WALK, TEASER];
  apiGetMock.mockReset(); apiPostMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("what the tile shows (D21, D22)", () => {
  it("shows status, Version, duration and the open-note count, and the link icon for an active link only", async () => {
    state.videos = [withNotes(WALK, 2), TEASER]; state.links = [linkOf()];
    await mount({ parts: ["upload", "links", "notes"] });
    const walk = tileOf("Main walkthrough");
    expect(walk.querySelector('[data-testid="video-card-status"]')?.textContent).toBe("In review");
    expect(walk.querySelector('[data-testid="video-card-version"]')?.textContent).toBe("v2");
    expect(walk.textContent).toContain("2:14");
    expect(walk.querySelector('[data-testid="video-card-open-notes"]')?.textContent).toBe("2");
    expect(walk.querySelector('[data-testid="video-card-linked"]')).not.toBeNull();
    expect(tileOf("Teaser").querySelector('[data-testid="video-card-linked"]')).toBeNull();
  });

  it("hides the count at 0 and when null, and a revoked link draws no icon", async () => {
    state.videos = [withNotes(WALK, 0), withNotes(TEASER, null)]; state.links = [linkOf({ status: "revoked", revokedAt: "2026-10-09T05:00:00.000Z" })];
    await mount({ parts: ["upload", "links", "notes"] });
    expect(tid("video-card-open-notes")).toBeNull();
    expect(tid("video-card-linked")).toBeNull();
  });

  it("says the count in words for a screen reader", async () => {
    state.videos = [withNotes(WALK, 2), TEASER];
    await mount({ parts: ["upload", "notes"] });
    expect(document.getElementById(openOf("Main walkthrough").getAttribute("aria-describedby")!)!.textContent).toBe("v2, 2:14, 2 open notes on v2, In review");
  });

  it("letterboxes the poster whatever its shape", async () => {
    await mount();
    for (const tile of all('[data-testid="video-card"]')) expect(tile.querySelector('[data-testid="video-card-poster"]')!.getAttribute("data-fit")).toBe("contain");
  });
});

describe("what opens it and what selects (D23, D24)", () => {
  it("a click on the open control opens the viewer; it does not select", async () => {
    await mount();
    await press(openOf("Teaser"));
    await waitViewer();
    expect(viewer()).not.toBeNull();
    expect(checked("Teaser")).toBe(false);
    expect(selectedBar()).toBeNull();
  });

  it("the open control stretches over the whole tile", async () => {
    await mount();
    expect(openOf("Teaser").className).toContain("after:absolute");
    expect(openOf("Teaser").className).toContain("after:inset-0");
  });

  it("Enter on the focused open control opens the viewer once", async () => {
    await mount();
    const open = openOf("Teaser");
    open.focus();
    await key(open, "Enter");
    await act(async () => { open.click(); });
    await waitViewer();
    expect(all('[data-testid="video-review-viewer"]')).toHaveLength(1);
  });

  it("the tick selects and brings up the bar; Clear empties it; neither opens the viewer", async () => {
    await mount();
    await press(checkbox("Select Teaser"));
    expect(checked("Teaser")).toBe(true);
    expect(tileOf("Teaser").getAttribute("data-selected")).toBe("true");
    expect(selectedBar()).not.toBeNull();
    expect(viewer()).toBeNull();
    await press(buttonIn(selectedBar(), "Clear"));
    expect(selectedBar()).toBeNull();
    expect(checked("Teaser")).toBe(false);
  });

  it("the tick shows on hover, focus, selection, touch and phone widths by CSS alone", async () => {
    await mount();
    const label = checkbox("Select Teaser")!.closest("label")!;
    for (const part of ["group-hover/tile:opacity-100", "focus-within:opacity-100", "group-data-[selected=true]/tile:opacity-100", "pointer-coarse:opacity-100", "max-[721px]:opacity-100"]) expect(label.className).toContain(part);
    expect(label.className).toContain("size-11");
  });

  it("the ⋯ button never opens or selects, and a click inside its portalled menu never reaches the tile", async () => {
    await mount({ parts: ["upload", "links"] });
    const menuButton = tileOf("Teaser").querySelector<HTMLElement>('[data-testid="video-card-menu"]')!;
    await act(async () => { menuButton.focus(); menuButton.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(10);
    const menu = q('[role="menu"]')!;
    await act(async () => { menu.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush(6);
    expect(viewer()).toBeNull();
    expect(checked("Teaser")).toBe(false);
  });

  it("with Review links off there is no tick and no selection bar, and the tile still opens", async () => {
    await mount({ parts: ["upload"] });
    expect(checkbox("Select Teaser")).toBeNull();
    await press(openOf("Teaser"));
    await waitViewer();
    expect(viewer()).not.toBeNull();
  });

  it("focus returns to the open control after the viewer closes", async () => {
    await mount();
    const open = openOf("Teaser");
    open.focus();
    await press(open);
    await waitViewer();
    await key(viewer()!, "Escape");
    await flush(10);
    expect(document.activeElement).toBe(open);
  });
});

describe("drop to upload a Version (D23)", () => {
  it("dragging a file over a tile says which Version it will become; a drag of anything else does not", async () => {
    await mount();
    const tile = tileOf("Main walkthrough");
    const poster = tile.querySelector('[data-testid="video-card-poster"]')!;
    const zone = tile.querySelector('[data-testid="video-card-drop"]')!;
    expect(poster.textContent).toContain("Drop to upload v3");
    expect(zone.hasAttribute("data-dragging")).toBe(false);
    // elementFromPoint over the poster centre returns the stretched open control (its ::after), not the poster div
    await dragEnter(tile.querySelector('[data-testid="video-card-open"]')!);
    expect(zone.getAttribute("data-dragging")).toBe("true");
  });

  it("a drop checks the file, then reserves the next Version of that film", async () => {
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await dropOn(tileOf("Main walkthrough").querySelector('[data-testid="video-card-poster"]')!, [await goodFile()]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: V1 });
  });

  it("a drop on the stretched open control over the poster uploads the next Version, not a new film", async () => {
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await dropOn(tileOf("Main walkthrough").querySelector('[data-testid="video-card-open"]')!, [await goodFile()]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: V1 });
    expect(all('[data-testid="new-film-row"]')).toHaveLength(0);
  });

  it("a drop while that film is uploading is a no-op", async () => {
    state.videos = [{ ...WALK, uploading: { reservationId: "22222222-2222-4222-8222-222222222222", version: 3, uploader: { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-09T08:00:00.000Z" } } as VideoDto, TEASER];
    await mount();
    await dropOn(tileOf("Main walkthrough").querySelector('[data-testid="video-card-poster"]')!, [await goodFile()]);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("a drop on a tile never also queues a new film; a drop in the gap between tiles queues one", async () => {
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await dropOn(tileOf("Teaser").querySelector('[data-testid="video-card-poster"]')!, [await goodFile("tile.mp4")]);
    expect(all('[data-testid="new-film-row"]')).toHaveLength(0);
    await dropOn(tid("video-card-grid")!, [await goodFile("gap.mp4")]);
    expect(all('[data-testid="new-film-row"]')).toHaveLength(1);
  });

  it("a tile has no drop target without the upload part", async () => {
    await mount({ parts: ["links"] });
    expect(tileOf("Teaser").textContent).not.toContain("Drop to upload");
  });
});

describe("the pieces that moved off the tile", () => {
  it("no Review status control, versions popover, note chip, link chips, Open review or Upload button is on the tile", async () => {
    state.links = [linkOf()]; state.videos = [withNotes(WALK, 2), TEASER];
    await mount({ parts: ["upload", "links", "notes"] });
    const tile = tileOf("Main walkthrough");
    expect([...tile.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["video-card-open", "video-card-menu"]);
    expect(tile.textContent).not.toContain("Open review");
    expect(tile.querySelector('[data-testid="video-card-link-chips"]')).toBeNull();
    expect(tile.querySelector('[data-testid="video-card-review-status"]')).toBeNull();
  });
});
