/**
 * #372 (range-end half) — a Subtask row's Due cell shows the end of its range and, for a viewer who may edit the
 * schedule, opens the Checklist's own range picker (`quincy/SubtaskScheduleControl`) on End. The write is the
 * Gantt's scheduling controller's (`useSchedulingController`): one PATCH at the version captured when the editor
 * opened, an optimistic bar, an Undo toast, the controller's settle refetch. A real `ProductionGantt` over a
 * stubbed `fetch`, exactly as `ProductionGantt.writes.dom.test.tsx` does it.
 *
 * Guard F (`test-seam.guard.test.ts`): nothing here selects a vendor `data-slot` or class. Bars are found by
 * their accessible name, the Due cell by its `data-testid` / accessible name, the picker by its group's name.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
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
import { clearToasts } from "../lib/toast-store";
import { ToastViewport } from "./quincy/ToastViewport";
import { ProductionGantt } from "./ProductionGantt";
import { endMoment, startMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { applyPopup, dateTimePopup, pickPopupDay, popupButton, pressInPopup, rangeToggles, typePopupTime, rangeMoment } from "@/testing/date-time-popup";

vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RANGE_ID = "22222222-2222-4222-8222-222222222222";
const RANGE_TITLE = "Edit hero set";
const TIMED_ID = "33333333-3333-4333-8333-333333333333";
const TIMED_TITLE = "Send preview";
const PAGE_TWO_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_TWO_TITLE = "Cull selects";

/** A civil date in the pinned Sydney month (the Gantt opens on today's month): day 10 + `offset`. 2026-09-10 is a Thursday. */
function sydneyDay(offset: number): string {
  const monthStart = `${formatSydneyCivilMinute(Date.now()).slice(0, 7)}-10`;
  const shifted = shiftSydneyCalendarDate(monthStart, offset);
  if (!shifted.ok) throw new Error("fixture date did not shift");
  return shifted.value;
}

function timedEndpoint(localCivil: string, disambiguation?: "earlier" | "later"): ChecklistScheduleEndpointDto {
  const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (!resolved.ok) throw new Error(`fixture civil did not resolve: ${localCivil}`);
  return { localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" };
}
const range = (version: number, start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto): ChecklistScheduleDto => ({ state: "range", version, zone: PRODUCTION_GANTT_ZONE, start, end, due: end.localCivil });

type Row = { id: string; title: string; position: number; schedule: ChecklistScheduleDto; canOpenScheduleEditor: boolean };
type ScheduleInput = { state: string; start?: { localCivil: string; disambiguation?: "earlier" | "later" }; end?: { localCivil: string; disambiguation?: "earlier" | "later" } };
type PatchBody = { schedule: { expectedVersion: number; schedule: ScheduleInput; reminderOffsetsMinutes?: number[] } };

/** The server's view: PATCH mutates it, GET reads it. */
let rows: Row[];
let pageTwo: Row[];
/** The server's stored reminder offsets by Subtask id (#425); the default is "1 day before". */
let storedOffsets: Record<string, number[]>;

function resetFixture(options: { canOpenScheduleEditor?: boolean; timedStart?: string; timedEnd?: string } = {}) {
  const can = options.canOpenScheduleEditor ?? true;
  rows = [
    { id: RANGE_ID, title: RANGE_TITLE, position: 0, canOpenScheduleEditor: can, schedule: range(1, startMoment(sydneyDay(1)), endMoment(sydneyDay(3))) },
    { id: TIMED_ID, title: TIMED_TITLE, position: 1, canOpenScheduleEditor: can, schedule: range(1, timedEndpoint(options.timedStart ?? `${sydneyDay(2)}T09:00`), timedEndpoint(options.timedEnd ?? `${sydneyDay(2)}T17:00`)) },
  ];
  pageTwo = [];
  storedOffsets = {};
}

function childRow(row: Row) {
  return {
    id: row.id, projectId: PROJECT_ID, title: row.title, done: false, position: row.position, assignees: [], otherAssigneeCount: 0, assignmentVersion: 1,
    schedule: row.schedule, reminders: subtaskReminders(storedOffsets[row.id] ?? [1440]), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: row.canOpenScheduleEditor, canEditAssignees: true },
  };
}

