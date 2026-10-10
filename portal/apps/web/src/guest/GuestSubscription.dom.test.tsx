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
const SESSION_OFF: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: false, approve: false, download: false, markup: true } }, verified: false, email: null, name: null, notifications: null };
const ANON: GuestSessionResponse = { ...SESSION_OFF, link: { ...SESSION_OFF.link, allow: { ...SESSION_OFF.link.allow, comments: true } } };
const VERIFIED: GuestSessionResponse = { ...ANON, verified: true, email: "sam@example.com", name: "Sam", notifications: { available: true, subscribed: true } };

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


const LABEL = "Email me updates about this review";
const switchEl = () => document.body.querySelector<HTMLElement>('[role="switch"]');
const checked = () => switchEl()?.getAttribute("aria-checked");
const puts = () => requests("PUT");
const putHandler = (respond: () => Response | Promise<Response>): Handler => (url, init) => (url === `${BASE}/subscription` && init?.method === "PUT" ? respond() : undefined);

describe("Email-updates switch (#741 15b)", () => {
  it("is absent without notifications, when unavailable, and for an unverified guest", async () => {
    for (const notifications of [null, { available: false, subscribed: true }] as const) {
      session = { ...VERIFIED, notifications }; await open();
      expect(switchEl(), JSON.stringify(notifications)).toBeNull();
      await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = "";
    }
    session = { ...ANON, notifications: null }; await open();
    expect(switchEl()).toBeNull();
  });

  it("shows a labelled switch in the notes panel, initially as the session says", async () => {
    session = { ...VERIFIED, notifications: { available: true, subscribed: false } };
    await open();
    expect(switchEl()).not.toBeNull();
    expect(checked()).toBe("false");
    expect(byId("guest-notes-panel")!.textContent).toContain(LABEL);
    expect(switchEl()!.getAttribute("aria-label") ?? byId("guest-notes-panel")!.querySelector("label")?.textContent).toContain(LABEL);
    expect(byId("guest-notes-panel")!.contains(switchEl())).toBe(true);
  });

  it("applies the toggle at once and PUTs subscribed:false, keeping the server's answer", async () => {
    let release: (response: Response) => void = () => undefined;
    extra = putHandler(() => new Promise<Response>((resolve) => { release = resolve; }));
    await open();
    expect(checked()).toBe("true");
    await click(switchEl());
    expect(checked()).toBe("false");
    expect(puts()).toEqual([{ url: `${BASE}/subscription`, body: { subscribed: false } }]);
    await act(async () => { release(json({ subscribed: false })); });
    await flush();
    expect(checked()).toBe("false");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("applies the server's answer when it differs from the toggle: the user turns it off, the server answers subscribed:true, the switch ends on", async () => {
    extra = putHandler(() => json({ subscribed: true }));
    await open();
    expect(checked()).toBe("true");
    await click(switchEl());
    expect(puts()).toEqual([{ url: `${BASE}/subscription`, body: { subscribed: false } }]);
    expect(checked()).toBe("true");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("reverts and says so inline when the PUT fails", async () => {
    extra = putHandler(() => json({ error: "server_error" }, 500));
    await open();
    await click(switchEl());
    expect(checked()).toBe("true");
    expect(byId("guest-notes-panel")!.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("a lost verification opens the verify dialog and withdraws the switch", async () => {
    extra = putHandler(() => json({ error: "verification_required" }, 401));
    await open();
    await click(switchEl());
    expect(byId("guest-verify-dialog")).not.toBeNull();
    // The session is unverified again, so the switch is withdrawn rather than left showing a state the server refused.
    expect(switchEl()).toBeNull();
  });

  it("an archived Project reverts the switch and makes it read-only", async () => {
    extra = putHandler(() => json({ error: "project_archived" }, 409));
    await open();
    await click(switchEl());
    expect(byId("guest-archived-notice")).not.toBeNull();
    expect(checked()).toBe("true");
    expect(switchEl()!.hasAttribute("disabled") || switchEl()!.getAttribute("aria-disabled") === "true" || switchEl()!.hasAttribute("data-disabled")).toBe(true);
  });

  it("a toggle pending while the phone drawer closes is not lost: the reopened drawer shows its result", async () => {
    await viewport.set({ width: 400 });
    let release: (response: Response) => void = () => undefined;
    extra = putHandler(() => new Promise<Response>((resolve) => { release = resolve; }));
    await open();
    await click(button("Notes"));
    await click(switchEl());
    expect(checked()).toBe("false");
    await click(byId("guest-notes-close"));
    await act(async () => { release(json({ subscribed: false })); });
    await flush();
    await click(button("Notes"));
    expect(checked()).toBe("false");
    expect(puts()).toHaveLength(1);
  });
});
