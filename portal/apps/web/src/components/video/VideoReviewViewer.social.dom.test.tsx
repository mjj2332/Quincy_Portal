import { legacyBodyToRichTextDoc } from "@quincy/shared";
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
import { installLocalStorageShim } from "../../testing/local-storage";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../../lib/time-format-prefs";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

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
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, reviewStatus: "in_review", uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 25, den: 1 }, tcNominalFps: 25, startTimecodeFrames: 90000, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

const OA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Reels safe zone", platformLabel: "Instagram Reels", isDefault: true, imageUrl: "/social-overlay-images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111", width: 1080, height: 1920 };
const OB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "TikTok safe zone", platformLabel: "TikTok", isDefault: false, imageUrl: "/social-overlay-images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222", width: 1080, height: 1920 };
let resolvedOverlays: Array<typeof OA> = [OA, OB];
let overlayReads = 0;
let overlaysFail = false;
const overlaysState = () => { if (overlaysFail) throw new ApiError("closed", 404); return { available: [], selected: [], resolved: resolvedOverlays, revision: "0".repeat(64) }; };

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

async function mount(opts: { role?: Role; parts?: string[]; archivedProject?: boolean; latch?: boolean; notes?: Record<string, VideoNoteThreadDto[]>; link?: { note: string } } = {}) {
  served = opts.notes ?? { [ids.asset2]: seed().all, [ids.asset1]: [note({ assetId: ids.asset1, body: "Version one note", startFrame: 5 })] };
  archived = opts.archivedProject ?? false;
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [videoOf()] };
    if (path.endsWith("/social-overlays")) { overlayReads += 1; return overlaysState(); }
    const match = /\/video-versions\/([^/]+)\/notes$/.exec(path);
    if (match) return { notes: served[match[1]!] ?? [] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const role = opts.role ?? "editor";
  const review = { open: true, parts: (opts.parts ?? ["notes"]) as never };
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><Probe />{opts.latch
    ? <ArchivedFromCache projectId={PROJECT} archived={archived}>{(latched) => <VideoCollectionPanel projectId={PROJECT} role={role} archived={latched} review={review} />}</ArchivedFromCache>
    : <VideoCollectionPanel projectId={PROJECT} role={role} archived={archived} review={review} {...(opts.link ? { deepLink: { selection: { id: ids.video, version: 2, note: opts.link.note }, onChange: vi.fn() } } : {})} />}</QuincyQueryProvider>); });
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

let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => {
  shim = installLocalStorageShim(); resetUiPrefMemory();
  notifyManager.setScheduler((callback) => callback());
  seedCache = null;
  stub = installVideoElementStub();
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); shim.restore(); resetUiPrefMemory(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const popup = () => dialog()!;
const composerBox = () => tid("video-note-composer");
const composerText = () => composerBox()!.querySelector<HTMLElement>("textarea") as HTMLTextAreaElement;
async function chooseNoteAction(scope: ParentNode, name: string, label: "Edit" | "Delete") {
  const trigger = scope.querySelector<HTMLElement>(`[aria-label="Actions for note by ${name}"]`)!;
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label)!;
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}
const socialToggle = () => tid("video-social-toggle")!;
const stage = () => tid("video-stage")!;
const overlayImg = () => tid("video-social-overlay") as HTMLImageElement | null;
async function startSocial() { await click(socialToggle()); await flush(6); }
beforeEach(() => { resolvedOverlays = [OA, OB]; overlayReads = 0; overlaysFail = false; });

