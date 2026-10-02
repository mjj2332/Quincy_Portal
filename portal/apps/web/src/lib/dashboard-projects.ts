import { canonicalDashboardEditorIds, canonicalDashboardPriorities, canonicalDashboardStages, dashboardFilterArchivedMode, dashboardFilterFingerprint, dashboardProjectsFilterQueryParams, normalizeDashboardFilter, type DashboardFilter, type ExternalProjectSummaryDto, type Role } from "@quincy/shared";
import { keepPreviousData, skipToken, useQuery, type Query, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet, externalProjectSummaryToDashboard } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import { getProjectQueryRuntime } from "./project-query-sync";
import type { ProjectSummary } from "./kanban-interaction";

export type DashboardProjectSearchCounts = { query: string; matching: number; total: number };

type ProjectsResponse = {
  projects: ProjectSummary[];
  /** Only the flag is read; the server's deprecated order maps are ignored (#475): the order is derived from the data. */
  board?: { contractEnabled: boolean };
  search?: DashboardProjectSearchCounts;
};
export type DashboardIdentity = { principalId: string; role: Role; authorizationEpoch: number };

/**
 * Option A: sort is a derived interaction identity, not a network input. Keep this five-element
 * authorization-scoped key stable: removeProjectFromDashboardQueries relies on its
 * ["dashboard-projects", principalId] prefix, and exact Dashboard invalidations rely on the full
 * tuple. Future key widening must audit both consumers.
 *
 * `q` (#217) widens the trailing object rather than adding a sixth element -- but ONLY when
 * non-empty (#217 fix round 1, item 7), and so does the shared Filter (#428): the trailing object is
 * `{ archived: mode, q?, stages?, priority? }` with `archived` the Archived MODE (`"hide"` |
 * `"include"` | `"only"`, no longer a boolean) and every other member present only when it narrows.
 * Defaults are omitted, never written as empty values, so the key's hash is a pure function of the
 * request: two filters that make the same request share one entry. `react-query`'s own key hashing
 * is order-and-shape-sensitive, so the member order here is fixed.
 *
 * The cached VALUE under this key stays `ProjectSummary[]` — never `{ projects, search }` — because
 * production code (`Dashboard.tsx`'s optimistic Board `setQueryData<ProjectSummary[]>`) and the
 * stage-interaction tests write it as a bare array via `setQueryData`'s unchecked generic; a shape
 * change here fails silently on that path. Search counts live in the sibling
 * `dashboardProjectSearchKey` cache entry instead, written once per fetch by this hook's `queryFn`.
 */
export type DashboardProjectsKeyFilter = Pick<DashboardFilter, "archived"> & Partial<Omit<DashboardFilter, "archived">>;
export const DASHBOARD_HIDE_ARCHIVED: DashboardProjectsKeyFilter = { archived: "hide" };

/** The trailing object of a Dashboard-projects key: only what narrows, in a fixed member order. */
export type DashboardProjectsKeyScope = {
  archived: DashboardFilter["archived"];
  q?: string;
  stages?: string[];
  priority?: string[];
  /** #429: the relation and date facets, after Priority and in this order. Each is present only when it narrows. */
  editors?: string[];
  unassigned?: true;
  shoot?: DashboardFilter["shootRange"];
  deadline?: DashboardFilter["deadlineRange"];
  overdue?: true;
  mine?: true;
  /** #461: a filter tree's fingerprint, present only when the filter is a tree (a flat filter's key is unchanged). */
  tree?: string;
};

/** The Archived scope of a Projects-list filter: the flat field, or the mode the tree implies (#461). */
function archivedModeOf(filter: DashboardProjectsKeyFilter): DashboardFilter["archived"] {
  return filter.tree ? dashboardFilterArchivedMode(filter.tree) : filter.archived;
}

function dashboardProjectsKeyScope(filter: DashboardProjectsKeyFilter, q: string): DashboardProjectsKeyScope {
  const stages = canonicalDashboardStages(filter.stageKeys ?? []);
  const priority = canonicalDashboardPriorities(filter.priorities ?? []);
  const editors = canonicalDashboardEditorIds(filter.editorIds ?? []);
  return {
    archived: archivedModeOf(filter),
    ...(q ? { q } : {}),
    ...(stages.length > 0 ? { stages } : {}),
    ...(priority.length > 0 ? { priority } : {}),
    ...(editors.length > 0 ? { editors } : {}),
    ...(filter.includeUnassigned ? { unassigned: true as const } : {}),
    ...(filter.shootRange ? { shoot: { from: filter.shootRange.from, to: filter.shootRange.to } } : {}),
    ...(filter.deadlineRange ? { deadline: { from: filter.deadlineRange.from, to: filter.deadlineRange.to } } : {}),
    // A Deadline range and Overdue are one rule: the range wins (the shared normaliser drops the other).
    ...(filter.overdueOnly && !filter.deadlineRange ? { overdue: true as const } : {}),
    ...(filter.myTasks ? { mine: true as const } : {}),
    ...(filter.tree ? { tree: dashboardFilterFingerprint(filter.tree) } : {}),
  };
}

