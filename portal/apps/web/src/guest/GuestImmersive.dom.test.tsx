import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestSocialOverlay, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { installLocalStorageShim } from "../testing/local-storage";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../lib/time-format-prefs";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
/** The rich field is a textarea handle on its props: this file is about what the page does with the document and the upload state (the field itself is tested in GuestNoteEditor.dom.test.tsx). Typing sends a one-paragraph document, which is what the real field sends for plain text. */
const field = vi.hoisted(() => ({ unmounts: 0, props: new Map<string, { media: unknown; onUploadingChange?: (uploading: boolean) => void; onChange: (doc: unknown) => void; value: unknown; label: string }>() }));
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  return {
    GuestNoteEditor: (props: { testId: string; label: string; placeholder?: string; disabled?: boolean; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void; media: unknown; onUploadingChange?: (uploading: boolean) => void }) => {
      field.props.set(props.testId, props as never);
      // eslint-disable-next-line react-hooks/rules-of-hooks -- a component body
      useEffect(() => () => { field.unmounts += 1; }, []);
      return <textarea data-testid={props.testId} aria-label={props.label} placeholder={props.placeholder} disabled={props.disabled} value={shared.videoNoteBody(props.value)}
        onChange={(event) => { props.onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : shared.legacyBodyToRichTextDoc(event.target.value)); }} />;
    },
  };
});
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

/** The one-paragraph document a typed note is sent as (#835): the note travels as `content`, never as `body`. */
const para = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const noteId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const SESSION_OFF: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false, markup: true } }, verified: false, email: null, name: null, notifications: null, media: { heic: false } };
const ANON: GuestSessionResponse = { ...SESSION_OFF, link: { ...SESSION_OFF.link, allow: { ...SESSION_OFF.link.allow, comments: true } } };
const VERIFIED: GuestSessionResponse = { ...ANON, verified: true, email: "sam@example.com", name: "Sam" };

