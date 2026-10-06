import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager } from "@tanstack/react-query";
import { nearestScrollContainer } from "../lib/scroll-container";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectSheet } from "../components/quincy/ProjectSheet";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { confirm, confirmStore } from "../lib/confirm";
import { QuincyQueryProvider } from "../lib/query-client";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import type { Role } from "@quincy/shared";
import { stubRailMedia } from "../testing/rail-media";
import type { WhiteboardMode } from "@quincy/shared";

// jsdom has no matchMedia: without it the checklist reads as stacked (collapsed) (#377).
stubRailMedia(true);

/**
 * #366 — the REAL Workspace inside a `ProjectSheet`, with the layers that share Escape and outside
 * presses: the Lightbox (rendered in place, inside the sheet popup) and a confirm (portalled to
 * body). `App-project-sheet.dom.test.tsx` covers the layering with a stub Workspace; this file is
 * the seam where Base UI's document-level dismissal meets the Lightbox's window listener.
 * Harness lifted from `ProjectWorkspace.dom.test.tsx`.
 */
const authState = vi.hoisted(() => ({ role: "editor" }));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: vi.fn(() => Promise.resolve({})), apiPatch: (path: string, body?: unknown) => apiPatchMock(path, body), apiDelete: vi.fn(() => Promise.resolve({})) };
});

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

function workspaceAsset(id: string): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

