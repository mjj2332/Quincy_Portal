# Revamp TB4B — Project Deadline, Reminders and Kanban Due Metadata Plan

**Status:** DEPLOYED TO PRODUCTION 2026-08-27 — build commit `dba2e40`, background Worker version `2668a652-dca8-4a24-a2c8-f0b712b8ff0f`, app Worker version `15b45ad1-620d-4c00-94e2-1b27484d29a0`, migration `0033` applied (remote `d1_migrations` tail `0032` → `0033`), rollback targets `c236a205-…` (background) / `8af4bcf9-…` (app). Cron `* * * * *` registered beside the retained `0 * * * *`. Passive production verification + local mutating QA (items 1–13, delivery-half deferred to the automated suite) green — see `docs/todo.md`'s TB4B entry for the full deploy/smoke record and the residual QA note. Plan: 2 Sol review rounds + fix passes, 2 Opus plan-tier reverts + fix passes, Opus final plan approval. Build: Luna build (4 test-authoring fix rounds), Sol diff review (1 Blocking/5 Should-fix — most seriously dropped admin-impersonation audit provenance on 3 new request-owned writes) + fix rounds, Sol final-focused pass (1 minor Should-fix) + fix, Opus final-draft review (APPROVE, 1 Nit fixed inline) — all findings resolved, verified independently by the orchestrating session outside Luna's sandbox after every round, including 4 separate Codex-credit-exhaustion interruptions mid-review that were resumed cleanly. Full verify sequence green: typecheck (6 workspaces), `apps/web` build, `apps/web` 412 tests, `workers/app` 221 tests/1 skipped, `workers/background` 231 tests, `packages/db` 44 tests, `packages/shared` 68 tests, `webhook-ingress` 13 tests — 989 total. This repo's fourth live-production schema migration (`0033`) — independently applied to a scratch SQLite instance by the orchestrating session outside any test framework: clean apply, `PRAGMA foreign_key_check` empty, `PRAGMA quick_check` ok, structural `fire_at` CHECK constraint correctly enforced, both real query shapes confirmed via `EXPLAIN QUERY PLAN` to use their intended indexes. Not yet committed or deployed — awaiting user go-ahead per `docs/Subagent-Orchestration.md` §2 policy 7.

## Purpose and review state

This is the formal TB4B Sol draft, revised to close every round-1 and final round-2 Sol finding plus
both Opus plan-tier reverts. It promotes the preliminary background document after checking all
seven TB4A dependencies against deployed `main` and current source. The two-round Sol cap and the
two-revert Opus cap in `docs/Subagent-Orchestration.md` §2.1 have both been reached; the final Opus
pass must approve or self-edit any remaining Blocking issue. It remains a plan, not an implementation
authorization, until that review completes.

The primary outcome remains the roadmap outcome: an authorized coordinator manages one project
Deadline and bounded advance reminders from the Project Workspace rail; all and only eligible
assigned Editors receive durable reminders; and Kanban shows Deadline/overdue metadata instead of
the card-level RAW count.

## Authority and dependency boundary

Authority for this plan, in order, is:

1. `docs/Decision-Sheet.md` D-18: the Project Workspace rail owns project Deadline/reminders,
   `editProject` authorizes writes, and the schedule uses Sydney civil-time/version rules.
2. `docs/Implementation-Plan.md` A10–A11: activity, audit, and inbox are separate; notification
   dispatch reauthorizes at send time; ambiguous email acceptance remains `unknown`; the Deadline
   has one shared revision/conflict token and delivered/archive suppress pending occurrences.
3. `docs/plans/revamp_2026_portal/roadmap/TB4B-Project-Deadline-And-Reminders.md`, every sentence.
4. `docs/plans/revamp_2026_portal/core/07-Notifications-On-Cloudflare.md`, especially the durable
   flow, semantic delivery key, reminder recipient contract, email default, and single-producer
   rule.
5. The shipped TB4/TB4A plans and, where prose differs, current source.

Sequence is TB4 → TB4A → TB4B → TB4C. TB4B may define a stable schedule-event seam for TB4C, but
must not pre-build TB4C's broad activity registry. TB5C later calls the same domain command when
Calendar moves a Deadline; it must not create a second Deadline store, conflict token, DST policy,
or notification producer.

## Resolved TB4A foundation

TB4A is deployed to production. `docs/todo.md:12-35` records build commit `15f28ef`,
documentation commit/current planning base `20d205a`, background Worker version
`c236a205-ab55-4ac6-8a04-97e2a867bd12`, app Worker version
`8af4bcf9-903e-4d3b-9979-eab34e4f70dc`, the 2026-08-27 deployment, no TB4A migration, and migration
tail `0032`. The seven former assumptions resolve as follows.

1. **Rail component and placement — resolved.** The canonical rail is
   `portal/apps/web/src/components/ProjectOverviewRail.tsx`. Its shipped order is header, Production,
   Team, Client, Collections, then conditional Dropbox. Production renders Stage, Shoot, literal
   inactive `Deadline — Not scheduled`, and literal inactive `Next reminder — None` rows in that
   exact order; Team delegates Photographers/Editors to `ProjectTeamControl`
   (`ProjectOverviewRail.tsx:46-89`; `ProjectTeamControl.tsx:92-103,167-187`). TB4B replaces only the
   two placeholder rows at `ProjectOverviewRail.tsx:58-59` with one live
   `ProjectDeadlineControl`; it does not insert another rail section or move Team/Client/Collections.
   `ProjectWorkspace.tsx:389-420` is the exact parent composition and already passes `project` and
   `canEdit` into the rail.
2. **Read-only Stage adjacency — resolved.** Stage is plain text in one `.kv` row, derived from
   `useStages()` and `project.stageKey`; it has no control, local mutation state, or mutation callback
   (`ProjectOverviewRail.tsx:43-60`). The Deadline editor may share Production styling but must not
   read or write Stage state and receives no Stage mutation prop.
3. **Rail data and freshness boundary — resolved.** Deadline is project-level state and therefore
   extends the `ProjectDetail` returned by `GET /api/projects/:id`, not membership DTOs or
   `collaboration-summary`. The exact query key is `projectDataKeys.detail(projectId)`
   (`portal/apps/web/src/lib/project-data.ts:11-28,65-77`). `useProjectDetailQuery(projectId, enabled,
   specialOwnerOwnsKey)` suppresses interval/focus/reconnect refetch whenever the exact key is owned,
   while `ProjectQueryRuntime.acquireOwner()` reference-counts that ownership
   (`project-data.ts:120-137`; `project-query-sync.ts:101-107,167-180`). While its editor is open,
   `ProjectDeadlineControl` acquires that exact detail key and releases it on close/unmount. Save
   success writes the authoritative response into the detail cache, then calls the shipped
   `invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] })`; a
   `409` leaves the owner and draft intact. The helper queues membership-ledger-covered exact keys,
   immediately invalidates the others, and publishes the existing cross-tab resource message
   (`project-data.ts:245-262`). Dashboard continues its intentionally manual `/api/projects` load;
   TB4B extends that DTO but does not pretend it is a TB2 detail resource
   (`Dashboard.tsx:122-176`;
   `docs/plans/implemented/Revamp-TB2-Route-Safe-Data-Freshness-Plan.md:207-208,464-466,677`).
4. **Membership-cycle representation — resolved.** One membership cycle is the lifetime of one exact
   `project_members.id` UUID row. `project_members.created_at` is an integer epoch-millisecond
   timestamp; the table has no version or deletion timestamp and uniqueness remains
   `(project_id,user_id,role_on_project)` (`portal/packages/db/src/schema.ts:9-13,191-208`). Add creates
   C1; removing C1 deletes that exact row permanently; re-adding creates C2 with a different UUID.
   The reminder payload's `membershipCycle` is the exact `project_members.id`, and `startedAt` is the
   exact `project_members.created_at` number. At fire, query `project_members` directly for
   `role_on_project='editor' AND created_at <= fired_at`, join `user`, require `active=1`, and call
   shared `isProjectAssignmentEligible("editor", globalRole)` using
   `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES` (`portal/packages/shared/src/project-members.ts:3-13`). At each
   channel delivery, require the same row ID still exists with the same project/user/role and the
   current user is still active/eligible. This excludes unassigned Admins and prevents C2 from
   inheriting C1's event.
5. **TB4A producer coexistence — resolved.** The shared constant is the named object
   `NOTIFICATION_OUTBOX_EVENT_TYPES`, currently containing
   `projectCommentMentioned: "project.comment.mentioned"` and
   `projectAssignmentCreated: "project.assignment.created"`; the old singular constant is only a
   backward-compatible mention alias (`portal/packages/shared/src/notification-outbox.ts:1-30`).
   `notification-delivery.ts` already has common claim/lease/channel/completion/retry/DLQ/recovery
   flow and an event-specific assignment branch inside the exact `resolveRecipient()` function
   (`portal/workers/background/src/notification-delivery.ts:103-120,165-276,278-410`;
   `portal/workers/background/src/notification-delivery.ts:586-637,687-757`). TB4B adds
   `projectDeadlineReminder: "project.deadline.reminder"` as the third object
   entry, a strict payload parser, and a third `resolveRecipient()` branch; it reuses `claimOutbox`,
   `releaseBeforeRetry`, `completeIfTerminal`, `deliverInApp`, `finishEmail`, and recovery/DLQ
   behavior rather than re-inventing the consumer. The Queue message remains exactly
   `{type:"notification_outbox",outboxId}`.
6. **Migration number — resolved.** The checked-in migration directory and
   `portal/packages/db/migrations/meta/_journal.json` both end at
   `0032_admin_impersonation`; there is no `0033*` file. TB4A added no schema or Cloudflare resource,
   and the production record still names `0032` as the applied tail (`docs/todo.md:33-35`). The plan
   therefore fixes the migration filename as
   `portal/packages/db/migrations/0033_project_deadline_and_reminders.sql`. Deployment preflight must
   still recheck remote `d1_migrations` immediately before application and must never rename an
   applied migration.
7. **Overlapping files and routes — resolved.** `projects.ts` now defines
   `editFields = baseProjectFields.partial().strict()`, so `PATCH /projects/:id` rejects every
   unrecognized key and is roster-free (`portal/workers/app/src/routes/projects.ts:20-27,415-423`).
   TB4B uses its own strict `PUT /projects/:id/deadline` schema and never adds Deadline keys to that
   generic PATCH. The four exact membership routes remain at `projects.ts:474-512`; the safe
   `GET /projects/:projectId/collaboration-summary` route is in
   `routes/project-comments.ts:64-77`, not `projects.ts`. `EditProject.tsx:114-123` renders no team
   control, and `ProjectFields.tsx:78-81,117-122` loads/renders Team only for `mode === "create"`.
   Deadline editing is rail-only and does not reintroduce a Team or Deadline editor on Edit Project.

## Verified current state on `main`

Baseline inspected for this promotion: branch `main`, commit
`20d205afbd7f0eb08deea8a0932622a94dbffc06` (the TB4A deployment-record commit). The preliminary
draft was the pre-existing untracked input promoted and revised into this plan.

### Projects and membership have no Deadline contract yet

- `projects` currently contains identity/property/client, `shoot_date`/`time_window`, Stage,
  priority/board order, order/payment, notes, Dropbox/cover, archive, and timestamps, but no Deadline,
  reminder-offset, or Deadline-version column. Its exact current SQL columns are `id`, `street`,
  `suburb`, `postcode`, `agency_name`, `agent_name`, `agent_email`, `agent_phone`, `agency_id`,
  `agent_id`, `shoot_date`, `time_window`, `stage_key`, `priority`, `board_position`, `order_no`,
  `order_id`, `invoice_amount`, `payment_status`, `notes`, `raw_folder_link`, `raw_folder_path`,
  `cover_asset_id`, `archived_at`, `archived_by`, `created_at`, and `updated_at`
  (`portal/packages/db/src/schema.ts:150-189`).
- `project_members` has exactly the shipped cycle identity described above
  (`portal/packages/db/src/schema.ts:191-208`).
- `details()` loads the whole project plus collections/member DTOs and returns it through
  `projectStageForRole()` (`portal/workers/app/src/routes/projects.ts:209-220`). The list endpoint
  joins only RAW received/expected counts onto the project row before the same Stage projection
  (`projects.ts:338-350`). Those are the exact detail/list serialization points TB4B extends.
- Generic project PATCH is roster-free and strict (`projects.ts:20-27,415-423`). Deadline writes use
  the dedicated versioned route/service and never pass Deadline columns through PATCH.

### Shipped TB4/TB4A infrastructure is durable and event-dispatched

