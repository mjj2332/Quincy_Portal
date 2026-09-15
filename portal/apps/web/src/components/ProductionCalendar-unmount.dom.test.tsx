// #152: the parent learns about the Calendar's accept gate only through an effect
// (`onAcceptGateChange?.(calendarInteractionBlocked)`), which needs a state update on THIS
// component to fire — and React drops a state update on an unmounting component. A route change
// mid-drop (Back, a rail link) must still release the parent's gate and withdraw the confirm this
// interaction opened, or the Dashboard's controls (and the confirm modal) are stuck until reload.
// Harness lifted from `ProductionCalendar-deadline.dom.test.tsx`, but `../lib/confirm` is left
// real (not mocked) so `confirmStore.getSnapshot()` reflects what this component actually opened.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import { confirmStore } from "../lib/confirm";
import { ProductionCalendar } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => capability === "adminBackend" }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { principalId: projectId, role: "admin" as const, authorizationEpoch: 0 };
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function response() {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-17", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [{ id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 3, total: 5 }, delivered: false }, timing: { allDay: false, start: "2026-08-11T23:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T09:00", deadlineVersion: 3, reminderOffsetsMinutes: [1440, 60] }],
    unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => <div data-testid="calendar-surface">
    <button type="button" data-testid="month-drop" onClick={() => props.eventDrop?.({ event: { allDay: true, start: new Date("2026-08-20T00:00:00.000Z"), startStr: "2026-08-20", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Month</button>
  </div>,
}));

describe("ProductionCalendar releases its parent's gate and its own confirm on unmount (#152)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    apiGetMock.mockReset().mockImplementation(() => Promise.resolve(response()));
    apiPutMock.mockReset().mockImplementation(() => new Promise(() => { /* left pending — never needed */ }));
    while (confirmStore.getSnapshot()) confirmStore.resolve(false);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    while (confirmStore.getSnapshot()) confirmStore.resolve(false);
    await act(async () => { root.unmount(); });
    document.body.replaceChildren();
  });

  async function render(onAcceptGateChange: (blocked: boolean) => void) {
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={identity} calendar={calendar} onNavigate={() => undefined} onAcceptGateChange={onAcceptGateChange} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  it("unmounting mid-drop, with the confirm open, releases the gate and withdraws the confirm", async () => {
    const gateStates: boolean[] = [];
    await render((blocked) => gateStates.push(blocked));

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="month-drop"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(gateStates.at(-1)).toBe(true);
    expect(confirmStore.getSnapshot()).not.toBeNull();

    await act(async () => { root.unmount(); await Promise.resolve(); });

    expect(gateStates.at(-1)).toBe(false);
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("unmounting while idle calls onAcceptGateChange(false) only as the pre-existing cleanup already did — no new call beyond that", async () => {
    const gateStates: boolean[] = [];
    await render((blocked) => gateStates.push(blocked));
    const callsBeforeUnmount = gateStates.length;
    expect(gateStates.at(-1)).toBe(false);

    await act(async () => { root.unmount(); await Promise.resolve(); });

    expect(gateStates.length).toBe(callsBeforeUnmount);
  });
});
