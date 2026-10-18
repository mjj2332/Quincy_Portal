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
import { ApiError } from "../lib/api";
import { stubRailMedia } from "../testing/rail-media";
import { mockViewport, type MockViewport } from "../testing/viewport";

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
const apiPutMock = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: vi.fn(() => Promise.resolve({})), apiPatch: (path: string, body?: unknown) => apiPatchMock(path, body), apiPut: (path: string, body?: unknown) => apiPutMock(path, body), apiDelete: vi.fn(() => Promise.resolve({})) };
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
  apiPutMock.mockReset();
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

  // #914 seam 1 (#787): the rebuilt header keeps Delivery as the Workspace's last tab, after Collaboration, in either tree.
  it("keeps Delivery the last Workspace tab, right after Collaboration, at 1440 and at 390", async () => {
    const fallback = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => path === "/api/projects/p1/delivery" ? Promise.resolve({ page: null, set: null, dto: null }) : fallback(path, init));
    for (const width of [1440, 390]) {
      const viewport = mockViewport({ width, height: width > 400 ? 900 : 844, coarse: width < 400 });
      try {
        await renderSheet();
        await flushUntil(() => tab("Delivery") !== undefined, `the Delivery tab at ${width}`);
        const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Workspace"] [role="tab"]')].map((element) => element.textContent?.replace(/\d+\+?$/, "").trim());
        expect(document.querySelectorAll('[role="tablist"][aria-label="Workspace"]'), String(width)).toHaveLength(1);
        expect(tabs.at(-1), String(width)).toBe("Delivery");
        expect(tabs.at(-2), String(width)).toBe("Collaboration");
      } finally {
        await act(async () => { root!.unmount(); await Promise.resolve(); });
        root = null;
        document.body.replaceChildren();
        viewport.restore();
      }
    }
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
    // #914: the header's ⋯ trigger, a control a confirm could be raised from (the first body button is now the Stage chip).
    const inner = document.querySelector<HTMLElement>('[data-testid="project-sheet-body"] [data-testid="project-more-actions"]')!;
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

// #914 D2 — Project info: a 440px sheet docked inside the Project sheet. It is modal: Esc closes it first, and focus returns to
// whatever opened it.
describe("Project info inside the Project sheet (#914 D2)", () => {
  const info = () => document.querySelector<HTMLElement>('[data-testid="project-info-sheet"]');
  const infoButton = () => document.querySelector<HTMLElement>('[data-testid="project-info-open"]');

  it("opens from its button, docked in the sheet's overlay slot; Esc closes it alone and focus returns to the button", async () => {
    await renderSheet();
    expect(info()).toBeNull();
    infoButton()!.focus();
    await click(infoButton()!);
    await flushUntil(() => info() !== null, "Project info to open");
    expect(document.querySelector('[data-testid="project-sheet-overlay-slot"]')!.contains(info())).toBe(true);
    expect(info()!.getAttribute("role")).toBe("dialog");
    expect(info()!.querySelector("h2")?.textContent).toBe("12 Example St");
    expect(info()!.contains(document.activeElement)).toBe(true);

    await escape(document.activeElement ?? document.body);
    await flushUntil(() => info() === null, "Project info to close");
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(infoButton());

    await escape(document.activeElement ?? document.body);
    await flush();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("covers the sheet's own Close with its scrim, and a scrim press closes Project info alone", async () => {
    await renderSheet();
    await click(infoButton()!);
    await flushUntil(() => info() !== null, "Project info to open");
    const scrim = document.querySelector<HTMLElement>('[data-testid="project-info-scrim"]')!;
    expect(document.querySelector('[data-testid="project-sheet-overlay-slot"]')!.contains(scrim)).toBe(true);
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    await flushUntil(() => info() === null, "Project info to close");
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(infoButton());
  });

  it("Change draws the deadline form in place with focus inside it; Cancel puts the facts back and focus on Change", async () => {
    authState.role = "admin";
    await renderSheet();
    await click(infoButton()!);
    await flushUntil(() => info() !== null, "Project info to open");
    const section = () => info()!.querySelector<HTMLElement>('[data-testid="project-info-deadline"]')!;
    await click(section().querySelector<HTMLElement>('[data-testid="project-info-deadline-change"]')!);
    await flushUntil(() => section().querySelector('[aria-label="Time slots"]') !== null, "the inline deadline form");
    expect(section().contains(document.activeElement)).toBe(true);
    // In place: no Deadline popover over Project info.
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).toBeNull();
    const cancel = [...section().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!;
    await click(cancel);
    await flush();
    expect(section().querySelector('[aria-label="Time slots"]')).toBeNull();
    expect(document.activeElement).toBe(section().querySelector('[data-testid="project-info-deadline-change"]'));
    expect(info()).not.toBeNull();
  });

  it("Manage draws the Team picker in place with the search focused; Done puts the facts back and focus on Manage", async () => {
    // Team management is `editProject` (Admin); an Editor sees the Team as facts.
    authState.role = "admin";
    await renderSheet();
    await click(infoButton()!);
    await flushUntil(() => info() !== null, "Project info to open");
    const manage = info()!.querySelector<HTMLElement>('[data-testid="project-info-team-manage"]')!;
    await click(manage);
    await flushUntil(() => info()!.querySelector('[data-testid="project-info-team"] [data-testid="project-team-control"]') !== null, "the inline Team picker");
    expect(document.activeElement).toBe(info()!.querySelector('[aria-label="Search people"]'));
    // In place, not a popup: no second layer opened over Project info.
    expect(info()!.contains(document.querySelector('[role="listbox"][aria-label="Team candidates"]'))).toBe(true);
    await click(info()!.querySelector<HTMLElement>('[data-testid="project-info-team-done"]')!);
    await flush();
    expect(info()!.querySelector('[data-testid="project-info-team"] [data-testid="project-team-control"]')).toBeNull();
    expect(document.activeElement).toBe(info()!.querySelector('[data-testid="project-info-team-manage"]'));
  });
});

// #870 — the Social overlays picker. #914 (settled decision): a section of Project info, after Team.
describe("the Social overlays picker in the Project header (#870)", () => {
  const overlayId = "22222222-2222-4222-8222-222222222222", tiktokId = "33333333-3333-4333-8333-333333333333";
  const overlayState = (selected: Array<{ id: string; name: string }>) => ({
    available: [{ id: overlayId, name: "Instagram Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null }, { id: tiktokId, name: "TikTok", platformLabel: "TikTok", isDefault: false, archivedAt: null }],
    selected: selected.map((choice) => ({ ...choice, platformLabel: "x", isDefault: false, archivedAt: null })),
    resolved: [],
    revision: "0".repeat(64),
  });
  function openGate(open: boolean) {
    const previous = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path, init) => path.endsWith("/video-review") ? Promise.resolve({ open, parts: [] }) : path.endsWith("/social-overlays") ? Promise.resolve(overlayState([])) : previous(path, init));
  }
  const picker = () => document.querySelector<HTMLElement>('[data-testid="project-social-overlays"]');
  const pickerTrigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Social overlays"]');
  const openInfo = async () => {
    await click(document.querySelector<HTMLElement>('[data-testid="project-info-open"]')!);
    await flushUntil(() => document.querySelector('[data-testid="project-info-sheet"]') !== null, "Project info to open");
  };

  it("is a Project info section after Team when video review is open, and not in the header rows", async () => {
    openGate(true);
    await renderSheet();
    expect(picker()).toBeNull();
    await openInfo();
    await flushUntil(() => picker() !== null, "the Social overlays picker");
    const info = document.querySelector('[data-testid="project-info-sheet"]')!;
    expect(info.contains(picker())).toBe(true);
    expect(document.querySelector('[data-testid="project-header"]')!.contains(picker())).toBe(false);
    expect(info.querySelector('[data-testid="project-info-team"]')!.compareDocumentPosition(picker()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is absent while video review is closed, and asks for nothing", async () => {
    openGate(false);
    await renderSheet();
    await openInfo();
    await flush(20);
    expect(picker()).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => String(path).endsWith("/social-overlays"))).toBe(false);
  });

  it("is absent for a Photographer even with video review open", async () => {
    authState.role = "photographer"; openGate(true);
    await renderSheet();
    await openInfo();
    await flush(20);
    expect(picker()).toBeNull();
  });

  it("picks by keyboard, saves once on Escape, closes only the picker (Project info stays), and returns focus to its trigger", async () => {
    openGate(true);
    apiPutMock.mockResolvedValue({ ...overlayState([{ id: tiktokId, name: "TikTok" }]) });
    await renderSheet();
    await openInfo();
    await flushUntil(() => pickerTrigger() !== null, "the picker trigger");
    await click(pickerTrigger()!);
    await flushUntil(() => document.querySelector('[role="listbox"]') !== null, "the overlay list");
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("TikTok"))!);
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => document.querySelector('[role="listbox"]') === null, "the list to close");
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock).toHaveBeenCalledWith("/api/projects/p1/social-overlays", { overlayIds: [tiktokId], expectedRevision: "0".repeat(64) });
    expect(document.querySelector('[data-testid="project-info-sheet"]')).not.toBeNull();
    expect(document.activeElement).toBe(pickerTrigger());
  });

  it("makes the whole header read-only when saving is refused because the Project is archived", async () => {
    openGate(true);
    apiPutMock.mockRejectedValue(new ApiError("Archived", 409, { error: "Archived", code: "project_archived" }));
    await renderSheet();
    await openInfo();
    await flushUntil(() => pickerTrigger() !== null, "the picker trigger");
    expect(document.querySelector('[role="group"][aria-label="Stage"]')).toBeNull();
    await click(pickerTrigger()!);
    await flushUntil(() => document.querySelector('[role="listbox"]') !== null, "the overlay list");
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("TikTok"))!);
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => document.querySelector('[role="group"][aria-label="Stage"]') !== null, "the Stage control to turn read-only");
  });
});

