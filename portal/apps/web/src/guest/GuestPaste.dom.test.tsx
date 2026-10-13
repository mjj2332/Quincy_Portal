import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { installLocalStorageShim } from "../testing/local-storage";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { TIME_FORMAT_KEY } from "../lib/time-format-prefs";
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


const reply = (n: number, parentId: string) => { const { replies: _none, ...rest } = mine(n, { parentId, startFrame: null, body: "My reply" }); return rest; };
const TARGET = asset(2);
const SOURCE = asset(1);
const twoVersions = (): GuestVideoDto[] => [videoOf(1, [versionOf(2), versionOf(1)])];
const sourceRow = (n: number, over: Record<string, unknown> = {}) => ({ revision: 1, visibility: "public" as const, authorName: "Sam", excerpt: `My note ${n}`, from: { startFrame: 50, endFrame: null }, ...over });
const mapped = (n: number, over: Record<string, unknown> = {}) => ({ noteId: noteId(n), status: "mapped" as const, source: sourceRow(n), to: { startFrame: 50, endFrame: null }, shortened: false, ...over });
const skipped = (n: number, reason: string, withSource = true) => ({ noteId: noteId(n), status: "skipped" as const, reason, source: withSource ? sourceRow(n) : null });
const plan = (rows: unknown[], offsetFrames = 0) => ({ sourceVersion: 1, targetVersion: 2, offsetFrames, rows });
const receipt = (rows: unknown[], copied: number, offsetFrames = 0) => ({ sourceVersion: 1, targetVersion: 2, offsetFrames, copied, skipped: rows.length - copied, rows });
const copied = (n: number, copyN: number) => ({ ...mapped(n), status: "copied" as const, copyId: noteId(copyN) });

const PREVIEW_URL = `${BASE}/versions/${TARGET}/note-paste/preview`;
const COMMIT_URL = `${BASE}/versions/${TARGET}/note-paste`;
const pasteCalls = (url: string) => requests("POST").filter((call) => call.url === url);
const openDialog = async () => { await click(byId("guest-paste-open")); await flush(); };
const wait = async (ms: number) => { await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }); await flush(); };
const rowIds = () => allById("guest-paste-row").map((row) => row.getAttribute("data-note-id"));

beforeEach(() => {
  videos = twoVersions();
  notes = { [SOURCE]: [mine(1, { startFrame: 50 }), mine(2, { startFrame: 80 })] };
});

