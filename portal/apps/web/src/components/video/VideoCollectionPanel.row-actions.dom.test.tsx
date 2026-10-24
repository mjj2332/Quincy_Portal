import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4RejectMessage, type VideoDto } from "@quincy/shared";
import { buildMp4, videoTrack, type Mp4Spec } from "../../../../../packages/shared/src/testing/mp4-builder";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { PROJECT, TEASER, USER, V1, V2, WALK, all, checkbox, dialog, flush, mia, mount, press, q, state, unmount, videoOf } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/**
 * #939: a staff Video row does everything a Video tile does, through the same pieces (VideoCard's menu, tick, drop and upload line), and its Title, Status and Uploaded
 * headers sort through the same per-person sort preference as the toolbar. Driven through the Video collection panel, with the list layout chosen.
 */
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

class FakeXhr {
  static instances: FakeXhr[] = [];
  url = ""; aborted = false; status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  constructor() { FakeXhr.instances.push(this); }
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader() {}
  getResponseHeader() { return null; }
  send() {}
  abort() { this.aborted = true; this.onabort?.(); }
}

const KEY = `quincy:ui:video-grid:${USER}`;
const RESERVATION = "22222222-2222-4222-8222-222222222222";
const me = { id: USER, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
/** Three films whose name, status and upload orders all differ. */
const ALPHA = videoOf("00000000-0000-4000-8000-000000000103", "Alpha", [["00000000-0000-4000-8000-000000000204", 1, true]]);
const dated = (video: VideoDto, at: string): VideoDto => ({ ...video, versions: video.versions.map((v) => (v.current ? { ...v, createdAt: at } : v)) });
const FILMS = [dated(WALK, "2026-10-05T00:00:00.000Z"), dated({ ...TEASER, reviewStatus: "published" }, "2026-10-07T00:00:00.000Z"), dated(ALPHA, "2026-10-03T00:00:00.000Z")];

const tid = (testId: string) => q(`[data-testid="${testId}"]`);
const rows = () => all('[data-testid="video-row"]');
const rowOf = (videoId: string) => q(`[data-testid="video-row"][data-video-id="${videoId}"]`)!;
const rowTitles = () => rows().map((row) => row.querySelector('[data-testid="video-row-open"]')?.textContent);
const menuOf = (videoId: string) => q<HTMLButtonElement>(`[data-testid="video-card-menu"][data-video-id="${videoId}"]`)!;
const items = () => all('[role="menuitem"]').map((el) => el.textContent);
const viewer = () => q('[data-testid="video-review-viewer"]');
const headerCell = (label: string) => all("th").find((th) => th.textContent?.trim() === label)!;
const headerButton = (label: string) => headerCell(label).querySelector("button");
const stored = () => JSON.parse(storage.values.get(KEY) ?? "{}") as Record<string, unknown>;
async function waitViewer() { const deadline = Date.now() + 10_000; while (!viewer()) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); } await flush(4); }
async function openMenu(videoId: string) {
  await act(async () => { menuOf(videoId).focus(); await Promise.resolve(); });
  await act(async () => { menuOf(videoId).click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(20);
}
async function choose(testId: string) { await act(async () => { tid(testId)!.click(); await Promise.resolve(); }); await flush(20); }
async function escape(target: Element) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(20); }
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
async function pickIn(scope: Element, file: File) {
  const input = scope.querySelector<HTMLInputElement>('[data-testid="file-pick-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(12);
}
const mp4 = async (spec: Mp4Spec, name = "recut.mp4") => { const s = buildMp4(spec); return new File([new Uint8Array(await s.read(0, s.size))], name, { type: "video/mp4" }); };
const good = () => mp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] });
async function pickOption(testId: string, label: string) {
  const trigger = tid(testId)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = all('[role="option"]').find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}

