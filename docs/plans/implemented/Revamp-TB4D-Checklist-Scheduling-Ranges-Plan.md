# Revamp TB4D — Checklist Scheduling Ranges

**Status:** DEPLOYED TO PRODUCTION 2026-08-28 — merge commit `37c6219` (build `b80e45f` + 5 fix
rounds `3a7d5f0`/`7a3afa2`/`a87fa2f`/`5a683dd`/`31bdbbe`), migration `0035` applied to prod D1
(11 additive `ALTER TABLE ADD COLUMN` + `schedule_version`; postflight: 11 cols, 19 rows all
`schedule_version=0`, FK check clean, quick_check ok), background Worker version
`e7133940-5c55-4faf-9db6-4c15394dcb39`, app Worker version `65ad323b-4ba5-4c19-8b9e-5e838a3562e6`,
rollback targets `ea917b33-…` (background) / `aecde3a7-…` (app) — TB4C's versions. Pre-migration
recovery export `../db-recovery/quincy-portal-before-tb4d-20260827T194205Z.sql`
(sha256 `a5476331dc000a87d01b3c342a1d8d8db0a0a0c50113106e2133780ee9c41a31`). Deployed
`CHECKLIST_SCHEDULE_RANGES_ENABLED = true` (direct write-enabled; the inert build is tested but was
not deployed as a separate artifact — rollback path is recovery export + revert + redeploy).
Pipeline: Sol draft → fresh-Sol review ×2 → Opus plan-tier revert 1/2 → fresh-Sol revision → Opus
re-review APPROVED → Luna build + 5 fix rounds → fresh Sol diff review (4 Blocking + 4 Should-fix) →
Sol focused pass (caught an S3 optimistic-concurrency regression) → **Opus final-draft review APPROVE
FOR DEPLOY** → §5 gate green (typecheck, web build, workers/app 242, workers/background 239,
webhook 13, shared 82, db 54, web 417, drizzle no-op).

**Follow-up (Opus final-draft nits + one should-fix, non-blocking):** `TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE`
constant confirmed `2026-08-28` at deploy; `capability.ts` `active !== true` now gates every
collaboration route (comments, read-markers), not just TB4D — a correct tightening, recorded here;
`project-subtasks.ts:247` `canonicalSchedule = schedule!` restructure; vestigial
`NormalizedChecklistSchedule.startChanged/endChanged`; post-commit reread failure now throws before
the finalizer (rows stay `pending`, outbox-recoverable — only the error shape regressed);
`packages/shared/tsconfig.json` doesn't typecheck the new test suites.

## Purpose and review state

TB4D makes every project checklist item carry one truthful optional schedule without changing the
meaning of the shipped `due_date` or its due-today reminder:

```text
Unscheduled       no start and no end/due
Due-only          end/due only
Scheduled range   start plus end/due
```

The result must stand alone before Calendar exists. Existing date-only and timed due values remain
literal Sydney civil values, no start is invented, date-only values receive no fabricated midnight
instant, every timed value becomes deterministically resolvable with explicit DST fold handling, and
TB5C can later call the same guarded task command rather than defining another schedule store.

This is a plan-only artifact promoted from the TB4D roadmap after verifying the dependencies against
local `main`/`HEAD` at `f6bfd8f`. It does not authorize code, migration, deployment, or production
mutation.

### Completed review sequence

1. Fresh-Sol round 1 returned 2 Blocking + 6 Should-fix findings; all eight resolved.
2. Fresh-Sol round 2 returned 1 Blocking + 2 Should-fix + 1 Nit; all four resolved. The two allowed
   Sol rounds are exhausted.
3. Opus plan-tier review affirmed the architecture, A13 conformance, activity admission, coalescing,
   recipient resolution, migration form, production-writer enumeration, and three-app rollout
   ordering, but issued revert 1 of 2 for 5 Blocking + 6 Should-fix + 4 Nits. A fresh-Sol revision
   resolved those findings surgically without restructuring the affirmed areas.
4. Opus plan-tier **re-review APPROVED** (2026-08-27): all five revert-1 Blocking items verified
   fixed against real source; the affirmed areas were not disturbed. 5 Should-fix + 6 Nits remain as
   builder / Sol-diff-review / §5-gate clarifications, carried in the build spec.
5. Build → self-check → fresh Sol diff review → fixes → Sol focused pass → Opus final-draft review →
   §5 gate → deploy + commit. Move this file to `docs/plans/implemented/` after production deploy.

Reviewer attention is specifically requested on six deliberate decisions:

- Schedule metadata stays on `project_subtasks` through bare additive columns; a child table would
  duplicate or cross-reference the authoritative `due_date` and make one-row atomicity harder.
  Cross-column invariants are command-enforced; inconsistent out-of-band rows serialize only as a
  bounded invalid-state sentinel.
- Homogeneous range endpoints are mandatory. Date-only ranges compare as inclusive civil-date
  intervals; timed ranges compare resolved instants. Mixed date-only/timed ranges are rejected.
- A pure start-side edit writes audit and activity truth but creates no broad notification outbox.
  Any effective end/due change may create the coalesced broad row. This is the strict reading of
  “start sends no notification in v1.”
- One route-independent create-or-update task command owns both POST and PATCH persistence and
  enforces collaboration authorization before existence disclosure. Schedule-version loss and
  unrelated item-snapshot loss receive distinct `409` responses; neither is silently retried.
- Before range writes are enabled, a tested inert TB4D-aware app artifact is deployed and recorded as
  the rollback target. A pre-TB4D app version is never a valid rollback after migration `0035`.
- TB4D adds no speculative cross-project Calendar endpoint or Calendar range index. TB5C owns the
  final authorized query and may add the indexes proven by that real projection.

These are proposed decisions for review, not unresolved product blockers.

Opus re-review focus is specifically requested on the non-throwing `invalid_request` + exact-once
non-throwing finalizer contract, the one-release/version-0-only raw PATCH adapter and sunset, the
non-retryable `storage_invalid` 422 mapping, the O(1) resolver differential/CPU proof, and the
deployment-date-bound activity cutover metadata. These are surgical responses to revert 1; every
other previously affirmed area remains structurally unchanged.

## Authority and dependency boundary

Apply authorities in this order:

1. `docs/Decision-Sheet.md`, especially D-13, D-17, and D-18. D-13 authorizes additive checklist
   due/range scheduling and Calendar later (`docs/Decision-Sheet.md:41`); D-18 keeps project Deadline
   separate and Collaboration task-focused (`:31`).
2. `docs/Implementation-Plan.md` A10–A13. Activity, audit, and inbox remain separate
   (`docs/Implementation-Plan.md:132-145`); Collaboration owns checklist/task work (`:157-184`);
   homogeneous endpoints, inclusive date-only end, half-open timed ranges, Sydney/DST/version rules,
   and five-minute schedule coalescing are fixed at `:201-216`.
3. `docs/plans/revamp_2026_portal/roadmap/TB4D-Checklist-Scheduling-Ranges.md`, every sentence.
4. `docs/plans/revamp_2026_portal/core/07-Notifications-On-Cloudflare.md`, especially durable flow,
   semantic delivery identity, Editor-cycle recipients, broad email off, privacy, and one producer.
5. `docs/plans/revamp_2026_portal/core/06-Discussions-And-Notice-Board.md` and the shipped TB3 plan:
   schedule change is checklist activity, never a Calendar-specific event; coalescing limits delivery
   noise without deleting activity truth.
6. Shipped TB2, TB4, TB4A, TB4B, and TB4C plans.
7. Where shipped-plan prose differs from the repository, current `main` source wins.

Repository rules in `AGENTS.md`/`CLAUDE.md`, especially `@quincy/shared` ownership, Hono path
scoping, trailing-slash gates, additive D1 migration discipline, deploy order, and immutable media,
remain mandatory. The migration-0020 failure and date-only rules in `docs/lessons.md:27-78` are
implementation constraints, not suggestions.

Sequence is:

```text
TB4 → TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C
```

TB4D may expose the task schedule DTO and route-independent command needed by TB5C. It must not build
Calendar, a cross-project range projection, External Editor policy, or any project Deadline coupling.

## Resolved TB2/TB4/TB4A/TB4B/TB4C foundation

The following was re-verified against local `main`/`HEAD` commit `f6bfd8f`, not inferred from roadmap
prose.

### Production and migration base

- Local `main`/`HEAD` resolve to `f6bfd8f`. That commit changes only `AGENTS.md`, `CLAUDE.md`,
  `docs/Subagent-Orchestration.md`, and `docs/subagents/agy-cli.md` for the Agy-replaces-Luna testing
  policy; it changes no TB4D dependency code. Dependency conclusions verified at the prior
  `d35534b` source therefore remain unchanged after re-verification at `f6bfd8f`.
- `origin/main` and the TB4C production documentation baseline remain `d35534b`; the deployed TB4C
  build commit is separately `f857f3f` (`git log` at revision time).
- `docs/todo.md:12-103` records TB4C deployed 2026-08-27 with migration `0034`, background Worker
  `ea917b33-4ba8-4ee3-a713-ae31cc336484`, and app Worker
  `aecde3a7-c525-4836-8272-e2b4eef0ef29`.
- The checked-in migration directory and journal end at `0034_project_activity_events`
  (`portal/packages/db/migrations/meta/_journal.json`, final entry; migration SQL at
  `portal/packages/db/migrations/0034_project_activity_events.sql:1-37`). No `0035*` exists.
- Therefore the planned number is **`0035`**, conditional on an immediate remote
  `d1_migrations` preflight still ending at `0034`. An applied number is never renamed or reused.

### TB2 freshness conventions and the current checklist gap

- TB2’s project query identities are rooted at `projectDataKeys`; the current finite resource set
  includes detail, collection assets, comments, comment-read marker, and collaboration summary, but
  no checklist/subtasks key (`portal/apps/web/src/lib/project-data.ts:18-29` and
  `portal/apps/web/src/lib/project-query-sync.ts:86-94`).
- The query runtime reference-counts active owners and defers exact-key invalidation while owned
  (`portal/apps/web/src/lib/project-query-sync.ts:101-108,167-203`). This is the convention TB4D
  extends for a schedule draft and active drag.
- `SubtaskChecklist` currently performs its own one-shot local fetch and protects late results only
  with `projectCollaborationDataGeneration()` (`portal/apps/web/src/components/SubtaskChecklist.tsx:115-137`;
  generation boundary at `portal/apps/web/src/lib/project-data.ts:197-208`). It is not yet a
  route/resource query, has no bounded polling, and does not publish a subtask-specific cross-tab
  invalidation.
- TB4D must add one `subtasks(projectId)` exact key/resource while preserving title/composer/schedule
  drafts, open controls, focus, and dnd interaction. A background refresh must never replace local
  draft state or interrupt an active drag.

### TB4 durable envelope

- The only Queue body remains `{ type: "notification_outbox", outboxId }`, and
  `publishNotificationOutbox()` publishes committed IDs while D1 remains recoverable on Queue failure
  (`portal/packages/shared/src/notification-outbox.ts:1-5,38-65`).
- The finite outbox event constants already include exactly one broad event,
  `project.activity.broad` (`portal/packages/shared/src/notification-outbox.ts:7-12`). TB4D adds no
  new outbox event type, Queue, DLQ, binding, or Cron.
- Broad events are in-app-only. `buildProjectActivityStatements()` creates only an `in_app` ledger
  (`portal/packages/db/src/project-activity.ts:122-131`), and the generic consumer skips the email
  phase for broad resolution (`portal/workers/background/src/notification-delivery.ts:1274-1282`).

### TB4A membership cycles

- One cycle is one exact `project_members.id` UUID row with epoch-ms `created_at`; uniqueness remains
  `(project_id,user_id,role_on_project)` (`portal/packages/db/src/schema.ts:249-266`).
- `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor` is `['editor','admin']`, with the shared predicate in
  `portal/packages/shared/src/project-members.ts:6-13`. TB4D imports this contract and never restates
  eligible roles.
- Generic broad fan-out resolves `role_on_project='editor'`, `member.created_at <= occurred_at`,
  active accounts, and eligible global roles inside marker-gated `INSERT ... SELECT`, not a JS
  pre-read (`portal/packages/db/src/project-activity.ts:48-73,106-121`).
- Delivery admission rejoins the exact stored membership cycle and repeats the full activity-time,
  active-account, role, payload, and registry agreement inside SQL
  (`portal/workers/background/src/notification-delivery.ts:904-969`). TB4D reuses it verbatim.

### TB4B civil-time and versioned-save pattern

- The shipped constant is `PROJECT_DEADLINE_ZONE = 'Australia/Sydney'`; the Deadline schedule stores
  civil, UTC offset, fold, instant, and version (`portal/packages/shared/src/project-deadline.ts:3-31`).
- `resolveSydneyCivilTime()` validates an exact minute, rejects gaps, requires Earlier/Later for a
  repeated minute, assigns fold `0|1`, and asserts its round trip
  (`portal/packages/shared/src/project-deadline.ts:103-175`).
- `saveProjectDeadlineSchedule()` follows guarded versioned update → adjacent audit marker → all
  marker-dependent writes in one D1 batch, and returns its event/publication IDs only after the
  marker wins (`portal/workers/app/src/lib/project-deadline.ts:219-345`).
- Its stale path returns `409` with authoritative `current`; unchanged current-version submission
  returns `changed:false` and emits nothing (`portal/workers/app/src/lib/project-deadline.ts:186-188,228-243,327-335`).
- Project Deadline remains a separate project-level domain and table/column set. TB4D may extract or
  import the neutral Sydney resolver primitives, but never reads/writes `projects.deadline_*` or
  `project_deadline_occurrences`.
- The every-minute Deadline Cron exists beside the retained hourly trigger. TB4D does not use or
  modify it; checklist due reminders remain on the existing hourly `scanDueSubtasks()` path.

### TB4C registry reservation, activity builder, and generic consumer

- The closed type union already declares `project.checklist.schedule_changed`, but it is in
  `RESERVED_TYPES`, not `LIVE_TYPES` (`portal/packages/shared/src/project-activity.ts:13-45`).
