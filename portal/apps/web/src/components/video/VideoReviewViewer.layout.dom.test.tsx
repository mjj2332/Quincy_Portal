import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto, VideoNoteThreadDto } from "@quincy/shared";
import { frameSeekSeconds } from "@quincy/shared";
import { installLocalStorageShim } from "../../testing/local-storage";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { REVIEW_PANE_KEY } from "../../lib/review-pane-prefs";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { QuincyQueryProvider } from "../../lib/query-client";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { ProjectSheet } from "../quincy/ProjectSheet";
import "../../testing/dom-polyfills";
import { VideoCollectionPanel } from "./VideoCollectionPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", asset2: "77777777-7777-4777-8777-777777777777", asset1: "66666666-6666-4666-8666-666666666666" };
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const me = { id: auth.userId, name: "Terry", roleLabel: "Admin", isExternal: false, active: true };
const versionOf = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset2, version: 2, current: true, reviewStatus: "in_review", uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 90000, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: true, streamUrl: `/media/video/${ids.asset2}`, posterUrl: `/media/video/${ids.asset2}/poster`, ...over });
const videoOf = (): VideoDto => ({ id: ids.video, reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ids.asset2, latestNoteCount: null, uploading: null, versions: [versionOf(), versionOf({ assetId: ids.asset1, version: 1, current: false, reviewStatus: "in_review", uploadedBy: me, createdAt: "2026-10-06T01:00:00.000Z", fps: { num: 30000, den: 1001 }, tcNominalFps: 30, tcDropFrame: true, startTimecodeFrames: null, streamUrl: `/media/video/${ids.asset1}`, posterUrl: null, hasPoster: false })] }) as VideoDto;

