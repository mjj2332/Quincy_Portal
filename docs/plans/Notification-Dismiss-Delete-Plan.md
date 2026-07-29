# User-Clearable Notification Deletion — Plan

**Status: approved, ready to build — parent plan and addendum both cleared.** Parent (dismiss
route/UI): cleared 2 Terra review rounds (cap) plus an Opus plan-tier review, which spent 1 of its
2 Terra reverts adding the keyboard-focus-handoff design and test (Design step 3, Testing item 2's
third case), then self-approved. Addendum (durable AutoHDR stalled-notification guard, required
before this feature deploys — see its own section below): cleared 2 Terra review rounds (cap) plus
an Opus plan-tier review, which spent 1 of its 2 Terra reverts fixing a TOCTOU claim-predicate gap,
a scope-decision wording contradiction, a test-fixture isolation gap, and a migration-test baseline
regex bug, then self-approved. Both must ship in the sequenced rollout the addendum specifies
(migration + background deploy before app deploy) — see the addendum's Rollout section.

## User request

> "I want users to be able to clear the notification message, after user clicked to removed it from the UI, the notification shall be removed from the database as well. so we don't get a bloated database."

Add an individual dismiss control to the bell dropdown. Dismissing a notification must delete that
caller-owned `notifications` row immediately; it is not a read-state change or a replacement for
the existing scheduled retention cleanup.

## Current state (re-derived from the current tree)

### API, ownership, and persistence

- `portal/workers/app/src/index.ts:47-51` mounts all API route groups behind
  `api.use("/*", requireSession)` and mounts `notificationsRoutes` at `/api`. Notification routes
  therefore already have an authenticated `c.get("user")` and need no new capability middleware.
- `portal/workers/app/src/routes/notifications.ts:10-29` lists only the caller's rows, ordered by
  newest first, with a 1–50 limit/cursor and a separately calculated unread count. `:32-40` is
  `POST /notifications/:id/read`: it updates only where `id`, `userId`, and unread status all
  match, then returns `{ error: "Notification not found" }`, 404 unless exactly one row changed.
  `:43-48` is `POST /notifications/read-all`. There is no DELETE route today.
- The table at `portal/packages/db/src/schema.ts:839-860` has its own primary key; outbound FKs
  only to `user` and optional `projects`; its existing per-user unread index and partial
  `(type, source_key, user_id)` dedup index are unchanged. A repository-wide search finds no
  schema foreign key that references `notifications` (and migration
  `packages/db/migrations/0019_productive_victor_mancha.sql:1-19` confirms its only FKs are the
  two outbound ones). It is a leaf for referential-integrity purposes, so deleting a row needs no
  cascade or schema work.
- The existing cleanup is separate: `READ_NOTIFICATION_RETENTION_MS` is 90 days
  (`portal/packages/db/src/notifications.ts:18`), and `pruneReadNotifications()` deletes only
  rows that are already read and older than that cutoff (`:141-145`). The background Worker
  imports `pruneNotifications` (`portal/workers/background/src/index.ts:34`) and its
  `scheduled()` handler calls it (`:49-57`); that wrapper calls `pruneReadNotifications(env.DB,
  now)` (`portal/workers/background/src/notifications.ts:72-74`). A user dismissal must instead
  delete one owned row whether read or unread and at any age; it does not modify the retention
  rule or schedule.
- The nearest route convention is mixed by resource: notice-board and annotation deletes first
  load a resource and use 403 for an existing-but-foreign owner
  (`routes/notice-board.ts:89-99`, `routes/annotations.ts:103-117`). Notification read already
  intentionally takes the tighter, non-enumerating form: caller ownership is part of its guarded
  mutation and both absent and foreign IDs yield 404. The new notification delete should follow
  that existing notification-specific contract, not introduce a 403 distinction.
- General app mutations normally call `audit()` after the write (for example notice-board delete,
  `routes/notice-board.ts:97-99`; `audit()` writes a separate `audit_log` row at
  `src/lib/audit.ts:5-17`). This contrasts with the existing notification `read` and `read-all`
  routes, neither of which audits; that is a real current-tree/documentation discrepancy, not a
  premise for this feature. The new destructive action will audit its own successful delete
  without changing those older routes. The audit record retains only the action and deleted ID,
  not a FK or a copy of notification content, so the notification row itself is still gone.

### Bell dropdown and client synchronization

- `portal/apps/web/src/components/Topbar.tsx:79-90` fetches the first 25 notifications on mount
  and polls at `NOTIFICATION_POLL_MS = 25_000` (`:15`).
  `markNotificationRead()` (`:92-97`) immediately changes local state and unread count, then
  best-effort posts in the background; failures are deliberately swallowed because the next poll
  reconciles state. `markAllNotificationsRead()` follows the same convention at `:99-103`.
- The dropdown is a `role="menu"` with focus-on-open, Escape-to-close-and-return-focus, and
  outside-pointer close behavior (`Topbar.tsx:66-77,145-148`). Each notification is currently a
  single `<button role="menuitem">` whose full-row click marks it read (`:147`). Placing a clear
  button inside it would nest interactive elements inside a button, which is invalid HTML and
  would break real-browser interaction/accessibility.
