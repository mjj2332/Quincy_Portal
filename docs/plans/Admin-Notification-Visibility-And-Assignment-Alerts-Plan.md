# Admin Notification Visibility and Assignment Alerts — Plan

Status: built and verified (typecheck, web build, all real test suites green; Terra diff-reviewed
and Opus final-draft reviewed, both approved) — not yet deployed or committed

## User request

The studio admin reported receiving neither in-app nor email notifications from Quincy Portal.
The investigation identified two independent omissions that should be fixed together:

1. Active admins must implicitly receive every existing project notification, even when they
   have no project_members row for that project.
2. A photographer or editor must be notified when they are newly assigned to a project.

The first change repairs recipient visibility for the six existing event types. The second adds
an assignment-specific event; it does not replace or alter the existing project-event fan-out.

## Current state

The approximate line numbers in the request have drifted slightly, so the references below are
re-derived from the current tree.

### Existing notification types and delivery path

portal/packages/db/src/notifications.ts:5-11 currently defines six NotificationType literals:
raw_ready, edited_landed, sent_to_editing, autohdr_stalled, delivered, and comment_added.
EMAIL_ENABLED_EVENTS already contains exactly those six at :13-15; this plan must preserve all
six members and may add only the new assignment type.

notificationCopy() handles those six cases at portal/packages/db/src/notifications.ts:27-35.
emitNotifications() accepts an explicit recipients array at :57-66, deduplicates by user id at
:73-75, inserts one row per recipient at :76-106, and only then checks EMAIL_ENABLED_EVENTS
before attempting email at :107-122. The email array therefore governs event types, not recipient
selection; Feature 2 does not require a separate email gate.

The current recipient helper at portal/packages/db/src/notifications.ts:38-55 joins
project_members to user, requires user.active = true at :49-52, applies the optional
role_on_project = 'editor' filter when editorOnly is set, and removes excludeUserId in
JavaScript. It never queries global admins. The schema confirms why that is a structural gap:

- portal/packages/db/src/schema.ts:20-33 defines the global user role as
  admin | photographer | editor and stores active on user.
- portal/packages/db/src/schema.ts:173-189 restricts project_members.role_on_project to
  photographer | editor; there is no admin project-member role.

The app worker wrapper at portal/workers/app/src/lib/notifications.ts:12-37 resolves the
project label and project recipients, then passes them to emitNotifications() with the email
binding. The background wrapper at portal/workers/background/src/notifications.ts:14-40 does
the same, with the optional stalled-scan sourceKey; scanStalledAutoHdr() uses the same
recipient helper at :42-60. Thus changing the shared recipient helper covers both workers and
the existing stalled-event path.

The six existing event families are already emitted per project at their current call sites:

| Type | Current call sites |
|---|---|
| raw_ready | portal/workers/app/src/lib/ingest.ts:118; portal/workers/background/src/index.ts:50; portal/workers/background/src/dropbox/sync.ts:374 |
| edited_landed | portal/workers/background/src/autohdr/finals.ts:203,263,308; portal/workers/background/src/workflows/autohdr-fetch.ts:184 |
| sent_to_editing | portal/workers/background/src/workflows/autohdr.ts:282; portal/workers/background/src/autohdr/claims.ts:137,621,870 |
| autohdr_stalled | portal/workers/background/src/notifications.ts:42-60 |
| delivered | portal/workers/app/src/routes/projects.ts:645-660, with the existing transition condition at :659 |
| comment_added | portal/workers/app/src/routes/annotations.ts:98, on annotation creation only, with editorOnly: true and excludeUserId |

Each call is already scoped to one project. Adding a global active-admin query adds one small
recipient lookup per event and one in-app row/email attempt per active admin. The main frequency
outlier is comment_added: annotations.ts:98 emits on every successful annotation POST. This
means active admins will also receive those comment notifications under the decision below;
the extra volume is intentional and should be observed, not silently throttled in this plan.

### Assignment writes are currently silent

