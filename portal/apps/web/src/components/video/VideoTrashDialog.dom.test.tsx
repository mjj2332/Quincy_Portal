import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoTrashItem } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
import { clearToasts, getToasts } from "../../lib/toast-store";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { FIXTURE_PERSON, fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { ToastViewport } from "../quincy/ToastViewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", gone: "88888888-8888-4888-8888-888888888899", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY - 3_600_000).toISOString();
const versionItem = (over: Partial<VideoTrashItem> = {}): VideoTrashItem => ({ kind: "version", videoId: ids.video, title: "Main walkthrough", assetId: ids.asset2, version: 2, canRestore: true, removedAt: "2026-10-09T01:00:00.000Z", removedBy: FIXTURE_PERSON, purgeAt: inDays(5), ...over });
const videoItem = (over: Partial<VideoTrashItem> = {}): VideoTrashItem => ({ kind: "video", videoId: ids.gone, title: "Sunset exterior", versionCount: 3, removedAt: "2026-10-08T01:00:00.000Z", removedBy: FIXTURE_PERSON, purgeAt: inDays(2), ...over });

let root: Root | null = null; let host: HTMLElement;
let trash: VideoTrashItem[];
let restoreOutcome: () => Promise<unknown>;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
let rerender: () => Promise<void>;
const ORIGINAL_USER = auth.userId;
async function mount(opts: { parts?: string[]; role?: Role; archived?: boolean } = {}) {
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset1, version: 1 })] })] };
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: trash };
    if (path.includes("/notes") || path.endsWith("/decisions")) return { notes: [], versions: [] };
    throw new Error(`unrouted ${path}`);
  });
  const role = opts.role ?? "editor";
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const tree = () => <QuincyQueryProvider principalId={auth.userId} role={role}><ToastViewport /><VideoCollectionPanel projectId={PROJECT} role={role} archived={opts.archived ?? false} review={{ open: true, parts: (opts.parts ?? ["trash"]) as never }} /></QuincyQueryProvider>;
  rerender = async () => { await act(async () => { root!.render(tree()); }); await flush(4); };
  await act(async () => { root!.render(tree()); });
  await flush();
}
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const trashDialog = () => document.querySelector<HTMLElement>('[data-testid="video-trash-dialog"]');
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-trash-row"]')];
const opener = () => tid("video-trash-open");
async function openTrash() {
  expect(opener(), "the Trash button").not.toBeNull();
  opener()!.focus();
  await act(async () => { opener()!.click(); });
  const deadline = Date.now() + 10_000;
  while (!trashDialog()) { if (Date.now() > deadline) throw new Error("the Trash dialog never mounted"); await flush(1); }
  await flush(6);
}
const restoreButton = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Restore")!;
const posts = () => api.apiPost.mock.calls.map(([path, body]) => ({ path: String(path), body }));
const listReads = () => api.apiGet.mock.calls.filter(([p]) => String(p).endsWith("/video-trash")).length;
const videoReads = () => api.apiGet.mock.calls.filter(([p]) => String(p).endsWith("/videos")).length;

beforeEach(() => {
  auth.userId = ORIGINAL_USER;
  Object.values(api).forEach((m) => m.mockReset()); clearToasts();
  trash = [versionItem(), videoItem()];
  restoreOutcome = async () => ({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset2, version: 2 }), fixtureVersion({ assetId: ids.asset1, version: 1 })] }) });
  api.apiPost.mockImplementation(async () => restoreOutcome());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

