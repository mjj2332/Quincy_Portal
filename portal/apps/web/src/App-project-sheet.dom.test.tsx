import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";

/**
 * #366 — the Project sheet over the LIVE Dashboard, through the real `App`, the real rail, the
 * real Dashboard and the real `RailedShell` (so the nested-Root case is exercised). `ProjectWorkspace`
 * is a stub (#374: `EditProject` is REAL, so the edit-in-sheet contract runs through the real form): this file owns the layering, history, focus and layer-gate
 * contract; the real Workspace inside a sheet is `screens/ProjectWorkspace-sheet.dom.test.tsx`.
 *
 * Harness lifted from `App-rail-dashboard-agreement.dom.test.tsx` (mocks, shims, `renderApp`).
 *
 * Traversal rule: happy-dom's `history.go()` does not fire `popstate` reliably, so a close is
 * asserted by spying `history.go`, then SIMULATING the traversal: restore the target entry's state
 * and URL, dispatch `popstate`. A test that calls `history.back()` and asserts "Dashboard visible"
 * would be vacuous.
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
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("./lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/api")>(),
  apiGet: (path: string) => apiGetMock(path),
  apiPut: vi.fn<() => Promise<unknown>>(),
  apiPost: vi.fn<() => Promise<unknown>>(),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
}));

const calendarEventFixture = vi.hoisted(() => ({ enabled: false }));

// The real Kanban board (so `kanban2-card` is the real opener). Its DnD is not under test here.
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
  const { useEffect, useRef, useState } = await import("react");
  const { ToastViewport } = await import("./components/quincy/ToastViewport");
  const { InternalLink } = await import("./components/InternalLink");
  const { apiGet } = await import("./lib/api");
  const { pushToast } = await import("./lib/toast-store");
  return {
    ProjectWorkspace: ({ projectId, arrivalTab, arrivalSignal, notice, onNoticeShown }: { projectId: string; arrivalTab?: string; arrivalSignal?: number; notice?: string | null; onNoticeShown?: () => void }) => {
      const [street, setStreet] = useState("");
      const trigger = useRef<HTMLButtonElement | null>(null);
      useEffect(() => { void apiGet<{ street: string }>(`/api/projects/${projectId}`).then((response) => setStreet(response.street)).catch(() => undefined); }, [projectId]);
      useEffect(() => { if (arrivalTab !== undefined) trigger.current?.focus(); }, [arrivalTab, arrivalSignal]);
      useEffect(() => { if (notice) { pushToast(notice); onNoticeShown?.(); } }, [notice, onNoticeShown]);
      return (
        <main data-testid="ws-stub" data-project-id={projectId} data-arrival-tab={String(arrivalTab)}>
          <button type="button">inner</button>
          <button type="button" ref={trigger} data-testid="ws-tab-trigger">Collaboration</button>
          <span data-testid="ws-street">{street}</span>
          <InternalLink data-testid="ws-edit-link" to={`/projects/${projectId}/edit`}>Edit details</InternalLink>
          <ToastViewport />
        </main>
      );
    },
  };
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

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
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
    projects: [{ id: PROJECT_ID, street: "1 Active Street", suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [PROJECT_ID] } },
  };
}

function calendarDeadlineEvent() {
  return {
    id: "project-deadline:one",
    kind: "project_deadline" as const,
    title: "Deadline",
    project: { id: PROJECT_ID, street: "1 Active Street", stageKey: "awaiting_raw" as const, checklist: { completed: 0, total: 0 }, delivered: false },
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
      appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
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
  serverProject.value = freshServerProject();
  apiPatchMock.mockImplementation((_path, body) => {
    serverProject.value = { ...serverProject.value!, ...(body as Record<string, unknown>) };
    return Promise.resolve(serverProject.value);
  });
  calendarEventFixture.enabled = false;
  apiGetMock.mockImplementation((path: string) => {
    if (path === `/api/projects/${PROJECT_ID}`) return Promise.resolve({ ...serverProject.value });
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
  if (view === "list") return host.querySelector('[data-testid="project-list-row"]')!;
  if (view === "kanban") return host.querySelector('[data-testid="kanban2-card"]')!;
  if (view === "gantt") return host.querySelector('[data-testid="gantt-project-link"]')!;
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

const VIEWS = ["list", "kanban", "calendar", "gantt"] as const;

describe("open from each Dashboard view (#366)", () => {
  it.each(VIEWS)("%s: the sheet floats over the SAME mounted Dashboard, with bookkeeping in history.state", async (view) => {
    const host = await renderDashboardAt(view);
    const from = currentUrl();
    const main = dashboardMain(host);
    expect(main).not.toBeNull();
    // The Dashboard's own project reads; the stub Workspace's detail read (#374) is not the Dashboard refetching.
    const projectCalls = () => apiGetMock.mock.calls.filter(([path]) => String(path).startsWith("/api/projects") && path !== `/api/projects/${PROJECT_ID}`).length;
    const callsBefore = projectCalls();
    const opener = await openerFor(host, view);
    expect(opener).not.toBeNull();

    await click(opener);

    expect(currentUrl()).toBe(PROJECT_PATH);
    expect(sheet()?.querySelector('[data-testid="ws-stub"]')).not.toBeNull();
    expect(dashboardMain(host)).toBe(main);
    expect(window.history.state).toEqual({ quincySheet: { v: 1, backdrop: from, depth: 1, prev: from } });
    expect(projectCalls()).toBe(callsBefore);
  });

  it("a keyboard activation (detail 0) opens the sheet as an SPA push; Ctrl+Enter is left native", async () => {
    const host = await renderDashboardAt("list");
    const main = dashboardMain(host);
    const row = host.querySelector('[data-testid="project-list-row"]')!;
    const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0, ctrlKey: true });
    await act(async () => { row.dispatchEvent(ctrl); await Promise.resolve(); });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(sheet()).toBeNull();
    const enter = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 });
    await act(async () => { row.dispatchEvent(enter); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(currentUrl()).toBe(PROJECT_PATH);
    expect(sheet()).not.toBeNull();
    expect(dashboardMain(host)).toBe(main);
  });

  it("keeps the Dashboard's own DOM (a scrolled list) across open and close", async () => {
    const host = await renderDashboardAt("list");
    const list = host.querySelector<HTMLElement>('[aria-label="Projects list"]')!;
    list.scrollTop = 300;
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    const closeGo = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    expect(closeGo).toHaveBeenCalledWith(-1);
    await traverseTo("/?view=list&q=smith", null);
    expect(host.querySelector('[aria-label="Projects list"]')).toBe(list);
    expect(list.scrollTop).toBe(300);
  });
});

describe("closing returns to the same view (#366)", () => {
  const closers: Array<[string, () => Promise<void>]> = [
    ["the close button", async () => { await click(document.querySelector('[data-testid="project-sheet-close"]')!); }],
    ["Escape", async () => { await act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); }); await settle(); }],
    ["an inset (scrim) press", async () => {
      const scrim = document.querySelector('[data-testid="project-sheet-scrim"]')!;
      await act(async () => {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        await Promise.resolve();
      });
      await settle();
    }],
  ];

  it.each(closers)("%s walks back one entry and lands on the same view, state and opener focus", async (_name, close) => {
    const host = await renderDashboardAt("list");
    const from = currentUrl();
    const main = dashboardMain(host);
    const opener = host.querySelector<HTMLElement>('[data-testid="project-list-row"]')!;
    await click(opener);
    expect(sheet()).not.toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);

    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await close();
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-1);

    await traverseTo(from, null);
    expect(currentUrl()).toBe(from);
    expect(sheet()).toBeNull();
    expect(dashboardMain(host)).toBe(main);
    expect(document.activeElement).toBe(opener);
  });

  it("Back closes the sheet (popstate to the Dashboard entry)", async () => {
    const host = await renderDashboardAt("kanban");
    const from = currentUrl();
    const main = dashboardMain(host);
    await click(await openerFor(host, "kanban"));
    expect(sheet()).not.toBeNull();
    await traverseTo(from, null);
    expect(sheet()).toBeNull();
    expect(dashboardMain(host)).toBe(main);
    expect(currentUrl()).toBe(from);
  });

  it("closing twice before the traversal lands walks back only once", async () => {
    const host = await renderDashboardAt("list");
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const escape = () => act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    await escape();
    await escape();
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe("a direct Project link (#366)", () => {
  it("loads the remembered view under the sheet, and closing replaces (never walks history)", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "kanban");
    const host = await renderApp(PROJECT_PATH, null);
    expect(host.querySelector('[data-testid="kanban2-card"]')).not.toBeNull();
    expect(sheet()?.querySelector('[data-testid="ws-stub"]')).not.toBeNull();
    const board = host.querySelector('[data-testid="kanban2-card"]');
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const replace = vi.spyOn(window.history, "replaceState");
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    expect(go).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(null, "", "/");
    expect(sheet()).toBeNull();
    expect(currentUrl()).toBe("/");
    expect(host.querySelector('[data-testid="kanban2-card"]')).toBe(board);
  });

  it("a reloaded sheet entry restores the Dashboard view its state names", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "kanban");
    const host = await renderApp(PROJECT_PATH, { quincySheet: { v: 1, backdrop: "/?view=list", depth: 1, prev: "/?view=list" } });
    expect(host.querySelector('[aria-label="Projects list"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kanban2-card"]')).toBeNull();
  });

  it.each([
    ["an off-Dashboard backdrop", { quincySheet: { v: 1, backdrop: "/admin", depth: 1, prev: "/" } }],
    ["a protocol-relative backdrop", { quincySheet: { v: 1, backdrop: "//evil.test/", depth: 1, prev: "/" } }],
    ["a future version", { quincySheet: { v: 2, backdrop: "/?view=list", depth: 1, prev: "/?view=list" } }],
    ["a zero depth", { quincySheet: { v: 1, backdrop: "/?view=list", depth: 0, prev: "/?view=list" } }],
  ])("ignores tampered state (%s)", async (_name, state) => {
    window.localStorage.setItem("quincy:dashboard:view", "kanban");
    const host = await renderApp(PROJECT_PATH, state);
    expect(host.querySelector('[aria-label="Projects list"]')).toBeNull();
    expect(host.querySelector('[data-testid="kanban2-card"]')).not.toBeNull();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    expect(go).not.toHaveBeenCalled();
  });
});

describe("Workspace-tab deep links open the sheet (#366)", () => {
  it.each([
    [`${PROJECT_PATH}?tab=raw`, "raw"],
    [`${PROJECT_PATH}?collaboration=open`, "collaboration"],
  ])("%s hands the arrival to the Workspace inside the sheet, URL untouched", async (location, tab) => {
    await renderApp(location, null);
    expect(sheet()?.querySelector('[data-testid="ws-stub"]')?.getAttribute("data-arrival-tab")).toBe(tab);
    expect(currentUrl()).toBe(location);
  });
});

describe("focus (#366)", () => {
  it("moves into the sheet on open and back to the opener on close (keyboard-opened too)", async () => {
    const host = await renderDashboardAt("list");
    const opener = host.querySelector<HTMLElement>('[data-testid="project-list-row"]')!;
    opener.focus();
    await act(async () => { opener.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 })); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    await traverseTo("/?view=list&q=smith", null);
    expect(document.activeElement).toBe(opener);
  });
});

describe("the Project sheet is a route-derived layer (#366)", () => {
  it("navigating to a non-sheet location closes it and unmounts the Dashboard; Back into the sheet entry reopens it over that entry's backdrop", async () => {
    const host = await renderDashboardAt("list");
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    const sheetState = window.history.state;
    expect(sheet()).not.toBeNull();

    await act(async () => { locationStore().push("/admin"); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(document.querySelector('[data-testid="admin-stub"]')).not.toBeNull();
    expect(sheet()).toBeNull();
    expect(host.querySelector('[aria-label="Projects list"]')).toBeNull();

    await traverseTo(PROJECT_PATH, sheetState);
    expect(sheet()).not.toBeNull();
    expect(host.querySelector('[aria-label="Projects list"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="admin-stub"]')).toBeNull();
  });

  it("⌘K stands down while the sheet is open (it would open the parent rail Root beneath it)", async () => {
    setViewportWidth(700);
    const host = await renderDashboardAt("list");
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    expect(sheet()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
    await settle();
    expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
  });
});

describe("nesting under the rail Sheet Root (#366)", () => {
  it("in narrow mode, after a Project sheet has opened and closed, the rail sheet still opens and closes on its own scrim", async () => {
    setViewportWidth(700);
    const host = await renderDashboardAt("list");
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    expect(sheet()).not.toBeNull();
    // A Project sheet uses its own scrim even though it is a nested Root.
    expect(document.querySelector('[data-testid="project-sheet-scrim"]')).not.toBeNull();
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    await traverseTo("/?view=list&q=smith", null);
    expect(sheet()).toBeNull();

    const trigger = host.querySelector<HTMLElement>('[data-testid="shell-header-sheet-trigger"]')!;
    await click(trigger);
    expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull();
    const scrim = document.querySelector('[data-testid="rail-sheet-scrim"]')!;
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();
  });
});

describe("exactly one toast viewport per route (#366)", () => {
  it("one on the Dashboard, one inside the sheet on a Project, and a toast lands there once", async () => {
    const host = await renderDashboardAt("list");
    expect(mountedToastViewports()).toBe(1);
    expect(host.querySelector('[data-testid="dashboard-toast-viewport"]')).not.toBeNull();

    await click(host.querySelector('[data-testid="project-list-row"]')!);
    expect(mountedToastViewports()).toBe(1);
    expect(host.querySelector('[data-testid="dashboard-toast-viewport"]')).toBeNull();

    await act(async () => { pushToast("Saved"); await Promise.resolve(); });
    const toasts = document.querySelectorAll('[data-testid="toast"], [data-testid="dashboard-toast"]');
    expect(toasts).toHaveLength(1);
    expect(sheet()!.contains(toasts[0]!)).toBe(true);
  });
});

describe("a search typed just before the sheet opens survives it (#366)", () => {
  it("type, open a List project inside the 300ms debounce, close: the typed search is still there and reaches the URL", async () => {
    const host = await renderDashboardAt("list");
    const input = () => host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "jones");
      input().dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    // Still inside the debounce: open the project straight away.
    await click(host.querySelector('[data-testid="project-list-row"]')!);
    expect(sheet()).not.toBeNull();

    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    expect(go).toHaveBeenCalledWith(-1);
    await traverseTo("/?view=list&q=smith", null);
    expect(sheet()).toBeNull();

    expect(input().value).toBe("jones");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    await settle();
    expect(input().value).toBe("jones");
    expect(currentUrl()).toBe("/?view=list&q=jones");
  });
});

// ---------------------------------------------------------------------------------------------
// #374 — Edit Project details inside the sheet. The REAL EditProject; the stub Workspace above.
// ---------------------------------------------------------------------------------------------

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function editStreet(value: string) {
  await act(async () => { setInputValue(sheet()!.querySelector<HTMLInputElement>("#project-street")!, value); await Promise.resolve(); });
}

async function submitForm() {
  await act(async () => {
    sheet()!.querySelector('[data-testid="edit-project-form"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
  });
  await settle();
}

const cancelLink = () => [...sheet()!.querySelectorAll("a")].find((a) => a.textContent === "Cancel")!;
const editForm = () => sheet()?.querySelector('[data-testid="edit-project-form"]') ?? null;

/** Dashboard -> project sheet -> edit form, through real clicks. */
async function openEditFromList() {
  const host = await renderDashboardAt("list");
  const from = currentUrl();
  const main = dashboardMain(host);
  await click(host.querySelector('[data-testid="project-list-row"]')!);
  await click(sheet()!.querySelector('[data-testid="ws-edit-link"]')!);
  return { host, from, main };
}

