/**
 * #222 step 9 — accepted-snapshot / gate / settle reconciliation through the event-calendar
 * renderer, ported from `ProductionCalendar-reconciliation.dom.test.tsx` (7). Happy-dom proves
 * accepted-snapshot and gate state, query coalescing and callback wiring only — not drag geometry,
 * focus timing or assistive-technology delivery.
 *
 * The fake vendor nav has no Prev button; navigation is driven through the controlled
 * `onDateChange` the real nav calls.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardCalendarState } from "@quincy/shared";
import { createProductionCalendarInvalidatedMessage, ProjectQueryRuntime } from "../lib/project-query-sync";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { deadlineEvent, deadlineSaveBody, instantOf, PROJECT_ID, PROJECT_STREET, rangeResponse } from "../testing/production-calendar-fixtures";
import {
  calendarState,
  clickTestId,
  createHarness,
  flush,
  json,
  liveRegion,
  mainRangeQuery,
  openReschedule,
  proposeUpdate,
  stubCalendarFetch,
  type Harness,
  type SurfaceProps,
} from "../testing/production-event-calendar-harness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const ID = `project-deadline:${PROJECT_ID}`;
const source = (civil = "2026-08-12T09:00") => deadlineEvent(civil, { version: 3 });
const response = (civil?: string) => rangeResponse({ events: [source(civil)] });
const drop = () => proposeUpdate(ID, { start: new Date(instantOf("2026-08-20T09:00")), allDay: false, granularity: "day" });
const civil = () => (eventCalendarFake.event(ID)?.data as { dto: { deadlineLocalCivil: string } } | undefined)?.dto.deadlineLocalCivil;
type SettleState = { pending: boolean; recoveryReason: string | null };

let h: Harness;
beforeEach(() => { h = createHarness(); });
afterEach(() => { h.teardown(); });

type Handler = (url: string, body: unknown) => Response | Promise<Response>;
/** `main` answers the Nth (1-based) main-range GET; the Up next query always gets `response()`. */
function stub(main: (n: number) => Response | Promise<Response> = () => json(response()), put: Handler = () => json(deadlineSaveBody("2026-08-20T09:00", 4))) {
  let n = 0;
  return stubCalendarFetch({ range: (url) => url.includes("bounds=1") ? main((n += 1)) : json(response()), put });
}

async function render(props: SurfaceProps = {}, calendar: DashboardCalendarState = calendarState()) {
  await h.render(calendar, props);
}

