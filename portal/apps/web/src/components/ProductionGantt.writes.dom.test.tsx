/**
 * #221 PR B2 + PR C — the Dashboard Gantt's checklist (subtask) writes and (PR C, the last
 * `describe`) project Deadline writes through the confirmation dialog, end to end through the real
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
import { setMoveDialogDeadline } from "@/testing/date-time-popup";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  adminProductionGanttResponseSchema,
  formatSydneyCivilMinute,
  PRODUCTION_GANTT_ZONE,
  resolveSydneyCivilMinute,
  shiftSydneyCalendarDate,
  type ChecklistScheduleDto,
  type ChecklistScheduleEndpointDto,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";
import { clearToasts } from "../lib/toast-store";
import { ProjectQueryRuntime } from "../lib/project-query-sync";
import { ToastViewport } from "./quincy/ToastViewport";
import { ProductionGantt } from "./ProductionGantt";
import { endMoment, startMoment, subtaskReminders } from "@/testing/subtask-schedule";

vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

/**
 * #344 fix round 2: a per-test draw cap, so the cap boundary can be exercised with the fixture's own
 * few rows. `null` (every other test) is the real `PRODUCTION_GANTT_DRAW_CAP`. The adapter reads the
 * binding at use time, so the getter is consulted on every model build.
 */
const drawCap = vi.hoisted(() => ({ override: null as number | null }));
vi.mock("@quincy/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quincy/shared")>();
  return {
    ...actual,
    get PRODUCTION_GANTT_DRAW_CAP() {
      return drawCap.override ?? actual.PRODUCTION_GANTT_DRAW_CAP;
    },
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_STREET = "1 Writes Street";
/** A second, Deadline-less project — only in the fixture when `secondNoDeadlineProject` is set. */
const SECOND_PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_PROJECT_STREET = "2 Other Street";
const RANGE_ID = "22222222-2222-4222-8222-222222222222";
const RANGE_TITLE = "Edit hero set";
const DUE_ID = "33333333-3333-4333-8333-333333333333";
const DUE_TITLE = "Send preview";

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

type Row = {
  id: string;
  title: string;
  position: number;
  schedule: ChecklistScheduleDto;
  permissions: { canDrag: boolean; canResize: boolean; canOpenScheduleEditor: boolean; canEditAssignees: boolean };
};

type ScheduleInput = { state: string; start?: { localCivil: string; disambiguation?: "earlier" | "later" }; end?: { localCivil: string; disambiguation?: "earlier" | "later" } };

/** The server's view of the checklist — PATCH mutates it, GET reads it. */
let rows: Row[];
let deadlineDay: string;
/** The server's view of the project Deadline — PUT mutates it, GET reads it. */
let deadline: { localCivil: string; at: string } | null;
let deadlineVersion: number;
let canEditDeadline: boolean;
/** When set, the project's checklist is truncated: `total` rows exist, only the fixture's are loaded. */
let truncatedTotal: number | null;
let secondNoDeadlineProject: boolean;
/** #344 — per-project `permissions.canEditChildren`, and rows the GET omits (as a filter would). */
let firstCanEditChildren: boolean;
let secondCanEditChildren: boolean;
let omittedFromGet: Set<string>;

function atFor(localCivil: string): string {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`fixture civil did not resolve: ${localCivil}`);
  return resolved.value.instant;
}

function resetFixture(options: { deadlineOffset?: number; noDeadline?: boolean; canEditDeadline?: boolean; truncatedTotal?: number; secondNoDeadlineProject?: boolean; firstCanEditChildren?: boolean; secondCanEditChildren?: boolean } = {}) {
  deadlineDay = sydneyDay(options.deadlineOffset ?? 6);
  deadline = options.noDeadline ? null : { localCivil: `${deadlineDay}T15:00`, at: atFor(`${deadlineDay}T15:00`) };
  deadlineVersion = 1;
  canEditDeadline = options.canEditDeadline ?? true;
  truncatedTotal = options.truncatedTotal ?? null;
  secondNoDeadlineProject = options.secondNoDeadlineProject ?? false;
  firstCanEditChildren = options.firstCanEditChildren ?? true;
  secondCanEditChildren = options.secondCanEditChildren ?? true;
  omittedFromGet = new Set();
  const all = { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true };
  rows = [
    { id: RANGE_ID, title: RANGE_TITLE, position: 0, permissions: all, schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(sydneyDay(1)), end: endMoment(sydneyDay(3)), due: sydneyDay(3) } },
    { id: DUE_ID, title: DUE_TITLE, position: 1, permissions: all, schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(sydneyDay(2)), end: endMoment(sydneyDay(2)), due: sydneyDay(2) } },
  ];
}

function ganttResponse() {
  const shoot = sydneyDay(-1);
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: PROJECT_ID,
        street: PROJECT_STREET,
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "editing_autohdr",
        delivered: false,
        archived: false,
        shootDate: shoot,
        shootDateCivil: shoot,
        createdAt: `${shoot}T00:00:00.000Z`,
        barStartDate: shoot,
        deadline: deadline ? { at: deadline.at, localCivil: deadline.localCivil, version: deadlineVersion, reminderOffsetsMinutes: [], overdue: false } : null,
        deadlineVersion,
        editors: [],
        checklist: { completed: 0, total: truncatedTotal ?? rows.length },
        // #365: the People column's data, so the writes below run with the Team / Due triggers mounted.
        team: [{ id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", roleLabel: "Editor", isExternal: false, active: true, roleOnProject: "editor" }],
        permissions: { canEditDeadline, canEditChildren: firstCanEditChildren, canEditTeam: true },
        children: {
          rows: rows.filter((row) => !omittedFromGet.has(row.id)).map((row) => ({ id: row.id, projectId: PROJECT_ID, title: row.title, done: false, position: row.position, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0, schedule: row.schedule, reminders: subtaskReminders(), permissions: row.permissions })),
          total: truncatedTotal ?? rows.length,
          returned: rows.length,
          truncated: truncatedTotal !== null,
          nextCursor: truncatedTotal !== null ? "cursor-2" : null,
        },
      },
      ...(secondNoDeadlineProject
        ? [{
            id: SECOND_PROJECT_ID,
            street: SECOND_PROJECT_STREET,
            suburb: null,
            agencyName: null,
            agentName: null,
            stageKey: "editing_autohdr",
            delivered: false,
            archived: false,
            shootDate: shoot,
            shootDateCivil: shoot,
            createdAt: `${shoot}T00:00:00.000Z`,
            barStartDate: shoot,
            deadline: null,
            deadlineVersion: 1,
            editors: [],
            checklist: { completed: 0, total: 0 },
            permissions: { canEditDeadline, canEditChildren: secondCanEditChildren },
            children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
          }]
        : []),
    ],
    page: { limit: 100, returned: secondNoDeadlineProject ? 2 : 1, nextCursor: null },
    density: { matchedProjects: secondNoDeadlineProject ? 2 : 1, matchedRows: rows.length + (secondNoDeadlineProject ? 2 : 1), drawCap: 2000, tooManyToDraw: false },
  });
}

