# Research — Route-Aware Freshness and TanStack Query

**Conclusion:** TanStack Query is now justified as a bounded server-state layer because the product explicitly requires route isolation, automatic refresh, mutation invalidation and multiple-tab correctness.

## What TanStack Query provides

- cache identity through serializable query keys;
- route/resource variables included in keys;
- automatic background refetch when stale queries remount, regain window focus or reconnect;
- optional polling through `refetchInterval`;
- targeted invalidation after mutations;
- retry/error state;
- cancellation through query function context signals;
- structural sharing for unchanged JSON-compatible data.

## Why it fits this issue

The current router already expresses the route correctly. The missing capability is a consistent relationship between route parameters and server state.

Example:

```ts
useQuery({
  queryKey: ["project", projectId],
  queryFn: ({ signal }) => apiGet(`/api/projects/${projectId}`, { signal }),
  staleTime: 15_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  refetchInterval: document.visibilityState === "visible" ? 30_000 : false,
});
```

The exact API must avoid reading `document` directly in static options without a stable visibility integration; the example expresses the policy, not final code.

## Constraints

- Query keys must include every request variable.
- Server state must not overwrite local drafts.
- Current job polling must be migrated or coordinated to avoid duplicate loops.
- Permanent 403/404 failures should not retry endlessly.
- Polling intervals must be resource-specific.
- The first proof should be Project Workspace only.

## Alternatives

### Continue manual `useEffect`/state

Possible, but the current regression demonstrates that consistency across screens is already difficult. Adding discussions and board refresh would increase duplication.

### Replace router

Does not solve stale server state by itself. A router may be evaluated later for route complexity, but it is not the freshness fix.

### WebSockets/Durable Objects

Exceeds the asynchronous requirement. Polling/focus refresh is sufficient.

## Official sources

- https://tanstack.com/query/latest/docs/framework/react/installation
- https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
- https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching
- https://tanstack.com/query/latest/docs/framework/react/guides/polling
- https://tanstack.com/query/v5/docs/framework/react/guides/invalidations-from-mutations
- https://tanstack.com/query/latest/docs/framework/react/guides/query-options
