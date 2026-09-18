import { authorizedBoardRank, type ExternalProjectSummaryDto, type Role } from "@quincy/shared";
import { keepPreviousData, skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet, externalProjectSummaryToDashboard } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import { getProjectQueryRuntime } from "./project-query-sync";
import type { ProjectSummary } from "./kanban-interaction";

export type DashboardProjectSearchCounts = { query: string; matching: number; total: number };

type ProjectsResponse = {
  projects: ProjectSummary[];
  board?: { contractEnabled: boolean; orderedProjectIdsByStage: Record<string, string[]> };
  search?: DashboardProjectSearchCounts;
};
export type DashboardIdentity = { principalId: string; role: Role; authorizationEpoch: number };

/**
 * Option A: sort is a derived interaction identity, not a network input. Keep this five-element
 * authorization-scoped key stable: removeProjectFromDashboardQueries relies on its
 * ["dashboard-projects", principalId] prefix, and exact Dashboard invalidations rely on the full
 * tuple. Future key widening must audit both consumers.
 *
 * `q` (#217) widens the trailing object rather than adding a sixth element, and defaults to `""`
 * so every existing call site (and the manually-constructed literal keys in
 * `project-data.test.ts`, which never call this function) keeps compiling. `dashboardProjectsKey`
 * is the sole producer of its own key shape, so nothing depends on `{ archived }` (no `q`) hashing
 * the same as `{ archived, q }` — a manually-constructed key is compared to itself, not to this
 * function's output.
 *
 * The cached VALUE under this key stays `ProjectSummary[]` — never `{ projects, search }` — because
 * production code (`Dashboard.tsx`'s optimistic Board `setQueryData<ProjectSummary[]>`) and the
 * stage-interaction tests write it as a bare array via `setQueryData`'s unchecked generic; a shape
 * change here fails silently on that path. Search counts live in the sibling
 * `dashboardProjectSearchKey` cache entry instead, written once per fetch by this hook's `queryFn`.
 */
export function dashboardProjectsKey(principalId: string, role: Role, authorizationEpoch: number, archived: boolean, q: string = "") {
  return ["dashboard-projects", principalId, role, authorizationEpoch, { archived, q }] as const;
}

/**
 * A different `key[0]` (`"dashboard-project-search"`, not `"dashboard-projects"`) so the prefix
 * scans in `removeProjectFromDashboardQueries` (below) and `project-query-sync.ts`'s
 * `dashboard-board-invalidated` handler don't pick this up as a projects-list query. Never fetched
 * directly — `useDashboardProjectSearch` reads it with `queryFn: skipToken`; the projects `queryFn`
 * below is its only writer, via `client.setQueryData`.
 */
export function dashboardProjectSearchKey(principalId: string, role: Role, authorizationEpoch: number, archived: boolean, q: string = "") {
  return ["dashboard-project-search", principalId, role, authorizationEpoch, { archived, q }] as const;
}

function dashboardProjectsPath(archived: boolean, q: string): string {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/projects?${qs}` : "/api/projects";
}

export function useDashboardProjects(archived: boolean, identity: DashboardIdentity = { principalId: "anonymous", role: "photographer", authorizationEpoch: 0 }, q: string = ""): UseQueryResult<ProjectSummary[], Error> {
  const { principalId, role, authorizationEpoch } = identity;
  const external = role === "external_editor";
  return useQuery<ProjectSummary[], Error>({
    queryKey: dashboardProjectsKey(principalId, role, authorizationEpoch, archived, q),
    enabled: !external || !archived,
    queryFn: async ({ signal, client }) => {
      const runtime = getProjectQueryRuntime(client);
      const searchKey = dashboardProjectSearchKey(principalId, role, authorizationEpoch, archived, q);
      if (external) {
        const response = await externalApiGet("project-list", dashboardProjectsPath(archived, q), signal) as {
          projects: ExternalProjectSummaryDto[];
          board: { contractEnabled: boolean; orderedProjectIdsByStage: Record<string, string[]> };
          search?: DashboardProjectSearchCounts;
        };
        client.setQueryData(searchKey, response.search ?? null);
        return response.projects.map((project) => externalProjectSummaryToDashboard(
          project,
          response.board.orderedProjectIdsByStage,
          response.board.contractEnabled,
        )).filter((project) => !runtime?.isProjectRemoved(project.id)) as ProjectSummary[];
      }
      const response = await apiGet<ProjectsResponse>(dashboardProjectsPath(archived, q), { signal });
      client.setQueryData(searchKey, response.search ?? null);
      const board = response.board;
      return response.projects.map((project) => ({
        ...project,
        boardRank: board ? authorizedBoardRank(project.id, project.stageKey, board.orderedProjectIdsByStage) : undefined,
        boardMapPresent: Boolean(board && Object.keys(board.orderedProjectIdsByStage).length > 0),
        authorizedBoardOrder: board?.orderedProjectIdsByStage,
        // A missing board envelope is an old deployed server; an explicit false is the
        // post-migration flag-off state and must hide Board mutation controls.
        boardContractEnabled: board?.contractEnabled ?? true,
      })).filter((project) => !runtime?.isProjectRemoved(project.id));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: projectQueryRetry,
    // Keeps the Board from blanking between keystrokes — the 300ms search debounce already bounds
    // the request rate. Gated off the archived-scope switch: stale archived rows must never flash
    // into the active view (or vice versa) while the new scope's fetch is in flight.
    placeholderData: (previousData, previousQuery) => {
      const previousArchived = (previousQuery?.queryKey[4] as { archived: boolean; q: string } | undefined)?.archived;
      return previousArchived === archived ? keepPreviousData(previousData) : undefined;
    },
  });
}

/**
 * Observes the search counts the projects `queryFn` above wrote for the same scope + `q`. Never
 * fetches on its own (`skipToken`): a cache miss (old server that never populated the key, or a
 * fetch still in flight) simply reads as `undefined`, distinct from the explicit `null` the writer
 * stores for "no search active" / "old server, no `search` in the response".
 */
export function useDashboardProjectSearch(archived: boolean, identity: DashboardIdentity, q: string): UseQueryResult<DashboardProjectSearchCounts | null, Error> {
  const { principalId, role, authorizationEpoch } = identity;
  return useQuery<DashboardProjectSearchCounts | null, Error>({
    queryKey: dashboardProjectSearchKey(principalId, role, authorizationEpoch, archived, q),
    queryFn: skipToken,
    staleTime: Infinity,
  });
}

export function removeProjectFromDashboardQueries(queryClient: import("@tanstack/react-query").QueryClient, principalId: string, projectId: string) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["dashboard-projects", principalId] })) {
    queryClient.setQueryData<ProjectSummary[]>(query.queryKey, (projects) => projects?.filter((project) => project.id !== projectId));
  }
  // The sibling search-counts cache can't be filtered by project id (its value is a counts
  // object, not a list) — a lost project makes its counts stale, so the whole scope is dropped
  // instead and re-populated on the next fetch.
  queryClient.removeQueries({ queryKey: ["dashboard-project-search", principalId] });
}
