import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { installLocalStorageShim } from "../testing/local-storage";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../lib/time-format-prefs";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { installSliderLayout, scrubberThumbShown } from "../testing/slider-layout";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
/** The rich field is a textarea handle on its props: this file is about what the page does with the document and the upload state (the field itself is tested in GuestNoteEditor.dom.test.tsx). Typing sends a one-paragraph document, which is what the real field sends for plain text. */
const field = vi.hoisted(() => ({ props: new Map<string, { media: unknown; onUploadingChange?: (uploading: boolean) => void; onFailedFilesChange?: (failed: number) => void; onChange: (doc: unknown) => void; value: unknown; label: string }>() }));
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  const { createPortal } = await import("react-dom");
  return {
    // The phone pill's props (#879 PR 2) are placed the way the real field places them: `inlineStart` / `inlineEnd` around the text, and a stand-in toolbar portalled into `toolbarContainer`.
    GuestNoteEditor: (props: { testId: string; id?: string; label: string; placeholder?: string; disabled?: boolean; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void; media: unknown; onUploadingChange?: (uploading: boolean) => void; pill?: boolean; pillWrap?: boolean; inlineStart?: import("react").ReactNode; inlineEnd?: import("react").ReactNode; toolbarContainer?: HTMLElement | null; contentClassName?: string }) => {
      field.props.set(props.testId, props as never);
      const area = <textarea data-testid={props.testId} id={props.id} aria-label={props.label} placeholder={props.placeholder} disabled={props.disabled} className={props.contentClassName} value={shared.videoNoteBody(props.value)}
        onChange={(event) => { props.onChange(event.target.value === "" ? { type: "doc", content: [{ type: "paragraph" }] } : shared.legacyBodyToRichTextDoc(event.target.value)); }} />;
      if (!props.pill) return area;
      return <div data-testid="stub-pill" data-pill-wrap={String(props.pillWrap ?? true)}>
        <div data-testid="stub-inline-start">{props.inlineStart}</div>{area}<div data-testid="stub-inline-end">{props.inlineEnd}</div>
        {props.toolbarContainer ? createPortal(<div role="toolbar" aria-label="Formatting" data-testid="stub-toolbar"><button type="button" data-testid="stub-bold">B</button></div>, props.toolbarContainer) : null}
      </div>;
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
  const list = /\/versions\/([^/]+)\/notes$/.exec(url);
  if (list && (init?.method ?? "GET") === "GET") return json({ notes: notes[list[1]!] ?? [] });
  return stub404();
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
async function open() {
  field.props.clear();
  window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestApp token="tok123" />); });
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
const sheetKey = async (key: string) => { const grabber = document.querySelector<HTMLElement>('[data-testid="review-sheet-grabber"]')!; await act(async () => { grabber.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); }); };
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
  session = VERIFIED; videos = [videoOf(1)]; notes = {}; extra = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

/** A control of the note box by its accessible name (#927: the box's tools carry labels, not test ids). */
const labelled = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll<HTMLElement>("button")].find((item) => item.getAttribute("aria-label") === label) ?? null;
const box = () => byId("guest-composer");
const inBox = (label: string) => (box() ? labelled(label, box()!) : null);
const chip = () => byId("note-composer-chip");
/** A control that is off: `disabled`, or locked with a reason (Base UI's focusable `aria-disabled`). */
const off = (element: Element | null | undefined) => element instanceof HTMLButtonElement && (element.disabled || element.getAttribute("aria-disabled") === "true");
const inOut = async () => { await click(inBox("In and out points")); };
const pen = async () => { await click(inBox("Draw on the frame")); };
const doneDrawing = async () => { await click(labelled("Done drawing")); };

describe("the note box (#927 G1)", () => {
  it("a verified guest's rail ends in the box: in/out, paperclip and pen bottom left, a round Post note bottom right, no visibility and no Add a note", async () => {
    await open();
    const form = box()!;
    expect(form).not.toBeNull();
    expect(form.getAttribute("data-variant")).toBe("guest");
    expect(byId("guest-add-note")).toBeNull();
    expect(inBox("In and out points")).not.toBeNull();
    expect(inBox("Add photos or videos")).not.toBeNull();
    expect(inBox("Draw on the frame")).not.toBeNull();
    expect(form.querySelector('[aria-label^="Who can see this note"]')).toBeNull();
    expect(byId("note-composer-visibility")).toBeNull();
    const send = inBox("Post note") as HTMLButtonElement;
    expect(send.getAttribute("type")).toBe("submit");
    expect(off(send)).toBe(true);
    // The box is the panel's foot: after the notes list.
    expect(byId("guest-notes-panel")!.lastElementChild!.contains(form)).toBe(true);
  });
  it("hides the pen when drawing is off for the Project, and still posts", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json(mine(5, { startFrame: 50 }), 201) : undefined);
    await open();
    expect(inBox("Draw on the frame")).toBeNull();
    expect(inBox("In and out points")).not.toBeNull();
    await atSeconds(2);
    await typeInto(byId("guest-composer-body"), "Text only");
    await submit("guest-composer");
    expect(requests("POST").at(-1)!.body).toEqual({ startFrame: 50, content: para("Text only") });
  });
  it("the chip follows the film until the note starts, then stays on the frame the text began on", async () => {
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json(mine(5, { startFrame: 75 }), 201) : undefined);
    await open();
    await atSeconds(2);
    expect(chip()!.textContent).toContain("00:00:02:00");
    await atSeconds(3);
    expect(chip()!.textContent).toContain("00:00:03:00");
    await typeInto(byId("guest-composer-body"), "Here");
    await atSeconds(5);
    expect(chip()!.textContent).toContain("00:00:03:00");
    expect((inBox("Post note") as HTMLButtonElement).disabled).toBe(false);
    await click(inBox("Post note"));
    expect(requests("POST").at(-1)!.body).toEqual({ startFrame: 75, content: para("Here") });
    // Posted: the box is empty again and follows the film.
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("");
    expect(chip()!.textContent).toContain("00:00:05:00");
  });
  it("one in/out button: In, then Out, then clear; the chip reads In → Out with ×, and the post carries the range", async () => {
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json(mine(5, { startFrame: 50, endFrame: 101 }), 201) : undefined);
    await open();
    await atSeconds(2);
    await click(inBox("In and out points"));
    expect(inBox("In and out points")!.getAttribute("aria-pressed")).toBe("true");
    await atSeconds(3);
    expect(chip()!.textContent).toMatch(/00:00:02:00 → 00:00:03:00/);
    expect(byId("note-composer-chip-live")).not.toBeNull();
    await atSeconds(4);
    await click(inBox("In and out points"));
    expect(chip()!.textContent).toMatch(/00:00:02:00 → 00:00:04:00/);
    expect(byId("note-composer-chip-live")).toBeNull();
    await click(inBox("In and out points"));
    expect(chip()!.textContent).not.toContain("→");
    expect(inBox("In and out points")!.getAttribute("aria-pressed")).toBe("false");
    await atSeconds(2);
    await click(inBox("In and out points"));
    await atSeconds(4);
    await click(inBox("In and out points"));
    await typeInto(byId("guest-composer-body"), "Cut this section");
    await click(inBox("Post note"));
    expect(requests("POST").at(-1)!.body).toEqual({ startFrame: 50, endFrame: 101, content: para("Cut this section") });
  });
  it("the chip's × clears the range back to a point", async () => {
    await open();
    await atSeconds(2);
    await click(inBox("In and out points"));
    await atSeconds(4);
    await click(inBox("In and out points"));
    await click(labelled("Clear in and out", chip()!));
    expect(chip()!.textContent).not.toContain("→");
  });
  it("an unverified guest's box has a field that asks for verification, and no draft opens", async () => {
    session = ANON;
    await open();
    expect(byId("guest-composer-body")).toBeNull();
    await click(byId("guest-compose-shell-open"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
  });
});

