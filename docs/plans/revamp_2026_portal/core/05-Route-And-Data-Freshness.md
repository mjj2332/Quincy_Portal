# Route and Data Freshness Architecture

**Status:** Settled proposal; automatic refresh is an approved requirement  
**Related:** [Current-state audit](./02-Current-State-Audit.md), [Calendar/scheduling](./12-Production-Calendar-And-Checklist-Scheduling.md), [External Editor](./13-External-Editor-Authorization.md), [TB2](../roadmap/TB2-Route-Safe-Data-Freshness.md), [TB5C](../roadmap/TB5C-Production-Calendar.md)

## 1. Required behavior

Keep path-based URLs and the typed custom router. Users must be able to open independent project/Calendar slices in separate tabs, receive relevant changes without browser reload, preserve local work during refetch, and stop displaying private data after access removal.

## 2. Server-state layer

Adopt TanStack Query incrementally in TB2, first for project detail and active collection assets. Jobs/AutoHDR/comments/checklist retain their existing lifecycles until their owning slices migrate.

## 3. Query identity

Every request variable belongs in its key.

```ts
const projectKeys = {
  detail: (projectId: string) => ["project", projectId] as const,
  assets: (projectId: string, collection: string) => ["project-assets", projectId, collection] as const,
  discussion: (projectId: string) => ["project-discussion", projectId] as const,
  subtasks: (projectId: string) => ["project-subtasks", projectId] as const,
  board: (scope: string, sort: string) => ["projects", { scope, sort }] as const,
  calendar: (range: { start: string; end: string }, filters: object, accessScope: string) =>
    ["production-calendar", range, filters, accessScope] as const,
};
```

Calendar identity includes visible range, event layers, Editor/Stage/status/search filters, active/archived scope where allowed, and authorization-relevant principal state. External Editor and internal Editor caches must never share a payload identity accidentally.

## 4. Freshness contract

- Visible ordinary project/board/Calendar resources: bounded 20–30 second polling where useful.
- Hidden tab: pause ordinary polling.
- Focus/reconnect: refetch stale visible resources.
- Jobs/AutoHDR: retain/adapt current five-second terminal-aware behavior; never duplicate it.
- Discussion/checklist: later slices use open-state refresh.
- Notifications: list on open plus bounded unread polling.

No one global interval.

## 5. Same-browser invalidation

Use a narrow same-origin `BroadcastChannel` after successful mutations. Invalidation identifies the smallest domain resource/project; Calendar consumers invalidate only ranges potentially affected by the changed project/schedule. Same-browser invalidation supplements focus/polling rather than replacing cross-session correctness.

## 6. Mutation behavior

After success:

1. apply authoritative response data when available;
2. invalidate the smallest affected query set;
3. broadcast narrow invalidation;
4. never reload the whole app.

Examples:

- team delta → project detail/coordination/board quick detail + Calendar filters if membership visibility changed;
- Deadline change → project detail/board/Calendar;
- checklist schedule change → checklist + Calendar;
- Stage move → project detail/board/Calendar metadata;
- role/membership access loss → purge now-inaccessible resources rather than merely refetching them.

## 7. Request cancellation and late responses

Query functions use `AbortSignal` where supported. Key identity makes old responses irrelevant. Permanent `403`/`404` stops ordinary retries and clears inaccessible content.

For External Editor access loss, purge project detail, Calendar events/Unscheduled items, checklist/comments, quick detail, and sensitive media references; close project-specific editors/lightboxes/popovers and navigate to the nearest safe Dashboard view. Membership loss does not globally sign out; role change/deactivation does through session revocation.

## 8. Draft and interaction preservation

Background refresh must not reset Tiptap/form/picker drafts, open dialog/sheet, scroll, Lightbox selection, Dashboard/Calendar filters, active Kanban drag, or active Calendar drag/resize.

During active Calendar manipulation, defer/reconcile incoming entity refresh so it cannot move the gesture target underneath the user. A conflict at commit remains authoritative and rolls the proposed event back.

## 9. Coordination conflicts

Freshness does not replace guarded mutation:

- membership removal carries membership-cycle identity;
- project Deadline save/drag carries schedule version;
- checklist schedule edit/drag/resize carries schedule/item version;
- Stage move carries expected Stage/revision;
- board movement carries accepted snapshot/neighbour contract.

Conflicts show authoritative state and never silently retry across a changed premise.

## 10. Typed Calendar URL state

Calendar query parameters own active date, Month/Week/Agenda, event layers, selected Editor IDs/Unassigned, Stage keys, completed/delivered visibility, and overdue-only. Back/Forward restores them. Invalid/inaccessible IDs are ignored or removed safely. Local remembered Calendar state is only a fallback when the URL omits explicit state.

## 11. Tests

Later consumers extend TB2 tests with:

- Calendar range/filter key separation;
- copied URL and Back/Forward state;
- same-browser Deadline/checklist schedule invalidation;
- active Calendar drag/resize survives refresh;
- stale mutation rollback;
- internal versus External Editor authorized projection isolation;
- membership removal purges an already-open project/Calendar cache;
- no inaccessible counts/search/filter candidates leak after access loss.

## 12. Non-goals

- WebSockets/presence.
- Router replacement.
- One-release conversion of all server state.
- Polling every resource every five seconds.