- Its payload schema is currently strict `{}` (`portal/packages/shared/src/project-activity.ts:67,94`).
- Its registry entry is reserved to “TB4D checklist scheduler,” category `checklist`, source kind
  `project_checklist`, Collaboration deep link, and a leading-edge 300-second declaration
  (`portal/packages/shared/src/project-activity.ts:182`).
- The source-key validator currently accepts any key starting
  `project-checklist-schedule:` (`portal/packages/shared/src/project-activity.ts:241-273`).
- `projectActivityCoalesce()` already produces
  `project-checklist-schedule:<projectId>:<itemId>:<actorId>` when actor and `itemId` exist
  (`portal/packages/shared/src/project-activity.ts:283-292`).
- The landed comment-edit precedent constructs actor/comment coalescing identity in its intent
  (`portal/workers/app/src/lib/project-comments.ts:185-216`), while the generic builder recomputes the
  registry-approved value from `activity.safePayload`, binds `coalesce_key`, and sets
  `coalesce_until=occurredAt+300000` (`portal/packages/db/src/project-activity.ts:82-120`). TB4D
  mirrors that single path with `itemId`; it does not trust a caller-supplied alternate window/key.
- The generic renderer currently falls back to “Project activity” for the reserved type
  (`portal/packages/shared/src/project-activity.ts:412-417`).
- Tests prove the coalescing declaration/helper is available but production parsing rejects the
  reserved type (`portal/packages/shared/test/project-activity.test.ts:117-123,152-164`).
- `buildProjectActivityStatements({db,intent,winnerAuditId,createdAt})` is registry-generic: it parses
  any live intent, inserts immutable activity, resolves Editor cycles, writes the broad outbox and
  in-app ledger, and returns stable statement indexes. It has no activity-type branch
  (`portal/packages/db/src/project-activity.ts:77-131`).
- The background consumer routes only on the generic outbox event `project.activity.broad`, joins
  the immutable activity row, validates its current registry entry, renders it, and uses the same
  broad admission regardless of semantic type
  (`portal/workers/background/src/notification-delivery.ts:408-505,507-509,904-1073`).

Two consequences follow:

1. TB4D must change the shared registry/parser/renderer and add the app producer. It does **not** add
   a second consumer event branch or event type. The background Worker still must deploy first,
   because its bundled shared registry must recognize the newly live type before app production.
2. The reserved source-key shape cannot be admitted unchanged. `project_activity_events` is unique on
   `(event_type,source_key)` (`portal/packages/db/migrations/0034_project_activity_events.sql:21`), so
   actor-scoped `project-checklist-schedule:<projectId>:<itemId>:<actorId>` would suppress all later
   history for that actor/item. TB4D changes the semantic activity source key to
   `project-checklist-schedule:<projectId>:<itemId>:version:<version>` while retaining the existing
   actor-scoped string **verbatim as the coalescing key**.

### Current checklist domain, reminder, and UI

- `project_subtasks` currently has title/done/position, assignee plus `assignment_version`, nullable
  literal `due_date`, nullable `due_reminder_sent_at`, creator, and timestamps. Its only indexes are
  project/position and assignee (`portal/packages/db/src/schema.ts:340-361`). Migrations `0027` and
  `0028` created the table and reminder claim column.
- The API validates `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; create/update inputs are strict
  (`portal/workers/app/src/routes/project-subtasks.ts:18-38`).
- Checklist collaboration permission is active Admin or explicit project membership through
  `hasProjectCollaborationAccess()` (`portal/workers/app/src/middleware/capability.ts:22-33`), applied
  by `ensureProjectAccessAndExists()` before the project/item existence reads
  (`portal/workers/app/src/routes/project-subtasks.ts:56-59,73-83,107-112`).
- POST currently assembles and executes its own item INSERT/activity batch directly in the route
  (`portal/workers/app/src/routes/project-subtasks.ts:80-104`); it is not an UPDATE-command caller.
  TB4D therefore moves both create and update persistence under one explicit command owner rather
  than inaccurately describing POST as an adapter around an update-only writer.
- The PATCH computes semantic `item_updated` changes only for title/completion/assignee. A due-only
  update is audited but creates no broad activity (`portal/workers/app/src/routes/project-subtasks.ts:115-145`).
- The PATCH UPDATE snapshot-fences title/done/due/assignee. A losing fence rereads and returns the
  current row with `200`, not `409` (`portal/workers/app/src/routes/project-subtasks.ts:142-150`).
- A due change clears `due_reminder_sent_at` in that same guarded update (`:119,129`).
- Reorder has its own neighbor/position snapshot and `409` behavior (`:160-200`); delete fences its
  precomputed title and returns `409 code:'subtask_changed'` on a rename race (`:203-229`).
- The daily due path runs only during Sydney hour 08, scans unfinished assigned items with
  `substr(due_date,1,10) <= todaySydney`, claims `due_reminder_sent_at`, and compensates back to NULL
  on delivery failure (`portal/workers/background/src/notifications.ts:64-139`). A timed due already
  fires by calendar date at 08:00 Sydney, not at its minute.
- The frontend owner is `SubtaskChecklist`. `DueDateControl` edits literal date/time values in an
  anchored popover (`portal/apps/web/src/components/SubtaskChecklist.tsx:37-53`), each row composes
  due/assignee/actions at `:79-100`, and the compact composer sends one metadata POST at `:151-157`.
  Existing Quincy CSS is in `portal/apps/web/src/styles/app.css:1152-1198`.

## Scope

### In scope

- One optional, versioned schedule per `project_subtasks` row with unscheduled, due-only, and range
  states.
- Date-only and timed endpoints, exact-minute input, Sydney civil/instant/offset/fold truth, gap
  rejection, and explicit repeated-time selection.
- One shared `@quincy/shared` checklist schedule parser/resolver/DTO contract.
- One route-independent guarded create-or-update task command used by the existing POST and PATCH
  routes and callable by TB5C for update.
- Canonical schedule creation goes through the same command, with the backward-compatible POST
  `dueDate` input retained as a legacy-shaped `due_date`-only passthrough; one normalization/
  validation path owns the canonical `schedule` field and one command owns both INSERT and UPDATE SQL.
- Authoritative version conflict response and draft-preserving UI.
- Admission of `project.checklist.schedule_changed`, marker-gated audit/activity/broad production,
  pure-start activity-only behavior, and existing five-minute broad coalescing.
- Existing due reminder boundary and reset behavior.
- One TB2-compatible exact subtask resource/query identity with draft/interaction ownership.
- Quincy-native desktop, compact, and phone schedule editor using existing CSS/tokens/components.
- A tested inert TB4D-aware app artifact deployed and recorded before the write-enabling app artifact,
  plus migration, automated tests, repository audits, local migration/query proof, manual QA,
  rollout, rollback, and documentation closeout.

### Hard non-goals

- No Calendar screen/view, Dashboard Calendar tab, FullCalendar dependency, drag/resize Calendar
  interaction, or cross-project Calendar range endpoint. TB5C owns them.
- No External Editor role, capability, projection, category filter, directory, Notice Board, Admin,
  or assigned-scope Calendar behavior. TB4E owns it.
- No recurrence, recurrence table, RRULE, exception, or series editing.
- No start-side notification or reminder.
- No minute-level checklist reminder delivery change; timed end still reminds by Sydney calendar date
  at the existing 08:00 scan.
- No `due_date` rename/drop, fabricated midnight instant, or destructive history backfill.
- No change to checklist reorder, assignment, targeted assignee notification, comment,
  `item_updated`, delete, or membership-cleanup semantics beyond composing them atomically with an
  optional schedule command.
- No new Cron, Queue, DLQ, Workflow, R2, KV, binding, secret, or email preference.
- No broad email ledger or provider call.
- No Tailwind/shadcn adoption, prototype work, project Deadline coupling, or new project-level field.

## Exact checklist schedule domain contract

### Canonical endpoint types

Add a shared module `portal/packages/shared/src/checklist-schedule.ts`, exported through
`@quincy/shared`. It owns the input union, normalized persisted shape, read DTO, comparison,
equality, legacy normalization, and error codes. No route or component duplicates date/DST logic.

```ts
type ChecklistScheduleEndpointInput =
  | { kind: "date"; localCivil: string }                    // YYYY-MM-DD
  | { kind: "timed"; localCivil: string; disambiguation?: "earlier" | "later" };

type SaveChecklistScheduleRequest = {
  expectedVersion: number;
  schedule:
    | { state: "unscheduled" }
    | { state: "due_only"; end: ChecklistScheduleEndpointInput }
    | { state: "range"; start: ChecklistScheduleEndpointInput; end: ChecklistScheduleEndpointInput };
};
```

The canonical response is sufficient for the checklist, both conflict responses, the inert app, and
TB5C. It has exactly five total read states:

```ts
type ChecklistScheduleEndpointDto = {
  kind: "date" | "timed";
  localCivil: string;
  instant: string | null;
  utcOffsetMinutes: number | null;
  fold: 0 | 1 | null;
  resolution: "stored" | "derived_unambiguous";
};

