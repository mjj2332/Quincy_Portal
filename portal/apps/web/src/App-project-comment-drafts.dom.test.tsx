import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";

/**
 * #375 — unsent Project comments survive a sheet close/reopen and a Project switch, are cleared by a
 * post (even one that resolves after the sheet closed), and never cross a signed-in user. Through the
 * real `App` (so the provider's place under the principal-keyed `QuincyQueryProvider` is what is
 * tested), the real Dashboard and rail; the Workspace is a stub that hosts the REAL
 * `ProjectDiscussionThread`. Harness lifted from `App-project-sheet.dom.test.tsx` (same traversal rule:
 * a close is simulated by restoring the entry and dispatching popstate).
 */
function setViewportWidth(width: number) {
  const happyWindow = window as unknown as { happyDOM: { setViewport(viewport: { width: number }): void } };
  happyWindow.happyDOM.setViewport({ width });
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionState = vi.hoisted(() => ({
  value: { data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() },
}));
vi.mock("./lib/auth", () => ({
  useSession: () => sessionState.value,
  stopImpersonating: vi.fn<() => Promise<void>>(),
  consumeSignInDestination: () => null,
  signOut: vi.fn<() => Promise<void>>(),
}));

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("./lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/api")>(),
  apiGet: (path: string) => apiGetMock(path),
  apiPut: vi.fn<() => Promise<unknown>>(),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
}));

const calendarEventFixture = vi.hoisted(() => ({ enabled: false }));

