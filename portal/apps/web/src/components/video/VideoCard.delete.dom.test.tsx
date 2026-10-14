import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Role, VideoDeletionImpact, VideoDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
import { clearToasts, getToasts } from "../../lib/toast-store";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { ToastViewport } from "../quincy/ToastViewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";

/** #868: Delete in the Video card's "⋯" menu: where the item sits, the confirmation that reads what the delete affects, the counts it sends, focus, and Undo. */
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
const ids = { video: "88888888-8888-4888-8888-888888888888", other: "99999999-9999-4999-8999-999999999990", a2: "77777777-7777-4777-8777-777777777777", a1: "66666666-6666-4666-8666-666666666666", b1: "55555555-5555-4555-8555-555555555550", link: "55555555-5555-4555-8555-555555555555" };
const impactOf = (over: Partial<VideoDeletionImpact> = {}): VideoDeletionImpact => ({ assetIds: [ids.a1, ids.a2].sort(), versions: 2, latestVersion: 2, uploading: false, published: false, notes: 3, decisions: 1, releases: 1, links: [{ id: ids.link, label: "Client cut" }], ...over });

let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
/** The "server": the films now, the impact of the first, and what a delete answers. */
let films: VideoDto[];
let impact: VideoDeletionImpact;
let deleteOutcome: () => Promise<unknown>;
const probe: { client: QueryClient | null } = { client: null };
function Probe() { probe.client = useQueryClient(); return null; }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(opts: { parts?: string[]; role?: Role; archived?: boolean } = {}) {
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: films };
    if (path.endsWith("/removal-impact")) return impact;
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: [] };
    throw new Error(`unrouted ${path}`);
  });
  const role = opts.role ?? "editor";
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><ToastViewport /><Probe /><VideoCollectionPanel projectId={PROJECT} role={role} archived={opts.archived ?? false} review={{ open: true, parts: (opts.parts ?? ["trash"]) as never }} /></QuincyQueryProvider>); });
  await flush();
}
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const cardMenu = (videoId: string) => document.querySelector<HTMLElement>(`[data-testid="video-card-menu"][data-video-id="${videoId}"]`)!;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent);
const separators = () => document.querySelectorAll('[role="separator"]').length;
async function openMenu(videoId: string) {
  await act(async () => { cardMenu(videoId).focus(); await Promise.resolve(); });
  await act(async () => { cardMenu(videoId).click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(10);
}
async function startDelete(videoId = ids.video) { await openMenu(videoId); await act(async () => { tid("video-card-delete")!.click(); await Promise.resolve(); }); await flush(8); }
const confirmBtn = () => tid("video-delete-confirm") as HTMLButtonElement;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const posts = () => api.apiPost.mock.calls.map(([path, body]) => ({ path: String(path), body }));
const gets = () => api.apiGet.mock.calls.map(([path]) => String(path));
const filmCards = () => [...document.querySelectorAll('[data-testid="video-card"]')].length;

beforeEach(() => {
  stub = installVideoElementStub(); Object.values(api).forEach((m) => m.mockReset()); clearToasts();
  films = [
    fixtureVideo({ id: ids.video, title: "Main walkthrough", versions: [fixtureVersion({ assetId: ids.a2, version: 2 }), fixtureVersion({ assetId: ids.a1, version: 1 })] }),
    fixtureVideo({ id: ids.other, title: "Teaser", versions: [fixtureVersion({ assetId: ids.b1, version: 1 })] }),
  ];
  impact = impactOf();
  deleteOutcome = async () => { films = films.filter((film) => film.id !== ids.video); return { videoId: ids.video, versionCount: 2 }; };
  api.apiPost.mockImplementation(async (path) => {
    if (String(path).endsWith("/remove")) return deleteOutcome();
    if (String(path).endsWith("/restore")) { films = [fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.a2, version: 2 }), fixtureVersion({ assetId: ids.a1, version: 1 })] }), ...films]; return { video: films[0] }; }
    throw new Error(`unrouted ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

describe("the Delete item", () => {
  it.each(["admin", "editor"] as const)("%s sees Delete… last, after Rename, in the last group under one separator", async (role) => {
    await mount({ role });
    await openMenu(ids.video);
    const labels = menuItems();
    expect(labels.at(-1)).toBe("Delete…");
    expect(labels.filter((label) => label === "Delete…")).toHaveLength(1);
    const menu = document.querySelector('[role="menu"]')!;
    const children = [...menu.children];
    expect(children.at(-1)).toBe(tid("video-card-delete"));
    expect(children.at(-2)).toBe(tid("video-card-rename"));
    expect(children.at(-3)?.getAttribute("role")).toBe("separator");
    expect(separators()).toBeGreaterThanOrEqual(1);
  });
  it("on an archived Project (no Rename) the disabled Delete… still gets the separator", async () => {
    await mount({ archived: true });
    await openMenu(ids.video);
    expect(menuItems()).not.toContain("Rename…");
    const children = [...document.querySelector('[role="menu"]')!.children];
    expect(children.at(-1)).toBe(tid("video-card-delete"));
    expect(children.at(-2)?.getAttribute("role")).toBe("separator");
  });
  it("is absent for a Photographer and with the trash part off", async () => {
    await mount({ role: "photographer" });
    await openMenu(ids.video);
    expect(tid("video-card-delete")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: [] });
    await openMenu(ids.video);
    expect(tid("video-card-delete")).toBeNull();
  });
  it("is disabled while the Project is archived", async () => {
    await mount({ archived: true });
    await openMenu(ids.video);
    expect(tid("video-card-delete")!.hasAttribute("data-disabled") || tid("video-card-delete")!.getAttribute("aria-disabled") === "true").toBe(true);
  });
});

describe("the confirmation", () => {
  it("reads the impact of that film and lists what it affects", async () => {
    await mount();
    await startDelete();
    expect(gets().some((path) => path === `/api/projects/${PROJECT}/videos/${ids.video}/removal-impact`)).toBe(true);
    const dialog = tid("video-delete-dialog")!;
    expect(dialog.textContent).toContain("Delete “Main walkthrough”?");
    expect(dialog.textContent).toContain("2 versions");
    const rows = tid("video-delete-impact")!.textContent!;
    expect(rows).toContain("3 notes"); expect(rows).toContain("1 client decision"); expect(rows).toContain("1 released version"); expect(rows).toContain("Live"); expect(rows).toContain("Client cut");
  });
  it("Cancel sends nothing and returns focus to that card's ⋯", async () => {
    await mount();
    await startDelete();
    await click(tid("video-delete-cancel")!); await flush(10);
    expect(tid("video-delete-dialog")).toBeNull();
    expect(posts()).toEqual([]);
    expect(document.activeElement).toBe(cardMenu(ids.video));
  });
  it("blocks while the film has an active upload, and offers Delete again once the upload ends", async () => {
    films[0] = fixtureVideo({ id: ids.video, versions: films[0]!.versions, uploading: { reservationId: "00000000-0000-4000-8000-0000000000a1", version: 3, uploader: { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-10T01:00:00.000Z" } });
    impact = impactOf({ uploading: true });
    await mount();
    await startDelete();
    expect(confirmBtn().disabled).toBe(true);
    expect(tid("video-delete-blocked")!.textContent).toMatch(/upload/i);
    films[0] = fixtureVideo({ id: ids.video, versions: films[0]!.versions }); impact = impactOf();
    await act(async () => { await probe.client!.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT), exact: true }); }); await flush(10);
    expect(confirmBtn().disabled).toBe(false);
  });
  it("blocks at once when an upload starts after the impact was read, and reads the impact again when it starts and when it ends", async () => {
    await mount();
    await startDelete();
    expect(confirmBtn().disabled).toBe(false);
    const reads = () => gets().filter((path) => path.endsWith("/removal-impact")).length;
    const before = reads();
    films[0] = fixtureVideo({ id: ids.video, versions: films[0]!.versions, uploading: { reservationId: "00000000-0000-4000-8000-0000000000a1", version: 3, uploader: { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-10T01:00:00.000Z" } });
    impact = impactOf({ uploading: true });
    await act(async () => { await probe.client!.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT), exact: true }); }); await flush(10);
    expect(confirmBtn().disabled).toBe(true);
    expect(tid("video-delete-blocked")).not.toBeNull();
    expect(reads()).toBeGreaterThan(before);
    const during = reads();
    films[0] = fixtureVideo({ id: ids.video, versions: films[0]!.versions }); impact = impactOf();
    await act(async () => { await probe.client!.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT), exact: true }); }); await flush(10);
    expect(reads()).toBeGreaterThan(during);
    expect(confirmBtn().disabled).toBe(false);
  });
  it("blocks a film that is on a published Client Delivery page", async () => {
    impact = impactOf({ published: true });
    await mount();
    await startDelete();
    expect(confirmBtn().disabled).toBe(true);
    expect(tid("video-delete-blocked")!.textContent).toMatch(/Client Delivery/);
  });
});

describe("Delete", () => {
  it("sends exactly the counts it read, the card leaves the grid, focus goes to the Trash button, and the Undo toast restores the whole film", async () => {
    await mount();
    await startDelete();
    expect(filmCards()).toBe(2);
    await click(confirmBtn()); await flush(12);
    expect(posts()).toEqual([{ path: `/api/projects/${PROJECT}/videos/${ids.video}/remove`, body: { expected: { assetIds: [ids.a1, ids.a2].sort(), notes: 3, decisions: 1, releases: 1, links: 1 } } }]);
    expect(tid("video-delete-dialog")).toBeNull();
    expect(filmCards()).toBe(1);
    await flush(10);
    expect(document.activeElement).toBe(tid("video-trash-open"));
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo");
    expect(toast?.message).toBe("“Main walkthrough” moved to Trash.");
    await act(async () => { toast!.action!.onAction(); }); await flush(12);
    expect(posts().at(-1)).toEqual({ path: `/api/projects/${PROJECT}/videos/${ids.video}/restore`, body: {} });
    expect(getToasts().some((candidate) => candidate.message === "Restored “Main walkthrough”.")).toBe(true);
    expect(filmCards()).toBe(2);
  });
  it("a changed film is refused: the rows are refreshed and the problem takes focus, nothing is deleted", async () => {
    await mount();
    await startDelete();
    deleteOutcome = async () => { throw new ApiError("changed", 409, { error: "changed", code: "impact_changed", impact: impactOf({ notes: 5 }) }); };
    await click(confirmBtn()); await flush(10);
    expect(tid("video-delete-dialog")).not.toBeNull();
    expect(tid("video-delete-impact")!.textContent).toContain("5 notes");
    expect(document.activeElement).toBe(tid("video-delete-problem"));
    expect(tid("video-delete-problem")!.textContent).toMatch(/changed/i);
    expect(filmCards()).toBe(2);
  });
  it("a film that is already gone shows Close instead of Cancel", async () => {
    await mount();
    await startDelete();
    deleteOutcome = async () => { throw new ApiError("Video not found", 404, { error: "Video not found" }); };
    await click(confirmBtn()); await flush(10);
    expect(tid("video-delete-cancel")!.textContent).toBe("Close");
    expect(confirmBtn().disabled).toBe(true);
  });
});
