/**
 * #221 PR B2 — the Dashboard Gantt's checklist (subtask) writes, end to end through the real
 * `ProductionGantt` → `useSchedulingController` → Gantt port → `lib/api` stack over a stubbed
 * `fetch`. Only the network is fake: the adapter, the vendor Gantt, the controller, the Undo module
 * and the toast store are all real.
 *
 * Pointer geometry: happy-dom lays nothing out, so every rect is stubbed to one 1440x40 box right
 * before a gesture (the same technique `components/reui/gantt/gantt-drop-warning.dom.test.tsx`
 * documents). Pointer-derived dates at month scale depend on that stub, so pointer cases assert the
 * request's shape and direction; the keyboard case (one Adjust step) asserts exact values.
 *
 * Guard F (`test-seam.guard.test.ts`): nothing here selects a vendor `data-slot`. Bars are found by
 * their accessible name, the ghost / hint / grip / announcer by `data-testid` / `aria-live`, timeline
 * rows by `data-gantt-resource`, the placement tile by its `aria-label`.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  adminProductionGanttResponseSchema,
  formatSydneyCivilMinute,
  PRODUCTION_GANTT_ZONE,
  shiftSydneyCalendarDate,
  type ChecklistScheduleDto,
  type ChecklistScheduleEndpointDto,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";
import { clearToasts } from "../lib/toast-store";
import { ToastViewport } from "./quincy/ToastViewport";
import { ProductionGantt } from "./ProductionGantt";

vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_STREET = "1 Writes Street";
const RANGE_ID = "22222222-2222-4222-8222-222222222222";
const RANGE_TITLE = "Edit hero set";
const DUE_ID = "33333333-3333-4333-8333-333333333333";
const DUE_TITLE = "Send preview";
const UNSCHED_ID = "44444444-4444-4444-8444-444444444444";
const UNSCHED_TITLE = "Place me";
const LOCKED_ID = "55555555-5555-4555-8555-555555555555";
const LOCKED_TITLE = "Locked placement";

const CONFLICT_TEXT = "The checklist schedule changed elsewhere. Reloaded the latest; no retry was made.";

/**
 * A civil date in the CURRENT Sydney month. `ProductionGantt` opens on today's month with no way
 * to override it, and a bar that crosses the view's edge is split into segments whose clipped edge
 * has no grip — so every fixture date sits well inside the month: day 10 + `offset`.
 */
function sydneyDay(offset: number): string {
  const monthStart = `${formatSydneyCivilMinute(Date.now()).slice(0, 7)}-10`;
  const shifted = shiftSydneyCalendarDate(monthStart, offset);
  if (!shifted.ok) throw new Error("fixture date did not shift");
  return shifted.value;
}

