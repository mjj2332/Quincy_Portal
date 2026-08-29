import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./Dashboard";
import { dashboardProjectsKey } from "../lib/dashboard-projects";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

const authState = vi.hoisted(() => ({ role: "admin" as "admin" | "editor", moved: false }));
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
    ],
    presentationStageKey: (key: string) => key,
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
      targetStageKey: "raw_review",
      placement: { kind: "between", before: { projectId: "before", boardRevision: 8 }, after: { projectId: "target", boardRevision: 9 } },
    }));

    const nextSource = card(host, "Source Street");
    await act(async () => { nextSource.querySelector<HTMLAnchorElement>(".kcard")!.dispatchEvent(dragEvent("dragstart")); await Promise.resolve(); });
    const rawColumn = host.querySelectorAll<HTMLElement>(".kcol")[1]!;
    rawColumn.dispatchEvent(dragEvent("drop"));
    await flush();
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
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
    move.focus(); move.value = "raw_review";
    authState.moved = true;
    await act(async () => { move.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); }); await flush(); await flush();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects/source/stage", expect.objectContaining({ targetStageKey: "raw_review", placement: { kind: "append" } }));
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("move-stage:source");
    expect(host.querySelector(".dashboard-live-region")?.textContent).toContain("Moved Source Street to RAW review.");
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
});
