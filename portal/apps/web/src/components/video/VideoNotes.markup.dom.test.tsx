import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { frameSeekSeconds, type Role, type VideoDto, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
import { ArchivedFromCache } from "../../testing/archived-from-cache";
import "../../testing/dom-polyfills";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const stores = vi.hoisted(() => ({ made: [] as Array<import("../../lib/video-note-form-store").NoteFormStore> }));
vi.mock("../../lib/video-note-form-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-note-form-store")>();
  return { ...actual, createNoteFormStore: (key: string) => { const store = actual.createNoteFormStore(key); stores.made.push(store); return store; } };
});
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPatch: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDeleteWithBody: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 25, den: 1 }, tcNominalFps: 25, startTimecodeFrames: 90000, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

let seq = 100;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const T = (n: number) => `2026-10-10T00:00:${String(n).padStart(2, "0")}.000Z`;
type NoteOver = Record<string, unknown>;
const note = (over: NoteOver = {}): VideoNoteThreadDto => ({
  id: nid(), assetId: ids.asset2, parentId: null, author: { kind: "staff", person: me }, authorRole: "admin", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, resolved: null, revision: 1, createdAt: T(1), editedAt: null, copiedFrom: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;
const replyTo = (root: VideoNoteThreadDto, over: NoteOver = {}) => { const { replies: _r, ...rest } = note({ parentId: root.id, startFrame: null, visibility: root.visibility, ...over }); return rest; };

// 6 roots: me internal point @10, Mia public point @50 (2 replies), Mia internal range [100,126), me public range [200,251) resolved, a tombstone with a reply @150, a guest public point @250.
function buildSeed() {
  const n1 = note({ body: "Fix the lower third", startFrame: 10, visibility: "internal" });
  const n2base = note({ author: { kind: "staff", person: mia }, authorRole: "editor", body: "Colour looks warm", startFrame: 50, visibility: "public", createdAt: T(2) });
  const n2 = { ...n2base, replies: [replyTo(n2base, { body: "Agreed", createdAt: T(3) }), replyTo(n2base, { author: { kind: "staff", person: me }, body: "Will grade", createdAt: T(4) })] } as VideoNoteThreadDto;
  const n3 = note({ author: { kind: "staff", person: mia }, authorRole: "editor", body: "Cut earlier", startFrame: 100, endFrame: 126, visibility: "internal", createdAt: T(5) });
  const n4 = note({ body: "Logo placement", startFrame: 200, endFrame: 251, visibility: "public", resolved: { at: T(9), by: me }, createdAt: T(6) });
  const n5base = note({ author: { kind: "staff", person: mia }, authorRole: "editor", body: "", deleted: true, startFrame: 150, visibility: "internal", createdAt: T(7) });
  const n5 = { ...n5base, replies: [replyTo(n5base, { body: "Still relevant", createdAt: T(8) })] } as VideoNoteThreadDto;
  const n6 = note({ author: { kind: "guest", id: "55555555-5555-4555-8555-555555555555", name: "Gina Client" }, authorRole: "guest", body: "From the client", startFrame: 250, visibility: "public", createdAt: T(10) });
  return { n1, n2, n3, n4, n5, n6, all: [n1, n2, n3, n4, n5, n6] };
}

/** One seed per test: `mount` and the test body must see the same ids. */
let seedCache: ReturnType<typeof buildSeed> | null = null;
const seed = () => (seedCache ??= buildSeed());
let stub: VideoElementStub; let root: Root | null = null; let host: HTMLElement;
let served: Record<string, VideoNoteThreadDto[]>;
/** What the "server" holds after a write, so the refetch that follows every write reads it back. */
const commit = (thread: VideoNoteThreadDto) => { served[thread.assetId] = [...(served[thread.assetId] ?? []).filter((n) => n.id !== thread.id), thread].sort((a, b) => (a.startFrame ?? 0) - (b.startFrame ?? 0)); return thread; };
const drop = (rootId: string) => { for (const key of Object.keys(served)) served[key] = served[key]!.filter((n) => n.id !== rootId); };
let archived = false;
/** What the server answers the lazy markup read with, by note id. */
let markups: Record<string, { revision: number; markup: unknown[] | null }> = {};
const markupFor = (noteId: string) => { const held = markups[noteId]; if (!held) throw new ApiError("Not found", 404, { error: "Not found" }); return { noteId, revision: held.revision, markup: held.markup }; };
let queryClient: QueryClient | null = null;
function Probe() { queryClient = useQueryClient(); return null; }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const playerVideo = () => dialog()?.querySelector("video") ?? null;
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const threads = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-note-thread"]')];
const threadOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="video-note-thread"][data-note-id="${id}"]`)!;
const noteIds = () => threads().map((t) => t.dataset.noteId!);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
async function key(k: string, target: Element, init: KeyboardEventInit = {}) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); }); }
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function mount(opts: { role?: Role; parts?: string[]; archivedProject?: boolean; latch?: boolean; notes?: Record<string, VideoNoteThreadDto[]> } = {}) {
  served = opts.notes ?? { [ids.asset2]: seed().all, [ids.asset1]: [note({ assetId: ids.asset1, body: "Version one note", startFrame: 5 })] };
  archived = opts.archivedProject ?? false;
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [videoOf()] };
    const match = /\/video-versions\/([^/]+)\/notes$/.exec(path);
    if (match) return { notes: served[match[1]!] ?? [] };
    const markupMatch = /\/video-notes\/([^/]+)\/markup$/.exec(path);
    if (markupMatch) return markupFor(markupMatch[1]!);
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const role = opts.role ?? "editor";
  const review = { open: true, parts: (opts.parts ?? ["notes"]) as never };
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><Probe />{opts.latch
    ? <ArchivedFromCache projectId={PROJECT} archived={archived}>{(latched) => <VideoCollectionPanel projectId={PROJECT} role={role} archived={latched} review={review} />}</ArchivedFromCache>
    : <VideoCollectionPanel projectId={PROJECT} role={role} archived={archived} review={review} />}</QuincyQueryProvider>); });
  await flush();
}
async function openViewer() {
  const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Open review")!;
  open.focus();
  await click(open);
  // The viewer is a lazy chunk: under a loaded verify run its import can outlast a fixed number of
  // ticks, so wait on the clock and fail loudly instead of handing a null <video> to the stub.
  const deadline = Date.now() + 10_000;
  while (!playerVideo()) {
    if (Date.now() > deadline) throw new Error("openViewer: the review player never mounted");
    await flush(1);
  }
  await flush(4);
}
/** Lands frame 0 the way a real load does, then presents `frame`. */
async function loadFilm(frame = 0) {
  const video = playerVideo()!;
  await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
  await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); });
  if (frame) await present(frame);
  stub.writes.length = 0; stub.calls.length = 0;
}
const present = (frame: number) => act(async () => { stub.presentFrame(playerVideo()!, frame / 25); });
async function openFilm(opts: Parameters<typeof mount>[0] = {}, frame = 0) { await mount(opts); await openViewer(); await loadFilm(frame); await flush(4); }
async function pickVersion(label: string) {
  const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
  seedCache = null; markups = {};
  stub = installVideoElementStub();
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
});


// ---- Drawing on notes (#741 6b-ui) ----
const popup = () => dialog()!;
const composerBox = () => tid("video-note-composer");
const composerText = () => composerBox()!.querySelector<HTMLElement>("textarea") as HTMLTextAreaElement;
const dispatchKey = (target: Element, k: string, init: KeyboardEventInit = {}) => key(k, target, init);
async function chooseNoteAction(scope: ParentNode, name: string, label: "Edit" | "Delete") {
  const trigger = scope.querySelector<HTMLElement>(`[aria-label="Actions for note by ${name}"]`)!;
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label)!;
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}
const settle = (ms = 300) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });

const ON = ["notes", "markup"];
const drawButton = () => tid("video-markup-toolbar-draw") as HTMLButtonElement | null;
const doneButton = () => tid("video-markup-done");
const layer = () => tid("video-markup-layer") as unknown as SVGSVGElement;
const strokesOnScreen = () => document.querySelectorAll('[data-testid="video-markup-stroke"]').length;
const RECT = { left: 100, top: 200, width: 800, height: 450 };

/** The stage has no layout in happy-dom: give the <video> an 800x800 box (a 16:9 picture then sits at top 175, 450 tall) and the layer a rect. */
let restoreLayout: (() => void) | null = null;
beforeEach(() => {
  const original = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  for (const [prop, value] of [["offsetWidth", 800], ["offsetHeight", 800], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  restoreLayout = () => {
    for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) {
      const d = original[prop];
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  };
});
afterEach(() => { restoreLayout?.(); restoreLayout = null; });

/** Brings the frame a seek asked for up on screen, the way the browser does. */
const land = (frame: number) => act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, frame / 25); });
async function startDrawing(frame = 12) {
  await click(drawButton()!);
  await land(frame);
  await flush(2);
  const svg = layer();
  svg.getBoundingClientRect = () => ({ ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height, x: RECT.left, y: RECT.top, toJSON: () => ({}) }) as DOMRect;
  (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  return svg;
}
async function pointer(svg: Element, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, over: PointerEventInit = {}) {
  await act(async () => { svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y, ...over })); await Promise.resolve(); });
}
async function stroke(svg: Element, from: [number, number], to: [number, number]) {
  await pointer(svg, "pointerdown", from[0], from[1]); await pointer(svg, "pointermove", to[0], to[1]); await pointer(svg, "pointerup", to[0], to[1]);
}
const markNote = (over: NoteOver = {}) => note({ body: "Has a drawing", startFrame: 30, endFrame: null, drawingFrame: 30, hasMarkup: true, revision: 3, ...over });
const STROKE = { color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] };

describe("Draw control visibility (#741 6b-ui)", () => {
  it("shows one 'Draw' button when the part is on, the viewer can annotate, the composer exists and the film is paused", async () => {
    await openFilm({ parts: ON }, 12);
    expect(drawButton()).not.toBeNull();
    expect(drawButton()!.textContent).toContain("Draw");
    expect(tid("video-markup-done")).toBeNull();
    expect(dialog()!.querySelector('[aria-label="Markup tool"]')).toBeNull();
  });

  it("is absent altogether when the markup part is off, and notes still post as they always did", async () => {
    await openFilm({ parts: ["notes"] }, 12);
    expect(drawButton()).toBeNull();
    expect(tid("video-markup")).toBeNull();
    await type(composerText(), "Plain note");
    api.apiPost.mockResolvedValue(note({ startFrame: 12, body: "Plain note" }));
    await click(tid("video-note-post")!);
    await land(12);
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/notes`, { startFrame: 12, visibility: "internal", body: "Plain note" });
  });

  it("is hidden while the film plays and back once it is paused", async () => {
    await openFilm({ parts: ON }, 12);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Play"]')!);
    expect(drawButton()).toBeNull();
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Pause"]')!);
    await present(14);
    expect(drawButton()).not.toBeNull();
  });

  it("is hidden for a viewer who cannot annotate video, on an archived Project, and while a reply is open", async () => {
    await openFilm({ parts: ON, role: "photographer" }, 12);
    expect(drawButton()).toBeNull();
  });

  it("is hidden on an archived Project and while a reply form is open; an edit of a root keeps it", async () => {
    const s = seed();
    await openFilm({ parts: ON }, 12);
    await click(threadOf(s.n1.id).querySelector<HTMLElement>('[data-testid="video-note-reply-button"]')!);
    expect(drawButton()).toBeNull();
    await click(tid("video-note-reply-cancel")!);
    expect(drawButton()).not.toBeNull();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    expect(drawButton()).not.toBeNull();
  });

  it("an archived Project has no Draw control", async () => {
    await openFilm({ parts: ON, archivedProject: true }, 12);
    expect(drawButton()).toBeNull();
  });
});