- `notifications` is the dismissible in-app projection, unique by
  `(type,source_key,user_id)` when a source key exists
  (`portal/packages/db/src/schema.ts:955-977`). Its exact fields are ID, user/project IDs, free-text
  type/title/body, read/email outcome metadata, optional source key, and created time; it has no
  stored link or payload column. `notification_outbox` has envelope identity/version/type/source,
  project/actor/recipient/payload, status/availability/publication/lease, attempt/error/completion,
  and created/updated fields; its semantic unique key is
  `(event_type,source_key,recipient_id)`. `notification_delivery_ledger` has outbox/event/source/
  recipient/channel identity, status/attempt/outcome/error timestamps, and both
  `(outbox_id,channel)` and `(event_type,source_key,recipient_id,channel)` unique keys. Their exact
  status checks and indexes remain those at `portal/packages/db/src/schema.ts:979-1045`; TB4B adds
  only the lifecycle index named below, not new status literals.
- The only Queue message is `{ type: "notification_outbox", outboxId }`. Publication occurs after
  the domain transaction; Queue rejection leaves D1 intent recoverable
  (`portal/packages/shared/src/notification-outbox.ts:1-70`).
- Project-comment mutations and TB4A membership-add mutations each commit outbox plus `in_app` and
  `email` ledger rows in the same D1 batch as their domain write, then publish committed IDs through
  `publishNotificationOutbox()` (`portal/workers/app/src/lib/project-comments.ts:250-346`;
  `portal/workers/app/src/lib/project-members.ts`; `routes/projects.ts:257-330,497-505`).
- The background consumer recognizes mention and assignment event types. `resolveRecipient()` owns
  event-specific parsing, current authorization, and copy; `processNotificationMessage()` owns the
  common claim → resolve → in-app → email flow
  (`portal/workers/background/src/notification-delivery.ts:103-120,165-276,586-637`). TB4B adds a
  third branch without weakening shipped claim, lease, in-app idempotency, email ambiguity, retry,
  DLQ, or recovery behavior.
- The consumer uses a ten-minute lease, delivers mandatory in-app before optional email, retries
  only the two quota-admission failures, makes ambiguous acceptance `unknown`, and uses the same
  outbox for recovery/operator replay
  (`portal/workers/background/src/notification-delivery.ts:18-21,278-410,511-637,639-757`).
- Existing direct `emitNotifications()` inserts the inbox row and then best-effort sends every
  currently enabled email type; it has no personal-preference check
  (`portal/packages/db/src/notifications.ts:5-19,120-182`). Deadline reminders must not use this
  legacy direct path.
- The authenticated inbox API returns `projectId`, `type`, copy, read time, and created time but no
  source key, payload, email address, or stored link
  (`portal/workers/app/src/routes/notifications.ts:11-30`). `Topbar` derives the safe destination
  from `projectNotificationRoute()` at render time
  (`portal/apps/web/src/components/Topbar.tsx:150-155`); Deadline reminder therefore needs only its
  new inbox type plus the project ID and existing root-route behavior.
- The Admin delivery projection is event-type-generic and privacy-bounded, but its current API and
  UI expose only `pending_stuck`, `dlq`, `failed`, and `unknown`; a completed outbox whose in-app
  channel is sent and email channel is preference-suppressed matches none of them
  (`portal/workers/app/src/routes/admin.ts:37-150`;
  `portal/apps/web/src/screens/Admin.tsx:31,453`). TB4B adds one fifth, read-only
  `preference_suppressed` view to this existing operator surface; it does not serialize payload JSON
  or add a second operator queue.

### Current Sydney precedent is civil-string-only

- Checklist due values are literal `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` strings. The API validates
  calendar shape but stores no zone, offset, fold, or instant
  (`portal/workers/app/src/routes/project-subtasks.ts:17-36,101-106`).
- The checklist UI preserves that literal value in date/time inputs and displays the literal
  wall-clock time (`portal/apps/web/src/components/SubtaskChecklist.tsx:20-28,37-51`).
- Its background alert derives the current Sydney date/hour with `Intl.DateTimeFormat`, scans at
  Sydney hour 08, and claims one `due_reminder_sent_at` value before direct notification
  (`portal/workers/background/src/notifications.ts:64-139`).

TB4B reuses the readable `YYYY-MM-DDTHH:mm` Sydney wall-clock representation. It deliberately
diverges by adding the metadata required by the approved timed-Deadline contract: IANA zone,
resolved UTC offset, fold, UTC instant, and schedule version. It does not retrofit checklist
scheduling; TB4D owns that migration.

### Current UI and scheduler baseline

- `KanbanCard` computes and renders a RAW count in its footer, while the List row independently
  renders `receivedCount` (`portal/apps/web/src/screens/Dashboard.tsx:66-116`). TB4B removes only
  the former.
- `ProjectOverviewRail.tsx:46-90` is the shipped canonical rail shell; the two TB4B placeholders are
  exact rows 58-59. `ProjectWorkspace.tsx:389-420` is its parent composition.
- The typed staff route grammar has no settings/preferences route
  (`portal/packages/shared/src/staff-routes.ts:6-13,44-50,66-73`), and the account menus expose only
  navigation/sign-out (`portal/apps/web/src/components/Topbar.tsx:126-176`).
- The background Worker currently has only hourly Cron `0 * * * *`
  (`portal/workers/background/wrangler.jsonc:16-18`). Its scheduled handler runs RAW
  reconciliation, AutoHDR/subtask scans, outbox recovery, and pruning on that invocation
  (`portal/workers/background/src/index.ts:53-75`). Stalled AutoHDR, due-subtask, and recovery have
  individual catches, but RAW reconciliation and pruning do not, so an exception in either can
  prevent later hourly work. TB4B needs a distinct every-minute branch so the existing hourly jobs
  do not accidentally run 60 times as often, plus one fault boundary per individual job.
- The checked-in journal ends at 0032, and 0032 is an additive impersonation/feature-flag migration
  (`portal/packages/db/migrations/meta/_journal.json`;
  `portal/packages/db/migrations/0032_admin_impersonation.sql:1-19`). `docs/todo.md:12-35` records
  TB4A's zero-migration deploy and `0032` production tail; `0033` is locally free and fixed for
  this plan, subject only to the immediate remote-ledger preflight.

## Scope

### In scope

- One nullable, versioned project Deadline schedule independent of Shoot and checklist dates.
- A shared Sydney civil-time resolver with explicit gap/fold behavior and stored civil/zone/offset/
  fold/instant metadata.
- One combined set/edit/clear/resume Deadline-and-reminders domain command, authorized by
  `editProject`, with optimistic version conflict handling.
- Presets at 1 day, 4 hours, and 1 hour; custom offsets from 1 minute through 30 days; no advance
  offsets selected by default; at most eight unique normalized advance offsets; implicit Due-now.
- Materialized occurrence history, every-minute scanning, durable per-recipient TB4 outbox/Queue/
  ledger delivery, membership-cycle reauthorization, and the two-minute operational in-app target
  measured from `max(fire_at, occurrence.created_at)`.
- Archive-atomic and Delivered-best-effort immediate suppression with retained
  schedule/occurrence/delivery history, pending-only lifecycle channel terminalization, and
  scan-time lazy terminalization while the project remains Delivered. When Delivered-entry
  suppression commits—or a due scan terminalizes the occurrence before the project leaves
  Delivered—explicit Resume is required after the project becomes active again. If the best-effort
  follow-up misses and the project leaves Delivered before a still-future occurrence becomes due,
  that retained pending occurrence fires normally once active; this bounded residual window is
  intentional and tested rather than described as an unconditional no-auto-resume guarantee.
- Personal Notification Preferences with one default-on "Project deadline reminder emails"
  toggle. In-app remains mandatory.
- Deadline/overdue metadata on Kanban and removal of only the Kanban-card RAW count.
- A stable schedule-event intent seam for TB4C and a reusable non-Hono domain command for TB5C.
- Focused automated tests, full repository gates, manual browser QA/evidence, additive migration,
  background-first rollout, and data-retaining rollback.

### Hard non-goals

- No Stage mutation redesign, `moveProjectStage`, Kanban ordering/sorting change, Deadline-based
  sort, or automatic Stage transition.
- No checklist schedule migration, checklist range/start fields, Calendar screen/range API, or
  Calendar-specific Deadline store.
- No TB4C broad Editor-wide activity registry or broad notification fan-out. TB4B constructs one
  typed schedule-change intent per state-changing save, but TB4C owns persisting/delivering broad
  activity from that seam.
- No External Editor role/capability/projection work. TB4B leaves one reusable
  `roleOnProject="editor"` recipient model for TB4E to extend.
- No per-project mute, digest, SMS, push, third-party provider, recurrence, or multiple project
  Deadlines.
- No rewrite of the existing notification bell, Admin delivery operations, or legacy direct
  producers. The one bounded Admin extension is the read-only `preference_suppressed` filter needed
  to make TB4B's safe suppression code reachable.
- No work in `prototype/` and no copy of its architecture.

## Exact Deadline domain contract

### Canonical schedule value

Expose one API/domain value:

```ts
type ProjectDeadlineSchedule = {
  version: number; // 0 for every existing/unset project until the first state-changing save
  deadline: null | {
    localCivil: string;              // exact YYYY-MM-DDTHH:mm
    zone: "Australia/Sydney";
    utcOffsetMinutes: number;        // +600 or +660 for current Sydney rules
    fold: 0 | 1;                     // earlier=0, later=1; unambiguous values use 0
    instant: string;                 // canonical UTC ISO string derived by the server
  };
  reminderOffsetsMinutes: number[]; // canonical descending unique integers; Due-now excluded
  state: "unset" | "scheduled" | "overdue" | "inactive_delivered" | "inactive_archived";
  nextOccurrence: null | {
    kind: "advance" | "due_now";
    offsetMinutes: number;
    firesAt: string;
  };
  canResume: boolean;
};
```

The seven stored project fields proposed below are the source of truth; `state`,
`nextOccurrence`, and `canResume` are server projections. When unset, all six nullable schedule
fields are `NULL`, `deadline_version` remains defined, reminder offsets serialize as `[]`, and
`nextOccurrence` is `null`. `canResume` is false while archived or Delivered; it becomes true only
after leave/restore when retained metadata has inactive terminal occurrences eligible for an
explicit resume. A current-version pending occurrence left by a missed Delivered follow-up is still
active work after the project leaves Delivered, so it does not project `canResume=true`.

Deadline is minute-precision. Seconds/milliseconds are rejected rather than truncated. The zone is
server-owned and cannot be changed by clients. UTC offset and fold are outputs of resolution, not
trusted request fields.

### Civil-time resolution and DST

Add one pure shared module under `@quincy/shared` and use it from app, background tests, Kanban
formatting, and later Calendar code. Do not add an unpinned date-time dependency merely for this
slice; the current dependency set contains none (`portal/package.json:21-44`).

Resolution algorithm:

1. Parse an exact, calendar-valid `YYYY-MM-DDTHH:mm` string.
2. Enumerate plausible UTC instants, round-trip each through `Intl.DateTimeFormat` with
   `timeZone="Australia/Sydney"`, and retain exact civil matches.
3. Zero matches is a DST gap: return `400 deadline_nonexistent_local_time` and preserve the draft.
4. One match is unambiguous: store it with fold 0 and its computed offset.
5. Two matches is a repeated time. If the request lacks `disambiguation`, return
   `400 deadline_repeated_local_time` with safe choices `{earlier,later}` and their offsets. The
   client must explicitly resubmit one; `earlier` selects the first UTC instant/fold 0 and `later`
   selects the second/fold 1.
6. Any other candidate count is a resolver defect and fails closed.
7. Before persistence, round-trip the selected instant and assert exact civil, zone, offset, and
   fold agreement.

Persisted instant remains authoritative for firing. Persisted civil/zone/offset/fold preserve the
meaning selected at save time even if runtime timezone data changes later. A future reschedule
re-resolves under the then-current runtime rules through the same command.

Advance offsets are absolute durations in minutes subtracted from the resolved UTC instant, not
Sydney civil-calendar arithmetic. Therefore a `1440`-minute “1 day” reminder can occur at a
different Sydney wall-clock hour from its Deadline when a DST transition lies between them. The
deterministic transition fixture is the unambiguous Deadline `2026-10-04T09:00` Sydney (fold 0),
which resolves to `2026-10-03T22:00:00.000Z` and stores
`deadline_utc_offset_minutes=+660` (AEDT). Subtracting the `1440`-minute absolute duration produces
`fire_at=2026-10-02T22:00:00.000Z`, which round-trips as `2026-10-03T08:00` Sydney with computed
UTC offset `+600` (AEST), not `09:00`.

Required deterministic fixtures include Sydney's 2026 gap at `2026-10-04T02:30` and repeated time
at `2026-04-05T02:30`: earlier is UTC+11/fold 0 and later is UTC+10/fold 1.

