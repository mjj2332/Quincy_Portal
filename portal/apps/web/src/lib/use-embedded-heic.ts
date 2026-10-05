import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { fetchEmbeddedHeicSetting } from "./embedded-media";

/** Never fetches: stands in as the client when there is no provider, so the hook can be called unconditionally. */
const inertClient = new QueryClient();

/**
 * Whether the signed-in person may upload HEIC images into Embedded media (#495), read once from the server (it answers for the effective
 * user: an Admin, or everyone once the owner turns it on). Fails closed: false until the answer arrives, when it cannot be read, and in a tree
 * with no query provider (isolated component tests), so the pickers never offer HEIC the server would refuse. `active` is false for an editor
 * that takes no media at all, which asks nothing.
 */
export function useEmbeddedHeicEnabled(active: boolean): boolean {
  const client = useContext(QueryClientContext);
  const query = useQuery({
    queryKey: ["embedded-media", "settings"],
    queryFn: fetchEmbeddedHeicSetting,
    enabled: active && client !== undefined,
    staleTime: Infinity,
    retry: false,
  }, client ?? inertClient);
  return query.data === true;
}