function dateEndpoint(localCivil: string): ChecklistScheduleEndpointDto {
  return { kind: "date", localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" };
}

type Row = {
  id: string;
  title: string;
  position: number;
  schedule: ChecklistScheduleDto;
  permissions: { canDrag: boolean; canResize: boolean; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
};

type ScheduleInput = { state: string; start?: { kind: string; localCivil: string }; end?: { kind: string; localCivil: string } };

/** The server's view of the checklist — PATCH mutates it, GET reads it. */
let rows: Row[];
let deadlineDay: string;

function resetFixture(options: { deadlineOffset?: number } = {}) {
  deadlineDay = sydneyDay(options.deadlineOffset ?? 6);
  const all = { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true };
  rows = [
    { id: RANGE_ID, title: RANGE_TITLE, position: 0, permissions: all, schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: dateEndpoint(sydneyDay(1)), end: dateEndpoint(sydneyDay(3)), due: sydneyDay(3) } },
    { id: DUE_ID, title: DUE_TITLE, position: 1, permissions: all, schedule: { state: "due_only", version: 1, zone: PRODUCTION_GANTT_ZONE, start: null, end: dateEndpoint(sydneyDay(2)), due: sydneyDay(2) } },
    { id: UNSCHED_ID, title: UNSCHED_TITLE, position: 2, permissions: all, schedule: { state: "unscheduled", version: 1, zone: PRODUCTION_GANTT_ZONE, start: null, end: null, due: null } },
    { id: LOCKED_ID, title: LOCKED_TITLE, position: 3, permissions: { ...all, canDrag: false, canResize: false }, schedule: { state: "unscheduled", version: 1, zone: PRODUCTION_GANTT_ZONE, start: null, end: null, due: null } },
  ];
}

function ganttResponse() {
  const shoot = sydneyDay(-1);
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: PROJECT_ID,
        street: PROJECT_STREET,
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "editing_autohdr",
        delivered: false,
        shootDate: shoot,
        shootDateCivil: shoot,
        createdAt: `${shoot}T00:00:00.000Z`,
        barStartDate: shoot,
        deadline: { at: `${deadlineDay}T05:00:00.000Z`, localCivil: `${deadlineDay}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
        deadlineVersion: 1,
        editors: [],
        checklist: { completed: 0, total: rows.length },
        permissions: { canEditDeadline: true, canEditChildren: true },
        children: {
          rows: rows.map((row) => ({ id: row.id, projectId: PROJECT_ID, title: row.title, done: false, position: row.position, assignee: null, schedule: row.schedule, permissions: row.permissions })),
          total: rows.length,
          returned: rows.length,
          truncated: false,
          nextCursor: null,
        },
      },
    ],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: rows.length + 1, drawCap: 2000, tooManyToDraw: false },
  });
}

function scheduleFromInput(input: ScheduleInput, version: number): ChecklistScheduleDto {
  const endpoint = (value: { localCivil: string } | undefined) => (value ? dateEndpoint(value.localCivil) : null);
  if (input.state === "unscheduled") return { state: "unscheduled", version, zone: PRODUCTION_GANTT_ZONE, start: null, end: null, due: null };
  const end = endpoint(input.end);
  return { state: input.state as "due_only" | "range", version, zone: PRODUCTION_GANTT_ZONE, start: input.state === "range" ? endpoint(input.start) : null, end, due: end?.localCivil ?? null };
}

type Request = { method: string; url: string; body: unknown };
type Reply = { status: number; body: unknown };

let requests: Request[];
/** Per-PATCH override; default echoes the requested schedule at expectedVersion + 1. */
let patchReply: ((body: { schedule: { expectedVersion: number; schedule: ScheduleInput } }, subtaskId: string) => Promise<Reply> | Reply) | null;
/** When set, GETs wait on it (to hold the controller's settle refetch open). */
let getGate: Promise<void> | null;

function echoPatch(body: { schedule: { expectedVersion: number; schedule: ScheduleInput } }, subtaskId: string): Reply {
  const row = rows.find((candidate) => candidate.id === subtaskId)!;
  const schedule = scheduleFromInput(body.schedule.schedule, body.schedule.expectedVersion + 1);
  row.schedule = schedule;
  return { status: 200, body: { id: row.id, title: row.title, done: false, assignee: null, position: row.position, schedule } };
}

function patches(): Request[] {
  return requests.filter((request) => request.method === "PATCH");
}

function gets(): Request[] {
  return requests.filter((request) => request.method === "GET" && request.url.startsWith("/api/production-gantt"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let onAcceptGateChange: ReturnType<typeof vi.fn<(blocked: boolean) => void>>;
let onSettleStateChange: ReturnType<typeof vi.fn<(state: CalendarSettleState) => void>>;
let onAccessLoss: ReturnType<typeof vi.fn<() => void>>;

function view(show = true): ReactNode {
  return (
    <QueryClientProvider client={client}>
      {show && (
        <ProductionGantt
          identity={identity}
          q=""
          filters={DEFAULT_GANTT_FACET_FILTERS}
          onFiltersChange={() => {}}
          onAcceptGateChange={onAcceptGateChange}
          onSettleStateChange={onSettleStateChange}
          onAccessLoss={onAccessLoss}
        />
      )}
      <ToastViewport />
    </QueryClientProvider>
  );
}

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(view());
    await Promise.resolve();
  });
  await flush();
}

async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

async function keydown(el: EventTarget, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
    await Promise.resolve();
  });
}

function stubGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect,
  );
}

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.getAttribute("aria-label")?.startsWith(title));
  if (!bar) throw new Error(`no bar found for ${title}`);
  return bar;
}

function barLabel(title: string): string {
  return findBar(title).getAttribute("aria-label") ?? "";
}

function liveRegionText(): string {
  return host.querySelector('[data-testid="production-gantt-live-region"]')?.textContent ?? "";
}

function allLiveText(): string {
  return [...document.body.querySelectorAll('[aria-live="polite"]')].map((el) => el.textContent ?? "").join(" | ");
}

function undoButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="toast-action"]')];
}

function toasts(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-testid="toast"]')];
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

/**
 * Drags the range task's end grip to `clientX` and releases. A resize edge follows the pointer's
 * ABSOLUTE position on the (stubbed, 1440px) axis, so 1400 lands near the view's far end — well
 * after the fixture's end date and deadline.
 */
async function resizeRangeEnd(clientX: number, pointerId: number, options: { release?: boolean } = {}) {
  stubGeometry();
  const grip = host.querySelector<HTMLElement>('[data-testid="gantt-resize-handle-end"]');
  if (!grip) throw new Error("no end grip");
  await pointerEvent(grip, "pointerdown", { pointerId, button: 0, clientX: 300, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX, clientY: 10 });
  if (options.release !== false) await pointerEvent(window, "pointerup", { pointerId, clientX, clientY: 10 });
}

/** One keyboard Adjust step on the range task's END edge, committed with Enter. */
async function keyboardResizeRangeEnd() {
  const bar = findBar(RANGE_TITLE);
  await act(async () => {
    bar.focus();
    await Promise.resolve();
  });
  await keydown(bar, " ");
  await keydown(bar, "e");
  await keydown(bar, "ArrowRight");
  await keydown(bar, "Enter");
}

function patchBody(index = 0) {
  return patches()[index]!.body as { schedule: { expectedVersion: number; schedule: ScheduleInput } };
}

beforeEach(() => {
  resetFixture();
  requests = [];
  patchReply = null;
  getGate = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onAcceptGateChange = vi.fn<(blocked: boolean) => void>();
  onSettleStateChange = vi.fn<(state: CalendarSettleState) => void>();
  onAccessLoss = vi.fn<() => void>();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const json = (reply: Reply) => new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.startsWith("/api/production-gantt")) {
      if (getGate) await getGate;
      return json({ status: 200, body: ganttResponse() });
    }
    const subtask = /^\/api\/projects\/[^/]+\/subtasks\/([^/?]+)$/.exec(url);
    if (method === "PATCH" && subtask) {
      const subtaskId = decodeURIComponent(subtask[1]!);
      return json(await (patchReply ?? echoPatch)(body, subtaskId));
    }
    return json({ status: 404, body: { error: `unexpected ${method} ${url}` } });
  }));
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  host.remove();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProductionGantt — checklist writes (#221 PR B2)", () => {
  it("1. a pointer resize-end of a range task sends one PATCH, shows the new end before the response, then the server value", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    const held = deferred<Reply>();
    patchReply = async (body, subtaskId) => {
      await held.promise;
      return echoPatch(body, subtaskId);
    };

    await resizeRangeEnd(1400, 31);
    await flush(2);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${RANGE_ID}`);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    expect(body.schedule.schedule.state).toBe("range");
    expect(body.schedule.schedule.start).toEqual({ kind: "date", localCivil: sydneyDay(1) });
    expect(body.schedule.schedule.end!.kind).toBe("date");
    expect(body.schedule.schedule.end!.localCivil > sydneyDay(3)).toBe(true);
    const pendingLabel = barLabel(RANGE_TITLE);
    expect(pendingLabel).not.toBe(before);

    held.resolve({ status: 200, body: null });
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(barLabel(RANGE_TITLE)).toBe(pendingLabel);
    expect(rows.find((row) => row.id === RANGE_ID)!.schedule.version).toBe(2);
    expect(liveRegionText()).not.toMatch(/rejected/i);
  });

  it("2. a pointer move of a due_only milestone sends one due_only PATCH", async () => {
    await render();
    stubGeometry();
    const bar = findBar(DUE_TITLE);
    await pointerEvent(bar, "pointerdown", { pointerId: 32, button: 0, clientX: 100, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 32, clientX: 300, clientY: 10 });
    await pointerEvent(window, "pointerup", { pointerId: 32, clientX: 300, clientY: 10 });
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${DUE_ID}`);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    expect(body.schedule.schedule.state).toBe("due_only");
    expect(body.schedule.schedule.end!.localCivil > sydneyDay(2)).toBe(true);
  });

  it("3. a 409 conflict rolls the bar back, announces the conflict and never retries", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    patchReply = () => ({ status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict" } });

    await resizeRangeEnd(1400, 33);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(barLabel(RANGE_TITLE)).toBe(before);
    expect(liveRegionText()).toBe(CONFLICT_TEXT);
    expect(undoButtons()).toHaveLength(0);
  });

  it("4. Undo: the toast's Undo sends one PATCH at the new version, then refetches", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    await keyboardResizeRangeEnd();
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(undoButtons()).toHaveLength(1);
    expect(undoButtons()[0]!.textContent).toBe("Undo");
    expect(toasts()[0]!.textContent).toContain("Schedule saved.");

    const getsBefore = gets().length;
    await click(undoButtons()[0]!);
    await flush(6);

    expect(patches()).toHaveLength(2);
    const undo = patchBody(1);
    expect(undo.schedule.expectedVersion).toBe(2);
    expect(undo.schedule.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: sydneyDay(1) }, end: { kind: "date", localCivil: sydneyDay(3) } });
    expect(gets().length).toBeGreaterThan(getsBefore);
    expect(barLabel(RANGE_TITLE)).toBe(before);
    expect(liveRegionText()).toBe("Change undone.");
  });

  it("5. one live Undo: a second save replaces the first toast, and the remaining Undo targets the latest version", async () => {
    await render();
    await keyboardResizeRangeEnd();
    await flush(6);
    await keyboardResizeRangeEnd();
    await flush(6);

    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(2);
    expect(undoButtons()).toHaveLength(1);

    await click(undoButtons()[0]!);
    await flush(6);
    expect(patches()).toHaveLength(3);
    expect(patchBody(2).schedule.expectedVersion).toBe(3);
  });

  it("6. a double-clicked Undo sends exactly one request", async () => {
    await render();
    await keyboardResizeRangeEnd();
    await flush(6);
    const undo = undoButtons()[0]!;
    await act(async () => {
      undo.click();
      undo.click();
      await Promise.resolve();
    });
    await flush(6);
    expect(patches()).toHaveLength(2);
  });

  it("7. a warned drag shows the caution ghost and reason, still saves, and the toast is caution-toned with the reason", async () => {
    resetFixture({ deadlineOffset: 3 });
    await render();

    await resizeRangeEnd(1400, 37, { release: false });
    const ghost = host.querySelector<HTMLElement>('[data-testid="gantt-drag-ghost"]');
    expect(ghost).not.toBeNull();
    expect(ghost!.hasAttribute("data-drop-warning")).toBe(true);
    expect(document.body.querySelector('[data-testid="gantt-drop-warning-hint"]')?.textContent).toBe("Ends after the project deadline.");
    await pointerEvent(window, "pointerup", { pointerId: 37, clientX: 1400, clientY: 10 });
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.getAttribute("data-tone")).toBe("caution");
    expect(toasts()[0]!.textContent).toContain("Schedule saved. Ends after the project deadline.");
  });

  it("8. a keyboard Adjust commit sends the PATCH, never announces rejected, and keeps focus on the bar", async () => {
    await render();
    await keyboardResizeRangeEnd();
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: sydneyDay(1) }, end: { kind: "date", localCivil: sydneyDay(4) } });
    expect(allLiveText()).not.toMatch(/rejected/i);
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
    await flush(6);
    expect(allLiveText()).not.toMatch(/rejected/i);
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
  });

  it("9. unmounting mid-save releases the Dashboard gate and dismisses the live Undo toast", async () => {
    await render();
    await keyboardResizeRangeEnd();
    await flush(6);
    expect(undoButtons()).toHaveLength(1);

    patchReply = () => new Promise<Reply>(() => {});
    await keyboardResizeRangeEnd();
    await flush(2);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      root.render(view(false));
      await Promise.resolve();
    });
    await flush(2);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(undoButtons()).toHaveLength(0);
  });

  it("10. a 401 from the mutation reports access loss exactly once", async () => {
    await render();
    patchReply = () => ({ status: 401, body: { error: "unauthorized" } });
    await keyboardResizeRangeEnd();
    await flush(6);
    expect(onAccessLoss).toHaveBeenCalledTimes(1);
    expect(undoButtons()).toHaveLength(0);
  });

  it("11. placement: a draggable unscheduled row offers the tile and a click places it; a locked row offers nothing", async () => {
    await render();
    stubGeometry();
    const hintTile = () => [...host.querySelectorAll("button")].find((el) => el.getAttribute("aria-label") === "Click or drag to add a schedule");

    const lockedRow = host.querySelector<HTMLElement>(`[data-gantt-resource="task:${LOCKED_ID}"]`);
    expect(lockedRow).not.toBeNull();
    await pointerEvent(lockedRow!, "pointermove", { pointerId: 40, pointerType: "mouse", clientX: 400, clientY: 10 });
    expect(hintTile()).toBeUndefined();
    await click(lockedRow!);
    await flush(2);
    expect(patches()).toHaveLength(0);

    const row = host.querySelector<HTMLElement>(`[data-gantt-resource="task:${UNSCHED_ID}"]`);
    expect(row).not.toBeNull();
    await pointerEvent(row!, "pointermove", { pointerId: 41, pointerType: "mouse", clientX: 400, clientY: 10 });
    expect(hintTile()).toBeDefined();
    await click(row!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${UNSCHED_ID}`);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    expect(body.schedule.schedule.state).toBe("due_only");
    expect(body.schedule.schedule.end!.kind).toBe("date");
  });

  it("12. project bars stay read-only in B2: no key shortcuts, no resize grip", async () => {
    await render();
    const projectBar = findBar(PROJECT_STREET);
    expect(projectBar.getAttribute("aria-keyshortcuts")).toBeNull();
    const projectRow = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"]`);
    expect(projectRow).not.toBeNull();
    expect(projectRow!.querySelector('[data-testid="gantt-resize-handle-end"]')).toBeNull();
    expect(projectRow!.querySelector('[data-testid="gantt-resize-handle-start"]')).toBeNull();
    // The writable task bar does advertise its keyboard contract.
    expect(findBar(RANGE_TITLE).getAttribute("aria-keyshortcuts")).not.toBeNull();
  });

  it("13. interactions are off while the post-save refetch is pending: no drag starts", async () => {
    await render();
    const gate = deferred<void>();
    getGate = gate.promise;
    await keyboardResizeRangeEnd();
    await flush(4);
    expect(patches()).toHaveLength(1);
    expect(onSettleStateChange).toHaveBeenLastCalledWith({ pending: true, recoveryReason: null });

    expect(findBar(DUE_TITLE).getAttribute("aria-keyshortcuts")).toBeNull();
    stubGeometry();
    const bar = findBar(DUE_TITLE);
    await pointerEvent(bar, "pointerdown", { pointerId: 42, button: 0, clientX: 100, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 42, clientX: 300, clientY: 10 });
    expect(host.querySelector('[data-testid="gantt-drag-ghost"]')).toBeNull();
    await pointerEvent(window, "pointerup", { pointerId: 42, clientX: 300, clientY: 10 });
    await flush(2);
    expect(patches()).toHaveLength(1);

    getGate = null;
    gate.resolve();
    await flush(6);
    expect(onSettleStateChange).toHaveBeenLastCalledWith({ pending: false, recoveryReason: null });
  });

  it("never passes onEventsChange: a deferred commit leaves the vendor's own events untouched until the server answers", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    patchReply = () => ({ status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict" } });
    await keyboardResizeRangeEnd();
    await flush(6);
    // Had the vendor applied the change itself (onEventsChange / a truthy onEventUpdate), the bar
    // would keep the rejected range after the controller's rollback.
    expect(barLabel(RANGE_TITLE)).toBe(before);
  });
});
