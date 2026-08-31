> **Status:** DEPLOYED TO PRODUCTION 2026-08-31. Branch `tb6-project-card-detail` off `main` @
> `6b8a5e0`, merged to `main`. Migration `0038` (additive index on `project_activity_events`)
> applied to prod D1; pre-migration recovery export
> `../db-recovery/quincy-portal-pre-0038-20260831T135320Z.sql`. App Worker version
> **`6f7a22b2-4c0a-40a3-b765-2bdb209762eb`** deployed from `portal/workers/app`; background/
> webhook-ingress NOT redeployed (bundle comparison: webhook byte-identical, background's diff
> traced to inert shared-barrel additions + one provably-no-op UUID-validation tightening — see
> `docs/plans/tb6/build-handoff.md` §2 item 9 area). Rollback target: app Worker version
> `10778f00-2884-48b9-b7ae-997343fed60a` (the prior live version, TB5C + Kanban divider fix).
> Built in 6 slices (0-5) per `docs/Subagent-Orchestration.md`: each slice individually Sol-reviewed
> and §5-gated; 2 scoped whole-branch Sol passes (Pass A 1 Blocking fixed, Pass B 3 Blocking + 6
> Should-fix fixed — the highest defect count of any TB6 review round, all real cross-slice issues);
> Opus final-draft review APPROVE (1 non-blocking follow-up, documented in build-handoff.md);
> Agy 7-item local-dev QA matrix PASS; post-deploy passive production verification PASS (0 console
> errors, 0 failed network requests across Overview/Activity/Discussion on real project data).
> Plan history: Sol draft → fresh-Sol review round 1 (5B+5SF, REVISE) → revision 1 → round-2
> confirmation folded by the orchestrating session (Codex credits exhausted mid-round) → Opus
> plan-tier REVERT #1 (7B+8SF+3N) → Sol revision 2 → Opus re-review APPROVE WITH FOLLOW-UPS (S1
> security-manifest class = `scoped-child-resource`; S2 ledger deferred-publish preserved; S3
> post-settle refetch stays with the shipped queued-refresh path).

# Revamp TB6 — Project-Card Detail and Shared Discussion

## Recommendation: one tracer bullet, one deploy

Build TB6 as one coherent tracer bullet made of six independently reviewed slices, with no
production deploy between slices. The acceptance boundary is one URL-addressable Dashboard sheet
whose Overview, Activity, and Discussion share one visibility/freshness boundary while preserving
the explicit per-view authorization matrix (Discussion is deliberately narrower), strict
projection, and shipped discussion contracts. Splitting the endpoint, URL, or rendered shell into
separate production releases would create reachable partial states without proving the cross-
surface consistency that is TB6's primary outcome.

The activity read path does require one additive migration: `0038` adds only the composite index
needed to keep project-scoped cursor reads bounded. It creates no table, column, or domain state.
The migration may exist harmlessly before the app release, but the app/UI release remains one
checkpoint.

Before implementation, run the repository review pipeline on this plan in order: fresh-Sol plan
review, revision, second fresh-Sol confirmation, then Opus plan-tier review and resolution. Build
only from the accepted plan.

## Purpose and outcomes

Authorized users can inspect a project without leaving the Dashboard context that opened it:

- Open a project quick detail from Dashboard List, Kanban, or Calendar.
- Preserve the originating Dashboard view and Calendar URL state across refresh, copied links,
  OAuth return, native new-tab navigation, Back, and Forward.
- Present the quick detail as a modal side sheet on desktop and a modal full-screen surface on a
  phone, with a clear link to the distinct full Project Workspace route
  `/projects/:projectId`.
- Keep three separate views: **Overview**, **Activity**, and **Discussion**. Activity is an
  immutable structured event feed. Discussion is the existing project comment stream and unread
  state. They are never interleaved into one timeline.
- Give Admin and internal Editor their approved internal projection. Give an External Editor the
  TB4E external-safe projection only for a current Editor assignment on a non-archived project.
  Hidden event types, fields, payloads, and actor identity are removed on the server.
- Reuse TB2 query ownership/access-loss cleanup, TB3 comments/read markers, TB4C immutable activity,
  TB4E external projection, TB5A Board state, and TB5C Calendar state. No new mutation is introduced;
  only the existing Discussion create/edit/delete operations write from this sheet.

## Authority and dependency boundary

Conflict order for implementation and review is:

1. `docs/plans/revamp_2026_portal/roadmap/TB6-Project-Card-Detail-And-Discussion.md`.
2. `docs/Decision-Sheet.md` D-16 through D-19.
3. `docs/Implementation-Plan.md` A9, A10, A11, A13, and A14.
4. `docs/PRD.md`, `docs/Personas.md`, and `docs/Sitemap.md`.
5. Live state in `docs/todo.md`.
6. Operational lessons in `docs/lessons.md`.

TB6 follows the structural precedents in the implemented TB5C Calendar plan, TB3 Discussion v2
plan, and TB4C project-activity plan. In particular, it preserves the closed staff-route grammar,
server-owned comment read state, immutable registry-validated activity rows, role-scoped strict
DTOs, and terminal access-loss purges.

## Verified current-main facts

- `main` is `6b8a5e0`; TB0 through TB5C and the two Kanban hotfixes are deployed. Production app
  Worker version is `10778f00`. There is no staging environment.
- D1 ends at migration `0037`; `0038` is free.
- `/projects/:projectId` is already the full Project Workspace. Its only accepted query is exactly
  `?collaboration=open`.
- `portal/packages/shared/src/staff-routes.ts` is a closed parser/serializer boundary. It rejects
  unknown, duplicate, malformed, encoded-static, unsafe-control, backslash, hash, non-canonical UUID,
  and trailing-slash staff locations; `safeStaffDestination` also owns OAuth return safety.
- Dashboard List and Kanban are currently remembered client views. Calendar alone has a closed,
  canonical query grammar. `Dashboard.tsx` owns all three views and remains mounted while its URL
  state changes.
- Dashboard project data is authorization-scoped by
  `dashboardProjectsKey(principalId, role, authorizationEpoch, archived)`.
- `projectDataKeys` already owns detail, assets, subtasks, comments, comment read marker, and
  collaboration summary. `ProjectQueryRuntime` already carries project-data, Dashboard Board, and
  Production Calendar invalidations over one `BroadcastChannel`.
- `PrincipalFreshnessBoundary` already removes a lost project from the principal's Dashboard and
  Calendar caches, tombstones its `project-data` family, and redirects project paths.
- TB3 comments are one newest-first cursor stream over `project_comments`, with
  `project_comment_read_markers` as the server-owned per-user high-water mark. Existing author-only
  edit/delete remains unchanged; Admin is not exempt except while intentionally impersonating the
  author.
- `ProjectCollaborationPanel` currently combines `SubtaskChecklist` and the project discussion.
  TB6 must extract/reuse the discussion portion; rendering the existing standalone panel verbatim
  would incorrectly pull checklist work into the Discussion view.
- `project_activity_events` is the immutable TB4C store. The shared registry contains live and
  reserved types, safe payload parsers, categories, renderers, deep links, and the external policy.
  There is no per-project GET/feed endpoint.
- `project_activity_events` has only its primary key and `(event_type, source_key)` unique index.
  It has no index supporting `project_id` plus newest-first cursor order.
- TB4E already gives External Editors strict project detail, discussion, read-marker, and Calendar
  DTOs through `EXTERNAL_API_RESPONSE_SCHEMAS`, `visibleProjectWhere`,
  `resolveVisibleProject`, `EXTERNAL_PROJECT_ACTIVITY_POLICY`, and the shared external projection
  regression gate.
- The existing Stage writers publish Dashboard and project-detail invalidations, while Calendar
  deadline/checklist writers publish Calendar plus project-resource invalidations. These call sites
  are close but not yet a complete Overview/Activity/Board/Calendar coherence matrix.

## Scope

### In scope

- A canonical Dashboard quick-detail URL for List, Kanban, and Calendar context.
- Plain-anchor project affordances in all three views so modified click, keyboard activation, and
  `target=_blank` retain native browser behavior.
- A routed modal sheet shell with Overview, Activity, and Discussion views.
- One project-scoped activity read endpoint, strict internal and External response schemas, query
  family, cursor pagination, safe server rendering, and a supporting index.
- Presentation-safe composition of existing project detail/member/deadline data.
- Reuse of the existing comment stream, unread coordinator, mentions, and author-only mutations.
- Whole-project terminal purge, late-response suppression, and route close on membership/role loss;
  the matrix-defined Discussion-only 403 is explicitly non-terminal.
- A source-mutation invalidation matrix using the existing project-data, Dashboard Board, and
  Production Calendar message types.
- Matched D-16 visual evidence at 1440x900, 1024x768, and 390x844.

### Hard non-goals

- No `kanban_card` table or generic card/board product.
- No duplicate project, team, deadline, reminder, activity, comment, read-state, or Calendar-detail
  store.
- No Calendar-specific detail state or endpoint.
- No replacement for the full Project Workspace.
- No combined Activity/Discussion timeline.
- No activity mutation, deletion, acknowledgement, or separate activity-read marker.
- No new team, reminder, or discussion mutation capability.
- No category filter, search, date range, or arbitrary sort on the initial Activity feed.
- No source mutation redesign beyond the narrow invalidation calls required to make already
  committed writes converge across shipped surfaces.
- No prototype changes and no source copying from `prototype/`.

## Resolved design decisions

