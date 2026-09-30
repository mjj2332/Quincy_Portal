/**
 * #365 — the Gantt's People and Due columns: an Admin adds and removes a team member and changes
 * the Deadline from the row itself, the row updates, and everyone else sees plain values.
 *
 * Harness = `ProjectHeaderDeadline.dom.test.tsx`'s: a real `ProjectQueryRuntime` (its constructor
 * registers itself on the client, so `invalidateProjectSurfaces` really refetches the Gantt — a bare
 * `QueryClientProvider` would silently skip it), a real `ConfirmModalHost`, and `lib/api` mocked at
 * the function level. The mocked server keeps its own state, so a write is visible on the next
 * Gantt page the way it is in production.
 *
 * No `[data-slot="…"]` selectors (`test-seam.guard.test.ts` guard F): everything is located by
 * `data-testid`, role or accessible name.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  adminProductionGanttResponseSchema,
  editorProductionGanttResponseSchema,
  externalProductionGanttSchema,
  PRODUCTION_GANTT_ZONE,
  type ProjectDeadlineSchedule,
  type Role,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import type { ProjectMember } from "../lib/project-data";
import { ConfirmModalHost } from "./ConfirmDialog";
import { ProductionGantt, type ProductionGanttProps } from "./ProductionGantt";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPutWithStatusMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiDeleteMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPut: (path: string, body: unknown) => apiPutMock(path, body),
  apiPutWithStatus: (path: string) => apiPutWithStatusMock(path),
  apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const STREET = "1 Team Street";
const uid = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
const PIA = uid(2);
const ELI = uid(3);
const ZED = uid(4);
const NEW_EDITOR = uid(5);

// Only `Date` is pinned (timers stay real) to a mid-month instant — see `ProductionGantt-readonly`.
const TODAY = new Date("2026-09-15T02:00:00.000Z");
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

type Person = { id: string; name: string; roleLabel: string; isExternal: boolean; active: boolean; roleOnProject: "photographer" | "editor" };
const person = (id: string, name: string, roleOnProject: "photographer" | "editor", active = true): Person => ({ id, name, roleLabel: roleOnProject === "editor" ? "Editor" : "Photographer", isExternal: false, active, roleOnProject });

/** userId -> the membership-cycle id the "server" currently holds, when it differs from the default. */
const cycleOverrides = new Map<string, string>();
const membershipFor = (p: Person, index: number): ProjectMember => ({
  id: cycleOverrides.get(p.id) ?? `cycle-${index}`, userId: p.id, roleOnProject: p.roleOnProject, name: p.name, email: `${p.name.split(" ")[0]!.toLowerCase()}@example.test`,
  globalRole: p.roleOnProject, active: p.active, assignedSubtaskCount: 0,
} as ProjectMember);

type Server = {
  team: Person[];
  canEditTeam: boolean;
  canEditDeadline: boolean;
  delivered: boolean;
  deadline: { localCivil: string; at: string } | null;
  deadlineVersion: number;
  withTeamKeys: boolean;
  detailGate: Promise<void> | null;
  ganttGets: number;
  detailGets: number;
};
let server: Server;

function freshServer(): Server {
  return {
    team: [person(PIA, "Pia Photographer", "photographer"), person(ELI, "Eli Editor", "editor"), person(ZED, "Zed Inactive", "editor", false)],
    canEditTeam: true,
    canEditDeadline: true,
    delivered: false,
    deadline: { localCivil: `${isoDate(5)}T15:00`, at: `${isoDate(5)}T04:00:00.000Z` },
    deadlineVersion: 1,
    withTeamKeys: true,
    detailGate: null,
    ganttGets: 0,
    detailGets: 0,
  };
}

function scheduleOf(): ProjectDeadlineSchedule {
  return {
    version: server.deadlineVersion,
    deadline: server.deadline ? { localCivil: server.deadline.localCivil, zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 0, instant: server.deadline.at } : null,
    reminderOffsetsMinutes: [],
    state: server.deadline ? "scheduled" : "unset",
    nextOccurrence: null,
    canResume: false,
  };
}