### Reminder-offset normalization

- Presets are exactly `1440`, `240`, and `60` minutes.
- Custom values normalize to integer minutes and must be between `1` and `43200` inclusive.
- Due-now is implicit offset `0`, always materialized, never accepted in the advance-offset array,
  and does not consume one of the eight advance slots.
- Canonicalization deduplicates equal minute values across presets/custom entries and sorts them
  descending. More than eight unique normalized advance offsets is a `400`.
- No advance offsets are selected when a Deadline is first set unless the user selects/adds them.
- The API stores only the canonical integer array. Labels/units are UI concerns.

### Versioned command and route

Exact route owned by TB4B:

```text
PUT /api/projects/:id/deadline
```

Strict request union:

```ts
type SaveProjectDeadlineRequest =
  | { expectedVersion: number; deadline: null }
  | {
      expectedVersion: number;
      deadline: { localCivil: string; disambiguation?: "earlier" | "later" };
      reminderOffsetsMinutes: number[];
      resume?: true;
    };
```

The Hono route validates UUID/session/project access and `editProject`, then calls a shared
`saveProjectDeadlineSchedule()` service. The service, not the route, owns validation, versioning,
occurrence materialization, suppression, audit statement, and schedule-event intent. TB5C later
calls this same service from its authorized Calendar endpoint.

The new router is mounted at `/` beside the existing routers, so it must not call `use("*", ...)`;
authorization stays inline/path-specific, following `docs/lessons.md:116-123`. The canonical route
has no trailing slash. Its `/api/*` fallback is a 404 rather than a permissive proxy, so the
trailing-slash form must be tested to return 404 with no mutation; if route mounting changes to a
permissive wildcard later, register/gate both forms per `docs/lessons.md:786-799`.

A state-changing set, edit, clear, or explicit resume pre-resolves/normalizes the complete proposed
schedule and preallocates the new occurrence IDs plus one `auditId`. It then executes one ordered D1
`db.batch([...])` protocol, following the shipped guarded DELETE marker pattern in
`portal/workers/app/src/lib/project-members.ts:186-212`:

1. **Guarded winner statement, first:** update all project Deadline fields and increment
   `deadline_version` exactly once with one authoritative predicate containing every write fence:
   `WHERE id = ? AND deadline_version = ? AND archived_at IS NULL AND stage_key <> 'delivered'`.
   Use `RETURNING id, deadline_version`; archive/Delivered policy is not a separate pre-check.
2. **Adjacent audit/mutation marker, second:** immediately insert the preallocated
   `project.deadline.schedule_saved` `audit_log` row with
   `INSERT ... SELECT ... WHERE changes() = 1 RETURNING id`. Its `changes()` therefore observes
   only statement 1, exactly as TB4A's guarded DELETE → audit pair does. The audit row is the
   transaction's unforgeable winner marker; never use `deadline_version = expectedVersion + 1` as
   proof, because a different concurrent winner can legitimately hold that value.
3. **Marker-gated old-work retirement:** supersede old pending occurrences and suppress eligible
   old pending reminder channels only with
   `WHERE ... AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)` using that exact `auditId`.
4. **Marker-gated new materialization:** every new occurrence uses
   `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`; clear has no such
   statements. Any other schedule-owned write added later must carry the same marker predicate.
5. Inspect the marker statement's `RETURNING id`. Only when it returned the preallocated `auditId`
   may the service report `changed:true`, expose committed publication IDs, or construct and return
   the one typed `ProjectDeadlineScheduleEventIntent`. Marker absence means zero event intent even
   though D1 still executed all later batch statements as gated no-ops.

The transaction fully rolls back on any statement failure. A losing guarded update does not depend
on rollback: the absent marker makes every downstream write a no-op, so it cannot change Deadline
fields, occurrences, delivery rows, audit, publication IDs, or event intent.

For an active/non-Delivered project, an exact canonical no-op returns
`200 {changed:false,current}` without increment, audit, event, or new occurrences. Archived/
Delivered policy is evaluated before any no-op response: ordinary set/edit/clear is rejected while
the project is archived or already in Delivered; a state-changing attempt's guarded write returns
no marker and the post-batch diagnostic returns respectively `409 deadline_project_archived` or
`409 deadline_project_delivered`. This policy avoids creating pending occurrences that the scanner
is forbidden to fire and keeps Delivered history immutable.
`resume:true` is accepted only when the same schedule is inactive specifically because
delivered/archive suppression terminalized the current-version occurrences and the project is now
active/non-delivered. It deliberately creates a new version and occurrences. This prevents both
silent resume and accidental re-sending of an already-fired ordinary Due-now event.

### Schedule event seam for TB4C

Every state-changing save constructs exactly one value, never one per reminder offset or recipient:

```ts
type ProjectDeadlineScheduleEventIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type: "project.deadline.schedule_changed";
    projectId: string;
    actorId: string;
    occurredAt: string;
    source: {
      kind: "project_deadline_schedule";
      id: string;  // projectId
      key: string; // project-deadline:<projectId>:version:<newVersion>
    };
    safePayload: {
      version: number;
      operation: "set" | "clear" | "resume";
    };
    deepLink: { kind: "project"; path: string };
  };
  broadDelivery: {
    registryKey: "project.deadline.schedule_changed";
    sourceActivityId: string;
    coalesce: null;
  };
};
```

TB4B tests this builder and command result but does not persist/deliver broad activity. TB4C owns
that cutover and starts from new saves only, consistent with its no-history-backfill rule. Reminder
occurrences use a different event type and source key; they cannot masquerade as schedule changes.

### Conflict and draft preservation

If the guarded project update returns no row, its immediately adjacent marker insert and every
marker-gated downstream statement are guaranteed no-ops. Load the authoritative project only after
the batch and classify missing as `404`, archived as `409 deadline_project_archived`, already
Delivered as `409 deadline_project_delivered`, and otherwise return:

```json
{
  "error": "Project deadline changed; reload before saving.",
  "code": "deadline_version_conflict",
  "current": { "version": 7, "deadline": {}, "reminderOffsetsMinutes": [] }
}
```

with `409`. The client keeps its exact date, time, fold choice, and reminder-offset draft for a
version conflict. It offers:

- **Reload latest:** replace baseline/version with `current` while retaining the user's draft in a
  recoverable reapply buffer; and
- **Review and reapply:** show authoritative versus draft values, then explicitly resubmit the
  draft against the new version.

There is no automatic retry, field-wise merge, last-write-wins fallback, or silent replacement of
the draft by a background query refresh.

### Due-now, past Deadline, and overdue semantics

- A future schedule materializes each selected advance and one Due-now occurrence at the Deadline
  instant.
- An advance whose fire time is already `<= savedAt` is materialized as terminal `skipped` with
  reason `elapsed_at_save`; it is never sent later.
- Due-now is never skipped. Saving a past Deadline creates one current-version Due-now occurrence
  whose `fire_at` is the past Deadline instant; the next minute scan claims it as one overdue event.
- `overdue` means authoritative `now > deadline_at`. Rail and Kanban derive it from the stored UTC
  instant, not the browser's timezone or string comparison.
- Delivery copy is truthful at channel time: advance says when the Deadline is due; Due-now says
  "due now" only while current, otherwise "overdue". The deep link is the project workspace, not
  Collaboration.
- Editing/resuming a past Deadline creates at most one new-version overdue Due-now event. Old
  versions never deliver after the version changes.

## Additive migration 0033

### Numbering preflight

The migration filename is
`portal/packages/db/migrations/0033_project_deadline_and_reminders.sql`. Current source, journal,
and the TB4A production record all end at 0032; no checked-in `0033*` file exists. Before applying,
recheck the checked-in journal/snapshots, local ledger, and remote `d1_migrations`. If an intervening
change has legitimately consumed 0033 before TB4B implementation starts, stop and revise this
not-yet-applied plan/file number; never rename or overwrite an applied migration.

### Additive `projects` columns

Use bare `ALTER TABLE ... ADD COLUMN` statements rather than a generated table rebuild:

```sql
ALTER TABLE projects ADD COLUMN deadline_local_civil text;
ALTER TABLE projects ADD COLUMN deadline_zone text
  CHECK (deadline_zone IS NULL OR deadline_zone = 'Australia/Sydney');
ALTER TABLE projects ADD COLUMN deadline_utc_offset_minutes integer
  CHECK (deadline_utc_offset_minutes IS NULL OR
    (typeof(deadline_utc_offset_minutes) = 'integer' AND
     deadline_utc_offset_minutes BETWEEN -840 AND 840));
ALTER TABLE projects ADD COLUMN deadline_fold integer
  CHECK (deadline_fold IS NULL OR deadline_fold IN (0, 1));
ALTER TABLE projects ADD COLUMN deadline_at integer
  CHECK (deadline_at IS NULL OR typeof(deadline_at) = 'integer');
ALTER TABLE projects ADD COLUMN deadline_reminder_offsets_json text
  CHECK (deadline_reminder_offsets_json IS NULL OR
    json_valid(deadline_reminder_offsets_json));
ALTER TABLE projects ADD COLUMN deadline_version integer NOT NULL DEFAULT 0
  CHECK (typeof(deadline_version) = 'integer' AND deadline_version >= 0);
```

Existing projects therefore start unset/version 0 without backfill. SQLite cannot add an
all-or-none cross-column constraint without rebuilding `projects`; the versioned domain command,
serializer, migration tests, and remote postflight enforce that invariant. Implementation must
reject any `drizzle-kit generate` output that rebuilds `projects`.

### `project_deadline_occurrences`

Exact table; `fire_at`, `deadline_at`, `fired_at`, `created_at`, and `updated_at` are integer epoch
milliseconds:

```sql
CREATE TABLE project_deadline_occurrences (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  schedule_version integer NOT NULL
    CHECK (typeof(schedule_version) = 'integer' AND schedule_version >= 1),
  kind text NOT NULL CHECK (kind IN ('advance', 'due_now')),
  reminder_offset_minutes integer NOT NULL
    CHECK (typeof(reminder_offset_minutes) = 'integer' AND
      reminder_offset_minutes BETWEEN 0 AND 43200),
  fire_at integer NOT NULL,
  deadline_at integer NOT NULL,
  deadline_local_civil text NOT NULL,
  deadline_zone text NOT NULL CHECK (deadline_zone = 'Australia/Sydney'),
  deadline_utc_offset_minutes integer NOT NULL,
  deadline_fold integer NOT NULL CHECK (deadline_fold IN (0, 1)),
  status text NOT NULL
    CHECK (status IN ('pending', 'fired', 'skipped', 'superseded')),
  terminal_reason text CHECK (terminal_reason IS NULL OR terminal_reason IN (
    'elapsed_at_save', 'schedule_replaced', 'deadline_cleared',
    'project_delivered', 'project_archived'
  )),
  fired_at integer,
  created_by text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK (
    (kind = 'due_now' AND reminder_offset_minutes = 0) OR
    (kind = 'advance' AND reminder_offset_minutes BETWEEN 1 AND 43200)
  ),
  CHECK (fire_at = deadline_at - (reminder_offset_minutes * 60000)),
  CHECK (
    (status = 'pending' AND terminal_reason IS NULL AND fired_at IS NULL) OR
    (status = 'fired' AND terminal_reason IS NULL AND fired_at IS NOT NULL) OR
    (status IN ('skipped', 'superseded') AND terminal_reason IS NOT NULL AND fired_at IS NULL)
  ),
  UNIQUE (project_id, schedule_version, kind, reminder_offset_minutes)
);

CREATE INDEX project_deadline_occurrences_due_idx
  ON project_deadline_occurrences (status, fire_at, project_id, id);
CREATE INDEX project_deadline_occurrences_project_version_idx
  ON project_deadline_occurrences
    (project_id, schedule_version, status, reminder_offset_minutes, id);
```

`created_by` intentionally preserves the schedule actor as metadata without a deleting FK; it also
supplies the existing outbox table's required `actor_id`. Deadline reminder delivery never excludes
that actor: an assigned Editor who saved the schedule still receives the reminder.

### Personal preference storage

Do not add product preference columns to better-auth's `user` table. Add an extensible, additive
one-row-per-user table:

```sql
CREATE TABLE notification_preferences (
  user_id text PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE cascade,
  project_deadline_reminder_emails integer NOT NULL DEFAULT 1
    CHECK (project_deadline_reminder_emails IN (0, 1)),
  updated_at integer NOT NULL
);
```

No row means the documented default `true`; there is no backfill. A user-created row records only
an override/current value. TB4E later exposes the same self-only API to External Editors without a
second table.

### Outbox lifecycle index