### D1 — URL shape: Dashboard query facet

Choose option (a): quick detail is a query facet layered onto the current Dashboard location. It is
distinct from `/projects/:projectId`, preserves the Dashboard behind it, composes with Calendar's
existing query state, and makes each card/event a real anchor usable in a new tab. It also keeps
OAuth return validation inside the one closed staff-route grammar.

Add shared route vocabulary equivalent to:

```ts
export const DASHBOARD_QUICK_DETAIL_VIEWS = ["overview", "activity", "discussion"] as const;
export type DashboardQuickDetail = {
  projectId: string;
  view: (typeof DASHBOARD_QUICK_DETAIL_VIEWS)[number];
};

export type DashboardListKanbanRoute = {
  kind: "dashboard";
  dashboardView: "list" | "kanban";
  detail?: DashboardQuickDetail;
};

export type DashboardCalendarFacetRoute = {
  kind: "dashboard";
  calendar: DashboardCalendarState;
  detail?: DashboardQuickDetail;
};

export type DashboardRoute =
  | { kind: "dashboard" }
  | DashboardListKanbanRoute
  | DashboardCalendarFacetRoute;
```

Do not reuse the current exported name `DashboardCalendarRoute`, whose `main` shape is
`{ kind: "dashboard"; calendar?: DashboardCalendarState }`. Replace that broad legacy alias with
the discriminated `DashboardRoute` above and use the new required-arm name
`DashboardCalendarFacetRoute`. Update both known consumers: in
`apps/web/src/screens/dashboard-helpers.ts` (`initializeDashboardCalendarState`, currently lines
139/143), read Calendar state only after `route.kind === "dashboard" && "calendar" in route`; in
`apps/web/src/lib/production-calendar-query.ts` (currently line 66), make the serializer input
satisfy `DashboardCalendarFacetRoute`. Audit and update every other direct optional-property access
for the new union as part of the same change—at minimum `staffPathFor` in `staff-routes.ts`,
`App.tsx`, `Dashboard.tsx`, and `Dashboard-calendar.dom.test.tsx` must narrow with `"calendar" in
route` (and `"dashboardView" in route` / `"detail" in route` where relevant). This keeps consumers
type-safe when the other Dashboard arms do not have those properties.

`StaffRoute` uses `DashboardRoute` as its Dashboard arm. Canonical URLs are:

```text
/?view=kanban&detail=<uuid>
/?view=list&detail=<uuid>&detailView=activity
/?view=calendar&date=...&sub=...&layers=...&detail=<uuid>&detailView=discussion
```

`detailView=overview` is omitted canonically; absence means Overview. An explicit
`detailView=overview` is rejected rather than accepted and normalized. `detailView` without
`detail` is invalid. A quick-detail URL always includes one of `view=kanban|list|calendar`, so
refresh and a new tab never infer the backing view from localStorage. Bare `/` retains today's
remembered List/Kanban fallback only until the user selects a view. Canonical `/?view=list` and
`/?view=kanban` are accepted and promoted to the URL-owned forms so a direct-linked sheet can close
without losing its explicit context.

Extend `parseStaffLocation`, the Dashboard query parser, canonical duplicate checks, and
`staffPathFor`. Keep `parseStaffPathname` unchanged: quick detail is not a new path. The grammar has
**per-arm allow-lists**, never one widened Dashboard list: the List/Kanban arm accepts exactly
`{ view, detail, detailView }`; the Calendar arm accepts the existing 12 names
`{ view, date, sub, layers, editors, unassigned, stages, completed, delivered, overdue, mine, q }`
plus `{ detail, detailView }`. A parameter legal in one arm is unknown in the other. Hoist
`hasMalformedQueryEncoding` and the
`PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES` encoded-byte bound (8192) into a shared
Dashboard-query preamble that runs before arm dispatch, so List/Kanban inputs receive the same
malformed/bounded treatment Calendar receives on `main`. Apply `unsafeText` to every decoded name
and value and `stripUnsafeText` on serialization. Dashboard-query parsing runs before
`parseStaffLocation`'s existing Calendar-only fallback; query-bearing non-Dashboard paths and every
other non-Dashboard query location continue to fail closed.
Prove `staffPathFor(route) -> parseStaffLocation(location) -> staffPathFor(route)` is a fixed point,
and prove `safeStaffDestination` and the OAuth callback preserve every canonical quick-detail URL.
Unknown params, duplicate params, malformed escapes, hashes, upper-case/noncanonical UUIDs,
encoded controls, backslashes, and invalid view/detail combinations fail closed.

Quick detail is capability-gated as well as syntactically valid. Add one new shared capability
`viewQuickDetail` to `packages/shared/src/capabilities.ts`: `CAPABILITIES`, `ROLE_CAPABILITIES`
for `admin` and `editor`, and `EXTERNAL_EDITOR_CAPABILITIES` (its list length goes 11 → 12).
Photographer does not receive it. `docs/Implementation-Plan.md` A14 states the External allow-list as
a closed enumeration "plus `moveProjectStage` when TB5A ships and `viewProductionCalendar` when TB5C
ships"; A14's own first paragraph names "quick-detail" among External-reachable surfaces, so TB6 adds
the third such conditional entry — the enumeration is amended, not contradicted. Because
`ROLE_CAPABILITIES.external_editor` **is** `EXTERNAL_EDITOR_CAPABILITIES`, that single edit makes
`roleHasCapability("external_editor", "viewQuickDetail")` true; no separate external gate is needed. This mirrors exactly how TB5C added `viewProductionCalendar`, and
it is the single source of truth for both the `App.tsx` route guard and the endpoint 403. **Known
ripple:** `externalMeResponseSchema` is derived from `EXTERNAL_EDITOR_CAPABILITIES` and needs no
manual edit. Update the only known hardcoded expectation in
`packages/shared/test/capabilities.test.ts` (the exact 11-entry array and length 11 → 12), plus any
worker-app `/me` fixture that hardcodes the returned list, then rerun the External-projection
regression gate. Admin, internal Editor, and
External Editor may consume the facet subject to project visibility. Photographer List, Kanban,
Calendar, and Workspace affordances retain their existing `/projects/:projectId` destinations and
render no quick-detail action. `App.tsx` gates on `roleHasCapability(user.role, "viewQuickDetail")`
and strips a Photographer (or any non-holder) quick-detail facet to its backing Dashboard route
before any sheet query mounts, including direct entry, OAuth restoration, and Back/Forward — the
same shape as the shipped `calendarBlocked` guard; this route denial is not project access loss and
must not tombstone or purge the Photographer's valid Dashboard/Workspace caches.

Rejected alternatives:

- `/projects/:id/detail` or `/projects/:id/card` would require reconstructing Dashboard and Calendar
  context behind a project path, complicate safe return destinations, and blur route ownership.
- Reusing `/projects/:id` with a mode flag conflicts with that route's existing Workspace identity
  and the brief's explicit link from quick detail to the full Workspace.

### D2 — URL ownership: sibling facet, view-owned base state

The selected Dashboard view owns its base state; `detail` is a sibling facet on each Dashboard route
arm. Calendar continues to own `date`, `sub`, layers, filters, and search. List/Kanban own only their
explicit `view` value while detail is open or directly addressed. The sheet never owns or mirrors
Calendar state and no Calendar detail store exists. The converse is equally binding: **every
Dashboard URL writer preserves the sibling facet it does not own**. A Calendar writer must carry
the current parsed `detail` and `detailView` unchanged; a sheet/tab/open/close writer must carry the
complete current Calendar state unchanged. Every rebuilt destination must continue to satisfy
`safeStaffDestination(built) === built`.

Opening a card/event pushes one canonical URL. Selecting Overview/Activity/Discussion replaces the
current entry so Back closes the sheet instead of walking tab history; copied links still preserve
the selected view. A plain close button or Escape uses Back only when this document recorded a
same-origin Dashboard opener for the current sheet entry; on refresh/direct/new-tab it replaces to
the same canonical Dashboard URL with `detail`/`detailView` removed. Browser Back/Forward remains
the source of truth and never triggers a compensating push.

List/Kanban selection has an explicit transition contract. Selecting the already-addressed view is
a no-op. Selecting the sibling view pushes `/?view=list` or `/?view=kanban`; after a direct-link
close those base URLs remain URL-owned and never collapse to bare `/` plus localStorage. From bare
`/`, the first List/Kanban selection pushes its canonical explicit URL. Back across a List/Kanban
selection restores the prior explicit view (or bare remembered fallback), Back from a same-document
sheet opener closes the sheet, and Forward reapplies exactly the entry that Back removed.
**Slice 4 owns this Dashboard view↔URL transition**, together with sheet activation and anchor work.
It rewires `Dashboard.tsx`'s `view` initialization/reconciliation, `initializeDashboardView`,
`lastNonCalendarViewRef`, the `quincy:dashboard:view` localStorage write, and
`calendarFallbackLocationRef`: explicit `dashboardView` owns rendered List/Kanban state and history,
while bare `/` alone may use the remembered fallback. During Slice 1, before Dashboard consumes
`dashboardView`, `App.tsx` temporarily replaces every parsed List/Kanban explicit route—including a
quick-detail form—to bare `/`; a Calendar quick-detail route replaces to the same Calendar route
minus `detail`/`detailView`. Thus Slice 1 never leaves a URL-owned List/Kanban value visible while
the Dashboard still renders localStorage-owned state. Slice 4 removes this temporary handoff and
activates the canonical explicit base URLs.