type ChecklistScheduleDto =
  | {
      state: "unscheduled" | "due_only" | "range";
      version: number;
      zone: "Australia/Sydney";
      start: ChecklistScheduleEndpointDto | null;
      end: ChecklistScheduleEndpointDto | null;
      due: string | null; // exact literal project_subtasks.due_date; identical to end.localCivil
    }
  | {
      state: "legacy_unresolved"; // recoverable version-0 due-only legacy value
      version: 0;
      zone: "Australia/Sydney";
      start: null;
      end: null;
      due: string;                // exact stored due_date
      error: {
        code: "subtask_schedule_legacy_unresolved";
        reason: "invalid_literal" | "nonexistent_local_time" | "repeated_local_time";
        foldChoices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
      };
    }
  | {
      state: "invalid"; // post-0035 integrity sentinel, never a writable schedule state
      version: number;
      zone: null;
      start: null;
      end: null;
      due: string | null;
      error: {
        code: "subtask_schedule_storage_invalid";
        reason: "shape_mismatch" | "resolution_mismatch" | "ordering_invalid";
      };
};
```

For every date-only endpoint, `resolution` is `"stored"`: its literal civil date is stored directly
in `schedule_start_civil` or `due_date`, and its instant/offset/fold fields are NULL. A legacy
version-0 date-only due and a TB4D-written date-only endpoint use the same `"stored"` value; their
`version` and persisted metadata—not a second resolution label—distinguish provenance.

The total DTO state set is therefore **`unscheduled | due_only | range | legacy_unresolved |
invalid`**. Only the first three are writable input states. `legacy_unresolved` is recoverable only by
supplying a complete replacement schedule through the normal command; `invalid` is read-only and
requires incident repair. Every serialized subtask retains top-level `dueDate` as a read-only
compatibility alias for the same literal `schedule.due`; it also adds `schedule`. No response carries
two independently writable end values. This is a write-path invariant: the canonical `schedule`
field is the sole TB4D schedule writer, while the PATCH adapter and POST's `dueDate` adapter are
explicit, mutually exclusive legacy-shaped `due_date`-only passthroughs. Those adapters preserve
`schedule_version=0`, write no schedule metadata, and emit no `schedule_changed` activity or schedule
broad outbox; neither creates a second writable end authority. Neither exceptional state is silently
represented as unscheduled or due-only.

There is one serializer and one DTO shape. The subtask list response, mutation-success reread, both
conflict `current` values, full-subtask conflict projection, and inert-rollback rendering all call it
and handle all five states exhaustively. TB4D adds no subtask-detail endpoint.

### Allowed shapes and ordering

| State | Start kind | Start civil presence | `due_date` / end kind + civil | `schedule_zone` | Timed metadata | Valid ordering |
|---|---|---|---|---|---|---|
| Unscheduled | NULL | absent (`schedule_start_civil` NULL) | NULL / NULL | NULL | all NULL | n/a |
| Due-only date | NULL | absent (`schedule_start_civil` NULL) | `YYYY-MM-DD` / `date` | `Australia/Sydney` | end instant/offset/fold NULL | n/a |
| Due-only timed | NULL | absent (`schedule_start_civil` NULL) | `YYYY-MM-DDTHH:MM` / `timed` | `Australia/Sydney` | resolved end instant/offset/fold required | n/a |
| Date-only range | `date` | present literal `YYYY-MM-DD` | literal `YYYY-MM-DD` / `date` | non-NULL `Australia/Sydney` | both endpoint timed fields NULL | stored start date `<=` stored inclusive end date |
| Timed range | `timed` | present exact-minute literal | exact-minute literal / `timed` | non-NULL `Australia/Sydney` | both resolved endpoint instants/offsets/folds required | start epoch-ms `<` end epoch-ms |

The due-only rows above deliberately require `schedule_end_kind` to match the end's literal kind and
require non-NULL `schedule_zone`; an unscheduled row has no end kind and a NULL zone. A version `>=1`
row cleared to unscheduled NULLs the zone and every other schedule metadata/end column. The fail-
closed validator is generated from these complete shapes; any deviation serializes as `invalid`.

Rules:

- Range endpoints are both `date` or both `timed`. Mixed endpoints are `400
  subtask_schedule_mixed_endpoint_kinds`.
- Start-only is impossible in the typed union and is also rejected at runtime with `400
  subtask_schedule_start_without_end` if malformed input reaches the parser.
- Timed `start < end` compares resolved UTC instants, so it remains correct across DST transitions
  and repeated wall minutes.
- Date-only end is inclusive. A one-day range stores equal start/end dates and is valid. For interval
  reasoning only, normalize it as `[start civil day, day-after-end civil boundary)`; this makes the
  normalized boundary strictly ordered without storing or fabricating midnight instants. A date-only
  start after the stored inclusive end is invalid.
- Same-day timed ranges require an actual later minute. Multi-day date and timed ranges are valid.
- Timed ranges are half-open `[startInstant,endInstant)`. Date-only ranges remain stored inclusive.
  TB5C alone will derive FullCalendar’s exclusive all-day end when serializing its wire projection.
- Seconds/milliseconds are never accepted. Inputs and civil values round-trip exactly to the minute.
- No recurrence fields exist.

### Storage choice: additive parent columns, no child table

Migration `0035_project_subtask_scheduling_ranges.sql` adds these exact columns to
`project_subtasks`:

| Column | SQL shape | Meaning |
|---|---|---|
| `schedule_start_kind` | `TEXT CHECK (schedule_start_kind IS NULL OR schedule_start_kind IN ('date','timed'))` | endpoint kind; NULL outside a range/legacy row |
| `schedule_start_civil` | nullable `TEXT` | literal start date or exact-minute civil value |
| `schedule_start_at` | `INTEGER CHECK (schedule_start_at IS NULL OR typeof(schedule_start_at)='integer')` | epoch-ms instant for timed start only |
| `schedule_start_utc_offset_minutes` | `INTEGER CHECK (schedule_start_utc_offset_minutes IS NULL OR (typeof(schedule_start_utc_offset_minutes)='integer' AND schedule_start_utc_offset_minutes BETWEEN -840 AND 840))` | resolved Sydney offset for timed start only |
| `schedule_start_fold` | `INTEGER CHECK (schedule_start_fold IS NULL OR schedule_start_fold IN (0,1))` | fold for timed start only |
| `schedule_end_kind` | `TEXT CHECK (schedule_end_kind IS NULL OR schedule_end_kind IN ('date','timed'))` | endpoint kind; NULL for unscheduled/legacy rows |
| `schedule_end_at` | `INTEGER CHECK (schedule_end_at IS NULL OR typeof(schedule_end_at)='integer')` | epoch-ms instant for timed end only |
| `schedule_end_utc_offset_minutes` | `INTEGER CHECK (schedule_end_utc_offset_minutes IS NULL OR (typeof(schedule_end_utc_offset_minutes)='integer' AND schedule_end_utc_offset_minutes BETWEEN -840 AND 840))` | resolved Sydney offset for timed end only |
| `schedule_end_fold` | `INTEGER CHECK (schedule_end_fold IS NULL OR schedule_end_fold IN (0,1))` | fold for timed end only |
| `schedule_zone` | `TEXT CHECK (schedule_zone IS NULL OR schedule_zone='Australia/Sydney')` | canonical zone for every TB4D-written scheduled state |
| `schedule_version` | `INTEGER NOT NULL DEFAULT 0 CHECK (typeof(schedule_version)='integer' AND schedule_version >= 0)` | optimistic schedule revision; incremented once per semantic schedule change |

`due_date` remains the only persisted civil end/due. There is deliberately no
`schedule_end_civil`, avoiding duplicated authorities. `due_reminder_sent_at` remains on the same row.

This plan rejects a one-to-one child table because it would have to duplicate `due_date`, leave the
parent/child cross-row invariant unenforceable, or make a schedule update span two authoritative
rows. Parent columns keep the guarded write, due reset, version increment, task update, and rollback
behavior in one row.

The tradeoff is explicit: **cross-column schedule integrity is command-enforced, not SQL-enforced**.
SQLite cannot add a cross-column `start < end` table constraint through a bare `ALTER TABLE`, so the
database alone cannot reject start-only rows, mixed endpoint kinds, incomplete timed metadata, or an
unordered range. TB4D has exactly two production persistence forms, both owned by the same
create-or-update command and the same shared normalizer: POST item creation issues the INSERT; PATCH
(and later TB5C) issues the guarded UPDATE. Migration `0035` performs no data backfill or schedule
write. Reorder, delete, reminder claim/reset, assignment cleanup, and reads do not create or rewrite
schedule state. The migration itself enforces only NULL-satisfiable single-column limits:

- kinds are NULL or `date|timed`;
- zone is NULL or `Australia/Sydney`;
- offsets are NULL or integer `-840..840`;
- folds are NULL or `0|1`;
- instants are NULL or integers;
- version is an integer `>=0`.

The serializer revalidates the complete persisted shape before exposing it. Any post-migration row
whose columns disagree—start without end, mixed kinds, missing/extraneous timed metadata, zone/kind
disagreement, literal/instant round-trip mismatch, or invalid ordering—fails closed as the bounded
`state:'invalid'` DTO above. It never silently coerces the row to due-only/unscheduled, never exposes
raw start/instant/offset/fold metadata, and never lets the ordinary editor save a partial mutation.
The UI labels the item “Schedule data needs repair” and disables schedule controls; an Admin uses a
reviewed full-replacement repair command/path only if implementation later authorizes one. Absent
that separately reviewed repair path, fix the corrupt row under incident authority, not through a
normal PATCH. The inert rollback app uses this same serializer and fail-closed behavior.

Additive validation triggers could enforce some state-shape invariants without rebuilding the table,
but this plan does not choose them: they would add hidden write behavior and still could not replace
the shared Sydney resolution/round-trip contract. If direct-write risk discovered during build makes
triggers necessary, return to plan review with their exact SQL and D1 proof.

Do not accept `drizzle-kit generate`’s table-rebuild output to introduce table-level checks. As in
TB4B, keep Drizzle schema/snapshot parity, then replace unsafe generated rebuild SQL with equivalent
bare `ALTER TABLE ADD COLUMN ... CHECK(...)` statements.

### Legacy no-start interpretation

Migration `0035` backfills **nothing**:

- every existing new metadata column is NULL;
- every existing row receives only the column default `schedule_version=0`;
- `due_date IS NULL` reads as unscheduled;
- a valid existing `due_date` reads as due-only, with no start invented;
- existing date-only and timed strings remain byte-for-byte unchanged;
- no date-only midnight instant is created.

The read discriminator is total and ordered:

1. When `schedule_version=0` and every new schedule metadata column other than the non-NULL-by-
   definition `schedule_version` is NULL, interpret only `due_date`:
   - NULL → normal `unscheduled`;
   - valid date-only → normal `due_only` with no instant;
   - valid unambiguous timed minute → normal `due_only` with transient `derived_unambiguous`
     instant/offset/fold;
   - malformed literal → `legacy_unresolved(reason:'invalid_literal')`;
   - Sydney gap → `legacy_unresolved(reason:'nonexistent_local_time')`;
   - repeated Sydney minute without stored fold →
     `legacy_unresolved(reason:'repeated_local_time')` with Earlier/Later choices.
2. When `schedule_version=0` and **any** new schedule metadata column (excluding `schedule_version`,
   which is `NOT NULL DEFAULT 0`) is non-NULL, return
   `invalid(reason:'shape_mismatch')` without considering whether those columns could otherwise form a
   complete range. Version 0 is reserved for untouched legacy/unscheduled rows and is never writable
   against a metadata shape the command could not produce.
3. For `schedule_version>=1`, validate the complete TB4D metadata state. A valid shape becomes a
   normal state; any cross-column, resolution, or ordering contradiction becomes `invalid`.

`legacy_unresolved.due` preserves the exact raw `due_date` for display/re-entry but exposes no invented
endpoint or instant. The normal schedule editor remains available in a recovery mode that requires a
**complete** replacement with `expectedVersion:0`: unscheduled, a valid due-only value, or—only in the
write-enabled app—a valid range. No field-level/partial legacy patch exists. A successful replacement
persists complete metadata where applicable, increments to version 1, and follows the ordinary
end-change reminder/activity rules. The inert app renders this state and permits complete replacement
only to unscheduled/due-only; it still rejects range transitions.

`invalid` is categorically different: it means post-`0035` metadata broke the command-owned invariant,
which can occur only through an out-of-band malformed DB write or defect. It exposes no raw schedule
metadata, disables ordinary editing in both app artifacts, and requires incident repair. No read path
performs a write, and neither exceptional state is silently normalized.

New scheduled item creation stores full metadata and starts at version 1; new unscheduled creation
starts at 0. Every later semantic schedule save increments by exactly one, including a reversion to a
prior value. Clearing to unscheduled retains the incremented version while nulling all schedule/end
fields and `due_date`.

### Civil-time resolution without Deadline coupling

Do not copy `resolveSydneyCivilTime()`.

Refactor its neutral mechanics into a shared `sydney-civil-time.ts` primitive such as
`resolveSydneyCivilMinute()` and `SYDNEY_TIME_ZONE`. The neutral resolver must be **O(1) in candidate
checks**, not the current linear `-840..840` scan: obtain the provisional Sydney offset from one
`Intl.DateTimeFormat.formatToParts()` projection of the naive civil-as-UTC instant, then round-trip
only that offset and the two plausible neighbouring Sydney DST offsets (deduplicated; at most three
candidate instants). Keep `PROJECT_DEADLINE_ZONE` and `resolveSydneyCivilTime()` as
backward-compatible aliases/adapters that preserve every TB4B type, error code, copy string, and test.
`checklist-schedule.ts` imports the neutral primitive and maps errors to checklist-specific codes:

```text
subtask_schedule_invalid_local_time
subtask_schedule_nonexistent_local_time
subtask_schedule_repeated_local_time
subtask_schedule_resolver_defect
```

For a range, errors also identify `endpoint: "start"|"end"`; repeated-time errors include the two
Earlier/Later offset choices. Resolution happens before SQL assembly. Stored `*_at`, offset, and fold
must round-trip back to the supplied Sydney civil minute. Date-only validation uses calendar
components directly and never calls `Date.parse()`.

Prove the optimization with a genuinely independent test-only oracle: its own `Intl.DateTimeFormat`
parts-to-epoch math and full `-840..840` candidate-offset scan, sharing no production resolver helper.
Run that differential corpus across every minute around both Sydney DST boundaries, ordinary
winter/summer dates, pre-1895 Sydney LMT (+10:04:52), the 1895 short historical-offset transition,
years below 1000, far-future dates, malformed inputs, and explicit Earlier/Later choices. New and
oracle results must be bit-identical, including success instants/offsets/folds, choice order, every
error code, and copy. The legacy read discriminator maps the fourth
`subtask_schedule_resolver_defect` outcome to `state:'invalid', reason:'resolution_mismatch'`;
`invalid` is not a recoverable legacy state. The production resolver may perform no more than three
candidate round trips per valid civil input. With the historical-offset probes deduplicated, the
implementation performs at most six `formatToParts()` calls per valid input (three bounded offset
projections plus up to three candidate round trips), remains O(1), and stays within the measured
CPU budget (the serializer benchmark records its measured median alongside the <10 ms p95 ceiling).

The extraction is a shared-helper refactor only. It creates no dependency from checklist rows to
project Deadline rows, occurrences, reminders, routes, or UI.

## One task mutation command and API contract

### Route-independent seam

Add `portal/workers/app/src/lib/project-subtasks.ts` (or a task-command module with that ownership)
containing one exported create-or-update command:

```ts
saveProjectSubtask({
  env, projectId, principal,
  operation:
    | { kind: "create"; item: CreateItemInput; schedule?: InitialChecklistScheduleInput }
    | { kind: "update"; subtaskId: string; itemPatch?: ItemPatch;
        scheduleRequest?: SaveChecklistScheduleRequest; legacyDueDatePatch?: string | null },
  now?
})
```

The existing POST and PATCH handlers validate transport shape, then delegate all persistence to this
command. Its create branch owns the INSERT now at
`portal/workers/app/src/routes/project-subtasks.ts:80-104`; its update branch owns the guarded UPDATE.
The canonical `schedule` field on both branches calls exactly the same shared schedule normalizer and
column-mapping function before assembling SQL, so validation, civil resolution, NULL population, and
version initialization cannot diverge. The POST and PATCH legacy `dueDate` adapters are the explicit
legacy-shaped `due_date`-only passthroughs described below: they keep `schedule_version=0`, write no
schedule metadata, and emit no schedule activity or schedule broad outbox.
TB5C later calls the update branch with only `scheduleRequest`; it must not call the Hono handler,
duplicate SQL, or create a Calendar-specific event.

Authorization is command-owned, not an assumption on callers. Extract a context-free
`hasProjectCollaborationAccessForUser(env,principal,projectId)` and have the command invoke it
**before** querying project or subtask existence. Its first condition is
`principal.active === true`; false returns forbidden before either the Admin shortcut or membership
query. Only then may active Admin pass globally or an active non-Admin pass through an exact
`project_members` row. This preserves the effective shipped route policy: today
`requireSession` rejects inactive sessions before the collaboration helper, while that helper’s
membership branch itself lacks the active check
(`portal/workers/app/src/middleware/session.ts:7-20`;
`portal/workers/app/src/middleware/capability.ts:27-33`). Moving the same effective guard into the
reusable command is defense in depth, not a POST/PATCH behavior change.

Routes may retain an early identical gate for transport ergonomics, but the command repeats it and
returns the same 403/404 classification. Every future caller, including TB5C, receives this guard
automatically. Direct invocation with an outsider, inactive/disallowed principal, forged project/item
ID, or a principal whose membership was removed must never reach the project/item existence read or
any mutation/audit/activity statement.

Extend the strict PATCH body to:

```ts
{
  title?: string;
  done?: boolean;
  assigneeId?: string | null;
  schedule?: SaveChecklistScheduleRequest;
  dueDate?: string | null; // one-release legacy adapter; mutually exclusive with schedule
}
```

`schedule` is the sole canonical PATCH field, but retain raw `dueDate` for one release as a
stale-predeploy-tab recovery adapter. It is mutually exclusive with `schedule`, accepted only when the
authoritative row is an untouched version-0 legacy unscheduled/due-only shape, and updates only the
legacy `due_date` column (resetting `due_reminder_sent_at` on change) without normalization, resolver
metadata, version bump, `schedule_changed` activity, or schedule broad outbox. A well-formed date or
timed legacy value remains a version-0 `due_only` read, while a post-TB4D shape, including any range or
version `>=1`, returns `400 code:'subtask_schedule_reload_required'` with copy
that tells the user to reload and reopen the schedule editor; it never overwrites newer schedule
truth. Remove this adapter in the first reviewed app release after TB4D production closeout. This is
the only temporary carve-out from “no two independently writable end values”: there is still one
canonical normalizer, one command owner, and one canonical schedule SQL mapping; the adapter's
legacy `due_date`-only SQL form is explicit. Unknown legacy fields remain rejected by `.strict()`.

For item creation, extend the existing POST with optional `schedule` (without `expectedVersion`
because the item does not exist), and retain `dueDate` permanently as a backward-compatible
legacy-shaped due-only adapter; providing both is a command-returned `400`. The POST adapter inserts only
`due_date`, leaves every schedule metadata column NULL and `schedule_version=0`, and emits no
`schedule_changed` activity or schedule broad outbox. Only the canonical `schedule` field enters the
shared parser, resolver, and column mapper. There is one command owner with two explicit SQL forms—
not a route-side create writer plus a command-side update writer.

Assignee-eligibility validation also moves into `saveProjectSubtask` after its authorization gate and
before SQL assembly. Remove the duplicated POST/PATCH route pre-checks now at
`portal/workers/app/src/routes/project-subtasks.ts:84,114`; an ineligible non-null assignee returns
`invalid_request` with `code:'subtask_assignee_ineligible'`. The routes retain only transport parsing
and do not make an independently drifting participant decision.

Initial item creation is one `project.checklist.item_created` operation, even when it includes an
initial schedule. It gets one create audit and one item-created activity, not an artificial second
schedule-changed event. The returned schedule/version is authoritative. Every later schedule edit is
the schedule operation defined below.

The create branch also retains POST’s existing inline last-position behavior inside the command: read
the final row with `ORDER BY position DESC, id DESC LIMIT 1`, then assign
`(last?.position ?? 0) + POSITION_STEP`
(`portal/workers/app/src/routes/project-subtasks.ts:85,96`). It does **not** call
`computeInsertPosition`, which remains owned by the reorder handler at `:176`. Moving the inline
allocation out of the route must not change its ordering semantics. A
scheduled create still emits only `project.checklist.item_created`: never `item_updated` and never
`schedule_changed`. Its targeted assignment notice remains the shipped create notice.

### Command result and shared finalization boundary

The command owns authorization, reads, validation, SQL, and authoritative rereads. It performs no
Queue publication or targeted notification call itself. It returns this discriminated result:

```ts
type ProjectSubtaskCommandResult =
  | {
      outcome: "created" | "updated" | "noop";
      item: ProjectSubtaskDto; // authoritative item; item.schedule is ChecklistScheduleDto
      broadPublicationIds: string[];
      assignmentNotice: null | {
        projectId: string;
        actorId: string;
        assigneeId: string | null;
        subtaskId: string;
        assignmentVersion: number;
      };
    }
  | {
      outcome: "invalid_request";
      status: 400;
      code: string;
      message: string;
      details?: {
        endpoint?: "start" | "end";
        choices?: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
      };
    }
  | { outcome: "forbidden" }
  | { outcome: "not_found"; target: "project" | "subtask" }
  | {
      outcome: "schedule_conflict";
      current: ChecklistScheduleDto;
      currentSubtask?: ProjectSubtaskDto; // present when itemPatch was supplied
    }
  | {
      outcome: "item_conflict";
      current: ChecklistScheduleDto;
      currentSubtask: ProjectSubtaskDto;
    }
  | { outcome: "storage_invalid"; current: ChecklistScheduleDto & { state: "invalid" } };
