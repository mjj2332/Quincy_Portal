import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
// The rich field is a textarea here: this file is about the page's box around the keyboard (#879 PR 2), not the editor.
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  return {
    GuestNoteEditor: (props: { testId: string; id?: string; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void; inlineStart?: import("react").ReactNode; inlineEnd?: import("react").ReactNode }) => <div>
      {props.inlineStart}
      <textarea data-testid={props.testId} id={props.id} value={shared.videoNoteBody(props.value)} onChange={(event) => { props.onChange(shared.legacyBodyToRichTextDoc(event.target.value)); }} />
      {props.inlineEnd}
    </div>,
  };
});

/**
 * The guest page on a phone follows the visual viewport (#879 PR 2, the staff viewer's r5 / r8 mechanism): the guest column (the notices and the video screen) is the root the
 * keyboard box is written on, for as long as the phone video screen is mounted, and the document's canvas is ink meanwhile.
 */
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const SESSION: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam", notifications: null, media: { heic: false } };
const versionOf = (n: number) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `${BASE}/versions/${asset(n)}/poster`, streamUrl: `${BASE}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null,
});
const videoOf = (n: number): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions: [versionOf(n * 10)] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
let fake: FakeViewport;
let original: PropertyDescriptor | undefined;
let videos: GuestVideoDto[];
let session: GuestSessionResponse;
let served: GuestNoteThreadDto[] = [];
let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const area = () => byId("guest-composer-body") as HTMLTextAreaElement | null;
const mode = () => byId("video-review-pane")!.getAttribute("data-mode");
async function open() {
  window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestApp token="tok123" />); });
  await flush();
}
async function openVideo() {
  await open();
  await vi.waitFor(() => { expect(area()).not.toBeNull(); });
}

beforeEach(async () => {
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 390, coarse: true });
  videos = [videoOf(1)];
  session = SESSION;
  served = [];
  fake = new FakeViewport();
  original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${BASE}/session`) return json(session);
    if (url === `${BASE}/videos`) return json({ videos });
    if (/\/notes$/.test(url)) return json({ notes: served });
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("the guest phone page and the keyboard (#879 PR 2)", () => {
  it("the guest column follows the visual viewport from the moment the screen mounts, with no transition, and keeps following through compose", async () => {
    fake.height = window.innerHeight - 340; fake.offsetTop = 24;
    await openVideo();
    const column = byId("guest-column")!;
    expect(column.contains(byId("guest-video-screen"))).toBe(true);
    expect(mode()).toBe("browse");
    expect(column.style.height).toBe(`${window.innerHeight - 340}px`);
    expect(column.style.transition).toBe("none");
    expect(byId("guest-video-screen")!.getAttribute("style")).toBeNull();
    fake.offsetTop = 30; fake.dispatchEvent(new Event("scroll"));
    expect(column.style.transform).toBe("translateY(30px)");
    await act(async () => { area()!.focus(); });
    await flush(2);
    expect(mode()).toBe("compose");
    expect(column.style.height).toBe(`${window.innerHeight - 340}px`);
    // No floor beats the shrunken height: Cancel must not end up behind the keyboard.
    expect(column.className).not.toContain("min-h-dvh");
    expect(byId("guest-video-screen")!.className).not.toContain("min-h-dvh");
  });

  it("the keyboard going away without a blur ends compose mode, unless the open tray holds it", async () => {
    await openVideo();
    await act(async () => { area()!.focus(); });
    await act(async () => { fake.height = window.innerHeight - 320; fake.dispatchEvent(new Event("resize")); });
    expect(mode()).toBe("compose");
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(4);
    expect(document.activeElement).not.toBe(area());
    expect(mode()).toBe("browse");
    await act(async () => { area()!.focus(); });
    await act(async () => { byId("guest-composer-extras")!.click(); });
    await act(async () => { fake.height = window.innerHeight - 320; fake.dispatchEvent(new Event("resize")); });
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(4);
    expect(mode()).toBe("compose");
  });

  it("paints the document canvas ink while the phone video screen is up, and clears both the canvas and the box when it crosses to a desktop", async () => {
    fake.height = window.innerHeight - 340;
    await openVideo();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    const column = byId("guest-column")!;
    expect(column.style.height).not.toBe("");
    await act(async () => { await viewport.set({ width: 1440 }); });
    await flush();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
    expect(byId("guest-column")!.style.height).toBe("");
    expect(byId("guest-column")!.style.transform).toBe("");
  });

  it("leaving the screen (unmount) clears the canvas", async () => {
    await openVideo();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    await act(async () => { root!.unmount(); }); root = null;
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
  });
});