describe("the Copy my notes entry", () => {
  it("is offered on a link that grants this Video two or more Versions and allows comments", async () => {
    await open();
    expect(byId("guest-paste-open")?.textContent).toBe("Copy my notes from another version");
  });
  it("is not offered when only one Version is granted", async () => {
    videos = [videoOf(1, [versionOf(2)])];
    await open();
    expect(byId("guest-add-note")).not.toBeNull();
    expect(byId("guest-paste-open")).toBeNull();
  });
  it("is not offered when the link does not allow comments", async () => {
    session = SESSION_OFF;
    await open();
    expect(byId("guest-paste-open")).toBeNull();
  });
  it("opens the verify dialog for a guest who has not verified, and no paste dialog", async () => {
    session = ANON;
    await open();
    await click(byId("guest-paste-open"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-paste-dialog")).toBeNull();
  });
});

describe("previewing a paste", () => {
  it("asks for the plan of the guest's own notes on the other Version and lists what will be copied and what is left out, with the reasons", async () => {
    extra = (url, init) => {
      if (url === PREVIEW_URL && init?.method === "POST") return json(plan([mapped(1), mapped(2, { shortened: true }), skipped(3, "already_copied"), skipped(4, "not_author", false)]));
      return undefined;
    };
    await open();
    await openDialog();
    expect(pasteCalls(PREVIEW_URL)).toEqual([{ url: PREVIEW_URL, body: { sourceAssetId: SOURCE, noteIds: [noteId(1), noteId(2)], offsetFrames: 0 } }]);
    expect(rowIds()).toEqual([noteId(1), noteId(2)]);
    expect(byId("guest-paste-dialog")?.textContent).toContain("Shortened to fit");
    const left = allById("guest-paste-skipped");
    expect(left.map((row) => row.getAttribute("data-reason"))).toEqual(["already_copied", "not_author"]);
    expect(left[0]!.textContent).toContain("Already copied to this version");
    expect(left[1]!.textContent).toContain("Only your own notes can be copied");
    expect(left[1]!.textContent).not.toContain("My note");
    expect(byId("guest-paste-submit")?.textContent).toBe("Paste 2 notes");
  });
  it("never asks for a studio note, another guest's note, a reply or a deleted note", async () => {
    notes = { [SOURCE]: [mine(1), note(2), note(3, { author: { kind: "guest", name: "Pat", self: false } }), mine(4, { deleted: true, body: "" }), mine(5, { replies: [reply(6, noteId(5))] })] };
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json(plan([mapped(1), mapped(5)])) : undefined);
    await open();
    await openDialog();
    expect((pasteCalls(PREVIEW_URL)[0]!.body as { noteIds: string[] }).noteIds).toEqual([noteId(1), noteId(5)]);
  });
  it("says so, and sends nothing, when the guest has no notes on that Version", async () => {
    notes = { [SOURCE]: [note(2)] };
    await open();
    await openDialog();
    expect(pasteCalls(PREVIEW_URL)).toEqual([]);
    expect(byId("guest-paste-none")).not.toBeNull();
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(true);
  });
  it("asks again from the other Version when the source is changed", async () => {
    videos = [videoOf(1, [versionOf(3), versionOf(2), versionOf(1)])];
    notes = { [asset(2)]: [mine(7)], [asset(1)]: [mine(1)] };
    const target = asset(3);
    extra = (url, init) => (url === `${BASE}/versions/${target}/note-paste/preview` && init?.method === "POST" ? json(plan([mapped(1)])) : undefined);
    await open();
    await openDialog();
    const asked = () => requests("POST").filter((call) => call.url === `${BASE}/versions/${target}/note-paste/preview`).map((call) => (call.body as { sourceAssetId: string }).sourceAssetId);
    expect(asked()).toEqual([asset(2)]);
    await click(byId("guest-paste-source"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v1")));
    expect(asked()).toEqual([asset(2), asset(1)]);
  });
  it("asks again with the frame offset once it has rested", async () => {
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json(plan([mapped(1)], (JSON.parse(String(init.body)) as { offsetFrames: number }).offsetFrames)) : undefined);
    await open();
    await openDialog();
    await click(button("One frame later"));
    await click(button("One frame later"));
    expect(pasteCalls(PREVIEW_URL)).toHaveLength(1);
    await wait(400);
    expect(pasteCalls(PREVIEW_URL).map((call) => (call.body as { offsetFrames: number }).offsetFrames)).toEqual([0, 2]);
  });
  it("leaves a drawn note out and says why when the link has markup off (the server would answer the stub for it)", async () => {
    session = { ...VERIFIED, link: { ...VERIFIED.link, allow: { ...VERIFIED.link.allow, markup: false } } };
    notes = { [SOURCE]: [mine(1), mine(2, { hasMarkup: true, drawingFrame: 80 })] };
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json(plan([mapped(1)])) : undefined);
    await open();
    await openDialog();
    expect((pasteCalls(PREVIEW_URL)[0]!.body as { noteIds: string[] }).noteIds).toEqual([noteId(1)]);
    expect(byId("guest-paste-drawn")?.textContent).toContain("1 note with a drawing can't be copied");
  });
  it("is the unavailable page when the server answers the stub", async () => {
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? stub404() : undefined);
    await open();
    await openDialog();
    expect(byId("guest-unavailable")).not.toBeNull();
  });
  it("asks the guest to verify again on a 401, closing the paste dialog", async () => {
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json({ error: "verification_required" }, 401) : undefined);
    await open();
    await openDialog();
    expect(byId("guest-paste-dialog")).toBeNull();
    expect(byId("guest-verify-dialog")).not.toBeNull();
  });
  it("offers Try again when the preview could not be reached", async () => {
    let calls = 0;
    extra = (url, init) => {
      if (url !== PREVIEW_URL || init?.method !== "POST") return undefined;
      calls += 1;
      return calls === 1 ? new Response("", { status: 503 }) : json(plan([mapped(1), mapped(2)]));
    };
    await open();
    await openDialog();
    expect(byId("guest-paste-load-error")).not.toBeNull();
    await click(button("Try again"));
    expect(rowIds()).toEqual([noteId(1), noteId(2)]);
    expect(byId("guest-paste-load-error")).toBeNull();
  });
});

