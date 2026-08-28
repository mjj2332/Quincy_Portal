import type { ExternalProjectSummaryDto, Role } from "@quincy/shared";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet, externalProjectSummaryToDashboard } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import type { ProjectSummary } from "../screens/Dashboard";

type ProjectsResponse = { projects: ProjectSummary[] };
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
    queryFn: async ({ signal }) => {
      if (external) {
        const response = await externalApiGet("project-list", "/api/projects", signal) as { projects: ExternalProjectSummaryDto[] };
        return response.projects.map(externalProjectSummaryToDashboard) as ProjectSummary[];
      }
      const response = await apiGet<ProjectsResponse>(archived ? "/api/projects?archived=1" : "/api/projects", { signal });
      return response.projects;
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