function ganttBody() {
  const shoot = isoDate(0);
  return {
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [{
      id: PROJECT_ID, street: STREET, suburb: null, agencyName: null, agentName: null, stageKey: role === "admin" ? "editing_autohdr" : "editing", delivered: server.delivered,
      shootDate: shoot, shootDateCivil: shoot, createdAt: `${shoot}T00:00:00.000Z`, barStartDate: shoot,
      deadline: server.deadline ? { at: server.deadline.at, localCivil: server.deadline.localCivil, version: server.deadlineVersion, reminderOffsetsMinutes: [], overdue: false } : null,
      deadlineVersion: server.deadlineVersion,
      editors: [],
      checklist: { completed: 0, total: 0 },
      ...(server.withTeamKeys ? { team: server.team } : {}),
      permissions: { canEditDeadline: server.canEditDeadline, canEditChildren: true, ...(server.withTeamKeys ? { canEditTeam: server.canEditTeam } : {}) },
      children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    }],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  };
}

const parsers: Partial<Record<Role, (value: unknown) => unknown>> = {
  admin: (value) => adminProductionGanttResponseSchema.parse(value),
  editor: (value) => editorProductionGanttResponseSchema.parse(value),
  external_editor: (value) => externalProductionGanttSchema.parse(value),
};
let role: Role;

function detailBody() {
  return {
    id: PROJECT_ID, street: STREET, suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "editing",
    rawFolderPath: null, rawFolderLink: null, boardRevision: 1, contractEnabled: true, coverAssetId: null, effectiveCoverAssetId: null, collections: [],
    members: server.team.map(membershipFor), deadlineSchedule: scheduleOf(),
  };
}

const candidates = () => ({
  photographers: [],
  editors: [
    { id: ELI, name: "Eli Editor", email: "eli@example.test", globalRole: "editor", active: true },
    { id: NEW_EDITOR, name: "Nina Newcomer", email: "nina@example.test", globalRole: "editor", active: true },
  ],
});

const identityFor = (r: Role): DashboardIdentity => ({ principalId: "user-1", role: r, authorizationEpoch: 0 });

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
let onOpenProject: ReturnType<typeof vi.fn<(projectId: string) => void>>;

async function flush(rounds = 2) {
  await act(async () => { for (let index = 0; index < rounds; index += 1) { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); } });
}

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  // `performance.now()`, not `Date.now()`: `Date` is pinned by the fake clock above.
  const start = performance.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (performance.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

async function render(props: Partial<ProductionGanttProps> = {}) {
  await act(async () => {
    root.render(
      <ProjectQueryRuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <ConfirmModalHost />
          <ProductionGantt identity={identityFor(role)} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} projectHrefFor={(id) => `/projects/${id}`} onOpenProject={onOpenProject} {...props} />
        </QueryClientProvider>
      </ProjectQueryRuntimeProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await flush(3);
}

const teamTrigger = () => host.querySelector<HTMLButtonElement>('[data-testid="gantt-team-trigger"]');
const deadlineTrigger = () => host.querySelector<HTMLButtonElement>('[data-testid="gantt-deadline-trigger"]');
const teamNames = () => teamTrigger()?.getAttribute("aria-label") ?? "";
const dialog = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);
const combobox = () => document.querySelector<HTMLInputElement>('[aria-label="Add team member"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const buttonNames = () => [...host.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.getAttribute("aria-label") ?? "");

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

async function openTeam() {
  await click(teamTrigger()!);
  await waitFor(() => expect(combobox()).not.toBeNull());
}

async function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); await Promise.resolve(); });
}

async function openCandidateList() {
  const input = combobox()!;
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  return input;
}