describe("a guest with more notes than one paste may carry", () => {
  const LIMIT_MESSAGE = "Copy up to 60 notes at a time. Untick some to continue.";
  const many = () => Array.from({ length: 61 }, (_, index) => mine(index + 1, { startFrame: 10 + index }));
  const planFor = (init: RequestInit | undefined) => json(plan((JSON.parse(String(init?.body)) as { noteIds: string[] }).noteIds.map((id) => mapped(Number(id.slice(-12))))));
  const asked = () => pasteCalls(PREVIEW_URL).map((call) => (call.body as { noteIds: string[] }).noteIds);
  beforeEach(() => {
    notes = { [SOURCE]: many() };
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? planFor(init) : undefined);
  });

  it("lists all 61 notes, ticks the first 60 and sends only those", async () => {
    await open();
    await openDialog();
    expect(rowIds()).toHaveLength(61);
    expect(rowIds()).toContain(noteId(61));
    expect(asked()).toHaveLength(1);
    expect(asked()[0]).toHaveLength(60);
    expect(asked()[0]).not.toContain(noteId(61));
    expect(byId("guest-paste-submit")?.textContent).toBe("Paste 60 notes");
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
  });
  it("sends the 61st note once it is ticked in place of another", async () => {
    await open();
    await openDialog();
    expect(allById("guest-paste-tick")).toHaveLength(61);
    await click(allById("guest-paste-tick")[0]);
    await click(allById("guest-paste-tick")[60]);
    await wait(400);
    const latest = asked().at(-1)!;
    expect(latest).toHaveLength(60);
    expect(latest).toContain(noteId(61));
    expect(latest).not.toContain(noteId(1));
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]?.body as { notes: Array<{ noteId: string }> } | undefined)?.notes.map((entry) => entry.noteId)).toContain(noteId(61));
  });
  it("disables Paste and says why when all 61 are ticked", async () => {
    await open();
    await openDialog();
    expect(allById("guest-paste-tick")).toHaveLength(61);
    await click(allById("guest-paste-tick")[60]);
    await wait(400);
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(true);
    expect(byId("guest-paste-dialog")?.textContent).toContain(LIMIT_MESSAGE);
    expect(asked().every((ids) => ids.length <= 60)).toBe(true);
    await click(allById("guest-paste-tick")[0]);
    await wait(400);
    expect(byId("guest-paste-dialog")?.textContent).not.toContain(LIMIT_MESSAGE);
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
  });
});

describe("a ticked note the current plan does not cover", () => {
  const LIMIT_MESSAGE = "Copy up to 60 notes at a time. Untick some to continue.";
  const planFor = (init: RequestInit | undefined) => json(plan((JSON.parse(String(init?.body)) as { noteIds: string[] }).noteIds.map((id) => mapped(Number(id.slice(-12))))));
  const asked = () => pasteCalls(PREVIEW_URL).map((call) => (call.body as { noteIds: string[] }).noteIds);
  const tickOf = (n: number) => allById("guest-paste-row").find((row) => row.getAttribute("data-note-id") === noteId(n))?.querySelector<HTMLElement>('[data-testid="guest-paste-tick"]') ?? null;
  const isChecked = (n: number) => tickOf(n)?.getAttribute("aria-checked") === "true";
  const submitDisabled = () => byId("guest-paste-submit")?.hasAttribute("disabled");
  const setUp = (count: number) => {
    notes = { [SOURCE]: Array.from({ length: count }, (_, index) => mine(index + 1, { startFrame: 10 + index })) };
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? planFor(init) : undefined);
  };

  it("keeps its checkbox, so a guest with 61 notes can untick note 61 after ticking it", async () => {
    setUp(61);
    await open();
    await openDialog();
    await click(tickOf(61));
    await wait(400);
    expect(tickOf(61)).not.toBeNull();
    expect(isChecked(61)).toBe(true);
    expect(submitDisabled()).toBe(true);
    expect(byId("guest-paste-dialog")?.textContent).toContain(LIMIT_MESSAGE);
    await click(tickOf(61));
    await wait(400);
    expect(isChecked(61)).toBe(false);
    expect(byId("guest-paste-dialog")?.textContent).not.toContain(LIMIT_MESSAGE);
    expect(submitDisabled()).toBe(false);
    expect(byId("guest-paste-submit")?.textContent).toBe("Paste 60 notes");
  });
  it("lets a guest with 121 notes who ticked every extra and unticked the first 60 untick back to 60 and paste", async () => {
    setUp(121);
    await open();
    await openDialog();
    for (let n = 61; n <= 121; n += 1) await click(tickOf(n));
    for (let n = 1; n <= 60; n += 1) await click(tickOf(n));
    await wait(400);
    expect(allById("guest-paste-tick")).toHaveLength(121);
    expect(submitDisabled()).toBe(true);
    expect(byId("guest-paste-dialog")?.textContent).toContain(LIMIT_MESSAGE);
    const before = asked().length;
    await click(tickOf(121));
    await wait(400);
    expect(isChecked(121)).toBe(false);
    expect(byId("guest-paste-dialog")?.textContent).not.toContain(LIMIT_MESSAGE);
    expect(asked().length).toBeGreaterThan(before);
    const latest = asked().at(-1)!;
    expect(latest).toHaveLength(60);
    expect(latest).toContain(noteId(61));
    expect(latest).not.toContain(noteId(121));
    expect(submitDisabled()).toBe(false);
    expect(byId("guest-paste-submit")?.textContent).toBe("Paste 60 notes");
  });
});

