import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
// The rich field is a textarea here: this file is about the page's box around the keyboard (#879 PR 2), not the editor.
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  return {
    GuestNoteEditor: (props: { testId: string; id?: string; value: import("@quincy/shared").RichTextDoc; onChange: (doc: import("@quincy/shared").RichTextDoc) => void; inlineStart?: import("react").ReactNode; inlineEnd?: import("react").ReactNode }) => <div>
      {props.inlineStart}
      <textarea data-testid={props.testId} id={props.id} value={shared.videoNoteBody(props.value)} onChange={(event) => { props.onChange(shared.legacyBodyToRichTextDoc(event.target.value)); }} />
      {props.inlineEnd}
    </div>,
  };
});

/**
 * The guest page on a phone follows the visual viewport (#879 PR 2, the staff viewer's r5 / r8 mechanism): the guest column (the notices and the video screen) is the root the
 * keyboard box is written on, for as long as the phone video screen is mounted, and the document's canvas is ink meanwhile.
 */
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const SESSION: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam", notifications: null, media: { heic: false } };
const versionOf = (n: number) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `${BASE}/versions/${asset(n)}/poster`, streamUrl: `${BASE}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null,
});
const videoOf = (n: number): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions: [versionOf(n * 10)] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
let fake: FakeViewport;
let original: PropertyDescriptor | undefined;
let videos: GuestVideoDto[];
let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const area = () => byId("guest-composer-body") as HTMLTextAreaElement | null;
const mode = () => byId("video-review-pane")!.getAttribute("data-mode");
async function open() {
  window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestApp token="tok123" />); });
  await flush();
}
async function openVideo() {
  await open();
  await vi.waitFor(() => { expect(area()).not.toBeNull(); });
}

beforeEach(async () => {
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 390, coarse: true });
  videos = [videoOf(1)];
  fake = new FakeViewport();
  original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${BASE}/session`) return json(SESSION);
    if (url === `${BASE}/videos`) return json({ videos });
    if (/\/notes$/.test(url)) return json({ notes: [] as GuestNoteThreadDto[] });
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("the guest phone page and the keyboard (#879 PR 2)", () => {
  it("the guest column follows the visual viewport from the moment the screen mounts, with no transition, and keeps following through compose", async () => {
    fake.height = window.innerHeight - 340; fake.offsetTop = 24;
    await openVideo();
    const column = byId("guest-column")!;
    expect(column.contains(byId("guest-video-screen"))).toBe(true);
    expect(mode()).toBe("browse");
    expect(column.style.height).toBe(`${window.innerHeight - 340}px`);
    expect(column.style.transition).toBe("none");
    expect(byId("guest-video-screen")!.getAttribute("style")).toBeNull();
    fake.offsetTop = 30; fake.dispatchEvent(new Event("scroll"));
    expect(column.style.transform).toBe("translateY(30px)");
    await act(async () => { area()!.focus(); });
    await flush(2);
    expect(mode()).toBe("compose");
    expect(column.style.height).toBe(`${window.innerHeight - 340}px`);
    // No floor beats the shrunken height: Cancel must not end up behind the keyboard.
    expect(column.className).not.toContain("min-h-dvh");
    expect(byId("guest-video-screen")!.className).not.toContain("min-h-dvh");
  });

  it("the keyboard going away without a blur ends compose mode, unless the open tray holds it", async () => {
    await openVideo();
    await act(async () => { area()!.focus(); });
    await act(async () => { fake.height = window.innerHeight - 320; fake.dispatchEvent(new Event("resize")); });
    expect(mode()).toBe("compose");
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(4);
    expect(document.activeElement).not.toBe(area());
    expect(mode()).toBe("browse");
    await act(async () => { area()!.focus(); });
    await act(async () => { byId("guest-composer-extras")!.click(); });
    await act(async () => { fake.height = window.innerHeight - 320; fake.dispatchEvent(new Event("resize")); });
    await act(async () => { fake.height = window.innerHeight; fake.dispatchEvent(new Event("resize")); });
    await flush(4);
    expect(mode()).toBe("compose");
  });

  it("paints the document canvas ink while the phone video screen is up, and clears both the canvas and the box when it crosses to a desktop", async () => {
    fake.height = window.innerHeight - 340;
    await openVideo();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    const column = byId("guest-column")!;
    expect(column.style.height).not.toBe("");
    await act(async () => { await viewport.set({ width: 1440 }); });
    await flush();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
    expect(byId("guest-column")!.style.height).toBe("");
    expect(byId("guest-column")!.style.transform).toBe("");
  });

  it("leaving the screen (unmount) clears the canvas", async () => {
    await openVideo();
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(true);
    await act(async () => { root!.unmount(); }); root = null;
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
  });
});