portal/workers/app/src/routes/projects.ts:103-105 has addMembers() insert deduplicated
membership rows but return nothing. syncMembers() at :111-117 currently reads the current
membership internally, adds the desired ids, removes absent ids, and returns exactly
{ added: string[], removed: string[] }. Its current added calculation is a desired-list versus
pre-insert-snapshot diff, not an insert result. That is sufficient for an ordinary no-op PATCH,
but is not safe as an assignment-notification signal: two concurrent PATCHes can read the same
snapshot, each infer the same user is added, and then have only one conflict-ignored insert
actually persist. The returned insert rows must become the source of truth for `added`; the
pre-read remains relevant only to calculating removals/audit metadata. The design below moves
that membership read to the route and passes its result explicitly to syncMembers(), which makes
the stale-snapshot case independently testable.

The create route at :157-168 calls addMembers() for photographer and editor ids at :166 and
then returns the project. The patch route destructures the assignment lists at :218-220, calls
syncMembers() at :262-263, updates the project at :264, and currently emits no assignment
notification. A no-op PATCH already produces empty added arrays; that existing diff behavior
is the correct basis for avoiding repeat alerts.

The current notification test coverage is split by runtime, and that split remains relevant:

- portal/packages/db/src/notifications.test.ts:1-101 is a Node-env test with a hand-mocked
  Drizzle Database, and already asserts the six email-enabled types and multi-recipient email
  failure handling.
- portal/workers/app/test/notifications.test.ts:54-90 uses real Miniflare-backed D1 for
  notification API scoping, active/editor-only/excluded recipient selection, and email failure.
- portal/workers/background/test/notifications.test.ts:23-95 uses real D1 for background
  fan-out, multi-role deduplication, stalled-scan deduplication, and source-key email dedup.
- portal/workers/app/test/api.test.ts already contains real route tests for project creation and
  membership updates, including membership behavior around :989-1014 and the
  editor-as-photographer case around :1016-1035; it is the right place for end-to-end assignment
  assertions.

The existing notification table already has every needed field. At
portal/packages/db/src/schema.ts:839-860, notifications stores userId, optional projectId,
type/copy, email outcome fields, and nullable sourceKey; :855-859 defines the partial unique
(type, source_key, user_id) index. No new column, enum constraint, or index is required for
either feature, so no migration is planned.

One repository-doc discrepancy is worth recording: the older implemented email plan describes
packages/db/src/notifications.test.ts as a new file, but it already exists in the current
tree and will be extended. This plan follows the current tree.

## Design

### Feature 2 — include active admins in every project notification

Change portal/packages/db/src/notifications.ts only for the shared fan-out behavior:

1. Keep the existing active project-member query and its editorOnly behavior for actual project
   members.
2. Add a second query for all user rows where role = 'admin' and active = true, without a
   project-membership predicate. Project notifications are already emitted one project at a
   time, so this global admin set is the implicit studio-wide recipient set for that event.
3. Merge member and admin recipients by userId before returning them, preserving the existing
   deduplication guarantee for a user who has two project-member roles or is otherwise present in
   both sets.
4. Apply excludeUserId after the merge to both populations. An admin who performs the action
   must not receive a self-notification, just as an actual project member does not.

editorOnly will continue to restrict only project-member rows. Admins will be added
unconditionally, even when editorOnly: true. This is the explicit choice required by the
approved scope of “every active admin receives every project notification of all six existing
types.” editorOnly exists to select the project-specific editor role; an admin who is not a
project member has no corresponding role_on_project value to evaluate. Applying it to admins
would also make comment_added the one existing type that silently violates the all-six admin
visibility requirement. The resulting tradeoff is that admins receive annotation notifications
too, including their email, and the existing unbounded annotation frequency remains visible in
the operational risk rather than being hidden by an inconsistent filter.

No changes are needed in either existing notifyProject() wrapper: both already delegate to
projectNotificationRecipients() and then to emitNotifications(). The six current event types,
their source-key behavior, and their in-app/email sequencing remain unchanged.

### Feature 3 — notify newly assigned photographers and editors