Add one index used when a schedule save, Delivered follow-up, or archive suppresses still-pending
Deadline work:

```sql
CREATE INDEX notification_outbox_project_event_status_idx
  ON notification_outbox (project_id, event_type, status, source_key);
```

Update Drizzle schema, journal, and snapshot to match exact applied SQL. A second generation against
the checked-in state must be empty.

## Occurrence lifecycle

| Operation | Project schedule | Old pending occurrences | New occurrences | Reminder delivery suppression | Already delivered history |
|---|---|---|---|---|---|
| First set | version +1, fields set | none | future advances pending, elapsed advances skipped, Due-now pending | none | unchanged |
| Edit | version +1, fields replaced | `superseded/schedule_replaced` | complete new-version set | old `pending` channels only; `processing` + lease untouched | unchanged |
| Clear | version +1, fields null | `superseded/deadline_cleared` | none | old `pending` channels only; `processing` + lease untouched | unchanged |
| Set/edit/clear while already Delivered | unchanged; command returns `409 deadline_project_delivered` | unchanged | none | none | unchanged |
| Enter Delivered | metadata/version retained | immediate best-effort `superseded/project_delivered`; a missed occurrence is lazily terminalized by a due scan only while the project remains Delivered | none | immediate best-effort suppression of current `pending` channels; scan/delivery guards remain authoritative | unchanged |
| Leave Delivered | metadata/version retained | unchanged; terminal work remains inactive, but a still-pending current-version occurrence left by a missed entry follow-up resumes ordinary fire eligibility once active | none; the transition never materializes work, but surviving pending work may fire without explicit Resume | none | unchanged |
| Archive | metadata/version retained | atomically `superseded/project_archived` in the archive batch | none | atomically suppress current `pending` channels; `processing` + lease untouched | unchanged |
| Restore | metadata/version retained | unchanged | none; no automatic resume | none | unchanged |
| Explicit Resume after terminalized leave/restore | version +1, same/reviewed fields | already terminal | complete new-version set | none | unchanged |
| Due scan finds stale project state | retained current schedule | same-batch `superseded` with `project_archived`, `project_delivered`, `deadline_cleared`, or `schedule_replaced` | none | no fan-out; delivery guards still reject any pre-existing stale envelope | unchanged |

Schedule save, the Delivered best-effort follow-up, and archive terminalize a Deadline channel as
`suppressed` only while that ledger channel is still exactly `pending`—before `beginChannel()`
admits it to `processing`. This **lifecycle suppression** SQL updates pending ledger rows only,
carries the winning schedule/audit marker when applicable, and may terminalize an outbox directly
only when its status is `pending`/`queued` and it has no `processing` channel. It never clears or
steals a live outbox lease. If an in-app or email channel is already `processing`, lifecycle
suppression leaves that channel, its outbox, and its lease untouched so the lease owner finishes
the admitted channel through its ordinary convergence/classifier path. In particular, email
resolves only to
`sent`, proven pre-acceptance `failed`, or ambiguity-preserving `unknown`; a provider-accepted or
provider-ambiguous email can never be rewritten to `suppressed` (which would falsely claim no send).
Sent, failed, unknown, dismissed inbox, audit, occurrence, outbox, and ledger history are never
deleted or rewritten as pending.

A delivery invocation may resolve content before each channel, but a reminder does not trust that
pre-read as authorization. Its project version, Stage, archive state, occurrence identity,
membership/account eligibility, and—on email—the current preference are re-evaluated inside the
same guarded statement that changes the channel from `pending` to `processing`. A failed predicate
atomically leaves the channel unadmitted and terminalizes only that still-`pending` channel in the
same D1 batch. No membership removal, account deactivation, or preference write can commit in a gap
between the decisive check and admission. The no-retroactive-reclassification invariant applies to
**email admission specifically**: a schedule edit, Delivered transition, archive, membership or
account change, or preference change that commits after email admission cannot prevent or suppress
the admitted external attempt, whose result remains truthful under TB4's ordinary
`sent`/`failed`/`unknown` classifier. In-app retains the shipped post-admission second resolution;
before any inbox side effect, that redundant safety check may use `suppressWholeOccurrence()` to
terminalize an already-`processing` in-app channel because no external effect has yet occurred.

Current Stage entry to Delivered is `POST /projects/:id/stage` at
`portal/workers/app/src/routes/projects.ts:944-961`. It is currently an unguarded Drizzle ORM
`db.update(...).where(id).returning(...)` write followed by separate `audit()` and best-effort
`notifyProject()` calls; there is no D1 batch and no previous-Stage fence to join. TB4B deliberately
does **not** redesign that Stage write. Capture that ORM statement's own returned row before any
fan-out. Only when the request entered Delivered and that exact write returned a row, invoke
`suppressProjectDeadlineWork()` as a bounded, logged best-effort post-success follow-up. If the
follow-up fails or the Worker stops between the Stage write and suppression, the fire guard
(`p.stage_key <> 'delivered'`) blocks fan-out and the next due scan lazily terminalizes the stale
occurrence as `superseded/project_delivered`; a missed immediate suppression is therefore
self-healing if the occurrence becomes due while the project remains Delivered. A still-future
occurrence is not selected by that scan. If the project leaves Delivered before its `fire_at`, the
fire guard becomes valid again and the retained pending occurrence fires normally without an
explicit Resume. That residual best-effort window is an intentional availability tradeoff, remains
authorization-safe, and must be covered as an expected outcome rather than hidden behind an
unconditional no-auto-resume claim.

Archive/restore is the paired route at `projects.ts:872-895`. Archive really is a guarded
`c.env.DB.batch([...])`: add the occurrence/channel suppression statements there, gated on the
archive update's own immediately captured affected-row marker, so archive plus suppression is one
atomic operation. Restore and leaving Delivered do not call Resume or materialize occurrences;
archive-terminalized work therefore always requires explicit Resume after restore, while a pending
occurrence surviving the documented Delivered window retains its ordinary eligibility after leave.
TB5A later moves Stage semantics into `moveProjectStage`; the suppression helper remains reusable.

## Every-minute scan and TB4 delivery integration

### Cron separation and target

Add a second Cron trigger `* * * * *` while retaining `0 * * * *`. Branch on the actual trigger:

- minute trigger: `scanProjectDeadlineOccurrences()` and generic
  `recoverNotificationOutbox()` as two independent jobs;
- hourly trigger: existing RAW reconciliation, stalled AutoHDR, due-subtask scan, and pruning as
  four independent jobs;
- remove generic outbox recovery from the hourly branch once it is owned by the minute branch.

This prevents the current hourly workloads from running every minute and gives a failed initial
Queue publication another recovery opportunity on the next tick. Put a separate `try/catch` around
**every individual job** in both branches—not one catch around the branch or just the new Deadline
scan. The current handler leaves RAW reconciliation and pruning unisolated; TB4B corrects those too.
Each catch emits that job's bounded failure log and execution then continues to the next sibling, so
an earlier failure can never prevent any later job in the same scheduled invocation.

The `triggers.crons` change and the branching `scheduled()` code are one deployable correctness
unit, not independently reversible settings. A pre-TB4B handler does not inspect
`controller.cron`; if the minute trigger were left registered against that code, it would run RAW
reconciliation (including real `raw_ready` notification fan-out), stalled AutoHDR, due subtasks,
outbox recovery, and pruning 60 times as often. RAW reconciliation and pruning also lack their own
current `try/catch`, compounding rollback risk. Rollout and rollback therefore follow the explicit
trigger ordering below.

Keep `fire_at` as the true semantic Deadline-relative instant for history, ordering, copy, and
display. Measure operational eligibility latency as
`delivered_at - max(fire_at, occurrence.created_at) <= 120000` under ordinary platform operation.
For an ordinary future occurrence this still starts at `fire_at`; for a newly saved past Deadline
it starts at materialization time rather than charging the scanner for historical overdue time.
Record both semantic `fire_at` and the derived safe metric basis in bounded latency logs and warn
when the operational target is exceeded. The Queue remains at-least-once and the target is not
represented as a hard Cloudflare SLA.

Scan at most 100 due occurrences per tick, ordered by `(fire_at,project_id,id)`, and log a safe
backlog warning when the bound is reached. Implementation preflight validates the bound against
current assignment counts and Worker CPU/subrequest limits; TB4A added no new Worker resource.

### Fire transaction and membership snapshot

For each selected pending due occurrence, preallocate one `fireAuditId`, choose one `fired_at` that
defines the occurrence-time membership boundary, and execute this exact ordered D1 batch protocol:

1. **Guarded occurrence claim, first:**
   `UPDATE project_deadline_occurrences SET status='fired', fired_at=?, updated_at=? WHERE id=? AND
   status='pending' AND fire_at<=? AND EXISTS (SELECT 1 FROM projects p WHERE
   p.id=project_deadline_occurrences.project_id AND
   p.deadline_version=project_deadline_occurrences.schedule_version AND p.deadline_at IS NOT NULL
   AND p.archived_at IS NULL AND p.stage_key<>'delivered') RETURNING id`.
2. **Adjacent winner marker, second:** insert a content-free, preallocated
   `project.deadline.occurrence_fired` system `audit_log` row with
   `INSERT ... SELECT ... WHERE changes()=1 RETURNING id`. Its `changes()` observes only statement
   1, and this exact `fireAuditId` is the transaction's unforgeable winner marker.
3. **Marker-gated fan-out:** every outbox and ledger `INSERT ... SELECT` includes
   `EXISTS (SELECT 1 FROM audit_log WHERE id=:fireAuditId)` and agrees with the exact occurrence
   `id/status='fired'/fired_at=:firedAt`. Resolve every active Editor membership cycle inside those
   SQL statements: exact project, `role_on_project='editor'`, `created_at <= fired_at`, active user,
   and a global role drawn from `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`; there is no global Admin
   union. Create one outbox and two ledger rows per qualifying cycle/recipient and store the exact
   membership row ID and `created_at` in each payload. Marker absence makes every fan-out statement
   a no-op even if another scan won with a different `fired_at` or recipient set.
4. **Same-batch lazy terminalization for a guard loser:** only when this attempt's marker is absent,
   update the still-`pending`, due occurrence to `superseded` if current project state proves the
   fire guard can never become valid. Choose the reason deterministically from current state in
   this order: `project_archived`, `project_delivered`, `deadline_cleared` when
   `p.deadline_at IS NULL`, otherwise `schedule_replaced` when the current Deadline version differs.
   A concurrent fire winner is already `fired`, so this statement cannot rewrite it. This prevents
   stale past-due rows from permanently occupying the ordered `LIMIT 100` scan budget.
5. Inspect only this batch's committed `RETURNING` results. Publish only outbox IDs returned by the
   marker-gated inserts, and only when the marker statement returned `fireAuditId`. Any statement
   failure rolls the occurrence claim, marker, envelopes, and ledgers back together.

Because the recipient set is data-driven inside one atomic `INSERT ... SELECT`, add one tested SQL
UUID-v4 expression built from `randomblob()` for outbox/ledger IDs rather than pre-reading members in
JavaScript. The outbox ID must remain a canonical lowercase UUID with version nibble `4` and variant
nibble `8|9|a|b`. The currently installed Zod `3.25.76` implementation used by both Admin and
project-route `idCheck()` calls has a permissive `z.string().uuid()` regex and would not reject wrong
version/variant nibbles today (`portal/package.json:44`; `portal/workers/app/src/routes/admin.ts:22`;
`portal/workers/app/src/routes/projects.ts:37`). The repo's strict `[1-5]`/`[89ab]` `UUID` schema is
instead the staff URL-path parser at `portal/packages/shared/src/staff-routes.ts:15`, not the outbox
cursor. Require the exact v4 shape for RFC correctness, consistency with the codebase's standard
`crypto.randomUUID()` producer, and forward-safety if a future Zod version tightens validation—not
because a current outbox validator catches it. SQLite `hex()` returns uppercase, so explicit
`lower()` remains mandatory in addition to setting both nibbles. Tests assert the generated SQL IDs'
canonical lowercase v4 shape; they must not assert that current Zod rejects a malformed-nibble ID.
The public semantic source key remains the occurrence UUID. Use `RETURNING id` to collect only
committed, marker-gated outbox IDs for publication. The eligibility bindings come from the shared
constant, and a parity test proves they match `isProjectAssignmentEligible("editor", role)`.
Collision/idempotency backstops remain the
existing outbox/ledger semantic unique constraints; a duplicate scan cannot create a second event.
Assignment C1 committed before the defined fire boundary qualifies; assignment after fire does not.
If C1 is removed after fire, its already-created envelope is suppressed by delivery reauthorization;
if the same person is re-added as C2, C2's different row ID cannot inherit C1's event. Zero recipients
is a valid fired occurrence with zero outbox rows and is not repeatedly rescanned.

