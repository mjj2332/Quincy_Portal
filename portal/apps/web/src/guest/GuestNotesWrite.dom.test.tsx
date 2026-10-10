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
const SESSION_OFF: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false } }, verified: false, email: null, name: null };
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
    const field = byId("guest-note-edit-body") as HTMLTextAreaElement;
    expect(field.value).toBe("My note");
    await typeInto(field, "Reworded");
    await submit("guest-note-edit-form");
    expect(patched).toEqual({ expectedRevision: 3, body: "Reworded" });
    expect(byId("guest-note-edit-form")).toBeNull();
    expect(byId("guest-note-body")?.textContent).toBe("Reworded");
  });
  it("on a revision conflict shows the latest, keeps the typed text, and says so", async () => {
    notes = { [asset(10)]: [mine(2, { revision: 3 })] };
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json({ error: "note_conflict", thread: mine(2, { revision: 5, body: "Edited elsewhere" }) }, 409) : undefined);
    await open();
    await click(byId("guest-note-actions"));
    await click(menuItem("Edit"));
    await typeInto(byId("guest-note-edit-body"), "My draft");
    await submit("guest-note-edit-form");
    expect((byId("guest-note-edit-body") as HTMLTextAreaElement).value).toBe("My draft");
    expect(byId("guest-note-edit-problem")?.textContent).toMatch(/changed/i);
    expect(byId("guest-note-edit-latest")?.textContent).toContain("Edited elsewhere");
    // Saving again uses the fresh revision.
    extra = (url, init) => (url === `${BASE}/notes/${noteId(2)}` && init?.method === "PATCH" ? json(mine(2, { revision: 6, body: "My draft" })) : undefined);
    await submit("guest-note-edit-form");
    expect(requests("PATCH").at(-1)!.body).toEqual({ expectedRevision: 5, body: "My draft" });
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
