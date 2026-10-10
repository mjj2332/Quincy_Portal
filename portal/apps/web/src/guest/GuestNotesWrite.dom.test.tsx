import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const noteId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const SESSION_OFF: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false, markup: true } }, verified: false, email: null, name: null };
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
const button = (label: string) => [...document.body.querySelectorAll<HTMLElement>("button")].find((item) => item.getAttribute("aria-label")?.startsWith(label) || item.textContent?.trim() === label);
const keyDown = async (key: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await flush(); };
const menuItem = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
/** Puts the film on `seconds` (25 fps), as the browser would after a seek. */
async function atSeconds(seconds: number) {
  const video = host.querySelector("video")!;
  await act(async () => { stub.finishSeek(video); stub.presentFrame(video, seconds); });
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

describe("Add a note", () => {
  it("is not offered when the link does not allow comments", async () => {
    session = SESSION_OFF;
    await open();
    expect(byId("guest-add-note")).toBeNull();
  });
  it("opens the verify dialog for a guest who has not verified, and no composer", async () => {
    session = ANON;
    await open();
    await click(byId("guest-add-note"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-composer")).toBeNull();
  });
  it("opens the composer for a verified guest", async () => {
    await open();
    await click(byId("guest-add-note"));
    expect(byId("guest-composer")).not.toBeNull();
    expect(byId("guest-verify-dialog")).toBeNull();
  });
  it("verifies by email code, then lands in the composer, and later writes still work on the rotated session", async () => {
    session = ANON;
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = VERIFIED; return json(VERIFIED); }
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") return json(mine(5, { startFrame: 0 }), 201);
      return undefined;
    };
    await open();
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    expect(requests("POST").map((call) => call.url)).toEqual([`${BASE}/email/code`, `${BASE}/email/verify`]);
    expect(requests("POST")[1]!.body).toEqual({ code: "123456", name: "Sam" });
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-composer")).not.toBeNull();
    await typeInto(byId("guest-composer-body"), "After verifying");
    await submit("guest-composer");
    expect(allById("guest-note")).toHaveLength(1);
  });
});

describe("the composer", () => {
  it("posts a point note at the frame on screen when opened, adds it to the list and closes", async () => {
    let posted: unknown = null;
    extra = (url, init) => {
      if (url === `${BASE}/versions/${asset(10)}/notes` && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json(mine(5, { startFrame: 50 }), 201); }
      return undefined;
    };
    await open();
    await atSeconds(2);
    await click(byId("guest-add-note"));
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:02:00");
    await typeInto(byId("guest-composer-body"), "  Too dark here ");
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, body: "Too dark here" });
    expect(byId("guest-composer")).toBeNull();
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
    await click(byId("guest-add-note"));
    await atSeconds(4);
    await click(byId("guest-composer-mark-out"));
    expect(byId("guest-composer-anchor")?.textContent).toMatch(/00:00:02:00.*00:00:04:00/);
    await typeInto(byId("guest-composer-body"), "Cut this section");
    await submit("guest-composer");
    expect(posted).toEqual({ startFrame: 50, endFrame: 101, body: "Cut this section" });
  });
  it("marking an in again moves the start, and clears an out that falls before it", async () => {
    await open();
    await atSeconds(2);
    await click(byId("guest-add-note"));
    await atSeconds(4);
    await click(byId("guest-composer-mark-out"));
    await atSeconds(6);
    await click(byId("guest-composer-mark-in"));
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:06:00");
    expect(byId("guest-composer-anchor")?.textContent).not.toMatch(/00:00:04:00/);
  });
  it("will not post an empty note", async () => {
    await open();
    await click(byId("guest-add-note"));
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(0);
    expect(byId("guest-composer-problem")?.textContent).toMatch(/write a note/i);
  });
  it("cancel closes it without posting", async () => {
    await open();
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "never mind");
    await click(byId("guest-composer-cancel"));
    expect(byId("guest-composer")).toBeNull();
    expect(requests("POST")).toHaveLength(0);
  });
  it("sends one post for a double submit while the first is in flight", async () => {
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; });
      return undefined;
    };
    await open();
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "once");
    await submit("guest-composer");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    await act(async () => { release(); });
    await flush();
    expect(allById("guest-note")).toHaveLength(1);
  });
  it("disables Mark in and Mark out while the post is pending, so a seek cannot change what the success clears", async () => {
    let release: () => void = () => undefined;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") return new Promise<Response>((resolve) => { release = () => { resolve(json(mine(5), 201)); }; });
      return undefined;
    };
    await open();
    await atSeconds(2);
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "once");
    await submit("guest-composer");
    await atSeconds(4);
    expect((byId("guest-composer-mark-in") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("guest-composer-mark-out") as HTMLButtonElement).disabled).toBe(true);
    await click(byId("guest-composer-mark-in"));
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:02:00");
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
    await click(byId("guest-add-note"));
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

  it("pauses on the frame, shows the pen, and posts the drawing with its frame on a point note that follows it", async () => {
    let posted: Record<string, unknown> | null = null;
    extra = (url, init) => {
      if (url.endsWith("/notes") && init?.method === "POST") { posted = JSON.parse(String(init.body)) as Record<string, unknown>; return json(mine(5, { startFrame: 50, hasMarkup: true, drawingFrame: 50 }), 201); }
      return undefined;
    };
    await withLayout(async () => {
      await open();
      await atSeconds(1);
      await click(byId("guest-add-note"));
      await atSeconds(2);
      await click(byId("guest-composer-draw"));
      await atSeconds(2);
      expect(byId("guest-markup-toolbar")).not.toBeNull();
      expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:02:00");
      const layer = byId("guest-draft-layer")!;
      await draw(layer);
      expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
      await click(byId("guest-markup-done"));
      expect(byId("guest-markup-toolbar")).toBeNull();
      expect(byId("guest-composer-drawing")).not.toBeNull();
      await typeInto(byId("guest-composer-body"), "Look here");
      await submit("guest-composer");
    });
    expect(posted).toMatchObject({ startFrame: 50, body: "Look here", drawingFrame: 50 });
    expect((posted as unknown as { markup: unknown[] }).markup).toHaveLength(1);
  });
  it("keeps Draw enabled and pressed while drawing, and pressing it again finishes the drawing like Done; Post stays disabled meanwhile", async () => {
    await withLayout(async () => {
      await open();
      await atSeconds(2);
      await click(byId("guest-add-note"));
      await click(byId("guest-composer-draw"));
      await atSeconds(2);
      const drawButton = byId("guest-composer-draw") as HTMLButtonElement;
      expect(byId("guest-markup-toolbar")).not.toBeNull();
      expect(drawButton.getAttribute("aria-pressed")).toBe("true");
      expect(drawButton.disabled).toBe(false);
      expect((byId("guest-composer-post") as HTMLButtonElement).disabled).toBe(true);
      await click(drawButton);
      expect(byId("guest-markup-toolbar")).toBeNull();
      expect((byId("guest-composer-draw") as HTMLButtonElement).getAttribute("aria-pressed")).toBe("false");
      expect((byId("guest-composer-post") as HTMLButtonElement).disabled).toBe(false);
    });
  });
  it("gives the composer's note field a placeholder", async () => {
    await open();
    await click(byId("guest-add-note"));
    expect(byId("guest-composer-body")?.getAttribute("placeholder")).toBe("Add a note at this frame…");
  });
  it("can take the drawing off again before posting", async () => {
    await withLayout(async () => {
      await open();
      await atSeconds(2);
      await click(byId("guest-add-note"));
      await click(byId("guest-composer-draw"));
      await atSeconds(2);
      await draw(byId("guest-draft-layer")!);
      await click(byId("guest-markup-done"));
      await click(byId("guest-composer-remove-drawing"));
      expect(byId("guest-composer-drawing")).toBeNull();
    });
  });
  it("redraws the drawing of a note being edited, sending the strokes with the note's drawing frame", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, hasMarkup: true, drawingFrame: 50 })) : undefined);
    await withLayout(async () => {
      await open();
      await click(byId("guest-note-actions"));
      await click(menuItem("Edit"));
      await click(byId("guest-composer-draw"));
      await atSeconds(2);
      await draw(byId("guest-draft-layer")!);
      await click(byId("guest-markup-done"));
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
        await click(byId("guest-composer-draw"));
        await atSeconds(2);
        expect(allById("guest-markup-stroke")).toHaveLength(0);
        await draw(byId("guest-draft-layer")!);
        await click(byId("guest-markup-done"));
        await atSeconds(2);
        expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
        expect(allById("guest-markup-stroke")).toHaveLength(0);
      });
    });
    it("a drawing history never crosses frames: draw at A, undo all, Done, draw at B, and Redo has nothing to bring back", async () => {
      await withLayout(async () => {
        await open();
        await atSeconds(2);
        await click(byId("guest-add-note"));
        await click(byId("guest-composer-draw"));
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        expect(allById("guest-draft-stroke").length).toBeGreaterThan(0);
        await click(button("Undo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
        await click(byId("guest-markup-done"));
        await atSeconds(4);
        await click(byId("guest-composer-draw"));
        await atSeconds(4);
        expect((button("Redo") as HTMLButtonElement).disabled).toBe(true);
        await click(button("Redo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
      });
    });
    it("a drawing history never crosses drafts: draw, undo all, Cancel, start a new draft on another frame, press Draw, and Redo is disabled", async () => {
      await withLayout(async () => {
        await open();
        await atSeconds(2);
        await click(byId("guest-add-note"));
        await click(byId("guest-composer-draw"));
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        await click(button("Undo"));
        expect(allById("guest-draft-stroke")).toHaveLength(0);
        await click(byId("guest-markup-done"));
        await click(byId("guest-composer-cancel"));
        await atSeconds(4);
        await click(byId("guest-add-note"));
        await click(byId("guest-composer-draw"));
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
        await click(byId("guest-composer-draw"));
        await atSeconds(2);
        await draw(byId("guest-draft-layer")!);
        await click(byId("guest-markup-done"));
        await submit("guest-composer");
        await atSeconds(2);
        expect(byId("guest-composer")).toBeNull();
        expect(markupReads).toBe(2);
        expect(allById("guest-markup-stroke")).toHaveLength(1);
        expect(byId("guest-markup")?.innerHTML).toContain("0.9");
      });
    });
  });
  it("does not offer Draw when the link's markup part is off, and the composer still posts text", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    await open();
    await click(byId("guest-add-note"));
    expect(byId("guest-composer")).not.toBeNull();
    expect(byId("guest-composer-draw")).toBeNull();
  });
  it("offers no drawing controls when editing a note either (even removing one would be refused)", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(byId("guest-composer-draw")).toBeNull();
    expect(byId("guest-composer-remove-drawing")).toBeNull();
  });
});