### D3 — tracer-bullet shape: one bullet

Use one tracer bullet. TB6 has one acceptance checkpoint, no independent mutation domain, and a
single privacy/freshness boundary across its three views. The slices below are green commits and
review boundaries, not partial releases. No unrelated acceptance checkpoint is hidden in TB6; the
activity index is support for the same feed rather than a separate product capability.

### D4 — activity endpoint: bounded newest-first projection

Add `portal/workers/app/src/routes/project-activity.ts` and mount both exact forms:

```text
GET /api/projects/:projectId/activity
GET /api/projects/:projectId/activity/
```

Both forms use the same terminal handler. Do not use `router.use("*", ...)` on the router mounted
at `/`. If middleware is added, scope both exact paths explicitly. Register both route forms in the
security manifest and add a new External surface name such as `activity`.

Request grammar is strict: optional `limit` defaults to 30 and is capped at 50. The optional opaque
`before` cursor is unpadded base64url of the UTF-8 bytes of the canonical JSON object
`{"occurredAt":<safe-integer epoch milliseconds>,"id":"<lowercase canonical UUID>"}`. Its decoded
object has exactly those two keys in that order, the encoded value is at most 512 bytes, and the
decoded UTF-8 is at most 256 bytes. Decode, strict-parse, reserialize, and re-encode; reject padding,
standard-base64 alphabet, invalid UTF-8, alternative encodings/key order, extra/missing keys,
non-safe or negative epoch milliseconds, upper-case/noncanonical UUIDs, and any value whose
re-encoding is not byte-for-byte identical. Reject unknown or duplicate query parameters. Order by
`occurred_at DESC, id DESC`, apply the tuple cursor, fetch `limit + 1`, and return `nextCursor` only
when another row exists. Workers' `btoa`/`atob` emit/accept standard **padded** base64, so implement
the base64url alphabet conversion and padding removal/restoration manually. The shipped comment
cursor in `routes/project-comments.ts` uses padded standard base64; the Activity and comment cursor
grammars deliberately differ. There is no category filter in TB6; the finite tabs already separate
the two user concepts and a filter would add URL/query identity without an accepted outcome.

Authorization uses one buildable two-step shape, not Collaboration-only fallback. Authenticate
first; reject any principal lacking `viewQuickDetail` with 403 before project resolution (this
denies Photographer without inferring anything from `collaborateOnProject`); then resolve project
visibility once with the single role-agnostic call
`resolveVisibleProject(c.env, c.get("user"), projectId)` for **all** roles; then execute exactly one
indexed Activity statement. The resolver already encodes both accepted rules: `viewAllProjects`
gives Admin/internal Editor archive-inclusive visibility, while External Editor requires a current
`editor` assignment and `archived_at IS NULL`. A zero-row result becomes the same generic 404 for
invisible and nonexistent projects. Keep the role split only for the response statement/shape and,
for External, the finite event-type predicate below. Both Activity forms enter
`PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED` as
`{ method: "GET", path: "/api/projects/:projectId/activity", class: "scoped", externalSurface: "activity" }`
plus the trailing-slash form. `securityClassForSeed` (`terminal-route.ts`) then **derives** the class
`scoped-child-resource` — the same class the sibling `/comments`, `/subtasks`, `/links` routes get;
do **not** edit `securityClassForSeed` or widen its `scoped-project` whitelist (both classes resolve
to the identical `{ scope: "assigned-project", projection: "external-safe", response: "scoped" }`
contract). The capability 403 occurs inside the terminal handler, not through `requireCapability`
middleware.

Create strict internal and External feed schemas in the shared activity/projection modules. The
response wrapper is exactly `{ items: ProjectActivityFeedItem[], nextCursor: string | null }` with
no unknown keys. Every `occurredAt` is the safe-integer epoch-millisecond value exposed by Drizzle
from SQL `occurred_at`; no ISO conversion occurs. An internal item has exactly `id`, `type`,
`category`, `occurredAt`, `presentation: { title, body }`, and `actor: { id, name } | null`; a system
event has `actor: null`. An External item has exactly the first five keys and omits `actor` entirely.
Return only these presentation DTOs, never raw `safe_payload_json`, source keys, DB deep-link paths,
or arbitrary payload objects. Actor rows are joined through `project_activity_events.actor_id` only
for the internal statement; External uses the existing generic external-safe copy boundary.

For External Editor, construct the SQL event-type allow-list from live entries whose
`EXTERNAL_PROJECT_ACTIVITY_POLICY` decision is `allowed` and put that finite predicate in the
Activity statement's `WHERE`, before tuple ordering and `LIMIT + 1`; privacy filtering is never
post-page. Then run every row through
`parseProjectActivityRow`, `projectExternalActivityPayload`, and the strict External response
schema. This server-side predicate omits, before pagination and serialization:

- `project.priority.changed` (`priority_withheld`);
- `project.archived` and `project.restored`;
- any unknown or reserved type;
- every provider/diagnostic or otherwise suppressed future type.

Allowed types still return only generic safe copy. Comment events remain Activity metadata, not
comment content; Discussion remains the only place comments are rendered. `project.details.changed`
returns no changed values. Invalid registry rows fail closed and emit an operational error; they are
not loosely serialized. Cursor progress is based on fetched rows, not surviving DTOs: after fetching
`limit + 1`, presence of raw row `rows[limit]` establishes another page, and `nextCursor` is derived
from the `limit`-th fetched row (`rows[limit - 1]`) even if that row or later page rows fail
`parseProjectActivityRow`. Never derive it from the last surviving item, which could truncate the
feed behind an invalid trailing row.

Project visibility is resolved exactly once through `resolveVisibleProject` for every role, never
re-derived inside the feed query. The following one Activity statement uses the resolved project ID
and the role-selected internal or External shape; the External statement carries the allow-list
predicate described above. Do not duplicate `visibleProjectWhere` into the feed query, do not use
`LIKE`/`GLOB`, and record `EXPLAIN QUERY PLAN` proving the new index is used. A generated repository
audit must also prove that the External SQL allow-list is exactly the **19** registry types where
`cutover === "live" && decision === "allowed"`; filtering on `decision === "allowed"` alone is
wrong because all four reserved `project.workflow.*` entries are already policy-allowed.

### D5 — Overview source: existing detail projection

Use `useProjectDetailQuery(projectId, ...)` as the authoritative Overview source. It already
branches to `externalApiGet("project-detail", ...)` and strict TB4E conversion for External Editor,
and it already contains members and the server-owned Deadline/reminder schedule. Extend the web
`ProjectDetail` transport typing narrowly for fields already returned by the internal detail route
that Overview needs (notably `priority` and `timeWindow`); do not widen the External schema with
priority.

Compose the rendered Overview through a small presentation selector that emits only:

- address and safe project summary;
- role-presented Stage;
- internal Priority when present;
- role-safe team rows;
- Deadline state, next reminder/due-now summary, and reminder offsets already present in the
  deadline DTO.

The Dashboard list row or Calendar event may seed a non-authoritative title/skeleton while opening,
but it never satisfies or overwrites the detail query. Direct links work from a cold cache.
`collaboration-summary` remains owned by Collaboration/Workspace consumers and is not fetched merely
to build Overview. No new overview endpoint or store is justified.

Because A14's External allow-list does not include project Priority and the External summary schema
already omits it, External Overview omits the Priority row rather than sending it and hiding a
control. Internal Priority remains visible. This role distinction is settled and enforced by the
strict projection tests.

Overview, Activity, and Discussion deliberately have different authorization gates. This matrix is
the per-view contract; “member” means a current `project_members` row for that principal:

| Principal/project state | Overview | Activity | Discussion |
|---|---|---|---|
| Admin | 200 via `hasProjectAccess` / `resolveVisibleProject` | 200 via `viewQuickDetail` + `resolveVisibleProject` | 200 via admin short-circuit in `hasProjectCollaborationAccess` |
| Internal Editor, member | 200 via `resolveVisibleProject` (`viewAllProjects`) | 200 via `viewQuickDetail` + `resolveVisibleProject` | 200 via explicit membership |
| Internal Editor, non-member | 200 via `resolveVisibleProject` (`viewAllProjects`) | 200 via `viewQuickDetail` + `resolveVisibleProject` | 403 from collaboration gate; render per-view denial |
| External Editor, assigned active project | 200 strict External detail | 200 strict External Activity | 200 strict External comments/read state |
| External Editor, unassigned or archived project | generic 404 | generic 404 | generic 404; sheet cannot be reached from another view |

An internal Editor's Discussion 403 is a **non-terminal per-view state**. It must not purge Overview
or Activity, tombstone/remove the project, close the sheet, or strip the `detail` facet. The
Discussion tab renders an explicit “No discussion access” empty state and no composer, while the
other authorized tabs remain usable. Its error handling must not pass this expected 403 into the
existing collaboration purge path; 401 and true project disappearance remain terminal under their
normal classifications.

“Collaboration-only fallback semantics remain distinct from normal External Editor assigned-project
access” means exactly this: `collaborateOnProject` / `hasProjectCollaborationAccess` is never a
second, looser path by which an External Editor—or any principal—reaches Overview or Activity, and
it never widens visibility beyond `resolveVisibleProject`. Only Discussion uses the narrower
collaboration contract.

### D6 — sheet/workspace/board/calendar cache coherence

