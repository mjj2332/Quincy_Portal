# TB6 build handoff — resume at Slice 3b

**Written 2026-08-31.** For a fresh session continuing the TB6 build. The approved plan is
`docs/plans/Revamp-TB6-Project-Card-Detail-And-Discussion-Plan.md` (APPROVED FOR BUILD, Opus
plan-tier). This file records the current build state, the refinements made since the plan was
approved, the pipeline mechanics, and the remaining slice specs.

---

## 1. Current state

- **Branch:** `tb6-project-card-detail` (off `main` @ `6b8a5e0`). Working tree clean.
- **Commits so far** (`git log --oneline main..HEAD`):
  | | commit | summary |
  |---|---|---|
  | plan | `8c51258` | approved implementation plan |
  | Slice 0 | `5904f20` | migration `0038` (activity feed index) + characterization baseline + `docs/plans/tb6/slice-0-inventory.md` (22-row TB4C producer inventory) |
  | Slice 1 | `4af8a63` | closed Dashboard routing grammar (`DashboardRoute` 3-arm union, per-arm allow-lists, `parseDashboardQuery` preamble, temporary `App.tsx` handoff) — **no affordance retarget** |
  | Slice 1 | `85ba4ad` | Slice 1 test hardening (resumed Sol review — test-only findings) |
  | Slice 2 | `e85c528` | `viewQuickDetail` capability (11→12) + `GET /api/projects/:id/activity` + strict feed schemas + base64url cursor codec + **unmounted** `useProjectActivityQuery` hook |
  | Slice 3a | `180d49b` | `{kind:"activity"}` resource + `classifyProjectAccessError`; `requestInvalidation`; `invalidateProjectSurfaces` coordinator; `PrincipalFreshnessBoundary` route-aware access-loss close; 4 barrier producer seams wired |
- **§5 gate baseline at `180d49b`** (all green): `npm run typecheck` (6 ws); `npm run test -w @quincy/web` = 208 node + 547 dom; `npm run test -w @quincy/db` = 114; `npx vitest run --config packages/shared/vitest.config.ts` = 147; `npm run test -w @quincy/worker-app` = 287 (+1 skip); `npm run test -w @quincy/worker-background` = 253; `npm run test -w @quincy/worker-webhook-ingress` = 13; `npm run build -w @quincy/web` ok; `cd packages/db && npx drizzle-kit generate` = no-op.
  - The `worker-app` suite prints an `uncaught exception ... RAW Dropbox unavailable` line — **pre-existing harness artifact, not a failure** (present on `main`). All 21 files pass.
- **Nothing is user-visible yet.** The sheet does not exist. List/Kanban/Calendar render exactly as before Slice 0. The activity endpoint is live but nothing calls it. The invalidation coordinator runs at existing mutation sites (converging Dashboard/Calendar/Workspace freshness and adding `activity` invalidations).
- **Migration `0038` is committed but NOT applied to prod** — prod D1 still ends at `0037`. Applied at deploy (Slice 5).

---

## 2. Refinements made during build (differ from the approved plan text)

The plan was approved; these are decisions taken while building that supersede or sharpen it. Carry
them forward.