- `portal/apps/web/src/lib/api.ts:72-74` already exports the generic `apiDelete<T>(path)` helper;
  it currently has no caller under `apps/web/src`, but this feature needs no new helper.
- Existing notification CSS is compact and local to
  `portal/apps/web/src/styles/app.css:60-73`; the current item owns its bottom border, unread
  background, and text layout. The implementation must move the row-level border/unread/hover
  treatment to a non-interactive wrapper while preserving that visual language.

### Existing tests

- `portal/workers/app/test/notifications.test.ts:33-36` creates authenticated requests against
  the real Miniflare Worker/D1 fixture. Its first test (`:54-66`) already proves list/read
  ownership scoping and read-all behavior; the later cases cover recipient selection and email
  failure handling. Extend this file and its existing `describe("notifications API and recipient
  selection", ...)` style rather than creating a parallel API suite.
- `portal/apps/web/src/components/Topbar.dom.test.tsx:6-11` mocks `apiGet` and `apiPost`, while
  its current single happy-dom test (`:41-68`) covers polling, open/focus, read, Escape, and
  outside-click. It is the correct place to add an `apiDelete` mock and the dismiss interaction.

## Design

### Backend: one owned-row DELETE route

In `portal/workers/app/src/routes/notifications.ts`, add:

`DELETE /notifications/:id` (mounted as `DELETE /api/notifications/:id`). It will:

1. Read the route `id` and authenticated `userId`.
2. Execute one Drizzle delete guarded by both
   `notifications.id = id` and `notifications.userId = userId`, then inspect the D1 result's
   `meta.changes` exactly as the existing read route does.
3. Return `{ error: "Notification not found" }`, 404 unless exactly one row was deleted. This
   deliberately makes missing, already-deleted, and another user's IDs indistinguishable, and
   allows deleting unread or read rows.
4. After that successful delete, write the normal audit event
   `notification.delete` with target type `notification` and the deleted ID (no copied body,
   title, project, or email metadata), then return `{ ok: true }` with 200.

There is no UUID validation added: the current notification read route accepts its path parameter
as-is and uses the guarded write/404 result as its validation and ownership behavior. There is no
schema or migration change because this is a plain DELETE from the existing leaf table.

### Frontend: valid sibling controls, not a nested button

In `Topbar.tsx`:

1. Import `apiDelete` alongside the existing API helpers and add
   `dismissNotification(notification)`.
2. The handler immediately filters that item from `notifications`; if its captured `readAt` is
   null, it also decrements `unreadCount` with the existing `Math.max(0, current - 1)` guard.
   It then best-effort calls
   `apiDelete("/api/notifications/" + encodeURIComponent(notification.id))`. As with the two
   read handlers, it catches and intentionally ignores an error so the unchanged 25-second poll
   restores authoritative server state. It does not call the read endpoint first: an unread row
   is deleted directly.
3. Hand off keyboard focus after optimistic removal deterministically. Before updating state,
   capture the dismissed notification's index in the current `notifications` array and compute
   the next target ID from that pre-removal array: the item at the same index after removal (the
   former next sibling), or, when dismissing the last item, the former previous sibling. Give
   each dismiss button `data-notification-dismiss={notification.id}`. After the state update
   commits, use the existing deferred `window.setTimeout(..., 0)` +
   `notificationsRef.current?.querySelector(...)` idiom to focus the dismiss button matching the
   computed ID (with a safely escaped attribute selector); if there is no target ID or no matching
   button, focus `notificationsRef.current` itself. Thus, the first dismissal moves focus to the
   next row's dismiss button, a last-row dismissal moves it to the new last row's dismiss button,
   and dismissing the only remaining row keeps the menu open and focuses its existing
   `tabIndex={-1}` container so the rendered `topbar__notification-empty` state remains
   reachable. Keep the menu-open effect unchanged: it must still focus the first row read button.
   A full ARIA-menu roving-tabindex/arrow-key pattern is out of scope; this plan adds only the
   focus-after-removal handoff.
4. Replace each one-button notification row with a non-interactive row wrapper containing two
   sibling buttons:
   - the existing title/body/time control remains the first `button`, keeps
     `role="menuitem"`, occupies the row's main area, and is the only control that calls
     `markNotificationRead`;
   - a second, adjacent `button role="menuitem"` calls `dismissNotification`. It has an explicit
     accessible name such as `Dismiss notification: RAW ready for review`, renders only a small
     visible `×` close glyph (hidden from accessibility), includes
     `data-notification-dismiss={notification.id}`, and includes no new navigation or
     confirmation flow.

   The menu's focus query still selects the first menu item—the read button. Escape/outside-click
   behavior remains attached to the same menu container, and a click on the sibling dismiss
   button cannot invoke the read handler because there is no nesting or parent click handler.