```

Contract details:

- `item` always comes from the post-commit/no-op authoritative reread and uses the same five-state
  serializer as the list and conflicts.
- `broadPublicationIds` contains every committed broad outbox ID returned by the item-created,
  item-updated, and/or schedule-changed statement bundles. It is empty on no-op and every non-success
  outcome. Statement offsets remain internal to the command.
- `assignmentNotice` is non-null only when a winning create/update requires the shipped targeted
  assignee delivery; it carries the winning `assignmentVersion`. It is null for no-op, unchanged
  assignment, and all rejection/failure/conflict outcomes.
- `invalid_request` is the command-owned non-throwing arm for every semantic `400`: mixed/start-only
  shape, invalid/nonexistent/repeated/defective civil resolution (including endpoint and Earlier/Later
  choices), start/end ordering, POST or transitional PATCH supplying both `dueDate` and `schedule`,
  transitional raw-PATCH reload requirement, and assignee ineligibility. Its `code` is one stable
  bounded code such as the named `subtask_schedule_*` codes or `subtask_assignee_ineligible`; its
  `message` supplies the mapped client copy. Strict JSON/unknown-field parsing remains route-owned and
  may return before command invocation, but every parsed semantic request receives this result rather
  than an expected-validation throw. The same arm carries the inert build-time gate as `status:503,
  code:'subtask_schedule_ranges_disabled'` before normalization for new range transitions; legacy
  version-0 `dueDate`, clear, and due-only edits remain available while disabled.
- `not_found` maps to the existing 404 without leaking a forbidden project. Both conflict outcomes
  map to the two 409 bodies below. `storage_invalid` fails closed without mutation and maps to a
  non-retryable `422 code:'subtask_schedule_storage_invalid'` with
  `current:<the canonical invalid DTO>` and repair-required copy; it is a resource-integrity condition,
  not a transient server failure. Ordinary UI never submits it because editing is disabled.
  This `422` trigger applies only when the request carries `schedule` or transitional `dueDate` and
  the authoritative row serializes as `invalid`; a pure title/done/assignee PATCH against a directly
  corrupted row preserves today's commit behavior and returns the item with `schedule.state:'invalid'`.

Define the create-time shape used above as:

```ts
type InitialChecklistScheduleInput =
  | { state: "unscheduled" }
  | { state: "due_only"; end: ChecklistScheduleEndpointInput }
  | { state: "range"; start: ChecklistScheduleEndpointInput; end: ChecklistScheduleEndpointInput };
```

Add one `finalizeProjectSubtaskCommandResult({env,executionCtx,result})` step and require **every**
caller—POST, PATCH, and later TB5C—to invoke it exactly once for every non-throwing command result
before returning its mapped response. Expected request rejection never throws; only an unexpected
internal fault may bypass result finalization and propagate through the Worker error boundary.
The finalizer:

1. schedules `publishNotificationOutbox(env.NOTIFICATION_QUEUE,env.DB,broadPublicationIds)` through
   `executionCtx.waitUntil` when IDs exist; Queue failure remains recoverable from D1;
2. invokes `notifySubtaskAssignee(env,assignmentNotice)` exactly once when notice data exists;
3. performs no work for no-op, invalid-request, forbidden, not-found, storage-invalid, or either
   conflict result.

This mirrors the shipped Deadline command/route boundary
(`portal/workers/app/src/lib/project-deadline.ts:323-344`;
`portal/workers/app/src/routes/project-deadline.ts:31-33`) while covering the targeted assignment
side effect that Deadline does not have. The command extracts and returns publication IDs directly
from its own batch-result indexes. Routes and every future caller may map transport status/copy, but
may not reconstruct publication IDs from batch offsets, inspect `2 + broadOutboxIndex`, reconstruct
assignment notice data, or invoke a second delivery path—especially when one batch contains both
`item_updated` and `schedule_changed` activity bundles.

### Guarded all-or-nothing batch

For a state-changing PATCH, preserve and extend the shipped structure:

```text
0  UPDATE project_subtasks ...
     WHERE id/project_id
       AND complete pre-read title/done/due/assignee snapshot
       AND schedule_version = expected/read version
       AND every new schedule metadata column IS its pre-read value
     RETURNING authoritative fields
1  INSERT audit_log ... SELECT ... WHERE changes() = 1 RETURNING id
2+ marker-gated item_updated activity bundle, if non-schedule semantic fields changed
n+ marker-gated schedule_changed activity bundle, if schedule changed
```

Requirements:

- The authoritative UPDATE writes all requested non-schedule fields and normalized schedule fields,
  increments `schedule_version` only for a real schedule change, clears
  `due_reminder_sent_at` only for a real effective-end change, and updates `updated_at` once.
- The complete pre-read fence includes all new schedule columns/version, as well as the shipped
  title/done/due/assignee snapshot. A concurrent writer can never create an audit/activity/outbox
  for a losing request. This fence is deliberately **wider than the columns a schedule-only request
  writes**: title, done, and assignee still participate, so a concurrent checkbox/title/assignee
  change produces `item_conflict` even though the requester touched only schedule. This wide fence is
  the sole source of `item_conflict`; do not “optimize” it down to `due_date`, schedule metadata, and
  version or the second conflict contract disappears.
- The adjacent audit action remains `project_subtask.update` for compatibility. Its
  impersonation-aware `auditMeta()` records bounded changed-field names, resulting schedule state,
  and schedule version—not client/contact/Dropbox data or a copied outbox payload.
- Both activity bundles depend on that exact winner audit ID. The command tracks its internal
  statement/result indexes explicitly, extracts the IDs for zero/one/two bundles, and returns the
  flattened committed IDs. No caller receives or reconstructs offsets; never preserve the current
  route-level `2 + broadOutboxIndex` pattern when two bundles are present.
- Return only broad outbox IDs produced by the committed batch; the shared finalizer owns publication.
- Return targeted assignment notice data only after the winning commit using the returned
  assignee/version exactly as today; the shared finalizer owns the call. It is neither coalesced with
  nor replaced by broad schedule delivery.
- Use `auditMeta(principal, ...)` so Admin impersonation provenance is retained.

### Equality, conflict, and combined-patch rules

- Validate `expectedVersion` as a nonnegative safe integer.
- If it differs from authoritative `schedule_version`, return `409` even if the requested values
  happen to equal current values. A stale token is stale.
- Schedule equality suppresses only the schedule delta. Return an immediate no-write `200` only when
  **both** the schedule and every supplied item field are semantically unchanged. An unchanged
  schedule must never discard a requested title/done/assignee change.
- A stale schedule-version/state response is:

```json
{
  "error": "Checklist schedule changed; review the latest schedule before saving.",
  "code": "subtask_schedule_version_conflict",
  "current": {
    "state": "due_only",
    "version": 3,
    "zone": "Australia/Sydney",
    "start": null,
    "end": {
      "kind": "date",
      "localCivil": "2026-09-02",
      "instant": null,
      "utcOffsetMinutes": null,
      "fold": null,
      "resolution": "stored"
    },
    "due": "2026-09-02"
  },
  "currentSubtask": { "id": "...", "title": "...", "done": false, "assigneeId": null, "schedule": {} }
}
```

`current` is exactly `ChecklistScheduleDto`, produced by the same serializer as list/success responses;
it may be any of the five total states. There is no conflict-only schedule shape.
`currentSubtask` is omitted for schedule-only requests and is the complete serialized subtask for
combined requests; the abbreviated object above is illustrative, not a second DTO.

On any losing schedule-bearing UPDATE, perform one authoritative reread and classify the loss in this
exact order:

1. item absent → `404` with no footprint;
2. reread `schedule_version` differs from the request/pre-read version **or** any raw canonical
   schedule column differs from the pre-read schedule snapshot → the schedule-conflict `409` above;
   include the full serialized `currentSubtask` when the request also carried `itemPatch`;
3. schedule version/state are unchanged but title/done/assignee (or another fenced item field)
   differs → `409 code:'subtask_item_conflict'` with `current:<ChecklistScheduleDto>` plus
   `currentSubtask:<full authoritative serialized subtask>`;
4. an otherwise unclassifiable zero-row result also fails closed as `subtask_item_conflict` with the
   full reread; it is never silently retried.

- The item-conflict body is exactly
  `{error:"Checklist item changed; review the latest item before saving.",
  code:"subtask_item_conflict",current:<ChecklistScheduleDto>,
  currentSubtask:<full serialized subtask>}`. Its `current` and `currentSubtask.schedule` are the same
  serializer result from the same authoritative reread.
- This plan deliberately chooses the distinct item-conflict response over an internal retry. Even
  strictly non-overlapping columns participate in one audited task operation and assignee delivery
  boundary; silently rebuilding against a newer item snapshot would hide a race and make a different
  write than the user reviewed.
- The UI never silently retries either `409` and never turns one into last-write-wins. It keeps every
  affected item/schedule draft, displays authoritative versus draft values, and requires explicit
  review/reapply. A schedule-only request that loses to a title/done/assignee update therefore shows
  an item conflict, not the false claim that the schedule changed.
- A PATCH containing both non-schedule and schedule changes is one atomic task request with one
  audit marker. It emits exactly one `item_updated` activity for the existing mapped
  title/completion/assignee changes **and** exactly one `schedule_changed` activity for the schedule
  change. Two activities are correct because they are distinct accepted product facts; there is
  still only one schedule operation/event.
- If that combined request loses any snapshot/version fence, none of its fields or downstream rows
  commit; the reread classification above selects schedule conflict or item conflict and supplies the
  authoritative item whenever the combined draft needs it.
- A pure non-schedule PATCH remains under the shipped compatibility behavior: same mapped
  `item_updated` semantics, same assignment notice, same all-or-nothing snapshot, and on a lost fence
  the current row is reread/returned as today rather than introducing a new general item-version
  conflict contract. TB4D does not silently call this behavior “schedule safe”; only a request that
  carries `schedule` gets the new versioned `409` guarantee.
- Pure reorder, assignment cleanup, comment operations, and delete never mutate schedule version or
  metadata. Delete may race a schedule save under its existing title-snapshot contract; whichever
  operation commits is truthfully audited/activity-recorded, and a losing schedule save returns
  missing/`404` with no footprint.

Request truth table (all rows assume the command’s authorization and existence gates passed):

| Request and authoritative pre-state | Result | Writes/events |
|---|---|---|
| Schedule only; current version; normalized schedule unchanged | `200`, authoritative item/schedule | None |
| Schedule supplied but unchanged; current version; item field changed | Commit item field | One audit + existing `item_updated` only; no version/reset/`schedule_changed` |
| Any schedule-bearing request; expected schedule version already stale | Schedule-conflict `409` before mutation | Canonical schedule DTO in `current`; none written; combined request also receives `currentSubtask` |
| Schedule changed; item unchanged | Commit schedule | One audit + exactly one `schedule_changed` and its eligible delivery |
| Schedule changed; item changed | Commit atomically | One audit + `item_updated` + `schedule_changed`; targeted assignment remains separate |
| Guarded write loses; schedule changed concurrently | Authoritative reread → schedule-conflict `409` | None from loser |
| Guarded write loses; schedule unchanged, item snapshot changed concurrently | Authoritative reread → item-conflict `409` with canonical schedule + full subtask | None from loser |

## Activity, broad delivery, and noise contract

### Admit exactly one reserved type

Move only `project.checklist.schedule_changed` from `RESERVED_TYPES` to `LIVE_TYPES`. Leave Stage and
workflow reservations untouched.

Its registry contract becomes:

```text
type             project.checklist.schedule_changed
category         checklist
producer         saveProjectSubtask schedule branch
source kind      project_checklist
source id        itemId
source key       project-checklist-schedule:<projectId>:<itemId>:version:<version>
actor            user
safe payload     { itemId, checklistTitle, scheduleState, version }
deep link        project_collaboration
channels         [in_app]
email default    off
coalescing       leading_edge, 300 seconds
coalesce key     project-checklist-schedule:<projectId>:<itemId>:<actorId>
backfill         none
```

Do not let the `live(...)` helper silently stamp this entry with TB4C metadata. Extend its generic
metadata input while leaving every existing live entry byte-for-byte equivalent, and set the TB4D
entry explicitly:

```text
producerOwner     TB4D saveProjectSubtask
producerCallSites ["workers/app/src/lib/project-subtasks.ts#saveProjectSubtask"]
cutoverOwner      TB4D saveProjectSubtask
cutoverDate       literal UTC YYYY-MM-DD of the tb4d-write-enabled app production deployment
noBackfillNote    TB4D has no checklist schedule history backfill; only post-cutover committed
                  schedule winners emit this type.