The guarded claim plus attempt-specific winner marker makes duplicate Cron invocations harmless;
semantic unique keys remain a second backstop. A crash before the transaction leaves the occurrence
pending; a crash after commit leaves durable outbox rows recoverable even if Queue publication never
ran. A failed state guard is not left pending forever: the same batch applies the lazy terminal
outcome above.

### Deadline reminder outbox envelope

Keep the Queue message unchanged. Add event type `project.deadline.reminder`; its semantic
`source_key` is the occurrence UUID, so the TB4 key is:

```text
(project.deadline.reminder, occurrenceId, recipientId, in_app|email)
```

Exact payload:

```ts
type ProjectDeadlineReminderOutboxPayload = {
  schemaVersion: 1;
  event: {
    type: "project.deadline.reminder";
    sourceKey: string;   // occurrenceId
    recipientId: string;
  };
  authorizationAtOccurrence: {
    kind: "project_editor_membership";
    membershipCycle: string; // exact project_members.id
    startedAt: number;       // exact project_members.created_at epoch milliseconds
  };
  reminder: {
    occurrenceId: string;
    projectId: string;
    scheduleVersion: number;
    kind: "advance" | "due_now";
    offsetMinutes: number;
    deadlineAt: string;
    deadlineLocalCivil: string;
    zone: "Australia/Sydney";
    utcOffsetMinutes: number;
    fold: 0 | 1;
  };
};
```

The payload contains no contact data, client/agent fields, notes, filenames, Dropbox paths, or
provider diagnostics. Current project street and recipient email/name are loaded during strict
resolve/copy preflight, but that pre-read never authorizes delivery; only the atomic admission SQL
does.

### Event-dispatched consumer without TB4 regression

Extend the shipped event-dispatched consumer in place:

```text
generic outbox claim/lease
  → strict event-type/version parser
  → event-specific resolver/copy preflight
  → channel admission (reminder: atomic authorization/preference + pending-to-processing update)
  → common mandatory in-app delivery, then optional email delivery
  → common email ambiguity/retry classifier
  → common completion/DLQ/recovery/operator behavior
```

`NOTIFICATION_OUTBOX_EVENT_TYPES` accepts exactly the three shipped/planned literals:
`project.comment.mentioned`, `project.assignment.created`, and `project.deadline.reminder`.
`resolveRecipient()` keeps the existing assignment and mention behavior and adds the strict reminder
payload/resolver branch. Unknown event/version fails terminally into existing operations; it is never
interpreted as one of the three. Keep the singular `NOTIFICATION_OUTBOX_EVENT_TYPE` alias only for
backward-compatible mention callers; do not rename or change either shipped literal. The Queue body,
outbox statuses, ten-minute lease, channel ordering, semantic uniqueness, notification dismissal,
retry allowlist, `unknown` invariant, DLQ, recovery, replay, and discard rules remain unchanged.

The Deadline resolver immediately before **each** channel must require:

- payload/outbox/occurrence/project IDs and schedule version agree;
- project still exists, is not archived, is not Delivered, and still has that Deadline version;
- occurrence is the exact fired occurrence and its Deadline snapshot matches the payload;
- recipient account is active and its current global role remains eligible for an Editor
  membership under the then-current role policy;
- the same `project_members.id = authorizationAtOccurrence.membershipCycle` row still exists for the
  payload project/recipient with `role_on_project='editor'`;
- that row's exact `created_at` equals payload `startedAt` and is no later than occurrence `fired_at`;
  and
- recipient has current project visibility for this safe reminder category.

Do not append unassigned Admins. Do not exclude the schedule actor. Content resolution may run
first, but the exact reminder per-channel order is: strict resolve/copy preflight; atomic
reauthorize-and-admit batch; deliver only when that batch's first statement returned the channel ID.
If the predicate is stale, that same batch suppresses only the exact `pending` channel and records
one content-free system audit with a bounded reason code. The email admission repeats all current
authorization predicates and adds the preference predicate; loss between in-app and email
therefore preserves the already-sent in-app row and suppresses pending email.

Keep the shipped helpers' distinct status contracts rather than applying one blanket predicate:

- `suppressEmailChannel()` remains `status = 'pending'` only. It runs before email admission, so it
  must never reclassify an in-flight external send; parameterizing its safe reason code does not
  change that predicate.
- `suppressWholeOccurrence()` retains its real current
  `status IN ('pending','processing')` shape. `deliverInApp()` calls `beginChannel()` first and then
  performs a second `resolveRecipient()`; if that second resolution fails, the in-app ledger is
  already `processing`. No external side effect has happened yet, so whole-occurrence suppression
  must terminalize that processing in-app row plus remaining pending work rather than strand it.

For `project.deadline.reminder`, keep `deliverInApp()`'s post-admission second
`resolveRecipient()` as a redundant safety net matching shipped mention/assignment behavior even
though reminder admission has already reauthorized atomically. Do not route reminder facts through
the unused `_resolved` parameter to bypass this check. Mention and assignment regression behavior
must remain unchanged.

### Atomic reminder channel admission

The current `beginChannel()` is not an authorization fence: its real SQL checks only ledger
`status='pending'` and an outbox in `processing` with the caller's lease token
(`portal/workers/background/src/notification-delivery.ts:410-419`). TB4B keeps the shipped
mention/assignment path behavior, but makes `beginChannel()` dispatch reminder events to one
reminder-specific D1 `DB.batch()` whose first statement folds the current authorization predicate
directly into the `pending → processing` update. The strict parser supplies immutable expected
payload facts as bindings; current mutable facts are read again by this statement, not copied from
`resolveRecipient()`.

No signature expansion is needed: `beginChannel(env, outbox, token, channel, now)` already receives
an `OutboxRow` carrying `payload_json`, `schema_version`, `event_type`, `source_key`, `project_id`,
and `recipient_id`, so the strict reminder parser can run inside `beginChannel()` itself.

The first statement has this precise shape (the implementation may factor the repeated predicate
into a SQL builder, but may not weaken or pre-read it):

```sql
UPDATE notification_delivery_ledger
SET status = 'processing', attempts = attempts + 1,
    last_attempt_at = :now, updated_at = :now,
    last_error_code = NULL, last_error = NULL
WHERE outbox_id = :outboxId AND channel = :channel AND status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM notification_outbox o
    JOIN projects p ON p.id = o.project_id
    JOIN project_deadline_occurrences occurrence
      ON occurrence.id = o.source_key AND occurrence.project_id = o.project_id
    JOIN user recipient ON recipient.id = o.recipient_id
    JOIN project_members member
      ON member.id = :membershipCycle
     AND member.project_id = o.project_id
     AND member.user_id = o.recipient_id
     AND member.role_on_project = 'editor'
    LEFT JOIN notification_preferences preference
      ON preference.user_id = o.recipient_id
    WHERE o.id = notification_delivery_ledger.outbox_id
      AND o.id = :outboxId
      AND o.status = 'processing' AND o.lease_token = :leaseToken
      AND o.schema_version = 1
      AND o.event_type = 'project.deadline.reminder'
      AND o.source_key = :occurrenceId
      AND o.project_id = :projectId AND o.recipient_id = :recipientId
      AND p.archived_at IS NULL AND p.stage_key <> 'delivered'
      AND p.deadline_version = :scheduleVersion
      AND p.deadline_at = :deadlineAtEpoch
      AND occurrence.status = 'fired' AND occurrence.fired_at IS NOT NULL
      AND occurrence.schedule_version = :scheduleVersion
      AND occurrence.kind = :kind
      AND occurrence.reminder_offset_minutes = :offsetMinutes
      AND occurrence.deadline_at = :deadlineAtEpoch
      AND occurrence.deadline_local_civil = :deadlineLocalCivil
      AND occurrence.deadline_zone = 'Australia/Sydney'
      AND occurrence.deadline_utc_offset_minutes = :utcOffsetMinutes
      AND occurrence.deadline_fold = :fold
      AND recipient.active = 1
      AND recipient.role IN (:sharedEligibleEditorRoles)
      AND member.created_at = :startedAt
      AND member.created_at <= occurrence.fired_at
      AND (:channel <> 'email' OR
           COALESCE(preference.project_deadline_reminder_emails, 1) = 1)
  )
RETURNING id;
```

`:deadlineAtEpoch` is the strict parser's UTC-instant conversion of payload `deadlineAt`, checked
against the occurrence/project integers; `:sharedEligibleEditorRoles` is expanded from
`PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`, not hard-coded separately. The envelope/source/project/
recipient bindings are also checked by the strict parser against the payload before this batch. The
exact membership join proves current project visibility and the same cycle at once.

For statements 2–4, define `A` as the exact statement-1 `SELECT` subquery through
`member.created_at <= occurrence.fired_at`, omitting only its final preference line, and define
`AP` as that same complete `SELECT` subquery with the final
`:channel <> 'email' OR COALESCE(preference.project_deadline_reminder_emails,1)=1` condition
included. Both are SQL predicates evaluated against current rows inside this batch; neither is a
JavaScript pre-read.
Statements 2–4 then run in the same D1 batch/transaction:

2. **Rejected-admission suppression, immediately adjacent.** Execute the following shape, expanding
   `A` and the preference lookup verbatim from statement 1 in real SQL:

   ```sql
   UPDATE notification_delivery_ledger
   SET status = 'suppressed',
       last_error_code = CASE
         WHEN channel = 'email'
          AND EXISTS(A)
          AND COALESCE((
            SELECT project_deadline_reminder_emails
            FROM notification_preferences
            WHERE user_id = :recipientId
          ), 1) = 0
         THEN 'recipient_preference_disabled'
         ELSE 'reauthorization_suppressed'
       END,
       last_error = CASE
         WHEN channel = 'email' AND EXISTS(A)
          AND COALESCE((SELECT project_deadline_reminder_emails
                        FROM notification_preferences
                        WHERE user_id = :recipientId), 1) = 0
         THEN 'Recipient disabled project deadline reminder email.'
         ELSE 'Current reminder authorization no longer matches.'
       END,
       updated_at = :now
   WHERE outbox_id = :outboxId AND channel = :channel AND status = 'pending'
     AND changes() = 0
     AND EXISTS (
       SELECT 1 FROM notification_outbox owned
       WHERE owned.id = :outboxId
         AND owned.status = 'processing' AND owned.lease_token = :leaseToken
     )
     AND NOT EXISTS(AP)
   RETURNING id, last_error_code;
   ```

   `A`/`AP` are documentation aliases only, not application-side authorization; implementation
   emits every repeated authorization fragment from one tested SQL builder so statement 1 and
   statement 2 cannot drift. If ownership or pending state was lost, statement 2 changes nothing.
   The immediately adjacent `changes() = 0` ensures a successful statement-1 admission can never
   also be suppressed.
3. **Suppression audit, immediately adjacent.** Insert the content-free
   `notification.delivery.suppressed` audit only with `INSERT ... SELECT ... WHERE changes() = 1`,
   so it observes statement 2 only. Metadata contains bounded event type/source key/recipient ID and
   the chosen safe code, never copy, email, payload, or preference data.
4. **Terminal convergence.** Mark the owned outbox `completed` and clear its lease only if no ledger
   channel remains `pending`/`processing`; an admitted channel therefore keeps the live lease.

The batch result is `admitted` only when statement 1 returned the ledger ID. No provider or in-app
write runs otherwise. A stale `resolveRecipient()` success can therefore neither authorize nor
admit a reminder. `beginChannel()` remains the irreversible admission boundary for status truth,
but for reminders the current authorization and email preference are now part of that boundary.
Once it admits email, no later resolver result or concurrent lifecycle/account/preference mutation
may change that channel to `suppressed` or clear its lease; the attempt resolves only through the
existing `sent`/proven-`failed`/`unknown` classifier.

### In-app and email policy

Add `project_deadline_reminder` to `NotificationType` and `ResolvedDelivery.notificationType`, but
do **not** add it to legacy `EMAIL_ENABLED_EVENTS`: Deadline email remains owned solely by the TB4
outbox consumer. Use `source_key=occurrenceId`. In-app is mandatory and is inserted before email
through existing `deliverInApp()` ledger/idempotency behavior. `projectNotificationRoute()` already
routes every non-Collaboration project type to the project root, so add regression coverage rather
than a new deep-link special case (`portal/packages/shared/src/staff-routes.ts:17,76-80`).

`finishEmail()` already calls `resolveRecipient()` before `beginChannel()`
(`portal/workers/background/src/notification-delivery.ts:511-527`), but that pre-read is not the
reminder authorization decision. It may return the current preference for copy/preflight, yet
`finishEmail()` must still call the atomic reminder admission batch even when that pre-read says
disabled. The batch re-evaluates
`COALESCE(notification_preferences.project_deadline_reminder_emails,1)` inside the guarded email
admission statement and records a disabled value through statement 2. Mention and assignment
branches preserve their behavior. Turning email off never removes inbox rows; turning it on never
replays old suppressed email.

