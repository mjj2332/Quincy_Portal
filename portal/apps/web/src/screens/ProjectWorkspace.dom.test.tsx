import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryObserver, useQueryClient } from "@tanstack/react-query";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { ApiError } from "../lib/api";
import { QuincyQueryProvider } from "../lib/query-client";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../lib/project-query-sync";
import { projectAssetsQueryOptions, projectDataKeys } from "../lib/project-data";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import type { Role } from "@quincy/shared";

const authState = vi.hoisted(() => ({ role: "editor" }));
const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string, init?: unknown) => apiGetMock(path, init), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

function workspaceAsset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false, ...overrides };
}

function projectFixture(id = "p1") {
  return {
    id, street: id === "p1" ? "12 Example St" : "34 Second Street", suburb: "Suburbia", postcode: "2000",
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

function collaborationSummaryFixture(id = "p1") {
  return { project: { id, street: id === "p1" ? "12 Example St" : "34 Second Street", stageKey: "raw_review" as const }, members: [] };
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function ClientCapture({ onClient }: { onClient: (client: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient>) => void }) {
  onClient(useQueryClient());
  return null;
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => { root!.render(<QuincyQueryProvider key={`${authState.role}:test`} principalId="test-user" role={authState.role as Role}>{value}</QuincyQueryProvider>); await Promise.resolve(); });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  }
}

/**
 * Pump until `predicate` holds, bounded by real elapsed time rather than by a tick count.
 *
 * `flush(n)` waits for a fixed number of macrotasks, which is fragile for two independent reasons:
 * a chain of dependent queries can need more ticks than the caller guessed, and — the one no tick
 * count can fix — `createQuincyQueryClient` sets a *real* `retryDelay` of 1s-4s
 * (`lib/query-client.tsx:21`). `setTimeout(resolve, 0)` advances ~1ms of wall clock, so even
 * `flush(20)` waits ~20ms and can never sit out a real backoff; raising the count buys nothing.
 * Waiting on the condition with a real deadline covers both.
 *
 * After the predicate holds we keep pumping for a short settle margin, so that anything a test
 * asserts must *not* happen still gets the chance to happen and be caught. That keeps negative
 * assertions ("no workspace reads were started") at least as strong as under the old fixed wait,
 * which is the property that makes this a safe substitution rather than a loosened one.
 *
 * The 3s default is deliberately *below* vitest's 5s `testTimeout` (`vitest.dom.config.ts` sets no
 * override, so the default applies). At 5s the two race and vitest wins, so the failure surfaces as
 * a bare "Test timed out in 5000ms" and this helper's `label` — the whole diagnostic value — is
 * never printed. Verified by probe. Keep this margin if either number changes.
 */
async function flushUntil(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) break;
    if (Date.now() > deadline) throw new Error(`flushUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
  }
  await flush(5);
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function stageOption(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')]
    .find((element) => element.textContent === label) ?? null;
}

async function chooseStage(trigger: HTMLButtonElement, label: string) {
  await act(async () => { trigger.focus(); trigger.click(); await Promise.resolve(); });
  const option = stageOption(label);
  if (!option) throw new Error(`Missing Stage option ${label}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}

async function typeIntoEditor(editor: HTMLElement, text: string) {
  await act(async () => {
    editor.focus(); editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
}

function editedTabButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("Edited"));
  if (!button) throw new Error("No Edited tab button");
  return button;
}

// #205 — the Deadline/Dropbox blocks moved behind dashed trigger buttons that open a
// `reui/popover.tsx` popover portalled to `document.body`, outside `host`. Callers that need the
// dialog's own content query `document`, not `host`.
async function openDeadlineDialog(host: HTMLElement): Promise<HTMLElement> {
  await click(host.querySelector<HTMLButtonElement>('[data-testid="project-deadline-trigger"]')!);
  await flush(5);
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Deadline"]')!;
}

async function openDropboxDialog(host: HTMLElement): Promise<HTMLElement> {
  await click(host.querySelector<HTMLButtonElement>('[data-testid="project-dropbox-trigger"]')!);
  await flush(5);
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Dropbox"]')!;
}

// `.project-collaboration__head` was retired to Tailwind (TB8-07 §7.1) — the Hide button carries
// no class hook of its own, so it is found by its accessible name instead.
function hideCollaborationButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Hide ›");
  if (!button) throw new Error("No Hide collaboration button");
  return button;
}

// `.project-collaboration--unavailable` was retired (TB8-07 §7.3, the fixed-overlay defect fix):
// the unavailable state is now a static in-flow section, identified by its unchanged aria-label
// and its distinguishing "Collaboration unavailable." title rather than by a class name.
function collaborationUnavailableSection(host: HTMLElement): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('[aria-label="Project collaboration"]')].find(
    (item) => item.tagName === "SECTION" && item.textContent?.includes("Collaboration unavailable."),
  ) ?? null;
}