describe("A resolved note", () => {
  it("shows a non-interactive green tick status, not a badge or button; an open note shows none", async () => {
    notes = { [asset(10)]: [note(1, { resolved: true }), note(2)] };
    await open();
    const ticks = allById("guest-note-resolved");
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.tagName).not.toBe("BUTTON");
    expect(ticks[0]!.textContent).toBe("Resolved");
    expect(ticks[0]!.querySelector("svg")!.getAttribute("class")).toContain("fill-success");
  });
  it("sits in the Reply row, bottom-right, when the guest can reply; on its own row when they cannot", async () => {
    notes = { [asset(10)]: [note(1, { resolved: true })] };
    await open();
    expect(byId("guest-note-resolved")!.parentElement).toBe(byId("guest-note-reply-button")!.parentElement);
    expect(byId("guest-note-resolved")!.className).toContain("ms-auto");
    expect(byId("guest-note-reply-button")!.parentElement!.className).toContain("min-h-8"); // open and resolved cards share one row height
    await act(async () => { root!.unmount(); }); root = null; host.remove();
    session = SESSION_OFF;
    await open();
    expect(byId("guest-note-reply-button")).toBeNull();
    expect(byId("guest-note-resolved")).not.toBeNull();
  });
  it("stays visible while a reply to the resolved note is being written", async () => {
    notes = { [asset(10)]: [note(1, { resolved: true })] };
    await open();
    await click(byId("guest-note-reply-button"));
    expect(byId("guest-reply-form")).not.toBeNull();
    expect(byId("guest-note-resolved")).not.toBeNull();
    expect(byId("guest-note-resolved")!.textContent).toBe("Resolved");
    // Bottom-right, as on the staff card: the tick follows the reply form, not sits above it.
    expect(byId("guest-reply-form")!.compareDocumentPosition(byId("guest-note-resolved")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the box's entry", () => {
  it("is not offered when the link does not allow comments", async () => {
    session = SESSION_OFF;
    await open();
    expect(box()).toBeNull();
  });
  it("asks a guest who has not verified to verify, and opens no field", async () => {
    session = ANON;
    await open();
    await click(byId("guest-compose-shell-open"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-composer-body")).toBeNull();
  });
  it("is the field itself for a verified guest", async () => {
    await open();
    expect(byId("guest-composer-body")).not.toBeNull();
    expect(byId("guest-compose-shell-open")).toBeNull();
    expect(byId("guest-verify-dialog")).toBeNull();
  });
  it("verifies by email code, then lands in the field, and later writes still work on the rotated session", async () => {
    session = ANON;
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = VERIFIED; return json(VERIFIED); }
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") return json(mine(5, { startFrame: 0 }), 201);
      return undefined;
    };
    await open();
    await click(byId("guest-compose-shell-open"));
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    expect(requests("POST").map((call) => call.url)).toEqual([`${BASE}/email/code`, `${BASE}/email/verify`]);
    expect(requests("POST")[1]!.body).toEqual({ code: "123456", name: "Sam" });
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(document.activeElement).toBe(byId("guest-composer-body"));
    await typeInto(byId("guest-composer-body"), "After verifying");
    await submit("guest-composer");
    expect(allById("guest-note")).toHaveLength(1);
  });
});

describe("the composer", () => {
  it("posts a point note at the frame the text began on, adds it to the list and empties the box", async () => {
    let posted: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json(mine(5, { startFrame: 50 }), 201); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    expect(chip()?.textContent).toContain("00:00:02:00");
    await typeInto(byId("guest-composer-body"), "Too dark here");
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, content: para("Too dark here") });
    expect(box()!.getAttribute("data-open")).toBe("false");
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("");
    const rows = allById("guest-note");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("My note");
  });
  it("marks an in and an out for a range note", async () => {
    let posted: unknown = null;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json(mine(5, { startFrame: 50, endFrame: 101 }), 201); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    await inOut();
    await atSeconds(4);
    await inOut();
    expect(chip()?.textContent).toMatch(/00:00:02:00.*00:00:04:00/);
    await typeInto(byId("guest-composer-body"), "Cut this section");
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, endFrame: 101, content: para("Cut this section") });
  });
  it("an I mark after the range moves the start, and clears an out that falls before it", async () => {
    await open();
    await atSeconds(2);
    await inOut();
    await atSeconds(4);
    await inOut();
    await atSeconds(6);
    await keyDown("i");
    expect(chip()?.textContent).toContain("00:00:06:00");
    expect(chip()?.textContent).not.toMatch(/00:00:04:00/);
  });
  it("will not post an empty note: Post note is off and a submit sends nothing", async () => {
    await open();
    expect(off(inBox("Post note"))).toBe(true);
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(0);
  });
  it("a new note has no Cancel: taking the text out leaves nothing to post", async () => {
    await open();
    expect([...box()!.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Cancel")).toBe(false);
    await typeInto(byId("guest-composer-body"), "never mind");
    expect(off(inBox("Post note"))).toBe(false);
    await typeInto(byId("guest-composer-body"), "");
    expect(off(inBox("Post note"))).toBe(true);
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(0);
  });
  it("sends one post for a double submit while the first is in flight", async () => {
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; });
      return undefined;
    };
    await open();
    await typeInto(byId("guest-composer-body"), "once");
    await submit("guest-composer");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    await act(async () => { release(); });
    await flush();
    expect(allById("guest-note")).toHaveLength(1);
  });
  it("turns in/out off while the post is pending, so a seek cannot change what the success clears", async () => {
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; });
      return undefined;
    };
    await open();
    await atSeconds(2);
    await typeInto(byId("guest-composer-body"), "once");
    await submit("guest-composer");
    await atSeconds(4);
    expect(off(inBox("In and out points"))).toBe(true);
    await inOut();
    expect(chip()?.textContent).toContain("00:00:02:00");
    await act(async () => { release(); });
    await flush();
  });
  it("drops a response that arrives after the guest moved to another Version", async () => {
    videos = [videoOf(1, [versionOf(11), versionOf(10)].sort((a, b) => b.version - a.version))];
    notes = { [asset(11)]: [], [asset(10)]: [note(1)] };
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(11)}/notes` && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; });
      return undefined;
    };
    await open();
    await typeInto(byId("guest-composer-body"), "for v11");
    await submit("guest-composer");
    // Pick the other Version while the post is out.
    const trigger = byId("guest-version-trigger")!;
    await click(trigger);
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.startsWith("v10"));
    await click(option);
    expect(allById("guest-note").map((row) => row.textContent)).toEqual([expect.stringContaining("Trim the opening")]);
    await act(async () => { release(); });
    await flush();
    expect(allById("guest-note")).toHaveLength(1);
    expect(allById("guest-note")[0]!.textContent).not.toContain("My note");
  });
});

describe("drawing", () => {
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
    await pointer(layer, "pointerdown", 10, 10);
    await pointer(layer, "pointermove", 40, 40);
    await pointer(layer, "pointerup", 40, 40);
  }
  beforeEach(() => {
    // happy-dom has no pointer capture and its MouseEvent is not a PointerEvent: the hook only needs a pointerId and isPrimary.
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  });

  it("pauses on the frame, shows the drawing row, and posts the drawing with its frame on a point note that follows it", async () => {
    let posted: Record<string, unknown> | null = null;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") { posted = JSON.parse(String(init.body)) as Record<string, unknown>; return json(mine(5, { startFrame: 50, hasMarkup: true, drawingFrame: 50 }), 201); }
      return undefined;
    };
    await withLayout(async () => {
      await open();
      await atSeconds(1);
      await atSeconds(2);
      await pen();
      await atSeconds(2);
      expect(byId("note-draw-row")).not.toBeNull();
      expect(chip()?.textContent).toContain("00:00:02:00");
      const layer = byId("guest-draft-layer")!;
      await draw(layer);
      expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
      await doneDrawing();
      expect(byId("note-draw-row")).toBeNull();
      // The chip carries the pencil once the draft has a drawing (C4).
      expect(chip()?.textContent).toContain("Note with a drawing at");
      await typeInto(byId("guest-composer-body"), "Look here");
      await submit("guest-composer");
    });
    expect(posted).toMatchObject({ startFrame: 50, content: para("Look here"), drawingFrame: 50 });
    expect((posted as unknown as { markup: unknown[] }).markup).toHaveLength(1);
  });
  it("while drawing the row takes the tools' place and Post hides; ‹ gives them back, and a drawing alone does not post (D2)", async () => {
    await withLayout(async () => {
      await open();
      await atSeconds(2);
      await pen();
      await atSeconds(2);
      expect(byId("note-draw-row")).not.toBeNull();
      expect(inBox("Post note")).toBeNull();
      expect(inBox("Draw on the frame")).toBeNull();
      await draw(byId("guest-draft-layer")!);
      await doneDrawing();
      expect(byId("note-draw-row")).toBeNull();
      const post = inBox("Post note")!;
      expect(off(post)).toBe(true);
      expect(post.getAttribute("title")).toBe("Add a few words to post the drawing");
      await typeInto(byId("guest-composer-body"), "Here");
      expect(off(inBox("Post note"))).toBe(false);
    });
  });
  it("gives the composer's note field a placeholder", async () => {
    await open();
    expect(byId("guest-composer-body")?.getAttribute("placeholder")).toBe("Add a note at this frame…");
  });
  it("can take the drawing off again before posting, with the row's Clear", async () => {
    await withLayout(async () => {
      await open();
      await atSeconds(2);
      await pen();
      await atSeconds(2);
      await draw(byId("guest-draft-layer")!);
      await click(labelled("Clear drawing"));
      expect(allById("guest-draft-stroke")).toHaveLength(0);
      await doneDrawing();
      expect(chip()?.textContent).toContain("Note at");
      expect(chip()?.textContent).not.toContain("with a drawing");
    });
  });
  it("redraws the drawing of a note being edited, sending the strokes with the note's drawing frame", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, hasMarkup: true, drawingFrame: 50 })) : undefined);
    await withLayout(async () => {
      await open();
      await click(byId("guest-note-actions"));
      await click(menuItem("Edit"));
      await pen();
      await atSeconds(2);
      await draw(byId("guest-draft-layer")!);
      await doneDrawing();
      await submit("guest-composer");
    });
    const body = requests("PATCH").at(-1)!.body as { markup: unknown[] };
    expect(body).toMatchObject({ expectedRevision: 3, drawingFrame: 50 });
    expect(body.markup).toHaveLength(1);
    expect(Object.keys(body).sort()).toEqual(["drawingFrame", "expectedRevision", "markup"]);
  });
  describe("a note that already has a drawing", () => {
    const OLD = { color: "#00aa00", width: 3, points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }] };
    const NEW = { color: "#0000aa", width: 3, points: [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.9 }] };
    const drawnNote = (over: Partial<GuestNoteThreadDto> = {}) => mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50, ...over });
    let markupReads: number;
    const serve = (patched: () => boolean) => {
      markupReads = 0;
      extra = (url, init) => {
        if (url === `${BASE}/notes/${noteId(2)}/markup`) { markupReads += 1; return json({ noteId: noteId(2), revision: patched() ? 4 : 3, markup: patched() ? [NEW] : [OLD] }); }
        if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") return json(drawnNote({ revision: 4 }));
        return undefined;
      };
    };
    const selectDrawn = async () => {
      await click(byId("guest-note-anchor"));
      await atSeconds(2);
    };
    it("while a redraw is in progress or finished, the saved strokes are replaced by the draft, not shown under it", async () => {
      notes = { [asset(10)]: [drawnNote()] };
      serve(() => false);
      await withLayout(async () => {
        await open();
        await selectDrawn();
        expect(allById("guest-markup-stroke")).toHaveLength(1);
        await click(byId("guest-note-actions"));
        await click(menuItem("Edit"));
        await pen();
        await atSeconds(2);
        expect(allById("guest-markup-stroke")).toHaveLength(0);
        await draw(byId("guest-draft-layer")!);
        await doneDrawing();
        await atSeconds(2);
        expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
        expect(allById("guest-markup-stroke")).toHaveLength(0);
      });
    });
    it("a drawing history never crosses frames: draw at A, undo all, Done, draw at B, and Redo has nothing to bring back", async () => {
      await withLayout(async () => {
        await open();
        await atSeconds(2);
        await pen();
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
        await click(button("Undo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
        await doneDrawing();
        await atSeconds(4);
        await pen();
        await atSeconds(4);
        expect((button("Redo") as HTMLButtonElement).disabled).toBe(true);
        await click(button("Redo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
      });
    });
    it("a drawing history never crosses drafts: draw, undo all, post, start a new draft on another frame, press the pen, and Redo is disabled", async () => {
      extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json(mine(5), 201) : undefined);
      await withLayout(async () => {
        await open();
        await atSeconds(2);
        await pen();
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        await click(button("Undo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
        await doneDrawing();
        await typeInto(byId("guest-composer-body"), "Posted");
        await submit("guest-composer");
        expect(box()!.getAttribute("data-open")).toBe("false");
        await atSeconds(4);
        await pen();
        await atSeconds(4);
        expect((button("Redo") as HTMLButtonElement).disabled).toBe(true);
        await click(button("Redo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
      });
    });
    it("after saving a redraw, the note's drawing is read again by its new revision", async () => {
      notes = { [asset(10)]: [drawnNote()] };
      let saved = false;
      serve(() => saved);
      const inner = extra!;
      extra = (url, init) => { if (init?.method === "PATCH") saved = true; return inner(url, init); };
      await withLayout(async () => {
        await open();
        await selectDrawn();
        expect(markupReads).toBe(1);
        await click(byId("guest-note-actions"));
        await click(menuItem("Edit"));
        await pen();
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        await doneDrawing();
        await submit("guest-composer");
        await atSeconds(2);
        expect(box()!.getAttribute("data-variant")).toBe("guest");
        expect(markupReads).toBe(2);
        expect(allById("guest-markup-stroke")).toHaveLength(1);
        expect(byId("guest-markup")?.innerHTML).toContain("0.9");
      });
    });
  });
  it("does not offer the pen when the link's markup part is off", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    await open();
    expect(box()).not.toBeNull();
    expect(inBox("Draw on the frame")).toBeNull();
  });
  it("offers no drawing controls when editing a note either (even removing one would be refused)", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(box()!.getAttribute("data-variant")).toBe("edit");
    expect(inBox("Draw on the frame")).toBeNull();
    expect(labelled("Clear drawing")).toBeNull();
  });
});

describe("refusals on a post", () => {
  const post = async () => {
    await open();
    await typeInto(byId("guest-composer-body"), "keep me");
    await submit("guest-composer");
  };
  const refuse = (response: () => Response) => { extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? response() : undefined); };
  it("401 asks the guest to verify again and keeps the draft", async () => {
    refuse(() => json({ error: "verification_required" }, 401));
    await post();
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("keep me");
  });
  it("429 says when to try again and keeps the draft", async () => {
    refuse(() => json({ error: "too_many_attempts", retryAfterSeconds: 45 }, 429, { "retry-after": "45" }));
    await post();
    expect(byId("guest-composer-problem")?.textContent).toMatch(/45 seconds/);
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("keep me");
  });
  it("409 project_archived turns the page read-only with a notice", async () => {
    refuse(() => json({ error: "project_archived" }, 409));
    await post();
    expect(byId("guest-archived-notice")).not.toBeNull();
    expect(box()).toBeNull();
  });
  it("the stub, or comments switched off, is the unavailable page", async () => {
    refuse(() => stub404());
    await post();
    expect(byId("guest-unavailable")).not.toBeNull();
  });
  it("a dropped connection keeps the draft and says nothing was sent", async () => {
    extra = (url, init) => { if (url.endsWith("/notes") && init?.method === "POST") throw new TypeError("offline"); return undefined; };
    await post();
    expect(byId("guest-composer-problem")?.textContent).toMatch(/couldn.t reach/i);
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("keep me");
  });
});

describe("own notes", () => {
  it("marks the guest's own notes 'You' with an actions menu, and nobody else's", async () => {
    notes = { [asset(10)]: [note(1), mine(2), note(3, { author: { kind: "guest", name: "Pat", self: false } })] };
    await open();
    const rows = allById("guest-note");
    expect(rows.map((row) => row.querySelector('[data-testid="guest-note-self-badge"]') !== null)).toEqual([false, true, false]);
    expect(rows.map((row) => row.querySelector('[data-testid="guest-note-actions"]') !== null)).toEqual([false, true, false]);
    expect(rows[2]!.textContent).toContain("Client");
  });
  it("offers no actions on a deleted note, or when comments are off", async () => {
    notes = { [asset(10)]: [mine(2, { deleted: true, body: "" })] };
    await open();
    expect(byId("guest-note-actions")).toBeNull();
  });
  it("edits the body with the note's revision and shows the saved thread", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let patched: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") { patched = JSON.parse(String(init.body)); return json(mine(2, { revision: 4, body: "Reworded", editedAt: "2026-10-09T02:00:00.000Z" })); }
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    const field = byId("guest-composer-body") as HTMLTextAreaElement;
    expect(field.value).toBe("My note");
    await typeInto(field, "Reworded");
    await submit("guest-composer");
    expect(patched).toEqual({ expectedRevision: 3, content: para("Reworded") });
    expect(box()!.getAttribute("data-variant")).toBe("guest");
    expect(byId("guest-note-body")?.textContent).toBe("Reworded");
  });
  it("sends nothing when an edit changed nothing", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await submit("guest-composer");
    expect(requests("PATCH")).toHaveLength(0);
    expect(box()!.getAttribute("data-variant")).toBe("guest");
  });
  it("on a revision conflict shows the latest, keeps the typed text, and says so", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json({ error: "note_conflict", thread: mine(2, { revision: 5, body: "Edited elsewhere" }) }, 409) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-composer-body"), "My draft");
    await submit("guest-composer");
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("My draft");
    expect(byId("guest-composer-problem")?.textContent).toMatch(/changed/i);
    expect(byId("guest-composer-latest")?.textContent).toContain("Edited elsewhere");
    // Saving again uses the fresh revision.
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 6, body: "My draft" })) : undefined);
    await submit("guest-composer");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 5, content: para("My draft") });
  });
  it("shows no visibility in the edit box: a guest's note is always public (owner decision 2026-10-20, E1)", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(box()!.getAttribute("data-variant")).toBe("edit");
    expect(box()!.querySelector('[data-testid="note-composer-visibility"]')).toBeNull();
    expect(box()!.textContent).not.toMatch(/Client-visible|Internal/);
  });
  it("re-marks the frames of a note without a drawing, sending only the frames", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, startFrame: 100, endFrame: 151 })) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(box()!.getAttribute("data-variant")).toBe("edit");
    expect(chip()?.textContent).toContain("00:00:02:00");
    await atSeconds(4);
    await inOut();
    await atSeconds(6);
    await inOut();
    // D4: a new range locks the pen until it is saved, with the reason as its title.
    expect(off(inBox("Draw on the frame"))).toBe(true);
    expect(inBox("Draw on the frame")!.getAttribute("title")).toBe("Save the new frames before you draw.");
    await submit("guest-composer");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 3, startFrame: 100, endFrame: 151 });
  });
  it("takes a drawing off a note, locking the frames while it has one", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, hasMarkup: false })) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    // D4: the drawing locks in/out, with the reason as its title; the chip carries the pencil. Clear in the drawing row takes the saved drawing off.
    expect(off(inBox("In and out points"))).toBe(true);
    expect(inBox("In and out points")!.getAttribute("title")).toMatch(/can't change while the note has a drawing/);
    expect(chip()?.textContent).toContain("with a drawing");
    await pen();
    await atSeconds(2);
    await click(labelled("Clear drawing"));
    await doneDrawing();
    await submit("guest-composer");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 3, markup: null });
  });
  it("keeps editing a reply inline, body only", async () => {
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH" ? json({ ...note(1), replies: [{ ...reply, body: "Done", revision: 3 }] }) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Done");
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 2, content: para("Done") });
  });
  it("disables a reply edit once the Project turns out to be archived, keeping its draft and sending nothing more", async () => {
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH" ? json({ error: "project_archived" }, 409) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Done");
    await submit("guest-note-edit-form");
    expect(requests("PATCH")).toHaveLength(1);
    expect(byId("guest-archived-notice")).not.toBeNull();
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).disabled).toBe(true);
    expect((byId("guest-note-edit-save") as HTMLButtonElement).disabled).toBe(true);
    await click(byId("guest-note-edit-save"));
    await submit("guest-note-edit-form");
    expect(requests("PATCH")).toHaveLength(1);
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("Done");
  });
  it("deletes only after the confirm, with the revision, and drops a hard-deleted thread", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE" ? json({ thread: null }) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    expect(byId("guest-delete-dialog")).not.toBeNull();
    expect(requests("DELETE")).toHaveLength(0);
    await click(byId("guest-delete-cancel"));
    expect(requests("DELETE")).toHaveLength(0);
    expect(allById("guest-note")).toHaveLength(1);
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE")).toEqual([{ url: `${BASE}/notes/${noteId(2)}`, body: { expectedRevision: 3 } }]);
    expect(allById("guest-note")).toHaveLength(0);
    expect(byId("guest-delete-dialog")).toBeNull();
  });
  it("returns focus to the notes panel after the guest deletes their own root note from the keyboard", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE" ? json({ thread: null }) : undefined);
    await open();
    const trigger = byId("guest-note-actions")!;
    await act(async () => { trigger.focus(); });
    await click(trigger);
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    await flush();
    expect(allById("guest-note")).toHaveLength(0);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(byId("guest-notes-panel"));
  });
  it("shows a tombstone when the server keeps the thread", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE" ? json({ thread: mine(2, { revision: 4, deleted: true, body: "" }) }) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(byId("guest-note-tombstone")).not.toBeNull();
  });
  it("keeps the confirm open with the reason when the delete is refused", async () => {
    notes = { [asset(10)]: [mine(2)] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE" ? json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(byId("guest-delete-problem")?.textContent).toMatch(/30 seconds/);
    expect(allById("guest-note")).toHaveLength(1);
  });
  it("disables the confirm's Delete once the Project turns out to be archived, keeping Cancel working and sending no second DELETE", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE" ? json({ error: "project_archived" }, 409) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE")).toHaveLength(1);
    expect(byId("guest-archived-notice")).not.toBeNull();
    expect((byId("guest-delete-confirm") as HTMLButtonElement).disabled).toBe(true);
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE")).toHaveLength(1);
    expect((byId("guest-delete-cancel") as HTMLButtonElement).disabled).toBe(false);
    await click(byId("guest-delete-cancel"));
    expect(byId("guest-delete-dialog")).toBeNull();
  });
});

describe("replies", () => {
  it("replies to a thread and shows the reply", async () => {
    notes = { [asset(10)]: [note(1)] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(1)}/replies` && init?.method === "POST"
      ? json({ ...note(1), replies: [(({ replies: _replies, ...reply }) => reply)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do" }))] }, 201) : undefined);
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "Will do");
    await submit("guest-reply-form");
    expect(requests("POST").at(-1)).toEqual({ url: `${BASE}/notes/${noteId(1)}/replies`, body: { content: para("Will do") } });
    expect(allById("guest-note-reply")).toHaveLength(1);
    expect(byId("guest-reply-form")).toBeNull();
  });
  it("is the reply box (R1): paperclip and Send reply only, no visible Cancel; Reply again or Esc dismisses it and drops the draft", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    const toggle = byId("guest-note-reply-button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    const form = byId("guest-reply-form")!;
    expect(form.getAttribute("data-variant")).toBe("reply");
    expect(labelled("Add photos or videos", form)).not.toBeNull();
    expect(labelled("Send reply", form)).not.toBeNull();
    for (const label of ["In and out points", "Draw on the frame"]) expect(labelled(label, form)).toBeNull();
    expect(form.querySelector('[data-testid="note-composer-chip"]')).toBeNull();
    expect([...form.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Cancel")).toBe(false);
    expect(off(labelled("Send reply", form))).toBe(true);
    await typeInto(byId("guest-reply-body"), "Half a reply");
    expect(off(labelled("Send reply", form))).toBe(false);
    expect(byId("guest-note-reply-button")!.getAttribute("aria-expanded")).toBe("true");
    expect(byId("guest-note-reply-button")!.getAttribute("aria-label")).toBe("Close reply");
    await click(byId("guest-note-reply-button"));
    expect(byId("guest-reply-form")).toBeNull();
    await click(byId("guest-note-reply-button"));
    expect((byId("guest-reply-body") as HTMLTextAreaElement).value).toBe("");
    await typeInto(byId("guest-reply-body"), "Another");
    await act(async () => { byId("guest-reply-body")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();
    expect(byId("guest-reply-form")).toBeNull();
    expect(requests("POST")).toHaveLength(0);
  });
  it("keeps a reply draft when the phone sheet collapses and opens again", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = { [asset(10)]: [note(1)] };
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "half written");
    await sheetKey("ArrowDown");
    expect(byId("video-review-pane")!.getAttribute("data-stop")).toBe("collapsed");
    expect(byId("guest-reply-body")!.closest("[inert]")).not.toBeNull();
    await sheetKey("ArrowUp");
    expect(byId("guest-reply-body")!.closest("[inert]")).toBeNull();
    expect((byId("guest-reply-body") as HTMLTextAreaElement | null)?.value).toBe("half written");
  });
  it("keeps a reply edit draft across the list unmounting, and drops it on cancel", async () => {
    await viewport.set({ width: 390, coarse: true });
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    await open();
    const menus = allById("guest-note-actions");
    await click(menus[0]);
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Will do it");
    await sheetKey("ArrowDown");
    await sheetKey("ArrowUp");
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement | null)?.value).toBe("Will do it");
    await click(byId("guest-note-edit-cancel"));
    await sheetKey("ArrowDown");
    await sheetKey("ArrowUp");
    expect(byId("guest-note-edit-form")).toBeNull();
  });
  it("asks an unverified guest to verify first", async () => {
    session = ANON;
    notes = { [asset(10)]: [note(1)] };
    await open();
    await click(byId("guest-note-reply-button"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-reply-form")).toBeNull();
  });
  it("offers no reply on a deleted note or when the link does not allow comments", async () => {
    session = SESSION_OFF;
    notes = { [asset(10)]: [note(1)] };
    await open();
    expect(byId("guest-note-reply-button")).toBeNull();
  });
});

describe("round 1 findings", () => {
  it("an old post that succeeds after the guest left the Version and came back does not erase the new draft", async () => {
    videos = [videoOf(1, [versionOf(11), versionOf(10)].sort((a, b) => b.version - a.version))];
    notes = { [asset(11)]: [], [asset(10)]: [note(1)] };
    let release: () => void = () => undefined;
    let posts = 0;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(11)}/notes` && init?.method === "POST") { posts += 1; return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; }); }
      return undefined;
    };
    const pick = async (label: string) => {
      await click(byId("guest-version-trigger"));
      await click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.startsWith(label)));
    };
    await open();
    await typeInto(byId("guest-composer-body"), "first");
    await submit("guest-composer");
    expect(posts).toBe(1);
    await pick("v10");
    await pick("v11");
    await typeInto(byId("guest-composer-body"), "second draft");
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-composer")).not.toBeNull();
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("second draft");
  });

  it("after verifying, the notes are read again so the guest's own notes carry Edit, Delete and 'You'", async () => {
    session = ANON;
    let verified = false;
    notes = { [asset(10)]: [] };
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { verified = true; session = VERIFIED; return json(VERIFIED); }
      if (url === `${BASE}/versions/${asset(10)}/notes` && (init?.method ?? "GET") === "GET") return json({ notes: [{ ...mine(2), author: { kind: "guest", name: "Sam", self: verified } }] });
      return undefined;
    };
    await open();
    expect(byId("guest-note-self-badge")).toBeNull();
    await click(byId("guest-compose-shell-open"));
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    expect(byId("guest-note-self-badge")).not.toBeNull();
    expect(byId("guest-note-actions")).not.toBeNull();
  });

  it("a dropped connection on a post says the outcome is unknown and reads the notes again", async () => {
    let landed = false;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") { landed = true; throw new TypeError("offline"); }
      if (url === `${BASE}/versions/${asset(10)}/notes` && (init?.method ?? "GET") === "GET") return json({ notes: landed ? [mine(5, { body: "keep me" })] : [] });
      return undefined;
    };
    await open();
    await typeInto(byId("guest-composer-body"), "keep me");
    await submit("guest-composer");
    expect(byId("guest-composer-problem")?.textContent).toMatch(/may or may not/i);
    expect(byId("guest-composer-problem")?.textContent).not.toMatch(/nothing was changed/i);
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("keep me");
    // The re-read found the note the failed answer hid.
    expect(allById("guest-note")).toHaveLength(1);
  });

  it("the re-read after an ambiguous post on Video A cannot throw the guest out of Video B when A's 404 arrives late", async () => {
    videos = [videoOf(1), videoOf(2)];
    let ambiguous = false;
    let answerA: () => void = () => undefined;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") { ambiguous = true; throw new TypeError("offline"); }
      if (ambiguous && url === `${BASE}/versions/${asset(10)}/notes` && (init?.method ?? "GET") === "GET") return new Promise<Response>((resolve) => { answerA = () => { resolve(stub404()); }; });
      return undefined;
    };
    await open();
    await click(button("Film 1"));
    await typeInto(byId("guest-composer-body"), "maybe sent");
    await submit("guest-composer");
    await click(button("All videos"));
    await click(button("Film 2"));
    expect(byId("guest-video-screen")).not.toBeNull();
    // Staff removed A's access; its delayed 404 stub arrives while B is showing.
    await act(async () => { answerA(); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-video-screen")).not.toBeNull();
  });

  it("a 4xx refusal keeps the definite wording and does not read the notes again", async () => {
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json({ error: "invalid_request" }, 400) : undefined);
    await open();
    const reads = () => fetchMock.mock.calls.filter((call) => String(call[0]) === `${BASE}/versions/${asset(10)}/notes` && ((call[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length;
    const before = reads();
    await typeInto(byId("guest-composer-body"), "x");
    await submit("guest-composer");
    expect(byId("guest-composer-problem")?.textContent).toMatch(/couldn.t be saved/i);
    expect(reads()).toBe(before);
  });

  it("I and O mark the in and out frames from the keyboard, as the box's button does; an unverified guest's keys mark nothing", async () => {
    await open();
    await atSeconds(2);
    await keyDown("i");
    expect(chip()?.textContent).toContain("00:00:02:00 →");
    expect(inBox("In and out points")!.getAttribute("aria-pressed")).toBe("true");
    await atSeconds(4);
    await keyDown("o");
    expect(chip()?.textContent).toMatch(/00:00:02:00.*00:00:04:00/);
    await atSeconds(6);
    await keyDown("i");
    expect(chip()?.textContent).toContain("00:00:06:00");
    expect(chip()?.textContent).not.toMatch(/00:00:04:00/);
    await act(async () => { root!.unmount(); }); root = null; host.remove();
    session = ANON;
    await open();
    await atSeconds(2);
    await keyDown("i");
    expect(chip()?.textContent).not.toContain("→");
  });
});

describe("round 2 findings", () => {
  it("a 401 on an edit keeps the edit open, with its text, through the re-verification and the notes read after it", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") return json({ error: "verification_required" }, 401);
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = VERIFIED; return json(VERIFIED); }
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-composer-body"), "Reworded");
    await submit("guest-composer");
    expect(byId("guest-verify-dialog")).not.toBeNull();
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-composer")).not.toBeNull();
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("Reworded");
  });

  it("a write still out when the guest goes to All videos and back is still pending: submitting again sends nothing, and the answer lands in the list", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [] };
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { notes[asset(10)] = [mine(5, { body: "slow" })]; resolve(json(mine(5, { body: "slow" }), 201)); }; });
      return undefined;
    };
    await open();
    await click(button("Film 1"));
    await typeInto(byId("guest-composer-body"), "slow");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    await click(button("All videos"));
    await click(button("Film 1"));
    await typeInto(byId("guest-composer-body"), "slow");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    await act(async () => { release(); });
    await flush();
    expect(requests("POST")).toHaveLength(1);
    expect(allById("guest-note")).toHaveLength(1);
  });
});

describe("round 4 findings", () => {
  const reply7 = (over: Partial<GuestNoteThreadDto> = {}) => (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2, ...over }));
  const conflict = (thread: GuestNoteThreadDto) => json({ error: "note_conflict", thread }, 409);

  it("a root edit saved after the list moved on still sends the revision it was opened on, and the conflict shows", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let mode: "unverified" | "conflict" = "unverified";
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") return mode === "unverified" ? json({ error: "verification_required" }, 401) : conflict(mine(2, { revision: 5, body: "Edited elsewhere" }));
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = VERIFIED; return json(VERIFIED); }
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-composer-body"), "Reworded");
    await submit("guest-composer");
    // Someone else edits the note while the guest re-verifies; the notes read after it carries the new revision.
    notes = { [asset(10)]: [mine(2, { revision: 5, body: "Edited elsewhere" })] };
    mode = "conflict";
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    await submit("guest-composer");
    const patches = requests("PATCH");
    expect(patches.length).toBeGreaterThanOrEqual(2);
    expect(patches.at(-1)!.body).toEqual({ expectedRevision: 3, content: para("Reworded") });
    expect(byId("guest-composer-problem")?.textContent).toMatch(/changed/i);
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("Reworded");
  });

  it("a reply edit saved after the guest left and came back sends the revision it was opened on, and the conflict shows", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7()] }] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH"
      ? conflict({ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }) : undefined);
    await open();
    await click(button("Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Will do it");
    await click(button("All videos"));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }] };
    await click(button("Film 1"));
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 2, content: para("Will do it") });
    expect(byId("guest-note-edit-problem")?.textContent).toMatch(/changed/i);
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("Will do it");
    // The guest has now been shown the latest version; saving again is the acknowledgement and moves the base forward.
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH" ? json({ ...note(1), replies: [reply7({ revision: 5, body: "Will do it" })] }) : undefined);
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 4, content: para("Will do it") });
  });

  it("a reply edit whose text equals the body it started from is unchanged, even if the list body moved", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7()] }] };
    await open();
    await click(button("Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await click(button("All videos"));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }] };
    await click(button("Film 1"));
    await submit("guest-note-edit-form");
    expect(requests("PATCH")).toHaveLength(0);
    expect(byId("guest-note-edit-form")).toBeNull();
  });

  it("a reply that was saved while the guest was on All videos leaves no draft behind when the thread is reopened", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [note(1)] };
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(1)}/replies` && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          release = () => {
            const saved = { ...note(1), replies: [(({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do" }))] };
            notes[asset(10)] = [saved];
            resolve(json(saved, 201));
          };
        });
      }
      return undefined;
    };
    await open();
    await click(button("Film 1"));
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "Will do");
    await submit("guest-reply-form");
    await click(button("All videos"));
    await act(async () => { release(); });
    await flush();
    await click(button("Film 1"));
    expect(allById("guest-note-reply")).toHaveLength(1);
    expect(byId("guest-reply-form")).toBeNull();
  });

  it("a reply edit that was saved while the guest was on All videos leaves no edit draft behind", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7()] }] };
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          release = () => {
            const saved = { ...note(1), replies: [reply7({ revision: 3, body: "Done" })] };
            notes[asset(10)] = [saved];
            resolve(json(saved));
          };
        });
      }
      return undefined;
    };
    await open();
    await click(button("Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Done");
    await submit("guest-note-edit-form");
    await click(button("All videos"));
    await act(async () => { release(); });
    await flush();
    await click(button("Film 1"));
    expect(byId("guest-note-edit-form")).toBeNull();
    expect(allById("guest-note-body").map((item) => item.textContent)).toContain("Done");
  });
});