The real `suppressEmailChannel()` currently accepts free-text `reason` but hard-codes
`last_error_code = 'reauthorization_suppressed'`. Parameterize it with a closed safe reason-code
union (at least `reauthorization_suppressed | recipient_preference_disabled`) and bind that code in
the ledger update. Authorization failures pass `reauthorization_suppressed`; only the Deadline
preference-disabled branch passes `recipient_preference_disabled`. Keep the human-safe/bounded
detail separate from the code, retain the pending-only status predicate, and preserve existing
mention/assignment behavior.

If enabled, use the existing Cloudflare `EMAIL` binding and TB4 classifier. Preserve the invariant:

- quota admission errors may return to pending/retry;
- documented permanent pre-acceptance failure is `failed`;
- any ambiguous/post-processing result is `unknown` and never auto-retried; and
- Admin replay of unknown email still requires the existing duplicate-send acknowledgement.

Add `recipient_preference_disabled` to `safeNotificationErrorCode()`'s allowlist in
`workers/app/src/routes/admin.ts`. Extend `notificationDeliveryView`, its query schema, counts, and
`notificationViewSql()` with exactly one fifth value, `preference_suppressed`, whose clause is:

```sql
o.status = 'completed'
AND o.event_type = 'project.deadline.reminder'
AND EXISTS (
  SELECT 1 FROM notification_delivery_ledger preference_suppressed_email
  WHERE preference_suppressed_email.outbox_id = o.id
    AND preference_suppressed_email.channel = 'email'
    AND preference_suppressed_email.status = 'suppressed'
    AND preference_suppressed_email.last_error_code = 'recipient_preference_disabled'
)
```

This makes the otherwise-completed row reachable without broadening the operator view to all
successful/completed traffic. Prove its serializer returns the exact allowlisted code and still no
payload/email address. In `Admin.tsx`, add the matching **Preference suppressed** filter/count; it is
read-only history, so hide replay/discard actions for rows in that view. `Admin.tsx` currently
receives `eventType` but does not render it; add a closed three-entry presentation-label map
(Comment mention / Project assignment / Deadline reminder), an “Unknown event” fallback, and an
Event column. Continue to expose no payload or email address
(`portal/workers/app/src/routes/admin.ts:37-187`;
`portal/apps/web/src/screens/Admin.tsx:31,453`).

## Personal Notification Preferences

Add a canonical typed staff route `/settings/notifications`, accessible to every authenticated
current role. Add it to desktop and phone account navigation; it is personal, never Admin-only.
Exact self-only API:

```text
GET   /api/notification-preferences
PATCH /api/notification-preferences
```

```ts
type NotificationPreferences = {
  projectDeadlineReminderEmails: boolean; // default true when no row exists
};
```

PATCH accepts exactly `{projectDeadlineReminderEmails:boolean}`, upserts only the authenticated
user's row, updates `updated_at`, and returns the authoritative value. It cannot read or update
another user. UI copy is exactly **Project deadline reminder emails**, with supporting text that
in-app Deadline reminders are always delivered. Save/error/loading/focus behavior is accessible;
optimistic display rolls back to the server value on failure.

External Editors later use the same route/API/table after TB4E grants authenticated access; no
staff directory or Admin scope is implied.

## Exact rail UI integration

Add `portal/apps/web/src/components/ProjectDeadlineControl.tsx` with the exact public props:

```ts
type ProjectDeadlineControlProps = {
  projectId: string;
  schedule: ProjectDeadlineSchedule;
  canEdit: boolean;
};
```

In `ProjectOverviewRail.tsx`, replace only lines 58-59's literal Deadline/Next-reminder placeholder
rows with:

```tsx
<ProjectDeadlineControl projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} />
```

The component renders those same two `.kv` row positions first—labels remain **Deadline** and
**Next reminder**—plus the adjacent combined editor/summary UI. Stage and Shoot stay the preceding
plain rows; `ProjectTeamControl` stays the next section. It does not receive Stage, members,
collections, or mutation callbacks.

Presentation/interaction contract:

- unset: `Not set`;
- set: civil date/time plus a visible `Sydney (Australia/Sydney)` label;
- read-only users: value, overdue/inactive state, reminder summary, and next occurrence only;
- `editProject` on an active/non-Delivered project: one combined editor for Deadline and reminder
  offsets;
- already Delivered: render the retained schedule/reminder summary as inactive, hide/disable Set,
  Edit, Clear, and Resume even for `editProject`, and show “Reminders inactive while Delivered. Move
  the project out of Delivered before changing or resuming them.” A direct/stale command still
  returns `409 deadline_project_delivered` and preserves the draft;
- date and time are both required to set; clear is explicit and confirmed when reminders exist;
- preset checkboxes for 1 day, 4 hours, 1 hour; custom add/remove; eight-slot count; Due-now shown as
  mandatory rather than a removable checkbox;
- repeated time exposes required Earlier/Later choices with offsets; gap error stays attached to
  the draft;
- summary shows skipped elapsed advances, next pending occurrence, overdue state, and delivered/
  archived inactivity; and
- after restore, and after leaving Delivered when the entry follow-up committed or a due scan
  terminalized work while still Delivered, show "Reminders inactive" and an explicit Resume action.
  No lifecycle transition auto-clicks or auto-saves it. If a missed entry follow-up left a
  still-pending current-version occurrence and the project leaves before it is due, show the active
  pending schedule/next occurrence instead; it may fire normally without Resume under the documented
  residual window.

When editor state opens, the component calls
`useProjectQueryRuntime().acquireOwner(projectDataKeys.detail(projectId))` and retains the release
function until close/unmount. This disables only that exact detail key's poll/focus/reconnect
refetch; surrounding resources continue refreshing. A successful save functionally updates
`projectDataKeys.detail(projectId).deadlineSchedule` from the authoritative response, calls
`invalidateProjectResources()` for `{kind:"detail"}`, adopts the response as baseline, and only then
closes/releases. A `409` retains the owner, exact draft, fold choice, and offset entries until the
user explicitly reloads/reapplies or cancels.

## Kanban contract

Extend only the project-list DTO/type with the minimal Deadline fields needed to render the card:
UTC instant plus stored Sydney civil/zone data. Do not send reminder-offset configuration merely
for Kanban.

On `KanbanCard`:

- set/future: render an accessible `Due …` Sydney label;
- set/past: render an overdue signal plus the Sydney date/time;
- unset: render no fabricated due date;
- remove the RAW-count element from the card footer;
- preserve Priority and every ordering/drag/open behavior; and
- leave the List row's RAW count untouched.

Formatting uses `Australia/Sydney` explicitly and `<time dateTime=<UTC ISO>>`; browser locale/time
zone must not change the date. There is no Deadline sort, board-position write, column movement, or
Stage mutation.

## Calendar compatibility contract

The shared service accepts a caller/principal and complete schedule input, not a Hono context or
rail component. TB5C's project milestone drag must call it with `expectedVersion`, preserve the
existing canonical reminder offset array unless the user explicitly changes it, re-resolve the
new Sydney civil time, and surface the same DST/conflict result. It cannot PATCH Deadline columns
directly.

Contract tests in TB4B call the service through both a rail-shaped adapter and a synthetic
Calendar-shaped adapter and require identical stored state, occurrences, audit, and single
schedule-event intent. No Calendar UI or range API is built now.

## Exact implementation slices

1. Add `portal/packages/shared/src/project-deadline.ts` for the schedule/request/event/payload types,
   Sydney civil resolver, offset normalization, and display/projection helpers; export it through
   `packages/shared/src/index.ts` and add focused shared tests. Extend
   `packages/shared/src/notification-outbox.ts` with the third named event constant/payload export.
2. Add exact migration `portal/packages/db/migrations/0033_project_deadline_and_reminders.sql`, the
   matching Drizzle project fields/tables/index in `packages/db/src/schema.ts`, and matching journal/
   snapshot, including the structural epoch-millisecond
   `fire_at = deadline_at - reminder_offset_minutes * 60000` CHECK. Extend
   `packages/db/src/notifications.ts` with the inbox type/copy but not the legacy email-enabled
   list. Add full-chain migration/query-plan tests.
3. Add `portal/workers/app/src/lib/project-deadline.ts` as the reusable versioned command,
   serializer, marker-gated/pending-only suppression helper, and schedule-event builder with focused
   D1 tests. Its ordered batch uses guarded project update → adjacent `changes() = 1` audit marker →
   marker-gated downstream writes, and its returned event intent is marker-dependent. Add strict
   route module `workers/app/src/routes/project-deadline.ts` for `PUT /projects/:id/deadline` and
   register it in `workers/app/src/index.ts`; do not change `editFields` or generic PATCH.
4. Extend `workers/app/src/routes/projects.ts` only at the exact detail/list serializers
   (`details()` and `GET /projects`) and the existing Delivered/archive call sites. At the Delivered
   ORM write, capture that statement's own `returning()` result and run immediate suppression only
   as a logged best-effort post-success hook; do not convert or otherwise redesign the Stage write.
   Preserve and test the documented residual window when that follow-up misses and the project
   leaves Delivered before a future occurrence is due. In the real archive D1 batch, add marker-
   gated suppression atomically with the archive update.
   Add `deadlineSchedule` to `apps/web/src/lib/project-data.ts`'s `ProjectDetail`; keep the exact
   `projectDataKeys.detail(projectId)` and `invalidateProjectResources()` boundary.
5. Add `workers/app/src/routes/notification-preferences.ts`, register it in `workers/app/src/index.ts`,
   and add strict self-only route tests. Add `/settings/notifications` to
   `packages/shared/src/staff-routes.ts`, render the screen from `apps/web/src/App.tsx`, and add links
   in both `apps/web/src/components/Topbar.tsx` account surfaces.
6. Add `workers/background/src/project-deadline.ts` for bounded due scanning/fire batches, including
   guarded occurrence claim → adjacent `changes()=1` fire-audit marker → marker-gated recipient
   fan-out/publication IDs and same-batch lazy terminalization of stale pending occurrences. Extend
   `workers/background/src/notification-delivery.ts` with the strict third `resolveRecipient()`
   branch and reminder admission bindings while reusing the named common helpers; dispatch
   `beginChannel()` for reminders through the exact atomic authorization/admission/suppression batch
   above, parameterize `suppressEmailChannel()`'s closed safe code while keeping it pending-only,
   retain `suppressWholeOccurrence()`'s shipped pending-or-processing behavior, and forbid
   lifecycle/email suppression from rewriting a processing email or stealing its lease. Branch the
   scheduled handler in `workers/background/src/index.ts` by `controller.cron`, wrap each of the two
   minute jobs and four hourly jobs in its own `try/catch`, and add `* * * * *` beside the retained
   hourly trigger in `workers/background/wrangler.jsonc`. Extend
   `workers/app/src/routes/admin.ts`'s safe code
   allowlist/query schema/counts/projection tests with the exact read-only
   `preference_suppressed` view, and extend `apps/web/src/screens/Admin.tsx` with its filter plus the
   closed event-label mapping above.
7. Add `apps/web/src/components/ProjectDeadlineControl.tsx`; replace exactly the two placeholder rows
   in `ProjectOverviewRail.tsx` with the exact prop call above. Do not add Deadline or Team UI to
   `EditProject.tsx`/edit-mode `ProjectFields.tsx`.
8. Extend `apps/web/src/screens/Dashboard.tsx`'s `ProjectSummary` and `KanbanCard` with minimal Deadline
   metadata, remove only the card footer RAW count, and leave `ProjectListRow`'s RAW value and all
   sorting/drag/priority code unchanged.
9. Add/extend focused tests for each seam above, including existing mention/assignment consumer
   regressions and TB2 ownership behavior.
10. Run focused/full automation, local migration proof, manual QA/evidence, formal independent diff
    review, remote migration preflight/export/apply/postflight, background-first rollout, app
    rollout, controlled smoke, and monitoring.

## Automated test plan

### Shared time/domain tests

1. Valid ordinary Sydney civil time resolves to exact instant/offset/fold and round-trips.
2. `2026-10-04T02:30` rejects as a gap.
3. `2026-04-05T02:30` requires disambiguation; earlier/later produce distinct correct instants,
   offsets, and folds. Independently test absolute-duration arithmetic with the unambiguous Deadline
   `2026-10-04T09:00` Sydney (fold 0): it resolves to `2026-10-03T22:00:00.000Z` and stores
   `deadline_utc_offset_minutes=+660` (AEDT); offset `1440` produces
   `fire_at=2026-10-02T22:00:00.000Z`, which round-trips as `2026-10-03T08:00` Sydney with computed
   UTC offset `+600` (AEST), not `09:00`.