describe("the guest phone chrome (#879 PR 3a, P2)", () => {
  const withAllow = (allow: Partial<GuestSessionResponse["link"]["allow"]>) => { session = { ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, ...allow } } }; };

  it("Approve is P2's outline button, drawn 32px with a 44px hit area", async () => {
    withAllow({ approve: true });
    await openVideo();
    const approve = byId("guest-approve")!;
    expect(byId("review-phone-bar")!.contains(approve)).toBe(true);
    expect(approve.className).toContain("border-border");
    expect(approve.className).not.toContain("bg-primary");
    expect(approve.className).toContain("min-h-8");
    expect(approve.className).toContain("after:-inset-y-1.5");
    expect(approve.className).not.toContain("min-h-11");
  });

  it("the sheet head has no vertical padding, its tab sits left at its own width, and the open count is a secondary Badge", async () => {
    await openVideo();
    const tab = byId("guest-notes-heading")!;
    const head = tab.closest<HTMLElement>('[data-sheet-part="head"]')!;
    expect(head.className).not.toContain("py-[var(--space-2)]");
    expect(head.className).toContain("px-[var(--space-3)]");
    expect(tab.className).toContain("max-[721px]:flex-none");
    const count = byId("guest-notes-count")!;
    expect(tab.contains(count)).toBe(true);
    expect(count.getAttribute("data-slot")).toBe("badge");
    expect(count.textContent).toBe("0");
  });

  it("the composer band is tight in browse mode: no wrapper padding above or below, the composer owns one border and --space-2 around the pill", async () => {
    await openVideo();
    const composer = byId("guest-notes-panel")!.querySelector<HTMLElement>('[data-sheet-part="composer"]')!;
    expect(composer.className).toContain("in-data-[mode=browse]:py-[var(--space-2)]");
    expect(byId("guest-notes-panel")!.className).toContain("in-data-[mode=browse]:gap-0");
    expect(byId("guest-notes-panel")!.parentElement!.className).toContain("in-data-[mode=browse]:py-0");
    // The strip's empty rows add no gap around the pill at rest (#879 PR 3a round 2: 85pt band on the Simulator, P1/P2's is 61).
    const strip = byId("guest-compose-strip")!;
    expect(strip.dataset.compose).toBe("false");
    expect(strip.className).toContain("data-[compose=false]:gap-y-0");
  });

  it("the transport drops frame step where the composer carries it, and keeps it for a guest who cannot write (C14)", async () => {
    await openVideo();
    expect(document.body.querySelector('[aria-label="Previous frame"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; host.remove();
    withAllow({ comments: false });
    await open();
    await vi.waitFor(() => { expect(byId("video-player")).not.toBeNull(); });
    expect(document.body.querySelector('[aria-label="Previous frame"]')).not.toBeNull();
  });
});

