import { act } from "react";
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
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
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

function dragEvent(type: string, clientY = 10) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", setData: vi.fn() } });
  return event;
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
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(response()) : Promise.resolve({}));
    apiPostMock.mockResolvedValue({ changed: true, project: { stageKey: "raw_review", boardRevision: 4 } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("uses exact authorized-map neighbours for a card boundary and append for a column background", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const source = card(host, "Source Street"); const target = card(host, "target Street");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
    await act(async () => { source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    target.dispatchEvent(dragEvent("dragover", 10));
    target.dispatchEvent(dragEvent("drop", 10));
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({
      expected: { stageKey: "awaiting_raw", boardRevision: 3 },
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "before", boardRevision: 8 }, after: { projectId: "target", boardRevision: 9 } },
    }));

    const nextSource = card(host, "Source Street");
    await act(async () => { nextSource.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    const rawColumn = host.querySelectorAll<HTMLElement>(".kcol")[1]!;
    rawColumn.dispatchEvent(dragEvent("drop"));
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
    const source = card(host, "before Street"); const target = card(host, "target Street");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
    await act(async () => { source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    target.dispatchEvent(dragEvent("drop", 10));
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("moves by keyboard action, returns focus, and announces the result", async () => {
    await act(async () => { root.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); }); await flush();
    const move = host.querySelector<HTMLSelectElement>('[aria-label="Move Source Street to Stage"]')!;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    move.focus(); move.value = "raw_review";
    authState.moved = true;
    await act(async () => { move.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); }); await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("move-stage:source");
    expect(scrollTo).toHaveBeenCalledWith(window.scrollX, window.scrollY);
    expect(host.querySelector(".dashboard-live-region")?.textContent).toContain("Moved Source Street to RAW review.");
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
    await act(async () => { source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    resolveBackground!(freshResponse);
    await flush();
    expect(host.textContent).toContain("Source Street");
    expect(host.textContent).not.toContain("Fresh Street");

    source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragend"));
    await flush();
    expect(requestCount).toBe(3);
    expect(host.textContent).toContain("Fresh Street");

    const fresh = card(host, "Fresh Street");
    await act(async () => { fresh.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
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
    await act(async () => { source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: dashboardProjectsKey("admin-1", "photographer", 0, false), exact: true, refetchType: "active" });
      await Promise.resolve();
    });
    expect(requestCount).toBe(2);
    runtime.markProjectRemoved("source");
    await flush();
    expect(host.textContent).not.toContain("Source Street");
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

    const source = card(host, "External First Street");
    const target = card(host, "External Second Street");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
    await act(async () => { source.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    target.dispatchEvent(dragEvent("drop", 10));
    await flush();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
