import { useContext, useEffect, useRef, type ReactNode } from "react";
import { QueryClientContext, useQuery, useQueryClient } from "@tanstack/react-query";
import { roleHasCapability, type Role } from "@quincy/shared";
import { useSession } from "../lib/auth";
import { apiGet } from "../lib/api";
import { decodeExternalResponse } from "../lib/external-api-response";
import { clearPrincipalProjectData, removeProjectData } from "../lib/project-data";
import { removeProjectFromDashboardQueries } from "../lib/dashboard-projects";
import { removeProductionCalendarQueries } from "../lib/production-calendar-query";
import { locationStore, parseStaffLocation, staffPathFor } from "../lib/router";
import { initializeDashboardView } from "../screens/dashboard-helpers";

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
    if (lost.length > 0) removeProductionCalendarQueries(queryClient, principalId);
    for (const projectId of lost) {
      // Filter the principal dashboard cache before the asynchronous tombstone work.
      removeProjectFromDashboardQueries(queryClient, principalId, projectId);
      // Close a TB6 quick-detail facet before the asynchronous tombstone work. Rebuild the
      // exact backing Dashboard route so its calendar/list/kanban state remains intact.
      const route = parseStaffLocation(history.getLocation());
      if (route.kind === "dashboard" && "detail" in route && route.detail?.projectId === projectId) {
        const backingRoute = "calendar" in route
          ? { kind: "dashboard" as const, calendar: route.calendar }
          : "dashboardView" in route
            ? { kind: "dashboard" as const, dashboardView: route.dashboardView }
            : { kind: "dashboard" as const };
        history.replace(staffPathFor(backingRoute));
        // The sheet's own close (Dashboard.tsx#closeQuickDetail) restores focus to its opener
        // or the active view toggle; this access-loss path has neither an opener element nor
        // Dashboard's own `view` state, so move focus to the toggle for whatever view the
        // backing route resolves to (falling back to the same localStorage default Dashboard
        // itself uses for a bare route) rather than leaving it on a now-detached project anchor.
        const focusTarget = "calendar" in backingRoute
          ? "calendar"
          : "dashboardView" in backingRoute
            ? backingRoute.dashboardView
            : (() => {
                const stored = initializeDashboardView({
                  read: () => window.localStorage.getItem("quincy:dashboard:view"),
                  write: (next) => window.localStorage.setItem("quincy:dashboard:view", next),
                });
                return !roleHasCapability(role, "viewProductionCalendar") && stored === "calendar" ? "kanban" : stored;
              })();
        window.setTimeout(() => document.querySelector<HTMLElement>(`[data-focus-key="dashboard-view-${focusTarget}"]`)?.focus(), 0);
      }
      void removeProjectData(queryClient, projectId);
      if (window.location.pathname === `/projects/${encodeURIComponent(projectId)}` || window.location.pathname.startsWith(`/projects/${encodeURIComponent(projectId)}/`)) history.replace("/");
    }
  }, [history, principalId, query.data, queryClient]);

  useEffect(() => {
    if (!query.error || !(query.error instanceof Error) || query.error.message !== "Authorization scope changed while refreshing.") return;
    removeProductionCalendarQueries(queryClient, principalId);
    void clearPrincipalProjectData(queryClient);
  }, [principalId, query.error, queryClient]);

  return <>{children}</>;
}

export function PrincipalFreshnessBoundary(props: { principalId: string; role: Role; authorizationEpoch: number; children: ReactNode }) {
  // App supplies the QueryClientProvider. Isolated App/component tests may intentionally mock
  // that provider; in that case the boundary is inert rather than issuing an unscoped fetch.
  const queryClient = useContext(QueryClientContext);
  return queryClient ? <PrincipalFreshnessBoundaryInner {...props} /> : <>{props.children}</>;
}