// The real Kanban board (so `board-card` is the real opener). Its DnD is not under test here.
vi.mock("./components/reui/event-calendar/event-calendar", async () => (await import("./testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./components/reui/event-calendar/event-calendar-nav", async () => (await import("./testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./components/reui/event-calendar/event-calendar-content", async () => (await import("./testing/event-calendar-fake")).eventCalendarContentModule);
vi.mock("./components/NoticeBoard", () => ({ NoticeBoard: () => <section data-testid="notice-board-marker" /> }));
// The Gantt surface is a stand-in carrying its real opener contract: a real project link whose
// activation calls `onOpenProject` (`ProductionGantt.tsx` via `ProjectCalendarAnchor`, #365).
vi.mock("./components/ProductionGantt", async () => {
  const { ProjectCalendarAnchor } = await import("./components/ProjectCalendarAnchor");
  return {
    ProductionGantt: (props: { onOpenProject?: (id: string) => void; projectHrefFor?: (id: string) => string }) => (
      <div data-testid="dashboard-gantt-surface">
        <ProjectCalendarAnchor testId="gantt-project-link" href="/projects/10000000-0000-4000-8000-000000000001" onOpenProject={() => props.onOpenProject?.("10000000-0000-4000-8000-000000000001")}>1 Active Street</ProjectCalendarAnchor>
      </div>
    ),
  };
});
vi.mock("./screens/Admin", () => ({ Admin: () => <main data-testid="admin-stub">Admin</main> }));
// A stand-in Workspace: one focusable inner control, the arrival it was handed, and a REAL
// `ToastViewport` (exactly as the real Workspace renders one) so the one-viewport rule is checked.
// #374: it also carries the real "Edit details" InternalLink, shows the street it fetched on mount
// (so a Save is visible after the return remounts it), focuses its tab trigger on an arrival (as the
// real Workspace's #337 does) and turns the shell `notice` into a toast (as the real one does).
vi.mock("./screens/ProjectWorkspace", async () => {
  const { ProjectDiscussionThread } = await import("./components/ProjectDiscussionThread");
  return { ProjectWorkspace: ({ projectId }: { projectId: string }) => <main data-testid="ws-stub" data-project-id={projectId}><ProjectDiscussionThread projectId={projectId} /></main> };
});

import App from "./App";
import { locationStore } from "./lib/router";
import { pushToast, mountedToastViewports, clearToasts } from "./lib/toast-store";
import { confirmStore } from "./lib/confirm";
import { eventCalendarFake } from "./testing/event-calendar-fake";

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

let root: Root | null = null;

/** When set, the project-detail GET never answers, so a street shown after Save can only have come
 *  from the edit form's query-cache publication (the invalidation refetch is stuck). */
const detailReadsHang = { value: false };
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_B_ID = "10000000-0000-4000-8000-000000000002";
const PROJECT_PATH = `/projects/${PROJECT_ID}`;
const EDIT_PATH = `${PROJECT_PATH}/edit`;
const serverProject = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
function freshServerProject(archivedAt: string | null = null) {
  return {
    id: "10000000-0000-4000-8000-000000000001", street: "1 Active Street", suburb: null, postcode: null, agencyName: null, agentName: null, agentEmail: null, agentPhone: null,
    shootDate: null, timeWindow: null, orderNo: null, orderId: null, invoiceAmount: null, paymentStatus: null, notes: null, productionNotes: null, rawFolderLink: null, rawFolderPath: null,
    monitoredRawFolder: null, archivedAt, collections: [],
  };
}
const STAGES = [{ key: "awaiting_raw", label: "Awaiting raw", displayOrder: 1, active: true }];

function projectsResponse() {
  return {
    projects: [PROJECT_ID, PROJECT_B_ID].map((id, index) => ({ id, street: `${index + 1} Active Street`, suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null })),
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [PROJECT_ID, PROJECT_B_ID] } },
  };
}

function calendarDeadlineEvent() {
  return {
    id: "project-deadline:one",
    kind: "project_deadline" as const,
    title: "Deadline",
    project: { id: PROJECT_ID, street: "1 Active Street", stageKey: "awaiting_raw" as const, checklist: { completed: 0, total: 0 }, delivered: false, archived: false },
    timing: { allDay: true, start: "2026-09-10", end: null },
    status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
    permissions: { canDrag: true, canResize: false },
    deadlineLocalCivil: "2026-09-10T09:00",
    deadlineVersion: 1,
    reminderOffsetsMinutes: [],
  };
}

function calendarRangeResponse(path: string) {
  const params = new URLSearchParams(path.split("?", 2)[1] ?? "");
  return adminProductionCalendarRangeResponseSchema.parse({
    range: {
      start: params.get("start") ?? "2026-08-31",
      end: params.get("end") ?? "2026-10-12",
      date: params.get("date") ?? "2026-09-16",
      subview: (params.get("sub") ?? "month") as "month" | "week" | "agenda",
      zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: calendarEventFixture.enabled ? [calendarDeadlineEvent()] : [],
    filterFacets: { projects: [], people: [], myTasksUserId: "00000000-0000-4000-8000-000000000000" },
  });
}

function installLocalStorageShim() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } });
}

const happyDomMatchMedia = window.matchMedia.bind(window);
function installMatchMediaShim() {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => {
    const list = happyDomMatchMedia(query);
    const resizeListeners = new Map<unknown, () => void>();
    const add = (listener: (event: { matches: boolean; media: string }) => void) => {
      let last = list.matches;
      const onResize = () => {
        if (list.matches === last) return;
        last = list.matches;
        listener({ matches: last, media: list.media });
      };
      resizeListeners.set(listener, onResize);
      window.addEventListener("resize", onResize);
    };
    const remove = (listener: unknown) => {
      const onResize = resizeListeners.get(listener);
      if (onResize) window.removeEventListener("resize", onResize);
      resizeListeners.delete(listener);
    };
    return {
      get matches() { return list.matches; },
      media: list.media,
      onchange: null,
      addEventListener: (type: string, listener: (event: { matches: boolean; media: string }) => void) => { if (type === "change") add(listener); },
      removeEventListener: (type: string, listener: unknown) => { if (type === "change") remove(listener); },
      addListener: add,
      removeListener: remove,
      dispatchEvent: () => false,
    };
  } });
}

