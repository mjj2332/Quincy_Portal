import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSeekSeconds } from "@quincy/shared";
import "./testing/dom-polyfills";
import { installVideoElementStub, type VideoElementStub } from "./testing/video-element";

/**
 * #819, whole app: a staff link to one film and Version (`?tab=video&video=<uuid>&version=<N>`) opens the viewer on it,
 * and opening, closing and switching Version keep the address bar copyable. Everything between the URL and the dialog is
 * real (`App`, the shell router, `locationStore`, the Workspace, the collection panel, the lazy viewer); only the session
 * and the HTTP boundary are stubbed.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const VIDEO_ID = "88888888-8888-4888-8888-888888888888";
const ASSET_2 = "77777777-7777-4777-8777-777777777777";
const ASSET_1 = "66666666-6666-4666-8666-666666666666";
const OTHER_VIDEO = "55555555-5555-4555-8555-555555555555";

vi.mock("./lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Ada Lovelace", role: "admin", authorizationEpoch: 0 } }, isPending: false, refetch: async () => undefined }),
  stopImpersonating: async () => undefined,
  consumeSignInDestination: () => null,
  signOut: async () => undefined,
}));
vi.mock("./components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("./components/video/VideoNoteEditor", async () => await import("./testing/video-note-editor-stub"));
vi.mock("./lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));

const list = vi.hoisted(() => ({ mode: "ok" as "ok" | "fail" | "pending", videos: [] as unknown[], parts: [] as string[], notes: [] as unknown[] }));
const removed = vi.hoisted(() => ({ callbacks: [] as Array<(removal: { assetId: string; videoId: string; video: unknown }) => void> }));
vi.mock("./components/video/VideoVersionMenu", () => ({ VideoVersionMenu: (props: { onRemoved: (removal: { assetId: string; videoId: string; video: unknown }) => void }) => { removed.callbacks.push(props.onRemoved); return null; } }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string, init?: unknown) => Promise<unknown>>());
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: async () => ({ ok: true }), apiPatch: async () => ({ ok: true }), apiDelete: async () => ({ ok: true }) };
});

const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const versionOf = (assetId: string, version: number, current: boolean) => ({ assetId, version, current, uploadedBy: mia, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 1, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, streamUrl: `/media/video/${assetId}`, posterUrl: null });
const videoOf = () => ({ id: VIDEO_ID, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ASSET_2, latestNoteCount: null, uploading: null, versions: [versionOf(ASSET_2, 2, true), versionOf(ASSET_1, 1, false)] });

const COLLECTIONS = ["raw", "edited", "video"].map((kind, index) => ({ id: `c-${index}`, kind, status: "active", expectedCount: null, receivedCount: 1 }));

function serveApi(path: string): Promise<unknown> {
  if (path.startsWith("/api/notifications")) return Promise.resolve({ notifications: [], unreadCount: 0 });
  if (path === "/api/project-access-snapshot") return Promise.resolve({ principal: { id: "u1", role: "admin", authorizationEpoch: 0 }, authorizationFingerprint: "f", projects: [{ projectId: PROJECT_ID, membershipCycleIds: [] }] });
  if (path === `/api/projects/${PROJECT_ID}`) return Promise.resolve({
    id: PROJECT_ID, street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review",
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null, collections: COLLECTIONS, members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  });
  if (path.endsWith("/video-review")) return Promise.resolve({ open: true, parts: list.parts });
  if (path.endsWith("/videos")) {
    if (list.mode === "fail") return Promise.reject(new Error("Films could not be loaded."));
    if (list.mode === "pending") return new Promise(() => undefined);
    return Promise.resolve({ videos: list.videos });
  }
  if (/\/video-versions\/[^/]+\/notes$/.test(path)) return Promise.resolve({ notes: list.notes });
  if (path.includes("/assets?collection=")) return Promise.resolve({ assets: [] });
  if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
  if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: PROJECT_ID, marker: null, latest: null, unreadCount: 0 });
  if (path.includes("comments")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St" }, comments: [] });
  if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
  if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
  if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
  if (path.includes("/links")) return Promise.resolve({ links: [] });
  return Promise.resolve({});
}

import App from "./App";

let root: Root | null = null;
let stub: VideoElementStub;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  stub = installVideoElementStub();
  list.mode = "ok";
  list.videos = [videoOf()];
  list.parts = [];
  list.notes = [];
  removed.callbacks.length = 0;
  apiGetMock.mockReset().mockImplementation(serveApi);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  stub.dispose();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

const currentLocation = () => `${window.location.pathname}${window.location.search}`;
const base = `/projects/${PROJECT_ID}`;
const viewerEl = () => document.querySelector<HTMLElement>('[data-testid="video-review-viewer"]');
const focusInViewer = () => { const viewer = viewerEl(); return viewer !== null && viewer.contains(document.activeElement); };
const cardOpen = () => document.querySelector<HTMLElement>(`[data-testid="video-card-open"][data-video-id="${VIDEO_ID}"]`);
const shownVersion = () => viewerEl()?.querySelector('[data-testid="video-version-label"]')?.textContent ?? null;

async function flushUntil(predicate: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) break;
    if (Date.now() > deadline) throw new Error(`flushUntil timed out waiting for: ${label} [at ${currentLocation()}]`);
  }
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function settle(times = 12) { for (let i = 0; i < times; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function click(element: Element) { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); }); }

async function mountAt(location: string) {
  window.history.replaceState(null, "", location);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); });
}

async function pickVersion(label: string) {
  const trigger = viewerEl()!.querySelector<HTMLElement>('[role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await settle(6);
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(label))!.click(); });
  await settle(8);
}

describe("#819: a link to a film and Version", () => {
  it("a cold link opens the viewer on that Version with focus inside the dialog", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    expect(shownVersion()).toMatch(/^v1/);
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    expect(focusInViewer()).toBe(true);
  });

  it("opening a film from its card writes the URL by replace, and focus stays in the dialog", async () => {
    await mountAt(`${base}?tab=video`);
    await flushUntil(() => cardOpen() !== null, "the film card");
    const depth = window.history.length;
    await click(cardOpen()!);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    await settle();
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=2`);
    expect(window.history.length).toBe(depth);
    expect(focusInViewer()).toBe(true);
  });

  it("closing returns to ?tab=video with focus on the film's card (also after a cold link)", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    const close = [...viewerEl()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
    await click(close);
    await flushUntil(() => viewerEl() === null, "the viewer closed");
    await settle();
    expect(currentLocation()).toBe(`${base}?tab=video`);
    expect(document.activeElement).toBe(cardOpen());
  });

  it("a Version switch rewrites version", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=2`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    await pickVersion("v1");
    expect(shownVersion()).toMatch(/^v1/);
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
  });

  it("an unknown or trashed film strips to ?tab=video: no viewer, no not-found", async () => {
    await mountAt(`${base}?tab=video&video=${OTHER_VIDEO}&version=1`);
    await flushUntil(() => currentLocation() === `${base}?tab=video`, "the strip");
    expect(viewerEl()).toBeNull();
    expect(document.querySelector('[data-testid="video-films"]')).not.toBeNull();
  });

  it("a missing Version opens the current one and the URL is rewritten", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    await settle();
    expect(shownVersion()).toMatch(/^v2/);
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=2`);

    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=9`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    await settle();
    expect(shownVersion()).toMatch(/^v2/);
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=2`);
  });

  it("a loading or failed list never strips the link", async () => {
    list.mode = "pending";
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => document.querySelector('[data-testid="video-films"]') !== null, "the Films section");
    await settle();
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=1`);

    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    list.mode = "fail";
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => document.querySelector('[data-testid="video-films"]') !== null, "the Films section");
    await settle(20);
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
  });

  it("switching to another tab drops video=", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    const close = [...viewerEl()!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Video")!;
    await click(close);
    await flushUntil(() => viewerEl() === null, "the viewer closed");
    const raw = [...document.querySelectorAll<HTMLElement>('[data-testid="project-overview-tab"]')].find((t) => t.textContent?.trim().startsWith("RAW"))!;
    await click(raw);
    await flushUntil(() => currentLocation() === `${base}?tab=raw`, "the RAW tab");
  });

  it("a Version removal that completes after Back to another film does not reopen the removed film", async () => {
    const filmA = { ...videoOf(), id: OTHER_VIDEO, title: "Second", currentAssetId: "44444444-4444-4444-8444-444444444441", versions: videoOf().versions.map((v, i) => ({ ...v, assetId: `44444444-4444-4444-8444-44444444444${i + 1}` })) };
    list.videos = [videoOf(), filmA];
    list.parts = ["trash"];
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=2`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null && removed.callbacks.length > 0, "the viewer with its Version menu");
    const finishRemoval = removed.callbacks[0]!;
    const location = `${base}?tab=video&video=${OTHER_VIDEO}&version=2`;
    await act(async () => { window.history.pushState(null, "", location); window.dispatchEvent(new PopStateEvent("popstate")); });
    await flushUntil(() => shownVersion()?.startsWith("v2") === true && removed.callbacks.length > 1, "film A on show");
    await act(async () => { finishRemoval({ assetId: ASSET_2, videoId: VIDEO_ID, video: { ...videoOf(), currentAssetId: ASSET_1, versions: [videoOf().versions[1]] } }); });
    await settle();
    expect(currentLocation()).toBe(location);
  });

  it("Back and Forward render the entry's selection", async () => {
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
    await flushUntil(() => viewerEl() !== null && shownVersion() !== null, "the viewer");
    // An entry the viewer's own writes never made: a person's history holds distinct selections.
    await act(async () => { window.history.pushState(null, "", `${base}?tab=video&video=${VIDEO_ID}&version=2`); window.dispatchEvent(new PopStateEvent("popstate")); });
    await flushUntil(() => shownVersion()?.startsWith("v2") === true, "Forward onto v2");
    await act(async () => { window.history.back(); });
    await flushUntil(() => shownVersion()?.startsWith("v1") === true, "Back onto v1");
    expect(currentLocation()).toBe(`${base}?tab=video&video=${VIDEO_ID}&version=1`);
  });
});

describe("#835: a link to a note", () => {
  const NOTE_OPEN = "00000000-0000-4000-8000-000000000201";
  const NOTE_RESOLVED = "00000000-0000-4000-8000-000000000202";
  const threadOf = (id: string) => document.querySelector<HTMLElement>(`[data-testid="video-note-thread"][data-note-id="${id}"]`);
  const noteOf = (id: string, startFrame: number, over: Record<string, unknown> = {}) => ({
    id, assetId: ASSET_2, parentId: null, author: { kind: "staff", person: mia }, authorRole: "editor", visibility: "public", startFrame, endFrame: null, drawingFrame: null, hasMarkup: false,
    body: `Note at ${startFrame}`, deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:01.000Z", editedAt: null, copiedFrom: null, replies: [], ...over,
  });
  async function openNoteLink(noteId: string) {
    list.parts = ["notes"];
    await mountAt(`${base}?tab=video&video=${VIDEO_ID}&version=2&note=${noteId}`);
    await flushUntil(() => viewerEl()?.querySelector("video") != null, "the review player");
    const video = viewerEl()!.querySelector("video")!;
    await act(async () => { stub.loadMetadata(video, { duration: 12, videoWidth: 1920, videoHeight: 1080 }); });
    await act(async () => { stub.finishSeek(video); stub.presentFrame(video, 0); });
    await flushUntil(() => threadOf(noteId)?.dataset.selected === "true", "the linked thread to be selected");
    return video;
  }

  it("a note= link selects the thread and seeks the film to its frame", async () => {
    list.notes = [noteOf(NOTE_OPEN, 50), noteOf("00000000-0000-4000-8000-000000000203", 10)];
    const video = await openNoteLink(NOTE_OPEN);
    expect(threadOf("00000000-0000-4000-8000-000000000203")?.dataset.selected).toBe("false");
    expect(video.currentTime).toBe(frameSeekSeconds(50, { num: 25, den: 1 }));
  });

  it("a note= link to a note since resolved opens the filters so the thread is listed and selected", async () => {
    list.notes = [noteOf(NOTE_OPEN, 50), noteOf(NOTE_RESOLVED, 200, { resolved: { at: "2026-10-10T00:00:05.000Z", by: mia } })];
    const video = await openNoteLink(NOTE_RESOLVED);
    expect(threadOf(NOTE_RESOLVED)?.dataset.resolved).toBe("true");
    expect(video.currentTime).toBe(frameSeekSeconds(200, { num: 25, den: 1 }));
  });
});
