# Revamp TB2 — Route-Safe Project Data Freshness Plan

> **Status: APPROVED — plan review complete (2 Sol draft-review rounds, 2 Opus tier-2 rounds, both
> reverts used, final verdict APPROVE 2026-08-26); not yet implemented, verified, or deployed.**

## Authority and outcome

Authority order for this plan is:

1. [`Decision-Sheet.md` D-17](../Decision-Sheet.md), limited to its route-aware server-state
   freshness decision. D-17's discussion, notification, pipeline, and Kanban decisions belong to
   later tracer bullets.
2. [`Implementation-Plan.md` A9](../Implementation-Plan.md), the promoted authority for route-aware
   server-state freshness. A10 is boundary context only and contributes no TB2 implementation.
3. The [TB2 roadmap scope stub](./revamp_2026_portal/roadmap/TB2-Route-Safe-Data-Freshness.md).
4. The settled [Route and Data Freshness Architecture](./revamp_2026_portal/core/05-Route-And-Data-Freshness.md)
   and its [TanStack Query research memo](./revamp_2026_portal/research/Route-Freshness-And-TanStack-Query.md).
5. This repository-native execution plan.

The primary user outcome is the roadmap's approved outcome: **“Project Workspace detail and
active collection assets receive relevant changes without reload while routes/tabs/drafts remain
correct.”**

D-17 and A9 require the existing typed custom router and deep URLs to remain authoritative while
TanStack Query is adopted incrementally. TB2 is the first bounded proof: only Project Workspace
project detail and the active collection's `/assets?collection=…` result move behind the new
server-state module. Query identity contains the project ID and collection kind; cancellation,
focus/reconnect refresh, visible 30-second polling, narrow same-browser invalidation, draft and
interaction preservation, and permanent-access-loss cleanup are part of that proof.

The target is measurable: another same-browser tab starts its targeted refetch within two seconds
of a successful foreground mutation, while another browser/session converges on a visible active
resource within one 30-second polling interval. These are elapsed-time acceptance limits, not
descriptions of eventual consistency.

### Implementation precondition

TB0A, TB0B, and TB1 are deployed and accepted on current `main`; `docs/todo.md` identifies TB2 as
next. Implementation still begins from a fresh branch off then-current `main`, records that base
commit, and rechecks all dependency/source facts below. This plan authorizes no work on `prototype/`.

## Verified current state

### Runtime, dependency ownership, and routing

`portal/package.json` is the monorepo dependency owner. It pins React/React DOM `19.2.8`, Vite
`^8.1.5`, TypeScript `^7.0.2`, and the shipped TB1 Tailwind/shadcn dependencies. It does not contain
TanStack Query. `portal/apps/web/package.json` contains only the workspace's `happy-dom` dev
dependency and must not gain a duplicate runtime declaration. `portal/apps/web/vite.config.ts`
already has `react()`, `tailwindcss()`, the `@ → src` alias, and the existing `/api` and `/media`
dev proxies; TB2 changes none of that wiring.

There is no third-party router. `portal/apps/web/src/lib/router.ts` wraps the typed route parsers
from `@quincy/shared` in a History API adapter. `Shell` in `portal/apps/web/src/App.tsx` reads it
with `useSyncExternalStore`, and `InternalLink.tsx` keeps real anchors while intercepting only safe
ordinary same-origin pointer navigation. `ProjectWorkspace` is rendered as
`<ProjectWorkspace key={route.projectId} projectId={route.projectId} … />`; direct URLs,
`popstate`, Back/Forward, modified clicks, and new-tab behavior already work. TB2 retains all of
these interfaces and introduces no routing package.

### Current Project Workspace load and state contract

The current implementation is `portal/apps/web/src/screens/ProjectWorkspace.tsx`.

Its initial `useEffect` owns a manual, project-scoped load run:

1. it increments `loadRunRef`, creates an `AbortController`, aborts the previous asset request,
   clears the workspace's server and UI state, and sets `viewState` to `loading`;
2. it calls `apiGet<ProjectResponse>(/api/projects/:projectId, { signal })`;
3. only after details succeed, it starts one `Promise.all` for
   `/assets?collection=raw`, `/ingest-status`, and (for `adminBackend`) `/jobs` using the same
   signal;
4. it commits the response into `data`, `assets`, `rawAssets`, `ingest`, and `jobs`, marks
   `workspaceReadyRunRef`, and switches once to Edited when the user can view Edited and the
   project is in `editing_autohdr`, `edited_review`, or `delivered`; and
5. `loadRunRef`, `currentProjectIdRef`, and the signal prevent a late old-project batch or comments
   probe from committing after navigation.

The detail shape stored in `data` includes the rail/header fields, `stageKey`, RAW folder values,
stored/effective cover IDs, `collections` (including per-kind `receivedCount`), and `members`.
There is no ordinary manual Refresh button, focus/reconnect refresh, or visible polling for this
detail read. It refreshes only on initial mount and through mutation/special-job paths listed
below.

An initial detail `403` has one intentional exception. The load effect probes
`GET /api/projects/:id/comments?limit=50`; a successful probe stores `fallbackComments` and shows
the existing collaboration-only view for a project participant whose media stage is hidden. The
probe never runs after a successful detail response followed by a later workspace-read failure.
TB2 preserves this exact split and keeps the comments request manual.

### Current active-collection asset path and race guards

`ProjectWorkspace` holds one shared `assets: WorkspaceAsset[]` state for RAW, Edited, video,
floorplan, and copy, plus a second `rawAssets` state used for persisted RAW selection counts and
Edited Lightbox comparison. `activeTab` is local state and is not a URL parameter.

`refreshAssets(kind = activeTab)` calls:

```text
GET /api/projects/:projectId/assets?collection=:kind
```

It aborts the previous `assetRequestRef.controller`, increments a generation, and commits only if
the generation, `currentProjectIdRef`, and `currentTabRef` still match. `refreshEditedCollection`
is a second Edited-only fetch with project/tab checks. On a tab switch, an effect restores the
cached `rawAssets` for RAW or clears `assets` for other kinds, closes `openAssetId` and
`lightboxOrderIds`, and starts `refreshAssets(activeTab)`.

That effect is a mitigation, not a complete identity model. React can render the new `activeTab`
once with the old shared `assets` before the effect clears it. The same shape exists in the
RAW-first initial load followed by the one-time Edited switch. The deferred
`docs/plans/ProjectWorkspace-Asset-Tab-Sync-Plan.md` records this finding. TB2 closes it by deriving
rendered assets directly from the exact project+collection query key; there is no untyped shared
asset slot to momentarily mislabel.

Current asset/detail refresh triggers are:

| Existing trigger | Current reads after success or while active |
|---|---|
| Asset review or RAW selection | optimistic writes to `assets`/`rawAssets`; no confirming read |
| Cover change | `refreshProject()` |
| One or bulk asset delete | sequential `refreshAssets()` then `refreshProject()` through `refreshAfterAssetDelete()` |
| RAW upload completion | `refresh()` = active assets + ingest + admin jobs |
| Edited upload/publish completion | Edited assets + project detail |
| Floorplan/copy document completion or manual link add/remove | `CollectionPanel.onChanged()` = active assets + project detail |
| `syncDropbox()` | six bounded 2.5-second cycles of active assets + ingest + jobs, Edited assets, and AutoHDR status |
| Send to AutoHDR or retry job | jobs + project detail |
| Any active job | one existing five-second interval for jobs + Edited assets + project detail until terminal |
| Legacy AutoHDR handoff | one existing terminal/block-aware five-second recursive timeout for status/jobs, with conditional Edited assets/project refresh |

No ordinary route/resource polling exists today. The five-second loops above are narrow special
lifecycles and are not a template for TB2's ordinary freshness.

### Lifecycles that TB2 must leave manual

The following concrete mechanisms remain on their current fetch/state owners:

- `ingest`, `refreshIngest()`, and `GET /api/projects/:id/ingest-status` in
  `ProjectWorkspace.tsx`;
- `jobs`, `refreshJobs()`, `GET /api/projects/:id/jobs`, the active-job five-second interval,
  `sendToAutoHdr()`, and `retryAutoHdr()`;
- `autohdrStatus`, `refreshAutohdrStatus()`, `autohdrObservedRef`, and the terminal/block-aware
  five-second legacy AutoHDR timeout;
- `UploadDropzone.tsx`'s `progress` state and five-second
  `GET /api/projects/:id/manual-upload-jobs` publication poll;
- `ProjectCollaborationPanel.tsx`'s manual comments load/pagination and local mutation state,
  including the collaboration-only 403 probe;
- `SubtaskChecklist.tsx`'s manual `load()`/mentionable-user reads and local add/update/delete/
  reorder state; and
- `CollectionPanel.tsx`'s manual `/links?collection=…` loading, `loadToken` late-response guard,
  link mutation state, and document-upload state.

TB2 may replace calls from these owners into `refreshProject()`/`refreshAssets()` with exact query
cache operations, because those two resources migrate. It must not move the owners themselves,
their job/comment/checklist/link payloads, or their intervals into TanStack Query.

### Current UI-only state that must survive background data changes

The relevant local state is real and distributed:

- `ProjectWorkspace`: `activeTab`, `openAssetId`, `lightboxOrderIds`, `viewState`,
  `fallbackComments`, `isSyncing`, `isSending`, `toasts`, and collaboration-open signal refs;