let storage: ReturnType<typeof installLocalStorageShim>;
let stub: VideoElementStub;
beforeEach(() => {
  storage = installLocalStorageShim(); resetUiPrefMemory(); stub = installVideoElementStub();
  storage.values.set(KEY, JSON.stringify({ layout: "rows" }));
  FakeXhr.instances = [];
  state.links = []; state.videos = [WALK, TEASER];
  apiGetMock.mockReset(); apiPostMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: [] };
    if (path.endsWith("/social-overlays")) return { available: [], selected: [], resolved: [], revision: "0".repeat(64) };
    throw new Error(`unrouted ${path}`);
  });
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the row's ⋯ menu", () => {
  it("offers the tile's actions, in the tile's order, in its own Actions column", async () => {
    await mount({ parts: ["upload", "links", "download", "trash"] });
    const menu = menuOf(V1);
    expect(menu.closest('[data-testid="video-row"]')).toBe(rowOf(V1));
    const cells = [...rowOf(V1).querySelectorAll("td")];
    expect(cells.at(-1)!.contains(menu)).toBe(true);
    expect(headerCell("Actions")).toBeDefined();
    await openMenu(V1);
    const fromRow = items();
    expect(fromRow).toEqual(["Upload new Version…", "Rename…", "Download v2", "Versions (2)", "Review links", "Delete…"]);
    await escape(document.activeElement!);
    await press(tid("video-layout-tiles"));
    await openMenu(V1);
    expect(items()).toEqual(fromRow);
  });

  it("pressing ⋯ neither opens the review nor ticks the row", async () => {
    await mount();
    await openMenu(V1);
    expect(viewer()).toBeNull();
    expect(checkbox("Select Main walkthrough")!.checked).toBe(false);
  });

  // The Version itself reaches the URL only with a deep link (the staff route); `VideoCollectionPanel.dom.test.tsx` pins that for the same menu on a tile.
  it("Versions opens the review on that film, and closing it returns focus to the row's ⋯", async () => {
    await mount();
    await openMenu(V1);
    await choose("video-card-versions");
    expect(all('[role="menuitem"]').map((el) => el.textContent)).toContain("v1");
    await choose("video-card-version-1");
    await waitViewer();
    expect(viewer()!.textContent).toContain("Main walkthrough");
    await escape(viewer()!);
    await flush(12);
    expect(viewer()).toBeNull();
    expect(document.activeElement).toBe(menuOf(V1));
  });

  it("Rename… opens the rename dialog, and Escape returns focus to the row's ⋯", async () => {
    await mount();
    await openMenu(V2);
    await choose("video-card-rename");
    const input = q<HTMLInputElement>("#video-rename-filename")!;
    expect(input).not.toBeNull();
    await escape(input);
    expect(tid("video-rename-dialog")).toBeNull();
    expect(document.activeElement).toBe(menuOf(V2));
  });

  it("Delete… opens the delete confirmation for that film", async () => {
    await mount({ parts: ["upload", "links", "trash"] });
    await openMenu(V2);
    await choose("video-card-delete");
    expect(tid("video-delete-dialog")!.textContent).toContain("Teaser");
  });

  it("Review links › Create Review link… opens the create dialog", async () => {
    await mount();
    await openMenu(V1);
    await choose("video-card-links");
    await choose("video-card-create-review-link");
    expect(dialog()).not.toBeNull();
  });
});

describe("the row's tick", () => {
  it("is in its own column while Review link selection is on, and ticking a row neither opens it nor is lost by switching layouts", async () => {
    await mount();
    expect(headerCell("Select")).toBeDefined();
    const tick = checkbox("Select Main walkthrough", rowOf(V1))!;
    expect([...rowOf(V1).querySelectorAll("td")][0]!.contains(tick)).toBe(true);
    await press(tick);
    expect(checkbox("Select Main walkthrough")!.checked).toBe(true);
    expect(rowOf(V1).getAttribute("data-selected")).toBe("true");
    expect(viewer()).toBeNull();
    expect(tid("review-link-selection-bar")).not.toBeNull();
    await press(tid("video-layout-tiles"));
    expect(checkbox("Select Main walkthrough")!.checked).toBe(true);
    await press(tid("video-layout-rows"));
    expect(checkbox("Select Main walkthrough")!.checked).toBe(true);
    expect(checkbox("Select Teaser")!.checked).toBe(false);
  });

  it("has no column and no tick with Review links off", async () => {
    await mount({ parts: ["upload"] });
    expect(all("th").map((th) => th.textContent?.trim())).not.toContain("Select");
    expect(checkbox("Select Main walkthrough")).toBeNull();
    expect(menuOf(V1)).not.toBeNull();
  });
});

describe("dropping a file on a row", () => {
  it("says which Version it will become while a file is over the row", async () => {
    await mount();
    const row = rowOf(V1);
    expect(row.textContent).toContain("Drop to upload v3");
    expect(row.hasAttribute("data-dragging")).toBe(false);
    await dragEnter(row.querySelector('[data-testid="video-row-open"]')!);
    expect(row.getAttribute("data-dragging")).toBe("true");
  });

  it("checks the file, then reserves the next Version of that film, never a new film", async () => {
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await dropOn(rowOf(V1).querySelector('[data-testid="video-row-open"]')!, [await good()]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: V1 });
    expect(all('[data-testid="new-film-row"]')).toHaveLength(0);
  });

  it("a drop on the ⋯ cell uploads a Version of that film too", async () => {
    apiPostMock.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await dropOn(menuOf(V2).closest("td")!, [await good()]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: V2 });
    expect(all('[data-testid="new-film-row"]')).toHaveLength(0);
  });

  it("is a no-op while that film is uploading, and there is no drop without the upload part", async () => {
    state.videos = [{ ...WALK, uploading: { reservationId: RESERVATION, version: 3, uploader: mia, expiresAt: "2026-10-09T08:00:00.000Z" } } as VideoDto, TEASER];
    await mount();
    await dropOn(rowOf(V1), [await good()]);
    expect(apiPostMock).not.toHaveBeenCalled();
    await unmount();
    await mount({ parts: ["links"] });
    expect(rowOf(V2).textContent).not.toContain("Drop to upload");
  });
});

