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
    GuestNoteEditor: (props: { testId: string; label: string; placeholder?: string; disabled?: boolean; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void; media: unknown; onUploadingChange?: (uploading: boolean) => void; pill?: boolean; inlineStart?: import("react").ReactNode; inlineEnd?: import("react").ReactNode }) => {
      field.props.set(props.testId, props as never);
      // eslint-disable-next-line react-hooks/rules-of-hooks -- a component body
      useEffect(() => () => { field.unmounts += 1; }, []);
      const area = <textarea data-testid={props.testId} aria-label={props.label} placeholder={props.placeholder} disabled={props.disabled} value={shared.videoNoteBody(props.value)}
        onChange={(event) => { props.onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : shared.legacyBodyToRichTextDoc(event.target.value)); }} />;
      // The phone pill (#879 PR 2) puts its +, chip and pen around the field.
      return props.pill ? <div>{props.inlineStart}{area}{props.inlineEnd}</div> : area;
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
/** A control of the note box by its accessible name (#927). */
const inBox = (label: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="guest-composer"] button[aria-label="${label}"]`);
const off = (element: HTMLButtonElement | null) => element !== null && (element.disabled || element.getAttribute("aria-disabled") === "true");
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
  viewport = mockViewport({ width: 1440 });
  session = VERIFIED; videos = [videoOf(1)]; socialOverlays = [REEL, TIKTOK]; overlayAnswer = null; notes = {}; extra = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});


/** Gives every element a layout size so the player can place its picture box (happy-dom has none). */
async function withLayout(run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  for (const [prop, value] of [["offsetWidth", 800], ["offsetHeight", 800], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  try { await run(); } finally {
    for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) {
      const d = original[prop];
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
}
const pointer = async (layer: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.assign(event, { pointerId: 1, isPrimary: true });
  await act(async () => { layer.dispatchEvent(event); });
};
async function draw(layer: Element) {
  Object.defineProperty(layer, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) });
  await pointer(layer, "pointerdown", 10, 10); await pointer(layer, "pointermove", 40, 40); await pointer(layer, "pointerup", 40, 40);
}
beforeEach(() => { Element.prototype.setPointerCapture = () => undefined; Element.prototype.releasePointerCapture = () => undefined; });
const toggle = () => byId("guest-social-toggle");
const stage = () => byId("video-stage");
const overlayImage = () => byId("video-social-overlay") as HTMLImageElement | null;
/** On a phone the toggle is a row of the ⋯ action sheet, which closes when the row is chosen. */
const social = async (on: boolean) => { if (!toggle()) await click(byId("video-header-menu")); if ((toggle()?.getAttribute("aria-pressed") === "true") !== on) await click(toggle()); };

describe("Social preview on the Review link (#872)", () => {
  it("is not offered when the Project resolves no overlays", async () => {
    socialOverlays = [];
    await open();
    expect(toggle()).toBeNull();
  });

  it("never marks the link unavailable when the overlays read fails: the film plays and the page simply has no Social toggle", async () => {
    for (const answer of [() => stub404(), () => new Response("boom", { status: 500 }), () => json({ socialOverlays: [{ ...REEL, platformLabel: "Instagram" }] }), () => json({ videos: [] }), () => Promise.reject(new TypeError("offline"))]) {
      overlayAnswer = answer;
      await open();
      expect(byId("guest-video-title")?.textContent, "the video screen shows").toBe("Film 1");
      expect(document.body.textContent).not.toContain("unavailable");
      expect(toggle()).toBeNull();
      await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = "";
    }
  });

  it("shows the film as soon as /videos answers while the overlays read is still out, then adds the toggle when it lands", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    overlayAnswer = async () => { await held; return json({ socialOverlays }); };
    await open();
    expect(byId("guest-video-title")?.textContent, "the film screen shows with the overlays read held open").toBe("Film 1");
    expect(toggle()).toBeNull();
    await act(async () => { release(); });
    await flush();
    expect(toggle()).not.toBeNull();
    expect(byId("guest-video-title")?.textContent).toBe("Film 1");
  });

  it("reads the overlays from their own route and leaves /videos alone", async () => {
    await open();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`${BASE}/social-overlays`);
    expect(urls.filter((url) => url === `${BASE}/videos`).length).toBeGreaterThan(0);
  });

  it("is a labelled toggle: visible text Social, accessible name Social preview", async () => {
    await open();
    expect(toggle()!.textContent).toContain("Social preview");
    expect(toggle()!.textContent).toBe("Social preview");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
    expect(stage()!.dataset.social).toBeUndefined();
  });

  it("frames the film fitted with the first overlay, switches overlay, offers no Fill or Fit, and leaves cleanly", async () => {
    await open();
    await social(true);
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
    expect(stage()!.dataset.social).toBe("fit");
    expect(byId("video-social-fill")).toBeNull();
    expect(byId("video-social-fit")).toBeNull();
    expect(overlayImage()!.getAttribute("src")).toBe(REEL.imageUrl);
    await click(byId("video-social-overlay-select"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === TIKTOK.name));
    expect(overlayImage()!.getAttribute("src")).toBe(TIKTOK.imageUrl);
    await social(false);
    expect(stage()!.dataset.social).toBeUndefined();
    expect(overlayImage()).toBeNull();
  });

  it("keeps the same <video> element and the marker lane, and I marks the in frame of the note", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    expect(byId("video-marker-lane")).not.toBeNull();
    const before = host.querySelector("video");
    await social(true);
    expect(host.querySelector("video")).toBe(before);
    expect(byId("video-marker-lane")).not.toBeNull();
    expect(byId("video-range-button")).toBeNull();
    await atSeconds(2);
    await keyDown("i");
    expect(byId("note-composer-chip")?.textContent).toContain("00:00:02:00");
    expect(inBox("In and out points")!.getAttribute("aria-pressed")).toBe("true");
    await social(false);
    expect(byId("video-marker-lane")).not.toBeNull();
    expect(host.querySelector("video")).toBe(before);
  });

  it("keeps the note box and the empty-list line with Social on: no paused line, nothing hidden", async () => {
    await open();
    expect(byId("guest-composer")).not.toBeNull();
    await social(true);
    expect(byId("guest-composer")!.closest("[hidden]")).toBeNull();
    expect(byId("guest-composer")!.closest("[inert]")).toBeNull();
    expect(byId("guest-notes-social-paused")).toBeNull();
    expect(document.body.textContent).toContain("No notes yet");
    await social(false);
    expect(document.body.textContent).toContain("No notes yet");
    expect(byId("guest-composer")).not.toBeNull();
  });

  it("a guest can Post a note while Social is on", async () => {
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? Promise.resolve(json(mine(5, { body: "From Social" }), 201)) : undefined);
    await open();
    await social(true);
    await typeInto(byId("guest-composer-body"), "From Social");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
    expect(byId("guest-composer")!.dataset.open).toBe("false");
  });

  it("is offered to a guest who cannot comment, with no paused line", async () => {
    session = SESSION_OFF;
    await open();
    await social(true);
    expect(stage()!.dataset.social).toBe("fit");
    expect(byId("guest-notes-social-paused")).toBeNull();
  });

  it("keeps a typed composer draft (body and an in mark) visible and intact while Social is on, and after it", async () => {
    await open();
    await atSeconds(1);
    await typeInto(byId("guest-composer-body"), "Half written");
    await click(inBox("In and out points"));
    const anchor = byId("note-composer-chip")!.textContent;
    await social(true);
    expect(byId("guest-composer")!.closest("[hidden]")).toBeNull();
    expect(byId("guest-composer")!.closest("[inert]")).toBeNull();
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("Half written");
    await social(false);
    expect(byId("guest-composer")!.closest("[hidden]")).toBeNull();
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("Half written");
    expect(byId("note-composer-chip")!.textContent).toBe(anchor);
  });

  it("keeps the same composer and editor nodes across Social, and an upload started before it is never torn down", async () => {
    await open();
    const form = byId("guest-composer"); const editor = byId("guest-composer-body");
    await act(async () => { field.props.get("guest-composer-body")!.onUploadingChange?.(true); });
    expect(off(inBox("Post note"))).toBe(true);
    await social(true);
    await social(false);
    expect(byId("guest-composer")).toBe(form);
    expect(byId("guest-composer-body")).toBe(editor);
    expect(field.unmounts).toBe(0);
    expect(off(inBox("Post note"))).toBe(true);
  });

  it("settles a Post that is still out when Social turns on: the answer lands and the composer is usable again", async () => {
    let release: (response: Response) => void = () => undefined;
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    await open();
    await typeInto(byId("guest-composer-body"), "On its way");
    await submit("guest-composer");
    expect(off(inBox("Post note"))).toBe(true);
    await social(true);
    await act(async () => { release(json(mine(5, { body: "On its way" }), 201)); });
    await flush();
    await social(false);
    expect(byId("guest-composer")!.dataset.open).toBe("false");
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("");
  });

  it("settles a Save that is still out when Social turns on", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let release: (response: Response) => void = () => undefined;
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-composer-body"), "Changed");
    await submit("guest-composer");
    expect(off(document.body.querySelector<HTMLButtonElement>('[data-testid="guest-composer"] button[type="submit"]'))).toBe(true);
    await social(true);
    await act(async () => { release(json(mine(2, { revision: 4, body: "Changed" }))); });
    await flush();
    await social(false);
    expect(byId("guest-composer")!.dataset.variant).toBe("guest");
    expect(byId("guest-composer")!.dataset.open).toBe("false");
  });

  it("keeps an open own-note Edit form usable with Social on, with its text", async () => {
    notes = { [asset(10)]: [note(1, { replies: [(({ replies: _replies, ...reply }) => reply)(mine(2, { parentId: noteId(1), startFrame: null, body: "My reply" }))] })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(byId("guest-note-edit-form")).not.toBeNull();
    const form = byId("guest-note-edit-form");
    await social(true);
    expect(byId("guest-note-edit-form")).toBe(form);
    expect(byId("guest-note-edit-form")!.hidden).toBe(false);
    expect(byId("guest-note-edit-form")!.closest("[inert]")).toBeNull();
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("My reply");
    await social(false);
    expect(byId("guest-note-edit-form")).toBe(form);
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("My reply");
  });

  it("keeps an open reply form and the Reply button usable with Social on, with the draft", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "Draft reply");
    await social(true);
    expect(byId("guest-reply-form")!.hidden).toBe(false);
    expect(byId("guest-reply-form")!.closest("[inert]")).toBeNull();
    expect((byId("guest-reply-body") as HTMLTextAreaElement).value).toBe("Draft reply");
    await social(false);
    expect((byId("guest-reply-body") as HTMLTextAreaElement).value).toBe("Draft reply");
  });

  it("keeps a drawing in progress when Social turns on or off, with its strokes, and the notes sheet stays where it is", async () => {
    viewport.restore(); viewport = mockViewport({ width: 375 });
    await withLayout(async () => {
      await open();
      await atSeconds(1);
      // The pen sits in the note box (#927), with the field mounted at rest for a verified guest.
      await vi.waitFor(() => { expect(byId("guest-composer-body")).not.toBeNull(); });
      await click(inBox("Draw on the frame"));
      await atSeconds(1);
      const layer = byId("guest-draft-layer")!;
      await draw(layer);
      expect(byId("note-draw-row")).not.toBeNull();
      await social(true);
      expect(byId("note-draw-row")).not.toBeNull();
      expect(byId("guest-draft-layer")).toBe(layer);
      expect(byId("video-social-frame")!.contains(layer)).toBe(true);
      expect(byId("video-review-pane")!.getAttribute("data-mode")).toBe("draw");
      await social(false);
      expect(byId("note-draw-row")).not.toBeNull();
      expect(byId("guest-draft-layer")).toBe(layer);
    });
  });

  it("keeps the premium watermark inside the Social frame on a locked film", async () => {
    videos = [videoOf(1, [versionOf(10)])]; videos = [{ ...videos[0]!, premium: true, unlocked: false }];
    await withLayout(async () => {
      await open();
      await social(true);
      expect(byId("video-social-frame")!.contains(byId("guest-watermark"))).toBe(true);
    });
  });

  it("stays on across Videos and Versions and starts off again after All videos", async () => {
    videos = [videoOf(1, [versionOf(11), versionOf(10)]), videoOf(2)];
    await open(vid(1));
    await social(true);
    await click(byId("guest-version-trigger"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v10")));
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
    await click(button("Next video"));
    expect(byId("guest-video-title")!.textContent).toBe("Film 2");
    expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
    expect(stage()!.dataset.social).toBe("fit");
    await click(button("All videos"));
    await click(button("Film 1"));
    expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("is offered on a Delivery deep link entry", async () => {
    videos = [videoOf(1), videoOf(2)];
    await open(vid(2));
    expect(byId("guest-video-title")!.textContent).toBe("Film 2");
    expect(toggle()).not.toBeNull();
  });

  it("names the toggle Social preview on a phone too", async () => {
    viewport.restore(); viewport = mockViewport({ width: 375 });
    await open();
    await click(byId("video-header-menu"));
    expect(toggle()!.textContent).toContain("Social preview");
  });

  it("takes the refreshed overlays with the refreshed Videos when the shown Version leaves the link", async () => {
    videos = [videoOf(1, [versionOf(11), versionOf(10)]), videoOf(2)];
    await open(vid(1));
    videos = [videoOf(1, [versionOf(10)]), videoOf(2)]; socialOverlays = [TIKTOK];
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    await flush();
    await click(button("Film 1"));
    await social(true);
    expect(overlayImage()!.getAttribute("src")).toBe(TIKTOK.imageUrl);
  });

  it("follows a changed selection after a resync: a chosen overlay that left the list falls back to the first", async () => {
    await open();
    await social(true);
    await click(byId("video-social-overlay-select"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === TIKTOK.name));
    expect(overlayImage()!.getAttribute("src")).toBe(TIKTOK.imageUrl);
    socialOverlays = [REEL];
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    await flush();
    expect(overlayImage()!.getAttribute("src")).toBe(REEL.imageUrl);
  });
});
