import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSocialOverlay, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { installLocalStorageShim } from "../testing/local-storage";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { REVIEW_PANE_KEY } from "../lib/review-pane-prefs";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { GuestApp } from "./GuestApp";
import { createGuestMediaTransport, type GuestApi } from "./guest-api";
import { GuestVideoScreen } from "./GuestVideoScreen";
import { createGuestWriter } from "./use-guest-writer";
import { createGuestDrafts } from "./guest-drafts";
import { createGuestSubscription } from "./guest-subscription";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea reads (same stub as App-project-sheet.dom.test.tsx).
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const SESSION = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false, markup: true } }, verified: false, email: null, name: null, notifications: null, media: { heic: false } };

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
let socialOverlays: GuestSocialOverlay[] = [];
let notes: GuestNoteThreadDto[] = [];
/** The `download-policy` answer; null is the stub (an old Worker or a failed read). */
let policy: { codeRequired: boolean } | null = { codeRequired: true };
let extra: Handler | null = null;
let log: string[] = [];
/** True: this visitor holds no session yet, so a GET on the session is the stub until an exchange lands. Resume-first (ADR 0023) makes that the precondition of every exchange test. */
let sessionGone = false;
let fetchMock: ReturnType<typeof vi.fn>;
let stub: VideoElementStub;
let viewport: MockViewport;
let shim: ReturnType<typeof installLocalStorageShim>;
let root: Root | null = null;
let host: HTMLElement;

function route(url: string, init: RequestInit | undefined): Response {
  const custom = extra?.(url, init);
  if (custom) return custom;
  const method = init?.method ?? "GET";
  const base = `/d/api/links/${LINK}`;
  if (url === `${base}/session`) { if (method === "POST") { sessionGone = false; return json(SESSION); } return sessionGone ? stub404() : json(SESSION); }
  if (url === `${base}/videos`) return json({ videos });
  if (url === `${base}/social-overlays`) return json({ socialOverlays });
  if (url === `${base}/download-policy`) return policy === null ? stub404() : json(policy);
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
  // A desktop element has its data by now: without it the clock holds every seek back (video-frame-clock.dom.test.tsx).
  await act(async () => { for (const video of host.querySelectorAll("video")) stub.loadData(video, 4); });
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
  shim = installLocalStorageShim(); resetUiPrefMemory();
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 1440 });
  videos = [videoOf(1), videoOf(2), videoOf(3)]; socialOverlays = []; notes = []; policy = { codeRequired: true }; extra = null; log = []; sessionGone = false;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore(); shim.restore();
  window.history.replaceState(null, "", "/");
});

