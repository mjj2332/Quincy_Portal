import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";
import type { GuestApi } from "./guest-api";
import { GuestVideoScreen } from "./GuestVideoScreen";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea reads (same stub as App-project-sheet.dom.test.tsx).
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const SESSION = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false } }, verified: false, email: null, name: null };

const versionOf = (n: number, over: Record<string, unknown> = {}) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `/d/api/links/${LINK}/versions/${asset(n)}/poster`, streamUrl: `/d/api/links/${LINK}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null, ...over,
});
const videoOf = (n: number, over: Partial<GuestVideoDto> = {}): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions: [versionOf(n * 10)], ...over });
const note = (over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id: "22222222-2222-4222-8222-222222222222", parentId: null, author: { kind: "studio", name: "Mia Chen" }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "Trim the opening", deleted: false, resolved: false, revision: 1, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stub404 = () => new Response("Not found", { status: 404 });

let videos: GuestVideoDto[] = [];
let notes: GuestNoteThreadDto[] = [];
let extra: Handler | null = null;
let log: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;

function route(url: string, init: RequestInit | undefined): Response {
  const custom = extra?.(url, init);
  if (custom) return custom;
  const method = init?.method ?? "GET";
  const base = `/d/api/links/${LINK}`;
  if (url === `${base}/session`) return method === "POST" ? json(SESSION) : json(SESSION);
  if (url === `${base}/videos`) return json({ videos });
  if (url.startsWith(`${base}/versions/`) && url.endsWith("/notes")) return json({ notes });
  return stub404();
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
async function open(search = `?link=${LINK}`, hash = "#t=tok123") {
  window.history.replaceState(null, "", `/d/review${search}${hash}`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const token = new URLSearchParams(hash.slice(1)).get("t");
  await act(async () => { root!.render(<GuestApp token={token} />); });
  await flush();
}
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.getAttribute("aria-label")?.startsWith(`${name},`) === true || b.textContent?.trim().startsWith(name) === true);
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const keyDown = async (key: string, target: Element = document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await flush(); };
const title = () => byId("guest-video-title")?.textContent;
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
const requests = () => fetchMock.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 1440 });
  videos = [videoOf(1), videoOf(2), videoOf(3)]; notes = []; extra = null; log = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  window.history.replaceState(null, "", "/");
});

describe("the link token", () => {
  it("comes in as a prop and the page never reads location.hash", async () => {
    const posts: string[] = [];
    extra = (url, init) => { if (url.endsWith("/session") && init?.method === "POST") posts.push(String(init.body)); return undefined; };
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=hashtoken`);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<GuestApp token="proptoken" />); });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("proptoken");
    expect(posts[0]).not.toContain("hashtoken");
    expect(window.location.hash).toBe("#t=hashtoken");
  });

  it("shows unavailable for a reload with no token and no live session, and for a missing link id", async () => {
    extra = (url) => (url.endsWith("/session") ? stub404() : undefined);
    await open(`?link=${LINK}`, "");
    expect(byId("guest-unavailable")).not.toBeNull();
    expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
    await act(async () => { root!.unmount(); }); host.remove(); root = null; fetchMock.mockClear();
    await open("", "#t=abc");
    expect(byId("guest-unavailable")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes a session on reload with GET and lists the videos with their note counts", async () => {
    videos = [videoOf(1, { versions: [versionOf(10, { publicNoteCount: 4 })] }), videoOf(2, { premium: true, unlocked: false })];
    await open(`?link=${LINK}`, "");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/d/api/links/${LINK}/session`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    const rows = allById("guest-video-row");
    expect(rows.map((row) => row.querySelector('[data-testid="guest-row-title"]')?.textContent)).toEqual(["Film 1", "Film 2"]);
    expect(rows[0]!.textContent).toContain("Version 10");
    expect(rows[0]!.textContent).toContain("4 notes");
    expect(rows[1]!.textContent).toMatch(/premium/i);
    expect(byId("guest-row-slot")).not.toBeNull();
  });

  it("skips the list for a single video and opens it", async () => {
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-list")).toBeNull();
    expect(title()).toBe("Film 1");
    expect(host.querySelector("video")).not.toBeNull();
    expect(button("Next video")).toBeUndefined();
  });

  it("goes to the unavailable screen when a later read is the stub (a revoked link)", async () => {
    await open();
    extra = (url) => (url.endsWith("/videos") || url.endsWith("/notes") ? stub404() : undefined);
    await click(button("Open Film 1"));
    expect(byId("guest-unavailable")).not.toBeNull();
  });
});

describe("the video screen", () => {
  it("moves through the videos with Previous / Next and [ / ], without the list", async () => {
    await open();
    await click(button("Open Film 1"));
    expect(title()).toBe("Film 1");
    expect(button("Previous video")!.disabled).toBe(true);
    await click(button("Next video"));
    expect(title()).toBe("Film 2");
    expect(byId("guest-video-position")?.textContent).toBe("2 of 3");
    await keyDown("]");
    expect(title()).toBe("Film 3");
    await keyDown("]");
    expect(title()).toBe("Film 3");
    await keyDown("[");
    await keyDown("[");
    expect(title()).toBe("Film 1");
    expect(byId("guest-list")).toBeNull();
    // A key typed in a field is the field's.
    await click(button("All videos"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("lists the granted Versions only in the Version select", async () => {
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] })];
    await open();
    await click(byId("guest-version-trigger") ?? undefined);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? "");
    expect(options).toHaveLength(2);
    expect(options[0]).toMatch(/^v30/);
    expect(options[0]).toMatch(/latest/);
    expect(options[1]).toMatch(/^v10/);
    expect(options.some((text) => text.startsWith("v20"))).toBe(false);
  });

  it("draws the watermark only on a premium video that is not unlocked", async () => {
    await withLayout(async () => {
      videos = [videoOf(1, { premium: true, unlocked: false })];
      await open();
      expect(byId("guest-watermark")).not.toBeNull();
      expect(byId("guest-watermark")!.className).toContain("pointer-events-none");
      expect(byId("guest-watermark")!.getAttribute("aria-hidden")).toBe("true");
      await act(async () => { root!.unmount(); }); host.remove(); root = null;
      videos = [videoOf(1, { premium: true, unlocked: true })];
      await open();
      expect(byId("guest-watermark")).toBeNull();
      await act(async () => { root!.unmount(); }); host.remove(); root = null;
      videos = [videoOf(1)];
      await open();
      expect(byId("guest-watermark")).toBeNull();
    });
  });

  it("keeps the watermark inside the picture, not across the letterbox bands", async () => {
    await withLayout(async () => {
      videos = [videoOf(1, { premium: true, unlocked: false })];
      await open();
      const picture = byId("video-picture-box")!;
      const mark = byId("guest-watermark")!;
      const clip = mark.parentElement!;
      expect(clip.style.left).toBe(picture.style.left);
      expect(clip.style.top).toBe(picture.style.top);
      expect(clip.style.width).toBe(picture.style.width);
      expect(clip.style.height).toBe(picture.style.height);
      expect(clip.style.height).toBe("450px");
      expect(clip.className).toContain("overflow-hidden");
      expect(byId("video-stage")!.contains(clip)).toBe(true);
    });
  });

  it("shows the public notes read-only on a desktop", async () => {
    const { replies: _unused, ...rootFields } = note();
    void _unused;
    notes = [note({ replies: [{ ...rootFields, id: "33333333-3333-4333-8333-333333333333", parentId: "22222222-2222-4222-8222-222222222222", body: "Done", author: { kind: "guest", name: "Sam", self: false }, startFrame: null }] as never })];
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-panel")).not.toBeNull();
    const rows = allById("guest-note");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Trim the opening");
    expect(rows[0]!.textContent).toContain("Mia Chen");
    expect(rows[0]!.textContent).toContain("Sam");
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("puts the notes in a bottom drawer on a phone", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-panel")).toBeNull();
    const trigger = button("Notes")!;
    expect(trigger.getAttribute("aria-label")).toBe("Notes, 1");
    expect(trigger.textContent?.trim()).toBe("1");
    await click(trigger);
    const drawer = document.querySelector('[data-testid="guest-notes-drawer"][data-side="bottom"]')!;
    expect(drawer).not.toBeNull();
    expect(document.body.textContent).toContain("Trim the opening");
    const heading = drawer.querySelector<HTMLElement>('[data-testid="guest-notes-heading"]')!;
    expect(heading.textContent).toBe("Notes 1");
    const closes = drawer.querySelectorAll<HTMLElement>("button[aria-label^=\"Close\"]");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.getAttribute("data-testid")).toBe("guest-notes-close");
    await click(closes[0]!);
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="guest-notes-drawer"][data-open]')).toBeNull(); });
  });

  it("shows the notes count beside the desktop heading", async () => {
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    const count = byId("guest-notes-count")!;
    expect(count.textContent).toBe("1");
    expect(byId("guest-notes-heading")!.contains(count)).toBe(true);
  });
});

const sleep = (ms: number) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
const drawn = (over: Partial<GuestNoteThreadDto> = {}) => note({ startFrame: 50, endFrame: 100, drawingFrame: 75, hasMarkup: true, ...over });

describe("Sol round 1: a revoked link is noticed everywhere", () => {
  it("a stream error rechecks the session and goes unavailable when access is gone", async () => {
    videos = [videoOf(1)];
    await open();
    const video = host.querySelector("video")!;
    extra = (url, init) => (url.endsWith("/session") && (init?.method ?? "GET") === "GET" ? stub404() : undefined);
    await act(async () => { stub.fireError(video); });
    await flush();
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("a stream error with access still fine keeps the player's own message", async () => {
    videos = [videoOf(1)];
    await open();
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(host.textContent).toContain("This version can't play in this browser.");
  });

  it("a markup read that returns 404 with the session gone goes unavailable", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    await open();
    extra = (url, init) => (url.includes("/markup") || (url.endsWith("/session") && (init?.method ?? "GET") === "GET") ? stub404() : undefined);
    await click(host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined);
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("a 401 on a later read is the same unavailable screen", async () => {
    await open();
    extra = (url) => (url.endsWith("/videos") || url.endsWith("/notes") ? new Response("no", { status: 401 }) : undefined);
    await click(button("Open Film 1"));
    expect(byId("guest-unavailable")).not.toBeNull();
  });
});

describe("Sol round 1: selecting a drawing note seeks to the drawing frame", () => {
  it("seeks to drawingFrame (75 at 25fps = 3s), not startFrame, when the note has markup", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    await open();
    stub.writes.length = 0;
    await click(host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined);
    expect(stub.writes.at(-1)).toBeCloseTo(3, 1);
  });

  it("still seeks to startFrame (50 = 2s) for a note without markup", async () => {
    notes = [note({ startFrame: 50, endFrame: 100 })];
    videos = [videoOf(1)];
    await open();
    stub.writes.length = 0;
    await click(host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined);
    expect(stub.writes.at(-1)).toBeCloseTo(2, 1);
  });
});

describe("Sol round 1: an initial rate limit on an unprotected link", () => {
  it("shows a countdown and a token-only retry, never a passcode form", async () => {
    const bodies: unknown[] = [];
    let limited = true;
    extra = (url, init) => {
      if (!url.endsWith("/session") || init?.method !== "POST") return undefined;
      bodies.push(JSON.parse(String(init.body)));
      return limited ? json({ error: "too_many_attempts", retryAfterSeconds: 1 }, 429) : undefined;
    };
    videos = [videoOf(1), videoOf(2)];
    await open();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(byId("guest-limited")?.querySelector("strong")?.textContent).toBe("Too many attempts.");
    expect(byId("guest-limited")?.textContent).toMatch(/Try again in 1 second/);
    expect(button("Try again")!.disabled).toBe(true);
    await sleep(1200);
    expect(button("Try again")!.disabled).toBe(false);
    limited = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
    expect(bodies).toEqual([{ token: "tok123" }, { token: "tok123" }]);
  });
});

describe("Sol round 1: a transient failure is not 'unavailable'", () => {
  const CALM = "Couldn't reach Quincy. Check your connection and try again.";
  const HINT = "Check your connection and try again.";

  it("a 5xx on the exchange shows the calm retry and repeats the exchange", async () => {
    let down = true;
    extra = (url, init) => (down && url.endsWith("/session") && init?.method === "POST" ? new Response("boom", { status: 503 }) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")?.querySelector("strong")?.textContent).toBe("Couldn't reach Quincy.");
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
    down = false;
    await click(button("Try again"));
    expect(byId("guest-unreachable")).toBeNull();
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a network error on the resumed session shows it and retries the session read", async () => {
    let down = true;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => { if (down) throw new TypeError("network"); return route(String(input), init); });
    await open(`?link=${LINK}`, "");
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
    down = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a 5xx on the video list shows it and retries the list", async () => {
    let down = true;
    extra = (url) => (down && url.endsWith("/videos") ? new Response("boom", { status: 502 }) : undefined);
    await open();
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
    expect(byId("guest-unavailable")).toBeNull();
    down = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a 5xx on the notes keeps the video screen, says so in the panel and retries the notes", async () => {
    notes = [note()];
    videos = [videoOf(1)];
    let down = true;
    extra = (url) => (down && url.endsWith("/notes") ? new Response("boom", { status: 500 }) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(title()).toBe("Film 1");
    expect(byId("guest-notes-panel")?.textContent).toContain(CALM);
    down = false;
    await click(button("Try again"));
    expect(allById("guest-note")).toHaveLength(1);
  });
});

describe("Sol round 2", () => {
  it("selecting the same drawing note again retries a markup read that failed in transit", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    let down = true;
    let markupReads = 0;
    extra = (url) => { if (!url.includes("/markup")) return undefined; markupReads += 1; return down ? new Response("boom", { status: 503 }) : json({ noteId: "22222222-2222-4222-8222-222222222222", revision: 1, markup: [] }); };
    await open();
    const anchor = () => host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined;
    await click(anchor());
    expect(markupReads).toBe(1);
    down = false;
    await click(anchor());
    expect(markupReads).toBe(2);
  });

  const withPasscode = () => {
    extra = (url, init) => {
      if (!url.endsWith("/session") || init?.method !== "POST") return undefined;
      const body = JSON.parse(String(init.body)) as { passcode?: string };
      if (body.passcode === undefined) return json({ error: "passcode_required" }, 401);
      return body.passcode.length > 64 ? json({ error: "invalid" }, 400) : undefined;
    };
  };
  const typeIn = async (input: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); };

  it("limits the passcode field to GUEST_PASSCODE_MAX (64)", async () => {
    withPasscode();
    await open();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.maxLength).toBe(64);
  });

  it("keeps a 400 from the passcode exchange on the form with an inline error", async () => {
    withPasscode();
    await open();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    await typeIn(input, "x".repeat(65));
    await click(button("Continue"));
    expect(byId("guest-unavailable")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/passcode/i);
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });
});

describe("Sol round 4", () => {
  const STROKE = { color: "#ff0000", width: 3, points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] };
  const anchor = () => host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined;

  it("clears the drawing when a reselect is answered with markup: null", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    let answer: unknown = [STROKE];
    extra = (url) => (url.includes("/markup") ? json({ noteId: "22222222-2222-4222-8222-222222222222", revision: 1, markup: answer }) : undefined);
    await withLayout(async () => {
      await open();
      await click(anchor());
      const video = host.querySelector("video")!;
      stub.finishSeek(video);
      stub.presentFrame(video, 3);
      await flush();
      expect(allById("guest-markup-stroke")).toHaveLength(1);
      answer = null;
      await click(anchor());
      stub.finishSeek(video);
      stub.presentFrame(video, 3);
      await flush();
      expect(allById("guest-markup-stroke")).toHaveLength(0);
    });
  });

  it("K toggles play after a note is selected and focus sits on its anchor", async () => {
    notes = [note({ startFrame: 50, endFrame: 100 })];
    videos = [videoOf(1)];
    await open();
    await click(anchor());
    const target = anchor()!;
    target.focus();
    stub.calls.length = 0;
    await keyDown("k", target);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "k", bubbles: true })); });
    await flush();
    expect(stub.calls).toContain("play");
  });

  it("leaves J / K / L to a text field", async () => {
    notes = [note({ startFrame: 50, endFrame: 100 })];
    videos = [videoOf(1)];
    await open();
    const field = document.createElement("input");
    host.appendChild(field);
    stub.calls.length = 0;
    await keyDown("k", field);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "k", bubbles: true })); });
    expect(stub.calls).toHaveLength(0);
  });

  it("separates the Notes heading from its count for a screen reader", async () => {
    notes = [note(), note({ id: "33333333-3333-4333-8333-333333333333" })];
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-heading")?.textContent).toMatch(/^Notes\s+2$/);
  });

  it("marks a note that carries a drawing, and no other", async () => {
    notes = [drawn(), note({ id: "33333333-3333-4333-8333-333333333333" })];
    videos = [videoOf(1)];
    await open();
    expect(allById("guest-note-has-drawing")).toHaveLength(1);
    expect(byId("guest-note-has-drawing")?.closest('[data-testid="guest-note"]')?.getAttribute("data-note-id")).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("Sol round 6", () => {
  const HINT = "Check your connection and try again.";
  const brokenBody = () => { const response = json({}); Object.defineProperty(response, "json", { value: () => Promise.reject(new TypeError("connection dropped")) }); return response; };

  it("a body-read rejection on the resumed session is a retry screen, not unavailable", async () => {
    let broken = true;
    extra = (url, init) => (broken && url.endsWith("/session") && (init?.method ?? "GET") === "GET" ? brokenBody() : undefined);
    await open(`?link=${LINK}`, "");
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
    broken = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a body-read rejection on the exchange is a retry screen, not unavailable", async () => {
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? brokenBody() : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
  });

  it("a body-read rejection on the video list is a retry screen, not unavailable", async () => {
    let broken = true;
    extra = (url) => (broken && url.endsWith("/videos") ? brokenBody() : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")?.textContent).toContain(HINT);
    broken = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("control: a schema-invalid 200 on the video list is still unavailable", async () => {
    extra = (url) => (url.endsWith("/videos") ? json({ videos: "nope" }) : undefined);
    await open();
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("control: a schema-invalid 200 on the exchange is still unavailable", async () => {
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? json({ nope: true }) : undefined);
    await open();
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("a media error when the displayed Version is no longer granted leaves it, with a calm notice", async () => {
    videos = [videoOf(1), videoOf(2), videoOf(3)];
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button") ?? undefined);
    expect(title()).toBe("Film 1");
    videos = [videoOf(2), videoOf(3)];
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-video-screen")).toBeNull();
    expect(byId("guest-list")).not.toBeNull();
    expect(allById("guest-row-title").map((row) => row.textContent)).toEqual(["Film 2", "Film 3"]);
    expect(byId("guest-notice")).not.toBeNull();
    expect(byId("guest-unavailable")).toBeNull();
  });

  it("a media error when one Video remains goes to it with a notice", async () => {
    videos = [videoOf(1), videoOf(2)];
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button") ?? undefined);
    videos = [videoOf(2)];
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(title()).toBe("Film 2");
    expect(byId("guest-notice")).not.toBeNull();
  });

  it("a media error when nothing is granted any more is unavailable", async () => {
    videos = [videoOf(1)];
    await open();
    videos = [];
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("control: a media error with the Version still granted keeps the player's error and the screen", async () => {
    videos = [videoOf(1)];
    notes = [note()];
    await open();
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(title()).toBe("Film 1");
    expect(byId("guest-notice")).toBeNull();
    expect(allById("guest-note")).toHaveLength(1);
    expect(host.textContent).toContain("This version can't play in this browser.");
  });
});

describe("Sol round 7", () => {
  const broken = (status: number) => { const response = json({}, status); Object.defineProperty(response, "json", { value: () => Promise.reject(new TypeError("connection dropped")) }); return response; };
  const pickVersion = async (prefix: string) => {
    await click(byId("guest-version-trigger") ?? undefined);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith(prefix)));
  };
  /** Holds every GET /videos until `release()`, then answers it from `videos`. */
  const gateVideos = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/videos")) await gate;
      return route(String(input), init);
    });
    return release;
  };

  it("a 401 whose body cannot be read is a retry screen, not unavailable", async () => {
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? broken(401) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")).not.toBeNull();
  });

  it("a 429 whose body cannot be read is a retry screen, not unavailable", async () => {
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? broken(429) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")).not.toBeNull();
  });

  it("a media error on a removed Version A, then switching to granted B before the recheck resolves, keeps B playing", async () => {
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] })];
    await open();
    await pickVersion("v10");
    const release = gateVideos();
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    await pickVersion("v30");
    videos = [videoOf(1, { versions: [versionOf(30)] })];
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-list")).toBeNull();
    expect(byId("guest-notice")).toBeNull();
    expect(byId("guest-version-trigger")?.textContent).toMatch(/^v30/);
  });

  it("a recheck that resolves after the screen unmounted changes nothing and warns nothing", async () => {
    videos = [videoOf(1)];
    const onGrantsChanged = vi.fn();
    const onUnavailable = vi.fn();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api: GuestApi = {
      exchange: async () => ({ ok: false, reason: "unavailable" }),
      session: async () => { await gate; return { kind: "gone" }; },
      videos: async () => { await gate; return { kind: "ok", value: [] }; },
      notes: async () => ({ kind: "ok", value: [] }),
      markup: async () => ({ kind: "gone" }),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<GuestVideoScreen api={api} videos={videos} index={0} onIndex={() => undefined} onBack={null} onUnavailable={onUnavailable} onGrantsChanged={onGrantsChanged} />); });
    await flush();
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { release(); });
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(onGrantsChanged).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("Sol round 9: a deleted drawing note does not take the link down", () => {
  const anchor = () => host.querySelector<HTMLElement>('[data-testid="guest-note-anchor"]') ?? undefined;
  const noteReads = () => requests().filter((url) => url.endsWith("/notes")).length;
  it("markup 404 with the session and grant still valid stays on the video, clears the overlay and refetches the notes", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    await withLayout(async () => {
      await open();
      expect(allById("guest-note")).toHaveLength(1);
      const before = noteReads();
      notes = [];
      extra = (url) => (url.includes("/markup") ? stub404() : undefined);
      await click(anchor());
      expect(byId("guest-unavailable")).toBeNull();
      expect(byId("guest-video-screen")).not.toBeNull();
      expect(byId("guest-markup")).toBeNull();
      expect(noteReads()).toBe(before + 1);
      expect(allById("guest-note")).toHaveLength(0);
    });
  });

  it("markup 404 when the displayed Version is no longer granted takes the grants-changed path", async () => {
    notes = [drawn()];
    videos = [videoOf(1), videoOf(2)];
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button") ?? undefined);
    videos = [videoOf(2)];
    extra = (url) => (url.includes("/markup") ? stub404() : undefined);
    await click(anchor());
    expect(title()).toBe("Film 2");
    expect(byId("guest-notice")).not.toBeNull();
    expect(byId("guest-unavailable")).toBeNull();
  });

  it("a markup 404 that resolves after the guest switched Version is ignored", async () => {
    notes = [drawn()];
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] })];
    await open();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/markup")) { await gate; return stub404(); }
      return route(String(input), init);
    });
    await click(anchor());
    await click(byId("guest-version-trigger") ?? undefined);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v10")));
    // Were the late answer acted on, the gone session would end the page.
    extra = (url, init) => (url.endsWith("/session") && (init?.method ?? "GET") === "GET" ? stub404() : undefined);
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-video-screen")).not.toBeNull();
  });
});

describe("Sol round 10: a deleted-drawing recovery does not clear a newer selection", () => {
  it("selecting deleted drawing A, then valid drawing B before A's recheck resolves, keeps B selected with its overlay", async () => {
    const A = "22222222-2222-4222-8222-22222222222a";
    const B = "22222222-2222-4222-8222-22222222222b";
    const stroke = { color: "#ff0000", width: 3, points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] };
    notes = [drawn({ id: A }), drawn({ id: B, startFrame: 60 })];
    videos = [videoOf(1)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    extra = (url) => {
      if (url.includes(`/notes/${A}/markup`)) return stub404();
      if (url.includes(`/notes/${B}/markup`)) return json({ noteId: B, revision: 1, markup: [stroke] });
      return undefined;
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (hold && url.endsWith("/session") && (init?.method ?? "GET") === "GET") await gate;
      return route(url, init);
    });
    await withLayout(async () => {
      await open();
      hold = true;
      const anchors = () => allById("guest-note-anchor");
      await click(anchors()[0]);
      await click(anchors()[1]);
      await act(async () => { release(); });
      await flush();
      const video = host.querySelector("video")!;
      stub.finishSeek(video);
      stub.presentFrame(video, 3);
      await flush();
      expect(allById("guest-note").find((n) => n.getAttribute("data-note-id") === B)?.getAttribute("data-selected")).toBe("true");
      expect(allById("guest-markup-stroke")).toHaveLength(1);
    });
  });
});