describe("Social preview in the staff viewer (#871)", () => {
  it("is off on open, fetches nothing until the toggle is pressed, then frames the film Fill with the first overlay", async () => {
    await openFilm({ parts: ["notes", "compare"] });
    expect(socialToggle().getAttribute("aria-pressed")).toBe("false");
    expect(overlayReads).toBe(0);
    expect(stage().dataset.social).toBeUndefined();
    await startSocial();
    expect(overlayReads).toBe(1);
    expect(socialToggle().getAttribute("aria-pressed")).toBe("true");
    expect(stage().dataset.social).toBe("fill");
    expect(overlayImg()!.getAttribute("src")).toBe(OA.imageUrl);
    expect(tid("video-social-overlay-select")!.textContent).toContain(OA.name);
  });

  it("keeps the same <video> element when Social is turned on, switched to Fit and off again", async () => {
    await openFilm();
    const before = playerVideo();
    await startSocial();
    await click(tid("video-social-fit")!);
    expect(stage().dataset.social).toBe("fit");
    await click(socialToggle()); await flush(2);
    expect(playerVideo()).toBe(before);
    expect(stage().dataset.social).toBeUndefined();
  });

  it("switches among the resolved overlays only", async () => {
    await openFilm();
    await startSocial();
    await click(tid("video-social-overlay-select")!); await flush(4);
    const names = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => [OA.name, OB.name].includes(o.textContent ?? "")).map((o) => o.textContent);
    expect(names).toEqual([OA.name, OB.name]);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === OB.name)!); await flush(4);
    expect(overlayImg()!.getAttribute("src")).toBe(OB.imageUrl);
  });

  it("an empty library says so and a failed read offers Retry", async () => {
    resolvedOverlays = [];
    await openFilm();
    await startSocial();
    expect(dialog()!.textContent).toContain("No overlay available");
    await click(socialToggle()); await flush(2);
    overlaysFail = true; resolvedOverlays = [OA];
    await startSocial(); await flush(10);
    expect(tid("video-social-retry")).not.toBeNull();
    overlaysFail = false;
    await click(tid("video-social-retry")!); await flush(8);
    expect(overlayImg()!.getAttribute("src")).toBe(OA.imageUrl);
  });

  it("pauses writing: the composer is replaced by a notice, no marker lane or range button, I marks nothing, and the typed draft is back after exit", async () => {
    await openFilm({}, 12);
    await type(composerText(), "keep me");
    await startSocial();
    expect(composerBox()!.closest("[hidden]")).not.toBeNull();
    expect(composerBox()!.closest("[inert]")).not.toBeNull();
    expect(tid("video-notes-social-paused")!.textContent).toContain("Notes are off in Social preview");
    expect(tid("video-marker-lane")).toBeNull();
    expect(tid("video-range-button")).toBeNull();
    await key("i", popup());
    await click(socialToggle()); await flush(2);
    expect(tid("video-pending-band")).toBeNull();
    expect(tid("video-range-button")).not.toBeNull();
    expect(composerText().value).toBe("keep me");
  });

  it("keeps the composer and an open reply form MOUNTED (same nodes) so a running upload survives a Social round trip", async () => {
    const s = seed();
    await openFilm({}, 12);
    await click(tid("video-note-reply-button", threadOf(s.n1.id))!);
    const composer = composerBox()!; const reply = threadOf(s.n1.id).querySelector('[data-notes-form="reply"]')!;
    await startSocial();
    await click(socialToggle()); await flush(2);
    expect(composerBox()).toBe(composer);
    expect(threadOf(s.n1.id).querySelector('[data-notes-form="reply"]')).toBe(reply);
  });

  it("cancels a Post waiting on its frame when Social is entered, keeps the draft, and never posts it", async () => {
    await openFilm({}, 7);
    await type(composerText(), "Point note");
    await present(40);
    api.apiPost.mockResolvedValue(note({ startFrame: 7, body: "Point note" }));
    await click(tid("video-note-post")!);
    await startSocial();
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 7 / 25); });
    await flush(4);
    expect(api.apiPost).not.toHaveBeenCalled();
    await click(socialToggle()); await flush(2);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(composerText().value).toBe("Point note");
  });

  it("keeps notes readable and hides an open reply form without dropping it", async () => {
    const s = seed();
    await openFilm();
    await click(tid("video-note-reply-button", threadOf(s.n1.id))!);
    await type(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>('[data-testid="video-note-reply-body"] textarea')!, "half a reply");
    await startSocial();
    expect(threadOf(s.n1.id)).not.toBeNull();
    const replyForm = threadOf(s.n1.id).querySelector('[data-notes-form="reply"]')!;
    expect(replyForm.closest("[hidden]")).not.toBeNull();
    expect(replyForm.closest("[inert]")).not.toBeNull();
    expect(tid("video-note-reply-button", threadOf(s.n1.id))).toBeNull();
    await click(socialToggle()); await flush(2);
    expect(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>('[data-notes-form="reply"] textarea')!.value).toBe("half a reply");
  });

  it("keeps a note readable while its Edit form is open and hidden by Social, and the form is back on exit", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    const form = threadOf(s.n1.id).querySelector('[data-notes-form="edit"]')!;
    await startSocial();
    expect(threadOf(s.n1.id).querySelector('[data-notes-form="edit"]')).toBe(form);
    expect(form.closest("[hidden]")).not.toBeNull();
    const body = tid("video-note-body", threadOf(s.n1.id))!;
    expect(body.textContent).toBe("Fix the lower third");
    expect(body.closest("[hidden]")).toBeNull();
    await click(socialToggle()); await flush(2);
    expect(form.closest("[hidden]")).toBeNull();
    expect(tid("video-note-body", threadOf(s.n1.id))).toBeNull();
  });

  it("stays on across a Version switch", async () => {
    await openFilm();
    await startSocial();
    await pickVersion("v1");
    expect(socialToggle().getAttribute("aria-pressed")).toBe("true");
    expect(stage().dataset.social).toBe("fill");
  });

  it("Compare and Social exclude each other, each disabled while the other is on", async () => {
    await openFilm({ parts: ["notes", "compare"] });
    await startSocial();
    expect((tid("video-compare-toggle") as HTMLButtonElement).disabled).toBe(true);
    await click(socialToggle()); await flush(2);
    expect((tid("video-compare-toggle") as HTMLButtonElement).disabled).toBe(false);
    await click(tid("video-compare-toggle")!); await flush(10);
    expect((socialToggle() as HTMLButtonElement).disabled).toBe(true);
  });

  it("Escape leaves Social first, then closes the viewer", async () => {
    await openFilm();
    await startSocial();
    await key("Escape", popup());
    await flush(4);
    expect(dialog()).not.toBeNull();
    expect(socialToggle().getAttribute("aria-pressed")).toBe("false");
    await key("Escape", popup());
    await flush(6);
    expect(dialog()).toBeNull();
  });

  it("is offered on an archived Project", async () => {
    await openFilm({ archivedProject: true });
    await startSocial();
    expect(stage().dataset.social).toBe("fill");
  });

  it("works with the notes part off", async () => {
    await openFilm({ parts: [] });
    await startSocial();
    expect(stage().dataset.social).toBe("fill");
  });
});