```

The shared `TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE` constant is initially a review marker (`2026-08-28`)
and the release-preparation/deployment step must confirm or update it to the reviewed write-enabled
production deployment date before that artifact is built; it must not inherit `"2026-08-27"` from the
TB4C helper. The background and inert-app compatibility deploys are not the producer cutover.

Payload schema is strict and bounded:

```ts
{
  itemId: identifier;
  checklistTitle: trimmed string, 1..500;
  scheduleState: "unscheduled" | "due_only" | "range";
  version: integer >= 1;
}
```

Do not persist civil values, instants, offsets, folds, comments, client/agent/agency/contact details,
billing/order data, production notes, filenames, Dropbox paths/links, provider data, arbitrary URLs,
or diagnostics in `safe_payload_json` or the broad outbox payload. The checklist title is the same
narrow freeform exception already approved for checklist events
(`portal/packages/shared/src/project-activity.ts:66,80-82`; privacy tests at
`portal/packages/shared/test/project-activity.test.ts:131-140`).

The helper’s fourth `payload` argument is computational coalescing input; `activity.safePayload` is
the immutable persisted payload. TB4D deliberately includes the safe `itemId` in the persisted
payload, so parser/DB-row/consumer reconstruction can derive the same coalescing key. No separate
coalescing object is persisted in `project_activity_events`; the broad outbox stores only its existing
identity envelope and `coalesce_key`/`coalesce_until` columns.

Tighten validation beyond syntax. The landed parser calls `sourceKeyMatches(type,sourceId,key)` before
payload parsing (`portal/packages/shared/src/project-activity.ts:229-274,313-318`), which cannot prove
identity agreement. For this type, first parse the exact key into `{projectId,itemId,version}` without
admitting it; parse the strict safe payload; then run a schedule-specific cross-representation check:

- key project token equals `activity.projectId`;
- key item token equals `activity.source.id`;
- key item token and `activity.source.id` both equal `safePayload.itemId`;
- key version token equals numeric `safePayload.version` using canonical decimal form.

Implement this by moving the final source-identity decision after payload parsing (or by adding a
post-payload `sourceIdentityMatches(...)` phase) while preserving every existing type’s validator.
Reject any mismatch and reject the old actor-scoped
`project-checklist-schedule:<projectId>:<itemId>:<actorId>` form even when its tokens otherwise look
valid. Test project-token, source-id, payload-item, and payload-version mismatches independently, plus
noncanonical/old-form keys. Update the renderer to safe copy such as:

```text
title: Checklist schedule updated
body:  <Actor> — Checklist “<bounded title>” schedule was updated.
```

### Pure-start suppression and generic builder extension

Classify the normalized diff into `startChanged` and `endChanged`:

- every committed schedule change writes one audit and one immutable schedule activity;
- `endChanged=true` creates the usual broad outbox/one in-app ledger per eligible cycle;
- `endChanged=false && startChanged=true` writes activity only and creates no broad outbox/ledger;
- no-op writes neither;
- a transition between range and due-only with unchanged end is start-side only and does not notify;
- clear to unscheduled changes end and may notify;
- any end kind, civil, resolved instant, offset, or fold change is end-affecting and resets reminder
  state and may notify.

Creating an item with an initial schedule keeps the shipped `item_created` activity/broad semantics;
the presence of a start creates no additional schedule activity or broad row. The pure-start rule
governs later `schedule_changed` operations and does not suppress the independent fact that a task
itself was created.

Keep `buildProjectActivityStatements()` generic. Add a generic option such as
`broadMode: "emit"|"activity_only"` (default `emit`) that marker-gates the same activity insert
while making its broad INSERT return zero rows and its ledger insert see no outbox in activity-only
mode. Do not add a schedule-type branch to the DB builder. Keep stable indexes/return shape so
producer publication bookkeeping is deterministic. Add DB tests proving activity-only mode writes
activity and no outbox/ledger for any valid intent.

This is the only required builder change. The background consumer needs shared registry/copy updates
and tests, but no new event dispatch, resolver union member, admission SQL, suppression function, or
Queue wrapper branch.

### Five-minute leading-edge coalescing

Use TB4C’s mechanism verbatim:

- key `project-checklist-schedule:<projectId>:<itemId>:<actorId>`;
- `strategy:'leading_edge'`;
- fixed `windowSeconds:300` anchored at the first admitted broad row;
- prior-window suppression by `event_type`, recipient, exact
  `recipient_membership_cycle_id`, `coalesce_key`, and `coalesce_until`
  (`portal/packages/db/src/project-activity.ts:33-46`);
- first event at `t0` creates `coalesce_until=t0+300000`;
- an event before the boundary creates activity/audit but no second broad row for that cycle;
- an event exactly at the boundary begins a new window;
- remove/re-add receives an independent first alert because the cycle UUID changed.

Coalescing never updates or deletes the leading row and never erases activity/audit history. Targeted
subtask-assignment notification remains a separate semantic event and is never coalesced here.

### Recipient and delivery rules

For end-affecting broad delivery, use the shipped generic builder and consumer unchanged in spirit:

- occurrence-time fan-out is inside the marker-gated SQL;
- recipient must hold `role_on_project='editor'`, cycle start `<= activity.occurred_at`, active
  account, and global role eligible by the shared mapping;
- unassigned Admin is not appended; an eligible actor receives their own broad row. The schedule
  producer therefore must **not** pass `excludeRecipientId` to `buildProjectActivityStatements()`;
- exact cycle still exists and active/current eligibility is rechecked inside final admission;
- removal, deactivation, role demotion, or remove/re-add before delivery suppresses safely;
- one broad outbox and one in-app ledger, zero email ledgers/provider calls;
- deep link opens Project Collaboration;
- all broad payload/registry agreement remains fail-closed.

TB4E later expands audience/projection policy. TB4D must not pre-add External Editors.

## Due reminder boundary

`project_subtasks.due_date` remains the effective end and the only input to the shipped daily scan.
Do not change `scanDueSubtasks()` to read start columns or create a new scheduler.

`scanDueSubtasks()` is intentionally outside the five-state serializer: it reads persisted `due_date`
directly, so `invalid` and `legacy_unresolved` rows retain existing reminder behavior unchanged even
when their schedule UI is disabled or limited to complete replacement. This is deliberate because
`due_date` remains the reminder truth; “fail closed on every read path” governs schedule projection and
editing, not suppression of the shipped reminder scan.

- Unscheduled has `due_date=NULL` and is ineligible.
- Due-only and ranges both store their end literal in `due_date`; the range end is its due.
- Date-only and timed ends both continue to remind when their Sydney calendar date is due/overdue at
  the existing Sydney-hour-08 scan. A timed `14:30` end does **not** create a 14:30 reminder in v1.
- A timed half-open range ending exactly at Sydney midnight ends the preceding civil day for interval
  display but still reminds on the persisted end literal's calendar date; A13 intentionally keeps the
  reminder boundary on `due_date`.
- Start never enters the scan and never triggers/reset a due reminder.
- Every semantic end change—including kind/fold/instant change or reversion to an earlier literal—sets
  `due_reminder_sent_at=NULL` inside the guarded winner update.
- A pure start change with identical end leaves `due_reminder_sent_at` untouched.
- Existing claim, one-shot source key, current assignee resolution, archived-project exclusion, and
  compensating NULL reset remain byte-for-byte in spirit
  (`portal/workers/background/src/notifications.ts:75-139`).

Tests must prove an end change after a sent reminder permits the new end’s reminder, while start-only
edits do not duplicate it. A fold-only end change resets `due_reminder_sent_at` but leaves `due_date`
unchanged, so the re-claim emits `emitted === 0` rather than a reminder for a new end.

## TB2 freshness and checklist UI

### Exact subtask query resource

Extend the finite TB2 resource grammar with:

```ts
projectDataKeys.subtasks(projectId)
{ kind: "subtasks" }
```

Add `projectSubtasksQueryOptions()` / `useProjectSubtasksQuery()` with the existing project pattern:
15-second stale time, bounded 30-second visible refresh, no background-tab polling, focus/reconnect
refresh while unowned, project/collaboration access classification, and exact-key purge on access
loss. Add it to `projectResourceKey()`, invalidation validation, BroadcastChannel messages, and
collaboration purge. No broad project-root invalidation substitutes for the exact key.

`SubtaskChecklist` consumes authoritative query data while keeping UI drafts keyed separately by
item ID. It acquires the exact subtask key while any schedule editor is open and while drag is active;
invalidation is deferred until release. Title draft, composer title/assignee/schedule draft, open
popover, focus, and drag state survive a background response. Successful mutation writes the returned
authoritative item into the exact cache, then publishes/invalidates `{kind:'subtasks'}`. A stale `409`
updates the displayed authoritative schedule separately but does not overwrite the saved draft.

Late responses after 401 purge all principal data; 403/404 collaboration loss purges subtask,
assignee, comments/read, and collaboration-summary data while leaving unrelated authorized project
detail behavior consistent with TB2/TB3.

### Schedule editor behavior

Replace `DueDateControl` with one `ScheduleControl` used by rows and the compact composer.

- Trigger copy/badge distinguishes `Unscheduled`, `Due <value>`, and `<start> → <end>`.
- A required state selector exposes Unscheduled / Due only / Range.
- Due-only selects Date or Timed for the end. Range selects one shared endpoint kind, so mixed values
  cannot be composed.
- Date inputs remain literal calendar inputs. Timed inputs use `type=time`, `step=60`, and show
  `Australia/Sydney` explicitly.
- Range shows Start and End; due-only shows End/Due only. Start-only cannot be saved.
- Gap errors attach to the offending endpoint and retain all fields. Fold errors reveal Earlier and
  Later radio choices with UTC offsets, separately per endpoint if necessary.
- Switching states is explicit: range → due-only removes only start; due-only → range requires a
  start; any state → unscheduled clears both only on Save. Do not invent a start or auto-copy end.
- Unchanged Save with the current version returns/settles as a no-op and closes normally.
- Conflict UI shows authoritative schedule/version beside the retained draft. “Use latest” and
  “Review and reapply my draft” are explicit; no automatic retry occurs.
- Render literal civil values with shared format helpers; never parse date-only values through
  browser `Date` or browser timezone.

Desktop/compact/phone requirements:

- desktop/compact uses the existing anchored popover and focus management;
- at narrow phone width, the same content stacks within a viewport-bounded popover/sheet-like
  surface with no horizontal clipping;
- all controls have visible labels, fieldsets/legends, accessible errors/live regions, Escape/cancel,
  focus return, and keyboard-only operation;
- existing grip-only dnd activator, title edit, assignee popover, delete confirmation, accordion,
  progress, and compact composer remain intact;
- use Quincy tokens and classes in `styles/app.css`; no Tailwind/shadcn or prototype copy.

## Additive migration `0035`

### Numbering and generation discipline

Implementation preflight must:

1. branch/rebase from then-current `main` and confirm TB4C remains deployed;
2. confirm checked-in journal and production `d1_migrations` both end at `0034`;
3. confirm no `0035*` exists and claim
   `portal/packages/db/migrations/0035_project_subtask_scheduling_ranges.sql`;
4. update `portal/packages/db/migrations/meta/_journal.json` and add
   `meta/0035_snapshot.json`;
5. inspect generated SQL before running it, replacing any `project_subtasks` table rebuild with the
   exact bare additive statements above;
6. run `drizzle-kit generate` again and require a no-op.

The migration contains only eleven bare `ALTER TABLE project_subtasks ADD COLUMN` statements with
the single-column checks specified above. It adds no table, backfill UPDATE, trigger, Calendar index,
foreign-key toggle, table copy/drop/rename, or `projects` change.

Those CHECKs constrain individual scalar domains only. They deliberately do not claim to enforce the
cross-column state machine; the authorized command enforces it and every serializer fails closed if
some out-of-band direct write bypasses that command.

The schema snapshot may describe table-level Drizzle checks for parity, as TB4B does, but migration
SQL must remain the D1-safe bare-column form. Never use `PRAGMA foreign_keys=OFF`; local success does
not prove remote safety (`docs/lessons.md:27-61`).

### Why no Calendar index in TB4D

The existing item list remains ordered by `(project_id,position,id)` and schedule mutation targets a
row by primary key/project ID. The due reminder scan remains unchanged. TB5C’s final overlap query
must combine authorization, date-only inclusive bounds, timed instant bounds, legacy unresolved
rows, filters, and range pagination; choosing an index before that SQL exists would be speculative.

TB4D records query plans for its real list/mutation/reminder/coalescing shapes. If implementation
evidence shows a regression caused by the new columns, return to plan review for the smallest index.
TB5C may add reviewed indexes with its authorized range endpoint.

## Implementation slices

Keep commits small and independently reviewable. Suggested slices:

1. **Shared neutral time primitive and checklist domain.** Extract the Sydney resolver without TB4B
   behavior drift; add the exhaustive five-state checklist DTO, input/normalization/equality/order
   rules, serializers, tests, and exports.
2. **Migration and schema.** Add exact columns/checks, journal/snapshot, migration upgrade tests, and
   second-generation no-op proof.
3. **Activity admission.** Move one type to live, correct versioned source key, add safe payload/copy,
   retain coalescing key, and add generic builder activity-only mode/tests.
4. **Authorized create-or-update task command and API.** Move POST INSERT and PATCH mutation assembly
   into the route-independent command; enforce active-first collaboration authorization, add one
   shared schedule normalizer/column mapper, preserve create-position/item-created behavior, define
   the result/finalization seam, complete snapshot fence, schedule-vs-item loss classification,
   marker-gated dual activities, reminder reset, and command-owned direct publication-ID extraction.
5. **TB2 subtask resource.** Add exact key/query/runtime/invalidation/access-loss support and cache
   tests before converting the component.
6. **Inert rollback artifact.** Land and fully test the migration-aware, range-disabled app state
   across all five DTO states using the single build-time `CHECKLIST_SCHEDULE_RANGES_ENABLED` constant
   checked by the command before normalization; the enabling slice changes exactly that constant from
   false to true. It becomes the recorded production rollback target before the enabling UI/API commit.
7. **Schedule UI and write enablement.** Replace the due editor, wire exact-minute/fold/two-conflict
   behavior, compact composer, responsive styles, accessibility, and DOM tests.
8. **Reminder/activity/consumer regression.** Add end/start/coalescing/exact-cycle/generic-delivery
   integration coverage without changing reminder or consumer branches.
9. **Audits, full gate, migration/query proof, QA, rollout, and documentation.** No deployment or
   commit until the independent gate passes.

Any slice that discovers a need for a child schedule table, new Queue/Cron, Calendar endpoint/index,
new capability/role, broad email, direct notification path, or a second schedule writer is plan drift
and returns to fresh-Sol review.

## Automated test plan

### Shared schedule/time tests

- valid/invalid leap dates and exact `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM` shapes;
- unscheduled, due-only date/timed, range date/timed normalization and serialization;
- exhaustive DTO state discriminator: normal three states, recoverable `legacy_unresolved`, and
  read-only `invalid`—never overlap or fall through;
- start-only and mixed-kind rejection;
- date-only same-day inclusive range, multi-day range, start-after-end rejection;
- timed same-day strict ordering and multi-day ordering by instant;
- ordering across both Sydney DST boundaries;
- Sydney gap rejects with endpoint-specific code and no normalized schedule;
- Sydney fold rejects without choice, then Earlier/Later persist distinct instant/offset/fold values;
- exact-minute round-trip; seconds/milliseconds rejected;
- date-only creates no instant/offset/fold;
- Deadline wrapper exports/codes/copy and all existing Deadline tests remain unchanged after helper
  extraction;
- differential old-scan/new-O(1) resolver equality across every minute around both Sydney DST
  boundaries, winter/summer samples, malformed values, both fold choices, and the old reference
  scan's complete `-840..840` offset range; no production resolution checks more than three candidate
  instants;
- legacy version-0 date/timed normalization and derived-unambiguous timed value;
- malformed legacy text → `legacy_unresolved/invalid_literal`, Sydney gap →
  `legacy_unresolved/nonexistent_local_time`, repeated minute →
  `legacy_unresolved/repeated_local_time` with choices; raw due preserved and no read-side write;
- date endpoints always use `resolution:'stored'`, whether legacy version 0 or TB4D-written, and carry
  no instant/offset/fold;
- version 0 plus any non-NULL schedule metadata is always `invalid/shape_mismatch`, including a
  superficially complete well-formed range; complete replacement from every `legacy_unresolved`
  reason to unscheduled/due-only/range has no partial patch; every post-0035 inconsistent shape remains
  `invalid` and non-editable.

### Migration/schema tests

- full `0000 → 0035` apply and `0034 → 0035` upgrade;
- all existing date-only/timed/NULL `due_date` bytes unchanged;
- new metadata NULL and schedule version 0 for legacy rows;
- no start backfill and no fabricated instant;
- each single-column CHECK rejects invalid kind/zone/fold/offset/instant/version values;
- deliberately insert cross-column-invalid rows that pass those limited CHECKs (start-only, mixed
  kinds, incomplete timed metadata, reversed range), then prove every API serializer returns only
  `state:'invalid'`, no raw schedule metadata, no silent unscheduled/due-only coercion, and no normal
  schedule mutation surface;
- migration SQL contains no `PRAGMA foreign_keys`, `DROP TABLE project_subtasks`, temp table, copy,
  or data UPDATE;
- foreign-key and quick checks pass;
- schema/journal/snapshot parity and a second generator no-op.

### Command/API tests

- create canonical unscheduled, due-only date, due-only timed, date range, timed range; POST legacy
  `dueDate` adapter as a literal `due_date`-only version-0 insert;
- update every valid state to every other valid state, including clear and reversion;
- strict unknown-field, both-`dueDate`-and-`schedule`, start-only, mixed endpoint, gap,
  fold-without-choice, ordering, assignee-ineligible, and transitional raw-PATCH reload rejection;
- exact stored civil/epoch/offset/fold/version round trips;
- complete request truth table: unchanged schedule/current version/no item delta → 200/no writes;
  unchanged schedule plus item delta → item commit + `item_updated` only; stale schedule version →
  schedule 409; schedule plus item changes → one audit and both activities;
- parameterize both 409 responses across all five schedule DTO states; each `current` is byte-for-byte
  the canonical serializer output, never a conflict-only shape, and item conflict/combined schedule
  conflict includes the same schedule inside its full `currentSubtask`;
- deterministic schedule-only races against concurrent title, done, and assignee updates: schedule
  remains unchanged, loser receives item-conflict `409` with full authoritative subtask, and loser has
  zero write/audit/activity/outbox/ledger/targeted-notice footprint;
- deterministic combined item+schedule races against concurrent title, done, and assignee updates:
  classify schedule conflict when schedule version/state also changed, otherwise item conflict; every
  loser receives sufficient authoritative item data and leaves zero footprint;
- deterministic two-schedule-writer race: one winner, one schedule-conflict `409`, zero loser
  footprint; deletion race returns 404;
- UI/API never retries the stale write automatically;
- pure start, pure end, both endpoints, state-only start removal, and clear diff classification;
- end change resets `due_reminder_sent_at`; start-only does not; reversion resets;
- combined title/done/assignee plus schedule commits atomically, produces one audit, one mapped
  `item_updated`, one schedule activity, and existing targeted assignment behavior;
- complete schedule snapshot fence; marker and publication indexes correct with zero/one/two bundles;
- command result union returns authoritative item, exact committed broad IDs, and winning assignment
  notice data for create/update; every command-owned semantic 400 returns `invalid_request` with its
  stable code/message and endpoint/fold choices where applicable; no-op returns authoritative item
  with empty/null finalization data; forbidden/not-found/storage-invalid/both conflicts return no
  side-effect data, and storage-invalid maps to non-retryable 422 rather than 500;
- POST create preserves its inline tail `(position,id)` read plus `POSITION_STEP` allocation without
  calling `computeInsertPosition`, emits `item_created` only (never `item_updated` or
  `schedule_changed`), and returns its existing targeted assignment notice data; reorder alone retains
  `computeInsertPosition`;
- POST, PATCH, and a TB5C-shaped direct caller all invoke the same finalizer exactly once for every
  non-throwing result; broad IDs are published once, assignment notice fires once,
  no-op/invalid-request/failure finalization does nothing, callers never reconstruct batch offsets,
  and a simulated Queue publish failure remains D1-recoverable;
- the one-release raw PATCH `dueDate` adapter succeeds only for untouched version-0 legacy rows,
  updates only literal `due_date`/the reminder claim, emits no schedule activity or schedule broad
  outbox, rejects `schedule`+`dueDate`, and returns reload-required 400 for version>=1/range state
  without mutation;
- admin impersonation provenance retained;
- collaboration access for active Admin/assigned Editor/Photographer and 403 for outsider;
- explicitly test an inactive non-Admin who still has a `project_members` row: command rejects on
  `principal.active` before the membership/existence query; existing active route callers are unchanged;
- direct command invocation by outsider/inactive or removed principal returns 403 before project/item
  existence can be distinguished and produces zero SQL mutation/audit/activity/delivery work;
- missing project/item, deletion race, authorization-before-existence, and route/command guard parity
  remain safe.

### Activity/coalescing/delivery tests

- registry type is live; parser round-trips exact safe payload/deep link/source key and rejects old
  actor-scoped/noncanonical keys, reserved types, extra/private fields, and malformed version/item/title;
- live registry metadata names `saveProjectSubtask`, its concrete lib call site, actual write-enabled
  UTC cutover date, and TB4D-specific no-backfill note; existing live entries retain their TB4C
  metadata rather than changing under the helper refactor;
- independently mismatch key project vs activity project, key item vs source ID, source/key item vs
  payload item, and key version vs payload version; every axis fails after payload parsing;
- every successive schedule version creates a distinct immutable activity source key;
- coalescing helper keeps the exact actor/item key and 300-second declaration;
- pure start writes audit/activity only; no broad outbox/ledger/publication;
- end-affecting first edit creates per-cycle broad rows and one in-app ledger each, no email ledger;
- eligible actor receives their own broad row because the schedule producer omits
  `excludeRecipientId`; an unassigned Admin still is not appended;
- same actor/item before 300 seconds: every audit/activity persists, broad row stays one;
- exact 300-second boundary creates a new broad row;
- different actor, item, recipient, and re-added cycle each have independent windows;
- builder remains type-generic and activity-only mode works without a type branch;
- generic background resolver delivers safe checklist schedule copy through Collaboration;
- removal, deactivation, role demotion, cycle replacement, malformed payload, missing activity,
  reserved type, and structural mismatch retain shipped suppress/fail semantics;
- Queue/recovery/DLQ wrapper still routes the one generic broad event and broad has no email phase.

### Reminder and regression tests

- date-only and timed due reminders still fire once by calendar date at Sydney hour 08;
- a range end is selected by the unchanged `due_date` scan; start is ignored;
- `legacy_unresolved` and `invalid` fixtures remain governed by that same direct `due_date` reminder
  scan even though their schedule projection/editing is limited or disabled;
- end update after sent reminder clears claim and allows the new end; start update preserves claim;
- done, no assignee, archived project, claim race, failed emit compensation, and source-key dedupe are
  unchanged;
- pure reorder emits no activity/broad notification and does not touch schedule/version;
- assignment, assignment-version cleanup, targeted notice, title/completion `item_updated`, delete,
  comment, and membership-cycle behavior remain byte-for-byte in result semantics;
- existing TB4/TB4A/TB4B/TB4C mention/assignment/Deadline/broad suites remain green.

### Web/query/UI tests

- exact subtask query key/resource, bounded refresh, BroadcastChannel invalidation, owner deferral,
  access-loss purge, and late-response rejection;
- current query refresh does not destroy title/composer/schedule draft, popover, focus, or active drag;
- row and compact composer create/edit/clear the three writable states;
- list, mutation-success response, schedule-conflict `current`, item-conflict `current` plus full item,
  and inert rendering exhaustively handle all five DTO states;
- malformed legacy text and Sydney-gap legacy due render recoverable re-entry UI; post-0035 invalid
  renders read-only incident copy with no ordinary editor;
- literal date/timed badges and no browser-timezone conversion;
- exact-minute input, gap errors, per-endpoint fold choices, mixed-kind prevention;
- schedule-conflict and item-conflict 409s keep all affected drafts, show the right authoritative
  schedule/full-item comparison, and never auto-retry;
- inert rollback artifact hides range controls, rejects range transitions with the bounded disabled
  code, renders valid ranges read-only, and renders malformed direct-DB fixtures fail-closed at every
  viewport; its allowed canonical due-only edits retain audit/activity but create no schedule broad
  outbox, while the legacy `dueDate` passthrough remains due_date-only with no schedule activity;
- keyboard-only state/kind/start/end/fold/save/cancel/conflict flow, Escape, focus return, live errors;
- desktop 1440×900, compact 1024×768, and phone 390×844 layout/reflow;
- existing accordion/progress, title edit, assignee search, confirmation portal, grip-only dnd,
  reorder focus, composer reset/failure draft, and access-generation tests remain green.

## Repository audits

Run and record at least:

```bash
rg -n "due_date|dueDate|due_reminder_sent_at|schedule_(start|end|zone|version)" portal
rg -n "INSERT INTO project_subtasks|UPDATE project_subtasks|hasProjectCollaborationAccess" portal/workers/app
rg -n "project\.checklist\.schedule_changed|project-checklist-schedule" portal
rg -n "PROJECT_ACTIVITY_REGISTRY|projectActivityCoalesce|buildProjectActivityStatements" portal
rg -n "project\.activity\.broad|NOTIFICATION_OUTBOX_EVENT_TYPES" portal
rg -n "emitNotifications|notifyProject|notifySubtaskAssignee|scanDueSubtasks" portal/workers portal/packages
rg -n "project_subtask\.reorder|subtasks/.*/reorder|item_updated" portal
rg -n "PROJECT_ASSIGNMENT_ELIGIBLE_ROLES|isProjectAssignmentEligible" portal
rg -n "projectDataKeys|ProjectDataResource|projectResourceKey|acquireOwner" portal/apps/web/src
rg -n "Date\.parse|new Date\(" portal/apps/web/src/components/SubtaskChecklist.tsx portal/packages/shared/src/checklist-schedule.ts
rg -n "comment.*body|email|phone|agency|invoice|payment|dropbox|diagnostic|provider" portal/packages/shared/src/project-activity.ts portal/packages/db/src/project-activity.ts
rg -n "tailwind|shadcn|FullCalendar|external_editor|recurrence|rrule" portal docs/plans/Revamp-TB4D-Checklist-Scheduling-Ranges-Plan.md
```

Audit conclusions required:

- exactly one authorized create-or-update command owns both schedule-capable INSERT and UPDATE SQL,
  and both branches consume one normalizer/column mapper;
- `due_date` remains the only civil end/due and every reminder reads it;
- no date-only instant or start backfill exists; migration `0035` is not a schedule writer;
- cross-column integrity is command-enforced; serializers fail closed on every inconsistent persisted
  shape and no other production writer bypasses the command;
- no Deadline table/route/occurrence is coupled to checklist scheduling;
- one registry type changed reserved→live; every other reservation remains producer-free;
- activity source key is version-unique while coalescing key stays actor/item-scoped;
- pure-start schedule operations create no notification work but retain audit/activity;
- every broad path has one in-app ledger and no email ledger;
- recipient eligibility is imported from shared code and exact-cycle scoped;
- pure reorder/comment/assignment/item-updated semantics are unchanged;
- no Calendar/External Editor/recurrence/Tailwind/shadcn/prototype scope entered the diff;
- no denied payload fields or raw schedule values enter broad outbox/copy/Admin operations.

## Local migration and query-plan proof

Use a disposable `mktemp -d` database/local D1, never production data.

1. Apply `0000 → 0035` from scratch.
2. Seed a representative `0034` database with NULL, date-only, unambiguous timed, malformed timed,
   Sydney-gap timed, repeated timed, due-reminder-claimed, assigned/unassigned, and
   project-member-cycle rows; apply only `0035`.
3. Verify exact columns/defaults/checks from `PRAGMA table_info` and `sqlite_master`. Direct writes
   outside kind/zone/fold/offset/instant/version limits must fail their single-column CHECKs.
4. Deliberately write start-only, mixed-kind, incomplete-timed, and unordered rows whose individual
   values satisfy those CHECKs; confirm SQLite accepts them, then run the actual list response,
   mutation-success reread, schedule-conflict `current`, and item-conflict `current`/full-subtask
   serialization paths. Require only the bounded `state:'invalid'` representation with no raw
   metadata/coercion or editable schedule surface. Do not add a subtask-detail route.
5. Verify legacy row bytes and reminder claims are unchanged; no metadata/backfill row writes occurred.
   Exercise list, mutation reread, both 409 `current` values, and inert rendering for normal,
   `legacy_unresolved`, and `invalid` fixtures; only `legacy_unresolved` permits complete replacement.
6. Run `PRAGMA foreign_key_check` and require empty; `PRAGMA quick_check` and require `ok`.
7. Run the real prepared command SQL for no-op, winner, stale schedule loser, unrelated item-snapshot
   loser, combined update, pure-start, and end-change fixtures. Race schedule-only and combined
   requests independently against title, done, and assignee writers; confirm response classification
   and audit/activity/outbox/ledger/targeted-notice counts.
8. Measure the actual list serializer after warm-up with **20 legacy timed rows** and record runtime,
   host, Node/Workers compatibility runtime, repetitions, measured median, and p95. Require p95 **<10
   ms** for the complete 20-row serialization and record the measured median alongside that ceiling so
   O(1)-resolver regressions are visible before reaching 10 ms. Instrument the resolver to prove at
   most three candidate round trips per row. Treat a miss as a release blocker, not a query-plan
   exception.
9. Run `EXPLAIN QUERY PLAN` for:
   - project checklist list order using `project_subtasks_project_position_idx`;
   - item/version guarded primary-key mutation;
   - unchanged due reminder scan/claim;
   - activity semantic dedupe;
   - exact-cycle broad fan-out;
   - prior coalescing lookup using `notification_outbox_coalesce_idx`;
   - delivery-time activity/cycle admission.
10. Record any intentional bounded scan (notably the existing due scan) rather than inventing a
   Calendar index under TB4D.
11. Run `drizzle-kit generate` a second time and require no migration, no table rebuild, and no
   snapshot drift.

## Required verification commands

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also run all focused shared/DB/app/background/web/migration tests while building. The workspace test
command still misses `packages/shared`; the separate command is mandatory. Record actual test counts
and any justified skips. Webhook-ingress is unchanged but its workspace suite remains part of the
full gate.

## Manual local QA matrix

Use the built app at `http://localhost:8787`, never Vite 5173. A human performs Google sign-in once.
Per current `docs/Subagent-Orchestration.md:83-104`, QA execution goes to Agy; role checks use Admin
impersonation. If Agy is blocked on auth/Chrome, this session’s Browser pane is the sanctioned fallback
after human sign-in. Local QA may mutate only disposable fixtures.

