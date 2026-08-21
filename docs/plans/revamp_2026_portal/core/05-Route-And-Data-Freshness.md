# Route and Data Freshness Architecture

**Status:** Proposed architecture; automatic refresh is a user-approved requirement  
**Related:** [Current-state audit](./02-Current-State-Audit.md), [TB2](../roadmap/TB2-Route-Safe-Data-Freshness.md)

## 1. Required behavior

Keep path-based URLs and restore automatic updates.

A user must be able to:

- open `/projects/A` and `/projects/B` in separate tabs;
- follow a direct project/sub-page link;
- remain on a page and receive relevant server changes without reloading;
- return to a background tab and see stale data refreshed;
- preserve unsaved local work while server data refreshes.

## 2. Diagnosis

The custom router already subscribes to history and scopes `ProjectWorkspace` by `projectId`. The stale behavior is caused by inconsistent fetch lifecycles, not by the existence of routes.

Several components fetch on mount or after their own mutations but have no shared policy for:

- route-keyed caching;
- stale time;
- polling;
- focus/reconnect refresh;
- query invalidation;
- cancellation/late-response protection.

## 3. Proposed server-state layer

Use TanStack Query beginning with Project Workspace.

Why it is justified now:

- independently changing comments/board/project state;
- background refresh;
- precise mutation invalidation;
- optimistic updates;
- stale request coordination;
- retry/reconnect behavior;
- multiple routes/tabs.

This is not “modernization for its own sake”; it directly solves a user-visible regression.

## 4. Query identity

Every variable used by the request must be represented in the query key.

Suggested key factory:

```ts
const projectKeys = {
  all: ["projects"] as const,
  list: (scope: "active" | "archived") => ["projects", { scope }] as const,
  detail: (projectId: string) => ["project", projectId] as const,
  assets: (projectId: string, collection: string) => ["project-assets", projectId, collection] as const,
  ingest: (projectId: string) => ["project-ingest", projectId] as const,
  jobs: (projectId: string) => ["project-jobs", projectId] as const,
  autohdr: (projectId: string) => ["project-autohdr", projectId] as const,
  discussion: (projectId: string) => ["project-discussion", projectId] as const,
  subtasks: (projectId: string) => ["project-subtasks", projectId] as const,
};
```

Never use a generic key that omits the project or collection identifier.

## 5. Recommended freshness policy

Exact intervals remain a product/plan choice. Starting proposal:

| Resource | Visible/active | Hidden/collapsed | Focus/reconnect |
|---|---|---|---|
| Dashboard/Kanban | 20–30 s | pause in background | refetch if stale |
| Project detail | 20–30 s | pause in background | refetch if stale |
| Active asset collection | 20–30 s when operationally useful | pause | refetch if stale |
| Jobs/AutoHDR | retain/adapt current 5 s while active | stop at terminal | immediate if stale |
| Project discussion | 15–30 s while open | 60–120 s or stop | refetch on open/focus |
| Subtasks | 20–30 s while panel open | slow/stop | refetch on open/focus |
| Notice board | 25–60 s depending open state | current model can be retained initially | refetch on focus |
| Notifications | unread count 30–60 s; list on open | pause/slow | refetch on open/focus |

Do not set one global polling interval for all data.

## 6. Mutation behavior

After a successful mutation:

1. update the relevant cache immediately when the response contains authoritative data;
2. invalidate the smallest affected query set;
3. await required invalidation before reporting final completion where consistency matters;
4. do not reload the whole app.

Examples:

- project edit → detail + active project list/Kanban;
- stage move → board list + project detail;
- comment post → project discussion + unread/notification queries as appropriate;
- asset delete → current collection + project counts/cover only;
- notification read → notification list + unread count.

## 7. Stale request handling

- Query functions must use the supplied `AbortSignal` where the API helper supports it.
- Route changes must cancel or render old responses irrelevant through query identity.
- Project A's response can never write into Project B's query/cache.
- RAW and Edited collection requests cannot share identity.

## 8. Local draft preservation

Background refetch must not reset:

- Tiptap content being composed or edited;
- form fields with unsaved changes;
- an open picker/dialog;
- current scroll;
- active drag;
- lightbox frame and selection state.

Server response merging must distinguish persisted entities from local drafts. Never replace an entire feature component with a loading state during a background refresh.

## 9. Cross-tab behavior

Polling and focus refresh are sufficient for the product requirement.

Optional enhancement: use same-origin `BroadcastChannel` to publish narrow invalidation messages after mutations:

```ts
{ type: "invalidate", resource: "project", projectId: "..." }
```

Other Quincy tabs invalidate matching queries. This improves same-browser immediacy but does not replace server polling/focus refresh.

## 10. API optimizations

Add only when measurements justify them:

- `after` cursors for discussion/activity increments;
- `ETag`/`If-None-Match` for unchanged lists;
- compact `latest` endpoints for collapsed surfaces;
- summary endpoints for unread counts;
- separate list/detail payloads rather than repeatedly returning heavy data.

## 11. Access changes

If a refetch returns `403` or `404` because access was removed:

- remove/clear inaccessible cached data;
- show the correct collaboration-only or unavailable state;
- do not keep displaying stale private data;
- avoid retry loops for permanent authorization failures.

## 12. Tests

TB2 must prove:

1. Direct `/projects/:id` load.
2. Project A/B route isolation.
3. Late A response cannot overwrite B.
4. RAW/Edited query separation.
5. Visible polling obtains a simulated server change.
6. Window focus refetch obtains a simulated server change.
7. Mutation invalidates only affected resources.
8. Background refresh does not clear drafts or selection.
9. Existing active-job polling is not duplicated.
10. Access removal clears private cached data.
11. Back/Forward and open-in-new-tab still work.
12. Hidden-page timer behavior is acceptable.

## 13. Non-goals

- WebSockets.
- Durable Objects for every screen.
- Realtime chat semantics.
- Router replacement in TB2.
- Converting all server state in one release.
