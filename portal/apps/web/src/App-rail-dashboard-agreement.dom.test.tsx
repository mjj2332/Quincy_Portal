import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";

/**
 * The real rail and the real Dashboard mounted together — issue #119. Every other App-level DOM
 * test mocks `./screens/Dashboard` away (`App-navigation-rail-shell.dom.test.tsx`,
 * `App-navigation-rail.dom.test.tsx`, `App.dom.test.tsx`): none of them can catch the rail and the
 * Dashboard disagreeing about which view is showing, because only one of the two is ever real at
 * once. This file mounts both, the way a Staff member actually sees them.
 *
 * The environment shims (viewport, `localStorage`, `IS_REACT_ACT_ENVIRONMENT`) are lifted from
 * `App-navigation-rail-shell.dom.test.tsx`; the heavy-child mocks (Board, Calendar surface, Notice
 * board) and the path-based `apiGet` are lifted from `screens/Dashboard-calendar.dom.test.tsx`,
 * which is the file that already mounts a real `Dashboard` against a fake network. Role is Admin
 * throughout: Archived needs `adminBackend`, Calendar needs `viewProductionCalendar`, and both are
 * required to reach every rail child this file clicks.
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
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("./lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/api")>(),
  apiGet: (path: string) => apiGetMock(path),
  apiPut: (path: string, body: unknown) => apiPutMock(path, body),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
}));

// #152: a per-test flag, defaulting off, so the Board's own DnD (rather than the street-listing
// stub every other test in this file relies on) is reachable for the drag scenarios below without
// touching the existing tests, which never turn it on.
const realBoardEnabled = vi.hoisted(() => ({ value: false }));
// Stage list is `[]` by default (unchanged from before #152 — nothing in this file reads it), and
// widened only for the drag scenarios, which need two real Stages to drag between.
const stagesFixture = vi.hoisted(() => ({ value: [] as Array<{ key: string; label: string; displayOrder: number; active: boolean }> }));
// Captures the real `DndContext` a real Board renders — the technique `board.dom.test.tsx` and
// `Dashboard-stage-interactions.dom.test.tsx` use, since happy-dom cannot exercise real
// PointerSensor/KeyboardSensor activation.
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ props: Record<string, unknown> }> }));
// A drop trigger's dropped-onto deadline event, present only when a Calendar-drop scenario needs
// the range response to carry one — every other test's response keeps its original empty `events`.
const calendarEventFixture = vi.hoisted(() => ({ enabled: false }));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ props: props as unknown as Record<string, unknown> });
      return createElement(actual.DndContext, props);
    },
  };
});
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return { ...actual, SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => createElement(actual.SortableContext, props) };
});

// Heavy children, same reasoning as `Dashboard-calendar.dom.test.tsx`: this file is about the
// rail/Dashboard AGREEMENT, not the Board's DnD or the Calendar's own surface, so each is a stub
// that leaves an unambiguous marker in the DOM for the "which view actually rendered" checks below
// — except the Board, which `realBoardEnabled` swaps for the genuine component so the drag
// scenarios below have a real `DndContext` to capture.
vi.mock("./components/kanban2/board", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/kanban2/board")>();
  return {
    ProjectKanbanBoard2: (props: Record<string, unknown>) => realBoardEnabled.value
      ? createElement(actual.ProjectKanbanBoard2, props as never)
      : <div data-testid="dashboard-board">{(props.projects as Array<{ street?: string }> | undefined)?.map((project) => project.street).join(", ")}</div>,
  };
});
vi.mock("./components/ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: { eventDrop?: (arg: unknown) => void; events?: Array<{ extendedProps?: unknown }> }) => <div data-testid="dashboard-calendar-surface">
    <button type="button" data-testid="dashboard-calendar-drop" onClick={() => props.eventDrop?.({ event: { allDay: true, start: new Date("2026-09-20T00:00:00.000Z"), startStr: "2026-09-20", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Deadline</button>
  </div>,
}));
vi.mock("./components/NoticeBoard", () => ({ NoticeBoard: () => null }));
// `Dashboard` navigates to a project by pushing a location; the real `ProjectWorkspace` fetches
// its own project graph, which is out of scope for a rail/Dashboard agreement check — a stub with
// an unambiguous marker is enough for the lifecycle sequence's "unmounts cleanly" assertion.
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: () => <main>Project workspace</main> }));

import App from "./App";
import { readDashboardView, subscribeDashboardView } from "./lib/dashboard-view-store";
import { locationStore, staffPathFor } from "./lib/router";
import { confirmStore } from "./lib/confirm";

let root: Root | null = null;

const ACTIVE_PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ARCHIVED_PROJECT_ID = "20000000-0000-4000-8000-000000000002";

function projectsResponse(street: string, id: string) {
  return {
    projects: [{ id, street, suburb: null, postcode: null, agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: null, boardRevision: 1, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null }],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [id] } },
  };
}

/**
 * `ProductionCalendar`'s own accept effect (`components/ProductionCalendar.tsx`) refuses a
 * response whose echoed `range.date` does not match the request's `calendar.date` — a late
 * observer outliving a route-key change must never accept data for the wrong range. So the mock
 * echoes the REQUESTED date/window straight back, the way the real API does, rather than a fixed
 * one: the requested date is "today" by default (`initializeDashboardCalendarState`'s Sydney-today
 * fallback), which this file does not otherwise control.
 */
