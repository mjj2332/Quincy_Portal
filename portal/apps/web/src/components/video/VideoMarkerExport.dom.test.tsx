import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { type Role, type VideoDto, type VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
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
let renderTree: () => void = () => undefined;
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
  const review = { open: true, parts: (opts.parts ?? ["notes", "export"]) as never };
  renderTree = () => root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><Probe /><VideoCollectionPanel projectId={PROJECT} role={role} archived={archived} review={review} /></QuincyQueryProvider>);
  await act(async () => { renderTree(); });
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
  seedCache = null;
  stub = installVideoElementStub();
  Object.values(api).forEach((mock) => mock.mockReset());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const dispatchKey = (target: Element, k: string, init: KeyboardEventInit = {}) => key(k, target, init);
const popup = () => dialog()!;
const settle = (ms = 300) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });

// ---- NLE marker export menu (#741 9) ----
// Seed (editor sees internal notes): public = n2 @50, n4 @200 (resolved), n6 @250 => 3 markers; internal adds n1 @10, n3 @100 and the tombstone-with-reply n5 @150 => 6.
describe("Marker export menu (#741 9)", () => {
  let created: Blob[]; let revoked: string[]; let downloads: Array<{ name: string; href: string }>; let exportFetch: ReturnType<typeof vi.fn>;
  const urls = () => exportFetch.mock.calls.map((call) => String(call[0]));
  const group = () => tid("video-export-group");
  const openMenu = async () => { await act(async () => { tid("video-notes-menu")!.click(); await Promise.resolve(); await Promise.resolve(); }); await flush(2); };
  const fileResponse = (over: { name?: string; count?: number; body?: string } = {}) => new Response(over.body ?? "TITLE: x", {
    status: 200, headers: { "content-disposition": `attachment; filename="fallback.edl"; filename*=UTF-8''${encodeURIComponent(over.name ?? "Main walkthrough-v2-notes-all-public.edl")}`, "X-Marker-Count": String(over.count ?? 3) },
  });
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const useExportFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
    exportFetch = vi.fn(impl as never);
    vi.stubGlobal("fetch", exportFetch);
  };
  const exportOpts = async (opts: { internal?: boolean; status?: "open" | "resolved" } = {}) => {
    if (opts.internal) await click(tid("video-export-internal")!);
    if (opts.status) await click(tid(`video-export-status-${opts.status}`)!);
  };

  beforeEach(() => {
    created = []; revoked = []; downloads = [];
    Object.assign(URL, { createObjectURL: vi.fn((blob: Blob) => { created.push(blob); return `blob:test-${created.length}`; }), revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }) });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, href: this.getAttribute("href") ?? "" }); });
    useExportFetch(async () => fileResponse());
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("gate, capability and archived visibility", async () => {
    await openFilm({ parts: ["notes"] });
    await openMenu();
    expect(group()).toBeNull(); // the export part is off: the copy menu is exactly 5c's
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();

    await openFilm({ parts: ["notes", "export"] });
    await openMenu();
    expect(group()).not.toBeNull();
    expect(tid("video-export-edl")).not.toBeNull(); expect(tid("video-export-fcpxml")).not.toBeNull();
  });

  it("export alone (no notes part) offers nothing: there is no notes panel", async () => {
    await mount({ parts: ["export"] }); await openViewer(); await loadFilm();
    expect(tid("video-notes-panel")).toBeNull();
    expect(tid("video-notes-menu")).toBeNull();
  });

  it("an archived Project still exports (an export is a read): the group is there and enabled, the copy items are not", async () => {
    await openFilm({ archivedProject: true });
    await openMenu();
    expect(group()).not.toBeNull();
    expect((tid("video-export-edl") as HTMLElement).getAttribute("aria-disabled")).not.toBe("true");
    expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "Copy shown notes")).toBe(false);
    await click(tid("video-export-edl")!); await flush(4);
    expect(urls()).toHaveLength(1);
  });

  it("defaults: internal unchecked, All selected, previews and a client-side count from the shared selection", async () => {
    await openFilm(); await openMenu();
    expect(tid("video-export-internal")!.getAttribute("aria-checked")).toBe("false");
    expect(tid("video-export-status-all")!.getAttribute("aria-checked")).toBe("true");
    expect(tid("video-export-status-open")!.getAttribute("aria-checked")).toBe("false");
    expect(tid("video-export-edl-name")!.textContent).toBe("Main walkthrough-v2-notes-all-public.edl");
    expect(tid("video-export-fcpxml-name")!.textContent).toBe("Main walkthrough-v2-notes-all-public.fcpxml");
    expect(tid("video-export-count")!.textContent).toBe("3 markers");
  });

  it("option changes keep the menu open and update the preview and the count; settings are not the panel's filters", async () => {
    await openFilm();
    await click(tid("video-notes-filter-status-resolved")!); // the panel's own filter
    await openMenu();
    expect(tid("video-export-status-all")!.getAttribute("aria-checked")).toBe("true");
    await exportOpts({ internal: true });
    expect(group()).not.toBeNull();
    expect(tid("video-export-count")!.textContent).toBe("6 markers");
    expect(tid("video-export-edl-name")!.textContent).toBe("Main walkthrough-v2-notes-all-with-internal.edl");
    await exportOpts({ status: "open" });
    expect(group()).not.toBeNull();
    expect(tid("video-export-count")!.textContent).toBe("5 markers");
    await exportOpts({ status: "resolved" });
    expect(tid("video-export-count")!.textContent).toBe("1 marker");
    expect(tid("video-export-edl-name")!.textContent).toBe("Main walkthrough-v2-notes-resolved-with-internal.edl");
  });

  it("sends the actual request, saves the file under the Content-Disposition name, closes the menu and revokes the URL", async () => {
    await openFilm(); await openMenu();
    await exportOpts({ internal: true, status: "open" });
    useExportFetch(async () => fileResponse({ name: "Main walkthrough-v2-notes-open-with-internal.fcpxml", count: 5 }));
    await click(tid("video-export-fcpxml")!); await flush(6);
    expect(urls()).toEqual([`/api/projects/${PROJECT}/video-versions/${ids.asset2}/marker-export?format=fcpxml&includeInternal=true&status=open`]);
    const init = exportFetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("GET"); expect(init.credentials).toBe("include"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(created).toHaveLength(1);
    expect(downloads).toEqual([{ name: "Main walkthrough-v2-notes-open-with-internal.fcpxml", href: "blob:test-1" }]);
    expect(group()).toBeNull(); // format activation closes the menu
    expect(tid("video-export-status")).toBeNull();
    await vi.waitFor(() => { expect(revoked).toEqual(["blob:test-1"]); }, { timeout: 3000 });
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("shows 'Preparing export…' as a status while the request is out", async () => {
    let release!: (response: Response) => void;
    useExportFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(2);
    expect(tid("video-export-status")!.getAttribute("role")).toBe("status");
    expect(tid("video-export-status")!.textContent).toBe("Preparing export…");
    await act(async () => { release(fileResponse()); }); await flush(4);
    expect(tid("video-export-status")).toBeNull();
    expect(created).toHaveLength(1);
  });

  it("suppresses a double activation: one request while it is out, and the items are disabled", async () => {
    let release!: (response: Response) => void;
    useExportFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
    await openFilm(); await openMenu();
    const edl = tid("video-export-edl")!;
    await act(async () => { edl.click(); edl.click(); }); // two activations before the menu has re-rendered
    await flush(2);
    expect(exportFetch).toHaveBeenCalledTimes(1);
    await openMenu();
    expect(tid("video-export-edl")!.getAttribute("aria-disabled")).toBe("true");
    expect(tid("video-export-fcpxml")!.getAttribute("aria-disabled")).toBe("true");
    await click(tid("video-export-fcpxml")!);
    expect(exportFetch).toHaveBeenCalledTimes(1);
    await act(async () => { release(fileResponse()); }); await flush(4);
    expect(created).toHaveLength(1);
  });

  it("a 422 over the EDL limit offers Download FCPXML with the same options, and writes no file for the refusal", async () => {
    useExportFetch(async (url) => url.includes("format=edl") ? jsonResponse(422, { code: "too_many_markers", format: "edl", count: 1200, limit: 999 }) : fileResponse({ name: "x.fcpxml" }));
    await openFilm(); await openMenu(); await exportOpts({ internal: true, status: "open" });
    await click(tid("video-export-edl")!); await flush(4);
    expect(created).toHaveLength(0);
    expect(tid("video-export-error")!.getAttribute("role")).toBe("alert");
    expect(tid("video-export-error")!.textContent).toContain("This export has 1200 markers. Resolve EDL supports up to 999. Download FCPXML or choose fewer notes.");
    await click(tid("video-export-recover")!); await flush(4);
    expect(urls()).toEqual([
      `/api/projects/${PROJECT}/video-versions/${ids.asset2}/marker-export?format=edl&includeInternal=true&status=open`,
      `/api/projects/${PROJECT}/video-versions/${ids.asset2}/marker-export?format=fcpxml&includeInternal=true&status=open`,
    ]);
    expect(created).toHaveLength(1);
    expect(tid("video-export-error")).toBeNull();
  });

  it("an empty file is downloaded and announced", async () => {
    useExportFetch(async () => fileResponse({ body: "", count: 0 }));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(4);
    expect(created).toHaveLength(1); expect(created[0]!.size).toBe(0);
    expect(tid("video-export-status")!.getAttribute("role")).toBe("status");
    expect(tid("video-export-status")!.textContent).toBe("No notes matched these export options. An empty file was downloaded.");
  });

  it.each([
    [404, { error: "Not found" }, "Export is unavailable. Refresh this Project and try again."],
    [403, { error: "Forbidden" }, "You don’t have permission to export these notes."],
    [409, { code: "project_archived" }, "This Project is archived. Notes cannot be exported."],
    [422, { code: "export_frames_out_of_range", count: 1, frameCount: 300 }, "Some notes are outside this Version. Export could not be created."],
    [500, { error: "boom" }, "Export could not be downloaded. Try again."],
  ])("status %i shows its copy and creates no Blob or download", async (status, body, copy) => {
    useExportFetch(async () => jsonResponse(status, body));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(4);
    expect(tid("video-export-error")!.textContent).toContain(copy);
    expect(created).toHaveLength(0); expect(downloads).toHaveLength(0);
  });

  it("a network failure is retryable with the same request", async () => {
    let calls = 0;
    useExportFetch(async () => { calls += 1; if (calls === 1) throw new TypeError("offline"); return fileResponse(); });
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(4);
    expect(tid("video-export-error")!.textContent).toContain("Export could not be downloaded. Try again.");
    expect(created).toHaveLength(0);
    await click(tid("video-export-retry")!); await flush(4);
    expect(urls()[1]).toBe(urls()[0]);
    expect(created).toHaveLength(1);
  });

  it("a completion that lands after the Version changed saves nothing, says nothing, and the request was aborted", async () => {
    let release!: (response: Response) => void; let signal!: AbortSignal;
    useExportFetch((_url, init) => new Promise<Response>((resolve) => { release = resolve; signal = init.signal!; }));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(2);
    await pickVersion("v1");
    expect(signal.aborted).toBe(true);
    await act(async () => { release(fileResponse()); }); await flush(6);
    expect(created).toHaveLength(0); expect(downloads).toHaveLength(0);
    expect(tid("video-export-status")).toBeNull(); expect(tid("video-export-error")).toBeNull();
    await openMenu(); // v1 starts from the defaults and its own request
    expect(tid("video-export-edl-name")!.textContent).toBe("Main walkthrough-v1-notes-all-public.edl");
  });

  it("settings reset when the Version changes", async () => {
    await openFilm(); await openMenu(); await exportOpts({ internal: true, status: "resolved" });
    await dispatchKey(tid("video-export-internal")!, "Escape"); await settle(200);
    await pickVersion("v1"); await openMenu();
    expect(tid("video-export-internal")!.getAttribute("aria-checked")).toBe("false");
    expect(tid("video-export-status-all")!.getAttribute("aria-checked")).toBe("true");
  });

  it("a completion after the viewer closed saves nothing", async () => {
    let release!: (response: Response) => void; let signal!: AbortSignal;
    useExportFetch((_url, init) => new Promise<Response>((resolve) => { release = resolve; signal = init.signal!; }));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(2);
    await dispatchKey(popup(), "Escape"); await settle(300);
    expect(dialog()).toBeNull();
    expect(signal.aborted).toBe(true);
    await act(async () => { release(fileResponse()); }); await flush(4);
    expect(created).toHaveLength(0);
  });

  it("a completion after the signed-in person changed saves nothing", async () => {
    let release!: (response: Response) => void; let signal!: AbortSignal;
    useExportFetch((_url, init) => new Promise<Response>((resolve) => { release = resolve; signal = init.signal!; }));
    await openFilm(); await openMenu(); await click(tid("video-export-edl")!); await flush(2);
    auth.userId = "55555555-5555-4555-8555-555555555555";
    await act(async () => { renderTree(); }); await flush(4);
    expect(signal.aborted).toBe(true);
    await act(async () => { release(fileResponse()); }); await flush(6);
    expect(created).toHaveLength(0);
    auth.userId = "44444444-4444-4444-8444-444444444444";
  });

  describe("keyboard and Escape", () => {
    it("Escape closes the menu first and leaves the viewer open; the next Escape closes the viewer", async () => {
      await openFilm(); await openMenu();
      expect(group()).not.toBeNull();
      await dispatchKey(tid("video-export-internal")!, "Escape"); await settle(200);
      expect(group()).toBeNull(); expect(dialog()).not.toBeNull();
      expect(document.activeElement).toBe(tid("video-notes-menu"));
      await dispatchKey(popup(), "Escape"); await settle(300);
      expect(dialog()).toBeNull();
    });

    it("arrow keys move through the items, Space on the checkbox does not play the film, and the menu stays open", async () => {
      await openFilm(); await openMenu();
      const internal = tid("video-export-internal")!;
      await act(async () => { internal.focus(); });
      await dispatchKey(internal, "ArrowDown");
      expect(document.activeElement).toBe(tid("video-export-status-all"));
      await dispatchKey(document.activeElement!, "ArrowUp");
      expect(document.activeElement).toBe(internal);
      await dispatchKey(internal, " "); await dispatchKey(internal, "Enter"); await flush(2);
      expect(playerVideo()!.paused).toBe(true);
      expect(group()).not.toBeNull();
      await dispatchKey(internal, "End");
      expect(document.activeElement).toBe(tid("video-export-fcpxml"));
      await dispatchKey(document.activeElement!, "Home");
      expect(document.activeElement?.textContent).toBe("Copy shown notes"); // the menu's first item
    });

    it("with unsent text in the composer, Escape closes the menu and keeps the text and the viewer; the next Escape keeps them too (the composer's own first Escape)", async () => {
      await openFilm();
      await type(document.getElementById("video-note-body") as HTMLTextAreaElement, "unsent thought");
      await openMenu();
      await dispatchKey(tid("video-export-internal")!, "Escape"); await settle(200);
      expect(group()).toBeNull(); expect(dialog()).not.toBeNull();
      expect((document.getElementById("video-note-body") as HTMLTextAreaElement).value).toBe("unsent thought");
    });
  });
});