5. Update only the notification CSS: add a grid/flex row wrapper with a main-column and compact
   close-control column; put the existing bottom border and unread/hover background on that
   wrapper; keep both buttons transparent and preserve the existing typography/spacing for the
   main control. Add one new, shared minimal hover rule for both
   `.topbar__notification-head button` (the existing "Mark all read" action) and the new close
   button: retain their borderless, transparent treatment while changing the text color to
   `var(--text-primary)` on hover. This deliberately adds the shared hover state—the current
   header-button rule has none—rather than claiming an existing treatment to copy. Do not
   introduce an icon dependency or redesign the dropdown.

### Explicit scope decisions

- **No clear-all action.** The user requested an individual message clear after clicking it, not
  bulk deletion. Reusing the existing "Mark all read" affordance for destructive bulk deletion
  would widen behavior, error handling, confirmation/accessibility, and retention implications
  without a request. The new route is deliberately per-item only.
- **Optimistic removal.** Remove immediately, rather than wait for server confirmation, because
  the bell already treats read mutations as best-effort and poll-reconciled. This makes the
  requested clear action feel immediate while preserving a single established failure model.
- **The 90-day pruner remains.** Explicit deletion reduces the table now; the scheduler still
  cleans up old read rows that users never dismiss. They address different populations and do not
  overlap in a way that warrants a change.

## What is explicitly not changing

- `GET /api/notifications`, `POST /api/notifications/:id/read`, and
  `POST /api/notifications/read-all`, including their response shapes and read semantics.
- The 25-second notification polling interval, list-page size/cursor behavior, and existing
  swallow-and-reconcile behavior for reads.
- The 90-day read-notification retention constant, `pruneReadNotifications()`, background
  schedule, and any retention for `audit_log`.
- Notification creation, recipient selection, source-key deduplication, email sending, and the
  prior admin/assignment notification work.
- Any bulk clear-all endpoint or UI control, confirmation dialog, undo feature, schema column,
  index, migration, R2 object work, or background-worker change.

## Testing requirements for the build

1. Extend `portal/workers/app/test/notifications.test.ts` with a real-D1 DELETE case using its
   existing authenticated tokens and `request()` helper (extend the helper's method union to
   include `DELETE`):
   - caller A receives 404 when deleting B's notification, and direct D1 inspection confirms B's
     row remains;
   - specifically insert a **fresh caller-A-owned notification with `read_at IS NULL`** for this
     DELETE case; do not reuse A's row from the shared fixture, because the earlier `read-all`
     test can have mutated it. Delete this freshly inserted ID directly, with no preceding read
     request, then assert the response is 200 / `{ ok: true }` and a direct D1 `SELECT` for that
     ID proves the row is completely absent (not merely `read_at`-updated). This demonstrates
     that deletion neither requires nor depends on read state;
   - a second DELETE of the removed ID and a random nonexistent ID both return 404;
   - the successful route writes exactly the expected `notification.delete` audit record for
     caller A and the deleted ID, without reintroducing any notification-table reference.
2. Extend `portal/apps/web/src/components/Topbar.dom.test.tsx` by mocking `apiDelete` in the same
   partial module mock/reset pattern as `apiGet`/`apiPost`. Open the menu, activate the named
   dismiss control for the seeded unread notification, and assert before its deferred DELETE
   promise resolves that the row is absent, the empty state is shown, the badge/unread label has
   dropped to zero, and the DELETE path is exactly `/api/notifications/n-1`. Also assert no read
   POST was made by the dismiss click. Keep the existing focus/Escape/outside-click/read assertions
   passing with the new sibling menuitem structure. Add a separate DOM case with two seeded
   notifications—one unread and one already read (with `readAt` set)—then dismiss the named
   control for the already-read notification specifically. Assert that the unread notification
   remains visible and the badge/unread count remain one. This proves the optimistic decrement is
   actually gated by `readAt == null`, rather than being applied for every dismissed row. Add a
   separate focus-handoff DOM case with at least two seeded notifications: open the menu, dismiss
   the first notification through its named dismiss control, then—after flushing the deferred
   focus work with the existing
   `await act(async () => { await vi.advanceTimersByTimeAsync(0); })` pattern at
   `Topbar.dom.test.tsx:51,61`—assert that `document.activeElement` is the dismiss button of the
   notification that took its place, selected by its stable data attribute or accessible name
   rather than array identity. Dismiss that remaining notification, flush the deferred focus work
   again, and assert that `document.activeElement` is the `[role="menu"]` container, the menu
   remains open, and the empty state is rendered.
3. Run the standing full verification sequence from `portal/`: `npm run typecheck`,
   `npm run build -w @quincy/web`, `npm run test --workspaces`, and
   `npx vitest run --config packages/shared/vitest.config.ts`.
4. After deployment, do an authenticated browser smoke check of both an unread and a read
   notification: dismissing removes it immediately from the open menu, adjusts the badge only for
   the unread one, and it remains absent after a refresh/poll (proving the row was deleted, not
   hidden locally).

## Rollout