function ganttResponse() {
  const shoot = sydneyDay(-1);
  const total = rows.length + pageTwo.length;
  return adminProductionGanttResponseSchema.parse({
    scope: "active", zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [{
      id: PROJECT_ID, street: "1 Range Street", suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
      shootDate: shoot, shootDateCivil: shoot, createdAt: `${shoot}T00:00:00.000Z`, barStartDate: shoot,
      deadline: { at: resolveSydneyCivilMinute(`${sydneyDay(6)}T15:00`).ok ? (resolveSydneyCivilMinute(`${sydneyDay(6)}T15:00`) as { ok: true; value: { instant: string } }).value.instant : "", localCivil: `${sydneyDay(6)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
      deadlineVersion: 1, editors: [], checklist: { completed: 0, total },
      team: [], permissions: { canEditDeadline: true, canEditChildren: true, canEditTeam: true },
      children: { rows: rows.map(childRow), total, returned: rows.length, truncated: pageTwo.length > 0, nextCursor: pageTwo.length > 0 ? "cursor-2" : null },
    }],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1 + total, drawCap: 2000, tooManyToDraw: false },
  });
}

type Request = { method: string; url: string; body: unknown };
type Reply = { status: number; body: unknown };
let requests: Request[];
let patchReply: ((body: PatchBody, subtaskId: string) => Promise<Reply> | Reply) | null;
let getGate: Promise<void> | null;
let getFails: boolean;

function scheduleFromInput(input: ScheduleInput, version: number): ChecklistScheduleDto {
  const endpoint = (value: ScheduleInput["end"]) => (value ? timedEndpoint(value.localCivil, value.disambiguation) : null);
  const start = endpoint(input.start);
  const end = endpoint(input.end);
  if (!start || !end) throw new Error("fixture: a range PATCH must carry both endpoints");
  return range(version, start, end);
}

function echoPatch(body: PatchBody, subtaskId: string): Reply {
  const row = [...rows, ...pageTwo].find((candidate) => candidate.id === subtaskId)!;
  const schedule = scheduleFromInput(body.schedule.schedule, body.schedule.expectedVersion + 1);
  row.schedule = schedule;
  if (body.schedule.reminderOffsetsMinutes) storedOffsets[row.id] = body.schedule.reminderOffsetsMinutes;
  return { status: 200, body: { id: row.id, title: row.title, done: false, position: row.position, schedule, reminders: subtaskReminders(storedOffsets[row.id] ?? [1440]) } };
}

const patches = () => requests.filter((request) => request.method === "PATCH");
const patchBody = (index = 0) => patches()[index]!.body as PatchBody;
const gets = () => requests.filter((request) => request.method === "GET" && request.url.startsWith("/api/production-gantt"));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let onAcceptGateChange: ReturnType<typeof vi.fn<(blocked: boolean) => void>>;
let onAccessLoss: ReturnType<typeof vi.fn<() => void>>;

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
// Iteration-counted, not clock-counted: `Date` is pinned in this file, so `Date.now()` never advances.
async function waitFor(assertion: () => void, attempts = 75) {
  for (let attempt = 0; ; attempt += 1) {
    try { assertion(); return; } catch (error) {
      if (attempt >= attempts) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} onAcceptGateChange={onAcceptGateChange} onAccessLoss={onAccessLoss} />
        <ToastViewport />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  await flush();
}

const findBar = (title: string) => [...host.querySelectorAll("button")].find((el) => el.getAttribute("aria-label")?.startsWith(title)) as HTMLButtonElement;
const barLabel = (title: string) => findBar(title)?.getAttribute("aria-label") ?? "";
/** The Due cell: an interactive trigger for an editor, a plain <time> for a viewer. */
const dueTrigger = (title: string) => host.querySelector<HTMLButtonElement>(`[data-testid="gantt-subtask-due-trigger"][aria-label^="Due for ${title}"]`);
const dueCells = () => [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-subtask-due"]')];
const dueText = (title: string) => dueTrigger(title)?.textContent ?? "";
const picker = (title: string) => dateTimePopup(`Schedule for ${title}`);
const pickerButton = (title: string, name: string) => (picker(title) ? popupButton(picker(title)!, name) : undefined);
/** The End toggle's text in the open popup ("Tue 15 Sep · 17:00"). */
const endText = (title: string) => rangeToggles(picker(title)!).end;
const startText = (title: string) => rangeToggles(picker(title)!).start;
const undoButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="toast-action"]')];
const toasts = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="toast"]')].map((el) => el.textContent ?? "");
const liveRegionText = () => host.querySelector('[data-testid="production-gantt-live-region"]')?.textContent ?? "";

async function click(el: HTMLElement) { await act(async () => { el.click(); await Promise.resolve(); }); }
async function keydown(el: EventTarget, key: string) { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); await Promise.resolve(); }); }
async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) { await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })); await Promise.resolve(); }); }
async function outsidePress() {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      document.body.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX: 2, clientY: 2 }));
    }
    await Promise.resolve();
  });
  await flush(3);
}
async function openDue(title: string) {
  await click(dueTrigger(title)!);
  await waitFor(() => expect(picker(title)).not.toBeNull());
  await flush(2);
}
/** Picks a new End day in the open popup (End is the active end) and presses Apply. */
async function saveEnd(title: string, date: string) {
  await pickPopupDay(picker(title)!, date);
  await applyPopup(picker(title)!);
  await flush(6);
}

/** #585: the 409 body the conflict tests answer with: v3, End on day 8. */
const winnerV3 = () => range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
const scheduleConflict = (winner: ChecklistScheduleDto): Reply => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
const itemConflict = (winner: ChecklistScheduleDto): Reply => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_item_conflict", current: winner, currentSubtask: { id: RANGE_ID, title: RANGE_TITLE, done: true, position: 0, schedule: winner } } }; };
/** A real outside press that lands on another focusable control (not only on the body). */
async function outsideControlPress() {
  const control = document.createElement("button");
  control.type = "button";
  control.setAttribute("data-testid", "outside-focus-target");
  document.body.append(control);
  await act(async () => {
    control.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      control.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX: 2, clientY: 2 }));
    }
    await Promise.resolve();
  });
  await flush(3);
  control.remove();
}
/** The Due cell's conflicted state: End on day 5 and "4 hours" drafted, answered 409 with v3. */
async function conflictOnDue(conflict: (winner: ChecklistScheduleDto) => Reply = scheduleConflict) {
  await openDue(RANGE_TITLE);
  await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
  await click(pickerButton(RANGE_TITLE, "4 hours")!);
  const winner = winnerV3();
  patchReply = () => conflict(winner);
  await applyPopup(picker(RANGE_TITLE)!);
  await flush(8);
  patchReply = null;
  expect(patches()).toHaveLength(1);
  expect(picker(RANGE_TITLE)!.textContent).toContain(conflict === itemConflict ? "Latest checklist item · schedule v3" : "Latest schedule · v3");
  expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
}
/** Dismisses the open Due picker the given way and waits until it is gone and the chart is live again. */
async function dismissDue(how: "escape" | "outside" | "control") {
  if (how === "escape") await keydown(document.activeElement ?? document.body, "Escape");
  else if (how === "outside") await outsidePress();
  else await outsideControlPress();
  await flush(3);
  await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
  expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
}
/** After a reopen: the stash's notice and the draft are back, and a reapply is exactly one more PATCH at `version`. */
async function expectDraftAndReapply(version: number) {
  expect(patches()).toHaveLength(1);
  expect(picker(RANGE_TITLE)!.textContent).toContain(`Latest schedule · v${version}`);
  expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
  expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  await applyPopup(picker(RANGE_TITLE)!);
  await flush(8);
  expect(patches()).toHaveLength(2);
  expect(patchBody(1).schedule.expectedVersion).toBe(version);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T02:00:00.000Z"));
  resetFixture();
  requests = [];
  patchReply = null;
  getGate = null;
  getFails = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onAcceptGateChange = vi.fn<(blocked: boolean) => void>();
  onAccessLoss = vi.fn<() => void>();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const json = (reply: Reply) => new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.startsWith("/api/production-gantt") && url.includes("childrenOf=")) {
      const total = rows.length + pageTwo.length;
      return json({ status: 200, body: { projectId: PROJECT_ID, children: { rows: pageTwo.map(childRow), total, returned: pageTwo.length, truncated: false, nextCursor: null } } });
    }
    if (method === "GET" && url.startsWith("/api/production-gantt")) {
      if (getGate) await getGate;
      if (getFails) return json({ status: 500, body: { error: "The schedule is unavailable." } });
      return json({ status: 200, body: ganttResponse() });
    }
    const subtask = /^\/api\/projects\/[^/]+\/subtasks\/([^/?]+)$/.exec(url);
    if (method === "PATCH" && subtask) return json(await (patchReply ?? echoPatch)(body, decodeURIComponent(subtask[1]!)));
    return json({ status: 404, body: { error: `unexpected ${method} ${url}` } });
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("ProductionGantt — Subtask Due cell (#372, range end)", () => {
  it("R1 shows the range END in the Due column with its Sydney wall time, 'Sun 13 Sep · 17:00'", async () => {
    await render();
    // 2026-09-13 is a Sunday; the timed row ends Sat 12 Sep at 17:00.
    expect(dueText(RANGE_TITLE)).toBe("Sun 13 Sep · 17:00");
    expect(dueText(TIMED_TITLE)).toBe("Sat 12 Sep · 17:00");
    // In the Due column, never the name cell: the row label keeps the title alone.
    const nameCell = host.querySelector(`[data-gantt-resource="task:${RANGE_ID}"]`);
    expect(dueCells()).toHaveLength(2);
    expect(nameCell?.textContent ?? "").not.toContain("Sun 13 Sep");
  });

  it("R2 changing only End sends ONE PATCH at the open version with the Start unchanged; the cell and bar update, Undo restores both", async () => {
    await render();
    const before = barLabel(RANGE_TITLE);
    const held = deferred<Reply>();
    patchReply = async (body, subtaskId) => { await held.promise; return echoPatch(body, subtaskId); };
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(2);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${RANGE_ID}`);
    expect(patchBody().schedule.expectedVersion).toBe(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00` }, end: { localCivil: `${sydneyDay(5)}T17:00` } });
    // The bar previews the new end while the request is held.
    expect(barLabel(RANGE_TITLE)).not.toBe(before);

    held.resolve({ status: 200, body: null });
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(dueText(RANGE_TITLE)).toBe("Tue 15 Sep · 17:00");
    expect(barLabel(RANGE_TITLE)).not.toBe(before);
    expect(toasts().join(" ")).toContain("Schedule saved.");
    expect(undoButtons()).toHaveLength(1);

    patchReply = null;
    await click(undoButtons()[0]!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(2);
    expect(patchBody(1).schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00`, disambiguation: "earlier" }, end: { localCivil: `${sydneyDay(3)}T17:00`, disambiguation: "earlier" } });
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Sun 13 Sep · 17:00"));
    expect(barLabel(RANGE_TITLE)).toBe(before);
  });

  it("#423 the Subtask picker offers the Project default from the project row and resets the range to it", async () => {
    await render();
    await openDue(RANGE_TITLE);
    // The fixture: shoot day -1 (2026-09-09), Deadline day +6 at 15:00 (2026-09-16).
    expect(pickerButton(RANGE_TITLE, "Project default")).toBeDefined();
    await pressInPopup(picker(RANGE_TITLE)!, "Project default");
    expect(startText(RANGE_TITLE)).toBe("Wed 9 Sep · 09:00");
    expect(endText(RANGE_TITLE)).toBe("Wed 16 Sep · 15:00");
  });

  it("R3 a timed End keeps the unchanged timed Start and its Sydney wall time on the wire", async () => {
    await render();
    await openDue(TIMED_TITLE);
    await typePopupTime(picker(TIMED_TITLE)!, "18:30");
    await applyPopup(picker(TIMED_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(2)}T09:00` }, end: { localCivil: `${sydneyDay(2)}T18:30` } });
    await waitFor(() => expect(dueText(TIMED_TITLE)).toBe("Sat 12 Sep · 18:30"));
  });

  it("R4 the popup opens on End, with focus on its toggle; Cancel and Escape return focus to the Due trigger and send nothing", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(rangeToggles(picker(RANGE_TITLE)!).active).toBe("End");
    expect(document.activeElement?.textContent).toContain("End");
    await pressInPopup(picker(RANGE_TITLE)!, "Cancel");
    await flush(3);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    expect(document.activeElement).toBe(dueTrigger(RANGE_TITLE));

    await openDue(RANGE_TITLE);
    await keydown(document.activeElement ?? document.body, "Escape");
    await flush(3);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    expect(document.activeElement).toBe(dueTrigger(RANGE_TITLE));
    expect(patches()).toHaveLength(0);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
  });

  it("R5 after a save, focus is on the Due trigger (not the page)", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await saveEnd(RANGE_TITLE, sydneyDay(4));
    expect(patches()).toHaveLength(1);
    expect(document.activeElement).toBe(dueTrigger(RANGE_TITLE));
  });

  it("R6 an End before the Start is refused in the popup and sends no PATCH; the draft stays open", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(1));
    await typePopupTime(picker(RANGE_TITLE)!, "08:00");
    expect(pickerButton(RANGE_TITLE, "Apply")!.disabled).toBe(true);
    expect(picker(RANGE_TITLE)!.textContent).toContain("Start must be before end.");
    expect(patches()).toHaveLength(0);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(1), "08:00"));
    expect(startText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(1), "09:00"));

    // The same day, later than the start, is a range under a day: accepted.
    await typePopupTime(picker(RANGE_TITLE)!, "16:00");
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule.end).toEqual({ localCivil: `${sydneyDay(1)}T16:00` });
  });

  it("R7 a timed End equal to its Start is refused before any PATCH", async () => {
    await render();
    await openDue(TIMED_TITLE);
    await typePopupTime(picker(TIMED_TITLE)!, "09:00");
    expect(pickerButton(TIMED_TITLE, "Apply")!.disabled).toBe(true);
    expect(patches()).toHaveLength(0);
    expect(picker(TIMED_TITLE)).not.toBeNull();
  });

  it("R8 a viewer without schedule access sees the end as plain text: no trigger, no picker, no request", async () => {
    resetFixture({ canOpenScheduleEditor: false });
    await render();
    expect(dueTrigger(RANGE_TITLE)).toBeNull();
    const plain = dueCells().find((cell) => cell.textContent === "Sun 13 Sep · 17:00");
    expect(plain?.tagName).toBe("TIME");
    expect(host.querySelectorAll('[data-testid="gantt-subtask-due"] button')).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });

  it("R9 a repeated Sydney hour asks Earlier or Later in the popup and sends the choice", async () => {
    // Sun 5 Apr 2026: clocks go back at 03:00, so 02:30 happens twice.
    resetFixture({ timedStart: "2026-04-04T09:00", timedEnd: "2026-04-04T10:00" });
    await render();
    await openDue(TIMED_TITLE);
    await pickPopupDay(picker(TIMED_TITLE)!, "2026-04-05");
    await typePopupTime(picker(TIMED_TITLE)!, "02:30");
    expect(pickerButton(TIMED_TITLE, "Apply")!.disabled).toBe(true);
    await pressInPopup(picker(TIMED_TITLE)!, "Later (UTC+10:00)");
    await applyPopup(picker(TIMED_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule.end).toEqual({ localCivil: "2026-04-05T02:30", disambiguation: "later" });
    expect(patchBody().schedule.schedule.start).toEqual({ localCivil: "2026-04-04T09:00" });
  });

  it("R10 the open version survives a late refresh: the first PATCH still carries the version the editor opened at", async () => {
    await render();
    await openDue(RANGE_TITLE);
    // The server moves on while the picker is open; the controller holds its accepted baseline.
    rows[0]!.schedule = range(4, startMoment(sydneyDay(1)), endMoment(sydneyDay(6)));
    await act(async () => { await client.invalidateQueries({ queryKey: ["production-gantt"] }); });
    await flush(4);
    expect(patches()).toHaveLength(0);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    patchReply = () => ({ status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: rows[0]!.schedule } });
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patchBody().schedule.expectedVersion).toBe(1);
  });

  it("R11 a version conflict keeps the draft, never retries, shows the latest, and an explicit Save resends at the latest version", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));

    patchReply = null;
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    expect(patchBody(1).schedule.schedule.end).toEqual({ localCivil: `${sydneyDay(5)}T17:00` });
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Tue 15 Sep · 17:00"));
  });

  it("R12 Use latest discards the draft with no second write, shows the latest end, and releases the gate", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    await pressInPopup(picker(RANGE_TITLE)!, "Use latest schedule (discard draft)");
    await flush(6);

    expect(patches()).toHaveLength(1);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Fri 18 Sep · 17:00"));
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(dueTrigger(RANGE_TITLE)!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("R13 a later-page row's conflict adopts the body's current schedule (the refetch never returns it): no stale retry, later-page cell converges", async () => {
    pageTwo = [{ id: PAGE_TWO_ID, title: PAGE_TWO_TITLE, position: 2, canOpenScheduleEditor: true, schedule: range(1, startMoment(sydneyDay(2)), endMoment(sydneyDay(4))) }];
    await render();
    await waitFor(() => expect(dueTrigger(PAGE_TWO_TITLE)).not.toBeNull());
    await openDue(PAGE_TWO_TITLE);
    await pickPopupDay(picker(PAGE_TWO_TITLE)!, sydneyDay(6));
    const winner = range(3, startMoment(sydneyDay(2)), endMoment(sydneyDay(9)));
    patchReply = () => { pageTwo[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(picker(PAGE_TWO_TITLE)!);
    await flush(1);
    await flush(5);

    expect(patches()).toHaveLength(1);
    expect(picker(PAGE_TWO_TITLE)!.textContent).toContain("Latest schedule · v3");
    patchReply = null;
    await applyPopup(picker(PAGE_TWO_TITLE)!);
    await flush(8);
    // The retry used the body's version, not the stale one the page-two source carried.
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    await waitFor(() => expect(dueText(PAGE_TWO_TITLE)).toBe("Wed 16 Sep · 17:00"));
  });

  it("R13b a 409 whose authoritative refetch is still in flight keeps the Due-cell draft: the reopened picker shows the user's End and reminder, not the latest ones", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    await click(pickerButton(RANGE_TITLE, "4 hours")!);
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    const gate = deferred<void>();
    getGate = gate.promise;
    await applyPopup(picker(RANGE_TITLE)!);
    // The PATCH has answered 409; the refetch GET is held. Let several renders and microtasks pass.
    await flush(6);
    await flush(6);
    expect(patches()).toHaveLength(1);
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    await flush(8);

    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
    expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  // #585: Escape and an outside press keep the conflicted draft and its notice (Gantt-owned stash); only Cancel and Use latest discard.
  it("R13c a 409 reopens the Due-cell picker with the draft; after Escape and a reopen the draft and the latest-schedule notice survive, and a reapply is one PATCH at the latest version", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("escape");
    await openDue(RANGE_TITLE);
    await expectDraftAndReapply(3);
  });

  it("R13d a 409 reopens the Due-cell picker with the draft; after an outside press and a reopen the draft and notice survive, and a reapply is one PATCH at the latest version", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("outside");
    await openDue(RANGE_TITLE);
    await expectDraftAndReapply(3);
  });

  it("R13d2 a real outside press on another focusable control counts as a dismiss, not a discard", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("control");
    await openDue(RANGE_TITLE);
    await expectDraftAndReapply(3);
  });

  it("R13e Escape, reopen, then Cancel discards the draft: the next open shows the stored v3 with no notice", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("escape");
    await openDue(RANGE_TITLE);
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    await pressInPopup(picker(RANGE_TITLE)!, "Cancel");
    await flush(6);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    await openDue(RANGE_TITLE);
    expect(picker(RANGE_TITLE)!.textContent).not.toContain("Latest schedule");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(8), "17:00"));
    expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).not.toBe("true");
    expect(patches()).toHaveLength(1);
  });

  it("R13f Escape, reopen, then Use latest sends nothing more and clears the stash: the next open has no notice", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("escape");
    await openDue(RANGE_TITLE);
    await pressInPopup(picker(RANGE_TITLE)!, "Use latest schedule (discard draft)");
    await flush(6);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    expect(patches()).toHaveLength(1);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    await openDue(RANGE_TITLE);
    expect(picker(RANGE_TITLE)!.textContent).not.toContain("Latest schedule");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(8), "17:00"));
  });

  it("R13g a refetch that brings v4 while the picker is dismissed makes the reopened notice name v4, and the reapply is a PATCH at v4", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("escape");
    rows[0]!.schedule = range(4, startMoment(sydneyDay(1)), endMoment(sydneyDay(9)));
    await act(async () => { await client.invalidateQueries(); });
    await flush(8);
    await openDue(RANGE_TITLE);
    await expectDraftAndReapply(4);
  });

  it("R13h an item conflict keeps its latest-item notice and the draft through Escape and a reopen", async () => {
    await render();
    await conflictOnDue(itemConflict);
    await dismissDue("escape");
    await openDue(RANGE_TITLE);
    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest checklist item · schedule v3");
    expect(picker(RANGE_TITLE)!.textContent).toContain("Complete");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
    expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("R13i editing another Subtask between the dismiss and the reopen keeps the first Subtask's stash", async () => {
    await render();
    await conflictOnDue();
    await dismissDue("escape");
    await openDue(TIMED_TITLE);
    await saveEnd(TIMED_TITLE, sydneyDay(4));
    await waitFor(() => expect(picker(TIMED_TITLE)).toBeNull());
    expect(patches()).toHaveLength(2);
    await openDue(RANGE_TITLE);
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
    expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("R14 a full-item conflict retains the draft and presents the latest item (names and count only)", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await pickPopupDay(picker(RANGE_TITLE)!, sydneyDay(5));
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => {
      rows[0]!.schedule = winner;
      return { status: 409, body: { error: "conflict", code: "subtask_item_conflict", current: winner, currentSubtask: { id: RANGE_ID, title: RANGE_TITLE, done: true, position: 0, schedule: winner } } };
    };
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest checklist item · schedule v3");
    expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
    await pressInPopup(picker(RANGE_TITLE)!, "Use latest item (discard draft)");
    await flush(6);
    expect(patches()).toHaveLength(1);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
  });

  it("R15 the owning editor's own fields stay usable while its open session freezes the rest of the chart", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
    // Other Subtask rows and the chart are frozen (the trigger keeps focus but will not open a second editor)...
    expect(dueTrigger(TIMED_TITLE)!.getAttribute("aria-disabled")).toBe("true");
    // ...while this editor's own controls are live.
    expect(pickerButton(RANGE_TITLE, "End")!.disabled).toBe(false);
    expect(pickerButton(RANGE_TITLE, "Apply")!.disabled).toBe(false);
    expect(pickerButton(RANGE_TITLE, "Cancel")!.disabled).toBe(false);
    await click(dueTrigger(TIMED_TITLE)!);
    expect(picker(TIMED_TITLE)).toBeNull();
  });

  it("R16 the Due trigger is unavailable for the whole of a pointer drag and returns when it ends", async () => {
    await render();
    expect(dueTrigger(RANGE_TITLE)!.getAttribute("aria-disabled")).not.toBe("true");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect);
    const grip = host.querySelector<HTMLElement>(`[data-gantt-resource="task:${RANGE_ID}"] [data-testid="gantt-resize-handle-end"]`)!;
    await pointerEvent(grip, "pointerdown", { pointerId: 7, button: 0, clientX: 300, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 7, clientX: 500, clientY: 10 });
    expect(dueTrigger(RANGE_TITLE)!.getAttribute("aria-disabled")).toBe("true");
    await click(dueTrigger(RANGE_TITLE)!);
    expect(picker(RANGE_TITLE)).toBeNull();
    await pointerEvent(window, "pointercancel", { pointerId: 7, clientX: 500, clientY: 10 });
    await flush(3);
    await waitFor(() => expect(dueTrigger(RANGE_TITLE)!.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("R17 the Due trigger is unavailable during the save's own settle refetch, and no second editor can open", async () => {
    await render();
    const gate = deferred<void>();
    await openDue(RANGE_TITLE);
    getGate = gate.promise;
    await saveEnd(RANGE_TITLE, sydneyDay(4));
    expect(patches()).toHaveLength(1);
    expect(dueTrigger(TIMED_TITLE)!.getAttribute("aria-disabled")).toBe("true");
    await click(dueTrigger(TIMED_TITLE)!);
    expect(picker(TIMED_TITLE)).toBeNull();
    gate.resolve();
    await flush(6);
    await waitFor(() => expect(dueTrigger(TIMED_TITLE)!.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("R18 a 401 or 403 is access loss: one report, the picker closes, nothing is toasted", async () => {
    await render();
    await openDue(RANGE_TITLE);
    patchReply = () => ({ status: 403, body: { error: "forbidden" } });
    await saveEnd(RANGE_TITLE, sydneyDay(4));
    expect(patches()).toHaveLength(1);
    expect(onAccessLoss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
    expect(toasts().join(" ")).not.toContain("could not");
  });

  it("R19 the controller's schedule editor sheet is not opened by the Gantt (its inline picker is the only editor)", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(document.body.querySelector('[data-testid="event-calendar-schedule-editor"]')).toBeNull();
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(liveRegionText()).not.toBe("");
  });

  it("R21 a background refetch that fails while the picker is open replaces the chart and releases the gate", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
    getFails = true;
    await act(async () => { await client.refetchQueries({ queryKey: ["production-gantt"] }); });
    await flush(4);
    await waitFor(() => expect(host.textContent).toContain("The production schedule is unavailable."));
    expect(picker(RANGE_TITLE)).toBeNull();
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(patches()).toHaveLength(0);
  });

  it("R20 the Due column is not rendered at 720px and returns at 721px, and an open picker cannot strand the gate when it narrows", async () => {
    const original = window.matchMedia;
    let narrow = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() { return query === "(max-width: 720px)" ? narrow : false; },
      media: query,
      addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      await render();
      expect(dueCells().length).toBeGreaterThan(0);
      await openDue(RANGE_TITLE);
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
      narrow = true;
      await act(async () => { listeners.forEach((listener) => listener()); await Promise.resolve(); });
      await flush(4);
      expect(dueCells()).toHaveLength(0);
      await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    } finally { window.matchMedia = original; }
  });
});

describe("ProductionGantt — Subtask Due cell reminders (#425)", () => {
  const chip = (title: string, name: string) => pickerButton(title, name)!;

  it("G1 the popup shows the row's stored set; a reminders-only edit is one PATCH at the open version, range unchanged", async () => {
    storedOffsets[RANGE_ID] = [60];
    await render();
    await openDue(RANGE_TITLE);
    expect(chip(RANGE_TITLE, "1 hour").getAttribute("aria-pressed")).toBe("true");
    expect(chip(RANGE_TITLE, "1 day").getAttribute("aria-pressed")).toBe("false");
    await click(chip(RANGE_TITLE, "4 hours"));
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.expectedVersion).toBe(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00` }, end: { localCivil: `${sydneyDay(3)}T17:00` } });
    expect(patchBody().schedule.reminderOffsetsMinutes).toEqual([240, 60]);
  });

  it("G2 Undo after a reminders-only edit restores the prior offsets", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await click(chip(RANGE_TITLE, "4 hours"));
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(storedOffsets[RANGE_ID]).toEqual([1440, 240]);
    expect(undoButtons()).toHaveLength(1);
    await click(undoButtons()[0]!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(2);
    expect(patchBody(1).schedule.reminderOffsetsMinutes).toEqual([1440]);
    expect(storedOffsets[RANGE_ID]).toEqual([1440]);
  });

  it("G3 a range-only edit, and its Undo, leave the offsets out of the request", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await saveEnd(RANGE_TITLE, sydneyDay(5));
    expect(patchBody().schedule).not.toHaveProperty("reminderOffsetsMinutes");
    await click(undoButtons()[0]!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule).not.toHaveProperty("reminderOffsetsMinutes");
  });

  it("G4 a conflict shows the latest reminders; Apply reapplies the retained offsets at the latest version", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await click(chip(RANGE_TITLE, "4 hours"));
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(3)));
    patchReply = () => {
      rows[0]!.schedule = winner; storedOffsets[RANGE_ID] = [60];
      return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner, currentSubtask: { id: RANGE_ID, title: RANGE_TITLE, done: false, position: 0, schedule: winner, reminders: subtaskReminders([60]) } } };
    };
    await applyPopup(picker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    const conflict = picker(RANGE_TITLE)!;
    expect(conflict.textContent).toContain("Latest schedule · v3");
    expect(conflict.textContent).toContain("Reminders1 hour, Due now");
    expect(chip(RANGE_TITLE, "4 hours").getAttribute("aria-pressed")).toBe("true");
    expect(chip(RANGE_TITLE, "1 day").getAttribute("aria-pressed")).toBe("true");
    patchReply = null;
    await applyPopup(conflict);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    expect(patchBody(1).schedule.reminderOffsetsMinutes).toEqual([1440, 240]);
  });

  it("G5 a range-only conflict then reapply sends no offsets and shows the latest set", async () => {
    await render();
    await openDue(RANGE_TITLE);
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(3)));
    patchReply = () => {
      rows[0]!.schedule = winner; storedOffsets[RANGE_ID] = [60];
      return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner, currentSubtask: { id: RANGE_ID, title: RANGE_TITLE, done: false, position: 0, schedule: winner, reminders: subtaskReminders([60]) } } };
    };
    await saveEnd(RANGE_TITLE, sydneyDay(5));
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule).not.toHaveProperty("reminderOffsetsMinutes");
    const conflict = picker(RANGE_TITLE)!;
    expect(chip(RANGE_TITLE, "1 hour").getAttribute("aria-pressed")).toBe("true");
    expect(chip(RANGE_TITLE, "1 day").getAttribute("aria-pressed")).toBe("false");
    patchReply = null;
    await applyPopup(conflict);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    expect(patchBody(1).schedule).not.toHaveProperty("reminderOffsetsMinutes");
    expect(storedOffsets[RANGE_ID]).toEqual([60]);
  });

  it("G6 a later-page row's conflict adopts the latest reminders too, so Undo after the reapply restores them, not the stale set", async () => {
    pageTwo = [{ id: PAGE_TWO_ID, title: PAGE_TWO_TITLE, position: 2, canOpenScheduleEditor: true, schedule: range(1, startMoment(sydneyDay(2)), endMoment(sydneyDay(4))) }];
    await render();
    await waitFor(() => expect(dueTrigger(PAGE_TWO_TITLE)).not.toBeNull());
    await openDue(PAGE_TWO_TITLE);
    await click(chip(PAGE_TWO_TITLE, "4 hours"));
    const winner = range(2, startMoment(sydneyDay(2)), endMoment(sydneyDay(4)));
    patchReply = () => {
      pageTwo[0]!.schedule = winner; storedOffsets[PAGE_TWO_ID] = [60];
      return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner, currentSubtask: { id: PAGE_TWO_ID, title: PAGE_TWO_TITLE, done: false, position: 2, schedule: winner, reminders: subtaskReminders([60]) } } };
    };
    await applyPopup(picker(PAGE_TWO_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    patchReply = null;
    await applyPopup(picker(PAGE_TWO_TITLE)!);
    await flush(8);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(2);
    expect(patchBody(1).schedule.reminderOffsetsMinutes).toEqual([1440, 240]);
    expect(undoButtons()).toHaveLength(1);
    await click(undoButtons()[0]!);
    await flush(8);
    expect(patches()).toHaveLength(3);
    expect(patchBody(2).schedule.expectedVersion).toBe(3);
    expect(patchBody(2).schedule.reminderOffsetsMinutes).toEqual([60]);
  });
});

