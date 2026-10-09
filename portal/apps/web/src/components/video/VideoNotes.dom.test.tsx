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
  for (let i = 0; i < 200 && !playerVideo(); i += 1) await flush(1);
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
  seedCache = null;
  stub = installVideoElementStub();
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Video notes panel (#741 5b)", () => {
  it("shows the shown Version's open notes under 'Notes on v2', and switching Version shows that Version's notes (story 44)", async () => {
    const s = seed();
    await openFilm({ notes: { [ids.asset2]: s.all, [ids.asset1]: [note({ assetId: ids.asset1, body: "Version one note", startFrame: 5 })] } });
    expect(tid("video-notes-title")!.textContent).toBe("Notes on v2");
    expect(noteIds()).toEqual([s.n1.id, s.n2.id, s.n3.id, s.n5.id, s.n6.id]);
    expect(dialog()!.textContent).not.toContain("Version one note");
    await pickVersion("v1");
    expect(tid("video-notes-title")!.textContent).toBe("Notes on v1");
    expect(threads().map((t) => tid("video-note-body", t)!.textContent)).toEqual(["Version one note"]);
  });

  it("the header counts open and resolved roots (a tombstone with replies counts; a bare tombstone would not)", async () => {
    await openFilm();
    expect(tid("video-notes-counts")!.textContent).toBe("5 open · 1 resolved");
  });

  it("clicking a note's timecode seeks the film to the middle of that frame and pauses (story 23)", async () => {
    const s = seed();
    await openFilm({}, 0);
    await click(tid("video-play-toggle") ?? [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === "Play")!);
    expect(playerVideo()!.paused).toBe(false);
    stub.writes.length = 0;
    await click(tid("video-note-anchor-button", threadOf(s.n2.id))!);
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(50, { num: 25, den: 1 }));
    expect(playerVideo()!.paused).toBe(true);
    expect(threadOf(s.n2.id).dataset.selected).toBe("true");
  });

  it("shows a point as one timecode and a range as start → last included frame", async () => {
    const s = seed();
    await openFilm();
    expect(tid("video-note-anchor-button", threadOf(s.n1.id))!.textContent).toContain("01:00:00:10");
    expect(tid("video-note-anchor-button", threadOf(s.n3.id))!.textContent).toContain("01:00:04:00 → 01:00:05:00");
  });

  it("marks every internal note and internal reply Internal, and public ones Client-visible (story 33)", async () => {
    const s = seed();
    await openFilm({}, 0);
    await click(tid("video-notes-filter-status-all")!);
    const badge = (el: Element) => tid("video-note-visibility-badge", el)!;
    expect(badge(threadOf(s.n1.id)).textContent).toContain("Internal");
    expect(badge(threadOf(s.n2.id)).textContent).toContain("Client-visible");
    // Replies inherit the root's visibility and carry no badge of their own.
    for (const reply of [...threadOf(s.n5.id).querySelectorAll<HTMLElement>('[data-testid="video-note-reply"]')]) expect(tid("video-note-visibility-badge", reply)).toBeNull();
    for (const reply of [...threadOf(s.n2.id).querySelectorAll<HTMLElement>('[data-testid="video-note-reply"]')]) expect(tid("video-note-visibility-badge", reply)).toBeNull();
  });

  it("a note with replies lists them under it, oldest first; a tombstone reads 'Note deleted' with its replies and no Reply button (story 34)", async () => {
    const s = seed();
    await openFilm();
    expect([...threadOf(s.n2.id).querySelectorAll<HTMLElement>('[data-testid="video-note-reply"]')].map((r) => tid("video-note-body", r)!.textContent)).toEqual(["Agreed", "Will grade"]);
    const tomb = threadOf(s.n5.id);
    expect(tid("video-note-tombstone", tomb)!.textContent).toBe("Note deleted");
    expect([...tomb.querySelectorAll<HTMLElement>('[data-testid="video-note-body"]')].map((el) => el.textContent)).toEqual(["Still relevant"]);
    expect(tid("video-note-reply-button", tomb)).toBeNull();
    expect(tid("video-note-resolve", tomb)).not.toBeNull();
    expect(tomb.textContent).toContain("Still relevant");
  });

  it("Reply posts only the body, names the inherited visibility, and shows the reply under the thread (story 35)", async () => {
    const s = seed();
    await openFilm();
    const thread = threadOf(s.n1.id);
    await click(tid("video-note-reply-button", thread)!);
    const form = thread.querySelector<HTMLElement>('[data-notes-form="reply"]')!;
    expect(form.textContent).toContain("Reply · Internal");
    expect(form.querySelector<HTMLElement>('[role="group"]')).toBeNull();
    const added = { ...s.n1, replies: [replyTo(s.n1, { body: "On it", createdAt: T(20) })] } as VideoNoteThreadDto;
    api.apiPost.mockResolvedValue(commit(added));
    await type(form.querySelector<HTMLElement>("textarea") as HTMLTextAreaElement, "On it");
    await click(tid("video-note-reply-post", form)!);
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/replies`, { body: "On it" });
    expect(tid("video-note-body", [...threadOf(s.n1.id).querySelectorAll<HTMLElement>('[data-testid="video-note-reply"]')][0]!)!.textContent).toBe("On it");
    expect(threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="reply"]')).toBeNull();
  });

  it("Resolve marks the thread resolved by the actor and Reopen undoes it; resolved notes leave Open and show under Resolved (stories 36, 37)", async () => {
    const s = seed();
    await openFilm();
    api.apiPut.mockResolvedValue(commit({ ...s.n1, resolved: { at: T(30), by: me } } as VideoNoteThreadDto));
    await click(tid("video-note-resolve", threadOf(s.n1.id))!);
    await flush(4);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/resolution`, { resolved: true });
    expect(noteIds()).not.toContain(s.n1.id);
    await click(tid("video-notes-filter-status-resolved")!);
    expect(noteIds()).toEqual([s.n1.id, s.n4.id]);
    expect(threadOf(s.n1.id).textContent).toContain("Resolved by Terry");
    api.apiPut.mockResolvedValue(commit({ ...s.n1, resolved: null } as VideoNoteThreadDto));
    await click(tid("video-note-resolve", threadOf(s.n1.id))!);
    await flush(4);
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/resolution`, { resolved: false });
    expect(noteIds()).toEqual([s.n4.id]);
  });

  it("the two filters combine: all nine status x visibility pairs list exactly their notes, and the timeline markers follow", async () => {
    const s = seed();
    await openFilm();
    const markerIds = () => [...document.querySelectorAll<HTMLElement>("[data-marker-id]")].map((m) => m.dataset.markerId!).sort();
    const sorted = (...list: VideoNoteThreadDto[]) => list.map((n) => n.id).sort();
    const pick = async (status: string, visibility: string) => { await click(tid(`video-notes-filter-status-${status}`)!); await click(tid(`video-notes-filter-visibility-${visibility}`)!); };
    const expected: Array<[string, string, VideoNoteThreadDto[]]> = [
      ["open", "all", [s.n1, s.n2, s.n3, s.n5, s.n6]], ["open", "public", [s.n2, s.n6]], ["open", "internal", [s.n1, s.n3, s.n5]],
      ["resolved", "all", [s.n4]], ["resolved", "public", [s.n4]], ["resolved", "internal", []],
      ["all", "all", s.all], ["all", "public", [s.n2, s.n4, s.n6]], ["all", "internal", [s.n1, s.n3, s.n5]],
    ];
    for (const [status, visibility, list] of expected) {
      await pick(status, visibility);
      expect([...noteIds()].sort(), `${status}/${visibility}`).toEqual(sorted(...list));
      expect(markerIds(), `markers ${status}/${visibility}`).toEqual(sorted(...list));
    }
  });

  it("filter buttons carry honest counts under the other axis, and an empty result says so", async () => {
    await openFilm();
    expect(tid("video-notes-filters")).not.toBeNull();
    expect(tid("video-notes-filter-status-open")!.textContent).toContain("5");
    expect(tid("video-notes-filter-status-resolved")!.textContent).toContain("1");
    expect(tid("video-notes-filter-status-all")!.textContent).toContain("6");
    await click(tid("video-notes-filter-visibility-internal")!);
    expect(tid("video-notes-filter-status-open")!.textContent).toContain("3");
    expect(tid("video-notes-filter-status-resolved")!.textContent).toContain("0");
    await click(tid("video-notes-filter-status-resolved")!);
    expect(tid("video-notes-empty")!.textContent).toBe("No notes match these filters.");
  });

  it("with no notes at all it says so", async () => {
    await openFilm({ notes: { [ids.asset2]: [], [ids.asset1]: [] } });
    expect(tid("video-notes-empty")!.textContent).toBe("No notes on this version yet.");
    expect(tid("video-notes-filters")).toBeNull(); // nothing to filter
  });

  it("Version details move behind a header button (and the popover holds the same rows)", async () => {
    await openFilm();
    expect(dialog()!.querySelector('aside[aria-label="Version details"]')).toBeNull();
    expect(tid("video-detail-label")).toBeNull();
    await click(tid("video-details-button")!);
    await flush(4);
    expect([...document.querySelectorAll<HTMLElement>('[data-testid="video-detail-label"]')].length).toBe(10);
  });
});

describe("Notes off (ships dark)", () => {
  it("without the notes part the viewer is today's: Version details column, no panel, no markers, no I/O in the legend", async () => {
    await openFilm({ parts: [] });
    expect(tid("video-notes-panel")).toBeNull();
    expect(dialog()!.querySelector<HTMLElement>('aside[aria-label="Version details"]')).not.toBeNull();
    expect(tid("video-marker-lane")).toBeNull();
    expect(tid("video-key-legend")!.textContent).not.toContain("in/out");
    expect(api.apiGet.mock.calls.some(([path]) => String(path).includes("/notes"))).toBe(false);
    const aside = dialog()!.querySelector<HTMLElement>("aside")!;
    expect(aside.className).toContain("min-[721px]:overflow-y-auto");
  });
});

// ---- Session behaviour: composer through the player, drafts, delete, archived, External, keyboard, Escape, markers (added after the first red run) ----
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

describe("Composer through the player (tests 9-12, 25)", () => {
  it("I and O on the player mark a range (band drawn), Post sends { startFrame, endFrame: out + 1 }, and typing 'io' in the textarea marks nothing", async () => {
    await openFilm({}, 12);
    await type(composerText(), "io");
    expect(tid("video-pending-band")).toBeNull();
    await type(composerText(), "");
    await dispatchKey(popup(), "i");
    await present(20);
    await dispatchKey(popup(), "o");
    expect(tid("video-pending-band")).not.toBeNull();
    api.apiPost.mockResolvedValue(commit(note({ startFrame: 12, endFrame: 21, body: "Range" })));
    await type(composerText(), "Range");
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 12 / 25); });
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/notes`, { startFrame: 12, endFrame: 21, visibility: "internal", body: "Range" });
    expect(tid("video-pending-band")).toBeNull();
  });

  it("with no marks Post pauses on the frame composing began at, waits for it to be on screen, then posts a point; visibility goes back to Internal", async () => {
    await openFilm({}, 7);
    await click(tid("video-note-visibility-public")!);
    expect(tid("video-note-visibility-hint")!.textContent).toContain("Shown to the client");
    await type(composerText(), "Point note");
    await present(40); // playback moved on: the anchor stays at 7
    api.apiPost.mockResolvedValue(note({ startFrame: 7, visibility: "public", body: "Point note" }));
    await click(tid("video-note-post")!);
    expect(api.apiPost).not.toHaveBeenCalled();
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 7 / 25); });
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/notes`, { startFrame: 7, visibility: "public", body: "Point note" });
    expect(tid("video-note-visibility-hint")!.textContent).toContain("Studio only");
  });

  it("a frame-0 note posts startFrame 0 (story 28)", async () => {
    await openFilm({}, 0);
    await type(composerText(), "At the start");
    api.apiPost.mockResolvedValue(note({ startFrame: 0 }));
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 0); });
    await flush(4);
    expect(api.apiPost.mock.calls[0]![1]).toMatchObject({ startFrame: 0 });
  });

  it("an unsent draft returns on switching back to its Version; marks are always cleared (D3)", async () => {
    await openFilm({}, 12);
    await type(composerText(), "Half a thought");
    await dispatchKey(popup(), "i");
    expect(tid("video-pending-band")).not.toBeNull();
    await pickVersion("v1");
    expect(composerText().value).toBe("");
    expect(tid("video-pending-band")).toBeNull();
    await type(composerText(), "On version one");
    await pickVersion("v2");
    expect(composerText().value).toBe("Half a thought");
    expect(tid("video-pending-band")).toBeNull();
    await pickVersion("v1");
    expect(composerText().value).toBe("On version one");
  });
});

describe("Delete (test 20, panel half)", () => {
  it("confirming a delete of a reply-less note removes the thread and its marker, and focus goes to the next thread's anchor", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    expect(tid("video-note-delete-confirm")).not.toBeNull();
    drop(s.n1.id); api.apiDeleteWithBody.mockResolvedValue({ thread: null });
    await click(tid("video-note-delete-confirm-action")!);
    await settle();
    expect(api.apiDeleteWithBody).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}`, { expectedRevision: 1 });
    expect(noteIds()).not.toContain(s.n1.id);
    expect([...document.querySelectorAll<HTMLElement>("[data-marker-id]")].map((m) => m.dataset.markerId)).not.toContain(s.n1.id);
    expect(document.activeElement).toBe(tid("video-note-anchor-button", threadOf(s.n2.id)));
  });

  it("deleting a note others replied to uses the tombstone wording and leaves 'Note deleted' with the replies", async () => {
    const mine = note({ body: "Mine", startFrame: 30 });
    const withReply = { ...mine, replies: [replyTo(mine, { author: { kind: "staff", person: mia }, authorRole: "editor", body: "Mia replied", createdAt: T(3) })] } as VideoNoteThreadDto;
    await openFilm({ notes: { [ids.asset2]: [withReply], [ids.asset1]: [] } });
    await chooseNoteAction(threadOf(mine.id), "Terry", "Delete");
    expect(tid("video-note-delete-confirm")!.textContent).toContain("Note deleted");
    api.apiDeleteWithBody.mockResolvedValue({ thread: commit({ ...withReply, deleted: true, body: "", revision: 2 } as VideoNoteThreadDto) });
    await click(tid("video-note-delete-confirm-action")!);
    await settle();
    expect(tid("video-note-tombstone", threadOf(mine.id))!.textContent).toBe("Note deleted");
    expect(threadOf(mine.id).textContent).toContain("Mia replied");
  });

  it("a 404 'Note not found' on delete closes the confirm silently and re-reads the list", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    api.apiDeleteWithBody.mockRejectedValue(new ApiError("Note not found", 404, { error: "Note not found" }));
    const reads = api.apiGet.mock.calls.length;
    await click(tid("video-note-delete-confirm-action")!);
    await settle();
    expect(tid("video-note-delete-confirm")).toBeNull();
    expect(tid("video-note-delete-error")).toBeNull();
    expect(api.apiGet.mock.calls.length).toBeGreaterThan(reads);
  });

  it("a failed delete keeps the confirm open with the message", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    api.apiDeleteWithBody.mockRejectedValue(new ApiError("Server said no", 500));
    await click(tid("video-note-delete-confirm-action")!);
    await settle(50);
    expect(tid("video-note-delete-error")!.textContent).toContain("Server said no");
  });
});