Capture redacted matched evidence at 1440×900, 1024×768, and 390×844.

| Case | Action | Required evidence |
|---|---|---|
| Legacy NULL/date/timed | Load pre-0035 rows | NULL is unscheduled; date/timed remain literal due-only; no start or date midnight; version 0. |
| Legacy unresolved | Load malformed, Sydney-gap, and repeated-minute pre-0035 values | Each has its bounded reason/raw due, complete-replacement editor, no invented endpoint; save requires a full valid state. |
| Create states | Create canonical unscheduled, due-only date/timed, range date/timed; create through legacy `dueDate` | Canonical schedule states have exact DTO/DB state and full metadata for timed values under the version 0/1 rule; legacy `dueDate` writes only literal `due_date` with metadata NULL/version 0 and preserves create audit/item-created semantics. |
| Convert states | Exercise every explicit state conversion | Only intended endpoint clears/appears; no invented start; version increments once. |
| Clear/revert | Clear, then recreate/revert prior values | History/audit/activity remain; each semantic commit has a new version. |
| Validation | Try start-only, mixed kinds, reversed ranges, invalid dates | `400`, draft retained, zero writes. |
| Same/multi-day | Same-day date, same-day timed, multi-day date/timed | Inclusive date day works; timed strictly ordered; values round-trip. |
| Midnight boundary | Save a timed range ending exactly at `00:00`, then exercise the reminder fixture | Half-open display ends on the preceding civil day; persisted `due_date` and reminder remain on the midnight endpoint's calendar date. |
| Sydney gap/fold | Enter gap; enter both fold endpoints | Gap rejected; Earlier/Later required; chosen offset/fold/instant survives reload. |
| Exact minute | Enter minutes not aligned to 15-minute UI conventions | Exact minute persists/displays; no seconds/millisecond drift. |
| Schedule conflict | Two tabs change schedule from one version, including a combined draft | One wins; loser `current` is the canonical DTO plus full item for combined draft, keeps drafts, never retries; zero loser footprint. |
| Item conflict | Hold a schedule-only/combined draft while another tab changes title, done, then assignee | Schedule unchanged; loser gets canonical DTO plus full authoritative subtask, never a false schedule error; zero loser footprint. |
| Unchanged schedule + item | Resubmit current schedule while changing title/assignee | Item commits; `item_updated` only, no schedule version/activity/reset. |
| Persisted corruption | Load direct-DB start-only/mixed/incomplete/reversed fixtures | Bounded invalid-state label, no raw metadata/coercion/editor, clean console; ordinary PATCH cannot repair. |
| Transitional stale tab | Submit raw PATCH `dueDate` against untouched version-0, then version>=1/range state | Legacy request updates only `due_date`, remains version 0, and reads as due-only; post-TB4D state returns reload-required 400 with actionable copy and zero writes. |
| Invalid write status | Attempt a write against a direct-DB invalid schedule row | Non-retryable 422 with canonical invalid DTO/repair copy; no 500, retry, or mutation. |
| Result/finalizer | Create assigned scheduled item; update assignment+schedule; submit no-op/conflict | Authoritative item returned; each committed broad ID published once; targeted notice once; no-op/conflict produces no side effect; create emits item-created only. |
| Inert rollback artifact | Run inert build across all five DTO states | Single build-time gate rejects new ranges with `503 code:'subtask_schedule_ranges_disabled'` before normalization; legacy `dueDate` passthrough, canonical clear, and canonical due-only edits remain available; valid range read-only; unresolved legacy permits complete due-only/clear replacement; invalid fail-closed; schedule broad stays off. |
| Reminder end | Mark due reminder sent, change/revert end | Claim resets under winner; new due reminder can fire on calendar date. |
| Reminder start | Mark due reminder sent, edit only start | Claim remains; start creates no notification. |
| Activity/noise | Rapid same actor/item end edits before/at 5 minutes | Every audit/activity persists; one broad per fixed window/cycle; exact boundary opens next. |
| Actor/item/cycle scope | Different actor/item; remove/re-add Editor | Independent windows; old/new membership cycles never suppress each other. |
| Broad delivery | Deliver an end-change broad row locally through test harness | Collaboration link/copy safe, one in-app ledger, no email/provider call. |
| Combined PATCH | Change title/assignee and schedule together | One atomic audit, one item activity, one schedule activity, existing targeted assignee notice. |
| Reorder regression | Pointer and keyboard reorder during/after schedule editing | No schedule/version/activity/broad change; focus/order semantics unchanged. |
| Assignment regression | Assign/unassign and membership cleanup | Targeted notices/version/confirmation semantics unchanged; schedule retained. |
| Comment/item regression | Create/edit/delete comment; title/done/delete item | Existing comment and `item_updated`/delete behavior unchanged. |
| Refresh/drafts | Open editor/title/composer and trigger polling/cross-tab invalidation | No draft, focus, popover, or drag loss; refresh applies after owner release. |
| Access | Admin, assigned Editor/Photographer, outsider; remove access mid-request | Existing collaboration permission and purge behavior; no late private response. |
| Responsive/a11y | Desktop/compact/phone, keyboard/zoom/reflow | Labels, errors, focus return, no clipping, Quincy styling, clean console/network. |