function omitScope({ archived: _archived, ...rest }: DashboardProjectsKeyScope) {
  return rest;
}

export function dashboardProjectsKey(principalId: string, role: Role, authorizationEpoch: number, filter: DashboardProjectsKeyFilter, q: string = "") {
  return ["dashboard-projects", principalId, role, authorizationEpoch, dashboardProjectsKeyScope(filter, q)] as const;
}

/**
 * A different `key[0]` (`"dashboard-project-search"`, not `"dashboard-projects"`) so the prefix
 * scans in `removeProjectFromDashboardQueries` (below) and `project-query-sync.ts`'s
 * `dashboard-board-invalidated` handler don't pick this up as a projects-list query. Never fetched
 * directly — `useDashboardProjectSearch` reads it with `queryFn: skipToken`; the projects `queryFn`
 * below is its only writer, via `client.setQueryData`.
 */
export function dashboardProjectSearchKey(principalId: string, role: Role, authorizationEpoch: number, filter: DashboardProjectsKeyFilter, q: string = "") {
  return ["dashboard-project-search", principalId, role, authorizationEpoch, { archived: archivedModeOf(filter), q, ...omitScope(dashboardProjectsKeyScope(filter, "")) }] as const;
}

function dashboardProjectsPath(filter: DashboardProjectsKeyFilter, q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const [name, value] of dashboardProjectsFilterQueryParams(normalizeDashboardFilter(filter))) params.set(name, value);
  const qs = params.toString();
  return qs ? `/api/projects?${qs}` : "/api/projects";
}

/**
 * The internal list response as Dashboard summaries. Only `board.contractEnabled` is read from the envelope
 * (a missing envelope is an old deployed server; an explicit false is the post-migration flag-off state and must
 * hide Board mutation controls). The server's deprecated order maps are never read: the Board order is
 * derived from the data (#470, #475).
 */
export function mapInternalProjects(response: Pick<ProjectsResponse, "projects" | "board">): ProjectSummary[] {
  const boardContractEnabled = response.board?.contractEnabled ?? true;
  return response.projects.map((project) => ({ ...project, boardContractEnabled }));
}