/**
 * A single draggable Project Deadline, present only while `calendarEventFixture.enabled` — the
 * #152 Calendar-drop scenarios drop it; every other test in this file keeps the original empty
 * `events` array.
 */
function calendarDeadlineEvent() {
  return {
    id: "project-deadline:one",
    kind: "project_deadline" as const,
    title: "Deadline",
    project: { id: ACTIVE_PROJECT_ID, street: "1 Active Street", stageKey: "awaiting_raw" as const, checklist: { completed: 0, total: 0 }, delivered: false },
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
    unscheduled: [],
    filterFacets: { projects: [], people: [], myTasksUserId: "00000000-0000-4000-8000-000000000000", unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

/** Same shim `App-navigation-rail-shell.dom.test.tsx` carries — see that file's own comment. */
function installLocalStorageShim() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } });
}

/** Same shim `App-navigation-rail-shell.dom.test.tsx` carries — see that file's own comment. */
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
  setViewportWidth(1024);
  apiGetMock.mockReset();
  apiPutMock.mockReset();
  apiPostMock.mockReset();
  realBoardEnabled.value = false;
  stagesFixture.value = [];
  calendarEventFixture.enabled = false;
  dnd.handlers.length = 0;
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/notifications")) return Promise.resolve({ notifications: [], unreadCount: 0 });
    if (path.startsWith("/api/stages")) return Promise.resolve({ stages: stagesFixture.value });
    if (path.startsWith("/api/production-calendar")) return Promise.resolve(calendarRangeResponse(path));
    if (path.startsWith("/api/projects")) return Promise.resolve(path.includes("archived=1") ? projectsResponse("9 Archived Street", ARCHIVED_PROJECT_ID) : projectsResponse("1 Active Street", ACTIVE_PROJECT_ID));
    return Promise.reject(new Error(`unhandled apiGet path in App-rail-dashboard-agreement.dom.test.tsx: ${path}`));
  });
  // Dashboard code-splits ProductionCalendar behind React.lazy; warm the dynamic import so the
  // Suspense boundary resolves within this file's own render/settle ticks.
  await import("./components/ProductionCalendar");
});

afterEach(async () => {
  // A test that fails mid-drop can leave a request queued — never let it bleed into the next test.
  while (confirmStore.getSnapshot()) confirmStore.resolve(false);
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

async function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  return host;
}

/**
 * Same initial commit `renderApp` reaches before its own `settle()` — the point every screen has
 * mounted and the lazy Calendar chunk is warm, but before any `setTimeout`-driven effect (the
 * capability redirect in `lib/app-router.tsx`, a settling query) has had a further tick to run.
 * Exists to catch a disagreement that only holds for that one intermediate frame, which `settle()`
 * would otherwise paper over before an assertion ever sees it.
 */
async function renderAppFirstCommit(path: string, strict = false) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const element = strict ? <StrictMode><App /></StrictMode> : <App />;
  await act(async () => { root!.render(element); await Promise.resolve(); await Promise.resolve(); });
  return host;
}

/** Which Dashboard view branch actually painted, read the same way a Staff member would see it —
 * not from `view`/`viewingArchived`, which is exactly the state this file catches disagreeing. */
function renderedDashboardBranch(host: ParentNode): "list" | "kanban" | "calendar" | "none" {
  if (host.querySelector('[aria-label="Projects list"]')) return "list";
  if (host.querySelector('[data-testid="dashboard-board"]')) return "kanban";
  if (host.querySelector('[data-testid="dashboard-calendar-surface"]')
    || [...host.querySelectorAll('[role="status"]')].some((node) => node.textContent === "Loading calendar…")) return "calendar";
  return "none";
}

