import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard, type ProjectSummary } from "./Dashboard";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { ApiError } from "../lib/api";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

const authState = vi.hoisted(() => ({ role: "admin" as "admin" | "editor" | "external_editor", moved: false }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
type DndTestEvent = { active: { id: string; data?: unknown }; over: { id: string; data?: unknown } | null };
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ start?: (event: DndTestEvent) => void; over?: (event: DndTestEvent) => void; end?: (event: DndTestEvent) => void; cancel?: (event: DndTestEvent) => void }> }));
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ start: props.onDragStart as ((event: DndTestEvent) => void) | undefined, over: props.onDragOver as ((event: DndTestEvent) => void) | undefined, end: props.onDragEnd as ((event: DndTestEvent) => void) | undefined, cancel: props.onDragCancel as ((event: DndTestEvent) => void) | undefined });
      return createElement(actual.DndContext, props);
    },
  };
});
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: authState.role } } }) }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: authState.role, capabilities: authState.role === "admin" ? ["moveProjectStage", "prioritizeProjects"] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" || (capability === "prioritizeProjects" && authState.role === "admin") }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
      { key: "editing_autohdr", label: "Editing · autoHDR", displayOrder: 3, active: true },
      { key: "editing", label: "Editing", displayOrder: 3, active: true },
    ],
    presentationStageKey: (key: string) => key === "editing_autohdr" ? "editing" : key,
  }),
}));
vi.mock("../components/NoticeBoard", () => ({ NoticeBoard: () => null }));

const boardOrder = { awaiting_raw: ["source"], raw_review: ["before", "target"], editing_autohdr: [] };