Add only `activity(projectId)` to `projectDataKeys`, plus `activity` to `ProjectDataResource`,
`projectResourceKey`, purge, terminal classification, and query-runtime tests. Do **not** re-home
`CollectionPanel`'s video-link fetch into `projectDataKeys` — that exceeds the non-goal "no source
mutation redesign beyond the narrow invalidation calls" and risks regressing the shipped
optimistic reorder/drag/409 handling. `CollectionPanel` keeps its existing `loadLinks`/`useState`
load path untouched. TB6's only *addition* for the four `project.collection.video_link_*` producers
is an `activity` invalidation (video links are not in the project-detail DTO or the TB6 Overview);
it does **not** remove the existing detail invalidation that `addLink`/`removeLink` already do via
`ProjectWorkspace#onLinksChanged` (`saveEdit`/`reorderLinks` do no project-data invalidation on
`main` today — see `docs/plans/tb6/slice-0-inventory.md`). Continue using the
existing `project-data-invalidated` message for `activity`; do not add a new BroadcastChannel
message type.

Deepen the existing `ProjectQueryRuntime` seam rather than adding a parallel channel. Promote its
private cross-tab-only `invalidateOrDefer` behavior to one public owner-aware primitive,
`requestInvalidation(queryKey)`: deduplicate by serialized exact key; if `acquireOwner(queryKey)` or
an asset/membership ledger owns the key, accumulate one deferred marker; otherwise invalidate the
exact active query immediately. Both local senders and `receive()` must cross this same primitive.
`invalidateProjectResources` must call it rather than calling `queryClient.invalidateQueries`
directly. Its higher-level coordinator interface is:

```ts
invalidateProjectSurfaces({
  projectId,
  resources: ["detail", "activity", ...],
  dashboard: boolean,
  calendar: boolean,
})
```

The coordinator deduplicates project resources and surface flags for one committed operation,
requests same-tab invalidation through `requestInvalidation`, then publishes at most one
`project-data-invalidated`, one `dashboard-board-invalidated`, and one
`production-calendar-invalidated`. A remote tab parses the message, derives only the exact active
keys in that tab's current principal/role/authorization-epoch scope, calls `requestInvalidation` for
those keys, and never rebroadcasts. Deferred accumulation is a `Map<serializedKey, QueryKey>`; the
final owner/ledger release removes the one marker and performs exactly one active refetch. A local
authoritative cache patch does not waive the queued Activity or sibling-surface invalidation.

**Deferred-publish semantics are preserved, not changed.** On `main`, when an asset/membership
ledger is pending, `invalidateProjectResources` routes the whole operation through
`queueLedgerInvalidation`, which also defers the cross-tab publish (`project-data.ts` —
`state.queuedPublish ||= publish`). The TB6 coordinator must keep that: for a resource whose ledger
is pending, both the local invalidation AND the `project-data-invalidated` publish for that resource
stay deferred through `queueLedgerInvalidation` and fire together on ledger release — the coordinator
does not publish an otherwise-withheld message immediately. Only non-ledger-pending resources publish
at commit time. Slice 0 characterizes today's `queuedPublish` behavior alongside the owner cases;
Slice 3 diffs it.

This promotion is an intentional behavior change, not merely exposure of shipped behavior. On
`main`, owner-aware `invalidateOrDefer` is reached only by cross-tab `receive()`; local
`invalidateProjectResources` ignores `runtime.isOwned(key)` and defers only the shipped asset/detail/
collaboration-summary ledgers. Routing local senders through `requestInvalidation` extends owner
deferral to local senders for the first time. In particular it newly gates local `subtasks`
invalidations while `SubtaskChecklist` owns that key during drag/schedule-popover work, and local
`detail` invalidations while `ProjectDeadlineControl` owns that key during deadline editing.

Bridge interaction barriers into the ownership interface with an explicit shipped/new distinction:

- Workspace detail/assets continue through their special owners and membership/asset ledgers.
  `CollectionPanel` is unchanged by TB6 and keeps its own `loadLinks` state; TB6 never invalidates
  a key it owns, so no draft/drag reset is possible there.
- `SubtaskChecklist` continues to own `projectDataKeys.subtasks(projectId)` while dragging or while
  its schedule editor is open; create/update/delete/schedule invalidations use the same primitive.
- Dashboard ownership is **new in TB6**—neither Dashboard nor Calendar calls `acquireOwner` on
  `main`. Dashboard acquires its exact authorization-scoped `dashboardProjectsKey` whenever
  `interactionBlocked || movementSettlePending`; release occurs only after the accepted Board
  response has completed the existing confirm/settle path. **The single post-settle refetch stays
  owned by the shipped queued-refresh path** (`Dashboard.tsx`'s `queuedRefreshRef` + the
  `movementSettlePendingRef` release effect that calls `projectsQuery.refetch()`); the runtime owner
  contributes only deferral and `takeDeferred` consumption on release — it must NOT issue a second
  `invalidateQueries`/refetch on the same key. Slice 3 asserts exactly one Board refetch after a
  Kanban drag.
- Production Calendar ownership is likewise **new in TB6**. It acquires every mounted exact range key while
  `calendarInteractionBlocked || calendarSettle.pending`; release occurs only after the existing
  drag/resize confirmation and accepted-response settle completes. Same rule: the shipped
  `calendarSettle` recovery/refetch path owns the single post-settle refetch; the runtime owner only
  defers and consumes its marker. Slice 3 asserts exactly one Calendar refetch after a drag/resize.

This is the exhaustive live-registry producer inventory. `A` means Activity. Each same-tab action
runs only after the authoritative success/commit; “publish” means the matching deduplicated existing
BroadcastChannel message(s).