This is an **app-worker-only** change. The API route changes app Worker code and the Topbar/CSS
changes are built into `apps/web/dist`, which the app Worker serves through its `ASSETS` binding
(`portal/workers/app/wrangler.jsonc:7-13`). The existing table is sufficient and has no inbound
FK/cascade requirement, so no D1 migration, migration number, background deployment, webhook
deployment, secret, or binding change is needed.

After the build and verification, deploy the app Worker (from `portal/workers/app`,
`npx wrangler deploy`) so both the new API route and rebuilt SPA assets reach production. A Worker
redeploy is required; unlike the earlier seed-admin UUID operation, this is code and web-asset
behavior, not a pure data update.

## Routing (per `docs/Subagent-Orchestration.md` §2)

Classify this as a **Normal feature or refactor**: it changes an authenticated API mutation,
deletes user data, restructures accessible interactive markup, adjusts state reconciliation, and
extends real-D1 plus happy-dom tests, but it neither changes auth/capabilities nor adds a schema
migration or cross-Worker workflow. The routing table assigns **Terra** as builder and a fresh
**Terra** as reviewer for this category. Per §2 policy 1, this draft must first receive the
separate fresh-Terra review (maximum two Terra review rounds), then the independent Opus plan-tier
review/revert process before any implementation begins.

## Addendum: durable AutoHDR stalled-notification guard (revised after Opus plan-tier review, revert 1; required before this feature deploys)

This addendum belongs here rather than in a separate plan. It corrects a behavior introduced by
this plan's new permanent DELETE operation, has to reach production before (or atomically with)
that operation, and otherwise leaves the deletion contract untouched. Keeping it with the parent
plan makes the combined release dependency explicit while retaining the original plan's API/UI
design as written. For this combined release, it supersedes two specific parent-plan scope
decisions: its prior "no schema column, migration, or background-worker change" decision and
app-worker-only rollout statement; and, solely for `autohdr_stalled`, its "recipient selection
not changing" decision as to *when* recipients are evaluated. The latter becomes a
once-per-handoff snapshot as the named scope decision below specifies. Every other parent-plan
scope decision remains in force.

### Current state (re-derived 2026-07-30)

- The parent plan's intended dismiss route is now present as uncommitted work:
  `DELETE /notifications/:id` deletes only the caller-owned row and audit-logs the successful
  deletion (`portal/workers/app/src/routes/notifications.ts:44-52`); Topbar calls that route after
  optimistic removal (`portal/apps/web/src/components/Topbar.tsx:105-116`). `git status --short`
  also shows the related app, Topbar, CSS, and test changes uncommitted, so this addendum is
  deliberately planned on top of that state, not on a clean-tree assumption.
- `emitNotifications()` stores an optional `sourceKey` on each notification row
  (`portal/packages/db/src/notifications.ts:71-100`). When supplied, it uses the partial unique
  `notifications_source_key_unique` conflict target `(type, source_key, user_id)` with
  `source_key IS NOT NULL` and skips both the inserted row and its email when that insert changes
  zero rows (`:102-138`). The matching schema index is the notification table's only durable
  source-key memory today (`portal/packages/db/src/schema.ts:839-860`). Deleting a row therefore
  deletes that recipient's only conflict entry.
- Repository-wide call-site inspection finds `sourceKey` passed only in
  `portal/workers/background/src/notifications.ts:58-67`, where its value is the current stalled
  handoff ID. The other background wrapper merely forwards an optional value (`:14-39`) and every
  application-worker `emitNotifications()` call omits it
  (`portal/workers/app/src/lib/notifications.ts:12-70`). Thus no other notification type currently
  has this row-existence-as-dedup behavior.
- `scanStalledAutoHdr()` computes `now - STALLED_NOTIFICATION_AGE_MS`
  (`portal/workers/background/src/notifications.ts:42-44`); the shared constant is exactly three
  hours (`3 * 60 * 60 * 1000`, `portal/packages/db/src/notifications.ts:14-18`). Its current SQL
  selects a handoff only when the handoff is `started`, its output mapping is
  `pending_discovery`, `started_at` predates that cutoff, and the project is not archived
  (`portal/workers/background/src/notifications.ts:45-52`), then emits
  `autohdr_stalled` with `row.handoffId` as the source key (`:54-69`). The background Worker calls
  this scan in `scheduled()` (`portal/workers/background/src/index.ts:49-57`) and its configured
  cron is `0 * * * *` (`portal/workers/background/wrangler.jsonc:16-19`). The scan's current
  per-row body has no `try`/`catch`: an error from recipient/project lookup or
  `emitNotifications()` aborts the rest of that scan; `scheduled()` catches and logs that rejected
  scan as a whole before continuing to notification pruning.
- `autohdr_handoffs` is the durable entity for this event and already owns `started_at`, state,
  and lifecycle timestamps (`portal/packages/db/src/schema.ts:405-435`); unlike a per-user
  notification it cannot be deleted by the new user route. `autohdr_stalled` remains in
  `EMAIL_ENABLED_EVENTS` (`portal/packages/db/src/notifications.ts:14-16`), so a successful
  reinsert would also re-send email. This verifies the reported side effect: after a user deletes
  their sole stalled row, the next hourly selection has no per-user source-key conflict and can
  insert/email it again while the handoff still matches.