function projectFixture() {
  return {
    id: "p1", street: "12 Example St", suburb: "Suburbia", postcode: "2000",
    agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review",
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null,
    collections: [
      { id: "c-raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 2 },
      { id: "c-edited", kind: "edited", status: "active", expectedCount: null, receivedCount: 1 },
    ],
    members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  };
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}
async function flushUntil(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) break;
    if (Date.now() > deadline) throw new Error(`flushUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
  }
  await flush(5);
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
const escape = (target: EventTarget) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.trim().startsWith(name));
const lightbox = () => document.querySelector('[role="dialog"][aria-label="Photo viewer"]');

/**
 * A keyboard Tab as a browser performs it: dispatch the keydown, and unless something prevented it,
 * move focus to the next/previous tabbable in document order (focus guards included, which is how
 * Floating UI's modal manager wraps focus). happy-dom does not move focus on Tab by itself.
 */
const pressTab = (shift = false) => act(async () => {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  from.dispatchEvent(event);
  if (!event.defaultPrevented) {
    const order = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')].filter((el) => el.getAttribute("tabindex") !== "-1");
    const at = order.indexOf(from);
    const next = order[(at + (shift ? -1 : 1) + order.length) % order.length];
    next?.focus();
  }
  await Promise.resolve();
});
const confirmFocusables = (modal: HTMLElement) => [...modal.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')].filter((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("data-floating-ui-focus-guard"));


const board = vi.hoisted(() => ({ log: [] as string[], mode: "edit" as WhiteboardMode, props: null as null | { onElements?: (e: unknown[]) => void; readOnly?: boolean; imageTool?: boolean; theme?: string; onSave?: () => Promise<void> }, scene: [] as Array<Record<string, unknown>>, send: null as null | ((batch: readonly unknown[]) => Promise<void>), handlers: null as null | { onInit: (init: { mode: WhiteboardMode; elements: unknown[]; sessionId: string; peers: unknown[] }, reconnect: boolean) => void } }));
vi.mock("../lib/whiteboard-socket", () => ({
  openWhiteboardSocket: (_projectId: string, handlers: { onInit: (init: { mode: WhiteboardMode; elements: unknown[]; sessionId: string; peers: unknown[] }, reconnect: boolean) => void; onConnection: (state: string) => void }) => {
    board.handlers = handlers;
    queueMicrotask(() => { handlers.onConnection("open"); handlers.onInit({ mode: board.mode, elements: [], sessionId: "me", peers: [] }, false); });
    return { send: (batch: readonly unknown[]) => (board.send ? board.send(batch) : Promise.resolve()), sendPresence: () => undefined, close: () => { board.log.push("close"); } };
  },
}));
vi.mock("../components/reui/whiteboard/whiteboard", () => ({
  Whiteboard: (props: { readOnly?: boolean; imageTool?: boolean; theme?: string; onSave?: () => Promise<void>; onReady?: (controller: unknown) => void; onElements?: (e: unknown[]) => void }) => { board.props = props; props.onElements?.(board.scene); props.onReady?.({ api: { getSceneElementsIncludingDeleted: () => board.scene, getAppState: () => ({ editingTextElement: null, resizingElement: null, newElement: null }) }, applyRemote: () => board.scene, adoptRevisions: () => undefined, setCollaborators: () => undefined }); return <div data-testid="whiteboard-stand-in" tabIndex={0}>board</div>; },
}));

const onRequestClose = vi.fn();
const onOpenWhiteboard = vi.fn();
const onCloseWhiteboard = vi.fn();

const sheetUi = (props: { whiteboardOpen?: boolean } = {}): ReactNode => (
  <QuincyQueryProvider key="test" principalId="test-user" role={authState.role as Role}>
    <ProjectSheet open kind="project" sheetKey="project:p1" backdropHref="/" onRequestClose={onRequestClose}>
      <ProjectWorkspace projectId="p1" onArrivalConsumed={() => undefined} whiteboardOpen={props.whiteboardOpen} onOpenWhiteboard={onOpenWhiteboard} onCloseWhiteboard={onCloseWhiteboard} />
    </ProjectSheet>
    <ConfirmModalHost />
  </QuincyQueryProvider>
);
const rerenderSheet = (props: { whiteboardOpen?: boolean }) => act(async () => { root!.render(sheetUi(props)); await Promise.resolve(); });

async function renderSheet(props: { whiteboardOpen?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(sheetUi(props)); await Promise.resolve(); });
  await flushUntil(() => tab("Collaboration") !== undefined, "the Workspace tabs inside the sheet");
  return host;
}

let archived = false;
beforeEach(() => {
  authState.role = "editor";
  archived = false;
  board.log = []; board.mode = "edit"; board.props = null; board.scene = []; board.send = null; board.handlers = null;
  onRequestClose.mockReset(); onOpenWhiteboard.mockReset(); onCloseWhiteboard.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset().mockResolvedValue({});
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), archivedAt: archived ? "2026-07-01T00:00:00.000Z" : null });
    if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
    if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
    if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
    if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
    if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
    if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
    if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
    return Promise.resolve({});
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

const openButton = () => document.querySelector<HTMLButtonElement>('[data-testid="project-whiteboard-open"]');
const boardRoot = () => document.querySelector<HTMLElement>('[data-testid="project-whiteboard"]');

describe("the whiteboard entry button (#498)", () => {
  it("sits right after the Collaboration tab, outside the tablist, and opens the board through the shell", async () => {
    await renderSheet();
    const button = openButton()!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Open whiteboard");
    expect(button.closest('[role="tablist"]')).toBeNull();
    // Beside the horizontally scrolling tab strip, never inside it (it would scroll out of view at 390px):
    // the strip is the tablist's ancestor that sits directly under the wrapper that also holds the button.
    let strip: Element = tab("Collaboration")!.closest('[role="tablist"]')!;
    while (strip.parentElement && !strip.parentElement.contains(button)) strip = strip.parentElement;
    expect(strip.contains(button)).toBe(false);
    expect(strip.nextElementSibling!.contains(button)).toBe(true);   // a sibling after the scroller
    expect(button.parentElement!.previousElementSibling!.contains(tab("Collaboration")!)).toBe(true);
    await click(button);
    expect(onOpenWhiteboard).toHaveBeenCalledTimes(1);
  });
});

describe("whiteboard focus and layout (#498 design review)", () => {
  it("a deep link lands focus on Close whiteboard, not the sheet popup", async () => {
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    expect(document.activeElement).toBe(document.querySelector('[data-testid="project-whiteboard-close"]'));
  });

  it("closing the board returns focus to the entry button", async () => {
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    await click(document.querySelector('[data-testid="project-whiteboard-close"]')!);
    expect(onCloseWhiteboard).toHaveBeenCalled();
    await rerenderSheet({ whiteboardOpen: false });
    await flush(3);
    expect(boardRoot()).toBeNull();
    expect(document.activeElement).toBe(openButton());
  });

  it("closing a deep-linked board scrolls the selected tab into view (a hidden scroller cannot scroll)", async () => {
    const scrolled: Array<{ selected: string | null; hidden: boolean }> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push({ selected: this.getAttribute("aria-selected"), hidden: this.closest("[data-whiteboard-hidden]")?.getAttribute("data-whiteboard-hidden") === "true" });
    };
    try {
      await renderSheet({ whiteboardOpen: true });
      await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
      // Mounted under the open board: nothing may be driven while the header has no layout.
      expect(scrolled.filter((call) => call.hidden)).toEqual([]);
      scrolled.length = 0;
      await rerenderSheet({ whiteboardOpen: false });
      await flush(3);
      expect(scrolled).toContainEqual({ selected: "true", hidden: false });
    } finally { Element.prototype.scrollIntoView = original; }
  });

  it("the section only subtracts the banner while impersonating (the token is always defined)", async () => {
    await renderSheet({ whiteboardOpen: true });
    const cls = boardRoot()!.className;
    expect(cls).not.toMatch(/(^|\s)(max-\[721px\]:)?h-\[calc\(100dvh-var\(--impersonation-banner-height,0px\)\)\]/);
    expect(cls).toContain("[[data-impersonating]_&]:h-[calc(100dvh-var(--impersonation-banner-height)-var(--space-5)*2-var(--border-width-hair)*2)]");
    expect(cls).toContain("max-[721px]:[[data-impersonating]_&]:h-[calc(100dvh-var(--impersonation-banner-height))]");
  });

  it("the right-hand group, not the heading, takes the free space", async () => {
    await renderSheet({ whiteboardOpen: true });
    const heading = boardRoot()!.querySelector("h2")!;
    expect(heading.className).not.toContain("me-auto");
    expect(heading.nextElementSibling!.className).toContain("ms-auto");
    expect(heading.nextElementSibling!.querySelector('[data-testid="project-whiteboard-status"]')).not.toBeNull();
  });

  it("the tab scroller carries inline/block padding so the focus ring and count chip are not clipped", async () => {
    await renderSheet();
    // The scroller is the tablist's nearest ancestor that clips: it is the one carrying the padding.
    const header = document.querySelector('[data-testid="project-header"]')!;
    let node: HTMLElement | null = tab("Collaboration")!.closest('[role="tablist"]')!.parentElement;
    const padded: string[] = [];
    while (node && node !== header) { if (node.className.includes?.("p-[var(--space-1)]")) padded.push(node.className); node = node.parentElement; }
    expect(padded).toHaveLength(1);
  });
});

describe("the open whiteboard (#498)", () => {
  it("replaces the sheet's body, keeps the Workspace mounted beneath it, and Close returns the tab it was on", async () => {
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    expect(boardRoot()).not.toBeNull();
    expect(board.props).toMatchObject({ readOnly: false, imageTool: false, theme: "light" });
    // The Workspace chrome is hidden, not unmounted: drafts and the sub-tab survive.
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(tab("Collaboration")!.closest("[data-whiteboard-hidden]")?.getAttribute("data-whiteboard-hidden")).toBe("true");
    await click(document.querySelector('[data-testid="project-whiteboard-close"]')!);
    expect(onCloseWhiteboard).toHaveBeenCalledWith("collaboration");
  });

  it("Close flushes the final state through the live socket and waits for its ack before closing", async () => {
    let ack!: () => void; const sent: unknown[][] = [];
    board.send = (batch) => { sent.push([...batch]); return new Promise<void>((resolve) => { ack = resolve; }); };
    board.scene = [{ id: "a", version: 2, versionNonce: 5 }];
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    await click(document.querySelector('[data-testid="project-whiteboard-close"]')!);
    expect(sent).toHaveLength(1);
    expect(onCloseWhiteboard).not.toHaveBeenCalled();     // still waiting for the ack
    await act(async () => { ack(); await Promise.resolve(); });
    await flush(3);
    expect(onCloseWhiteboard).toHaveBeenCalledWith("collaboration");
  });

  it("retries unacknowledged changes once the socket reconnects", async () => {
    const sent: unknown[][] = [];
    board.send = (batch) => { sent.push([...batch]); return sent.length === 1 ? Promise.reject(new Error("dropped")) : Promise.resolve(); };
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    board.scene = [{ id: "a", version: 2, versionNonce: 5 }];
    board.props!.onElements!(board.scene);
    await act(async () => { await board.props!.onSave!().catch(() => undefined); });
    expect(sent).toHaveLength(1);
    await act(async () => { board.handlers!.onInit({ mode: "edit", elements: [], sessionId: "me2", peers: [] }, true); await Promise.resolve(); });
    await flush(3);
    expect(sent).toHaveLength(2);
  });

  it("Close during an autosave that then fails stays open with the error", async () => {
    let fail!: (e: Error) => void; const sent: unknown[][] = [];
    board.send = (batch) => { sent.push([...batch]); return new Promise<void>((_, reject) => { fail = reject; }); };
    board.scene = [{ id: "a", version: 2, versionNonce: 5 }];
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    void board.props!.onSave!().catch(() => undefined);   // the autosave, in flight
    await click(document.querySelector('[data-testid="project-whiteboard-close"]')!);
    expect(sent).toHaveLength(1);                         // Close joined it rather than skipping
    await act(async () => { fail(new Error("dropped")); await Promise.resolve(); });
    await flush(3);
    expect(onCloseWhiteboard).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-whiteboard-status"]')?.textContent).toBe("Not saved");
  });

  it("unmounting with a pending edit still sends it, from the last reported snapshot", async () => {
    const sent: unknown[][] = [];
    board.send = (batch) => { sent.push([...batch]); return Promise.resolve(); };
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    board.props!.onElements!([{ id: "a", version: 3, versionNonce: 9 }]);
    board.scene = [];   // the live editor API is empty by teardown
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    expect(sent.flat()).toEqual([{ id: "a", version: 3, versionNonce: 9 }]);
  });

  it("unmount with an autosave in flight and a newer edit sends the edit before the socket closes", async () => {
    const acks: Array<() => void> = [];
    board.send = (batch) => { board.log.push(`send:${(batch[0] as { version: number }).version}`); return new Promise<void>((resolve) => { acks.push(resolve); }); };
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    board.props!.onElements!([{ id: "a", version: 2, versionNonce: 5 }]);
    void board.props!.onSave!().catch(() => undefined);          // autosave v2, in flight
    board.props!.onElements!([{ id: "a", version: 3, versionNonce: 6 }]);   // then an edit
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    expect(board.log).toEqual(["send:2"]);                       // not closed yet; the edit is queued behind the save
    await act(async () => { acks[0]!(); await new Promise<void>((r) => setTimeout(r, 0)); });
    expect(board.log).toEqual(["send:2", "send:3"]);
    await act(async () => { acks[1]!(); await new Promise<void>((r) => setTimeout(r, 0)); });
    expect(board.log).toEqual(["send:2", "send:3", "close"]);
  });

  it("Close stays open with a visible error when the final save fails, and a second Close leaves", async () => {
    board.send = () => Promise.reject(new Error("The whiteboard did not confirm the save."));
    board.scene = [{ id: "a", version: 2, versionNonce: 5 }];
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    const close = document.querySelector('[data-testid="project-whiteboard-close"]')!;
    await click(close); await flush(3);
    expect(onCloseWhiteboard).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-whiteboard-status"]')?.textContent).toBe("Not saved");
    await click(close); await flush(3);
    expect(onCloseWhiteboard).toHaveBeenCalledWith("collaboration");
  });

  it("an archived Project's board is view-only, and says so", async () => {
    archived = true; board.mode = "view";
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    expect(board.props?.readOnly).toBe(true);
    expect(document.querySelector('[data-testid="project-whiteboard-view-only"]')?.textContent).toBe("View only");
    // One indicator only: the canvas's own pill is off, and a read-only board has no save status to show.
    expect((board.props as { viewOnlyIndicator?: boolean }).viewOnlyIndicator).toBe(false);
    expect(document.querySelector('[data-testid="project-whiteboard-status"]')).toBeNull();
  });

  it("Esc inside the board never closes the sheet", async () => {
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    const inside = document.querySelector<HTMLElement>('[data-testid="whiteboard-stand-in"]')!;
    inside.focus();
    await escape(inside);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(boardRoot()).not.toBeNull();
  });
  it("Esc on the open History sheet closes only that sheet: the Project sheet stays open (#559)", async () => {
    const base = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string) => path.endsWith("/whiteboard/versions") ? Promise.resolve({ generation: 1, versions: [] }) : base(path));
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    await click(document.querySelector('[data-testid="project-whiteboard-history"]')!);
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-history-empty"]') !== null, "the History sheet");
    const inside = document.querySelector<HTMLElement>('[data-testid="whiteboard-history-empty"]')!;
    await escape(inside); await flush(5);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="whiteboard-history-empty"]')).toBeNull();
    expect(boardRoot()).not.toBeNull();
  });
  it("Esc on the toolbar (outside the canvas) never closes the Project sheet either (#559)", async () => {
    await renderSheet({ whiteboardOpen: true });
    await flushUntil(() => document.querySelector('[data-testid="whiteboard-stand-in"]') !== null, "the board");
    const toolbar = document.querySelector<HTMLElement>('[data-testid="project-whiteboard-close"]')!;
    toolbar.focus();
    await escape(toolbar); await flush(5);
    expect(onRequestClose).not.toHaveBeenCalled();
  });
});
