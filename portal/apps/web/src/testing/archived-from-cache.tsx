import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import { projectDataKeys } from "../lib/project-data";

/**
 * Derives `archived` from the cached Project detail, as the Workspace does (#566): a refusal's cache write reaches the surface through
 * this value and nothing else. The `archived` prop is the test's way to move the "server" state: changing it between renders writes
 * the cache, as a refetch landing would. It is written during render, before the observer reads it, so the new value shows in that render.
 */
export function ArchivedFromCache({ projectId, archived, children }: { projectId: string; archived?: boolean; children: (archived: boolean) => ReactNode }) {
  const queryClient = useQueryClient();
  const key = projectDataKeys.detail(projectId);
  const last = useRef<boolean | undefined>(undefined);
  const wanted = Boolean(archived);
  if (last.current !== wanted) { last.current = wanted; queryClient.setQueryData(key, { archivedAt: wanted ? "2026-01-01T00:00:00.000Z" : null }); }
  const query = useQuery({ queryKey: key, queryFn: () => new Promise<{ archivedAt: string | null }>(() => undefined), enabled: false, staleTime: Infinity });
  return <>{children(Boolean(query.data?.archivedAt))}</>;
}
