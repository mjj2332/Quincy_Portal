import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionCalendarKey } from "../lib/production-calendar-query";
import { projectDataKeys } from "../lib/project-data";
import { ProjectQueryRuntime } from "../lib/project-query-sync";
import { PrincipalFreshnessBoundary } from "./PrincipalFreshnessBoundary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const sessionRefetchMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ refetch: sessionRefetchMock }) }));

const principal = "11111111-1111-4111-8111-111111111111";
const otherPrincipal = "99999999-9999-4999-8999-999999999999";
const project = "22222222-2222-4222-8222-222222222222";
const cycleOne = "33333333-3333-4333-8333-333333333333";
const cycleTwo = "44444444-4444-4444-8444-444444444444";

function snapshot(projects: Array<{ projectId: string; membershipCycleIds: string[] }>, id = principal) {
  return {
    principal: { id, role: "editor", authorizationEpoch: 0 },
    authorizationFingerprint: `${id}-${projects.length}-${projects[0]?.membershipCycleIds.join("-") ?? "none"}`,
    projects,
  };
}

const calendarFilters = {
  layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function seedCalendar(client: QueryClient, id: string, value: number) {
  client.setQueryData(productionCalendarKey(
    { principalId: id, role: "editor", authorizationEpoch: 0 },
    "active",
    { start: `2026-08-${String(value).padStart(2, "0")}`, end: `2026-09-${String(value).padStart(2, "0")}` },
    "month",
    calendarFilters,
  ), { value });
}

describe("PrincipalFreshnessBoundary Calendar purge", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let runtime: ProjectQueryRuntime | undefined;

  beforeEach(() => {
    apiGetMock.mockReset();
    sessionRefetchMock.mockReset();
    window.history.replaceState(null, "", "/");
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    runtime?.dispose();
    runtime = undefined;
    client.clear();
    host.remove();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  }

  // The boundary purge is an async useQuery-observer -> re-render -> effect chain.
  // A fixed tick count is flaky under parallel-worker load, so poll the outcome.
  async function waitFor(assertion: () => void) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { assertion(); return; } catch { /* not settled yet */ }
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assertion();
  }

  function renderBoundary() {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <PrincipalFreshnessBoundary principalId={principal} role="editor" authorizationEpoch={0}>
            <span>Dashboard</span>
          </PrincipalFreshnessBoundary>
        </QueryClientProvider>,
      );
    });
  }

  it("removes every cached Calendar range for the principal before project tombstones, preserving another principal", async () => {
    apiGetMock.mockResolvedValueOnce(snapshot([{ projectId: project, membershipCycleIds: [cycleOne] }]));
    renderBoundary();
    // Wait until the boundary has actually accepted the first snapshot (its effect
    // captured previous.current) before staging the membership change.
    await waitFor(() => expect(client.getQueryData(["authorization-scope", principal, "editor", 0])).toBeDefined());
    await act(async () => { await flush(); });

    seedCalendar(client, principal, 1);
    seedCalendar(client, principal, 2);
    seedCalendar(client, otherPrincipal, 3);

    await act(async () => {
      client.setQueryData(["authorization-scope", principal, "editor", 0], snapshot([{ projectId: project, membershipCycleIds: [cycleTwo] }]));
      await flush();
    });

    await waitFor(() => {
      expect(client.getQueryCache().findAll({ queryKey: ["production-calendar", principal] })).toHaveLength(0);
      expect(client.getQueryCache().findAll({ queryKey: ["production-calendar", otherPrincipal] })).toHaveLength(1);
    });
  });

  it("purges the Calendar family when the authorization scope refresh returns a different principal", async () => {
    seedCalendar(client, principal, 1);
    seedCalendar(client, principal, 2);
    apiGetMock.mockResolvedValueOnce(snapshot([], otherPrincipal));
    renderBoundary();

    await act(async () => { await flush(); });
    await waitFor(() => {
      expect(client.getQueryCache().findAll({ queryKey: ["production-calendar", principal] })).toHaveLength(0);
    });
  });

  it("keeps a canonical Calendar location while removing project data on access loss", async () => {
    runtime = new ProjectQueryRuntime(client, "boundary-test");
    client.setQueryData(projectDataKeys.detail(project), { id: project, street: "Stale detail" });
    const location = "/?view=calendar&date=2026-08-31&sub=month&layers=project%2Cchecklist";
    window.history.replaceState(null, "", location);
    apiGetMock.mockResolvedValueOnce(snapshot([{ projectId: project, membershipCycleIds: [cycleOne] }]));
    renderBoundary();
    await waitFor(() => expect(client.getQueryData(["authorization-scope", principal, "editor", 0])).toBeDefined());

    await act(async () => {
      client.setQueryData(["authorization-scope", principal, "editor", 0], snapshot([]));
      await flush();
    });

    await waitFor(() => expect(runtime?.removedProjectIds.has(project)).toBe(true));
    expect(`${window.location.pathname}${window.location.search}`).toBe(location);
    await waitFor(() => expect(client.getQueryData(projectDataKeys.detail(project))).toBeUndefined());
  });

  it("redirects a lost Workspace project to the Dashboard", async () => {
    runtime = new ProjectQueryRuntime(client, "boundary-workspace-test");
    window.history.replaceState(null, "", `/projects/${project}`);
    apiGetMock.mockResolvedValueOnce(snapshot([{ projectId: project, membershipCycleIds: [cycleOne] }]));
    renderBoundary();
    await waitFor(() => expect(client.getQueryData(["authorization-scope", principal, "editor", 0])).toBeDefined());

    await act(async () => {
      client.setQueryData(["authorization-scope", principal, "editor", 0], snapshot([]));
      await flush();
    });

    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe("/"));
  });

});