describe("Draw mode (#741 6b-ui)", () => {
  it("Draw pauses, waits for the frame, then expands the pill in place with a trailing Done", async () => {
    await openFilm({ parts: ON }, 12);
    await click(drawButton()!);
    await land(12);
    await flush(2);
    expect(drawButton()).toBeNull();
    expect(doneButton()).not.toBeNull();
    expect(dialog()!.querySelector('[aria-label="Markup tool"]')).not.toBeNull();
    expect(tid("video-markup")!.dataset.drawing).toBe("true");
    expect(layer().style.touchAction).toBe("none");
  });

  it("input exists only while drawing: the layer lets pointers through at rest and takes them (touch-action none) while drawing", async () => {
    await openFilm({ parts: ON }, 12);
    expect(layer().style.pointerEvents).toBe("none");
    expect(layer().style.touchAction).toBe("auto");
    await startDrawing();
    expect(layer().style.pointerEvents).toBe("auto");
    await click(doneButton()!);
    expect(layer().style.pointerEvents).toBe("none");
    expect(layer().style.touchAction).toBe("auto");
  });

  it("a dragged stroke is stored as fractions of the picture, and Done keeps it (the Draw button returns)", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await stroke(svg, [500, 425], [900, 650]); // the middle of the picture to its bottom-right corner
    expect(strokesOnScreen()).toBe(1);
    const held = stores.made.at(-1)!.slot(ids.asset2).markup;
    expect(held.items).toHaveLength(1);
    expect(held.items[0]!.points[0]).toEqual({ x: 0.5, y: 0.5 });
    expect(held.items[0]!.points[1]).toEqual({ x: 1, y: 1 });
    expect(held.drawingFrame).toBe(12);
    await click(doneButton()!);
    expect(drawButton()).not.toBeNull();
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(1);
    expect(tid("video-note-drawing-chip")).not.toBeNull();
    expect(strokesOnScreen()).toBe(1); // paused on its frame: the draft still shows
  });

  it("a second finger does not draw: one pointer owns a gesture, the others are ignored", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await pointer(svg, "pointerdown", 500, 425);
    await pointer(svg, "pointerdown", 300, 300, { pointerId: 2 });
    await pointer(svg, "pointermove", 600, 500, { pointerId: 2 });
    await pointer(svg, "pointerup", 600, 500, { pointerId: 2 });
    await pointer(svg, "pointermove", 800, 600);
    await pointer(svg, "pointerup", 800, 600);
    const items = stores.made.at(-1)!.slot(ids.asset2).markup.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.points[0]).toEqual({ x: 0.5, y: 0.5 });
  });

  it("Cmd+Z undoes a whole stroke, Shift+Cmd+Z redoes it, Ctrl+Y redoes, and none of it happens in a text field", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await stroke(svg, [200, 300], [400, 400]);
    await stroke(svg, [250, 320], [450, 420]);
    const count = () => stores.made.at(-1)!.slot(ids.asset2).markup.items.length;
    expect(count()).toBe(2);
    await key("z", document.body, { metaKey: true });
    expect(count()).toBe(1);
    await key("z", document.body, { metaKey: true, shiftKey: true });
    expect(count()).toBe(2);
    await key("z", document.body, { ctrlKey: true });
    expect(count()).toBe(1);
    await key("y", document.body, { ctrlKey: true });
    expect(count()).toBe(2);
    await key("y", document.body, { metaKey: true }); // Cmd+Y is History on macOS, not redo
    await key("z", composerText(), { metaKey: true });
    expect(count()).toBe(2);
  });

  it("locks the transport while drawing: Space, J, K, L, arrows, Home, End, I and O move nothing, the buttons are inert, and a held K is forgotten", async () => {
    await openFilm({ parts: ON }, 12);
    await startDrawing();
    stub.calls.length = 0; stub.writes.length = 0;
    for (const k of [" ", "j", "k", "l", "ArrowRight", "ArrowLeft", "Home", "End", "i", "o"]) await dispatchKey(popup(), k);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "k", bubbles: true })); });
    expect(stub.calls).toEqual([]);
    expect(stub.writes).toEqual([]);
    expect(tid("video-pending-band")).toBeNull();
    for (const label of ["Play", "Previous frame", "Next frame"]) expect(dialog()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.disabled).toBe(true);
    expect((tid("video-note-set-in") as HTMLButtonElement).disabled).toBe(true);
    await click(doneButton()!);
    for (const label of ["Play", "Previous frame", "Next frame"]) expect(dialog()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.disabled).toBe(false);
    await dispatchKey(popup(), "ArrowRight");
    expect(stub.writes.length).toBeGreaterThan(0);
  });

  it("selecting or seeking to another note is refused while drawing", async () => {
    const s = seed();
    await openFilm({ parts: ON }, 12);
    await startDrawing();
    stub.writes.length = 0;
    await click(tid("video-note-anchor-button", threadOf(s.n2.id))!);
    expect(stub.writes).toEqual([]);
    expect(threadOf(s.n2.id).dataset.selected).toBe("false");
  });
});