- The migration directory ends at `0022_seed_admin_uuid.sql` and its Drizzle journal ends at
  index 22 (`portal/packages/db/migrations/meta/_journal.json:152-165`). More importantly, a
  drafting-time read-only remote query from `portal/workers/app` returned ledger ID 23,
  `0022_seed_admin_uuid.sql`, as the newest applied D1 migration. `0023` is therefore both the
  next repository and production number; it is not inferred solely from an old plan. The tracker
  records the same applied state (`docs/todo.md:12-28`).

### Design

1. Add `stalledNotifiedAt: integer("stalled_notified_at", { mode: "timestamp_ms" })` to the
   `autoHdrHandoffs` table definition in `portal/packages/db/src/schema.ts`, immediately beside
   `startedAt`. It is nullable and has no default: a null value means the specific handoff has
   not yet had its stalled condition processed; a timestamp is system-owned evidence that it has.

2. Add the hand-authored migration
   `portal/packages/db/migrations/0023_autohdr_stalled_notification_guard.sql` with exactly:

   ```sql
   ALTER TABLE autohdr_handoffs ADD COLUMN stalled_notified_at INTEGER;
   ```

   Update `portal/packages/db/migrations/meta/_journal.json` with its next journal item (index
   23, tag `0023_autohdr_stalled_notification_guard`, generator-time `when` value) but do not use
   `drizzle-kit generate`'s table-rebuild output or add a new schema snapshot for this
   hand-authored additive migration. The shipped `0022` migration follows that manual-file plus
   journal-only precedent (`git show 3897501 -- portal/packages/db/migrations`). This bare ALTER
   has no `CHECK`, default, data rewrite, `PRAGMA`, drop, or FK-sensitive table rebuild. That is
   deliberate: the real `0020` D1 incident showed that a generator-style rebuild can fail on
   production foreign keys despite local success (`docs/lessons.md:3-26`), while a nullable
   single-column add leaves all existing handoffs valid.

3. In `scanStalledAutoHdr()`, append `AND h.stalled_notified_at IS NULL` to the discovery
   SELECT after the existing age/project predicates, then add the guarded claim statement,
   per-handoff `try`/`catch`, and narrow claimed-candidate helper described in testing item 3.
   Do not change the discovery joins or predicate semantics. The SELECT is a pure optimization
   that narrows rows worth attempting; the claim UPDATE is the **sole** authority to emit. For
   **each candidate**, atomically claim the handoff *before* resolving recipients, looking up the
   project, or calling `emitNotifications(...)`, using the scan's supplied `now` and its already
   computed `cutoff` value:

   ```ts
   const claim = await env.DB.prepare(
     "UPDATE autohdr_handoffs SET stalled_notified_at = ?, updated_at = ? " +
     "WHERE id = ? AND stalled_notified_at IS NULL AND state = 'started' " +
     "AND started_at IS NOT NULL AND started_at < ? " +
     "AND EXISTS (SELECT 1 FROM autohdr_output_mappings m " +
     "WHERE m.handoff_id = autohdr_handoffs.id AND m.state = 'pending_discovery') " +
     "AND EXISTS (SELECT 1 FROM projects p " +
     "WHERE p.id = autohdr_handoffs.project_id AND p.archived_at IS NULL)",
   ).bind(now, now, row.handoffId, cutoff).run();
   if ((claim.meta.changes ?? 0) !== 1) continue;
   ```

   Keep the claim WHERE predicates a mirror of the discovery SELECT's predicates: a future change
   to either predicate set is a required change to both. D1's declared `run()` result is a
   `D1Result`, whose `meta` includes `changes`; use that database-authoritative result, not the
   stale candidate SELECT, to decide whether emission is permitted. This matches the direct
   guarded-handoff precedent at `portal/workers/background/src/autohdr/claims.ts:125-126` and the
   guarded mapping `EXISTS` shape at `portal/workers/background/src/index.ts:555-556`.
   `changes === 1` is the sole permission to emit. `changes === 0` means either another execution
   already claimed the handoff or it is no longer eligible (resolved, mapping advanced, or project
   archived), so this execution always skips it completely—even if its earlier SELECT found the
   row. Log that skip with handoff/project IDs and a diagnostics-only post-claim classification:
   `already_claimed` when its marker is non-null, `no_longer_eligible` when it is null and a
   guarded eligibility predicate fails, and `concurrently_changed` otherwise. That diagnostic
   re-read is for operations only and must never authorize emission. This closes the
   overlapping-scheduler/deleted-notification window: once the first claimant has set the handoff
   marker, deleting its notification row cannot make a second, already-selected candidate eligible
   to emit.

   After a successful claim, perform recipient lookup and emission in a per-handoff `try`/`catch`
   so one bad handoff does not abort all later candidates. A return of zero from
   `emitNotifications()` is a successful, terminal observation: it includes the legitimate
   zero-active-recipient case and leaves the claim in place. Individual email-send failures do not
   enter this path—`emitNotifications()` has already inserted the in-app row and records each
   failed send on that row itself (`portal/packages/db/src/notifications.ts:120-136`).

   If anything escapes the post-claim work (for example a notification insert, recipient lookup,
   or project-query database error), **revert this scan's claim before continuing** so a future
   scan can retry the handoff. Use a conditional, parameterized rollback tied to the value this
   scan claimed, for example:

   ```ts
   await env.DB.prepare(
     "UPDATE autohdr_handoffs SET stalled_notified_at = NULL, updated_at = ? " +
     "WHERE id = ? AND stalled_notified_at = ?",
   ).bind(now, row.handoffId, now).run();
   ```

   Log the original emission error and any rollback failure with the handoff/project IDs; protect
   the rollback itself so its error does not stop later candidates. The recovery choice is to retry
   a total emission failure, rather than silently losing the alert: unlike an email failure, it may
   mean no durable in-app notification was recorded at all. If a multi-recipient emission failed
   after some inserts, the retained source-key index suppresses those already-recorded recipients
   on retry while the missing ones can be inserted. A failed rollback is an exceptional
   operationally visible case in which the already-written marker remains; it is not a separate
   normal-path partial-marker condition. With claim-first ordering, the ordinary
   "marker set but nobody notified" concern can arise only from this genuine post-claim failure,
   for which the rollback is the prescribed recovery.

   **Named scope decision — one-shot recipient snapshot.** A successful claim remains terminal
   even when there are zero active recipients, so a photographer, editor, or active admin added
   after that scan will not receive this historical stalled alert. This bounds a recipient-less
   handoff to one scan instead of re-querying it hourly forever. Re-checking the current code shows
   this is a deliberate **new limitation**, not merely preserved source-key behavior: today the
   unmarked handoff is selected every hour, and a newly added active recipient has no
   `(type, source_key, user_id)` row, so the existing unique index permits their later insert and
   email even though it suppresses recipients notified by an earlier scan. The combined release
   accepts that behavior change because the addendum defines a stalled condition as observed once
   per handoff rather than as an indefinitely replayed event; it does not affect future, distinct
   AutoHDR handoffs.

