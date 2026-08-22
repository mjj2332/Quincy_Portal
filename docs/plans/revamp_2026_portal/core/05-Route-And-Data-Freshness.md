# Route and Data Freshness Architecture

**Status:** Settled proposal; automatic refresh is an approved requirement  
**Related:** [Current-state audit](./02-Current-State-Audit.md), [TB2](../roadmap/TB2-Route-Safe-Data-Freshness.md)

## 1. Required behavior

Keep path-based URLs and the typed custom router. A user must be able to:

- open `/projects/A` and `/projects/B` in separate tabs;
- follow direct project/sub-surface links;
- remain on a route and receive relevant changes without a browser reload;
- return to a background tab and refresh stale data;
- preserve drafts and active interactions during refetch;
- stop displaying private data after access removal.

## 2. Diagnosis

The router already tracks history/search and scopes Project Workspace by project ID. Staleness comes from component-specific fetch lifecycles without shared route keys, invalidation, cancellation, focus/reconnect, or bounded polling.

## 3. Server-state layer

Adopt TanStack Query incrementally in TB2. Do not convert every request at once.

First proof:

- `GET /api/projects/:projectId`;
- `GET /api/projects/:projectId/assets?collection=<kind>`.

This proves both project-route isolation and parameterized child-resource isolation while leaving jobs, AutoHDR, ingest, comments, and checklist on their existing lifecycles temporarily.

## 4. Query identity

Every request variable belongs in its key.

```ts
const projectKeys = {
  detail: (projectId: string) => ["project", projectId] as const,
  assets: (projectId: string, collection: string) =>
    ["project-assets", projectId, collection] as const,
  discussion: (projectId: string) => ["project-discussion", projectId] as const,
  subtasks: (projectId: string) => ["project-subtasks", projectId] as const,
  board: (scope: string, sort: string) => ["projects", { scope, sort }] as const,
};
```

Project A can never write into Project B's cache. RAW and Edited never share identity.

## 5. Freshness contract

- Visible ordinary project/board resources: bounded 20–30 second polling where operationally useful.
- Hidden browser tab: pause ordinary polling.
- Focus/reconnect: refetch stale visible resources.
- Jobs/AutoHDR: retain/adapt current five-second terminal-aware behavior; never duplicate it.
- Discussion/checklist: later slices use open-state polling and immediate refetch on open/focus.
- Notifications: list on open plus bounded unread polling.

Exact per-resource intervals belong to each implementation plan, but no one global interval is allowed.

## 6. Same-browser invalidation

Use a narrow same-origin `BroadcastChannel` after successful mutations:

```ts
{ type: "invalidate", resource: "project", projectId: "..." }
```

Other Quincy tabs invalidate only matching queries. This targets roughly two seconds for same-browser visibility. It supplements—not replaces—server polling and focus refresh, so different browsers/sessions remain correct within the 30-second target.

## 7. Mutation behavior

After success:

1. apply authoritative response data when available;
2. invalidate the smallest affected query set;
3. broadcast narrow same-browser invalidation;
4. never reload the whole app.

Examples:

- team delta → project detail/coordination summary and related board quick detail;
- Deadline change → project detail, board, coordination summary;
- Stage move → project detail and board;
- asset mutation → active collection and affected project summary only;
- notification read → inbox list and unread count.

## 8. Request cancellation and late responses

- Query functions use the provided `AbortSignal` where supported.
- Key identity makes old route responses irrelevant.
- Route changes cancel or ignore late work.
- Permanent `403`/`404` stops ordinary retries, clears inaccessible content, and renders the correct collaboration-only/unavailable state.

## 9. Draft and interaction preservation

Background refresh must not reset:

- Tiptap draft/edit state;
- form/picker drafts;
- open popover/dialog/sheet;
- scroll;
- active drag;
- Lightbox frame and selection;
- dashboard filter/view selection.

Do not replace an entire populated feature with a loading screen during background refetch. Merge persisted entities while keeping local drafts separate.

## 10. Coordination conflicts

Automatic freshness does not replace guarded mutation:

- membership removal carries membership-cycle identity;
- Deadline save carries schedule version;
- Stage move carries expected current Stage/revision;
- board movement carries the accepted snapshot/version/neighbour contract.

A conflict shows authoritative state, preserves the user's local context where appropriate, and never silently retries across a changed premise.

## 11. Tests

TB2 and later consumers must cover:

1. direct project URL;
2. A/B tab isolation;
3. late A response cannot overwrite B;
4. RAW/Edited key separation;
5. visible simulated external change;
6. focus/reconnect refresh;
7. narrow mutation invalidation;
8. same-browser broadcast invalidation;
9. hidden-page timer behavior;
10. drafts/selection/Lightbox preserved;
11. no duplicate special polling;
12. access removal clears private data;
13. Back/Forward and native new-tab behavior.

## 12. Non-goals

- WebSockets/presence.
- Router replacement.
- One-release conversion of all server state.
- Polling every resource every five seconds.