describe("Escape order with a drawing (#741 6b-ui)", () => {
  const escape = (target: Element) => dispatchKey(target, "Escape");

  it("the first Escape leaves draw mode and keeps the strokes, the next is the dirty-form hold, the third closes the viewer", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await stroke(svg, [200, 300], [400, 400]);
    await escape(popup());
    expect(drawButton()).not.toBeNull();
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(1);
    expect(dialog()).not.toBeNull();
    await escape(popup());
    expect(dialog()).not.toBeNull();
    await escape(popup());
    await flush(4);
    expect(dialog()).toBeNull();
  });

  it("a popup open over the viewer takes Escape before draw mode does", async () => {
    await openFilm({ parts: ON }, 12);
    await startDrawing();
    await click(tid("video-details-button")!);
    await flush(4);
    expect(tid("video-details-popover")).not.toBeNull();
    await escape(popup());
    await flush(4);
    expect(tid("video-details-popover")).toBeNull();
    expect(tid("video-markup")!.dataset.drawing).toBe("true");
  });

  it("an Escape during the frame confirmation cancels it", async () => {
    await openFilm({ parts: ON }, 12);
    await click(drawButton()!);
    await escape(popup());
    await land(12);
    await flush(2);
    expect(tid("video-markup")!.dataset.drawing).toBe("false");
    expect(drawButton()).not.toBeNull();
  });
});