4. Retain the notification-table partial unique index and its `sourceKey` insert path exactly as
   defense in depth against duplicate inserts for the same recipient within a scan/run. The new
   handoff marker is the cross-dismissal memory; it does not replace the row-level concurrency
   backstop.

### What is explicitly not changing

- The parent plan's DELETE route, ownership/404 semantics, audit entry, optimistic UI behavior,
  CSS, polling, and focus management. This addendum changes neither how a user dismisses a row
  nor what deletion means.
- The three-hour threshold; `started` handoff and `pending_discovery` mapping predicates;
  `started_at IS NOT NULL`; non-archived-project filter; candidate joins; or the hourly schedule.
  Their semantics and thresholds are unchanged, but the same predicates are additionally enforced
  at claim time.
- `EMAIL_ENABLED_EVENTS`, including `autohdr_stalled`; notification copy; the
  `projectNotificationRecipients` recipient-set query (its project-member plus active-admin
  composition and deduplication); email delivery/error recording; and the notification table's
  source-key unique index. Only the timing of that unchanged recipient set for `autohdr_stalled`
  changes to once per handoff, as the named scope decision above states.
- Any other notification type or its deduplication behavior. The call-site result above confirms
  there is no other actual `sourceKey` producer to change.
- AutoHDR lifecycle transitions, mapping discovery, handoff state, project archival behavior,
  notification retention, and the existing read/delete APIs beyond their already-uncommitted
  parent-plan work.

### Testing requirements for the build

1. Extend `portal/workers/background/test/notifications.test.ts`, whose existing scan fixture
   already seeds a handoff/mapping and proves a normal repeated scan is a no-op
   (`:41-68`). Keep the independent direct `emitNotifications()` test, “skips both the duplicate
   row and the duplicate email on a repeated sourceKey” (`:70-101`), unchanged: it continues to
   prove the retained row-level backstop.

   The file shares one D1 instance and `projectNotificationRecipients()` unions every active global
   admin with project members (`portal/packages/db/src/notifications.ts:46-69`). Therefore every
   **new** case below that asserts an exact recipient, notification, or email-send count must use a
   test helper that queries and temporarily deactivates all pre-existing active admins before the
   case, runs the case in `try`/`finally`, and restores exactly those captured users' active state
   in `finally`. Seed the case's intended project members after that suppression. This makes exact
   counts declaration-order independent; it must not perturb the existing scan test at `:41-68`,
   whose expected count remains `2`, or the existing direct `emitNotifications()` sourceKey test
   at `:70-101`, both of which must continue to pass unchanged.