describe("the guest phone notes head (#879 PR 3b, P2)", () => {
  let seq = 500;
  const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const thread = (over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
    id: nid(), parentId: null, author: { kind: "guest", name: "Sam", self: true }, startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
    body: "A note", deleted: false, revision: 1, resolved: false, createdAt: "2026-10-10T00:00:00.000Z", editedAt: null, replies: [], ...over,
  });
  const listed = () => [...document.querySelectorAll<HTMLElement>('[data-testid="guest-note"]')].map((item) => item.dataset.noteId);
  const radio = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.startsWith(name))!;
  const press = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); element.click(); }); await flush(2); };
  const search = async (text: string) => {
    if (!byId("notes-search-field")) await press(byId("notes-filter-search")!);
    const field = byId("notes-search-field") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await flush(2);
  };
  let mine: GuestNoteThreadDto; let studio: GuestNoteThreadDto; let done: GuestNoteThreadDto;
  beforeEach(() => {
    mine = thread({ body: "Logo too small" });
    studio = thread({ author: { kind: "studio", name: "Quincy" }, body: "Graded the sky", startFrame: 40 });
    done = thread({ body: "Fixed already", resolved: true, startFrame: 80 });
    served = [mine, studio, done];
  });

  it("opens on the open notes, with the head at the top of the list in place of the delivery row's chips", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    expect(byId("guest-notes-list")!.contains(byId("notes-filter-head"))).toBe(true);
    expect(byId("notes-filter-status")!.textContent).toBe("Open · 2");
    expect(listed()).toEqual([mine.id, studio.id]);
    await press(byId("notes-filter-status")!);
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual(["Open2", "Resolved1", "All3"]);
    await press(radio("All"));
    expect(listed()).toEqual([mine.id, studio.id, done.id]);
  });

  it("filters by author and by search, and markers follow", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    await press(byId("notes-filter-author")!);
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual(["Everyone", "Quincy", "Sam"]);
    await press(radio("Quincy"));
    expect(listed()).toEqual([studio.id]);
    expect([...document.querySelectorAll<HTMLElement>("[data-marker-id]")].map((marker) => marker.dataset.markerId)).toEqual([studio.id]);
    await press(byId("notes-filter-author")!);
    await press(radio("Everyone"));
    await search("logo");
    expect(listed()).toEqual([mine.id]);
  });

  it("search takes the sheet to full and back; Escape closes it and focus returns to Search", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    expect(byId("video-review-pane")!.getAttribute("data-stop")).toBe("half");
    await search("sky");
    expect(byId("video-review-pane")!.getAttribute("data-stop")).toBe("full");
    expect(mode()).toBe("browse");
    await act(async () => { byId("notes-search-field")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(2);
    expect(byId("notes-search-field")).toBeNull();
    expect(document.activeElement).toBe(byId("notes-filter-search"));
    expect(byId("video-review-pane")!.getAttribute("data-stop")).toBe("half");
  });

  it("nothing matching says so and Reset filters brings the open notes back", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    await search("nothing like it");
    expect(byId("guest-notes-filtered-empty")!.textContent).toContain("No notes match.");
    await press(byId("guest-notes-reset-filters")!);
    expect(listed()).toEqual([mine.id, studio.id]);
  });

  it("an open reply keeps its thread listed under a search that leaves it out", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    const item = document.querySelector<HTMLElement>(`[data-note-id="${mine.id}"]`)!;
    await press(item.querySelector<HTMLElement>('[data-testid="guest-note-reply-button"]')!);
    await search("sky");
    expect(listed()).toEqual([mine.id, studio.id]);
  });

  it("crossing to a desktop shows every note, unfiltered, with no head", async () => {
    await openVideo();
    await vi.waitFor(() => { expect(byId("notes-filter-head")).not.toBeNull(); });
    await search("sky");
    await viewport.set({ width: 1280 });
    await flush(4);
    expect(byId("notes-filter-head")).toBeNull();
    expect(listed()).toEqual([mine.id, studio.id, done.id]);
    await viewport.set({ width: 390 });
    await flush(4);
    expect(byId("notes-search-field")).toBeNull();
    expect(listed()).toEqual([mine.id, studio.id]);
  });
});