describe("ProjectWorkspace cross-tab asset/selection/lightbox safety", () => {
  let host: HTMLElement;
  let rawAssets: WorkspaceAsset[];
  let editedFetch: ReturnType<typeof deferredPromise<{ assets: WorkspaceAsset[] }>>;

  beforeEach(() => {
    host = mount();
    authState.role = "editor";
    rawAssets = [workspaceAsset("raw-1"), workspaceAsset("raw-2")];
    editedFetch = deferredPromise();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiDeleteMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited")) return editedFetch.promise;
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
  });

afterEach(async () => {
    vi.useRealTimers();
    await unmount();
    host.remove();
  });

  it("shows no Editor folder banner when nothing is latched (#163)", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.textContent).toContain("raw-1.jpg");
    expect(host.querySelector('[data-testid="editor-folder-attention"]')).toBeNull();
  });

  it("shows a latched Editor folder banner from the project detail (#163)", async () => {
    const base = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string) => path === "/api/projects/p1"
      ? Promise.resolve({ ...projectFixture(), editorFolderAttention: { kind: "editor_folder_move_stuck", headline: "Editor pipeline paused: test headline.", code: "editor_folder_move_stuck", detail: null, updatedAt: 0 } })
      : base(path));
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.querySelector('[data-testid="editor-folder-attention"]')?.textContent).toContain("Editor pipeline paused: test headline.");
  });

  it("clears a RAW-tab selection when switching to Edited, via the key={activeTab} remount", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();

    const selectBoxes = host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]');
    expect(selectBoxes.length).toBeGreaterThan(0);
    await click(selectBoxes[0]!);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).not.toBeNull();

    await click(editedTabButton(host));
    await flush();

    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).toBeNull();
  });

  it("shows the empty state instead of the previous tab's assets while the new tab's fetch is in flight", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();
    expect(host.textContent).toContain("raw-1.jpg");

    await click(editedTabButton(host));
    await flush();

    expect(host.textContent).not.toContain("raw-1.jpg");
    expect(host.textContent).not.toContain("raw-2.jpg");
    expect(host.querySelector('[data-testid="collection-loading"]')).not.toBeNull();

    await act(async () => {
      editedFetch.resolve({ assets: [workspaceAsset("edited-1")] });
      await Promise.resolve();
    });
    await flush();

    expect(host.textContent).toContain("edited-1.jpg");
  });

  it("hides stale private collection data in the same render that receives a capability 403", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click(editedTabButton(host));
    await act(async () => { editedFetch.resolve({ assets: [workspaceAsset("edited-private")] }); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("edited-private.jpg");
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("/assets?collection=edited")) return Promise.reject(new ApiError("Edited collection forbidden", 403, { capability: "viewEdited" }));
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      return Promise.resolve({});
    });
    await queryClient!.invalidateQueries({ queryKey: ["project-data", "p1", "assets", "edited"], exact: true, refetchType: "active" }); await flush();
    expect(host.textContent).not.toContain("edited-private.jpg");
  });

  it("remembers every denied collection for the mounted route generation", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited") || path.includes("/assets?collection=video")) return Promise.reject(new ApiError("Collection forbidden", 403, { capability: "viewEdited" }));
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    await click(editedTabButton(host)); await flush(20);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].some((item) => item.textContent?.includes("Edited"))).toBe(false);
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("Video"))!); await flush(20);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].some((item) => item.textContent?.includes("Edited"))).toBe(false);
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].some((item) => item.textContent?.includes("Video"))).toBe(false);
  });

  it("falls back the active collection switcher tab to RAW when the current non-raw tab becomes denied", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited")) return Promise.reject(new ApiError("Edited collection forbidden", 403, { capability: "viewEdited" }));
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    await click(editedTabButton(host)); await flush(20);
    const tabsAfter = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
    const rawTab = tabsAfter.find((item) => item.textContent?.includes("RAW"))!;
    expect(rawTab.getAttribute("aria-selected")).toBe("true");
    expect(tabsAfter.some((item) => item.textContent?.includes("Edited"))).toBe(false);
    expect(tabsAfter.filter((item) => item.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(host.textContent).toContain("raw-1.jpg");
  });

  it("falls back the active collection switcher tab to Edited when RAW becomes denied and Edited stays viewable", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("RAW collection forbidden", 403, { capability: "viewRaw" }));
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    const editedTab = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("Edited"))!;
    expect(editedTab.getAttribute("aria-selected")).toBe("true");
    expect([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].some((item) => item.textContent?.includes("RAW"))).toBe(false);
    expect(host.textContent).toContain("edited-1.jpg");
  });

  it("resets the collection switcher to RAW without leaking the prior project's tab or selection on a project change", async () => {
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    await click(editedTabButton(host));
    await act(async () => { editedFetch.resolve({ assets: [workspaceAsset("edited-1")] }); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("edited-1.jpg");
    const editedTab = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("Edited"))!;
    expect(editedTab.getAttribute("aria-selected")).toBe("true");

    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p2") return Promise.resolve(projectFixture("p2"));
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("p2-raw-1")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p2", street: "34 Second Street" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p2", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p2" />);
    await flush(20);

    const rawTabAfter = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("RAW"))!;
    expect(rawTabAfter.getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).not.toContain("edited-1.jpg");
    expect(host.textContent).toContain("p2-raw-1.jpg");
  });

  it("cannot leak a dirty, open Deadline draft across projects, because the router remounts ProjectWorkspace by key={projectId} on every project switch (App.tsx:101), not by relying on this component's own projectId-change reset", async () => {
    // App.tsx's only render site for this screen is
    // `<ProjectWorkspace key={route.projectId} projectId={route.projectId} .../>` — the key
    // literally IS the projectId, so a projectId change can never happen without also being a
    // key change. React unmounts the whole old-project fiber tree (discarding every local
    // useState in it, including ProjectDeadlineControl's `open`/`date`/`time`/`offsets` draft)
    // before mounting the new-project tree, in the same commit — there is no frame where a
    // dirty draft from project A could still be attached to project B's projectId. This test
    // exercises that real mechanism (a key swap on ProjectWorkspace itself), not just the
    // internal `useEffect([projectId])` reset covered by the "resets the collection switcher…"
    // test above, which changes the projectId prop without changing the key and so cannot by
    // itself prove what actually prevents cross-project draft leakage in production.
    // canEdit (and so ProjectDeadlineControl's canWrite) requires the editProject capability,
    // which only the admin role carries (portal/packages/shared/src/capabilities.ts) — the
    // file's default authState.role = "editor" would render the popover read-only, with no editor.
    authState.role = "admin";
    await render(<ProjectWorkspace key="p1" projectId="p1" />); await flush(20);
    const p1Dialog = await openDeadlineDialog(host);
    const dateInput = p1Dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!;
    expect(dateInput).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(dateInput, "2027-01-15"); dateInput.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    expect(p1Dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");

    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p2") return Promise.resolve({
        ...projectFixture("p2"),
        deadlineSchedule: {
          version: 1,
          deadline: { localCivil: "2028-06-01T10:00", zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 0, instant: "2028-06-01T00:00:00.000Z" },
          reminderOffsetsMinutes: [1440], state: "scheduled",
          nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2028-05-31T00:00:00.000Z" }, canResume: false,
        },
      });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("p2-raw-1")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p2", street: "34 Second Street" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p2", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      return Promise.resolve({});
    });

    // The real routing swap: a different key, forcing React to unmount the p1 tree and mount a
    // fresh p2 tree, exactly like App.tsx's key={route.projectId}.
    await render(<ProjectWorkspace key="p2" projectId="p2" />); await flush(20);

    // The whole p1 fiber tree — including its Deadline popover's portal — was unmounted by the
    // key swap, so nothing from it survives in `document` at all.
    expect(document.querySelector('input[aria-label="Deadline date"]')).toBeNull();
    expect(document.body.textContent).not.toContain("2027-01-15");
    const p2Dialog = await openDeadlineDialog(host);
    // p2's live editor is seeded from p2's own schedule, not p1's draft.
    expect(p2Dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2028-06-01");
    expect(p2Dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("10:00");
  });

  it("hides passive-RAW private data in the same render as a membership 403", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click(editedTabButton(host)); await act(async () => { editedFetch.resolve({ assets: [workspaceAsset("edited-1")] }); await Promise.resolve(); }); await flush();
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("RAW project membership forbidden", 403));
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      return Promise.resolve({});
    });
    const invalidation = queryClient!.invalidateQueries({ queryKey: ["project-data", "p1", "assets", "raw"], exact: true, refetchType: "active" });
    await invalidation; await flush();
    expect(host.textContent).not.toContain("edited-1.jpg");
    expect(host.textContent).toContain("Project unavailable.");
  });

  it("terminates the principal when a passive RAW observer receives a 401", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click(editedTabButton(host)); await act(async () => { editedFetch.resolve({ assets: [workspaceAsset("edited-1")] }); await Promise.resolve(); }); await flush();
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("Session expired", 401));
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      return Promise.resolve({});
    });
    await queryClient!.invalidateQueries({ queryKey: ["project-data", "p1", "assets", "raw"], exact: true, refetchType: "active" }); await flush();
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("finishes workspace initialization after a transient companion failure with one bounded notice", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.reject(new ApiError("Ingest temporarily unavailable", 500));
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
    expect(host.textContent).toContain("Ingest temporarily unavailable");
    expect(host.textContent).not.toContain("Preparing the workspace.");
  });

  it("terminates on a 401 hidden behind another companion-bootstrap failure", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.reject(new ApiError("Ingest temporarily unavailable", 500));
      if (path.endsWith("/jobs")) return Promise.reject(new ApiError("Session expired", 401));
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("retains assets, multi-select, Lightbox, and a markup draft after a transient refetch error", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    rawAssets = [workspaceAsset("raw-1"), workspaceAsset("raw-2")];
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[1]!);
    await flush(12);
    await click(host.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]')!); await flush();
    await click(host.querySelector<HTMLButtonElement>('[data-testid="lightbox-review-trigger"]')!); await flush();
    const note = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional note for this markup…"]');
    expect(note).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(note, "unsaved markup draft"); note!.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    const scroll = host.querySelector<HTMLElement>('[data-testid="lightbox-review-scroll"]');
    expect(scroll).not.toBeNull();
    scroll!.scrollTop = 240;
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("Temporary asset outage", 500));
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      return Promise.resolve({});
    });
    await expect(queryClient!.fetchQuery({ ...projectAssetsQueryOptions("p1", "raw"), staleTime: 0, retry: false })).rejects.toMatchObject({ status: 500 });
    await flush(12);
    expect(host.textContent).toContain("Temporary asset outage");
    expect(host.querySelectorAll('[data-testid="photo-grid-tile"][data-multi-selected="true"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional note for this markup…"]')?.value).toBe("unsaved markup draft");
    expect(host.querySelector<HTMLElement>('[data-testid="lightbox-review-scroll"]')?.scrollTop).toBe(240);
  });

  it("preserves multi-select, Lightbox draft, and scroll across an ordinary focus refetch", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    rawAssets = [workspaceAsset("raw-1"), workspaceAsset("raw-2")];
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[1]!); await flush(12);
    await click(host.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]')!); await flush();
    await click(host.querySelector<HTMLButtonElement>('[data-testid="lightbox-review-trigger"]')!); await flush();
    const note = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional note for this markup…"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(note, "focus-refresh draft"); note.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    const scroll = host.querySelector<HTMLElement>('[data-testid="lightbox-review-scroll"]')!; scroll.scrollTop = 180;
    const refresh = deferredPromise<{ assets: WorkspaceAsset[] }>();
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes("/assets?collection=raw")) return refresh.promise;
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      return Promise.resolve({});
    });
    queryClient!.setQueryData(projectDataKeys.assets("p1", "raw"), rawAssets, { updatedAt: 0 });
    focusManager.setFocused(false); focusManager.setFocused(true);
    await flush(4);
    expect(refresh.promise).toBeDefined();
    refresh.resolve({ assets: rawAssets.map((asset) => ({ ...asset })) });
    await flush(12);
    expect(host.querySelectorAll('[data-testid="photo-grid-tile"][data-multi-selected="true"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="photo-grid-actionbar"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Close"]')).not.toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Optional note for this markup…"]')?.value).toBe("focus-refresh draft");
    expect(host.querySelector<HTMLElement>('[data-testid="lightbox-review-scroll"]')?.scrollTop).toBe(180);
    focusManager.setFocused(true);
  });

  it("holds active-job ownership between forced cycles and releases it at terminal state", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let jobsCalls = 0;
    let detailCalls = 0;
    const activeJob = { id: "job-1", kind: "autohdr_api_send" as const, status: "running" as const, error: null, correlationId: null, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" };
    const terminalJob = { ...activeJob, status: "done" as const };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") { detailCalls += 1; return Promise.resolve(projectFixture()); }
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) { jobsCalls += 1; return Promise.resolve({ jobs: [jobsCalls < 3 ? activeJob : terminalJob] }); }
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>);
    for (let index = 0; index < 20; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(jobsCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await Promise.resolve(); });
    for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(jobsCalls).toBe(2);
    const afterForcedCycle = detailCalls;
    queryClient!.setQueryData(projectDataKeys.detail("p1"), projectFixture(), { updatedAt: 0 });
    focusManager.setFocused(false); focusManager.setFocused(true);
    for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(detailCalls).toBe(afterForcedCycle);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await Promise.resolve(); });
    for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(jobsCalls).toBe(3);
    const beforeTerminalFocus = detailCalls;
    queryClient!.setQueryData(projectDataKeys.detail("p1"), projectFixture(), { updatedAt: 0 });
    focusManager.setFocused(false); focusManager.setFocused(true);
    for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(detailCalls).toBeGreaterThan(beforeTerminalFocus);
    focusManager.setFocused(true);
  });

  it("keeps ordinary detail freshness and received invalidations when an admin has no AutoHDR handoff", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let detailCalls = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") { detailCalls += 1; return Promise.resolve(projectFixture()); }
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) return Promise.resolve({ jobs: [] });
      if (path.includes("/autohdr-status")) return Promise.resolve({ handoff: null });
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>);
    for (let index = 0; index < 20; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(detailCalls).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await Promise.resolve(); });
    for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(detailCalls).toBeGreaterThan(1);

    const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    const runtime = getProjectQueryRuntime(queryClient!);
    (runtime as unknown as { receive: (value: unknown) => void }).receive({
      ...createProjectDataInvalidationMessage("p1", [{ kind: "detail" }]),
      sourceTabId: "other-tab",
    });
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectDataKeys.detail("p1"), exact: true, refetchType: "active" });
  });

  it("starts the legacy AutoHDR gate when a live detail refetch moves the project into RAW review", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let stageKey: "awaiting_raw" | "raw_review" = "awaiting_raw";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) return Promise.resolve({ jobs: [] });
      if (path.includes("/autohdr-status")) return Promise.resolve({ handoff: null });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("/autohdr-status"))).toBe(false);

    stageKey = "raw_review";
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.detail("p1"), exact: true, refetchType: "active" }); await flush(20);
    expect(apiGetMock.mock.calls.some(([path]) => path.includes("/autohdr-status"))).toBe(true);
  });

  it("moves Stage from the header through the shared confirmation retry", async () => {
    authState.role = "admin";
    let stageKey: "raw_review" | "awaiting_raw" = "raw_review";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey, boardRevision: stageKey === "raw_review" ? 7 : 8, contractEnabled: true });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) return Promise.resolve({ jobs: [] });
      if (path.includes("/autohdr-status")) return Promise.resolve({ handoff: null });
      return Promise.resolve({});
    });
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    apiPostMock
      .mockRejectedValueOnce(new ApiError("Confirmation required", 409, { code: "stage_confirmation_required", requiredConfirmation: { reasons: ["backward"] } }))
      .mockImplementationOnce(async () => { stageKey = "awaiting_raw"; return { changed: true, project: { stageKey, boardRevision: 8 } }; });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    const runtime = getProjectQueryRuntime(queryClient!);
    const publish = vi.spyOn(runtime!, "publish");
    const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    const dashboardKey = dashboardProjectsKey("test-user", "admin", 0, false);
    queryClient!.setQueryData(dashboardKey, []);
    const dashboardObserver = new QueryObserver(queryClient!, { queryKey: dashboardKey, queryFn: () => Promise.resolve([]), staleTime: Infinity });
    const stopDashboardObserver = dashboardObserver.subscribe(() => undefined);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Move project Stage"]');
    expect(trigger).not.toBeNull();
    await chooseStage(trigger!, "Awaiting RAW"); await flush(20);
    expect(confirmMock).toHaveBeenCalledWith({ title: "Confirm Stage move", message: "This move moves backward. Continue?", confirmLabel: "Move project" });
    expect(apiPostMock).toHaveBeenNthCalledWith(2, "/api/projects/p1/stage", {
      expected: { stageKey: "raw_review", boardRevision: 7 }, targetStageKey: "awaiting_raw", placement: { kind: "append" }, confirmation: { reasons: ["backward"] },
    });
    expect(host.textContent).toContain("Awaiting RAW");
    const boardMessage = publish.mock.calls.map(([message]) => message).find((message) => message.type === "dashboard-board-invalidated");
    expect(boardMessage).toEqual(expect.objectContaining({ version: 1, type: "dashboard-board-invalidated" }));
    expect(boardMessage).not.toHaveProperty("projectId");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "detail" }, { kind: "activity" }] }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ version: 1, type: "production-calendar-invalidated" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dashboardKey, exact: true, refetchType: "active" });
    stopDashboardObserver();
  });

  it("uses the idempotent already-in message and restores rail focus after a 503", async () => {
    authState.role = "admin";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "raw_review", boardRevision: 7, contractEnabled: true });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) return Promise.resolve({ jobs: [] });
      if (path.includes("/autohdr-status")) return Promise.resolve({ handoff: null });
      return Promise.resolve({});
    });
    apiPostMock.mockResolvedValueOnce({ changed: false, project: { projectId: "p1", stageKey: "edited_review", boardRevision: 7 }, board: { sourceStageKey: "raw_review", targetStageKey: "edited_review", orderedVisibleProjectIds: [] } });
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    const runtime = getProjectQueryRuntime(queryClient!);
    const publish = vi.spyOn(runtime!, "publish");
    const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    const trigger = host.querySelector<HTMLButtonElement>('[data-focus-key="rail-stage:p1"]')!;
    await chooseStage(trigger, "Edited review"); await flush(20);
    expect(host.textContent).toContain("Already in Edited review.");
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("rail-stage:p1");
    expect(publish).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["dashboard-projects"], refetchType: "active" });

    apiPostMock.mockRejectedValueOnce(new ApiError("Board unavailable", 503, { code: "board_schema_maintenance" }));
    await chooseStage(trigger, "Awaiting RAW"); await flush(20);
    expect(host.textContent).toContain("Stage movement is temporarily unavailable while the Board is being updated.");
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("rail-stage:p1");
  });

  it("treats a Stage capability 403 as a command failure without terminating the workspace", async () => {
    authState.role = "admin";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "raw_review", boardRevision: 7, contractEnabled: true });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.endsWith("/jobs")) return Promise.resolve({ jobs: [] });
      if (path.includes("/autohdr-status")) return Promise.resolve({ handoff: null });
      return Promise.resolve({});
    });
    apiPostMock.mockRejectedValueOnce(new ApiError("Stage movement forbidden", 403, { capability: "moveProjectStage" }));
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    const trigger = host.querySelector<HTMLButtonElement>('[data-focus-key="rail-stage:p1"]')!;
    await chooseStage(trigger, "Awaiting RAW"); await flush(20);
    expect(host.textContent).toContain("12 Example St");
    expect(host.textContent).toContain("Stage movement forbidden");
  });

  it("keeps a PhotoGrid filter through a background refetch", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    rawAssets = [workspaceAsset("rated", { review: { stars: 5, colorLabel: null, decision: null, recommended: false } }), workspaceAsset("unrated")];
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-filter"]')].find((button) => button.textContent?.startsWith("Rated"))!);
    apiGetMock.mockImplementation((path: string) => path.includes("/assets?collection=raw") ? Promise.resolve({ assets: rawAssets }) : path === "/api/projects/p1" ? Promise.resolve(projectFixture()) : path.includes("/ingest-status") ? Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false }) : Promise.resolve({}));
    await queryClient!.invalidateQueries({ queryKey: ["project-data", "p1", "assets", "raw"], exact: true, refetchType: "active" }); await flush();
    expect([...host.querySelectorAll<HTMLElement>('[data-testid="photo-grid-filter"]')].find((button) => button.textContent?.startsWith("Rated"))?.dataset.active).toBe("true");
  });

  it("fires exact cache invalidation and broadcast actions from real workspace mutation call sites", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush();
    const runtime = getProjectQueryRuntime(queryClient!); const publish = vi.spyOn(runtime!, "publish"); const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((button) => button.textContent === "Select for editing")!); await flush(20);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.assets("p1", "raw"), exact: true, refetchType: "active" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "assets", collectionKind: "raw" }] }));

    invalidate.mockClear(); publish.mockClear(); apiPostMock.mockResolvedValueOnce({});
    const coverButton = host.querySelector<HTMLButtonElement>('button[title="Use as project cover"]');
    expect(coverButton).not.toBeNull();
    await click(coverButton!); await flush(20);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail("p1"), exact: true, refetchType: "active" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "detail" }] }));

    invalidate.mockClear(); publish.mockClear(); apiPostMock.mockResolvedValueOnce({});
    await click(host.querySelector<HTMLButtonElement>('button[title="Approve"]')!); await flush(20);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.assets("p1", "raw"), exact: true, refetchType: "active" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "assets", collectionKind: "raw" }] }));

    invalidate.mockClear(); publish.mockClear(); apiDeleteMock.mockResolvedValueOnce({ ok: true, deletedAssetIds: ["raw-1"], deletedObjects: 1, dropboxDeleted: true, dropboxOutcome: "removed" });
    confirmMock.mockResolvedValue(true);
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="Delete raw-1.jpg"]')!); await flush(20);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.assets("p1", "raw"), exact: true, refetchType: "active" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail("p1"), exact: true, refetchType: "active" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.assets("p1", "edited"), exact: true, refetchType: "active" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "assets", collectionKind: "raw" }, { kind: "detail" }, { kind: "assets", collectionKind: "edited" }] }));
    vi.unstubAllGlobals();
  });

  it("keeps document assets/detail invalidation and adds Activity after copy completion", async () => {
    authState.role = "admin";
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=")) return Promise.resolve({ assets: [] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/links")) return Promise.resolve({ links: [] });
      if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    apiPostMock.mockImplementation((path: string) => path.endsWith("/documents/presign")
      ? Promise.resolve({ sessionId: "session-1", version: 1, files: { pdf: { key: "copy.pdf", devDirect: true } } })
      : Promise.resolve({}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((button) => button.textContent?.includes("Copy"))!); await flush(20);
    const runtime = getProjectQueryRuntime(queryClient!); const publish = vi.spyOn(runtime!, "publish"); const invalidate = vi.spyOn(queryClient!, "invalidateQueries");
    const input = host.querySelector<HTMLInputElement>('input[type="file"][accept="application/pdf"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["copy"], "copy.pdf", { type: "application/pdf" })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); }); await flush(20);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.assets("p1", "copy"), exact: true, refetchType: "active" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail("p1"), exact: true, refetchType: "active" }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.activity("p1"), exact: true, refetchType: "active" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "p1", resources: [{ kind: "assets", collectionKind: "copy" }, { kind: "detail" }, { kind: "activity" }] }));
    vi.unstubAllGlobals();
  });

  it("closes an open lightbox on tab switch instead of crashing or showing the wrong asset", async () => {
    await render(<ProjectWorkspace projectId="p1" />);
    await flush();

    const tile = host.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]');
    expect(tile).not.toBeNull();
    await click(tile!);
    await flush();
    expect(host.querySelector('[aria-label="Close"]')).not.toBeNull();

    await click(editedTabButton(host));
    await flush();

    expect(host.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it("keeps photographer Dropbox sync capability-scoped to RAW and ingest", async () => {
    authState.role = "photographer";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), rawFolderPath: "/dropbox/raw" });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: rawAssets });
      return Promise.resolve({});
    });
    apiPostMock.mockResolvedValue({ raw: { jobId: "raw-job" }, edited: { skipped: "not_ready" } });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    const dropboxDialog = await openDropboxDialog(host);
    vi.useFakeTimers();
    await click(dropboxDialog.querySelector<HTMLButtonElement>('[data-testid="dropbox-sync"]')!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/p1/sync-dropbox", {});
    for (let cycle = 0; cycle < 6; cycle += 1) await act(async () => { vi.advanceTimersByTime(2500); await Promise.resolve(); await Promise.resolve(); });
    const paths = apiGetMock.mock.calls.map(([path]) => path);
    expect(paths.filter((path) => path.includes("/assets?collection=raw")).length).toBeGreaterThanOrEqual(7);
    expect(paths.filter((path) => path.includes("/ingest-status")).length).toBeGreaterThanOrEqual(7);
    expect(paths.some((path) => path.includes("/assets?collection=edited"))).toBe(false);
    expect(paths.some((path) => path.includes("/jobs"))).toBe(false);
    expect(paths.some((path) => path.includes("/autohdr-status"))).toBe(false);
  });
});

