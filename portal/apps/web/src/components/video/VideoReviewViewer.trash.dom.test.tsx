import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto, VideoRemovalImpact } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
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
  const tree = () => <QuincyQueryProvider principalId={auth.userId} role={role}><ToastViewport /><VideoCollectionPanel projectId={PROJECT} role={role} archived={opts.archived ?? false} review={{ open: true, parts: (opts.parts ?? ["trash"]) as never }} /></QuincyQueryProvider>;
  rerender = async () => { await act(async () => { root!.render(tree()); }); await flush(4); };
  await act(async () => { root!.render(tree()); });
  await flush();
}
let rerender: () => Promise<void>;
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
const posts = () => api.apiPost.mock.calls.map(([path, body]) => ({ path: String(path), body }));
const versionLabel = () => tid("video-version-label")?.textContent ?? "";

beforeEach(() => {
  stub = installVideoElementStub(); Object.values(api).forEach((m) => m.mockReset()); stores.made.length = 0; clearToasts();
  versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }];
  impact = impactOf(); uploadingNow = null;
  removeOutcome = async () => ({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.asset1, version: 1 })] }) });
  api.apiPost.mockImplementation(async (path) => { if (String(path).endsWith("/remove")) return removeOutcome(); throw new Error(`unrouted ${path}`); });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { auth.userId = ORIGINAL_USER; if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

describe("Remove a Version from the staff viewer (#776 E)", () => {
  it("offers no Version menu with the trash part off, or to a role that may not manage Trash", async () => {
    await mount({ parts: [] });
    await openViewer();
    expect(document.querySelector('[aria-label="Version actions"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount({ parts: ["trash"], role: "photographer" });
    await openViewer();
    expect(document.querySelector('[aria-label="Version actions"]')).toBeNull();
  });

  it("puts Remove in a Version menu beside the Version select", async () => {
    await mount();
    await openViewer();
    const item = await menuItem("Remove version…");
    expect(item).toBeDefined();
    expect(dialog()!.querySelector('[aria-label="Version actions"]')).not.toBeNull();
  });

  it("disables Remove while the project is archived", async () => {
    await mount({ archived: true });
    await openViewer();
    const item = await menuItem("Remove version…");
    expect(item?.getAttribute("aria-disabled")).toBe("true");
  });

  it("asks what the removal affects, and lists notes, decisions, the live release and the review links before anything is sent", async () => {
    await mount();
    await openViewer();
    await startRemove();
    expect(api.apiGet.mock.calls.map(([p]) => String(p))).toContain(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/removal-impact`);
    const text = confirm()!.textContent!;
    expect(text).toContain("Remove version 2?");
    expect(text).toContain("3 notes");
    expect(text).toContain("1 client decision");
    expect(text).toMatch(/released to the client/i);
    expect(text).toContain("2 review links");
    expect(text).toContain("Client cut");
    expect(text).toMatch(/30 days/);
    expect(posts()).toEqual([]);
  });

  it("says plainly when nothing else is affected", async () => {
    impact = impactOf({ notes: 0, decisions: 0, release: false, links: [] });
    await mount();
    await openViewer();
    await startRemove();
    expect(confirm()!.textContent).toMatch(/nothing else/i);
  });

  it("Cancel closes the confirmation, sends nothing and returns focus to the Version menu", async () => {
    await mount();
    await openViewer();
    await startRemove();
    await click(confirm()!.querySelector('[data-testid="video-remove-cancel"]')!);
    await flush(6);
    expect(confirm()).toBeNull();
    expect(posts()).toEqual([]);
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Version actions"]'));
  });

  it("Escape in the confirmation closes only the confirmation, not the viewer", async () => {
    await mount();
    await openViewer();
    await startRemove();
    await act(async () => { confirm()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(6);
    expect(confirm()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it("confirming sends the counts the person saw and removeVideo false, then shows the previous Version and no longer offers the removed one", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(posts()).toEqual([{ path: `/api/projects/${PROJECT}/video-versions/${ids.asset2}/remove`, body: { expected: { notes: 3, decisions: 1, release: true, links: 2 }, removeVideo: false } }]);
    expect(confirm()).toBeNull();
    expect(versionLabel()).toContain("v1");
    expect(dialog()!.textContent).not.toContain("v2");
  });

  it("an Undo toast follows, and its action restores that Version", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo");
    expect(toast?.message).toMatch(/version 2/i);
    api.apiPost.mockImplementation(async (path) => { versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; });
    await act(async () => { toast!.action!.onAction(); });
    await flush(8);
    expect(posts().pop()?.path).toBe(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/restore`);
    expect(getToasts().some((candidate) => candidate.tone === "error")).toBe(false);
  });

  it("Undo follows what the person confirmed, not what the answer turned out to be (another editor removed the last Version first)", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(8);
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo");
    expect(toast?.message).toMatch(/version 2 of/i);
    api.apiPost.mockImplementation(async () => { versions = [{ assetId: ids.asset2, version: 2 }, { assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; });
    await act(async () => { toast!.action!.onAction(); });
    await flush(8);
    expect(posts().pop()?.path).toBe(`/api/projects/${PROJECT}/video-versions/${ids.asset2}/restore`);
  });

  it("Undo is inside the open viewer, so the modal focus trap can reach it", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(dialog()).not.toBeNull();
    const undo = tid("toast-action");
    expect(undo, "the Undo action").not.toBeNull();
    expect(dialog()!.contains(undo)).toBe(true);
    expect(document.querySelectorAll('[data-testid="toast"]')).toHaveLength(1);
    undo!.focus();
    expect(document.activeElement).toBe(undo);
  });

  it("the discard warning counts the composer's draft even while an unchanged reply is open", async () => {
    await mount({ parts: ["trash", "notes"] });
    await openViewer();
    const forms = stores.made.at(-1)!;
    forms.setBody(ids.asset2, "an unsent note", 4);
    forms.openReply(ids.asset2, "00000000-0000-4000-8000-000000000001");
    await startRemove();
    expect(tid("video-remove-draft")).not.toBeNull();
  });

  it("an Undo that is refused says why", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo")!;
    api.apiPost.mockRejectedValue(new ApiError("Version not found in Trash", 404, { error: "Version not found in Trash" }));
    await act(async () => { toast.action!.onAction(); });
    await flush(8);
    expect(getToasts().some((candidate) => candidate.tone === "error" && /already restored or deleted/i.test(candidate.message))).toBe(true);
  });

  it("retires the removed Version's form slot, so a restored Version starts with no draft", async () => {
    await mount({ parts: ["trash", "notes"] });
    await openViewer();
    const forms = stores.made.at(-1)!;
    forms.setBody(ids.asset2, "an unsent note", 4);
    expect(forms.slot(ids.asset2).composer.body).toBe("an unsent note");
    await startRemove();
    expect(confirm()!.textContent).toMatch(/unsent note/i);
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(forms.slot(ids.asset2).composer.body).toBe("");
  });

  it("the discard warning also shows for an unsaved drawing with no text", async () => {
    await mount({ parts: ["trash", "notes"] });
    await openViewer();
    const forms = stores.made.at(-1)!;
    forms.setItems(ids.asset2, "composer", [{ color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }] }]);
    await startRemove();
    expect(tid("video-remove-draft")).not.toBeNull();
  });

  it("when the Version is the last, the confirmation says the whole film goes to Trash, and the removal is sent with removeVideo true", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true });
    await mount();
    await openViewer();
    await startRemove();
    expect(confirm()!.textContent).toContain("Remove the whole film?");
    expect(confirm()!.textContent).toMatch(/only version/i);
    expect(confirm()!.textContent).toMatch(/Main walkthrough/);
    expect(confirm()!.textContent).toMatch(/Trash/);
    removeOutcome = async () => { versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(10);
    expect(posts()[0]!.body).toMatchObject({ removeVideo: true });
    expect(dialog()).toBeNull();
  });

  it("removing the whole film closes the viewer, leaves focus in the page (not on the body), and Undo restores the film", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true });
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(10);
    expect(dialog()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    const toast = getToasts().find((candidate) => candidate.action?.label === "Undo");
    expect(toast?.message).toContain("Main walkthrough");
    api.apiPost.mockImplementation(async () => { versions = [{ assetId: ids.asset2, version: 2 }]; return { video: videoNow() }; });
    await act(async () => { toast!.action!.onAction(); });
    await flush(8);
    expect(posts().pop()?.path).toBe(`/api/projects/${PROJECT}/videos/${ids.video}/restore`);
  });

  it("a removal answered after the person changed announces nothing and offers no Undo", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true });
    await mount();
    await openViewer();
    await startRemove();
    let answer!: () => void;
    removeOutcome = async () => { await new Promise<void>((resolve) => { answer = resolve; }); versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(4);
    auth.userId = OTHER_USER;
    await rerender();
    await act(async () => { answer(); });
    await flush(10);
    expect(getToasts().filter((candidate) => /Main walkthrough/.test(candidate.message) || candidate.action)).toEqual([]);
  });

  it("an Undo toast shown before the person changed is dismissed when they do", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true });
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = []; return { video: null }; };
    await click(confirmButton());
    await flush(10);
    expect(getToasts().some((candidate) => candidate.action?.label === "Undo")).toBe(true);
    auth.userId = OTHER_USER;
    await rerender();
    await flush(4);
    expect(getToasts().some((candidate) => candidate.action?.label === "Undo")).toBe(false);
  });

  it("a changed impact keeps the dialog open with the new counts and asks again; nothing is re-sent on its own", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { throw new ApiError("changed", 409, { error: "changed", code: "impact_changed", impact: impactOf({ notes: 5 }) }); };
    await click(confirmButton());
    await flush(8);
    expect(posts()).toHaveLength(1);
    expect(confirm()).not.toBeNull();
    expect(confirm()!.textContent).toContain("5 notes");
    expect(confirm()!.textContent).toMatch(/changed since you looked/i);
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; return { video: videoNow() }; };
    await click(confirmButton());
    await flush(8);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.body).toMatchObject({ expected: { notes: 5 } });
    expect(confirm()).toBeNull();
  });

  it("when another Version is gone meanwhile, the answer turns the confirmation into the whole-film one", async () => {
    await mount();
    await openViewer();
    await startRemove();
    expect(confirm()!.textContent).toContain("Remove version 2?");
    removeOutcome = async () => { throw new ApiError("last", 409, { error: "last", code: "last_version", impact: impactOf({ lastVersion: true }) }); };
    await click(confirmButton());
    await flush(8);
    expect(confirm()!.textContent).toContain("Remove the whole film?");
    expect(posts()).toHaveLength(1);
  });

  it.each([
    ["upload_in_progress", 409, /being uploaded/i],
    ["project_archived", 409, /archived/i],
  ])("a %s refusal is shown in the dialog in plain words", async (code, status, words) => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { throw new ApiError("x", status, { error: "x", code }); };
    await click(confirmButton());
    await flush(8);
    const alert = confirm()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(words);
  });

  it("a Version already removed elsewhere is said so, and the viewer shows what is left", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { versions = [{ assetId: ids.asset1, version: 1 }]; throw new ApiError("Version not found", 404, { error: "Version not found" }); };
    await click(confirmButton());
    await flush(10);
    expect(confirm()!.querySelector('[role="alert"]')?.textContent).toMatch(/already removed/i);
    expect(versionLabel()).toContain("v1");
  });

  it("blocks removing the whole film while a new Version is uploading", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true, uploading: true });
    await mount();
    await openViewer();
    await startRemove();
    expect(confirm()!.textContent).toMatch(/being uploaded/i);
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
  });

  it("re-reads the impact when the upload that blocked the removal finishes, so Remove becomes available without reopening", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true, uploading: true });
    uploadingNow = { reservationId: "99999999-9999-4999-8999-999999999999", version: 3, uploader: { id: auth.userId, name: "Ed", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-09T02:00:00.000Z" };
    await mount();
    await openViewer();
    await startRemove();
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    // The upload is cancelled from the card behind the dialog: the server holds no reservation and the Videos are read again.
    vi.stubGlobal("fetch", vi.fn(async () => { uploadingNow = null; impact = impactOf({ lastVersion: true, uploading: false }); return new Response(null, { status: 204 }); }));
    const cancel = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Cancel upload")!;
    await act(async () => { cancel.click(); });
    await flush(10);
    expect(confirm()!.textContent).not.toMatch(/being uploaded/i);
    expect(confirmButton().hasAttribute("disabled")).toBe(false);
  });

  it("an impact read issued before the upload ended is read again when it answers late, so Remove is not left disabled", async () => {
    versions = [{ assetId: ids.asset2, version: 2 }];
    impact = impactOf({ lastVersion: true, uploading: true });
    uploadingNow = { reservationId: "99999999-9999-4999-8999-999999999999", version: 3, uploader: { id: auth.userId, name: "Ed", roleLabel: "Editor", isExternal: false, active: true }, expiresAt: "2026-10-09T02:00:00.000Z" };
    await mount();
    await openViewer();
    const routed = api.apiGet.getMockImplementation()!;
    let answerLate!: () => void;
    let impactReads = 0;
    api.apiGet.mockImplementation(async (path) => {
      if (!path.endsWith("/removal-impact")) return routed(path);
      impactReads += 1;
      if (impactReads === 1) { const captured = impactOf({ lastVersion: true, uploading: true }); await new Promise<void>((resolve) => { answerLate = resolve; }); return captured; }
      return impact;
    });
    await startRemove();
    // The upload is cancelled and the Videos list updates while the first impact read is still out.
    vi.stubGlobal("fetch", vi.fn(async () => { uploadingNow = null; impact = impactOf({ lastVersion: true, uploading: false }); return new Response(null, { status: 204 }); }));
    const cancel = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Cancel upload")!;
    await act(async () => { cancel.click(); });
    await flush(6);
    await act(async () => { answerLate(); });
    await flush(10);
    expect(impactReads).toBeGreaterThanOrEqual(2);
    expect(confirm()!.textContent).not.toMatch(/being uploaded/i);
    expect(confirmButton().hasAttribute("disabled")).toBe(false);
  });

  it("a failure to read the impact says so and offers a retry, and sends nothing", async () => {
    await mount();
    await openViewer();
    api.apiGet.mockImplementation(async (path) => { if (path.endsWith("/removal-impact")) throw new ApiError("Failed to fetch", 0); if (path.endsWith("/videos")) return { videos: [videoNow()] }; return { notes: [], versions: [] }; });
    await startRemove();
    expect(confirm()!.querySelector('[role="alert"]')?.textContent).toMatch(/couldn't reach the server/i);
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    expect(posts()).toEqual([]);
  });

  it("a Version removed elsewhere is found out when its impact is read: the list refreshes, and the viewer shows what is left", async () => {
    await mount();
    await openViewer();
    versions = [{ assetId: ids.asset1, version: 1 }];
    api.apiGet.mockImplementation(async (path) => {
      if (path.endsWith("/removal-impact")) throw new ApiError("Version not found", 404, { error: "Version not found" });
      if (path.endsWith("/videos")) return { videos: [videoNow()] };
      if (path.endsWith("/video-trash")) return { retentionDays: 30, items: [] };
      return { notes: [], versions: [] };
    });
    await startRemove();
    await flush(8);
    expect(confirm()!.querySelector('[role="alert"]')?.textContent).toMatch(/already removed/i);
    expect(versionLabel()).toContain("v1");
  });

  it("a refused removal brings focus back into the confirmation, onto the problem", async () => {
    await mount();
    await openViewer();
    await startRemove();
    removeOutcome = async () => { throw new ApiError("uploading", 409, { error: "uploading", code: "upload_in_progress" }); };
    await click(confirmButton());
    await flush(8);
    const problem = tid("video-remove-problem");
    expect(problem, "the problem notice").not.toBeNull();
    expect(document.activeElement).toBe(problem);
  });
});