describe("ProductionEventCalendar reconciliation", () => {
  it("defers accepted data during confirmation and coalesces invalidations into one post-gate refetch", async () => {
    const fetch = stub();
    await render();
    await drop();
    expect(civil()).toBe("2026-08-12T09:00");
    const key = mainRangeQuery(h.client).queryKey;
    h.client.setQueryData(key, response("2026-08-20T09:00"));
    h.client.setQueryData(key, response("2026-08-21T09:00"));
    await flush(10);
    expect(civil()).toBe("2026-08-12T09:00");
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(20);
    expect(fetch.rangeGets()).toHaveLength(2);
  });

  it("clears the accept gate before settling, keeps navigation available while commands settle, and accepts one authoritative response", async () => {
    let release!: () => void;
    stub((n) => n === 1 ? json(response()) : new Promise<Response>((resolve) => { release = () => resolve(json(response("2026-08-20T09:00"))); }));
    const settle: SettleState[] = [];
    const gate: boolean[] = [];
    const onNavigate = vi.fn();
    await render({ onNavigate, onAcceptGateChange: (blocked) => gate.push(blocked), onSettleStateChange: (state) => settle.push(state) });
    await drop();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(eventCalendarFake.event(ID)?.draggable).toBe(false);
    expect(h.host.querySelector("[data-drag-source]")).toBeNull();
    expect(gate.at(-1)).toBe(false);
    await act(async () => { (eventCalendarFake.lastProps?.onDateChange as (date: Date) => void)(new Date(instantOf("2026-07-12T12:00"))); await Promise.resolve(); });
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-07-12" }));
    expect(settle.some((state) => state.pending && state.recoveryReason === null)).toBe(true);

    release();
    await flush(20);
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
    const afterWinner = settle.slice(settle.findIndex((state) => state.pending));
    expect(afterWinner.filter((state) => !state.pending && state.recoveryReason === null)).toHaveLength(1);
  });

  it("refuses navigation while a confirmation holds the accept gate", async () => {
    stub();
    const onNavigate = vi.fn();
    await render({ onNavigate });
    await drop();
    await act(async () => { (eventCalendarFake.lastProps?.onDateChange as (date: Date) => void)(new Date(instantOf("2026-07-12T12:00"))); await Promise.resolve(); });
    expect(onNavigate).not.toHaveBeenCalled();
    await clickTestId("gantt-deadline-confirm-cancel");
    await flush(10);
  });

  it("clears recovery after a later automatic authoritative acceptance without Refresh", async () => {
    const fetch = stub((n) => n === 2 ? json({ message: "Calendar unavailable" }, 400) : json(response(n >= 3 ? "2026-08-20T09:00" : undefined)));
    const settle: SettleState[] = [];
    await render({ onSettleStateChange: (state) => settle.push(state) });
    await drop();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(50);
    expect(settle.some((state) => state.pending && state.recoveryReason === "The latest Calendar could not be loaded.")).toBe(true);
    expect(h.host.querySelector('button[data-focus-key="calendar-recovery"]')).not.toBeNull();
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).toBeNull();

    await act(async () => { await h.client.refetchQueries({ queryKey: mainRangeQuery(h.client).queryKey }); await new Promise((resolve) => setTimeout(resolve, 20)); await Promise.resolve(); });
    await flush(10);
    expect(fetch.rangeGets()).toHaveLength(3);
    expect(h.host.querySelector('button[data-focus-key="calendar-recovery"]')).toBeNull();
    expect(settle.at(-1)).toEqual({ pending: false, recoveryReason: null });
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).not.toBeNull();
  });

  it("preserves an active confirmation across a semantically equal Calendar rerender but resets on a real route change", async () => {
    const fetch = stub();
    await render();
    await drop();
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')).not.toBeNull();
    const base = calendarState();
    await h.rerender({ ...base, layers: [...base.layers], editorIds: [...base.editorIds], stageKeys: [...base.stageKeys] });
    await flush(5);
    expect(fetch.puts()).toHaveLength(0);
    await clickTestId("gantt-deadline-confirm-action");
    await flush(50);
    expect(fetch.puts()).toHaveLength(1);

    await drop();
    expect(document.querySelector('[data-testid="gantt-deadline-confirm"]')).not.toBeNull();
    await h.rerender({ ...base, date: "2026-08-13", layers: [...base.layers], editorIds: [...base.editorIds], stageKeys: [...base.stageKeys] });
    await flush(200);
    expect(document.querySelector('[data-testid="gantt-deadline-confirm-action"]')).toBeNull();
    expect(fetch.puts()).toHaveLength(1);
  });

  it("wins with access loss mid-mutation, clears the overlay/gate, and suppresses private late copy", async () => {
    const onAccessLoss = vi.fn();
    stub(undefined, () => json({ code: "forbidden", message: "Forbidden" }, 403));
    await render({ onAccessLoss });
    await drop();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(liveRegion()).not.toContain(PROJECT_STREET);
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).toBeNull();
  });

  it("purges accepted private data after an observer-originated authorization error", async () => {
    const onAccessLoss = vi.fn();
    stub((n) => n === 1 ? json(response()) : json({ code: "forbidden", message: "Forbidden" }, 403));
    await render({ onAccessLoss });
    await act(async () => { await h.client.refetchQueries({ queryKey: mainRangeQuery(h.client).queryKey }); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    await flush(5);
    expect(onAccessLoss).toHaveBeenCalledOnce();
    expect(h.host.querySelector('[data-testid="event-calendar-fake"]')).toBeNull();
    expect(liveRegion()).not.toContain(PROJECT_STREET);
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
    const fetch = stub();
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const runtime = new ProjectQueryRuntime(h.client, "event-calendar-runtime");
    const sender = new ProjectQueryRuntime(new QueryClient(), "other-tab");
    runtime.start(); sender.start();
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(h.client, "invalidateQueries");

    await render({ runtime });
    await drop();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(100);
    expect(fetch.puts()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(4);
    const message = publish.mock.calls.find(([candidate]) => candidate.type === "production-calendar-invalidated")?.[0];
    if (!message) throw new Error("Calendar invalidation was not published");
    expect(Object.keys(message).sort()).toEqual(["committedAt", "type", "version"]);

    const getsBefore = fetch.rangeGets().length;
    const invalidateCount = invalidate.mock.calls.length;
    sender.publish(createProductionCalendarInvalidatedMessage());
    await flush(25);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(fetch.rangeGets().length - getsBefore).toBe(1);
    const received = invalidate.mock.calls.slice(invalidateCount);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.every(([options]) => options?.queryKey?.[0] === "production-calendar" && options?.queryKey?.[1] === PROJECT_ID)).toBe(true);
    runtime.dispose(); sender.dispose();
  });

  it("hides the Reschedule action while a command settles", async () => {
    let release!: () => void;
    stub((n) => n === 1 ? json(response()) : new Promise<Response>((resolve) => { release = () => resolve(json(response("2026-08-20T09:00"))); }));
    await render();
    await openReschedule(ID);
    await clickTestId("event-calendar-move-cancel");
    await flush(5);
    await drop();
    await clickTestId("gantt-deadline-confirm-action");
    await flush(10);
    await act(async () => { eventCalendarFake.click(ID); await Promise.resolve(); });
    expect(h.host.querySelector(`[data-focus-key="calendar-move:${ID}"]`)).toBeNull();
    release();
    await flush(20);
  });
});