describe("the guest phone ⋯ and delivery (#879 PR 3b, P10 / P2)", () => {
  const MANIFEST = { included: [{ videoId: vid(1), title: "Film 1", version: 11, bytes: 1024 }], leftOut: [], totalBytes: 1024, tooLarge: false, archive: { state: "ready", pending: 0 } };
  const decided = (value: "approved" | "changes_requested") => ({ value, revision: 1, at: "2026-10-09T01:00:00.000Z", self: true });
  const released = { ...versionOf(11), released: true, downloadUrl: `${BASE}/versions/${asset(11)}/download` };
  const press = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(4); };
  const rows = () => [...byId("review-action-rows")!.children].map((row) => ((row as HTMLElement).dataset.testid === "review-action-separator" ? "—" : row.textContent));
  const menu = () => byId("video-header-menu")!;
  async function openFilm(decision: ReturnType<typeof decided> | null = null) {
    session = { ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, approve: true, download: true } } };
    videos = [{ ...videoOf(1), versions: [{ ...released, decision }, versionOf(10)] }, videoOf(2)];
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === `${BASE}/downloads` ? json(MANIFEST) : base(input, init))) as unknown as typeof fetch;
    await open();
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="guest-video-row"] button')).not.toBeNull(); });
    await press(document.querySelector<HTMLElement>('[data-testid="guest-video-row"] button')!);
    await vi.waitFor(() => { expect(area()).not.toBeNull(); });
  }

  it("lists P10's rows in order, with the decisions under a rule, and no delivery row above the notes", async () => {
    await openFilm();
    expect(byId("guest-delivery")).toBeNull();
    await press(menu());
    expect(rows()).toEqual(["Download v11", "Download all…", "Copy my notes…", "—", "Approve", "Request changes…"]);
  });

  it("a recorded decision takes the Approve slot as its badge; after Changes requested the ⋯ still offers Approve", async () => {
    await openFilm(decided("changes_requested"));
    const bar = byId("review-phone-bar")!;
    expect(bar.querySelector('[data-testid="guest-approve"]')).toBeNull();
    expect(bar.querySelector('[data-testid="guest-decision-chip"]')!.textContent).toBe("Changes requested");
    await press(menu());
    expect(rows()).toEqual(["Download v11", "Download all…", "Copy my notes…", "—", "Approve", "Request changes…"]);
    await press(byId("guest-approve-row")!);
    expect(byId("review-action-sheet")).toBeNull();
    expect(byId("guest-decision-dialog")).not.toBeNull();
  });

  it("an approval reads Approved in the slot, and the ⋯ keeps only Request changes…", async () => {
    await openFilm(decided("approved"));
    const chip = byId("review-phone-bar")!.querySelector<HTMLElement>('[data-testid="guest-decision-chip"]')!;
    expect(chip.textContent).toBe("Approved");
    expect(chip.querySelector("svg")).not.toBeNull();
    await press(menu());
    expect(rows()).toEqual(["Download v11", "Download all…", "Copy my notes…", "—", "Request changes…"]);
  });

  it("Request changes… closes the sheet for the decision dialog, and closing it returns focus to the ⋯", async () => {
    await openFilm();
    await press(menu());
    await press(byId("guest-request-changes")!);
    expect(byId("review-action-sheet")).toBeNull();
    expect(byId("guest-decision-dialog")).not.toBeNull();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush(6);
    expect(byId("guest-decision-dialog")).toBeNull();
    expect(document.activeElement).toBe(menu());
  });

  it("Download all… opens its dialog outside the closed sheet, and Close returns focus to the ⋯", async () => {
    await openFilm();
    await press(menu());
    await press(byId("guest-download-all")!);
    expect(byId("review-action-sheet")).toBeNull();
    await vi.waitFor(() => { expect(byId("guest-download-all-start")).not.toBeNull(); });
    await press(byId("guest-download-all-close")!);
    await flush(6);
    expect(byId("guest-download-all-dialog")).toBeNull();
    expect(document.activeElement).toBe(menu());
  });

  it("Released opens the quiet line at the end of the notes scroll, above who is reviewing", async () => {
    await openFilm();
    const list = byId("guest-notes-list")!;
    const releasedChip = byId("guest-released-chip")!;
    expect(list.contains(releasedChip)).toBe(true);
    expect(releasedChip.closest("[data-testid=\"guest-quiet-line\"]")).not.toBeNull();
    expect(byId("review-phone-bar")!.contains(releasedChip)).toBe(false);
    expect(releasedChip.compareDocumentPosition(byId("guest-identity")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