beforeEach(async () => {
  sessionState.value = { data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
  installLocalStorageShim();
  installMatchMediaShim();
  window.localStorage.clear();
  eventCalendarFake.reset();
  clearToasts();
  setViewportWidth(1024);
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockReset();
  detailReadsHang.value = false;
  serverProject.value = freshServerProject();
  apiPatchMock.mockImplementation((_path, body) => {
    serverProject.value = { ...serverProject.value!, ...(body as Record<string, unknown>) };
    return Promise.resolve(serverProject.value);
  });
  calendarEventFixture.enabled = false;
  apiGetMock.mockImplementation((path: string) => {
    if (path === `/api/projects/${PROJECT_ID}` || path === `/api/projects/${PROJECT_B_ID}`) return detailReadsHang.value ? new Promise(() => undefined) : Promise.resolve({ ...serverProject.value });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: PROJECT_ID, marker: null, latest: null, unreadCount: 0 });
    if (path.includes("/comments")) return Promise.resolve({ project: { id: PROJECT_ID, street: "1 Active Street" }, comments: [], nextCursor: null });
    if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
    if (path.startsWith("/api/notifications")) return Promise.resolve({ notifications: [], unreadCount: 0 });
    if (path.startsWith("/api/stages")) return Promise.resolve({ stages: STAGES });
    if (path.startsWith("/api/production-calendar")) return Promise.resolve(calendarRangeResponse(path));
    if (path.startsWith("/api/projects")) return Promise.resolve(projectsResponse());
    return Promise.reject(new Error(`unhandled apiGet path in App-project-sheet.dom.test.tsx: ${path}`));
  });
  await import("./components/ProductionEventCalendar");
});

afterEach(async () => {
  while (confirmStore.getSnapshot()) confirmStore.resolve(false);
  vi.restoreAllMocks();
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  installLocalStorageShim();
  window.localStorage.clear();
  setViewportWidth(1024);
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function renderApp(path: string, state: unknown = null) {
  window.history.replaceState(state, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  return host;
}

const currentUrl = () => `${window.location.pathname}${window.location.search}`;
const sheet = () => document.querySelector<HTMLElement>('[data-testid="project-sheet"]');
const dashboardMain = (host: HTMLElement) => host.querySelector("main");

function pointerClick(element: Element, init: MouseEventInit = {}) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }));
}