describe("Edit details opens the form inside the sheet (#374)", () => {
  it("shows the real form in the sheet with the SAME Dashboard <main> mounted, depth 2, prev = the project URL", async () => {
    const { host, from, main } = await openEditFromList();
    expect(currentUrl()).toBe(EDIT_PATH);
    expect(editForm()).not.toBeNull();
    expect(dashboardMain(host)).toBe(main);
    expect(window.history.state).toEqual({ quincySheet: { v: 1, backdrop: from, depth: 2, prev: PROJECT_PATH } });
    expect(mountedToastViewports()).toBe(1);
    expect(sheet()!.querySelector('[data-testid="project-sheet-toast-viewport"]')).not.toBeNull();
  });

  it("moves focus to the 'Edit shoot' heading when the opener link unmounts", async () => {
    await openEditFromList();
    const heading = sheet()!.querySelector("h1");
    expect(heading?.textContent).toBe("Edit shoot");
    expect(document.activeElement).toBe(heading);
  });
});

describe("Save and Cancel return by traversal (#374)", () => {
  it("Save: PATCH, then history.go(-1), no push; after the traversal the Workspace shows the new street and one toast, in the sheet", async () => {
    const { host, from } = await openEditFromList();
    const main = dashboardMain(host);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const push = vi.spyOn(window.history, "pushState");
    await editStreet("2 Changed Street");
    await submitForm();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock.mock.calls[0]![1]).toMatchObject({ street: "2 Changed Street" });
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-1);
    expect(push).not.toHaveBeenCalled();

    await traverseTo(PROJECT_PATH, { quincySheet: { v: 1, backdrop: from, depth: 1, prev: from } });
    expect(editForm()).toBeNull();
    expect(sheet()!.querySelector('[data-testid="ws-street"]')?.textContent).toBe("2 Changed Street");
    const toasts = sheet()!.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("Shoot details saved.");
    expect(mountedToastViewports()).toBe(1);
    expect(dashboardMain(host)).toBe(main);
  });

  it("Cancel: go(-1); after the traversal the Workspace is unchanged and no toast is shown", async () => {
    const { from } = await openEditFromList();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await editStreet("Typed but discarded");
    await click(cancelLink());
    expect(go).toHaveBeenCalledWith(-1);
    expect(apiPatchMock).not.toHaveBeenCalled();
    await traverseTo(PROJECT_PATH, { quincySheet: { v: 1, backdrop: from, depth: 1, prev: from } });
    expect(editForm()).toBeNull();
    expect(sheet()!.querySelector('[data-testid="ws-street"]')?.textContent).toBe("1 Active Street");
    expect(sheet()!.querySelectorAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("Cancel re-lands the tab the previous URL named: focus goes to the tab trigger, not the popup", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    const entry = { quincySheet: { v: 1, backdrop: "/?view=list", depth: 1, prev: "/?view=list" } };
    await renderApp(`${PROJECT_PATH}?collaboration=open`, entry);
    await click(sheet()!.querySelector('[data-testid="ws-edit-link"]')!);
    expect(window.history.state).toEqual({ quincySheet: { v: 1, backdrop: "/?view=list", depth: 2, prev: `${PROJECT_PATH}?collaboration=open` } });
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(cancelLink());
    expect(go).toHaveBeenCalledWith(-1);
    await traverseTo(`${PROJECT_PATH}?collaboration=open`, entry);
    expect(sheet()!.querySelector('[data-testid="ws-stub"]')?.getAttribute("data-arrival-tab")).toBe("collaboration");
    expect(document.activeElement).toBe(sheet()!.querySelector('[data-testid="ws-tab-trigger"]'));
  });

  it("a cancel whose previous entry is another location replaces with the workspace instead of walking history", async () => {
    // A stateful entry whose `prev` is NOT this project (a hand-edited or stale state).
    window.localStorage.setItem("quincy:dashboard:view", "list");
    await renderApp(EDIT_PATH, { quincySheet: { v: 1, backdrop: "/?view=list", depth: 2, prev: "/?view=list" } });
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const replace = vi.spyOn(window.history, "replaceState");
    await click(cancelLink());
    expect(go).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(expect.anything(), "", PROJECT_PATH);
  });
});