describe("notes the plan leaves out do not count toward the cap", () => {
  it("lets note 61 be ticked and pasted alone when the first 60 already preview as already copied", async () => {
    notes = { [SOURCE]: Array.from({ length: 61 }, (_, index) => mine(index + 1, { startFrame: 10 + index })) };
    extra = (url, init) => {
      if (init?.method !== "POST") return undefined;
      if (url === PREVIEW_URL) {
        const ids = (JSON.parse(String(init.body)) as { noteIds: string[] }).noteIds.map((id) => Number(id.slice(-12)));
        return json(plan(ids.map((n) => (n === 61 ? mapped(n) : skipped(n, "already_copied")))));
      }
      if (url === COMMIT_URL) return json(receipt([copied(61, 99)], 1));
      return undefined;
    };
    await open();
    await openDialog();
    await click(allById("guest-paste-tick").at(-1));
    await wait(400);
    expect(byId("guest-paste-dialog")?.textContent).not.toContain("Copy up to 60 notes at a time");
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]?.body as { notes: Array<{ noteId: string }> }).notes.map((entry) => entry.noteId)).toEqual([noteId(61)]);
  });
});

describe("a note left out for where it lands, past the cap", () => {
  it("is asked about again, and can be pasted, once the frame offset puts it in range", async () => {
    notes = { [SOURCE]: Array.from({ length: 61 }, (_, index) => mine(index + 1, { startFrame: 10 + index })) };
    extra = (url, init) => {
      if (init?.method !== "POST") return undefined;
      if (url === PREVIEW_URL) {
        const body = JSON.parse(String(init.body)) as { noteIds: string[]; offsetFrames: number };
        return json(plan(body.noteIds.map((id) => { const n = Number(id.slice(-12)); return n === 1 && body.offsetFrames === 0 ? skipped(n, "out_of_range") : mapped(n); }), body.offsetFrames));
      }
      if (url === COMMIT_URL) return json(receipt([copied(1, 99)], 1, 2));
      return undefined;
    };
    await open();
    await openDialog();
    expect(rowIds()).not.toContain(noteId(1));
    await click(button("One frame later"));
    await click(button("One frame later"));
    await wait(400);
    await wait(400);
    await wait(400);
    const latest = pasteCalls(PREVIEW_URL).at(-1)!.body as { noteIds: string[]; offsetFrames: number };
    expect(latest.offsetFrames).toBe(2);
    expect(latest.noteIds).toContain(noteId(1));
    expect(rowIds()).toContain(noteId(1));
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]?.body as { notes: Array<{ noteId: string }> }).notes.map((entry) => entry.noteId)).toContain(noteId(1));
  });
});

