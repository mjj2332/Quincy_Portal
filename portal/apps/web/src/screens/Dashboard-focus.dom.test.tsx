/**
 * #464 — Dashboard orchestration of "Show in Calendar / Timeline": a `focus` location becomes a
 * one-shot request handed to the matching view, the outcome is announced, `focus` is removed from
 * the URL, and a Project the filters hide gets a notice with Clear filters / Dismiss. The two view
 * surfaces are mocked at the boundary (they own their landing: `ProductionGantt-focus` and
 * `ProductionEventCalendar-focus`); this suite owns only the Dashboard's side of the contract.
 */
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staffPathFor, type DashboardCalendarState } from "@quincy/shared";
import { Dashboard } from "./Dashboard";
import { locationStore } from "../lib/router";
import { confirmStore } from "../lib/confirm";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";
import type { ProductionGanttProps } from "../components/ProductionGantt";
import type { ProductionEventCalendarProps } from "../components/ProductionEventCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authRole = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "photographer" | "external_editor" }));
const surfaces = vi.hoisted(() => ({ gantt: null as Record<string, unknown> | null, calendar: null as Record<string, unknown> | null }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authRole.value } } }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: authRole.value, capabilities: [], can: (capability: string) => authRole.value === "admin" && ["adminBackend", "createProject", "viewNoticeBoard"].includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => <div data-testid="notice-board" /> }));
vi.mock("../components/board/board", () => ({ ProjectKanbanBoard2: () => <div data-testid="dashboard-board" /> }));
vi.mock("../components/ProductionGantt", () => ({
  ProductionGantt: (props: ProductionGanttProps) => { surfaces.gantt = props as unknown as Record<string, unknown>; return <div data-testid="dashboard-gantt-surface" />; },
}));
vi.mock("../components/ProductionEventCalendar", () => ({
  ProductionEventCalendar: (props: ProductionEventCalendarProps) => { surfaces.calendar = props as unknown as Record<string, unknown>; return <div data-testid="event-calendar-screen" />; },
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const calendarState: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide", shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

const ganttProps = () => surfaces.gantt as unknown as ProductionGanttProps;
const calendarProps = () => surfaces.calendar as unknown as ProductionEventCalendarProps;
const live = () => locationStore().getLocation();
const liveRegionText = () => [...document.querySelectorAll('[data-testid="dashboard-live-region"]')].map((region) => region.textContent ?? "").join("|");
const notice = () => document.querySelector<HTMLElement>('[data-testid="dashboard-focus-notice"]');
const noticeButton = (name: string) => [...(notice()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === name);

function Harness() {
  const history = locationStore();
  useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  return <Dashboard currentUserId="user-1" role={authRole.value} authorizationEpoch={0} />;
}

describe("Dashboard focus orchestration (#464)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    authRole.value = "admin";
    surfaces.gantt = null;
    surfaces.calendar = null;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation(() => Promise.resolve({ projects: [], board: { contractEnabled: true, orderedProjectIdsByStage: {} } }));
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() } });
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
    await import("../components/ProductionGantt");
    await import("../components/ProductionEventCalendar");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    confirmStore.resolve(false);
    if (root) act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
    __resetDashboardSearchStoreForTest();
  });

  async function mountAt(url: string) {
    window.history.replaceState(null, "", url);
    await act(async () => { root.render(<Harness />); await Promise.resolve(); await Promise.resolve(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  const settle = async (surface: "gantt" | "calendar", token: number, outcome: unknown) => {
    await act(async () => { (surface === "gantt" ? ganttProps().onFocusSettled : calendarProps().onFocusSettled)?.(token, outcome as never); await Promise.resolve(); });
  };

  it("hands a cold Timeline focus URL to the Timeline only, then announces and removes focus on found", async () => {
    await mountAt(`/?view=timeline&focus=${PROJECT}`);
    const request = ganttProps().focus;
    expect(request).toMatchObject({ projectId: PROJECT });
    await settle("gantt", request!.token, { kind: "found", street: "12 Smith St" });
    expect(liveRegionText()).toContain("Showing 12 Smith St in Timeline.");
    expect(live()).toBe("/?view=timeline");
    expect(ganttProps().focus).toBeNull();
    expect(notice()).toBeNull();
  });

  it("hands a cold Calendar focus URL to the Calendar, announces the Deadline and keeps the facet URL", async () => {
    await mountAt(staffPathFor({ kind: "dashboard", calendar: calendarState, focus: PROJECT }));
    const request = calendarProps().focus;
    expect(request).toMatchObject({ projectId: PROJECT });
    await settle("calendar", request!.token, { kind: "found", target: "deadline", label: "Deadline", street: "1 Calendar Street", civilDate: "2026-08-27", folded: false });
    expect(liveRegionText()).toContain("Showing 1 Calendar Street's Deadline, Thu 27 Aug.");
    expect(live()).toBe(staffPathFor({ kind: "dashboard", calendar: calendarState }));
    expect(calendarProps().focus).toBeNull();
  });

  it("announces a folded Calendar chip as folded", async () => {
    await mountAt(staffPathFor({ kind: "dashboard", calendar: calendarState, focus: PROJECT }));
    await settle("calendar", calendarProps().focus!.token, { kind: "found", target: "task", label: "Select hero images", street: "1 Calendar Street", civilDate: "2026-08-12", folded: true });
    expect(liveRegionText()).toContain("Showing 1 Calendar Street's Select hero images, Wed 12 Aug. It is folded under +N more.");
  });

  it("a URL with no focus hands neither view a request", async () => {
    await mountAt("/?view=timeline");
    expect(ganttProps().focus ?? null).toBeNull();
    expect(live()).toBe("/?view=timeline");
  });

  it("the Calendar's filter-reconcile replace keeps the pending focus in the URL", async () => {
    await mountAt(staffPathFor({ kind: "dashboard", calendar: calendarState, focus: PROJECT }));
    await act(async () => { calendarProps().onAppliedFilters?.({ layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: ["editing"], priorities: [], archived: "hide", shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } as never); await Promise.resolve(); });
    expect(live()).toContain(`focus=${PROJECT}`);
    expect(live()).toContain("stages=editing");
  });

  it("a stale token's outcome is ignored and does not touch a newer focus", async () => {
    await mountAt(`/?view=timeline&focus=${PROJECT}`);
    const first = ganttProps().focus!;
    await act(async () => { locationStore().push(`/?view=timeline&focus=${OTHER}`); await Promise.resolve(); });
    const second = ganttProps().focus!;
    expect(second.projectId).toBe(OTHER);
    expect(second.token).not.toBe(first.token);
    await settle("gantt", first.token, { kind: "found", street: "Old St" });
    expect(live()).toBe(`/?view=timeline&focus=${OTHER}`);
    expect(liveRegionText()).not.toContain("Old St");
  });

  it("shows the notice when the Project is hidden: focus on Clear filters, Dismiss removes it", async () => {
    await mountAt(`/?view=timeline&stages=editing&focus=${PROJECT}`);
    await settle("gantt", ganttProps().focus!.token, { kind: "hidden" });
    expect(notice()?.textContent).toContain("That Project isn't shown with the current filters.");
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(live()).toBe("/?view=timeline&stages=editing");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(noticeButton("Clear filters"));
    await act(async () => { noticeButton("Dismiss")?.click(); await Promise.resolve(); });
    expect(notice()).toBeNull();
  });

  it("Clear filters pushes the view with filters and search reset, keeps archived, delivered and focus, and re-lands", async () => {
    await mountAt(`/?view=timeline&q=smith&stages=editing&archived=include&delivered=1&focus=${PROJECT}`);
    await settle("gantt", ganttProps().focus!.token, { kind: "too-many" });
    expect(notice()).not.toBeNull();
    const before = ganttProps().focus;
    await act(async () => { noticeButton("Clear filters")?.click(); await Promise.resolve(); });
    expect(live()).toBe(`/?view=timeline&archived=include&delivered=1&focus=${PROJECT}`);
    expect(notice()).toBeNull();
    expect(ganttProps().focus).toMatchObject({ projectId: PROJECT });
    expect(ganttProps().focus).not.toBe(before);
  });

  it("a Calendar Clear filters keeps layers and Display toggles", async () => {
    const filtered = { ...calendarState, stageKeys: ["editing" as const], showDeliveredProjects: true, layers: ["checklist" as const], search: "smith" };
    await mountAt(staffPathFor({ kind: "dashboard", calendar: filtered, focus: PROJECT }));
    await settle("calendar", calendarProps().focus!.token, { kind: "hidden" });
    await act(async () => { noticeButton("Clear filters")?.click(); await Promise.resolve(); });
    expect(live()).toBe(staffPathFor({ kind: "dashboard", calendar: { ...calendarState, showDeliveredProjects: true, layers: ["checklist"] }, focus: PROJECT }));
  });

  it("a Photographer (no production views) gets no request", async () => {
    authRole.value = "photographer";
    await mountAt(`/?view=timeline&focus=${PROJECT}`);
    expect(surfaces.gantt).toBeNull();
  });
});