const versionOf = (n: number) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `${BASE}/versions/${asset(n)}/poster`, streamUrl: `${BASE}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null,
});
const videoOf = (n: number, versions = [versionOf(n * 10)]): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions });
const note = (n: number, over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id: noteId(n), parentId: null, author: { kind: "studio", name: "Mia Chen" }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false, body: "Trim the opening", deleted: false,
  resolved: false, revision: 1, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});
const mine = (n: number, over: Partial<GuestNoteThreadDto> = {}) => note(n, { author: { kind: "guest", name: "Sam", self: true }, body: "My note", ...over });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const stub404 = () => new Response("Not found", { status: 404 });

let session: GuestSessionResponse;
let videos: GuestVideoDto[];
let socialOverlays: GuestSocialOverlay[];
/** Replaces the Social overlays answer (a failure, a bad body). */
let overlayAnswer: (() => Response | Promise<Response>) | null;
let notes: Record<string, GuestNoteThreadDto[]>;
let extra: Handler | null;
let fetchMock: ReturnType<typeof vi.fn>;
let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;

async function route(url: string, init: RequestInit | undefined): Promise<Response> {
  const custom = await extra?.(url, init);
  if (custom) return custom;
  if (url === `${BASE}/session`) return json(session);
  if (url === `${BASE}/videos`) return json({ videos });
  if (url === `${BASE}/social-overlays`) return overlayAnswer ? overlayAnswer() : json({ socialOverlays });
  const list = /\/versions\/([^/]+)\/notes$/.exec(url);
  if (list && (init?.method ?? "GET") === "GET") return json({ notes: notes[list[1]!] ?? [] });
  return stub404();
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const REEL: GuestSocialOverlay = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Instagram Reel", imageUrl: "/social-overlay-images/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const TIKTOK: GuestSocialOverlay = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "TikTok", imageUrl: "/social-overlay-images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/ffffffff-ffff-4fff-8fff-ffffffffffff" };
async function open(initialVideoId: string | null = null) {
  field.props.clear(); field.unmounts = 0;
  window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestApp token="tok123" initialVideoId={initialVideoId} />); });
  await flush();
}
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const typeInto = async (element: HTMLElement | null, value: string) => {
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
};
const submit = async (id: string) => { await act(async () => { byId(id)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };
const button = (label: string) => [...document.body.querySelectorAll<HTMLElement>("button")].find((item) => item.getAttribute("aria-label")?.startsWith(label) || item.textContent?.trim() === label);
const keyDown = async (key: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await flush(); };
const menuItem = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
/** Puts the film on `seconds` (25 fps), as the browser would after a seek: its data is there (the clock holds a seek until it is), the seek lands, the frame shows. */
async function atSeconds(seconds: number) {
  const video = host.querySelector("video")!;
  await act(async () => { stub.loadData(video, 4); stub.finishSeek(video); stub.presentFrame(video, seconds); });
  await flush();
}
/** The writes the page made (the token exchange at boot is not one). */
const requests = (method: string) => fetchMock.mock.calls.filter((call) => ((call[1] as RequestInit | undefined)?.method ?? "GET") === method && String(call[0]) !== `${BASE}/session`).map((call) => ({ url: String(call[0]), body: (call[1] as RequestInit).body === undefined ? null : JSON.parse(String((call[1] as RequestInit).body)) as unknown }));

beforeEach(() => {
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 1440, height: 900 });
  session = VERIFIED; videos = [videoOf(1)]; socialOverlays = [REEL, TIKTOK]; overlayAnswer = null; notes = {}; extra = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled; delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
});



const film = () => host.querySelector("video")!;
const screenRoot = () => byId("guest-video-screen")!;
const tapMarker = async () => {
  const lane = byId("video-marker-lane")!;
  lane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 12, right: 1000, bottom: 12, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 6 + (988 * 50) / 2999 })); });
  await flush(3);
};
async function escape() { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await flush(3); }
const escapeOutOfTooltip = async () => { if ([...document.querySelectorAll("[data-open]")].some((popup) => popup.tagName === "DIV" && /^(Add note|Full screen|Exit full screen)$/.test(popup.textContent ?? ""))) await escape(); };
const immersiveOn = () => byId("video-player")!.hasAttribute("data-immersive");

describe.each([["a phone at 390", { width: 390, height: 844, coarse: true }], ["a desktop at 1200", { width: 1200, height: 900, coarse: false }]] as const)("the guest page's Full screen on %s (#880)", (_name, size) => {
  beforeEach(() => { viewport.restore(); viewport = mockViewport(size); notes = { [asset(10)]: [note(1)] }; });

  it("Full screen is a fixed layer in place: the header inert, the markers lane there, focus on Exit full screen, the watermark and nodes unchanged", async () => {
    await open();
    const player = film();
    expect(byId("guest-header-hide")!.hasAttribute("inert")).toBe(false);
    byId("video-fullscreen")!.focus();
    await click(byId("video-fullscreen"));
    expect(immersiveOn()).toBe(true);
    expect(screenRoot().className).toContain("fixed");
    expect(byId("guest-header-hide")!.hasAttribute("inert")).toBe(true);
    expect(byId("video-marker-lane")).not.toBeNull();
    expect(document.activeElement).toBe(byId("video-exit-fullscreen"));
    expect(film()).toBe(player);
  });

  it("a marker press shows the note as a card and pauses; the drawer is left alone", async () => {
    await open();
    await click(byId("video-fullscreen"));
    await tapMarker();
    expect(byId("review-note-card-body")!.textContent).toContain("Trim the opening");
    expect(byId("review-note-card-author")!.textContent).toBe("Mia Chen");
  });

  it("Add note shows the composer (the one editor node), and Escape goes card, composer, then out; focus returns to Full screen", async () => {
    await open();
    byId("video-fullscreen")!.focus();
    await click(byId("video-fullscreen"));
    await click(byId("video-immersive-add-note"));
    // A phone's composer is the strip (#879 PR 2), the same node the sheet showed; a desktop's is the form.
    expect(byId(size.coarse ? "guest-compose-strip" : "guest-composer")).not.toBeNull();
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    // A phone's Full screen composer is P6's compose strip (S4, owner decision 1): its hint names the stamp, and the field has the focus inside the tap.
    if (size.coarse) {
      expect(byId("guest-composer-stamp")!.textContent).toContain("the note is stamped here");
      expect(byId("video-review-pane")!.contains(document.activeElement)).toBe(true);
    }
    await tapMarker();
    expect(byId("review-note-card")).not.toBeNull();
    await escape();
    expect(byId("review-note-card")).toBeNull();
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    await escape();
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(byId(size.coarse ? "guest-compose-strip" : "guest-composer")).not.toBeNull();
    await escapeOutOfTooltip();
    await escape();
    expect(immersiveOn()).toBe(false);
    expect(document.activeElement).toBe(byId("video-fullscreen"));
  });

  it("Cancel discards the draft and closes the composer, as the Add note toggle does (#880 fix round 1, item 2)", async () => {
    await open();
    await click(byId("video-fullscreen"));
    await click(byId("video-immersive-add-note"));
    await typeInto(byId("guest-composer-body"), "Trim the opening");
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    // A desktop click focuses the button first (a phone's Cancel keeps the field's focus instead).
    if (!size.coarse) await act(async () => { byId("guest-composer-cancel")!.focus(); });
    await click(byId("guest-composer-cancel"));
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(document.activeElement).toBe(byId("video-immersive-add-note"));
    await click(byId("video-immersive-add-note"));
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("");
  });

  it("Tab is held inside the layer: the focus manager's guards exist only while in Full screen, and the page's header is inert", async () => {
    await open();
    expect(document.querySelector("[data-floating-ui-focus-guard]")).toBeNull();
    await click(byId("video-fullscreen"));
    expect(document.querySelectorAll("[data-floating-ui-focus-guard]").length).toBeGreaterThan(0);
    expect(byId("guest-header-hide")!.hasAttribute("inert")).toBe(true);
    await click(byId("video-exit-fullscreen"));
    expect(document.querySelector("[data-floating-ui-focus-guard]")).toBeNull();
  });
});

describe("the guest page's Full screen and the keyboard on a phone device (#880 S1)", () => {
  class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
  let fake: FakeViewport; let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    viewport.restore(); viewport = mockViewport({ width: 844, height: 390, coarse: true }); notes = { [asset(10)]: [note(1)] };
    fake = new FakeViewport(); original = Object.getOwnPropertyDescriptor(window, "visualViewport"); Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
  });
  afterEach(() => { if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport; });

  it("sideways (844 wide, not the phone layout) the column follows the visual viewport and carries its transform, so the layer's fixed inset-0 is the column's box; the canvas is ink", async () => {
    await open();
    expect(immersiveOn()).toBe(true);
    const column = byId("guest-column")!;
    expect(column.contains(screenRoot())).toBe(true);
    expect(screenRoot().className).toContain("fixed");
    expect(screenRoot().className).toContain("inset-0");
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    await act(async () => { fake.height = window.innerHeight - 200; fake.offsetTop = 12; fake.dispatchEvent(new Event("resize")); });
    // A transform on the column makes it the containing block of its fixed descendants: the layer is the box above the keyboard, not the layout viewport.
    expect(column.style.transform).toBe("translateY(12px)");
    expect(column.style.height).toBe(`${window.innerHeight - 200}px`);
  });

  it("the keyboard going away without a blur blurs the Full screen composer's field, and the composer stays shown", async () => {
    await open();
    await click(byId("video-immersive-add-note"));
    const editor = byId("video-review-pane")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { editor.focus(); });
    await act(async () => { fake.height = window.innerHeight - 200; fake.dispatchEvent(new Event("resize")); });
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(3);
    expect(document.activeElement).not.toBe(editor);
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
  });
});

describe("the guest ⋯ with nothing but the system player (#880 S6)", () => {
  beforeEach(() => { viewport.restore(); viewport = mockViewport({ width: 390, height: 844, coarse: true }); });
  it("still shows: its one row is the system player, disabled with its hint where the browser has none", async () => {
    session = SESSION_OFF; socialOverlays = []; notes = {};
    await open();
    expect(byId("video-header-menu")).not.toBeNull();
    await click(byId("video-header-menu"));
    const row = byId("guest-open-system-player")!;
    expect(row.textContent).toContain("Open in system player");
    expect(row.getAttribute("aria-disabled") === "true" || row.hasAttribute("data-disabled") || (row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain("This browser has no player of its own");
    // The hint describes the row; it is not part of its name.
    const described = row.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described!)!.textContent).toBe("This browser has no player of its own to open the film in.");
    expect(row.querySelector('[data-testid="review-action-row-label"]')!.textContent).toBe("Open in system player");
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-paste-open")).toBeNull();
    expect(byId("guest-request-changes")).toBeNull();
  });
});

describe("the guest page's Full screen: unverified Add note (#880)", () => {
  it("asks to verify first, and opens no composer until the guest has", async () => {
    session = ANON; notes = {}; videos = [videoOf(1)];
    await open();
    await click(byId("video-fullscreen"));
    await click(byId("video-immersive-add-note"));
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("watch");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it("the verify dialog takes the focus from Full screen's trap, and Tab stays in the dialog (#880, test g)", async () => {
    viewport.restore(); viewport = mockViewport({ width: 390, height: 844, coarse: true });
    session = ANON; notes = {}; videos = [videoOf(1)];
    await open();
    await click(byId("video-fullscreen"));
    await click(byId("video-immersive-add-note"));
    await flush(4);
    const dialog = byId("guest-verify-dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => { byId("guest-verify-email")!.focus(); });
    await flush(2);
    expect(document.activeElement).toBe(byId("guest-verify-email"));
  });
});

describe("the guest page's Full screen and rotation (#880, D14)", () => {
  beforeEach(() => { viewport.restore(); viewport = mockViewport({ width: 390, height: 844, coarse: true }); });
  it("turning sideways enters, turning back leaves", async () => {
    await open();
    await viewport.set({ width: 844, height: 390 });
    expect(immersiveOn()).toBe(true);
    await viewport.set({ width: 390, height: 844 });
    expect(immersiveOn()).toBe(false);
  });
  it("a button entry stays through a turn back", async () => {
    await open();
    await click(byId("video-fullscreen"));
    await viewport.set({ width: 844, height: 390 });
    await viewport.set({ width: 390, height: 844 });
    expect(immersiveOn()).toBe(true);
  });
  it("a turn mid-compose enters Full screen's compose, the draft carried (#880 S5); the field is the desktop form's, main's second composer, so it is a new node", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    const strip = byId("video-review-pane")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { strip.focus(); });
    await typeInto(strip, "Brighter sky");
    await flush(2);
    expect(byId("video-review-pane")!.getAttribute("data-mode")).toBe("compose");
    await viewport.set({ width: 844, height: 390 });
    await flush(2);
    expect(immersiveOn()).toBe(true);
    expect(byId("video-review-pane")!.getAttribute("data-immersive")).toBe("compose");
    expect(byId("guest-composer")).not.toBeNull();
    expect((byId("video-review-pane")!.querySelector<HTMLTextAreaElement>('[data-testid="guest-composer-body"]'))!.value).toBe("Brighter sky");
  });
  it("turning back with the field left in Full screen gives the sheet browse, not a stale compose (#880 S5)", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    await act(async () => { byId("video-review-pane")!.querySelector<HTMLTextAreaElement>("textarea")!.focus(); });
    await flush(2);
    await viewport.set({ width: 844, height: 390 });
    await act(async () => { (document.activeElement as HTMLElement).blur(); });
    await viewport.set({ width: 390, height: 844 });
    await flush(2);
    expect(immersiveOn()).toBe(false);
    expect(byId("video-review-pane")!.getAttribute("data-mode")).toBe("browse");
  });
  it("the action sheet labels the row by device and hands the film to webkitEnterFullscreen", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    await open();
    const enter = vi.fn();
    (film() as unknown as { webkitEnterFullscreen: () => void }).webkitEnterFullscreen = enter;
    await click(byId("video-header-menu"));
    const row = byId("guest-open-system-player")!;
    expect(row.textContent).toContain("Open in iPhone player");
    await click(row);
    expect(enter).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