| Live registry type | Server producer | Browser caller / system owner | Project resources | Dashboard effect | Calendar effect | Same-tab action | Cross-tab action | Background convergence |
|---|---|---|---|---|---|---|---|---|
| `project.team.member_added` | `workers/app/src/lib/project-members.ts`; initial roster in `routes/projects.ts#createProjectAtomically` | `ProjectTeamControl.tsx`; `CreateProject.tsx` | existing project: detail, collaboration-summary, A; initial roster: no active project cache—cold read on first open | yes: assignment-scoped list/access; create also adds a row | yes: people/access/unscheduled facets | existing project coordinator; create invalidates Board/Calendar only | project resources + Board + Calendar; create sends Board + Calendar | each affected detail/summary/Board/Calendar/Activity query's own 30s polling and focus/reconnect refresh |
| `project.team.member_removed` | `workers/app/src/lib/project-members.ts#removeProjectMemberCycle` | `ProjectTeamControl.tsx` | detail, collaboration-summary, A; also subtasks when `subtaskAssignmentsCleared > 0` | yes: assignment-scoped visibility | yes: people/access and cleared checklist assignments | commit membership ledger, then coordinator including conditional subtasks | resources + Board + Calendar | each affected detail/summary/subtasks/Board/Calendar/Activity query's own refresh |
| `project.deadline.schedule_changed` | `workers/app/src/lib/project-deadline.ts#saveProjectDeadlineSchedule` | `ProjectDeadlineControl.tsx`; `ProductionCalendar.tsx` | detail, A | yes: card/list deadline metadata | yes: event placement/reminders/overdue filters | coordinator after schedule settle | resources + Board + Calendar | detail, Board, Calendar, and Activity each poll/focus/reconnect independently |
| `project.priority.changed` | `workers/app/src/routes/projects.ts#priority` | `Dashboard.tsx#setProjectPriority` | detail, A | yes: card and priority sort | no: Calendar projection has no Priority | coordinator after optimistic Board commit | resources + Board | detail, Board, and Activity own refresh |
| `project.details.changed` | `workers/app/src/routes/projects.ts#patch` | `EditProject.tsx` | detail, A | yes: address/shoot/card summary | yes: title/search/project projection can change | coordinator after returned detail | resources + Board + Calendar | detail, Board, Calendar, and Activity own refresh |
| `project.archived` | `workers/app/src/routes/projects.ts#archive` | `EditProject.tsx` | detail, A | yes: move between active/archived scopes | yes: remove from active Calendar | coordinator; close quick detail only if its role loses visibility | resources + Board + Calendar | detail, active/archived Board, Calendar, and Activity own refresh; External terminal 404 remains fail-closed |
| `project.restored` | `workers/app/src/routes/projects.ts#restore` | `EditProject.tsx` | detail, A | yes: move back to active scope | yes: restore eligible Calendar data | coordinator | resources + Board + Calendar | detail, active/archived Board, Calendar, and Activity own refresh |
| `project.checklist.item_created` | `workers/app/src/routes/project-subtasks.ts#post` | `SubtaskChecklist.tsx` | subtasks, A | no: Dashboard summary has no checklist projection | yes: schedule/unscheduled/facets | coordinator after local row commit | resources + Calendar | subtasks, Calendar, and Activity own refresh |
| `project.checklist.item_updated` | `workers/app/src/routes/project-subtasks.ts#patch` | `SubtaskChecklist.tsx`; `ProductionCalendar.tsx` | subtasks, A | no: Dashboard summary has no checklist projection | yes: title/done/assignee/schedule/filter state | coordinator through checklist/Calendar settle | resources + Calendar | subtasks, Calendar, and Activity own refresh |
| `project.checklist.item_deleted` | `workers/app/src/routes/project-subtasks.ts#delete` | `SubtaskChecklist.tsx` | subtasks, A | no: Dashboard summary has no checklist projection | yes: remove event/unscheduled/facet counts | coordinator after local removal | resources + Calendar | subtasks, Calendar, and Activity own refresh |
| `project.checklist.schedule_changed` | `workers/app/src/lib/project-subtasks.ts#saveProjectSubtask` | `SubtaskChecklist.tsx`; `ProductionCalendar.tsx` | subtasks, A | no: Dashboard summary has no checklist projection | yes: range/due placement and filters | coordinator through schedule/Calendar settle | resources + Calendar | subtasks, Calendar, and Activity own refresh |
| `project.comment.created` | `workers/app/src/lib/project-comments.ts#createProjectComment` | extracted Discussion core / current `ProjectCollaborationPanel.tsx` | comments, comment-read-marker, A | no: comments are absent from Dashboard summaries | no: comments are absent from Calendar | retain optimistic Discussion state; coordinator for read marker + A | resources only | open comments use 30s/reconnect; read marker uses 30s/focus/reconnect; Activity uses its own 30s/focus/reconnect |
| `project.comment.edited` | `workers/app/src/lib/project-comments.ts#editProjectComment` | extracted Discussion core / current `ProjectCollaborationPanel.tsx` | comments, A | no: comments are absent from Dashboard summaries | no: comments are absent from Calendar | retain draft/editor settle; coordinator for A | resources only | comments and Activity own refresh |
| `project.comment.deleted` | `workers/app/src/lib/project-comments.ts#deleteProjectComment` | extracted Discussion core / current `ProjectCollaborationPanel.tsx` | comments, comment-read-marker, A | no: comments are absent from Dashboard summaries | no: comments are absent from Calendar | commit local removal; coordinator for read marker + A | resources only | open comments, read marker, and Activity each follow their own bounded refresh policy |
| `project.collection.video_link_added` | `workers/app/src/routes/collections.ts#post-link` | `CollectionPanel.tsx#addLink` | A only | no: links are not card fields | no: links are absent from Calendar | after link success, coordinator invalidates `activity` only; `CollectionPanel` `loadLinks` untouched | resources only (`activity`) | Activity's own 30s/focus/reconnect refresh |
| `project.collection.video_link_changed` | `workers/app/src/routes/collections.ts#patch-link` | `CollectionPanel.tsx#saveEdit` | A only | no: links are not card fields | no: links are absent from Calendar | after save, coordinator invalidates `activity` only | resources only (`activity`) | Activity's own refresh |
| `project.collection.video_links_reordered` | `workers/app/src/routes/collections.ts#reorder-link` | `CollectionPanel.tsx#reorderLinks` | A only | no: link order is not a card field | no: links are absent from Calendar | after reorder settle, coordinator invalidates `activity` only | resources only (`activity`) | Activity's own refresh |
| `project.collection.video_link_removed` | `workers/app/src/routes/collections.ts#delete-link` | `CollectionPanel.tsx#removeLink` | A only | no: links are not card fields | no: links are absent from Calendar | after removal, coordinator invalidates `activity` only | resources only (`activity`) | Activity's own refresh |
| `project.collection.document_completed` | `workers/app/src/routes/collections.ts#complete-document` | `CollectionPanel.tsx#uploadCopy/#uploadFloorplan` | detail; assets(copy or floorplan); A | no: document versions are not Dashboard fields | no: document versions are absent from Calendar | existing document completion callback plus coordinator | resources only | detail, collection assets, and Activity each poll/focus/reconnect independently |
| `project.workflow.manual_edited_ready` | `workers/background/src/workflows/manual-edited-publish.ts` | background Workflow; Workspace job polling observes completion | detail; assets(edited); A | yes: effective cover/card delivery summary can change | no: no Calendar field changes | no browser sender; active Workspace keeps its existing job-completion refresh | none from Worker | Workspace job polling triggers detail/edited-assets refresh; Board and Activity each converge through their own 30s/focus/reconnect refresh |
| `project.collection.raw_sync_completed` | `workers/background/src/dropbox/sync.ts#claim-completion` | background RAW reconciliation; `ProjectWorkspace.tsx#syncDropbox` observes status | detail; assets(raw); A | yes: received count/effective cover/card summary | no: no Calendar field changes | no Worker message; active Workspace keeps its existing sync/status refresh | none from Worker | sync/status refresh owns detail/raw assets; Board and Activity independently poll/focus/reconnect |
| `project.stage.changed` | `workers/app/src/lib/project-stage.ts#moveProjectStage` | `Dashboard.tsx`; `ProjectOverviewRail.tsx` | detail, A | yes: Stage identity/order | yes: stage filters/delivered state | coordinator through Board or rail settle | resources + Board + Calendar | detail, Board, Calendar, and Activity own refresh |

The inventory is generated/tested against the live (`cutover === "live"`) registry keys so a future
live entry fails the matrix completeness test until it declares all columns. Reserved workflow
entries are deliberately excluded until their owner promotes them live. Background/system
producers do not emit browser messages: each affected source query converges through its **own**
bounded polling/focus/reconnect or explicit job/status refresh, while Activity converges through its
separate Activity refresh. Activity polling is never claimed to refresh Overview, assets, Board, or
Calendar.

Coordinator tests inject invalidations during: Workspace detail edits; membership and asset ledger
operations; checklist drag and schedule editing; Kanban drag, confirmation, and
`movementSettlePending`; and Calendar drag/resize, confirmation, and `calendarSettle`. For each,
assert no mid-interaction adoption or draft/drag reset, duplicate local/remote messages coalesce,
remote tabs touch only their authorized exact keys, no message is rebroadcast, and final release
causes exactly one post-settlement refetch.

### D7 — focus, scroll, and accessibility

Use a modal `role="dialog"` with `aria-modal="true"`, a stable labelled title, and a focus trap.
Desktop geometry is a right-side sheet over the still-mounted Dashboard; phone geometry is a
full-screen `100dvh` surface with safe-area padding. This is not `complementary`: background
Dashboard controls are inert while the sheet is open.

- On open, save a focus descriptor for the List row, Kanban card, Calendar event/disclosure action,
  or safe Dashboard fallback. Focus the sheet heading/close control only after it is mounted.
- On route close, restore focus to the still-authorized originating control; if it disappeared due
  to filters, refresh, or access loss, use the active view heading/control. Access loss never
  restores focus to a removed project.
- Escape performs the same route close as the Close button unless a nested confirmation/editor owns
  Escape. Back/Forward changes the route directly and closes/reopens without a second history write.
- Lock document/background scroll while open, keep the Dashboard's scroll position, contain scroll
  within the sheet body, preserve each tab's scroll/draft while the project remains the same, and
  reset private state when project ID or principal scope changes.
- Use an accessible tablist with roving/arrow-key behavior. Tabs expose unread Discussion count
  without color alone. Loading, empty, retry, terminal, and pagination states are announced once.
- The full Workspace link is a normal `InternalLink`/anchor to `/projects/:projectId` and remains
  usable with modified click/new tab.
- Respect reduced motion, visible focus, 44x44 phone targets, zoom, and no horizontal page trap.

Matched evidence is required at 1440x900, 1024x768, and 390x844 for Overview, Activity, and
Discussion, plus loading, empty, error, unread, long-content, focus, and External-omission states.
Real-browser evidence—not happy-dom—owns focus trap, focus restore, scroll lock/containment,
Back/Forward, native new-tab, mobile viewport/keyboard, and rich-text value-sync claims.

### D8 — migration: additive index `0038`

A no-migration endpoint would be functionally correct but would scan the append-only global
activity table for every page. That is not a bounded production read projection. Add exactly one
reversible migration, `portal/packages/db/migrations/0038_project_activity_feed_index.sql`:

```sql
CREATE INDEX project_activity_events_project_occurred_idx
  ON project_activity_events(project_id, occurred_at DESC, id DESC);
```

Mirror the named index in `packages/db/src/schema.ts` and add/verify the matching `0038` Drizzle
journal entry and snapshot metadata; generation must be a no-op after those artifacts land. There
is no table rebuild and no `ALTER TABLE`; rollback is
`DROP INDEX project_activity_events_project_occurred_idx`. A bare `CREATE INDEX` is not a
table-rebuild migration, so CLAUDE.md's `drizzle-kit generate` `PRAGMA foreign_keys=OFF` rebuild
caveat does not apply here. Migration tests apply 0000-0038 from
empty and upgrade 0037->0038 with representative activity rows, prove rows unchanged, cursor order
stable, foreign keys intact, and the query plan uses the index. This index is the only schema delta.
No `kanban_card`, activity copy, comment copy, reminder, team, or Calendar-detail table is
introduced.

## View-to-store map

| Sheet view | Authoritative store/query | Notes |
|---|---|---|
| Overview | `projects`, `project_members`, collections, Deadline tables through existing `/api/projects/:id`; `projectDataKeys.detail(id)` | Existing internal detail or strict TB4E external detail; no new endpoint/store |
| Activity | `project_activity_events`; new `/api/projects/:id/activity`; `projectDataKeys.activity(id)` | Immutable cursor projection; no duplicate feed/read-state table |
| Discussion | `project_comments`, `project_comment_mentions`, `project_comment_read_markers`; existing comment/read-marker endpoints and keys | Extract/reuse discussion UI; no checklist in TB6 Discussion and no duplicate cache |
| Dashboard backing view | Existing `dashboard-projects` or `production-calendar` query | Supplies context/skeleton only; never becomes detail authority |

## Numbered implementation slices