describe("a direct edit link (#374)", () => {
  it("opens the form in the sheet over the remembered List; Cancel replaces with the workspace, never walking history", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    const host = await renderApp(EDIT_PATH, null);
    expect(editForm()).not.toBeNull();
    expect(host.querySelector('[aria-label="Projects list"]')).not.toBeNull();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const replace = vi.spyOn(window.history, "replaceState");
    await click(cancelLink());
    expect(go).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(null, "", PROJECT_PATH);
    expect(currentUrl()).toBe(PROJECT_PATH);
    expect(sheet()!.querySelector('[data-testid="ws-stub"]')).not.toBeNull();
  });

  it("Save from a direct link also replaces, and the Workspace shows the new street", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    await renderApp(EDIT_PATH, null);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await editStreet("9 Direct Road");
    await submitForm();
    expect(go).not.toHaveBeenCalled();
    expect(currentUrl()).toBe(PROJECT_PATH);
    expect(sheet()!.querySelector('[data-testid="ws-street"]')?.textContent).toBe("9 Direct Road");
    expect(sheet()!.querySelectorAll('[data-testid="toast"]')).toHaveLength(1);
  });

  it.each([
    ["the close button", async () => { await click(document.querySelector('[data-testid="project-sheet-close"]')!); }],
    ["Escape", async () => { await act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); }); await settle(); }],
  ])("closing from the edit form with %s lands on / with the List, same <main>", async (_name, close) => {
    window.localStorage.setItem("quincy:dashboard:view", "list");
    const host = await renderApp(EDIT_PATH, null);
    const list = host.querySelector('[aria-label="Projects list"]');
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await close();
    expect(go).not.toHaveBeenCalled();
    expect(currentUrl()).toBe("/");
    expect(sheet()).toBeNull();
    expect(host.querySelector('[aria-label="Projects list"]')).toBe(list);
  });
});