describe("the phone sheet composer (#879 PR 2: the pill strip, P2 / P6 / P7 as guest)", () => {
  beforeEach(async () => { await viewport.set({ width: 390, coarse: true }); });
  const area = () => byId("guest-composer-body") as HTMLTextAreaElement | null;
  const mode = () => byId("video-review-pane")!.getAttribute("data-mode");
  const fieldReady = async () => { await vi.waitFor(() => { expect(area()).not.toBeNull(); }); };
  const focusField = async () => { await act(async () => { area()!.focus(); }); await flush(2); };
  const blurField = async () => { await act(async () => { area()!.blur(); }); await flush(4); };
  /** A press the way a finger makes one: the pointerdown (whose default decides whether the focus moves), then the click. */
  const press = async (element: HTMLElement | null): Promise<boolean> => {
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => { element!.dispatchEvent(down); element!.click(); });
    await flush(2);
    return down.defaultPrevented;
  };

  it("a sent note is listed: the post clears the author and the search, which could hide it; the status stays (#879 PR 3b, S1)", async () => {
    notes = { [asset(10)]: [note(1), mine(2, { startFrame: 80 })] };
    extra = (url, init) => (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST" ? json(mine(5, { body: "Too dark here", startFrame: 50 }), 201) : undefined);
    const tap = async (element: HTMLElement) => { await act(async () => { element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); element.click(); }); await flush(2); };
    const radio = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.startsWith(name))!;
    const listed = () => allById("guest-note").map((row) => row.dataset.noteId);
    await open();
    await atSeconds(2);
    await fieldReady();
    await tap(byId("notes-filter-author")!);
    await tap(radio("Mia Chen"));
    expect(listed()).toEqual([noteId(1)]);
    await tap(byId("notes-filter-search")!);
    await typeInto(byId("notes-search-field"), "Trim");
    await flush(2);
    expect(listed()).toEqual([noteId(1)]);
    // The keyboard goes from the search field first (search mode puts the pill away), as on the phone.
    await act(async () => { byId("notes-search-field")!.blur(); });
    await flush(2);
    await focusField();
    await typeInto(area(), "Too dark here");
    await press(inBox("Post note"));
    await flush(4);
    expect(requests("POST")).toHaveLength(1);
    expect(byId("notes-search-field")).toBeNull();
    expect(byId("notes-filter-author")!.textContent).not.toContain("Mia Chen");
    expect(byId("notes-filter-status")!.textContent).toContain("Open");
    expect(listed()).toContain(noteId(5));
  });

  it("a verified guest's sheet ends in the box at rest (P1): chip and field, in/out, paperclip and pen, a round Post note; no Add a note, hint or Cancel", async () => {
    await open();
    await atSeconds(2);
    await fieldReady();
    const form = box()!;
    expect(form.closest('[data-sheet-part="composer"]')).not.toBeNull();
    expect(form.getAttribute("data-variant")).toBe("guest");
    expect(byId("guest-add-note")).toBeNull();
    expect(chip()!.textContent).toContain("00:00:02:00");
    for (const label of ["In and out points", "Add photos or videos", "Draw on the frame", "Post note"]) expect(inBox(label)).not.toBeNull();
    expect(off(inBox("Post note"))).toBe(true);
    expect([...form.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Cancel")).toBe(false);
    expect(byId("guest-composer-tray")).toBeNull();
    expect(byId("guest-composer-step-forward")).toBeNull();
    expect(area()!.getAttribute("placeholder")).toBe("Add a note…");
    expect(mode()).toBe("browse");
  });

  it("focus pauses the film and stamps the frame (P2, D10): compose mode, and the stamp holds while the film moves", async () => {
    await open();
    await atSeconds(2);
    await fieldReady();
    await focusField();
    expect(mode()).toBe("compose");
    expect(host.querySelector("video")!.paused).toBe(true);
    expect(chip()!.textContent).toContain("00:00:02:00");
    await atSeconds(4);
    await typeInto(area(), "Too dark");
    expect(chip()!.textContent).toContain("00:00:02:00");
  });

  it("blur keeps a draft with text (browse mode); a pristine draft is released, so the chip follows the film again", async () => {
    await open();
    await atSeconds(2);
    await fieldReady();
    await focusField();
    await typeInto(area(), "Keep me");
    await blurField();
    expect(mode()).toBe("browse");
    expect(area()!.value).toBe("Keep me");
    await atSeconds(4);
    expect(chip()!.textContent).toContain("00:00:02:00");
    await focusField();
    await typeInto(area(), "");
    await blurField();
    await atSeconds(5);
    expect(chip()!.textContent).toContain("00:00:05:00");
    expect(box()!.dataset.open).toBe("false");
  });

  it("the in/out button keeps the focus in the field on press (the keyboard stays up, P3), and marks a range", async () => {
    await open();
    await atSeconds(2);
    await fieldReady();
    await focusField();
    expect(await press(inBox("In and out points"))).toBe(true);
    expect(document.activeElement).toBe(area());
    await atSeconds(3);
    expect(chip()!.textContent).toMatch(/00:00:02:00 → 00:00:03:00/);
    expect(await press(inBox("In and out points"))).toBe(true);
    expect(byId("note-composer-chip-live")).toBeNull();
    expect(mode()).toBe("compose");
  });

  it("Post note is off while the note is empty; a post holds compose until it lands, then the box rests with the note listed (P5)", async () => {
    let answer: (response: Response) => void = () => undefined;
    let posted: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") { posted = JSON.parse(String(init.body)); return new Promise<Response>((resolve) => { answer = resolve; }); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    await fieldReady();
    await focusField();
    expect(off(inBox("Post note"))).toBe(true);
    await typeInto(area(), "Too dark here");
    expect(off(inBox("Post note"))).toBe(false);
    expect(await press(inBox("Post note"))).toBe(true);
    expect(posted).toEqual({ startFrame: 50, content: para("Too dark here") });
    await blurField();
    expect(mode()).toBe("compose");
    await act(async () => { answer(json(mine(5, { startFrame: 50 }), 201)); });
    await flush();
    expect(mode()).toBe("browse");
    expect(area()!.value).toBe("");
    expect(allById("guest-note")).toHaveLength(1);
  });

  it("a refused post keeps the draft and shows the problem in the box", async () => {
    extra = (url, init) => (url.endsWith("/notes") && init?.method === "POST" ? json({ error: "rate_limited" }, 429, { "retry-after": "30" }) : undefined);
    await open();
    await fieldReady();
    await focusField();
    await typeInto(area(), "Again");
    await press(inBox("Post note"));
    expect(byId("guest-composer-problem")!.getAttribute("role")).toBe("alert");
    expect(byId("guest-composer-problem")!.textContent).toContain("too quickly");
    expect(area()!.value).toBe("Again");
  });

  it("the pen blurs the field and puts the sheet in draw mode (P4); ‹ ends drawing and the field takes the focus back", async () => {
    await open();
    await atSeconds(2);
    await fieldReady();
    await focusField();
    await act(async () => { inBox("Draw on the frame")!.click(); });
    expect(document.activeElement).not.toBe(area());
    expect(mode()).toBe("draw");
    await atSeconds(2);
    expect(byId("note-draw-row")).not.toBeNull();
    await act(async () => { labelled("Done drawing")!.click(); });
    await flush(2);
    expect(byId("note-draw-row")).toBeNull();
    expect(document.activeElement).toBe(area());
    expect(mode()).toBe("compose");
  });

  it("Edit from ⋯ fills the pill inside the click: the field has the focus, the hint says Editing, Send is Save, and Save sends the patch", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let patched: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") { patched = JSON.parse(String(init.body)); return json(mine(2, { revision: 4, body: "Reworded" })); }
      return undefined;
    };
    await open();
    await fieldReady();
    await click(byId("guest-note-actions"));
    // Inside the click: the menu item takes no focus back after it (Base UI's list navigation refocuses a clicked item), and the menu closes.
    await act(async () => { menuItem("Edit")!.click(); });
    await flush();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(area()!.value).toBe("My note");
    expect(document.activeElement).toBe(area());
    expect(mode()).toBe("compose");
    expect(box()!.getAttribute("data-variant")).toBe("edit");
    // Owner decision 2026-10-20: the guest's edit shows no visibility label.
    expect(box()!.textContent).not.toMatch(/Client-visible|Internal/);
    await typeInto(area(), "Reworded");
    await press(button("Save") ?? null);
    expect(patched).toEqual({ expectedRevision: 3, content: para("Reworded") });
    expect(byId("guest-note-body")?.textContent).toBe("Reworded");
  });

  it("an unverified guest sees the pill's shell: a tap asks for verification, and the code lands them in a focused draft", async () => {
    session = ANON;
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = VERIFIED; return json(VERIFIED); }
      return undefined;
    };
    await open();
    expect(area()).toBeNull();
    const shell = byId("guest-compose-shell-open")!;
    expect(shell.getAttribute("aria-label")).toBe("Add a note");
    expect(off(inBox("Post note"))).toBe(true);
    await click(shell);
    expect(byId("guest-verify-dialog")).not.toBeNull();
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    await fieldReady();
    await vi.waitFor(() => { expect(document.activeElement).toBe(area()); });
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(mode()).toBe("compose");
    expect(box()!.dataset.open).toBe("true");
  });

  it("the identity and email-updates rows end the notes list's scroll; Copy my notes is a row of the ⋯ sheet", async () => {
    videos = [videoOf(1, [versionOf(11), versionOf(10)])];
    notes = { [asset(11)]: [note(1)] };
    session = { ...VERIFIED, notifications: { available: true, subscribed: false } } as GuestSessionResponse;
    await open();
    const list = byId("guest-notes-panel")!.querySelector('[data-slot="scroll-area"]') ?? byId("guest-notes-panel")!;
    expect(list.contains(byId("guest-identity"))).toBe(true);
    expect(byId("guest-paste-open")).toBeNull();
    await click(byId("video-header-menu"));
    expect(byId("guest-paste-open")).not.toBeNull();
  });

  // Fix round 2 (row 17): after the pen and ‹ the scrubber's thumb was gone: the transport came back from under the drawing row as a new subtree. The slider stays the one node.
  it("the scrubber's thumb is still drawn after pen → ‹ → blur, and the slider is the same node throughout", async () => {
    const restore = installSliderLayout();
    try {
      await open();
      await atSeconds(2);
      await fieldReady();
      expect(scrubberThumbShown()).toBe(true);
      const slider = byId("video-scrubber")!.querySelector('[data-slot="slider"]');
      await focusField();
      await act(async () => { inBox("Draw on the frame")!.click(); });
      await atSeconds(2);
      expect(byId("note-draw-row")).not.toBeNull();
      await act(async () => { labelled("Done drawing")!.click(); });
      await flush(2);
      expect(mode()).toBe("compose");
      await blurField();
      expect(mode()).toBe("browse");
      expect(byId("video-scrubber")!.querySelector('[data-slot="slider"]')).toBe(slider);
      expect(scrubberThumbShown()).toBe(true);
    } finally { restore(); }
  });

  const verifyWithHeldAnswer = () => {
    let answer: (() => void) | null = null;
    session = ANON;
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") return new Promise<Response>((resolve) => { answer = () => { session = VERIFIED; resolve(json(VERIFIED)); }; });
      return undefined;
    };
    return { release: async () => { await act(async () => { answer!(); }); await flush(); } };
  };
  const enterCode = async () => {
    await click(byId("guest-compose-shell-open"));
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    const code = byId("guest-verify-code") as HTMLInputElement;
    await act(async () => { code.focus(); });
    await typeInto(code, "123456");
    await flush(2);
    return code;
  };

  it("while the code is checked the code field keeps the focus (the keyboard stays up), and the answer hands the focus to the pill", async () => {
    const held = verifyWithHeldAnswer();
    await open();
    const code = await enterCode();
    expect(requests("POST").map((call) => call.url)).toContain(`${BASE}/email/verify`);
    expect(code.disabled).toBe(false);
    expect(document.activeElement).toBe(code);
    // Edits while the check is out are not taken.
    await typeInto(code, "1");
    expect(code.value).toBe("123456");
    await held.release();
    await fieldReady();
    await vi.waitFor(() => { expect(document.activeElement).toBe(area()); });
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(mode()).toBe("compose");
  });

  it("when the keyboard is already gone at the answer (the code field lost the focus), the guest lands at rest: no caret in the pill, no compose mode", async () => {
    const held = verifyWithHeldAnswer();
    await open();
    const code = await enterCode();
    await act(async () => { code.blur(); });
    await held.release();
    await fieldReady();
    await flush(4);
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(document.activeElement).not.toBe(area());
    expect(mode()).toBe("browse");
    expect(box()!.dataset.open).toBe("false");
    // One tap on the pill then starts the note as usual.
    await focusField();
    expect(mode()).toBe("compose");
  });

  // Fix round 1 (row 9, row 13): every state of the notes body scrolls in the one list, which ends where the pill's strip begins, so nothing sits behind the pinned pill.
  const listOf = () => byId("guest-notes-list");
  const expectScrolledAbovePill = () => {
    const list = listOf();
    expect(list).not.toBeNull();
    expect(list!.getAttribute("data-slot")).toBe("scroll-area");
    expect(list!.contains(byId("guest-identity"))).toBe(true);
    expect(list!.contains(byId("guest-subscription"))).toBe(true);
    // The quiet line (Released, the hints and notices) scrolls with the notes rather than taking its own fixed band; Request changes is a ⋯ row now, not a list row (#879 PR 3b).
    expect(list!.contains(byId("guest-quiet-line"))).toBe(true);
    expect(byId("guest-request-changes")).toBeNull();
    const strip = box()!;
    expect(list!.contains(strip)).toBe(false);
    // The strip's part is the list's sibling in the panel's column, laid out after it: the list ends where the strip's top border begins.
    const composer = strip.closest<HTMLElement>('[data-sheet-part="composer"]')!;
    expect(composer.parentElement).toBe(list!.closest('[data-sheet-part="body"]')!.parentElement);
    expect(composer.className.split(" ")).toContain("order-last");
    // The panel clips, so nothing overflowing its body can paint under the pill.
    expect(byId("guest-notes-panel")!.className).toContain("overflow-clip");
  };
  const withRows = () => { session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, approve: true } }, notifications: { available: true, subscribed: false } } as GuestSessionResponse; };

  it("with no notes, the empty state, the quiet line and the identity / email rows all scroll in the list above the pill", async () => {
    withRows();
    await open();
    await vi.waitFor(() => { expect(byId("guest-identity")).not.toBeNull(); });
    expect(listOf()!.textContent).toContain("No notes yet");
    expectScrolledAbovePill();
  });

  it("while the notes load, and when they fail, the rows still scroll in the list above the pill", async () => {
    withRows();
    let fail = false;
    extra = (url, init) => {
      if (/\/notes$/.test(url) && (init?.method ?? "GET") === "GET") return fail ? new Response("down", { status: 503 }) : new Promise<Response>(() => undefined);
      return undefined;
    };
    await open();
    await vi.waitFor(() => { expect(byId("guest-identity")).not.toBeNull(); });
    expect(listOf()!.textContent).toContain("Loading notes…");
    expectScrolledAbovePill();
    await act(async () => { root!.unmount(); });
    root = null; host.remove();
    fail = true;
    await open();
    await vi.waitFor(() => { expect(byId("guest-notes-unreachable")).not.toBeNull(); });
    expect(listOf()!.contains(byId("guest-notes-unreachable"))).toBe(true);
    expectScrolledAbovePill();
  });

  it("with notes, the cards and the rows share the one list", async () => {
    withRows();
    notes = { [asset(10)]: [mine(2)] };
    await open();
    await vi.waitFor(() => { expect(byId("guest-note")).not.toBeNull(); });
    expect(listOf()!.contains(byId("guest-note"))).toBe(true);
    expectScrolledAbovePill();
  });

  // Fix round 4 (design review): Delete read oxblood on ink (about 1.8:1); the inverse surface re-points only the tone text roles.
  it("the ⋯ menu's Delete reads the danger text role, not the oxblood fill", async () => {
    notes = { [asset(10)]: [mine(2)] };
    await open();
    await click(byId("guest-note-actions"));
    const del = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete")!;
    expect(del.className.split(" ")).toContain("text-destructive-wash-foreground");
    expect(del.className.split(" ")).not.toContain("text-destructive");
  });

  // Fix round 4: the list's 10px overlay scrollbar sat on the cards' right border (the list kept 4px at its end); the end gutter is now 12px, the start untouched.
  it("the notes list keeps a gutter for its scrollbar at the end only", async () => {
    notes = { [asset(10)]: [mine(2)] };
    await open();
    const grid = byId("guest-notes-list-body")!;
    expect(byId("guest-notes-list")!.contains(grid)).toBe(true);
    expect(grid.className.split(" ")).toContain("pe-[var(--space-3)]");
    expect(grid.className).not.toMatch(/(?:^|\s)(?:px|ps|pl)-/);
  });

  // Fix round 4: "Not you? Sign out" ended 10px short of the cards' right edge (the small button's trailing inset); in the notes pane it ends flush, at its full 44px height.
  it("the sign-out link in the notes pane ends flush with the cards, keeping its touch height", async () => {
    notes = { [asset(10)]: [mine(2)] };
    await open();
    const signOut = byId("guest-sign-out")!;
    expect(byId("guest-notes-list")!.contains(signOut)).toBe(true);
    expect(signOut.className.split(" ")).toContain("pe-0");
    expect(signOut.className.split(" ")).toContain("max-[721px]:min-h-11");
  });

  it("a note's ⋯ menu opens in the viewer's inverse scope, not on the light page", async () => {
    notes = { [asset(10)]: [mine(2)] };
    await open();
    await click(byId("guest-note-actions"));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(byId("guest-video-screen")!.contains(menu)).toBe(true);
    expect(menu.closest('[data-surface="inverse"]')).not.toBeNull();
  });
});