describe("ProjectWorkspace selection download", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = mount();
    authState.role = "editor";
    apiGetMock.mockReset(); apiPostMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1"), workspaceAsset("raw-2")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [] });
      return Promise.resolve({});
    });
  });
  afterEach(async () => { vi.useRealTimers(); await unmount(); host.remove(); vi.restoreAllMocks(); });

  it("POSTs the captured ids, then uses the returned ticket URL in a native anchor download", async () => {
    apiPostMock.mockResolvedValue({ downloadUrl: "/api/projects/p1/download-selection/ticket/archive.zip" });
    const append = vi.spyOn(document.body, "append");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const anchorRemove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((item) => item.textContent === "Download selection")!;
    await click(button); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/p1/download-selection", { assetIds: ["raw-1"] });
    const anchor = append.mock.calls.map(([node]) => node).find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)!;
    expect(anchor.href).toBe("http://localhost:3000/api/projects/p1/download-selection/ticket/archive.zip"); expect(anchor.hasAttribute("download")).toBe(true); expect(anchorClick).toHaveBeenCalled(); expect(anchorRemove).toHaveBeenCalledWith(); expect(anchor.isConnected).toBe(false);
  });

  it("keeps the AutoHDR toolbar on the persisted selected-raw ZIP route and removes its anchor", async () => {
    authState.role = "admin";
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "awaiting_raw" });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-selected", { selected: true })] });
      if (path.includes("/jobs")) return Promise.resolve({ jobs: [] });
      return Promise.resolve({});
    });
    const append = vi.spyOn(document.body, "append");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const anchorRemove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    // TB8-10B: the legacy `.button` hook is retired onto buttonClasses(); select by role within
    // the `[data-testid="autohdr-handoff"]` wrapper instead.
    const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="autohdr-handoff"] button')].find((item) => item.textContent === "Download 1 selected (zip)")!;
    await click(button);
    const anchor = append.mock.calls.map(([node]) => node).find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)!;
    expect(anchor.href).toBe("http://localhost:3000/api/projects/p1/selected-raw.zip"); expect(anchor.href).not.toContain("download-selection"); expect(anchorClick).toHaveBeenCalled(); expect(anchorRemove).toHaveBeenCalledWith(); expect(anchor.isConnected).toBe(false);
  });

  it("toasts POST errors without removing the checked tile", async () => {
    apiPostMock.mockRejectedValue(new Error("Selection unavailable"));
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((item) => item.textContent === "Download selection")!); await flush(20);
    expect(host.textContent).toContain("Selection unavailable");
    expect(host.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]')?.dataset.multiSelected).toBe("true");
  });

  it("treats an asset-specific mutation 404 as an ordinary mutation error", async () => {
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    await click(host.querySelectorAll<HTMLButtonElement>('[aria-label^="Select "]')[0]!);
    apiPostMock.mockRejectedValueOnce(new ApiError("Asset disappeared", 404));
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="photo-grid-actionbar"] button')].find((item) => item.textContent === "Download selection")!); await flush(20);
    expect(host.textContent).toContain("Asset disappeared");
    expect(host.textContent).not.toContain("Project unavailable.");
  });
});

