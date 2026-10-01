import type { DashboardArchivedMode, DashboardPeopleResponse, DashboardPerson } from "@quincy/shared";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { projectQueryRetry } from "./project-data";
import type { DashboardIdentity } from "./dashboard-projects";

/**
 * #429: the People field's options for every Dashboard view (`GET /api/dashboard/people`): the Editors of,
 * and Subtask assignees on, the Projects the viewer may see under the Archived mode — the one set the
 * server also validates `editors=` against, so a chosen person can never drop out of the options. An
 * External Editor's list is their own Projects' teams. The key leads with `"dashboard-people"` and the
 * principal, role and authorization epoch (the isolation every other Dashboard key carries).
 */
export function dashboardPeopleKey(identity: DashboardIdentity, archived: DashboardArchivedMode) {
  return ["dashboard-people", identity.principalId, identity.role, identity.authorizationEpoch, archived] as const;
}

const NO_PEOPLE: readonly DashboardPerson[] = [];

export function useDashboardPeople(identity: DashboardIdentity, archived: DashboardArchivedMode, enabled = true): { people: readonly DashboardPerson[]; query: UseQueryResult<DashboardPeopleResponse, Error> } {
  const query = useQuery<DashboardPeopleResponse, Error>({
    queryKey: dashboardPeopleKey(identity, archived),
    queryFn: ({ signal }) => apiGet<DashboardPeopleResponse>(archived === "hide" ? "/api/dashboard/people" : `/api/dashboard/people?archived=${archived}`, { signal }),
    enabled,
    // The list moves only when a team or an assignment does: a minute is fresh enough for a picker.
    staleTime: 60_000,
    retry: projectQueryRetry,
    placeholderData: keepPreviousData,
  });
  return { people: query.data?.people ?? NO_PEOPLE, query };
}