describe("Video Trash dialog (#776 E)", () => {
  it("is offered with the trash part on and not otherwise, and not to a role that may not manage Trash", async () => {
    await mount({ parts: [] });
    expect(opener()).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: ["trash"], role: "photographer" });
    expect(opener()).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: ["trash"] });
    expect(opener()).not.toBeNull();
    expect(opener()!.textContent).toBe("Trash");
  });

  it("reads nothing about the Trash until it is opened", async () => {
    await mount();
    expect(listReads()).toBe(0);
  });

  it("lists each removed Version and film with who removed it and the days left", async () => {
    await mount();
    await openTrash();
    expect(trashDialog()!.getAttribute("role")).toBe("dialog");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("Main walkthrough");
    expect(rows()[0]!.textContent).toContain("Version 2");
    expect(rows()[0]!.textContent).toContain("Mia Chen");
    expect(rows()[0]!.textContent).toContain("5 days left");
    expect(rows()[1]!.textContent).toContain("Sunset exterior");
    expect(rows()[1]!.textContent).toMatch(/whole film/i);
    expect(rows()[1]!.textContent).toContain("3 versions");
    expect(rows()[1]!.textContent).toContain("2 days left");
    expect(trashDialog()!.textContent).toContain("30 days");
  });

  it("counts a part day as a whole day, says '1 day left', and 'Due for deletion' once the time has passed", async () => {
    trash = [versionItem({ purgeAt: inDays(1) }), videoItem({ purgeAt: new Date(Date.now() - 1000).toISOString() })];
    await mount();
    await openTrash();
    expect(rows()[0]!.textContent).toContain("1 day left");
    expect(rows()[1]!.textContent).toContain("Due for deletion");
  });

  it("shows an empty Trash plainly", async () => {
    trash = [];
    await mount();
    await openTrash();
    expect(trashDialog()!.textContent).toContain("Trash is empty");
    expect(rows()).toHaveLength(0);
  });

  it("restores a Version by its Asset id, then reads the list and the films again", async () => {
    await mount();
    await openTrash();
    const listBefore = listReads(); const filmsBefore = videoReads();
    trash = [videoItem()];
    await act(async () => { restoreButton(rows()[0]!).click(); });
    await flush(8);
    expect(posts()).toEqual([{ path: `/api/projects/${PROJECT}/video-versions/${ids.asset2}/restore`, body: {} }]);
    expect(listReads()).toBeGreaterThan(listBefore);
    expect(videoReads()).toBeGreaterThan(filmsBefore);
    expect(rows()).toHaveLength(1);
    expect(getToasts().some((toast) => toast.tone === "success" && /restored/i.test(toast.message))).toBe(true);
  });

  it("restores a whole film by its Video id", async () => {
    await mount();
    await openTrash();
    await act(async () => { restoreButton(rows()[1]!).click(); });
    await flush(8);
    expect(posts()).toEqual([{ path: `/api/projects/${PROJECT}/videos/${ids.gone}/restore`, body: {} }]);
  });

  it("a Version whose film is also in Trash cannot be restored until the film is, and says why", async () => {
    trash = [versionItem({ canRestore: false, restoreBlockedReason: "video_in_trash" })];
    await mount();
    await openTrash();
    expect(restoreButton(rows()[0]!).hasAttribute("disabled")).toBe(true);
    expect(rows()[0]!.textContent).toMatch(/restore the film first/i);
  });

  it("a restore that finds the item already gone says so and refreshes the list", async () => {
    await mount();
    await openTrash();
    const before = listReads();
    trash = [videoItem()];
    restoreOutcome = async () => { throw new ApiError("Version not found in Trash", 404, { error: "Version not found in Trash" }); };
    await act(async () => { restoreButton(rows()[0]!).click(); });
    await flush(8);
    expect(trashDialog()!.querySelector('[role="alert"]')?.textContent).toMatch(/already restored or deleted/i);
    expect(listReads()).toBeGreaterThan(before);
    expect(rows()).toHaveLength(1);
  });

  it("a restore refused because the film is in Trash says to restore the film first", async () => {
    await mount();
    await openTrash();
    restoreOutcome = async () => { throw new ApiError("video in trash", 409, { error: "video in trash", code: "video_in_trash" }); };
    await act(async () => { restoreButton(rows()[0]!).click(); });
    await flush(8);
    expect(trashDialog()!.querySelector('[role="alert"]')?.textContent).toMatch(/restore the film first/i);
  });

  it("an archived project lists the Trash and cannot restore", async () => {
    await mount({ archived: true });
    await openTrash();
    expect(rows()).toHaveLength(2);
    expect(restoreButton(rows()[0]!).hasAttribute("disabled")).toBe(true);
    expect(trashDialog()!.textContent).toMatch(/archived/i);
  });

  it("disables a row's Restore while its request is out, so it cannot be sent twice", async () => {
    await mount();
    await openTrash();
    let release!: () => void;
    restoreOutcome = () => new Promise((resolve) => { release = () => resolve({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset2, version: 2 })] }) }); });
    await act(async () => { restoreButton(rows()[0]!).click(); });
    expect(restoreButton(rows()[0]!).hasAttribute("disabled")).toBe(true);
    await act(async () => { restoreButton(rows()[0]!).click(); });
    expect(posts()).toHaveLength(1);
    await act(async () => { release(); });
    await flush(8);
  });

  it("a restore answered after the person changed announces nothing", async () => {
    await mount();
    await openTrash();
    let release!: () => void;
    restoreOutcome = () => new Promise((resolve) => { release = () => resolve({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset2, version: 2 })] }) }); });
    await act(async () => { restoreButton(rows()[0]!).click(); });
    auth.userId = "22222222-2222-4222-8222-222222222222";
    await rerender();
    await act(async () => { release(); });
    await flush(8);
    expect(getToasts().filter((candidate) => /Restored/.test(candidate.message))).toEqual([]);
  });

  it("reads the list afresh on every opening, and Escape closes it with focus back on the Trash button", async () => {
    await mount();
    await openTrash();
    expect(listReads()).toBe(1);
    await act(async () => { trashDialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(8);
    expect(trashDialog()).toBeNull();
    expect(document.activeElement).toBe(opener());
    await openTrash();
    expect(listReads()).toBe(2);
  });

  it("a list that cannot be read says so and offers Retry", async () => {
    await mount();
    api.apiGet.mockImplementation(async (path) => { if (path.endsWith("/video-trash")) throw new ApiError("bad", 400, {}); return { videos: [], notes: [], versions: [] }; });
    await openTrash();
    await flush(12);
    expect(trashDialog()!.querySelector('[role="alert"]')).not.toBeNull();
    expect([...trashDialog()!.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(true);
  });
});