Add one new NotificationType literal, assigned_to_project, rather than separate
photographer/editor event types. This is one semantic event (“you were assigned”) whose role is
part of the copy. A single type avoids multiplying event taxonomy and email-gating entries for
the same lifecycle event; the role is still explicit to the recipient in the title/body.
Because NotificationType is a literal union and notificationCopy() is a switch, adding the
literal forces the shared copy switch and all typed test fixtures to acknowledge it.

In portal/packages/db/src/notifications.ts:

- Add assigned_to_project to NotificationType.
- Add its canonical copy to notificationCopy(), with an optional
  photographer | editor role argument so the body can say, for example,
  “You have been assigned as the photographer for [project].” The no-role fallback should still
  be a valid generic assignment message for any future direct caller.
- Add assigned_to_project to EMAIL_ENABLED_EVENTS while leaving all existing six members
  intact. The precedent in Notification-Email-All-Events-Plan.md is to email every actionable
  notification type, and assignment is a direct user action that should not require the user to
  discover the in-app bell first. There is no technical or safety reason to delay email
  observation: emitNotifications() already best-effort sends the type after inserting its
  in-app row, and its existing failure recording applies unchanged.

In portal/workers/app/src/lib/notifications.ts, add and export a dedicated
`notifyProjectAssignments(env, projectId, assignments)` helper rather than reusing
projectNotificationRecipients(). It takes the same app binding object as notifyProject(), so the
route uses the normal Worker bindings while real-D1 tests can pass an explicit fake Env:

- Accept the project id and explicit { userId, roleOnProject } assignments.
- Fetch the project label and all target users in set-based queries, filtering the target users
  with active = true. This is a deliberate scope decision, not an incidental query detail:
  assignment alerts follow the existing recipient policy, which filters every recipient query to
  active users. A deactivated user cannot sign in to see an in-app notification and should not
  receive a new email alert either. The membership write itself remains unchanged and may retain
  an inactive assignee, but the helper skips that target without making the project update fail.
  Build NotificationRecipient objects from the selected user.id, user.email, and user.name fields.
- Group the explicit recipients by role only as an implementation efficiency (to reuse one
  role-specific copy per call); every emitted row must still be for one of the newly assigned
  user ids, never for the project team and never for global admins. Call emitNotifications()
  with those explicit recipient arrays, the new type, role-specific title/body, and the existing
  app email binding/from address.
- Keep the helper best-effort and error-isolated like notifyProject(), so a notification or
  email failure does not turn a successful project assignment into an API failure. Do not pass a
  sourceKey: re-adding a user after a real removal is a new assignment and should be eligible
  for a new alert; the existing partial unique index remains available for event types that
  already use it.

Add small, independently testable membership-write helpers at
portal/workers/app/src/lib/project-members.ts. Export
`insertProjectMembers(db, projectId, ids, roleOnProject): Promise<string[]>` and
`syncMembers(db, projectId, existing, desired, roleOnProject)`. This deliberate export,
alongside the assignment notifier above, gives the tests the exact production helpers without
exposing a route handler's private implementation. `existing` is the pre-fetched list of
`{ id, userId }` membership rows for the specified project and role; syncMembers() must not read
membership internally. It is therefore a function of the supplied database, project id,
pre-fetched existing list, desired list, and role, with a test seam for a stale pre-read.
projects.ts will import these helpers, and the real-D1 route test will import those same helpers
rather than trying to reach route-local functions. insertProjectMembers() must deduplicate the
requested ids, insert the corresponding
project_members rows with `ON CONFLICT DO NOTHING`, and return only `user_id` values confirmed by
`RETURNING user_id` (or the equivalent D1 result that exposes exactly the inserted rows). It must
not return requested ids or infer success from a preceding SELECT. The current Drizzle/D1 route
code already uses `returning()` for guarded writes; this insert must inspect the same
database-authoritative result. syncMembers() must calculate removals from its supplied `existing`
list, delete those rows as today, and set `added` exclusively to insertProjectMembers()'s
confirmed-insert result—never to `desired`/`existing` set arithmetic.