describe("refusals on a post", () => {
  const post = async () => {
    await open();
    await click(byId("guest-add-note"));
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
    expect(byId("guest-add-note")).toBeNull();
    expect(byId("guest-composer")).toBeNull();
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
    expect(patched).toEqual({ expectedRevision: 3, body: "Reworded" });
    expect(byId("guest-composer")).toBeNull();
    expect(byId("guest-note-body")?.textContent).toBe("Reworded");
  });
  it("sends nothing when an edit changed nothing", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await submit("guest-composer");
    expect(requests("PATCH")).toHaveLength(0);
    expect(byId("guest-composer")).toBeNull();
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
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 5, body: "My draft" });
  });
  it("re-marks the frames of a note without a drawing, sending only the frames", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, startFrame: 100, endFrame: 151 })) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:02:00");
    await atSeconds(4);
    await click(byId("guest-composer-mark-in"));
    await atSeconds(6);
    await click(byId("guest-composer-mark-out"));
    await submit("guest-composer");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 3, startFrame: 100, endFrame: 151 });
  });
  it("takes a drawing off a note, locking the frames while it has one", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3, startFrame: 50, hasMarkup: true, drawingFrame: 50 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 4, hasMarkup: false })) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    expect((byId("guest-composer-mark-in") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("guest-composer-mark-out") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("guest-composer-drawing")?.textContent).toMatch(/has a drawing/i);
    await click(byId("guest-composer-remove-drawing"));
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
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 2, body: "Done" });
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
    expect(requests("POST").at(-1)).toEqual({ url: `${BASE}/notes/${noteId(1)}/replies`, body: { body: "Will do" } });
    expect(allById("guest-note-reply")).toHaveLength(1);
    expect(byId("guest-reply-form")).toBeNull();
  });
  it("keeps a reply draft when the phone drawer closes and opens again", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = { [asset(10)]: [note(1)] };
    await open();
    await click(button("Notes"));
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "half written");
    await click(byId("guest-notes-close"));
    expect(byId("guest-reply-form")).toBeNull();
    await click(button("Notes"));
    expect((byId("guest-reply-body") as HTMLTextAreaElement | null)?.value).toBe("half written");
  });
  it("keeps a reply edit draft across the list unmounting, and drops it on cancel", async () => {
    await viewport.set({ width: 390, coarse: true });
    const reply = (({ replies: _replies, ...rest }) => rest)(mine(7, { parentId: noteId(1), startFrame: null, body: "Will do", revision: 2 }));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply] }] };
    await open();
    await click(button("Notes"));
    const menus = allById("guest-note-actions");
    await click(menus[0]);
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Will do it");
    await click(byId("guest-notes-close"));
    await click(button("Notes"));
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement | null)?.value).toBe("Will do it");
    await click(byId("guest-note-edit-cancel"));
    await click(byId("guest-notes-close"));
    await click(button("Notes"));
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
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "first");
    await submit("guest-composer");
    expect(posts).toBe(1);
    await pick("v10");
    await pick("v11");
    await click(byId("guest-add-note"));
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
    await click(byId("guest-add-note"));
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
    await click(byId("guest-add-note"));
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
    await click(button("Open Film 1"));
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "maybe sent");
    await submit("guest-composer");
    await click(button("All videos"));
    await click(button("Open Film 2"));
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
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "x");
    await submit("guest-composer");
    expect(byId("guest-composer-problem")?.textContent).toMatch(/couldn.t be saved/i);
    expect(reads()).toBe(before);
  });

  it("I and O mark the in and out frames while a composer is open, and do nothing otherwise", async () => {
    await open();
    await atSeconds(2);
    await keyDown("i");
    await click(byId("guest-add-note"));
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:02:00");
    await atSeconds(4);
    await keyDown("o");
    expect(byId("guest-composer-anchor")?.textContent).toMatch(/00:00:02:00.*00:00:04:00/);
    await atSeconds(6);
    await keyDown("i");
    expect(byId("guest-composer-anchor")?.textContent).toContain("00:00:06:00");
    expect(byId("guest-composer-anchor")?.textContent).not.toMatch(/00:00:04:00/);
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
    await click(button("Open Film 1"));
    await click(byId("guest-add-note"));
    await typeInto(byId("guest-composer-body"), "slow");
    await submit("guest-composer");
    expect(requests("POST")).toHaveLength(1);
    await click(button("All videos"));
    await click(button("Open Film 1"));
    await click(byId("guest-add-note"));
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
    expect(patches.at(-1)!.body).toEqual({ expectedRevision: 3, body: "Reworded" });
    expect(byId("guest-composer-problem")?.textContent).toMatch(/changed/i);
    expect((byId("guest-composer-body") as HTMLTextAreaElement).value).toBe("Reworded");
  });

  it("a reply edit saved after the guest left and came back sends the revision it was opened on, and the conflict shows", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7()] }] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH"
      ? conflict({ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }) : undefined);
    await open();
    await click(button("Open Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Will do it");
    await click(button("All videos"));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }] };
    await click(button("Open Film 1"));
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 2, body: "Will do it" });
    expect(byId("guest-note-edit-problem")?.textContent).toMatch(/changed/i);
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("Will do it");
    // The guest has now been shown the latest version; saving again is the acknowledgement and moves the base forward.
    extra = (url, init) => (url === `${BASE}/notes/${noteId(7)}` && init?.method === "PATCH" ? json({ ...note(1), replies: [reply7({ revision: 5, body: "Will do it" })] }) : undefined);
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 4, body: "Will do it" });
  });

  it("a reply edit whose text equals the body it started from is unchanged, even if the list body moved", async () => {
    videos = [videoOf(1), videoOf(2)];
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7()] }] };
    await open();
    await click(button("Open Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await click(button("All videos"));
    notes = { [asset(10)]: [{ ...note(1), replies: [reply7({ revision: 4, body: "Edited elsewhere" })] }] };
    await click(button("Open Film 1"));
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
    await click(button("Open Film 1"));
    await click(byId("guest-note-reply-button"));
    await typeInto(byId("guest-reply-body"), "Will do");
    await submit("guest-reply-form");
    await click(button("All videos"));
    await act(async () => { release(); });
    await flush();
    await click(button("Open Film 1"));
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
    await click(button("Open Film 1"));
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "Done");
    await submit("guest-note-edit-form");
    await click(button("All videos"));
    await act(async () => { release(); });
    await flush();
    await click(button("Open Film 1"));
    expect(byId("guest-note-edit-form")).toBeNull();
    expect(allById("guest-note-body").map((item) => item.textContent)).toContain("Done");
  });
});