2. Add a distinct scan-level dismissal regression case with exactly one eligible recipient. Seed
   a `started` handoff older than three hours, a `pending_discovery` mapping, an unarchived
   project, and one active project member under the active-admin isolation discipline in item 1;
   use a mock email sender. Run `scanStalledAutoHdr(localEnv, now)` and assert exactly one
   notification/email plus a non-null `autohdr_handoffs.stalled_notified_at` equal to `now`.
   Directly delete that emitted notification row by ID (the database-level analogue of the user's
   dismiss), assert it is absent, then run the same scan an hour later. Assert the second result is
   zero, no new notification row exists for the handoff source key, the sender remains called
   exactly once, and the durable marker remains set. This proves the background guard—not the
   retained notification row—prevents the re-notify and re-email side effect.

3. Add a concurrency-interleaving regression, not merely another sequential scan assertion. Factor
   the claimed candidate-processing portion of `scanStalledAutoHdr()` into a narrow helper whose
   result distinguishes `{ claimed: true, emitted: number }` from
   `{ claimed: false, emitted: 0 }`; `scanStalledAutoHdr()` continues to sum only `emitted`.
   In the Miniflare-backed test, obtain two candidate inputs from the same eligible handoff before
   either one claims it, then invoke the helper twice under the active-admin isolation discipline
   in item 1 to represent two schedulers that both read that pre-claim state. The first must report
   `claimed: true`, emit exactly one notification and email, and set the marker. Delete that
   notification row **between the two claim attempts**. The second, still holding its stale
   candidate, must report `claimed: false` from its `meta.changes === 0` update, skip recipient
   resolution and `emitNotifications()`, create no replacement notification, and leave the sender
   at exactly one call. `claimed: false` covers both a lost race and a handoff that is no longer
   eligible, so this concurrency test must establish its race-specific meaning from the first
   helper's successful claim and retained marker, not from that result value alone. This
   specifically proves that row deletion cannot reopen an overlapping scan that selected before
   the winner claimed; it is not satisfied by calling the full scan twice after the first has
   completed selection.

4. Cover the named recipient snapshot, claim-time ineligibility, and post-claim recovery in the
   background test suite:

   - Under the active-admin isolation discipline in item 1, seed no active recipients, scan once,
     then add an active project member and scan again. Assert the marker remains set and no
     historical stalled notification is created for that new member; this locks in the named
     one-shot-recipient-snapshot decision above.
   - Under the active-admin isolation discipline in item 1, obtain candidate input while a handoff
     is eligible, then mutate it before invoking the claimed-candidate helper. Cover at least two
     variants: archive its project, and separately change either the handoff state or mapping state
     so the guarded predicate no longer matches. In each variant, assert `claimed: false`, zero
     notifications, zero email sends, and `stalled_notified_at` still `NULL`, so a genuinely
     stalled future state can still be claimed.
   - Force a failure that escapes `emitNotifications()` after the handoff claim (a local D1
     notification-insert failure is sufficient). Assert the per-handoff catch conditionally clears
     `stalled_notified_at`, later candidates in that same scan are still processed, and a
     subsequent scan can claim and emit for the failed handoff. Use the active-admin isolation
     discipline in item 1 for any exact-count assertion in this case. Add or retain a separate
     email-sender-rejection assertion: that rejection is recorded within `emitNotifications()` and
     must retain the claim rather than be treated as a total emission failure.

5. Add a focused `portal/packages/db/test/migration-0023.test.ts`. This migration is small, but a
   focused test is warranted because it changes the FK-referenced `autohdr_handoffs` table and the
   production `0020` incident specifically makes migration *shape* material. Model the setup
   utilities after `migration-0020.test.ts:1-36` and `migration-0022.test.ts:29-38`: apply
   migrations `0000`–`0022` with foreign keys enabled, insert a valid legacy handoff/dependency
   fixture, then apply the exact `0023` SQL file. When adapting `migration-0022.test.ts`'s
   `applyLegacyMigrations`, widen its filename filter from `2[01]` to `2[0-2]` so it includes
   `0022` while excluding only `0023`; have that helper return its sorted applied filenames and
   assert the baseline includes every migration `0000`–`0022` (including
   `0022_seed_admin_uuid.sql`) before applying `0023`. This prevents a future migration test from
   silently using a weaker baseline. Assert `PRAGMA table_info('autohdr_handoffs')` contains a
   nullable `stalled_notified_at` `INTEGER` column and the pre-existing handoff reads `NULL`; also
   assert the normalized migration source is only the bare `ALTER TABLE ... ADD COLUMN ...`
   statement. This is intentionally a narrow migration-shape/schema test, not a recreation of
   the much larger 0022 data-migration suite. `portal/workers/background/vitest.config.ts:6-15`
   already globs, sorts, and joins every migration `*.sql` into `__PORTAL_MIGRATION_SQL__`, so the
   background suite will pick up `0023` automatically and needs no config change.

6. Run the repository verification sequence from `portal/`: `npm run typecheck`,
   `npm run build -w @quincy/web`, `npm run test --workspaces`, and
   `npx vitest run --config packages/shared/vitest.config.ts`. The web build is unchanged in this
   addendum but is required because the combined rollout includes the uncommitted dismiss UI.
   Also run the focused DB migration test and background notifications test while iterating.

