import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectVideoSelection, VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { REVIEW_PANE_KEY } from "../../lib/review-pane-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

/** #936: previous / next in the staff review viewer, driven through the Video collection panel the way a person meets it (prior art: the grid-toolbar and viewer-identity suites). */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Three films, newest upload first by default: Alpha, Bravo, Charlie. Bravo is Published, the others In review. */
const film = (n: number, title: string, at: string, status: VideoDto["reviewStatus"] = "in_review"): VideoDto => fixtureVideo({
  id: uid(100 + n), title, reviewStatus: status,
  versions: [fixtureVersion({ assetId: uid(200 + n), version: 2, createdAt: at }), fixtureVersion({ assetId: uid(300 + n), version: 1, createdAt: "2026-01-01T00:00:00.000Z" })],
});
const ALPHA = film(1, "Alpha", "2026-10-05T00:00:00.000Z");
const BRAVO = film(2, "Bravo", "2026-10-04T00:00:00.000Z", "published");
const CHARLIE = film(3, "Charlie", "2026-10-03T00:00:00.000Z");
const NOTE = uid(901);
const noteOn = (assetId: string) => ({
  id: NOTE, assetId, parentId: null, author: { kind: "staff", person: { id: uid(990), name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true } }, authorRole: "editor", visibility: "public", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "Note at 10", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, copiedFrom: null, replies: [],
});

let stub: VideoElementStub; let viewport: MockViewport; let storage: ReturnType<typeof installLocalStorageShim>;
let root: Root | null = null; let client: QueryClient;
let films: VideoDto[];
/** The URL as the staff route holds it (#819): `writes` records every replace the panel asks for. */
const link = { selection: null as ProjectVideoSelection | null, writes: [] as Array<ProjectVideoSelection | null> };
function Probe() { client = useQueryClient(); return null; }
function LinkedPanel({ parts, initial }: { parts: string[]; initial: ProjectVideoSelection | null }) {
  const [selection, setSelection] = useState(initial);
  link.selection = selection;
  return <VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: parts as never }} deepLink={{ selection, onChange: (next, from) => { if ((selection?.id ?? null) !== from) return; link.writes.push(next); setSelection(next); } }} />;
}
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(options: { parts?: string[]; linked?: ProjectVideoSelection | null } = {}) {
  const parts = options.parts ?? [];
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: films };
    if (/\/video-versions\/[^/]+\/notes$/.test(path)) return { notes: path.includes(ALPHA.currentAssetId) ? [noteOn(ALPHA.currentAssetId)] : [] };
    if (path.endsWith("/decisions")) return { versions: [] };
    if (path.includes("social-overlays")) return { resolved: [] };
    throw new Error(`unrouted ${path}`);
  });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const panel = options.linked !== undefined ? <LinkedPanel parts={parts} initial={options.linked} /> : <VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: parts as never }} />;
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><Probe />{panel}</QuincyQueryProvider>); });
  await flush();
}
const viewer = () => document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]');
const backdrop = () => document.querySelector<HTMLElement>('[data-testid="video-review-backdrop"]');
/** The dialog's accessible name: its labelling title. */
const title = () => { const labelledBy = viewer()?.getAttribute("aria-labelledby"); return labelledBy ? document.getElementById(labelledBy)?.textContent ?? null : null; };
const inViewer = (testId: string) => viewer()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
const next = () => inViewer("video-step-next") as HTMLButtonElement | null;
const previous = () => inViewer("video-step-previous") as HTMLButtonElement | null;
const position = () => inViewer("video-step-position")?.textContent ?? null;
const tileOpen = (video: VideoDto) => document.querySelector<HTMLElement>(`[data-testid="video-card-open"][data-video-id="${video.id}"]`)!;
const composer = () => inViewer("video-note-composer")?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await flush(1); }
  await flush(4);
}
async function open(video: VideoDto) {
  // Focused first, as a real press does: Base UI's default return target is the element focused before the dialog opened.
  await act(async () => { tileOpen(video).focus(); tileOpen(video).click(); });
  await until(() => title() === video.title && viewer()!.querySelector("video") !== null, `${video.title} in the viewer`);
}
async function step(button: HTMLElement | null) {
  if (!button) throw new Error("no step button");
  const was = title();
  await act(async () => { button.click(); });
  await until(() => title() !== was && viewer()!.querySelector("video") !== null, "the stepped-to film");
}
async function key(k: string, target: EventTarget = document.activeElement ?? document.body, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
  await flush(6);
}
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const paneShown = () => { const pane = document.querySelector<HTMLElement>('[data-testid="video-review-pane"]'); return pane !== null && !pane.hidden; };

