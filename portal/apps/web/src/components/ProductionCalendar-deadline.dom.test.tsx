import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, deriveProductionCalendarWindow, editorProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, resolveSydneyCivilMinute, type DashboardCalendarState } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { ProjectQueryRuntime } from "../lib/project-query-sync";
import { productionCalendarFiltersFor, productionCalendarKey } from "../lib/production-calendar-query";
import { ProductionCalendar } from "./ProductionCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());
const roleState = vi.hoisted(() => ({ value: "admin" as "admin" | "editor" | "external_editor" }));
const callbackMode = vi.hoisted(() => ({ value: "normal" as "normal" | "gap" }));

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));
const confirmStoreMock = vi.hoisted(() => ({ getSnapshot: vi.fn(() => null), resolve: vi.fn() }));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock, confirmStore: confirmStoreMock }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: roleState.value, capabilities: [], can: (capability: string) => capability === "adminBackend" && roleState.value === "admin" }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: unknown[]) => stages, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) }));
vi.mock("../lib/production-calendar-fullcalendar", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/production-calendar-fullcalendar")>();
  return {
    ...original,
    fullCalendarCallbackToSydneyCivil: (value: Parameters<typeof original.fullCalendarCallbackToSydneyCivil>[0]) => callbackMode.value === "gap"
      ? { allDay: false as const, date: "2026-10-04T02:30:00.000Z", localCivil: "2026-10-04T02:30", utcOffsetMinutes: 600 }
      : original.fullCalendarCallbackToSydneyCivil(value),
  };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { principalId: projectId, role: "admin" as const, authorizationEpoch: 0 };
const calendar: DashboardCalendarState = { view: "calendar", date: "2026-08-12", subview: "month", layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function response(overrides: Partial<{ canDrag: boolean; deadlineLocalCivil: string; deadlineVersion: number; offsets: number[]; timingStart: string; rangeDate: string }> = {}, stageKey: "editing_autohdr" | "editing" = "editing_autohdr") {
  const payload = {
    range: { start: "2026-08-10", end: "2026-08-17", date: overrides.rangeDate ?? "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } },
    events: [{ id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project: { id: projectId, street: "12 Harbour Street", stageKey, checklist: { completed: 3, total: 5 }, delivered: false }, timing: { allDay: false, start: overrides.timingStart ?? "2026-08-11T23:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: overrides.canDrag ?? true, canResize: false }, deadlineLocalCivil: overrides.deadlineLocalCivil ?? "2026-08-12T09:00", deadlineVersion: overrides.deadlineVersion ?? 3, reminderOffsetsMinutes: overrides.offsets ?? [1440, 60] }],
    unscheduled: [], filterFacets: { projects: [], people: [], myTasksUserId: projectId, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
  };
  return (stageKey === "editing" ? editorProductionCalendarRangeResponseSchema : adminProductionCalendarRangeResponseSchema).parse(payload);
}

function saveCurrent(localCivil: string, version = 3, offsets = [1440, 60]) {
  return { changed: true, current: { version: version + 1, deadline: { localCivil, instant: "2026-08-20T00:00:00.000Z" }, reminderOffsetsMinutes: offsets }, eventIntent: null, publicationIds: [] };
}

vi.mock("./ProductionCalendarSurface", () => ({
  ProductionCalendarSurface: (props: any) => <div data-testid="calendar-surface" data-editable={String(props.editable)}>
    <button type="button" data-testid="month-drop" onClick={() => props.eventDrop?.({ event: { allDay: true, start: new Date("2026-08-20T00:00:00.000Z"), startStr: "2026-08-20", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Month</button>
    <button type="button" data-testid="week-drop" onClick={() => props.eventDrop?.({ event: { allDay: false, start: new Date("2026-08-20T00:07:00.000Z"), startStr: "2026-08-20T00:07:00.000Z", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Week</button>
    <button type="button" data-testid="fold-drop" onClick={() => props.eventDrop?.({ event: { allDay: false, start: new Date("2026-04-04T15:30:00.000Z"), startStr: "2026-04-04T15:30:00.000Z", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Fold</button>
    <button type="button" data-testid="gap-drop" onClick={() => props.eventDrop?.({ event: { allDay: false, start: new Date("2026-10-03T15:30:00.000Z"), startStr: "2026-10-03T15:30:00.000Z", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Gap</button>
    <button type="button" data-testid="same-drop" onClick={() => props.eventDrop?.({ event: { allDay: false, start: new Date("2026-08-11T23:00:00.000Z"), startStr: "2026-08-11T23:00:00.000Z", extendedProps: props.events?.[0]?.extendedProps }, revert: vi.fn() })}>Drop Same</button>
    {props.events?.map((item: any) => <div key={item.id} data-testid="deadline-event" data-civil={item.extendedProps?.dto?.deadlineLocalCivil} data-start={item.start}>{props.eventContent?.({ event: { extendedProps: item.extendedProps } })}</div>)}
  </div>,
}));

describe("ProductionCalendar Project Deadline mutation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    roleState.value = "admin";
    callbackMode.value = "normal";
    apiGetMock.mockReset().mockImplementation(() => Promise.resolve(response({}, roleState.value === "admin" ? "editing_autohdr" : "editing")));
    apiPutMock.mockReset().mockResolvedValue(saveCurrent("2026-08-20T09:00"));
    confirmMock.mockReset().mockResolvedValue(true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

  async function render(value = calendar, props: Record<string, unknown> = {}) {
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={{ ...identity, role: roleState.value }} calendar={value} onNavigate={() => undefined} {...props as any} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  async function click(testId: string) {
    await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); await Promise.resolve(); await Promise.resolve(); });
  }

  async function waitForMutation() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); await Promise.resolve(); await Promise.resolve(); });
  }

  async function setDialogInput(label: "Deadline date" | "Deadline time", value: string) {
    const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!input) throw new Error(`${label} input is missing`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function openMoveDialog() {
    const move = document.querySelector<HTMLButtonElement>('[data-focus-key="calendar-move:project-deadline:project"]');
    if (!move) throw new Error("Move / Reschedule control is missing");
    await act(async () => { move.click(); await Promise.resolve(); });
  }

  it("sends exact Month request, preserving wall time and offsets", async () => {
    await render();
    await click("month-drop");
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Move Deadline", message: "Move the Deadline for 12 Harbour Street?", content: expect.anything() }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 3, deadline: { localCivil: "2026-08-20T09:00" }, reminderOffsetsMinutes: [1440, 60] });
  });

  it("snaps a Week target to a 15-minute Sydney civil slot", async () => {
    await render({ ...calendar, subview: "week" });
    await click("week-drop");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 3, deadline: { localCivil: "2026-08-20T10:00" }, reminderOffsetsMinutes: [1440, 60] });
  });

  it("makes no request on confirmation cancel or unchanged Month target", async () => {
    confirmMock.mockResolvedValue(false);
    await render();
    await click("month-drop");
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledOnce();
    await act(async () => { root.unmount(); root = createRoot(host); });
    confirmMock.mockResolvedValue(true);
    const gateStates: boolean[] = [];
    await render(calendar, { onAcceptGateChange: (blocked: boolean) => gateStates.push(blocked) });
    apiGetMock.mockClear();
    // Dropping back onto the source instant short-circuits before confirmation and
    // routes through the cancel teardown: no request, accept gate released, and no
    // spurious refetch (nothing was queued during the instantaneous no-op).
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="same-drop"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(gateStates.at(-1)).toBe(false);
  });

  it("routes a direct-dialog no-op through the cancel teardown without a request", async () => {
    const gateStates: boolean[] = [];
    await render({ ...calendar, subview: "agenda" }, { onAcceptGateChange: (blocked: boolean) => gateStates.push(blocked) });
    await openMoveDialog();
    expect(gateStates.at(-1)).toBe(true);
    await setDialogInput("Deadline date", "2026-08-12");
    await setDialogInput("Deadline time", "09:00");
    apiGetMock.mockClear();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(gateStates.at(-1)).toBe(false);
    // `Modal` retains the dialog mounted for its 120ms exit transition after `open` goes false
    // (§6.0) — wait for that transition before asserting it is gone.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector('[data-testid="calendar-move-submit"]')).toBeNull();
  });

  it("retains the Move dialog through its exit animation on close, then reopens cleanly (§6.0 retention)", async () => {
    // Regression guard: the open-token that forces a fresh `key` on a genuine re-open must be
    // bumped synchronously during the render that opens the dialog — not in a `useEffect` after
    // it. A `useEffect`-based bump lands one render late, so the render that *closes* the dialog
    // (not the one that opened it) is the one that sees the bumped token, changing `key` on the
    // close instead of a future open. React then unmounts the closing instance immediately
    // (`Modal` mounts fresh with `open=false`, renders nothing) instead of keeping the same
    // instance mounted for `Modal`'s 120ms exit transition — defeating the whole retention
    // design. This test fails on that bug: the dialog would already be gone from the very next
    // synchronous check, with no exit-transition window to observe.
    await render({ ...calendar, subview: "agenda" });
    await openMoveDialog();
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();

    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-cancel"]')!.click(); await Promise.resolve(); });
    // Still mounted immediately after `open` flips false — the retained instance is animating
    // out, not already gone.
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).toBeNull();

    // Reopening afterwards still works cleanly — a fresh instance, correctly seeded.
    await openMoveDialog();
    expect(document.querySelector('[data-testid="calendar-move-dialog"]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline date"]')?.value).toBe("2026-08-12");
  });

  it("does not apply the optimistic overlay before confirmation resolves", async () => {
    let resolve!: (value: boolean) => void;
    confirmMock.mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    await render();
    await click("month-drop");
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-12T09:00");
    resolve(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiPutMock).toHaveBeenCalledOnce();
  });

  it("serializes only one active Calendar command", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    await render();
    await click("month-drop");
    await click("week-drop");
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiPutMock).not.toHaveBeenCalled();
    resolveConfirm(false);
    await waitForMutation();
  });

  it("holds a DST gap draft without sending a command", async () => {
    callbackMode.value = "gap";
    await render({ ...calendar, subview: "week" });
    await click("gap-drop");
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline date"]')?.value).toBe("2026-10-04");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline time"]')?.value).toBe("02:30");
  });

  it("re-runs a DST fold choice and confirms the resolved instant", async () => {
    await render({ ...calendar, subview: "week" });
    await click("fold-drop");
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    const later = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === "later")!;
    await act(async () => { later.click(); document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); });
    await waitForMutation();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, {
      expectedVersion: 3,
      deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" },
      reminderOffsetsMinutes: [1440, 60],
    });
  });

  it("surfaces direct-dialog fold choices before confirmation and sends the chosen disambiguation", async () => {
    await render({ ...calendar, subview: "agenda" });
    await openMoveDialog();
    await setDialogInput("Deadline date", "2026-04-05");
    await setDialogInput("Deadline time", "02:30");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(document.querySelector('[aria-live]')?.textContent).toContain("That time occurs twice in Sydney");

    await act(async () => {
      document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click();
      await Promise.resolve();
    });
    await waitForMutation();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, {
      expectedVersion: 3,
      deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" },
      reminderOffsetsMinutes: [1440, 60],
    });
  });

  it("retains a direct-dialog DST gap draft, announces the gap, and sends no request", async () => {
    await render({ ...calendar, subview: "agenda" });
    await openMoveDialog();
    await setDialogInput("Deadline date", "2026-10-04");
    await setDialogInput("Deadline time", "02:30");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); await Promise.resolve(); });

    expect(apiPutMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-live]')?.textContent).toContain("That time does not exist in Sydney");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline date"]')?.value).toBe("2026-10-04");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline time"]')?.value).toBe("02:30");
  });

  it("treats a server fold response as a new confirmation and preserves the snapshot request", async () => {
    const choices = [{ disambiguation: "earlier" as const, utcOffsetMinutes: 660 }, { disambiguation: "later" as const, utcOffsetMinutes: 600 }];
    apiPutMock.mockReset()
      .mockRejectedValueOnce(new ApiError("deadline repeated", 400, { code: "deadline_repeated_local_time", choices }))
      .mockResolvedValueOnce(saveCurrent("2026-08-20T09:00"));
    await render({ ...calendar, subview: "week" });
    await click("week-drop");
    await waitForMutation();
    expect(apiPutMock).toHaveBeenCalledOnce();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-start")).toBe("2026-08-11T23:00:00.000Z");
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);

    await act(async () => {
      document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click();
      await Promise.resolve();
    });
    await waitForMutation();

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(apiPutMock).toHaveBeenCalledTimes(2);
    expect(apiPutMock.mock.calls[1]?.[1]).toEqual({
      expectedVersion: 3,
      deadline: { localCivil: "2026-08-20T10:00", disambiguation: "later" },
      reminderOffsetsMinutes: [1440, 60],
    });
    const secondContent = (confirmMock.mock.calls[1]?.[0] as { content: { props: { consequences: unknown[] } } }).content.props.consequences;
    const resolved = resolveSydneyCivilMinute("2026-08-20T10:00", "later");
    if (!resolved.ok) throw new Error("Test target did not resolve");
    expect(secondContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ offsetMinutes: 1440, newFireAt: new Date(resolved.value.epochMs - 1440 * 60_000).toISOString() }),
      expect.objectContaining({ offsetMinutes: 60, newFireAt: new Date(resolved.value.epochMs - 60 * 60_000).toISOString() }),
    ]));
  });

  it("moves from the earlier to later fold occurrence instead of treating the civil text as unchanged", async () => {
    apiGetMock.mockReset().mockResolvedValue(response({ deadlineLocalCivil: "2026-04-05T02:30", timingStart: "2026-04-04T15:30:00.000Z" }));
    await render({ ...calendar, subview: "week" });
    // The source is the earlier 02:30 occurrence; the fold drop opens the choice editor.
    await click("fold-drop");
    await act(async () => {
      document.querySelector<HTMLInputElement>('input[type="radio"][value="later"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click();
      await Promise.resolve();
    });
    await waitForMutation();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, {
      expectedVersion: 3,
      deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" },
      reminderOffsetsMinutes: [1440, 60],
    });
  });

  it("rejects a late settle refetch after the Calendar range changes", async () => {
    let resolveStale!: (value: unknown) => void;
    const stale = new Promise<unknown>((resolve) => { resolveStale = resolve; });
    let firstRange = true;
    apiGetMock.mockReset().mockImplementation((path) => {
      if (firstRange) { firstRange = false; return Promise.resolve(response()); }
      if (path.includes("date=2026-08-13")) return Promise.resolve(response({ deadlineLocalCivil: "2026-08-13T09:00", rangeDate: "2026-08-13" }));
      return stale;
    });
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    await render(calendar, { onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await click("month-drop");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(settleStates.some((state) => state.pending)).toBe(true);
    const nextCalendar = { ...calendar, date: "2026-08-13" };
    client.setQueryData(productionCalendarKey(identity, "active", deriveProductionCalendarWindow(nextCalendar.date, nextCalendar.subview), nextCalendar.subview, productionCalendarFiltersFor(nextCalendar)), response({ deadlineLocalCivil: "2026-08-13T09:00", rangeDate: "2026-08-13" }));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionCalendar identity={identity} calendar={nextCalendar} onNavigate={() => undefined} onSettleStateChange={(state) => settleStates.push(state)} /></QueryClientProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-13T09:00");
    resolveStale(response({ deadlineLocalCivil: "2026-08-20T09:00" }));
    await waitForMutation();
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-13T09:00");
    expect(settleStates.at(-1)).toEqual({ pending: false, recoveryReason: null });
  });

  it.each([401, 403] as const)("treats a refetch-originated access error as terminal (%s)", async (status) => {
    const onAccessLoss = vi.fn();
    apiGetMock.mockReset().mockResolvedValueOnce(response()).mockRejectedValueOnce(new ApiError("Calendar access lost", status, {}));
    await render(calendar, { onAccessLoss });
    await click("month-drop");
    await waitForMutation();
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-live]')?.textContent ?? "").toBe("");
  });

  it("defers an incoming range replacement and flushes one refetch on cancel", async () => {
    let resolveConfirm!: (value: boolean) => void;
    confirmMock.mockReturnValue(new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    await render();
    await click("month-drop");
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-12T09:00");

    const key = productionCalendarKey(identity, "active", deriveProductionCalendarWindow(calendar.date, calendar.subview), calendar.subview, productionCalendarFiltersFor(calendar));
    client.setQueryData(key, response({ deadlineLocalCivil: "2026-08-20T09:00" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-12T09:00");

    resolveConfirm(false);
    await waitForMutation();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="deadline-event"]')?.getAttribute("data-civil")).toBe("2026-08-12T09:00");
  });

  it("settles a changed winner with one authoritative refetch and one ID-free broadcast", async () => {
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const runtime = new ProjectQueryRuntime(client, "calendar-mutation-tab");
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render(calendar, { onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await click("month-drop");
    await waitForMutation();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(settleStates.some((state) => state.pending && state.recoveryReason === null)).toBe(true);
    expect(settleStates.at(-1)).toEqual({ pending: false, recoveryReason: null });
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining(["project-data-invalidated", "dashboard-board-invalidated", "production-calendar-invalidated"]));
    expect(publish.mock.calls.find(([message]) => message.type === "production-calendar-invalidated")?.[0]).toMatchObject({ version: 1, type: "production-calendar-invalidated" });
    expect(publish.mock.calls.find(([message]) => message.type === "production-calendar-invalidated")?.[0]).not.toHaveProperty("projectId");
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "production-calendar")).toBe(false);
    runtime.dispose();
  });

  it("adopts a no-op without opening the settle gate or broadcasting", async () => {
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    const runtime = new ProjectQueryRuntime(client, "calendar-noop-tab");
    const publish = vi.spyOn(runtime, "publish");
    apiPutMock.mockResolvedValueOnce({ changed: false, current: { version: 3, deadline: { localCivil: "2026-08-12T09:00", instant: "2026-08-11T23:00:00.000Z" }, reminderOffsetsMinutes: [1440, 60] }, eventIntent: null, publicationIds: [] });
    await render(calendar, { onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await click("month-drop");
    await waitForMutation();
    expect(apiPutMock).toHaveBeenCalledOnce();
    expect(apiGetMock).toHaveBeenCalledOnce();
    expect(settleStates.every((state) => !state.pending)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-live]')?.textContent).toBe("No change.");
    runtime.dispose();
  });

  it("keeps a failed settle recoverable and clears it after Refresh", async () => {
    apiGetMock.mockReset()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new ApiError("Calendar unavailable", 400, {}))
      .mockResolvedValue(response());
    const settleStates: Array<{ pending: boolean; recoveryReason: string | null }> = [];
    await render(calendar, { onSettleStateChange: (state: { pending: boolean; recoveryReason: string | null }) => settleStates.push(state) });
    await click("month-drop");
    await waitForMutation();
    expect(settleStates.length).toBeGreaterThan(1);
    expect(document.querySelector('button[data-focus-key="calendar-recovery"]')).not.toBeNull();
    expect(document.querySelector('[aria-live]')?.textContent).toContain("latest Calendar could not be loaded");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[data-focus-key="calendar-recovery"]')!.click(); await Promise.resolve(); });
    await waitForMutation();
    expect(document.querySelector('button[data-focus-key="calendar-recovery"]')).toBeNull();
    expect(settleStates.at(-1)).toEqual({ pending: false, recoveryReason: null });
  });

  it("renders Deadline controls read-only for internal Editor and External Editor", async () => {
    for (const role of ["editor", "external_editor"] as const) {
      roleState.value = role;
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await render(calendar);
      expect(host.textContent).not.toContain("Move / Reschedule");
      expect(host.querySelector<HTMLElement>("[data-testid=calendar-surface]")?.dataset.editable).toBe("false");
      await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="month-drop"]')!.click(); await Promise.resolve(); });
      expect(apiPutMock).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); root = createRoot(host); });
    }
  });

  it.each([
    ["deadline_version_conflict", 409, true, true, "The Deadline changed elsewhere."],
    ["deadline_project_archived", 409, true, false, "This project was archived."],
    ["deadline_project_delivered", 409, true, false, "This project was delivered."],
    ["deadline_nonexistent_local_time", 400, false, true, "That time does not exist in Sydney"],
    ["deadline_repeated_local_time", 400, false, true, "That time occurs twice in Sydney"],
    ["deadline_invalid_reminder_offsets", 400, true, false, "The saved reminder offsets are no longer valid."],
    ["deadline_invalid_version", 400, true, false, "The source Deadline version is invalid."],
    ["deadline_invalid_local_time", 400, false, true, "That is not a valid Sydney time."],
    ["deadline_resolver_defect", 400, true, false, "Scheduling could not be resolved."],
    ["project_not_found", 404, true, false, "That project is no longer available."],
  ] as const)("rolls back, follows the refetch/draft arm, and never retries %s", async (code, status, refetch, retainDraft, announcement) => {
    if (refetch && (code === "deadline_project_archived" || code === "deadline_project_delivered" || code === "project_not_found")) {
      apiGetMock.mockReset().mockResolvedValueOnce(response()).mockResolvedValue(response({ canDrag: false }));
    }
    apiPutMock.mockRejectedValueOnce(new ApiError("deadline failed", status, { code, ...(code === "deadline_repeated_local_time" ? { choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }] } : {}) }));
    await render();
    await click("month-drop");
    await waitForMutation();
    expect(apiPutMock).toHaveBeenCalledOnce();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiGetMock).toHaveBeenCalledTimes(refetch ? 2 : 1);
    expect(document.querySelector('[aria-live]')?.textContent).toContain(announcement);
    if (retainDraft) {
      expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline date"]')?.value).toBe("2026-08-20");
      expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline time"]')?.value).toBe("09:00");
    }
    if (code === "deadline_repeated_local_time") expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    if (code === "deadline_project_archived" || code === "deadline_project_delivered" || code === "project_not_found") {
      expect(host.querySelector<HTMLElement>("[data-testid=calendar-surface]")?.dataset.editable).toBe("false");
    }
  });

  it.each([401, 403] as const)("purges Calendar and suppresses announcements on access loss %s", async (status) => {
    const onAccessLoss = vi.fn();
    apiPutMock.mockRejectedValueOnce(new ApiError("Forbidden", status, { code: "deadline_version_conflict" }));
    await render(calendar, { onAccessLoss });
    await click("month-drop");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(apiPutMock).toHaveBeenCalledOnce();
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-live]')?.textContent ?? "").not.toContain("12 Harbour Street");
  });
});