/** The Dashboard's own segmented control — reflects `view` directly, independent of whether the
 * data underneath it has loaded yet, unlike `renderedDashboardBranch`'s content markers. */
function dashboardViewControlActive(host: ParentNode): string | null {
  return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')]
    .find((button) => button.dataset.active === "true")?.textContent?.trim() ?? null;
}

/**
 * `detail: 1`, not a bare synthetic click: `InternalLink`'s `shouldInterceptInternalLink`
 * (`lib/router.ts`) treats `event.detail === 0` as keyboard-issued and deliberately does not
 * `preventDefault()`, so a `detail: 0` click never reaches `locationStore().push()`. Lifted from
 * `App-navigation-rail-shell.dom.test.tsx`'s own `click()`, which explains the same thing at
 * greater length.
 */
async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).focus?.();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

function findByText<T extends Element>(elements: T[], text: string): T | undefined {
  return elements.find((element) => element.textContent?.trim() === text);
}

async function clickButtonLabelled(host: ParentNode, text: string) {
  const button = findByText([...host.querySelectorAll<HTMLButtonElement>("button")], text);
  if (!button) throw new Error(`No button labelled "${text}"`);
  await click(button);
}

function railChildLinks(host: ParentNode) {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="navigation-rail-child-link"]')];
}

async function clickRailChild(host: ParentNode, text: string) {
  const link = findByText(railChildLinks(host), text);
  if (!link) throw new Error(`No rail child link labelled "${text}"`);
  await click(link);
}

/** The rail's own claim about which Dashboard view is current — `aria-current="page"` on exactly
 * one child link, or none while the Dashboard group is not showing children at all. */
function activeRailChild(host: ParentNode): string | null {
  return host.querySelector<HTMLElement>('[data-testid="navigation-rail-child-link"][aria-current="page"]')?.textContent?.trim() ?? null;
}

/** The breadcrumb's own claim — the last crumb, which `ShellHeader`/`reui/breadcrumb.tsx` render
 * with `aria-current="page"` and no link. */
function lastBreadcrumbSegment(host: ParentNode): string | null {
  return host.querySelector('[data-testid="shell-breadcrumb"] [aria-current="page"]')?.textContent?.trim() ?? null;
}

function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

/** One of the Dashboard's own "List"/"Kanban"/"Calendar" segmented-control buttons — `disabled`
 * reflects `interactionBlocked || calendarInteractionBlocked` directly (`screens/Dashboard.tsx`). */