describe("ProjectWorkspace collaboration relocation", () => {
  let host: HTMLElement;
  beforeEach(() => { host = mount(); authState.role = "editor"; apiGetMock.mockReset(); apiPostMock.mockReset(); apiPatchMock.mockReset(); });
  afterEach(async () => { vi.useRealTimers(); await unmount(); host.remove(); });

  it("keeps the overlay out of the workspace grid, forwards every arrival, and preserves it over a lightbox", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    const consumed: number[] = [];
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={1} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    const panel = host.querySelector<HTMLElement>('[data-testid="project-collaboration-panel"]')!;
    const workspace = panel.closest<HTMLElement>('[data-testid="project-workspace"]')!;
    const wrap = host.querySelector<HTMLElement>('[data-testid="project-collaboration-wrap"]')!;
    expect(panel).not.toBeNull(); expect(workspace).toBeNull(); expect(panel.closest('[aria-label="Project Overview"], [data-testid="workspace-main"]')).toBeNull();
    expect(panel.closest('[data-testid="project-collaboration-wrap"]')).toBe(wrap); expect(consumed).toEqual([1]);
    await click(host.querySelector<HTMLElement>('[data-testid="photo-grid-tile"]')!); await flush();
    expect(host.querySelector('[aria-label="Photo viewer"]')).not.toBeNull(); expect(host.querySelector('[data-testid="project-collaboration-panel"]')).not.toBeNull();
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={2} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(consumed).toEqual([1, 2]);
    await click(hideCollaborationButton(host)); await flush();
    expect(host.querySelector('[data-testid="project-collaboration-panel"]')).toBeNull();
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={3} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.querySelector('[data-testid="project-collaboration-panel"]')).not.toBeNull(); expect(consumed).toEqual([1, 2, 3]);
  });

  it("preserves a comment draft, closed overlay state, and one collaboration load across RAW↔Edited tabs", async () => {
    let commentRequests = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?limit=50")) { commentRequests += 1; return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] }); }
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    await typeIntoEditor(host.querySelector<HTMLElement>("[data-testid=discussion-composer] [contenteditable=\"true\"]")!, "unsent draft");
    await click(hideCollaborationButton(host));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="project-collaboration-toggle"]')?.getAttribute("aria-expanded")).toBe("false");

    await click(editedTabButton(host)); await flush(20);
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("RAW"))!); await flush(20);
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="project-collaboration-toggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle); await flush(4);
    expect(host.querySelector<HTMLElement>("[data-testid=discussion-composer] [contenteditable=\"true\"]")?.textContent).toContain("unsent draft");
    expect(commentRequests).toBe(1);
  });

  it("uses the comments probe for a 403 collaborator without starting workspace reads", async () => {
    // The probe responses are deferred so the in-flight window is held open by the test rather
    // than by luck. Previously they resolved immediately, which made the "Loading project."
    // assertion below a race against however many ticks `render`'s `act` happened to drain: on a
    // loaded machine the whole 403 -> probe -> collaboration-only chain could settle inside
    // `render`, and the assertion then saw the *final* view ("Collaboration / 12 Example St") and
    // failed. Reproduced deterministically by inserting `await flush(3)` before the assertion.
    // Same deferred idiom as "reuses a cached collaboration probe ..." below.
    const probeGate = deferredPromise<void>();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("/collaboration-summary")) return probeGate.promise.then(() => collaborationSummaryFixture());
      if (path.includes("/comments?limit=50")) return probeGate.promise.then(() => ({ project: { id: "p1", street: "Hidden Street" }, comments: [] }));
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    const consumed: number[] = [];
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={7} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />);
    // Deliberately over-pump first: with the gate closed the detail 403 has certainly settled, so
    // this asserts the stronger property — while the probe is in flight the screen holds the
    // loading state and never flashes the terminal error — instead of whatever was on screen at
    // an arbitrary moment. Any number of ticks here must give the same answer.
    await flush(3);
    expect(host.textContent).toContain("Loading project."); expect(host.textContent).not.toContain("Project unavailable.");
    probeGate.resolve();
    // Condition-based, not `flush()`'s fixed 10 ticks: the 403 on `/api/projects/p1` has to settle
    // before the probe queries are even issued, so this test waits on a *sequential* chain whose
    // tick cost the caller cannot know. It is the one site in this file that used the bare default
    // while its siblings used `flush(20)`, and the one observed to fail (~1 run in 12) under the
    // full `npm run test --workspaces`.
    await flushUntil(
      () => host.querySelector('[data-testid="project-collaboration-only"]') !== null
        && host.textContent!.includes("Hidden Street")
        && host.querySelector('[data-testid="project-collaboration-panel"][data-mode="standalone"]') !== null
        && consumed.length > 0,
      "the collaboration-only probe to render and consume the open signal",
    );
    expect(host.querySelector('[data-testid="project-collaboration-only"]')).not.toBeNull(); expect(host.textContent).toContain("Hidden Street"); expect(host.querySelector('[data-testid="project-workspace"], [aria-label="Project Overview"], [data-testid="workspace-main"]')).toBeNull();
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("/assets?collection=raw"), expect.stringContaining("/ingest-status")]));
    expect(consumed).toEqual([7]); expect(host.querySelector('[data-testid="project-collaboration-panel"][data-mode="standalone"]')).not.toBeNull();
  });

  it("fails closed after a collaboration-only comments 403 without mounting workspace reads", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentsAvailable = true;
    let detailCalls = 0;
    let assetCalls = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") { detailCalls += 1; return Promise.reject(new ApiError("Forbidden", 403)); }
      if (path.includes("/collaboration-summary")) return Promise.resolve(collaborationSummaryFixture());
      if (path.includes("/comments?")) return commentsAvailable
        ? Promise.resolve({ project: { id: "p1", street: "Hidden Street" }, comments: [] })
        : Promise.reject(new ApiError("Collaboration unavailable", 403));
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/assets?")) { assetCalls += 1; return Promise.resolve({ assets: [] }); }
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    expect(host.querySelector('[data-testid="project-collaboration-only"]')).not.toBeNull();

    commentsAvailable = false;
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.comments("p1"), exact: true, refetchType: "active" }); await flush(20);

    expect(collaborationUnavailableSection(host)).not.toBeNull();
    expect(host.querySelector('[data-testid="project-collaboration-panel"][data-mode="standalone"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-workspace"], [aria-label="Project Overview"], [data-testid="workspace-main"]')).toBeNull();
    expect(detailCalls).toBe(1);
    expect(assetCalls).toBe(0);
  });

  it("defers all workspace reads until details succeeds, then owns one initial RAW batch and starts collaboration open", async () => {
    authState.role = "admin";
    const details = deferredPromise<ReturnType<typeof projectFixture>>();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return details.promise;
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(["/api/projects/p1"]);
    await act(async () => { details.resolve(projectFixture()); await Promise.resolve(); }); await flush();
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/assets?collection=raw"))).toHaveLength(1);
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([expect.stringContaining("/ingest-status")]));
    expect(apiGetMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([expect.stringContaining("/jobs")]));
    expect(host.querySelector('[data-testid="project-collaboration-toggle"]')?.getAttribute("aria-expanded")).toBe("true");
  });

  it("never probes comments after a successful details response when the workspace batch fails", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.reject(new ApiError("RAW forbidden", 403));
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("comments")) return Promise.resolve({ project: { id: "p1", street: "Leaked Street" }, comments: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(host.textContent).toContain("Project unavailable.");
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("/comments?limit=50")]));
  });

  it("acknowledges terminal 403-probe and direct-failure signals exactly once without mounting a panel", async () => {
    const consumed: number[] = [];
    apiGetMock.mockImplementation((path: string) => path === "/api/projects/p1"
      ? Promise.reject(new ApiError("Forbidden", 403))
      : path.includes("/collaboration-summary") ? Promise.resolve(collaborationSummaryFixture())
      : path.includes("comments?limit=50") ? Promise.reject(new ApiError("Forbidden", 403)) : Promise.resolve({}));
    await render(<ProjectWorkspace projectId="p1" collaborationOpenSignal={11} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.textContent).toContain("Collaboration unavailable."); expect(collaborationUnavailableSection(host)).not.toBeNull(); expect(consumed).toEqual([11]);

    apiGetMock.mockReset().mockImplementation((path: string) => path === "/api/projects/p2" ? Promise.reject(new ApiError("Session expired", 401)) : Promise.resolve({}));
    await render(<ProjectWorkspace projectId="p2" collaborationOpenSignal={12} onCollaborationOpenSignalConsumed={(signal) => consumed.push(signal)} />); await flush();
    expect(host.textContent).toContain("Project unavailable."); expect(consumed).toEqual([11, 12]);
    expect(apiGetMock.mock.calls.map(([path]) => path)).not.toEqual(expect.arrayContaining([expect.stringContaining("comments?limit=50")]));
  });

  it("ignores a late comments probe after navigation and keeps the next project on its own load run", async () => {
    const probe = deferredPromise<{ project: { id: string; street: string }; comments: [] }>();
    let probeSignal: AbortSignal | undefined;
    apiGetMock.mockImplementation((path: string, init?: unknown) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("p1/collaboration-summary")) return Promise.resolve(collaborationSummaryFixture());
      if (path.includes("p1/comments?limit=50")) { probeSignal = (init as { signal?: AbortSignal } | undefined)?.signal; return probe.promise; }
      if (path === "/api/projects/p2") return Promise.resolve(projectFixture("p2"));
      if (path.includes("p2/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("p2-raw")] });
      if (path.includes("p2/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(probeSignal).toBeDefined();
    await render(<ProjectWorkspace projectId="p2" />); await flush();
    expect(probeSignal?.aborted).toBe(true); expect(host.textContent).toContain("34 Second Street");
    await act(async () => { probe.resolve({ project: { id: "p1", street: "Hidden Street" }, comments: [] }); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("34 Second Street"); expect(host.textContent).not.toContain("Hidden Street"); expect(host.querySelector('[data-testid="project-collaboration-only"]')).toBeNull();
  });

  it("does not carry collaboration-only access into the next project generation", async () => {
    const p2Detail = deferredPromise<ReturnType<typeof projectFixture>>();
    let p2CommentsCalls = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.reject(new ApiError("Forbidden", 403));
      if (path.includes("p1/collaboration-summary")) return Promise.resolve(collaborationSummaryFixture());
      if (path.includes("p1/comments?")) return Promise.resolve({ project: { id: "p1", street: "Hidden Street" }, comments: [] });
      if (path === "/api/projects/p2") return p2Detail.promise;
      if (path.includes("p2/comments?")) { p2CommentsCalls += 1; return Promise.resolve({ project: { id: "p2", street: "Wrong Street" }, comments: [] }); }
      if (path.includes("p1/comment-read-marker") || path.includes("p2/comment-read-marker")) return Promise.resolve({ projectId: path.includes("p1/") ? "p1" : "p2", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush(20);
    expect(host.querySelector('[data-testid="project-collaboration-only"]')).not.toBeNull();

    await render(<ProjectWorkspace projectId="p2" />); await flush();

    expect(apiGetMock.mock.calls.map(([path]) => path)).toContain("/api/projects/p2");
    expect(p2CommentsCalls).toBe(0);
    expect(host.textContent).toContain("Loading project.");
    await act(async () => { p2Detail.resolve(projectFixture("p2")); await Promise.resolve(); }); await flush(20);
    expect(host.textContent).toContain("34 Second Street");
  });

  it("keeps authorized detail data when the comments resource loses collaboration access", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentsForbidden = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return commentsForbidden ? Promise.reject(new ApiError("Collaboration unavailable", 403)) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
    commentsForbidden = true;
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.comments("p1"), exact: true, refetchType: "active" }); await flush(20);
    expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
    expect(collaborationUnavailableSection(host)).not.toBeNull();
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
    expect(queryClient!.getQueryData(projectDataKeys.comments("p1"))).toBeUndefined();
    expect(queryClient!.getQueryData(projectDataKeys.commentReadMarker("p1"))).toBeUndefined();
  });

  it("keeps authorized detail data when the read-marker resource loses collaboration access", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let markerForbidden = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return markerForbidden ? Promise.reject(new ApiError("Collaboration unavailable", 403)) : Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    markerForbidden = true;
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.commentReadMarker("p1"), exact: true, refetchType: "active" }); await flush(20);
    expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
    expect(collaborationUnavailableSection(host)).not.toBeNull();
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
  });

  it.each([
    { status: 403, expected: "collaboration" },
    { status: 404, expected: "project" },
  ])("classifies comment POST $status at the owning scope", async ({ status, expected }) => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    apiPostMock.mockRejectedValueOnce(new ApiError(`Comment POST ${status}`, status));
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    await typeIntoEditor(host.querySelector<HTMLElement>('[data-testid=discussion-composer] [contenteditable="true"]')!, "A comment");
    await click(host.querySelector<HTMLButtonElement>('[data-testid=discussion-composer] button[type="submit"]')!); await flush(20);
    if (expected === "collaboration") {
      expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
      expect(collaborationUnavailableSection(host)).not.toBeNull();
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
    } else {
      expect(host.textContent).toContain("Project unavailable.");
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
    }
    expect(queryClient!.getQueryData(projectDataKeys.comments("p1"))).toBeUndefined();
    expect(queryClient!.getQueryData(projectDataKeys.commentReadMarker("p1"))).toBeUndefined();
  });

  it.each([
    { status: 403, expected: "collaboration" },
    { status: 404, expected: "project" },
  ])("classifies read-marker PATCH $status at the owning scope", async ({ status, expected }) => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousObserver = globals.IntersectionObserver;
    const previousFocused = focusManager.isFocused();
    let callback: IntersectionObserverCallback | undefined;
    class TestIntersectionObserver {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globals.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
    focusManager.setFocused(true);
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [{ id: "head", author: { id: "user-1", name: "Owner" }, body: "Head", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Head" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null }] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: { commentId: "head", createdAt: "2026-08-25T00:00:00.000Z" }, unreadCount: 1 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    apiPatchMock.mockRejectedValueOnce(new ApiError(`Read marker PATCH ${status}`, status));
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    const anchor = host.querySelector<HTMLElement>("[data-testid=discussion-read-anchor]")!;
    const scroll = host.querySelector<HTMLElement>('[data-testid="project-collaboration-scroll"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) });
    Object.defineProperty(scroll, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: 100, bottom: 900, width: 100, height: 900 }) });
    callback?.([{ isIntersecting: true, intersectionRatio: 1, boundingClientRect: anchor.getBoundingClientRect() } as IntersectionObserverEntry] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await flush(20);
    if (expected === "collaboration") {
      expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
      expect(collaborationUnavailableSection(host)).not.toBeNull();
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
    } else {
      expect(host.textContent).toContain("Project unavailable.");
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
    }
    focusManager.setFocused(previousFocused);
    if (previousObserver === undefined) Reflect.deleteProperty(globals, "IntersectionObserver");
    else globals.IntersectionObserver = previousObserver;
  });

  it("purges the full project prefix when the comments resource returns 404", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentsMissing = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return commentsMissing ? Promise.reject(new ApiError("Project missing", 404)) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    commentsMissing = true;
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.comments("p1"), exact: true, refetchType: "active" }); await flush(20);
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
    expect(queryClient!.getQueryCache().findAll({ queryKey: projectDataKeys.project("p1") })).toHaveLength(0);
  });

  it("purges the full project prefix when the read-marker resource returns 404", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let markerMissing = false;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
      if (path.includes("comment-read-marker")) return markerMissing ? Promise.reject(new ApiError("Project missing", 404)) : Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    markerMissing = true;
    await queryClient!.invalidateQueries({ queryKey: projectDataKeys.commentReadMarker("p1"), exact: true, refetchType: "active" }); await flush(20);
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
    expect(queryClient!.getQueryCache().findAll({ queryKey: projectDataKeys.project("p1") })).toHaveLength(0);
  });

  it("waits for a confirming list GET before treating nested PATCH 403 as terminal", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentListCalls = 0;
    const own = { id: "own-comment", author: { id: "user-1", name: "Owner" }, body: "Own comment", content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Own comment" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) { commentListCalls += 1; return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [own] }); }
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    const initialCalls = commentListCalls;
    apiPatchMock.mockRejectedValueOnce(new ApiError("Only the author can edit this comment.", 403));
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!); await flush(20);
    expect(commentListCalls).toBeGreaterThan(initialCalls);
    expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
  });

  it("takes a nested PATCH 404 to project terminal only after the confirming list 404", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentListCalls = 0;
    const own = { id: "own-comment", author: { id: "user-1", name: "Owner" }, body: "Own comment", content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Own comment" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) { commentListCalls += 1; return commentListCalls > 1 ? Promise.reject(new ApiError("Project missing", 404)) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [own] }); }
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    apiPatchMock.mockRejectedValueOnce(new ApiError("Comment missing", 404));
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!); await flush(20);
    expect(commentListCalls).toBeGreaterThan(1);
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
  });

  it("waits for a confirming list GET before treating nested DELETE 403 as terminal", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentListCalls = 0;
    const own = { id: "own-comment", author: { id: "user-1", name: "Owner" }, body: "Own comment", content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Own comment" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) { commentListCalls += 1; return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [own] }); }
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    const initialCalls = commentListCalls;
    apiDeleteMock.mockRejectedValueOnce(new ApiError("Only the author can delete this comment.", 403));
    confirmMock.mockResolvedValue(true);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete")!); await flush(20);
    expect(commentListCalls).toBeGreaterThan(initialCalls);
    expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("takes a nested DELETE 404 to project terminal only after the confirming list 404", async () => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentListCalls = 0;
    const own = { id: "own-comment", author: { id: "user-1", name: "Owner" }, body: "Own comment", content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Own comment" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) { commentListCalls += 1; return commentListCalls > 1 ? Promise.reject(new ApiError("Project missing", 404)) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [own] }); }
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
    apiDeleteMock.mockRejectedValueOnce(new ApiError("Comment missing", 404));
    confirmMock.mockResolvedValue(true);
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete")!); await flush(20);
    expect(commentListCalls).toBeGreaterThan(1);
    expect(host.textContent).toContain("Project unavailable.");
    expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it.each([
    { method: "PATCH", confirmationStatus: 401, expected: "principal" },
    { method: "PATCH", confirmationStatus: 403, expected: "collaboration" },
    { method: "PATCH", confirmationStatus: 500, expected: "transient" },
    { method: "DELETE", confirmationStatus: 401, expected: "principal" },
    { method: "DELETE", confirmationStatus: 403, expected: "collaboration" },
    { method: "DELETE", confirmationStatus: 500, expected: "transient" },
  ])("classifies nested $method after confirming GET $confirmationStatus", async ({ method, confirmationStatus, expected }) => {
    let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
    let commentListCalls = 0;
    const own = { id: "own-comment", author: { id: "user-1", name: "Owner" }, body: "Own comment", content: { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Own comment" }] }] }, createdAt: "2026-08-25T00:00:00.000Z", editedAt: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/comments?")) {
        commentListCalls += 1;
        return commentListCalls > 1 ? Promise.reject(new ApiError(`Confirming comments GET ${confirmationStatus}`, confirmationStatus)) : Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [own] });
      }
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
      if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
      return Promise.resolve({});
    });
    if (method === "PATCH") {
      apiPatchMock.mockRejectedValueOnce(new ApiError("Only the author can edit this comment.", 403));
      await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
      await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!);
      await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!);
    } else {
      apiDeleteMock.mockRejectedValueOnce(new ApiError("Only the author can delete this comment.", 403));
      confirmMock.mockResolvedValue(true);
      await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
      await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete")!);
    }
    await flush(20);
    expect(commentListCalls).toBeGreaterThan(1);
    if (expected === "principal") {
      expect(host.textContent).toContain("Project unavailable.");
      expect(queryClient!.getQueryCache().getAll()).toHaveLength(0);
    } else if (expected === "collaboration") {
      expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
      expect(collaborationUnavailableSection(host)).not.toBeNull();
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
      expect(queryClient!.getQueryData(projectDataKeys.comments("p1"))).toBeUndefined();
    } else {
      expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
      expect(host.textContent).not.toContain("Project unavailable.");
      expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeDefined();
      expect(queryClient!.getQueryData(projectDataKeys.comments("p1"))).toBeDefined();
    }
    if (method === "DELETE") vi.unstubAllGlobals();
  });

  it("refreshes RAW after an initial Edited-stage selection", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/api/projects/p1") return Promise.resolve({ ...projectFixture(), stageKey: "edited_review" });
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
      if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [workspaceAsset("edited-1")] });
      if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId="p1" />); await flush();
    expect(host.textContent).toContain("Edited frames");
    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.includes("RAW"))!); await flush();
    expect(host.textContent).toContain("RAW frames");
    expect(apiGetMock.mock.calls.filter(([path]) => path.includes("/assets?collection=raw"))).toHaveLength(1);
  });

  it("lets uploadExtras manage Video and document collections without granting project controls", async () => {
    authState.role = "external_editor";
    const externalProjectId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const collectionIds = { raw: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", edited: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", video: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", floorplan: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", copy: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    const service = (kind: keyof typeof collectionIds, receivedCount: number) => ({ id: collectionIds[kind], kind, status: receivedCount ? "received" : "empty", expectedCount: null, receivedCount });
    const externalAsset = (id: string, collectionId: string, kind: WorkspaceAsset["kind"], filename: string, versionGroupId: string | null = null) => workspaceAsset(id, { collectionId, kind, originalFilename: filename, versionGroupId });
    const raw = externalAsset("11111111-1111-4111-8111-111111111111", collectionIds.raw, "photo", "raw.jpg");
    const floorplan = externalAsset("22222222-2222-4222-8222-222222222222", collectionIds.floorplan, "floorplan_pdf", "plan.pdf", "33333333-3333-4333-8333-333333333333");
    const copy = externalAsset("44444444-4444-4444-8444-444444444444", collectionIds.copy, "copy_pdf", "copy.pdf", "55555555-5555-4555-8555-555555555555");
    const detail = {
      id: externalProjectId,
      address: { street: "External Collections", suburb: null, postcode: null },
      agencyDisplayName: null, agentDisplayName: null, shootDate: null, timeWindow: null, stageKey: "editing", boardRevision: 0, deadline: null, productionNotes: null,
      services: [service("raw", 1), service("edited", 0), service("video", 1), service("floorplan", 1), service("copy", 1)], cover: null, contractEnabled: false, editedUploadAvailable: false,
      collections: [service("raw", 1), service("edited", 0), service("video", 1), service("floorplan", 1), service("copy", 1)], members: [],
    };
    apiGetMock.mockImplementation((path: string) => {
      if (path === `/api/projects/${externalProjectId}`) return Promise.resolve(detail);
      if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [raw] });
      if (path.includes("/assets?collection=edited") || path.includes("/assets?collection=video")) return Promise.resolve({ assets: [] });
      if (path.includes("/assets?collection=floorplan")) return Promise.resolve({ assets: [floorplan] });
      if (path.includes("/assets?collection=copy")) return Promise.resolve({ assets: [copy] });
      if (path.includes("/assets?collection=video")) return Promise.resolve({ assets: [] });
      if (path.includes("/links")) return Promise.resolve({ links: [{ id: "66666666-6666-4666-8666-666666666666", url: "https://example.com/delivered-copy", label: "Delivered copy", source: "manual", position: 1024, createdAt: "2026-08-01T00:00:00.000Z" }] });
      if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
      if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: externalProjectId, street: "External Collections", stageKey: "editing" }, members: [] });
      if (path.includes("/comments?")) return Promise.resolve({ project: { id: externalProjectId, street: "External Collections" }, comments: [] });
      if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: externalProjectId, marker: null, latest: null, unreadCount: 0 });
      if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
      if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
      if (path === "/api/stages") return Promise.resolve({ stages: [] });
      return Promise.resolve({});
    });
    await render(<ProjectWorkspace projectId={externalProjectId} />); await flush(20);

    expect(host.querySelector('a[href$="/edit"]')).toBeNull();
    // dropbox-sync now lives in a closed popover for every role, so gating is proven by the trigger's absence.
    expect(host.querySelector('[data-testid="project-dropbox-trigger"]')).toBeNull();
    expect(host.querySelector('[data-testid="dropbox-sync"]')).toBeNull();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector('[title="Use as project cover"]')).toBeNull();

    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((button) => button.textContent?.startsWith("Video"))!); await flush(20);
    expect(host.textContent).toContain("Add link");
    expect(host.querySelector('[data-testid="collection-link-add"]')).not.toBeNull();

    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((button) => button.textContent?.startsWith("Floorplan"))!); await flush(20);
    expect(host.textContent).toContain("Upload floorplan");
    expect(host.querySelector('[data-testid="document-group"]')).not.toBeNull();
    expect(host.querySelector('button[title="Approve"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="document-upload-version"]').length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain("Edit details");

    await click([...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((button) => button.textContent?.startsWith("Copy"))!); await flush(20);
    expect(host.textContent).toContain("Upload copy");
    expect(host.querySelector('[data-testid="document-group"]')).not.toBeNull();
    expect(host.querySelector('button[title="Approve"]')).toBeNull();
    expect(host.textContent).toContain("Delivered copy");
    expect(host.querySelector('[data-testid="collection-link-editor"]')).toBeNull();
  });

  it("keeps Activity 403 and 404 inside the selected tab while forwarding only 401", async () => {
    const statuses = [403, 404, 401] as const;
    for (const status of statuses) {
      await unmount(); host.remove(); host = mount(); authState.role = "editor";
      apiGetMock.mockReset().mockImplementation((path: string) => {
        if (path === "/api/projects/p1") return Promise.resolve(projectFixture());
        if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [workspaceAsset("raw-1")] });
        if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
        if (path.includes("/activity?")) return Promise.reject(new ApiError(`Activity ${status}`, status));
        if (path.includes("/comments?")) return Promise.resolve({ project: { id: "p1", street: "12 Example St" }, comments: [] });
        if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: "p1", marker: null, latest: null, unreadCount: 0 });
        if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
        if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
        return Promise.resolve({});
      });
      let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;
      // The real workspace callback is exercised for 401; 403/404 stay local to Activity.
      await render(<><ProjectWorkspace projectId="p1" /><ClientCapture onClient={(client) => { queryClient = client; }} /></>); await flush(20);
      await click(host.querySelector<HTMLButtonElement>('[role="tab"][aria-controls$="-activity-panel"]')!); await flush(20);
      if (status === 401) {
        expect(host.textContent).toContain("Project unavailable.");
        expect(queryClient!.getQueryData(projectDataKeys.detail("p1"))).toBeUndefined();
      } else {
        expect(host.querySelector('[data-testid="project-workspace"]')).not.toBeNull();
        expect(collaborationUnavailableSection(host)).toBeNull();
        expect(host.querySelector('[role="tabpanel"][id$="-activity-panel"] [role="alert"]')?.textContent).toContain("isn't available");
        expect(host.querySelector('[role="tabpanel"][id$="-activity-panel"] button')?.textContent).not.toBe("Retry");
      }
    }
  });
});
