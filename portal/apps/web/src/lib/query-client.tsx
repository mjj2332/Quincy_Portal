import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Role } from "@quincy/shared";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { clearPrincipalProjectData, isApiError, projectQueryRetry } from "./project-data";
import { bindQueryClientPrincipal } from "./principal-terminal";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "./project-query-sync";

export function createQuincyQueryClient() {
  let queryClient!: QueryClient;
  const terminateOnUnauthorized = (error: unknown) => {
    if (isApiError(error) && error.status === 401) void clearPrincipalProjectData(queryClient);
  };
  queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: terminateOnUnauthorized }),
    mutationCache: new MutationCache({ onError: terminateOnUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: projectQueryRetry,
        retryDelay: (attemptIndex) => Math.min(1_000 * 2 ** attemptIndex, 4_000),
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        structuralSharing: true,
      },
      mutations: { retry: false },
    },
  });
  return queryClient;
}

export function QuincyQueryProvider({ principalId, role, children }: { principalId: string; role: Role; children: ReactNode }) {
  // The client belongs to this person for its whole life, so a terminal notice from it names them.
  const [queryClient] = useState(() => { const client = createQuincyQueryClient(); bindQueryClientPrincipal(client, principalId); return client; });
  const runtimeRef = useRef<ProjectQueryRuntime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = new ProjectQueryRuntime(queryClient);
  const runtime = runtimeRef.current;

  useEffect(() => {
    runtime.start();
    return () => {
      runtime.dispose();
      queryClient.clear();
    };
  }, [queryClient, runtime, principalId, role]);

  return <ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></ProjectQueryRuntimeProvider>;
}