describe("the phone drawer", () => {
  beforeEach(async () => { await viewport.set({ width: 390, coarse: true }); });
  const drawer = () => document.querySelector('[data-testid="guest-notes-drawer"][data-open]');
  it("closes when the composer opens, so the picture is visible, and stays closed until the guest opens it", async () => {
    await open();
    // The drawer is where Add a note lives on a phone.
    await click(button("Notes"));
    expect(drawer()).not.toBeNull();
    await click(byId("guest-add-note"));
    expect(byId("guest-composer")).toBeNull();
    expect(drawer()).toBeNull();
    await click(button("Notes"));
    expect(byId("guest-composer")).not.toBeNull();
  });
  it("opens again once the draft is posted or cancelled", async () => {
    await open();
    await click(button("Notes"));
    await click(byId("guest-add-note"));
    expect(drawer()).toBeNull();
    await click(button("Notes"));
    await click(byId("guest-composer-cancel"));
    expect(byId("guest-composer")).toBeNull();
    expect(drawer()).not.toBeNull();
  });
});

describe("delete revision", () => {
  const replyJson = (over: Partial<GuestNoteThreadDto>) => json({ ...mine(2, { revision: 5, ...over }), replies: [(({ replies: _replies, ...reply }) => reply)(mine(7, { parentId: noteId(2), startFrame: null, body: "Will do" }))] }, 201);

  it("sends the revision the confirm opened on, even when the list moves meanwhile, and a conflict shows before the base moves", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    let deletes = 0;
    extra = (url, init) => {
      if (url === `${BASE}/notes/${noteId(2)}/replies` && init?.method === "POST") return replyJson({});
      if (url === `${BASE}/notes/${noteId(2)}` && init?.method === "DELETE") {
        deletes += 1;
        return deletes === 1 ? json({ error: "note_conflict", thread: mine(2, { revision: 5, body: "Edited elsewhere" }) }, 409) : json({ thread: null });
      }
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
    expect(byId("guest-delete-dialog")).not.toBeNull();
    expect(byId("guest-delete-problem")).not.toBeNull();
    // Having seen the conflict, confirming again is the acknowledgement: the base moves forward.
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
    await click(button("Open Film 1"));
    await click(byId("guest-add-note"));
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