function summary(id: string, stageKey: "awaiting_raw" | "raw_review" | "editing_autohdr", boardRevision: number) {
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

function cardData(stageKey: "awaiting_raw" | "raw_review" | "editing_autohdr", projectId: string) {
  return { current: { kind: "card", stageKey, projectId } };
}

function columnData(stageKey: "awaiting_raw" | "raw_review" | "editing_autohdr") {
  return { current: { kind: "column", stageKey } };
}

function dndEvent(activeId: string, activeData: unknown, over: { id: string; data: unknown } | null = null): DndTestEvent {
  return { active: { id: activeId, data: activeData }, over };
}

async function dndStart(activeId: string, stageKey: "awaiting_raw" | "raw_review" | "editing_autohdr") {
  const handler = dnd.handlers.at(-1)?.start;
  if (!handler) throw new Error("No DndContext drag-start handler was rendered");
  await act(async () => { handler(dndEvent(activeId, cardData(stageKey, activeId))); await Promise.resolve(); });
}

async function dndOver(activeId: string, activeStage: "awaiting_raw" | "raw_review" | "editing_autohdr", overId: string, overData: unknown) {
  const handler = dnd.handlers.at(-1)?.over;
  if (!handler) throw new Error("No DndContext drag-over handler was rendered");
  await act(async () => { handler(dndEvent(activeId, cardData(activeStage, activeId), { id: overId, data: overData })); await Promise.resolve(); });
}

async function dndEnd(activeId: string, activeStage: "awaiting_raw" | "raw_review" | "editing_autohdr", over: { id: string; data: unknown } | null) {
  const handler = dnd.handlers.at(-1)?.end;
  if (!handler) throw new Error("No DndContext drag-end handler was rendered");
  await act(async () => { handler(dndEvent(activeId, cardData(activeStage, activeId), over)); await Promise.resolve(); });
}

async function dndCancel(activeId: string, stageKey: "awaiting_raw" | "raw_review" | "editing_autohdr") {
  const handler = dnd.handlers.at(-1)?.cancel;
  if (!handler) throw new Error("No DndContext drag-cancel handler was rendered");
  await act(async () => { handler(dndEvent(activeId, cardData(stageKey, activeId))); await Promise.resolve(); });
}

function card(host: HTMLElement, street: string) {
  const address = [...host.querySelectorAll<HTMLElement>(".kcard__addr")].find((element) => element.textContent === street);
  if (!address) throw new Error(`Missing card ${street}`);
  return address.closest<HTMLElement>(".kcard-wrap")!;
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
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(response()) : Promise.resolve({}));
    apiPostMock.mockImplementation((path) => path.endsWith("/board-position")
      ? Promise.resolve({ changed: true, project: { projectId: "before", stageKey: "raw_review", boardRevision: 10 }, board: { sourceStageKey: "raw_review", targetStageKey: "raw_review", orderedVisibleProjectIds: ["target", "before"] } })
      : Promise.resolve({ changed: true, project: { projectId: "source", stageKey: "raw_review", boardRevision: 4 }, board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["before", "target", "source"] } }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("uses exact authorized-map neighbours for a card boundary and append for a column background", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const source = card(host, "Source Street"); const target = card(host, "target Street");
    await dndStart("source", "awaiting_raw");
    await dndOver("source", "awaiting_raw", "target", cardData("raw_review", "target"));
    await dndEnd("source", "awaiting_raw", { id: "target", data: cardData("raw_review", "target") });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "before", boardRevision: 8 }, after: { projectId: "target", boardRevision: 9 } },
    }));

    const nextSource = card(host, "Source Street");
    await dndStart("source", "awaiting_raw");
    await dndOver("source", "awaiting_raw", "column:raw_review", columnData("raw_review"));
    await dndEnd("source", "awaiting_raw", { id: "column:raw_review", data: columnData("raw_review") });
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
    await dndStart("before", "raw_review");
    await dndOver("before", "raw_review", "target", cardData("raw_review", "target"));
    await dndEnd("before", "raw_review", { id: "target", data: cardData("raw_review", "target") });
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("routes Admin same-Stage Board-order drag to board-position with exact placement", async () => {
    let resolveMove!: (value: unknown) => void;
    apiPostMock.mockImplementationOnce((path) => {
      expect(path).toBe("/api/projects/target/board-position");
      return new Promise((resolve) => { resolveMove = resolve; });
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await dndStart("target", "raw_review");
    await dndOver("target", "raw_review", "before", cardData("raw_review", "before"));
    await dndEnd("target", "raw_review", { id: "before", data: cardData("raw_review", "before") });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/target/board-position", {
      expected: { stageKey: "raw_review", boardRevision: 9 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: null, after: { projectId: "before", boardRevision: 8 } },
    });
    expect(apiPostMock.mock.calls.some(([path]) => path.endsWith("/stage"))).toBe(false);
    const rawColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["target Street", "before Street"]);
    resolveMove({ changed: true, project: { projectId: "target", stageKey: "raw_review", boardRevision: 10 }, board: { sourceStageKey: "raw_review", targetStageKey: "raw_review", orderedVisibleProjectIds: ["target", "before"] } });
    await flush();
  });

  it("routes Board-order arrows through the same board-position orchestrator", async () => {
    let resolveMove!: (value: unknown) => void;
    apiPostMock.mockImplementationOnce((path) => {
      expect(path).toBe("/api/projects/target/board-position");
      return new Promise((resolve) => { resolveMove = resolve; });
    });
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click();
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/target/board-position", {
      expected: { stageKey: "raw_review", boardRevision: 9 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: null, after: { projectId: "before", boardRevision: 8 } },
    });
    expect(apiPostMock.mock.calls.some(([path]) => path.endsWith("/stage"))).toBe(false);
    resolveMove({ changed: true, project: { projectId: "target", stageKey: "raw_review", boardRevision: 10 }, board: { sourceStageKey: "raw_review", targetStageKey: "raw_review", orderedVisibleProjectIds: ["target", "before"] } });
    await flush();
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
    const key = dashboardProjectsKey("admin-1", "photographer", 0, false);
    const serverSnapshot = queryClient.getQueryData<ProjectSummary[]>(key);
    const setQueryData = vi.spyOn(queryClient, "setQueryData");
    await act(async () => { card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(setQueryData).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<ProjectSummary[]>(key)).toEqual(serverSnapshot);
    const rawColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["target Street", "before Street"]);
    resolveMove({ changed: true, project: { projectId: "target", stageKey: "raw_review", boardRevision: 10 }, board: { sourceStageKey: "raw_review", targetStageKey: "raw_review", orderedVisibleProjectIds: ["target", "before"] } });
    await flush();
    runtime.dispose();
    queryClient.clear();
  });

  it("rolls back a same-Stage conflict with one POST, one refetch, and no retry", async () => {
    let projectFetches = 0;
    let rejectMove!: (reason: unknown) => void;
    apiGetMock.mockImplementation((path) => path === "/api/projects"
      ? (projectFetches += 1, Promise.resolve(response()))
      : Promise.resolve({}));
    apiPostMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectMove = reject; }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await act(async () => { card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click(); await Promise.resolve(); });
    await flush();
    const optimisticColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...optimisticColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["target Street", "before Street"]);
    rejectMove(new ApiError("Board conflict", 409, { code: "project_stage_conflict", current: { projectId: "target", stageKey: "raw_review", boardRevision: 20 } }));
    await flush(); await flush();
    const restoredColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...restoredColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(projectFetches).toBe(2);
    expect(host.querySelector(".dashboard-live-region")?.textContent).toContain("Board changed elsewhere");
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
    await act(async () => { card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain(copy);
    expect(host.querySelector('select[aria-label="Priority"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Move target Street"]')?.getAttribute("disabled")).toBe("");
    expect(host.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(host.querySelector('[aria-label="Move target Street to Stage"]')).toBeNull();
    resolveRefresh(response());
    await flush();
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
      projects: [summary("source", "raw_review", 4), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [], raw_review: ["target", "source", "before"], editing_autohdr: [] } },
    };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      return projectFetches === 1 ? Promise.resolve(response()) : new Promise((resolve) => { resolveSettle = resolve; });
    });
    apiPostMock.mockImplementationOnce((path) => {
      expect(path).toBe("/api/projects/source/stage");
      return Promise.resolve(winner);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "dashboard-settle-test");
    await act(async () => {
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await flush();
    await dndStart("source", "awaiting_raw");
    await dndOver("source", "awaiting_raw", "target", cardData("raw_review", "target"));
    await dndEnd("source", "awaiting_raw", { id: "target", data: cardData("raw_review", "target") });
    await flush();

    expect(projectFetches).toBe(2);
    const movedCard = card(host, "Source Street");
    expect(movedCard.querySelector<HTMLButtonElement>('[aria-label="Move Source Street"]')?.disabled).toBe(true);
    expect(movedCard.querySelector<HTMLSelectElement>('[aria-label="Move Source Street to Stage"]')?.disabled).toBe(true);
    expect(movedCard.querySelector<HTMLButtonElement>('[aria-label="Move project up"]')?.disabled).toBe(true);
    movedCard.querySelector<HTMLButtonElement>('[aria-label="Move project up"]')?.click();
    expect(apiPostMock).toHaveBeenCalledTimes(1);

    const targetColumn = movedCard.closest<HTMLElement>(".kcol")!;
    expect([...targetColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["Source Street", "before Street", "target Street"]);
    resolveSettle(settledSnapshot);
    await flush();
    expect(projectFetches).toBe(2);
    const settledColumn = card(host, "Source Street").closest<HTMLElement>(".kcol")!;
    expect([...settledColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["target Street", "Source Street", "before Street"]);
    expect(card(host, "Source Street").querySelector<HTMLButtonElement>('[aria-label="Move Source Street"]')?.disabled).toBe(false);
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
      projects: [summary("source", "raw_review", 4), summary("before", "raw_review", 8), summary("target", "raw_review", 9)],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: [], raw_review: ["target", "source", "before"], editing_autohdr: [] } },
    };
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({});
      projectFetches += 1;
      if (projectFetches === 1) return Promise.resolve(response());
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
    await dndStart("source", "awaiting_raw");
    await dndOver("source", "awaiting_raw", "target", cardData("raw_review", "target"));
    await dndEnd("source", "awaiting_raw", { id: "target", data: cardData("raw_review", "target") });
    await flush(); await flush();
    expect(projectFetches).toBe(2);
    expect(host.textContent).toContain("The move was saved, but the latest Board could not be loaded. Refresh to continue.");
    expect(card(host, "Source Street").querySelector<HTMLButtonElement>('[aria-label="Move Source Street"]')?.disabled).toBe(true);
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    await flush();
    expect(projectFetches).toBe(3);
    expect(host.querySelector('.muted[role="status"]')?.textContent ?? "").not.toContain("The move was saved, but the latest Board could not be loaded. Refresh to continue.");
    expect(card(host, "Source Street").querySelector<HTMLButtonElement>('[aria-label="Move Source Street"]')?.disabled).toBe(false);
    runtime.dispose();
    queryClient.clear();
  });

  it.each(["project_archived_read_only", "inactive_destination", "stage_contract_reload_required"] as const)("rolls back generic 409 %s without retrying", async (code) => {
    let projectFetches = 0;
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? (projectFetches += 1, Promise.resolve(response())) : Promise.resolve({}));
    apiPostMock.mockRejectedValueOnce(new ApiError("Move rejected", 409, { code }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await act(async () => { card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click(); await Promise.resolve(); });
    await flush(); await flush();
    const rawColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/before"]'))!;
    expect([...rawColumn.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["before Street", "target Street"]);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(projectFetches).toBe(2);
  });

  it("uses the capability-only Board-position 403 response for the Priority-access copy", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("Forbidden", 403, { error: "Forbidden", capability: "prioritizeProjects" }));
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    await act(async () => { card(host, "target Street").querySelector<HTMLButtonElement>('[aria-label="Move project up"]')!.click(); await Promise.resolve(); });
    await flush(); await flush();
    expect(host.querySelector(".dashboard-live-region")?.textContent).toContain("Manual Board reorder requires Priority access.");
  });

  it("moves by keyboard action, returns focus, and announces the result", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const move = host.querySelector<HTMLSelectElement>('[aria-label="Move Source Street to Stage"]')!;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    move.focus(); move.value = "raw_review";
    authState.moved = true;
    await act(async () => { move.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); }); await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(["stage-heading:raw_review", "board", "move-stage:source"]).toContain(document.activeElement?.getAttribute("data-focus-key"));
    expect(scrollTo).toHaveBeenCalledWith(window.scrollX, window.scrollY);
    expect(host.querySelector(".dashboard-live-region")?.textContent).toContain("Moved Source Street to RAW review, position");
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
    const move = host.querySelector<HTMLSelectElement>('[aria-label="Move Source Street to Stage"]')!;
    move.value = "raw_review";
    await act(async () => { move.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ expected: { stageKey: "awaiting_raw", boardRevision: 3 } }));

    queryClient.setQueryData<ProjectSummary[]>(dashboardProjectsKey("admin-1", "photographer", 0, false), (current) => current?.map((project) => project.id === "source" ? { ...project, street: "Incoming Street" } : project));
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
    const move = host.querySelector<HTMLSelectElement>('[aria-label="Move Source Street to Stage"]')!;
    move.value = "raw_review";
    await act(async () => { move.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();

    queryClient.setQueryData<ProjectSummary[]>(dashboardProjectsKey("admin-1", "photographer", 0, false), (current) => current?.map((project) => project.id === "source" ? { ...project, street: "Incoming Street" } : project));
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Incoming Street");

    document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!.click();
    await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(requestCount).toBe(2);
    expect(host.textContent).toContain("Fresh Street");
    const freshColumn = card(host, "Fresh Street").closest(".kcol")!;
    expect(freshColumn.querySelector(".kcol__head")?.textContent).toContain("Awaiting RAW");
    expect(freshColumn.querySelector(".kcol__head")?.textContent).not.toContain("RAW review");
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
    await dndStart("source", "awaiting_raw");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    resolveBackground!(freshResponse);
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Fresh Street");

    await dndCancel("source", "awaiting_raw");
    await flush();
    expect(requestCount).toBe(3);
    expect(host.textContent).toContain("Fresh Street");

    const fresh = card(host, "Fresh Street");
    await dndStart("source", "awaiting_raw");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    runtime.markPrincipalTerminal();
    resolveLate!(freshResponse);
    await flush();
    expect(host.querySelector(".kcard")).toBeNull();
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
    await dndStart("source", "awaiting_raw");
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    runtime.markProjectRemoved("source");
    await flush();
    expect(host.querySelector('[href="/projects/source"]')).toBeNull();
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
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    await flush();
    expect(requestCount).toBe(2);
    expect(host.querySelector(".kcard")).toBeNull();
    // The access-loss response is terminal for this accepted snapshot; later promise turns do not
    // repopulate private project markup through the stale query data.
    await flush();
    expect(host.querySelector(".kcard")).toBeNull();
    runtime.dispose();
    queryClient.clear();
  });

  it("keeps External Editor order and presentation stages from the external authorized projection", async () => {
    authState.role = "external_editor";
    const firstId = "123e4567-e89b-42d3-a456-426614174001";
    const secondId = "123e4567-e89b-42d3-a456-426614174002";
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(externalResponse()) : Promise.resolve({}));
    await act(async () => { root.render(<Dashboard currentUserId="external-1" role="external_editor" />); await Promise.resolve(); });
    await flush();
    const editingColumn = [...host.querySelectorAll<HTMLElement>(".kcol")].find((column) => column.querySelector('[href="/projects/123e4567-e89b-42d3-a456-426614174001"]'));
    expect(editingColumn).not.toBeUndefined();
    expect([...editingColumn!.querySelectorAll<HTMLElement>(".kcard__addr")].map((element) => element.textContent)).toEqual(["External Second Street", "External First Street"]);
    expect(editingColumn!.textContent).toContain("Editing");
    expect(host.querySelector('select[aria-label="Priority"]')).toBeNull();
    expect(host.querySelector('[aria-label="Move project up"]')).toBeNull();
    expect(host.querySelector('[aria-label="Move project down"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLElement>(".kcol")].some((column) => /Priority|Shoot date/.test(column.textContent ?? ""))).toBe(false);

    await dndStart(firstId, "editing_autohdr");
    await dndOver(firstId, "editing_autohdr", secondId, cardData("editing_autohdr", secondId));
    await dndEnd(firstId, "editing_autohdr", { id: secondId, data: cardData("editing_autohdr", secondId) });
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
