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

const dateEndpoint = (localCivil: string): ChecklistScheduleEndpointDto => ({ kind: "date", localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" });
function timedEndpoint(localCivil: string, disambiguation?: "earlier" | "later"): ChecklistScheduleEndpointDto {
  const resolved = resolveSydneyCivilMinute(localCivil, disambiguation);
  if (!resolved.ok) throw new Error(`fixture civil did not resolve: ${localCivil}`);
  return { kind: "timed", localCivil, instant: resolved.value.instant, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, resolution: "stored" };
}
const range = (version: number, start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto): ChecklistScheduleDto => ({ state: "range", version, zone: PRODUCTION_GANTT_ZONE, start, end, due: end.localCivil });

type Row = { id: string; title: string; position: number; schedule: ChecklistScheduleDto; canOpenScheduleEditor: boolean };
type ScheduleInput = { state: string; start?: { kind: string; localCivil: string; disambiguation?: "earlier" | "later" }; end?: { kind: string; localCivil: string; disambiguation?: "earlier" | "later" } };
type PatchBody = { schedule: { expectedVersion: number; schedule: ScheduleInput } };

/** The server's view: PATCH mutates it, GET reads it. */
let rows: Row[];
let pageTwo: Row[];

function resetFixture(options: { canOpenScheduleEditor?: boolean; timedStart?: string; timedEnd?: string } = {}) {
  const can = options.canOpenScheduleEditor ?? true;
  rows = [
    { id: RANGE_ID, title: RANGE_TITLE, position: 0, canOpenScheduleEditor: can, schedule: range(1, dateEndpoint(sydneyDay(1)), dateEndpoint(sydneyDay(3))) },
    { id: TIMED_ID, title: TIMED_TITLE, position: 1, canOpenScheduleEditor: can, schedule: range(1, timedEndpoint(options.timedStart ?? `${sydneyDay(2)}T09:00`), timedEndpoint(options.timedEnd ?? `${sydneyDay(2)}T17:00`)) },
  ];
  pageTwo = [];
}

function childRow(row: Row) {
  return {
    id: row.id, projectId: PROJECT_ID, title: row.title, done: false, position: row.position, assignee: null, assignees: [], otherAssigneeCount: 0, assignmentVersion: 1,
    schedule: row.schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: row.canOpenScheduleEditor, canEditAssignees: true },
  };
}

function ganttResponse() {
  const shoot = sydneyDay(-1);
  const total = rows.length + pageTwo.length;
  return adminProductionGanttResponseSchema.parse({
    scope: "active", zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [{
      id: PROJECT_ID, street: "1 Range Street", suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false,
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

function scheduleFromInput(input: ScheduleInput, version: number): ChecklistScheduleDto {
  const endpoint = (value: ScheduleInput["end"]) => (value ? (value.kind === "timed" ? timedEndpoint(value.localCivil, value.disambiguation) : dateEndpoint(value.localCivil)) : null);
  const start = endpoint(input.start);
  const end = endpoint(input.end);
  if (!start || !end) throw new Error("fixture: a range PATCH must carry both endpoints");
  return range(version, start, end);
}

function echoPatch(body: PatchBody, subtaskId: string): Reply {
  const row = [...rows, ...pageTwo].find((candidate) => candidate.id === subtaskId)!;
  const schedule = scheduleFromInput(body.schedule.schedule, body.schedule.expectedVersion + 1);
  row.schedule = schedule;
  return { status: 200, body: { id: row.id, title: row.title, done: false, assignee: null, position: row.position, schedule } };
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
const picker = (title: string) => document.querySelector<HTMLElement>(`[role="group"][aria-label="Schedule for ${title}"]`);
const fieldset = (title: string, which: "Start" | "End") => [...(picker(title)?.querySelectorAll("fieldset") ?? [])].find((set) => set.querySelector("legend")?.textContent === which) ?? null;
const dateInput = (title: string, which: "Start" | "End") => fieldset(title, which)?.querySelector<HTMLInputElement>('input[type="date"]') ?? null;
const timeInput = (title: string, which: "Start" | "End") => fieldset(title, which)?.querySelector<HTMLInputElement>('input[type="time"]') ?? null;
const pickerButton = (title: string, name: string) => [...(picker(title)?.querySelectorAll("button") ?? [])].find((el) => el.textContent === name) as HTMLButtonElement | undefined;
const undoButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="toast-action"]')];
const toasts = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="toast"]')].map((el) => el.textContent ?? "");
const liveRegionText = () => host.querySelector('[data-testid="production-gantt-live-region"]')?.textContent ?? "";

async function click(el: HTMLElement) { await act(async () => { el.click(); await Promise.resolve(); }); }
async function setInput(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}
async function keydown(el: EventTarget, key: string) { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })); await Promise.resolve(); }); }
async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) { await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })); await Promise.resolve(); }); }
async function openDue(title: string) {
  await click(dueTrigger(title)!);
  await waitFor(() => expect(picker(title)).not.toBeNull());
  await flush(2);
}
/** Types a new End date into the open picker and presses Save. */
async function saveEnd(title: string, date: string) {
  await setInput(dateInput(title, "End")!, date);
  await click(pickerButton(title, "Save")!);
  await flush(6);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T02:00:00.000Z"));
  resetFixture();
  requests = [];
  patchReply = null;
  getGate = null;
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
  it("R1 shows the range END in the Due column, 'Fri 11 Sep' style for a date and with the Sydney wall time for a timed end", async () => {
    await render();
    // 2026-09-13 is a Sunday; the timed row ends Sat 12 Sep at 17:00.
    expect(dueText(RANGE_TITLE)).toBe("Sun 13 Sep");
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
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(5));
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(2);

    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toBe(`/api/projects/${PROJECT_ID}/subtasks/${RANGE_ID}`);
    expect(patchBody().schedule.expectedVersion).toBe(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: sydneyDay(1) }, end: { kind: "date", localCivil: sydneyDay(5) } });
    // The bar previews the new end while the request is held.
    expect(barLabel(RANGE_TITLE)).not.toBe(before);

    held.resolve({ status: 200, body: null });
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(dueText(RANGE_TITLE)).toBe("Tue 15 Sep");
    expect(barLabel(RANGE_TITLE)).not.toBe(before);
    expect(toasts().join(" ")).toContain("Schedule saved.");
    expect(undoButtons()).toHaveLength(1);

    patchReply = null;
    await click(undoButtons()[0]!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(2);
    expect(patchBody(1).schedule.schedule).toEqual({ state: "range", start: { kind: "date", localCivil: sydneyDay(1) }, end: { kind: "date", localCivil: sydneyDay(3) } });
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Sun 13 Sep"));
    expect(barLabel(RANGE_TITLE)).toBe(before);
  });

  it("R3 a timed End keeps the unchanged timed Start and its Sydney wall time on the wire", async () => {
    await render();
    await openDue(TIMED_TITLE);
    await setInput(timeInput(TIMED_TITLE, "End")!, "18:30");
    await click(pickerButton(TIMED_TITLE, "Save")!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule).toEqual({ state: "range", start: { kind: "timed", localCivil: `${sydneyDay(2)}T09:00` }, end: { kind: "timed", localCivil: `${sydneyDay(2)}T18:30` } });
    await waitFor(() => expect(dueText(TIMED_TITLE)).toBe("Sat 12 Sep · 18:30"));
  });

  it("R4 the picker opens with focus on End; Cancel and Escape return focus to the Due trigger and send nothing", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(document.activeElement).toBe(dateInput(RANGE_TITLE, "End"));
    await click(pickerButton(RANGE_TITLE, "Cancel")!);
    await flush(3);
    expect(picker(RANGE_TITLE)).toBeNull();
    expect(document.activeElement).toBe(dueTrigger(RANGE_TITLE));

    await openDue(RANGE_TITLE);
    await keydown(document.activeElement ?? document.body, "Escape");
    await flush(3);
    expect(picker(RANGE_TITLE)).toBeNull();
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

  it("R6 an End before the Start is refused with the picker's message and sends no PATCH; the draft stays open", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(0));
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(4);
    expect(patches()).toHaveLength(0);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.querySelector('[role="alert"]')?.textContent ?? "").toMatch(/end/i);
    expect(dateInput(RANGE_TITLE, "End")!.value).toBe(sydneyDay(0));
    expect(dateInput(RANGE_TITLE, "Start")!.value).toBe(sydneyDay(1));

    // The same day is one inclusive day: accepted.
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(1));
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule.end).toEqual({ kind: "date", localCivil: sydneyDay(1) });
  });

  it("R7 a timed End equal to its Start is refused before any PATCH", async () => {
    await render();
    await openDue(TIMED_TITLE);
    await setInput(timeInput(TIMED_TITLE, "End")!, "09:00");
    await click(pickerButton(TIMED_TITLE, "Save")!);
    await flush(4);
    expect(patches()).toHaveLength(0);
    expect(picker(TIMED_TITLE)).not.toBeNull();
  });

  it("R8 a viewer without schedule access sees the end as plain text: no trigger, no picker, no request", async () => {
    resetFixture({ canOpenScheduleEditor: false });
    await render();
    expect(dueTrigger(RANGE_TITLE)).toBeNull();
    const plain = dueCells().find((cell) => cell.textContent === "Sun 13 Sep");
    expect(plain?.tagName).toBe("TIME");
    expect(host.querySelectorAll('[data-testid="gantt-subtask-due"] button')).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });

  it("R9 a repeated Sydney hour keeps the fold choice in the picker and sends it", async () => {
    // Sun 5 Apr 2026: clocks go back at 03:00, so 02:30 happens twice.
    resetFixture({ timedStart: "2026-04-04T09:00", timedEnd: "2026-04-04T10:00" });
    await render();
    await openDue(TIMED_TITLE);
    await setInput(dateInput(TIMED_TITLE, "End")!, "2026-04-05");
    await setInput(timeInput(TIMED_TITLE, "End")!, "02:30");
    await click(pickerButton(TIMED_TITLE, "Save")!);
    await flush(4);
    expect(patches()).toHaveLength(0);
    expect(picker(TIMED_TITLE)).not.toBeNull();
    const radios = [...picker(TIMED_TITLE)!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(dateInput(TIMED_TITLE, "End")!.value).toBe("2026-04-05");
    await click(radios[1]!);
    await click(pickerButton(TIMED_TITLE, "Save")!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(patchBody().schedule.schedule.end).toEqual({ kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" });
    expect(patchBody().schedule.schedule.start).toEqual({ kind: "timed", localCivil: "2026-04-04T09:00" });
  });

  it("R10 the open version survives a late refresh: the first PATCH still carries the version the editor opened at", async () => {
    await render();
    await openDue(RANGE_TITLE);
    // The server moves on while the picker is open; the controller holds its accepted baseline.
    rows[0]!.schedule = range(4, dateEndpoint(sydneyDay(1)), dateEndpoint(sydneyDay(6)));
    await act(async () => { await client.invalidateQueries({ queryKey: ["production-gantt"] }); });
    await flush(4);
    expect(patches()).toHaveLength(0);
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(5));
    patchReply = () => ({ status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: rows[0]!.schedule } });
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);
    expect(patchBody().schedule.expectedVersion).toBe(1);
  });

  it("R11 a version conflict keeps the draft, never retries, shows the latest, and an explicit Save resends at the latest version", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(5));
    const winner = range(3, dateEndpoint(sydneyDay(1)), dateEndpoint(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest schedule · v3");
    expect(dateInput(RANGE_TITLE, "End")!.value).toBe(sydneyDay(5));

    patchReply = null;
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    expect(patchBody(1).schedule.schedule.end).toEqual({ kind: "date", localCivil: sydneyDay(5) });
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Tue 15 Sep"));
  });

  it("R12 Use latest discards the draft with no second write, shows the latest end, and releases the gate", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(5));
    const winner = range(3, dateEndpoint(sydneyDay(1)), dateEndpoint(sydneyDay(8)));
    patchReply = () => { rows[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);
    await click(pickerButton(RANGE_TITLE, "Use latest schedule (discard draft)")!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).toBeNull();
    await waitFor(() => expect(dueText(RANGE_TITLE)).toBe("Fri 18 Sep"));
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    expect(dueTrigger(RANGE_TITLE)!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("R13 a later-page row's conflict adopts the body's current schedule (the refetch never returns it): no stale retry, later-page cell converges", async () => {
    pageTwo = [{ id: PAGE_TWO_ID, title: PAGE_TWO_TITLE, position: 2, canOpenScheduleEditor: true, schedule: range(1, dateEndpoint(sydneyDay(2)), dateEndpoint(sydneyDay(4))) }];
    await render();
    await waitFor(() => expect(dueTrigger(PAGE_TWO_TITLE)).not.toBeNull());
    await openDue(PAGE_TWO_TITLE);
    await setInput(dateInput(PAGE_TWO_TITLE, "End")!, sydneyDay(6));
    const winner = range(3, dateEndpoint(sydneyDay(2)), dateEndpoint(sydneyDay(9)));
    patchReply = () => { pageTwo[0]!.schedule = winner; return { status: 409, body: { error: "conflict", code: "subtask_schedule_version_conflict", current: winner } }; };
    await click(pickerButton(PAGE_TWO_TITLE, "Save")!);
    await flush(6);

    expect(patches()).toHaveLength(1);
    expect(picker(PAGE_TWO_TITLE)!.textContent).toContain("Latest schedule · v3");
    patchReply = null;
    await click(pickerButton(PAGE_TWO_TITLE, "Save")!);
    await flush(8);
    // The retry used the body's version, not the stale one the page-two source carried.
    expect(patches()).toHaveLength(2);
    expect(patchBody(1).schedule.expectedVersion).toBe(3);
    await waitFor(() => expect(dueText(PAGE_TWO_TITLE)).toBe("Wed 16 Sep"));
  });

  it("R14 a full-item conflict retains the draft and presents the latest item (names and count only)", async () => {
    await render();
    await openDue(RANGE_TITLE);
    await setInput(dateInput(RANGE_TITLE, "End")!, sydneyDay(5));
    const winner = range(3, dateEndpoint(sydneyDay(1)), dateEndpoint(sydneyDay(8)));
    patchReply = () => {
      rows[0]!.schedule = winner;
      return { status: 409, body: { error: "conflict", code: "subtask_item_conflict", current: winner, currentSubtask: { id: RANGE_ID, title: RANGE_TITLE, done: true, assignee: null, position: 0, schedule: winner } } };
    };
    await click(pickerButton(RANGE_TITLE, "Save")!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).not.toBeNull();
    expect(picker(RANGE_TITLE)!.textContent).toContain("Latest checklist item · schedule v3");
    expect(dateInput(RANGE_TITLE, "End")!.value).toBe(sydneyDay(5));
    await click(pickerButton(RANGE_TITLE, "Use latest item (discard draft)")!);
    await flush(6);
    expect(patches()).toHaveLength(1);
    expect(picker(RANGE_TITLE)).toBeNull();
  });

  it("R15 the owning editor's own fields stay usable while its open session freezes the rest of the chart", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
    // Other Subtask rows and the chart are frozen (the trigger keeps focus but will not open a second editor)...
    expect(dueTrigger(TIMED_TITLE)!.getAttribute("aria-disabled")).toBe("true");
    // ...while this editor's own controls are live.
    expect(dateInput(RANGE_TITLE, "End")!.disabled).toBe(false);
    expect(pickerButton(RANGE_TITLE, "Save")!.disabled).toBe(false);
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
    expect(picker(RANGE_TITLE)).toBeNull();
    expect(toasts().join(" ")).not.toContain("could not");
  });

  it("R19 the controller's schedule editor sheet is not opened by the Gantt (its inline picker is the only editor)", async () => {
    await render();
    await openDue(RANGE_TITLE);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(liveRegionText()).not.toBe("");
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
    })) as typeof window.matchMedia;
    try {
      await render();
      expect(dueCells().length).toBeGreaterThan(0);
      await openDue(RANGE_TITLE);
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(true);
      narrow = true;
      await act(async () => { listeners.forEach((listener) => listener()); await Promise.resolve(); });
      await flush(4);
      expect(dueCells()).toHaveLength(0);
      expect(picker(RANGE_TITLE)).toBeNull();
      expect(onAcceptGateChange).toHaveBeenLastCalledWith(false);
    } finally { window.matchMedia = original; }
  });
});