describe("Edit frames through the player keys", () => {
  it("while an edit form is open I and O write into its marks (not the composer's) and Save sends the frames", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    await dispatchKey(popup(), "i");
    await present(30);
    await dispatchKey(popup(), "o");
    expect(tid("video-note-anchor")!.textContent).not.toContain("In ");
    expect(tid("video-pending-band")).not.toBeNull();
    api.apiPatch.mockResolvedValue(commit({ ...s.n1, startFrame: 20, endFrame: 31, revision: 2 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(api.apiPatch).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}`, { expectedRevision: 1, startFrame: 20, endFrame: 31 });
  });
});

describe("Archived Project (test 21)", () => {
  it("replaces the composer with the notice, drops Reply / Resolve / the menu, leaves I and O inert, and filters and seeking still work", async () => {
    const s = seed();
    await openFilm({ archivedProject: true }, 12);
    expect(composerBox()).toBeNull();
    expect(tid("video-notes-archived")).not.toBeNull();
    expect(tid("video-note-reply-button")).toBeNull();
    expect(tid("video-note-resolve")).toBeNull();
    expect(tid("video-note-actions")).toBeNull();
    await dispatchKey(popup(), "i");
    expect(tid("video-pending-band")).toBeNull();
    expect(tid("video-key-legend")!.textContent).not.toContain("in/out");
    await click(tid("video-notes-filter-status-all")!);
    expect(noteIds().length).toBe(6);
    await click(tid("video-note-anchor-button", threadOf(s.n2.id))!);
    expect(stub.writes.at(-1)).toBe(frameSeekSeconds(50, { num: 25, den: 1 }));
  });

  it("a 409 project_archived on Post latches the panel read-only through the cache and nothing is retried", async () => {
    await openFilm({ latch: true }, 5);
    queryClient!.setQueryData(projectDataKeys.collaborationSummary(PROJECT), undefined);
    await type(composerText(), "Too late");
    api.apiPost.mockRejectedValue(new ApiError("Project is archived", 409, { code: "project_archived" }));
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 5 / 25); });
    await flush(6);
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(composerBox()).toBeNull();
    expect(tid("video-notes-archived")).not.toBeNull();
  });
});

describe("Archive during a Post confirmation (#741 5b, Sol r15)", () => {
  it("an archive that lands while the frame is being confirmed cancels the Post: nothing is sent, and the draft is kept", async () => {
    await openFilm({ latch: true }, 5);
    await type(composerText(), "Almost sent"); // the anchor freezes at frame 5
    await present(9); // playback moves on, so Post has to seek back before it can send
    await click(tid("video-note-post")!); // the seek is now in flight
    expect(stores.made.at(-1)!.slot(ids.asset2).op?.phase).toBe("confirming");
    await act(async () => { queryClient!.setQueryData(projectDataKeys.detail(PROJECT), { archivedAt: "2026-10-10T00:00:00.000Z" }); });
    await flush(2);
    expect(tid("video-notes-archived")).not.toBeNull();
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 5 / 25); });
    await flush(6);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(stores.made.at(-1)!.slot(ids.asset2).op).toBeNull();
    expect(stores.made.at(-1)!.slot(ids.asset2).composer.body).toBe("Almost sent");
  });
});

describe("External role (test 22)", () => {
  it("lists internal notes and posts through the External parser", async () => {
    const s = seed();
    await openFilm({ role: "external_editor" }, 5);
    expect(noteIds()).toContain(s.n1.id);
    expect(tid("video-note-visibility-badge", threadOf(s.n1.id))!.textContent).toContain("Internal");
    await type(composerText(), "External note");
    api.apiPost.mockResolvedValue(note({ startFrame: 5, body: "External note" }));
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 5 / 25); });
    await flush(4);
    expect(api.apiPost.mock.calls[0]![1]).toMatchObject({ visibility: "internal", body: "External note" });
  });

  it("a 404 on a write (the Project is gone) re-asks the gate and the Project, keeps the draft and shows the server's message", async () => {
    await openFilm({ role: "external_editor" }, 5);
    queryClient!.setQueryData(projectDataKeys.videoReview(PROJECT), { open: true, parts: ["notes"] });
    queryClient!.setQueryData(projectDataKeys.detail(PROJECT), { archivedAt: null });
    await type(composerText(), "Lost access");
    api.apiPost.mockRejectedValue(new ApiError("Project not found", 404, { error: "Project not found" }));
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 5 / 25); });
    await flush(6);
    expect(queryClient!.getQueryState(projectDataKeys.videoReview(PROJECT))!.isInvalidated).toBe(true);
    expect(queryClient!.getQueryState(projectDataKeys.detail(PROJECT))!.isInvalidated).toBe(true);
    expect(composerText().value).toBe("Lost access");
    expect(composerBox()!.textContent).toContain("Project not found");
  });
});

describe("Keyboard ownership (test 23)", () => {
  it("Space on a note's timecode button is the button's: the film does not toggle", async () => {
    const s = seed();
    await openFilm({}, 0);
    const anchor = tid("video-note-anchor-button", threadOf(s.n1.id))!; anchor.focus();
    stub.calls.length = 0;
    await dispatchKey(anchor, " ");
    expect(stub.calls).toEqual([]);
  });

  it("arrows, Home and End inside a filter group or the visibility switch do not move the film", async () => {
    await openFilm({}, 12);
    stub.writes.length = 0;
    for (const target of [tid("video-notes-filter-status-open")!, tid("video-notes-filter-visibility-all")!, tid("video-note-visibility-internal")!]) {
      for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) await dispatchKey(target, k);
    }
    expect(stub.writes).toEqual([]);
  });

  it("J, K and L typed in the composer are letters, not shuttle commands", async () => {
    await openFilm({}, 12);
    stub.calls.length = 0; stub.writes.length = 0;
    const event = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    await act(async () => { composerText().dispatchEvent(event); });
    for (const k of ["j", "l"]) await dispatchKey(composerText(), k);
    expect(event.defaultPrevented).toBe(false);
    expect(stub.calls).toEqual([]); expect(stub.writes).toEqual([]);
  });
});

describe("Escape order (test 24, decision 2)", () => {
  const escape = (target: Element) => dispatchKey(target, "Escape");
  const viewerOpen = () => dialog() !== null;

  it("1. an open note menu closes first, and the viewer stays", async () => {
    const s = seed();
    await openFilm();
    const trigger = threadOf(s.n1.id).querySelector<HTMLElement>('[aria-label="Actions for note by Terry"]')!;
    await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
    expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].length).toBeGreaterThan(0);
    await escape([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!);
    await settle(200);
    expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].length).toBe(0);
    expect(viewerOpen()).toBe(true);
  });

  it("1. the Version details popover closes first, and the viewer stays", async () => {
    await openFilm();
    await click(tid("video-details-button")!); await flush(4);
    expect([...document.querySelectorAll<HTMLElement>('[data-testid="video-detail-label"]')].length).toBe(10);
    await escape(tid("video-details-button")!);
    await settle(200);
    expect([...document.querySelectorAll<HTMLElement>('[data-testid="video-detail-label"]')].length).toBe(0);
    expect(viewerOpen()).toBe(true);
  });

  it("1. the delete confirm closes first, and the viewer stays", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    expect(tid("video-note-delete-confirm")).not.toBeNull();
    await escape(tid("video-note-delete-cancel")!);
    await settle();
    expect(tid("video-note-delete-confirm")).toBeNull();
    expect(viewerOpen()).toBe(true);
    expect(api.apiDeleteWithBody).not.toHaveBeenCalled();
  });

  it("2. a focused composer with typed text keeps the text, the viewer stays and focus stays in the text field; the next Escape closes the viewer", async () => {
    await openFilm();
    composerText().focus();
    await type(composerText(), "Do not lose this");
    await escape(composerText());
    expect(viewerOpen()).toBe(true);
    expect(composerText().value).toBe("Do not lose this");
    expect(document.activeElement).toBe(composerText());
    await escape(composerText());
    await settle(200);
    expect(viewerOpen()).toBe(false);
  });

  it("2. marks set with an empty composer keep the viewer open on the first Escape; the second closes it", async () => {
    await openFilm({}, 12);
    await dispatchKey(popup(), "i");
    expect(tid("video-pending-band")).not.toBeNull();
    await dispatchKey(popup(), "Escape");
    await settle(200);
    expect(viewerOpen()).toBe(true);
    expect(tid("video-pending-band")).not.toBeNull();
    await dispatchKey(popup(), "Escape");
    await settle(200);
    expect(viewerOpen()).toBe(false);
  });

  it("2. a focused empty composer is spent by the first Escape too", async () => {
    await openFilm();
    composerText().focus();
    await escape(composerText());
    expect(viewerOpen()).toBe(true);
    expect(document.activeElement).toBe(popup());
    await escape(popup());
    await settle(200);
    expect(viewerOpen()).toBe(false);
  });

  it("2. an open, unchanged reply form is cancelled by Escape; the next Escape closes the viewer", async () => {
    const s = seed();
    await openFilm();
    await click(tid("video-note-reply-button", threadOf(s.n1.id))!);
    const field = threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="reply"] textarea')!;
    await escape(field);
    expect(threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="reply"]')).toBeNull();
    expect(viewerOpen()).toBe(true);
    await escape(document.activeElement ?? popup());
    await settle(200);
    expect(viewerOpen()).toBe(false);
  });

  it("2. a reply form with text keeps it on the first Escape (focus stays in the field), the viewer stays, and the second Escape closes it", async () => {
    const s = seed();
    await openFilm();
    await click(tid("video-note-reply-button", threadOf(s.n1.id))!);
    const field = threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="reply"] textarea') as HTMLTextAreaElement;
    await type(field, "Half a reply");
    await escape(field);
    expect(viewerOpen()).toBe(true);
    expect((threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="reply"] textarea') as HTMLTextAreaElement).value).toBe("Half a reply");
    expect(document.activeElement).toBe(threadOf(s.n1.id).querySelector('[data-notes-form="reply"] textarea'));
    await escape(document.activeElement!);
    await settle(200);
    expect(viewerOpen()).toBe(false);
  });

  it("2. an open, unchanged edit form is cancelled by Escape", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    const field = threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="edit"] textarea')!;
    field.focus();
    await escape(field);
    expect(threadOf(s.n1.id).querySelector<HTMLElement>('[data-notes-form="edit"]')).toBeNull();
    expect(viewerOpen()).toBe(true);
  });

  it("3. with nothing else open, Escape closes the viewer and returns focus to the opener", async () => {
    await openFilm();
    await escape(popup());
    await settle(200);
    expect(viewerOpen()).toBe(false);
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Open review");
  });
});

describe("Marker lane (test 26)", () => {
  it("a fine-pointer press near a marker seeks to it, selects its note and scrolls the list's own scroller, never scrollIntoView", async () => {
    const s = seed();
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    const tops: number[] = [];
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return 0; }, set(value: number) { tops.push(value); } });
    try {
      await openFilm({}, 0);
      const lane = tid("video-marker-lane")!;
      lane.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 12, width: 1000, height: 12, x: 0, y: 0, toJSON: () => ({}) });
      const x = 6 + (1000 - 12) * (50 / 299);
      await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: x })); });
      expect(stub.writes.at(-1)).toBe(frameSeekSeconds(50, { num: 25, den: 1 }));
      expect(threadOf(s.n2.id).dataset.selected).toBe("true");
      expect(tops.length).toBeGreaterThan(0);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollTop", original); else delete (Element.prototype as unknown as { scrollTop?: unknown }).scrollTop;
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("Sol round 1: one active form, frozen submits, revisions (#741 5b)", () => {
  const notesKey = () => projectDataKeys.videoNotes(PROJECT, ids.asset2);
  const composerAnchor = () => tid("video-note-anchor")!.textContent ?? "";
  const editForms = () => [...document.querySelectorAll<HTMLElement>('[data-notes-form="edit"]')];
  const conflictOf = (note: VideoNoteThreadDto) => new ApiError("Conflict", 409, { code: "note_conflict", thread: note });

  it("finding 1: Save sends the revision the form was opened with, not the one a refetch brought in; after the conflict only 'Save anyway' sends the new one", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    const elsewhere = { ...s.n1, body: "Changed in another tab", revision: 2 } as VideoNoteThreadDto;
    await act(async () => { queryClient!.setQueryData(notesKey(), seed().all.map((n) => (n.id === s.n1.id ? elsewhere : n))); });
    await type(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!, "My edit");
    api.apiPatch.mockRejectedValueOnce(conflictOf(elsewhere));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(api.apiPatch).toHaveBeenCalledTimes(1);
    expect(api.apiPatch.mock.calls[0]![1]).toEqual({ expectedRevision: 1, body: "My edit" });
    expect(tid("video-note-conflict")!.textContent).toContain("Changed in another tab");
    expect(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("My edit");
    expect(tid("video-note-edit-save")!.textContent).toBe("Save anyway");
    api.apiPatch.mockResolvedValueOnce(commit({ ...elsewhere, body: "My edit", revision: 3 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(api.apiPatch.mock.calls[1]![1]).toEqual({ expectedRevision: 2, body: "My edit" });
  });

  it("finding 2: opening a second edit closes the first; I and O then mark the second, and Save sends its frames", async () => {
    const s = seed();
    await openFilm({}, 20);
    await click(tid("video-notes-filter-status-all")!);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    await chooseNoteAction(threadOf(s.n4.id), "Terry", "Edit");
    expect(editForms().length).toBe(1);
    expect(threadOf(s.n1.id).querySelector('[data-notes-form="edit"]')).toBeNull();
    expect(threadOf(s.n4.id).querySelector('[data-notes-form="edit"]')).not.toBeNull();
    await dispatchKey(popup(), "i");
    await flush(2);
    api.apiPatch.mockResolvedValue(commit({ ...s.n4, startFrame: 20, endFrame: 251, revision: 2 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(4);
    expect(api.apiPatch).toHaveBeenCalledTimes(1);
    expect(api.apiPatch).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n4.id}`, { expectedRevision: 1, startFrame: 20, endFrame: 251 });
  });

  it("finding 2: opening a reply closes an open edit (and its marks); once the reply is closed the composer takes I and O again", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    await click(tid("video-note-reply-button", threadOf(s.n2.id))!);
    expect(editForms().length).toBe(0);
    expect(document.querySelectorAll('[data-notes-form="reply"]').length).toBe(1);
    await dispatchKey(popup(), "i");
    await flush(2);
    expect(composerAnchor()).not.toContain("In ");
    await click(tid("video-note-reply-cancel")!);
    await dispatchKey(popup(), "i");
    await flush(2);
    expect(composerAnchor()).toContain("In ");
  });

  it("finding 8 (reversed): filtering the edited note away keeps its form pinned and labelled, and I and O still go to it; counts and markers follow the filters", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit"); // n1 is Internal
    await type(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!, "Typed before filtering");
    await click(tid("video-notes-filter-visibility-public")!);
    expect(noteIds()).toContain(s.n1.id);
    expect(threadOf(s.n1.id).textContent).toContain("Outside current filters");
    expect(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Typed before filtering");
    expect(editForms().length).toBe(1);
    expect(document.querySelector(`[data-marker-id="${s.n1.id}"]`)).toBeNull();
    await dispatchKey(popup(), "i");
    expect(tid("video-note-edit-anchor")!.textContent).toContain("01:00:00:20");
    expect(composerAnchor()).not.toContain("In ");
    await click(tid("video-notes-filter-visibility-all")!);
    expect(threadOf(s.n1.id).textContent).not.toContain("Outside current filters");
    expect(editForms().length).toBe(1);
  });

  it("finding 5: Escape during frame confirmation returns the composer to idle with its text; the seek landing later posts nothing", async () => {
    await openFilm({}, 12);
    composerText().focus();
    await type(composerText(), "Hold this");
    await present(40);
    await click(tid("video-note-post")!);
    expect(tid("video-note-post")!.textContent).toBe("Confirming…");
    await dispatchKey(composerText(), "Escape");
    expect(dialog()).not.toBeNull();
    expect(tid("video-note-post")!.textContent).toBe("Post");
    expect((tid("video-note-post") as HTMLButtonElement).disabled).toBe(false);
    expect(composerText().value).toBe("Hold this");
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 12 / 25); });
    await flush(4);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(composerText().value).toBe("Hold this");
  });

  it("findings 3 and 4: a scrub to another frame before the anchor lands cancels the post ('Frame moved'); Post again posts the anchor", async () => {
    await openFilm({}, 12);
    await type(composerText(), "Anchored at 12");
    await present(40);
    await click(tid("video-note-post")!);
    expect(composerText().readOnly).toBe(true);
    await dispatchKey(popup(), "ArrowRight"); // a step supersedes the seek back to the anchor: the frame that lands is 13
    await act(async () => { stub.finishSeek(playerVideo()!); });
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 13 / 25); });
    await flush(4);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(composerBox()!.textContent).toContain("Frame moved — Post again");
    expect(composerText().value).toBe("Anchored at 12");
    expect(composerText().readOnly).toBe(false);
  });

  it("finding 6 (reversed): I marks the frame on screen at once and does not pause or wait", async () => {
    await openFilm({}, 5);
    await click(dialog()!.querySelector<HTMLElement>('button[aria-label="Play"]')!);
    await present(30);
    stub.calls.length = 0;
    await dispatchKey(popup(), "i");
    expect(stub.calls).not.toContain("pause");
    expect(composerAnchor()).toContain("In 01:00:01:05");
    expect(tid("video-pending-band")).not.toBeNull();
  });

  it("finding 7: a Delete that hits a conflict shows the server's note; only 'Delete anyway' sends the new revision", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    const elsewhere = { ...s.n1, body: "Edited elsewhere", revision: 2 } as VideoNoteThreadDto;
    api.apiDeleteWithBody.mockRejectedValueOnce(conflictOf(elsewhere));
    await click(tid("video-note-delete-confirm-action")!);
    await settle(50);
    expect(api.apiDeleteWithBody.mock.calls[0]![1]).toEqual({ expectedRevision: 1 });
    expect(tid("video-note-delete-error")!.textContent).toContain("Edited elsewhere");
    expect(tid("video-note-delete-confirm-action")!.textContent).toBe("Delete anyway");
    api.apiDeleteWithBody.mockResolvedValueOnce({ thread: null });
    await click(tid("video-note-delete-confirm-action")!);
    await settle(50);
    expect(api.apiDeleteWithBody.mock.calls[1]![1]).toEqual({ expectedRevision: 2 });
  });

  it("finding 7: Delete sends the revision the confirm was opened with, not what a refetch brought in meanwhile", async () => {
    const s = seed();
    await openFilm();
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Delete");
    await act(async () => { queryClient!.setQueryData(notesKey(), seed().all.map((n) => (n.id === s.n1.id ? { ...s.n1, revision: 5 } as VideoNoteThreadDto : n))); });
    api.apiDeleteWithBody.mockRejectedValueOnce(new ApiError("Server said no", 500));
    await click(tid("video-note-delete-confirm-action")!);
    await settle(50);
    expect(api.apiDeleteWithBody.mock.calls[0]![1]).toEqual({ expectedRevision: 1 });
  });

  it("an open edit or reply keeps the composer's Post and Set in/out disabled (nothing is discarded silently) until it is closed", async () => {
    const s = seed();
    await openFilm({}, 20);
    await type(composerText(), "Draft");
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    expect((tid("video-note-post") as HTMLButtonElement).disabled).toBe(true);
    expect((tid("video-note-set-in") as HTMLButtonElement).disabled).toBe(true);
    expect(tid("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open edit first.");
    expect(editForms().length).toBe(1);
    await click(tid("video-note-edit-cancel")!);
    expect(tid("video-note-other-form-hint")).toBeNull();
    expect((tid("video-note-post") as HTMLButtonElement).disabled).toBe(false);
    await click(tid("video-note-reply-button", threadOf(s.n2.id))!);
    expect(tid("video-note-other-form-hint")!.textContent).toBe("Finish or cancel the open reply first.");
  });

  const v1Note = () => served[ids.asset1]![0]!;
  const gate = () => { let release: (value: unknown) => void = () => undefined; const promise = new Promise<unknown>((resolve) => { release = resolve; }); return { promise, release }; };

  it("round 2 (1): a save that finishes after a Version switch touches neither the new Version's open edit nor its ability to open one", async () => {
    const s = seed();
    await openFilm({}, 20);
    await pickVersion("v1");
    const n = v1Note();
    await chooseNoteAction(threadOf(n.id), "Terry", "Edit");
    await type(threadOf(n.id).querySelector<HTMLTextAreaElement>("textarea")!, "v1 edit");
    const pending = gate();
    api.apiPatch.mockReturnValueOnce(pending.promise);
    await click(tid("video-note-edit-save")!);
    await pickVersion("v2");
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    expect(editForms().length).toBe(1);
    await act(async () => { pending.release(commit({ ...n, body: "v1 edit", revision: 2 } as VideoNoteThreadDto)); });
    await flush(6);
    expect(editForms().length).toBe(1);
    expect(threadOf(s.n1.id).querySelector('[data-notes-form="edit"]')).not.toBeNull();
  });

  it("round 2 (5, reversed): a mark made while a seek is in flight is the frame it is bringing, at once; Clear marks leaves nothing for the landing to write", async () => {
    await openFilm({}, 20);
    await dispatchKey(popup(), "i");
    expect(composerAnchor()).toContain("In ");
    await dispatchKey(popup(), "ArrowRight"); // a seek is now in flight, to 21
    await dispatchKey(popup(), "o");
    expect(composerAnchor()).toContain("Out 01:00:00:21");
    await click(tid("video-note-clear-marks")!);
    expect(composerAnchor()).not.toContain("In ");
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 21 / 25); });
    await flush(4);
    expect(composerAnchor()).not.toContain("Out");
    expect(tid("video-pending-band")).toBeNull();
  });

  it("round 2 (2): a post that succeeds after the composer unmounted clears the draft it was sent from", async () => {
    await openFilm({}, 12);
    await type(composerText(), "Sent while away");
    const pending = gate();
    api.apiPost.mockReturnValueOnce(pending.promise);
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 12 / 25); });
    await flush(4);
    await pickVersion("v1");
    await act(async () => { pending.release(commit(note({ startFrame: 12, body: "Sent while away" }))); });
    await flush(6);
    await pickVersion("v2");
    expect(composerText().value).toBe("");
  });

  it("form lifetime: Post on v2, switch to v1 and back while it is out: the remounted composer shows it pending and read-only, then empty when it lands", async () => {
    await openFilm({}, 12);
    await type(composerText(), "First");
    const pending = gate();
    api.apiPost.mockReturnValueOnce(pending.promise);
    await click(tid("video-note-post")!);
    await act(async () => { stub.finishSeek(playerVideo()!); stub.presentFrame(playerVideo()!, 12 / 25); });
    await flush(4);
    await pickVersion("v1");
    await pickVersion("v2");
    expect(composerText().value).toBe("First");
    expect(composerText().readOnly).toBe(true);
    expect(tid("video-note-post")!.textContent).toBe("Posting…");
    await act(async () => { pending.release(commit(note({ startFrame: 12, body: "First" }))); });
    await flush(6);
    expect(composerText().value).toBe("");
    expect(composerText().readOnly).toBe(false);
    expect((tid("video-note-post") as HTMLButtonElement).disabled).toBe(true);
  });

  it("form lifetime: a frame confirmation cancelled by a Version change posts nothing when the seek lands, and the text returns", async () => {
    await openFilm({}, 12);
    await type(composerText(), "Hold on");
    await present(40);
    await click(tid("video-note-post")!);
    expect(tid("video-note-post")!.textContent).toBe("Confirming…");
    await pickVersion("v1");
    await pickVersion("v2");
    await act(async () => { stub.finishSeek(playerVideo()!); });
    await flush(4);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(composerText().value).toBe("Hold on");
    expect(tid("video-note-post")!.textContent).toBe("Post");
    expect(composerBox()!.textContent).not.toContain("Frame moved");
  });

  it("form lifetime: a conflict on a note the Open filter then hides keeps its draft and conflict pinned, and Save anyway sends the stored revision after another refetch", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    await type(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!, "My edit");
    const resolvedElsewhere = { ...s.n1, body: "Changed and resolved elsewhere", revision: 2, resolved: { at: T(30), by: me } } as VideoNoteThreadDto;
    api.apiPatch.mockRejectedValueOnce(conflictOf(resolvedElsewhere));
    await click(tid("video-note-edit-save")!);
    await flush(6);
    expect(noteIds()).toContain(s.n1.id); // resolved, so the Open filter hides it: the open form pins it
    expect(threadOf(s.n1.id).textContent).toContain("Outside current filters");
    expect(tid("video-note-conflict")!.textContent).toContain("Changed and resolved elsewhere");
    expect(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("My edit");
    await act(async () => { queryClient!.setQueryData(notesKey(), seed().all.map((n) => (n.id === s.n1.id ? { ...resolvedElsewhere, body: "And again", revision: 3 } as VideoNoteThreadDto : n))); });
    api.apiPatch.mockResolvedValueOnce(commit({ ...resolvedElsewhere, body: "My edit", revision: 4 } as VideoNoteThreadDto));
    await click(tid("video-note-edit-save")!);
    await flush(6);
    expect(api.apiPatch.mock.calls[1]![1]).toEqual({ expectedRevision: 2, body: "My edit" });
  });

  it("form lifetime: Escape with focus on the player holds a dirty composer's first Escape and focuses its text field; the second closes the viewer", async () => {
    await openFilm({}, 12);
    await type(composerText(), "Do not lose this");
    popup().focus();
    await dispatchKey(popup(), "Escape");
    expect(dialog()).not.toBeNull();
    expect(composerText().value).toBe("Do not lose this");
    expect(document.activeElement).toBe(composerText());
    await dispatchKey(composerText(), "Escape");
    await settle(200);
    expect(dialog()).toBeNull();
  });

  it("round 2 (3): Escape with a dirty edit and focus elsewhere in the viewer is spent by the form (text kept); only the next Escape closes the viewer", async () => {
    const s = seed();
    await openFilm({}, 20);
    await chooseNoteAction(threadOf(s.n1.id), "Terry", "Edit");
    const field = threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!;
    await type(field, "Unsaved edit");
    popup().focus(); // the person clicked the player
    await dispatchKey(popup(), "Escape");
    expect(dialog()).not.toBeNull();
    expect(threadOf(s.n1.id).querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Unsaved edit");
    expect(document.activeElement).toBe(field);
    await dispatchKey(field, "Escape");
    await settle(200);
    expect(dialog()).toBeNull();
  });

  it("round 2 (3): typing again re-arms the first Escape of a dirty reply", async () => {
    const s = seed();
    await openFilm({}, 20);
    await click(tid("video-note-reply-button", threadOf(s.n1.id))!);
    const field = () => threadOf(s.n1.id).querySelector<HTMLTextAreaElement>('[data-notes-form="reply"] textarea')!;
    await type(field(), "a");
    popup().focus();
    await dispatchKey(popup(), "Escape");
    expect(dialog()).not.toBeNull();
    await type(field(), "ab");
    popup().focus();
    await dispatchKey(popup(), "Escape");
    expect(dialog()).not.toBeNull();
    expect(field().value).toBe("ab");
  });
});

