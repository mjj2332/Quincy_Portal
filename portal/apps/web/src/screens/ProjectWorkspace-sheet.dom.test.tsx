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

const onRequestClose = vi.fn();

async function renderSheet(props: { arrivalTab?: "raw" | "collaboration"; arrivalSignal?: number } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const ui: ReactNode = (
    <QuincyQueryProvider key="test" principalId="test-user" role={authState.role as Role}>
      <ProjectSheet open kind="project" sheetKey="project:p1" backdropHref="/" onRequestClose={onRequestClose}>
        <ProjectWorkspace projectId="p1" arrivalSignal={props.arrivalSignal} arrivalTab={props.arrivalTab} onArrivalConsumed={() => undefined} />
      </ProjectSheet>
      <ConfirmModalHost />
    </QuincyQueryProvider>
  );
  await act(async () => { root!.render(ui); await Promise.resolve(); });
  await flushUntil(() => tab("Collaboration") !== undefined, "the Workspace tabs inside the sheet");
  return host;
}

beforeEach(() => {
  authState.role = "editor";
  onRequestClose.mockReset();
  apiGetMock.mockReset();
  apiPatchMock.mockReset().mockResolvedValue({});
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
    if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1"), workspaceAsset("raw-2")] });
    if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
    if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
    if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
    if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
    if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
    if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
    return Promise.resolve({});
  });
});

