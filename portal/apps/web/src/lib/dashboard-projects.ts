import { authorizedBoardRank, type ExternalProjectSummaryDto, type Role } from "@quincy/shared";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet, externalProjectSummaryToDashboard } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import { getProjectQueryRuntime } from "./project-query-sync";
import type { ProjectSummary } from "./kanban-interaction";

type ProjectsResponse = {
  projects: ProjectSummary[];
  board?: { contractEnabled: boolean; orderedProjectIdsByStage: Record<string, string[]> };
};
export type DashboardIdentity = { principalId: string; role: Role; authorizationEpoch: number };

export function dashboardProjectsKey(principalId: string, role: Role, authorizationEpoch: number, archived: boolean) {
  return ["dashboard-projects", principalId, role, authorizationEpoch, { archived }] as const;
}

export function useDashboardProjects(archived: boolean, identity: DashboardIdentity = { principalId: "anonymous", role: "photographer", authorizationEpoch: 0 }): UseQueryResult<ProjectSummary[], Error> {
  const { principalId, role, authorizationEpoch } = identity;
  const external = role === "external_editor";
  return useQuery<ProjectSummary[], Error>({
    queryKey: dashboardProjectsKey(principalId, role, authorizationEpoch, archived),
    enabled: !external || !archived,
    queryFn: async ({ signal, client }) => {
      const runtime = getProjectQueryRuntime(client);
      if (external) {
        const response = await externalApiGet("project-list", "/api/projects", signal) as {
          projects: ExternalProjectSummaryDto[];
          board: { contractEnabled: boolean; orderedProjectIdsByStage: Record<string, string[]> };
        };
        return response.projects.map((project) => externalProjectSummaryToDashboard(
          project,
          response.board.orderedProjectIdsByStage,
          response.board.contractEnabled,
        )).filter((project) => !runtime?.isProjectRemoved(project.id)) as ProjectSummary[];
      }
      const response = await apiGet<ProjectsResponse>(archived ? "/api/projects?archived=1" : "/api/projects", { signal });
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
  });
}

export function removeProjectFromDashboardQueries(queryClient: import("@tanstack/react-query").QueryClient, principalId: string, projectId: string) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["dashboard-projects", principalId] })) {
    queryClient.setQueryData<ProjectSummary[]>(query.queryKey, (projects) => projects?.filter((project) => project.id !== projectId));
  }
}