function ganttRequests() {
  return apiGetMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/production-gantt"));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  role = "admin";
  server = freshServer();
  cycleOverrides.clear();
  onOpenProject = vi.fn<(projectId: string) => void>();
  apiGetMock.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/api/production-gantt")) {
      if (!path.includes("childrenOf=")) {
        expect(new URLSearchParams(path.split("?")[1]).get("team"), "every Gantt page asks for the team").toBe("1");
        server.ganttGets += 1;
      }
      return parsers[role]!(ganttBody());
    }
    if (path === `/api/projects/${PROJECT_ID}`) {
      server.detailGets += 1;
      if (server.detailGate) await server.detailGate;
      return detailBody();
    }
    if (path === "/api/project-assignment-candidates") return candidates();
    throw new Error(`unexpected GET ${path}`);
  });
  apiPutWithStatusMock.mockReset().mockImplementation(async (path: string) => {
    const match = /\/editors\/([^/]+)$/.exec(path)!;
    const added = person(match[1]!, "Nina Newcomer", "editor");
    server.team = [...server.team, added];
    return { status: 201, data: { outcome: "created", membership: membershipFor(added, server.team.length) } };
  });
  apiDeleteMock.mockReset().mockImplementation(async (path: string) => {
    const userId = decodeURIComponent(path.split("/").pop()!);
    const removed = server.team.find((member) => member.id === userId)!;
    server.team = server.team.filter((member) => member.id !== userId);
    return { outcome: "removed", removed: { membershipCycle: "x", userId, roleOnProject: removed.roleOnProject }, subtaskAssignmentsCleared: 0 };
  });
  apiPutMock.mockReset().mockImplementation(async (path: string, body: unknown) => {
    expect(path).toBe(`/api/projects/${PROJECT_ID}/deadline`);
    const request = body as { deadline: { localCivil: string; disambiguation?: string } | null };
    server.deadlineVersion += 1;
    if (request.deadline) server.deadline = { localCivil: request.deadline.localCivil, at: `${request.deadline.localCivil.slice(0, 10)}T05:00:00.000Z` };
    return { changed: true, current: scheduleOf(), eventIntent: null, publicationIds: [] };
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  confirmStore.resolve(false);
  await act(async () => { root.unmount(); await Promise.resolve(); });
  runtime.dispose();
  queryClient.clear();
  host.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("ProductionGantt — People and Due columns (#365)", () => {
  it("T1 Admin adds a team member: detail loads behind a skeleton, focus lands on the input, the chip is pending, and the row's stack updates", async () => {
    server.team = server.team.slice(0, 2); // two chips, so the new one is not folded behind the picker's "+N"
    await render();
    expect(teamNames()).toBe("Team for 1 Team Street: Pia Photographer, Eli Editor");
    const gate = deferred();
    server.detailGate = gate.promise;
    await click(teamTrigger()!);
    await waitFor(() => expect(document.querySelector('[data-testid="gantt-project-detail-loading"]')).not.toBeNull());
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}`);
    expect(combobox()).toBeNull();
    server.detailGate = null;
    gate.resolve();
    await waitFor(() => expect(combobox()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(combobox()));
    expect(document.activeElement?.getAttribute("data-testid")).not.toBe("project-member-remove");

    const before = ganttRequests().length;
    const input = await openCandidateList();
    const putGate = deferred();
    apiPutWithStatusMock.mockImplementationOnce(async (path: string) => {
      await putGate.promise;
      const match = /\/editors\/([^/]+)$/.exec(path)!;
      const added = person(match[1]!, "Nina Newcomer", "editor");
      server.team = [...server.team, added];
      return { status: 201, data: { outcome: "created", membership: membershipFor(added, server.team.length) } };
    });
    await typeInto(input, "nina");
    await waitFor(() => expect(options().some((option) => option.textContent?.includes("Nina Newcomer"))).toBe(true));
    await act(async () => { options().find((option) => option.textContent?.includes("Nina Newcomer"))!.click(); await Promise.resolve(); });
    expect(apiPutWithStatusMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/editors/${NEW_EDITOR}`);
    // The chip is pending straight away (the membership ledger), while the write is still in flight.
    const chip = () => document.querySelector(`[data-testid="project-member-editor:${NEW_EDITOR}"]`);
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()!.getAttribute("data-state")).toBe("pending");
    expect(chip()!.getAttribute("aria-busy")).toBe("true");
    expect(teamNames()).not.toContain("Nina Newcomer");
    putGate.resolve();
    await flush(3);
    await waitFor(() => expect(chip()?.getAttribute("data-state")).toBe("idle"));
    expect(chip()!.getAttribute("aria-busy")).toBeNull();
    await waitFor(() => expect(ganttRequests().length).toBeGreaterThan(before));
    await waitFor(() => expect(teamNames()).toContain("Nina Newcomer"));
  });

  it("T1b both triggers are disabled while a bar drag is in progress (before release) and re-enable when the gesture ends", async () => {
    await render();
    expect(teamTrigger()!.disabled).toBe(false);
    expect(deadlineTrigger()!.disabled).toBe(false);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect,
    );
    const grip = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"] [data-testid="gantt-resize-handle-end"]`)!;
    expect(grip).not.toBeNull();
    const fire = async (target: EventTarget, type: string, clientX: number) => {
      await act(async () => { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX, clientY: 10 })); await Promise.resolve(); });
    };
    await fire(grip, "pointerdown", 700);
    await fire(window, "pointermove", 900);
    expect(host.querySelector('[data-testid="gantt-drag-ghost"]')).not.toBeNull();
    expect(teamTrigger()!.disabled).toBe(true);
    expect(deadlineTrigger()!.disabled).toBe(true);
    await fire(window, "pointercancel", 900);
    await flush(3);
    await waitFor(() => expect(teamTrigger()!.disabled).toBe(false));
    expect(deadlineTrigger()!.disabled).toBe(false);
  });

  it("T2 Admin removes the final role of a member with checklist items: 422 opens the real confirm, confirming keeps the popover and sends the count", async () => {
    await render();
    await openTeam();
    apiDeleteMock.mockReset()
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockImplementationOnce(async () => { server.team = server.team.filter((member) => member.id !== PIA); return { outcome: "removed", removed: { membershipCycle: "cycle-1", userId: PIA, roleOnProject: "photographer" }, subtaskAssignmentsCleared: 2 }; });
    const chip = document.querySelector<HTMLElement>(`[data-testid="project-member-photographer:${PIA}"]`)!;
    await act(async () => { chip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(3);
    expect(apiDeleteMock.mock.calls[0]).toEqual([`/api/projects/${PROJECT_ID}/photographers/${PIA}`, { membershipCycle: "cycle-0", clearSubtaskAssignments: false, confirmedAssignmentCount: 0 }]);
    await waitFor(() => expect(document.querySelector('[data-testid="confirm-modal-message"]')?.textContent).toContain("unassign 2 checklist items"));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]')!.click(); await Promise.resolve(); });
    await flush(4);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
    expect(apiDeleteMock.mock.calls[1]![1]).toEqual({ membershipCycle: "cycle-0", clearSubtaskAssignments: true, confirmedAssignmentCount: 2 });
    expect(dialog("Team")).not.toBeNull();
    await waitFor(() => expect(teamNames()).not.toContain("Pia Photographer"));
  });

  it("T2b Cancel on the confirm sends no second DELETE and leaves the person on the team", async () => {
    await render();
    await openTeam();
    apiDeleteMock.mockReset().mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }));
    const chip = document.querySelector<HTMLElement>(`[data-testid="project-member-photographer:${PIA}"]`)!;
    await act(async () => { chip.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[data-testid="confirm-modal-cancel"]')).not.toBeNull());
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!.click(); await Promise.resolve(); });
    await flush(4);
    expect(apiDeleteMock).toHaveBeenCalledTimes(1);
    expect(teamNames()).toContain("Pia Photographer");
  });

  it("T3 a 409 membership_cycle_changed shows the conflict, and the next remove uses the NEW cycle id", async () => {
    await render();
    await openTeam();
    cycleOverrides.set(PIA, "cycle-new"); // another tab re-added Pia: the server now holds a new cycle
    const current = membershipFor(server.team[0]!, 0);
    apiDeleteMock.mockReset().mockRejectedValueOnce(new ApiError("stale", 409, { code: "membership_cycle_changed", currentMembership: current }));
    const chipFor = () => document.querySelector<HTMLElement>(`[data-testid="project-member-photographer:${PIA}"]`)!;
    await act(async () => { chipFor().querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await waitFor(() => expect(chipFor().getAttribute("data-state")).toBe("conflict"));
    expect(document.body.textContent).toContain("Assignment changed elsewhere");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Retry" && button.closest('[role="dialog"]'))).toBe(false);

    apiDeleteMock.mockImplementationOnce(async () => ({ outcome: "removed", removed: { membershipCycle: "cycle-new", userId: PIA, roleOnProject: "photographer" }, subtaskAssignmentsCleared: 0 }));
    await act(async () => { chipFor().querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush(3);
    expect(apiDeleteMock.mock.calls[1]![1]).toMatchObject({ membershipCycle: "cycle-new" });
  });

  it("T4 Admin changes the Deadline: the popover is seeded from the detail, saves at the detail's version, closes, and the cell shows the new text", async () => {
    await render();
    expect(deadlineTrigger()!.getAttribute("aria-label")).toBe(`Deadline for ${STREET}: Sun 20 Sep · 15:00`);
    await click(deadlineTrigger()!);
    await waitFor(() => expect(dialog("Deadline")?.querySelector('input[aria-label="Deadline date"]')).not.toBeNull());
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}`);
    const dateInput = dialog("Deadline")!.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!;
    expect(dateInput.value).toBe(isoDate(5));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(dateInput, isoDate(7)); dateInput.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    const save = [...dialog("Deadline")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); await Promise.resolve(); });
    await flush(3);
    expect(apiPutMock.mock.calls[0]![1]).toMatchObject({ expectedVersion: 1, deadline: { localCivil: `${isoDate(7)}T15:00` } });
    await waitFor(() => expect(dialog("Deadline")).toBeNull());
    await waitFor(() => expect(deadlineTrigger()!.getAttribute("aria-label")).toBe(`Deadline for ${STREET}: Tue 22 Sep · 15:00`));
  });

  it("T5 an internal Editor sees plain values: no Team/Deadline controls, and no detail or candidates request", async () => {
    role = "editor";
    server.canEditTeam = false;
    server.canEditDeadline = false;
    await render();
    expect(host.querySelector('[data-testid="gantt-team"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="gantt-deadline"]')).not.toBeNull();
    expect(buttonNames().filter((name) => /Team for|Deadline for/.test(name))).toEqual([]);
    await click(host.querySelector('[data-testid="gantt-team"]')!);
    await click(host.querySelector('[data-testid="gantt-deadline"]')!);
    await flush(2);
    expect(apiGetMock.mock.calls.map(([path]) => path).filter((path) => !path.startsWith("/api/production-gantt"))).toEqual([]);
  });

  it("T5b an External Editor sees plain values too", async () => {
    role = "external_editor";
    server.canEditTeam = false;
    server.canEditDeadline = false;
    await render();
    expect(host.querySelector('[data-testid="gantt-team"]')).not.toBeNull();
    expect(buttonNames().filter((name) => /Team for|Deadline for/.test(name))).toEqual([]);
    expect(apiGetMock.mock.calls.map(([path]) => path).filter((path) => !path.startsWith("/api/production-gantt"))).toEqual([]);
  });

  it("T6 a delivered row: the Admin can still edit the team, the Deadline is plain", async () => {
    server.delivered = true;
    server.canEditDeadline = false;
    await render({ filters: { ...DEFAULT_GANTT_FACET_FILTERS, delivered: true } });
    expect(teamTrigger()).not.toBeNull();
    expect(deadlineTrigger()).toBeNull();
    expect(host.querySelector('[data-testid="gantt-deadline"]')).not.toBeNull();
  });

  it("T7 no Deadline: the Due cell is an em dash with an sr-only label, non-interactive; 'Set deadline' stays on the label", async () => {
    server.deadline = null;
    await render();
    const cell = host.querySelector<HTMLElement>('[data-testid="gantt-deadline"]')!;
    expect(cell.textContent).toContain("—");
    expect(cell.querySelector("span")?.textContent).toBe("No deadline"); // the sr-only label
    expect(deadlineTrigger()).toBeNull();
    expect(host.querySelector('[data-testid="gantt-deadline-action"]')?.textContent).toBe("Set deadline");
  });

  it("T7b layout contract: the name cell is a 240px floor and holds the street and the Set deadline button; People and Due are separate cells", async () => {
    server.deadline = null;
    await render();
    const nameCell = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-cell"]')!;
    expect(nameCell.style.width).toBe("240px");
    expect(nameCell.querySelector('[data-testid="gantt-deadline-action"]')).not.toBeNull();
    expect(nameCell.querySelector('[data-testid="gantt-project-link"]')).not.toBeNull();
    expect(nameCell.querySelector('[data-testid="gantt-team-trigger"]')).toBeNull();
  });

  it("T7c on a phone the name cell keeps the same 240px floor (the tree scrolls inside its pane)", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === "(max-width: 720px)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      await render();
      expect(host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-cell"]')!.style.width).toBe("240px");
    } finally { window.matchMedia = original; }
  });

  it("T8 more than three members: three avatars and +N, a dual-role person counting once", async () => {
    server.team = [
      person(PIA, "Pia Photographer", "photographer"),
      person(ELI, "Eli Editor", "editor"),
      person(ELI, "Eli Editor", "photographer"),
      person(ZED, "Zed Inactive", "editor", false),
      person(NEW_EDITOR, "Nina Newcomer", "editor"),
      person(uid(6), "Otto Other", "editor"),
    ];
    await render();
    const trigger = teamTrigger()!;
    const avatars = [...trigger.querySelectorAll('[role="img"]')];
    expect(avatars).toHaveLength(4); // three avatars and the overflow chip
    expect(avatars.every((avatar) => avatar.closest('[aria-hidden="true"]') !== null)).toBe(true); // decorative: named once, by the trigger
    expect(trigger.textContent).toContain("+2");
    expect(trigger.getAttribute("aria-label")).toContain("Pia Photographer, Eli Editor, Zed Inactive (inactive), Nina Newcomer, Otto Other");
    expect(trigger.getAttribute("aria-label")!.match(/Eli Editor/g)).toHaveLength(1);
  });

  it("T9 Esc closes the candidate list first, then the popover, and focus returns to the trigger", async () => {
    await render();
    await openTeam();
    const input = await openCandidateList();
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    expect(dialog("Team")).not.toBeNull();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await waitFor(() => expect(dialog("Team")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(teamTrigger()));
  });

  it("T11 a response without team/canEditTeam (an old worker) renders an empty, non-interactive stack and never throws", async () => {
    server.withTeamKeys = false;
    await render();
    const cell = host.querySelector<HTMLElement>('[data-testid="gantt-team"]')!;
    expect(cell).not.toBeNull();
    expect(cell.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("No team assigned");
    expect(teamTrigger()).toBeNull();
  });

  it("T12 a failed detail load shows an error and Retry, which refetches", async () => {
    await render();
    const failing = vi.fn();
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === `/api/projects/${PROJECT_ID}`) { failing(); throw new ApiError("nope", 400); }
      if (path === "/api/project-assignment-candidates") return candidates();
      return parsers[role]!(ganttBody());
    });
    await click(teamTrigger()!);
    await waitFor(() => expect(document.querySelector('[data-testid="gantt-project-detail-error"]')).not.toBeNull());
    const retry = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-project-detail-error"] button')].find((button) => button.textContent === "Retry")!;
    const calls = failing.mock.calls.length;
    await click(retry);
    await waitFor(() => expect(failing.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe("ProductionGantt — row label opens the Project (#365, AC3)", () => {
  const link = () => host.querySelector<HTMLAnchorElement>('[data-testid="gantt-project-link"]');

  it("L1 the street is a real link; a plain click opens the Project once; a modified click and the Team/Due triggers do not", async () => {
    await render();
    expect(link()!.getAttribute("href")).toBe(`/projects/${PROJECT_ID}`);
    expect(link()!.textContent).toBe(STREET);
    const linkClick = (init: MouseEventInit) => link()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }));
    await act(async () => { linkClick({}); await Promise.resolve(); });
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT_ID);
    await act(async () => { linkClick({ ctrlKey: true }); linkClick({ metaKey: true }); await Promise.resolve(); });
    expect(onOpenProject).toHaveBeenCalledTimes(1);

    await click(teamTrigger()!);
    await waitFor(() => expect(combobox()).not.toBeNull());
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await click(deadlineTrigger()!);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("L1b without projectHrefFor the street stays plain text", async () => {
    await render({ projectHrefFor: undefined, onOpenProject: undefined });
    expect(link()).toBeNull();
  });
});