describe("a preview that is no longer the current one", () => {
  const THREE = () => [videoOf(1, [versionOf(3), versionOf(2), versionOf(1)])];
  const URL3 = `${BASE}/versions/${asset(3)}/note-paste/preview`;
  const sourceOf = (init: RequestInit) => (JSON.parse(String(init.body)) as { sourceAssetId: string }).sourceAssetId;
  it("sends the guest nowhere when its late 404 arrives after the source was switched to a reachable Version", async () => {
    videos = THREE();
    notes = { [asset(2)]: [mine(7)], [asset(1)]: [mine(8)] };
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    extra = (url, init) => {
      if (url !== URL3 || init?.method !== "POST") return undefined;
      return sourceOf(init) === asset(2) ? held : json({ sourceVersion: 1, targetVersion: 3, offsetFrames: 0, rows: [mapped(8)] });
    };
    await open();
    await openDialog();
    await click(byId("guest-paste-source"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v1")));
    await act(async () => { release(stub404()); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(rowIds()).toEqual([noteId(8)]);
  });
  it("still sends the guest to the unavailable page when the current preview is refused", async () => {
    videos = THREE();
    notes = { [asset(2)]: [mine(7)] };
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    extra = (url, init) => (url === URL3 && init?.method === "POST" ? held : undefined);
    await open();
    await openDialog();
    await act(async () => { release(stub404()); });
    await flush();
    expect(byId("guest-unavailable")).not.toBeNull();
  });
});

describe("committing a paste", () => {
  const withPlan = (rows: unknown[] = [mapped(1), mapped(2)]) => { extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json(plan(rows)) : undefined); };

  it("posts the revisions it showed, closes, adds the copies to the list and says what was copied", async () => {
    withPlan();
    const base = extra!;
    extra = (url, init) => {
      if (url === COMMIT_URL && init?.method === "POST") {
        notes = { ...notes, [TARGET]: [mine(11, { body: "Copied one", startFrame: 50 }), mine(12, { body: "Copied two", startFrame: 80 })] };
        return json(receipt([copied(1, 11), copied(2, 12)], 2));
      }
      return base(url, init);
    };
    await open();
    expect(allById("guest-note-body").map((item) => item.textContent)).toEqual([]);
    await openDialog();
    await click(byId("guest-paste-submit"));
    expect(pasteCalls(COMMIT_URL)).toEqual([{ url: COMMIT_URL, body: { sourceAssetId: SOURCE, notes: [{ noteId: noteId(1), revision: 1 }, { noteId: noteId(2), revision: 1 }], offsetFrames: 0 } }]);
    expect(byId("guest-paste-dialog")).toBeNull();
    expect(allById("guest-note-body").map((item) => item.textContent)).toEqual(["Copied one", "Copied two"]);
    expect(byId("guest-paste-status")?.textContent).toBe("Copied 2 notes from v1.");
  });
  it("leaves out a note the guest unticked", async () => {
    withPlan();
    extra = ((base) => (url: string, init: RequestInit | undefined) => (url === COMMIT_URL && init?.method === "POST" ? json(receipt([copied(2, 12)], 1)) : base!(url, init)))(extra);
    await open();
    await openDialog();
    await click(allById("guest-paste-tick")[0]);
    expect(byId("guest-paste-submit")?.textContent).toBe("Paste 1 note");
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]!.body as { notes: unknown[] }).notes).toEqual([{ noteId: noteId(2), revision: 1 }]);
  });
  it("sends the offset the plan was made for", async () => {
    extra = (url, init) => {
      if (url === PREVIEW_URL && init?.method === "POST") return json(plan([mapped(1)], (JSON.parse(String(init.body)) as { offsetFrames: number }).offsetFrames));
      if (url === COMMIT_URL && init?.method === "POST") return json(receipt([copied(1, 11)], 1, 1));
      return undefined;
    };
    await open();
    await openDialog();
    await click(button("One frame later"));
    await wait(400);
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]!.body as { offsetFrames: number }).offsetFrames).toBe(1);
  });
  it("refreshes the preview on paste_stale, tells the guest, and sends the new revision next", async () => {
    notes = { [SOURCE]: [mine(1, { startFrame: 50 })] }; // one own note, so the canned plan covers every ticked note like the server's does
    withPlan([mapped(1)]);
    const base = extra!;
    let commits = 0;
    extra = (url, init) => {
      if (url === COMMIT_URL && init?.method === "POST") {
        commits += 1;
        return commits === 1 ? json({ error: "paste_stale", preview: plan([mapped(1, { source: sourceRow(1, { revision: 2, excerpt: "Edited elsewhere" }) })]) }, 409) : json(receipt([copied(1, 11)], 1));
      }
      return base(url, init);
    };
    await open();
    await openDialog();
    await click(byId("guest-paste-submit"));
    expect(byId("guest-paste-dialog")).not.toBeNull();
    expect(byId("guest-paste-notice")?.textContent).toContain("changed");
    expect(byId("guest-paste-dialog")?.textContent).toContain("Edited elsewhere");
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[1]!.body as { notes: unknown[] }).notes).toEqual([{ noteId: noteId(1), revision: 2 }]);
    expect(byId("guest-paste-dialog")).toBeNull();
  });
  it("opens the verify flow on a 401 and keeps the page", async () => {
    withPlan([mapped(1)]);
    const base = extra!;
    extra = (url, init) => (url === COMMIT_URL && init?.method === "POST" ? json({ error: "verification_required" }, 401) : base(url, init));
    await open();
    await openDialog();
    await click(byId("guest-paste-submit"));
    expect(byId("guest-paste-dialog")).toBeNull();
    expect(byId("guest-verify-dialog")).not.toBeNull();
  });
  it("makes the page read-only when the Project is archived", async () => {
    withPlan([mapped(1)]);
    const base = extra!;
    extra = (url, init) => (url === COMMIT_URL && init?.method === "POST" ? json({ error: "project_archived" }, 409) : base(url, init));
    await open();
    await openDialog();
    await click(byId("guest-paste-submit"));
    expect(byId("guest-paste-dialog")).toBeNull();
    expect(byId("guest-archived-notice")).not.toBeNull();
    expect(byId("guest-paste-open")).toBeNull();
    expect(byId("guest-add-note")).toBeNull();
  });
  it("tells the guest to wait, and keeps the dialog, on a 429", async () => {
    withPlan([mapped(1)]);
    const base = extra!;
    extra = (url, init) => (url === COMMIT_URL && init?.method === "POST" ? json({ error: "too_many_attempts", retryAfterSeconds: 45 }, 429, { "retry-after": "45" }) : base(url, init));
    await open();
    await openDialog();
    await click(byId("guest-paste-submit"));
    expect(byId("guest-paste-error")?.textContent).toContain("45 seconds");
    expect(byId("guest-paste-dialog")).not.toBeNull();
  });
  it("reads the list again and says pasting twice is safe when the commit could not be reached", async () => {
    withPlan([mapped(1)]);
    const base = extra!;
    extra = (url, init) => (url === COMMIT_URL && init?.method === "POST" ? new Response("", { status: 503 }) : base(url, init));
    await open();
    await openDialog();
    const reads = () => fetchMock.mock.calls.filter((call) => String(call[0]) === `${BASE}/versions/${TARGET}/notes`).length;
    const before = reads();
    await click(byId("guest-paste-submit"));
    expect(byId("guest-paste-error")?.textContent).toContain("never makes a second copy");
    expect(reads()).toBeGreaterThan(before);
  });
});