describe("ProductionGantt — Edit schedule… on the bar (#582)", () => {
  /** The bar's picker is named with the street too: "Schedule for <title>, <street>". */
  const barPicker = (title: string) => dateTimePopup(`Schedule for ${title}, 1 Range Street`);
  const barPickerButton = (title: string, name: string) => (barPicker(title) ? popupButton(barPicker(title)!, name) : undefined);
  const itemMenuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label) ?? null;
  /** The item menu's route to the bar picker: activate the bar, pick Edit schedule…. */
  async function openFromBar(title: string) {
    const bar = findBar(title);
    await act(async () => { bar.focus(); await Promise.resolve(); });
    await click(bar);
    await waitFor(() => expect(itemMenuItem("Edit schedule…")).not.toBeNull());
    await act(async () => { itemMenuItem("Edit schedule…")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(barPicker(title)).not.toBeNull());
    await flush(3);
  }

  it("B1 a Start edit is ONE PATCH at the open version, and focus lands on the (re-keyed) bar", async () => {
    await render();
    await openFromBar(RANGE_TITLE);
    expect(rangeToggles(barPicker(RANGE_TITLE)!).active).toBe("Start");
    expect(document.body.querySelector('[data-testid="event-calendar-schedule-editor"]')).toBeNull();
    await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
    await applyPopup(barPicker(RANGE_TITLE)!);
    await flush(8);
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${RANGE_ID}`);
    expect(patchBody().schedule.expectedVersion).toBe(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(2)}T09:00` }, end: { localCivil: `${sydneyDay(3)}T17:00` } });
    await waitFor(() => expect(barPicker(RANGE_TITLE)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(findBar(RANGE_TITLE)));
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
  });

  it("B2 a version conflict reopens the picker on the bar with the Use latest notice, and Use latest releases the gate with no second write", async () => {
    await render();
    await openFromBar(RANGE_TITLE);
    await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(barPicker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(barPicker(RANGE_TITLE)).not.toBeNull();
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    // Still the bar's picker (the Due cell has no popup of its own).
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await pressInPopup(barPicker(RANGE_TITLE)!, "Use latest schedule (discard draft)");
    await flush(6);
    expect(patches()).toHaveLength(1);
    await waitFor(() => expect(barPicker(RANGE_TITLE)).toBeNull());
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
  });

  it("B3 a reminders-only edit is one PATCH at the open version, range unchanged", async () => {
    await render();
    await openFromBar(RANGE_TITLE);
    await click(barPickerButton(RANGE_TITLE, "4 hours")!);
    await applyPopup(barPicker(RANGE_TITLE)!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.expectedVersion).toBe(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { localCivil: `${sydneyDay(1)}T09:00` }, end: { localCivil: `${sydneyDay(3)}T17:00` } });
    expect(patchBody().schedule.reminderOffsetsMinutes).toEqual([1440, 240]);
  });

  it("B4 narrowing to 720px cancels a Due-cell picker but a bar picker survives it", async () => {
    const original = window.matchMedia;
    let narrow = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() { return query === "(max-width: 720px)" ? narrow : false; },
      media: query,
      addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const narrowNow = async () => { narrow = true; await act(async () => { listeners.forEach((listener) => listener()); await Promise.resolve(); }); await flush(4); };
    try {
      await render();
      await openDue(RANGE_TITLE);
      await narrowNow();
      await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);

      narrow = false;
      await act(async () => { listeners.forEach((listener) => listener()); await Promise.resolve(); });
      await flush(4);
      await openFromBar(RANGE_TITLE);
      await narrowNow();
      expect(barPicker(RANGE_TITLE)).not.toBeNull();
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
      await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
      await applyPopup(barPicker(RANGE_TITLE)!);
      await flush(8);
      expect(patches()).toHaveLength(1);
    } finally { window.matchMedia = original; }
  });

  it("B5 a later-page row's conflict adopts the body's current schedule on the bar picker: no stale retry, the later-page bar picker converges", async () => {
    pageTwo = [{ id: PAGE_TWO_ID, title: PAGE_TWO_TITLE, position: 2, canOpenScheduleEditor: true, schedule: range(1, startMoment(sydneyDay(2)), endMoment(sydneyDay(4))) }];
    await render();
    await waitFor(() => expect(findBar(PAGE_TWO_TITLE)).toBeTruthy());
    await openFromBar(PAGE_TWO_TITLE);
    await pickPopupDay(barPicker(PAGE_TWO_TITLE)!, sydneyDay(6));
    const winner = range(3, startMoment(sydneyDay(2)), endMoment(sydneyDay(9)));
    patchReply = () => { pageTwo[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(barPicker(PAGE_TWO_TITLE)!);
    await flush(1);
    await flush(5);

    expect(patches()).toHaveLength(1);
    expect(barPicker(PAGE_TWO_TITLE)!.textContent).toContain("Latest schedule · v3");
    patchReply = null;
    await applyPopup(barPicker(PAGE_TWO_TITLE)!);
    await flush(8);
    // The retry used the body's version, not the stale one the page-two source carried.
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    await waitFor(() => expect(barPicker(PAGE_TWO_TITLE)).toBeNull());
    await waitFor(() => expect(dueText(PAGE_TWO_TITLE)).toBe("Wed 16 Sep · 17:00"));
  });

  it("B6 a 409 that answers late reopens the bar picker on the user's edited Start and reminder, not the stored or latest ones", async () => {
    await render();
    await openFromBar(RANGE_TITLE);
    await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
    await click(barPickerButton(RANGE_TITLE, "4 hours")!);
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    patchReply = async () => { await held; rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await applyPopup(barPicker(RANGE_TITLE)!);
    // The request is pending: let several renders and microtasks pass before it answers.
    await flush(6);
    await flush(6);
    expect(patches()).toHaveLength(1);
    await act(async () => { release(); await Promise.resolve(); });
    await flush(8);

    expect(patches()).toHaveLength(1);
    const reopened = barPicker(RANGE_TITLE);
    expect(reopened).not.toBeNull();
    expect(reopened!.textContent).toContain("Latest schedule · v3");
    expect(reopened!.textContent).toContain("StartSat 12 Sep · 09:00");
    expect(reopened!.textContent).not.toContain("StartFri 11 Sep");
    expect(barPickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("B7 a 409 whose authoritative refetch is still in flight keeps the bar picker's draft: the reopened picker shows the user's Start and reminder", async () => {
    await render();
    await openFromBar(RANGE_TITLE);
    await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
    await click(barPickerButton(RANGE_TITLE, "4 hours")!);
    const winner = range(3, startMoment(sydneyDay(1)), endMoment(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    const gate = deferred<void>();
    getGate = gate.promise;
    await applyPopup(barPicker(RANGE_TITLE)!);
    // The PATCH has answered 409; the refetch GET is held. Let several renders and microtasks pass.
    await flush(6);
    await flush(6);
    expect(patches()).toHaveLength(1);
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    await flush(8);

    expect(patches()).toHaveLength(1);
    const reopened = barPicker(RANGE_TITLE);
    expect(reopened).not.toBeNull();
    expect(reopened!.textContent).toContain("Latest schedule · v3");
    expect(reopened!.textContent).toContain("StartSat 12 Sep · 09:00");
    expect(reopened!.textContent).not.toContain("StartFri 11 Sep");
    expect(barPickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  /** The bar picker's conflicted state: Start on day 2 and "4 hours" drafted, answered 409 with v3. */
  async function conflictOnBar() {
    await openFromBar(RANGE_TITLE);
    await pickPopupDay(barPicker(RANGE_TITLE)!, sydneyDay(2));
    await click(barPickerButton(RANGE_TITLE, "4 hours")!);
    const winner = winnerV3();
    patchReply = () => scheduleConflict(winner);
    await applyPopup(barPicker(RANGE_TITLE)!);
    await flush(8);
    patchReply = null;
    expect(patches()).toHaveLength(1);
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("StartSat 12 Sep · 09:00");
  }
  async function dismissBar(how: "escape" | "outside") {
    if (how === "escape") await keydown(document.activeElement ?? document.body, "Escape");
    else await outsidePress();
    await flush(3);
    await waitFor(() => expect(barPicker(RANGE_TITLE)).toBeNull());
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
  }
  async function expectBarDraftAndReapply() {
    expect(patches()).toHaveLength(1);
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("StartSat 12 Sep · 09:00");
    expect(barPickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
    await applyPopup(barPicker(RANGE_TITLE)!);
    await flush(8);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
  }

  // #585: Escape and an outside press keep the conflicted draft and its notice; only Cancel and Use latest discard.
  it("B8 a 409 reopens the bar picker with the draft; after Escape and a reopen via Edit schedule… the draft and notice survive, and a reapply is one PATCH at v3", async () => {
    await render();
    await conflictOnBar();
    await dismissBar("escape");
    await openFromBar(RANGE_TITLE);
    await expectBarDraftAndReapply();
  });

  it("B9 a 409 reopens the bar picker with the draft; after an outside press and a reopen via Edit schedule… the draft and notice survive, and a reapply is one PATCH at v3", async () => {
    await render();
    await conflictOnBar();
    await dismissBar("outside");
    await openFromBar(RANGE_TITLE);
    await expectBarDraftAndReapply();
  });

  it("B10 the two pickers share one holder: a bar picker dismissed on a conflict reopens from the Due cell with the same draft and notice, and the reverse", async () => {
    await render();
    await conflictOnBar();
    await dismissBar("escape");
    await openDue(RANGE_TITLE);
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(startText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(2), "09:00"));
    expect(pickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
    await pressInPopup(picker(RANGE_TITLE)!, "Cancel");
    await flush(6);
    await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());

    // Reverse: conflict on the Due cell, Escape, reopen from the bar.
    resetFixture();
    requests = [];
    await act(async () => { await client.invalidateQueries(); });
    await flush(8);
    await conflictOnDue();
    await dismissDue("escape");
    await openFromBar(RANGE_TITLE);
    expect(barPicker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(rangeToggles(barPicker(RANGE_TITLE)!).end).toBe(rangeMoment(sydneyDay(5), "17:00"));
    expect(barPickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("B11 a dismissed conflict keeps its stash when the chart narrows to 720px: the bar picker reopens with the draft, and a narrowed Due picker is dismissed, not discarded", async () => {
    const original = window.matchMedia;
    let narrow = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() { return query === "(max-width: 720px)" ? narrow : false; },
      media: query,
      addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const setNarrow = async (next: boolean) => { narrow = next; await act(async () => { listeners.forEach((listener) => listener()); await Promise.resolve(); }); await flush(4); };
    try {
      await render();
      // A Due picker with a conflict is cancelled by narrowing, but the conflict context is kept.
      await conflictOnDue();
      await setNarrow(true);
      await waitFor(() => expect(picker(RANGE_TITLE)).toBeNull());
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
      // A bar picker reopened at the narrow width still shows it.
      await openFromBar(RANGE_TITLE);
      expect(barPicker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
      expect(barPickerButton(RANGE_TITLE, "4 hours")!.getAttribute("aria-pressed")).toBe("true");
      await dismissBar("escape");
      await setNarrow(false);
      await openDue(RANGE_TITLE);
      expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
      expect(endText(RANGE_TITLE)).toBe(rangeMoment(sydneyDay(5), "17:00"));
    } finally { window.matchMedia = original; }
  });
});