No slice is a production deploy. Each starts from the previous green commit. Each owns targeted
tests, runs its applicable gate, receives a fresh-Sol mid-slice diff review before the slice is
declared complete, then receives a separate fresh-Sol confirmation review after all findings are
fixed. Agent-reported success is independently verified by the orchestrating session; Worker/
Miniflare suites that a review sandbox cannot run are rerun outside that sandbox.

### Slice 0 — characterization, inventory, and migration proof

- Pin current route acceptance/rejection, OAuth destination fixed points, Dashboard view storage,
  Calendar URL ordering, InternalLink modified-click behavior, and App route handoff.
- Characterize Dashboard routing in `Dashboard.tsx` and `dashboard-helpers.ts`, with assertions in
  the existing `dashboard-routing.test.ts`; there is no `dashboard-routing.ts` implementation file.
- Characterize List/Kanban/Calendar project anchors and focus candidates, Dashboard scroll ownership,
  current collaboration panel composition, comment draft/read-marker lifecycle, and access-loss
  close behavior.
- Add characterization tests pinning `main`'s local-invalidation behavior while the existing owners
  are active: a local `subtasks` invalidation during `SubtaskChecklist` drag/schedule-popover
  ownership applies immediately despite `runtime.isOwned`, and a local `detail` invalidation during
  `ProjectDeadlineControl` editing likewise applies immediately (apart from the separate shipped
  ledger rules). Also pin today's `queueLedgerInvalidation` deferred-publish behavior
  (`project-data.ts` `state.queuedPublish ||= publish`): with an asset/membership ledger pending, the
  cross-tab `project-data-invalidated` publish for that resource is withheld until ledger release.
  Keep the equivalent cross-tab invalidations characterized as deferred. These are the before-side of
  Slice 3's intentional behavior diff.
- Inventory every TB4C live producer and each corresponding browser mutation/invalidation call site.
- Add migration `0038`, `schema.ts` declaration, Drizzle journal/snapshot metadata, migration
  upgrade tests, cursor/index fixture, generation no-op check, and `EXPLAIN QUERY PLAN` assertion.
  Prove no data rewrite or new store.
- Record the exact External projection manifest/schema tests that must widen for Activity.

Targeted tests: migration apply/upgrade/rollback rehearsal, index query plan, staff-route baseline,
current comment draft/read-state characterization, current access-loss purge, and local-versus-
cross-tab invalidation under active `subtasks`/`detail` owners.

Review checkpoints: fresh-Sol mid-slice review covers migration safety and inventory completeness;
fresh-Sol confirmation reviews the fixed diff and evidence.

Acceptance: current behavior is executable, all mutation/invalidation owners are enumerated, and
0038 is proven additive and reversible. Production remains unchanged if work stops.

### Slice 1 — closed Dashboard routing grammar (no affordance retarget)

- Add the exact `DashboardRoute`/`DashboardQuickDetail`/
  `DashboardCalendarFacetRoute` types, parser, serializer, per-arm allow-lists, shared query
  preamble/budget, and safe-destination changes from D1/D2. Replace the old optional-calendar
  `DashboardCalendarRoute` alias and update `dashboard-helpers.ts` and
  `production-calendar-query.ts` with the D1 `"calendar" in route`/required-arm changes; audit the
  serializer, `App.tsx`, `Dashboard.tsx`, and Dashboard Calendar tests for the same union narrowing.
- Update shared and web router tests, OAuth callback tests, history/router helpers, and `App.tsx`
  route handoff for the new Dashboard arm. Until Slice 4, `App.tsx` replaces any parsed explicit
  List/Kanban route (base or quick-detail) with bare `/`, because Dashboard does not consume
  `dashboardView` yet; it replaces a Calendar quick-detail location with the same canonical Calendar
  route minus `detail`/`detailView`. It renders only that shipped backing view, so no
  detail/activity/discussion query can mount and URL/render state cannot disagree.
- Defer List/Kanban anchor retargeting **and the new Calendar anchor entry point** to Slice 4. Every
  production affordance keeps its shipped behavior in Slice 1: List/Kanban retain
  `/projects/:id`, while Calendar remains action-only with Move/Reschedule/Schedule controls and no
  project anchor. Ordinary, modified, keyboard, and new-tab behavior is unchanged.
- Prove parser/serializer/history behavior in isolation, the temporary replace-to-backing handoff,
  and exact preservation of all Calendar fields. Do not test quick-detail anchor markup yet.

Targeted tests: parser/serializer property matrix; duplicate/unknown/malformed/unsafe query matrix;
explicit `detailView=overview` rejection; OAuth return; history sequences; shipped List/Kanban
anchor destinations and Calendar action-only markup unchanged; temporary direct-detail
normalization; List/Kanban localStorage fallback
versus explicit URL; Calendar state byte-for-byte preservation; Dashboard parsing before the
Calendar fallback and fail-closed non-Dashboard query locations.
Include the cross-arm rejection matrix: Calendar-only params such as `date`/`layers` on `view=list`
or `view=kanban`; List/Kanban shape on `view=calendar` (including missing required Calendar fields);
and `/?detail=<canonical-uuid>` with no `view`. Prove malformed encoding and the 8192-byte bound
reject on every arm.

Review checkpoints: fresh-Sol mid-slice review covers the closed grammar and security boundary;
fresh-Sol confirmation covers fixes and all native-navigation evidence.

Acceptance: every quick-detail URL is canonical and safe at the grammar seam, existing
project/Calendar routes remain fixed points, every production affordance retains its old
destination, and any manually supplied quick-detail URL is replaced to its backing Dashboard before
a sheet query mounts. No partial sheet is user-reachable; production remains coherent if work stops.

### Slice 2 — strict activity projection and query family

- Add strict shared internal/External activity feed schemas and External policy adapters without
  exposing raw payloads.
- Add the `viewQuickDetail` capability (`CAPABILITIES`, `ROLE_CAPABILITIES` admin+editor,
  `EXTERNAL_EDITOR_CAPABILITIES` 11→12). Do not edit the derived `externalMeResponseSchema`; update
  the exact-array/length assertions in `packages/shared/test/capabilities.test.ts` and any
  worker-app `/me` fixture that hardcodes the external list.
- Add and mount `project-activity.ts` with both exact GET route forms, strict query parsing,
  an explicit `roleHasCapability(role, "viewQuickDetail")` 403 before project resolution, the
  single `resolveVisibleProject(c.env, c.get("user"), projectId)` call for every role, the one
  subsequent indexed feed statement, tuple cursor pagination, response-shape role branches, server
  rendering, and byte-identical generic 404 semantics. The External allowed-type predicate must be
  visible in SQL before `LIMIT + 1`; its generated set is exactly the 19 `live && allowed` types.
- Extend `terminal-route.ts`, route security classification, `externalSurface`, route-manifest probes,
  and `EXTERNAL_API_RESPONSE_SCHEMAS` with Activity.
- Add `projectDataKeys.activity`, query options/hook, 30-second polling, focus/reconnect refresh,
  cancellation, and strict external decode. Slice 3 owns its resource-classification/coordinator
  integration before any UI can mount it.
- Verify pagination uses the 0038 index and never uses `LIKE`/`GLOB` or client-side post-page privacy
  filtering. Derive `nextCursor` from the `limit`-th fetched row whenever row `limit + 1` exists,
  independent of strict-parser survivors.

Targeted tests: Admin/internal Editor/External/Photographer/anonymous sessions; assigned,
unassigned, archived, removed-membership, and nonexistent projects; bare/trailing parity; malformed
cursor/query; cursor encoded/decoded caps, canonical re-encoding, padding/alternative encoding and
UUID rejection; safe-integer epoch milliseconds; strict wrapper/item keys; stable ties; page
boundaries; live/reserved/unknown/invalid rows; system/user actors;
External suppression of priority/archive/restore and actor/payload/source/deep-link fields; strict
unknown-key failure; no comment body/checklist payload leak; query plan and response bound; exact
19-type `live && allowed` SQL audit (excluding the four reserved-but-policy-allowed workflow types);
invalid trailing fetched row followed by a reachable next page.

Review checkpoints: fresh-Sol mid-slice review covers authorization, SQL pagination, registry use,
and external privacy; fresh-Sol confirmation covers every fix and reruns the shared-projection
regression gate.

Acceptance: the feed is bounded, indexed, strictly parsed, and server-safe for all named roles; no UI
route consumes it yet. Production remains coherent if work stops.

### Slice 3 — Overview, Activity, and freshness/coherence seams

- Add the presentation-safe Overview selector over `useProjectDetailQuery`; extend only existing
  internal transport typing needed for Priority/time window and preserve strict External detail.
- Build reusable Overview and Activity view components with role-correct empty/loading/error/retry,
  cursor pagination, timestamps, system actor presentation, and no mutation controls.
- Add the invalidation coordinator and apply the D6 matrix to existing interactive mutation success
  sites. This intentionally changes local owner behavior from Slice 0: route every local sender
  through `requestInvalidation`, so active `subtasks` and `detail` owners now defer one exact-key
  invalidation until release; add the new Dashboard and Calendar owners and avoid duplicate
  broadcasts.
- Extend `ProjectDataResource`, `projectResourceKey`, cancellation/purge/runtime tests, and
  `classifyProjectAccessError` with `activity`: Activity 401 maps to `principal`; Activity 403/404
  map to `project`, never `collaboration`, because the endpoint gates on `viewQuickDetail` plus
  project visibility rather than membership. A Discussion 403 remains an expected per-view denial
  for a non-member internal Editor and is intercepted by the sheet view contract: it must not invoke
  collaboration/project purge, tombstone, or route close.