afterEach(async () => {
  while (confirmStore.getSnapshot()) confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("the real Workspace inside the Project sheet (#366)", () => {
  it("an arrival lands focus on its tab trigger: the sheet's initial focus does not override #337", async () => {
    await renderSheet({ arrivalTab: "raw", arrivalSignal: 1 });
    await flush(20);
    expect(document.querySelector('[data-testid="project-sheet"]')!.contains(document.activeElement)).toBe(true);
    expect(tab("RAW")!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("RAW"));
  });

  it("the header carries no second 'Dashboard' leave control: the sheet's close button is the way out", async () => {
    await renderSheet();
    const header = document.querySelector('[data-testid="project-header"]')!;
    expect(header).not.toBeNull();
    expect([...header.querySelectorAll("a")].some((link) => link.textContent?.includes("Dashboard"))).toBe(false);
    expect(document.querySelector('[data-testid="project-sheet-close"]')).not.toBeNull();
  });

  it("Escape with the Lightbox open closes only the Lightbox; the next Escape asks the sheet to close", async () => {
    await renderSheet();
    await click(tab("RAW")!);
    await flush(20);
    await click(document.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]')!);
    await flush();
    expect(lightbox()).not.toBeNull();
    // The Lightbox is rendered in place: inside the sheet's own popup.
    expect(document.querySelector('[data-testid="project-sheet"]')!.contains(lightbox())).toBe(true);

    await escape(document.activeElement ?? document.body);
    await flush();
    expect(lightbox()).toBeNull();
    expect(onRequestClose).not.toHaveBeenCalled();

    await escape(document.activeElement ?? document.body);
    await flush();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("a confirm raised from inside the sheet traps focus in the confirm; Escape closes it alone", async () => {
    await renderSheet();
    const inner = document.querySelector<HTMLElement>('[data-testid="project-sheet-body"] button')!;
    inner.focus();
    let answer: boolean | undefined;
    await act(async () => { void confirm({ title: "Delete comment?", message: "This cannot be undone.", danger: true }).then((value) => { answer = value; }); await Promise.resolve(); });
    await flushUntil(() => document.querySelector('[data-testid="confirm-modal"]') !== null, "the confirm modal");
    const modal = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]')!;
    expect(modal.contains(document.activeElement)).toBe(true);

    // Real traversal: Tab from the last focusable wraps to the first; Shift+Tab from the first wraps to the last.
    const focusables = confirmFocusables(modal);
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    await act(async () => { last.focus(); await Promise.resolve(); });
    await pressTab();
    await flush(3);
    expect(document.activeElement).toBe(first);
    await pressTab(true);
    await flush(3);
    expect(document.activeElement).toBe(last);
    // Focus never reached the sheet body beneath the confirm.
    expect(document.querySelector('[data-testid="project-sheet"]')!.contains(document.activeElement)).toBe(false);

    await escape(modal);
    await flushUntil(() => document.querySelector('[data-testid="confirm-modal"]') === null, "the confirm to close");
    expect(answer).toBe(false);
    // Focus returns to the control that raised the confirm.
    expect(document.activeElement).toBe(inner);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-sheet"]')).not.toBeNull();
  });

  it("Escape on a confirm raised from inside the sheet answers it alone: the sheet stays open", async () => {
    await renderSheet();
    let answer: boolean | undefined;
    await act(async () => { void confirm({ title: "Delete comment?", message: "Sure?", danger: true }).then((value) => { answer = value; }); await Promise.resolve(); });
    await flushUntil(() => document.querySelector('[data-testid="confirm-modal"]') !== null, "the confirm modal");
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => answer !== undefined, "the confirm to resolve");
    expect(answer).toBe(false);
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="project-sheet"]')).not.toBeNull();
  });

  it("an outside press on the confirm's scrim is the confirm's, not the sheet's", async () => {
    await renderSheet();
    await act(async () => { void confirm({ title: "Delete comment?", message: "Sure?" }); await Promise.resolve(); });
    await flushUntil(() => document.querySelector('[data-testid="confirm-modal"]') !== null, "the confirm modal");
    const scrim = document.querySelector('[data-testid="alert-dialog-scrim"]')!;
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    await flush();
    expect(onRequestClose).not.toHaveBeenCalled();
    // Alert-dialog behaviour (#625): the scrim press neither closes the sheet nor answers the confirm.
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
  });

  // #376 — the Discussion's read anchor must be judged against the sheet body's own scroll box:
  // scrolling the body never fires a window scroll, and an anchor scrolled above the body but still
  // inside the window would otherwise count as visible.
  it("marks the newest comment read only while its anchor is inside the sheet body's scroll box", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    Reflect.deleteProperty(globals, "IntersectionObserver");
    const previousFocused = focusManager.isFocused(); focusManager.setFocused(true);
    const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const style = document.createElement("style");
    style.textContent = "[data-testid=project-sheet-body]{overflow-y:auto}";
    document.head.append(style);
    const rect = (top: number, bottom: number) => ({ left: 0, right: 800, top, bottom, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    let anchorRect = rect(40, 41);
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "project-sheet-body") return rect(100, 500);
      if (this.dataset.testid === "discussion-read-anchor") return anchorRect;
      return original.call(this);
    });
    try {
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };
      const head = { id: "head", author: { id: "user-2", name: "Other" }, body: "Hello", content: doc, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
      const previous = apiGetMock.getMockImplementation()!;
      apiGetMock.mockImplementation((path, init) => path.includes("comment-read-marker") || !path.includes("/comments") ? previous(path, init) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [head] }));
      apiPatchMock.mockResolvedValue({ projectId: "p1", marker: { throughCommentId: "head", throughCreatedAt: head.createdAt, updatedAt: head.createdAt }, latest: { commentId: "head", createdAt: head.createdAt }, unreadCount: 0 });
      await renderSheet({ arrivalTab: "collaboration", arrivalSignal: 1 });
      await flushUntil(() => document.querySelector('[data-testid="discussion-read-anchor"]') !== null, "the discussion read anchor");
      const body = document.querySelector<HTMLElement>('[data-testid="project-sheet-body"]')!;
      const section = document.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
      // Guards the harness itself: happy-dom must honour the injected rule, or this test proves nothing.
      expect(nearestScrollContainer(section)).toBe(body);

      body.dispatchEvent(new Event("scroll")); await flush(10);
      expect(apiPatchMock).not.toHaveBeenCalled();

      anchorRect = rect(200, 201);
      body.dispatchEvent(new Event("scroll")); await flush(20);
      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      expect(apiPatchMock).toHaveBeenCalledWith("/api/projects/p1/comment-read-marker", { throughCommentId: "head" });
    } finally {
      style.remove();
      if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility); else Reflect.deleteProperty(document, "visibilityState");
      focusManager.setFocused(previousFocused);
      if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver"); else globals.IntersectionObserver = previousObserver;
      rectSpy.mockRestore();
    }
  });

  // #377 — the checklist is a sibling of the sub-tab strip, so it sits in the sheet body and outside every tabpanel.
  it("renders the Collaboration checklist rail inside the sheet body and outside the Discussion tabpanel", async () => {
    await renderSheet({ arrivalTab: "collaboration", arrivalSignal: 1 });
    await flushUntil(() => document.querySelector('[aria-label="Project checklist"]') !== null, "the checklist");
    const checklist = document.querySelector<HTMLElement>('[aria-label="Project checklist"]')!;
    expect(document.querySelector('[data-testid="project-sheet-body"]')!.contains(checklist)).toBe(true);
    expect(checklist.closest('[id$="-discussion-panel"], [id$="-activity-panel"]')).toBeNull();
    expect(document.querySelector('[data-testid="project-collaboration-panel"]')!.getAttribute("data-checklist-layout")).toBe("rail");
  });
});