Agy never performs Google OAuth. Production is not used for this mutating matrix. Evidence redacts
street/client data, emails, tokens/cookies, membership IDs, payload JSON, and raw errors, and records
fixture cleanup.

## Deployment preflight and rollout

### Preflight

1. Rebase a branch from then-current `main`; record clean/understood worktree and exact commit SHA.
2. Confirm TB4C production baseline and rollback versions:
   - reviewed local base `f6bfd8f` (or its then-current descendant), with its orchestration-doc-only
     delta recorded separately from production;
   - deployed build `f857f3f`, production documentation baseline `d35534b`;
   - background `ea917b33-4ba8-4ee3-a713-ae31cc336484`;
   - app `aecde3a7-c525-4836-8272-e2b4eef0ef29`.
3. Query remote `d1_migrations`; require tail `0034`. Confirm local journal tail `0034`, then claim
   `0035`.
4. Confirm candidate columns/migration are absent and no unexpected Calendar/External Editor schema
   has landed; if the base changed, re-review this plan against source.
5. Create a timestamped remote D1 recovery export under the established parent
   `db-recovery/` directory named like
   `quincy-portal-before-tb4d-<UTC timestamp>.sql`; record exact path, size, SHA-256, preflight FK
   check, and quick check. Never store it in the repo.
6. Record counts for projects, project_subtasks by due shape, sent reminder claims, activity, outbox,
   ledger, notifications, and audit without exposing private payloads.
7. Run the complete automated gate, audits, full-chain/upgrade migration proof, query plans, and local
   mutating QA.
8. Confirm no Queue/DLQ/Cron/binding/secret/wrangler change and no webhook-ingress change.
9. Confirm the background bundle admits/renders the now-live activity type before app production.
10. Build and test two explicit app artifacts from reviewed commits:
    - **`tb4d-inert-rollback`**: migration-aware serializer/command, the pre-TB4D direct raw PATCH
      `dueDate` writer removed but its one-release version-0 adapter retained, due-only compatibility
      retained, range controls hidden, new range transitions rejected with
      `503 code:'subtask_schedule_ranges_disabled'`, existing valid range rows rendered read-only,
      legacy-unresolved rows rendered with complete due-only/clear replacement, post-0035 malformed
      rows surfaced only through `state:'invalid'`, and any allowed due-only schedule change records
      audit/activity truth in activity-only mode without a schedule broad outbox. This is an
      intentional behavior delta from TB4C for canonical `schedule` due-only edits: they previously
      produced audit only because `dueDate` was excluded from `mappedChanges`; the inert artifact now
      also writes the truthful `project.checklist.schedule_changed` activity, although no in-app
      activity feed exists yet. The legacy `dueDate` passthrough remains due_date-only and emits no
      schedule activity;
    - **`tb4d-write-enabled`**: the accepted range UI/API producer.
    Record both commit SHAs and prove the inert artifact against valid range and malformed direct-DB
    fixtures before any range-producing version reaches production. The shipped `feature_flags`
    infrastructure (used by Admin impersonation) is acknowledged but deliberately not used here:
    Worker-version rollback keeps the served SPA bundle and API contract in lockstep, which a runtime
    flag cannot guarantee.

### Rollout order

1. Apply reviewed migration `0035` once.
2. Postflight remote migration tail, exact columns/checks/defaults, representative legacy bytes,
   no-backfill/version-0 counts, FK check, quick check, and row counts.
3. Deploy **background first** from `portal/workers/background`.
   - The dispatch remains generic over `project.activity.broad`; there is no new event branch.
   - This deploy is still required because the background bundle’s shared registry/parser/renderer
     must flip the schedule type from reserved to live before any app outbox exists.
4. Verify background version, Queue/recovery health, no unknown/reserved-type failures, no email
   ledger/provider activity for broad events, and normal minute/hourly Cron behavior. Cron config is
   unchanged.
5. Deploy the tested **`tb4d-inert-rollback` app second** from `portal/workers/app` before range writes
   are possible. Passively verify it serves existing legacy due-only items and has no route/render
   regression; attach the pre-deploy local evidence that valid range fixtures render read-only,
   legacy-unresolved fixtures allow only complete due-only/clear replacement, post-0035 malformed
   metadata fails closed, range transitions receive the bounded disabled code, and no pre-TB4D raw
   `dueDate` direct writer remains—the bounded version-0 compatibility adapter is the only accepted
   raw path. Record this exact Cloudflare Worker version as the named
   **app rollback target** and preserve proof that it creates no
   `project.checklist.schedule_changed` broad outbox. Do not manufacture a production range fixture.