1. **Slice 3 is split into 3a (this handoff's predecessor) and 3b.** 3a = the freshness/coherence
   infrastructure + the 4 barrier-having producer seams. 3b = the Overview presentation selector,
   the Overview/Activity view components (still unmounted), and wiring the coordinator into the
   remaining ~18 producer sites. This keeps each Luna pass tractable; the plan's Slice 3 acceptance
   is met once both land.

2. **`invalidateProjectSurfaces` has a `producer?: "dashboard" | "calendar"` param** (D6 in the plan
   said "the sender also invalidates its own active … Dashboard/Calendar queries" — superseded by
   Opus S3 + the Sol 3a review). Semantics: for each true `dashboard`/`calendar` flag, the coordinator
   invalidates that surface's active in-tab queries via `requestInvalidation` **unless**
   `producer === that surface`, and **always** publishes the surface's cross-tab message. The
   producing surface (the one that did the drag) owns its single settle refetch
   (`Dashboard.tsx` `queuedRefreshRef`, `ProductionCalendar.tsx` `refetchAuthoritative`), so its own
   key is not re-invalidated here — but other tabs still get the broadcast. `invalidateProjectSurfaces`
   `await`s the non-producing surface invalidations before returning.

3. **`ProjectQueryRuntime.invalidateOrDefer` was renamed to public `requestInvalidation(queryKey):
   Promise<void>`** (Opus B7). It now returns a promise: `Promise.resolve()` when deferred
   (owned / ledger-pending), else the `queryClient.invalidateQueries(...)` promise.
   `invalidateProjectResources` routes its immediate invalidations through it and `await`s them for
   unowned keys — **local senders are now owner-deferred for the first time** (a local `subtasks`
   invalidation while `SubtaskChecklist` holds `acquireOwner(subtasks)` during drag/schedule-popover,
   or a local `detail` invalidation while `ProjectDeadlineControl` holds `acquireOwner(detail)`, now
   defers until release). The Slice-0 baseline test
   `apps/web/src/lib/project-invalidation-tb6-baseline.test.ts` was updated to assert this.

4. **`CANONICAL_LOWERCASE_UUID_REGEX` is exported from `packages/shared/src/staff-routes.ts`** and
   reused by `project-activity.ts` / `project-activity-feed.ts` (Slice 2 fix round). Deferred to the
   Slice-5 whole-branch review: whether `staff-routes.ts` is the right home vs a dedicated
   `uuid.ts` leaf module (see §5 deferred list).

5. **The Activity feed's `nextCursor` degraded mode** (Slice 2): if the `rows[limit-1]` boundary
   row's `id` is not a canonical UUID, the handler walks backward to an earlier encodable row
   (bounded ≤49 rows). Every crossed row also fails the feed parser, so raw fetched rows may repeat
   across pages but feed *items* never duplicate. All real IDs are `crypto.randomUUID()`; a Slice-5
   pre-deploy precondition audits `project_activity_events.id` (added to the plan's Slice 5
   preconditions).

6. **The external Activity feed body uses `projects.street` as the project label** (via a new
   `projectLabel` field on `VisibleProjectContext` from `resolveVisibleProject`). Sol confirmed
   this is A14-acceptable (address is in the external-safe projection). `externalProjectActivityFeedItemSchema.type`
   is constrained to the 19 `live ∩ allowed` types (`EXTERNAL_ACTIVITY_FEED_TYPES`), not just the
   SQL predicate.

7. **The temporary `App.tsx` handoff from Slice 1 is still in place** — it replaces every explicit
   List/Kanban route and Calendar quick-detail facet to a backing route, because `Dashboard.tsx`
   does not consume `dashboardView` yet. **Slice 4 removes it** and makes `Dashboard.tsx` consume
   `dashboardView` (the D2 URL-owned List/Kanban transition contract). Look for the comment
   `// TB6 Slice 1 temporary` in `App.tsx`.

8. **The Slice-1 Calendar URL grammar tightened**: hand-typed non-canonical percent spellings
   (`%20` for space, literal `,` in `layers`) now 404. Serializer-canonical Calendar URLs are
   unaffected (verified: `calendarPathFor` emits `+`/`%2C`). Recorded in the Slice 1 commit body.

9. **D6's planned new `acquireOwner` seams on `Dashboard.tsx`/`ProductionCalendar.tsx` were never
   built** (flagged by the Opus final-draft review, 2026-08-31). The plan's D6 section calls for
   Dashboard/Calendar to acquire ownership of their own `dashboardProjectsKey`/range keys during
   `interactionBlocked`/drag-settle, deferring any invalidation that arrives mid-interaction from a
   cross-tab broadcast or a different local producer. What shipped instead is only the `producer`
   param (item 2 above), which suppresses the *producing* call's own in-tab invalidation but does
   nothing for an invalidation arriving from elsewhere mid-drag. **Accepted as-is, not a bug**:
   `Dashboard.tsx` already refuses to adopt query data while `interactionBlocked` (queues a refresh
   instead) — the same guard `main` already has — so no drag reset or mid-interaction data adoption
   is possible either way; this matches pre-TB6 behavior exactly. The only cost is that in the rare
   concurrent case (another producer commits while a drag is in flight) the Board/Calendar key can
   refetch once mid-drag (result discarded by the interaction guard) and again at settle, instead of
   exactly once — a minor efficiency gap, not a correctness one. Not worth adding two new ownership
   seams to live drag surfaces the day before deploy for a discarded-refetch savings; revisit only if
   a future slice needs true single-refetch guarantees under real concurrency.

---

## 3. Pipeline mechanics

Follow `docs/Subagent-Orchestration.md`. Summary for this build:

- **Per slice:** Luna (`codex exec`, `-m gpt-5.6-luna -c model_reasoning_effort=xhigh`,
  `--sandbox workspace-write`) builds → fresh-Sol (`-m gpt-5.6-sol -c model_reasoning_effort=medium`,
  `--sandbox read-only`) **mid-slice** diff review → Luna fix round(s) → fresh-Sol **confirm** review
  → the orchestrating session re-runs the **full §5 gate** independently → commit. Sol review is
  capped at 2 rounds per slice (mid + confirm); residual fixes after that are applied by the
  orchestrating session directly.
- **Spec files:** write each Luna/Sol spec to a scratchpad `.md` first, pipe via stdin
  (`cat spec.md | codex exec ...`), capture the report with `--output-last-message`. Lead every spec
  with a **DIRECTIVE block** ("this run IS gpt-5.6-{sol|luna} at {medium|xhigh}; do NOT invoke the
  Sol Advisor gate; proceed directly").
- **Luna cannot run** `workers/app` / `workers/background` vitest (sandbox EPERM) — it verifies
  typecheck + web + shared + db; the orchestrator runs the worker suites.
- **Codex failure modes seen on this workspace (all transient, all recoverable):**
  - `ERROR: Your workspace is out of credits` — Terry tops up; `codex exec resume <session-id>`
    continues a dead review from where it stopped. Happens every ~2-3 runs.
  - `ERROR: Selected model is at capacity` — OpenAI-side load; retry after ~30s.
  - Both leave no report file. Check `grep -c "out of credits\|at capacity" <run.log>` after every run.
- **Do NOT** `run_in_background: true` on a Bash command that itself ends with `&` — it double-detaches
  and orphans the codex process (no task notification). Either background the bare `codex exec`
  invocation with `run_in_background: true` and no `&`, or foreground it.
- **Opus** touchpoints: plan-tier review (done, APPROVED) and the final-draft review at Slice 5
  (`Agent` tool, `model: opus`). No Opus in Slices 1-4.
- **Agy** (local-dev functional QA) runs at Slice 5 only, per the plan's Agy matrix.
- **§5 gate command** (run from `portal/`):
  ```
  npm run typecheck
  npm run build -w @quincy/web
  npm run test -w @quincy/web
  npm run test -w @quincy/db
  npx vitest run --config packages/shared/vitest.config.ts
  npm run test -w @quincy/worker-app
  npm run test -w @quincy/worker-background
  npm run test -w @quincy/worker-webhook-ingress
  cd packages/db && npx drizzle-kit generate   # must be a no-op
  ```

---

## 4. Slice 3b — scope + spec skeleton

**Goal:** the read-model UI (still unmounted) + finish the D6 producer wiring. No sheet, no
discussion extraction, no anchor retargeting, no `Dashboard.tsx dashboardView` consumption — those
are Slice 4.

### 4.1 Overview presentation source (plan D5)

- Web `ProjectDetail` type (`apps/web/src/lib/project-data.ts:13`) currently under-declares
  `priority` and `timeWindow` — the internal `/api/projects/:id` route **already returns them**
  (`packages/db/src/project-projections.ts:19,22` → `routes/projects.ts#details`). Extend the web
  transport type narrowly for those two fields. **Do NOT widen the External detail schema** with
  `priority` (A14 excludes it; the external Overview omits the Priority row).
- A small pure `overviewPresentation(detail, role)` selector that emits only: address + safe project
  summary; role-presented Stage; internal Priority when present (omitted for `external_editor`);
  role-safe team rows; Deadline state + next reminder / due-now summary + reminder offsets (all
  already in the deadline DTO). No new endpoint, no new store, no `collaboration-summary` fetch.

### 4.2 Overview + Activity view components (unmounted)

- `OverviewView` and `ActivityView` reusable components with role-correct empty / loading / error /
  retry states. Activity: cursor pagination via `useProjectActivityQuery` (Slice 2), timestamps,
  system-actor presentation (`actor: null` → generic), **no mutation controls**.
- Per D5's per-view matrix: Overview/Activity are gated only by `viewQuickDetail` + project
  visibility (`resolveVisibleProject`); an internal Editor non-member gets 200 on both. Discussion
  (Slice 4) is the narrower one.
- These components are NOT rendered anywhere yet. Add them + their tests; a `ProjectQuickDetailSheet`
  shell that composes them can be stubbed but not routed/mounted until Slice 4.

### 4.3 Finish the D6 coordinator wiring (the remaining ~18 producer sites)

The Slice-0 inventory (`docs/plans/tb6/slice-0-inventory.md`) is the authoritative list. Slice 3a
wired: Stage move (Dashboard board + Workspace rail), Deadline (rail), checklist
(`SubtaskChecklist` add/update/remove), and the Calendar container's 2 settle paths. **Slice 3b
wires the rest** with additive `invalidateProjectSurfaces` calls after each mutation's
authoritative success, using the resources + `dashboard`/`calendar` flags + `producer` from the
matrix below (derived from the inventory; `producer` is only ever `"dashboard"` or `"calendar"`
when the mutation is performed *on* that surface — none of these are):

| Producer | file / handler | resources | dashboard | calendar |
|---|---|---|---:|---:|
| `project.team.member_added` / `_removed` | `ProjectTeamControl.tsx` add/remove | `detail`, `collaboration-summary`, `activity`; `+ subtasks` when `subtaskAssignmentsCleared > 0` | yes | yes |
| initial roster (`project.team.member_added`) | `CreateProject.tsx#submit` | — (no active project cache) | yes (a row is added) | yes |
| `project.details.changed` | `EditProject.tsx#submit` | `detail`, `activity` | yes | yes |
| `project.archived` / `project.restored` | `EditProject.tsx#archiveProject` / `#restoreProject` | `detail`, `activity` | yes | yes |
| `project.priority.changed` | `Dashboard.tsx#setProjectPriority` | `detail`, `activity` | yes (`producer: "dashboard"` — Board is the sender, self-refreshes) | no |
| `project.comment.created` / `_edited` / `_deleted` | `ProjectCollaborationPanel.tsx` (its comment handlers) | `comments`, `activity`; `+ comment-read-marker` on create/delete | no | no |
| `project.collection.video_link_added` / `_removed` | `CollectionPanel.tsx#addLink` / `#removeLink` → `ProjectWorkspace#onLinksChanged` | `activity` **only** (they already invalidate `detail` via `onLinksChanged`; TB6 *adds* `activity`) | no | no |
| `project.collection.video_link_changed` / `_reordered` | `CollectionPanel.tsx#saveEdit` / `#reorderLinks` | `activity` only (these do NOT call `reportLinksChanged` on `main` — see inventory) | no | no |
| `project.collection.document_completed` | `CollectionPanel.tsx#uploadCopy` / `#uploadFloorplan` → `ProjectWorkspace#onDocumentsChanged` | `activity` (they already invalidate `detail`+`assets`) | no | no |
| `project.workflow.manual_edited_ready` | background Workflow — **no browser sender** | Activity converges via its own 30s poll; no coordinator call | — | — |
| `project.collection.raw_sync_completed` | background — no browser sender | Activity converges via its own poll | — | — |

Notes:
- The comment producers need the coordinator too (Slice 3a only wired checklist, not comments).
  Add `activity` to `ProjectCollaborationPanel`'s existing `invalidateProjectCommentResources([...])`
  calls, or an `invalidateProjectSurfaces({resources: ["comments", "activity", ...], dashboard:false, calendar:false})`
  after each. Note `ProjectCollaborationPanel` is also the extraction source for Slice 4 — be
  careful the wiring survives the extraction (or do the wiring on the extracted core in Slice 4;
  document whichever you choose).
- For any producer that ALREADY invalidates `detail` (video links via `onLinksChanged`, documents),
  TB6 only *adds* `activity` — it must NOT remove the existing `detail` invalidation.
- `CreateProject` has no active project cache to invalidate; it navigates to the new Workspace.
  It should still broadcast Board + Calendar (`dashboard: true, calendar: true`) so an open Dashboard
  in another tab shows the new project.

### 4.4 Tests

Per-producer: the additive `invalidateProjectSurfaces` call fires with the expected resources/flags
after success; existing behaviour intact. Overview: cold/direct load; internal Priority vs External
omission; Stage presentation; team/deadline summaries. Activity component: polling + pagination;
system vs user actor; empty/error/retry. Re-run the **External-Editor shared-projection regression
gate** (the plan lists it as a release gate — Activity joined the external surface in Slice 2).

### 4.5 Slice 3b review checkpoints

Mid-slice Sol: DTO reuse vs duplication; the producer wiring completeness against the inventory;
whether the comment-producer wiring conflicts with the Slice-4 extraction. Confirm Sol: fixes +
the External projection gate re-run.

---

## 5. Slice 4 — scope outline (do after 3b)

Plan Slice 4. The big one for user-visible behaviour.

- **Extract the comment-thread / read-state / composer core from `ProjectCollaborationPanel.tsx`**
  (it renders `<SubtaskChecklist>` inline — the extracted core must be discussion-only). The
  Workspace panel keeps checklist + discussion unchanged. TB6 renders the extracted discussion core
  alone.
- **`sheetVisible` + read advancement:** compute `presented = detailView === "discussion" && sheetVisible`
  and pass it as `open` to the existing `useProjectCommentPresentation` coordinator
  (`project-comments.ts:292` — its gate list is open ∧ doc visibility ∧ focus ∧ intersection ∧
  non-zero geometry ∧ scroll-root intersection ∧ generation ∧ non-tombstoned; `mode="standalone"`
  does NOT attach a `scrollRootRef` today — TB6 supplies its own). Hidden Overview/Activity tabs
  must never fetch-to-advance or PATCH the read marker.
- **Per-view authorization matrix (plan D5):** an internal Editor non-member gets Discussion **403**
  (via `hasProjectCollaborationAccessForUser`) — non-terminal per-view state: render "No discussion
  access" + no composer, do NOT purge Overview/Activity, do NOT tombstone/close/strip the facet.
  `classifyProjectAccessError` for `comments` maps a 403 to `{scope:"collaboration"}` → the
  Discussion view must intercept the expected 403 and NOT pass it into the collaboration purge path.
- **Build + route + mount `ProjectQuickDetailSheet`** in Dashboard: 3 separate views, modal
  `role="dialog"` `aria-modal`, focus trap, desktop right-side sheet / phone `100dvh`, focus
  save/restore, Escape ↔ Close, scroll lock + containment, per-tab draft/scroll preservation,
  tablist with roving arrow keys, unread count without colour, `InternalLink` to `/projects/:id`.
- **Remove Slice 1's temporary `App.tsx` handoff**; make `Dashboard.tsx` consume `dashboardView`
  (D2 transition contract — names `view` init/reconciliation, `initializeDashboardView`,
  `lastNonCalendarViewRef`, the `quincy:dashboard:view` write, `calendarFallbackLocationRef`).
- **Retarget** Admin/internal-Editor/External-Editor List + Kanban affordances to canonical
  quick-detail anchors (List row + Kanban card are already `InternalLink`s — change the `to`).
  **Calendar is a NEW anchor** (`ProductionCalendarEvent.tsx` has no project anchor today) —
  introduce a plain anchor inside each draggable FullCalendar event with drag-vs-click / Enter /
  Space disambiguation; Move/Reschedule/Schedule controls stay outside it. **Calendar sheet-open
  uses a separate facet-only writer, not `navigateCalendar`** (which returns early while
  `calendarInteractionBlocked`).
- **Thread `detail`/`detailView` through every Calendar URL writer** (Opus B4 — there are FOUR:
  `navigateCalendar`, the debounced-search path, `reconcileAppliedCalendarFilters`, and the
  saved-view restoration writer at `Dashboard.tsx:275`). Each must still satisfy
  `safeStaffDestination(built) === built`.
- **`App.tsx` capability guard** modelled on the shipped `calendarBlocked` guard: a Photographer
  (or any non-`viewQuickDetail` holder) direct URL / OAuth return / Back/Forward into a quick-detail
  facet is replaced to the backing Dashboard route before any sheet query mounts — NOT a tombstone/
  purge.
- **Wire `activity` into the extracted discussion core's post/edit/delete invalidations.**
- **Live-browser recheck** the `RichTextEditor` `onUpdate`/value-sync no-op-transaction race
  (happy-dom can't prove it — see `docs/lessons.md`).
- Matched D-16 visual evidence at 1440×900 / 1024×768 / 390×844 for all 3 views + states.

---

## 6. Slice 5 — whole-branch proof + release (do after 4)

Plan Slice 5. Key points:
- Two **scoped** whole-branch Sol reviews (≤120k tokens each — big ones exhaust credits on this
  workspace): pass A = migration/shared/server/security/projection; pass B = routing/web/freshness/
  discussion/a11y. Then Opus final-draft review.
- Agy local-dev functional QA (danger/YOLO), per the plan's Agy matrix.
- **Deferred items to resolve or explicitly accept in this slice:**
  - N2 (Slice 1): extract a shared quick-detail-facet parser from `staff-routes.ts` (the
    `detail`/`detailView` validation is duplicated between the List/Kanban arm and the inline
    Calendar block in `parseStaffLocation`). Touches the security parse path — deserves its own
    review pass.
  - `CANONICAL_LOWERCASE_UUID_REGEX` home: `staff-routes.ts` vs a dedicated leaf `uuid.ts`.
  - The Activity `nextCursor` degraded-mode + the pre-deploy `project_activity_events.id` audit
    (already a Slice 5 precondition line in the plan).
  - Whether the Calendar now broadcasting `project-data-invalidated` (Slice 3a — TB5C kept it
    local) is acceptable long-term (Sol said yes: desirable cross-tab convergence).
- **Deploy:** app Worker only + migration `0038`. Order if any worker changes: background →
  webhook-ingress → app. Rollback target: app Worker `10778f00`. Recovery export before `0038`.
  Prod D1 currently ends at `0037`.

---

## 7. Roadmap doc bookkeeping

Once deployed + verified: update the plan's own Status line (with the commit hash), `git mv` it to
`docs/plans/implemented/`, update `docs/todo.md` current-state, and the `tb6-project-card-detail`
auto-memory. `docs/plans/tb6/slice-0-inventory.md` and this handoff can be deleted at closeout (or
kept for history — `slice-0-inventory.md` is genuinely useful reference).