// #914 M1/M2 — the phone header (the sheet's `max-[721px]` width, PROJECT_SHEET_PHONE_QUERY). It draws Close in whichever bar is
// showing and claims the sheet's own; the slim bar is inert until the project bar has scrolled under it.
describe("the phone header inside the Project sheet (#914 M1, M2)", () => {
  class FakeIO {
    static instances: FakeIO[] = [];
    targets: Element[] = [];
    disconnected = false;
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) { FakeIO.instances.push(this); }
    observe(target: Element) { this.targets.push(target); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    takeRecords() { return []; }
  }
  let viewport: MockViewport;
  const liveClose = () => [...document.querySelectorAll<HTMLElement>('button[aria-label="Close project"]')].filter((button) => !button.closest("[inert]"));
  const projectBar = () => document.querySelector<HTMLElement>('[data-testid="project-header"]');
  const slimBar = () => document.querySelector<HTMLElement>('[data-testid="project-header-slim"]');
  const info = () => document.querySelector<HTMLElement>('[data-testid="project-info-sheet"]');
  const barObserver = () => FakeIO.instances.find((io) => !io.disconnected && io.targets[0] === projectBar());
  async function scrollBarUnder(out: boolean) {
    const io = barObserver()!;
    await act(async () => {
      io.callback([{ target: io.targets[0]!, isIntersecting: !out, boundingClientRect: { top: out ? -40 : 0, bottom: out ? 20 : 62 } as DOMRectReadOnly, rootBounds: { top: 48 } as DOMRectReadOnly } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
      await Promise.resolve();
    });
  }
  beforeEach(async () => {
    FakeIO.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIO);
    viewport = mockViewport({ width: 390, height: 844, coarse: true });
  });
  afterEach(() => { viewport.restore(); stubRailMedia(true); vi.unstubAllGlobals(); });

  it("observes the project bar against the Project sheet's scroll body (the sheet context's `body`)", async () => {
    await renderSheet();
    expect(barObserver()!.options?.root).toBe(document.querySelector('[data-testid="project-sheet-body"]'));
    expect(barObserver()!.options?.root).not.toBeNull();
  });

  it("has exactly one live Close project, inside the header landmark, in place of the sheet's own; it asks the sheet to close", async () => {
    await renderSheet();
    expect(document.querySelector('[data-testid="project-sheet-close"]')).toBeNull();
    expect(liveClose()).toHaveLength(1);
    expect(projectBar()!.matches('section[aria-label="Project Overview"]')).toBe(true);
    expect(projectBar()!.contains(liveClose()[0]!)).toBe(true);
    await click(liveClose()[0]!);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("keeps one Workspace tablist", async () => {
    // (The whiteboard's phone button is covered with the board's own gate in ProjectWorkspace-whiteboard.dom.test.tsx.)
    await renderSheet();
    expect(document.querySelectorAll('[role="tablist"][aria-label="Workspace"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="project-header-tabbar"]')!.contains(document.querySelector('[role="tablist"][aria-label="Workspace"]'))).toBe(true);
  });

  it("gives the sheet its own Close back at 1440, and keeps it while the Project is loading at 390", async () => {
    await viewport.set({ width: 1440, height: 900, coarse: false });
    await renderSheet();
    expect(document.querySelector('[data-testid="project-sheet-close"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="project-header-close"]')).toBeNull();
    await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    document.body.replaceChildren();
    await viewport.set({ width: 390, height: 844, coarse: true });
    apiGetMock.mockImplementation(() => new Promise(() => undefined));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<QuincyQueryProvider key="test" principalId="test-user" role={authState.role as Role}>
        <ProjectSheet open kind="project" sheetKey="project:p1" backdropHref="/" onRequestClose={onRequestClose}>
          <ProjectWorkspace projectId="p1" onArrivalConsumed={() => undefined} />
        </ProjectSheet>
      </QuincyQueryProvider>);
      await Promise.resolve();
    });
    await flush();
    expect(document.querySelector('[data-testid="project-sheet-close"]')).not.toBeNull();
  });

  it("opens Project info from the project bar, and focus returns to it", async () => {
    await renderSheet();
    const opener = projectBar()!.querySelector<HTMLElement>('button[aria-label="Project info, 12 Example St"]')!;
    opener.focus();
    await click(opener);
    await flushUntil(() => info() !== null, "Project info to open");
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => info() === null, "Project info to close");
    expect(document.activeElement).toBe(opener);
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("swaps in the slim bar once the project bar has scrolled under it: its name opens Project info and its Close is the live one", async () => {
    await renderSheet();
    expect(barObserver()!.options?.rootMargin).toBe("-48px 0px 0px 0px");
    expect(slimBar()!.hasAttribute("inert")).toBe(true);
    await scrollBarUnder(true);
    expect(slimBar()!.hasAttribute("inert")).toBe(false);
    expect(projectBar()!.hasAttribute("inert")).toBe(true);
    expect(liveClose()).toHaveLength(1);
    expect(slimBar()!.contains(liveClose()[0]!)).toBe(true);
    const name = slimBar()!.querySelector<HTMLElement>('button[aria-label="Project info, 12 Example St"]')!;
    name.focus();
    await click(name);
    await flushUntil(() => info() !== null, "Project info to open");
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => info() === null, "Project info to close");
    expect(document.activeElement).toBe(name);
    // Back up: focus on the slim bar moves to its twin in the project bar instead of falling to the body.
    await scrollBarUnder(false);
    expect(slimBar()!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(projectBar()!.querySelector('button[aria-label="Project info, 12 Example St"]'));
  });

  // #914 M3–M6: Project info on the phone is a bottom sheet (reui/drawer) with pushed views.
  const openInfo = async () => {
    const opener = projectBar()!.querySelector<HTMLElement>('button[aria-label="Project info, 12 Example St"]')!;
    opener.focus();
    await click(opener);
    await flushUntil(() => info() !== null, "Project info to open");
    return opener;
  };
  const back = () => document.querySelector<HTMLElement>('[data-testid="project-info-back"]');
  const row = (name: string) => info()!.querySelector<HTMLElement>(`[data-testid="project-info-${name}-row"]`);
  function withProject(patch: Record<string, unknown>) {
    const fallback = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => path === "/api/projects/p1" ? Promise.resolve({ ...projectFixture(), ...patch }) : fallback(path, init));
  }

  it("is a bottom sheet over the Project: Status first (Stage, Deadline, Team), then notes, Client and shoot and Files, then the actions", async () => {
    authState.role = "admin";
    withProject({ contractEnabled: true, boardRevision: 1, productionNotes: "Twilight shots", agencyName: "Ray White" });
    await renderSheet();
    await openInfo();
    const sheet = info()!;
    expect(sheet.getAttribute("data-view")).toBe("info");
    // What the Project sheet's Esc gate relies on (project-sheet-layers.dom.test.tsx): an open dialog in the overlay slot, no aria-modal.
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.hasAttribute("aria-modal")).toBe(false);
    expect(sheet.hasAttribute("data-open")).toBe(true);
    expect(sheet.closest('[data-testid="project-sheet"]')).not.toBeNull();
    expect([...sheet.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Status", "Production notes", "Client and shoot", "Files"]);
    expect(row("stage")!.getAttribute("aria-label")).toMatch(/^Stage: /);
    expect(row("deadline")!.getAttribute("aria-label")).toBe("Deadline: set deadline");
    expect(row("team")!.getAttribute("aria-label")).toBe("Team: nobody assigned");
    expect(sheet.querySelector('[data-testid="project-info-notes-text"]')!.textContent).toBe("Twilight shots");
    const actions = [...sheet.querySelectorAll<HTMLElement>('[data-testid="project-info-actions"] > *')].map((element) => element.textContent?.trim());
    // (Open whiteboard heads the actions where the board is offered: ProjectWorkspace-whiteboard.dom.test.tsx.)
    expect(actions[0]).toBe("Edit project details");
    expect(actions).toContain("Copy link");
  });

  it("pushes the Stage view; Back pops it and focuses the Stage row; Esc in a pushed view closes Project info only", async () => {
    authState.role = "admin";
    withProject({ contractEnabled: true, boardRevision: 1 });
    await renderSheet();
    const opener = await openInfo();
    await click(row("stage")!);
    expect(info()!.getAttribute("data-view")).toBe("stage");
    expect(document.activeElement).toBe(back());
    expect(info()!.querySelector('[role="radiogroup"]')).not.toBeNull();
    await click(back()!);
    expect(info()!.getAttribute("data-view")).toBe("info");
    expect(document.activeElement).toBe(row("stage"));
    await click(row("deadline")!);
    expect(info()!.getAttribute("data-view")).toBe("deadline");
    expect(info()!.querySelector<HTMLInputElement>('input[type="date"]')).not.toBeNull();
    expect([...info()!.querySelectorAll("button")].some((button) => button.textContent === "Save deadline")).toBe(true);
    await escape(document.activeElement ?? document.body);
    await flushUntil(() => info() === null, "Project info to close");
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("saves a Stage chosen in the Stage view and returns to Project info", async () => {
    withProject({ contractEnabled: true, boardRevision: 1 });
    await renderSheet();
    await openInfo();
    await click(row("stage")!);
    const radios = [...info()!.querySelectorAll<HTMLElement>('[role="radio"]')];
    const { apiPost: postBefore } = await import("../lib/api");
    vi.mocked(postBefore).mockClear();
    // The arrow keys move focus through the rows and choose nothing (a radio group would otherwise save on every arrow).
    const checked = radios.find((radio) => radio.getAttribute("aria-checked") === "true")!;
    checked.focus();
    await act(async () => { checked.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); });
    await flush(3);
    expect(document.activeElement).not.toBe(checked);
    expect(info()!.getAttribute("data-view")).toBe("stage");
    expect(vi.mocked(postBefore).mock.calls.some(([path]) => path === "/api/projects/p1/stage")).toBe(false);
    const target = radios.find((radio) => radio.getAttribute("aria-checked") === "false" && radio.getAttribute("aria-disabled") !== "true")!;
    await click(target);
    await flushUntil(() => info()?.getAttribute("data-view") === "info", "the Stage view to return to Project info");
    const { apiPost } = await import("../lib/api");
    expect(vi.mocked(apiPost).mock.calls.some(([path]) => path === "/api/projects/p1/stage")).toBe(true);
    expect(document.activeElement).toBe(row("stage"));
  });

  it("keeps the Stage view up when the move fails (only a saved move returns to Project info)", async () => {
    withProject({ contractEnabled: true, boardRevision: 1 });
    await renderSheet();
    await openInfo();
    await click(row("stage")!);
    const { apiPost } = await import("../lib/api");
    vi.mocked(apiPost).mockImplementationOnce(() => Promise.reject(new ApiError("Server error", 500, { error: "Server error" })));
    const target = [...info()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) => radio.getAttribute("aria-checked") === "false" && radio.getAttribute("aria-disabled") !== "true")!;
    await click(target);
    await flushUntil(() => vi.mocked(apiPost).mock.calls.some(([path]) => path === "/api/projects/p1/stage"), "the Stage move to be sent");
    await flush(5);
    expect(info()!.getAttribute("data-view")).toBe("stage");
  });

  it("focuses the Team search inside the tap that pushes the Team view (iOS raises the keyboard only then)", async () => {
    authState.role = "admin";
    await renderSheet();
    await openInfo();
    const teamRow = row("team")!;
    let focusedInHandler: Element | null = null;
    // On the document, so it runs after React's root listener: what is focused when the tap's handler has returned.
    const record = () => { focusedInHandler = document.activeElement; };
    document.addEventListener("click", record);
    await click(teamRow);
    document.removeEventListener("click", record);
    expect(info()!.getAttribute("data-view")).toBe("team");
    expect(focusedInHandler).toBe(info()!.querySelector('input[aria-label="Search people"]'));
  });

  it("gives a Photographer plain Status rows and no Edit project details", async () => {
    authState.role = "photographer";
    withProject({ contractEnabled: true, boardRevision: 1 });
    await renderSheet();
    await openInfo();
    expect(row("stage")).toBeNull();
    expect(row("deadline")).toBeNull();
    expect(row("team")).toBeNull();
    expect(info()!.querySelector('[role="group"][aria-label^="Stage: "]')).not.toBeNull();
    expect(info()!.querySelector('[data-testid="project-info-details"]')).toBeNull();
  });

  // #870 / owner decision (browser pass): on the phone Social overlays is the Status group's last row, pushing a view with the picker.
  it("makes Social overlays the last Status row, naming the overlays, and pushes a view holding the picker", async () => {
    authState.role = "admin";
    const reel = { id: "22222222-2222-4222-8222-222222222222", name: "Instagram Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null };
    const fallback = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => path.endsWith("/video-review") ? Promise.resolve({ open: true, parts: [] })
      : path.endsWith("/social-overlays") ? Promise.resolve({ available: [reel], selected: [reel], resolved: [], revision: "0".repeat(64) })
      : fallback(path, init));
    await renderSheet();
    await openInfo();
    await flushUntil(() => row("overlays") !== null, "the Social overlays row");
    const status = info()!.querySelector<HTMLElement>('[data-testid="project-info-status"]')!;
    expect(status.lastElementChild).toBe(row("overlays"));
    await flushUntil(() => row("overlays")!.getAttribute("aria-label") === "Social overlays: Instagram Reel", "the row to name the overlays");
    expect(info()!.querySelector('[data-testid="project-social-overlays"]'), "no picker in the info view").toBeNull();
    expect([...info()!.querySelectorAll("h3")].map((heading) => heading.textContent)).not.toContain("Social overlays");
    await click(row("overlays")!);
    expect(info()!.getAttribute("data-view")).toBe("overlays");
    expect(document.activeElement).toBe(back());
    await flushUntil(() => info()!.querySelector('[data-testid="project-social-overlays"]') !== null, "the picker in the pushed view");
    await click(back()!);
    expect(document.activeElement).toBe(row("overlays"));
  });

  it("gives no Social overlays row while video review is closed", async () => {
    authState.role = "admin";
    const fallback = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => path.endsWith("/video-review") ? Promise.resolve({ open: false, parts: [] }) : fallback(path, init));
    await renderSheet();
    await openInfo();
    await flush(20);
    expect(row("overlays")).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => String(path).endsWith("/social-overlays"))).toBe(false);
  });
});