6. Only after step 5 is healthy, deploy **`tb4d-write-enabled` app third**, including the range UI and
   producer. The safe dependency order is therefore migration → background → inert app →
   write-enabled app; the consumer still precedes every producing app.
7. Verify the write-enabled app passively and keep the inert Worker version available for immediate
   Cloudflare rollback. Do not replace the recorded rollback target with a pre-TB4D app version.
8. Do not deploy webhook-ingress; if the final diff changes it, return to plan review.
9. Record migration result, background/inert/write-enabled Worker versions, rollback targets, commits,
   and UTC/local timestamps.

### Passive production verification

Production verification is passive-only under `docs/Subagent-Orchestration.md` §2.9 unless the human
separately authorizes a compliant YOLO-mode disposable fixture under §2.10. The default plan does not
require a production mutation.

- verify authenticated Collaboration/checklist renders at desktop and phone without console/network
  errors;
- verify migration/columns/checks and legacy aggregate counts, without selecting private values;
- verify existing due reminders, mention/assignment/Deadline traffic, Queue recovery, and both Cron
  schedules remain healthy;
- observe natural schedule activity, if any, for one safe activity per winner, expected coalescing,
  exact cycle, and zero email ledger;
- inspect Admin operations only through privacy-safe aggregate/label fields;
- watch for `project_activity_type_reserved`, malformed intent, retry, failed, or DLQ growth;
- do not manufacture a real-client schedule edit to prove the path. If no natural event occurs,
  record that and rely on local mutation plus passive consumer/migration proof.

### Documentation closeout

Only after verified production deployment:

- update `docs/todo.md`, `CLAUDE.md`, and mirrored `AGENTS.md` with migration/Worker/commit state;
- update this status line with deployed commit, migration, Worker versions, recovery export, and QA;
- mark every acceptance item with evidence;
- write the one-release raw `dueDate` adapter sunset obligation into `docs/todo.md`, including the
  TB4D write-enabled production deployment date, and check off the adapter-removal acceptance item;
- `git mv` this file to `docs/plans/implemented/` only when production matches the reviewed plan.

## Rollback and fix-forward

Migration `0035` is additive and data-retaining. Prefer fix-forward, but TB4D also has a deployable
rollback artifact.

TB4D adds no persistent runtime feature flag, although the live `feature_flags` table and Admin-
impersonation flag prove that such infrastructure exists. Worker-version rollback is chosen because
it rolls the served SPA bundle and API contract together; a runtime flag cannot keep those artifacts
in lockstep. Before range writes are enabled, rollout must already
have deployed, exercised, and recorded the exact Cloudflare Worker version of the reviewed
**`tb4d-inert-rollback` app**. That named version is the only app rollback target after `0035`: it
hides range controls, rejects new range transitions, removes the pre-TB4D raw `dueDate` PATCH writer,
retains only the bounded one-release version-0 adapter, uses the new command/serializer, renders valid
retained ranges read-only, renders recoverable
legacy-unresolved rows with complete due-only/clear replacement, fails closed on inconsistent
post-0035 rows, leaves legacy due-only behavior/reminders active, and forces allowed canonical
schedule activity into activity-only mode so no new schedule broad outbox is produced. Unlike TB4C,
those allowed canonical due-only edits do write truthful `project.checklist.schedule_changed` activity
rows; this intentional, feed-invisible delta is not notification production. The raw legacy `dueDate`
adapter remains a due_date-only passthrough with no schedule activity. Recovery therefore does not
depend on authoring or reviewing a compatibility shim during an incident.

### UI/API/producer fault

1. Roll the app directly to the recorded **`tb4d-inert-rollback` Worker version**. Verify its version
   ID, disabled range response, read-only retained-range rendering, recoverable legacy-unresolved
   rendering, invalid-row sentinel, due-only compatibility, absence of new range writes, and absence
   of new schedule broad outboxes.
2. Never roll to a pre-TB4D app after migration `0035`: its raw `dueDate` PATCH can mutate `due_date`
   while retained range metadata remains stale. The inert target exists specifically to close that
   corruption path.
3. Keep the TB4D-aware background registry live long enough to drain/terminally classify committed
   broad outboxes. Preserve activity/outbox/ledger/inbox/audit rows.
4. Leave additive schedule data in place. Never mass-convert ranges to due-only during incident
   response.

### Consumer fault

1. Roll the app to the recorded inert target to stop schedule broad production if continued outbox
   creation increases risk; ordinary non-schedule checklist activity remains supported.
2. Deploy a fixed TB4D-aware background consumer/registry.
3. Let existing lease expiry/recovery republish the same outbox IDs.
4. Never roll background to a pre-TB4D registry while schedule broad work is pending/queued/processing;
   it would permanently classify the live type as reserved.
5. Never add email ledgers or synthesize new activity/source keys during replay.

### Schema/migration fault

- Do not drop/rename `due_date`, drop new columns, reset schedule versions, edit `d1_migrations`, or
  restore the full recovery export for an ordinary defect.
- Fix schema forward with the next reviewed additive migration.
- Use the recovery export only for catastrophic recovery under explicit human authorization.
- Legacy due-only reminder behavior remains available because `due_date` and
  `due_reminder_sent_at` were never removed.

### Privacy/noise fault

If payload/copy is unsafe or broad noise is excessive:

1. disable only the schedule broad producer via TB4D-aware app deploy while retaining audit/activity;
2. make registry parsing/rendering fail closed if necessary;
3. retain durable rows and assess with restricted queries—never paste payloads into logs/issues;
4. do not delete history or silently rewrite recipient rows without explicit incident authority.

Pure-start suppression can be tightened by fix-forward without changing schedule storage. Broad email
is absent, so email acceptance ambiguity does not apply; existing targeted email `unknown` behavior
remains untouched.

## Acceptance checklist

### Domain and storage

- [ ] Unscheduled, due-only, and range states are exact; start-only and mixed endpoints are rejected.
- [ ] Date-only ranges are inclusive and allow one-day equality; timed ranges are half-open with
  resolved start instant strictly before end.
- [ ] Same-day/multi-day, exact minute, Sydney gap/fold, and DST-crossing comparisons are proven.
- [ ] `due_date` remains the sole civil end/due; no rename/drop, duplicate end civil, invented start,
  date-only instant, recurrence, or Deadline coupling exists.
- [ ] Existing NULL/date/timed rows remain byte-for-byte truthful, metadata NULL/version 0, with no
  migration backfill.
- [ ] Version 0 with any non-NULL schedule metadata is invalid/shape-mismatch; date endpoints always
  use stored resolution and never receive instant/offset/fold data.
- [ ] New timed values persist civil/instant/offset/fold/zone and round-trip deterministically.
- [ ] The one-release raw PATCH `dueDate` adapter sunset is recorded in `docs/todo.md` with the TB4D
  write-enabled deployment date and removed in the first reviewed post-closeout release.
- [ ] The O(1) Sydney resolver is bit-identical to the old exhaustive scan across the differential
  corpus; the 20-row list serializer records measured median and p95 and meets the <10 ms p95 CPU
  budget.
- [ ] Cross-column integrity is explicitly command-enforced; direct-DB inconsistent fixtures surface
  only the bounded invalid-state DTO/UI and are never coerced or normally editable.
- [ ] Migration is `0035`, strictly additive bare ALTERs, no table rebuild/PRAGMA/data UPDATE; schema,
  journal, snapshot, FK/quick checks, and second-generate no-op pass.

### Mutation and conflict correctness

- [ ] One route-independent create-or-update command owns POST INSERT and PATCH UPDATE persistence;
  both use one normalizer/column mapper, and TB5C can call its update branch later.
- [ ] The command itself enforces the shipped collaboration guard before project/item existence for
  routes, direct callers, and TB5C; direct misuse cannot disclose existence or write.
- [ ] Command-owned semantic/assignee validation returns the typed `invalid_request` arm; every caller
  finalizes each non-throwing result exactly once, and storage-invalid is a non-retryable 422.
- [ ] The complete schedule/item snapshot and expected version guard one authoritative UPDATE; audit
  marker and every downstream statement depend on that winner.
- [ ] Losing schedule-bearing writes reread and classify missing item (`404`), schedule conflict, or
  item conflict; schedule conflict carries authoritative schedule/full item when combined, item
  conflict carries the full subtask, and neither silently retries.
- [ ] The full request truth table passes: wholly unchanged is 200/no writes; unchanged schedule plus
  item delta commits item only; stale schedule is 409; changed schedule+item emits both activities.
- [ ] Schedule-only and combined races against title, done, and assignee changes produce the distinct
  item-conflict response when schedule truth is unchanged and zero loser footprint.
- [ ] Combined item/schedule PATCH is atomic, one audit, one existing item activity if applicable,
  exactly one schedule activity, with direct command-returned publication IDs and no caller offset
  reconstruction.
- [ ] Pure non-schedule PATCH, reorder, delete, assignment/cleanup, targeted notice, comments, and
  `item_updated` result semantics remain unchanged.

### Reminder, activity, and delivery

- [ ] End/due still drives the existing 08:00 Sydney calendar-date scan for date and timed values;
  start never enters it and no Cron was added.
- [ ] End changes/reversions reset the due-reminder claim under the winner; start-only changes do not.
- [ ] `project.checklist.schedule_changed` alone moves reserved→live with a bounded safe payload,
  exact versioned source key, Collaboration deep link, explicit TB4D cutover metadata/call site, and
  no denied data.
- [ ] Post-payload identity validation proves key project/item/version agree with activity project,
  source ID, and payload item/version; every mismatch axis and old actor-scoped key fail closed.
- [ ] Every committed schedule change writes audit and one immutable activity; pure start creates no
  broad notification.
- [ ] End-affecting broad delivery uses the exact five-minute leading-edge actor/item key, exact
  membership-cycle scope, active/eligible Editor fan-out (including an eligible actor because no
  `excludeRecipientId` is passed), and delivery-time reauthorization.
- [ ] Coalescing suppresses recipient noise only: every committed audit/activity remains; exact
  boundary/different actor/item/cycle behavior is proven.
- [ ] Broad path creates one in-app ledger and zero email ledgers/provider calls; targeted assignee
  notification remains separate.
- [ ] Background consumer remains one generic `project.activity.broad` branch; no second event type or
  consumer mechanism exists.

### Freshness and UI

- [ ] One exact TB2 subtask resource/key owns refresh/invalidation/access purge.
- [ ] Background/cross-tab refresh preserves title/composer/schedule drafts, controls, focus, and
  active drag/resize ownership conventions.
- [ ] Schedule editor supports explicit states/conversions, endpoint kind, exact minutes, endpoint
  errors/fold choices, distinct schedule/item conflict review, and literal Sydney display.
- [ ] Desktop 1440×900, compact 1024×768, phone 390×844, keyboard, focus, zoom/reflow, live errors,
  console, and network QA pass under Quincy visual authority.
- [ ] No Calendar, External Editor, recurrence, Tailwind/shadcn, prototype, or cross-project endpoint
  entered the diff.

### Proof and rollout

- [ ] Shared/DB/app/background/web focused suites plus full typecheck/build/workspace/shared gates pass.
- [ ] Producer/privacy/reminder/reorder/assignment/freshness audits are recorded.
- [ ] Full-chain and `0034→0035` migration/command/query-plan proof is recorded.
- [ ] Differential resolver proof and the 20-row list-serializer CPU budget are recorded beside query
  plans.
- [ ] Local mutating QA matrix is complete via Agy or the sanctioned Browser fallback; production
  verification is passive by default.
- [ ] Recovery export exists; remote tail was `0034`; `0035` applied cleanly.
- [ ] Migration → background → tested inert app → write-enabled app order completed; the inert
  TB4D-aware Worker version is recorded and exercised as the only post-0035 app rollback target,
  including its range-write rejection, fail-closed reads, and schedule-broad suppression.
- [ ] Documentation reflects production and this file moves to `implemented/` only after deployment.

## Expected implementation footprint

Exact test filenames may follow workspace conventions, but implementation should remain within:

- `portal/packages/db/migrations/0035_project_subtask_scheduling_ranges.sql`
- `portal/packages/db/migrations/meta/_journal.json`
- `portal/packages/db/migrations/meta/0035_snapshot.json`
- `portal/packages/db/src/schema.ts`
- `portal/packages/shared/src/sydney-civil-time.ts` (new neutral primitive)
- `portal/packages/shared/src/checklist-schedule.ts` (new domain module)
- `portal/packages/shared/src/project-deadline.ts` (backward-compatible wrapper/refactor only)
- `portal/packages/shared/src/project-activity.ts`
- `portal/packages/shared/src/index.ts`
- shared schedule/Deadline/activity tests
- `portal/packages/db/src/project-activity.ts` and DB activity/migration tests
- `portal/workers/app/src/lib/project-subtasks.ts` (new authorized create-or-update command owner)
- `portal/workers/app/src/middleware/capability.ts` (context-free collaboration guard extraction,
  policy unchanged)
- `portal/workers/app/src/routes/project-subtasks.ts` and its integration tests
- `portal/workers/background/src/notifications.ts` tests only unless a minimal type import is needed;
  production scan semantics/SQL remain unchanged
- `portal/workers/background/src/notification-delivery.ts` tests and only the minimal shared-registry
  compatibility needed for rendering; no new dispatch branch
- `portal/apps/web/src/lib/project-data.ts`
- `portal/apps/web/src/lib/project-query-sync.ts`
- `portal/apps/web/src/components/SubtaskChecklist.tsx` and DOM/access tests
- `portal/apps/web/src/styles/app.css`
- deployment closeout docs only after production acceptance

Any need to touch `prototype/`, project Deadline storage/occurrences, Calendar/Dashboard views,
External Editor auth/projection, webhook-ingress, Queue/Cron/wrangler resources, notification email
preferences, or a cross-project range endpoint is outside this plan and requires fresh review.