describe("delete revision", () => {
  const replyJson = (over: Partial<GuestNoteThreadDto>) => json({ ...mine(2, { revision: 5, ...over }), replies: [(({ replies: _replies, ...reply }) => reply)(mine(7, { parentId: noteId(2), startFrame: null, body: "Will do" }))] }, 201);

  it("sends the revision the confirm opened on, even when the list moves meanwhile", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}/replies` && init?.method === "POST") return replyJson({});
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE") return json({ thread: null });
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    // The list moves on while the confirm is open (another session's change arrives through a write answer).
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "Will do");
    await submit("guest-reply-form");
    expect(allById("guest-note-reply")).toHaveLength(1);
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE").at(-1)!.body).toEqual({ expectedRevision: 3 });
  });

  it("a delete conflict closes the confirm and shows the latest note, and deleting again sends that revision", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let deletes = 0;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE") {
        deletes += 1;
        return deletes === 1 ? json({ error: "note_conflict", thread: mine(2, { revision: 5, body: "Edited elsewhere" }) }, 409) : json({ thread: null });
      }
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE").at(-1)!.body).toEqual({ expectedRevision: 3 });
    expect(byId("guest-delete-dialog")).toBeNull();
    expect(byId("guest-note-problem")?.getAttribute("role")).toBe("alert");
    expect(byId("guest-note-body")?.textContent).toBe("Edited elsewhere");
    await click(byId("guest-note-actions"));
    await click(menuItem("Delete"));
    await click(byId("guest-delete-confirm"));
    expect(requests("DELETE").at(-1)!.body).toEqual({ expectedRevision: 5 });
    expect(byId("guest-delete-dialog")).toBeNull();
  });
});

describe("the video step keys and modals", () => {
  const keyFrom = async (target: Element, key: string) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await flush(); };
  it("keeps [ / ] out of the verify dialog, and still steps from the screen itself", async () => {
    session = ANON; videos = [videoOf(1), videoOf(2)];
    await open();
    await click(button("Film 1"));
    await click(byId("guest-compose-shell-open"));
    const dialog = document.body.querySelector('[role=dialog]');
    expect(dialog).not.toBeNull();
    const cancel = button("Cancel")!;
    expect(dialog!.contains(cancel)).toBe(true);
    await keyFrom(cancel, "]");
    expect(byId("guest-video-title")?.textContent).toBe("Film 1");
    // Close the dialog: the same key on the screen moves on to Film 2.
    await click(cancel);
    await keyDown("]");
    expect(byId("guest-video-title")?.textContent).toBe("Film 2");
  });
});

describe("rich notes (#835 C): pictures, no mentions", () => {
  const MEDIA = "44444444-4444-4444-8444-444444444444";
  const withImage = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }, { type: "image", attrs: { mediaId: MEDIA } }] });
  const props = (testId: string) => field.props.get(testId)!;
  const typed = async (testId: string, text: string) => { await typeInto(byId(testId), text); };
  const uploading = async (testId: string, busy: boolean) => { await act(async () => { props(testId).onUploadingChange!(busy); }); await flush(); };
  const post = () => inBox("Post note");
  const save = () => [...box()!.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Save") ?? null;

  it("every field (the composer, a reply, an edit) reads and uploads media through the link's own routes", async () => {
    notes = { [asset(10)]: [note(1), mine(2)] };
    await open();
    const transport = props("guest-composer-body").media as { mediaUrl: (id: string) => string; posterUrl: (id: string) => string; heicEnabled: boolean };
    expect(transport.mediaUrl(MEDIA)).toBe(`${BASE}/media/${MEDIA}`);
    expect(transport.posterUrl(MEDIA)).toBe(`${BASE}/media/${MEDIA}/poster`);
    expect(transport.heicEnabled).toBe(false);
    await click(allById("guest-note-reply-button")[0]);
    expect(props("guest-reply-body").media).toBe(transport);
  });

  it("holds Post while a picture is still uploading, and releases it when it lands", async () => {
    await open();
    await typed("guest-composer-body", "See the logo");
    expect(off(post())).toBe(false);
    await uploading("guest-composer-body", true);
    expect(off(post())).toBe(true);
    expect(post()!.getAttribute("title")).toBe("Wait for the upload to finish");
    await submit("guest-composer");
    expect(requests("POST")).toEqual([]);
    await uploading("guest-composer-body", false);
    expect(off(post())).toBe(false);
  });

  it("posts the document with its picture as content, and a picture alone is a note", async () => {
    let posted: unknown = null;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json(mine(5, { startFrame: 50 }), 201); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    await submit("guest-composer");
    expect(posted).toBeNull(); // nothing yet: an empty field is not a note
    await act(async () => { props("guest-composer-body").onChange(withImage("See the logo")); });
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, content: withImage("See the logo") });
    const only = { type: "doc", content: [{ type: "image", attrs: { mediaId: MEDIA } }] };
    await act(async () => { props("guest-composer-body").onChange(only); });
    expect(off(post())).toBe(false);
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, content: only });
  });

  it("holds Send reply and Save while their pictures upload", async () => {
    notes = { [asset(10)]: [note(1), mine(2)] };
    await open();
    await click(allById("guest-note-reply-button")[0]);
    await typed("guest-reply-body", "Will do");
    await uploading("guest-reply-body", true);
    expect(off(labelled("Send reply"))).toBe(true);
    await submit("guest-reply-form");
    expect(requests("POST")).toEqual([]);
    await uploading("guest-reply-body", false);
    expect(off(labelled("Send reply"))).toBe(false);
    await click(labelled("Close reply"));
    // A reply to the guest's own note is edited inline; the root is edited in the composer.
    await click(allById("guest-note-actions")[0]);
    await click(menuItem("Edit"));
    await typed("guest-composer-body", "Reworded");
    await uploading("guest-composer-body", true);
    expect(off(save())).toBe(true);
    await submit("guest-composer");
    expect(requests("PATCH")).toEqual([]);
  });

  it("an edit that adds a picture sends the document", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let patched: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH") { patched = JSON.parse(String(init.body)); return json(mine(2, { revision: 4 })); }
      return undefined;
    };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await act(async () => { props("guest-composer-body").onChange(withImage("My note")); });
    await submit("guest-composer");
    expect(patched).toEqual({ expectedRevision: 3, content: withImage("My note") });
  });
});

describe("collapsing the notes pane keeps its work (#859)", () => {
  let shim: ReturnType<typeof installLocalStorageShim>;
  beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); });
  afterEach(() => { shim.restore(); resetUiPrefMemory(); });
  const toggle = () => (byId("video-pane-show") ?? byId("video-pane-hide"))!;

  it("a reply that is in flight when the pane is collapsed still shows its failure when the pane is reopened", async () => {
    notes = { [asset(10)]: [note(1)] };
    let reject: () => void = () => undefined;
    extra = (url, init) => (url.endsWith("/replies") && init?.method === "POST" ? new Promise<Response>((resolve) => { reject = () => { resolve(json({ error: "server_error" }, 500)); }; }) : undefined);
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "On it");
    await submit("guest-reply-form");
    expect(off(labelled("Send reply"))).toBe(true);
    await click(toggle());
    expect(byId("video-review-pane")!.hidden).toBe(true);
    await act(async () => { reject(); });
    await flush();
    await click(toggle());
    expect(byId("video-review-pane")!.hidden).toBe(false);
    expect(byId("guest-reply-problem")).not.toBeNull();
    expect(byId("guest-reply-problem")!.textContent).not.toBe("");
  });

  it("an attachment still uploading when the pane is collapsed is still uploading (Send stays held) when it is reopened", async () => {
    notes = { [asset(10)]: [note(1)] };
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "See this");
    await act(async () => { field.props.get("guest-reply-body")!.onUploadingChange!(true); });
    expect(off(labelled("Send reply"))).toBe(true);
    await click(toggle());
    await click(toggle());
    expect(byId("guest-reply-form")).not.toBeNull();
    expect(off(labelled("Send reply"))).toBe(true);
    await act(async () => { field.props.get("guest-reply-body")!.onUploadingChange!(false); });
    expect(off(labelled("Send reply"))).toBe(false);
  });
});

describe("files on a guest's note (#956)", () => {
  const props = (testId: string) => field.props.get(testId)!;
  const failed = async (testId: string, count: number) => { await act(async () => { props(testId).onFailedFilesChange!(count); }); await flush(); };
  const post = () => inBox("Post note");
  type Files = { files: { url: (id: string) => string; maxPerPost: number; maxBytes: number } };

  it("every field (the composer, a reply, an edit) attaches through the link's own file routes, with the guest's limits", async () => {
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    await open();
    const transport = props("guest-composer-body").media as Files;
    expect(transport.files.url("f")).toBe(`${BASE}/attachments/f`);
    expect(transport.files).toMatchObject({ maxPerPost: 5, maxBytes: 25 * 1024 * 1024 });
    await click(byId("guest-note-reply-button"));
    expect(props("guest-reply-body").media).toBe(transport);
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(props("guest-note-edit-body").media).toBe(transport);
  });

  it("holds Post while a file has failed to upload, saying to retry or remove it, and releases it once none has", async () => {
    await open();
    await typeInto(byId("guest-composer-body"), "The brief");
    await failed("guest-composer-body", 1);
    expect(off(post())).toBe(true);
    expect(post()!.getAttribute("title")).toBe("Retry or remove the file that failed.");
    await submit("guest-composer");
    expect(requests("POST")).toEqual([]);
    await failed("guest-composer-body", 0);
    expect(off(post())).toBe(false);
  });

  it("holds Send reply and a reply's Save while a file has failed", async () => {
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    await open();
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "See this");
    await failed("guest-reply-body", 1);
    expect(off(labelled("Send reply"))).toBe(true);
    await failed("guest-reply-body", 0);
    expect(off(labelled("Send reply"))).toBe(false);

    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Done");
    await failed("guest-note-edit-body", 2);
    expect((byId("guest-note-edit-save") as HTMLButtonElement).disabled).toBe(true);
    await submit("guest-note-edit-form");
    expect(requests("PATCH")).toEqual([]);
    await failed("guest-note-edit-body", 0);
    expect((byId("guest-note-edit-save") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the time format on the guest page (#860)", () => {
  let shim: ReturnType<typeof installLocalStorageShim>;
  beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); });
  afterEach(() => { shim.restore(); resetUiPrefMemory(); });
  const trigger = () => document.querySelector<HTMLElement>('[data-testid="video-time-format-trigger"]')!;
  const choose = async (id: string) => {
    await act(async () => { trigger().click(); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    await act(async () => { document.querySelector<HTMLElement>(`[data-testid="video-time-format-${id}"]`)!.click(); await Promise.resolve(); });
    await flush();
  };

  it("offers the menu on the player; picking Frames rewrites the note anchors and the composer's anchor, and the choice is saved", async () => {
    notes = { [asset(10)]: [note(1, { startFrame: 50 })] };
    await open();
    await atSeconds(2);
    expect(trigger().getAttribute("aria-label")).toBe("Time format: Timecode");
    expect(byId("guest-note-anchor")!.textContent).toBe("00:00:02:00");
    await choose("frames");
    expect(byId("guest-note-anchor")!.textContent).toBe("50");
    expect(chip()!.textContent).toBe("Note at 50");
    expect(JSON.parse(shim.values.get(TIME_FORMAT_KEY)!)).toBe("frames");
  });

  it("a value written under the one browser-wide key (the staff viewer's) is what the guest shows", async () => {
    shim.values.set(TIME_FORMAT_KEY, JSON.stringify("standard"));
    notes = { [asset(10)]: [note(1, { startFrame: 50 })] };
    await open();
    expect(trigger().getAttribute("aria-label")).toBe("Time format: Standard");
    expect(byId("guest-note-anchor")!.textContent).toBe("0:02");
  });
});

describe("In / Out range handles and keys, no player button (#861, #927)", () => {
  const rangeButton = () => byId("video-range-button") as HTMLButtonElement | null;
  const handle = (kind: "in" | "out") => byId(`video-range-${kind}`);
  const keyOn = async (target: Element, k: string) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); await flush(); };

  it("there is no range button in the player, and with no draft the I key opens one at In (the box is always there, #927)", async () => {
    await open();
    expect(rangeButton()).toBeNull();
    expect(box()!.getAttribute("data-open")).toBe("false");
    await atSeconds(2);
    await keyDown("i");
    expect(box()!.getAttribute("data-open")).toBe("true");
    expect(chip()?.textContent).toContain("00:00:02:00 →");
  });

  it("the I and O keys set the range, and the chip and pending band follow", async () => {
    await open();
    await atSeconds(2);
    await keyDown("i");
    expect(rangeButton()).toBeNull();
    await atSeconds(4);
    await keyDown("o");
    expect(chip()?.textContent).toMatch(/00:00:02:00.*00:00:04:00/);
    expect(byId("video-pending-band")).not.toBeNull();
  });

  it("a handle moves one end and the POST carries the exclusive end frame", async () => {
    let posted: unknown = null;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json(mine(5, { startFrame: 51, endFrame: 101 }), 201); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    await keyDown("i");
    await atSeconds(4);
    await keyDown("o");
    await keyOn(handle("in")!, "ArrowRight");
    expect(chip()?.textContent).toMatch(/00:00:02:01.*00:00:04:00/);
    await typeInto(byId("guest-composer-body"), "Nudged");
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 51, endFrame: 101, content: para("Nudged") });
  });

  it("the range gives way to the pen while drawing: the box's in/out is behind the drawing row, and the player has no range button", async () => {
    await open();
    await atSeconds(2);
    await pen();
    await atSeconds(2);
    expect(byId("note-draw-row")).not.toBeNull();
    expect(inBox("In and out points")).toBeNull();
    expect(rangeButton()).toBeNull();
  });

  it("an In mark past the edit's Out clears the Out (the shipped crossing rule): Out follows the playhead again", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, endFrame: 101 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(rangeButton()).toBeNull();
    await atSeconds(5);
    await keyDown("i");
    expect(chip()?.textContent).toContain("00:00:05:00 →");
    expect(chip()?.textContent).not.toContain("00:00:04:00");
    expect(byId("note-composer-chip-live")).not.toBeNull();
  });

  it("a link that allows no comments has no range button", async () => {
    session = SESSION_OFF;
    await open();
    expect(rangeButton()).toBeNull();
  });
});
