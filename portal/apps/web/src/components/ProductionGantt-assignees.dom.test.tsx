/**
 * #372 (assignee half) — Subtask rows in the Dashboard Gantt show an assignee stack and open the Checklist's
 * assignee picker. A real `ProductionGantt` render; only `apiGet` / `apiPatch` (never a real `fetch`, per
 * `src/testing/no-unmocked-fetch.ts`) and `invalidateProjectSurfaces` are faked.
 *
 * Guard F (`test-seam.guard.test.ts`): nothing here selects a vendor `data-slot` or a class. The picker is found by
 * its accessible name, options by their ARIA role, the stack's people by their `role="img"` labels.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, productionGanttChildPageSchema, PRODUCTION_GANTT_ZONE, type CalendarPerson, type GanttChecklistRowDto, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError } from "../lib/api";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { clearToasts } from "../lib/toast-store";
import { ToastViewport } from "./quincy/ToastViewport";
import { ProductionGantt } from "./ProductionGantt";
import { startMoment, endMoment } from "@/testing/subtask-schedule";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const invalidateMock = vi.hoisted(() => vi.fn<(client: unknown, options: Record<string, unknown>) => Promise<void>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
}));
vi.mock("../lib/project-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/project-data")>()),
  invalidateProjectSurfaces: (client: unknown, options: Record<string, unknown>) => invalidateMock(client, options),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ONE = "22222222-2222-4222-8222-000000000001";
const ROW_TWO = "22222222-2222-4222-8222-000000000002";
const ROW_PAGE_TWO = "22222222-2222-4222-8222-000000000003";

const person = (n: number, name: string): CalendarPerson => ({ id: `33333333-3333-4333-8333-00000000000${n}`, name, roleLabel: "Editor", isExternal: false, active: true });
const ada = person(1, "Ada Smith");
const ben = person(2, "Ben Ortiz");
const cy = person(3, "Cy Young");
const candidates = [ada, ben, cy].map(({ id, name }) => ({ id, name, role: "editor" }));

const isoDate = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };
const schedule = () => ({ state: "range" as const, version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(isoDate(2)), end: endMoment(isoDate(2)), due: isoDate(2) });

type RowInput = { id: string; title: string; assignees: CalendarPerson[]; otherAssigneeCount?: number; assignmentVersion: number; canEditAssignees: boolean };
function row(input: RowInput, position: number): GanttChecklistRowDto {
  return {
    id: input.id, projectId: PROJECT_ID, title: input.title, done: false, position,
    assignees: input.assignees, otherAssigneeCount: input.otherAssigneeCount ?? 0, assignmentVersion: input.assignmentVersion,
    schedule: schedule(),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: input.canEditAssignees },
  };
}

/** The server's view: PATCH mutates it, GET reads it. */
let server: RowInput[];
let pageTwo: RowInput[];
let truncated: boolean;