Update portal/workers/app/src/routes/projects.ts as follows:
- On POST /projects, capture the confirmed photographer and editor ids from the two
  insertProjectMembers() calls at :166, then invoke the assignment helper after those membership
  inserts. This preserves the same correctness rule even though a newly created project's normal
  case has no members.
- On PATCH /projects/:id, the route must fetch the existing membership list once for each supplied
  role, then pass that list explicitly to the corresponding syncMembers() call and retain its
  result at :262-263. syncMembers() must not perform its own membership read; it must set `added`
  to insertProjectMembers()'s confirmed inserted ids—not the old snapshot diff. After the
  existing project update, pass only photographerResult.added and editorResult.added to the
  assignment helper. Do not pass removed; removal alerts are explicitly out of scope. A no-op save
  has no returned insert rows and therefore produces no alert.
- This fixes the concurrent-PATCH race at its source. If two requests both observe no row for the
  same `(project_id, user_id, role_on_project)` tuple, the unique index permits one insert and
  conflict-ignores the other; only the request whose insert returns that user id may emit an
  assignment alert. No sourceKey is added as a secondary dedup mechanism, because a real later
  removal and re-assignment must still be eligible for another alert.
- If a user is added in both role lists in the same request, emit the role-specific assignment
  alert for each role whose role-specific insert succeeded. This preserves truthful copy for the
  two distinct membership rows.

The new assignment type does not participate in Feature 2 admin auto-inclusion. It is inherently
personal (“you were assigned”), so studio-wide admin copies would be noise and would incorrectly
turn a targeted assignment event into another project broadcast. An admin who is itself explicitly
assigned as a photographer or editor still receives its own targeted alert, subject to the
active-user check; that is a real assignment, not implicit admin inclusion.

### Performance and frequency decision

The added admin lookup is one global active-user query per existing per-project emission, followed
by the existing sequential insert/email loop. The number of active admins is expected to be small,
and there is no new project-wide scan or cross-project fan-out. The main rate concern is known and
bounded by the existing behavior: annotation creation emits comment_added on every POST, so the
new admin recipients increase both rows and email sends by the number of active admins. This plan
does not add throttling, digesting, batching, preferences, or opt-out state; those would be a
separate product decision. The implementation should retain logging/error behavior so failed
admin email sends remain visible through the existing emailError field.

## What is explicitly not changing

- The six existing EMAIL_ENABLED_EVENTS members; the only array addition is the new
  assigned_to_project type.
- The existing six notification call sites, their project scope, copy, source-key behavior, or
  best-effort email semantics.
- The editorOnly filter for actual project members. It remains editor-only for member rows;
  admins are the intentional unconditional exception described in Design.
- No “you were removed from a project” notification. syncMembers() will continue returning and
  auditing removals, but this plan will not notify removed users.
- No per-user notification preferences, mute/opt-out mechanism, digest, or comment throttling.
- No retroactive backfill of notifications for admins or assignees for events that happened before
  deployment.
- No new notification binding, secret, queue, Worker RPC, or environment configuration.
- No new migration. Existing notifications.project_id, user_id, type/copy, email fields,
  nullable source_key, and its partial unique index already support both features.
- No implicit admin recipient for assigned_to_project; only the explicitly assigned active user
  is targeted.
- No change to media retention, project membership authorization, or the existing annotation
  author-only mutation rules.

## Testing requirements for the build

The current Node-vs-Miniflare split applies directly: the package-level tests can validate type,
copy, email-gate, and explicit-recipient behavior with a mocked Drizzle chain, while recipient
joins and route membership diffs must run against real D1.