describe("closing from the edit form in-app (#374)", () => {
  it("walks back the whole depth (go(-2)) to the Dashboard view it came from", async () => {
    const { host, from, main } = await openEditFromList();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-2);
    await traverseTo(from, null);
    expect(sheet()).toBeNull();
    expect(dashboardMain(host)).toBe(main);
  });
});

describe("a save that completes after the sheet was closed (#374, E3)", () => {
  it("does not reopen the sheet or walk history: it only toasts, in the Dashboard's viewport", async () => {
    const { host, from } = await openEditFromList();
    let resolvePatch!: (value: unknown) => void;
    apiPatchMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));
    await editStreet("3 Late Street");
    await submitForm();
    expect(apiPatchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await click(document.querySelector('[data-testid="project-sheet-close"]')!);
    await traverseTo(from, null);
    expect(sheet()).toBeNull();

    const go = vi.spyOn(window.history, "go");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    go.mockClear();
    await act(async () => { resolvePatch({ ...serverProject.value, street: "3 Late Street" }); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    expect(go).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
    expect(currentUrl()).toBe(from);
    const inDashboard = host.querySelector('[data-testid="dashboard-toast-viewport"]');
    expect(inDashboard?.textContent).toContain("Shoot details saved.");
  });
});

describe("permanent delete from the edit form (#374, E4)", () => {
  it("closes the sheet (go(-2)) and the toast lands in the Dashboard viewport", async () => {
    serverProject.value = freshServerProject("2026-01-01T00:00:00.000Z");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { host, from } = await openEditFromList();
      const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
      await act(async () => { setInputValue(sheet()!.querySelector<HTMLInputElement>("#project-delete-confirmation")!, "1 Active Street"); await Promise.resolve(); });
      const del = [...sheet()!.querySelectorAll("button")].find((b) => b.textContent === "Delete project permanently")!;
      await click(del);
      await act(async () => { confirmStore.resolve(true); await Promise.resolve(); await Promise.resolve(); });
      await settle();
      expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}`, expect.objectContaining({ method: "DELETE" }));
      expect(go).toHaveBeenCalledWith(-2);
      await traverseTo(from, null);
      expect(sheet()).toBeNull();
      expect(host.querySelector('[data-testid="dashboard-toast-viewport"]')?.textContent).toContain("Project permanently deleted.");
    } finally { vi.unstubAllGlobals(); }
  });
});