describe("Posting a drawing (#741 6b-ui)", () => {
  it("Post confirms the drawing frame again and sends markup with drawingFrame, as a point on that frame", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    await type(composerText(), "Look at this");
    api.apiPost.mockResolvedValue(commit(note({ startFrame: 12, drawingFrame: 12, hasMarkup: true, body: "Look at this" })));
    await present(60); // the film moved on while the person wrote
    await click(tid("video-note-post")!);
    expect(api.apiPost).not.toHaveBeenCalled();
    await land(12);
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/notes`, {
      startFrame: 12, visibility: "internal", body: "Look at this", drawingFrame: 12,
      markup: [{ color: "#e64b3c", width: 4, points: [{ x: 0.5, y: 0.5 }, { x: 1, y: 1 }] }],
    });
    expect(tid("video-note-drawing-chip")).toBeNull();
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(0);
  });

  it("Remove drawing in the composer takes the strokes away and the note posts plain", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    await click(tid("video-note-remove-drawing")!);
    expect(tid("video-note-drawing-chip")).toBeNull();
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(0);
  });

  it.each([
    [413, "markup_too_large", /too large/i],
    [422, "drawing_frame_outside", /frame the note covers/i],
  ])("a %s %s refusal is read to the person and the drawing is kept", async (status, code, text) => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    await type(composerText(), "Look");
    api.apiPost.mockRejectedValue(new ApiError("refused", status, { code }));
    await click(tid("video-note-post")!);
    await land(12);
    await flush(4);
    expect(composerBox()!.textContent).toMatch(text);
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(1);
  });

  it("a 404 on a post that carries a drawing says the drawing is unavailable and keeps the draft", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    await type(composerText(), "Look");
    api.apiPost.mockRejectedValue(new ApiError("Not found", 404, { error: "Not found" }));
    await click(tid("video-note-post")!);
    await land(12);
    await flush(4);
    expect(composerBox()!.textContent).toMatch(/drawing isn't available/i);
    expect(composerText().value).toBe("Look");
  });
});

describe("A note's saved drawing (#741 6b-ui)", () => {
  async function withDrawnNote(extra: NoteOver = {}) {
    const drawn = markNote(extra);
    markups = { [drawn.id]: { revision: 3, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [drawn], [ids.asset1]: [] } }, 5);
    return drawn;
  }
  const markupReads = () => api.apiGet.mock.calls.filter(([path]) => String(path).endsWith("/markup")).length;

  it("is not fetched until the note is selected; selecting seeks to the drawing's frame and shows it, once per revision", async () => {
    const drawn = await withDrawnNote();
    expect(markupReads()).toBe(0);
    expect(strokesOnScreen()).toBe(0);
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(4);
    expect(markupReads()).toBe(1);
    expect(strokesOnScreen()).toBe(1);
    await present(31);
    expect(strokesOnScreen()).toBe(0); // not on its frame
    await present(30);
    expect(strokesOnScreen()).toBe(1);
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(4);
    expect(markupReads()).toBe(1); // the same revision is cached
  });

  it("hides while the film plays and when the filters exclude the note", async () => {
    const drawn = await withDrawnNote();
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(4);
    expect(strokesOnScreen()).toBe(1);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Play"]')!);
    expect(strokesOnScreen()).toBe(0);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Pause"]')!);
    await land(30);
    await flush(2);
    expect(strokesOnScreen()).toBe(1);
    await click(tid("video-notes-filter-visibility-public")!);
    await flush(2);
    expect(strokesOnScreen()).toBe(0);
  });

  it("never shows or fetches a drawing when the markup part is off", async () => {
    const drawn = markNote();
    markups = { [drawn.id]: { revision: 3, markup: [STROKE] } };
    await openFilm({ parts: ["notes"], notes: { [ids.asset2]: [drawn], [ids.asset1]: [] } }, 5);
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(4);
    expect(strokesOnScreen()).toBe(0);
    expect(markupReads()).toBe(0);
    expect(tid("video-note-has-drawing", threadOf(drawn.id))!.textContent).toMatch(/hidden/i); // the row says so, but nothing is drawn or fetched
  });

  it("a note with a drawing carries a pen mark on its row", async () => {
    const drawn = await withDrawnNote();
    expect(tid("video-note-has-drawing", threadOf(drawn.id))!.textContent).toContain("Drawing");
  });
});

describe("Editing a note's drawing (#741 6b-ui)", () => {
  async function editing(over: NoteOver = {}, withMarkup = true) {
    const target = withMarkup ? markNote({ author: { kind: "staff", person: me }, ...over }) : note({ body: "Plain", startFrame: 40, endFrame: 60, ...over });
    if (withMarkup) markups = { [target.id]: { revision: target.revision, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [target], [ids.asset1]: [] } }, 45);
    await chooseNoteAction(threadOf(target.id), "Terry", "Edit");
    await flush(4);
    return target;
  }

  it("adding a drawing to a plain note sends markup and the drawing frame, never frames", async () => {
    const target = await editing({}, false);
    expect(tid("video-note-edit-draw")!.textContent).toContain("Add drawing");
    await click(tid("video-note-edit-draw")!);
    await land(45);
    await flush(2);
    const svg = layer();
    svg.getBoundingClientRect = () => ({ ...RECT, right: 900, bottom: 650, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
    (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    expect(tid("video-note-edit-set-in")).toBeNull(); // the frame controls lock once the drawing is touched
    api.apiPatch.mockResolvedValue(commit({ ...target, drawingFrame: 45, hasMarkup: true, revision: 2 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await land(45);
    await flush(4);
    expect(api.apiPatch).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${target.id}`, {
      expectedRevision: 1, drawingFrame: 45, markup: [{ color: "#e64b3c", width: 4, points: [{ x: 0.5, y: 0.5 }, { x: 1, y: 1 }] }],
    });
  });

  it("'Edit drawing' waits for the saved drawing, opens it on its own frame, and Save sends the replaced list", async () => {
    const target = await editing();
    await flush(4);
    expect(tid("video-note-edit-set-in")).toBeNull(); // a note with a drawing has no frame controls
    await click(tid("video-note-edit-draw")!);
    expect(stub.writes.at(-1)).toBeCloseTo(frameSeekSeconds(30, { num: 25, den: 1 }), 5);
    await land(30);
    await flush(2);
    const svg = layer();
    svg.getBoundingClientRect = () => ({ ...RECT, right: 900, bottom: 650, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
    (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    api.apiPatch.mockResolvedValue(commit({ ...target, revision: 4 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await land(30);
    await flush(4);
    const [, body] = api.apiPatch.mock.calls.at(-1) as [string, { expectedRevision: number; markup: unknown[]; drawingFrame: number }];
    expect(body.expectedRevision).toBe(3);
    expect(body.drawingFrame).toBe(30);
    expect(body.markup).toHaveLength(2);
    expect(body.markup[0]).toEqual(STROKE);
  });

  it("'Remove drawing' is a pending change shown in the form; Keep drawing takes it back; Save sends markup null", async () => {
    const target = await editing();
    await flush(2);
    await click(tid("video-note-edit-remove-drawing")!);
    expect(tid("video-note-edit-drawing-removed")).not.toBeNull();
    await click(tid("video-note-edit-keep-drawing")!);
    expect(tid("video-note-edit-drawing-removed")).toBeNull();
    await click(tid("video-note-edit-remove-drawing")!);
    api.apiPatch.mockResolvedValue(commit({ ...target, hasMarkup: false, drawingFrame: null, revision: 4 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(api.apiPatch).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${target.id}`, { expectedRevision: 3, markup: null });
  });

  it("markup_locks_frames is read to the person and the edit stays open", async () => {
    const target = await editing();
    await flush(2);
    await click(tid("video-note-edit-remove-drawing")!);
    api.apiPatch.mockRejectedValue(new ApiError("A note with a drawing cannot be moved.", 422, { code: "markup_locks_frames" }));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(threadOf(target.id).textContent).toMatch(/can't be moved/i);
    expect(tid("video-note-edit-save")).not.toBeNull();
  });

  it("the Edit drawing button stays off until the saved drawing has loaded, and a failed read offers Retry (the editor is never seeded with nothing)", async () => {
    const target = markNote({ author: { kind: "staff", person: me } });
    await openFilm({ parts: ON, notes: { [ids.asset2]: [target], [ids.asset1]: [] } }, 45); // no markups entry: the read answers 404
    await chooseNoteAction(threadOf(target.id), "Terry", "Edit");
    await flush(6);
    expect((tid("video-note-edit-draw") as HTMLButtonElement).disabled).toBe(true);
    expect(threadOf(target.id).textContent).toMatch(/could not be loaded/i);
  });
});

describe("A drawing with an item this build cannot read (#741 6b-ui, 6s override 2)", () => {
  const FUTURE = { type: "spiral", color: "#e64b3c", width: 4, points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }] };
  async function future() {
    const target = markNote({ author: { kind: "staff", person: me } });
    markups = { [target.id]: { revision: target.revision, markup: [STROKE, FUTURE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [target], [ids.asset1]: [] } }, 5);
    return target;
  }

  it("shows the known items, nothing for the unknown one, and the short note beside the drawing (no throw on the read)", async () => {
    const target = await future();
    await click(tid("video-note-anchor-button", threadOf(target.id))!);
    await land(30);
    await flush(4);
    expect(strokesOnScreen()).toBe(1);
    expect(tid("video-markup-unsupported")!.textContent).toBe("Some markup can't be shown");
    await present(31);
    expect(tid("video-markup-unsupported")).toBeNull(); // the note goes with the drawing
  });

  it("a fully readable drawing shows no note", async () => {
    const target = markNote({ author: { kind: "staff", person: me } });
    markups = { [target.id]: { revision: 3, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [target], [ids.asset1]: [] } }, 5);
    await click(tid("video-note-anchor-button", threadOf(target.id))!);
    await land(30);
    await flush(4);
    expect(strokesOnScreen()).toBe(1);
    expect(tid("video-markup-unsupported")).toBeNull();
  });

  it("disables Edit drawing and Remove drawing in the edit form, with the reason, and the Draw pill is not offered", async () => {
    const target = await future();
    await chooseNoteAction(threadOf(target.id), "Terry", "Edit");
    await flush(6);
    const edit = tid("video-note-edit-draw") as HTMLButtonElement;
    const remove = tid("video-note-edit-remove-drawing") as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    const reason = tid("video-note-edit-drawing-unsupported")!;
    expect(reason.textContent).toMatch(/can't be shown/);
    expect(edit.getAttribute("aria-describedby")).toBe(reason.id);
    expect(remove.getAttribute("aria-describedby")).toBe(reason.id);
    expect(drawButton()).toBeNull();
    await click(edit); await click(remove);
    expect(tid("video-note-edit-drawing-removed")).toBeNull();
  });

  it("a text-only edit still saves, and its PATCH carries no markup key", async () => {
    const target = await future();
    await chooseNoteAction(threadOf(target.id), "Terry", "Edit");
    await flush(6);
    await type(threadOf(target.id).querySelector("textarea") as HTMLTextAreaElement, "Reworded");
    api.apiPatch.mockResolvedValue(commit({ ...target, body: "Reworded", revision: 4 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    const [, body] = api.apiPatch.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(body).toEqual({ expectedRevision: 3, body: "Reworded" });
    expect("markup" in body).toBe(false);
    expect("drawingFrame" in body).toBe(false);
  });
});

describe("Code-review fixes (#741 6b-ui)", () => {
  const notesReads = () => api.apiGet.mock.calls.filter(([path]) => /\/notes$/.test(String(path))).length;
  const sized = (svg: Element) => {
    svg.getBoundingClientRect = () => ({ ...RECT, right: 900, bottom: 650, x: 100, y: 200, toJSON: () => ({}) }) as DOMRect;
    (svg as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  };
  async function editingSaved(over: NoteOver = {}) {
    const target = markNote({ author: { kind: "staff", person: me }, ...over });
    markups = { [target.id]: { revision: target.revision, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [target], [ids.asset1]: [] } }, 45);
    await chooseNoteAction(threadOf(target.id), "Terry", "Edit");
    await flush(6);
    return target;
  }
  const editItems = () => stores.made.at(-1)!.slot(ids.asset2).open?.drawing.items ?? null;

  it("Clear in the pill clears the drawing being edited, not the composer's draft", async () => {
    await editingSaved();
    await click(tid("video-note-edit-draw")!);
    await land(30);
    await flush(2);
    const svg = layer(); sized(svg);
    await stroke(svg, [500, 425], [900, 650]);
    expect(editItems()).toHaveLength(2);
    await click(popup().querySelector<HTMLElement>('button[aria-label="Clear"]')!);
    expect(editItems()).toEqual([]);
  });

  it("new strokes after the saved drawing was removed save on their own frame", async () => {
    const target = await editingSaved({ endFrame: 60 });
    await click(tid("video-note-edit-remove-drawing")!);
    await click(drawButton()!);
    await land(45);
    await flush(2);
    const svg = layer(); sized(svg);
    await stroke(svg, [500, 425], [900, 650]);
    expect(stores.made.at(-1)!.slot(ids.asset2).open?.drawing.drawingFrame).toBe(45);
    await click(doneButton()!);
    api.apiPatch.mockResolvedValue(commit({ ...target, revision: 4 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await land(45);
    await flush(4);
    expect(api.apiPatch.mock.calls.at(-1)![1]).toMatchObject({ drawingFrame: 45 });
  });

  it("a drawing whose revision differs from the list's is not shown, and the notes list is read again", async () => {
    const drawn = markNote({ revision: 4 });
    markups = { [drawn.id]: { revision: 5, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [drawn], [ids.asset1]: [] } }, 5);
    const before = notesReads();
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(6);
    expect(strokesOnScreen()).toBe(0);
    expect(notesReads()).toBeGreaterThan(before);
  });

  it("once the list shows the new revision, the new drawing shows on its new frame", async () => {
    const drawn = markNote({ revision: 4 });
    markups = { [drawn.id]: { revision: 5, markup: [STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [drawn], [ids.asset1]: [] } }, 5);
    served[ids.asset2] = [{ ...drawn, revision: 5, drawingFrame: 40, startFrame: 40 } as VideoNoteThreadDto];
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(6);
    await present(40);
    expect(strokesOnScreen()).toBe(1);
    await present(30);
    expect(strokesOnScreen()).toBe(0);
  });

  it("dragging out of the picture finishes the stroke at the last point inside it", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await pointer(svg, "pointerdown", 500, 425);
    await pointer(svg, "pointermove", 600, 500);
    await pointer(svg, "pointermove", 950, 500); // right of the picture: a letterbox band
    await pointer(svg, "pointermove", 700, 600); // back inside: the stroke is over
    await pointer(svg, "pointerup", 700, 600);
    const items = stores.made.at(-1)!.slot(ids.asset2).markup.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.points).toHaveLength(2);
    expect(items[0]!.points.at(-1)!.x).toBeLessThan(1);
  });

  it("only the primary pointer's left button draws: right-click and a non-primary pointer do not", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    for (const over of [{ button: 2 }, { isPrimary: false }] as PointerEventInit[]) {
      await pointer(svg, "pointerdown", 500, 425, over);
      await pointer(svg, "pointermove", 600, 500, over);
      await pointer(svg, "pointerup", 600, 500, over);
    }
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(0);
    await stroke(svg, [500, 425], [600, 500]);
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.items).toHaveLength(1);
  });

  it("the floating Draw of an edit loads the saved drawing first, like Edit drawing", async () => {
    await editingSaved();
    await click(drawButton()!);
    await land(30);
    await flush(2);
    expect(tid("video-markup")!.dataset.drawing).toBe("true");
    expect(editItems()).toHaveLength(1);
    expect(stores.made.at(-1)!.slot(ids.asset2).draw).toMatchObject({ form: "edit", frame: 30 });
  });

  it("Remove drawing on a plain note drops the drawing just added to it", async () => {
    const plain = note({ author: { kind: "staff", person: me }, body: "Plain", startFrame: 40, endFrame: 60 });
    await openFilm({ parts: ON, notes: { [ids.asset2]: [plain], [ids.asset1]: [] } }, 45);
    await chooseNoteAction(threadOf(plain.id), "Terry", "Edit");
    await flush(4);
    await click(tid("video-note-edit-draw")!);
    await land(45);
    await flush(2);
    const svg = layer(); sized(svg);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    await click(tid("video-note-edit-remove-drawing")!);
    expect(stores.made.at(-1)!.slot(ids.asset2).open?.drawing).toMatchObject({ items: null, touched: false, drawingFrame: null });
    expect(tid("video-note-edit-set-in")).not.toBeNull(); // the frame controls are back
  });

  it("Clear marks is off while drawing", async () => {
    await openFilm({ parts: ON }, 12);
    await click(tid("video-note-set-in")!);
    await present(40);
    await click(tid("video-note-set-out")!);
    await present(20);
    expect((tid("video-note-clear-marks") as HTMLButtonElement).disabled).toBe(false);
    await startDrawing(20);
    expect((tid("video-note-clear-marks") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Undo after Clear cannot carry the old strokes to a different frame", async () => {
    await openFilm({ parts: ON }, 12);
    let svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(popup().querySelector<HTMLElement>('button[aria-label="Clear"]')!);
    await click(doneButton()!);
    await present(45);
    svg = await startDrawing(45);
    const undo = popup().querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!;
    expect(undo.disabled).toBe(true);
    await click(undo);
    expect(stores.made.at(-1)!.slot(ids.asset2).markup).toMatchObject({ items: [], drawingFrame: null });
    await stroke(svg, [500, 425], [600, 500]);
    expect(stores.made.at(-1)!.slot(ids.asset2).markup.drawingFrame).toBe(45);
  });

  it("an unsaved drawing added to a note that had none stays on the picture after Done", async () => {
    const plain = note({ author: { kind: "staff", person: me }, body: "Plain", startFrame: 40, endFrame: 60 });
    await openFilm({ parts: ON, notes: { [ids.asset2]: [plain], [ids.asset1]: [] } }, 45);
    await click(tid("video-note-anchor-button", threadOf(plain.id))!);
    await land(40);
    await chooseNoteAction(threadOf(plain.id), "Terry", "Edit");
    await flush(4);
    await click(tid("video-note-edit-draw")!);
    await land(40);
    await flush(2);
    const svg = layer(); sized(svg);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    expect(strokesOnScreen()).toBe(1);
    await present(41);
    expect(strokesOnScreen()).toBe(0);
  });

  it("a tapped dot keeps its CSS-pixel width: a zero-length round non-scaling path, not a circle scaled with the picture", async () => {
    await openFilm({ parts: ON }, 12);
    const svg = await startDrawing();
    await pointer(svg, "pointerdown", 500, 425); await pointer(svg, "pointerup", 500, 425);
    const dot = document.querySelector('[data-testid="video-markup-stroke"]')!;
    expect(dot.tagName.toLowerCase()).toBe("path");
    expect(dot.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(dot.getAttribute("stroke-linecap")).toBe("round");
    expect(dot.getAttribute("stroke-width")).toBe("4");
    expect(dot.getAttribute("d")).toMatch(/^M\s*0\.5[,\s]+0\.5\s*h\s*0$/);
    expect(dot.getAttribute("r")).toBeNull();
  });

  it("an unsent composer drawing on one frame does not hide a selected note's drawing on another", async () => {
    const drawn = markNote();
    markups = { [drawn.id]: { revision: 3, markup: [STROKE, STROKE] } };
    await openFilm({ parts: ON, notes: { [ids.asset2]: [drawn], [ids.asset1]: [] } }, 12);
    const svg = await startDrawing(12);
    await stroke(svg, [500, 425], [900, 650]);
    await click(doneButton()!);
    expect(strokesOnScreen()).toBe(1); // the draft, on its own frame
    await click(tid("video-note-anchor-button", threadOf(drawn.id))!);
    await land(30);
    await flush(4);
    expect(strokesOnScreen()).toBe(2); // the note's drawing
    await present(12);
    expect(strokesOnScreen()).toBe(1); // the draft again on its frame
  });
});