**Email-attempt test setup is explicit, never inherited from wrangler.jsonc or Worker secrets.**
For every new Worker-level case below that asserts an email attempt, create the same local fake
binding object already used by app notifications.test.ts:87, for example
`const send = vi.fn().mockResolvedValue({ messageId: "test-message" })` and
`const testEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS:
"studio@example.test" } as unknown as Env`. Pass `testEnv` directly to notifyProject(),
scanStalledAutoHdr(), or notifyProjectAssignments(), then assert the spy call count. This supplies
both conditions emitNotifications() requires (`email` and `fromAddress`) without relying on a
deployed binding or secret. Tests that call emitNotifications() directly instead pass that same
`{ send }` object as its `email` input and the same literal as `fromAddress`; the Node-only DB
mock has no Env parameter.

1. **portal/packages/db/src/notifications.test.ts — extend the existing Node-env mock suite.**

   - Add assigned_to_project to the test type list and update the email-gate assertion from six
     to seven types.
   - Assert the new notification copy includes the project label and the correct photographer vs.
     editor role wording.
   - Assert explicit recipient input remains the only source of assignment recipients and that a
     failing email records emailError without blocking later recipients, including the new type.
     As this suite calls emitNotifications() directly, provide its mock `email: { send }` and
     literal `fromAddress: "studio@example.test"` in the input rather than attempting to use a
     Worker Env.
   - Keep the mock shaped as the current chainable Drizzle insert().values() /
     update().set().where() interface; do not substitute the raw D1Database mock used by
     stage-transition.test.ts.

2. **portal/workers/app/test/notifications.test.ts — extend real-D1 recipient tests.**

   - Seed an active admin with no project_members row, an inactive admin with no membership, an
     active editor member, and an active photographer member.
   - Emit each of the six existing project types for one project, using editorOnly: true for
     comment_added, and assert the active admin receives all six despite having no membership;
     the inactive admin receives none; and comment_added still reaches the active admin while the
     photographer remains filtered out.
   - Exercise excludeUserId with an admin id and assert that admin is omitted while other
     eligible recipients remain.
   - Seed an active user whose global role is admin and who is also a real project_members row
     (for example, a photographer). Call `notifyProject(testEnv, ...)` with the explicit fake
     Env/`send` spy defined above, then assert exactly one notification row and exactly one email
     attempt for that event. This verifies the merge/dedup path rather than only the existing
     two-member-role case.
   - Import and call `notifyProjectAssignments(testEnv, ...)` directly with an active target and
     inactive target, again using the explicit fake Env/`send` spy. Assert one targeted row with
     role-specific copy and one email attempt for the active target, no row or email for the
     inactive target, and no assignment row or email for an unrelated active admin. This tests
     the helper's actual email path without assuming the Worker test configuration supplies EMAIL
     or NOTIFICATIONS_FROM_ADDRESS.

3. **portal/workers/background/test/notifications.test.ts — extend background fan-out.**

   - Add an active admin with no membership and an inactive admin to a background notification
     fixture and assert the active admin receives a background-emitted notification while the
     inactive admin does not.
   - Retain the existing two-project-member-role dedup assertion so adding the global admin query
     cannot create duplicate rows for a member; keep its current explicit fake Env, mock
     EMAIL.send, and literal from address for its email-success assertion.
   - Add/extend the stalled-handoff scan test through scanStalledAutoHdr() itself (not a manually
     supplied recipients array): seed an active admin with no project membership plus the stalled
     handoff fixture, construct the explicit fake Env with a `vi.fn()` EMAIL.send spy and literal
     from address, then run the scan with that Env. Assert the admin gets a row and email on the
     first run. Run it again with the same Env for the same handoff and assert no additional admin
     row or email attempt, proving sourceKey dedup remains intact after real recipient resolution.
   - Keep the direct source-key test asserting both row and email dedup on a repeated key; the new
     admin recipients must follow the same emitNotifications() conflict behavior. Because this
     particular test invokes emitNotifications() directly, retain its explicit `email: { send }`
     and literal `fromAddress` inputs.