- Generalize `PrincipalFreshnessBoundary`'s 30-second authorization-snapshot close before the async
  tombstone. Parse the complete current location with `parseStaffLocation`; when it is a Dashboard
  route whose `detail.projectId` is in `lost`, call
  `history.replace(staffPathFor(<the same parsed Dashboard route minus detail/detailView>))`. Perform
  this route-aware replacement before `removeProjectData`, alongside the existing project-path
  redirect and matching the shipped “before the asynchronous tombstone work” ordering. Then remove
  Dashboard/Calendar data, cancel/purge all project queries, and suppress late private render or
  announcement. Activity 401/403/404 uses the same terminal machinery, but is not the only trigger.
- Prove external project detail, Activity, and Calendar all traverse their strict shared projection
  boundaries; rerun the TB4E regression gate.

Targeted tests: cold/direct Overview; internal Priority versus External omission; Stage presentation;
team/deadline/reminder summaries; activity polling and pagination; generated completeness against
every live registry key; same-tab and cross-tab matrix for every D6 row; invalidations during
Workspace edits, membership/asset ledgers, checklist drag/schedule editing, Kanban
drag/confirm/settle, and Calendar drag/resize/confirm; deduped owned-key deferral and exactly one
post-release flush; authorized remote keys only; no rebroadcast; principal epoch/membership loss
with late responses; a 30-second snapshot diff while a query-facet sheet is open that strips only
`detail`/`detailView` before tombstoning and cannot be resurrected by Back; Activity access-error
classification; non-terminal Discussion 403; and the per-view matrix from D5. Diff the Slice 0
local-owner characterizations explicitly and require Kanban-drag, Calendar-drag, and checklist-drag
regression evidence in this slice.

Review checkpoints: fresh-Sol mid-slice review covers DTO reuse, invalidation completeness, and
access-loss ordering; fresh-Sol confirmation covers fixes, late-response tests, and projection gate.

Acceptance: the 22-row coordinator is live at existing mutation success sites in this slice, so it
changes Dashboard/Workspace/Calendar refresh timing even though the sheet components are not yet
reachable. Kanban drag, Calendar drag/resize, checklist drag/schedule editing, and Deadline editing
prove no mid-interaction adoption or draft/drag reset and exactly one release flush. Production is
coherent if work stops, but the slice is not user-invisible.

### Slice 4 — discussion extraction, routed sheet, and accessibility

- Extract the comment-thread/read-state/composer core from `ProjectCollaborationPanel`. Keep the
  Workspace panel's existing checklist plus discussion behavior unchanged. Render the discussion
  core alone in TB6. For the D5 internal-Editor/non-member case, consume Discussion 403 locally and
  render an explicit “No discussion access” state with no composer; do not purge Overview/Activity,
  tombstone the project, close the sheet, or remove its route facet.
- Define `sheetVisible` as the sheet being the topmost presented modal in a visible/focused document
  (false while a covering nested modal owns presentation). Compute
  `presented = detailView === "discussion" && sheetVisible` in the routed sheet and pass it
  as `open` to the existing `useProjectCommentPresentation` coordinator. Attach the extracted core's
  presentation anchor and the sheet body as its scroll root. Preserve the coordinator's document
  visibility, focus, intersection, non-zero geometry, scroll-root intersection, current-generation,
  and non-tombstoned-project gates. Hidden Overview/Activity tabs remain mounted but can never
  fetch-to-advance or PATCH the read marker.
- Preserve newest-first pagination, mentions, unread count, author-only edit/delete, optimistic
  cache helpers, content byte limits, and existing mutation endpoints. Include `activity` in
  post/edit/delete invalidations.
- Build and activate the routed `ProjectQuickDetailSheet` in Dashboard with the three separate
  views, normal Workspace anchor, context skeleton, and the D7 modal behavior.
- Complete D2's URL-owned List/Kanban transition in this slice. Make parsed `dashboardView` drive
  `Dashboard.tsx`'s `view`; update `initializeDashboardView`, `lastNonCalendarViewRef`, the
  `quincy:dashboard:view` write, and `calendarFallbackLocationRef`; push canonical explicit sibling
  view URLs, no-op same-view selection, retain bare `/` as the only localStorage fallback, and remove
  Slice 1's temporary explicit-List/Kanban replacement. Prove Back/Forward and direct-link close
  retain the addressed base view.
- Thread the current parsed `detail`/`detailView` through **every** Calendar-owned URL rebuild,
  specifically `navigateCalendar`, its debounced-search call path, and
  `reconcileAppliedCalendarFilters`, plus any Calendar drag/resize settle path that reconciles
  filters and the saved-Calendar restoration writer. Conversely, sheet open/tab/close writers
  preserve Calendar state byte-for-byte. Each path must still prove
  `safeStaffDestination(built) === built`.
- In the same Slice 4 commit, remove Slice 1's temporary replace-to-backing handoff and retarget only
  Admin/internal-Editor/External-Editor List and Kanban affordances to canonical quick-detail
  anchors. Calendar is **not** a retarget: `ProductionCalendarEvent` has no project anchor on `main`,
  so introduce a new plain project anchor inside each applicable draggable FullCalendar event and
  compact/unscheduled disclosure while keeping Move/Reschedule/Schedule controls outside it.
  Supply the canonical `href` for native modified click/new tab and keyboard activation. Prove
  FullCalendar's drag threshold/click suppression prevents a pointer drag from activating the
  anchor, unmodified click opens exactly once, Enter activates without beginning a drag, Space keeps
  native anchor behavior and does not accidentally open/drag, and the separate controls neither
  bubble into the anchor nor open the sheet. Photographer
  affordances retain their shipped `/projects/:id` destination and no Photographer quick-detail
  affordance renders.
- Calendar sheet opening uses a separate facet-only writer, not `navigateCalendar`: it reads the
  current parsed Calendar route, adds only `detail`/`detailView`, and leaves all Calendar bytes
  unchanged. Suppress unmodified same-tab opening while
  `calendarInteractionBlocked || calendarSettle.pending`; the anchor's canonical `href` still owns
  native modified-click/new-tab behavior outside a drag gesture. Test the block explicitly during
  drag/resize and confirmation settle.
- Add an `App.tsx` capability guard modelled on `viewProductionCalendar`: a Photographer direct
  quick-detail URL, OAuth return, or Back/Forward entry is replaced with the same canonical backing
  Dashboard route before any detail/activity/discussion hook mounts. Render the authorized
  Dashboard backing view while replacement settles. This route denial does not call
  `markProjectRemoved`, `removeProjectData`, `purgeProjectData`, or remove any legitimate
  Photographer Dashboard/Workspace cache.
- Keep the sheet mounted across tab changes for draft/scroll preservation; reset/tombstone on
  project/principal change. Activity and Discussion use separate DOM regions, queries, headings,
  empty states, and pagination.
- Add Quincy styling under source-owned tokens/components and capture the matched D-16 evidence.

Targeted tests: Discussion-only composition (no checklist); draft survives polling/tab switches;
RichTextEditor submit/reset/edit/link round trip; read advancement across Discussion-to-hidden-tab
switches, backgrounded documents, covered/nested modals, zero geometry, scroll-root clipping, and
late fetch/PATCH completion; author/impersonated-author controls; modal semantics/trap wiring;
Escape/nested modal precedence; focus restore/fallback; route Back/Forward; scroll lock; mobile
layout; long content; External strict omissions; full Workspace/new-tab anchors; role-correct
List/Kanban/Calendar anchor targets; Photographer direct URL, OAuth return, and Back/Forward
replacement with zero quick-detail network requests and no tombstone/cache purge; internal
non-member Discussion 403 with Overview/Activity retained and no composer; List/Kanban explicit-view
selection/no-op/history/localStorage rules. With a sheet open on a Calendar route, exercise
`navigateCalendar`, debounced search, `reconcileAppliedCalendarFilters`, and drag/resize settle;
each preserves `detail` + `detailView` byte-for-byte and its `safeStaffDestination` invariant. Add
real-browser evidence for Calendar click versus drag, blocked mid-drag opening, keyboard activation,
and modified-click/new-tab behavior.

Live-browser requirement: recheck the real RichTextEditor `onUpdate`/value-sync behavior because
happy-dom cannot prove the no-op transaction race documented in `lessons.md`.

Review checkpoints: fresh-Sol mid-slice review covers reuse versus duplication, draft/read-state,
and dialog mechanics; fresh-Sol confirmation covers all fixes and matched visual evidence.

Acceptance: the complete sheet is reachable from all three Dashboard views, all three views meet
their contracts, and focus/scroll/mobile/navigation behavior is evidenced. The branch is coherent
if later release preparation stops: nothing has been deployed.

### Slice 5 — whole-branch proof and release preparation

- Run repository audits, the External-Editor shared-projection regression gate, targeted endpoint
  density/query-plan checks, and the full §5 gate below in the orchestrating session.
- Run two fresh whole-branch Sol reviews as scoped passes of at most 120k tokens each: pass A covers
  migration/shared/server/security/projection; pass B covers routing/web/freshness/discussion/a11y.
  Resolve findings, then run focused confirmation passes on the changed scopes. Do not feed one
  oversized whole-branch review that exhausts workspace credits.
- Run the final Opus plan-tier/spec review against the binding brief and accepted plan; resolve and
  independently verify every finding.
