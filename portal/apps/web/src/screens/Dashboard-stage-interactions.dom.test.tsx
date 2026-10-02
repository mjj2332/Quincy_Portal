// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance items.
import { cardMenuTrigger, closeMenus, menuItems, openCardMenu, openMoveTo, openMoveToFrom, stageRadio, stageRadios } from "../components/board/board-menu-test-helpers";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { displayMenu, displayTrigger } from "./dashboard-display-test-helpers";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { ApiError } from "../lib/api";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { createDashboardBoardInvalidatedMessage, ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Board's horizontal
// scroll, `board/board.tsx`) calls on a timer after mount. The no-op stub means "no active
// animations"; see `reui/gantt/gantt-adjust-ghost-marker.dom.test.tsx` for the same polyfill.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const authState = vi.hoisted(() => ({ role: "admin" as "admin" | "editor" | "external_editor", moved: false }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
type DndTestEvent = { active: { id: string }; over: { id: string } | null; activatorEvent?: Event };
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ props: Parameters<typeof import("@dnd-kit/core").DndContext>[0]; start?: (event: DndTestEvent) => void; over?: (event: DndTestEvent) => void; end?: (event: DndTestEvent) => void; cancel?: (event: DndTestEvent) => void }> }));
const sortable = vi.hoisted(() => ({ contexts: [] as Array<readonly string[]> }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ props, start: props.onDragStart as ((event: DndTestEvent) => void) | undefined, over: props.onDragOver as ((event: DndTestEvent) => void) | undefined, end: props.onDragEnd as ((event: DndTestEvent) => void) | undefined, cancel: props.onDragCancel as ((event: DndTestEvent) => void) | undefined });
      return createElement(actual.DndContext, props);
    },
  };
});
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => {
      sortable.contexts.push(props.items.map(String));
      return createElement(actual.SortableContext, props);
    },
  };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: authState.role, capabilities: authState.role === "admin" ? ["moveProjectStage", "prioritizeProjects"] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" || (capability === "prioritizeProjects" && authState.role === "admin") }),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: readonly unknown[]) => stages,
  useStages: () => {
    const stages = [
      { key: "awaiting_raw" as const, label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review" as const, label: "RAW review", displayOrder: 2, active: true },
      ...(authState.role === "admin"
        ? [{ key: "editing_autohdr" as const, label: "Editing · autoHDR", displayOrder: 3, active: true }]
        : [{ key: "editing" as const, label: "Editing", displayOrder: 3, active: true }]),
    ];
    return { stages, presentationStageKey: (key: string) => key === "editing_autohdr" && authState.role !== "admin" ? "editing" : key };
  },
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));

const boardOrder = { awaiting_raw: ["source"], raw_review: ["before", "target"] };

function summary(id: string, stageKey: ProjectSummary["stageKey"], boardRevision: number) {
  return {
    id, street: id === "source" ? "Source Street" : `${id} Street`, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey, shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null, priority: id === "source" ? 1 : null,
    boardPosition: id === "source" ? 9000 : 1, boardRevision, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
  };
}

function response() {
  const source = authState.moved ? { ...summary("source", "raw_review", 4), priority: 1 } : summary("source", "awaiting_raw", 3);
  return { projects: [source, summary("before", "raw_review", 8), summary("target", "raw_review", 9)], board: { contractEnabled: true, orderedProjectIdsByStage: boardOrder } };
}

function editingMoveResponse() {
  return {
    projects: [summary("source", "raw_review", 3), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
    board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["source", "before", "target"] } },
  };
}

function settleInitialResponse() {
  return {
    projects: [
      summary("source", "awaiting_raw", 3),
      summary("source-sibling-a", "awaiting_raw", 5),
      summary("source-sibling-b", "awaiting_raw", 6),
      summary("before", "raw_review", 8),
      summary("target", "raw_review", 9),
    ],
    board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source", "source-sibling-a", "source-sibling-b"], raw_review: ["before", "target"] } },
  };
}

function externalResponse() {
  const firstId = "123e4567-e89b-42d3-a456-426614174001";
  const secondId = "123e4567-e89b-42d3-a456-426614174002";
  const rawService = (id: string) => ({ id, kind: "raw", status: "active", expectedCount: null, receivedCount: 0 });
  const externalProject = (id: string, street: string) => ({
    id,
    address: { street, suburb: "External suburb", postcode: "2000" },
    agencyDisplayName: "External agency",
    agentDisplayName: null,
    shootDate: null,
    timeWindow: null,
    stageKey: "editing" as const,
    boardRevision: id === firstId ? 12 : 13,
    deadline: null,
    productionNotes: null,
    services: [rawService(`${id.slice(0, -1)}3`)],
    cover: null,
  });
  return {
    projects: [externalProject(firstId, "External First Street"), externalProject(secondId, "External Second Street")],
    board: { contractEnabled: true, orderedProjectIdsByStage: { editing: [secondId, firstId] } },
  };
}