### Rollout

This guard and the not-yet-deployed dismiss feature should ship in **one combined rollout**. A
separate dismiss-first deployment is unsafe because it creates the hourly re-notification window;
deploying the guard first is safe but leaves related uncommitted work split unnecessarily.

1. Apply `0023_autohdr_stalled_notification_guard.sql` to production D1 **before** deploying the
   new background query, using the app Worker config that declares the migrations directory:
   `cd portal/workers/app && npx wrangler d1 migrations apply quincy-portal --remote`. Verify the
   `d1_migrations` ledger includes `0023_autohdr_stalled_notification_guard.sql` and
   `PRAGMA table_info('autohdr_handoffs')` shows the new nullable column before any Worker deploy.
   Migration and code must not be applied only "alongside" one another: an old background Worker
   tolerates the extra column, but a new query cannot tolerate a missing column.

2. Deploy `portal/workers/background` next (`npx wrangler deploy`). It is the only Worker changed
   by this addendum and owns the hourly scan. `webhook-ingress` has no source, binding, or migration
   change here, so it does **not** require a redeploy solely for this work. If an operator runs the
   standing three-Worker release sequence anyway, retain the mandated order
   **background → webhook-ingress → app**; the ingress deployment is a no-op middle step.
   **If this deploy fails for any reason, stop — do not proceed to step 3.** Deploying the app
   Worker's DELETE route while the background Worker still runs the old emit-then-mark code
   reopens exactly the re-notify window this addendum exists to close.

3. Deploy `portal/workers/app` last (`npx wrangler deploy`) to release the existing DELETE route
   and rebuilt Topbar assets. This respects the repository's background → webhook-ingress → app
   ordering and means users cannot delete notification rows until the durable background guard and
   its schema are live. No secret, queue, R2, KV, or binding change is required.

After deployment, perform an authenticated dismissal smoke test of a normal notification as the
parent plan requires, and use the focused automated regression (rather than manufacturing a real
three-hour AutoHDR stall) as the proof for the guard. Monitor the scheduled scan log for the new
`"Claimed stalled AutoHDR notification"` line (added after the final review found the zero-recipient
one-shot snapshot was otherwise silent — a claim with `emitted: 0` is that case firing) and for
unexpected `autohdr_stalled` email traffic during the first hourly tick.

**Recovery note — a handoff stuck claimed-but-unnotified.** If a genuine post-claim emission
failure's own rollback also fails (both are logged via `console.error`, but there is no automated
alert), a handoff can be left with `stalled_notified_at` set and no notification ever recorded for
it. There is no self-healing path for this rare case. To manually clear it once confirmed (via the
logs) that no notification exists for that handoff, run:
`UPDATE autohdr_handoffs SET stalled_notified_at = NULL WHERE id = '<handoffId>';` — this makes the
handoff eligible for the next hourly scan again.

### Routing (per `docs/Subagent-Orchestration.md` §2)

Route this as **Security, auth, payments, migrations**—Terra at maximum effort with a fresh,
maximum-effort Terra reviewer—not as a normal feature/refactor. The code change is small and
additive, but it includes a production D1 schema migration on a table with foreign-key
relationships; the routing table explicitly lists migrations in that category
(`docs/Subagent-Orchestration.md:132-142`), and the documented 0020 remote-D1 failure makes the
risk classification substantive rather than ceremonial.

**Addendum built, tested, and fully reviewed — ready for the combined rollout above.** Cleared 2
Terra review rounds (cap) — round 1 found and fixed a real emit-then-mark concurrency race by
redesigning to claim-before-emit; round 2 found three should-fix items (a TOCTOU gap in the claim
predicate, a scope-decision wording contradiction, and a test-fixture isolation gap) — plus an
Opus plan-tier review, which spent 1 of its 2 Terra reverts fixing all three (and a fourth it found
itself: the migration test's baseline regex would have silently excluded `0022` from its
applied-migrations set), then self-approved after independently verifying every citation in the
fix. Built by Terra (schema/migration, the claim-before-emit redesign, and 6 new background tests
plus a focused migration test); the builder also fixed an unrelated pre-existing bug it found in
`workers/background/vitest.config.ts`'s "before 0015" migration filter. A fresh Terra diff review
found zero issues and executed the full test suite itself. Opus final-draft review of the diff
approved it for deploy and found two things worth fixing before rollout, both applied directly in
this session: (1) a missing `drizzle-kit` snapshot for `0023`'s real schema change — confirmed by
actually running `drizzle-kit generate`, which reproduced the predicted failure (a duplicate
`0024` migration re-adding the same column), then fixed by taking drizzle-kit's own correctly-computed
snapshot output and discarding the unwanted duplicate migration/journal entry, re-verified with a
second `drizzle-kit generate` reporting "No schema changes"; (2) the zero-recipient one-shot
snapshot decision was otherwise completely unobservable in production logs, fixed by adding a
`console.log` on every successful claim. Both fixes were re-verified against the full test suite
before proceeding.
