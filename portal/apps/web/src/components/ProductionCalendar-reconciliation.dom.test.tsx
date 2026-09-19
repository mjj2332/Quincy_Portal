// Happy-dom proves accepted-snapshot/gate state, query coalescing, markup, and
// callback wiring only; it cannot prove real drag geometry, sensor activation,
// scroll, browser focus timing, or assistive-technology delivery.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState, type ProductionCalendarRangeResponse } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { createProductionCalendarInvalidatedMessage, ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { ProductionCalendar, type ProductionCalendarProps } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());
const lastSurfaceProps = vi.hoisted(() => ({ value: null as any }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock, confirmStore: { getSnapshot: () => null, resolve: vi.fn() } }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: [], can: (capability: string) => capability === "adminBackend" }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [] }) }));
vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => {
    lastSurfaceProps.value = props;
    const event = props.events?.[0];
    return <div data-testid="reconciliation-surface" data-editable={String(props.editable)} data-droppable={String(props.droppable)}>
      <button type="button" data-testid="reconciliation-drop" onClick={() => props.eventDrop?.({ event: { allDay: true, start: new Date("2026-08-20T00:00:00.000Z"), startStr: "2026-08-20", extendedProps: event?.extendedProps }, revert: vi.fn() })}>Drop</button>
      {props.events?.map((item: any) => <div key={item.id} data-testid="reconciliation-event">{props.eventContent?.({ event: { extendedProps: item.extendedProps } })}</div>)}
    </div>;
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function response(deadlineLocalCivil = "2026-08-12T09:00", rangeDate = "2026-08-12"): ProductionCalendarRangeResponse {
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { start: "2026-08-10", end: "2026-08-17", date: rangeDate, subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [{ id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project: { id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false }, timing: { allDay: false, start: "2026-08-11T23:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil, deadlineVersion: 3, reminderOffsetsMinutes: [] }],
    unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  });
}

function saveResponse() {
  return { changed: true, current: { version: 4, deadline: { localCivil: "2026-08-20T09:00", instant: "2026-08-19T23:00:00.000Z" }, reminderOffsetsMinutes: [] }, eventIntent: null, publicationIds: [] };
}

describe("ProductionCalendar reconciliation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiGetMock.mockReset().mockResolvedValue(response());
    apiPutMock.mockReset().mockResolvedValue(saveResponse());
    confirmMock.mockReset().mockResolvedValue(true);
    lastSurfaceProps.value = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function renderPage(nextCalendar: DashboardCalendarState, props: Partial<ProductionCalendarProps> = {}, runtime?: ProjectQueryRuntime) {
    const page = <QueryClientProvider client={client}><ProductionCalendar identity={{ principalId: projectId, role: "admin", authorizationEpoch: 0 }} calendar={nextCalendar} onNavigate={() => undefined} {...props as any} /></QueryClientProvider>;
    await act(async () => { root.render(runtime ? <ProjectQueryRuntimeProvider runtime={runtime}>{page}</ProjectQueryRuntimeProvider> : page); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); });
  }

  async function render(props: Partial<ProductionCalendarProps> = {}, runtime?: ProjectQueryRuntime) {
    await renderPage(calendar, props, runtime);
  }

  it("defers accepted data during confirmation and coalesces invalidations into one post-gate refetch", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const accepted = response();
    apiGetMock.mockResolvedValue(accepted);
    await render();
    const key = client.getQueryCache().findAll({ queryKey: ["production-calendar", projectId] })[0]?.queryKey;
    if (!key) throw new Error("Calendar query was not created");
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="reconciliation-event"]')?.textContent).toContain("12 Harbour Street");

    apiGetMock.mockResolvedValue(response("2026-08-20T09:00"));
    client.setQueryData(key, response("2026-08-20T09:00"));
    client.setQueryData(key, response("2026-08-21T09:00"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="reconciliation-event"]')?.textContent).toContain("12 Harbour Street");

    resolveConfirm(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("clears the accept gate before settling, keeps navigation available while commands settle, and accepts one authoritative response", async () => {
    let release!: (value: unknown) => void;
    const settle = new Promise<unknown>((resolve) => { release = resolve; });
    apiGetMock.mockReset().mockResolvedValueOnce(response()).mockReturnValueOnce(settle);
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const acceptGateStates: boolean[] = [];
    const onNavigate = vi.fn();
    await render({ onNavigate, onAcceptGateChange: (blocked: boolean) => acceptGateStates.push(blocked), onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(lastSurfaceProps.value.editable).toBe(false);
    expect(lastSurfaceProps.value.droppable).toBe(false);
    expect(acceptGateStates.at(-1)).toBe(false);
    expect(host.querySelector('[aria-label="Previous period"]')?.textContent).toBe("Prev");
    await act(async () => { (host.querySelector('[aria-label="Previous period"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(onNavigate).toHaveBeenCalled();
    expect(settleStates.some((state) => state.pending && state.recoveryReason === null)).toBe(true);

    release(response("2026-08-20T09:00"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    expect(settleStates.at(-1)).toEqual({ pending: false, recoveryReason: null });
    // acceptRange clears the pending settle, and the mutation flow's explicit
    // refetch-succeeded is then a no-op — exactly one settle→clear transition, no churn.
    const afterWinner = settleStates.slice(settleStates.findIndex((state) => state.pending));
    expect(afterWinner.filter((state) => !state.pending && state.recoveryReason === null)).toHaveLength(1);
  });

  it("clears recovery after a later automatic authoritative acceptance without Refresh", async () => {
    apiGetMock.mockReset()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new ApiError("Calendar unavailable", 400, {}))
      .mockResolvedValue(response());
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const acceptGateStates: boolean[] = [];
    await render({ onAcceptGateChange: (blocked: boolean) => acceptGateStates.push(blocked), onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); await Promise.resolve(); await Promise.resolve(); });
    expect(settleStates.some((state) => state.pending && state.recoveryReason === "The latest Calendar could not be loaded.")).toBe(true);
    expect(host.querySelector('button[data-focus-key="calendar-recovery"]')).not.toBeNull();
    expect(host.querySelector('button[data-focus-key="calendar-move:project-deadline:project"]')).toBeNull();

    const query = client.getQueryCache().findAll({ queryKey: ["production-calendar", projectId] })[0];
    if (!query) throw new Error("Calendar query was not created");
    apiGetMock.mockResolvedValueOnce(response("2026-08-20T09:00"));
    await act(async () => { await client.refetchQueries({ queryKey: query.queryKey }); await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(3);
    expect(host.querySelector('button[data-focus-key="calendar-recovery"]')).toBeNull();
    expect(settleStates.at(-1)).toEqual({ pending: false, recoveryReason: null });
    expect(host.querySelector('button[data-focus-key="calendar-move:project-deadline:project"]')).not.toBeNull();
  });

  it("preserves an active confirmation across a semantically equal Calendar rerender but resets on a real route change", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    await render();
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiPutMock).not.toHaveBeenCalled();

    await renderPage({ ...calendar, layers: [...calendar.layers], editorIds: [...calendar.editorIds], stageKeys: [...calendar.stageKeys] });
    expect(apiPutMock).not.toHaveBeenCalled();
    resolveConfirm(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledOnce();

    confirmMock.mockReset();
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(confirmMock).toHaveBeenCalledOnce();
    await renderPage({ ...calendar, date: "2026-08-13", layers: [...calendar.layers], editorIds: [...calendar.editorIds], stageKeys: [...calendar.stageKeys] });
    resolveConfirm(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledOnce();
  });

  it("wins with access loss mid-mutation, clears the overlay/gate, and suppresses private late copy", async () => {
    const onAccessLoss = vi.fn();
    apiPutMock.mockRejectedValueOnce(new ApiError("Forbidden", 403, { code: "forbidden" }));
    await render({ onAccessLoss });
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-live]')?.textContent ?? "").not.toContain("12 Harbour Street");
    expect(host.querySelector("[data-testid=reconciliation-surface]")).toBeNull();
  });

  it("purges accepted private data after an observer-originated authorization error", async () => {
    const onAccessLoss = vi.fn();
    apiGetMock.mockReset().mockResolvedValueOnce(response());
    await render({ onAccessLoss });
    const query = client.getQueryCache().findAll({ queryKey: ["production-calendar", projectId] })[0];
    if (!query) throw new Error("Calendar query was not created");
    apiGetMock.mockRejectedValueOnce(new ApiError("Forbidden", 403, { code: "forbidden" }));
    await act(async () => { await client.refetchQueries({ queryKey: query.queryKey }); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-testid=reconciliation-surface]")).toBeNull();
    expect(host.querySelector('[aria-live]')?.textContent ?? "").not.toContain("12 Harbour Street");
  });

  it("publishes an ID-free invalidation after a real deadline winner and refetches once when received", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const runtime = new ProjectQueryRuntime(client, "calendar-runtime");
    const sender = new ProjectQueryRuntime(new QueryClient(), "other-tab");
    runtime.start(); sender.start();
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await render({}, runtime);
    await act(async () => { (host.querySelector("[data-testid=reconciliation-drop]") as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 100)); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledOnce();
    // One more broadcast than before #218: invalidateProjectSurfaces now also converges the
    // Production Gantt projection alongside the Calendar's own.
    expect(publish).toHaveBeenCalledTimes(4);
    const message = publish.mock.calls.find(([candidate]) => candidate.type === "production-calendar-invalidated")?.[0];
    if (!message) throw new Error("Calendar invalidation was not published");
    expect(Object.keys(message).sort()).toEqual(["committedAt", "type", "version"]);
    expect(message).toMatchObject({ version: expect.any(Number), type: "production-calendar-invalidated", committedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(message.committedAt))).toBe(false);

    apiGetMock.mockClear();
    const invalidateCount = invalidate.mock.calls.length;
    sender.publish(createProductionCalendarInvalidatedMessage());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.resolve(); });
    expect(publish).toHaveBeenCalledTimes(4);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    const receiveInvalidations = invalidate.mock.calls.slice(invalidateCount);
    expect(receiveInvalidations).toHaveLength(1);
    expect(receiveInvalidations[0]?.[0]).toMatchObject({ queryKey: expect.arrayContaining(["production-calendar", projectId]), exact: true, refetchType: "active" });
    expect(receiveInvalidations[0]?.[0]?.queryKey?.[0]).toBe("production-calendar");
    expect(receiveInvalidations[0]?.[0]?.queryKey?.[1]).toBe(projectId);

    runtime.dispose(); sender.dispose();
    vi.unstubAllGlobals();
  });
});