/** A stored timed endpoint; `disambiguation` picks a side of the April fold. */
function timedEndpoint(localCivil: string, disambiguation?: "earlier" | "later"): ChecklistScheduleEndpointDto {
  const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (!resolved.ok) throw new Error(`fixture civil did not resolve: ${localCivil}`);
  return { localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" };
}

function scheduleFromInput(input: ScheduleInput, version: number): ChecklistScheduleDto {
  const endpoint = (value: ScheduleInput["end"]) => (value ? timedEndpoint(value.localCivil, value.disambiguation) : null);
  const start = endpoint(input.start);
  const end = endpoint(input.end);
  if (!start || !end) throw new Error("fixture: a range PATCH must carry both endpoints");
  return { state: "range", version, zone: PRODUCTION_GANTT_ZONE, start, end, due: end.localCivil };
}

type Request = { method: string; url: string; body: unknown };
type Reply = { status: number; body: unknown };

let requests: Request[];
/** Per-PATCH override; default echoes the requested schedule at expectedVersion + 1. */
let patchReply: ((body: { schedule: { expectedVersion: number; schedule: ScheduleInput } }, subtaskId: string) => Promise<Reply> | Reply) | null;
/** When set, GETs wait on it (to hold the controller's settle refetch open). */
let getGate: Promise<void> | null;
/** When set, a truncated project's continuation page answers with this once it resolves (else held forever). */
let childPageReply: Promise<Reply> | null;
/** #344: per-request continuation page answer (wins over `childPageReply`). */
let childPageHandler: (() => Promise<Reply>) | null;
/** #344: a Gantt GET whose body is taken when the request ARRIVES, then held until this resolves. */
let getHeldAtRequest: Promise<void> | null;

function echoPatch(body: { schedule: { expectedVersion: number; schedule: ScheduleInput } }, subtaskId: string): Reply {
  const row = rows.find((candidate) => candidate.id === subtaskId)!;
  const schedule = scheduleFromInput(body.schedule.schedule, body.schedule.expectedVersion + 1);
  row.schedule = schedule;
  return { status: 200, body: { id: row.id, title: row.title, done: false, position: row.position, schedule } };
}

const CREATED_ID = "77777777-7777-4777-8777-777777777777";
const CREATED_TITLE = "Cull selects";
/** Per-POST override; default creates a range Subtask with the Project's default range (server-applied). */
let createReply: ((body: { title: string }, projectId: string) => Promise<Reply> | Reply) | null;

function echoCreate(body: { title: string }, projectId: string): Reply {
  const schedule: ChecklistScheduleDto = { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(sydneyDay(4)), end: endMoment(sydneyDay(6)), due: sydneyDay(6) };
  if (projectId === PROJECT_ID) {
    rows.push({ id: CREATED_ID, title: body.title, position: 4, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true }, schedule });
  }
  return { status: 201, body: { id: CREATED_ID, title: body.title, done: false, assignmentVersion: 1, position: 4, dueDate: schedule.due, schedule, reminders: subtaskReminders(), createdBy: "user-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
}

function posts(): Request[] {
  return requests.filter((request) => request.method === "POST");
}

function patches(): Request[] {
  return requests.filter((request) => request.method === "PATCH");
}

function puts(): Request[] {
  return requests.filter((request) => request.method === "PUT");
}

type DeadlinePut = { expectedVersion: number; deadline: { localCivil: string } | null; reminderOffsetsMinutes?: number[] };

function putBody(index = 0): DeadlinePut {
  return puts()[index]!.body as DeadlinePut;
}

/** Applies a Deadline PUT to the fixture (versioned), answering like `PUT /api/projects/:id/deadline`. */
function applyDeadlinePut(body: DeadlinePut): Reply {
  if (body.expectedVersion !== deadlineVersion) return { status: 409, body: { error: "conflict", code: "deadline_version_conflict" } };
  deadlineVersion += 1;
  deadline = body.deadline ? { localCivil: body.deadline.localCivil, at: atFor(body.deadline.localCivil) } : null;
  return {
    status: 200,
    body: {
      changed: true,
      current: { version: deadlineVersion, deadline: deadline ? { localCivil: deadline.localCivil, instant: deadline.at } : null, reminderOffsetsMinutes: body.reminderOffsetsMinutes ?? [] },
      eventIntent: null,
      publicationIds: [],
    },
  };
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
let onOpenProjectProp: ((projectId: string) => void) | undefined;

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
          onOpenProject={onOpenProjectProp}
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
async function resizeRangeEnd(clientX: number, pointerId: number, options: { release?: boolean; taskId?: string } = {}) {
  stubGeometry();
  const grip = host.querySelector<HTMLElement>(`[data-gantt-resource="task:${options.taskId ?? RANGE_ID}"] [data-testid="gantt-resize-handle-end"]`);
  if (!grip) throw new Error("no end grip");
  await pointerEvent(grip, "pointerdown", { pointerId, button: 0, clientX: 300, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX, clientY: 10 });
  if (options.release !== false) await pointerEvent(window, "pointerup", { pointerId, clientX, clientY: 10 });
}

/** Drags the range task's START grip to `clientX` (absolute on the stubbed 1440px axis) and releases. */
async function resizeRangeStart(clientX: number, pointerId: number) {
  stubGeometry();
  const grip = host.querySelector<HTMLElement>(`[data-gantt-resource="task:${RANGE_ID}"] [data-testid="gantt-resize-handle-start"]`);
  if (!grip) throw new Error("no start grip");
  await pointerEvent(grip, "pointerdown", { pointerId, button: 0, clientX: 500, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX, clientY: 10 });
  await pointerEvent(window, "pointerup", { pointerId, clientX, clientY: 10 });
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

/** One keyboard Adjust MOVE step on the range task (Space enters on the move target), committed with Enter. */
async function keyboardMoveRange() {
  const bar = findBar(RANGE_TITLE);
  await act(async () => {
    bar.focus();
    await Promise.resolve();
  });
  await keydown(bar, " ");
  await keydown(bar, "ArrowRight");
  await keydown(bar, "Enter");
}

function patchBody(index = 0) {
  return patches()[index]!.body as { schedule: { expectedVersion: number; schedule: ScheduleInput } };
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function deadlineDialog(): HTMLElement | null {
  return byTestId("gantt-deadline-confirm");
}

/** Drags the project bar's END (Deadline) grip to `clientX`. */
async function resizeProjectEnd(clientX: number, pointerId: number, options: { release?: boolean } = {}) {
  stubGeometry();
  const grip = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"] [data-testid="gantt-resize-handle-end"]`);
  if (!grip) throw new Error("no project end grip");
  await pointerEvent(grip, "pointerdown", { pointerId, button: 0, clientX: 700, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX, clientY: 10 });
  if (options.release !== false) await pointerEvent(window, "pointerup", { pointerId, clientX, clientY: 10 });
}

/** The project's timeline bar (the tree panel's row toggle carries the bare street as its name). */
function projectBar(): HTMLButtonElement {
  const row = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"]`);
  const bar = row && [...row.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-label")?.startsWith(`${PROJECT_STREET},`));
  if (!bar) throw new Error("no project bar");
  return bar;
}

/** `steps` keyboard Adjust steps on the project bar's END edge (negative = earlier), then Enter. */
async function keyboardResizeProjectEnd(steps: number) {
  const bar = projectBar();
  await act(async () => {
    bar.focus();
    await Promise.resolve();
  });
  await keydown(bar, " ");
  await keydown(bar, "e");
  for (let index = 0; index < Math.abs(steps); index += 1) await keydown(bar, steps < 0 ? "ArrowLeft" : "ArrowRight");
  await keydown(bar, "Enter");
}

function deadlineActionButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-deadline-action"]')][0];
}

async function setInput(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

// The fixture days and the resize aims are anchored to the visible month, which the Gantt takes from
// `new Date()` in the runner's zone and the fixture from Sydney's clock. Pin `Date` (timers stay real)
// for every describe so none depends on the real date — near a month boundary the two disagree. The
// clock still advances from the pinned instant, because the code under test measures elapsed time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-15T02:00:00.000Z"));
  resetFixture();
  requests = [];
  patchReply = null;
  createReply = null;
  getGate = null;
  childPageReply = null;
  childPageHandler = null;
  getHeldAtRequest = null;
  drawCap.override = null;
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
    if (method === "GET" && url.startsWith("/api/production-gantt") && url.includes("childrenOf=")) {
      // A truncated project's continuation pages: held forever, so the project stays truncated.
      if (childPageHandler) return json(await childPageHandler());
      if (childPageReply) return json(await childPageReply);
      return new Promise<Response>(() => {});
    }
    if (method === "GET" && url.startsWith("/api/production-gantt")) {
      if (getHeldAtRequest) {
        const snapshot = ganttResponse();
        await getHeldAtRequest;
        return json({ status: 200, body: snapshot });
      }
      if (getGate) await getGate;
      return json({ status: 200, body: ganttResponse() });
    }
    const createMatch = /^\/api\/projects\/([^/]+)\/subtasks$/.exec(url);
    if (method === "POST" && createMatch) {
      return json(await (createReply ?? echoCreate)(body as { title: string }, decodeURIComponent(createMatch[1]!)));
    }
    const subtask = /^\/api\/projects\/[^/]+\/subtasks\/([^/?]+)$/.exec(url);
    if (method === "PATCH" && subtask) {
      const subtaskId = decodeURIComponent(subtask[1]!);
      return json(await (patchReply ?? echoPatch)(body, subtaskId));
    }
    if (method === "PUT" && url === `/api/projects/${PROJECT_ID}/deadline`) {
      return json(applyDeadlinePut(body as DeadlinePut));
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
  vi.useRealTimers();
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
    expect(body.schedule.schedule.start).toEqual({ localCivil: `${sydneyDay(1)}T09:00`, disambiguation: "earlier" });
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

  it("1b. a pointer resize-START of a range task sends one PATCH: the start moves, the end is unchanged", async () => {
    await render();
    await resizeRangeStart(40, 38);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${RANGE_ID}`);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    expect(body.schedule.schedule.state).toBe("range");
    expect(body.schedule.schedule.start!.localCivil < sydneyDay(1)).toBe(true);
    expect(body.schedule.schedule.end).toEqual({ localCivil: `${sydneyDay(3)}T17:00`, disambiguation: "earlier" });
    expect(liveRegionText()).not.toMatch(/rejected/i);
  });

  it("2. a pointer move of a one-day range sends one range PATCH", async () => {
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
    expect(body.schedule.schedule.state).toBe("range");
    expect(body.schedule.schedule.end!.localCivil > sydneyDay(2)).toBe(true);
  });

  it("2b. a permitted ONE-DAY range bar shows both grips, and resizing its end sends a range PATCH ending one day later", async () => {
    await render();
    const row = host.querySelector(`[data-gantt-resource="task:${DUE_ID}"]`);
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-testid="gantt-resize-handle-start"]')).not.toBeNull();
    expect(row!.querySelector('[data-testid="gantt-resize-handle-end"]')).not.toBeNull();

    // The stubbed 1440px axis spans the visible month, one equal cell per day: aim at the middle of
    // the cell one day after the task's day.
    const target = sydneyDay(3);
    const [year, month, day] = target.split("-").map(Number) as [number, number, number];
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    await resizeRangeEnd(((day - 0.5) / daysInMonth) * 1440, 39, { taskId: DUE_ID });
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${DUE_ID}`);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    expect(body.schedule.schedule.state).toBe("range");
    expect(body.schedule.schedule.start).toEqual({ localCivil: `${sydneyDay(2)}T09:00`, disambiguation: "earlier" });
    expect(body.schedule.schedule.end).toEqual({ localCivil: `${sydneyDay(3)}T17:00` });
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
    expect(undo.schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00`, disambiguation: "earlier" }, end: { localCivil: `${sydneyDay(3)}T17:00`, disambiguation: "earlier" } });
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
    // The toast is aria-hidden (`announcedElsewhere`): the controller's live region carries the warning.
    expect(liveRegionText()).toBe(`Saved the checklist schedule for ${PROJECT_STREET}. Warning: Ends after the project deadline.`);
  });

  it("8. a keyboard Adjust commit sends the PATCH, never announces rejected, and keeps focus on the bar", async () => {
    await render();
    await keyboardResizeRangeEnd();
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00`, disambiguation: "earlier" }, end: { localCivil: `${sydneyDay(4)}T17:00` } });
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

  it("12. a project bar the user may re-deadline offers only its END grip and advertises its keyboard contract (#221 PR C)", async () => {
    await render();
    expect(projectBar().getAttribute("aria-keyshortcuts")).not.toBeNull();
    const projectRow = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"]`);
    expect(projectRow).not.toBeNull();
    expect(projectRow!.querySelector('[data-testid="gantt-resize-handle-end"]')).not.toBeNull();
    expect(projectRow!.querySelector('[data-testid="gantt-resize-handle-start"]')).toBeNull();
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

  it("13b. the Team and Deadline triggers are disabled while the post-save refetch is pending (#365 T10)", async () => {
    await render();
    const team = () => host.querySelector<HTMLButtonElement>('[data-testid="gantt-team-trigger"]')!;
    const due = () => host.querySelector<HTMLButtonElement>('[data-testid="gantt-deadline-trigger"]')!;
    expect(team().disabled).toBe(false);
    expect(due().disabled).toBe(false);
    const gate = deferred<void>();
    getGate = gate.promise;
    await keyboardResizeRangeEnd();
    await flush(4);
    expect(onSettleStateChange).toHaveBeenLastCalledWith({ pending: true, recoveryReason: null });
    expect(team().disabled).toBe(true);
    expect(due().disabled).toBe(true);
    getGate = null;
    gate.resolve();
    await flush(6);
    expect(team().disabled).toBe(false);
    expect(due().disabled).toBe(false);
  });

  it("8b. a keyboard Adjust MOVE commit (the bar remounts under a new start) keeps focus on the moved bar", async () => {
    await render();
    await keyboardMoveRange();
    expect(patches()).toHaveLength(1);
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
    await flush(6);
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
  });

  it("8c. a keyboard Adjust MOVE answered 409: focus follows the bar through the revert", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    patchReply = () => ({ status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict" } });
    await keyboardMoveRange();
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
    await flush(6);
    expect(barLabel(RANGE_TITLE)).toBe(before);
    expect(document.activeElement).toBe(findBar(RANGE_TITLE));
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

describe("ProductionGantt — project Deadline writes (#221 PR C)", () => {
  const civil = (value: string) => value.replace("T", " ");

  it("1. a grip resize of the project end opens the confirmation with from → to and the affected items; Cancel writes nothing and restores the bar", async () => {
    await render();
    const original = projectBar().getAttribute("aria-label");
    // Far left: the vendor clamps the end to the day after the bar start (the shoot day).
    await resizeProjectEnd(450, 60);
    await flush(4);

    const dialog = deadlineDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Move Deadline");
    expect(dialog!.querySelector('[data-testid="gantt-deadline-confirm-description"]')!.textContent).toBe(PROJECT_STREET);
    expect(byTestId("calendar-move-confirmation")!.textContent).toContain(`${civil(`${deadlineDay}T15:00`)} → ${civil(`${sydneyDay(-1)}T15:00`)}`);
    const affected = [...document.body.querySelectorAll('[data-testid="gantt-deadline-confirm-affected"] [role="listitem"]')].map((item) => item.textContent);
    expect(affected).toEqual([`${RANGE_TITLE}now after the deadline`, `${DUE_TITLE}now after the deadline`]);
    expect(liveRegionText()).toMatch(/Confirmation required\.$/);
    expect(projectBar().getAttribute("aria-label")).not.toBe(original);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);

    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(4);

    expect(puts()).toHaveLength(0);
    expect(deadlineDialog()).toBeNull();
    expect(projectBar().getAttribute("aria-label")).toBe(original);
    expect(liveRegionText()).toBe(`Cancelled moving the Deadline for ${PROJECT_STREET}. It remains at ${civil(`${deadlineDay}T15:00`)}.`);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
  });

  it("2. Escape is the same as Cancel", async () => {
    await render();
    const original = projectBar().getAttribute("aria-label");
    await resizeProjectEnd(450, 61);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();

    await act(async () => {
      deadlineDialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush(4);

    expect(puts()).toHaveLength(0);
    expect(deadlineDialog()).toBeNull();
    expect(projectBar().getAttribute("aria-label")).toBe(original);
    expect(liveRegionText()).toMatch(/^Cancelled moving the Deadline/);
  });

  it("3. confirm sends one PUT at the Deadline's version; the Undo toast restores the old Deadline with one PUT", async () => {
    await render();
    await keyboardResizeProjectEnd(-2);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    expect(puts()).toHaveLength(0);

    await click(byTestId("gantt-deadline-confirm-action")!);
    await flush(6);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/deadline`);
    expect(putBody()).toEqual({ expectedVersion: 1, deadline: { localCivil: `${sydneyDay(4)}T15:00` }, reminderOffsetsMinutes: [] });
    expect(deadlineDialog()).toBeNull();
    expect(undoButtons()).toHaveLength(1);
    expect(toasts()[0]!.textContent).toContain("Deadline saved.");
    expect(liveRegionText()).toBe(`Moved the Deadline for ${PROJECT_STREET} to ${civil(`${sydneyDay(4)}T15:00`)}.`);

    await click(undoButtons()[0]!);
    await flush(6);

    expect(puts()).toHaveLength(2);
    expect(putBody(1)).toEqual({ expectedVersion: 2, deadline: { localCivil: `${deadlineDay}T15:00` }, reminderOffsetsMinutes: [] });
    expect(deadline?.localCivil).toBe(`${deadlineDay}T15:00`);
    expect(liveRegionText()).toBe("Change undone.");
  });

  it("3b. a grip resize (nothing focused) then Cancel returns focus to the project bar, not the page", async () => {
    await render();
    await resizeProjectEnd(450, 65);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(4);
    expect(deadlineDialog()).toBeNull();
    expect(document.activeElement).toBe(projectBar());
  });

  // Browser pass E (#221): focus still sat on a subtask bar from earlier keyboard work when the
  // Deadline grip was dragged (a grip pointerdown focuses nothing), and Cancel sent focus back to
  // that unrelated subtask bar instead of the project whose Deadline the dialog was about.
  it("3b2. a grip resize while another bar holds focus then Cancel returns focus to the project bar", async () => {
    await render();
    const other = findBar(RANGE_TITLE);
    await act(async () => { other.focus(); });
    expect(document.activeElement).toBe(other);
    await resizeProjectEnd(450, 68);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(4);
    expect(deadlineDialog()).toBeNull();
    expect(document.activeElement).toBe(projectBar());
  });

  it("3c. a grip resize then Escape returns focus to the project bar", async () => {
    await render();
    await resizeProjectEnd(450, 66);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    await act(async () => {
      deadlineDialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush(4);
    expect(deadlineDialog()).toBeNull();
    expect(document.activeElement).toBe(projectBar());
  });

  it("3d. a grip resize then Confirm returns focus to the project bar", async () => {
    await render();
    await resizeProjectEnd(450, 67);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    await click(byTestId("gantt-deadline-confirm-action")!);
    await flush(6);
    expect(puts()).toHaveLength(1);
    expect(deadlineDialog()).toBeNull();
    expect(document.activeElement).toBe(projectBar());
  });

  it("4. a truncated project's confirmation says how many checklist items the preview is based on", async () => {
    resetFixture({ truncatedTotal: 9 });
    await render();
    await resizeProjectEnd(450, 62);
    await flush(4);
    expect(byTestId("gantt-deadline-confirm-truncated")?.textContent).toBe("Based on 2 of 9 checklist items loaded.");
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(2);
    expect(puts()).toHaveLength(0);
  });

  it("5. a Deadline before the shoot date: the inverted bar offers Fix deadline, and the confirmation shows the clash", async () => {
    resetFixture({ deadlineOffset: -4 });
    await render();
    // The row's Deadline action carries the reason, so the attention badge is not rendered beside it.
    expect(host.querySelector(`[data-testid="gantt-row-attention-deadline_before_start"]`)).toBeNull();
    // Inverted bars stay read-only: no Deadline grip.
    expect(host.querySelector(`[data-gantt-resource="project:${PROJECT_ID}"] [data-testid="gantt-resize-handle-end"]`)).toBeNull();
    const fix = deadlineActionButton();
    expect(fix?.textContent).toBe("Fix deadline");
    expect(fix?.getAttribute("aria-label")).toBe(`Fix deadline for ${PROJECT_STREET}`);
    expect(fix?.getAttribute("title")).toBe("Deadline before shoot");
    expect(document.getElementById(fix!.getAttribute("aria-describedby")!)?.textContent).toBe("Deadline before shoot");

    await click(fix!);
    await flush(2);
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    await setMoveDialogDeadline({ day: sydneyDay(-3) });
    await click(byTestId("event-calendar-move-submit")!);
    await flush(4);

    expect(deadlineDialog()).not.toBeNull();
    expect(byTestId("gantt-deadline-confirm-clashes")!.textContent).toContain("Deadline before the shoot date.");
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(4);
    expect(puts()).toHaveLength(0);
  });

  it("6. Set deadline on a Deadline-not-set row → move dialog → confirmation → one PUT at deadlineVersion; Undo clears it", async () => {
    resetFixture({ noDeadline: true });
    await render();
    expect(host.querySelector(`[data-testid="gantt-row-attention-missing_deadline"]`)).toBeNull();
    const set = deadlineActionButton();
    expect(set?.textContent).toBe("Set deadline");
    expect(set?.getAttribute("title")).toBe("Deadline not set");
    expect(document.getElementById(set!.getAttribute("aria-describedby")!)?.textContent).toBe("Deadline not set");

    await click(set!);
    await flush(2);
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    await setMoveDialogDeadline({ day: sydneyDay(5) });
    await click(byTestId("event-calendar-move-submit")!);
    await flush(4);

    expect(deadlineDialog()).not.toBeNull();
    expect(deadlineDialog()!.textContent).toContain("Schedule Deadline");
    expect(deadlineDialog()!.querySelector('[data-testid="gantt-deadline-confirm-description"]')!.textContent).toBe(PROJECT_STREET);
    expect(puts()).toHaveLength(0);
    await click(byTestId("gantt-deadline-confirm-action")!);
    await flush(6);

    expect(puts()).toHaveLength(1);
    expect(putBody()).toMatchObject({ expectedVersion: 1, deadline: { localCivil: `${sydneyDay(5)}T17:00` } });
    expect(deadlineActionButton()).toBeUndefined();

    await click(undoButtons()[0]!);
    await flush(6);
    expect(puts()).toHaveLength(2);
    expect(putBody(1)).toEqual({ expectedVersion: 2, deadline: null });
  });

  // Browser pass F (#221, 390px, real input): the Set deadline confirm opens from the move
  // dialog, which is gone by the time the confirm closes, so base-ui's default sent focus to the
  // page. Cancel returns it to the row's Set deadline button; a saved Deadline (the button is
  // gone) hands it to the project's new bar.
  it("6c. Set deadline → confirm → Cancel returns focus to the Set deadline button", async () => {
    resetFixture({ noDeadline: true });
    await render();
    await click(deadlineActionButton()!);
    await flush(2);
    await setMoveDialogDeadline({ day: sydneyDay(5) });
    await click(byTestId("event-calendar-move-submit")!);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    // #224: the move dialog is the ReUI alert-dialog now; focus must move into the confirm, not
    // stay on the page behind it.
    expect(deadlineDialog()!.contains(document.activeElement)).toBe(true);
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    await flush(4);
    expect(deadlineDialog()).toBeNull();
    expect(puts()).toHaveLength(0);
    expect(document.activeElement).toBe(deadlineActionButton());
  });

  it("6e. Set deadline → move dialog → Cancel returns focus to the Set deadline button", async () => {
    resetFixture({ noDeadline: true });
    await render();
    const set = deadlineActionButton()!;
    set.focus();
    await click(set);
    await flush(2);
    expect(byTestId("event-calendar-move-dialog")!.contains(document.activeElement)).toBe(true);
    await click(byTestId("event-calendar-move-cancel")!);
    await flush(4);
    expect(byTestId("event-calendar-move-dialog")).toBeNull();
    expect(puts()).toHaveLength(0);
    expect(document.activeElement).toBe(deadlineActionButton());
  });

  it("6d. Set deadline → confirm → Schedule hands focus to the project's new bar", async () => {
    resetFixture({ noDeadline: true });
    await render();
    await click(deadlineActionButton()!);
    await flush(2);
    await setMoveDialogDeadline({ day: sydneyDay(5) });
    await click(byTestId("event-calendar-move-submit")!);
    await flush(4);
    await click(byTestId("gantt-deadline-confirm-action")!);
    await flush(6);
    expect(puts()).toHaveLength(1);
    expect(deadlineActionButton()).toBeUndefined();
    expect(document.activeElement).toBe(projectBar());
  });

  it("6b. two Set deadline buttons have distinct accessible names, each naming its street and reason", async () => {
    resetFixture({ noDeadline: true, secondNoDeadlineProject: true });
    await render();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-deadline-action"]')];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.textContent)).toEqual(["Set deadline", "Set deadline"]);
    const names = buttons.map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(expect.arrayContaining([`Set deadline for ${PROJECT_STREET}`, `Set deadline for ${SECOND_PROJECT_STREET}`]));
    for (const button of buttons) {
      expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Deadline not set");
    }
  });

  it("7. unmounting while the confirmation is open withdraws it, releases the gate and writes nothing", async () => {
    await render();
    await resizeProjectEnd(450, 63);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      root.render(view(false));
      await Promise.resolve();
    });
    await flush(4);

    expect(deadlineDialog()).toBeNull();
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(puts()).toHaveLength(0);
  });

  it("7b. access loss while the confirmation is open withdraws it and writes nothing", async () => {
    resetFixture({ truncatedTotal: 9 });
    const childPage = deferred<Reply>();
    childPageReply = childPage.promise;
    await render();
    await resizeProjectEnd(450, 64);
    await flush(4);
    expect(deadlineDialog()).not.toBeNull();

    // A continuation page answering 401 is access loss (the port's `latestError`).
    childPage.resolve({ status: 401, body: { error: "unauthorized" } });
    await flush(6);

    expect(onAccessLoss).toHaveBeenCalledTimes(1);
    expect(deadlineDialog()).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("8. without canEditDeadline: no Deadline grip, no keyboard contract on the bar, no Set deadline", async () => {
    resetFixture({ canEditDeadline: false });
    await render();
    expect(host.querySelector(`[data-gantt-resource="project:${PROJECT_ID}"] [data-testid="gantt-resize-handle-end"]`)).toBeNull();
    expect(projectBar().getAttribute("aria-keyshortcuts")).toBeNull();
    expect(deadlineActionButton()).toBeUndefined();

    await act(async () => { root.unmount(); await Promise.resolve(); });
    root = createRoot(host);
    resetFixture({ canEditDeadline: false, noDeadline: true });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render();
    expect(host.querySelector(`[data-testid="gantt-row-attention-missing_deadline"]`)).not.toBeNull();
    expect(deadlineActionButton()).toBeUndefined();
  });
});

describe("ProductionGantt — Sydney DST on a timed range (#221)", () => {
  // The Gantt opens on the real current month; only `Date` is faked (timers stay real) so the view
  // opens on the DST month and the fixture's timed range sits inside it.
  async function renderTimedRangeAt(systemTime: string, start: string, end: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(systemTime));
    resetFixture();
    rows[0]!.schedule = { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: timedEndpoint(start), end: timedEndpoint(end), due: end };
    await render();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a keyboard Adjust onto the April fold (2026-04-05 02:30 occurs twice) asks which occurrence, then sends one PATCH carrying the choice", async () => {
    await renderTimedRangeAt("2026-04-01T00:00:00Z", "2026-04-02T09:00", "2026-04-04T02:30");
    await keyboardResizeRangeEnd();
    await flush(4);

    // The planner catches the fold before any request: nothing is sent until a side is chosen.
    expect(patches()).toHaveLength(0);
    const dialog = byTestId("event-calendar-fold-choice");
    expect(dialog).not.toBeNull();
    const radios = [...dialog!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["end earlier occurrence", "end later occurrence"]);
    expect(liveRegionText()).toBe("That time occurs twice in Sydney that day. Choose the earlier or later occurrence for each endpoint.");

    await click(radios[1]!);
    await click(byTestId("event-calendar-fold-submit")!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    const body = patchBody();
    expect(body.schedule.expectedVersion).toBe(1);
    // The unmoved start keeps its stored civil time (the request builder carries its stored side).
    expect(body.schedule.schedule.start).toMatchObject({ localCivil: "2026-04-02T09:00" });
    expect(body.schedule.schedule.end).toEqual({ localCivil: "2026-04-05T02:30", disambiguation: "later" });
  });

  it("a keyboard Adjust into the October gap (2026-10-04 02:30 does not exist) announces the gap and sends nothing", async () => {
    await renderTimedRangeAt("2026-10-01T00:00:00Z", "2026-10-01T09:00", "2026-10-03T02:30");
    const before = barLabel(RANGE_TITLE);
    await keyboardResizeRangeEnd();
    await flush(6);

    expect(patches()).toHaveLength(0);
    expect(byTestId("event-calendar-fold-choice")).toBeNull();
    expect(liveRegionText()).toBe("That time does not exist in Sydney on that date (daylight-saving gap).");
    expect(barLabel(RANGE_TITLE)).toBe(before);
  });
});

/**
 * #344 — the per-Project "+ Add task" row, end to end over the stubbed `fetch`: the real vendored
 * Gantt, the real `ProductionGantt` consumer, the real toast store. The POST is the SAME endpoint
 * and body shape the Project page's composer sends (`POST /api/projects/:id/subtasks`, title only;
 * the server applies the default range from #339 and writes the audit row and activity in the same
 * batch — proven by `workers/app/test/project-subtasks.test.ts`, so nothing is re-proven here).
 */
describe("ProductionGantt — Add task row (#344)", () => {
  // `invalidateProjectSurfaces` refetches the Gantt through the query runtime the app installs on its
  // QueryClient; the file's default client has none, so this describe gives it one.
  let runtime: ProjectQueryRuntime;
  beforeEach(() => {
    runtime = new ProjectQueryRuntime(client, "gantt-create-tab");
  });
  afterEach(() => {
    onOpenProjectProp = undefined;
    runtime.dispose();
  });

  function addTaskButton(street: string): HTMLButtonElement | null {
    return [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-label") === `Add task in ${street}`) ?? null;
  }

  function createInput(): HTMLInputElement {
    const el = [...host.querySelectorAll<HTMLInputElement>("input")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith("New task title in"));
    if (!el) throw new Error("no create input");
    return el;
  }

  function hasBar(title: string): boolean {
    return [...host.querySelectorAll("[data-gantt-resource] button")].some((el) => el.getAttribute("aria-label")?.startsWith(title));
  }

  async function open(street = PROJECT_STREET) {
    await click(addTaskButton(street)!);
  }

  async function submit(title: string) {
    await setInput(createInput(), title);
    await keydown(createInput(), "Enter");
    await flush(6);
  }

  function toastTexts(): string[] {
    return toasts().map((toast) => toast.textContent ?? "");
  }

  function errorToasts(): string[] {
    return toasts().filter((toast) => toast.getAttribute("data-tone") === "error").map((toast) => toast.textContent ?? "");
  }

  function capToasts(): number {
    return toastTexts().filter((text) => text.includes("Created — not shown (chart row limit)")).length;
  }

  function hiddenToasts(): number {
    return toastTexts().filter((text) => text.includes("Created — hidden by current filters")).length;
  }

  it("shows the row only where the server lets the user edit the Project's children", async () => {
    resetFixture({ secondNoDeadlineProject: true, secondCanEditChildren: false });
    await render();
    expect(addTaskButton(PROJECT_STREET)).not.toBeNull();
    expect(addTaskButton(SECOND_PROJECT_STREET)).toBeNull();
    // no permission: no row, and a Project with no Subtasks stays a plain leaf (no toggle)
    expect(host.querySelector(`button[aria-label="${SECOND_PROJECT_STREET}"]`)).toBeNull();
  });

  it("gives a Project with no Subtasks a + and keeps it a leaf (no chevron promising hidden children), when its children are editable", async () => {
    resetFixture({ secondNoDeadlineProject: true });
    await render();
    expect(addTaskButton(SECOND_PROJECT_STREET)).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${SECOND_PROJECT_STREET}"]`)).toBeNull();
  });

  it("keeps the + on a collapsed Project; pressing it expands the Project and opens the editor under its last Subtask", async () => {
    await render();
    await click(host.querySelector<HTMLElement>(`button[aria-label="${PROJECT_STREET}"]`)!);
    expect(host.querySelector(`button[aria-label="${PROJECT_STREET}"]`)!.getAttribute("aria-expanded")).toBe("false");
    expect(addTaskButton(PROJECT_STREET)).not.toBeNull();
    await click(addTaskButton(PROJECT_STREET)!);
    expect(host.querySelector(`button[aria-label="${PROJECT_STREET}"]`)!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(createInput());
  });

  it("clicking the row and pressing Enter posts exactly { title } (trimmed) to the selected Project, and the Subtask appears as a real, editable bar", async () => {
    await render();
    await open();
    await submit(`  ${CREATED_TITLE}  `);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ method: "POST", url: `/api/projects/${PROJECT_ID}/subtasks`, body: { title: CREATED_TITLE } });
    expect(Object.keys(posts()[0]!.body as object)).toEqual(["title"]);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    // the refetch replaced the pinned copy with the server's row: it has grips
    expect(host.querySelector(`[data-gantt-resource="task:${CREATED_ID}"] [data-testid="gantt-resize-handle-end"]`)).not.toBeNull();
    expect(host.querySelector('input[aria-label^="New task title in"]')).toBeNull();
    expect(document.activeElement).toBe(addTaskButton(PROJECT_STREET));
    expect(toastTexts().join("|")).not.toContain("hidden by current filters");
  });

  it("posts to the second Project when its row is used", async () => {
    resetFixture({ secondNoDeadlineProject: true });
    await render();
    await open(SECOND_PROJECT_STREET);
    await submit("Second one");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe(`/api/projects/${SECOND_PROJECT_ID}/subtasks`);
  });

  it("the arrow keys reach the row and Enter opens the input", async () => {
    await render();
    const toggle = host.querySelector<HTMLElement>(`button[aria-label="${PROJECT_STREET}"]`)!;
    await act(async () => toggle.focus());
    // walk down the tree's focus targets until the Add task row
    for (let step = 0; step < 12 && document.activeElement !== addTaskButton(PROJECT_STREET); step += 1) await keydown(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(addTaskButton(PROJECT_STREET));
    await keydown(document.activeElement!, "Enter");
    expect(document.activeElement).toBe(createInput());
    await keydown(createInput(), "Escape");
    expect(document.activeElement).toBe(addTaskButton(PROJECT_STREET));
  });

  it("refuses an empty or whitespace title, and Esc cancels: nothing is sent", async () => {
    await render();
    await open();
    await setInput(createInput(), "   ");
    await keydown(createInput(), "Enter");
    await flush(2);
    expect(posts()).toHaveLength(0);
    expect(createInput()).toBeDefined();
    await keydown(createInput(), "Escape");
    await flush(2);
    expect(posts()).toHaveLength(0);
    expect(host.querySelector('input[aria-label^="New task title in"]')).toBeNull();
  });

  it("refuses a title over 500 characters without sending it", async () => {
    await render();
    await open();
    await setInput(createInput(), "x".repeat(501));
    await keydown(createInput(), "Enter");
    await flush(2);
    expect(posts()).toHaveLength(0);
    expect(createInput().getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[data-testid="gantt-group-create-task-error"]')?.textContent).toContain("500");
    // visible where the tree's scroll edge cannot clip it
    expect(errorToasts().some((text) => text.includes("500"))).toBe(true);
  });

  it("sends once while the request is held", async () => {
    const held = deferred<Reply>();
    createReply = async (body, projectId) => {
      await held.promise;
      return echoCreate(body, projectId);
    };
    await render();
    await open();
    await setInput(createInput(), CREATED_TITLE);
    await keydown(createInput(), "Enter");
    await keydown(createInput(), "Enter");
    await flush(2);
    expect(posts()).toHaveLength(1);
    held.resolve({ status: 200, body: {} });
    await flush(6);
    expect(posts()).toHaveLength(1);
  });

  it("a 500 keeps the typed title and the input, shows the server's message as a toast and in the row's status, and adds no bar", async () => {
    createReply = () => ({ status: 500, body: { error: "Nope from the server" } });
    await render();
    await open();
    await submit(CREATED_TITLE);
    expect(posts()).toHaveLength(1);
    expect(createInput().value).toBe(CREATED_TITLE);
    expect(createInput().getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[data-testid="gantt-group-create-task-error"]')?.textContent).toBe("Nope from the server");
    expect(errorToasts()).toHaveLength(1);
    expect(errorToasts()[0]).toContain("Nope from the server");
    expect(onAccessLoss).not.toHaveBeenCalled();
    expect(hasBar(CREATED_TITLE)).toBe(false);
  });

  for (const status of [401, 403]) {
    it(`a ${status} goes through the Gantt's access-loss flow (onAccessLoss) and adds no bar`, async () => {
      createReply = () => ({ status, body: { error: "Nope from the server" } });
      await render();
      await open();
      await submit(CREATED_TITLE);
      expect(posts()).toHaveLength(1);
      expect(onAccessLoss).toHaveBeenCalledTimes(1);
      expect(hasBar(CREATED_TITLE)).toBe(false);
    });
  }

  it("a refetch that omits the new Subtask keeps its bar and raises the hidden-by-filters toast once; the next refetch retires it", async () => {
    createReply = (body, projectId) => {
      const reply = echoCreate(body, projectId);
      omittedFromGet.add(CREATED_ID);
      return reply;
    };
    await render();
    await open();
    await submit(CREATED_TITLE);

    expect(hasBar(CREATED_TITLE)).toBe(true);
    // the pinned copy is read-only: no grips until the real row arrives
    expect(host.querySelector(`[data-gantt-resource="task:${CREATED_ID}"] [data-testid="gantt-resize-handle-end"]`)).toBeNull();
    expect(toastTexts().filter((text) => text.includes("Created — hidden by current filters"))).toHaveLength(1);

    await act(async () => { await client.invalidateQueries(); });
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(false);
    expect(toastTexts().filter((text) => text.includes("Created — hidden by current filters"))).toHaveLength(1);
  });

  it("a pinned created bar (not yet returned by the refetch) still opens the item menu, with Open project only (#463)", async () => {
    const opened = vi.fn<(projectId: string) => void>();
    onOpenProjectProp = opened;
    createReply = (body, projectId) => {
      const reply = echoCreate(body, projectId);
      omittedFromGet.add(CREATED_ID);
      return reply;
    };
    await render();
    await open();
    await submit(CREATED_TITLE);
    await click(findBar(CREATED_TITLE));
    const labels = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].map((node) => node.textContent);
    // read-only pin: no Edit schedule…, but the Project is still reachable
    expect(labels).toEqual(["Open project"]);
    await click([...document.querySelectorAll<HTMLElement>("[role=menuitem]")][0]!);
    expect(opened).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("does not raise the hidden toast when the row simply comes back on the refetch", async () => {
    await render();
    await open();
    await submit(CREATED_TITLE);
    expect(toastTexts().join("|")).not.toContain("hidden by current filters");
  });

  it("does not treat a truncated child page as an omission", async () => {
    resetFixture({ truncatedTotal: 40 });
    createReply = (body, projectId) => {
      const reply = echoCreate(body, projectId);
      omittedFromGet.add(CREATED_ID);
      return reply;
    };
    await render();
    await open();
    await submit(CREATED_TITLE);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(toastTexts().join("|")).not.toContain("hidden by current filters");
  });

  /**
   * A Project whose checklist spans two child pages: page one is the fixture's rows, page two is
   * `pageTwo`. The walk's continuation answers from `childGate` (held until the test releases it).
   */
  function paginated(pageTwo: Array<{ id: string; title: string; position: number }>) {
    resetFixture({ truncatedTotal: rows.length + pageTwo.length });
    let gate = deferred<void>();
    childPageReply = null;
    childPageHandler = async () => {
      await gate.promise;
      return {
        status: 200,
        body: {
          projectId: PROJECT_ID,
          children: {
            rows: pageTwo.map((row) => ({ id: row.id, projectId: PROJECT_ID, title: row.title, done: false, position: row.position, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0, schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(sydneyDay(4)), end: endMoment(sydneyDay(6)), due: sydneyDay(6) }, reminders: subtaskReminders(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true } })),
            total: truncatedTotal!,
            returned: pageTwo.length,
            truncated: false,
            nextCursor: null,
          },
        },
      };
    };
    return {
      release: () => { gate.resolve(); },
      rearm: () => { gate = deferred<void>(); },
    };
  }

  it("a refetch that supersedes a completed child walk is not judged until the new walk loads: the row comes back silently", async () => {
    const pageTwo = [{ id: "88888888-8888-4888-8888-000000000001", title: "Page two row", position: 10 }];
    const walk = paginated(pageTwo);
    // the new Subtask lands on the LAST page (page two), and the Project's total grows
    createReply = (body, projectId) => {
      const reply = echoCreate(body, projectId);
      omittedFromGet.add(CREATED_ID);
      pageTwo.push({ id: CREATED_ID, title: body.title, position: 11 });
      truncatedTotal = truncatedTotal! + 1;
      return reply;
    };
    await render();
    walk.release();
    await flush(4);
    expect(hasBar("Page two row")).toBe(true);

    walk.rearm();
    await open();
    await submit(CREATED_TITLE);
    // the refetch's new page one re-seeded the walk; its page two is still held
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(hiddenToasts()).toBe(0);

    walk.release();
    await flush(6);
    // the new walk brought the real row (grips and all): the pin retired, silently
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(host.querySelector(`[data-gantt-resource="task:${CREATED_ID}"] [data-testid="gantt-resize-handle-end"]`)).not.toBeNull();
    expect(hiddenToasts()).toBe(0);
  });

  it("a refetch that supersedes a completed child walk: when the new walk completes WITHOUT the row, the toast is raised then", async () => {
    const pageTwo = [{ id: "88888888-8888-4888-8888-000000000001", title: "Page two row", position: 10 }];
    const walk = paginated(pageTwo);
    createReply = (body, projectId) => {
      const reply = echoCreate(body, projectId);
      omittedFromGet.add(CREATED_ID);
      truncatedTotal = truncatedTotal! + 1;
      return reply;
    };
    await render();
    walk.release();
    await flush(4);

    walk.rearm();
    await open();
    await submit(CREATED_TITLE);
    expect(hiddenToasts()).toBe(0);

    walk.release();
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(hiddenToasts()).toBe(1);
  });

  it("the real row tipping its Project over the draw cap removes the Project, and says so (never silently)", async () => {
    // the Project row + its 4 Subtasks fill a cap of 5 exactly
    drawCap.override = rows.length + 1;
    const held = deferred<void>();
    await render();
    getGate = held.promise;
    await open();
    await submit(CREATED_TITLE);
    // the pin is exempt from the budget: the new bar shows while the refetch is out
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(hasBar(RANGE_TITLE)).toBe(true);
    expect(capToasts()).toBe(0);

    // the refetch returns the real row: 6 real rows > 5, the Project leaves the chart
    getGate = null;
    held.resolve();
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(false);
    expect(hasBar(RANGE_TITLE)).toBe(false);
    expect(capToasts()).toBe(1);
    expect(hiddenToasts()).toBe(0);

    // once only
    await act(async () => { await client.invalidateQueries(); });
    await flush(6);
    expect(capToasts()).toBe(1);
  });

  it("during a pending resize transaction the chart is frozen: a refetch carrying the real row does not retire the pin until the chart shows it", async () => {
    const held = deferred<void>();
    await render();
    getGate = held.promise;
    await open();
    await submit(CREATED_TITLE);
    expect(hasBar(CREATED_TITLE)).toBe(true);

    // a resize is saving: the controller freezes the drawn baseline (which lacks the new row)
    const patchHeld = deferred<void>();
    patchReply = async (body, subtaskId) => {
      await patchHeld.promise;
      return echoPatch(body, subtaskId);
    };
    await keyboardResizeRangeEnd();
    await flush(2);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);

    // the create's refetch lands with the real row while the chart is frozen
    getGate = null;
    held.resolve();
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(hiddenToasts()).toBe(0);

    // the save settles: the chart unfreezes onto the real row
    patchHeld.resolve();
    await flush(10);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(host.querySelector(`[data-gantt-resource="task:${CREATED_ID}"] [data-testid="gantt-resize-handle-end"]`)).not.toBeNull();
    expect(hiddenToasts()).toBe(0);
  });

  it("a refetch that STARTED before the create cannot retire the pin or raise the toast, even though it lands after it", async () => {
    await render();
    const ganttKey = client.getQueryCache().getAll().find((query) => query.queryKey[0] === "production-gantt")!.queryKey;
    // a poll starts; its body is what the server had at that moment (no new row yet)
    const held = deferred<void>();
    getHeldAtRequest = held.promise;
    await act(async () => { void client.refetchQueries({ queryKey: ganttKey }); await Promise.resolve(); });
    await flush(1);
    getHeldAtRequest = null;
    // the create's own invalidation is deferred while something owns the Gantt key
    const release = runtime.acquireOwner(ganttKey);

    await open();
    await submit(CREATED_TITLE);
    expect(hasBar(CREATED_TITLE)).toBe(true);

    // the pre-create poll lands AFTER the create, without the row
    held.resolve();
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(hiddenToasts()).toBe(0);

    // a refetch that starts after the create returns the row: the pin retires, silently
    release();
    await act(async () => { await client.invalidateQueries({ queryKey: ganttKey }); });
    await flush(6);
    expect(hasBar(CREATED_TITLE)).toBe(true);
    expect(host.querySelector(`[data-gantt-resource="task:${CREATED_ID}"] [data-testid="gantt-resize-handle-end"]`)).not.toBeNull();
    expect(hiddenToasts()).toBe(0);
  });

  it("9. at <=720px the warning sits on a second line under the project name; desktop layout is unchanged (#689)", async () => {
    resetFixture({ canEditDeadline: false, noDeadline: true });
    await render();
    const badge = host.querySelector<HTMLElement>(`[data-testid="gantt-row-attention-missing_deadline"]`)!;
    const tokens = badge.className.split(/\s+/);
    for (const token of ["min-w-0", "truncate", "min-[721px]:shrink-0"]) expect(tokens, token).toContain(token);
    expect(tokens).not.toContain("shrink-0");
    expect(tokens).not.toContain("max-[721px]:max-w-[45%]");
    expect(badge.getAttribute("title")).toBe("Deadline not set");

    const meta = badge.closest<HTMLElement>(`[data-testid="gantt-row-label-meta"]`)!;
    expect(meta).not.toBeNull();
    const metaTokens = meta.className.split(/\s+/);
    for (const token of ["min-[721px]:contents", "max-[721px]:flex", "min-w-0", "max-[721px]:overflow-hidden"]) expect(metaTokens, token).toContain(token);

    const outer = meta.parentElement!;
    const outerTokens = outer.className.split(/\s+/);
    for (const token of ["max-[721px]:flex-col", "max-[721px]:items-stretch", "max-[721px]:justify-center"]) expect(outerTokens, token).toContain(token);
    expect(outerTokens).not.toContain("max-[721px]:items-start");

    const title = meta.previousElementSibling as HTMLElement;
    expect(title.className.split(/\s+/)).toContain("max-[721px]:flex-none");
    expect(title.className.split(/\s+/)).toContain("truncate");

    // narrowTree is `(max-width: 720px)` (width <= 720); `max-[720px]:` compiles to width < 720, leaving 720 in neither variant (#692).
    expect([badge, meta, outer, title].map((el) => el.className).join(" ")).not.toContain("max-[720px]");
  });

  it("9b. a row with no badge renders no meta wrapper (#689)", async () => {
    resetFixture({ canEditDeadline: false });
    await render();
    expect(host.querySelector(`[data-testid="gantt-row-label-meta"]`)).toBeNull();
  });
});
