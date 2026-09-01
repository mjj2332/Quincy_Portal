import {
  externalProjectActivityFeedResponseSchema,
  projectActivityFeedResponseSchema,
  type ExternalProjectActivityFeedResponse,
  type ProjectActivityFeedResponse,
} from "@quincy/shared";
import { useInfiniteQuery, type InfiniteData, type QueryFunctionContext, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { useSession } from "./auth";
import { externalApiGet } from "./external-api-response";
import { isPermanentProjectAccessError, projectDataKeys, projectQueryRetry } from "./project-data";

export type ProjectActivityResponse = ProjectActivityFeedResponse | ExternalProjectActivityFeedResponse;
export type ProjectActivityInfiniteData = InfiniteData<ProjectActivityResponse, string | null>;

function activityPath(projectId: string, before: string | null) {
  const query = new URLSearchParams({ limit: "30" });
  if (before) query.set("before", before);
  return `/api/projects/${encodeURIComponent(projectId)}/activity?${query.toString()}`;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

async function fetchProjectActivityPage(projectId: string, before: string | null, signal: AbortSignal, external: boolean): Promise<ProjectActivityResponse> {
  const path = activityPath(projectId, before);
  const response = external
    ? await externalApiGet("activity", path, signal)
    : await apiGet<unknown>(path, { signal });
  assertNotAborted(signal);
  return external
    ? externalProjectActivityFeedResponseSchema.parse(response)
    : projectActivityFeedResponseSchema.parse(response);
}

export function projectActivityInfiniteQueryOptions(projectId: string, external = false) {
  return {
    queryKey: projectDataKeys.activity(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }: QueryFunctionContext<ReturnType<typeof projectDataKeys.activity>, string | null>) =>
      fetchProjectActivityPage(projectId, pageParam, signal, external),
    getNextPageParam: (lastPage: ProjectActivityResponse) => lastPage.nextCursor ?? undefined,
  } as const;
}

export function useProjectActivityQuery(projectId: string, enabled = true): UseInfiniteQueryResult<ProjectActivityInfiniteData, Error> {
  const session = useSession();
  const external = session.data?.user?.role === "external_editor";
  const options = projectActivityInfiniteQueryOptions(projectId, external);
  return useInfiniteQuery<ProjectActivityResponse, Error, ProjectActivityInfiniteData, typeof options.queryKey, string | null>({
    ...options,
    enabled,
    staleTime: 30_000,
    retry: projectQueryRetry,
    refetchInterval: (query) => enabled && !(isPermanentProjectAccessError(query.state.error) && (query.state.error.status === 403 || query.state.error.status === 404)) ? 30_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  }) as UseInfiniteQueryResult<ProjectActivityInfiniteData, Error>;
}