- Run Agy local-dev functional QA after a human Admin signs in. Use Admin impersonation for internal
  Editor and External Editor. Danger-mode covers passive navigation/privacy/focus/scroll checks;
  YOLO-mode is required for real Discussion writes and is permitted only while impersonating the
  disposable QA account. Agy never performs OAuth, reads secrets, forges a session, or proceeds
  without the existing authenticated Chrome session.
- Capture final matched screenshots and network/console evidence. Retry a clean local-dev sequence
  after known intermittent Wrangler connection failures before classifying an application defect.
- Build all three Worker artifacts and compare their produced bundles/dependency behavior with the
  pre-TB6 baseline. Source-path inspection alone is insufficient because TB6 adds runtime exports to
  shared modules imported by Worker code. If background or webhook artifacts change materially,
  classify the behavior and require the full background -> webhook-ingress -> app deploy order; if
  they do not, record the bundle evidence showing the additions were tree-shaken or behavior-neutral.
- Record production D1/app rollback targets, migration preflight/backup, exact deploy commands, and
  passive production checks. Do not update the plan status or move it to `implemented/` before live
  verification.

Review checkpoints: the two scoped whole-branch Sol passes are the mid checkpoint for this slice;
fresh-Sol confirmation passes after fixes are the confirm checkpoint. Opus then checks the resolved
whole branch against the accepted plan.

Acceptance: every automated/manual/privacy/visual gate is green, rollback is known, and the exact
release candidate is accepted.

## Automated tests and release gates

### Full six-workspace §5 gate

Run from `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test -w @quincy/web
npm run test -w @quincy/db
npx vitest run --config packages/shared/vitest.config.ts
npm run test -w @quincy/worker-app
npm run test -w @quincy/worker-background
npm run test -w @quincy/worker-webhook-ingress
```

`npm run typecheck` covers all six workspaces. `@quincy/db` owns the 0038 migration/index/query-plan
proof and has its own `test` script. The explicit shared Vitest command remains required because
`packages/shared` has a Vitest config but no `test` script, so `npm run test --workspaces` silently
misses it. Background and webhook suites remain release gates because activity
registry/projection changes are shared with notification delivery.

### External-Editor projection regression gate

This is a hard release gate, not a sampled test:

- Every External-reachable Overview field parses through the existing strict project-detail schema.
- Every Activity page parses through the new strict External activity schema and the finite
  `EXTERNAL_PROJECT_ACTIVITY_POLICY`; a generated audit proves its SQL predicate is exactly the 19
  `cutover === "live" && decision === "allowed"` types and excludes every reserved type.
- Discussion list/mutations/read state continue through existing strict External schemas.
- Route-manifest probes cover both Activity route forms and assigned/unassigned/archived/removal.
- `collaborateOnProject` / `hasProjectCollaborationAccess` is never an alternate or looser route to
  External Overview or Activity, and never expands `resolveVisibleProject` visibility. The matrix
  proves assigned-active succeeds, unassigned/archived stays generic 404, and only Discussion uses
  collaboration authorization.
- Repository audit finds no direct External serialization bypassing
  `EXTERNAL_API_RESPONSE_SCHEMAS`, no `select()`-all on the new route, and no Priority, internal
  notes/contact/order/billing/Dropbox/provider/Admin/unrelated-person field in External fixtures.

### Repository audits

- No `kanban_card`, new comment/activity/team/reminder/Calendar-detail table, or client duplicate
  store.
- Exactly one new migration, `0038`, containing only the named index.
- No `router.use("*", ...)` in a router mounted at `/`; both gated exact route forms exist.
- Every staff-route decoded key/value uses unsafe-text rejection; every serializer path strips
  unsafe text; all valid routes are parser/serializer fixed points.
- No Activity query accepts `LIKE`, `GLOB`, free-text search, arbitrary sort, or unbounded limit.
- No raw activity payload/source key/deep link reaches the browser.
- No quick-detail control grants a new mutation capability.
- No Calendar component owns a project-detail cache/store.
- No `prototype/` change.

## Agy local-dev functional QA matrix

After a human signs into `http://localhost:8787` as Admin:

1. Admin: open from List, Kanban, Calendar Month/Week/Agenda; Back/Forward; refresh; copied URL;
   Cmd/Ctrl-click new tab; full Workspace link; archived internal project.
2. Internal Editor via impersonation: repeat active-project paths; verify presentation-safe Stage,
   Priority, team, Deadline/reminder, Activity actor copy, and Discussion author controls. Also open
   an internally visible project where that Editor has no membership: Overview and Activity remain
   usable, Discussion alone shows “No discussion access” with no composer, and the sheet/URL remain
   open without a purge or tombstone.
3. External Editor via impersonation: assigned active project succeeds; unassigned, removed, and
   archived projects close/fail as 404; Priority and suppressed activity/actor/internal fields never
   appear in DOM or network JSON.
4. Access loss: while the sheet is open, remove/change the membership cycle from another authorized
   context; wait for the 30-second authorization-snapshot diff and verify it parses the Dashboard
   query facet, replaces to the same backing route without `detail`/`detailView` before the async
   tombstone/cache purge, restores safe focus, suppresses late render, and prevents Back from
   resurrecting private data. Separately verify Activity terminal errors use the same outcome.
5. Discussion in YOLO mode on disposable QA only: post, mention, edit, delete, unread advance, reload,
   tab switch with draft, and existing-link edit round trip. Verify Activity receives only safe
   comment metadata and Discussion content remains separate.
6. Accessibility: keyboard-only open/tab/paginate/compose/close, real focus trap/restore, nested
   confirmation Escape precedence, screen-reader labels/status, reduced motion, 200% zoom, long
   sheet scroll, background scroll lock, and mobile software keyboard at 390x844.
7. Capture matched evidence at 1440x900, 1024x768, and 390x844 for each view and material state;
   record clean console and expected endpoint/status network evidence.

## Deployment, acceptance, and rollback

### Preconditions

- Exact release commit passed both scoped Sol reviews, confirmation reviews, Opus review, Agy QA,
  the full §5 gate, and External projection regression gate.
- Confirm production still ends at migration 0037 and take/verify the normal D1 recovery export.
- Audit `project_activity_events.id` — every row is a canonical lowercase UUID.
- Record app Worker rollback version `10778f00` unless production changed before release; if it did,
  stop and record the actual current version.
- Build and compare the produced background and webhook Worker artifacts plus resolved shared
  dependency behavior against the pre-TB6 baseline. Record either the material delta that requires
  their deployment or the evidence that TB6's shared additions are tree-shaken/behavior-neutral;
  source/config path comparison alone does not satisfy this precondition.

### Rollout

1. Apply migration `0038` to production D1 and verify the named index plus row counts/query plan.
   The existing app remains coherent because the index changes no response or write behavior.
2. If artifact comparison finds a material background or webhook change, deploy in the mandated
   service-binding order with `npx wrangler deploy` from background, then webhook-ingress, then app.
   Otherwise record the tree-shaken or behavior-neutral bundle result and deploy only the app Worker
   from `portal/workers/app`.
3. Perform passive production checks first: health/sign-in, Dashboard List/Kanban/Calendar, direct
   quick-detail URL, internal Activity, External assigned projection, Back/Forward, and network/
   console status. Perform any write smoke test only under the approved disposable-account policy.
4. After verified live, update this Status with deployment date/commit, update `docs/todo.md`, and
   `git mv` this plan into `docs/plans/implemented/`.

### Accept checkpoint

Accept TB6 only when:

- The same authorized project facts are consistent in List/Kanban/Calendar, sheet, and Workspace.
- URL/open/close/Back/Forward/refresh/direct/new-tab behavior is deterministic.
- Overview, Activity, and Discussion are separate and use only their mapped existing stores.
- External assigned/non-archived scope and server-side field/event omission hold in JSON, not just UI.
- Membership loss purges and closes before late data can render.
- Discussion is the only sheet write surface and preserves all TB3 semantics.
- D-16 matched visual/a11y evidence and every release gate are green.

### Rollback and fix-forward

- App/UI/endpoint fault: roll the app Worker back to the recorded prior version. Migration 0038 may
  remain because the unused index is additive and behavior-neutral.
- Privacy or authorization fault: immediately roll back the app Worker; do not rely on hiding the
  sheet. Verify the old Worker no longer serves the Activity route and purge affected browser data
  by session/authorization refresh.
- Index fault: after app rollback, `DROP INDEX project_activity_events_project_occurred_idx` only if
  diagnostics show the index itself is harmful. No row restoration is required because 0038 changes
  no data.
- A fix-forward reruns the targeted failure test, both applicable scoped Sol confirmation passes,
  the External projection gate, the full §5 gate, and affected Agy scenarios before redeploy.

At every stop point, production remains coherent: before rollout nothing is live; after 0038 only an
unused index is live; after the app deploy the complete URL/server/UI boundary is live together.

## Settled role & projection rules

These are fixed implementation constraints, not reviewer questions: External Overview omits
Priority; every External Activity item omits actor identity and uses generic server-rendered safe
copy; Photographer receives no TB6 sheet or quick-detail affordance and retains the existing
Workspace destinations; internal archived access follows the existing visible-project rule; and
External archived access is always denied. The route guard, endpoint gate, strict response schemas,
anchor targets, and release tests above enforce the same rules at every seam.

If any of these is changed, return the External schemas, route manifest, URL entry-point visibility,
and matched QA matrix to plan review before building; do not patch the distinction only in JSX.