describe("the link token", () => {
  it("comes in as a prop and the page never reads location.hash", async () => {
    sessionGone = true;
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

  it("resumes a session on reload with GET and lists poster-first tiles: Version, duration, title and the open-note count only (#884)", async () => {
    videos = [videoOf(1, { versions: [versionOf(10, { publicNoteCount: 4 })] }), videoOf(2, { premium: true, unlocked: false })];
    await open(`?link=${LINK}`, "");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/d/api/links/${LINK}/session`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    const rows = allById("guest-video-row");
    expect(rows.map((row) => row.querySelector('[data-testid="guest-row-title"]')?.textContent)).toEqual(["Film 1", "Film 2"]);
    expect(rows[0]!.querySelector('[data-testid="guest-video-row-version"]')?.textContent).toBe("v10");
    expect(rows[0]!.textContent).toContain("2:00");
    expect(rows[0]!.querySelector('[data-testid="guest-video-row-open-notes"]')?.textContent).toBe("4");
    expect(document.getElementById(rows[0]!.querySelector('[data-testid="guest-row-title"]')!.getAttribute("aria-describedby")!)!.textContent).toContain("4 open notes on v10");
    expect(rows[1]!.querySelector('[data-testid="guest-video-row-open-notes"]')).toBeNull();
    expect(rows[1]!.textContent).toMatch(/premium/i);
  });

  it("gives a guest tile no tick, no menu, no status, and only the open control as a button (#884, story 32)", async () => {
    videos = [videoOf(1, { versions: [versionOf(10, { decision: { value: "approved", revision: 1, at: "2026-10-09T01:00:00.000Z", self: false }, released: true })] }), videoOf(2)];
    await open(`?link=${LINK}`, "");
    const row = allById("guest-video-row")[0]!;
    expect(row.querySelector('input[type="checkbox"]')).toBeNull();
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["guest-row-title"]);
    expect(row.querySelector('[data-testid="guest-video-row-status"]')).toBeNull();
    expect(row.querySelector('[data-testid="guest-decision-chip"]')).toBeNull();
    expect(row.querySelector('[data-testid="guest-released-chip"]')).toBeNull();
    expect(row.textContent).not.toMatch(/in review|approved|released/i);
  });

  it("a tap anywhere on a tile opens that film's screen (#884, story 33)", async () => {
    videos = [videoOf(1), videoOf(2)];
    await open(`?link=${LINK}`, "");
    await click(allById("guest-row-title")[1]!);
    expect(byId("guest-video-screen")).not.toBeNull();
  });

  it("opens no default-scope panel on the guest video screen (ADR 0024)", async () => {
    videos = [videoOf(1, { versions: [versionOf(10)] })];
    await open(`?link=${LINK}`, "");
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(document.querySelector('[data-surface="default"]')).toBeNull();
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
    await click(button("Film 1"));
    expect(byId("guest-unavailable")).not.toBeNull();
  });
});

describe("a Delivery deep link (#847)", () => {
  const posts = () => fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST" && String(call[0]).endsWith("/session"));
  async function openDeep(videoId: string | null, token: string | null = "tok123", pageSlug: string | null = null) {
    window.history.replaceState(null, "", `/d/review?link=${LINK}`);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<GuestApp token={token} initialVideoId={videoId} pageSlug={pageSlug} />); });
    await flush();
  }

  it("with a live session, resumes first (no exchange) and opens that film WITHOUT asking an unverified guest for a code (D34: watching needs none)", async () => {
    await openDeep(vid(2));
    expect(posts()).toHaveLength(0);
    expect(title()).toBe("Film 2");
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
  });

  it("still asks for the code when the guest approves or writes a note", async () => {
    extra = (url) => (url === `/d/api/links/${LINK}/session` ? json({ ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, approve: true, comments: true } } }) : undefined);
    videos = [videoOf(1, { versions: [versionOf(10, { released: false })] })];
    await openDeep(vid(1));
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
    await click(byId("guest-approve") ?? undefined);
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(1);
  });

  describe("Back to the Delivery page (D34)", () => {
    const PAGE = "14-harbour-st-mosman-d234xz";
    it("is a native link to /d/<slug> naming the film on screen (so the page returns to its tile), not a button, and survives without any history call", async () => {
      const push = vi.spyOn(window.history, "pushState"); const replace = vi.spyOn(window.history, "replaceState");
      replace.mockClear();
      await openDeep(vid(2), "tok123", PAGE);
      const back = byId("guest-back-to-page") as HTMLAnchorElement;
      expect(back.tagName).toBe("A"); expect(back.getAttribute("href")).toBe(`/d/${PAGE}#v=${vid(2)}`);
      expect(push).not.toHaveBeenCalled();
    });
    it("is absent when the link was not opened from a Delivery page", async () => {
      await openDeep(vid(2));
      expect(byId("guest-back-to-page")).toBeNull();
    });
    it("follows the film on screen when the viewer moves to another one", async () => {
      await openDeep(vid(1), "tok123", PAGE);
      await click(button("Next video"));
      expect(title()).toBe("Film 2");
      expect(byId("guest-back-to-page")!.getAttribute("href")).toBe(`/d/${PAGE}#v=${vid(2)}`);
    });
    it("is on the film list too, where a reload lands (no film in the address), so the page is still one tap away", async () => {
      await openDeep(null, null, PAGE);
      expect(byId("guest-list")).not.toBeNull();
      const back = byId("guest-back-to-page") as HTMLAnchorElement;
      expect(back.tagName).toBe("A"); expect(back.getAttribute("href")).toBe(`/d/${PAGE}`);
    });
  });

  it("opens the film's newest granted Version, which the list gives first", async () => {
    videos = [videoOf(1), videoOf(2, { versions: [versionOf(22, { version: 2 }), versionOf(21, { version: 1 })] })];
    await openDeep(vid(2));
    expect(title()).toBe("Film 2");
    expect(host.textContent).toContain("v2 · latest");
  });

  it("does not open the verify dialog for an already verified session", async () => {
    const verified = { ...SESSION, verified: true, email: "a@b.co", name: "A" };
    extra = (url) => (url === `/d/api/links/${LINK}/session` ? json(verified) : undefined);
    await openDeep(vid(3));
    expect(title()).toBe("Film 3");
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
  });

  it("exchanges the token only when there is no session to resume", async () => {
    let gone = true;
    extra = (url, init) => {
      if (url !== `/d/api/links/${LINK}/session`) return undefined;
      if ((init?.method ?? "GET") === "GET") return gone ? stub404() : undefined;
      gone = false; return undefined;
    };
    await openDeep(vid(1));
    expect(posts()).toHaveLength(1);
    expect(title()).toBe("Film 1");
  });

  it("a token with no film in the fragment resumes a live session first, with no exchange (the staff-copied Delivery link, ADR 0023)", async () => {
    await openDeep(null);
    expect(posts()).toHaveLength(0);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/d/api/links/${LINK}/session`);
    expect(allById("guest-video-row")).toHaveLength(3);
  });

  it("a token with no film exchanges when the session is gone, and a passcode link still asks for the passcode", async () => {
    let gone = true;
    extra = (url, init) => {
      if (url !== `/d/api/links/${LINK}/session`) return undefined;
      if ((init?.method ?? "GET") === "GET") return gone ? stub404() : undefined;
      return json({ error: "passcode_required" }, 401);
    };
    await openDeep(null);
    expect(posts()).toHaveLength(1);
    expect(byId("guest-passcode")).not.toBeNull();
    gone = false;
  });

  it("a film that is no longer on the link shows a calm notice and the list", async () => {
    await openDeep(vid(9));
    expect(byId("guest-notice")?.textContent).toContain("no longer available");
    expect(allById("guest-video-row")).toHaveLength(3);
  });

  it("an ordinary link with no session to resume exchanges the token and lands on the list", async () => {
    sessionGone = true;
    await openDeep(null);
    expect(posts()).toHaveLength(1);
    expect(allById("guest-video-row")).toHaveLength(3);
    expect(byId("guest-notice")).toBeNull();
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
  });
});

describe("the video screen", () => {
  it("moves through the videos with Previous / Next and [ / ], without the list", async () => {
    await open();
    await click(button("Film 1"));
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

  it("portals the Version select popup inside the inverse scope (#877)", async () => {
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] })];
    await open();
    await click(byId("guest-version-trigger") ?? undefined);
    const option = document.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.closest('[data-surface="inverse"]')).not.toBeNull();
  });

  it("keeps the phone sheet and its Versions and action sheets inside the inverse scope (#877, #879)", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    expect(byId("video-review-pane")!.closest('[data-surface="inverse"]')).not.toBeNull();
    await click(byId("video-version-chip") ?? undefined);
    expect(byId("video-versions-sheet")!.closest('[data-surface="inverse"]')).not.toBeNull();
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

  it("puts the notes in a sheet under the film on a phone: the list is mounted, with its count in the head, and no drawer or Notes button", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-panel")).not.toBeNull();
    expect(byId("video-review-pane")!.getAttribute("data-stop")).toBe("half");
    expect(byId("guest-notes-drawer")).toBeNull();
    expect(byId("guest-notes-heading")!.getAttribute("role")).toBe("tab");
    expect(byId("guest-notes-heading")!.closest("[role=tablist]")).not.toBeNull();
    expect(host.querySelectorAll("[role=tab]")).toHaveLength(1);
    // The list's own height utility out-ranks a plain one, so the phone height is forced; the underline sits on the list's bottom edge.
    expect(byId("guest-notes-heading")!.closest("[role=tablist]")!.className).toContain("max-[721px]:!h-11");
    expect(byId("guest-notes-heading")!.className).toContain("max-[721px]:after:!bottom-0");
    expect(document.body.textContent).toContain("Trim the opening");
    expect(byId("guest-notes-heading")!.textContent).toBe("Notes 1 open");
  });

  it("shows the notes count beside the desktop heading", async () => {
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    const count = byId("guest-notes-count")!;
    expect(count.textContent).toBe("1");
    expect(byId("guest-notes-heading")!.contains(count)).toBe(true);
  });

  // The count is the open notes (#879 PR 2, owner decision): resolved roots and empty tombstones do not count, a tombstone that kept its replies does, replies never do. Shown at 0.
  const openFixture = () => {
    const { replies: _unused, ...rootFields } = note();
    void _unused;
    const reply = { ...rootFields, id: "44444444-4444-4444-8444-444444444444", parentId: "22222222-2222-4222-8222-222222222222", startFrame: null, body: "Reply" };
    return [
      note({ replies: [reply] as never }),
      note({ id: "55555555-5555-4555-8555-555555555555", resolved: true }),
      note({ id: "66666666-6666-4666-8666-666666666666", deleted: true, body: "", replies: [{ ...reply, parentId: "66666666-6666-4666-8666-666666666666" }] as never }),
      note({ id: "77777777-7777-4777-8777-777777777777", deleted: true, body: "" }),
    ];
  };
  it("counts open notes on the phone tab", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = openFixture();
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-count")!.textContent).toBe("2");
    expect(byId("guest-notes-heading")!.textContent).toBe("Notes 2 open");
  });
  it("counts open notes beside the desktop heading, and shows 0", async () => {
    notes = openFixture();
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-count")!.textContent).toBe("2");
  });
  it("shows 0 when every note is resolved", async () => {
    notes = [note({ resolved: true })];
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-notes-count")!.textContent).toBe("0");
  });
});

describe("the notes pane (#859)", () => {
  /** ⇥ is in the pane (mounted even when collapsed), ⇤ in the strip (only while collapsed): whichever is the live control. */
  const toggle = () => byId("video-pane-show") ?? byId("video-pane-hide");
  /** The pane when it is showing; a collapsed pane stays mounted but hidden (`mountedPane`). */
  const mountedPane = () => byId("video-review-pane");
  const pane = () => { const el = mountedPane(); return el && !el.hidden ? el : null; };
  const handle = () => byId("video-review-handle");
  const now = (el: Element) => Number(el.getAttribute("aria-valuenow"));
  const press = async (target: Element, key: string, init: KeyboardEventInit = {}) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); }); };
  const saved = () => JSON.parse(shim.values.get(REVIEW_PANE_KEY) ?? "null") as { open: boolean; width: number } | null;

  it("opens at 360px with the toggle expanded and the notes in the pane", async () => {
    videos = [videoOf(1)];
    await open();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(pane()!.querySelector('[data-testid="guest-notes-panel"]')).not.toBeNull();
    expect(now(handle()!)).toBe(360);
    expect(pane()!.style.getPropertyValue("--review-pane-w")).toBe("360px");
  });

  it("puts ⇥ in the pane's heading row, none in the top bar, and a strip with ⇤ once collapsed (#877 S2)", async () => {
    videos = [videoOf(1)];
    await open();
    const hide = byId("video-pane-hide")!;
    expect(hide.getAttribute("aria-label")).toBe("Hide notes");
    expect(byId("guest-notes-heading")!.parentElement!.contains(hide)).toBe(true);
    expect(byId("guest-bar")!.contains(hide)).toBe(false);
    expect(byId("video-review-strip")).toBeNull();
    await click(hide);
    expect(byId("video-review-strip")!.contains(byId("video-pane-show"))).toBe(true);
    expect(byId("video-pane-show")!.getAttribute("aria-label")).toBe("Show notes");
    expect(document.activeElement).toBe(byId("video-pane-show"));
    await click(byId("video-pane-show")!);
    expect(document.activeElement).toBe(byId("video-pane-hide"));
  });

  it("the bar is one truncating line; Approve and the other deliveries sit in their own row under it (#877 S2)", async () => {
    videos = [videoOf(1)];
    await open();
    const title = byId("guest-video-title")!;
    expect(title.className).toContain("truncate");
    expect(title.getAttribute("title")).toBe(title.textContent);
    expect(byId("guest-bar")!.className).toContain("flex-nowrap");
    expect(byId("guest-bar")!.contains(byId("guest-delivery"))).toBe(false);
  });

  it("a phone gets the shared header: Back (icon), the title with the Version chip, no Select, no prev/next, and no delivery row: its parts are the ⋯ rows and the quiet line (#879 PR 3b)", async () => {
    await viewport.set({ width: 390, coarse: true });
    videos = [videoOf(1)];
    await open();
    const bar = byId("review-phone-bar")!;
    expect(bar).not.toBeNull();
    expect(byId("guest-bar")).toBeNull();
    expect(byId("guest-version-trigger")).toBeNull();
    expect(byId("video-version-chip")!.textContent).toMatch(/^v\d+/);
    expect(byId("guest-delivery")).toBeNull();
    expect(byId("video-review-pane")!.contains(byId("guest-quiet-line"))).toBe(true);
    expect(byId("guest-video-title")!.textContent).toBeTruthy();
  });

  it("the toggle collapses and restores the pane without remounting the film, and saves the choice", async () => {
    videos = [videoOf(1)];
    await open();
    const film = host.querySelector("video");
    await click(toggle()!);
    expect(pane()).toBeNull();
    expect(mountedPane()!.hidden).toBe(true);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("video")).toBe(film);
    expect(saved()).toEqual({ open: false, width: 360 });
    await click(toggle()!);
    expect(pane()).not.toBeNull();
    expect(host.querySelector("video")).toBe(film);
  });

  it("keyboard on the handle resizes and persists across a remount, and never steps the film", async () => {
    videos = [videoOf(1)];
    await open();
    const writes = stub.writes.length;
    const h = handle()!;
    await act(async () => { h.focus(); });
    await press(h, "ArrowLeft", { shiftKey: true });
    expect(now(handle()!)).toBe(424);
    await press(h, "ArrowRight");
    expect(now(handle()!)).toBe(408);
    expect(stub.writes.length).toBe(writes);
    expect(saved()).toEqual({ open: true, width: 408 });
    await act(async () => { root!.unmount(); }); root = null; host.remove();
    await open();
    expect(now(handle()!)).toBe(408);
  });

  it("shares one key with the staff viewer: a collapsed choice made there is collapsed here", async () => {
    shim.values.set(REVIEW_PANE_KEY, JSON.stringify({ open: false, width: 520 }));
    videos = [videoOf(1)];
    await open();
    expect(pane()).toBeNull();
    await click(toggle()!);
    expect(now(handle()!)).toBe(520);
  });

  it("collapsing with focus in the pane moves focus to the toggle", async () => {
    videos = [videoOf(1)];
    await open();
    const panel = byId("guest-notes-panel")!;
    await act(async () => { panel.focus(); });
    expect(pane()!.contains(document.activeElement)).toBe(true);
    await click(toggle()!);
    expect(document.activeElement).toBe(toggle());
  });

  it("choosing a marker while the pane is collapsed opens it on the notes", async () => {
    shim.values.set(REVIEW_PANE_KEY, JSON.stringify({ open: false, width: 360 }));
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    expect(pane()).toBeNull();
    const marker = host.querySelector<HTMLElement>("[data-marker-id]")!;
    expect(marker).not.toBeNull();
    // The lane picks the nearest marker by x within its box: give the box a width (happy-dom has no layout) and press at the marker's frame (50 of 3000).
    const lane = marker.parentElement!;
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 3000, bottom: 12, width: 3000, height: 12, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { lane.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 50 })); });
    expect(pane()).not.toBeNull();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("a phone keeps the sheet: no toggle and no resize handle", async () => {
    await viewport.set({ width: 390, coarse: true });
    videos = [videoOf(1)];
    await open();
    expect(toggle()).toBeNull();
    expect(handle()).toBeNull();
    expect(pane()).not.toBeNull();
  });

  it("puts notices and the video screen in one bounded column, so a notice shortens the screen instead of overflowing", async () => {
    videos = [videoOf(1)];
    await open();
    const screen = byId("guest-video-screen")!;
    const column = screen.parentElement!;
    expect(column.getAttribute("data-testid")).toBe("guest-column");
    expect(column.className).toContain("h-dvh");
    expect(column.className).toContain("flex-col");
    expect(screen.className).toContain("flex-1");
    expect(screen.className).toContain("min-h-0");
    expect(screen.className).not.toContain("min-[721px]:h-dvh");
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
    await click(button("Film 1"));
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
    sessionGone = true;
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
    sessionGone = true;
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
    sessionGone = true;
    withPasscode();
    await open();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.maxLength).toBe(64);
  });

  it("keeps a 400 from the passcode exchange on the form with an inline error", async () => {
    sessionGone = true;
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
    expect(byId("guest-notes-heading")?.textContent).toMatch(/^Notes\s+2 open$/);
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
    sessionGone = true;
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
    sessionGone = true;
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
    sessionGone = true;
    extra = (url, init) => (url.endsWith("/session") && init?.method === "POST" ? broken(401) : undefined);
    await open();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-unreachable")).not.toBeNull();
  });

  it("a 429 whose body cannot be read is a retry screen, not unavailable", async () => {
    sessionGone = true;
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
      endSession: async () => "ok",
      videos: async () => { await gate; return { kind: "ok", value: [] }; },
      socialOverlays: async () => ({ kind: "ok", value: [] }),
      downloadPolicy: async () => ({ codeRequired: true }),
      versionSummaries: async () => ({ kind: "gone" }),
      notes: async () => ({ kind: "ok", value: [] }),
      markup: async () => ({ kind: "gone" }),
      sendCode: async () => ({ ok: false, reason: "gone" }),
      verifyCode: async () => ({ ok: false, reason: "gone" }),
      createNote: async () => ({ kind: "gone" }),
      replyToNote: async () => ({ kind: "gone" }),
      editNote: async () => ({ kind: "gone" }),
      deleteNote: async () => ({ kind: "gone" }),
      setSubscription: async () => ({ kind: "gone" }),
      previewPaste: async () => ({ kind: "gone" }),
      commitPaste: async () => ({ kind: "gone" }),
      decide: async () => ({ kind: "gone" }),
      downloads: async () => ({ kind: "gone" }),
      prepareDownloads: async () => ({ kind: "gone" }),
      media: createGuestMediaTransport(LINK),
      downloadAllUrl: `/d/api/links/${LINK}/downloads/all.zip`,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<GuestVideoScreen api={api} verify={{ request: () => undefined }} writer={createGuestWriter()} drafts={createGuestDrafts()} subscription={createGuestSubscription()} session={SESSION} onSession={() => undefined} archived={false} onArchived={() => undefined} socialOverlays={[]} videos={videos} index={0} onIndex={() => undefined} onBack={null} onUnavailable={onUnavailable} onGrantsChanged={onGrantsChanged} onDecided={() => undefined} onResyncDelivery={() => undefined} onShownVersion={() => undefined} />); });
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

describe("#776 E: a removed Version's stream 404 refreshes the list", () => {
  const pickVersion = async (prefix: string) => {
    await click(byId("guest-version-trigger") ?? undefined);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith(prefix)));
  };
  const versionOptions = async () => {
    await click(byId("guest-version-trigger") ?? undefined);
    const labels = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? "");
    await click(byId("guest-version-trigger") ?? undefined);
    return labels;
  };

  it("after a stream error the picker no longer offers a Version the studio removed meanwhile, and nothing is announced", async () => {
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] })];
    await open();
    expect((await versionOptions()).some((label) => label.startsWith("v10"))).toBe(true);
    videos = [videoOf(1, { versions: [versionOf(30)] })];
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-notice")).toBeNull();
    expect((await versionOptions()).some((label) => label.startsWith("v10"))).toBe(false);
  });

  it("when the shown Version is the one removed, the guest lands on what is still granted with the studio's notice", async () => {
    videos = [videoOf(1, { versions: [versionOf(30), versionOf(10)] }), videoOf(2)];
    await open();
    await click(button("Film 1"));
    await pickVersion("v10");
    videos = [videoOf(1, { versions: [versionOf(30)] }), videoOf(2)];
    await act(async () => { stub.fireError(host.querySelector("video")!); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-notice")).not.toBeNull();
  });
});

describe("rich notes on the page (#835 C)", () => {
  const MEDIA = "44444444-4444-4444-8444-444444444444";
  const CLIP = "55555555-5555-4555-8555-555555555555";
  const para = (...content: unknown[]) => ({ type: "paragraph" as const, content });
  const text = (value: string) => ({ type: "text" as const, text: value });
  const doc = (...content: unknown[]) => ({ type: "doc" as const, content }) as unknown as NonNullable<GuestNoteThreadDto["content"]>;

  it("a mention reaches the guest as a plain name, never a mention node, id or link", async () => {
    // The server has already turned the node into "@Mia" text (story 9); the page shows it as the words it is.
    notes = [note({ body: "Ask @Mia Chen about it", content: doc(para(text("Ask "), text("@Mia Chen"), text(" about it"))) })];
    await open();
    await click(button("Film 1"));
    const body = byId("guest-note-body")!;
    expect(body.textContent).toBe("Ask @Mia Chen about it");
    expect(body.querySelector("a, [data-type=\"mention\"]")).toBeNull();
  });

  it("a stray mention node still reads as the plain name", async () => {
    notes = [note({ body: "Ask @Mia", content: doc(para(text("Ask "), { type: "mention", attrs: { id: "11111111-1111-4111-8111-111111111111", label: "Mia" } })) })];
    await open();
    await click(button("Film 1"));
    expect(byId("guest-note-body")!.textContent).toBe("Ask @Mia");
    expect(host.innerHTML).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("a picture and a video in a note are read from the link's own media routes", async () => {
    notes = [note({ body: "Look [1 image] [1 video]", content: doc(para(text("Look")), { type: "image", attrs: { mediaId: MEDIA, alt: "Site photo" } }, { type: "video", attrs: { mediaId: CLIP } }) })];
    await open();
    await click(button("Film 1"));
    const image = byId("guest-note-body")!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(`/d/api/links/${LINK}/media/${MEDIA}`);
    expect(image.getAttribute("alt")).toBe("Site photo");
    const video = byId("guest-note-body")!.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(`/d/api/links/${LINK}/media/${CLIP}`);
    expect(video.getAttribute("poster")).toBe(`/d/api/links/${LINK}/media/${CLIP}/poster`);
    expect(host.innerHTML).not.toContain("/media/embedded/");
  });

  it("a note with no document still reads from its text", async () => {
    notes = [note()];
    await open();
    await click(button("Film 1"));
    expect(byId("guest-note-body")!.textContent).toBe("Trim the opening");
  });
});

describe("Not you? Sign out (#854)", () => {
  const VERIFIED = { ...SESSION, verified: true, email: "sam@example.com", name: "Sam" };
  /** A visitor with a verified session; DELETE `/session` answers `deleteAs` and, on 204 or 404, ends it, so the next exchange mints an unverified one. */
  function visitor(deleteAs: () => Response = () => new Response(null, { status: 204 })) {
    const calls: Array<{ method: string; body: string | null }> = [];
    extra = (url, init) => {
      if (url !== `/d/api/links/${LINK}/session`) return undefined;
      const method = init?.method ?? "GET";
      calls.push({ method, body: typeof init?.body === "string" ? init.body : null });
      if (method === "DELETE") { const response = deleteAs(); if (response.status === 204 || response.status === 404) sessionGone = true; return response; }
      if (method === "POST") { sessionGone = false; return json(SESSION); }
      return sessionGone ? stub404() : json(VERIFIED);
    };
    return calls;
  }
  const signOut = () => button("Not you? Sign out");

  it("shows the identity row only when the session is verified", async () => {
    await open();
    expect(byId("guest-identity")).toBeNull(); expect(signOut()).toBeUndefined();
    await act(async () => { root!.unmount(); }); root = null; host.remove();
    visitor();
    await open();
    expect(byId("guest-identity")!.textContent).toContain("Reviewing as Sam");
    expect(signOut()).toBeDefined();
  });

  it("sends DELETE then POST with the original token, and lands unverified on the list with no identity left", async () => {
    const calls = visitor();
    await open();
    await click(signOut());
    const sent = calls.filter((call) => call.method !== "GET");
    expect(sent.map((call) => call.method)).toEqual(["DELETE", "POST"]);
    expect(JSON.parse(sent[1]!.body!)).toEqual({ token: "tok123" });
    expect(byId("guest-list")).not.toBeNull();
    expect(byId("guest-identity")).toBeNull();
  });

  it("treats a 404 (staff already ended the session) as signed out", async () => {
    const calls = visitor(() => stub404());
    await open();
    await click(signOut());
    expect(calls.filter((call) => call.method !== "GET").map((call) => call.method)).toEqual(["DELETE", "POST"]);
    expect(byId("guest-identity")).toBeNull();
  });

  it("with no token in memory (after a reload) shows the plain signed-out screen, not the unavailable one", async () => {
    visitor();
    await open(`?link=${LINK}`, "");
    await click(signOut());
    expect(byId("guest-signed-out")).not.toBeNull();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-signed-out")!.textContent).toContain("Open the review link again");
  });

  it("a failed sign-out (5xx) says so inline and leaves the guest signed in", async () => {
    const calls = visitor(() => new Response("", { status: 503 }));
    await open();
    await click(signOut());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Couldn't sign out. Try again.");
    expect(byId("guest-identity")!.textContent).toContain("Reviewing as Sam");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("the phone review screen (#879)", () => {
  const withAllow = (allow: Partial<typeof SESSION.link.allow>, over: Record<string, unknown> = {}) => ({ ...SESSION, ...over, link: { ...SESSION.link, allow: { ...SESSION.link.allow, ...allow } } });
  const serve = (session: unknown, summaries?: unknown) => {
    extra = (url) => {
      const base = `/d/api/links/${LINK}`;
      if (url === `${base}/session`) return json(session);
      if (summaries !== undefined && url.includes("/version-summaries")) return json(summaries);
      return undefined;
    };
  };
  beforeEach(async () => { await viewport.set({ width: 390, coarse: true }); });

  it("shows Approve in the header where the link allows it, and not Previous or Next video", async () => {
    serve(withAllow({ approve: true }, { verified: true, email: "g@example.com", name: "Gina" }));
    await open(`?link=${LINK}`);
    await click(button("Film 1"));
    expect(byId("review-phone-bar")!.contains(byId("guest-approve"))).toBe(true);
    expect(byId("guest-approve")!.textContent).toBe("Approve");
    expect(button("Previous video") ?? null).toBeNull();
    expect(button("Next video") ?? null).toBeNull();
  });

  it("reads \"✓ Approved\" as the decision badge once the Version carries an approval (#879 PR 3b)", async () => {
    serve(withAllow({ approve: true }, { verified: true, email: "g@example.com", name: "Gina" }));
    videos = [videoOf(1, { versions: [versionOf(10, { decision: { value: "approved", revision: 1, at: "2026-10-09T01:00:00.000Z", self: true } })] })];
    await open(`?link=${LINK}`);
    expect(byId("review-phone-bar")!.contains(byId("guest-decision-chip"))).toBe(true);
    expect(byId("guest-decision-chip")!.textContent).toBe("Approved");
    expect(byId("guest-decision-chip")!.querySelector("svg")).not.toBeNull();
    expect(byId("guest-approve")).toBeNull();
  });

  it("the chip opens the Versions sheet with dates and open counts from the read, choosing a row switches Version, and focus returns to the chip", async () => {
    videos = [videoOf(1, { versions: [versionOf(11), versionOf(10)] })];
    serve(SESSION, { versions: [{ assetId: asset(11), version: 11, createdAt: "2026-10-09T01:00:00.000Z", openNoteCount: 3 }, { assetId: asset(10), version: 10, createdAt: "2026-10-01T01:00:00.000Z", openNoteCount: 0 }] });
    await open(`?link=${LINK}`);
    const chip = byId("video-version-chip")!;
    expect(chip.textContent).toContain("v11 · latest");
    await click(chip);
    expect(requests().some((url) => url.endsWith(`/videos/${vid(1)}/version-summaries`))).toBe(true);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="video-version-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("3 open");
    await click(rows[1]);
    expect(byId("video-version-chip")!.textContent).toContain("v10");
    expect(document.activeElement).toBe(byId("video-version-chip"));
  });

  it("the ⋯ sheet offers Social preview when the Project has overlays, and Download only where the Version has a download URL", async () => {
    socialOverlays = [{ id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Instagram", imageUrl: "/social-overlay-images/aaaaaaaa-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002" } as GuestSocialOverlay];
    serve(withAllow({ download: true }, { verified: true, email: "g@example.com", name: "Gina" }));
    videos = [videoOf(1, { versions: [versionOf(10, { released: true, downloadUrl: "/d/api/links/x/download" })] })];
    await open(`?link=${LINK}`);
    await click(byId("video-header-menu") ?? undefined);
    expect(document.querySelector('[data-testid="guest-social-toggle"]')).not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>('a[data-testid="guest-download"]')!.getAttribute("href")).toBe("/d/api/links/x/download");
  });

  it("crossing 721px keeps the notes panel and the film as the same nodes", async () => {
    await viewport.set({ width: 390, coarse: true });
    notes = [note()];
    videos = [videoOf(1)];
    await open();
    const panel = byId("guest-notes-panel")!;
    const film = host.querySelector("video");
    await viewport.set({ width: 1200 });
    await flush();
    expect(byId("guest-notes-panel")).toBe(panel);
    expect(host.querySelector("video")).toBe(film);
    await viewport.set({ width: 390, coarse: true });
    await flush();
    expect(byId("guest-notes-panel")).toBe(panel);
  });

  it("on a phone the column is the window and the screen fills it: no min-height floor that the keyboard box would have to beat (#879 PR 2)", async () => {
    await viewport.set({ width: 390, coarse: true });
    videos = [videoOf(1)];
    await open();
    const column = byId("guest-column")!;
    expect(column.className).toContain("h-dvh");
    expect(column.className).toContain("max-[721px]:overflow-hidden");
    expect(column.className).not.toContain("min-h-dvh");
    expect(byId("guest-video-screen")!.className).toContain("min-h-0");
    expect(byId("guest-video-screen")!.className).not.toContain("min-h-dvh");
  });
});

describe("downloads on the Delivery review link need no code (#882, ADR 0025)", () => {
  const download = () => document.querySelector<HTMLElement>('[data-testid="guest-download"]');
  const withDownload = () => {
    extra = (url) => (url === `/d/api/links/${LINK}/session` ? json({ ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, download: true } } }) : undefined);
    videos = [videoOf(1, { versions: [versionOf(10, { released: true, downloadUrl: "/d/api/links/x/download" })] })];
  };
  it("codeRequired false: an unverified guest gets a Download anchor straight away, no verify dialog", async () => {
    policy = { codeRequired: false }; withDownload();
    await open();
    expect(download()?.tagName).toBe("A"); expect(download()?.getAttribute("href")).toBe("/d/api/links/x/download");
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
  });
  it("codeRequired true: Download is the verify button, and pressing it opens the dialog", async () => {
    policy = { codeRequired: true }; withDownload();
    await open();
    expect(download()?.tagName).toBe("BUTTON");
    await click(download() ?? undefined);
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(1);
  });
  it("a failed policy read (the stub, a bad body) is codeRequired true for downloads only: the film still plays and the link is not gone", async () => {
    withDownload();
    for (const answer of [null, "bad" as const]) {
      if (answer === null) policy = null; else extra = (url) => (url.endsWith("/download-policy") ? json({ codeRequired: "yes" }) : url === `/d/api/links/${LINK}/session` ? json({ ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, download: true } } }) : undefined);
      await act(async () => { root?.unmount(); }); root = null; host?.remove();
      await open();
      expect(byId("guest-video-screen")).not.toBeNull(); expect(byId("guest-unavailable")).toBeNull();
      expect(download()?.tagName).toBe("BUTTON");
    }
  });
  it("Download all opens its dialog without verifying when no code is required", async () => {
    policy = { codeRequired: false };
    extra = (url) => (url === `/d/api/links/${LINK}/session` ? json({ ...SESSION, link: { ...SESSION.link, allow: { ...SESSION.link.allow, download: true } } }) : url.endsWith("/downloads") ? json({ included: [], leftOut: [], totalBytes: 0, tooLarge: false, archive: { state: "ready", pending: 0 } }) : undefined);
    await open();
    await click(byId("guest-download-all") ?? undefined);
    expect(document.querySelectorAll('[data-testid="guest-verify-dialog"]')).toHaveLength(0);
    expect(document.querySelector('[data-testid="guest-download-all-dialog"]')).not.toBeNull();
  });
});
