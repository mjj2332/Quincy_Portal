import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { frameSeekSeconds, type Role, type VideoDto, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor", name: "Terry" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
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
const videoOf = (): VideoDto => ({ id: ids.video, title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 25, den: 1 }, tcNominalFps: 25, startTimecodeFrames: 90000, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

let seq = 100;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const T = (n: number) => `2026-10-10T00:00:${String(n).padStart(2, "0")}.000Z`;
type NoteOver = Record<string, unknown>;
const note = (over: NoteOver = {}): VideoNoteThreadDto => ({
  id: nid(), assetId: ids.asset2, parentId: null, author: { kind: "staff", person: me }, authorRole: "admin", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, resolved: null, revision: 1, createdAt: T(1), editedAt: null, copiedFrom: null, copiedFromNote: undefined, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;
const replyTo = (root: VideoNoteThreadDto, over: NoteOver = {}) => { const { replies: _r, ...rest } = note({ parentId: root.id, startFrame: null, visibility: root.visibility, ...over }); return rest; };

// 6 roots: me internal point @10, Mia public point @50 (2 replies), Mia internal range [100,126), me public range [200,251) resolved, a tombstone with a reply @150, a guest public point @250.
function seed() {
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

let stub: VideoElementStub; let root: Root | null = null; let host: HTMLElement;
let served: Record<string, VideoNoteThreadDto[]>;
let archived = false;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const playerVideo = () => dialog()?.querySelector("video") ?? null;
const q = (selector: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(selector);
const qa = (selector: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(selector)];
const tid = (id: string, scope: ParentNode = document) => q(`[data-testid="${id}"]`, scope);
const threads = () => qa('[data-testid="video-note-thread"]');
const threadOf = (id: string) => q(`[data-testid="video-note-thread"][data-note-id="${id}"]`)!;
const noteIds = () => threads().map((t) => t.dataset.noteId!);
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
async function key(k: string, target: Element, init: KeyboardEventInit = {}) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); }); }
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function mount(opts: { role?: Role; parts?: string[]; archivedProject?: boolean; notes?: Record<string, VideoNoteThreadDto[]> } = {}) {
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
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} archived={archived} review={{ open: true, parts: (opts.parts ?? ["notes"]) as never }} /></QuincyQueryProvider>); });
  await flush();
}
async function openViewer() {
  const open = qa("button").find((b) => b.textContent === "Open review")!;
  open.focus();
  await click(open);
  for (let i = 0; i < 60 && !dialog(); i += 1) await flush(1);
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
  const trigger = q('[role="combobox"]', dialog()!)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  const option = qa('[role="option"]').find((o) => o.textContent?.startsWith(label))!;
  await act(async () => { option.click(); });
  await flush(8);
}

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
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
    await click(tid("video-play-toggle") ?? qa("button").find((b) => b.getAttribute("aria-label") === "Play")!);
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
    for (const reply of qa('[data-testid="video-note-reply"]', threadOf(s.n5.id))) expect(badge(reply).textContent).toContain("Internal");
    for (const reply of qa('[data-testid="video-note-reply"]', threadOf(s.n2.id))) expect(badge(reply).textContent).toContain("Client-visible");
  });

  it("a note with replies lists them under it, oldest first; a tombstone reads 'Note deleted' with its replies and no Reply button (story 34)", async () => {
    const s = seed();
    await openFilm();
    expect(qa('[data-testid="video-note-reply"]', threadOf(s.n2.id)).map((r) => tid("video-note-body", r)!.textContent)).toEqual(["Agreed", "Will grade"]);
    const tomb = threadOf(s.n5.id);
    expect(tid("video-note-tombstone", tomb)!.textContent).toBe("Note deleted");
    expect(tid("video-note-body", tomb)).toBeNull();
    expect(tid("video-note-reply-button", tomb)).toBeNull();
    expect(tid("video-note-resolve", tomb)).not.toBeNull();
    expect(tomb.textContent).toContain("Still relevant");
  });

  it("Reply posts only the body, names the inherited visibility, and shows the reply under the thread (story 35)", async () => {
    const s = seed();
    await openFilm();
    const thread = threadOf(s.n1.id);
    await click(tid("video-note-reply-button", thread)!);
    const form = q('[data-notes-form="reply"]', thread)!;
    expect(form.textContent).toContain("Reply · Internal");
    expect(q("[data-testid^=video-note-visibility-]", form)).toBeNull();
    const added = { ...s.n1, replies: [replyTo(s.n1, { body: "On it", createdAt: T(20) })] } as VideoNoteThreadDto;
    api.apiPost.mockResolvedValue(added);
    await type(q("textarea", form) as HTMLTextAreaElement, "On it");
    await click(tid("video-note-reply-post", form)!);
    await flush(4);
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/replies`, { body: "On it" });
    expect(tid("video-note-body", qa('[data-testid="video-note-reply"]', threadOf(s.n1.id))[0]!)!.textContent).toBe("On it");
    expect(q('[data-notes-form="reply"]', threadOf(s.n1.id))).toBeNull();
  });

  it("Resolve marks the thread resolved by the actor and Reopen undoes it; resolved notes leave Open and show under Resolved (stories 36, 37)", async () => {
    const s = seed();
    await openFilm();
    api.apiPut.mockResolvedValue({ ...s.n1, resolved: { at: T(30), by: me } });
    await click(tid("video-note-resolve", threadOf(s.n1.id))!);
    await flush(4);
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/resolution`, { resolved: true });
    expect(noteIds()).not.toContain(s.n1.id);
    await click(tid("video-notes-filter-status-resolved")!);
    expect(noteIds()).toEqual([s.n1.id, s.n4.id]);
    expect(threadOf(s.n1.id).textContent).toContain("Resolved by Terry");
    api.apiPut.mockResolvedValue({ ...s.n1, resolved: null });
    await click(tid("video-note-resolve", threadOf(s.n1.id))!);
    await flush(4);
    expect(api.apiPut).toHaveBeenLastCalledWith(`/api/projects/${PROJECT}/video-notes/${s.n1.id}/resolution`, { resolved: false });
    expect(noteIds()).toEqual([s.n4.id]);
  });

  it("the two filters combine: all nine status x visibility pairs list exactly their notes, and the timeline markers follow", async () => {
    const s = seed();
    await openFilm();
    const markerIds = () => qa("[data-marker-id]").map((m) => m.dataset.markerId!).sort();
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
  });

  it("Version details move behind a header button (and the popover holds the same rows)", async () => {
    await openFilm();
    expect(dialog()!.querySelector('aside[aria-label="Version details"]')).toBeNull();
    expect(tid("video-detail-label")).toBeNull();
    await click(tid("video-details-button")!);
    await flush(4);
    expect(qa('[data-testid="video-detail-label"]').length).toBe(10);
  });
});

describe("Notes off (ships dark)", () => {
  it("without the notes part the viewer is today's: Version details column, no panel, no markers, no I/O in the legend", async () => {
    await openFilm({ parts: [] });
    expect(tid("video-notes-panel")).toBeNull();
    expect(q('aside[aria-label="Version details"]', dialog()!)).not.toBeNull();
    expect(tid("video-marker-lane")).toBeNull();
    expect(tid("video-key-legend")!.textContent).not.toContain("in/out");
    expect(api.apiGet.mock.calls.some(([path]) => String(path).includes("/notes"))).toBe(false);
    const aside = q("aside", dialog()!)!;
    expect(aside.className).toContain("min-[721px]:overflow-y-auto");
  });
});