function project(): GanttProjectRowDto {
  const rows = server.map((input, index) => row(input, index));
  const total = rows.length + pageTwo.length;
  return {
    id: PROJECT_ID, street: "1 Assignee Street", suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
    shootDate: isoDate(0), shootDateCivil: isoDate(0), createdAt: `${isoDate(0)}T00:00:00.000Z`, barStartDate: isoDate(0),
    deadline: { at: `${isoDate(5)}T05:00:00.000Z`, localCivil: `${isoDate(5)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1, editors: [], checklist: { completed: 0, total },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows, total, returned: rows.length, truncated, nextCursor: truncated ? "cursor-1" : null },
  };
}

const dto = (input: RowInput) => ({ id: input.id, title: input.title, done: false, assignees: input.assignees, assignmentVersion: input.assignmentVersion, position: 0, schedule: schedule() });

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} />
        <ToastViewport />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

const trigger = (title: string) => host.querySelector<HTMLButtonElement>(`[aria-label="Assignees for ${title}"]`);
const triggerTitle = (title: string) => trigger(title)?.getAttribute("title");
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

async function open(title: string) {
  const button = trigger(title)!;
  await act(async () => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); button.click(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  await waitFor(() => expect(options().map((option) => option.textContent).join("|")).toContain("Cy Young"));
}
async function pick(name: string) {
  const option = options().find((candidate) => candidate.textContent?.includes(name));
  if (!option) throw new Error(`No option ${name}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}
async function closeWithEscape() {
  const target = document.activeElement ?? document.body;
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
  await settle();
}

beforeEach(() => {
  server = [
    { id: ROW_ONE, title: "Row one", assignees: [ada, ben], assignmentVersion: 3, canEditAssignees: true },
    { id: ROW_TWO, title: "Row two", assignees: [ada], otherAssigneeCount: 2, assignmentVersion: 1, canEditAssignees: false },
  ];
  pageTwo = [];
  truncated = false;
  apiGetMock.mockReset().mockImplementation((path: string) => {
    if (path.includes("/subtask-assignee-options")) return Promise.resolve({ candidates });
    if (path.includes("childrenOf=")) {
      const rows = pageTwo.map((input, index) => row(input, server.length + index));
      return Promise.resolve(productionGanttChildPageSchema.parse({ projectId: PROJECT_ID, children: { rows, total: server.length + rows.length, returned: rows.length, truncated: false, nextCursor: null } }));
    }
    return Promise.resolve(adminProductionGanttResponseSchema.parse({
      scope: "active", zone: PRODUCTION_GANTT_ZONE,
      appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
      projects: [project()], page: { limit: 100, returned: 1, nextCursor: null },
      density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
    }));
  });
  apiPatchMock.mockReset();
  invalidateMock.mockReset().mockResolvedValue(undefined);
  clearToasts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  client.clear();
  host.remove();
  document.body.replaceChildren();
});

describe("ProductionGantt — Subtask assignees (#372)", () => {
  it("adds one and removes one from a row's picker: exactly one PATCH with the delta and expectedVersion, and the row re-renders", async () => {
    apiPatchMock.mockImplementation((_path, body) => {
      const { add, remove } = (body as { assignees: { add: string[]; remove: string[] } }).assignees;
      const current = server[0]!;
      const next = [...current.assignees.filter((p) => !remove.includes(p.id)), ...[ada, ben, cy].filter((p) => add.includes(p.id))];
      server[0] = { ...current, assignees: next, assignmentVersion: current.assignmentVersion + 1 };
      return Promise.resolve(dto(server[0]));
    });
    await mount();
    expect(triggerTitle("Row one")).toBe("Ada Smith, Ben Ortiz");

    await open("Row one");
    await pick("Ada Smith"); // remove
    await pick("Cy Young"); // add
    await closeWithEscape();

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/subtasks/${ROW_ONE}`, { assignees: { expectedVersion: 3, add: [cy.id], remove: [ada.id] } });
    await waitFor(() => expect(triggerTitle("Row one")).toBe("Ben Ortiz, Cy Young"));
  });

  it("layout contract: a Subtask's assignee control sits in the People cell, never in the name cell, so the title keeps the whole name cell", async () => {
    await mount();
    const nameCellFor = (title: string) => [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-tree-name-cell"]')].find((cell) => cell.textContent?.includes(title))!;
    for (const title of ["Row one", "Row two"]) {
      const nameCell = nameCellFor(title);
      expect(nameCell).toBeDefined();
      expect(nameCell.querySelector('[data-testid="gantt-subtask-assignees"]')).toBeNull();
      expect(nameCell.querySelector(`[aria-label="Assignees for ${title}"]`)).toBeNull();
      expect(nameCell.querySelector('[role="img"]')).toBeNull();
    }
    // Editable row: the picker is inside the row, inside the assignee cell, and not inside the name cell.
    const rowOne = nameCellFor("Row one").closest<HTMLElement>("[data-gantt-row-id]")!;
    const cellOne = trigger("Row one")!.closest<HTMLElement>('[data-testid="gantt-subtask-assignees"]');
    expect(cellOne).not.toBeNull();
    expect(rowOne.contains(cellOne)).toBe(true);
    expect(nameCellFor("Row one").contains(cellOne)).toBe(false);
    // Read-only row: the plain stack is likewise in the assignee cell only.
    const rowTwo = nameCellFor("Row two").closest<HTMLElement>("[data-gantt-row-id]")!;
    const cellTwo = rowTwo.querySelector<HTMLElement>('[data-testid="gantt-subtask-assignees"]');
    expect(cellTwo?.querySelector('[role="img"]')).not.toBeNull();
    // A Project row keeps its Team there, not a Subtask control.
    const projectRow = [...host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")].find((element) => element.getAttribute("data-gantt-row-id")?.startsWith("project:"))!;
    expect(projectRow.querySelector('[data-testid="gantt-subtask-assignees"]')).toBeNull();
  });

  it("on a phone the People column is not rendered, so no Subtask assignee control is either", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === "(max-width: 720px)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      await mount();
      expect(host.textContent).toContain("Row one");
      expect(trigger("Row one")).toBeNull();
      expect(host.querySelector('[data-testid="gantt-subtask-assignees"]')).toBeNull();
      expect(host.querySelectorAll('button[aria-label^="Assignees for"]')).toHaveLength(0);
    } finally { window.matchMedia = original; }
  });

  it("refreshes the Gantt, Calendar, Checklist and Activity after a commit, and does not suppress this tab's own Gantt refetch", async () => {
    apiPatchMock.mockImplementation(() => { server[0] = { ...server[0]!, assignees: [ada], assignmentVersion: 4 }; return Promise.resolve(dto(server[0]!)); });
    await mount();
    await open("Row one");
    await pick("Ben Ortiz");
    await closeWithEscape();

    expect(invalidateMock).toHaveBeenCalledTimes(1);
    const options_ = invalidateMock.mock.calls[0]![1];
    expect(options_).toMatchObject({ projectId: PROJECT_ID, calendar: true, gantt: true, dashboard: false, resources: [{ kind: "subtasks" }, { kind: "activity" }] });
    expect(options_).not.toHaveProperty("producer");
  });

  it("an untouched picker sends nothing", async () => {
    await mount();
    await open("Row one");
    await closeWithEscape();
    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("empty state: an editable Subtask shows the shared glyph in its trigger; a read-only one shows nothing (no glyph, no avatars) but keeps its cell", async () => {
    server = [
      { id: ROW_ONE, title: "Row one", assignees: [], assignmentVersion: 1, canEditAssignees: true },
      { id: ROW_TWO, title: "Row two", assignees: [], assignmentVersion: 1, canEditAssignees: false },
    ];
    await mount();
    expect(trigger("Row one")!.querySelector('[data-testid="empty-assignee-glyph"]')).not.toBeNull();
    const rowTwo = [...host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")].find((element) => element.textContent?.includes("Row two"))!;
    const cellTwo = rowTwo.querySelector<HTMLElement>('[data-testid="gantt-subtask-assignees"]');
    expect(cellTwo).not.toBeNull();
    expect(cellTwo!.querySelector('[data-testid="empty-assignee-glyph"]')).toBeNull();
    expect(cellTwo!.querySelector('[role="img"]')).toBeNull();
    expect(cellTwo!.querySelector("button")).toBeNull();
  });

  it("without access, a row is a plain stack: no button, no popup, and the hidden count is a count", async () => {
    await mount();
    expect(trigger("Row two")).toBeNull();
    expect(host.querySelectorAll('button[aria-label^="Assignees for"]')).toHaveLength(1);
    const two = [...host.querySelectorAll<HTMLElement>('[role="img"]')];
    expect(two.some((element) => element.getAttribute("aria-label")?.includes("Ada Smith"))).toBe(true);
    expect(two.some((element) => element.getAttribute("aria-label")?.includes("2 others not shown"))).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("clicking or keying the picker never reaches the row's own handlers", async () => {
    await mount();
    const seen: string[] = [];
    const listen = (type: string) => document.body.addEventListener(type, (event) => { if ((event.target as Element | null)?.closest?.('[aria-label="Assignees for Row one"]')) seen.push(type); });
    for (const type of ["pointerdown", "mousedown", "click", "keydown"]) listen(type);
    const button = trigger("Row one")!;
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button.click();
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    await act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(seen).toEqual([]);
    await closeWithEscape();
  });

  it("on a version conflict shows the latest assignees and says so", async () => {
    apiPatchMock.mockImplementation(() => {
      server[0] = { ...server[0]!, assignees: [ben], assignmentVersion: 9 };
      return Promise.reject(new ApiError("Assignees changed.", 409, { code: "subtask_assignment_version_conflict", currentSubtask: dto(server[0]!) }));
    });
    await mount();
    await open("Row one");
    await pick("Cy Young");
    await closeWithEscape();

    await waitFor(() => expect(triggerTitle("Row one")).toBe("Ben Ortiz"));
    expect(document.body.textContent).toContain("Assignees changed elsewhere — showing the latest.");
  });

  it("edits a row that lives on a later page, which the settle refetch never returns", async () => {
    truncated = true;
    pageTwo = [{ id: ROW_PAGE_TWO, title: "Row three", assignees: [ada], assignmentVersion: 2, canEditAssignees: true }];
    apiPatchMock.mockImplementation(() => Promise.resolve(dto({ ...pageTwo[0]!, assignees: [ada, cy], assignmentVersion: 3 })));
    await mount();
    expect(triggerTitle("Row three")).toBe("Ada Smith");

    await open("Row three");
    await pick("Cy Young");
    await closeWithEscape();

    expect(apiPatchMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_ID}/subtasks/${ROW_PAGE_TWO}`, { assignees: { expectedVersion: 2, add: [cy.id], remove: [] } });
    await waitFor(() => expect(triggerTitle("Row three")).toBe("Ada Smith, Cy Young"));
  });

  describe("convergence with the server after an edit", () => {
    /** The real refetch: the Gantt query refetches from `apiGet`, which reads `server`/`pageTwo`. */
    const refetchForReal = () => invalidateMock.mockImplementation(async (queryClient) => { await (queryClient as QueryClient).invalidateQueries(); });

    it("a newer server state (higher assignmentVersion, other selection) beats the adopted PATCH result, and the next commit is based on it", async () => {
      refetchForReal();
      apiPatchMock.mockImplementationOnce(() => { server[0] = { ...server[0]!, assignees: [ada, ben, cy], assignmentVersion: 4 }; return Promise.resolve(dto(server[0]!)); });
      await mount();
      await open("Row one");
      await pick("Cy Young");
      await closeWithEscape();
      await waitFor(() => expect(triggerTitle("Row one")).toBe("Ada Smith, Ben Ortiz, Cy Young"));

      // Someone else changes the row after our write; the next refetch must win over what this tab adopted at v4.
      server[0] = { ...server[0]!, assignees: [cy], assignmentVersion: 6 };
      await act(async () => { await client.invalidateQueries(); });
      await settle();
      await waitFor(() => expect(triggerTitle("Row one")).toBe("Cy Young"));

      apiPatchMock.mockImplementationOnce(() => { server[0] = { ...server[0]!, assignees: [cy, ben], assignmentVersion: 7 }; return Promise.resolve(dto(server[0]!)); });
      await open("Row one");
      await pick("Ben Ortiz");
      await closeWithEscape();
      expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${PROJECT_ID}/subtasks/${ROW_ONE}`, { assignees: { expectedVersion: 6, add: [ben.id], remove: [] } });
    });

    it("an undecodable PATCH body is not an error: no failure toast, and the refetched server state is what the row shows", async () => {
      refetchForReal();
      apiPatchMock.mockImplementation(() => { server[0] = { ...server[0]!, assignees: [ben, cy], assignmentVersion: 4 }; return Promise.resolve({ unexpected: "shape" }); });
      await mount();
      await open("Row one");
      await pick("Cy Young");
      await closeWithEscape();

      await waitFor(() => expect(triggerTitle("Row one")).toBe("Ben Ortiz, Cy Young"));
      expect(document.body.textContent).not.toContain("could not be updated");
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(invalidateMock).toHaveBeenCalledTimes(1);
    });

    it("an undecodable 409 body still converges on the refetched server state, with the conflict notice and no failure toast", async () => {
      refetchForReal();
      apiPatchMock.mockImplementation(() => {
        server[0] = { ...server[0]!, assignees: [cy], assignmentVersion: 9 };
        return Promise.reject(new ApiError("Assignees changed.", 409, { code: "subtask_assignment_version_conflict", currentSubtask: { garbage: true } }));
      });
      await mount();
      await open("Row one");
      await pick("Ada Smith");
      await closeWithEscape();

      await waitFor(() => expect(triggerTitle("Row one")).toBe("Cy Young"));
      expect(document.body.textContent).toContain("Assignees changed elsewhere — showing the latest.");
      expect(document.body.textContent).not.toContain("could not be updated");
    });

    it("a later-page row keeps its committed assignees and versions the next commit from them, across a refetch that never returns it", async () => {
      refetchForReal();
      truncated = true;
      pageTwo = [{ id: ROW_PAGE_TWO, title: "Row three", assignees: [ada], assignmentVersion: 2, canEditAssignees: true }];
      apiPatchMock.mockImplementationOnce(() => { pageTwo[0] = { ...pageTwo[0]!, assignees: [ada, cy], assignmentVersion: 3 }; return Promise.resolve(dto(pageTwo[0]!)); });
      await mount();
      await open("Row three");
      await pick("Cy Young");
      await closeWithEscape();
      await waitFor(() => expect(triggerTitle("Row three")).toBe("Ada Smith, Cy Young"));

      await act(async () => { await client.invalidateQueries(); });
      await settle();
      expect(triggerTitle("Row three")).toBe("Ada Smith, Cy Young");

      apiPatchMock.mockImplementationOnce(() => { pageTwo[0] = { ...pageTwo[0]!, assignees: [cy], assignmentVersion: 4 }; return Promise.resolve(dto(pageTwo[0]!)); });
      await open("Row three");
      await pick("Ada Smith");
      await closeWithEscape();
      expect(apiPatchMock).toHaveBeenLastCalledWith(`/api/projects/${PROJECT_ID}/subtasks/${ROW_PAGE_TWO}`, { assignees: { expectedVersion: 3, add: [], remove: [ada.id] } });
      await waitFor(() => expect(triggerTitle("Row three")).toBe("Cy Young"));
    });
  });
});