4. **portal/workers/app/test/api.test.ts — add route-level assignment coverage beside the
   existing project membership tests.**

   - Create a project with photographer and editor ids and assert each newly assigned active user
     gets exactly one assigned_to_project row with the role-specific copy. These HTTP tests assert
     persisted route outcomes only; they do not count email calls through SELF, whose Worker
     bindings are not dynamically replaced by a test's fake Env.
   - Assert the project creator/admin does not receive the new assignment type merely because it
     is an admin.
   - PATCH the same lists again and assert no new assignment rows; PATCH with one newly added id
     and assert only that id receives an alert; PATCH with a removal and assert no removal alert.
   - Include an inactive assigned user and assert the membership row may still be written by the
     existing route behavior but no notification row is created for that inactive user, explicitly
     covering the active-recipient scope decision.
   - Put one active user in both photographerUserIds and editorUserIds in the same create or PATCH
     request. Assert exactly two assigned_to_project rows for that user—one per role—with the
     correct role-specific copy, not one collapsed generic alert.
   - Keep a complementary lower-level `insertProjectMembers()` test: import it, create one
     project and active target in D1, construct `db = createDb(database.DB)`, and make two
     back-to-back direct calls for the same `(projectId, userId, roleOnProject)` while the
     fixture's initial precondition is no such membership row. Assert the two returned-id sets
     contain the contested user exactly once in total (one call returns `[userId]`, the other
     `[]`) and the membership table has one row. Map the returned id sets to
     `{ userId, roleOnProject }` assignments and pass both results in turn to
     notifyProjectAssignments using the explicit fake Env with the mock EMAIL.send and literal
     from address described above. Assert exactly one assigned_to_project row and one `send` call.
     This validates the database-authoritative helper contract, but is explicitly insufficient by
     itself: neither sequential call exercises syncMembers()'s stale-membership snapshot or its
     `added` wiring.
   - Add the separate, deterministic syncMembers()-level regression test that actually covers
     that wiring. Import `syncMembers` as well as `insertProjectMembers`; seed a project and an
     active target user in D1 with no `(projectId, userId, roleOnProject)` project_members row.
     First call `insertProjectMembers(db, projectId, [userId], roleOnProject)` once for real,
     representing the concurrent writer that won just after this request took its membership
     snapshot. Then call
     `syncMembers(db, projectId, [], [userId], roleOnProject)`, passing an explicitly empty
     `existing` list—the stale pre-read from before that winner inserted the row—even though the
     database now has the membership row. Assert syncMembers() returns `added: []` and
     `removed: []`: this call's insert confirmed no new row, and its empty `existing` list has no
     row to remove. It must not derive `[userId]` from the stale `existing`/`desired` difference.
     Finally, assert project_members has exactly one row for that tuple, proving the competing
     writer's earlier insert remains the only row. This test is deliberately direct rather than
     scheduler-dependent HTTP concurrency:
     it reproduces the real two-writers-read-empty/one-insert-wins state while proving the actual
     syncMembers() result that controls assignment notification remains database-confirmed.

5. Run the full repository verification required by CLAUDE.md from portal/:

   - npm run typecheck
   - npm run build -w @quincy/web
   - npm run test --workspaces
   - npx vitest run --config packages/shared/vitest.config.ts

   The build must also check that all NotificationType fixtures and the notificationCopy() switch
   are exhaustive after adding the seventh type.

## Rollout

The shared @quincy/db recipient/type changes are consumed by both workers/background and
workers/app; the assignment helper and project-route calls are app-worker changes. Follow the
standing, unconditional production deployment order: background → webhook-ingress → app.
webhook-ingress has no code change in this plan, but its deployment remains in that required
service-binding order.

No D1 migration or data backfill is required. Existing rows remain unchanged; the new behavior
starts with the first post-deploy event or assignment.

## Routing (per docs/Subagent-Orchestration.md §2)

This is a **normal feature/refactor**, not “too small to be worth delegating”: it changes shared
recipient semantics, adds a new typed event and email behavior, modifies project creation and
PATCH membership flows, and requires coordinated real-D1 tests in both Workers. Route the build
to **Terra**, with Terra reviewing the resulting diff in a separate fresh invocation as required
by the orchestration policy. The plan itself remains in docs/plans/ until Terra approves it and
the implementation is built, verified, reviewed, deployed, and committed.
