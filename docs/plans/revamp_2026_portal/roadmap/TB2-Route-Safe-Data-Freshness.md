# TB2 — Route-Safe Project Data Freshness

**Primary user outcome:** a project page receives relevant changes without browser reload while deep links and multiple tabs remain correct.

## Scope

- Add TanStack Query provider and typed query-key factory.
- Migrate a bounded Project Workspace data set first: project detail plus one current collection/status path.
- Include project/collection variables in keys.
- Focus/reconnect refetch.
- bounded polling while visible.
- targeted invalidation after existing mutations.
- abort/late-response protection.
- preserve local state and existing special polling.

## Non-goals

- convert every API call;
- router replacement;
- WebSockets;
- comment/notice storage changes;
- UI redesign.

## Acceptance

- direct URL works;
- Project A/B tabs are isolated;
- external simulated update appears without reload;
- focus refresh works;
- old request cannot overwrite new route;
- drafts/lightbox/selection are preserved;
- no duplicate job polling;
- access removal clears private data.

## Checkpoint

Approve the query conventions before TB3/TB5 reuse them.
