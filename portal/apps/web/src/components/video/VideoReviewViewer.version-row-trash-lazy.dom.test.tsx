import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto, VideoRemovalImpact } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { announcePrincipalTerminal } from "../../lib/principal-terminal";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { versionSlot, videoSlot } from "../../lib/video-approval-store";
import { clearToasts, getToasts } from "../../lib/toast-store";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { ToastViewport } from "../quincy/ToastViewport";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
const gate = vi.hoisted(() => { let release!: () => void; const open = new Promise<void>((resolve) => { release = resolve; }); return { open, release }; });
vi.mock("./VideoVersionMenu", async (importOriginal) => { await gate.open; return importOriginal<typeof import("./VideoVersionMenu")>(); });
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const stores = vi.hoisted(() => ({ made: [] as Array<import("../../lib/video-note-form-store").NoteFormStore> }));
vi.mock("../../lib/video-note-form-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-note-form-store")>();
  return { ...actual, createNoteFormStore: (key: string) => { const store = actual.createNoteFormStore(key); stores.made.push(store); return store; } };
});
const approvals = vi.hoisted(() => ({ made: [] as Array<import("../../lib/video-approval-store").VideoApprovalStore> }));
vi.mock("../../lib/video-approval-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-approval-store")>();
  return { ...actual, createVideoApprovalStore: (key: string) => { const store = actual.createVideoApprovalStore(key); approvals.made.push(store); return store; } };
});
const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const impactOf = (over: Partial<VideoRemovalImpact> = {}): VideoRemovalImpact => ({ lastVersion: false, uploading: false, notes: 3, decisions: 1, release: true, links: [{ id: "55555555-5555-4555-8555-555555555555", label: "Client cut" }, { id: "44444444-4444-4444-8444-444444444444", label: null }], ...over });

const ORIGINAL_USER = auth.userId;
let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
/** The "server": the Versions the film has now. */
let versions: Array<{ assetId: string; version: number }>;
let impact: VideoRemovalImpact;
let removeOutcome: () => Promise<unknown>;
/** The film's upload reservation on the "server" (null: none). */
let uploadingNow: VideoDto["uploading"] = null;
const videoNow = (): VideoDto => fixtureVideo({ id: ids.video, versions: versions.map((v) => fixtureVersion(v)), uploading: uploadingNow });
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(opts: { parts?: string[]; role?: Role; archived?: boolean } = {}) {
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: versions.length ? [videoNow()] : [] };
    if (path.endsWith("/removal-impact")) return impact;
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: [] };
    if (path.endsWith("/decisions")) return { versions: [] };
    if (path.includes("/notes")) return { notes: [] };
    throw new Error(`unrouted ${path}`);
  });
  const role = opts.role ?? "editor";
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const tree = () => <QuincyQueryProvider key={providerKey} principalId={auth.userId} role={role}><ToastViewport /><Probe /><VideoCollectionPanel projectId={PROJECT} role={role} archived={opts.archived ?? false} review={{ open: true, parts: (opts.parts ?? ["trash"]) as never }} /></QuincyQueryProvider>;
  rerender = async () => { await act(async () => { root!.render(tree()); }); await flush(4); };
  await act(async () => { root!.render(tree()); });
  await flush();
}
let rerender: () => Promise<void>;
let providerKey = 0;
const probe: { client: QueryClient | null } = { client: null };
function Probe() { probe.client = useQueryClient(); return null; }
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const dialog = () => document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]');
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
async function openViewer() {
  const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Open review")!;
  open.focus();
  await act(async () => { open.click(); });
  const deadline = Date.now() + 10_000;
  while (!dialog()?.querySelector("video")) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); }
  await flush(4);
}
async function menuItem(label: string) {
  // The menu is its own lazy chunk, loaded after the viewer.
  const deadline = Date.now() + 5_000;
  while (!document.querySelector('[aria-label="Version actions"]') && Date.now() < deadline) await flush(1);
  const trigger = document.querySelector<HTMLElement>('[aria-label="Version actions"]');
  expect(trigger, "the Version actions menu").not.toBeNull();
  await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
}
async function startRemove() {
  const item = await menuItem("Remove version…");
  expect(item, "the Remove version item").toBeDefined();
  await act(async () => { item!.click(); await Promise.resolve(); });
  await flush(6);
}
const confirmButton = () => { expect(confirm(), "the confirmation").not.toBeNull(); return confirm()!.querySelector<HTMLElement>('[data-testid="video-remove-confirm"]')!; };
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const versionLabel = () => tid("video-version-label")?.textContent ?? "";

beforeEach(() => {
  providerKey = 0;
  stub = installVideoElementStub(); Object.values(api).forEach((m) => m.mockReset()); stores.made.length = 0; approvals.made.length = 0; clearToasts();
  versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }];
  impact = impactOf(); uploadingNow = null;
  removeOutcome = async () => ({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset1, version: 1 })] }) });
  api.apiPost.mockImplementation(async (path) => { if (String(path).endsWith("/remove")) return removeOutcome(); throw new Error(`unrouted ${path}`); });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { auth.userId = ORIGINAL_USER; if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

async function openList() {
  const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const posts = () => api.apiPost.mock.calls.map(([path, body]) => ({ path: String(path), body }));

beforeEach(() => {
  providerKey = 0;
  stub = installVideoElementStub(); Object.values(api).forEach((m) => m.mockReset()); stores.made.length = 0; approvals.made.length = 0; clearToasts();
  versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }];
  impact = impactOf(); uploadingNow = null;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { auth.userId = ORIGINAL_USER; if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

describe("Version row trash icons while the Version menu chunk loads (#862)", () => {
  it("keeps the icons disabled and the list open on a press until the menu has mounted, then enables them", async () => {
    await mount();
    await openViewer();
    await openList();
    const icon = () => options().find((o) => o.textContent?.startsWith("v1"))!.querySelector<HTMLElement>('[data-testid="video-version-row-remove"]')!;
    expect(icon().hasAttribute("disabled")).toBe(true);
    await act(async () => { icon().click(); });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { gate.release(); });
    const deadline = Date.now() + 5_000;
    while (!document.querySelector('[aria-label="Version actions"]') && Date.now() < deadline) await flush(1);
    expect(icon().hasAttribute("disabled")).toBe(false);
    expect(posts()).toEqual([]);
  });
});