describe("a paste that settles after the guest moved on", () => {
  it("changes nothing on the Version now on screen", async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    extra = (url, init) => {
      if (url === PREVIEW_URL && init?.method === "POST") return json(plan([mapped(1)]));
      if (url === COMMIT_URL && init?.method === "POST") return held;
      return undefined;
    };
    notes = { [SOURCE]: [mine(1)], [TARGET]: [], };
    await open();
    await openDialog();
    await click(byId("guest-paste-submit"));
    // The guest switches Version while the commit is out.
    await click(byId("guest-version-trigger"));
    // The dialog's own source list is in the document too: take the option of the Version list.
    const list = document.getElementById(byId("guest-version-trigger")!.getAttribute("aria-controls") ?? "");
    await click([...(list ?? document).querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v1")));
    expect(byId("guest-paste-dialog")).toBeNull();
    notes = { ...notes, [SOURCE]: [mine(1, { body: "Still mine" })] };
    await act(async () => { release(json({ ...receipt([copied(1, 11)], 1) })); });
    await flush();
    expect(byId("guest-paste-status")).toBeNull();
    expect(byId("guest-paste-dialog")).toBeNull();
    expect(byId("guest-version-trigger")?.textContent).toMatch(/^v1/);
    expect(allById("guest-note-body").map((item) => item.textContent)).toEqual(["My note"]);
  });
  it("does not fill the list or enable Paste when a slow preview for the old source lands after the source was switched", async () => {
    videos = [videoOf(1, [versionOf(3), versionOf(2), versionOf(1)])];
    notes = { [asset(2)]: [mine(7)], [asset(1)]: [] };
    const url = `${BASE}/versions/${asset(3)}/note-paste/preview`;
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    extra = (requested, init) => (requested === url && init?.method === "POST" ? held : undefined);
    await open();
    await openDialog();
    await click(byId("guest-paste-source"));
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("v1")));
    expect(byId("guest-paste-none")).not.toBeNull();
    await act(async () => { release(json({ sourceVersion: 2, targetVersion: 3, offsetFrames: 0, rows: [mapped(7)] })); });
    await flush();
    expect(rowIds()).toEqual([]);
    expect(byId("guest-paste-dialog")?.textContent).not.toContain("My note 7");
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(true);
  });
  it("does not show a preview that arrives after the dialog was cancelled", async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? held : undefined);
    await open();
    await openDialog();
    await click(byId("guest-paste-cancel"));
    await act(async () => { release(json(plan([mapped(1)]))); });
    await flush();
    expect(byId("guest-paste-dialog")).toBeNull();
    await openDialog();
    expect(byId("guest-paste-dialog")).not.toBeNull();
    expect(rowIds()).toEqual([]);
  });
  it("shows its own preview, with Paste enabled, when the dialog is reopened while the cancelled one is still pending", async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    let previews = 0;
    extra = (url, init) => {
      if (url !== PREVIEW_URL || init?.method !== "POST") return undefined;
      previews += 1;
      return previews === 1 ? held : json(plan([mapped(1), mapped(2)]));
    };
    await open();
    await openDialog();
    await click(byId("guest-paste-cancel"));
    await openDialog();
    await act(async () => { release(json(plan([mapped(1), mapped(2)]))); });
    await flush();
    expect(rowIds()).toEqual([noteId(1), noteId(2)]);
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
  });
});