4. Leap-day/calendar/minute precision and malformed strings reject.
5. Presets/custom minimum/maximum work; 0, negative, fractional, >30-day, and ninth unique offsets
   reject; duplicates normalize once; Due-now cannot be supplied as an advance.
6. Sydney display/overdue helpers are independent of browser/system timezone.

### Migration and command tests

7. The full migration chain applies; existing projects are null/version 0; exact columns/checks/
   tables/FKs/unique constraints/indexes exist; the database rejects an occurrence whose epoch-
   millisecond `fire_at` differs from `deadline_at - reminder_offset_minutes * 60000`; Drizzle
   matches; foreign/quick checks are clean.
8. Migration is additive only: no `projects` rebuild/copy/drop/PRAGMA toggle and no existing-row
   rewrite.
9. Set commits fields, version, complete occurrences, one audit, and one schedule-event intent; the
   adjacent audit marker is absent when the guarded project update changes zero rows, and every
   downstream statement/event-intent return is proven gated on that marker rather than on the new
   version value.
10. Edit supersedes only pending old rows, suppresses only pending old delivery channels, and
    creates one new version; processing and delivered history remain immutable.
11. Clear increments once, nulls all schedule fields, creates no new occurrence, and preserves
    history.
12. Exact no-op changes nothing. Explicit eligible Resume increments and rematerializes; ordinary
    already-fired schedules cannot be force-replayed through Resume.
13. Any failed statement rolls back project, occurrences, audit, and version together.
14. Stale expected version returns authoritative `409`; no mutation/event/audit occurs. Launch two
    concurrent saves with different schedules against the same expected version and hold them at
    the guarded batch boundary: exactly one winner lands. The loser changes zero occurrences, zero
    delivery/outbox/ledger rows, and zero audit rows, returns no event intent/publication IDs, and
    cannot match merely because the winner now has `expectedVersion + 1`.
15. Future, partially elapsed, and past schedules produce correct pending/skipped/Due-now rows;
    past creates exactly one current-version overdue event. The latency assertion uses
    `delivered_at - max(fire_at, occurrence.created_at)`, while stored/displayed `fire_at` remains
    the historical Deadline instant.

### Scan, dedupe, and delivery tests

16. Minute Cron runs Deadline scan/recovery only; hourly Cron runs existing jobs only; minute 0
    does not duplicate either branch. Fault-inject each earlier job in turn and prove every later
    job in that same minute/hourly branch still executes; include RAW reconciliation and pruning,
    which lack individual isolation in current source. Assert the deployed config contains both
    exact triggers and the handler dispatches by `controller.cron`; prove the pre-TB4B unbranched
    handler is never paired with the minute trigger in rollout/rollback fixtures.
17. Two concurrent scans of the same occurrence converge to exactly one guarded claim and one
    `project.deadline.occurrence_fired` winner marker. Hold them so their evaluated recipient sets
    could differ (for example, add an eligible membership between the attempts); prove the loser's
    marker-gated outbox/ledger writes and publication-ID result are empty, while Queue duplicate/
    Cron recovery/Admin replay still produce one ledger outcome/channel and one inbox row.
18. Queue publication failure leaves committed intent and next-minute recovery publishes it.
19. Scan bound/order/backlog logging are deterministic; zero-recipient occurrence fires exactly
    once. For each fire-guard state failure—version replaced, Deadline cleared, project Delivered,
    and project archived—the same batch lazily terminalizes the still-pending due occurrence as
    `superseded` with respectively `schedule_replaced`, `deadline_cleared`, `project_delivered`, or
    `project_archived`. None remains past-due/pending to consume a later `LIMIT 100` budget slot.
20. Assignment before fire qualifies; after fire does not; removal/deactivation before delivery
    suppresses; remove C1/re-add C2 suppresses C1 because the exact `project_members.id` differs;
    payload `startedAt` equals C1's integer `created_at`; unassigned Admin is excluded; assigned
    Admin Editor qualifies through the shared eligibility policy. Add a deterministic barrier
    test that lets reminder `resolveRecipient()` succeed, pauses before `beginChannel()`, then in
    separate parameterized cases deletes the exact membership, deactivates the account, or replaces
    C1 with C2. Release the barrier and prove the atomic admission statement returns no ledger ID,
    the still-pending channel is suppressed by the same batch, and no inbox/email delivery occurs.
21. Version edit, clear, Delivered, or archive between fire and either not-yet-admitted channel
    suppresses only `pending` stale delivery. In-app already sent is never retracted. Pause exactly
    after email `beginChannel()` changes its ledger to `processing` but before/during
    `EMAIL.send()`, trigger each suppression-eligible lifecycle class in that window, and prove the
    live lease/outbox/email ledger are not overwritten to `suppressed`: the attempt resolves through
    the real classifier to `sent`, `failed`, or `unknown` (ambiguous/provider-accepted cases never
    claim “not sent”).
22. Deadline reminder payload/source key are exact and omit disallowed fields. One schedule save
    does not create one broad event per offset/recipient.
23. Mention and assignment delivery regression suites remain green, including both existing resolver
    branches, leases, retry release, unknown email, DLQ, recovery, dismissal, replay, and privacy.
    Explicitly preserve `deliverInApp()`'s begin-then-second-resolve ordering and prove a failed
    second resolve lets `suppressWholeOccurrence()` terminalize the already-`processing` in-app
    row, while `suppressEmailChannel()` remains pending-only.
24. Preference default-on sends email; false suppresses only still-pending email; preference change
    between in-app and email uses current value; turning on later does not replay old email. The
    parameterized suppression helper writes `recipient_preference_disabled` (not the currently
    hard-coded `reauthorization_suppressed`). Add the matching deterministic barrier case: let the
    email `resolveRecipient()` preflight observe enabled, pause before `beginChannel()`, flip the
    preference to false, then release. The guarded update must not admit email; statement 2 must
    atomically suppress it with `recipient_preference_disabled`; `EMAIL.send()` must not run. The
    Admin API count/query/serializer and the read-only **Preference suppressed** UI filter must make
    that completed outbox reachable with the exact allowlisted code, no replay/discard action, and
    no payload/contact leakage. Other completed/successful rows must remain outside this filter.
25. Email success/quota/permanent/unknown/missing-config behavior preserves TB4's invariant and
    mandatory in-app independence.

### Lifecycle, API, freshness, and UI tests

26. Archive atomically terminalizes pending occurrences/channels in its real guarded batch.
    Delivered captures the ORM update's own returned row before its immediate best-effort
    suppression hook. Prove the successful-hook path terminalizes pending work and requires explicit
    Resume after leave. Then inject hook failure and prove the Stage write still succeeds and the
    fire guard blocks fan-out while Delivered. Cover both resulting paths: (a) a due scan before
    leave lazily terminalizes `project_delivered`, after which explicit Resume is required; and (b)
    leaving Delivered before a still-future pending occurrence's `fire_at` makes it ordinarily
    eligible so it fires without Resume, the intentional residual-window outcome. Archive/restore
    still creates nothing and always requires explicit Resume. Every path preserves processing/
    terminal delivery and all metadata/history. Set, edit, clear, and Resume while already Delivered
    each return `409 deadline_project_delivered`, change no version/occurrence/delivery/audit/event
    state, and the UI exposes no write action until the project leaves Delivered.
27. Deadline API requires session, project access, `editProject`, exact body, valid UUID, active
    project rules, and version. Read-only project users still receive safe schedule projection.
28. Preferences API is self-only, strict, default-on without a row, and upserts idempotently.
29. Open rail draft survives detail poll/focus/reconnect/broadcast invalidation. Successful save
    functionally replaces the detail schedule then invalidates that exact key; a subsequently mounted
    or manually reloaded Dashboard receives the extended `/api/projects` list metadata. Access loss
    terminates project state under TB2/TB4A rules. No test invents a TanStack list key that TB2
    deliberately did not ship.
30. Rail UI covers unset/set/edit/clear/loading/error/gap/fold/conflict/reapply/past/overdue/
    delivered/resume/read-only states with keyboard/focus/label/announcement assertions.
31. Kanban future and overdue labels use Sydney time; unset has no fabricated value; card RAW text
    is absent; List RAW count, Priority, order, drag, and link behavior remain.
32. Personal Preferences desktop/phone route and toggle are accessible and truthful about mandatory
    in-app.
33. Synthetic Calendar adapter calls the same domain command and produces identical version, DST,
    conflict, offsets, occurrences, audit, and event intent.
34. Future-compatibility contract proves recipient identity is project Editor membership-cycle
    based, not a separate internal-Editor recipient table or an Admin union, so TB4E can extend the
    global-role eligibility policy without a second schedule/occurrence model.

## Repository verification and source audits

From `portal/`, implementation must record:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also audit the exact current paths:

```bash
rg -n "deadline_|project_deadline|project.deadline" packages workers apps
rg -n "Australia/Sydney|deadline_nonexistent|deadline_repeated|fold|utcOffset" packages workers apps
rg -n "project.deadline.reminder|notification_outbox|notification_delivery_ledger|emitNotifications" packages workers
rg -n "role_on_project|cycle|membership|recipient_preference_disabled" workers packages
rg -n "receivedCount|expectedCount|RAW|Due|Overdue" apps/web/src/screens/Dashboard* apps/web/src
rg -n "crons|scheduled\(|recoverNotificationOutbox|scanProjectDeadline" workers/background
```

Review must prove: one schedule store, one versioned command, one occurrence producer, one Queue
message shape, one reminder semantic key, no direct `emitNotifications()` reminder path, no Admin
recipient union, no timezone-by-browser conversion, no table rebuild, no TB4A roster regression,
and no Calendar/checklist/registry scope creep.

## Local migration and query-plan proof

Apply the complete migration chain to an isolated `mktemp -d` D1 and the ordinary local database.
Record:

- migration ledger tail and exact schema/index/FK/check shapes;
- existing project null/version-0 behavior;
- occurrence due scan query uses `project_deadline_occurrences_due_idx`;
- project/version lifecycle queries use
  `project_deadline_occurrences_project_version_idx`;
- pending-only lifecycle outbox suppression uses `notification_outbox_project_event_status_idx` and
  leaves processing leases/ledgers untouched;
- preference lookup uses its primary key;
- full set/edit/clear/conflict/archive/resume transaction fixtures;
- `PRAGMA foreign_key_check` empty and `PRAGMA quick_check` `ok`; and
- a second Drizzle generation produces no migration.

Because this is a production migration, the builder must read `docs/lessons.md` before final SQL and
must not accept a locally-green generated `projects` rebuild.

## Manual QA matrix

Use the built app at `http://localhost:8787`, not Vite 5173. Chrome QA follows
`docs/Subagent-Orchestration.md`: Luna performs browser testing; a human handles any Google sign-in;
Admin impersonation covers read-only Editor/Photographer roles. Use only clearly labelled disposable
projects and approved recipient inboxes. Faults and membership races belong in deterministic local
tests, never production injection.

Capture redacted matched evidence at 1440×900, 1024×768, and 390×844.

1. **Set and presets.** Set a future Deadline with no advances, then presets/custom offsets. Verify
   visible Sydney label, Due-now, canonical summary, next occurrence, one version/event, and Kanban.
2. **Edit/clear.** Edit time/offsets and clear. Verify old pending rows terminalize, history remains,
   Kanban/detail refresh, and no stale reminder arrives.
3. **DST.** Gap is rejected without losing draft. Repeated time requires Earlier/Later and shows the
   selected offset; reload preserves it. Verify the 1-day absolute-duration fixture: the
   unambiguous Deadline `2026-10-04T09:00` Sydney (fold 0) resolves to
   `2026-10-03T22:00:00.000Z` and stores `deadline_utc_offset_minutes=+660` (AEDT); offset `1440`
   produces `fire_at=2026-10-02T22:00:00.000Z`, which displays as `2026-10-03T08:00` Sydney with
   computed UTC offset `+600` (AEST), not `09:00`. The UI must not promise same-wall-clock-hour
   calendar arithmetic.
4. **Past/overdue.** Save a past Deadline. Verify elapsed advances skipped, one overdue occurrence,
   rail/Kanban overdue, one mandatory inbox reminder, semantic `fire_at` remains historical, and the
   two-minute operational metric starts at `max(fire_at, occurrence.created_at)`.
5. **Conflict.** Keep two tabs with different schedules and the same version, release both saves
   concurrently, and verify exactly one wins. The loser gets `409`, retains its draft, shows
   authoritative values, requires explicit review/reapply, and has no occurrence/delivery/audit/
   event-intent footprint.