- `PhotoGrid`: `filter`, multi-select `multi`, `lastSelected`, `failedThumbnails`,
  `thumbnailRetries`, and `isPreparingDownload`; its current `key={activeTab}` intentionally resets
  grid-local selection only on a user/programmatic collection switch, not on data refresh;
- `Lightbox`: the active `index`, RAW compare state, panel state, zoom, strokes, annotation-note
  draft, inline note/drawing edits, annotation/stroke caches, current tool, and saving state;
- `ProjectCollaborationPanel`: `overlayOpen`, comment composer `content`, `editing`, comments,
  pagination, and focus/signal refs;
- `SubtaskChecklist`: `newTitle`, `newAssigneeId`, `newDueDate`, `draftTitles`, `editingId`,
  `composerOpen`, `activePopover`, drag/focus refs, and the open/collapsed state; and
- `CollectionPanel`: new-link `url`/`label`, `editingLinkId`, `editDraft`, reorder/upload state,
  and file-input refs.

Window scroll, `.project-collaboration__scroll`, and `.vpanel__scroll` are DOM-owned. None is
currently stored in project/asset server state. TB2 must keep these modules mounted during an
ordinary refetch and must not make query status a `key` or set the whole workspace back to
`loading` after its first successful initialization.

## Scope constraints

### In scope

- Add one pinned TanStack Query runtime dependency, one authenticated-principal-and-role-scoped
  `QueryClientProvider`, and a typed Project Workspace query module.
- Migrate only `GET /api/projects/:id` as consumed by `ProjectWorkspace` and
  `GET /api/projects/:id/assets?collection=:kind` as consumed for the active workspace collection.
- Preserve the existing RAW-first bootstrap: RAW is the sole active asset query first; after it
  succeeds, the one-time stage rule may switch the sole ordinary polling observer to Edited while
  one passive subscribed RAW observer preserves reactive compare data. Do not mount simultaneous
  ordinary RAW and Edited polling observers.
- Replace the current shared `assets` slot, asset abort/generation refs, and detail `data` state
  with exact keyed query data while retaining manual companion lifecycles.
- Add exact-key cache update/invalidation and same-browser BroadcastChannel publication to every
  existing foreground mutation that changes either migrated response.
- Add permanent 401/403/404 retry suppression, immediate private-view hiding, principal- or project-scoped cache
  purge, and safe terminal UI behavior.
- Add focused tests, race tests with actually reversed promise completion, timing/manual evidence,
  dependency/bundle evidence, app-only deployment, and rollback records.

### Hard non-goals

- **No every-API conversion.** Dashboard lists, EditProject's own form load, Admin, stages,
  notifications, comments, checklist/subtasks, links, mentionables, annotations, jobs, ingest, and
  AutoHDR status stay on their current read mechanisms.
- **No router replacement.** Do not add TanStack Router, React Router, route loaders, SSR, or URL
  ownership for `activeTab`; retain `@quincy/shared` route parsing, `locationStore`,
  `InternalLink`, `key={route.projectId}`, direct URLs, and History API behavior.
- **No WebSockets, Durable Object presence, SSE, or push subscription.**
- **No duplicate five-second polling.** Preserve `UploadDropzone`'s publication poll and
  `ProjectWorkspace`'s job/legacy-AutoHDR loops; do not add another five-second timer. Pause TB2's
  ordinary 30-second interval while an existing special lifecycle is explicitly refreshing the
  same project/detail/asset resources.
- **No UI redesign.** Normal successful rendering, copy, tabs, geometry, styling, focus order,
  and affordances remain visually unchanged. Initial-tab loading may become an explicit existing-
  style empty/loading state, but no new visual system enters.
- No A10 discussion/read-state/activity/notification outbox work; no notification registry or
  cross-device read-state migration.
- No pipeline semantic, `moveProjectStage`, Kanban ordering/dnd-kit, Project Workspace rail,
  Deadline/team coordination, Calendar, External Editor, or authorization-projection program.
- No mutation rewrite to `useMutation` as a collateral cleanup. Existing `apiPost`/`apiPatch`/
  `apiDelete` requests remain; only their optimistic server-state writes and post-success exact
  invalidation are adapted.
- No query persistence to IndexedDB/localStorage, no service worker, no offline mutation queue,
  no TanStack Query devtools in production, and no cross-browser/session BroadcastChannel claim.
- No change to the send-only AutoHDR provider contract, no direct-path retrieval/polling revival,
  no duplicate send, no selection reset, and no ambiguous-provider retry as a new paid job.
- No schema, D1 migration, R2/KV/Queue/Workflow/binding/secret, app API response, or Worker route
  change.

## Exact implementation plan

### 1. Recheck and pin TanStack Query

The live npm package page and official TanStack source/docs were checked on **2026-08-25**. The
current published stable candidate is **`@tanstack/react-query@5.102.2`**. The repository's React
`19.2.8` satisfies the package's declared `react: ^18 || ^19` peer range. TanStack's `main` source
already reports an unreleased `5.102.3`; that is not evidence that `5.102.3` is installable and is
not the candidate.

Immediately before editing, run from `portal/`:

```bash
npm view @tanstack/react-query version
npm view @tanstack/react-query@<chosen-version> dist-tags --json
npm view @tanstack/react-query@<chosen-version> peerDependencies --json
npm view @tanstack/react-query@<chosen-version> dependencies --json
```

Use the latest **published stable v5** returned at execution time, pin it exactly, and update the
execution record if it differs from `5.102.2`. Do not use a caret, tilde, `latest`, alpha, beta,
RC, canary, an unreleased source version, the persistence/broadcast experimental packages, or
devtools. With the currently checked candidate, the command is:

```bash
npm install --save-exact @tanstack/react-query@5.102.2
```

Run it from `portal/`, so the direct dependency lands in `portal/package.json` and the root
`package-lock.json`. `portal/apps/web/package.json` remains unchanged. Review the lockfile for one
direct React Query line, its expected `@tanstack/query-core` dependency, compatible peers, and no
unexplained transitive churn. Save the command output and chosen version at
`docs/plans/revamp_2026_portal/evidence/TB2/dependency-version-check.txt`.