/** What the notes read answers (#881's count): the threads, or a read that never settles. */
let notesFixture: VideoNoteThreadDto[] = [];
let notesRead: "ok" | "pending" = "ok";
const noteOf = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`, assetId: ids.asset2, parentId: null, author: { kind: "staff", person: mia }, authorRole: "editor", visibility: "public", startFrame: 100 + n, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: `Note ${n}`, deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, copiedFrom: null, replies: [], ...over,
}) as unknown as VideoNoteThreadDto;

let stub: VideoElementStub;
let root: Root | null = null; let host: HTMLElement;
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const approvedEvent = { id: "55555555-5555-4555-8555-555555555555", revision: 1, decision: "approved", note: null, at: "2026-10-10T01:00:00.000Z", actor: { kind: "guest", name: "Sam Client" }, link: { id: "44444444-4444-4444-8444-444444444441", label: "Owner link" } };
async function mount(parts: Array<"delivery" | "notes">, role: Role = "editor", approved = false) {
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [videoOf()] };
    if (path.endsWith("/decisions")) return { versions: [{ assetId: ids.asset2, version: 2, events: approved ? [approvedEvent] : [], release: null }, { assetId: ids.asset1, version: 1, events: [], release: null }] };
    if (path.includes("/notes")) { if (notesRead === "pending") return new Promise(() => undefined); return { notes: notesFixture }; }
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role={role}><VideoCollectionPanel projectId={PROJECT} role={role} review={{ open: true, parts }} /></QuincyQueryProvider>); });
  await flush();
}
const openButton = () => document.querySelector<HTMLElement>('[data-testid="video-card-open"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function openViewer() {
  await act(async () => { openButton().click(); });
  const deadline = Date.now() + 10_000;
  while (!dialog()) { if (Date.now() > deadline) throw new Error("the review viewer never mounted"); await flush(1); }
  await flush(6);
}
async function panelLoaded() { const deadline = Date.now() + 10_000; while (!panel()) { if (Date.now() > deadline) throw new Error("the delivery panel never mounted"); await flush(1); } await flush(4); }
const panel = () => document.querySelector('[data-testid="video-delivery"]');

let shim: ReturnType<typeof installLocalStorageShim>; let viewport: MockViewport;
beforeEach(() => { notesFixture = []; notesRead = "ok"; shim = installLocalStorageShim(); resetUiPrefMemory(); viewport = mockViewport({ width: 1440 }); stub = installVideoElementStub(); apiGetMock.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))); });
afterEach(async () => { viewport.restore(); shim.restore(); if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });


const PANE = REVIEW_PANE_KEY;
/** ⇥ lives in the pane (mounted even when collapsed, hidden); ⇤ lives in the strip and exists only while the pane is closed. */
const hide = () => document.querySelector<HTMLButtonElement>('[data-testid="video-pane-hide"]');
const show = () => document.querySelector<HTMLButtonElement>('[data-testid="video-pane-show"]');
const strip = () => document.querySelector<HTMLElement>('[data-testid="video-review-strip"]');
/** Whichever of the two is the live control right now. */
const toggle = () => show() ?? hide();
/** The pane when it is showing; a collapsed pane stays mounted but hidden (`mountedPane`). */
const mountedPane = () => document.querySelector<HTMLElement>('[data-testid="video-review-pane"]');
const pane = () => { const el = mountedPane(); return el && !el.hidden ? el : null; };
const handle = () => document.querySelector<HTMLElement>('[data-testid="video-review-handle"]');
const splitRow = () => document.querySelector<HTMLElement>('[data-testid="video-review-split"]')!;
const filmNode = () => document.querySelector("video");
const saved = () => JSON.parse(shim.values.get(PANE) ?? "null") as { open: boolean; width: number } | null;
const now = (el: Element) => Number(el.getAttribute("aria-valuenow"));
const press = async (target: Element, k: string, init: KeyboardEventInit = {}) => { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); }); };
const pointer = async (target: Element, type: string, clientX: number) => { await act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })); }); };
const hostWidth = (width: number) => { Object.defineProperty(splitRow(), "clientWidth", { configurable: true, value: width }); };

/** The notes host is a lazy chunk and the player lives inside it: wait for the film too. */
async function openViewerWithFilm() { await openViewer(); const deadline = Date.now() + 10_000; while (!document.querySelector("video")) { if (Date.now() > deadline) throw new Error("the film never mounted"); await flush(1); } await flush(4); }

describe("VideoReviewViewer dark panels (ADR 0024, #877)", () => {
  it("opens no default-scope panel in the viewer: only the toast slot may re-scope to the light look", async () => {
    await mount(["delivery", "notes"]);
    await openViewerWithFilm();
    await panelLoaded(); // the delivery panel is a lazy chunk: the assertion below means nothing until it is in the DOM
    const viewer = document.querySelector('[data-testid="video-review-viewer"]')!;
    expect(viewer.querySelector('[data-testid="video-delivery"]')!.closest('[data-surface="default"]')).toBeNull();
    // Whatever default scope exists is the toast viewport's `display: contents` wrapper, nothing else.
    for (const el of viewer.querySelectorAll('[data-surface="default"]')) expect(el.classList.contains("contents")).toBe(true);
  });

  it("keeps the dialog scrim behind the viewer on a desktop: the phone's solid ink backdrop is the phone's only (#879 fix r7)", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const overlay = document.querySelector<HTMLElement>('[data-testid="video-review-backdrop"]')!;
    expect(overlay.className).toContain("bg-[var(--scrim-overlay)]");
    expect(overlay.className).not.toContain("bg-background");
    expect(overlay.hasAttribute("data-surface")).toBe(false);
    // The ink canvas under the viewer is the phone's only (#879 fix r11).
    expect(document.documentElement.hasAttribute("data-ink-canvas")).toBe(false);
  });
});

describe("VideoReviewViewer layout (#859): full-height player, collapsible and resizable side pane", () => {
  it("opens with the pane open at 380px, the toggle expanded, and the player first in the row", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle()!.getAttribute("aria-label")).toBe("Hide notes");
    expect(pane()!.querySelector('aside[aria-label="Notes"]')).not.toBeNull();
    expect(now(handle()!)).toBe(380);
    expect(pane()!.style.getPropertyValue("--review-pane-w")).toBe("380px");
    expect(splitRow().firstElementChild!.querySelector("video")).not.toBeNull();
  });

  it("the toggle collapses the pane (the film is the same node, still first) and expands it again, and the choice is saved", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const film = filmNode();
    await act(async () => { toggle()!.click(); });
    expect(pane()).toBeNull();
    expect(handle()).toBeNull();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(filmNode()).toBe(film);
    expect(saved()).toEqual({ open: false, width: 380 });
    await act(async () => { toggle()!.click(); });
    expect(pane()).not.toBeNull();
    expect(filmNode()).toBe(film);
    expect(saved()).toEqual({ open: true, width: 380 });
  });

  it("collapsing hides the pane without unmounting it: its contents are the same nodes, inert and out of the tab order, when it reopens", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const aside = mountedPane()!.querySelector("aside")!;
    await act(async () => { toggle()!.click(); });
    expect(mountedPane()).not.toBeNull();
    expect(mountedPane()!.hidden).toBe(true);
    expect(mountedPane()!.hasAttribute("inert")).toBe(true);
    expect(mountedPane()!.style.display).toBe("none");
    expect(handle()).toBeNull();
    await act(async () => { toggle()!.click(); });
    expect(mountedPane()!.hidden).toBe(false);
    expect(mountedPane()!.hasAttribute("inert")).toBe(false);
    expect(mountedPane()!.querySelector("aside")).toBe(aside);
  });

  it("a row too narrow for the smallest pane and a 480px player lays the pane out collapsed without writing the saved preference; the toggle shows it for the visit", async () => {
    shim.values.set(PANE, JSON.stringify({ open: true, width: 400 }));
    await mount(["notes"]);
    // the row is measured when the viewer mounts: give every element 740px of width, as a 740px window has
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 740 });
    try {
      await openViewerWithFilm();
      expect(pane()).toBeNull();
      expect(handle()).toBeNull();
      expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
      expect(JSON.parse(shim.values.get(PANE)!)).toEqual({ open: true, width: 400 });
      await act(async () => { toggle()!.click(); });
      expect(pane()).not.toBeNull();
      expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
      expect(handle()).toBeNull();
      expect(JSON.parse(shim.values.get(PANE)!)).toEqual({ open: true, width: 400 });
    } finally { if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth; }
  });

  it("collapsing with focus inside the pane moves focus to the strip button", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const inside = pane()!.querySelector<HTMLElement>("button, textarea, [tabindex]")!;
    await act(async () => { inside.focus(); });
    expect(pane()!.contains(document.activeElement)).toBe(true);
    await act(async () => { toggle()!.click(); });
    expect(document.activeElement).toBe(show());
  });

  it("keyboard on the handle resizes (arrows 16px, Shift 64px, Home 300, End 560), persists, and never steps the film", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const writesBefore = stub.writes.length;
    const h = handle()!;
    await act(async () => { h.focus(); });
    await press(h, "ArrowLeft");
    expect(now(handle()!)).toBe(396);
    expect(pane()!.style.getPropertyValue("--review-pane-w")).toBe("396px");
    await press(h, "ArrowLeft", { shiftKey: true });
    expect(now(handle()!)).toBe(460);
    await press(h, "ArrowRight");
    expect(now(handle()!)).toBe(444);
    await press(h, "Home");
    expect(now(handle()!)).toBe(300);
    await press(h, "ArrowRight");
    expect(now(handle()!)).toBe(300);
    await press(h, "End");
    expect(now(handle()!)).toBe(560);
    expect(handle()!.getAttribute("aria-valuemin")).toBe("300");
    expect(handle()!.getAttribute("aria-valuemax")).toBe("560");
    expect(saved()).toEqual({ open: null, width: 560 });
    expect(stub.writes.length).toBe(writesBefore);
  });

  it("dragging the handle left widens the pane live and commits on release", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const h = handle()!;
    await pointer(h, "pointerdown", 1000);
    await pointer(h, "pointermove", 950);
    expect(now(handle()!)).toBe(430);
    expect(saved()).toBeNull();
    await pointer(h, "pointermove", 1100);
    expect(now(handle()!)).toBe(300);
    await pointer(h, "pointermove", 940);
    await pointer(h, "pointerup", 940);
    expect(now(handle()!)).toBe(440);
    // A resize is not a show / hide choice: a never-chosen pane stays never chosen.
    expect(saved()).toEqual({ open: null, width: 440 });
  });

  it("always leaves the player 480px: the ceiling is the row minus 480, and the saved preference is kept when the row is narrow", async () => {
    shim.values.set(PANE, JSON.stringify({ open: true, width: 540 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(now(handle()!)).toBe(540);
    hostWidth(900);
    const h = handle()!;
    await press(h, "ArrowLeft");
    expect(handle()!.getAttribute("aria-valuemax")).toBe("420");
    expect(now(handle()!)).toBe(420);
    await press(h, "End");
    expect(now(handle()!)).toBe(420);
  });

  it("restores the saved open state and width on the next open, and falls back to the defaults for a junk value", async () => {
    shim.values.set(PANE, JSON.stringify({ open: false, width: 500 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).toBeNull();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { toggle()!.click(); });
    expect(now(handle()!)).toBe(500);
  });

  it("a junk stored value reads as open at 380", async () => {
    shim.values.set(PANE, "{{{not json");
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(now(handle()!)).toBe(380);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("an I mark while the pane is collapsed opens it, so the composer is where the person can see it", async () => {
    shim.values.set(PANE, JSON.stringify({ open: false, width: 360 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).toBeNull();
    const film = document.querySelector("video")!;
    await act(async () => { stub.loadMetadata(film, { duration: 12 }); });
    await press(document.querySelector('[data-testid="video-review-viewer"]')!, "i");
    await flush(4);
    expect(pane()).not.toBeNull();
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("with notes off the Version details are the pane, the toggle says Details, and it collapses the same way", async () => {
    await mount([]);
    await openViewerWithFilm();
    expect(toggle()!.getAttribute("aria-label")).toBe("Hide details");
    expect(pane()!.querySelector('aside[aria-label="Version details"]')).not.toBeNull();
    await act(async () => { toggle()!.click(); });
    expect(pane()).toBeNull();
  });

  describe("delivery", () => {
    /** A tab's name without the Notes tab's open-note count (W1: "Notes 0 open" to a screen reader). */
    const tabName = (t: Element) => t.textContent!.replace(/ \d+ open$/, "");
    const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => tabName(t) === name)!;
    const tabpanel = (name: string) => document.getElementById(tab(name).getAttribute("aria-controls")!)!;

    it("is a Delivery tab beside Notes in the pane, so the player takes the full column; both panels stay mounted", async () => {
      await mount(["delivery", "notes"]);
      await openViewerWithFilm();
      await panelLoaded();
      expect([...document.querySelectorAll('[role="tab"]')].map(tabName)).toEqual(["Notes", "Delivery"]);
      expect(pane()!.contains(panel())).toBe(true);
      expect(document.querySelector('[data-testid="video-review-player"]')!.contains(panel())).toBe(false);
      expect(tab("Notes").getAttribute("aria-selected")).toBe("true");
      expect(tabpanel("Delivery").hidden).toBe(true);
      expect(pane()!.querySelector('aside[aria-label="Notes"]')).not.toBeNull();
      await act(async () => { tab("Delivery").click(); });
      expect(tabpanel("Delivery").hidden).toBe(false);
      expect(tabpanel("Notes").hidden).toBe(true);
      expect(pane()!.querySelector('aside[aria-label="Notes"]')).not.toBeNull();
    });

    it("with notes off the desktop pane is Delivery alone: no tablist, the Version details behind the head's button (#881, D8)", async () => {
      await mount(["delivery"]);
      await openViewerWithFilm();
      await panelLoaded();
      expect(document.querySelector('[role="tablist"]')).toBeNull();
      expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
      const heading = document.querySelector<HTMLElement>('[data-testid="video-pane-delivery-heading"]')!;
      expect(heading.textContent).toBe("Delivery");
      const region = panel()!.closest<HTMLElement>('[role="region"]')!;
      expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
      expect(region.hidden).toBe(false);
      expect(heading.parentElement!.contains(document.querySelector('[data-testid="video-details-button"]'))).toBe(true);
      expect(heading.parentElement!.contains(hide())).toBe(true);
      expect(toggle()!.getAttribute("aria-label")).toBe("Hide delivery");
      await act(async () => { document.querySelector<HTMLElement>('[data-testid="video-details-button"]')!.click(); });
      await flush(2);
      expect(document.querySelector('[data-testid="video-details-popover"]')!.textContent).toContain("Uploaded by");
    });

    it("with notes off, crossing to a phone keeps the Details · Delivery tabs, and the delivery panel is never remounted (#881)", async () => {
      await mount(["delivery"]);
      await openViewerWithFilm();
      await panelLoaded();
      // The panel's own box is a Frame on a phone and bare in the pane (#878); what holds it, and its state (a confirmation it has open), must survive the crossing.
      const holder = panel()!.parentElement;
      await act(async () => { document.querySelector<HTMLElement>('[data-testid="delivery-record-approved"]')!.click(); });
      await flush(2);
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await viewport.set({ width: 390 });
      await flush(4);
      expect([...document.querySelectorAll('[role="tab"]')].map(tabName)).toEqual(["Details", "Delivery"]);
      expect(panel()!.parentElement).toBe(holder);
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await viewport.set({ width: 1440 });
      await flush(4);
      expect(document.querySelector('[role="tablist"]')).toBeNull();
      expect(panel()!.parentElement).toBe(holder);
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    });

    it("arrows on a focused tab move between tabs and do not step the film", async () => {
      await mount(["delivery", "notes"]);
      await openViewerWithFilm();
      await panelLoaded();
      const writesBefore = stub.writes.length;
      await act(async () => { tab("Notes").focus(); });
      await press(tab("Notes"), "ArrowRight");
      expect(stub.writes.length).toBe(writesBefore);
    });
  });

  describe("phone", () => {
    it("is the notes sheet under the film: no toggle, no handle, Notes and Delivery tabs in the sheet (not under the player), and the film is the same node across the breakpoint", async () => {
      await mount(["delivery", "notes"]);
      await openViewerWithFilm();
      await panelLoaded();
      const film = filmNode();
      await viewport.set({ width: 390 });
      await flush(4);
      expect(toggle()).toBeNull();
      expect(handle()).toBeNull();
      expect(pane()!.querySelector('aside[aria-label="Notes"]')).not.toBeNull();
      expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent!.replace(/ \d+ open$/, ""))).toEqual(["Notes", "Delivery"]);
      expect(pane()!.getAttribute("data-stop")).toBe("half");
      expect(document.querySelector('[data-testid="video-review-player"]')!.contains(panel())).toBe(false);
      expect(pane()!.contains(panel())).toBe(true);
      expect(filmNode()).toBe(film);
    });

    it("a collapsed desktop preference does not hide the pane on a phone", async () => {
      shim.values.set(PANE, JSON.stringify({ open: false, width: 360 }));
      viewport.restore(); viewport = mockViewport({ width: 390 });
      await mount(["notes"]);
      await openViewerWithFilm();
      expect(pane()).not.toBeNull();
      expect(toggle()).toBeNull();
    });
  });
});

describe("VideoReviewViewer pane-side collapse control (#877 S2)", () => {
  it("puts hide (⇥) inside the pane and keeps it out of the top bar; no strip while open", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()!.contains(hide())).toBe(true);
    expect(hide()!.getAttribute("aria-label")).toBe("Hide notes");
    expect(hide()!.getAttribute("aria-expanded")).toBe("true");
    expect(hide()!.getAttribute("aria-controls")).toBe(mountedPane()!.id);
    expect(document.querySelector("header")!.querySelector('[data-testid="video-pane-hide"], [data-testid="video-pane-show"]')).toBeNull();
    expect(strip()).toBeNull();
    expect(document.querySelector('[data-testid="video-pane-toggle"]')).toBeNull();
  });

  it("collapsed: a slim strip with ⇤ is the last child of the row, labelled Show notes", async () => {
    shim.values.set(PANE, JSON.stringify({ open: false, width: 360 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(strip()).not.toBeNull();
    expect(splitRow().lastElementChild).toBe(strip());
    expect(strip()!.contains(show())).toBe(true);
    expect(show()!.getAttribute("aria-label")).toBe("Show notes");
    expect(show()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("with notes off the labels say details", async () => {
    await mount([]);
    await openViewerWithFilm();
    expect(hide()!.getAttribute("aria-label")).toBe("Hide details");
    await act(async () => { hide()!.click(); });
    expect(show()!.getAttribute("aria-label")).toBe("Show details");
  });

  it("focus goes hide to show to hide, the film node survives, and the width and choice are remembered", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const film = filmNode();
    await act(async () => { hide()!.focus(); });
    await act(async () => { hide()!.click(); });
    expect(document.activeElement).toBe(show());
    expect(filmNode()).toBe(film);
    expect(saved()).toEqual({ open: false, width: 380 });
    await act(async () => { show()!.click(); });
    expect(document.activeElement).toBe(hide());
    expect(strip()).toBeNull();
    expect(filmNode()).toBe(film);
    expect(saved()).toEqual({ open: true, width: 380 });
  });

  it("revealing the pane another way (an I mark) moves no focus", async () => {
    shim.values.set(PANE, JSON.stringify({ open: false, width: 360 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    const film = document.querySelector("video")!;
    await act(async () => { stub.loadMetadata(film, { duration: 12 }); });
    const viewer = document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]')!;
    await act(async () => { viewer.focus(); });
    await press(viewer, "i");
    await flush(4);
    expect(pane()).not.toBeNull();
    expect(document.activeElement).not.toBe(hide());
  });

  it("with Delivery on, hide sits beside the tabs and the tab panels keep their parent", async () => {
    await mount(["delivery", "notes"]);
    await openViewerWithFilm();
    await panelLoaded();
    const tabs = document.querySelector('[role="tablist"]')!;
    expect(tabs.parentElement!.contains(hide())).toBe(true);
    const content = document.querySelector('[role="tabpanel"]')!;
    const parent = content.parentElement;
    await act(async () => { hide()!.click(); });
    await act(async () => { show()!.click(); });
    expect(document.querySelector('[role="tabpanel"]')).toBe(content);
    expect(content.parentElement).toBe(parent);
  });

  it("Version details: the heading and hide share one row", async () => {
    await mount([]);
    await openViewerWithFilm();
    const heading = pane()!.querySelector("h3")!;
    expect(heading.parentElement!.contains(hide())).toBe(true);
  });

  it("a phone has no collapse control", async () => {
    viewport.restore(); viewport = mockViewport({ width: 390 });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(hide()).toBeNull();
    expect(show()).toBeNull();
    expect(strip()).toBeNull();
  });
});

describe("VideoReviewViewer desktop rail (#881)", () => {
  const RESOLVED = { at: "2026-10-11T00:00:00.000Z", by: mia };
  const viewer = () => document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]')!;
  const stripCount = () => document.querySelector<HTMLElement>('[data-testid="video-pane-strip-count"]');
  const n = async (target: Element = viewer(), init: KeyboardEventInit = {}) => { await press(target, "n", init); await flush(2); };

  it("W2: the collapsed strip is one button showing the open count, and reopens the pane with the same film node", async () => {
    notesFixture = [noteOf(1), noteOf(2), noteOf(3, { resolved: RESOLVED })];
    shim.values.set(PANE, JSON.stringify({ open: false, width: 380 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    const film = filmNode();
    expect(strip()!.querySelectorAll("button")).toHaveLength(1);
    expect(show()!.getAttribute("aria-label")).toBe("Show notes, 2 open");
    expect(stripCount()!.textContent).toBe("2");
    expect(stripCount()!.getAttribute("aria-hidden")).toBe("true");
    expect(show()!.contains(stripCount())).toBe(true);
    expect(show()!.getAttribute("aria-keyshortcuts")).toBe("N");
    await act(async () => { show()!.click(); });
    expect(pane()).not.toBeNull();
    expect(filmNode()).toBe(film);
  });

  it("D22: the strip shows no count at 0, and none while the notes are still loading", async () => {
    notesFixture = [noteOf(1, { resolved: RESOLVED })];
    shim.values.set(PANE, JSON.stringify({ open: false, width: 380 }));
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(show()!.getAttribute("aria-label")).toBe("Show notes");
    expect(stripCount()).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    notesRead = "pending";
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(show()!.getAttribute("aria-label")).toBe("Show notes");
    expect(stripCount()).toBeNull();
  });

  it("W1: the Notes tab shows the open count on a desktop too", async () => {
    notesFixture = [noteOf(1), noteOf(2), noteOf(3, { resolved: RESOLVED })];
    await mount(["delivery", "notes"]);
    await openViewerWithFilm();
    await panelLoaded();
    const count = document.querySelector('[data-testid="video-pane-tab-count"]')!;
    expect(count.textContent).toBe("2");
    expect(document.querySelector('[data-testid="video-pane-tab-main"]')!.textContent).toBe("Notes 2 open");
  });

  it("N with focus on the viewer collapses the pane and shows it again, remembers the choice, and never touches the film", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const film = filmNode();
    const writes = stub.writes.length;
    await act(async () => { viewer().focus(); });
    await n();
    expect(pane()).toBeNull();
    expect(strip()).not.toBeNull();
    expect(saved()).toEqual({ open: false, width: 380 });
    // Showing it by the shortcut moves no focus.
    await n();
    expect(pane()).not.toBeNull();
    expect(saved()).toEqual({ open: true, width: 380 });
    expect(document.activeElement).toBe(viewer());
    expect(filmNode()).toBe(film);
    expect(stub.writes.length).toBe(writes);
  });

  it("N with focus inside the pane moves focus to the strip as the pane hides", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const inside = pane()!.querySelector<HTMLElement>('[data-testid="video-pane-hide"]')!;
    await act(async () => { inside.focus(); });
    await n(inside);
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(show());
  });

  it("N typed into the composer is a letter, and Cmd+N, Ctrl+N, Shift+N and a held N do nothing", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const field = document.getElementById("video-note-body")!;
    const editable = field.matches('[contenteditable="true"], textarea') ? field : field.querySelector<HTMLElement>('[contenteditable="true"], textarea')!;
    await act(async () => { editable.focus(); });
    await n(editable);
    expect(pane()).not.toBeNull();
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { repeat: true }]) { await n(viewer(), init); expect(pane(), JSON.stringify(init)).not.toBeNull(); }
    expect(saved()).toBeNull();
  });

  it("N does nothing on a phone", async () => {
    viewport.restore(); viewport = mockViewport({ width: 390 });
    await mount(["notes"]);
    await openViewerWithFilm();
    await n();
    expect(pane()).not.toBeNull();
    expect(saved()).toBeNull();
  });

  it("N does nothing in Full screen, where the pane is hidden for the film", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="video-fullscreen"]')!.click(); });
    await flush(3);
    expect(mountedPane()!.getAttribute("data-immersive")).toBe("watch");
    await n();
    expect(mountedPane()!.getAttribute("data-immersive")).toBe("watch");
    expect(saved()).toBeNull();
  });

  it("hide announces the N shortcut (its tooltip names it too)", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(hide()!.getAttribute("aria-keyshortcuts")).toBe("N");
  });

  it("D18 / W4: a portrait tablet with no remembered choice starts collapsed, live until the person chooses", async () => {
    viewport.restore(); viewport = mockViewport({ width: 834, height: 1112, coarse: true });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).toBeNull();
    expect(strip()).not.toBeNull();
    expect(saved()).toBeNull();
    // Turned sideways (1112 × 834) with no choice made: the pane opens, and nothing is written.
    await viewport.set({ width: 1112, height: 834 });
    await flush(2);
    expect(pane()).not.toBeNull();
    expect(saved()).toBeNull();
    // A choice made in landscape (hide) holds when it turns back, and showing it in portrait holds too.
    await act(async () => { hide()!.click(); });
    expect(saved()).toEqual({ open: false, width: 380 });
    await viewport.set({ width: 834, height: 1112 });
    await flush(2);
    expect(pane()).toBeNull();
    await act(async () => { show()!.click(); });
    expect(saved()).toEqual({ open: true, width: 380 });
    await viewport.set({ width: 1112, height: 834 });
    await viewport.set({ width: 834, height: 1112 });
    await flush(2);
    expect(pane()).not.toBeNull();
  });

  it("D18: a remembered open choice opens on a portrait tablet; landscape and a wide desktop start open", async () => {
    shim.values.set(PANE, JSON.stringify({ open: true, width: 380 }));
    viewport.restore(); viewport = mockViewport({ width: 834, height: 1112, coarse: true });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).not.toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); shim.values.clear(); resetUiPrefMemory();
    viewport.restore(); viewport = mockViewport({ width: 1112, height: 834, coarse: true });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).not.toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    // A portrait window wider than a tablet is a desktop: open.
    viewport.restore(); viewport = mockViewport({ width: 1440, height: 2000 });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).not.toBeNull();
     await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    // A square tablet-width window is not taller than wide (D18: height > width): open (#881 Sol review).
    viewport.restore(); viewport = mockViewport({ width: 1024, height: 1024 });
    await mount(["notes"]);
    await openViewerWithFilm();
    expect(pane()).not.toBeNull();
  });

  it("a drag ends cleanly: another pointer cannot move it, a cancel commits what was drawn, and a collapse mid-drag commits nothing", async () => {
    await mount(["notes"]);
    await openViewerWithFilm();
    const ptr = async (target: Element, type: string, clientX: number, pointerId: number) => { await act(async () => { target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }), { pointerId })); }); };
    let h = handle()!;
    await ptr(h, "pointerdown", 1000, 1);
    await ptr(h, "pointermove", 960, 1);
    expect(now(handle()!)).toBe(420);
    await ptr(h, "pointermove", 800, 2);
    await ptr(h, "pointerup", 800, 2);
    expect(now(handle()!)).toBe(420);
    expect(saved()).toBeNull();
    await ptr(h, "pointercancel", 960, 1);
    expect(saved()).toEqual({ open: null, width: 420 });
    h = handle()!;
    await ptr(h, "pointerdown", 1000, 3);
    await ptr(h, "pointermove", 900, 3);
    expect(now(handle()!)).toBe(520);
    await act(async () => { viewer().focus(); });
    await n();
    expect(handle()).toBeNull();
    expect(saved()).toEqual({ open: false, width: 420 });
    await n();
    expect(now(handle()!)).toBe(420);
  });
});
