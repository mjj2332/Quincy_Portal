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
  const open = document.querySelector<HTMLElement>('[data-testid="video-card-open"]')!;
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
const posts = () => api.apiPost.mock.calls.map(([path, body]) => ({ path: String(path), body }));
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

/** The pointer way a person opens the Version list (the Select opens on pointerdown). */
async function openList() {
  const deadline = Date.now() + 5_000;
  while (!document.querySelector('[aria-label="Version actions"]') && Date.now() < deadline) await flush(1);
  const trigger = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const rowIcon = (n: number) => options().find((o) => o.textContent?.startsWith(`v${n}`))!.querySelector<HTMLElement>('[data-testid="video-version-row-remove"]')!;
/** A press on the icon as a pointer sends it: pointerdown, mousedown, mouseup, click. */
async function pressIcon(icon: HTMLElement) {
  await act(async () => {
    icon.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    icon.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    icon.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    icon.click();
    await Promise.resolve();
  });
  await flush(6);
}
const UPLOAD = { reservationId: "99999999-9999-4999-8999-999999999999", version: 3, uploader: { id: auth.userId, name: "Ed", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-09T02:00:00.000Z" };

beforeEach(() => {
  removeOutcome = async () => { versions = versions.filter((v) => v.assetId !== ids.asset1); return { video: videoNow() }; };
});

describe("Remove a Version from its row in the Version list (#862)", () => {
  it("shows one trash icon per option, and none without the trash part or for a role that may not manage Trash", async () => {
    await mount();
    await openViewer();
    await openList();
    expect(options()).toHaveLength(2);
    expect(document.querySelectorAll('[data-testid="video-version-row-remove"]')).toHaveLength(2);
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: [] });
    await openViewer();
    await openList();
    expect(options()).toHaveLength(2);
    expect(document.querySelectorAll('[data-testid="video-version-row-remove"]')).toHaveLength(0);
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: ["trash"], role: "photographer" });
    await openViewer();
    await openList();
    expect(document.querySelectorAll('[data-testid="video-version-row-remove"]')).toHaveLength(0);
  });

  it("keeps the option's text the label only, and the icon out of the accessibility tree and tab order", async () => {
    await mount();
    await openViewer();
    await openList();
    const icon = rowIcon(1);
    expect(options().map((o) => o.textContent)).toEqual([expect.stringMatching(/^v2 · latest · /), expect.stringMatching(/^v1 · /)]);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("tabindex")).toBe("-1");
  });

  it("pressing the icon on another Version keeps the selection, closes the list and opens the confirmation for that Version", async () => {
    await mount();
    await openViewer();
    await openList();
    await pressIcon(rowIcon(1));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(versionLabel()).toContain("v2");
    expect(confirm()!.textContent).toContain("Remove version 1?");
    expect(confirm()!.textContent).toContain("3 notes");
    expect(api.apiGet.mock.calls.map(([p]) => String(p))).toContain(`/api/projects/${PROJECT}/video-versions/${ids.asset1}/removal-impact`);
    expect(posts()).toEqual([]);
  });

  it("confirming removes that Version and the viewer stays on the Version it was showing", async () => {
    await mount();
    await openViewer();
    await openList();
    await pressIcon(rowIcon(1));
    await click(confirmButton());
    await flush(8);
    expect(posts()).toEqual([{ path: `/api/projects/${PROJECT}/video-versions/${ids.asset1}/remove`, body: { expected: { notes: 3, decisions: 1, release: true, links: 2 }, removeVideo: false } }]);
    expect(confirm()).toBeNull();
    expect(versionLabel()).toContain("v2");
    await openList();
    expect(options().map((o) => o.textContent?.slice(0, 2))).toEqual(["v2"]);
  });

  it("removing another Version leaves the viewer on the Version it was showing, not the film's current one", async () => {
    const asset3 = "55555555-5555-4555-8555-555555555556";
    versions = [{ assetId: asset3, version: 3 }, { assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }];
    await mount();
    await openViewer();
    await openList();
    await act(async () => { options().find((o) => o.textContent?.startsWith("v2"))!.click(); });
    await flush(8);
    expect(versionLabel()).toContain("v2");
    await openList();
    await pressIcon(rowIcon(1));
    removeOutcome = async () => { versions = [{ assetId: asset3, version: 3 }, { assetId: ids.asset2, version: 2 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(versionLabel()).toContain("v2");
  });

  it("removing the Version on show from its row moves to the current Version", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }];
    await mount();
    await openViewer();
    // show v1, then remove it from its own row
    await openList();
    await act(async () => { options().find((o) => o.textContent?.startsWith("v1"))!.click(); });
    await flush(8);
    expect(versionLabel()).toContain("v1");
    await openList();
    await pressIcon(rowIcon(1));
    removeOutcome = async () => { versions = [{ assetId: ids.asset2, version: 2 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(versionLabel()).toContain("v2");
  });

  it("the Undo toast restores the Version", async () => {
    await mount();
    await openViewer();
    await openList();
    await pressIcon(rowIcon(1));
    await click(confirmButton());
    await flush(8);
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo");
    expect(toast?.message).toMatch(/version 1/i);
    api.apiPost.mockImplementation(async () => { versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; });
    await act(async () => { toast!.action!.onAction(); });
    await flush(8);
    expect(posts().pop()?.path).toBe(`/api/projects/${PROJECT}/video-versions/${ids.asset1}/restore`);
    expect(getToasts().some((candidate) => candidate.message.startsWith("Restored version 1"))).toBe(true);
  });

  it("disables every icon while the project is archived, and nothing opens", async () => {
    await mount({ archived: true });
    await openViewer();
    await openList();
    expect(rowIcon(1).hasAttribute("disabled")).toBe(true);
    expect(rowIcon(2).hasAttribute("disabled")).toBe(true);
    await pressIcon(rowIcon(1));
    expect(confirm()).toBeNull();
  });

  it("while an upload runs, disables the icon only when the film has a single Version; with several it proceeds", async () => {
    uploadingNow = UPLOAD;
    await mount();
    await openViewer();
    await openList();
    expect(rowIcon(1).hasAttribute("disabled")).toBe(false);
    await pressIcon(rowIcon(1));
    expect(confirm()!.textContent).toContain("Remove version 1?");
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    versions = [{ assetId: ids.asset2, version: 2 }];
    await mount();
    await openViewer();
    await openList();
    expect(rowIcon(2).hasAttribute("disabled")).toBe(true);
  });

  it("Cancel and Escape close only the confirmation and return focus to the Version select", async () => {
    await mount();
    await openViewer();
    await openList();
    await pressIcon(rowIcon(1));
    await click(confirm()!.querySelector('[data-testid="video-remove-cancel"]')!);
    await flush(6);
    expect(confirm()).toBeNull();
    expect(posts()).toEqual([]);
    expect(document.activeElement).toBe(document.getElementById("video-review-version"));
    await openList();
    await pressIcon(rowIcon(1));
    await act(async () => { confirm()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(6);
    expect(confirm()).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(document.getElementById("video-review-version"));
  });

  it("on a single Version the confirmation is the whole-film one, removeVideo is true and the viewer closes", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true });
    await mount();
    await openViewer();
    await openList();
    await pressIcon(rowIcon(2));
    expect(confirm()!.textContent).toContain("Remove the whole film?");
    removeOutcome = async () => { versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(10);
    expect(posts()[0]!.body).toMatchObject({ removeVideo: true });
    expect(dialog()).toBeNull();
  });

  describe.each([["with the trash part on", ["trash"]], ["with the trash part off", []]])("an ordinary close of the Version list %s", (_name, parts) => {
    const trigger = () => document.getElementById("video-review-version")!;
    it("Escape returns focus to the Version select", async () => {
      await mount({ parts });
      await openViewer();
      await openList();
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      await act(async () => { document.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      await flush(16);
      expect(document.activeElement).toBe(trigger());
    });
    it("choosing a Version returns focus to the Version select", async () => {
      await mount({ parts });
      await openViewer();
      await openList();
      await act(async () => { options().find((o) => o.textContent?.startsWith("v1"))!.click(); });
      await flush(8);
      expect(versionLabel()).toContain("v1");
      expect(document.activeElement).toBe(trigger());
    });
  });
});
