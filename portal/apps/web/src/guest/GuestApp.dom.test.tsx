import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

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
  hasAudio: true, posterUrl: `/d/api/links/${LINK}/versions/${asset(n)}/poster`, streamUrl: `/d/api/links/${LINK}/versions/${asset(n)}/stream`, publicNoteCount: 0, ...over,
});
const videoOf = (n: number, over: Partial<GuestVideoDto> = {}): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions: [versionOf(n * 10)], ...over });
const note = (over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id: "22222222-2222-4222-8222-222222222222", parentId: null, author: { kind: "studio", name: "Mia Chen" }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "Trim the opening", deleted: false, resolved: false, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
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
  await act(async () => { root!.render(<GuestApp />); });
  await flush();
}
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim().startsWith(name) === true);
const click = async (element: Element | undefined) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const keyDown = async (key: string, target: Element = document.body) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await flush(); };
const title = () => byId("guest-video-title")?.textContent;
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

describe("the link fragment", () => {
  it("is scrubbed with replaceState before the first fetch, keeping path and query", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockImplementation(function (this: History, ...args) { log.push("replaceState"); return Object.getPrototypeOf(window.history).replaceState.apply(this, args); });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => { log.push("fetch"); return route(String(input), init); });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    window.history.pushState(null, "", `/d/review?link=${LINK}#t=tok123`); log.length = 0;
    await act(async () => { root!.render(<GuestApp />); });
    await flush();
    expect(log[0]).toBe("replaceState");
    expect(log).toContain("fetch");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe(`/d/review?link=${LINK}`);
    replace.mockRestore();
  });

  it("sends the token only in the exchange body", async () => {
    await open();
    const exchange = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST")!;
    expect(String(exchange[0])).toBe(`/d/api/links/${LINK}/session`);
    expect(JSON.parse(String((exchange[1] as RequestInit).body))).toEqual({ token: "tok123" });
    expect((exchange[1] as RequestInit).credentials).toBe("same-origin");
    expect(requests().some((url) => url.includes("tok123"))).toBe(false);
  });

  it("makes no request to the staff /api", async () => {
    await open();
    await click(button("Open Film 1"));
    expect(requests().length).toBeGreaterThan(0);
    expect(requests().filter((url) => url.startsWith("/api/") || url.includes("://") && new URL(url).pathname.startsWith("/api/"))).toEqual([]);
  });
});

describe("the four states", () => {
  it("asks for the passcode, shows a wrong one inline, and then opens the list", async () => {
    let attempts = 0;
    extra = (url, init) => {
      if (url !== `/d/api/links/${LINK}/session` || init?.method !== "POST") return undefined;
      const body = JSON.parse(String(init.body)) as { token: string; passcode?: string };
      attempts += 1;
      if (body.passcode === undefined) return json({ error: "passcode_required" }, 401);
      return body.passcode === "right-code" ? undefined : json({ error: "passcode_incorrect" }, 401);
    };
    await open();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.autocomplete).toBe("off");
    const type = async (value: string) => {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await click(button("Continue"));
    };
    await type("nope-nope");
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/isn't right/);
    await type("right-code");
    expect(attempts).toBe(3);
    expect(byId("guest-list")).not.toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("counts down a rate limit and disables the form", async () => {
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429) : undefined);
    // A 429 on the first exchange has no passcode yet, so it arrives once the passcode step is up.
    let first = true;
    const original = extra;
    extra = (url, init) => { if (url.endsWith("/session") && init?.method === "POST" && first) { first = false; return json({ error: "passcode_required" }, 401); } return original(url, init); };
    await open();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "abcdefg"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("Continue"));
    expect(host.textContent).toMatch(/30 seconds/);
    expect(button("Continue")!.disabled).toBe(true);
  });

  it("shows the one calm message when the exchange is the stub", async () => {
    extra = (url) => (url.endsWith("/session") ? stub404() : undefined);
    await open();
    expect(byId("guest-unavailable")?.textContent).toContain("This link isn't available.");
    expect(byId("guest-unavailable")?.textContent).toContain("Open the link from your email again, or ask the studio for a new one.");
  });

  it("shows it for a reload (no fragment) with no live session, and for a missing link id", async () => {
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
    await click(button("Notes"));
    expect(document.querySelector('[data-testid="guest-notes-drawer"][data-side="bottom"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Trim the opening");
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

  it("a markup read that returns 404 goes unavailable", async () => {
    notes = [drawn()];
    videos = [videoOf(1)];
    await open();
    extra = (url) => (url.includes("/markup") ? stub404() : undefined);
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
    expect(host.textContent).toMatch(/1 second/);
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

  it("a 5xx on the exchange shows the calm retry and repeats the exchange", async () => {
    let down = true;
    extra = (url, init) => (down && url.endsWith("/session") && init?.method === "POST" ? new Response("boom", { status: 503 }) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")?.textContent).toContain(CALM);
    down = false;
    await click(button("Try again"));
    expect(byId("guest-unreachable")).toBeNull();
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a network error on the resumed session shows it and retries the session read", async () => {
    let down = true;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => { if (down) throw new TypeError("network"); return route(String(input), init); });
    await open(`?link=${LINK}`, "");
    expect(byId("guest-unreachable")?.textContent).toContain(CALM);
    down = false;
    await click(button("Try again"));
    expect(byId("guest-list")).not.toBeNull();
  });

  it("a 5xx on the video list shows it and retries the list", async () => {
    let down = true;
    extra = (url) => (down && url.endsWith("/videos") ? new Response("boom", { status: 502 }) : undefined);
    await open();
    expect(byId("guest-unreachable")?.textContent).toContain(CALM);
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