async function click(element: Element, init: MouseEventInit = {}) {
  await act(async () => {
    (element as HTMLElement).focus?.();
    pointerClick(element, init);
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

/** The Dashboard's project opener for `view`, ready to activate. */
async function openerFor(host: HTMLElement, view: string): Promise<Element> {
  if (view === "table") return host.querySelector('[data-testid="project-table-row-link"]')!;
  if (view === "board") return host.querySelector('[data-testid="board-card"]')!;
  if (view === "timeline") return host.querySelector('[data-testid="gantt-project-link"]')!;
  await act(async () => { eventCalendarFake.click("project-deadline:one"); await Promise.resolve(); });
  return host.querySelector('[data-testid="calendar-project-link"]')!;
}

/** Simulates the browser having walked to `url` with `state`, which happy-dom's `go()` does not do. */
async function traverseTo(url: string, state: unknown) {
  await act(async () => {
    window.history.replaceState(state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

async function renderDashboardAt(view: string) {
  calendarEventFixture.enabled = view === "calendar";
  const host = await renderApp(`/?view=${view}&q=smith`);
  return host;
}


const composer = () => document.querySelector<HTMLElement>('[data-testid="discussion-composer"] [contenteditable="true"]');
const composerText = () => composer()?.textContent ?? null;

async function typeDraft(text: string) {
  const editor = composer()!;
  await act(async () => {
    editor.focus();
    editor.querySelector("p")!.append(document.createTextNode(text));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    await Promise.resolve(); await Promise.resolve();
  });
  // ProseMirror reads the DOM edit on a MutationObserver tick: wait until the composer's Post
  // button has seen the text (it is disabled while the comment is empty, #376), i.e. until
  // `onChange` (and so the draft store) has run. The character counter used to be this signal,
  // but #376 shows it only near the limit.
  const postEnabled = () => {
    const post = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="discussion-composer"] button'))
      .find((button) => button.textContent?.trim() === "Post");
    return post !== undefined && !post.disabled;
  };
  for (let i = 0; i < 50 && !postEnabled(); i += 1) await settle();
  expect(postEnabled()).toBe(true);
}
async function openProject(host: HTMLElement, index: number) {
  await click(host.querySelectorAll('[data-testid="project-table-row-link"]')[index]!);
  await waitForComposer();
}
async function waitForComposer() {
  for (let i = 0; i < 20 && !composer(); i += 1) await settle();
  expect(composer()).not.toBeNull();
}
async function closeSheet() {
  const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
  await click(document.querySelector('[data-testid="project-sheet-close"]')!);
  expect(go).toHaveBeenCalledWith(-1);
  go.mockRestore();
  await traverseTo("/?view=table&q=smith", null);
  expect(sheet()).toBeNull();
}

describe("Project comment drafts (#375)", () => {
  it("restores an unsent comment on reopen, keeps a separate draft per Project, and restores both", async () => {
    const host = await renderDashboardAt("table");
    await openProject(host, 0);
    await typeDraft("hello");
    await closeSheet();

    await openProject(host, 0);
    expect(composerText()).toBe("hello");
    await closeSheet();

    await openProject(host, 1);
    expect(composerText()).toBe("");
    await typeDraft("b");
    await closeSheet();

    await openProject(host, 0);
    expect(composerText()).toBe("hello");
    await closeSheet();
    await openProject(host, 1);
    expect(composerText()).toBe("b");
  });

  it("a post clears the draft: reopening shows an empty composer", async () => {
    apiPostMock.mockResolvedValue({ id: "c1", author: { id: "u1", name: "Ada Lovelace", isExternal: false }, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] }, createdAt: "2026-09-01T00:00:00.000Z", editedAt: null });
    const host = await renderDashboardAt("table");
    await openProject(host, 0);
    await typeDraft("hello");
    const form = document.querySelector<HTMLFormElement>('[data-testid="discussion-composer"]')!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
    await settle();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(composerText()).toBe("");
    await closeSheet();
    await openProject(host, 0);
    expect(composerText()).toBe("");
  });

  it("a post that resolves after the sheet closed still clears the draft (no double-post on reopen)", async () => {
    let resolvePost: (value: unknown) => void = () => undefined;
    apiPostMock.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
    const host = await renderDashboardAt("table");
    await openProject(host, 0);
    await typeDraft("hello");
    const form = document.querySelector<HTMLFormElement>('[data-testid="discussion-composer"]')!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
    await settle();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    await closeSheet();
    await act(async () => { resolvePost({ id: "c1", author: { id: "u1", name: "Ada Lovelace", isExternal: false }, content: { type: "doc", content: [{ type: "paragraph" }] }, createdAt: "2026-09-01T00:00:00.000Z", editedAt: null }); await Promise.resolve(); });
    await settle();
    await openProject(host, 0);
    expect(composerText()).toBe("");
  });

  it("never leaks across signed-in users: another user, or sign-out and back in, sees no draft", async () => {
    const host = await renderDashboardAt("table");
    await openProject(host, 0);
    await typeDraft("secret");
    await closeSheet();

    // Another user (an impersonation switch changes `user.id` the same way): the keyed provider remounts.
    sessionState.value = { data: { user: { id: "u2", name: "Grace Hopper", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    await act(async () => { root!.render(<App />); await Promise.resolve(); });
    await settle();
    await openProject(host, 0);
    expect(composerText()).toBe("");
    await closeSheet();

    // Back to the first user: still nothing (the store died with the earlier provider).
    sessionState.value = { data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    await act(async () => { root!.render(<App />); await Promise.resolve(); });
    await settle();
    await openProject(host, 0);
    expect(composerText()).toBe("");
    await typeDraft("again");
    await closeSheet();

    // Sign-out unmounts the whole tree; signing back in starts with no drafts.
    sessionState.value = { data: null as never, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    await act(async () => { root!.render(<App />); await Promise.resolve(); });
    await settle();
    sessionState.value = { data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    await act(async () => { root!.render(<App />); await Promise.resolve(); });
    await settle();
    await openProject(host, 0);
    expect(composerText()).toBe("");
  });
});