beforeEach(() => {
  storage = installLocalStorageShim(); resetUiPrefMemory();
  stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 });
  apiGetMock.mockReset(); films = [ALPHA, BRAVO, CHARLIE]; link.selection = null; link.writes = [];
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); }); root = null;
  resetVideoUploadStore(); resetUiPrefMemory(); stub.dispose(); viewport.restore(); storage.restore(); document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("the step control in the viewer header", () => {
  it("steps in the grid's order with n of N, its ends disabled", async () => {
    await mount();
    await open(ALPHA);
    expect(position()).toBe("1 of 3");
    expect(previous()!.disabled).toBe(true);
    expect(next()!.disabled).toBe(false);
    await step(next());
    expect(title()).toBe("Bravo");
    expect(position()).toBe("2 of 3");
    await step(next());
    expect(title()).toBe("Charlie");
    expect(position()).toBe("3 of 3");
    expect(next()!.disabled).toBe(true);
    await step(previous());
    expect(title()).toBe("Bravo");
  });

  it("follows a sort and a Review status filter", async () => {
    storage.values.set(`quincy:ui:video-grid:${auth.userId}`, JSON.stringify({ sort: "name", dir: "desc", status: "in_review" }));
    await mount();
    await open(CHARLIE);
    expect(position()).toBe("1 of 2");
    await step(next());
    expect(title()).toBe("Alpha");
    expect(position()).toBe("2 of 2");
  });

  it("is not there when only one film is shown", async () => {
    films = [ALPHA];
    await mount();
    await open(ALPHA);
    expect(inViewer("video-step-control")).toBeNull();
  });

  it("opens the stepped-to film on its newest Version, in a new player", async () => {
    await mount();
    await open(ALPHA);
    const before = viewer()!.querySelector("video");
    await step(next());
    expect(inViewer("video-version-label")?.textContent).toMatch(/^v2/);
    const after = viewer()!.querySelector("video");
    expect(after).not.toBe(before);
    expect(after!.getAttribute("src") ?? after!.src).toContain(BRAVO.currentAssetId);
  });

  it("shows a film the filter hides with no position, both buttons disabled, and ] does nothing (#933 S1)", async () => {
    storage.values.set(`quincy:ui:video-grid:${auth.userId}`, JSON.stringify({ sort: "uploaded", dir: "desc", status: "in_review" }));
    await mount({ linked: { id: BRAVO.id, version: 2 } });
    await until(() => title() === "Bravo", "Bravo from the link");
    expect(inViewer("video-step-control")).not.toBeNull();
    expect(position()).toBeNull();
    expect(previous()!.disabled).toBe(true);
    expect(next()!.disabled).toBe(true);
    await key("]");
    expect(title()).toBe("Bravo");
  });

  it("counts one fewer when another film goes to the Trash while the viewer is open", async () => {
    await mount();
    await open(ALPHA);
    expect(position()).toBe("1 of 3");
    films = [ALPHA, BRAVO];
    await act(async () => { await client.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT) }); });
    await flush(6);
    expect(position()).toBe("1 of 2");
  });
});

describe("[ and ]", () => {
  it("step from the viewer", async () => {
    await mount();
    await open(ALPHA);
    await key("]");
    expect(title()).toBe("Bravo");
    await key("[");
    expect(title()).toBe("Alpha");
  });

  it("do nothing with a modifier held, or while the Version list is open", async () => {
    await mount();
    await open(ALPHA);
    await key("]", document.activeElement!, { ctrlKey: true });
    expect(title()).toBe("Alpha");
    const trigger = inViewer("video-version-trigger")!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
    await flush(6);
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox).not.toBeNull();
    await key("]", listbox!);
    expect(title()).toBe("Alpha");
  });

  it("do nothing while typing a note", async () => {
    await mount({ parts: ["notes"] });
    await open(ALPHA);
    await until(() => composer() !== null, "the composer");
    await key("]", composer()!);
    expect(title()).toBe("Alpha");
  });
});