6. **Durable scan/dedupe.** Exercise controlled minute ticks, duplicate tick/publication, and mocked
   Queue rejection/recovery. Verify one inbox/ledger outcome and measured latency target. Attach
   deterministic concurrent-scan evidence with potentially different recipient sets and one fire
   winner marker, plus stale-guard fixtures proving replaced/cleared/Delivered/archived occurrences
   lazily terminalize instead of remaining past-due/pending at the head of the scan.
7. **Membership cycle.** With approved local principals, assign before fire, remove before delivery,
   and remove/re-add. Verify exact qualify/suppress behavior and no unassigned Admin delivery. The
   browser walkthrough is not the race proof; attach the deterministic post-resolve/pre-admission
   barrier-test evidence showing membership removal/account deactivation cannot admit a channel.
8. **Preferences.** Toggle Deadline email off/on from Personal Notification Preferences. Verify
   in-app always, email only while enabled, desktop/phone account navigation, and the Admin
   **Preference suppressed** filter reaches the completed outbox and shows
   `recipient_preference_disabled` without replay/discard controls. Attach the deterministic
   post-resolve/pre-admission preference-flip evidence; do not claim the ordinary browser toggle
   alone proves the atomic race fence.
9. **Delivered/archive.** Set future reminders, enter Delivered/archive, then leave/restore. Verify
   archive suppression commits atomically and successful Delivered entry performs its immediate
   best-effort suppression. Attach deterministic injected-failure evidence (not a browser fault
   injection) for both documented outcomes: a missed follow-up remains blocked by the fire guard and
   self-heals as `superseded/project_delivered` if scanned while still Delivered; a still-future
   pending occurrence instead fires normally without Resume if the project leaves Delivered before
   `fire_at`. Verify the successful-hook/self-healed and archive paths show inactive work and require
   explicit Resume, while the residual-window path shows the surviving pending schedule as active.
   In every path, admitted/processing email is not reclassified and metadata/history is retained.
   While still Delivered, verify the editor exposes no Set/Edit/Clear/Resume controls and a direct
   stale request returns `deadline_project_delivered` with zero writes.
10. **Read-only rail.** Impersonate a role without `editProject`; verify schedule/summary visible and
    every write control absent/disabled server-side as well as UI-side.
11. **Kanban regression.** Future/overdue/unset cards, no card RAW count, List RAW count intact,
    Priority/order/drag/link unchanged.
12. **Bell/Admin regression.** Reminder opens project root, read/read-all/dismiss work, all five
    Admin delivery filters safely label reminder rows, the bounded preference-suppressed view omits
    unrelated completed traffic, unknown replay warning remains, and no payload/email leaks.
13. **Responsive/accessibility.** Keyboard-only editor/preferences/conflict flow, focus return,
    labels, errors/live regions, zoom/reflow, no clipped popover/sheet, clean console/network.

Evidence must redact user email, street/client data, tokens, cookies, payload JSON, raw provider
errors, and membership identifiers. Record exact fixture cleanup/disposition.

## Deployment preflight and rollout

Implementation must branch from then-current `main`, confirm TB4A remains deployed/accepted, and
record:

- clean/understood worktree and base commit;
- checked-in plus remote migration tail and chosen free migration number;
- exact current background/app Worker rollback versions;
- Queue IDs/settings, both Worker bindings, Email binding, Cron inventory, and existing hourly jobs;
- absence of candidate columns/table/indexes/preferences table; and
- a verified pre-migration remote D1 recovery export in the established external
  `db-recovery/` directory, with size/hash, FK check, and quick check.

Rollout order:

1. apply the reviewed additive migration once and postflight exact schema/index/query plans,
   existing-row null/version behavior, FK check, and quick check;
2. deploy **background first**, applying the branching `scheduled()` handler and
   `triggers.crons: ["0 * * * *", "* * * * *"]` together in that same reviewed deployment, so the
   event-dispatched consumer and every-minute scanner exist before the app can save schedules.
   This immediately moves generic `recoverNotificationOutbox()` to every minute for already-live
   mention and assignment traffic as well as future Deadline reminders. That increased recovery
   cadence is an expected, monitored behavior change—not a bug; watch recovered/publication counts,
   duplicate-safe convergence, errors, and backlog from the first minute tick onward;
3. build once from the reviewed tree and deploy **app** (including web assets/API); webhook-ingress
   is unchanged and is not deployed;
4. **Human-only production mutation:** the human operator, acting knowingly as an authorized Admin,
   creates and labels the disposable project, assigns the explicitly approved Editor/inbox, saves
   the near-future Deadline, and later clears/archives the fixture. The human also owns any
   email-triggering verification and must explicitly consent to the controlled real recipient;
   Luna never creates, assigns, schedules, clears, archives, or triggers email in production.
5. **Luna passive verification only:** after each human action, Luna may use danger-mode under
   `docs/Subagent-Orchestration.md` §2.9 solely to confirm the resulting occurrence/outbox/ledger,
   bell, Admin operations, Cron, console, and network state. It performs no production write and
   does not use YOLO-mode: the disposable impersonated Photographer has zero memberships and no
   `editProject`, so §2.10 cannot authorize a Deadline save and independently forbids real staff
   email. This follows TB4A's production precedent: agent verification remains passive and any
   required mutation belongs to the human operator.
6. confirm no duplicate schedule event/inbox/email, no real client project changed, no unknown/
   DLQ/pending backlog, Cron branches correct, console/network clean, and operational latency from
   `max(fire_at, occurrence.created_at)` within target;
7. monitor at least the next several minute ticks and one hourly boundary; and
8. only after production acceptance update the real plan status, `docs/todo.md`, evidence, commit,
   and move the reviewed plan to `implemented/` with the live commit hash.

No agent signs into Google, mutates the production fixture, or sends test email. No email goes to an
uncontrolled/non-consenting address. Production fault injection, real membership removal, and real
staff deactivation are prohibited for smoke evidence. The human records every production mutation
and cleanup; Luna's evidence is explicitly labelled passive, matching the TB4A rollout record and
`docs/todo.md` production precedent rather than implying an impossible impersonated write.

## Rollback and fix-forward

Before rollout, record exact previous background/app versions. Cloudflare Cron triggers are
script-level settings applied from `triggers.crons`; they are not carried inside a Worker version.
Therefore a background version rollback alone is unsafe: the pre-TB4B handler would treat the
still-registered minute trigger like its hourly trigger and run every legacy job once per minute.

Mandatory rollback order:

1. If the editor/API is faulty, roll back app first to stop new schedule saves.
2. Before, or atomically in the same deploy as, restoring pre-TB4B background code, revert
   `portal/workers/background/wrangler.jsonc` to exactly
   `"triggers": { "crons": ["0 * * * *"] }` and apply/redeploy that trigger setting. Never leave
   `* * * * *` registered against pre-TB4B code, even transiently, and never rely on Worker-version
   rollback to change the trigger inventory.
3. Verify with Wrangler or the Cloudflare dashboard that the live Cron inventory contains exactly
   one `0 * * * *` trigger and no `* * * * *` trigger. If trigger removal and code restoration were
   not one atomic deploy, complete this verification **before** rolling the code version back.
4. Then roll back the background code if still required. Do not add a direct notification fallback.

If both app and background roll back, the old code ignores the additive columns/tables and no
editor, scheduler, or reminder producer remains active; the verified hourly-only trigger prevents
the old RAW reconciliation, stalled AutoHDR, due-subtask, recovery, and pruning jobs from running
60 times too often.

Retain all project Deadline metadata, occurrence/outbox/ledger/inbox/audit history, migration rows,
and Queue resources. Do not drop tables/columns, purge valid Queue messages, restore the full export
over production, reset unknown email, or edit `d1_migrations`. A schema defect is fixed forward with
the next reviewed migration.

Before rolling back a background version that understands Deadline events, stop new app production
and inspect/drain committed Deadline outbox work; suppress only channels still pending and never
rewrite a processing email or clear its live lease. Never let the older
mention-plus-assignment consumer misclassify or discard a valid Deadline event. Re-deploy the fixed
background consumer, then recover pending durable IDs through the existing Queue/recovery path.

Delivered/archive/schedule-version reauthorization remains authoritative during rollback: stale
pending reminder work may be delayed, but it must never bypass those fences. Unknown email remains
unknown and retains the duplicate warning.

## Acceptance checklist

- [x] TB4A is deployed and all seven former assumptions are replaced with cited shipped facts and
      exact contracts in “Resolved TB4A foundation.”
- [x] Current source/schema/Worker/Cron/UI/checked-in migration ledger was re-read at planning base
      `20d205a`; citations and the implementation file list were updated.
- [ ] One nullable versioned Sydney Deadline, offsets, Due-now, DST, conflict, overdue, Delivered
      write rejection, and explicit post-Delivered/post-restore resume contracts remain exact. The
      absolute-duration fixture is Deadline `2026-10-04T09:00` Sydney/fold 0 at
      `2026-10-03T22:00:00.000Z` with stored `deadline_utc_offset_minutes=+660`; offset `1440` yields
      `fire_at=2026-10-02T22:00:00.000Z`, displayed as `2026-10-03T08:00` Sydney at computed offset
      `+600` (AEST).
- [ ] Migration 0033 remains free in the immediate remote preflight; SQL is additive and no existing
      table rebuild is generated; the occurrence table structurally enforces its epoch-millisecond
      Deadline-relative `fire_at` equation.
- [ ] Occurrence fire and delivery bind to exact `project_members.id`/`created_at` cycle semantics and
      prove all five recipient rules, including no unassigned Admin.
- [ ] The versioned save uses guarded project update → adjacent `changes() = 1` audit marker →
      marker-gated occurrences/delivery writes and marker-dependent event intent; concurrent
      different-schedule losers leave zero downstream footprint.
- [ ] The fire batch uses guarded occurrence claim → adjacent `changes() = 1` fire-audit marker →
      marker-gated outbox/ledger/publication IDs; concurrent scans with different evaluated
      recipient sets yield one fired winner, and guard-stale due rows lazily terminalize in the same
      batch rather than poisoning the bounded scan.
- [ ] TB4's Queue message, leases, semantic channel key, in-app idempotency, email ambiguity,
      recovery, DLQ, and operations invariants are preserved for mentions and reminders;
      `suppressEmailChannel()` and lifecycle suppression remain pending-only,
      `suppressWholeOccurrence()` retains pending-or-processing for the shipped in-app second-
      resolve path, and an admitted email can never become suppressed.
- [ ] Reminder membership/account authorization and email preference are re-evaluated inside the
      same D1 batch and guarded SQL statement that admits `pending` to `processing`; deterministic
      post-resolve/pre-admission removal, deactivation, cycle-replacement, and preference-flip tests
      prove no stale recipient is admitted or delivered.
- [ ] One state-changing save creates one schedule-event intent; each reminder occurrence has one
      source key; no legacy/direct/broad duplicate producer exists.
- [ ] Preference email is default-on/current-at-delivery and mandatory in-app is unaffected;
      `recipient_preference_disabled` is actually written by the parameterized helper and safely
      surfaced through the reachable, read-only Admin `preference_suppressed` view without exposing
      unrelated completed traffic, payload, contact data, or invalid replay/discard actions.
- [ ] Archive atomically suppresses pending work in its real D1 batch; Delivered suppression is an
      own-result-gated best-effort follow-up. While the project remains Delivered, missed work is
      blocked by delivery/fire guards and self-healed by scan-time `project_delivered`
      terminalization. If the project leaves before a missed follow-up's still-future occurrence is
      due, that pending work intentionally regains ordinary fire eligibility and may fire without
      Resume;
      successful follow-up, scan-terminalized, and archive-terminalized work remains inactive until
      explicit Resume. All paths preserve history, reject schedule writes while already Delivered,
      and preserve processing email truth.
- [ ] Every minute/hourly scheduled job has its own fault boundary, and in-app operational latency
      is measured from `max(fire_at, occurrence.created_at)` without changing semantic `fire_at`;
      rollout monitors the expected every-minute recovery of existing mention/assignment traffic,
      and rollback restores/verifies exactly one hourly Cron before or with old background code.
- [ ] `ProjectDeadlineControl` replaces exactly `ProjectOverviewRail.tsx:58-59`; Kanban removes only
      card RAW count and changes no sort/order/Stage behavior.
- [ ] Calendar compatibility is through the same domain command and version, without Calendar code.
- [ ] Focused tests, full gate, local migration/query proof, manual QA matrix, visual evidence,
      deployment preflight, recovery export, background-first rollout, human-owned production
      mutation/email consent, Luna-passive smoke verification, monitoring, and rollback checkpoints
      are all completed and recorded.