function externalEditingMoveResponse() {
  const firstId = "123e4567-e89b-42d3-a456-426614174001";
  const secondId = "123e4567-e89b-42d3-a456-426614174002";
  const rawService = (id: string) => ({ id, kind: "raw", status: "active", expectedCount: null, receivedCount: 0 });
  const externalProject = (id: string, street: string, stageKey: "raw_review" | "editing") => ({
    id,
    address: { street, suburb: "External suburb", postcode: "2000" },
    agencyDisplayName: "External agency",
    agentDisplayName: null,
    shootDate: null,
    timeWindow: null,
    stageKey,
    boardRevision: id === firstId ? 12 : 13,
    deadline: null,
    productionNotes: null,
    services: [rawService(`${id.slice(0, -1)}3`)],
    cover: null,
  });
  return {
    projects: [externalProject(firstId, "External First Street", "raw_review"), externalProject(secondId, "External Second Street", "editing")],
    board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: [firstId], editing: [secondId] } },
  };
}

async function dndStart(activeId: string, keyboard = false) {
  const handler = dnd.handlers.at(-1)?.start;
  if (!handler) throw new Error("No DndContext drag-start handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: null, activatorEvent: keyboard ? new KeyboardEvent("keydown", { key: " " }) : undefined }); await Promise.resolve(); });
}

async function dndOver(activeId: string, overId: string) {
  const handler = dnd.handlers.at(-1)?.over;
  if (!handler) throw new Error("No DndContext drag-over handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: { id: overId } }); await Promise.resolve(); });
}

async function dndEnd(activeId: string, overId: string | null) {
  const handler = dnd.handlers.at(-1)?.end;
  if (!handler) throw new Error("No DndContext drag-end handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: overId === null ? null : { id: overId } }); await Promise.resolve(); });
}

async function dndCancel(activeId: string) {
  const handler = dnd.handlers.at(-1)?.cancel;
  if (!handler) throw new Error("No DndContext drag-cancel handler was rendered");
  await act(async () => { handler({ active: { id: activeId }, over: null }); await Promise.resolve(); });
}

function card(host: HTMLElement, street: string) {
  const address = [...host.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].find((element) => element.textContent === street);
  if (!address) throw new Error(`Missing card ${street}`);
  return address.closest<HTMLElement>('[data-testid="board-card-wrap"]')!;
}

/** The card's link is its drag handle (#432): a disabled drag shows as `data-disabled`, not `disabled`. */
function isLocked(element: Element): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("data-disabled") === "true";
}

function movementControls(host: ParentNode): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>('[data-testid="board-card"]'),
    // The ⋯ menu is the one non-drag control (#432); Move to is its one item (#470).
    ...host.querySelectorAll<HTMLButtonElement>('[data-testid="board-card-menu"]'),
  ];
}