describe("Delete confirm focus (#741 5b, Sol r7)", () => {
  it("Cancel and Escape return focus to the ⋯ that opened Delete (a reply's own, not the root's anchor); a successful delete uses the current destination", async () => {
    const mine = note({ body: "Mine", startFrame: 30 });
    const withReply = { ...mine, replies: [replyTo(mine, { body: "My reply", createdAt: T(3) })] } as VideoNoteThreadDto;
    await openFilm({ notes: { [ids.asset2]: [withReply], [ids.asset1]: [] } });
    const replyEl = () => threadOf(mine.id).querySelector<HTMLElement>('[data-testid="video-note-reply"]')!;
    const trigger = () => replyEl().querySelector<HTMLElement>('[data-testid="video-note-actions"]')!;
    await chooseNoteAction(replyEl(), "Terry", "Delete");
    await click(tid("video-note-delete-cancel")!);
    await settle();
    expect(document.activeElement).toBe(trigger());
    await chooseNoteAction(replyEl(), "Terry", "Delete");
    await dispatchKey(tid("video-note-delete-cancel")!, "Escape");
    await settle();
    expect(document.activeElement).toBe(trigger());
  });
});

describe("Panel layout classes (design r4)", () => {
  it("the list keeps min-h-32 on desktop and the panel clips (not hides) its overflow, so focus cannot scroll it", async () => {
    await openFilm();
    const panelClass = tid("video-notes-panel")!.className;
    expect(panelClass).toContain("min-[721px]:overflow-clip");
    expect(panelClass).not.toContain("overflow-hidden");
    const list = tid("video-notes-list")!.parentElement!;
    expect(list.className).toContain("min-[721px]:min-h-32");
    expect(list.className).not.toContain("40%");
  });
});

