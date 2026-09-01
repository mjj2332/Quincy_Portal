# Project Navigation and External Editor Collections — Plan
**Status: IMPLEMENTED — built by Luna, independently re-verified (typecheck, web build, full
`test --workspaces`, and the shared package's dedicated vitest suite all green outside any
sandbox; one test-fixture gap found and fixed directly — see below), committed to `main` at
`c302172`, and deployed to production 2026-09-01. App Worker version
`8fd42378-4e77-41b3-b816-c5f78851b42a` (rollback target: TB7's `682ed4a0`). No D1 migration;
background/webhook-ingress not redeployed (untouched by this change). Passive production smoke
test via Agy (chrome-devtools MCP, Option A, signed-in Admin session): all Dashboard→Full
Workspace navigation paths (Kanban/List/Calendar) and the new Discussion/Activity Collaboration
tabs verified working with zero console errors and zero non-2xx responses — SHIP-CLEAN verdict,
independently spot-checked (bundle hash + a cited workspace route both confirmed live). Change 2's
`external_editor` collection widening was **not** exercised in this smoke test — no
`external_editor` account is provisioned in production (see `docs/todo.md`); provisioning one is a
standalone Admin decision, unchanged by this plan.**

Build-verification note: Luna's own sandbox could not run the `workers/app` vitest suite (loopback
`EPERM`), so its self-report of "all green" was unverified for that suite specifically. Re-running
it independently outside any sandbox found 3 real failures — three pagination/cursor-integrity
tests in `project-activity.test.ts` used an Editor token against projects with no membership row,
which now correctly 403s under this plan's own new narrower Activity authorization (§3's intended
behavior; the test fixtures simply hadn't been updated for it). Fixed directly by adding the
missing `insertMember` rows; all 21 files / 296 tests pass on re-run.

Review history and what changed in the final editor pass:

- Round 1 (Sol → Opus) and round 2 (Sol → Opus) each reverted the plan. Per
  `docs/Subagent-Orchestration.md` §2.1, past that cap Opus edits the plan itself and a fresh
  Opus self-review approves it. This document is the result.
- **B-1 (blocking, now resolved in §5)** — the checked-in route security manifest
  (`portal/workers/app/src/lib/terminal-route.ts`) declared every route this plan opens to
  `external_editor` as `"withheld"`. §5's *Route security manifest* subsection now instructs the
  reclassification and adds the positive reachability coverage the existing manifest test lacks.
- **B-2 (blocking, resolved by owner decision, now documented in §4 and §5)** — the document
  upload routes return an internal-shaped response (including the raw R2 object key and presigned
  multipart upload URLs on presign) to an `uploadExtras`-only external editor. The project owner
  was presented three options (same-origin proxy like TB4E, an external-safe projection, or accept
  the exposure) and **explicitly chose to accept it as a deliberate, documented trust-boundary
  exception**. §5's *Document-upload response shape* subsection states that decision and its
  rationale; §4's Non-goal was corrected so it no longer contradicts it.
- Eight round-2 should-fix items were folded in: Activity permanent-denial UI (§2),
  `CollectionPanel` external response validation (§5), the approval-suppression `role` source (§4),
  read-marker re-arm coverage, external-actor Activity-event safety, the pre-review search list,
  the `uploadExtras` ordering nit, and `role="tabpanel"`/`aria-labelledby` on the new tab panels.

## Problem and scope

Two independently deliverable quick changes are bundled into one implementation/review unit:

1. Every Dashboard project entry opens Full Workspace. The TB6 quick-detail route facet, modal,
   modal-only Overview presentation, and `viewQuickDetail` capability are retired. Activity moves
   into a new Discussion/Activity tab set inside the existing Workspace Collaboration panel, and
   its API adopts the same project-collaboration authorization boundary as comments and subtasks.
2. An `external_editor` assigned to a project can read all five project collection kinds and use
   the existing Video link-management and Floorplan/Copy document-management/upload surface.
   Existing assignment-scoped project visibility remains the boundary. A new narrow
   `uploadExtras` capability opens only that extras surface; it does not grant the broader
   `editProject` or `manageExtras` capabilities.

The sections can be reviewed and reverted independently even though both update the shared static
capability map. The original external-editor RAW/Edited-only collection checks have no documented
security rationale in either
[`13-External-Editor-Authorization.md`](revamp_2026_portal/core/13-External-Editor-Authorization.md)
or
[`Revamp-TB4E-External-Editor-Assigned-Scope-Access-Plan.md`](implemented/Revamp-TB4E-External-Editor-Assigned-Scope-Access-Plan.md).
Treat them as an implementation gap left when video/floorplan/copy were added, not as a security
boundary being reversed. The durable security boundary remains assignment-scoped project access
and the external-safe DTO/projection path.

This plan deliberately does not redesign Full Workspace, Calendar interaction, collection upload
protocols, review semantics, or annotations. It preserves the Workspace rail, the Collaboration
overlay's fixed header/inner scroller, `?collaboration=open`, and the immutable R2 object policy.

External-editor field projections are preserved with exactly two deliberate exceptions, both
stated in full in §4's Non-goals and §5:

1. the existing link-origin discriminator (`source`) is added to the external collection-link DTO,
   so manual Video links stay editable after an external-safe response is reloaded; and
2. the Floorplan/Copy **document-upload** routes keep their current internal response shape for an
   `uploadExtras` external editor — including, on presign, the raw R2 object key and presigned
   multipart upload URLs — instead of gaining an external-safe projection. This is an explicit,
   owner-approved trust-boundary decision scoped to those routes, not an oversight; §5's
   *Document-upload response shape* subsection carries the decision and its rationale.

## Source map

### Project navigation, routes, and Collaboration Activity

