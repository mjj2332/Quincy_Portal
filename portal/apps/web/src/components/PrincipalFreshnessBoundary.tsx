import { useContext, useEffect, useRef, type ReactNode } from "react";
import { QueryClientContext, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Role } from "@quincy/shared";
import { useSession } from "../lib/auth";
import { apiGet } from "../lib/api";
import { decodeExternalResponse } from "../lib/external-api-response";
import { clearPrincipalProjectData, removeProjectData } from "../lib/project-data";
import { removeProjectFromDashboardQueries } from "../lib/dashboard-projects";
import { locationStore } from "../lib/router";

type Snapshot = { principal: { id: string; role: Role; authorizationEpoch: number }; authorizationFingerprint: string; projects: Array<{ projectId: string; membershipCycleIds: string[] }> };

function snapshotKey(principalId: string, role: Role, authorizationEpoch: number) {
  return ["authorization-scope", principalId, role, authorizationEpoch] as const;
}

function projectMap(snapshot: Snapshot) {
  return new Map(snapshot.projects.map((project) => [project.projectId, project.membershipCycleIds.slice().sort()]));
}

function PrincipalFreshnessBoundaryInner({ principalId, role, authorizationEpoch, children }: { principalId: string; role: Role; authorizationEpoch: number; children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const history = locationStore();
  const previous = useRef<Snapshot | undefined>(undefined);
  const query = useQuery<Snapshot, Error>({
    queryKey: snapshotKey(principalId, role, authorizationEpoch),
    queryFn: async ({ signal }) => {
      const response = decodeExternalResponse("access-snapshot", await apiGet<unknown>("/api/project-access-snapshot", { signal })) as Snapshot;
      if (response.principal.id !== principalId || response.principal.role !== role || response.principal.authorizationEpoch !== authorizationEpoch) throw new Error("Authorization scope changed while refreshing.");
      return response;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });

  useEffect(() => {
    const refreshSession = () => { if (document.visibilityState === "visible") void session.refetch({}); };
    const interval = window.setInterval(refreshSession, 30_000);
    window.addEventListener("focus", refreshSession);
    window.addEventListener("online", refreshSession);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", refreshSession); window.removeEventListener("online", refreshSession); };
  }, [session.refetch]);

  useEffect(() => {
    const next = query.data;
    const prior = previous.current;
    previous.current = next;
    if (!next || !prior || prior.principal.id !== next.principal.id) return;
    const before = projectMap(prior);
    const after = projectMap(next);
    const lost = [...before.keys()].filter((projectId) => {
      const current = after.get(projectId);
      const old = before.get(projectId)!;
      return !current || current.join(",") !== old.join(",");
    });
    for (const projectId of lost) {
      // Filter the principal dashboard cache before the asynchronous tombstone work.
      removeProjectFromDashboardQueries(queryClient, principalId, projectId);
      void removeProjectData(queryClient, projectId);
      if (window.location.pathname === `/projects/${encodeURIComponent(projectId)}` || window.location.pathname.startsWith(`/projects/${encodeURIComponent(projectId)}/`)) history.replace("/");
    }
  }, [history, principalId, query.data, queryClient]);

  useEffect(() => {
    if (!query.error || !(query.error instanceof Error) || query.error.message !== "Authorization scope changed while refreshing.") return;
    void clearPrincipalProjectData(queryClient);
  }, [query.error, queryClient]);

  return <>{children}</>;
}

export function PrincipalFreshnessBoundary(props: { principalId: string; role: Role; authorizationEpoch: number; children: ReactNode }) {
  // App supplies the QueryClientProvider. Isolated App/component tests may intentionally mock
  // that provider; in that case the boundary is inert rather than issuing an unscoped fetch.
  const queryClient = useContext(QueryClientContext);
  return queryClient ? <PrincipalFreshnessBoundaryInner {...props} /> : <>{props.children}</>;
}