describe("Orphan notices (#741 5b, Sol r6)", () => {
  it("a notice whose root thread is gone shows above the list and can be dismissed", async () => {
    await openFilm();
    const store = stores.made.at(-1)!;
    const s = seed();
    const ghost = { ...s.n1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", parentId: null };
    for (const assetId of [ids.asset1, ids.asset2]) {
      store.openEdit(assetId, ghost as never, ghost.id);
      store.retireMissing(assetId, [{ ...ghost, deleted: true, replies: [] } as never]);
    }
    await flush(2);
    const notice = tid("video-notes-orphan-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("This note was deleted.");
    await click(tid("video-notes-orphan-dismiss")!);
    expect(tid("video-notes-orphan-notice")).toBeNull();
  });
});

// ---- Copy and paste notes between Versions (#741 5c-ui) ----
describe("Copy and paste notes (#741 5c-ui)", () => {
  const PASTE_DEBOUNCE = 400;
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const menuItem = (text: string) => menuItems().find((item) => item.textContent?.startsWith(text));
  const openNotesMenu = async () => { await act(async () => { tid("video-notes-menu")!.click(); await Promise.resolve(); await Promise.resolve(); }); await flush(2); };
  const pasteDialog = () => tid("video-note-paste-dialog");
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-note-paste-row"]')];
  const skipped = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-note-paste-skipped"]')];
  const offsetInput = () => tid("video-note-paste-offset") as HTMLInputElement;
  async function setOffset(value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(offsetInput(), value); offsetInput().dispatchEvent(new Event("input", { bubbles: true })); offsetInput().dispatchEvent(new Event("change", { bubbles: true })); });
  }
  const src = (n: VideoNoteThreadDto, over: Record<string, unknown> = {}) => ({ revision: n.revision, visibility: n.visibility, authorName: "Terry", excerpt: n.body, from: { startFrame: n.startFrame, endFrame: n.endFrame }, ...over });
  /** A fake paste server over the v1 seed: every note maps `startFrame + offset`; `skips` names the ones it refuses. */
  function pasteServer(sourceNotes: VideoNoteThreadDto[], skips: Record<string, string> = {}) {
    const planFor = (noteIds: string[], offsetFrames: number) => ({
      sourceVersion: 1, targetVersion: 2, offsetFrames,
      rows: noteIds.map((noteId) => {
        const n = sourceNotes.find((candidate) => candidate.id === noteId)!;
        return skips[noteId] ? { noteId, status: "skipped", reason: skips[noteId], source: src(n) } : { noteId, status: "mapped", source: src(n), to: { startFrame: n.startFrame! + offsetFrames, endFrame: n.endFrame === null ? null : n.endFrame + offsetFrames }, shortened: false };
      }),
    });
    api.apiPost.mockImplementation(async (path, body) => {
      const input = body as { noteIds?: string[]; notes?: Array<{ noteId: string; revision: number }>; offsetFrames: number };
      if (path.endsWith("/note-paste/preview")) return planFor(input.noteIds!, input.offsetFrames);
      if (path.endsWith("/note-paste")) { const plan = planFor(input.notes!.map((n) => n.noteId), input.offsetFrames); return { ...plan, copied: plan.rows.length, skipped: 0, rows: plan.rows.map((row) => ({ ...row, status: "copied", copyId: nid() })) }; }
      throw new Error(`unrouted ${path}`);
    });
    return planFor;
  }
  const v1Notes = () => {
    const a = note({ assetId: ids.asset1, body: "Fix the sting", startFrame: 5, visibility: "internal" });
    const b = note({ assetId: ids.asset1, body: "Hold the logo", startFrame: 20, endFrame: 50, visibility: "public", author: { kind: "staff", person: mia }, authorRole: "editor" });
    const c = note({ assetId: ids.asset1, body: "Gone soon", startFrame: 80, visibility: "public" });
    return { a, b, c, all: [a, b, c] };
  };
  /** Opens the film on v1, copies what it shows, then returns to v2. */
  async function copyOnV1(v1 = v1Notes(), skips: Record<string, string> = {}) {
    await openFilm({ notes: { [ids.asset2]: seed().all, [ids.asset1]: v1.all } });
    await pickVersion("v1");
    await openNotesMenu();
    await click(menuItem("Copy shown notes")!);
    await flush(2);
    await pickVersion("v2");
    const planFor = pasteServer(v1.all, skips);
    return { v1, planFor };
  }
  async function openPasteDialog() { await openNotesMenu(); await click(menuItem("Paste")!); await flush(6); }

  it("offers 'Copy shown notes' on a Version, copies the root notes the filters show and says so", async () => {
    const v1 = v1Notes();
    await openFilm({ notes: { [ids.asset2]: seed().all, [ids.asset1]: v1.all } });
    await pickVersion("v1");
    await openNotesMenu();
    expect(menuItem("Copy shown notes")).toBeDefined();
    expect(menuItem("Paste")).toBeUndefined();
    await click(menuItem("Copy shown notes")!);
    await flush(2);
    expect(stores.made.at(-1)!.clipboard(ids.video)).toEqual({ sourceAssetId: ids.asset1, sourceVersion: 1, noteIds: v1.all.map((n) => n.id) });
    expect(tid("video-notes-paste-status")!.textContent).toBe("Copied 3 notes");
  });

  it("copies only what the filters show", async () => {
    const v1 = v1Notes();
    await openFilm({ notes: { [ids.asset2]: seed().all, [ids.asset1]: v1.all } });
    await pickVersion("v1");
    await click(tid("video-notes-filter-visibility-internal")!);
    await openNotesMenu();
    await click(menuItem("Copy shown notes")!);
    expect(stores.made.at(-1)!.clipboard(ids.video)!.noteIds).toEqual([v1.a.id]);
  });

  it("offers 'Paste N notes from v1…' only on another Version of the same Video, and the clipboard survives switching Versions", async () => {
    await copyOnV1();
    await openNotesMenu();
    expect(menuItem("Paste 3 notes from v1…")).toBeDefined();
    await click(menuItem("Paste 3 notes from v1…")!);
    await flush(4);
    expect(pasteDialog()).not.toBeNull();
  });

  it("hides the menu on an archived Project, and for a role without the notes capability", async () => {
    await openFilm({ archivedProject: true });
    expect(tid("video-notes-menu")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await openFilm({ role: "photographer" });
    expect(tid("video-notes-menu")).toBeNull();
  });

  it("an External editor, who holds the capability, sees the menu", async () => {
    await openFilm({ role: "external_editor" });
    expect(tid("video-notes-menu")).not.toBeNull();
  });

  it("the dialog lists source → new timecodes with every note ticked, each note's visibility, and no way to change it", async () => {
    const { v1 } = await copyOnV1();
    await openPasteDialog();
    expect(rows().map((r) => r.dataset.noteId)).toEqual(v1.all.map((n) => n.id));
    expect(tid("video-note-paste-source", rows()[0]!)!.textContent).toBe("01:00:00:05");
    expect(tid("video-note-paste-target", rows()[0]!)!.textContent).toBe("01:00:00:05");
    expect(tid("video-note-paste-source", rows()[1]!)!.textContent).toBe("01:00:00:20 → 01:00:01:24");
    expect(rows().map((r) => tid("video-note-visibility-badge", r)!.dataset.visibility)).toEqual(["internal", "public", "public"]);
    expect(pasteDialog()!.querySelectorAll('[role="checkbox"][aria-checked="true"]').length).toBe(3);
    expect(pasteDialog()!.querySelector('[role="radiogroup"], [role="switch"], [role="combobox"]')).toBeNull();
    const sent = api.apiPost.mock.calls.at(-1)!;
    expect(sent[0]).toBe(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/note-paste/preview`);
    expect(sent[1]).toEqual({ sourceAssetId: ids.asset1, noteIds: v1.all.map((n) => n.id), offsetFrames: 0 });
  });

  it("lists skipped notes with their reason in plain words and never ticks them", async () => {
    const v1 = v1Notes();
    await copyOnV1(v1, { [v1.a.id]: "already_copied", [v1.c.id]: "out_of_range" });
    await openPasteDialog();
    expect(rows().map((r) => r.dataset.noteId)).toEqual([v1.b.id]);
    expect(skipped().map((r) => r.textContent)).toEqual([expect.stringContaining("Already copied to this version"), expect.stringContaining("Falls outside this version")]);
  });

  it("re-runs the preview, debounced, when the offset changes, and the offset and ticks survive closing the dialog", async () => {
    const { v1 } = await copyOnV1();
    await openPasteDialog();
    const before = api.apiPost.mock.calls.length;
    await setOffset("2"); await setOffset("3");
    await settle(PASTE_DEBOUNCE); await flush(4);
    expect(api.apiPost.mock.calls.length).toBe(before + 1);
    expect(api.apiPost.mock.calls.at(-1)![1]).toMatchObject({ offsetFrames: 3 });
    expect(tid("video-note-paste-target", rows()[0]!)!.textContent).toBe("01:00:00:08");
    await click(rows()[1]!.querySelector<HTMLElement>('[role="checkbox"]')!);
    await click(tid("video-note-paste-cancel")!); await settle(200);
    expect(pasteDialog()).toBeNull();
    await openPasteDialog();
    expect(offsetInput().value).toBe("3");
    expect(rows().map((r) => r.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
    expect(stores.made.at(-1)!.pasteDraft(ids.asset2)).toEqual({ offset: 3, unticked: [v1.b.id] });
  });

  it("Paste commits the ticked notes with the revisions the preview showed, closes, confirms and re-reads the notes and the Videos list", async () => {
    const { v1 } = await copyOnV1();
    await openPasteDialog();
    await click(rows()[2]!.querySelector<HTMLElement>('[role="checkbox"]')!);
    const reads = () => api.apiGet.mock.calls.map(([path]) => path);
    const readsBefore = reads().length;
    await click(tid("video-note-paste-submit")!); await flush(6);
    const after = reads().slice(readsBefore);
    expect(after.some((path) => path.endsWith("/videos"))).toBe(true);
    expect(after.some((path) => path.endsWith(`/video-versions/${ids.asset2}/notes`))).toBe(true);
    const [path, body] = api.apiPost.mock.calls.at(-1)!;
    expect(path).toBe(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/note-paste`);
    expect(body).toEqual({ sourceAssetId: ids.asset1, notes: [{ noteId: v1.a.id, revision: 1 }, { noteId: v1.b.id, revision: 1 }], offsetFrames: 0 });
    await settle(200);
    expect(pasteDialog()).toBeNull();
    expect(tid("video-notes-paste-status")!.textContent).toBe("Pasted 2 notes");
    expect(viewerStillOpen()).toBe(true);
    expect(stores.made.at(-1)!.pasteDraft(ids.asset2)).toEqual({ offset: 0, unticked: [] });
  });

  it("a 409 paste_stale refreshes the list from the server's plan and says so; nothing is lost", async () => {
    const { v1, planFor } = await copyOnV1();
    await openPasteDialog();
    const fresh = planFor([v1.a.id, v1.b.id], 0);
    fresh.rows[1] = { ...fresh.rows[1]!, source: { ...(fresh.rows[1] as { source: object }).source, revision: 2, excerpt: "Hold the logo longer" } } as never;
    api.apiPost.mockRejectedValueOnce(new ApiError("Some notes changed since the preview.", 409, { code: "paste_stale", error: "x", preview: { ...fresh, rows: [...fresh.rows, { noteId: v1.c.id, status: "skipped", reason: "deleted", source: null }] } }));
    const stalePlan = { ...fresh, rows: [...fresh.rows, { noteId: v1.c.id, status: "skipped", reason: "deleted", source: null }] };
    api.apiPost.mockImplementationOnce(async () => stalePlan);
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(pasteDialog()).not.toBeNull();
    expect(tid("video-note-paste-notice")!.textContent).toContain("changed since");
    expect(rows().map((r) => r.dataset.noteId)).toEqual([v1.a.id, v1.b.id]);
    expect(rows()[1]!.textContent).toContain("Hold the logo longer");
    expect(skipped()[0]!.textContent).toContain("Deleted on the source version");
    api.apiPost.mockImplementationOnce(async (_p, body) => ({ sourceVersion: 1, targetVersion: 2, offsetFrames: 0, copied: 2, skipped: 0, rows: (body as { notes: Array<{ noteId: string }> }).notes.map((n) => ({ ...fresh.rows.find((r) => r.noteId === n.noteId)!, status: "copied", copyId: nid() })) }));
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect((api.apiPost.mock.calls.at(-1)![1] as { notes: unknown[] }).notes).toEqual([{ noteId: v1.a.id, revision: 1 }, { noteId: v1.b.id, revision: 2 }]);
  });

  it("a 409 paste_stale asks again for the whole clipboard: unticked and skipped notes stay, the ticks and the offset are kept", async () => {
    const v1 = v1Notes();
    await copyOnV1(v1, { [v1.c.id]: "out_of_range" });
    await openPasteDialog();
    await setOffset("3"); await settle(PASTE_DEBOUNCE); await flush(4);
    await click(rows()[1]!.querySelector<HTMLElement>('[role="checkbox"]')!);
    // The server's 409 only covers the submitted note.
    api.apiPost.mockRejectedValueOnce(new ApiError("Some notes changed since the preview.", 409, { code: "paste_stale", error: "x", preview: { sourceVersion: 1, targetVersion: 2, offsetFrames: 3, rows: [] } }));
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(tid("video-note-paste-notice")!.textContent).toContain("changed since");
    expect(api.apiPost.mock.calls.at(-1)![0]).toMatch(/note-paste\/preview$/);
    expect(api.apiPost.mock.calls.at(-1)![1]).toEqual({ sourceAssetId: ids.asset1, noteIds: v1.all.map((n) => n.id), offsetFrames: 3 });
    expect(rows().map((r) => r.dataset.noteId)).toEqual([v1.a.id, v1.b.id]);
    expect(rows().map((r) => r.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(skipped().map((r) => r.dataset.noteId)).toEqual([v1.c.id]);
    expect(offsetInput().value).toBe("3");
    expect(stores.made.at(-1)!.pasteDraft(ids.asset2)).toEqual({ offset: 3, unticked: [v1.b.id] });
  });

  it("an untick survives a stale refresh that skips the note and an offset change that brings it back (#741 5c-ui round 3)", async () => {
    const v1 = v1Notes();
    await copyOnV1(v1);
    await openPasteDialog();
    await click(rows()[1]!.querySelector<HTMLElement>('[role="checkbox"]')!);
    const planAt = (offsetFrames: number, skipB: boolean) => ({
      sourceVersion: 1, targetVersion: 2, offsetFrames,
      rows: v1.all.map((n) => skipB && n.id === v1.b.id
        ? { noteId: n.id, status: "skipped", reason: "out_of_range", source: src(n) }
        : { noteId: n.id, status: "mapped", source: src(n), to: { startFrame: n.startFrame! + offsetFrames, endFrame: n.endFrame === null ? null : n.endFrame + offsetFrames }, shortened: false }),
    });
    api.apiPost.mockRejectedValueOnce(new ApiError("Some notes changed since the preview.", 409, { code: "paste_stale", error: "x", preview: planAt(0, true) }));
    api.apiPost.mockImplementationOnce(async () => planAt(0, true));
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(rows().map((r) => r.dataset.noteId)).toEqual([v1.a.id, v1.c.id]);
    expect(stores.made.at(-1)!.pasteDraft(ids.asset2).unticked).toEqual([v1.b.id]);
    await setOffset("1"); await settle(PASTE_DEBOUNCE); await flush(4);
    expect(rows().map((r) => r.dataset.noteId)).toEqual([v1.a.id, v1.b.id, v1.c.id]);
    expect(rows().map((r) => r.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect((api.apiPost.mock.calls.at(-1)![1] as { notes: Array<{ noteId: string }> }).notes.map((n) => n.noteId)).toEqual([v1.a.id, v1.c.id]);
  });

  it("a paste that finishes after a remount, once a newer draft exists, leaves that draft and its dialog alone (#741 5c-ui round 3)", async () => {
    await copyOnV1();
    await openPasteDialog();
    let finish!: (value: unknown) => void;
    api.apiPost.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(tid("video-note-paste-submit")!); await flush(4);
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(true);
    // Remount: the Version goes away and comes back. The store still says a commit is out.
    await pickVersion("v1"); await pickVersion("v2");
    expect(pasteDialog()).not.toBeNull();
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(true);
    const store = stores.made.at(-1)!;
    // The session ends (cancelAll) and the person starts a newer draft.
    store.cancelAll();
    store.setPasteOffset(ids.asset2, 7);
    store.setPasteTicked(ids.asset2, "keep-me", false);
    await act(async () => { finish({ sourceVersion: 1, targetVersion: 2, offsetFrames: 0, copied: 3, skipped: 0, rows: [] }); await Promise.resolve(); });
    await flush(6); await settle(200);
    expect(pasteDialog()).not.toBeNull();
    expect(store.pasteDraft(ids.asset2)).toEqual({ offset: 7, unticked: ["keep-me"] });
    expect(tid("video-notes-paste-status")).toBeNull();
  });

  it("a 409 that returns after a remount refreshes the live dialog: the stale notice, a fresh preview, Paste enabled (#741 5c-ui round 4)", async () => {
    const { v1, planFor } = await copyOnV1();
    await openPasteDialog();
    let fail!: (error: unknown) => void;
    api.apiPost.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await click(tid("video-note-paste-submit")!); await flush(4);
    // Archive/restore, or any remount: the old dialog instance is gone and a new one has asked for its own preview.
    await pickVersion("v1"); await pickVersion("v2");
    expect(pasteDialog()).not.toBeNull();
    expect(rows()).toHaveLength(3);
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(true);
    const fresh = planFor(v1.all.map((n) => n.id), 0);
    fresh.rows[1] = { ...fresh.rows[1]!, source: { ...(fresh.rows[1] as { source: object }).source, revision: 2, excerpt: "Hold the logo longer" } } as never;
    api.apiPost.mockImplementationOnce(async () => fresh);
    await act(async () => { fail(new ApiError("Some notes changed since the preview.", 409, { code: "paste_stale", error: "x", preview: { sourceVersion: 1, targetVersion: 2, offsetFrames: 0, rows: [] } })); await Promise.resolve(); });
    await flush(6);
    expect(tid("video-note-paste-notice")!.textContent).toContain("changed since");
    expect(rows()[1]!.textContent).toContain("Hold the logo longer");
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Cancel and Escape return focus to the Notes actions trigger (#741 5c-ui round 5)", async () => {
    await copyOnV1();
    await openPasteDialog();
    await click(tid("video-note-paste-cancel")!); await settle(300);
    expect(pasteDialog()).toBeNull();
    expect(document.activeElement).toBe(tid("video-notes-menu"));
    (document.activeElement as HTMLElement).blur();
    await openPasteDialog();
    await dispatchKey(offsetInput(), "Escape"); await settle(300);
    expect(pasteDialog()).toBeNull();
    expect(document.activeElement).toBe(tid("video-notes-menu"));
  });

  it("marks the table as stacking below 721px, with each timecode labelled by its Version (#741 5c-ui round 5)", async () => {
    await copyOnV1();
    await openPasteDialog();
    const table = tid("video-note-paste-table")!;
    expect(table.getAttribute("data-layout")).toBe("stack-below-721");
    expect(tid("video-note-paste-source", rows()[0]!)!.getAttribute("data-version")).toBe("v1");
    expect(tid("video-note-paste-target", rows()[0]!)!.parentElement!.getAttribute("data-version")).toBe("v2");
  });

  it("hides the offset field when nothing can be pasted (#741 5c-ui round 5)", async () => {
    const v1 = v1Notes();
    await copyOnV1(v1, { [v1.a.id]: "out_of_range", [v1.b.id]: "out_of_range", [v1.c.id]: "out_of_range" });
    await openPasteDialog();
    expect(tid("video-note-paste-none")).not.toBeNull();
    expect(tid("video-note-paste-offset")).toBeNull();
  });

  it("a stale refresh that fails keeps Paste disabled and offers 'Try again', which asks for the preview again (#741 5c-ui round 3)", async () => {
    const { v1 } = await copyOnV1();
    await openPasteDialog();
    api.apiPost.mockRejectedValueOnce(new ApiError("Some notes changed since the preview.", 409, { code: "paste_stale", error: "x", preview: { sourceVersion: 1, targetVersion: 2, offsetFrames: 0, rows: [] } }));
    api.apiPost.mockRejectedValueOnce(new ApiError("Network error", 0));
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(tid("video-note-paste-load-error")).not.toBeNull();
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(stores.made.at(-1)!.pasteView(ids.asset2).status).toBe("failed");
    const retry = [...tid("video-note-paste-load-error")!.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await click(retry); await flush(6);
    expect(api.apiPost.mock.calls.at(-1)![0]).toMatch(/note-paste\/preview$/);
    expect(tid("video-note-paste-load-error")).toBeNull();
    expect(rows().map((r) => r.dataset.noteId)).toEqual(v1.all.map((n) => n.id));
    expect((tid("video-note-paste-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a network failure keeps the dialog and offers 'Try again', which sends the same payload", async () => {
    await copyOnV1();
    await openPasteDialog();
    api.apiPost.mockRejectedValueOnce(new ApiError("Network error", 0));
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(tid("video-note-paste-error")!.textContent).toContain("Couldn't reach the server");
    expect(tid("video-note-paste-submit")!.textContent).toBe("Try again");
    const first = api.apiPost.mock.calls.at(-1)![1];
    await click(tid("video-note-paste-submit")!); await flush(6);
    expect(api.apiPost.mock.calls.at(-1)![1]).toEqual(first);
    await settle(200);
    expect(pasteDialog()).toBeNull();
  });

  it("shows each copied thread's origin: 'Copied from v1 · originally by …'", async () => {
    const copy = note({ body: "Copied note", startFrame: 30, copiedFrom: { version: 1, authorName: "Mia Chen", authorRole: "editor" } });
    await openFilm({ notes: { [ids.asset2]: [copy, ...seed().all], [ids.asset1]: [] } });
    expect(tid("video-note-copied-from", threadOf(copy.id))!.textContent).toBe("Copied from v1 · originally by Mia Chen");
    expect(tid("video-note-copied-from", threadOf(seed().n1.id))).toBeNull();
  });

  it("Escape inside the paste dialog closes only the dialog: the viewer stays and the composer's first Escape is not spent", async () => {
    await copyOnV1();
    composerText().focus();
    await type(composerText(), "Do not lose this");
    await openPasteDialog();
    await dispatchKey(offsetInput(), "Escape");
    await settle(300);
    expect(pasteDialog()).toBeNull();
    expect(viewerStillOpen()).toBe(true);
    expect(stores.made.at(-1)!.slot(ids.asset2).spent).toBe(false);
    expect(composerText().value).toBe("Do not lose this");
  });
});
const viewerStillOpen = () => document.querySelector('[data-testid="video-review-viewer"]') !== null;