- [`Dashboard.tsx`](../../portal/apps/web/src/screens/Dashboard.tsx#L1) imports the quick-detail
  route/component types; its modal-only route helpers are at lines 127–141, route state and origin
  tracking at lines 143–212, project destination/open/close handlers at lines 573–648, the Calendar,
  List, and Kanban wiring at lines 1018–1083, and the modal mount at lines 1087–1098.
- [`App.tsx`](../../portal/apps/web/src/App.tsx#L45) owns the quick-detail capability guard at lines
  53 and 89–101 and passes `suppressQuickDetail` to Dashboard at line 115. The independent
  `?collaboration=open` one-shot handling is at lines 62–79 and must remain unchanged.
- [`staff-routes.ts`](../../portal/packages/shared/src/staff-routes.ts#L17) defines
  `DashboardQuickDetail` and the `detail` facets at lines 32–54; admits `detail`/`detailView` into
  both Dashboard grammars at lines 70–75 and 249–307; serializes them at lines 343–355; and keeps
  the separate project `collaboration=open` contract at lines 274–284 and 351–360.
- [`router.ts`](../../portal/apps/web/src/lib/router.ts#L1) re-exports the shared quick-detail type
  from its frontend routing facade.
- [`ProjectQuickDetailSheet.tsx`](../../portal/apps/web/src/components/ProjectQuickDetailSheet.tsx#L1)
  is the modal to delete. Its three-tab keyboard/ARIA pattern is at lines 10–11 and 111–151; the
  Activity invocation to relocate is at line 150.
- [`ProjectOverviewView.tsx`](../../portal/apps/web/src/components/ProjectOverviewView.tsx#L1) and
  [`project-overview.ts`](../../portal/apps/web/src/lib/project-overview.ts#L1) are used only by the
  modal and become dead when it is deleted.
- [`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L1)
  aliases the discussion-only access-failure resource at line 6, owns overlay/open/unread state at
  lines 16–27, consumes `?collaboration=open` signals at lines 29–37, preserves the
  fixed-header/scroll split at lines 54–60, and mounts the unchanged checklist-plus-discussion
  content at lines 62–70.
- [`ProjectActivityView.tsx`](../../portal/apps/web/src/components/ProjectActivityView.tsx#L5)
  already has the required `projectId`, `enabled`, and activity-specific access-failure props. Its
  query enabling and failure callback are at lines 21–29, and its existing inline loading/error
  presentation is at lines 31–45. Line 38 is the single "any error" branch: it renders the raw
  server message plus a Retry button for every failure, including a genuine 403/404 denial.
- [`project-activity.ts`](../../portal/apps/web/src/lib/project-activity.ts#L46) owns
  `useProjectActivityQuery`. It sets `retry: projectQueryRetry` (which returns `false` for every
  4xx except 408/429, so a 403/404 is never auto-retried) and
  `refetchInterval: enabled ? 30_000 : false`, so a denied Activity tab currently re-requests the
  denied endpoint every 30 s for as long as the tab stays selected.
- [`ProjectDiscussionThread.tsx`](../../portal/apps/web/src/components/ProjectDiscussionThread.tsx#L89)
  turns its `presented` prop into `useProjectCommentPresentation({ projectId, open: presented })`
  at lines 89–93 and passes the same flag as the presentation argument of
  `useProjectCommentsQuery(projectId, true, presentation.readAttemptRegistrar, presented)` at line
  97. The read-marker coordinator therefore re-arms on a `false → true` transition of `presented`,
  which is exactly what a switch back from Activity to Discussion produces.
- [`project-data.ts`](../../portal/apps/web/src/lib/project-data.ts#L40) already accepts `activity`
  as an access-failure resource at line 49, but currently classifies every Activity 403/404 as a
  project-scope loss at lines 51–56. That is unsafe for panel-local Activity reads: it can replace
  the whole Workspace with `UnavailableProject`.
- [`ProjectWorkspace.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L55) defines the
  parent access-failure union at line 57, classifies failures at lines 150–180, mounts the overlay
  panel at line 316 and the same panel in `CollaborationOnlyView` at lines 320–333, and derives
  collection-management and review visibility at lines 397–398. `QueryOwnerProps` already carries
  `role: Role` (line 344) and `WorkspaceBody` receives it through `props` (line 392), so
  `props.role` is available inside the same JSX that renders `CollectionPanel` with
  `canApprove={can("reviewEdited")}` — no second `useCapabilities()` call and no new prop are
  needed for the §4 approval suppression. The parent passes `role={role ?? "photographer"}`, so
  `props.role` is never `undefined`, and the `"photographer"` fallback cannot hold `reviewEdited`
  anyway.
- [`PrincipalFreshnessBoundary.tsx`](../../portal/apps/web/src/components/PrincipalFreshnessBoundary.tsx#L63)
  contains quick-detail-specific route stripping and focus restoration at lines 67–94; Full
  Workspace access-loss redirection remains at lines 95–97.
- [`ProjectKanbanBoard.tsx`](../../portal/apps/web/src/components/ProjectKanbanBoard.tsx#L60)
  threads the quick-detail origin callback through card props at lines 68, 241–272, 524–587, and
  624–650/927–928.
- [`ProductionCalendar.tsx`](../../portal/apps/web/src/components/ProductionCalendar.tsx#L78)
  declares the href, click opener, and quick-detail-origin callback at lines 85–87 and threads them
  into scheduled, disclosure, and unscheduled entries at lines 1556–1579.
- [`ProductionCalendarEvent.tsx`](../../portal/apps/web/src/components/ProductionCalendarEvent.tsx#L5)
  owns Calendar's drag-safe real anchor. Lines 59–71 intercept an ordinary click and call the
  route owner's independent opener; the quick-detail-only origin callback is line 67 and is
  threaded through event props at lines 83–145.
- [`ProductionCalendarUnscheduledPanel.tsx`](../../portal/apps/web/src/components/ProductionCalendarUnscheduledPanel.tsx#L12)
  threads the same href/opener/origin props through project and checklist rows at lines 22–24,
  51–79, 107–167, and 193–211.
- [`app.css`](../../portal/apps/web/src/styles/app.css#L1162) defines the Collaboration overlay's
  fixed header and inner scroller at lines 1162–1190. The modal-only shell/tab rules to remove are
  lines 1192–1220; line 1210 currently couples the reusable Activity view to modal selectors.
  The similarly prefixed `.project-overview__heading`/`__header` rules at lines 262 and 875–876
  belong to the live `ProjectOverviewRail` and must remain.
- [`capabilities.ts`](../../portal/packages/shared/src/capabilities.ts#L17) is the static,
  code-only capability catalogue and role allow-list. `viewQuickDetail` appears at lines 46, 62,
  106, and 128; no capability grant is stored in D1.
- [`project-activity.ts`](../../portal/workers/app/src/routes/project-activity.ts#L84) gates the
  Activity feed with `viewQuickDetail` before parsing the project at lines 84–93. Its retained
  `resolveVisibleProject` check is stage-sensitive for Photographer even after the collaboration
  guard admits a real membership.
- [`capability.ts`](../../portal/workers/app/src/middleware/capability.ts#L23) is the collaboration
  authorization authority: active principals require `collaborateOnProject`; Admin is global and
  every other role is project-membership/visibility scoped at lines 28–46.
- [`projects.ts`](../../portal/workers/app/src/routes/projects.ts#L1135) returns 403 from project
  detail when `hasProjectAccess` rejects an assigned Photographer after the project leaves a
  photographer-visible stage, which routinely selects Workspace's collaboration-only mode.
- [`stages.ts`](../../portal/packages/shared/src/stages.ts#L18) limits Photographer project
  visibility to `awaiting_raw` and `raw_review` at line 20.
- [`project-comments.ts`](../../portal/workers/app/src/routes/project-comments.ts#L47) and
  [`project-subtasks.ts`](../../portal/workers/app/src/routes/project-subtasks.ts#L66) are the
  route-local precedents for calling `hasProjectCollaborationAccess` without router-wide Hono
  middleware.

### External-editor collection access

- [`review.ts`](../../portal/workers/app/src/routes/review.ts#L29) has the primary external-safe
  collection listing path and its RAW/Edited-only check at lines 35–37. The direct asset review
  route repeats a collection-kind check at lines 122–132, but that route is a POST write and its
  guard remains.
- [`media.ts`](../../portal/workers/app/src/routes/media.ts#L57) restricts external-editor asset
  bytes to RAW/Edited at lines 59–62 and independently restricts annotation-markup bytes to
  RAW/Edited at lines 146–153. Both lookups use external assignment-scoped query helpers, but
  `externalAnnotation` at lines 30–41 does not enforce a collection kind; the annotation-markup
  route's own kind predicate must therefore remain.
- [`annotations.ts`](../../portal/workers/app/src/routes/annotations.ts#L76) enforces the universal
  RAW/Edited-only annotation rule at lines 76–89. Its external branches repeat the kind check at
  lines 94–101, 124–132, 168–175, and 196–203, but those branches bypass the universal helpers;
  the checks are therefore not redundant in actual control flow and remain in place.
- [`schema.ts`](../../portal/packages/db/src/schema.ts#L898) defines `annotations.assetId` as an FK
  to `assets.id` at lines 898–917, but neither that FK nor `annotations.scope` constrains the
  referenced asset's collection kind. A legacy or inconsistent annotation row can therefore point
  at an asset outside RAW/Edited, so the byte-serving route cannot rely on schema integrity for
  this boundary.
- [`collections.ts`](../../portal/workers/app/src/routes/collections.ts#L16) limits the router to
  video/floorplan/copy kinds at lines 16–31. `canManageCollection` currently accepts only
  `editProject || manageExtras` at lines 40–44; every link/document mutation calls it, beginning
  at lines 174–205. Link create accepts all three kinds, link delete resolves all three kinds, and
  patch/reorder are already Video-only. The external-safe links read accepts all three kinds at
  lines 156–165 but omits `collection_links.source` from its projection.
- [`terminal-route.ts`](../../portal/workers/app/src/lib/terminal-route.ts#L70) is the checked-in
  route security manifest. `securityContractForClass` expands the legacy `"withheld"` class to
  `{ scope: "none", projection: "internal", response: "constant-403" }` at line 60 and the legacy
  `"scoped"` class to `scoped-child-resource` →
  `{ scope: "assigned-project", projection: "external-safe", response: "scoped" }` at lines 55 and
  236–248. Every route this plan opens to `external_editor` is currently seeded `"withheld"`: the
  four document routes at lines 153–156 and the four link mutations at lines 164–166 and 168.
  `POST /api/projects/:id/documents` (line 157) is an unconditional 410 tombstone (`collections.ts`
  line 362) and is not part of this plan's surface.
- [`route-manifest.test.ts`](../../portal/workers/app/test/route-manifest.test.ts#L235) drives every
  `"withheld"` route with a real assigned external-editor session but an empty `"{}"` body (lines
  241–252) and asserts only `status >= 400`. Verified: after this plan every one of these routes
  still fails that probe for a reason unrelated to authorization (schema validation 400 for
  presign/complete/link-create/patch/reorder, `Link not found`/`session not found` 404 for
  delete/abort), so the existing test would stay green over a stale contract. `projection` is only
  actually asserted for routes carrying an `externalSurface` tag (lines 171–194).
- [`r2s3.ts`](../../portal/workers/app/src/lib/r2s3.ts#L34) — `createMultipartPresign` returns
  `{ uploadId, key, partUrls, partBytes }`, where `partUrls` are signed
  `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>` URLs (lines 49–54). It returns `null`
  when `APP_ENV === "dev"`. `documentKey()` (`collections.ts` line 47) is the raw R2 key
  `projects/<projectId>/<collection>/<assetId>/<filename>`, and the presign response spreads both
  into `files.pdf`/`files.preview` at `collections.ts` lines 404–406.
- [`external-upload.ts`](../../portal/packages/shared/src/external-upload.ts#L19) is the contrasting
  TB4E protocol: its `sameOriginPath` regex pins every part/complete/abort URL to
  `/api/external-uploads/...`, so that surface never discloses an R2 key or a presigned storage URL
  to an external principal. This plan deliberately does not adopt that shape for documents (§5).
- [`project-activity.ts`](../../portal/packages/shared/src/project-activity.ts#L92) holds the
  `safePayload` schemas and notification copy for the four external-actor-reachable activity types.
  Payloads are `{ linkId, collectionKind: "video" }`, `{ linkId, collectionKind, changedFields }`,
  `{ collectionKind, count }` and `{ collectionKind, version, assetCount }` (lines 92–96), and the
  rendered titles/bodies are the generic "Video links updated" / "Document upload completed" strings
  at lines 464–468. Verified: no AutoHDR, provider, R2-key, or watch-folder metadata can reach an
  internal Activity reader through an external-actor-sourced event.
- [`external-project-dto.ts`](../../portal/packages/shared/src/external-project-dto.ts#L149)
  defines the strict external collection-link schema without `source`; its list response and
  external response-surface registry reuse that schema. Once `source` is added, the external link
  DTO (`{id,url,label,source,position,createdAt}`) matches the internal branch's selected columns
  (`collections.ts` line 168) field for field.
- [`CollectionPanel.tsx`](../../portal/apps/web/src/components/CollectionPanel.tsx#L13) requires
  every link to have `source: "tonomo" | "manual"`, uses it to render the state tag and gate
  Edit/Remove at lines 30–40, and loads links through plain typed `apiGet` at lines 68–74 rather
  than parsing `EXTERNAL_API_RESPONSE_SCHEMAS["collection-links"]`. It exposes link
  create/edit/reorder/delete only for Video at lines 153–154; Floorplan and Copy render delivered
  links read-only and expose document upload/version controls instead at lines 155–163.
- [`ProjectWorkspace.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L391) already
  exposes all five collection tabs unless a server 403 reactively adds a kind to
  `collectionDenied` (lines 397–400); the same line controls whether `CollectionPanel` receives
  its manage/upload affordances.
- [`uploads.ts`](../../portal/workers/app/src/routes/uploads.ts#L53) is the naming precedent:
  `uploadEdited` is checked as a narrow upload capability at lines 53–57, 70–77, and 84–92. The
  new capability does not alter this RAW/Edited upload path.

## 1. Retire quick detail and make every project entry open Full Workspace

### Change

In [`Dashboard.tsx`](../../portal/apps/web/src/screens/Dashboard.tsx#L573), keep one small
`projectHrefFor(projectId)` helper, but reduce it to the canonical encoded
`/projects/${encodeURIComponent(projectId)}` path. This keeps a single destination builder for
Calendar, List, and Kanban without duplicating encoding rules. Remove its role/capability branch,
Dashboard route-facet construction, and fallback logic.

Keep Calendar's independent `openCalendarProject` because
[`ProjectCalendarAnchor`](../../portal/apps/web/src/components/ProductionCalendarEvent.tsx#L12)
uses it to suppress a terminating FullCalendar drag click and to enhance ordinary unmodified
clicks. Replace only its destination logic: preserve the
`calendarInteractionBlocked`, `calendarSettle.pending`, `canViewProductionCalendar`, and
`viewingArchived` guards, then push `projectHrefFor(projectId)`. Drop the now-dead
`parseStaffLocation`/`calendar` lookup and `if (!calendar) return` guard; once the destination is
unconditionally Full Workspace, retaining that lookup could silently suppress an otherwise valid
Calendar activation. Do not preserve Calendar filters in the destination; Full Workspace is a
different route. Modified clicks continue to follow the anchor's same Full Workspace `href`
natively.

Remove `QuickDetailOrigin`, `quickDetailOriginRef`, `routeDetail`, `dashboardDetail`,
`dashboardBackingRoute`, `dashboardRouteWithDetail`, `rememberQuickDetailOrigin`,
`closeQuickDetail`, `handleSheetAccessFailure`, `changeQuickDetailView`, `sheetVisible`, the
document focus/visibility listener used only by `computeSheetVisible`, the `suppressQuickDetail`
prop, and the `ProjectQuickDetailSheet` render. Calendar route restoration, navigation, and
applied-filter reconciliation must call `staffPathFor` directly with the Calendar route and must
continue preserving all Calendar fields. Remove `onProjectAnchorClick` from `ProjectListRow` and
from the Dashboard calls into Calendar/Kanban.

Remove the now-unowned `onProjectAnchorClick` prop from `ProjectKanbanBoard`,
`ProductionCalendar`, `ProductionCalendarEvent`/`ProjectCalendarAnchor`, and
`ProductionCalendarUnscheduledPanel`. Preserve `ProjectCalendarAnchor`'s movement threshold,
modified-click behavior, Enter activation, and `onOpenProject`; only the origin-recording callback
is dead.

Delete `ProjectQuickDetailSheet.tsx`. Also delete the modal-only `ProjectOverviewView.tsx` and
`project-overview.ts`: a repository-wide import search shows neither has another production
consumer, while Full Workspace already presents this information through
`ProjectOverviewRail`. Remove only the corresponding modal/Overview-view CSS, including
`.project-overview-view__header`; explicitly retain the live rail selectors
`.project-overview__heading` and `.project-overview__header`, which belong to
`ProjectOverviewRail.tsx` despite their similar prefix. Keep a standalone
`.project-activity-view { min-width: 0; }` rule rather than deleting the Activity layout guard
with the modal selector group.

In [`staff-routes.ts`](../../portal/packages/shared/src/staff-routes.ts#L32), delete
`DASHBOARD_QUICK_DETAIL_VIEWS`, `DashboardQuickDetail`, the optional `detail` fields, the
`dashboardQuickDetailViewNames` set, `detail`/`detailView` parameter admission and parsing on both
Dashboard arms, and `appendDashboardQuickDetail`. `staffPathFor` serializes only the backing
List/Kanban or Calendar route. Former `?detail=`/`detailView=` URLs become invalid closed-grammar
locations (`not-found`/unsafe OAuth destination); there is no compatibility redirect. Remove the
dead type re-export from the frontend `router.ts` facade.

Delete App's `quickDetailBlocked` effect and Dashboard suppression prop. Delete the corresponding
quick-detail access-loss branch and now-unused imports from `PrincipalFreshnessBoundary`; its
project-data tombstoning and direct Full Workspace redirect remain unchanged.

### Non-goals

- No deep-link migration or redirect for old `?detail=` or `detailView=` URLs. Notifications,
  Notice Board, and mentions already use `projectNotificationRoute` and Full Workspace.
- No change to `?collaboration=open`; it remains the existing one-shot Collaboration-overlay
  intent and continues to canonicalize back to `/projects/:id` after consumption.
- No change to Dashboard List/Kanban/Calendar selection, drag/resize, filter, or browser-history
  behavior beyond the destination of a project activation.
- No new Overview tab in Full Workspace and no redesign of `ProjectOverviewRail`.

## 2. Add Discussion and Activity tabs to the Collaboration panel

### Change

Add local `activeView: "discussion" | "activity"` state to
[`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L16),
defaulting to Discussion and resetting to Discussion when `projectId` changes. Preserve the
selected tab across closing and reopening the same overlay instance. This is a local presentation
choice only: it is not persisted and is not represented in the URL.

**Resolved in the final review pass — build it as specified.** The overlay's Hide/Show toggle is a
local visibility affordance, not a navigation: re-defaulting to Discussion on every hide would
fight a user who deliberately parked on Activity while working in the Workspace behind it. The two
cases where a specific tab *is* intended are both handled explicitly and take precedence — a new
`projectId` resets to Discussion, and so does each newly consumed `?collaboration=open` signal
(next paragraph), which is the path every mention, subtask, and comment notification arrives on.

Also reset `activeView` to Discussion whenever a new `?collaboration=open` signal is consumed in
the existing lines 30–37 effect, before acknowledging/canonicalizing that signal. `App.tsx` keys
`ProjectWorkspace` only by `projectId`, so navigating on a warm mount from `/projects/X` to
`/projects/X?collaboration=open` does not remount either component; this reset ensures a mention
or subtask notification aimed at Discussion cannot reopen a retained Activity tab.

Adapt the deleted sheet's accessible tab pattern to two panel-local tabs:

- render a `role="tablist"` labelled `Project collaboration views` after the existing
  `.project-collaboration__head` and before the content scroller;
- give both buttons `role="tab"`, `aria-selected`, `aria-controls`, selected-only `tabIndex=0`,
  and project-scoped tab/panel ids;
- give both content panels `role="tabpanel"`, an `id` matching the owning tab's `aria-controls`,
  and `aria-labelledby` pointing back at that tab's own id, mirroring the deleted sheet's panel
  markup (`ProjectQuickDetailSheet.tsx` lines 149–151). Toggle the inactive panel with the `hidden`
  attribute, as the sheet does — do not unmount it (see the `presented`/`enabled` rules below);
- preserve ArrowLeft/ArrowRight/ArrowUp/ArrowDown wrapping plus Home/End keyboard selection and
  focus movement; and
- retain the current unread count on the outer Collaboration toggle and mirror it on the
  Discussion tab using the same capped `99+` presentation.

For overlay mode, keep the current direct `.project-collaboration__head` and
`.project-collaboration__scroll` structure; the tablist is a non-scrolling sibling between them,
so the header and tabs remain fixed while the existing inner body remains the only scroll box.
For standalone mode, render the same header, tablist, and panels in normal document flow; do not
introduce a standalone fixed-height scroller. Add narrowly named
`.project-collaboration__tabs`, `__tab`, and `__panel` rules using the former sheet tab style and
existing paper/border/focus tokens. Do not change overlay dimensions, `z-index: 70`, edge toggle,
Hide button, Escape handling, or scroll-root ref ownership.

Keep `ProjectDiscussionThread` mounted so its existing cache/unread coordination survives tab
switches, but change `presented` to `open && activeView === "discussion"`; a hidden Discussion tab
must not advance its read marker. Its Discussion panel contains exactly today's `content`,
including the existing `beforeAnchor={<SubtaskChecklist ... />}` ordering. Mount
`ProjectActivityView` in the Activity panel with `projectId`,
`enabled={open && activeView === "activity"}`. Hidden Activity must not issue its query merely
because the overlay is open on Discussion. Give Activity a resource-specific failure adapter:
only a genuine `ApiError` 401 is forwarded through the shared `onAccessFailure`; Activity 403 and
404 (and ordinary transient failures) remain inside `ProjectActivityView`. Do not send Activity
403/404 through `setCollaborationUnavailable(true)`: that state replaces the entire Collaboration
panel and would discard still-usable Discussion just as surely as page-level termination does.

Because 403/404 now stay inside the panel, `ProjectActivityView`'s single "any error" branch is no
longer adequate — split it. Today line 38 renders the raw server message plus a Retry button for
every failure, so a genuine denial would read as `Project activity unavailable. Forbidden… [Retry]`
directly beside a working Discussion thread, and Retry could never succeed
(`projectQueryRetry` returns `false` for every 4xx except 408/429, and a manual `refetch()` just
re-issues the same denied request). Change it to:

- on an `ApiError` with status 403 or 404, render a permanent-denial message with **no** Retry
  button — for example `Project activity isn't available for this project at its current stage.`
  Do not surface the raw server message in this branch; the server text ("Forbidden…",
  "Project not found") describes an anti-enumeration response, not something the reader can act on;
- on every other error (transient/5xx/network), keep today's message-plus-Retry presentation
  unchanged; and
- suppress the 30 s poll while the query is in that permanent-denial state, so a selected-but-denied
  Activity tab stops re-requesting a denied endpoint. Use TanStack Query v5's function form in
  `useProjectActivityQuery` — `refetchInterval: (query) => enabled && !isPermanentDenial(query.state.error) ? 30_000 : false`
  — rather than adding a component-level flag, so `refetchOnWindowFocus`/`refetchOnReconnect` are
  the only remaining refetch triggers and the query object stays the single source of truth. Reuse
  `isPermanentProjectAccessError` from `project-data.ts` narrowed to 403/404 (401 is still
  forwarded to the parent and terminates the principal, so it never reaches this branch).

Extend `ProjectCollaborationPanel`'s `AccessFailureResource` alias with `"activity"`, and add
`"activity"` to `ProjectWorkspace`'s parent union. The existing
`classifyProjectAccessError(..., "activity")` signature already accepts the resource. Make its
contract defensive and consistent with panel ownership: Activity 401 remains principal-scoped,
but Activity 403/404 return `null` rather than project- or collaboration-scope classifications.
The panel adapter should normally prevent those failures from reaching the parent at all; the
classifier rule ensures an accidental call still cannot terminate the Workspace or replace the
whole Collaboration panel. This protects both an Editor who loses membership and the more common
assigned Photographer whose later-stage project detail is 403/collaboration-only while Activity's
retained visibility check returns 404.

### Non-goals

- No Activity-specific URL facet and no change to `?collaboration=open`. A later plan may extend
  the collaboration arrival intent with a closed sub-view value, but this build does not reserve,
  parse, serialize, or emit one.
- No changes to checklist, comment thread, composer, unread algorithm, or access-failure semantics
  beyond withholding discussion presentation while its tab is hidden and containing Activity
  403/404 in Activity's own inline error UI (including its new permanent-denial branch and the
  matching poll suppression).
- No change to `ProjectActivityView`'s transient-error presentation, its loading/idle/empty states,
  its pagination, or its event rendering; only the 403/404 branch and the poll condition change.
- No Overview tab, unread Activity badge, Activity mutation controls, or Activity data-shape
  change.
- No regression to the fixed-header/inner-scroller design from
  [`Workspace-UI-Polish-Plan.md`](implemented/Workspace-UI-Polish-Plan.md#2-overlay-collaboration-fixed-header-and-inner-scroller).

## 3. Replace `viewQuickDetail` with project-collaboration authorization

### Change

Remove `viewQuickDetail` from `CAPABILITIES` and every role allow-list. It has no remaining client
or API surface once quick detail is gone. Do not replace it with an Activity-only role capability.

In [`project-activity.ts`](../../portal/workers/app/src/routes/project-activity.ts#L84), remove the
inline `roleHasCapability(..., "viewQuickDetail")` check and import
`hasProjectCollaborationAccess`. Parse/canonicalize the project UUID first, then call the
collaboration guard inside the handler—do not register router-wide Hono middleware. For a denied
external editor, retain the generic `404 { error: "Project not found" }` anti-enumeration response;
for denied internal users, return the same assignment-oriented 403 used by Collaboration routes.
After the collaboration gate, retain the existing visible-project/existence check, query grammar,
cursor validation, external feed-type filter, external-safe schema, and ordering/index use.

This deliberately widens Activity to assigned photographers in photographer-visible pipeline
stages: Photographer already has `collaborateOnProject`, and `hasProjectCollaborationAccess`
requires that photographer's explicit project membership. The retained subsequent
`resolveVisibleProject` check applies `visibleProjectWhere` and therefore additionally requires a
photographer-visible stage. In a later stage the ordinary project-detail 403 can leave the
Photographer on the valid collaboration-only page while Activity returns 404; section 2's local
Activity failure handling is therefore part of this authorization change, not optional UI polish.
Admin remains globally admitted. Editor and External Editor require the same
membership/visibility semantics as the rest of Collaboration. For Editor this is an intentional
narrowing from today's `viewQuickDetail` + `viewAllProjects` behavior: Activity now requires an
explicit `project_members` row instead of being globally readable. There is no role-specific
carve-out to reproduce the removed Photographer denial.

### Non-goals

- No capability-list changes for Photographer, Editor, or Admin other than deleting the obsolete
  `viewQuickDetail` name from roles that had it. Their existing capability memberships otherwise
  remain byte-for-byte unchanged. Authorization behavior does narrow for Editor Activity reads:
  non-Admin collaboration membership is now required as stated above.
- No weakening of project membership, active-user, archived-project, external-safe event-type, or
  response-projection checks.
- No `router.use("*", ...)` or manual invocation of a Hono middleware factory; the guard remains an
  inline handler check, consistent with the routing lessons in `docs/lessons.md`.

## 4. Widen assigned external-editor reads to all collection kinds

### Change

Remove only the external-editor collection-kind predicates from:

- the external asset list branch in [`review.ts:35–37`](../../portal/workers/app/src/routes/review.ts#L35);
- and the external plain asset-media branch (`GET /media/asset/:assetId/:variant`) at
  [`media.ts:59–62`](../../portal/workers/app/src/routes/media.ts#L59).

Do not merge external and internal branches. Preserve `resolveVisibleProject`,
`visibleProjectWhere`, `externalAsset`, publish-status checks, external DTO schemas,
private/no-store response headers, and R2 existence checks. The primary list and plain asset-media
paths then accept RAW, Edited, Video, Floorplan, and Copy only when their existing assigned-project
query returns a row.

Retain the external RAW/Edited collection-kind guard at
[`POST /assets/:id/review`](../../portal/workers/app/src/routes/review.ts#L122). This is a write
route, not part of the read widening. Internal roles already have no equivalent collection-kind
guard at lines 141–147, so removing it would be API parity widening rather than a prerequisite for
the new reads; this plan intentionally declines that new privilege. Because the newly readable
Floorplan/Copy assets would otherwise make the existing `canApprove={can("reviewEdited")}` buttons
appear for an external editor, also make the Workspace's extras approval prop internal-only:
`canApprove={can("reviewEdited") && props.role !== "external_editor"}` on the `CollectionPanel`
render inside `WorkspaceBody`. Use the already-available `props.role` — `WorkspaceBodyProps`
inherits `role: Role` from `QueryOwnerProps` (`ProjectWorkspace.tsx` line 344) and `WorkspaceBody`
receives it at line 392 — **not** a second `useCapabilities()` call, and do not add a new prop.
Note that `WorkspaceBody`'s existing `const { detail: project, assets, … } = props;` destructuring
does not include `role`, so reference it as `props.role`. The parent passes
`role={role ?? "photographer"}`, so this value is never `undefined`. Video has no review controls.
The API guard and UI suppression keep extra-collection review read-only without changing internal
Admin/Editor approval behavior.

Keep the external-editor RAW/Edited-only predicate on `GET /media/annotation/:annotationId` at
[`media.ts:149–153`](../../portal/workers/app/src/routes/media.ts#L149). Its `externalAnnotation`
lookup enforces assignment/visibility but no collection-kind restriction; the route's predicate
separately retains its publish-status check. The annotation FK does not guarantee that the
referenced asset belongs to RAW or Edited. This independent byte-serving read route must reject
annotation markup attached by legacy/inconsistent data to Video, Floorplan, or Copy assets even
though ordinary annotation CRUD also prevents such rows from being created now.

Keep the existing kind/access behavior of
[`collections.ts:156–165`](../../portal/workers/app/src/routes/collections.ts#L156). Its
external-safe video/floorplan/copy link read is the existing precedent for this widening; section
5 adds only the missing link-origin field to that response.

Keep every RAW/Edited annotation-kind guard in `annotations.ts`. Although the external branch
conditions look textually duplicative, those branches return before `scopeForAsset`/`canViewAsset`
and therefore do not inherit the universal restriction. Removing them would accidentally enable
extra-collection annotation creation/edit/delete under `annotateEdited`.

**Resolved in the final review pass — re-verified directly against the source; keep every guard.**
Each `external_editor` branch (`annotations.ts` lines 94–101, 124–132, 168–175, 196–203) resolves
its asset through `externalAssetContext` and then `return`s its own response, so control never
reaches `scopeForAsset` (line 76, which rejects a non-RAW/Edited `asset.kind` with a 400) or
`canViewAsset` (line 84, which does the same at line 87). The external branches' own
`asset.kind !== "raw" && asset.kind !== "edited"` conditions are therefore the *only* thing
enforcing this boundary on the external path — they are load-bearing, not redundant.

### Non-goals

- No annotation restriction change: every annotation-related route remains RAW/Edited-only for
  every role, including annotation CRUD and the independent annotation-markup byte-serving route
  for external editors.
- No new collection-kind capability matrix and no client-side proactive tab gating. The existing
  reactive `collectionDenied` fallback remains for genuine server denials.
- No access to unassigned, archived-out-of-scope, removed, or nonexistent projects. External-safe
  response fields are unchanged **except** for two deliberate, owner-approved changes stated in
  section 5:
  1. `source` is added to the external collection-link DTO. That discriminator is required so the
     shared client can distinguish editable manual links from immutable Tonomo links after reload
     without an unsafe client-side default.
  2. The Floorplan/Copy **document-upload** routes (presign, complete, abort) return their existing
     internal response shape to an `uploadExtras`-only external editor rather than gaining an
     external-safe projection. On presign that shape includes the raw R2 object key and presigned
     S3 multipart upload URLs. This is a scoped, documented exception to this project's general
     external-safe-projection posture — a boundary decision the project owner made explicitly after
     reviewing the alternatives, not an oversight or an unnoticed leak. Its full rationale and
     limits are in section 5's *Document-upload response shape* subsection.

  These are the only external-safe response-surface changes in this plan; no other external DTO,
  registry entry, or projection is touched.
- No extra-collection review writes for `external_editor`; the POST route's RAW/Edited guard and
  the extras approval-control suppression remain deliberate.
- No capability changes for Photographer, Editor, or Admin.

## 5. Add the narrow `uploadExtras` capability

### Change

Add `uploadExtras` to the shared `CAPABILITIES` tuple and grant it only through
`EXTERNAL_EDITOR_CAPABILITIES`. Do not add it to Admin or Editor: they remain authorized through
their existing `editProject`/`manageExtras` paths, which keeps their explicit capability lists
otherwise unchanged. Photographer receives no new capability.

Place `uploadExtras` in the **same trailing position** `viewQuickDetail` currently occupies in
`EXTERNAL_EDITOR_CAPABILITIES` (it is the last entry today), and likewise substitute it in place
where `viewQuickDetail` sits last in the `CAPABILITIES` tuple. `/api/me` serializes this array in
declaration order and
[`api.test.ts`](../../portal/workers/app/test/api.test.ts#L881) compares it with `toMatchObject`,
which matches arrays element-by-element in order rather than as a set — a different insertion point
fails that assertion for no functional reason.

Keep [`canManageCollection`](../../portal/workers/app/src/routes/collections.ts#L40) as the broad
Admin/Editor authority:

```ts
roleHasCapability(role, "editProject")
  || roleHasCapability(role, "manageExtras")
```

Add two surface-specific helpers in the same module: `canManageVideoLinks(c)` and
`canManageDocuments(c)`, each returning `canManageCollection(c) ||
roleHasCapability(role, "uploadExtras")`. Use `canManageVideoLinks` for Video link
create/edit/reorder/delete and `canManageDocuments` for every Floorplan/Copy document mutation
(presign, dev direct upload, complete, and abort). This preserves the broad helper's current
Admin/Editor behavior while making the new capability's product surface explicit at each route
family.

The POST link-create route accepts a collection kind in its body, so parse the validated body and
require `data.collection === "video"` before allowing an `uploadExtras`-only principal to proceed.
Patch and reorder already constrain their target queries to Video and therefore return 404 for a
Floorplan/Copy link id. The DELETE route currently looks up links from all three collection kinds.
After `hasProjectAccess`, establish whether the principal has broad collection authority or only
`uploadExtras`, resolve the link, and return the same 404 `Link not found` response both when no
link exists and when an `uploadExtras`-only principal targets an existing non-Video link. Do not
return 403 for the latter: the narrow principal must not gain an existence oracle for
Floorplan/Copy links it cannot manage. Broad `editProject`/`manageExtras` principals retain their
existing ability to create/delete Floorplan/Copy links. Preserve existing manual-versus-Tonomo,
audit, and activity behavior after that scope check.

Add `source: z.enum(["tonomo", "manual"])` to the strict
[`externalCollectionLinkSchema`](../../portal/packages/shared/src/external-project-dto.ts#L149),
and select/project `collection_links.source` in the external branch of
[`GET /projects/:id/links`](../../portal/workers/app/src/routes/collections.ts#L156). `source` is
the minimal external-safe discriminator needed by `CollectionPanel` to label link provenance and
render Edit/Remove only for manual links. Do not default an absent source to `"manual"` in the
client: that would erase the server-owned manual/Tonomo distinction. This also makes a link loaded
after reload match the internal POST/PATCH response shape for the fields the shared `Link` client
type actually consumes.

Because these helpers are local to the video/floorplan/copy collections router, `uploadExtras`
cannot open project metadata editing, membership changes, deadline/Calendar scheduling, cover
selection, archive/delete, RAW upload, or the dedicated external Edited-upload protocol. It admits
manual Video link management plus Floorplan/Copy document upload/version management on projects
that first pass `hasProjectAccess`. No route may check `uploadExtras` outside `collections.ts`.

Update [`ProjectWorkspace.tsx:397`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L397)
to derive `canManageCollections` from `editProject || manageExtras || uploadExtras`. This only
passes `canManage` into the existing Video/Floorplan/Copy `CollectionPanel`; RAW and Edited upload
controls retain their separate `uploadRaw`/`uploadEdited` checks.

Keep the existing `forbidden()` response body (`capability: "manageExtras"`) in this quick change
to avoid changing a legacy error contract shared by all collection mutations; authorization is
defined by the broad and surface-specific collection helpers, not by that diagnostic string.
Add a code comment immediately above/alongside `forbidden()` documenting that
`capability: "manageExtras"` is legacy diagnostic text, not the authorization source. The frontend
classifier reads `capability` only for asset-read resources, and `CollectionPanel` displays only
the error message, so no downstream behavior depends on this collection-management value.

### Validate the external link read in `CollectionPanel`

`CollectionPanel.loadLinks` currently reads links through an unvalidated
`apiGet<{ links: Link[] }>` ([`CollectionPanel.tsx` line 70](../../portal/apps/web/src/components/CollectionPanel.tsx#L70)),
so the `source` fix above is only fixture-tested — nothing structurally checks the response at
runtime, and a future projection regression could silently reintroduce the same missing-field bug
this plan exists to fix. Close that hole now; it is small and bounded:

- add `useSession()` to `CollectionPanel` and branch `loadLinks` on
  `session.data?.user.role === "external_editor"`, calling
  `externalApiGet("collection-links", path)` for the external role and leaving the existing
  `apiGet` path byte-for-byte unchanged for internal roles. This is the same pattern
  `SubtaskChecklist` (line 183), `ProjectDiscussionThread` (line 132), and `project-comments.ts`
  (lines 97 and 124) already use;
- keep the existing `loadToken` stale-response guard, the surrounding `try`/`catch`,
  `terminateOnUnauthorized`, and the error toast exactly as they are — only the fetch call changes;
- do not route the internal branch through the strict external schema. Once `source` is added the
  two shapes happen to coincide, but the internal response is free to grow fields later and must
  not start failing a `.strict()` parse when it does.

Only the read path changes. Link create/edit/reorder/delete keep their current `apiPostWithStatus`/
`apiPatch`/`apiPost`/`apiDelete` calls and their existing 200-versus-201 duplicate handling.

### Document-upload response shape — an accepted, scoped trust-boundary exception

The Floorplan/Copy document-upload routes gated by the new `canManageDocuments` helper return the
**same internal response shape to every principal**, including an `uploadExtras`-only external
editor. Concretely:

- **presign** (`collections.ts` line 406) returns
  `{ sessionId, kind, versionGroupId, version, files: { pdf, preview? } }`, and each `file` entry
  (line 404) is `{ assetId, key, ...multipart }` — the **raw R2 object key**
  (`projects/<projectId>/<collection>/<assetId>/<filename>`, `documentKey()` at line 47) plus, in
  production, the `uploadId`, `partBytes`, and the **presigned S3 multipart `partUrls`** produced by
  `createMultipartPresign` (`r2s3.ts` lines 49–54). In dev the multipart object is `null` and the
  entry degrades to `{ assetId, key, devDirect: true }`, which still carries the raw key;
- **complete** (`responseFor`, lines 124–128) returns internal asset metadata — asset ids, `kind`,
  `originalFilename`, `bytes`, `version`, `versionGroupId`, `supersedesAssetId`, `createdAt`. It
  does **not** contain an R2 key or a presigned URL;
- **abort** returns `204` with no body, and **dev direct upload** returns `204`.

This is architecturally different from the TB4E external-upload protocol
(`packages/shared/src/external-upload.ts` lines 19–26), which deliberately proxies external uploads
through same-origin `/api/external-uploads/...` paths and never exposes an R2 key or a presigned
storage URL to an external principal.

**The project owner was presented all three options — build a same-origin proxy like TB4E's, add a
safe response projection that strips the R2 key, or accept the exposure — and explicitly chose to
accept it.** Build exactly that. Do not add a proxy, do not add a projection, and do not
second-guess or silently substitute a different option: doing so would change an approved product
decision under cover of an implementation detail.

Record the decision in the code as prose, not just in this plan: add a comment above
`canManageDocuments` in `collections.ts` stating that these routes intentionally return their
internal shape to an `uploadExtras` principal and pointing at this section.

The rationale, for the reviewer who finds this later:

- It is a **deliberate, owner-approved exception** to the CLAUDE.md invariant that "the
  assignment-scoped `external_editor` role uses one external-safe server projection," scoped
  narrowly to Floorplan/Copy document uploads and to nothing else.
- Per `docs/lessons.md` ("Presigned provider uploads have two separate trust boundaries",
  2026-08-24), **a presigned object URL is already its own authorization token**. An external editor
  who has already passed `hasProjectAccess` for this project and holds `uploadExtras` is, by
  definition, authorized to write these bytes. Learning the object key and the multipart upload
  URLs *for their own upload session* grants them nothing they could not already write to, so this
  is not credential disclosure in the sense that entry warns about — no provider Bearer key, no R2
  account credential, and no other principal's or project's key is reachable. The key itself is
  derived entirely from values the uploader already supplies or receives (`projectId`, the
  collection kind, the new `assetId`, their own filename).
- The exposure is bounded by the same assignment scope as every other route here: `hasProjectAccess`
  runs before `canManageDocuments` on presign/complete, and before it on abort and dev-direct as
  part of the same condition. `ownedUpload` additionally pins complete/abort/direct to sessions
  created by that same user (`created_by = c.get("user").id`, line 131), so one external editor
  cannot even reach another external editor's session on the same project.
- The **residual risk this accepts** is that a presigned `partUrl` handed to the browser reaches the
  R2 S3 endpoint directly, so an external principal learns that endpoint's hostname and this app's
  key layout, and holds a one-hour (`PRESIGN_EXPIRES_SECONDS`) write capability for exactly those
  part numbers of exactly that key. That is the same residual risk internal Admin/Editor uploads
  already carry today; the decision is that extending it to an assigned external editor is
  acceptable.

**This exception does not extend to the four link routes.** Their responses are already minimal and
safe: `{ id, url, label, source, position, createdAt }` for create/patch (once `source` is added —
it is already present on the internal create/patch responses at lines 198 and 245), `{ position }`
for reorder, and `204` for delete. They need no projection change and must not gain one.

### Route security manifest (`terminal-route.ts`)

The checked-in manifest currently declares every route this plan opens to `external_editor` as
`"withheld"`, which `securityContractForClass` expands to
`{ scope: "none", projection: "internal", response: "constant-403" }` (line 60). After this change
all of these are reachable and can succeed for an assigned `uploadExtras` external editor, so the
declared contract would be false. Update the seed.

**Reclassify these seven entries from `"withheld"` to `"scoped"`** in
`PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED`:

| Method | Path |
| --- | --- |
| `POST` | `/api/projects/:id/documents/presign` |
| `POST` | `/api/projects/:id/documents/complete` |
| `POST` | `/api/projects/:id/documents/:sessionId/abort` |
| `POST` | `/api/projects/:id/links` |
| `PATCH` | `/api/projects/:id/links/:linkId` |
| `POST` | `/api/projects/:id/links/:linkId/reorder` |
| `DELETE` | `/api/projects/:id/links/:linkId` |

`"scoped"` is the correct legacy value: `securityClassForSeed` (lines 236–248) maps it to
`scoped-child-resource` for every path except the four project-root paths it special-cases, giving
`{ scope: "assigned-project", projection: "external-safe", response: "scoped" }`. That matches the
existing precedent of `POST /api/assets/:id/review` (line 101) — a scoped, externally reachable
mutation on a project child resource. Do **not** add an `externalSurface` tag to any of them: that
field marks a route whose external DTO is driven through
`EXTERNAL_API_RESPONSE_SCHEMAS` by the manifest test, and none of these seven has such a schema.

**Two entries stay `"withheld"`, for stated reasons:**

- `PUT /api/projects/:id/documents/direct/:sessionId/:slot` — verified: its very first statement is
  `if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);`
  (`collections.ts` line 415), which runs before any authorization check. In production this route
  is unreachable by every principal including an assigned external editor, so widening
  `canManageCollection` → `canManageDocuments` inside it changes nothing about the production
  contract. It keeps `"withheld"` because that class means "not part of the externally reachable
  production surface," which remains true. (Its class also asserts `response: "constant-403"` while
  the route actually returns a constant 404 — a pre-existing coarseness in the manifest's response
  vocabulary, unchanged by this plan and not something to fix here.)
- `POST /api/projects/:id/documents` — an unconditional `410` tombstone (`collections.ts` line 362)
  with no authorization path at all. Not part of this plan's surface.

**On the `projection: "external-safe"` claim the reclassification introduces.** Given the accepted
exposure above, presign and complete return internal-shaped bodies, so it is worth being precise
about what the manifest is asserting. Reuse `"scoped"` anyway, and do **not** invent a new manifest
class:

- The manifest already uses this exact combination for a route whose response is not an
  external-safe DTO. `GET /media/asset/:assetId/:variant` (line 216) is seeded `"scoped"` and
  therefore also declares `projection: "external-safe"`, yet it returns raw image/PDF bytes to an
  external principal and, on the internal branch, `302`-redirects to a
  `/cdn-cgi/image/.../__transform-source/<raw R2 key>` URL. There is no existing class that means
  "externally reachable, mutation-scoped, not DTO-projected," and the precedent shows the manifest
  never intended `scoped` to imply one.
- Operationally, `projection` is only *asserted* for entries carrying an `externalSurface` tag
  (`route-manifest.test.ts` line 177). For untagged `"scoped"` entries — which is what these seven
  will be — the field is a derived label with no test behind it.
- So this is a **known, accepted manifest-modeling gap**: for an untagged `scoped` route,
  `projection: "external-safe"` should be read as "no *additional* internal-only surface beyond what
  the route's own authorization already permits," not as "a projection schema is applied." The owner
  has implicitly accepted this gap by approving the underlying exposure. Record it as a comment
  beside the reclassified document entries in `terminal-route.ts`, naming the
  `GET /media/asset/:assetId/:variant` precedent, so the next reader does not mistake the label for
  a guarantee.

If a builder concludes during implementation that this modeling gap deserves a real fix (for
example a `scoped-child-resource-internal-shape` class), that is a **separate plan** — raise it,
do not fold it into this build.

### Non-goals

- No upload or management widening beyond Video, Floorplan, and Copy.
- No Floorplan/Copy link create, edit, reorder, or delete authority for `external_editor` through
  `uploadExtras`; those delivered links remain read-only on the external-editor surface.
- No grant of `editProject` or `manageExtras` to `external_editor`, and no changes to the existing
  membership of either capability for any role.
- No RAW upload change, no change to the external Edited multipart API, and no replacement of the
  existing collection link/document protocols.
- No new per-kind `uploadVideo`, `uploadFloorplan`, or `uploadCopy` capabilities.
- **No external-safe projection is built for the document-upload response shape, and no same-origin
  upload proxy is introduced for documents.** This is intentional per the accepted trust-boundary
  decision above — not deferred work, not a TODO, and not an item for a follow-up plan. A future
  build may revisit it only on a new owner decision.
- No change to the document-upload wire protocol itself: presign/complete/abort keep their current
  request schemas, multipart mechanics, TTLs, reaper behavior, `ownedUpload` ownership pinning, and
  status transitions. Only who may call them changes.
- No change to the response shape of the four link routes; they are already minimal and safe, and
  the only field added anywhere is `source` on the external link DTO.
- No new manifest class in `terminal-route.ts`, and no change to any manifest entry other than the
  seven reclassified above.

## Migration and deployment

No D1 migration is required. Capabilities are computed from the static role-to-capability arrays
in `packages/shared/src/capabilities.ts`; there is no persisted capability grant or capability
column to alter. This is a code-only capability and route/UI change, so migration number `0040`
remains available.

The implementation affects only the app Worker/frontend bundle and shared package. It does not
change background or webhook-ingress behavior. Eventual production deployment therefore needs
only the app Worker after verification, subject to the repository's normal final bundle-diff
check; no D1 preflight/postflight or migration recovery export is needed.

## Test impact

### Delete with retired modal-only production code

- Delete
  [`ProjectQuickDetailSheet.dom.test.tsx`](../../portal/apps/web/src/components/ProjectQuickDetailSheet.dom.test.tsx#L1)
  and
  [`computeSheetVisible.test.ts`](../../portal/apps/web/src/components/computeSheetVisible.test.ts#L1)
  with the modal.
- Delete
  [`ProjectOverviewView.dom.test.tsx`](../../portal/apps/web/src/components/ProjectOverviewView.dom.test.tsx#L1)
  and
  [`project-overview.test.ts`](../../portal/apps/web/src/lib/project-overview.test.ts#L1)
  with the modal-only Overview presenter/helper. **Resolved in the final review pass — delete them;
  do not retain an unreferenced component.** A repository-wide search for `ProjectOverviewView`,
  `project-overview`, and `overviewPresentation` across `apps`, `packages`, and `workers` returns
  only: `ProjectOverviewView.tsx` and `project-overview.ts` themselves, their two own test files,
  and `ProjectQuickDetailSheet.tsx` (its import at line 8 and its render at line 149) plus that
  sheet's test mock — every one of which this plan deletes. Full Workspace presents the same
  information through the separate, live `ProjectOverviewRail`.

### Update existing navigation, route, and capability tests

- Rewrite
  [`Dashboard-calendar.dom.test.tsx`](../../portal/apps/web/src/screens/Dashboard-calendar.dom.test.tsx#L16)
  to remove the sheet mock/origin/failure assertions and assert that List, Kanban, scheduled
  Calendar, disclosure, and unscheduled project anchors all target `/projects/:id`; an ordinary
  Calendar click must push that same Full Workspace route while drag suppression and modified
  clicks stay covered.
- Update
  [`Dashboard-stage-interactions.dom.test.tsx`](../../portal/apps/web/src/screens/Dashboard-stage-interactions.dom.test.tsx#L1115)
  so the external-editor Kanban card assertion finds the Full Workspace href rather than a
  `?detail=` facet.
- Update
  [`ProductionCalendarEvent.dom.test.tsx`](../../portal/apps/web/src/components/ProductionCalendarEvent.dom.test.tsx#L87)
  to use canonical Full Workspace href fixtures while retaining its ordinary/modified click,
  keyboard, and drag-threshold assertions.
- Remove quick-detail guard/suppression cases and mock props from
  [`App.dom.test.tsx`](../../portal/apps/web/src/App.dom.test.tsx#L5); retain Calendar authorization
  and all `?collaboration=open` one-shot tests. Add a closed-route assertion that a former
  `?detail=` location no longer mounts Dashboard as a valid canonical route.
- Replace the quick-detail stripping/focus cases in
  [`PrincipalFreshnessBoundary.dom.test.tsx`](../../portal/apps/web/src/components/PrincipalFreshnessBoundary.dom.test.tsx#L135)
  with the still-relevant Full Workspace access-loss/tombstone cases; no invalid legacy route
  should be treated as a live Dashboard project surface.
- Remove quick-detail OAuth round trips from
  [`router.test.ts`](../../portal/apps/web/src/lib/router.test.ts#L158), and rewrite
  [`staff-routes-dashboard-facet.test.ts`](../../portal/packages/shared/test/staff-routes-dashboard-facet.test.ts#L1)
  around List/Kanban/Calendar-only round trips plus explicit rejection of `detail` and
  `detailView`. Keep the existing `collaboration=open` acceptance/rejection matrix.
- Update
  [`capabilities.test.ts`](../../portal/packages/shared/test/capabilities.test.ts#L1) to remove
  every `viewQuickDetail` assertion, add `uploadExtras` to the catalogue and exact external role
  allow-list, assert `external_editor` still lacks `editProject`/`manageExtras`, and assert the
  Admin/Editor/Photographer lists have no other membership changes. Keep
  `expect(EXTERNAL_EDITOR_CAPABILITIES).toHaveLength(12)`: removing `viewQuickDetail` and adding
  `uploadExtras` leaves that exact length coincidentally unchanged.
- Update the external `/api/me` exact capability expectation in
  [`api.test.ts`](../../portal/workers/app/test/api.test.ts#L879) from `viewQuickDetail` to
  `uploadExtras`.

### Add Collaboration Activity coverage

- Extend
  [`ProjectCollaborationPanel.dom.test.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx#L158)
  with semantic tab assertions, roving Arrow/Home/End keyboard behavior, Discussion default/reset,
  close/reopen retention, and overlay-versus-standalone markup. Assert the checklist and thread
  remain in Discussion, Activity receives the project id, the Activity query is disabled while
  hidden/closed, and Discussion read-marker presentation pauses while Activity is selected. Add a
  warm-mount case that selects Activity, consumes a new `?collaboration=open` signal without
  changing `projectId`, and resets to Discussion before acknowledging the signal. Assert both
  content panels carry `role="tabpanel"`, an `id` matching their tab's `aria-controls`, and
  `aria-labelledby` pointing back at that tab.
- Add a read-marker **re-arm** case to the same file: select Activity (Discussion's `presented`
  goes `true → false`, pausing its read marker), then switch back to Discussion and assert the
  presentation coordinator re-arms — `ProjectDiscussionThread` passes `presented` straight into
  `useProjectCommentPresentation({ open: presented })` (line 89–93) and as the presentation
  argument of `useProjectCommentsQuery` (line 97), so a `false → true` transition must resume
  read-marker advancement rather than leaving it latched off for the rest of the overlay's life.
  Cover the full round trip (Discussion → Activity → Discussion), not just the pause.
- Add `ProjectActivityView` cases for the split error branch: an `ApiError` 403 and an `ApiError`
  404 each render the permanent-denial message with **no** Retry button and do not surface the raw
  server message, while a 500/network error keeps today's message-plus-Retry presentation. Assert
  the 30 s poll is suppressed in the permanent-denial state and still active for a transient
  error — for example by advancing fake timers past 30 s and counting fetches.
- Extend
  [`ProjectWorkspace.dom.test.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.dom.test.tsx#L706)
  to prove Activity 403 and 404 render inside the selected Activity tab without purging
  Discussion, selecting `collaboration-unavailable`, or replacing either the surrounding full
  Workspace or collaboration-only standalone page. Assert only Activity 401 is forwarded to the
  parent and reaches the existing principal/session termination path. Keep proof that
  `?collaboration=open` opens the panel on Discussion.
- Update the focused classifier matrix in
  [`project-data.test.ts`](../../portal/apps/web/src/lib/project-data.test.ts#L76) so Activity 401
  remains principal-scoped while Activity 403 and 404 return `null` and cannot become page- or
  panel-level terminal classifications.
- Rewrite the authorization expectations in
  [`project-activity.test.ts`](../../portal/workers/app/test/project-activity.test.ts#L135): Admin
  remains admitted globally; assigned Editor and External Editor receive 200; an assigned
  Photographer in a photographer-visible stage receives 200; an assigned Photographer outside
  those stages receives the retained project-visibility 404; unassigned internal users receive
  403; external
  unassigned/nonexistent/archived-out-of-scope cases remain byte-identical 404; anonymous remains
  401; bare/trailing-slash responses remain equivalent. Preserve query-grammar, cursor,
  projection, external event-filter, and query-plan coverage.

### Add external collection read/upload coverage

- Expand the assigned external-editor integration block in
  [`api.test.ts`](../../portal/workers/app/test/api.test.ts#L883) with representative assets in all
  five collections. For Video/Floorplan/Copy, assert external-safe asset lists and original media
  return 200 only for the assigned project, while equivalent unassigned direct/list requests stay
  denied without leaking project existence. Assert the retained external direct-review write
  guard still returns 404 for Video/Floorplan/Copy assets. Assert RAW/Edited annotation-markup
  media remains available according to its existing rules, while an external editor's direct
  markup fetch for an annotation attached to a
  Video/Floorplan/Copy asset is denied even if a legacy/inconsistent row exists; keep
  extra-collection annotation create/edit/delete denied as well.
- In the collection link/document tests around
  [`api.test.ts:3460`](../../portal/workers/app/test/api.test.ts#L3460), add an external assigned
  principal that can create/edit/reorder/delete a Video link and
  reserve/direct-upload/complete/abort Floorplan and Copy documents through the surface-specific
  helpers. Assert its external-safe GET-link responses include `source` and pass the strict shared
  response schema for both manual and Tonomo links. Assert that the same `uploadExtras`-only
  principal gets 403 for Floorplan/Copy link creation, 404 for PATCH and reorder because their
  lookups are Video-pinned, and 404 for DELETE by the deliberate nonexistence/wrong-kind
  indistinguishability rule; a random nonexistent DELETE id must produce the same status/body as
  an existing wrong-kind id. Add a same-role unassigned-project denial and a
  Photographer denial. Assert these calls do not make project-edit, membership, deadline,
  Calendar scheduling, cover, archive/delete, RAW upload, or Admin routes accessible.
- Add a frontend capability case in
  [`ProjectWorkspace.dom.test.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.dom.test.tsx#L391)
  showing `uploadExtras` alone exposes Video link-management controls and Floorplan/Copy document
  upload/version controls while Floorplan/Copy delivered links stay read-only and Edit Project,
  RAW upload, Edited upload, cover, extras Approve/Unapprove, and danger-zone controls remain
  absent for `external_editor`.
- Extend
  [`CollectionPanel.dom.test.tsx`](../../portal/apps/web/src/components/CollectionPanel.dom.test.tsx#L140)
  with an external-shaped GET fixture containing only the strict external link DTO fields,
  including the new `source`. After a reload, manual links must retain Manual/Edit/Remove,
  Tonomo links must retain Tonomo and omit Edit/Remove, and both may still participate in Video
  reorder when `canManage` is true. Do not use an internal response fixture or a client default for
  `source`; also cover create followed by reload so controls do not appear only transiently from
  the POST response.
- In the same file, cover the new `externalApiGet("collection-links", …)` read path added in §5's
  *Validate the external link read in `CollectionPanel`*: with an `external_editor` session an
  external-shaped GET response parses and renders, and a response **missing `source`** now fails
  loudly at the client boundary instead of silently degrading the Edit/Remove affordances. Assert
  an internal-role session still goes through the unchanged `apiGet` path and is unaffected by the
  strict schema, and that the `loadToken` stale-response guard still discards an out-of-order load.
- Preserve and, where useful, strengthen the annotation boundary in
  [`api.test.ts`](../../portal/workers/app/test/api.test.ts#L921): external RAW/Edited annotation
  behavior remains supported, while Video/Floorplan/Copy annotation create/edit/delete remains
  rejected.

### Add route security manifest coverage (B-1)

- Extend [`route-manifest.test.ts`](../../portal/workers/app/test/route-manifest.test.ts#L235) with
  a **positive reachability** assertion for each of the seven newly `"scoped"` routes, using the
  file's existing assigned external-editor session (`externalCookie()` on `manifestProjectId`, where
  that user already has a `project_members` row) once `external_editor` holds `uploadExtras`.
  Each probe must send a **real, valid request body — not `{}`** — and assert a genuine
  success-or-domain response rather than merely "not 403":
  - `POST /links` with `{ collection: "video", url: "https://vimeo.com/…", label: "…" }` → 201 (or
    200 on the deliberate duplicate path), and the body carries `source: "manual"`;
  - `PATCH /links/:linkId` and `POST /links/:linkId/reorder` against the link just created → 200
    with the documented body;
  - `DELETE /links/:linkId` against that link → 204;
  - `POST /documents/presign` with a valid `copy_pdf` (and a `floorplan` variant) payload → 201 with
    a `sessionId` and `files.pdf`;
  - `POST /documents/complete` for that session → its documented completion or verification-failure
    response, and `POST /documents/:sessionId/abort` → 204.

  The point of the "real body" requirement is that the existing withheld probe stays green purely by
  accident: an empty `{}` body fails schema validation (or a random id fails lookup) *before* the
  authorization check runs, so a `>= 400` assertion proves nothing about the security contract.
  Verified against current code — that is exactly why the stale `"withheld"` declaration would not
  have been caught.
- Keep the existing "returns a non-success response for every withheld manifest route" test intact.
  After the reclassification it no longer covers these seven, and `PUT /documents/direct/...` and
  `POST /documents` must still fail it.
- Assert `PUT /api/projects/:id/documents/direct/:sessionId/:slot` remains manifest-`"withheld"` and
  that a production-mode request to it returns 404 regardless of principal, so the dev gate stays
  the reason it is exempt.

### Confirm the accepted document-upload exposure behaves as decided (B-2)

- Add an `api.test.ts` case asserting the **accepted** behavior, not preventing it: an assigned
  `uploadExtras` external editor calling `POST /documents/presign` for their own project receives
  the **same response shape as an internal Admin/Editor** — `sessionId`, `kind`, `versionGroupId`,
  `version`, and a `files.pdf` entry containing `assetId` and the raw `key` (plus multipart fields,
  or `devDirect: true` under the test environment's `APP_ENV`). Do the same for
  `POST /documents/complete`: identical `responseFor(...)` shape for both principals. Write the
  assertion so it reads as a deliberate contract check with a comment pointing at §5's
  *Document-upload response shape*, so a later reader does not "fix" it as a leak.
- Alongside it, keep/extend the containment proof: the same external principal gets the generic
  404/403 for a presign, complete, or abort against **any other** project (unassigned, archived,
  nonexistent), cannot reach another user's upload session on the *same* project (`ownedUpload`
  pins `created_by`), and gains no route outside `collections.ts` — reassert the existing
  project-edit, membership, deadline, Calendar scheduling, cover, archive/delete, RAW upload, and
  Admin denials in the same block.

### Confirm external-actor Activity events stay safe for the widened internal audience

- Section 3 widens Activity reads to assigned photographers, and section 5 lets an external editor
  author link create/patch/reorder/delete and document-complete events (emission sites:
  `collections.ts` lines 183, 224, 287, 344, and 467). Add an assertion that these
  external-actor-sourced events carry nothing sensitive to an internal reader. Verified while
  writing this plan: their `safePayload` schemas are
  `{ linkId, collectionKind: "video" }`, `{ linkId, collectionKind, changedFields }`,
  `{ collectionKind, count }`, and `{ collectionKind, version, assetCount }`
  (`packages/shared/src/project-activity.ts` lines 92–96), and the rendered copy is the generic
  "Video links updated" / "Document upload completed" pair at lines 464–468 — no AutoHDR, provider,
  watch-folder, R2-key, filename, or URL data is present in any of them. The test is therefore a
  **regression lock on an already-safe shape**, not a fix: assert an assigned Photographer reading
  Activity after an external editor performs each of these five mutations sees only those generic
  titles/bodies and payload keys, and that no `key`, `r2Key`, `pdfKey`, `url`, or filename value
  appears anywhere in the serialized feed.

## Verification before commit

From `portal/`, the eventual build must pass the repository's complete required sequence:

1. `npm run typecheck`
2. `npm run build -w @quincy/web`
3. `npm run test --workspaces`
4. `npx vitest run --config packages/shared/vitest.config.ts`

Before review, also run repository-wide searches for `ProjectQuickDetailSheet`,
`PROJECT_QUICK_DETAIL_VIEWS`, `ProjectQuickDetailView`, `ProjectOverviewView`,
`overviewPresentation`, `computeSheetVisible`, `viewQuickDetail`, `DashboardQuickDetail`,
`DASHBOARD_QUICK_DETAIL_VIEWS`, `detailView`, `suppressQuickDetail`, and `onProjectAnchorClick`;
every result should be gone except historical documentation.

`PROJECT_QUICK_DETAIL_VIEWS` and `ProjectQuickDetailView` are both exported from
`ProjectQuickDetailSheet.tsx` (lines 10–11), the file being deleted, and `ProjectQuickDetailView` is
imported at [`Dashboard.tsx` line 37](../../portal/apps/web/src/screens/Dashboard.tsx#L37)
(`import { ProjectQuickDetailSheet, computeSheetVisible, type ProjectQuickDetailView } from …`) and
used at line 639 by `changeQuickDetailView`; both also appear in
`ProjectQuickDetailSheet.dom.test.tsx`, which this plan deletes. Verified: those are the only
production and test references — omitting either name from the search list would let a dangling
import survive the deletion.

Search every `uploadExtras` use and confirm it is limited to the shared declaration/allow-list,
tests, `collections.ts`, and the Workspace `canManageCollections` check. Search `editProject` and
`manageExtras` role arrays to confirm no membership changed. Finally, diff
`PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED` and confirm exactly seven entries moved `"withheld"` →
`"scoped"`, that no `externalSurface` tag was added, and that
`PUT /api/projects/:id/documents/direct/:sessionId/:slot` and `POST /api/projects/:id/documents`
still read `"withheld"`.