describe("a stale answer for part of the selection", () => {
  it("lets a note that was unticked before the stale answer be ticked again and pasted", async () => {
    const planFor = (init: RequestInit | undefined, edited: boolean) => plan((JSON.parse(String(init?.body)) as { noteIds: string[] }).noteIds.map((id) => { const n = Number(id.slice(-12)); return mapped(n, n === 1 && edited ? { source: sourceRow(1, { revision: 2 }) } : {}); }));
    let commits = 0;
    extra = (url, init) => {
      if (url === PREVIEW_URL && init?.method === "POST") return json(planFor(init, commits > 0));
      if (url === COMMIT_URL && init?.method === "POST") {
        commits += 1;
        const sent = (JSON.parse(String(init.body)) as { notes: Array<{ noteId: string }> }).notes.map((entry) => entry.noteId);
        return commits === 1 ? json({ error: "paste_stale", preview: plan(sent.map((id) => mapped(Number(id.slice(-12)), Number(id.slice(-12)) === 1 ? { source: sourceRow(1, { revision: 2 }) } : {}))) }, 409) : json(receipt([copied(1, 11), copied(2, 12)], 2));
      }
      return undefined;
    };
    await open();
    await openDialog();
    await click(allById("guest-paste-tick")[1]);
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[0]!.body as { notes: Array<{ noteId: string }> }).notes.map((entry) => entry.noteId)).toEqual([noteId(1)]);
    expect(byId("guest-paste-notice")).not.toBeNull();
    const before = pasteCalls(PREVIEW_URL).length;
    await click(allById("guest-paste-tick")[1]);
    await wait(400);
    expect(pasteCalls(PREVIEW_URL).length).toBeGreaterThan(before);
    expect(rowIds()).toEqual([noteId(1), noteId(2)]);
    expect(byId("guest-paste-submit")?.hasAttribute("disabled")).toBe(false);
    await click(byId("guest-paste-submit"));
    expect((pasteCalls(COMMIT_URL)[1]!.body as { notes: Array<{ noteId: string }> }).notes.map((entry) => entry.noteId)).toEqual([noteId(1), noteId(2)]);
  });
});

describe("the time format in the paste dialog (#860)", () => {
  let shim: ReturnType<typeof installLocalStorageShim>;
  beforeEach(() => { shim = installLocalStorageShim(); resetUiPrefMemory(); });
  afterEach(() => { shim.restore(); resetUiPrefMemory(); });

  it("the source and new labels follow the chosen format", async () => {
    shim.values.set(TIME_FORMAT_KEY, JSON.stringify("frames"));
    extra = (url, init) => (url === PREVIEW_URL && init?.method === "POST" ? json(plan([mapped(1)])) : undefined);
    await open();
    await openDialog();
    expect(allById("guest-paste-row")[0]!.textContent).toContain("v1 50 → v2 50");
  });
});