function viewButton(host: ParentNode, label: "List" | "Kanban" | "Calendar"): HTMLButtonElement | undefined {
  return findByText([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Dashboard view"] button')], label);
}

// Two active Stages — enough for a cross-Stage drag between the single fixture project's own
// Stage ("awaiting_raw") and an adjacent, empty one.
const TWO_STAGES = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
  { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
];

/** Fires the real Board's captured `DndContext.onDragStart` — the technique `board.dom.test.tsx`
 * and `Dashboard-stage-interactions.dom.test.tsx` use, since happy-dom cannot exercise real
 * PointerSensor/KeyboardSensor activation. */
async function dndStart(activeId: string) {
  const handler = dnd.handlers.at(-1)?.props.onDragStart as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error("No onDragStart handler captured");
  await act(async () => { handler({ active: { id: activeId }, over: null }); await Promise.resolve(); });
}

describe("the rail and the Dashboard agree about the current view (#119)", () => {
  it("1a — clicking the rail's Kanban while archived exits archived and everything agrees", async () => {
    const host = await renderApp("/?view=list");
    await clickButtonLabelled(host, "Archived");

    expect(host.textContent).toContain("Archived projects");
    expect(host.textContent).toContain("9 Archived Street");
    // The Dashboard's own view control disappears while archived (it has nothing to switch
    // between), but the rail's model does not know archive scope and keeps offering all four
    // (#220 added Gantt between Kanban and Calendar) — so every destination stays reachable, and
    // choosing one leaves archived scope.
    expect(railChildLinks(host).map((link) => link.textContent?.trim())).toEqual(["List", "Kanban", "Gantt", "Calendar"]);
    expect(activeRailChild(host)).toBe("List");

    await clickRailChild(host, "Kanban");

    expect(currentUrl()).toBe("/?view=kanban");
    expect(activeRailChild(host)).toBe("Kanban");
    expect(lastBreadcrumbSegment(host)).toBe("Kanban");
    expect(host.querySelector('[data-testid="dashboard-board"]')).not.toBeNull();
    expect(host.textContent).toContain("1 Active Street");
    expect(host.textContent).not.toContain("Archived projects");
  });

  it("1b — clicking the rail's Calendar while archived exits archived and everything agrees", async () => {
    const host = await renderApp("/?view=list");
    await clickButtonLabelled(host, "Archived");

    await clickRailChild(host, "Calendar");

    expect(currentUrl().startsWith("/?view=calendar")).toBe(true);
    expect(activeRailChild(host)).toBe("Calendar");
    expect(lastBreadcrumbSegment(host)).toBe("Calendar");
    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Archived projects");
  });

  it("1c — clicking the rail's List while archived stays archived", async () => {
    const host = await renderApp("/?view=list");
    await clickButtonLabelled(host, "Archived");

    await clickRailChild(host, "List");

    expect(host.textContent).toContain("Archived projects");
    expect(host.textContent).toContain("9 Archived Street");
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
  });

  it("1d — a history arrival at an explicit Kanban URL while archived exits archived", async () => {
    const host = await renderApp("/?view=list");
    await clickButtonLabelled(host, "Archived");
    expect(host.textContent).toContain("Archived projects");

    // Not a click through `InternalLink` — a genuine Back/Forward-shaped arrival, landing on an
    // explicit non-List view while still archived, the way pasting a URL or pressing Back could
    // already reach it before the rail made it a single click (#119's issue text).
    await act(async () => {
      window.history.pushState(null, "", "/?view=kanban");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(currentUrl()).toBe("/?view=kanban");
    expect(activeRailChild(host)).toBe("Kanban");
    expect(lastBreadcrumbSegment(host)).toBe("Kanban");
    expect(host.querySelector('[data-testid="dashboard-board"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Archived projects");
  });

  it("2 — Back past an explicit List switch restores Kanban everywhere, including the rail, though the remembered preference now says List", async () => {
    window.localStorage.setItem("quincy:dashboard:view", "kanban");
    // A pushed anchor point of its own — `afterEach`'s `replaceState` only overwrites the CURRENT
    // entry, it does not guarantee a clean stack underneath it, so a genuine `history.back()`
    // needs a known bare "/" entry to land on. Same reasoning as
    // `Dashboard-calendar.dom.test.tsx`'s "restores the bare-route remembered view..." test.
    window.history.pushState(null, "", "/");
    const host = await renderApp("/");

    expect(host.querySelector('[data-testid="dashboard-board"]')).not.toBeNull();
    expect(activeRailChild(host)).toBe("Kanban");
    expect(lastBreadcrumbSegment(host)).toBe("Kanban");

    await clickButtonLabelled(host, "List");

    expect(currentUrl()).toBe("/?view=list");
    expect(activeRailChild(host)).toBe("List");
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeNull();
    expect(host.textContent).toContain("1 Active Street");

    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    // Storage now says "list" — the click above wrote it — but the bare route Back landed on is
    // the one the Dashboard originally rendered Kanban for, and Kanban is what it renders again.
    // The rail must follow THAT, not a fresh read of storage, or it disagrees with the screen it
    // is supposedly describing (#119).
    expect(currentUrl()).toBe("/");
    expect(window.localStorage.getItem("quincy:dashboard:view")).toBe("list");
    expect(host.querySelector('[data-testid="dashboard-board"]')).not.toBeNull();
    expect(activeRailChild(host)).toBe("Kanban");
    expect(lastBreadcrumbSegment(host)).toBe("Kanban");

    await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    expect(currentUrl()).toBe("/?view=list");
    expect(host.querySelector('[data-testid="dashboard-board"]')).toBeNull();
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
  });

  it("lifecycle — navigating to a project and back leaves no stale active child, and the store clears on unmount", async () => {
    const host = await renderApp("/?view=kanban");
    expect(activeRailChild(host)).toBe("Kanban");
    expect(readDashboardView()).toBe("kanban");

    await act(async () => {
      locationStore().push(`/projects/${ACTIVE_PROJECT_ID}`);
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(host.textContent).toContain("Project workspace");
    // The Dashboard group closes off its own route (`staff-navigation.ts`'s `expandedItemId`), so
    // no child link is even rendered here — there is nothing left that COULD wrongly claim current.
    expect(activeRailChild(host)).toBeNull();
    expect(readDashboardView()).toBeNull();

    await act(async () => {
      locationStore().push("/");
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(activeRailChild(host)).toBe("Kanban");
    expect(readDashboardView()).toBe("kanban");
  });

  it("a role without the Calendar capability at an explicit Calendar URL never disagrees with the rail", async () => {
    // `view`'s own `useState` initializer used to return an explicit route's "calendar" before any
    // capability check ran, while `calendarState` (gated on the capability from the start) came up
    // `null` — a `view` no render branch matched, yet the store still published "calendar" for one
    // publish before the reconciliation effect corrected it later in the SAME `act()` flush. Reading
    // `readDashboardView()` only after `act()` returns misses that publish entirely — React drains
    // the whole effect queue before yielding, so the transient value is gone by the time any
    // assertion runs. Subscribing BEFORE the first render and recording every notification is the
    // only way this harness can see it.
    sessionState.value = { data: { user: { id: "u2", name: "Pat Photographer", role: "photographer" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    window.history.replaceState(null, "", "/?view=calendar");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    const published: Array<{ value: ReturnType<typeof readDashboardView>; control: string | null }> = [
      { value: readDashboardView(), control: dashboardViewControlActive(host) },
    ];
    const unsubscribe = subscribeDashboardView(() => {
      // `notify()` fires synchronously from inside the Dashboard's own `useLayoutEffect`, after its
      // commit but before any consumer (the rail) has re-rendered — so the segmented control read
      // here is from the SAME commit as the publish, the cheapest thing that can catch the two
      // disagreeing without waiting a further tick for the rail's own re-render to reflect it.
      published.push({ value: readDashboardView(), control: dashboardViewControlActive(host) });
    });

    try {
      await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });

      // Photographer has neither `adminBackend` nor `viewProductionCalendar`: Calendar is absent
      // from the rail's own children, not merely disabled — "calendar" must never even transit
      // through the store, since nothing downstream can show it.
      expect(railChildLinks(host).map((link) => link.textContent?.trim())).toEqual(["List", "Kanban"]);
      expect(published.map((entry) => entry.value)).not.toContain("calendar");
      for (const entry of published) {
        if (entry.value === "list" || entry.value === "kanban") {
          expect(entry.control).toBe(entry.value === "list" ? "List" : "Kanban");
        }
      }

      await settle();

      // The capability redirect (`lib/app-router.tsx`) replaces the explicit Calendar location
      // once it runs; the Dashboard has settled on a real, renderable view and the rail agrees.
      expect(currentUrl()).toBe("/");
      expect(readDashboardView()).not.toBe("none");
      expect(activeRailChild(host)).toBe(dashboardViewControlActive(host));
    } finally {
      unsubscribe();
    }
  });
});

describe("archive entry, Back navigation, StrictMode and unmount keep the rail and the Dashboard agreeing (#119)", () => {
  it("enters Archived from an explicit Kanban URL and stays archived", async () => {
    const host = await renderApp("/?view=kanban");
    expect(activeRailChild(host)).toBe("Kanban");

    await clickButtonLabelled(host, "Archived");

    expect(currentUrl()).toBe("/?view=list");
    expect(activeRailChild(host)).toBe("List");
    expect(host.textContent).toContain("Archived projects");
    expect(host.textContent).toContain("9 Archived Street");
  });

  it("enters Archived from a canonical Calendar URL and stays archived", async () => {
    const host = await renderApp("/?view=calendar");
    expect(activeRailChild(host)).toBe("Calendar");

    await clickButtonLabelled(host, "Archived");

    expect(currentUrl()).toBe("/?view=list");
    expect(activeRailChild(host)).toBe("List");
    expect(host.textContent).toContain("Archived projects");
    expect(host.textContent).toContain("9 Archived Street");
  });

  it("a real Back past the Archived click lands on the popped URL, with the rail and breadcrumb agreeing with whatever the Dashboard renders there", async () => {
    // An anchored `?view=kanban` entry for Back to return to — same reasoning as sequence "2"'s own
    // pushed anchor above: `afterEach`'s `replaceState` only overwrites the current entry.
    window.history.pushState(null, "", "/?view=kanban");
    const host = await renderApp("/?view=kanban");

    await clickButtonLabelled(host, "Archived");
    expect(host.textContent).toContain("Archived projects");

    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    // Whatever the Dashboard's own reconciliation lands on here, the rail's active child and the
    // breadcrumb's last segment must name the SAME branch that actually rendered.
    const branch = renderedDashboardBranch(host);
    const expectedLabel = branch === "list" ? "List" : branch === "kanban" ? "Kanban" : branch === "calendar" ? "Calendar" : null;
    expect(activeRailChild(host)).toBe(expectedLabel);
    expect(lastBreadcrumbSegment(host)).toBe(expectedLabel);
    // A real Back always lands on the pushed `/?view=kanban` anchor this test itself set up — the
    // URL is a fact about where Back went, not a further guess, so it is checked against that
    // literal address rather than re-derived from `branch` the way the rail/breadcrumb checks are.
    expect(currentUrl()).toBe(staffPathFor({ kind: "dashboard", dashboardView: "kanban" }));
  });

  it("agrees inside StrictMode the same way production mounts (main.tsx)", async () => {
    const host = await renderAppFirstCommit("/?view=list", true);
    await settle();
    await clickButtonLabelled(host, "Archived");
    expect(activeRailChild(host)).toBe("List");

    await clickRailChild(host, "Kanban");

    expect(currentUrl()).toBe("/?view=kanban");
    expect(activeRailChild(host)).toBe("Kanban");
    expect(host.querySelector('[data-testid="dashboard-board"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Archived projects");
  });

  it("clears the published view on a root unmount", async () => {
    await renderApp("/?view=kanban");
    expect(readDashboardView()).toBe("kanban");

    await act(async () => { root!.unmount(); });
    root = null;

    expect(readDashboardView()).toBeNull();
  });
});

describe("#152 — a route change mid-interaction releases the barriers the unmounted surface held", () => {
  it("1 — Back during a Calendar drop withdraws the confirm and re-enables every control, and the rail still agrees afterwards", async () => {
    calendarEventFixture.enabled = true;
    const host = await renderApp("/?view=list");
    await clickRailChild(host, "Calendar");
    const drop = host.querySelector<HTMLButtonElement>('[data-testid="dashboard-calendar-drop"]');
    if (!drop) throw new Error("No calendar drop trigger rendered");
    await click(drop);

    // Preconditions: the drop opened the confirm and the accept gate is blocking navigation.
    expect(viewButton(host, "List")?.disabled).toBe(true);
    expect(confirmStore.getSnapshot()).not.toBeNull();

    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    expect(host.querySelector('[data-testid="dashboard-calendar-surface"]')).toBeNull();
    expect(confirmStore.getSnapshot()).toBeNull();
    expect(viewButton(host, "List")?.disabled).toBe(false);
    expect(viewButton(host, "Kanban")?.disabled).toBe(false);
    expect(viewButton(host, "Calendar")?.disabled).toBe(false);
    expect(currentUrl()).toBe("/?view=list");
    expect(renderedDashboardBranch(host)).toBe("list");
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
    expect(readDashboardView()).toBe("list");
    expect(apiPutMock).not.toHaveBeenCalled();

    await clickRailChild(host, "Kanban");
    expect(currentUrl()).toBe("/?view=kanban");
    expect(renderedDashboardBranch(host)).toBe("kanban");
    expect(activeRailChild(host)).toBe("Kanban");
    expect(lastBreadcrumbSegment(host)).toBe("Kanban");

    await clickButtonLabelled(host, "Archived");
    expect(host.textContent).toContain("Archived projects");
  });

  it("2 — a rail List click while the Calendar's write is in flight re-enables controls immediately, and the deferred write settles without a second request", async () => {
    calendarEventFixture.enabled = true;
    let resolvePut!: (value: unknown) => void;
    apiPutMock.mockImplementation(() => new Promise((resolve) => { resolvePut = resolve; }));

    const host = await renderApp("/?view=list");
    await clickRailChild(host, "Calendar");
    await click(host.querySelector<HTMLButtonElement>('[data-testid="dashboard-calendar-drop"]')!);
    expect(viewButton(host, "List")?.disabled).toBe(true);

    await act(async () => { confirmStore.resolve(true); await Promise.resolve(); });
    await settle();
    // The accepted write is now in flight, held open by the deferred `apiPutMock` above.
    expect(apiPutMock).toHaveBeenCalledTimes(1);

    await clickRailChild(host, "List");

    expect(currentUrl()).toBe("/?view=list");
    expect(renderedDashboardBranch(host)).toBe("list");
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
    expect(readDashboardView()).toBe("list");
    expect(viewButton(host, "List")?.disabled).toBe(false);
    expect(viewButton(host, "Kanban")?.disabled).toBe(false);
    expect(viewButton(host, "Calendar")?.disabled).toBe(false);

    await act(async () => { resolvePut({ changed: true, current: { version: 2, deadline: { localCivil: "2026-09-20T09:00", instant: "2026-09-19T23:00:00.000Z" }, reminderOffsetsMinutes: [] } }); await Promise.resolve(); });
    await settle();

    expect(viewButton(host, "List")?.disabled).toBe(false);
    expect(viewButton(host, "Kanban")?.disabled).toBe(false);
    expect(apiPutMock).toHaveBeenCalledTimes(1);
  });

  it("3 — Back during a Kanban drag re-enables every control and the rail/breadcrumb agree with wherever Back landed", async () => {
    realBoardEnabled.value = true;
    stagesFixture.value = TWO_STAGES;
    const host = await renderApp("/?view=list");
    await clickRailChild(host, "Kanban");

    await dndStart(ACTIVE_PROJECT_ID);
    expect(viewButton(host, "List")?.disabled).toBe(true);

    await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();

    expect(viewButton(host, "List")?.disabled).toBe(false);
    expect(viewButton(host, "Kanban")?.disabled).toBe(false);
    expect(viewButton(host, "Calendar")?.disabled).toBe(false);
    expect(currentUrl()).toBe("/?view=list");
    expect(renderedDashboardBranch(host)).toBe("list");
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
    expect(readDashboardView()).toBe("list");
  });

  it("4 — a rail List click during a Kanban drag re-enables controls, and a cross-Stage drag-end the dead Board still receives writes nothing and opens no confirm", async () => {
    realBoardEnabled.value = true;
    stagesFixture.value = TWO_STAGES;
    const host = await renderApp("/?view=list");
    await clickRailChild(host, "Kanban");

    await dndStart(ACTIVE_PROJECT_ID);
    expect(viewButton(host, "List")?.disabled).toBe(true);
    // Captured before the Board unmounts — dnd-kit does not detach an active sensor when
    // `DndContext` unmounts, so this handler can still fire after the click below.
    const deadHandlers = dnd.handlers.at(-1);

    await clickRailChild(host, "List");

    expect(currentUrl()).toBe("/?view=list");
    expect(renderedDashboardBranch(host)).toBe("list");
    expect(activeRailChild(host)).toBe("List");
    expect(lastBreadcrumbSegment(host)).toBe("List");
    expect(readDashboardView()).toBe("list");
    expect(viewButton(host, "List")?.disabled).toBe(false);
    expect(viewButton(host, "Kanban")?.disabled).toBe(false);

    const end = deadHandlers?.props.onDragEnd as ((event: unknown) => void) | undefined;
    if (!end) throw new Error("No onDragEnd handler captured");
    await act(async () => { end({ active: { id: ACTIVE_PROJECT_ID }, over: { id: "raw_review" } }); await Promise.resolve(); });
    await settle();

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(confirmStore.getSnapshot()).toBeNull();
  });
});

/**
 * #217 fix round 8, Sol review, item 1 (HIGH). `withLiveDashboardSearch` (`lib/app-router.tsx`)
 * used to rewrite only the Dashboard CHILD hrefs (List/Kanban/Calendar), leaving the top-level
 * "Dashboard" rail link (`staff-navigation.ts`'s own `id: "dashboard"` item, rendered as a real
 * `<a>` by `NavigationRail.tsx`) bare `/`. Clicking it landed on a q-less URL, which `ShellRoute`'s
 * own sync (`syncDashboardSearchDraftFromLocation`) then treated as authoritative and used to clear
 * the draft — discarding an off-Dashboard draft that had never been committed anywhere else.
 */
function railParentDashboardLink(host: ParentNode): HTMLAnchorElement | undefined {
  return [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="navigation-rail-link"]')]
    .find((link) => link.textContent?.trim() === "Dashboard");
}

describe("the rail's top-level Dashboard link carries the live off-Dashboard draft (#217 fix round 8, item 1)", () => {
  async function typeIntoShellSearch(host: ParentNode, value: string) {
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("clicking Dashboard mid-debounce (before the 300ms commit) lands on ?q=smith, keeps the input, and the projects request carries q", async () => {
    const host = await renderApp("/admin");
    await typeIntoShellSearch(host, "smith");
    // Still inside the 300ms debounce — no commit has happened anywhere yet.
    expect(railParentDashboardLink(host)!.getAttribute("href")).toBe("/?q=smith");

    await click(railParentDashboardLink(host)!);

    expect(currentUrl()).toBe("/?q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);
  });

  // #217 fix round 9, Sol review, item 5. Off-Dashboard, at `/admin`, no writer is registered
  // (only a mounted `Dashboard` registers one) -- so the debounce firing after 300ms here is
  // DROPPED, not "written through" to the URL (#217 build step 5). The rail's own href already
  // carries the live draft (`withLiveDashboardSearch`, `lib/app-router.tsx`), so clicking it is
  // what lands on `?q=smith`, independent of whether the dropped timer fired first.
  it("clicking Dashboard after the 300ms debounce fires (and is dropped, off-Dashboard) still lands on ?q=smith via the rail href, keeps the input, and the projects request carries q", async () => {
    const host = await renderApp("/admin");
    await typeIntoShellSearch(host, "smith");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });

    await click(railParentDashboardLink(host)!);

    expect(currentUrl()).toBe("/?q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");
    expect(apiGetMock.mock.calls.map(([path]) => path).some((path) => path.startsWith("/api/projects") && path.includes("q=smith"))).toBe(true);
  });

  it("an empty draft keeps the top-level Dashboard href bare `/`", async () => {
    const host = await renderApp("/admin");
    expect(railParentDashboardLink(host)!.getAttribute("href")).toBe("/");
  });
});

/**
 * #217 fix round 9, Sol review, item 2. Ported from `Dashboard-search-interaction.dom.test.tsx`'s
 * own former "a debounce armed off-Dashboard is cancelled on arrival" test, which mounted a bare
 * `Dashboard` under `<StrictMode>` but synthesised the arrival itself — it pushed `/?q=smith` onto
 * `window.history` directly and drove the draft-to-URL sync through a LOCAL `ArrivalSync`
 * stand-in, never the real rail click/Enter path or the real `ShellRoute`. Hosted here instead,
 * against the real `App` this file already mounts: types into the REAL `ShellSearch` at `/admin`
 * under `<StrictMode>`, then arrives at Dashboard through (i) a REAL click on the rail's parent
 * Dashboard link and (ii) a REAL Enter keydown — asserting against a spy on `locationStore()`'s
 * own `push`/`replace`, not `window.location.search` alone, so a same-URL write that string
 * equality would miss is still caught. Uses its own fake-timers-throughout render/type/arrive
 * helpers rather than the file's `renderApp`/`click`/`settle` (which drive real `setTimeout`s) —
 * mixing the two would leave the debounce's own 300ms timer unadvanceable.
 */
describe("off-Dashboard, the draft reaches the URL exactly once through the rail click/Enter itself (never the dropped debounce), under StrictMode (#217 fix round 9, item 2)", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function typeIntoShellSearchFakeTimers(host: ParentNode, value: string) {
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function renderAppUnderStrictModeFakeTimers(path: string) {
    window.history.replaceState(null, "", path);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<StrictMode><App /></StrictMode>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    return host;
  }

  it("(i) clicking the rail's parent Dashboard link", async () => {
    vi.useFakeTimers();
    const host = await renderAppUnderStrictModeFakeTimers("/admin");
    await typeIntoShellSearchFakeTimers(host, "smith");

    const pushSpy = vi.spyOn(locationStore(), "push");
    const replaceSpy = vi.spyOn(locationStore(), "replace");

    // Still inside the 300ms debounce — the rail link's own href already carries the draft (#217
    // fix round 8, item 1), so clicking it is what commits, not the stale off-Dashboard timer.
    await act(async () => {
      railParentDashboardLink(host)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(currentUrl()).toBe("/?q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");

    const writesAtArrival = pushSpy.mock.calls.length + replaceSpy.mock.calls.length;
    // A full second past the original 300ms debounce — no LATER write occurs: the arrival itself
    // (`ShellRoute`'s own `syncDashboardSearchDraftFromLocation`) cancelled the obsolete timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(pushSpy.mock.calls.length + replaceSpy.mock.calls.length).toBe(writesAtArrival);
    expect(currentUrl()).toBe("/?q=smith");
    pushSpy.mockRestore();
    replaceSpy.mockRestore();
  });

  it("(ii) pressing Enter in the ShellSearch input", async () => {
    vi.useFakeTimers();
    const host = await renderAppUnderStrictModeFakeTimers("/admin");
    await typeIntoShellSearchFakeTimers(host, "smith");

    const pushSpy = vi.spyOn(locationStore(), "push");
    const replaceSpy = vi.spyOn(locationStore(), "replace");

    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(currentUrl()).toBe("/?q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");

    const writesAtArrival = pushSpy.mock.calls.length + replaceSpy.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(pushSpy.mock.calls.length + replaceSpy.mock.calls.length).toBe(writesAtArrival);
    expect(currentUrl()).toBe("/?q=smith");
    pushSpy.mockRestore();
    replaceSpy.mockRestore();
  });
});