export function useDashboardProjects(filter: DashboardProjectsKeyFilter, identity: DashboardIdentity = { principalId: "anonymous", role: "photographer", authorizationEpoch: 0 }, q: string = ""): UseQueryResult<ProjectSummary[], Error> {
  const { principalId, role, authorizationEpoch } = identity;
  const external = role === "external_editor";
  return useQuery<ProjectSummary[], Error>({
    queryKey: dashboardProjectsKey(principalId, role, authorizationEpoch, filter, q),
    // An External Editor never has archived Projects (the server refuses the request): never send it.
    enabled: !external || archivedModeOf(filter) === "hide",
    queryFn: async ({ signal, client }) => {
      const runtime = getProjectQueryRuntime(client);
      const searchKey = dashboardProjectSearchKey(principalId, role, authorizationEpoch, filter, q);
      if (external) {
        const response = await externalApiGet("project-list", dashboardProjectsPath(filter, q), signal) as {
          projects: ExternalProjectSummaryDto[];
          board: { contractEnabled: boolean };
          search?: DashboardProjectSearchCounts;
        };
        client.setQueryData(searchKey, response.search ?? null);
        return response.projects.map((project) => externalProjectSummaryToDashboard(
          project,
          response.board.contractEnabled,
        )).filter((project) => !runtime?.isProjectRemoved(project.id)) as ProjectSummary[];
      }
      const response = await apiGet<ProjectsResponse>(dashboardProjectsPath(filter, q), { signal });
      client.setQueryData(searchKey, response.search ?? null);
      return mapInternalProjects(response).filter((project) => !runtime?.isProjectRemoved(project.id));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: projectQueryRetry,
    // Keeps the Board from blanking between keystrokes — the 300ms search debounce already bounds
    // the request rate. Gated off the Archived MODE: stale archived rows must never flash into the
    // active view (or vice versa) while the new mode's fetch is in flight. A Stage or Priority change
    // keeps the previous rows as placeholder, like a search keystroke does.
    placeholderData: (previousData, previousQuery) => {
      const previousArchived = (previousQuery?.queryKey[4] as DashboardProjectsKeyScope | undefined)?.archived;
      return previousArchived === archivedModeOf(filter) ? keepPreviousData(previousData) : undefined;
    },
  });
}

/**
 * Observes the search counts the projects `queryFn` above wrote for the same scope + `q`. Never
 * fetches on its own (`skipToken`): a cache miss (old server that never populated the key, or a
 * fetch still in flight) simply reads as `undefined`, distinct from the explicit `null` the writer
 * stores for "no search active" / "old server, no `search` in the response".
 */
export function useDashboardProjectSearch(filter: DashboardProjectsKeyFilter, identity: DashboardIdentity, q: string): UseQueryResult<DashboardProjectSearchCounts | null, Error> {
  const { principalId, role, authorizationEpoch } = identity;
  return useQuery<DashboardProjectSearchCounts | null, Error>({
    queryKey: dashboardProjectSearchKey(principalId, role, authorizationEpoch, filter, q),
    queryFn: skipToken,
    staleTime: Infinity,
  });
}

/**
 * The `["dashboard-projects", principalId]` prefix every dashboard-projects query key starts
 * with, regardless of role/authorizationEpoch/archived/q -- the one piece of cache-key shape
 * callers outside this file (Dashboard.tsx's confirmed-priority fan-out, this file's own
 * `removeProjectFromDashboardQueries` below) need to scan or match against, without knowing the
 * key's full five-element shape themselves.
 */
export function dashboardProjectsKeyPrefix(principalId: string) {
  return ["dashboard-projects", principalId] as const;
}

/**
 * A `Query` predicate: true for every dashboard-projects query belonging to `principalId`,
 * optionally excluding one exact key (compared structurally, as `JSON.stringify`, matching how
 * `dashboardKeyString` is derived) -- the sibling test `setProjectPriority`'s confirmed-fan-out
 * uses to cancel/invalidate every OTHER scope's entry without touching the one currently active.
 */
export function isDashboardProjectsQueryFor(principalId: string, exceptKeyString?: string) {
  const [kind, id] = dashboardProjectsKeyPrefix(principalId);
  return (query: Query) =>
    Array.isArray(query.queryKey) &&
    query.queryKey[0] === kind &&
    query.queryKey[1] === id &&
    (exceptKeyString === undefined || JSON.stringify(query.queryKey) !== exceptKeyString);
}

/**
 * #428/#429: a `Query` predicate for the dashboard-projects entries whose request carries a Stage,
 * Priority, People, Unassigned, My tasks, Overdue or date-range filter. A Project's priority or stage edit can move it OUT of such an entry (or into one
 * that never held it), so patching the cached row would leave a row in a list it no longer belongs
 * to: these entries are invalidated and refetched on next use instead of patched.
 */
export function isFilteredDashboardProjectsQuery(principalId: string, facet: "stages" | "priority" | "relation" | "any" = "any") {
  const [kind, id] = dashboardProjectsKeyPrefix(principalId);
  return (query: Query) => {
    if (!Array.isArray(query.queryKey) || query.queryKey[0] !== kind || query.queryKey[1] !== id) return false;
    const scope = query.queryKey[4] as DashboardProjectsKeyScope | undefined;
    if (!scope) return false;
    const relation = scope.editors !== undefined || scope.unassigned !== undefined || scope.shoot !== undefined || scope.deadline !== undefined || scope.overdue !== undefined || scope.mine !== undefined;
    return facet === "stages" ? scope.stages !== undefined : facet === "priority" ? scope.priority !== undefined : facet === "relation" ? relation : scope.stages !== undefined || scope.priority !== undefined || relation;
  };
}

export function removeProjectFromDashboardQueries(queryClient: import("@tanstack/react-query").QueryClient, principalId: string, projectId: string) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: dashboardProjectsKeyPrefix(principalId) })) {
    queryClient.setQueryData<ProjectSummary[]>(query.queryKey, (projects) => projects?.filter((project) => project.id !== projectId));
  }
  // The sibling search-counts cache can't be filtered by project id (its value is a counts
  // object, not a list) — a lost project makes its counts stale, so the whole scope is dropped
  // instead and re-populated on the next fetch.
  queryClient.removeQueries({ queryKey: ["dashboard-project-search", principalId] });
}