/** Opens a card's ⋯ menu, then Move to, and picks a Stage: always an append, never a position (#470). */
async function moveToStage(host: HTMLElement, street: string, targetLabel: string) {
  const trigger = card(host, street).querySelector<HTMLButtonElement>('[data-testid="board-card-menu"]');
  if (!trigger) throw new Error(`Missing ⋯ trigger for ${street}`);
  await openMoveToFrom(trigger);
  const stage = stageRadio(targetLabel);
  if (!stage) throw new Error(`Missing target Stage ${targetLabel}`);
  await act(async () => { stage.click(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

let root: Root;
let host: HTMLElement;

describe("Dashboard Stage interactions", () => {
  beforeEach(() => {
    authState.role = "admin"; authState.moved = false; apiGetMock.mockReset(); apiPostMock.mockReset();
    dnd.handlers.length = 0;
    sortable.contexts.length = 0;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(response()) : Promise.resolve({}));
    apiPostMock.mockImplementation(() => Promise.resolve({ changed: true, project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 }, board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["before", "target", "source"] } }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("sends an append for a drop on a card and for a drop on the column background", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await dndStart("source");
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", {
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "append" },
    });
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    await dndStart("source");
    await dndOver("source", "raw_review");
    await dndEnd("source", "raw_review");
    await flush();
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/projects/source/stage", expect.objectContaining({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "append" },
    }));
  });

  it("does not offer same-column reorder to an Editor without prioritizeProjects", async () => {
    authState.role = "editor";
    await act(async () => { root.render(<Dashboard currentUserId="editor-1" />); await Promise.resolve(); }); await flush();
    await dndStart("before");
    await dndOver("before", "target");
    await dndEnd("before", "target");
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("serializes an internal Editor's cross-Stage move into Editing and overlays the role-safe Stage", async () => {
    authState.role = "editor";
    let resolveMove!: (value: unknown) => void;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(editingMoveResponse()) : Promise.resolve({}));
    apiPostMock
      .mockRejectedValueOnce(new ApiError("Confirmation required", 409, {
        code: "stage_confirmation_required",
        requiredConfirmation: { reasons: ["editing_boundary"] },
      }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMove = resolve; }));
    await act(async () => { root.render(<><Dashboard currentUserId="editor-1" role="editor" /><ConfirmModalHost /></>); await Promise.resolve(); }); await flush();

    await dndStart("source");
    await dndOver("source", "editing");
    await dndEnd("source", "editing");
    await flush();
    expect(apiPostMock).toHaveBeenNthCalledWith(1, "/api/projects/source/stage", expect.objectContaining({ targetStageKey: "editing" }));
    expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("confirmation");

    document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]')!.click();
    await flush();
    expect(apiPostMock).toHaveBeenNthCalledWith(2, "/api/projects/source/stage", expect.objectContaining({ targetStageKey: "editing", confirmation: { reasons: ["editing_boundary"] } }));
    const editingColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[data-focus-key="stage-heading:editing_autohdr"]'))!;
    expect([...editingColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toContain("Source Street");
    expect(editingColumn.querySelector('[data-focus-key="stage-heading:editing_autohdr"]')?.textContent).toContain("Editing");
    expect(editingColumn.querySelector('[data-focus-key="stage-heading:editing_autohdr"]')?.textContent).not.toContain("autoHDR");

    resolveMove({ changed: true, project: { projectId: "source", stageKey: "editing", boardRevision: 4 }, board: { sourceStageKey: "raw_review", targetStageKey: "editing", orderedVisibleProjectIds: ["source"] } });
    await flush();
  });

  it("keeps Admin's internal Editing transport key for a cross-Stage move", async () => {
    authState.role = "admin";
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(editingMoveResponse()) : Promise.resolve({}));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await dndStart("source");
    await dndOver("source", "editing_autohdr");
    await dndEnd("source", "editing_autohdr");
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "editing_autohdr" }));
  });

  it("moves an Admin card into a keyless empty Stage with append placement and clean announcement", async () => {
    let projectFetches = 0;
    const settled = {
      projects: [summary("source", "editing_autohdr", 4), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["before", "target"], editing_autohdr: ["source"] } },
    };
    apiGetMock.mockImplementation((path) => path === "/api/projects"
      ? (projectFetches += 1, Promise.resolve(projectFetches === 1 ? response() : settled))
      : Promise.resolve({}));
    apiPostMock.mockResolvedValueOnce({
      changed: true,
      project: { projectId: "source", stageKey: "editing_autohdr", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "editing_autohdr", orderedVisibleProjectIds: ["source"] },
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await dndStart("source");
    await dndOver("source", "editing_autohdr");
    await dndEnd("source", "editing_autohdr");
    await flush(); await flush();

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({
      targetStageKey: "editing_autohdr",
      placement: { kind: "append" },
    }));
    const editingColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[data-focus-key="stage-heading:editing_autohdr"]'))!;
    expect([...editingColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["Source Street"]);
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toBe("Moved Source Street to Editing · autoHDR, position 1 of 1.");
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).not.toContain("Cancelled");
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).not.toContain("That position changed");
  });

  it("moves into a keyless empty Stage from Move to with an append, in one pick", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await openMoveTo(host, "source");
    expect(stageRadios().map((radio) => radio.textContent)).toEqual(["Awaiting RAW", "RAW review", "Editing · autoHDR"]);
    await act(async () => { stageRadio("Editing · autoHDR")!.click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[role="dialog"]'), "no position step follows the pick").toBeNull();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({
      targetStageKey: "editing_autohdr",
      placement: { kind: "append" },
    }));
  });

  it("keeps an assigned External Editor scoped while serializing a move into Editing", async () => {
    authState.role = "external_editor";
    const firstId = "123e4567-e89b-42d3-a456-426614174001";
    const secondId = "123e4567-e89b-42d3-a456-426614174002";
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(externalEditingMoveResponse()) : Promise.resolve({}));
    apiPostMock.mockResolvedValueOnce({ changed: true, project: { projectId: firstId, stageKey: "editing", boardRevision: 14 }, board: { sourceStageKey: "raw_review", targetStageKey: "editing", orderedVisibleProjectIds: [secondId, firstId] } });
    await act(async () => { root.render(<Dashboard currentUserId="external-1" role="external_editor" />); await Promise.resolve(); }); await flush();
    expect(host.textContent).toContain("External First Street");
    expect(host.textContent).toContain("External Second Street");
    await dndStart(firstId);
    await dndOver(firstId, secondId);
    await dndEnd(firstId, secondId);
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${firstId}/stage`, expect.objectContaining({ targetStageKey: "editing" }));
    expect(host.querySelectorAll('[data-testid="board-card-address"]')).toHaveLength(2);
    expect(host.textContent).not.toContain("Unassigned");
  });

  it("refuses an Admin same-Stage drag: no request, the Stage-sorted copy, and the handle back", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const handle = card(host, "target Street").querySelector<HTMLElement>('[data-testid="board-card"]')!;
    await dndStart("target");
    await dndOver("target", "before");
    await dndEnd("target", "before");
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toBe("target Street stays in RAW review. Columns are sorted by priority and shoot date.");
    const rawColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect(document.activeElement).toBe(handle);
  });

  it("routes an eligible keyboard cross-Stage drop through the exact Stage request and restores the handle", async () => {
    apiPostMock.mockResolvedValueOnce({ changed: true, project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 }, board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["before", "target", "source"] } });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const handle = card(host, "Source Street").querySelector<HTMLElement>('[data-testid="board-card"]')!;
    handle.focus();
    await dndStart("source", true);
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("card:source");
  });

  it("renders the optimistic overlay without writing the Dashboard query cache", async () => {
    let resolveMove!: (value: unknown) => void;
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { resolveMove = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-overlay-test");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    const key = dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" });
    const serverSnapshot = queryClient.getQueryData<ProjectSummary[]>(key);
    const setQueryData = vi.spyOn(queryClient, "setQueryData");
    const publish = vi.spyOn(runtime, "publish");
    await moveToStage(host, "Source Street", "RAW review");
    await flush();
    expect(setQueryData).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<ProjectSummary[]>(key)).toEqual(serverSnapshot);
    // Only the Stage changes in the overlay: the card renders at its SORTED slot (priority 1 beats unset), not at the end.
    const rawColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["Source Street", "before Street", "target Street"]);
    resolveMove({ changed: true, project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 }, board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["source", "before", "target"] } });
    await flush();
    const boardMessage = publish.mock.calls.map(([message]) => message).find((message) => message.type === "dashboard-board-invalidated");
    expect(boardMessage).toEqual(expect.objectContaining({ version: 1, type: "dashboard-board-invalidated" }));
    expect(boardMessage).not.toHaveProperty("projectId");
    runtime.dispose();
    queryClient.clear();
  });

  it("rolls back a Move to conflict with one POST, one refetch, and no retry", async () => {
    let projectFetches = 0;
    let rejectMove!: (reason: unknown) => void;
    apiGetMock.mockImplementation((path) => path === "/api/projects"
      ? (projectFetches += 1, Promise.resolve(response()))
      : Promise.resolve({}));
    apiPostMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectMove = reject; }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await moveToStage(host, "Source Street", "RAW review");
    await flush();
    const rawColumn = () => [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn().querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toContain("Source Street");
    rejectMove(new ApiError("Board conflict", 409, { code: "project_stage_conflict", current: { projectId: "source", stageKey: "awaiting_raw", boardRevision: 20 } }));
    await flush(); await flush();
    expect([...rawColumn().querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(projectFetches).toBe(2);
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("Board changed elsewhere");
  });

  it("keeps the principal alive when a Stage movement gets a capability 403", async () => {
    let projectFetches = 0;
    apiGetMock.mockImplementation((path) => path === "/api/projects"
      ? (projectFetches += 1, Promise.resolve(response()))
      : Promise.resolve({}));
    apiPostMock.mockRejectedValueOnce(new ApiError("Forbidden", 403, { capability: "moveProjectStage" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-movement-403-test");
    const markPrincipalTerminal = vi.spyOn(runtime, "markPrincipalTerminal");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    await dndStart("source");
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush(); await flush();

    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review" }));
    expect(markPrincipalTerminal).not.toHaveBeenCalled();
    expect(projectFetches).toBe(2);
    expect(card(host, "Source Street").closest<HTMLElement>('[data-testid="board-column"]')?.querySelector('[data-focus-key^="stage-heading:"]')?.textContent).toContain("Awaiting RAW");
    expect(isLocked(card(host, "Source Street").querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(false);
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("Forbidden");
    runtime.dispose();
    queryClient.clear();
  });

  it.each([
    ["board_contract_disabled", "Board interactions are temporarily unavailable while the Board contract is disabled."],
    ["board_schema_maintenance", "Board interactions are temporarily unavailable while the Board is being updated."],
  ] as const)("restores and disables movement controls on 503 %s", async (code, copy) => {
    let resolveRefresh!: (value: unknown) => void;
    let projectFetches = 0;
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      return projectFetches === 1 ? Promise.resolve(response()) : new Promise((resolve) => { resolveRefresh = resolve; });
    });
    apiPostMock.mockRejectedValueOnce(new ApiError("Board unavailable", 503, { code }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await moveToStage(host, "Source Street", "RAW review");
    await flush();
    expect(host.textContent).toContain(copy);
    expect(host.querySelector('[aria-label="Priority for target Street"]')).not.toBeNull();
    expect(isLocked(card(host, "target Street").querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(true);
    // Movement is off: the ⋯ trigger that fronts Move to stays, disabled — the principal cannot reach it.
    const moveTo = host.querySelector<HTMLButtonElement>('[data-testid="board-card-menu"]');
    expect(moveTo).not.toBeNull();
    expect(moveTo?.disabled).toBe(true);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    resolveRefresh(response());
    await flush();
  });

  it("locks Kanban sorting and preserves the drag proposal while an interaction is active", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const sort = displayTrigger(host)!;
    await dndStart("source");
    await dndOver("source", "target");
    expect(sort.disabled).toBe(true);
    await act(async () => { sort.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(displayMenu()).toBeNull();
    // The accepted card order stays fixed during a drag; the live proposal shows as a drop
    // indicator (dnd-kit transforms open the gap in the browser). The moving card ghosts in its
    // source column, and the blocked sort change leaves the proposal intact.
    const rawColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/target"]'))!;
    expect(rawColumn.querySelector('[data-testid="board-drop-indicator"]')).not.toBeNull();
    expect([...rawColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect([...card(host, "Source Street").closest<HTMLElement>('[data-testid="board-column"]')!.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["Source Street"]);
    await dndCancel("source");
  });

  it("never rewrites SortableContext order from the drag proposal, even as targets change", async () => {
    // Regression: reflowing the card lists on every onDragOver re-measured droppables, re-ran
    // collision detection against the moved geometry, and fed a new proposal back in — an
    // infinite render loop that unmounted the app (React #185). This now protects ReUI's
    // MeasuringStrategy.Always safety contract: the rendered order must stay pinned to the
    // accepted order for the whole drag; dnd-kit transforms + a drop indicator carry the proposal.
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await dndStart("source");
    sortable.contexts.length = 0;
    await dndOver("source", "target");
    await dndOver("source", "before");
    await dndOver("source", "raw_review");
    expect(sortable.contexts.length).toBeGreaterThan(0);
    // "source" only ever appears alone in its own (awaiting_raw) context — the proposal never
    // inserts it into raw_review's list.
    for (const items of sortable.contexts) {
      if (items.includes("source")) expect([...items]).toEqual(["source"]);
      else expect(items.includes("before") || items.includes("target") || items.length === 0).toBe(true);
    }
    await dndCancel("source");
  });

  it("defers a cross-tab Board invalidation during drag, then performs one post-block refetch without rebroadcasting", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    let projectFetches = 0;
    const freshResponse = { ...response(), projects: response().projects.map((project) => project.id === "source" ? { ...project, street: "Fresh Street" } : project) };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      return Promise.resolve(projectFetches === 1 ? response() : freshResponse);
    });
    const firstClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstRuntime = new ProjectQueryRuntime(firstClient, "drag-tab");
    const secondClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const secondRuntime = new ProjectQueryRuntime(secondClient, "other-tab");
    firstRuntime.start(); secondRuntime.start();
    const publish = vi.spyOn(firstRuntime, "publish");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={firstRuntime}><QueryClientProvider client={firstClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    expect(projectFetches).toBe(1);

    await dndStart("source");
    secondRuntime.publish(createDashboardBoardInvalidatedMessage());
    await flush();
    expect(projectFetches).toBe(2);
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Fresh Street");
    await dndCancel("source");
    await flush(); await flush();
    expect(projectFetches).toBe(3);
    expect(host.textContent).toContain("Fresh Street");
    expect(publish).not.toHaveBeenCalled();
    firstRuntime.dispose(); secondRuntime.dispose(); firstClient.clear(); secondClient.clear();
    vi.unstubAllGlobals();
  });

  it("renders one fixed order, priority then shoot date, with no sort choice and no fetch to change it", async () => {
    const sortProjects = [
      { ...summary("sort-source", "awaiting_raw", 4), street: "Sort Source", priority: 5, shootDate: "2026-08-15" },
      { ...summary("board-first", "raw_review", 1), street: "Board First", priority: 1, shootDate: "2026-08-30" },
      { ...summary("priority-first", "raw_review", 2), street: "Priority First", priority: 5, shootDate: "2026-09-01" },
      { ...summary("date-first", "raw_review", 3), street: "Date First", priority: 2, shootDate: "2026-08-01" },
      { ...summary("unset-late", "raw_review", 5), street: "Unset Late", priority: null, shootDate: "2026-07-01" },
    ];
    // The server's map is deliberately NOT the sorted order: the Board renders the data's order, not the map's.
    const sortSnapshot = {
      projects: sortProjects,
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["sort-source"], raw_review: ["board-first", "priority-first", "date-first", "unset-late"] } },
    };
    const settledSnapshot = {
      projects: sortProjects.map((project) => project.id === "sort-source" ? { ...project, stageKey: "raw_review" as const, boardRevision: 5 } : project),
      board: { contractEnabled: true, orderedProjectIdsByStage: { raw_review: ["sort-source", "priority-first", "date-first", "board-first", "unset-late"] } },
    };
    let projectFetches = 0;
    let moved = false;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? (projectFetches += 1, Promise.resolve(moved ? settledSnapshot : sortSnapshot)) : Promise.resolve({}));
    apiPostMock.mockImplementationOnce(() => {
      moved = true;
      return Promise.resolve({
        changed: true,
        project: { projectId: "sort-source", stageKey: "raw_review", boardRevision: 5 },
        board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["sort-source", "priority-first", "date-first", "board-first", "unset-late"] },
      });
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); });
    await flush();
    const rawColumn = () => [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/board-first"]'))!;
    const order = () => [...rawColumn().querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent);
    expect(order()).toEqual(["Priority First", "Date First", "Board First", "Unset Late"]);
    expect(projectFetches).toBe(1);

    // The drag proposal is a drop indicator over the frozen sorted order, not a live list rewrite. The mover
    // (priority 5, an older Shoot date) sorts first, ahead of Priority First, wherever in the column it is hovered.
    await dndStart("sort-source");
    await dndOver("sort-source", "unset-late");
    const indicator = rawColumn().querySelector('[data-testid="board-drop-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator!.parentElement!.textContent).toContain("Priority First");
    expect(order()).toEqual(["Priority First", "Date First", "Board First", "Unset Late"]);
    await dndCancel("sort-source");
    await flush();
    const fetchesBeforeMove = projectFetches;

    await moveToStage(host, "Sort Source", "RAW review");
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/sort-source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(order()).toEqual(["Sort Source", "Priority First", "Date First", "Board First", "Unset Late"]);
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toBe("Moved Sort Source to RAW review, position 1 of 5.");
    expect(projectFetches).toBeGreaterThanOrEqual(fetchesBeforeMove);
  });

  it("says the move changed nothing, at the card's sorted position, when the server reports changed:false", async () => {
    const noChangeSnapshot = {
      projects: [
        { ...summary("source", "awaiting_raw", 3), shootDate: "2026-08-02", priority: 3 },
        { ...summary("before", "raw_review", 8), shootDate: "2026-08-03", priority: 1 },
        { ...summary("target", "raw_review", 9), shootDate: "2026-08-01", priority: 2 },
      ],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source"], raw_review: ["before", "target"] } },
    };
    let projectFetches = 0;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? (projectFetches += 1, Promise.resolve(noChangeSnapshot)) : Promise.resolve({}));
    apiPostMock.mockResolvedValueOnce({
      changed: false,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["target", "source", "before"] },
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); });
    await flush();
    await dndStart("source");
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush();
    // Sorted: source (priority 3), target (2), before (1).
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toBe("Source Street is already in RAW review, position 1 of 3.");
    expect(host.querySelector('[data-testid="board-drop-indicator"]')).toBeNull();
    expect(document.querySelector('[data-testid="board-card-overlay"]')).toBeNull();
    const controls = movementControls(host);
    // A bare .every() would pass on an empty list.
    expect(controls).not.toHaveLength(0);
    expect(controls.every((element) => !isLocked(element))).toBe(true);
    expect(projectFetches).toBeGreaterThanOrEqual(1);
  });

  it("holds the cross-Stage settle barrier until the full source projection is accepted", async () => {
    let projectFetches = 0;
    let resolveSettle!: (value: unknown) => void;
    const winner = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["source", "before", "target"] },
    };
    const settledSnapshot = {
      projects: [summary("source", "raw_review", 4), summary("source-sibling-a", "awaiting_raw", 15), summary("source-sibling-b", "awaiting_raw", 16), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source-sibling-b", "source-sibling-a"], raw_review: ["target", "source", "before"] } },
    };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      return projectFetches === 1 ? Promise.resolve(settleInitialResponse()) : new Promise((resolve) => { resolveSettle = resolve; });
    });
    apiPostMock.mockImplementationOnce((path) => {
      expect(path).toBe("/api/projects/source/stage");
      return Promise.resolve(winner);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-settle-test");
    const publish = vi.spyOn(runtime, "publish");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    await dndStart("source");
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush();

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "dashboard-board-invalidated" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "project-data-invalidated", projectId: "source", resources: [{ kind: "detail" }, { kind: "activity" }] }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "production-calendar-invalidated" }));
    expect(invalidate.mock.calls.some(([options]) => options?.queryKey?.[0] === "dashboard-projects")).toBe(false);
    expect(projectFetches).toBe(2);
    const movedCard = card(host, "Source Street");
    expect(isLocked(movedCard.querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(true);
    // One ⋯ trigger fronts the one Move to item, so one disabled assertion covers it.
    expect(cardMenuTrigger(movedCard, "source")?.disabled).toBe(true);
    cardMenuTrigger(movedCard, "source")?.click();
    expect(document.querySelector('[role="menu"]'), "a locked card's menu opened").toBeNull();
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    const targetColumn = movedCard.closest<HTMLElement>('[data-testid="board-column"]')!;
    expect([...targetColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["Source Street", "before Street", "target Street"]);
    const provisionalSourceColumn = card(host, "source-sibling-a Street").closest<HTMLElement>('[data-testid="board-column"]')!;
    expect([...provisionalSourceColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["source-sibling-a Street", "source-sibling-b Street"]);
    resolveSettle(settledSnapshot);
    await flush();
    expect(projectFetches).toBe(2);
    const settledColumn = card(host, "Source Street").closest<HTMLElement>('[data-testid="board-column"]')!;
    expect([...settledColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["Source Street", "before Street", "target Street"]);
    // The settled snapshot's server map lists the siblings b, a: the Board renders the data's order, a then b.
    const settledSourceColumn = card(host, "source-sibling-b Street").closest<HTMLElement>('[data-testid="board-column"]')!;
    expect([...settledSourceColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["source-sibling-a Street", "source-sibling-b Street"]);
    const controls = movementControls(host);
    expect(controls).toHaveLength(10);
    expect(controls.every((element) => !isLocked(element))).toBe(true);
    expect(isLocked(card(host, "Source Street").querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(false);
    runtime.dispose();
    queryClient.clear();
  });

  it("keeps the settle barrier and recovery copy after a failed refetch, then releases on a later success", async () => {
    let projectFetches = 0;
    const winner = {
      changed: true,
      project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 },
      board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["source", "before", "target"] },
    };
    const settledSnapshot = {
      projects: [summary("source", "raw_review", 4), summary("source-sibling-a", "awaiting_raw", 25), summary("source-sibling-b", "awaiting_raw", 26), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["source-sibling-b", "source-sibling-a"], raw_review: ["target", "source", "before"] } },
    };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      if (projectFetches === 1) return Promise.resolve(settleInitialResponse());
      if (projectFetches === 2) return Promise.reject(new ApiError("Refresh failed", 409, { code: "project_stage_conflict" }));
      return Promise.resolve(settledSnapshot);
    });
    apiPostMock.mockImplementationOnce(() => Promise.resolve(winner));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-settle-failure-test");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    await dndStart("source");
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush(); await flush();
    expect(projectFetches).toBe(2);
    // Scope to the notice: the live region carries this exact copy as its announcement too, so host.textContent cannot tell them apart.
    expect(host.querySelector('[data-testid="board-unavailable-notice"]')?.textContent).toBe("The move was saved, but the latest Board could not be loaded. Refresh to continue.");
    expect([...card(host, "source-sibling-a Street").closest<HTMLElement>('[data-testid="board-column"]')!.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["source-sibling-a Street", "source-sibling-b Street"]);
    expect(isLocked(card(host, "Source Street").querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(true);
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    await flush();
    expect(projectFetches).toBe(3);
    expect(host.querySelector('[data-testid="board-unavailable-notice"]')).toBeNull();
    expect(isLocked(card(host, "Source Street").querySelector<HTMLElement>('[data-testid="board-card"]')!)).toBe(false);
    expect([...card(host, "source-sibling-b Street").closest<HTMLElement>('[data-testid="board-column"]')!.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["source-sibling-a Street", "source-sibling-b Street"]);
    const controls = movementControls(host);
    expect(controls).toHaveLength(10);
    expect(controls.every((element) => !isLocked(element))).toBe(true);
    runtime.dispose();
    queryClient.clear();
  });

  it.each(["project_archived_read_only", "inactive_destination", "stage_contract_reload_required"] as const)("rolls back generic 409 %s without retrying", async (code) => {
    let projectFetches = 0;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? (projectFetches += 1, Promise.resolve(response())) : Promise.resolve({}));
    apiPostMock.mockRejectedValueOnce(new ApiError("Move rejected", 409, { code }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" role="admin" />); await Promise.resolve(); }); await flush();
    await dndStart("source");
    // Keep the target populated so this exercises generic 409 handling, not the keyless-empty
    // Stage path covered above; inactive_destination still models a concurrent Stage edit.
    await dndOver("source", "target");
    await dndEnd("source", "target");
    await flush(); await flush();
    const rawColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review" }));
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(projectFetches).toBe(2);
  });

  it("moves by the Move to submenu, returns focus to the card's new ⋯, and announces the result", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    authState.moved = true;
    await moveToStage(host, "Source Street", "RAW review"); await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("card-menu:source");
    // The card jumped to its sorted slot in another column: the restored control is also scrolled into view.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollTo).toHaveBeenCalledWith(window.scrollX, window.scrollY);
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("Moved Source Street to RAW review, position");
  });

  it("moves into a collapsed Stage and puts focus on the rail's heading, since the card is not mounted there", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Collapse RAW review"]')!.click(); await Promise.resolve(); });
    expect(host.querySelector('[data-collapsed="true"]'), "anchor: RAW review is a rail").not.toBeNull();
    authState.moved = true;
    await moveToStage(host, "Source Street", "RAW review");
    await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("stage-heading:raw_review");
  });

  it("keeps the accepted snapshot while a Stage move is pending", async () => {
    let resolveMove!: (value: unknown) => void;
    let requestCount = 0;
    const freshResponse = { ...response(), projects: response().projects.map((project) => project.id === "source" ? { ...project, street: "Fresh Street" } : project) };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      requestCount += 1;
      return Promise.resolve(requestCount === 1 ? response() : freshResponse);
    });
    apiPostMock.mockReturnValueOnce(new Promise((resolve) => { resolveMove = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-pending-test");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    await moveToStage(host, "Source Street", "RAW review");
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ expected: { stageKey: "awaiting_raw", boardRevision: 3 } }));

    queryClient.setQueryData<ProjectSummary[]>(dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), (current) => current?.map((project) => project.id === "source" ? { ...project, street: "Incoming Street" } : project));
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Incoming Street");
    expect(requestCount).toBe(1);

    resolveMove({ changed: true, project: { stageKey: "raw_review", boardRevision: 4 } });
    await flush(); await flush();
    expect(requestCount).toBe(2);
    expect(host.textContent).toContain("Fresh Street");
    runtime.dispose();
    queryClient.clear();
  });

  it("keeps the accepted snapshot while confirmation is open, then cancels without a second request or optimistic Stage change", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("Confirmation required", 409, {
      code: "stage_confirmation_required",
      requiredConfirmation: { reasons: ["backward"] },
    }));
    let requestCount = 0;
    const freshResponse = { ...response(), projects: response().projects.map((project) => project.id === "source" ? { ...project, street: "Fresh Street" } : project) };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      requestCount += 1;
      return Promise.resolve(requestCount === 1 ? response() : freshResponse);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-confirm-test");
    await act(async () => {
      root.render(<><ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider><ConfirmModalHost /></>);
      await Promise.resolve();
    });
    await flush();
    await moveToStage(host, "Source Street", "RAW review");
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();

    queryClient.setQueryData<ProjectSummary[]>(dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), (current) => current?.map((project) => project.id === "source" ? { ...project, street: "Incoming Street" } : project));
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Incoming Street");

    document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!.click();
    await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(requestCount).toBe(2);
    expect(host.textContent).toContain("Fresh Street");
    const freshColumn = card(host, "Fresh Street").closest('[data-testid="board-column"]')!;
    expect(freshColumn.querySelector('[data-focus-key^="stage-heading:"]')?.textContent).toContain("Awaiting RAW");
    expect(freshColumn.querySelector('[data-focus-key^="stage-heading:"]')?.textContent).not.toContain("RAW review");
    runtime.dispose();
    queryClient.clear();
  });

  it("defers a background replacement while dragging, refetches once after, and lets terminal purge win", async () => {
    let requestCount = 0;
    let resolveBackground: ((value: unknown) => void) | undefined;
    let resolveLate: ((value: unknown) => void) | undefined;
    const oldResponse = response();
    const freshResponse = { ...response(), projects: response().projects.map((project) => project.id === "source" ? { ...project, street: "Fresh Street" } : project) };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      requestCount += 1;
      if (requestCount === 1) return Promise.resolve(oldResponse);
      if (requestCount === 2) return new Promise((resolve) => { resolveBackground = resolve; });
      if (requestCount === 3) return Promise.resolve(freshResponse);
      return new Promise((resolve) => { resolveLate = resolve; });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-refresh-test");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    expect(host.textContent).toContain("Source Street");

    const source = card(host, "Source Street");
    await dndStart("source");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    resolveBackground!(freshResponse);
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Fresh Street");

    await dndCancel("source");
    await flush();
    expect(requestCount).toBe(3);
    expect(host.textContent).toContain("Fresh Street");

    const fresh = card(host, "Fresh Street");
    await dndStart("source");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    runtime.markPrincipalTerminal();
    resolveLate!(freshResponse);
    await flush();
    expect(host.querySelector('[data-testid="board-card"]')).toBeNull();
    runtime.dispose();
    queryClient.clear();
  });

  it("purges a project removal immediately and does not accept its late response", async () => {
    let requestCount = 0;
    let resolveLate: ((value: unknown) => void) | undefined;
    const oldResponse = response();
    const freshResponse = { ...response(), projects: response().projects.map((project) => project.id === "source" ? { ...project, street: "Fresh Street" } : project) };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      requestCount += 1;
      if (requestCount === 1) return Promise.resolve(oldResponse);
      return new Promise((resolve) => { resolveLate = resolve; });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-project-removed-test");
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await flush();
    const source = card(host, "Source Street");
    await dndStart("source");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    runtime.markProjectRemoved("source");
    await flush();
    expect(host.querySelector('[href="/projects/source"]')).toBeNull();
    const currentDnd = dnd.handlers.at(-1);
    const cancelHandler = currentDnd?.cancel;
    const announcementHandler = currentDnd?.props.accessibility?.announcements?.onDragCancel;
    if (!cancelHandler || !announcementHandler) throw new Error("No terminal drag-cancel handlers were rendered");
    await act(async () => { cancelHandler({ active: { id: "source" }, over: null }); await Promise.resolve(); });
    expect(announcementHandler({} as Parameters<typeof announcementHandler>[0])).toBeUndefined();
    expect(document.querySelector('[data-testid="board-card-overlay"]')).toBeNull();
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.textContent).not.toContain("Source Street");
    resolveLate!(freshResponse);
    await flush();
    expect(host.textContent).not.toContain("Fresh Street");
    expect(host.querySelector('[href="/projects/source"]')).toBeNull();
    runtime.dispose();
    queryClient.clear();
  });

  it.each([401, 403])("purges accepted data immediately on %s access loss", async (status) => {
    let requestCount = 0;
    const oldResponse = response();
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      requestCount += 1;
      return requestCount === 1 ? Promise.resolve(oldResponse) : Promise.reject(new ApiError("Access lost", status));
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, `dashboard-access-loss-${status}`);
    await act(async () => { root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Source Street");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, { archived: "hide" }), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    await flush();
    expect(requestCount).toBe(2);
    expect(host.querySelector('[data-testid="board-card"]')).toBeNull();
    // The access-loss response is terminal for this accepted snapshot; later promise turns do not
    // repopulate private project markup through the stale query data.
    await flush();
    expect(host.querySelector('[data-testid="board-card"]')).toBeNull();
    runtime.dispose();
    queryClient.clear();
  });

  it("keeps External Editor presentation stages and renders their data-sorted order", async () => {
    authState.role = "external_editor";
    const firstId = "123e4567-e89b-42d3-a456-426614174001";
    const secondId = "123e4567-e89b-42d3-a456-426614174002";
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(externalResponse()) : Promise.resolve({}));
    await act(async () => { root.render(<Dashboard currentUserId="external-1" role="external_editor" />); await Promise.resolve(); });
    await flush();
    const editingColumn = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((column) => column.querySelector('[href="/projects/123e4567-e89b-42d3-a456-426614174001"]'));
    expect(editingColumn).not.toBeUndefined();
    expect([...editingColumn!.querySelectorAll<HTMLElement>('[data-testid="board-card-address"]')].map((element) => element.textContent)).toEqual(["External First Street", "External Second Street"]);
    expect(editingColumn!.textContent).toContain("Editing");
    expect(host.querySelector('[aria-label="Priority for External First Street"]')).toBeNull();
    // The server's map for this role lists Second before First; the Board renders the data's order (street
    // for an External Editor, whose summaries carry no priority), which is also what the server's map is built from.
    await openCardMenu(host, firstId);
    expect(menuItems().map((item) => item.textContent)).toEqual(["Move to"]);
    await closeMenus();
    expect([...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].some((column) => /Priority|Shoot date/.test(column.textContent ?? ""))).toBe(false);

    await dndStart(firstId);
    await dndOver(firstId, secondId);
    await dndEnd(firstId, secondId);
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