describe("the upload line under the row's title", () => {
  it("shows a refused file's reason, then my upload's progress, and the menu stops offering a new Version", async () => {
    await mount();
    apiPostMock.mockResolvedValue({ reservationId: RESERVATION, videoId: V1, version: 3, devDirect: true, expiresAt: "2026-10-09T08:00:00.000Z" });
    await pickIn(rowOf(V1), await mp4({ tracks: [videoTrack({ codec: "hvc1" })] }));
    expect(rowOf(V1).textContent).toContain(mp4RejectMessage("hevc"));
    expect(apiPostMock).not.toHaveBeenCalled();
    await pickIn(rowOf(V1), await good());
    expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ videoId: V1 });
    const line = rowOf(V1).querySelector('[data-testid="video-card-uploading"]')!;
    expect(line.textContent).toBe("Uploading v3 · 0%");
    expect(rowOf(V1).textContent).not.toContain(mp4RejectMessage("hevc"));
    await openMenu(V1);
    expect(q('[data-testid="video-card-upload-version"]')).toBeNull();
  });

  it("someone else's upload reads '{name} is uploading v3' with no Cancel upload", async () => {
    state.videos = [{ ...WALK, uploading: { reservationId: RESERVATION, version: 3, uploader: mia, expiresAt: "2026-10-09T08:00:00.000Z" } } as VideoDto, TEASER];
    await mount();
    expect(rowOf(V1).querySelector('[data-testid="video-card-uploading-other"]')?.textContent).toBe("Mia Chen is uploading v3");
    expect(all("button", rowOf(V1)).find((b) => b.textContent === "Cancel upload")).toBeUndefined();
  });

  it("my upload this tab has no job for offers Cancel upload, which aborts that reservation", async () => {
    state.videos = [{ ...WALK, uploading: { reservationId: RESERVATION, version: 3, uploader: me, expiresAt: "2026-10-09T08:00:00.000Z" } } as VideoDto, TEASER];
    await mount();
    expect(rowOf(V1).querySelector('[data-testid="video-card-uploading-other"]')?.textContent).toBe("Your upload of v3 is still open (another tab or device).");
    const cancel = all<HTMLButtonElement>("button", rowOf(V1)).find((b) => b.textContent === "Cancel upload")!;
    await press(cancel);
    await flush(8);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/abort"))).toEqual([`/api/projects/${PROJECT}/video-uploads/${RESERVATION}/abort`]);
  });
});

describe("header sort", () => {
  beforeEach(() => { state.videos = FILMS; });

  it("only Title, Status and Uploaded headers sort, and the sorted one says how", async () => {
    await mount();
    expect(headerButton("Title")).not.toBeNull();
    expect(headerButton("Status")).not.toBeNull();
    expect(headerButton("Uploaded")).not.toBeNull();
    for (const label of ["Notes", "Duration", "Uploader"]) expect(headerButton(label)).toBeNull();
    expect(headerCell("Uploaded").getAttribute("aria-sort")).toBe("descending");
    expect(rowTitles()).toEqual(["Teaser", "Main walkthrough", "Alpha"]);
  });

  it("a header picks its key in its natural direction, a second press flips it, a third flips it back, and the toolbar shows the same sort", async () => {
    await mount();
    await press(headerButton("Title"));
    expect(rowTitles()).toEqual(["Alpha", "Main walkthrough", "Teaser"]);
    expect(stored()).toMatchObject({ sort: "name", dir: "asc", layout: "rows" });
    expect(tid("video-grid-sort")!.textContent).toContain("Name");
    expect(headerCell("Title").getAttribute("aria-sort")).toBe("ascending");
    await press(headerButton("Title"));
    expect(rowTitles()).toEqual(["Teaser", "Main walkthrough", "Alpha"]);
    expect(stored()).toMatchObject({ sort: "name", dir: "desc" });
    await press(headerButton("Title"));
    expect(stored()).toMatchObject({ sort: "name", dir: "asc" });
    expect(headerCell("Title").getAttribute("aria-sort")).toBe("ascending");
    await press(headerButton("Uploaded"));
    expect(stored()).toMatchObject({ sort: "uploaded", dir: "desc" });
    expect(rowTitles()).toEqual(["Teaser", "Main walkthrough", "Alpha"]);
    await press(headerButton("Status"));
    expect(stored()).toMatchObject({ sort: "status", dir: "asc" });
    // In review first (newest upload first among them), then published.
    expect(rowTitles()).toEqual(["Main walkthrough", "Alpha", "Teaser"]);
  });

  it("the toolbar's sort shows on the headers", async () => {
    await mount();
    await pickOption("video-grid-sort", "Name");
    expect(headerCell("Title").getAttribute("aria-sort")).toBe("ascending");
    expect(headerCell("Uploaded").getAttribute("aria-sort")).not.toBe("descending");
  });
});