describe("what a step resets and what it keeps", () => {
  it("turns Social preview off", async () => {
    await mount();
    await open(ALPHA);
    await act(async () => { inViewer("video-social-toggle")!.click(); });
    await flush(4);
    expect(inViewer("video-social-toggle")!.getAttribute("aria-pressed")).toBe("true");
    await step(next());
    expect(inViewer("video-social-toggle")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("leaves Compare for the next film's single view", async () => {
    await mount({ parts: ["compare"] });
    await open(ALPHA);
    await act(async () => { inViewer("video-compare-toggle")!.click(); });
    await flush(6);
    expect(inViewer("video-compare-toggle")!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { next()!.click(); });
    await until(() => title() === "Bravo", "Bravo");
    expect(inViewer("video-compare-toggle")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a typed note draft on the film it was typed on, there again on return", async () => {
    await mount({ parts: ["notes"] });
    await open(ALPHA);
    await until(() => composer() !== null, "the composer");
    await type(composer()!, "Lift the shadows");
    await step(next());
    await until(() => composer() !== null, "Bravo's composer");
    expect(composer()!.value).toBe("");
    await step(previous());
    await until(() => composer() !== null, "Alpha's composer");
    expect(composer()!.value).toBe("Lift the shadows");
  });

  it("keeps the notes pane shown when a note link had revealed it over a hidden choice (#933 S5)", async () => {
    storage.values.set(REVIEW_PANE_KEY, JSON.stringify({ open: false, width: 360 }));
    await mount({ parts: ["notes"], linked: { id: ALPHA.id, version: 2, note: NOTE } });
    await until(() => title() === "Alpha" && paneShown(), "Alpha with its notes revealed");
    await step(next());
    expect(title()).toBe("Bravo");
    expect(paneShown()).toBe(true);
  });
});

describe("focus and entry", () => {
  it("a step by button lands on the same button in the next film's viewer, and nothing hands focus to the old tile", async () => {
    await mount();
    await open(ALPHA);
    const focusSpy = vi.spyOn(tileOpen(ALPHA), "focus");
    await step(next());
    await flush(6);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(next());
  });

  it("a step by button at the end lands on the button that still steps", async () => {
    await mount();
    await open(BRAVO);
    await step(next());
    expect(title()).toBe("Charlie");
    expect(next()!.disabled).toBe(true);
    expect(document.activeElement).toBe(previous());
  });

  it("a step by key leaves focus on the viewer itself", async () => {
    await mount();
    await open(ALPHA);
    await key("]");
    expect(title()).toBe("Bravo");
    expect(document.activeElement).toBe(viewer());
  });

  it("closing after steps returns focus to the current film's tile", async () => {
    await mount();
    await open(ALPHA);
    await step(next());
    const close = [...viewer()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
    await act(async () => { close.click(); });
    await until(() => viewer() === null, "the viewer to close");
    expect(document.activeElement).toBe(tileOpen(BRAVO));
  });

  it("marks the stepped-to viewer and its backdrop as a step entry (no open animation); an ordinary open is not one", async () => {
    await mount();
    await open(ALPHA);
    expect(viewer()!.dataset.entry).toBeUndefined();
    expect(backdrop()!.dataset.entry).toBeUndefined();
    await step(next());
    expect(viewer()!.dataset.entry).toBe("step");
    expect(backdrop()!.dataset.entry).toBe("step");
  });
});

describe("with the deep link", () => {
  it("replaces the selection with the stepped-to film on its newest Version, the note dropped", async () => {
    await mount({ parts: ["notes"], linked: { id: ALPHA.id, version: 1, note: NOTE } });
    await until(() => title() === "Alpha", "Alpha from the link");
    await step(next());
    expect(link.selection).toEqual({ id: BRAVO.id, version: 2 });
  });
});

describe("on a phone", () => {
  it("puts the buttons in the review bar and the position under the title", async () => {
    await viewport.set({ width: 390 });
    await mount();
    await open(ALPHA);
    const bar = inViewer("review-phone-bar")!;
    expect(bar.querySelector('[data-testid="video-step-next"]')).not.toBeNull();
    expect(bar.querySelector('[data-testid="video-step-position"]')).toBeNull();
    expect(bar.querySelector('[data-testid="review-phone-bar-position"]')?.textContent).toBe("1 of 3");
    await step(bar.querySelector<HTMLElement>('[data-testid="video-step-next"]'));
    expect(title()).toBe("Bravo");
    expect(inViewer("review-phone-bar-position")?.textContent).toBe("2 of 3");
  });
});

describe("in the list layout (#939)", () => {
  const rowOpen = (video: VideoDto) => document.querySelector<HTMLElement>(`[data-testid="video-row-open"][data-video-id="${video.id}"]`)!;
  const header = (label: string) => [...document.querySelectorAll("th")].find((th) => th.textContent?.trim() === label)!.querySelector<HTMLElement>("button")!;
  async function openRow(video: VideoDto) {
    await act(async () => { rowOpen(video).focus(); rowOpen(video).click(); });
    await until(() => title() === video.title && viewer()!.querySelector("video") !== null, `${video.title} in the viewer`);
  }
  beforeEach(() => { storage.values.set(`quincy:ui:video-grid:${auth.userId}`, JSON.stringify({ layout: "rows" })); });

  it("steps in the order a column header chose", async () => {
    await mount();
    await act(async () => { header("Status").click(); });
    await flush();
    // Status, in review first (newest upload first among them), then Published: Alpha, Charlie, Bravo, not the upload order Alpha, Bravo, Charlie.
    await openRow(ALPHA);
    expect(position()).toBe("1 of 3");
    await step(next());
    expect(title()).toBe("Charlie");
    await step(next());
    expect(title()).toBe("Bravo");
    expect(position()).toBe("3 of 3");
    expect(next()!.disabled).toBe(true);
  });

  it("steps from a viewer opened from a Video row, and closing returns focus to the current film's row", async () => {
    await mount();
    await openRow(CHARLIE);
    expect(position()).toBe("3 of 3");
    await step(previous());
    expect(title()).toBe("Bravo");
    const close = [...viewer()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
    await act(async () => { close.click(); });
    await until(() => viewer() === null, "the viewer to close");
    expect(document.activeElement).toBe(rowOpen(BRAVO));
  });
});