Primary checks at implementation time are the
[npm package](https://www.npmjs.com/package/%40tanstack/react-query),
[official installation guide](https://tanstack.com/query/latest/docs/framework/react/installation),
[important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults),
[query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation),
and [QueryClient reference](https://tanstack.com/query/latest/docs/reference/QueryClient).

### 2. Mount one authenticated-principal-and-role-scoped provider

Add `portal/apps/web/src/lib/query-client.tsx` with a `QuincyQueryProvider` that creates its
`QueryClient` exactly once per mounted provider (lazy `useState` or an equivalent stable ref) and
renders `QueryClientProvider`.

Mount it in `App.tsx` only inside the authenticated branch, outside `StagesProvider` and `Shell`.
Extend the local `SessionUser` type with `role: Role`, then pass both authorization-scope values:

```tsx
const user = session.data.user as SessionUser;

<QuincyQueryProvider
  key={`${user.id}:${user.role}`}
  principalId={user.id}
  role={user.role}
>
  <StagesProvider>
    <Shell user={user} />
  </StagesProvider>
</QuincyQueryProvider>
```

The provider key is a privacy invariant: a sign-out or any observed principal/role change unmounts
the client and its complete in-memory cache. The client is never a module singleton shared across
authenticated principals or roles. This role partition is required because
`workers/app/src/routes/users.ts` deletes sessions only when `data.active === false`; an ordinary
role-only `PATCH /users/:id` leaves the session alive. Role changes alter real response authority:
`workers/app/src/routes/projects.ts` passes the session role through `details()`/
`projectStageForRole()` and uses RAW-only cover maps for photographers, while
`workers/app/src/routes/review.ts` rejects an Edited collection read without `viewEdited`. Keying the
provider by principal and role therefore supplies the authorization-scope identity and role-loss
purge required by Implementation Plan A9 without repeating either value in every project key inside
that scoped client.

This protection is bounded by what the client can observe. TB2 adds no independent session-role
refetch mechanism: the role-keyed remount occurs only when the existing `useSession()` state exposes
a changed server role. Closing that separate role-observation gap is outside TB2; a 401 observed by
a migrated query still takes the full-cache terminal path in §9.

Use these explicit defaults:

```ts
new QueryClient({
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
})
```

`projectQueryRetry(failureCount, error)` returns `false` for `ApiError` 401/403/404 and every other
non-transient 4xx except 408/429; it permits at most two retries for status `0`, 408, 429, and 5xx
(`failureCount < 2`). An abort remains cancellation/control flow, not a retryable error. There is
no global `refetchInterval`; polling belongs only to the two TB2 query options, so later manual
resources cannot accidentally inherit it.

The provider owns the BroadcastChannel lifecycle from §7. It closes the channel and calls
`queryClient.clear()` on unmount. Do not add a page-level global containing the client.

### 3. Define one typed Project Workspace server-state module

Add `portal/apps/web/src/lib/project-data.ts`. It is the seam for the two migrated resources and
owns their response types, paths, keys, query functions, exact invalidation, and purge behavior.
Move the current `ProjectResponse`/collection/member types out of `ProjectWorkspace.tsx`; retain
`WorkspaceAsset` as the existing shared view type from `PhotoGrid.tsx` unless implementation-time
type review proves a more appropriate already-shared owner.

Use `CollectionKind` from `@quincy/shared`; do not redeclare the five-kind union. The exact key
factory is:

```ts
export const projectDataKeys = {
  root: ["project-data"] as const,
  project: (projectId: string) => ["project-data", projectId] as const,
  detail: (projectId: string) => ["project-data", projectId, "detail"] as const,
  assetsRoot: (projectId: string) => ["project-data", projectId, "assets"] as const,
  assets: (projectId: string, collectionKind: CollectionKind) =>
    ["project-data", projectId, "assets", collectionKind] as const,
};
```

The explicit `detail` segment lets a detail invalidation use `exact: true` without touching assets.
`project(projectId)` is reserved for privacy purge/deletion of that one project; ordinary
mutations must not use it. Never call `invalidateQueries()` without a key.

The shared `project-data` root is an intentional deviation from the separate `project` and
`project-assets` roots illustrated—not mandated—in core architecture document
`core/05-Route-And-Data-Freshness.md` §3. It still includes every request-changing project and
collection value, while giving deletion and access-loss handling one prefix that can be tombstoned,
cancelled, and purged without touching another project.

Expose these typed interfaces:

```ts
projectDetailQueryOptions(projectId: string)
projectAssetsQueryOptions(projectId: string, collectionKind: CollectionKind)
useProjectDetailQuery(projectId: string, enabled: boolean, specialOwnerOwnsKey: boolean)
useProjectAssetsQuery(projectId: string, collectionKind: CollectionKind, enabled: boolean, specialOwnerOwnsKey: boolean)
usePassiveRawAssetsQuery(projectId: string, enabled: boolean)
invalidateProjectResources(queryClient, invalidation, publish?: boolean)
purgeProjectData(queryClient, projectId: string)
```

The detail query function replaces the current Workspace call to
`apiGet<ProjectResponse>(/api/projects/:id, { signal })`. The asset query function replaces every
Workspace call to `apiGet<AssetsResponse>(/api/projects/:id/assets?collection=:kind, { signal })`
and returns the `WorkspaceAsset[]` itself. Both URL-encode the project ID and collection value and
pass TanStack's query-function `signal` directly to `apiGet`.

The exported option factories contain the key/query function and no observer-only polling fields.
They are the only way existing special lifecycles force an exact detail/collection read:
`queryClient.fetchQuery({ ...project…QueryOptions(...), staleTime: 0 })`. This creates an inactive
Edited entry when the already-existing five-second owner requests Edited before that tab has ever
mounted, and always performs the special owner's read even if the ordinary 15-second stale window
has not elapsed. Do not duplicate URLs, hand-build keys, or use a broad `refetchQueries` prefix back
in `ProjectWorkspace`.

### 4. Convert only Project Workspace detail and active assets

In `ProjectWorkspace.tsx`:

1. Replace `data`/`setData` with `useProjectDetailQuery` data.
2. Replace shared `assets`/`setAssets` and the active query part of `rawAssets` with
   `useProjectAssetsQuery(projectId, activeTab, …)` data.
3. Delete `assetRequestRef`, `currentTabRef`, the active-asset generation/controller code, and
   `refreshEditedCollection`; query identity/cancellation now owns that concern.
4. Keep `currentProjectIdRef`/a manual generation only where the untouched comment fallback,
   ingest, jobs, or AutoHDR lifecycles still require it. Do not retain a second guard around the
   query functions “for safety”; one owner is testable, two can diverge.
5. Keep `activeTab` initialized to RAW. Enable the RAW asset query only after detail succeeds.
   Start the existing manual ingest/admin-jobs companion requests at the same point and with their
   §9 project-generation AbortSignal and late-commit guard. Mark the workspace initialized only
   after detail, initial RAW assets, ingest, and required jobs succeed, matching the current
   sequence.
6. After that first RAW success, apply the existing stage/capability rule once per project to
   select Edited. Do not run that selection effect on background project-detail updates. Whenever
   `activeTab !== "raw"`, mount `usePassiveRawAssetsQuery` against the same exact RAW key with
   `staleTime: Infinity`, `refetchInterval: false`, `refetchOnWindowFocus: false`, and
   `refetchOnReconnect: false`. Enable it only after the initial RAW success. This is a genuine
   subscribed observer, so the RAW entry is not garbage-collected while the workspace is mounted
   and a later exact RAW cache update remains reactive; it is not an ordinary polling observer.
   The invariant is no simultaneous ordinary RAW and Edited **polling** observers, not zero RAW
   observers. When RAW is the active tab, the ordinary RAW hook supplies the same data and the
   passive duplicate is not mounted. Keep this hook-safe by conditionally rendering a non-RAW body
   descendant that calls both the active-kind hook and `usePassiveRawAssetsQuery`; do not call a hook
   conditionally in one component, use a headless effect to copy RAW into parent state, or mount an
   `enabled: false` passive observer on the RAW branch.
7. Derive displayed assets only from the exact active query. When a never-visited key is pending,
   render the current collection's existing-style loading/empty state—never previous-key data.
   Do not use `keepPreviousData` or `placeholderData: previousData` across collection keys.
8. When revisiting RAW/Edited/etc., render only that key's own cache and refetch it according to
   staleness. Derive `rawAssets` from the ordinary RAW hook while RAW is active and from the passive
   RAW observer otherwise; do not read it during render with non-reactive `getQueryData`. This
   preserves current Lightbox compare/selection support beyond the default five-minute `gcTime`
   without a second ordinary polling observer.

Delete the load effect's mutable `loading`/`full-workspace` assignments and derive the effective
`viewState` for the current generation explicitly. It is `loading` until detail and initial RAW
queries are successful and the initial ingest/required-jobs companion batch has succeeded;
that conjunction records a state-backed `workspaceInitializedFor` token (mirrored in a ref for
post-`await` guards). It is `full-workspace` while that token matches the current project/generation
and no terminal access classification exists, even if a migrated query is subsequently fetching or
has a transient background error. Initial detail/probe/access outcomes derive
`collaboration-only` or `unavailable` as specified in §9. The parent's matching initialized token
plus its non-terminal generation replaces the current `ready()` gate for `refreshIngest()`,
`refreshJobs()`, `refreshAutohdrStatus()`, active-job startup, and every other remaining manual
owner; the token is set only after the migrated query states and companion bootstrap meet the same
success boundary that `ready()` represents today. The child reports only generation-tagged query
bootstrap readiness to that parent lifecycle; query payloads remain in the child and are never
lifted back into parent state to implement the gate.

After first initialization, `isFetching` is background state only: it must not reset `viewState`,
clear local state, unmount collaboration/Lightbox/PhotoGrid, or scroll. An initial detail failure
or initial RAW/companion failure still uses the current unavailable/collaboration-only rules. A
later transient 0/408/429/5xx refresh failure retains last good data and produces one bounded
non-blocking error indication; it does not turn the whole screen into `loading` or repeatedly toast
on every 30-second attempt.

`EditProject.tsx` continues to load its form with its current manual `useEffect` and `apiGet`.
Dashboard continues to load its project list manually. Their mutation success paths participate
only in §7 exact invalidation.

### 5. Make cancellation and late-response safety structural

Every query function must use the `signal` received in `QueryFunctionContext`:

```ts
queryFn: ({ signal }) =>
  apiGet<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`, { signal })
```

and equivalently for assets. `apiGet` already preserves native `AbortError` and forwards
`RequestInit.signal` to `fetch`.

The safety proof has two independent parts:

- When a project/collection observer becomes inactive or a newer exact refetch supersedes it,
  TanStack aborts the consumed signal. The fetch is actually cancelled where the platform honors
  AbortController.
- Cancellation is not the sole correctness guard. A response can only be written under the
  query key captured when that request started. A late Project A response writes, at worst, to
  `projectDataKeys.detail(A)`; Project B renders `detail(B)`. A late RAW response writes only to
  `assets(projectId, "raw")`; an Edited view renders only its Edited key. No response handler calls
  shared `setData`/`setAssets`, so a server that ignores abort still cannot overwrite the current
  route/collection.

Exact mutation invalidation uses TanStack's default `cancelRefetch: true`. Optimistic review and
selection additionally use one coordinator keyed by the exact asset-list query. This is required
because `PhotoGrid.bulk()` starts every selected asset's `onReview`/`onSelection` call together with
`Promise.all`; several mutations against one list are therefore a normal current call path, not an
edge case.

The coordinator owns an ordered ledger of mutation tokens. Each token records only its touched
coordinates—asset ID plus `selected` or the individual `review.stars`, `review.colorLabel`,
`review.decision`, and `review.recommended` fields in the submitted patch—and the value that
preceded the first ledger entry for each coordinate. Starting a token cancels the exact query and
uses functional `setQueryData(current => …)` to compose its field patch over the latest list. It
never replaces the list from a saved whole-query snapshot and never rolls back an entire asset or
`review` object.

If `current` is `undefined` because that exact entry was evicted or purged before the optimistic
write, return `undefined` and skip creating optimistic cache data; there is nothing safe to show,
and the mutation's eventual exact invalidation/refetch remains authoritative.

Success marks that token committed; failure removes only that token and recomputes only its touched
coordinates from the coordinate base plus the remaining pending/committed tokens in start order.
Thus a failure cannot erase a successful sibling asset update, an unrelated field on the same
asset, or a later write to the same field. The terminal project purge in §9 discards the ledger
instead of replaying it.

While any token for an exact key remains pending, that key is mutation-owned: its ordinary
interval/focus/reconnect refetch is suppressed, and local or received invalidation requests are
recorded rather than executed. A successful sibling queues one confirming invalidation but does not
start it while another sibling is pending. When the pending count reaches zero, retain the composed
optimistic result, clear the settled ledger, run at most one queued exact invalidation, and publish
that resource once if at least one local mutation committed. This prevents a success refetch from
stomping a still-pending optimistic patch while still converging on the authoritative server result.
The query hooks subscribe to this coordinator and combine its pending-key flag with the exact-key
special-owner flag from §6; cancelling the pre-mutation request is therefore followed by structural
suppression of new automatic reads until the ledger settles.

Add deterministic tests that leave A/RAW promises pending, switch to B/Edited, resolve the new
request first, then resolve the old request despite its aborted signal. Assert both the visible DOM
and exact cache entries. Reasoning about an AbortSignal without completing promises in reverse
order is not sufficient evidence.

### 6. Use exact visible freshness and preserve special polling

Each TB2 observer evaluates ownership for its own exact key. Let `refetchOwned` mean either a §5
optimistic ledger is pending for that key or a special lifecycle below currently owns it; use:

```ts
refetchInterval: refetchOwned ? false : 30_000,
refetchIntervalInBackground: false,
refetchOnWindowFocus: refetchOwned ? false : true,
refetchOnReconnect: refetchOwned ? false : true,
```

“Visible” means the default TanStack v5 browser focus manager sees
`document.visibilityState !== "hidden"`; it does not require that the browser window own OS-level
keyboard focus. V5's `refetchOnWindowFocus` browser event is a `visibilitychange` return. An
ordinary hidden tab does not run its 30-second interval. Returning to a stale visible tab or
restoring network connectivity refetches the active stale detail and collection queries. The 15-second
`staleTime` avoids a redundant focus churn immediately after a successful fetch; the independent
30-second interval still enforces the cross-session upper bound while visible.

Maintain an owner set keyed by the exact detail or project+collection asset key; there is no
screen-wide `ordinaryPolling` switch. The existing special lifecycles register only the resources
they are about to force-read and leave every other active observer on its ordinary 30-second bound:

- Active-job lifecycle states are `idle`, `active`, and `terminal`. The transition to `active`
  occurs when a jobs response first satisfies `jobs.some(activeJob)`; while active, the existing
  five-second batch owns exact project detail and exact Edited assets (plus manual jobs state).
  A terminal jobs response leaves ownership in place until that batch's final detail/Edited promises
  settle, then transitions to `terminal` and releases both keys. RAW, video, floorplan, and copy
  retain ordinary polling throughout.
- Legacy AutoHDR lifecycle states are `inactive`, `polling`, `blocked`, and `terminal`. The eligible
  effect starts `polling`; the existing `retired`/`failed` handoff result enters `terminal`, and
  `blocked`/`blocked_collision` enters `blocked`, clearing its recursive timeout in either case.
  Status/jobs-only cycles own no migrated key. A polling cycle owns detail only while the current
  `raw_review` condition makes that cycle force detail, and owns Edited only while the existing
  newly-observed terminal `fetch_edited` branch force-reads Edited. Each ownership token begins
  before its exact `fetchQuery` and releases after that promise settles; blocked, terminal, cleanup,
  and access loss release the complete owner set.
- The bounded Dropbox-sync cycles follow the same rule: register only the exact migrated keys a
  given cycle actually force-reads, release them after that cycle settles, and never suppress an
  unrelated active collection merely because `isSyncing` is true.

Every forced read and special owner preserves the capability guard on its current manual call site
before registering ownership. A RAW read requires `can("viewRaw")`; an Edited/video/floorplan/copy read
requires `canViewEdited`; AutoHDR status and jobs reads require `canAdminBackend`. A guarded-out
resource is neither force-read nor added to the owner set for that principal. This applies to
active-job, legacy AutoHDR, and bounded Dropbox-sync cycles alike: the current Sync-from-Dropbox
control is reachable to photographers via `uploadRaw`, but its guarded Edited and AutoHDR companion
legs must remain silent for that role.

The owner transition is synchronous and precedes the special fetch. Release schedules the next
ordinary interval from that point; it does not fire an immediate duplicate read of a just-settled
special fetch. `UploadDropzone`'s five-second publication-status poll remains unchanged; its
completion callback performs the exact asset/detail invalidation in §7 rather than starting another
timer.

No interval is global, no hidden-tab ordinary interval runs, and no five-second timer is added.
Tests use fake timers plus a controllable `visibilityState`/focus manager to prove 30 seconds,
hidden pause, resume, and the special-owner suppression.

### 7. Add narrow mutation invalidation and same-browser broadcast

Create `portal/apps/web/src/lib/project-query-sync.ts`, owned by `QuincyQueryProvider`. Use the
exact same-origin channel name:

```text
quincy:project-data:v1
```

The validated wire union is:

```ts
type ProjectDataSyncMessage =
  | {
      version: 1;
      type: "project-data-invalidated";
      sourceTabId: string;
      projectId: string;
      committedAt: string;
      resources: Array<
        | { kind: "detail" }
        | { kind: "assets"; collectionKind: CollectionKind }
      >;
    }
  | {
      version: 1;
      type: "project-data-removed";
      sourceTabId: string;
      projectId: string;
      committedAt: string;
    }
  | {
      version: 1;
      type: "active-project-details-invalidated";
      sourceTabId: string;
      committedAt: string;
    };
```

Generate `sourceTabId` once with `crypto.randomUUID()`. Validate every received field and the exact
fields permitted for that discriminant, reject unknown versions/types/kinds/empty IDs, ignore the
sender's ID, deduplicate invalidation resources, and never put response data, user data, filenames,
comments, or auth material on the channel.

`invalidateProjectResources` normally does local
`invalidateQueries({ queryKey, exact: true, refetchType: "active" })` first, then broadcasts only
after the foreground server mutation succeeded. The §5 coordinator instead queues an affected key
while its ledger is pending. A receiver applies the same exact invalidations with `publish: false`;
it never rebroadcasts, reloads, navigates, or invalidates the whole cache. Active keys refetch
immediately unless mutation-owned; inactive keys are marked stale and refetch only when observed.
If `BroadcastChannel` is unavailable, local exact invalidation still works and 30-second
focus/polling is the explicit fallback; no localStorage event bus is added in TB2.

`project-data-removed` is deletion-only and stronger than invalidation. On local deletion success or
receipt, synchronously mark that project ID terminal in the provider's in-memory registry so a
mounted Workspace immediately renders its private-data-free branch and unmounts its query-owning
child. Expose that registry as a synchronous external store to which `ProjectWorkspace` subscribes;
the deletion tombstone lasts for this provider's lifetime. Abort every §9 manual owner, cancel every
in-flight query under `projectDataKeys.project(projectId)`, then remove every query under that prefix
after observers are gone. Query functions check the terminal registry again after `apiGet` resolves
and reject instead of returning data if removal arrived during the request. An inactive cached
query is removed immediately. Receivers never rebroadcast the removal message.

`active-project-details-invalidated` is the one deliberate broad-but-bounded exception for the rare
Admin user rename. A sender and receiver enumerate only cache entries whose full tuple matches a
project detail key and which are currently active, then exact-invalidate each match; asset keys and
inactive detail keys are untouched. The message carries no project or user data and is never
rebroadcast.

Apply the following complete mutation map. “Detail” and every “assets(kind)” entry mean the exact
keys in §3, not prefixes:

| Existing successful mutation/call site | Authoritative effect | Exact TB2 cache action and broadcast |
|---|---|---|
| `ProjectWorkspace.updateReview()` → `POST /api/assets/:id/review` | review fields in that asset response | apply the §5 field-coordinate ledger to active `assets(projectId, activeTab)`; defer one exact kind invalidation/broadcast until all sibling tokens settle; failure removes only its own token |
| `updateSelection()` → POST/DELETE `/api/assets/:id/select` | `selected` in RAW response | apply the §5 field-coordinate ledger to `assets(projectId, raw)`; defer one exact RAW invalidation/broadcast until all sibling tokens settle; failure removes only its own token |
| `updateCover()` → `POST /api/projects/:id/cover` | stored/effective cover in detail | exact detail invalidate+broadcast |
| `deleteAsset()`/`deleteAssets()` → `DELETE /api/assets/:id` | removes active-kind asset(s), changes collection count and possibly effective cover; deleting RAW also nulls `source_raw_asset_id` on referencing Edited assets in `workers/app/src/routes/assets.ts`, projected as `sourceRawAssetId` by `workers/app/src/routes/review.ts` | exact active-kind assets + exact detail invalidate/broadcast; when the deleted kind is RAW, also exact-invalidate/broadcast Edited assets; close Lightbox only for a server-confirmed deleted current asset |
| `UploadDropzone` completion for RAW or Edited, including its manual-publication terminal callback | adds visible asset(s), changes collection count | exact submitted collection assets + detail invalidate/broadcast; keep current ingest/jobs callback reads manual |
| `CollectionPanel` successful `documents/complete` | adds floorplan/copy assets and changes count | exact floorplan/copy assets + detail invalidate/broadcast |
| `CollectionPanel.addLink()` 201 and `removeLink()` | changes collection `receivedCount` in project detail; assets response is unchanged | exact detail invalidate/broadcast only; split the current generic `onChanged` callback so links do not invalidate assets |
| `CollectionPanel.saveEdit()` and `reorderLinks()` | changes only its manual links response | no TB2 invalidation/broadcast; retain local/manual reload |
| `EditProject.submit()` → `PATCH /api/projects/:id` | returns authoritative detail | `setQueryData(detail, response)`, then exact detail invalidate/broadcast; EditProject's GET remains manual |
| `archiveProject()` / `restoreProject()` | project lifecycle fields in detail | exact detail invalidate/broadcast before navigation |
| `deleteProject()` | project and every collection cease to exist | run the terminal cancel/remove sequence locally and broadcast one `project-data-removed` message; receivers purge immediately rather than retaining inactive data or waiting for a 404 |
| `Dashboard.moveProject()` → `POST /api/projects/:id/stage` | `stageKey` in detail | exact detail invalidate/broadcast; Dashboard list remains manual |
| Dashboard priority/board-position mutations | fields are not consumed by the current Workspace detail/asset views | no TB2 invalidation; their owning Dashboard lifecycle remains unchanged |
| `Admin.updateUser(user, { name })` after a successful `PATCH /api/users/:id` | Project detail joins `project_members` to `user.name` in `workers/app/src/routes/projects.ts` | publish `active-project-details-invalidated` and exact-invalidate every currently active detail query; this rare admin-only fan-out is bounded to active detail tuples and is the explicit exception to ordinary per-project narrow invalidation |
| `sendToAutoHdr()` and `retryAutoHdr()` | existing immediate project refresh plus manual jobs; later job progress may move Stage | exact detail invalidate/broadcast plus the existing jobs refresh; do not touch RAW selection or add provider polling |
| `syncDropbox()` | queues RAW/Edited background work | keep the six bounded 2.5-second companion cycles; force the exact active-collection read only when that kind's existing capability guard passes, force the companion Edited read only when `canViewEdited`, and run manual jobs/AutoHDR status only when `canAdminBackend`; guarded-out resources are not registered as owned or forced; keep ingest manual, and publish one combined invalidation only on cycles where structural sharing shows an authorized migrated resource changed |
| Existing active-job/legacy-AutoHDR terminal observation | may change detail/Edited assets after background completion | force only the exact conditional reads in §6; ordinary polling is suppressed only while each exact key is owned; no new timer or provider action |

The link/document callback split is deliberate locality: callers report whether they changed
detail, assets, or both; one generic “refresh everything” callback would defeat the narrow-key
contract.

Comments, subtasks, annotations, mentionables, link edit/reorder, download-ticket creation,
selected ZIP download, upload presign/abort, ingest status, jobs, AutoHDR status, notifications,
and Admin mutations other than successful user rename do not change either migrated response and
get no TB2 query key or broadcast.

### 8. Preserve tabs, drafts, selection, scroll, and Lightbox position

Keep all UI-only state named in “Verified current state” outside TanStack Query. The query cache
contains only server JSON; no `activeTab`, draft document, filter, selection set, open flag, focus
target, or scroll offset enters a key or cached payload.

Specific invariants are:

- `activeTab` changes only on the existing one-time stage default or explicit tab activation.
  Project-detail background data never resets it.
- `PhotoGrid key={activeTab}` remains. A background refetch retains the same key and therefore
  `filter`, `multi`, retry state, and selection anchor. Its existing asset-ID pruning effect removes
  only IDs genuinely absent from the new response. A deliberate tab change keeps its current
  reset behavior.
- Use TanStack's JSON structural sharing. Do not map/clone every asset in a `select` callback on
  each render; unchanged asset objects retain references. Query `select` functions, if used, must
  be stable module functions.
- Do not use cross-key previous data. A never-loaded collection shows no other collection's
  assets. A revisited collection may show only its own cached result while it refetches.
- `openAssetId` and `lightboxOrderIds` remain parent-local. A normal response containing the open
  ID keeps the Lightbox mounted and on that ID. Harden the Lightbox asset-list reconciliation so
  a changed list finds the current asset ID's new index; removing a different earlier item cannot
  shift the viewer to the wrong frame or create an out-of-range index. If the current asset itself
  is authoritatively absent, close safely; ordinary review/selection/count changes never close it.
- Keep all Lightbox draft state (`strokes`, `annotationNote`, drawing/note edit IDs and text),
  zoom, panel, compare state, and annotation lifecycle untouched. Do not key Lightbox by query
  status/data reference. Access loss and confirmed current-asset deletion are the only TB2-forced
  closes.
- Keep `ProjectCollaborationPanel`, `SubtaskChecklist`, and `CollectionPanel` mounted while query
  `isFetching`. Their composer/edit drafts and open popovers survive even if refreshed project
  labels/counts render elsewhere.
- Never call `window.scrollTo`, replace `.workmain`, or remount the full workspace on background
  fetch. Stable keyed lists and mounted scroll containers preserve window, collaboration, and
  Lightbox-panel scroll. Manual QA records numeric `scrollY`/`scrollTop` before and after a forced
  refresh; an unexplained reset is a failure.

This TB2 work may add focused Lightbox list-reconciliation logic/tests because it is necessary to
meet the approved preservation contract. It must not implement the deferred synchronized RAW↔Edited
zoom feature, annotation fixes, or any visual Lightbox redesign.

### 9. Clear inaccessible private data on permanent access loss

Use the existing `ApiError.status` convention. `isPermanentProjectAccessError(error)` is true for
401/403/404, and the retry policy returns false immediately for all three. Classification must also
retain the resource that failed; the same HTTP status does not imply the same purge scope:

- A 401 from either migrated query or any still-manual project request is principal-terminal.
  `requireSession` returns 401 for a missing/invalid session and for `user.active !== true`;
  `workers/app/src/index.ts` mounts it on all `/api/*`, and `api.ts` currently only throws the
  resulting `ApiError`—it has no global sign-out or redirect handler. Route every manual owner's 401
  catch into the same parent terminal transition rather than merely swallowing or toasting it.
- A 403/404 from the detail query is project-terminal after the workspace has initialized.
- An assets 403 whose `ApiError.details` payload carries the exact collection capability rejected
  by `workers/app/src/routes/review.ts` (`viewRaw` for RAW; `viewEdited` for Edited/video/floorplan/
  copy) is collection-terminal only. Remove that exact key and collection from this route
  generation; do not infer loss of the still-authorized project or another collection.
- An assets 403 without that exact capability marker is the route's project-membership failure and
  is project-terminal. Treat an assets 404 as project-terminal too: the current assets handler has
  no collection-specific 404 branch, so a 404 is not evidence for a narrower capability loss.

Put the query hooks in a query-owning **full-workspace body** child of `ProjectWorkspace`. It
receives `projectId` plus parent callbacks/UI props, renders the entire rail and workspace body
directly from its own detail, active-assets, and passive-RAW hook results, and never copies query
data into parent React state. Every `ProjectWorkspace`-owned UI-only item named in §8—including
`activeTab`, `openAssetId`, `lightboxOrderIds`, `toasts`, `isSyncing`, `isSending`, and project-open
intent—remains in the parent and is passed down. Unmounting the query owner therefore cannot itself
lose or recreate those values; the access-loss transition clears the privacy-sensitive subset
deliberately. The parent owns the terminal project generation and renders the child only while it is
non-terminal. The child derives the classified access error directly from its current query results
and branches away from the affected private markup in that same render; it does not wait for an
effect before hiding data.

Do not retain the hooks in a mounted `enabled: false` branch. TanStack React Query v5's checked
[`useBaseQuery` source](https://github.com/TanStack/query/blob/388bbaf/packages/react-query/src/useBaseQuery.ts)
constructs a `QueryObserver` during render, and that observer can build a cache entry even when
fetching is disabled. Unmounting the query owner before removal is therefore what makes the zero-
project-entry postcondition stable across later terminal-screen renders.

Give every still-manual project owner one parent-held generation and abort/timer registry. The
initial ingest/jobs batch, `refreshIngest()`, `refreshJobs()`, `refreshAutohdrStatus()`, and the
fallback-comments probe pass that generation's signal to `apiGet`; every response checks the same
project ID, generation, non-terminal marker, and signal after its final `await` before committing.
Track the active-job interval, legacy AutoHDR recursive timeout, and bounded Dropbox-sync delay so
the terminal transition can clear them. Unmounting `UploadDropzone` must run its existing
publication-poll cleanup; its outstanding publication result also receives the terminal generation
guard before invoking the parent completion callback. The same generation guard covers post-await
commits from `syncDropbox()`, `sendToAutoHdr()`, and `retryAutoHdr()` even where the foreground
mutation itself has already reached the server and cannot safely be treated as undone.

A capability-marked assets 403 follows a narrower sequence. In the error render, omit that
collection's cached assets immediately. Mark the kind denied for the rest of the mounted route
generation, release/discard only its special-owner and optimistic-ledger state, unmount its exact
observer, then cancel/remove only `projectDataKeys.assets(projectId, collectionKind)`. Exclude the
kind from `availableTabs`; if it was active, ask the parent to select the first still-authorized
kind—RAW for the current photographer case. If no collection remains, render the existing empty
collection treatment without exposing the denied payload. Do not stop detail/RAW/manual owners,
clear the rest of the project, or enter the full-project terminal token. Correct capability guards
in §6 should make this exceptional, but a stale observed role or server/client capability drift
must still fail at collection scope instead of locking an authorized user out of the whole project.

On a project-terminal error after previously rendering a full workspace, on any 401, or on a
`project-data-removed` marker, the terminal transition is:

1. render the private-data-free terminal branch immediately from the query error/provider marker;
2. mark that project generation terminal, increment the manual generation, abort the manual
   controller(s), clear the active-job interval, legacy AutoHDR timeout, and Dropbox-sync delay, and
   reject every late manual response at its generation guard;
3. clear parent-held `ingest`, `jobs`, `autohdrStatus`, `fallbackComments`, `isSyncing`, `isSending`,
   project-specific toasts, `openAssetId`/`lightboxOrderIds`, and other project-open UI; the next
   committed render omits the query-owning child, collaboration/checklist/collection children,
   UploadDropzone, PhotoGrid, and Lightbox;
4. only after that unmount commit, discard the affected §5 optimistic ledger/owner tokens. For a
   project-terminal error or deletion, call
   `cancelQueries({ queryKey: projectDataKeys.project(projectId) })` and then
   `removeQueries({ queryKey: projectDataKeys.project(projectId) })`. For a 401, discard **all**
   client ledger/owner state, call unkeyed `cancelQueries()`, then call `queryClient.clear()` so no
   detail or collection belonging to the revoked principal remains anywhere in the cache; and
5. keep a project access-loss token for the rest of this mounted route generation; a later route
   revisit may create a fresh generation but starts without old project cache data. A deletion
   message's project-ID tombstone and a 401 principal-terminal token instead last for the provider
   lifetime. Query functions and manual readers check the applicable token after their requests
   resolve, so a pre-terminal request cannot repopulate cache or local state.

After step 4, `getQueriesData({ queryKey: projectDataKeys.project(id) })` remains empty for a
project-terminal path because no observer for that project is mounted. After a 401,
`queryClient.getQueryCache().getAll()` remains empty for the whole provider. These are stronger
invariants than “disabled observers are inert”: no inaccessible cache entry, including an empty
recreated entry, persists in the terminal generation.

The detail/project-terminal, deletion, and 401 paths all reuse the current “Project unavailable”
presentation and safe Dashboard link; no new visual system is added. TB2 does not globally sign out
or reload the app—the existing API client has no such 401 behavior—but the provider-lifetime 401
token prevents its migrated cache from refilling under the stale session object. The typed custom
route remains in the address bar, so Back/Forward continues to behave normally. A later External
Editor phase may add its approved automatic nearest-safe navigation; TB2 does not pre-implement
that role.

An **initial** detail 403 remains different: mark that query generation terminal and unmount its
query owner, cancel/remove any partial project-data keys, then start a fresh signal-aware manual
comments-probe generation. A successful probe enters collaboration-only mode and never remounts the
detail/assets query owner or enables ingest/jobs. A failed probe enters unavailable. An initial
detail 404 enters unavailable without a comments probe; an initial 401 takes the principal-terminal
full-cache path without a probe. After detail succeeds, a capability-marked initial assets 403 takes
the collection-only path above, while a membership-style 403 or a 404 takes the project-terminal
path without probing comments.

Do not use query-level `onError` callbacks (removed from v5 `useQuery`) or leave stale `data`
rendered beside a background `error`. Tests assert DOM removal, every manual state/timer/request
owner becoming terminal at the applicable scope, late results being rejected, exact-key removal for
a collection capability failure, stable zero project entries for project loss, and a stable empty
whole cache for 401 across later terminal re-renders. A later transient error is not a permission
decision and retains last good data.

### 10. Add focused tests at the server-state seam and real consumers

Add node tests for `project-data`/`project-query-sync` and extend the existing happy-dom suites.
Use a fresh QueryClient per test with retries disabled and `gcTime: Infinity`; never share cache or
BroadcastChannel state between tests. The explicit RAW-retention/default-GC tests instead use the
production five-minute `gcTime`; an infinite test override cannot prove that boundary.

Required focused coverage:

- exact key tuples for two project IDs and all five collection kinds;
- query paths and propagation of the supplied AbortSignal;
- retry classification for abort, 0, 4xx, 408/429, 5xx, 401, 403, and 404;
- 15-second stale/5-minute GC defaults and query-specific visible 30-second intervals;
- hidden pause, focus/reconnect stale refetch, exact-resource special-owner suppression, and resume;
- an active special loop leaves an unowned resource on its ordinary 30-second bound, plus start and
  terminal/blocked transition races proving the exact owned resource has neither a polling gap nor
  a duplicate ordinary+special read;
- Project A/B detail cache isolation and A/B RAW isolation;
- same-project RAW/Edited/video/floorplan/copy separation;
- deterministic A→B and RAW→Edited late-response reversal where the old promise resolves last;
- exact invalidation only—detail never invalidates assets, RAW review/selection never invalidates
  Edited, the RAW-delete exception does, and no ordinary mutation uses a project/root prefix;
- optimistic review/selection cancellation, field-coordinate rollback, and deferred confirming
  invalidation, including (a) two different assets updated concurrently with one success/one
  failure and (b) two different fields on the same asset updated concurrently with one success/one
  failure;
- valid BroadcastChannel invalidation/removal/active-detail message publication, discriminant-
  specific validation, sender-loop suppression, exact receiver behavior, unsupported-channel
  fallback, and channel cleanup;
- deletion removal with an inactive cached project query; an open sibling tab receiving
  `project-data-removed`; and a request started before that message but resolved afterward, proving
  it cannot repopulate the removed prefix;
- the full mutation table's expected resource sets, including link-vs-document callback split and
  project deletion's removal message, RAW deletion's Edited side effect, and the bounded active-
  detail user-rename exception;
- a fixture whose Edited asset points `sourceRawAssetId` at a RAW asset that is then deleted: Edited
  invalidates/refetches and returns that field as `null`;
- successful `Admin.updateUser(user, { name })` refreshes every active project detail query within
  the same-browser bound without touching asset or inactive detail queries;
- initial RAW-first then one-time Edited default with one ordinary Edited polling observer and one
  non-polling passive RAW observer; with production `gcTime`, fake timers advance beyond five
  minutes on Edited and prove RAW compare data remains present and reacts to a subsequent exact RAW
  cache change;
- a photographer-role `syncDropbox()` runs its authorized active/RAW and ingest legs but never
  registers or fires Edited, AutoHDR-status, or jobs forced reads, and no synthetic 403 triggers a
  project purge;
- no prior-collection placeholder during a pending tab request and revisit uses only its own cache;
- background detail/asset refetch preserves active tab, PhotoGrid filter/multi-select, open
  Lightbox/current ID, comment/subtask/link drafts, and scroll;
- asset-list reorder/removal preserves Lightbox by ID or closes only when the current ID disappears;
- initial detail 403 collaboration-only probe, no probe after successful detail + asset failure,
  and late-probe cancellation on project navigation;
- a capability-marked Edited assets 403 removes only that exact key/tab and returns the user to RAW
  without stopping authorized project/manual owners; a membership-style assets 403, detail 403/404,
  and assets 404 take the full project-terminal path;
- mid-session project-terminal 403/404 immediately hides the full workspace, stops retry, aborts
  ingest/jobs/AutoHDR/fallback requests, clears all special timers/manual state, rejects deliberately
  late manual completions, unmounts query owners, and leaves zero project-scoped query entries across
  a later terminal render; a 401 from a migrated query and from a representative manual owner each
  uses the same unavailable branch but cancels and clears the **entire** QueryClient, leaving it
  empty across a later render; transient 500 retains last good data; and
- App/provider session isolation, including a session object's role changing under the same user ID
  and causing a complete old-client cache clear/remount, plus custom-router direct route,
  Back/Forward, modified click, and new-tab behavior remain intact.

From `portal/`, run focused suites before the full gate. Adjust the file list only to match the
final reviewed test owners:

```bash
npx vitest run --config apps/web/vitest.config.ts src/lib/project-data.test.ts src/lib/project-query-sync.test.ts
npx vitest run --config apps/web/vitest.dom.config.ts src/screens/ProjectWorkspace.dom.test.tsx src/App.dom.test.tsx src/components/Lightbox.dom.test.tsx
```

Tests must exercise real promise ordering/timers/query-client behavior. Static source-string
assertions alone do not satisfy the race, timing, purge, or draft-preservation criteria.

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run the repository-standard gate exactly:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Record each workspace result separately. The repository-documented workspace command does not own
the `packages/shared` suite, so the fourth command is mandatory. Any new React, query, timer,
unhandled rejection, `act`, console, dependency, bundle, or TypeScript warning is investigated and
dispositioned; no “expected race warning” is accepted.

Also run source/build audits and retain them in the gate record:

```bash
rg -n '@tanstack/react-query|QueryClient|projectDataKeys|BroadcastChannel|refetchInterval' apps/web/src package.json package-lock.json
rg -n 'setInterval|setTimeout' apps/web/src/screens/ProjectWorkspace.tsx apps/web/src/components/UploadDropzone.tsx apps/web/src/lib/project-data.ts
rg -n 'react-router|@tanstack/react-router|WebSocket|EventSource' package.json package-lock.json apps/web/src
```

The audit must prove one direct TanStack Query pin, no router/WebSocket/SSE dependency, one
ordinary 30-second interval policy, and no new five-second timer. Review the final diff against
the mutation table and use a repo-wide endpoint grep so an existing project/detail/asset mutation
is not silently omitted.

### Bundle, CSS, and dependency delta

Before implementation, build the recorded TB2 base commit and capture emitted JS/CSS raw and gzip
bytes plus total `dist`. Repeat after the final build with the same commands:

```bash
find apps/web/dist -type f -print0 | sort -z | xargs -0 wc -c
wc -c apps/web/dist/assets/*.js apps/web/dist/assets/*.css
for asset in apps/web/dist/assets/*.js apps/web/dist/assets/*.css; do
  test -f "$asset" || continue
  raw_bytes="$(wc -c < "$asset" | tr -d ' ')"
  gzip_bytes="$(gzip -9 -c "$asset" | wc -c | tr -d ' ')"
  printf '%s\t%s\t%s\n' "$asset" "$raw_bytes" "$gzip_bytes"
done
```

Save both inventories, direct-dependency/lockfile deltas, absolute/percentage JS/CSS/total deltas,
and explanation at:

`docs/plans/revamp_2026_portal/evidence/TB2/bundle-css-delta.md`

TanStack Query adds real JavaScript weight; measure it rather than calling it negligible. CSS is
expected to remain byte-identical because TB2 is visually/data-layer-only. Any CSS delta or an
unexplained second query/persistence/devtools package blocks acceptance. Confirm the production
bundle contains no Query devtools.

### Manual QA matrix

Use the built app Worker at `http://localhost:8787`, not Vite `5173`. Use two disposable
real/synthetic projects A and B with distinguishable street names and distinguishable RAW/Edited
asset filenames. Where a second principal is required, use only a reviewer-approved disposable
account/session; local Google OAuth currently admits only the seeded Admin, and there is no staging
environment, so do not manufacture a production authorization test without the owner checkpoint
in “Implementation-time open item.” Redact project/client/media data from evidence.

1. **Direct URL and route isolation.** Paste `/projects/A` into a new tab, then navigate A → B → A
   through ordinary links and Back/Forward. Cmd/Ctrl-click B into another tab. Confirm the URL,
   street, members, counts, and asset requests always match the route ID; no full-page reload or
   router behavior changes.
2. **RAW/Edited separation.** On one project, rapidly alternate RAW and Edited while Network is
   throttled. Confirm no RAW filename/tile appears under Edited controls or vice versa, each
   request carries its kind, revisiting a key may show only that key's cache, and an open Lightbox
   closes only on the intentional tab switch as it does today.
3. **Actually exercise the late race.** Keep the deterministic reversed-promise automated test
   output as primary proof. In the browser, apply Slow 3G, start A or RAW, immediately switch to B
   or Edited, and retain the request timeline showing the old request aborted or completing later.
   Confirm the later old completion cannot alter current DOM. A throttle run where requests happen
   to finish in order does not count; repeat until the timeline proves reversal/cancellation.
4. **Focus and reconnect.** Leave an active tab hidden for more than 15 seconds while another
   approved session changes a reversible detail/asset field. Return and confirm one stale refetch
   starts on visibility return. Repeat by taking the observing tab offline, changing the resource,
   then restoring connectivity. Confirm no hidden ordinary polling requests occur while hidden.
5. **Visible bounded poll/cross-session.** Keep the observing tab visible but untouched in a
   separate browser/profile session. Make one reversible external change immediately after an
   observed poll. Record commit time, next request start, and visible update; all must occur within
   30 seconds plus normal request latency, with no ordinary requests faster than the configured
   interval.
6. **Same-browser BroadcastChannel.** Open the same project in two same-session tabs. Perform a
   reversible review/selection/cover/detail change in tab A. Tab B must start only the exact
   affected active query within two seconds, update without reload, and not request the unrelated
   detail/collection key. Repeat detail-only and RAW-only examples.
7. **Special polling ownership.** With a disposable manual upload or existing safe synthetic job,
   show the existing five-second publication/job lifecycle still terminates correctly, ordinary
   30-second polling is suppressed only for its exact owned resource, an unowned active collection
   keeps its normal cadence, and exactly one five-second loop—not two—appears in Network/timer
   evidence through both the start and terminal transition. Do not trigger a real paid/ambiguous
   AutoHDR send solely for QA.
8. **Draft/interaction preservation.** On a long project, select multiple PhotoGrid tiles, choose a
   non-default filter, scroll the window, open collaboration, type an unsent comment, open the
   subtask composer with title/due/assignee, and (on a delivery tab) type a link draft. Trigger an
   external detail/active-assets refresh. Confirm exact text/selection/filter/tab/popovers and
   numeric scroll offsets remain. Cancel drafts afterward; do not submit test content.
9. **Lightbox preservation.** Open a middle asset, open the review panel, enter an unsaved
   annotation note/drawing, set zoom, and record panel scroll. Trigger a non-destructive asset
   refetch/update from another tab. Confirm the same asset ID/index, draft, zoom, panel, and scroll
   survive. Separately, remove the current asset only in a disposable fixture and confirm the
   viewer closes safely; removing another earlier asset must keep the same current asset ID.
10. **Access removal.** Start with a disposable non-admin principal authorized for a disposable
    project, render detail/assets, then have an authorized reviewer remove that membership. Within
    the focus/poll bound, confirm rail/client/member data, thumbnails, Lightbox, collaboration
    overlay, and counts disappear; the query returns a membership-style 403/404 once with no
    retries; the unavailable/safe link appears; ingest/jobs/AutoHDR requests and timers stop;
    Back/Forward still works; and revisiting does not resurrect cached private content. Separately,
    deactivate a reviewer-approved disposable principal: the first project-request 401 must reuse the
    same unavailable branch, stop all project owners, and leave the entire QueryClient—not only the
    open project's prefix—empty. Pair both paths with the automated cache-inspection assertions for
    stable zero project entries and stable zero whole-client entries after a later terminal render.
11. **Initial collaboration-only 403.** Using a safe stage-hidden photographer fixture, confirm
    the existing comments probe still renders collaboration-only and that assets, ingest, jobs,
    rail, and full workspace never request/render.
12. **Regression/passive checks.** Exercise RAW/Edited upload completion callbacks without leaving
    residue where safe; cover set/clear; a review and RAW selection reverted to original; comments
    and checklist read/draft behavior; links; Back/Forward/new-tab; console and Network. Confirm no
    visual/style change at `1440×900`, `1024×768`, and `390×844` on representative normal/loading/
    error states.

### Exact evidence paths

Create only redacted evidence under:

```text
docs/plans/revamp_2026_portal/evidence/TB2/dependency-version-check.txt
docs/plans/revamp_2026_portal/evidence/TB2/automated-gates.txt
docs/plans/revamp_2026_portal/evidence/TB2/query-contract-and-race-tests.txt
docs/plans/revamp_2026_portal/evidence/TB2/bundle-css-delta.md
docs/plans/revamp_2026_portal/evidence/TB2/manual-qa.md
docs/plans/revamp_2026_portal/evidence/TB2/direct-url-history-and-ab-isolation.md
docs/plans/revamp_2026_portal/evidence/TB2/raw-edited-late-race-network.png
docs/plans/revamp_2026_portal/evidence/TB2/focus-reconnect-poll-timing.md
docs/plans/revamp_2026_portal/evidence/TB2/broadcast-timing-and-narrow-requests.md
docs/plans/revamp_2026_portal/evidence/TB2/draft-lightbox-selection-scroll.md
docs/plans/revamp_2026_portal/evidence/TB2/access-loss-purge.md
docs/plans/revamp_2026_portal/evidence/TB2/request-cadence-redacted.har
docs/plans/revamp_2026_portal/evidence/TB2/workspace-after-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB2/workspace-after-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB2/workspace-after-390x844.png
```

`manual-qa.md` records project/account fixture disposition, exact timestamps/deltas, browser/
profile/session relationship, `visibilityState`, Network throttling/offline settings, query keys
expected, actual requests, restored mutations, console result, and any not-applicable item with
source rationale. The HAR and screenshots must be redaction-checked before commit; if a HAR cannot
be safely redacted, replace it with a timestamped request table in the named Markdown records and
record why the HAR was deliberately omitted.

Visual evidence is regression evidence, not a convergence exercise: compare against the matching
TB0/TB0A current-state views and require no material visual drift. No new prototype capture is
needed because TB2 changes the data layer, not design authority.

### Deployment

TB2 changes the web bundle/static assets and app-side frontend source only. It adds no server
route, schema, migration, binding, secret, queue, Workflow, background, or webhook-ingress
contract. After review, the full gate, local/manual timing evidence, and the QA-principal checkpoint:

1. record the active production app Worker version/deployment ID as the rollback target;
2. make one final web build and verify its hashes/sizes match the accepted evidence;
3. from `portal/workers/app`, run:

   ```bash
   npx wrangler deploy --message "TB2 route-safe project data freshness"
   ```

4. smoke direct URL, A/B navigation, RAW/Edited switching, hidden/focus, and same-browser
   invalidation in production using only designated disposable/reversible data; observe Network
   for at least one 30-second visible interval and one hidden interval; and
5. confirm zero unexpected console/API errors, request storms, private-data persistence, or visual
   drift. Restore every reversible test mutation and record the restoration.

Do not deploy background or webhook-ingress and do not apply a D1 migration. After production
verification, update this plan's status with commit/version/evidence, update `docs/todo.md`, and
move the plan with `git mv` to `docs/plans/implemented/` as repository policy requires.

### Concrete rollback

Before deploy, record the current app Worker version. If production shows route/key leakage,
private data surviving a 401 or project-/collection-scoped 403/404, draft/Lightbox loss, an ordinary
request storm, duplicate five-second polling, or a material load regression, restore that version:

```bash
npx wrangler rollback <recorded-pre-TB2-version-id> --message "Rollback TB2 route-safe data freshness" --yes
```

Repeat direct URL, RAW/Edited, access-loss-safe-state, and request-cadence smoke after rollback.
The source rollback is one ordinary revert that:

- removes `@tanstack/react-query` and its lockfile additions;
- removes `query-client.tsx`, `project-data.ts`, `project-query-sync.ts`, and their focused tests;
- restores the authenticated App tree without `QuincyQueryProvider`;
- restores `ProjectWorkspace`'s manual `data`/`assets`/`rawAssets`, abort/generation, refresh, and
  mutation paths;
- restores pre-TB2 Dashboard/EditProject/CollectionPanel/UploadDropzone mutation callbacks and
  focused tests; and
- removes only TB2 evidence/status/todo changes.

There is no schema/data rollback and no user data is deleted. Do not touch D1/R2/KV, attempt to
“clear” browser data remotely, or redeploy unchanged background/webhook Workers. A browser reload
after rollback naturally destroys the in-memory QueryClient and returns to the prior manual model.

## Acceptance checklist

- [ ] The implementation begins from recorded current `main`; TB0A/TB0B/TB1 remain live and their
      React 19.2, pipeline, Tailwind, shadcn, alias, and design contracts are unchanged.
- [ ] The live registry/peer/dependency data is rechecked; one exact stable TanStack Query v5 pin
      is added at `portal/package.json`, no duplicate web-workspace declaration or devtools/
      persistence package exists, and lockfile churn is explained.
- [ ] One `QueryClient` is stable for one authenticated principal+role scope, unmounts/clears on an
      observed session, principal, or role change, and uses the exact stale/GC/retry/focus/reconnect/
      structural-sharing policy; any observed project-request 401 clears the whole client even if
      session state has not independently refreshed.
- [ ] The typed custom router, route parsing, History API adapter, `InternalLink`, direct URLs,
      `key={route.projectId}`, Back/Forward, modified clicks, and new tabs are unchanged and pass.
- [ ] Exact keys are `project-data/projectId/detail` and
      `project-data/projectId/assets/collectionKind`; every request-changing project/kind variable
      is present and ordinary mutations never use an unkeyed/global invalidation.
- [ ] Only Project Workspace detail and collection assets (the active collection plus passive RAW
      compare observer) use TanStack Query. Dashboard, EditProject form load, Admin, stages,
      notifications, comments, checklist, links, annotations, jobs, ingest, and AutoHDR status remain
      on their verified manual owners.
- [ ] RAW-first bootstrap and one-time stage-driven Edited default remain; only one ordinary asset
      polling observer is active, while one passive subscribed RAW observer keeps compare data
      reactive and immune to five-minute GC without focus/reconnect/interval RAW polling when Edited
      is active.
- [ ] The shared-asset single-paint race is structurally eliminated: render data always comes from
      the exact active collection key, and no previous-key placeholder appears.
- [ ] Query functions consume TanStack's AbortSignal; deterministic reversed completion proves a
      late Project A/old collection response cannot overwrite Project B/current collection even if
      abort is ignored.
- [ ] Each migrated exact key polls every 30 seconds only while visible and not owned by a special
      lifecycle; unowned collections retain that bound, start/end transitions neither gap nor
      double-poll the owned key, stale focus/reconnect refetch, and hidden polling pauses.
- [ ] Existing UploadDropzone, active-job, and legacy AutoHDR five-second lifecycles are preserved;
      no new five-second timer, duplicate provider fetch path, direct retrieval, duplicate send,
      selection reset, or ambiguous paid retry exists; every forced Edited read retains
      `canViewEdited`, and every jobs/AutoHDR read retains `canAdminBackend`, before ownership.
- [ ] Every mutation in §7 maps to its exact detail/collection keys except the documented rare,
      active-detail-only Admin rename fan-out; RAW deletion also invalidates Edited, link add/remove
      do not invalidate assets, link edit/reorder has no TB2 invalidation, and no relevant mutation
      is omitted.
- [ ] Concurrent optimistic review/RAW selection uses an ordered per-key, per-asset, per-field
      ledger: a failure removes only its token, a success cannot be erased by a sibling failure or
      refetch, and one confirming exact invalidation runs after the last sibling settles.
- [ ] `quincy:project-data:v1` emits only validated, response-data-free invalidation/removal/active-
      detail messages after success; receiving tabs refetch or purge as specified within two
      seconds without rebroadcast/full reload; unsupported BroadcastChannel falls back to focus/
      polling where deletion is not already known locally.
- [ ] Active tab, PhotoGrid filter/multi-select, selection anchor, window/panel scroll, collaboration
      state, comment/subtask/link drafts, open controls, and focus survive ordinary background
      refetch.
- [ ] Lightbox remains on the same asset ID with zoom/panel/annotation drafts during ordinary
      refetch, reconciles list changes by ID, and closes only for access loss, intentional tab
      switch, or authoritative removal of its current asset.
- [ ] Initial detail 403 retains the collaboration-only probe without workspace reads. Later detail
      403/404, membership-style assets 403, and assets 404 retry zero times and take the full
      project-terminal purge; a capability-marked assets 403 removes only that collection and
      returns to an authorized tab; any project-request 401 reuses Project unavailable and clears
      the whole QueryClient. Every scope hides its affected private UI before observer removal and
      cannot resurrect late data.
- [ ] Transient 0/408/429/5xx behavior is bounded, retains last good data after initialization,
      and does not repeatedly unmount/toast or silently masquerade as permanent access loss.
- [ ] Direct URL/A-B isolation, RAW/Edited separation, reversed late response, focus/reconnect,
      visible poll, same-browser broadcast, special-loop ownership, draft preservation,
      Lightbox/list reconciliation, collaboration-only fallback, and access removal all have
      automated plus applicable manual evidence at the exact TB2 paths.
- [ ] Raw/gzip JS, CSS, total dist, dependency, absolute, and percentage deltas are recorded and
      explained; CSS is unchanged or every byte is accounted for; no Query devtools ship.
- [ ] Focused tests, typecheck, web build, every runnable workspace suite, and the dedicated shared
      suite are green with no unexplained warning or sandbox-based assumed pass.
- [ ] App-only deploy, pre-deploy rollback version, final asset hashes, production cadence/smoke,
      reversible fixture restoration, and any owner risk disposition are recorded; no migration or
      background/webhook deploy occurs.
- [ ] After production verification, the status/todo are updated and this plan is moved with
      `git mv` to `docs/plans/implemented/` with its live commit and Worker version.

## Opus final-approval notes for the builder (non-blocking)

The plan review pipeline concluded APPROVE after 2 Sol draft-review rounds and 2 Opus tier-2 rounds
(2026-08-26). The approving Opus review flagged five small clarifications that did not justify a
further revision round but are worth the builder's attention:

1. **§9's query-owning child description vs. §4 item 6's passive-RAW placement.** §9 says the
   child renders the body "from its own detail, active-assets, and passive-RAW hook results," which
   read literally could mount the passive RAW observer on the RAW branch itself. §4 item 6 is the
   operative structure: the passive RAW hook belongs in a conditionally-rendered *non-RAW* body
   descendant (mounted only while Edited/another kind is active). Implement two body variants under
   the query owner accordingly — §4 item 6 governs over §9's looser wording.
2. **§4's "the child reports only generation-tagged query bootstrap readiness."** Read in context
   with §9, this excludes query *payloads* from what crosses the parent/child boundary, not the
   access-error *classification*. The child must report both bootstrap readiness and the
   project-terminal-vs-collection-scoped error classification from §9's 403/404/401 handling.
3. **§9's "any still-manual project request" 401 handling has two real exceptions.**
   `updateSelection`'s DELETE and `deleteProject()` use raw `fetch` and discard status today, so
   they cannot themselves surface an `ApiError` 401 — convergence for those two specific call sites
   happens via the next poll's 401 on a migrated query, not directly. Every other enumerated manual
   read owner uses `apiGet` and is unaffected.
4. **§6's `refetchIntervalInBackground: false`.** In TanStack Query v5, a hidden tab's interval
   timer still technically fires internally; this option suppresses the resulting *fetch*, not the
   timer. Observable behavior (zero network requests while hidden) matches what the plan's tests
   and QA assert — no change needed, just don't be surprised if a timer-inspection test sees the
   interval "running" while network stays quiet.
5. **§5's ledger field composition must handle `review: null`.** The existing `emptyReview()`
   helper in `ProjectWorkspace.tsx` already produces the correct default shape — reuse it rather
   than re-deriving a null-safe review object.

## Implementation-time open item

1. **Resolved 2026-08-26.** The owner provisioned a disposable QA account
   (`tsseotsseo@gmail.com`, `Photographer` role, active) via the Admin → Users "Provision user"
   form in local dev, specifically for this plan's cross-session polling, broadcast, and
   access-removal manual QA. The account is registered and can sign in with Google, but has not
   been signed into by any agent — per this session's standing rule, only the human signs into a
   newly provisioned account. The reviewer/owner should sign in as this account when the manual QA
   matrix's cross-session steps are reached. If production-side QA also needs a second session,
   the same account must be separately provisioned in production (not yet done as of this writing)
   via the same Admin UI flow before that step.
