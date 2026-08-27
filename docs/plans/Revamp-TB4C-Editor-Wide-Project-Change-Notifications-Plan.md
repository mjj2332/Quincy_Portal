# Revamp TB4C — Editor-Wide Project-Change Notifications

**Status:** APPROVED FOR BUILD (2026-08-27). Pipeline: Sol draft → Sol review r1 (4 Blocking / 4 Should-fix) → Sol first revision (all 8 resolved) → Sol review r2 (all confirmed, +1 Should-fix / 1 Nit) → Opus plan-tier review (all 8 fixes confirmed sound vs landed code, plan structure approved, 7 surgical revert items) → Sol follow-up revision (all 7 resolved) → final Opus plan-tier review: **APPROVE**, all 7 verified against source, item 3 (`deliverBroadInApp()` contract) confirmed airtight, 7 implementation nits N1–N7 incorporated below. Not yet built.

## Purpose

TB4C adds the durable, privacy-safe broad project-change path promised by D-17 and D-18:

> For every approved semantic project operation, persist one immutable safe activity event and give every event-time-eligible, still-authorized assigned Editor one durable in-app alert—without duplicate producers, notification storms, membership-history leakage, or broad email.

This tracer bullet establishes the activity store, finite type registry, exact membership-cycle fan-out, coalescing seam, broad Queue consumer branch, and existing bell projection that TB4D and TB4E must extend rather than replace.

It does **not** build Calendar/checklist scheduling, External Editor authorization or projections, a global activity feed, a bell redesign, or a broad email channel.

## Required review sequence

This document is the Sol-authored draft with all review revisions applied.

1. The fresh-Sol findings and follow-up review are resolved.
2. After fresh-Sol approval, a fresh Opus plan-tier session reviewed it and approved the final plan.
3. Implementation may begin only after both gates approve the same final plan.
4. Building, migration, deployment, and moving this file to `docs/plans/implemented/` are separate later work.

Reviewer attention is especially requested on two deliberate judgments:

- The five-minute rule below is a **leading-edge fixed window** anchored to the first admitted alert, not a rolling quiet-period timer. That is deterministic, bounds suppression, requires no mutable auxiliary recipient table, and is reusable by TB4D.
- Stage and legacy workflow outcomes are present in the registry as reserved ownership contracts, but TB4C does not add competing producers beside the existing direct `emitNotifications()` paths. Their broad cutovers belong to the future canonical Stage/workflow owner.

Neither is a blocking product question; both are proposed decisions for reviewers to affirm or revise.

## Authority and conflict order

Apply these authorities in order:

1. `docs/Decision-Sheet.md`, especially D-17, D-18, and D-19.
2. `docs/Implementation-Plan.md`, especially A10–A11 and the A13/A14 boundaries.
3. The TB4C roadmap brief reproduced in the drafting task, every sentence.
4. `docs/plans/revamp_2026_portal/core/07-Notifications-On-Cloudflare.md`.
5. `docs/plans/revamp_2026_portal/core/06-Discussions-And-Notice-Board.md` and the implemented TB3 plan.
6. The shipped TB4, TB4A, and TB4B plans.
7. Where shipped-plan prose differs from the repository, current `main` source wins.

Repository rules in `CLAUDE.md`, routing/migration/auth lessons in `docs/lessons.md`, and the review/delegation rules in `docs/Subagent-Orchestration.md` remain mandatory.

## Resolved TB4/TB4A/TB4B/TB3 foundation

The following is verified against commit `dba2e40` on `main`, not inferred from roadmap prose.

### TB4 durable delivery envelope

- The only Queue body remains `{ type: "notification_outbox", outboxId }` in `portal/packages/shared/src/notification-outbox.ts:1-5`.
- The finite shipped event constants currently contain comment mention, assignment created, and Deadline reminder only (`portal/packages/shared/src/notification-outbox.ts:7-11`). TB4C must add one named broad event constant; it must not use an arbitrary string.
- `publishNotificationOutbox()` publishes only committed outbox IDs and records publish admission in `portal/packages/shared/src/notification-outbox.ts:41-65`.
- `notification_outbox` and `notification_delivery_ledger` remain separate durable state machines in `portal/packages/db/src/schema.ts:1037-1105`.
- The background consumer has a ten-minute lease (`portal/workers/background/src/notification-delivery.ts:22`), event dispatch in `resolveRecipient()` (`:326`), common claiming at `claimOutbox()` (`:420`), safe retry release at `releaseBeforeRetry()` (`:468`), terminal completion at `completeIfTerminal()` (`:492`), in-app delivery at `deliverInApp()` (`:666`), and the shared orchestration in `processNotificationMessage()` (`:861-912`).
- Recovery remains `recoverNotificationOutbox()` (`portal/workers/background/src/notification-delivery.ts:981-1033`), and the Queue/DLQ topology does not need a new resource.
- Mandatory in-app delivery precedes optional email. Only the two email-provider admission codes `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` retry automatically as provider classifications; pre-email D1/platform exceptions still release the lease and retry through `releaseBeforeRetry()`, while an ambiguous accepted email remains `unknown` (`portal/workers/background/src/notification-delivery.ts:289-299,896-903`). TB4C broad events have no optional email channel at all, so the provider-ambiguity rule is unchanged rather than exercised.

### TB4A membership cycles

- One assignment cycle is the lifetime of one exact `project_members.id` UUID row. The row stores `created_at` as epoch milliseconds; uniqueness is `(project_id, user_id, role_on_project)` (`portal/packages/db/src/schema.ts:249-266`).
- `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor` is `["editor", "admin"]`, and `isProjectAssignmentEligible()` is the shared role predicate (`portal/packages/shared/src/project-members.ts:3-13`). TB4C must import these definitions; it must not restate them.
- Post-create assignment writes use `addProjectMemberWithAssignmentIntent()`, which atomically writes the membership cycle, audit marker, targeted `project.assignment.created` outbox, and its ledgers (`portal/workers/app/src/lib/project-members.ts:74-139`).
- Initial assignments are a separate producer path: `createProjectAtomically()` calls `buildInitialProjectMemberStatementTuples()` and places every initial membership insert, member-add audit, targeted assignment outbox, and targeted ledger directly in the project-create batch (`portal/workers/app/src/routes/projects.ts:259-319`; `portal/workers/app/src/lib/project-members.ts:228-268`). TB4C owns this path explicitly; it does not pretend those writes flow through `addProjectMemberWithAssignmentIntent()`.
- Exact-cycle removal and checklist-assignment cleanup are guarded in `portal/workers/app/src/lib/project-members.ts:162-224`.
- The existing membership route publishes only the committed targeted outbox (`portal/workers/app/src/routes/projects.ts:476-520`). TB4C must add the broad roster event to the same winner batch and suppress that broad row for the newly assigned user. Project creation must publish both returned targeted IDs and returned broad IDs only after its full batch commits.
- The proven recipient-fan-out pattern is the Deadline fire batch: eligible `editor` cycles are selected inside the marker-gated `INSERT ... SELECT`, with `member.created_at <= occurrence.fired_at`, active user, and shared eligible global roles (`portal/workers/background/src/project-deadline.ts:45-104`).

### TB4B schedule-change seam

- `ProjectDeadlineScheduleEventIntent` is already typed in `portal/packages/shared/src/project-deadline.ts:42-59` with `schemaVersion: 1`, type/registry key `project.deadline.schedule_changed`, versioned source key, safe `{ version, operation }`, project deep link, and `coalesce: null`.
- `scheduleEventIntent()` builds exactly that intent in `portal/workers/app/src/lib/project-deadline.ts:189-205`.
- `saveProjectDeadlineSchedule()` returns the intent only after the versioned project update wins and its adjacent audit marker exists (`portal/workers/app/src/lib/project-deadline.ts:271-337`). It currently returns no publication IDs.
- TB4B does **not** persist or deliver this broad activity. TB4C consumes this one existing intent after the same winner batch. It must not create a second Deadline schedule-change producer.
- To make persistence atomic, TB4C constructs that same single intent once before assembling the existing batch, appends its activity/fan-out statements after the existing audit marker, and returns the already-constructed intent/publication IDs only when the marker wins. It must not persist in a second post-commit batch or call `scheduleEventIntent()` twice.
- Deadline reminder occurrences are a different event (`project.deadline.reminder`) with occurrence IDs as source keys (`portal/workers/background/src/project-deadline.ts:29-42,71-104`). They are not activity schedule changes and must never be coalesced or relabelled as such.

### TB3 activity direction

- Project discussion data, mention delivery, and freshness are already separate concerns. Comments live in `project_comments`; freshness is per-user in `project_comment_read_markers` (`portal/packages/db/src/schema.ts:269-307`).
- Current create/edit/delete commands already return safe activity intents with comment-only source identity, project/collaboration deep links, no comment body, and a same-comment/same-actor edit coalescing key of 300 seconds (`portal/workers/app/src/lib/project-comments.ts:30-48,183-218`). They do not yet persist those intents.
- Comment writes, mention mappings, audits, and targeted mention outboxes are handled in `portal/workers/app/src/lib/project-comments.ts:321-390`; routes publish targeted mention outboxes in `portal/workers/app/src/routes/project-comments.ts:89-128`.
- The current project notification route sends comment/subtask notification types to Collaboration (`portal/packages/shared/src/staff-routes.ts:18,79-84`). TB4C extends that finite mapping; it does not overload read markers or comment ordering.

Therefore, in TB4C:

```text
audit_log                     = operator/compliance evidence
project_activity_events       = immutable privacy-safe product fact
notification_outbox + ledger  = durable per-recipient delivery work
notifications                 = final dismissible in-app projection
project_comment_read_markers  = discussion freshness only
```

No table substitutes for another.

## Verified current-state caveats on `main`

The implementation preflight must reconcile these documentation facts before code is committed:

- `main` is `dba2e40`, and the task's production record says TB4B deployed on 2026-08-27 with migration `0033`, background Worker `2668a652-dca8-4a24-a2c8-f0b712b8ff0f`, and app Worker `15b45ad1-620d-4c00-94e2-1b27484d29a0`.
- The migration journal already ends at `0033` (`portal/packages/db/migrations/meta/_journal.json:237-241`), and `0033_project_deadline_and_reminders.sql` is the current tail.
- `docs/todo.md`, the migration paragraph in `CLAUDE.md`, and the TB4B plan status/location still describe the pre-deploy state. That prose is stale; it does not invalidate the code or the supplied deployment record. The TB4C build branch must first land the normal TB4B documentation closeout (including moving its plan to `implemented/`) or rebase after that closeout lands.
- The remote `d1_migrations` tail is still a deployment preflight check. TB4C may claim `0034` only if remote production and rebased `main` both end at `0033`.

## Scope

### In scope

- One additive activity table and the minimum additive outbox coalescing/cycle-scope columns and index.
- A finite, runtime-validating activity registry in `@quincy/shared`.
- A generic `project.activity.broad` outbox event using the unchanged Queue body.
- Marker-gated activity persistence and eligible Editor fan-out for the live producer set below.
- Exact membership-cycle authorization at occurrence and at each channel delivery.
- In-app-only ledgers for broad events.
- Five-minute per-recipient coalescing for same-comment/same-actor edits.
- A reusable coalescing contract reserved for TB4D schedule changes.
- Existing bell/list copy, deep links, dismissal, and privacy-safe Admin delivery-ops labels.
- Automated, repository-audit, migration, query-plan, local QA, rollout, and rollback proof.

### Hard non-goals

- No TB4D checklist schedule semantics, reminders, range queries, Calendar, drag, or resize. TB4C only reserves the schedule activity/coalescing contract.
- No `external_editor` global role, capability, projection, preferences, or access. No External Editor Notice Board, staff directory, or Admin scope.
- No rewrite of the bell, notification list, Admin delivery-ops screen, or legacy direct `emitNotifications()` architecture.
- No broad email, email preference, digest, SMS, mobile push, or webhook notification channel.
- No global activity feed or TB6 Activity Log UI.
- No history backfill, synthetic assignment cycle, or reconstruction from `audit_log`.
- No replacement of audits with activity rows and no notification payload copied into audits.
- No new Queue, DLQ, Cron trigger, Workflow, R2 object, KV namespace, or service binding.
- No broad event for pure project Kanban order or checklist order.
- No `prototype/` work.

## Exact activity persistence contract

### Migration `0034`

If preflight confirms `0033` is still the local and remote tail, add:

`portal/packages/db/migrations/0034_project_activity_events.sql`

The migration is strictly additive:

```sql
CREATE TABLE project_activity_events (
  id text PRIMARY KEY NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  event_type text NOT NULL,
  category text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_id text,
  occurred_at integer NOT NULL CHECK (typeof(occurred_at) = 'integer'),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_key text NOT NULL,
  safe_payload_json text NOT NULL CHECK (json_valid(safe_payload_json)),
  deep_link_kind text NOT NULL CHECK (deep_link_kind IN ('project', 'project_collaboration')),
  deep_link_path text NOT NULL,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  CHECK (
    (actor_kind = 'user' AND actor_id IS NOT NULL)
    OR (actor_kind = 'system' AND actor_id IS NULL)
  ),
  UNIQUE (event_type, source_key)
);

ALTER TABLE notification_outbox ADD COLUMN coalesce_key text;
ALTER TABLE notification_outbox ADD COLUMN coalesce_until integer;
ALTER TABLE notification_outbox ADD COLUMN recipient_membership_cycle_id text;

CREATE INDEX notification_outbox_coalesce_idx
  ON notification_outbox(
    event_type,
    recipient_id,
    recipient_membership_cycle_id,
    coalesce_key,
    coalesce_until
  );
```

Then add the corresponding Drizzle declarations in `portal/packages/db/src/schema.ts`. Update the journal and tail `0034_snapshot.json` to match the exact applied SQL. Following the shipped TB4B, TB4, and TB3 migration discipline (`docs/plans/implemented/Revamp-TB4B-Project-Deadline-And-Reminders-Plan.md:643-644`; `docs/plans/implemented/Revamp-TB4-Notification-Outbox-And-Queues-Plan.md:460-463`; `docs/plans/implemented/Revamp-TB3-Project-Discussion-V2-Plan.md:340-344`), a second `drizzle-kit generate` against that checked-in schema/journal/snapshot state must produce no migration and no rebuild of either `projects` or `notification_outbox`.

No existing table is rebuilt. No existing column changes meaning. `projects` is not rebuilt. The `occurred_at`/`created_at` storage-class checks follow the shipped `0033` integer-check convention (`portal/packages/db/migrations/0033_project_deadline_and_reminders.sql:14-15,21-22`). The three `ALTER TABLE ADD COLUMN` statements are nullable and therefore safe for existing rows. `recipient_membership_cycle_id` deliberately has no foreign key: it preserves the admitted historical cycle after that `project_members` row is removed. It is required and equal to the payload's `membershipCycle` for every new broad outbox, while every pre-TB4C/targeted row keeps `NULL`. No standalone project-activity feed/source indexes are added: TB4C builds no query that uses them, and TB6 may add only the indexes its Activity Log query shapes prove necessary. If preflight finds `0034` occupied, renumber the file and this plan before implementation rather than creating a duplicate journal tag.

### Immutability and retention

- There is no update API for `project_activity_events`, no generic repository update helper, and no mutation path after insertion.
- Activity rows are append-only during a project's lifetime. The project foreign-key cascade follows the existing project data-retention boundary; it is not an activity-edit operation.
- `audit_log` remains the authoritative compliance trail and is never generated from, merged into, or queried as fallback activity.
- The unique `(event_type, source_key)` constraint deduplicates replay of the **same prepared activity intent**. Stable domain keys (membership cycle, comment/item create/delete ID, Deadline version, completion job/claim/session) also survive intent reconstruction. A source key ending in a freshly generated `activityId` does not, by itself, identify a new HTTP/command invocation as a retry.
- `occurred_at` is epoch milliseconds of the committed semantic operation. `created_at` is the activity insertion time and may not be used for membership-cycle eligibility.
- `source_key` is type-owned and non-secret. Its documented retry-identity lifetime is either (a) a stable domain version/ID across reconstructed commands, or (b) one prepared intent plus the equality-guarded canonical-state rule below. It is never a filename, URL, Dropbox path, email address, phone number, or raw provider diagnostic.
- `safe_payload_json` must pass the exact registry parser before a statement is prepared and again before delivery renders copy.
- `deep_link_path` must equal the registry-derived route for the project; producers cannot supply arbitrary paths or URLs.

### One semantic winner, one activity row

Create `portal/packages/db/src/project-activity.ts` as the shared D1 statement builder. It accepts a registry-validated `ProjectActivityIntent`, the adjacent authoritative winner/audit marker ID, and the optional new-assignee suppression ID. It returns statements and result indexes; it does not execute or publish independently.

Every producer batch has this order, with all operation-local prerequisites present before fan-out:

1. all guarded domain mutation statements needed by that semantic operation;
2. each adjacent audit/winner marker written only when its guarded mutation won;
3. any existing targeted notification statements that share those markers;
4. only after every domain row needed for eligibility exists, activity `INSERT ... SELECT ... WHERE EXISTS (authoritative marker)`;
5. broad outbox `INSERT ... SELECT` from the inserted activity and eligible membership rows;
6. **in-app-only** ledger insertion for returned broad outboxes;
7. after `db.batch()` returns, inspect the actual activity/outbox `RETURNING` rows and publish only returned broad outbox IDs.

Do not infer success from a pre-read, `changes()`, fixed result offsets after dynamically appended statements, or the requested input. Keep the marker adjacent to its guarded write, following the shipped D1 batch lessons.

If an existing operation is already complete or is a true no-op, it returns no new activity and no broad outbox. If the activity's unique source key already exists, the same prepared intent uses that existing semantic result and must not fan out a second set of outboxes.

For every mutable producer whose source key contains a newly generated `activityId`—priority, safe project/details/services save, checklist update, comment edit, video-link update, and video-link reorder—the authoritative mutation must include an equality guard over the complete canonical state owned by that command. Rebuilding an ambiguous-after-commit request while the first result is still current therefore yields a no-op marker and no second audit/activity/outbox. Comment equality includes body, canonical `content_json`, and the exact mention set; checklist equality includes all owned fields including due date even though due-date-only activity is excluded; link reorder equality compares the complete persisted ordered ID sequence. The retry identity ends if an intervening committed mutation changes that canonical state: without a stable client command ID, a later request that changes state again is a new semantic operation, not deduplicable as the old retry. Tests must state this bounded lifetime rather than claiming general HTTP idempotency.

Other existing update/transition producers use their domain guard: membership add uniqueness, exact-cycle removal, Deadline version, archive/restore state, document session, manual-publish job/asset, and RAW claim. Reconstructing their same command cannot win a second time. Conversely, a create endpoint that deliberately allocates a new domain object ID for each invocation is **not** made generally HTTP-idempotent by TB4C: two independently accepted project/comment/checklist/link creates are two domain objects and two semantic activities. The plan's retry guarantee is limited to stable domain command identity or the equality-guarded update lifetime above.

## The single activity type registry

Add `portal/packages/shared/src/project-activity.ts` and export it through `@quincy/shared`.

The registry—not route-local unions—is the single source of truth for:

- exact activity type and schema version;
- category;
- producer owner and call-site contract;
- source kind and source-key shape;
- user/system actor rule and actor-recipient rule;
- exact safe-payload parser and renderer inputs;
- deep-link kind/path builder;
- coalescing key/window or `null`;
- channel plan (`["in_app"]` for every TB4C broad entry);
- email default (`off`);
- internal audience status;
- future external projection status;
- cutover date/owner and explicit no-backfill note.

Export at minimum:

```ts
PROJECT_ACTIVITY_SCHEMA_VERSION
PROJECT_ACTIVITY_CATEGORIES
PROJECT_ACTIVITY_REGISTRY
PROJECT_ACTIVITY_TYPES
PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID
parseProjectActivityIntent()
parseProjectActivityRow()
projectActivityDeepLink()
projectActivityCoalesce()
renderProjectActivityNotification()
```

The registry is a finite typed object with runtime Zod validation. A completeness test must fail if an activity type lacks any required declaration. `@quincy/shared` also adds:

```ts
NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad = "project.activity.broad"
```

The generic delivery event is distinct from the semantic activity type. Its semantic delivery identity is:

```text
(event_type = project.activity.broad,
 source_key = project_activity_events.id,
 recipient_id,
 channel = in_app)
```

### Safe-payload rules applying to every type

Allowed payload values are identifiers, small enums, booleans, version numbers, safe counts, and explicitly approved changed-field names. Broad payload and rendered notification copy must never include:

- comment body or rich-text JSON;
- original filename, asset display filename, annotation/production-note content, or upload key;
- client/agent email, phone, billing, invoice, payment, or order-bookkeeping details;
- agency notes or internal project notes;
- Dropbox path/link, provider token/URL, job diagnostic, stack trace, or raw error;
- arbitrary collection-link URL or label;
- Admin-only capability/feature-flag state.

`docs/plans/revamp_2026_portal/core/07-Notifications-On-Cloudflare.md` §8 expressly permits checklist titles in broad copy. TB4C adopts that authority narrowly: only `project.checklist.*` registry entries may carry `checklistTitle`, it is the authoritative trimmed title captured by the winning mutation (the pre-delete title for delete), and its runtime parser requires 1–500 characters to match the shipped checklist input bound. The field lives only in the registry-validated `safe_payload_json`, never in the broad outbox payload; non-checklist types and unknown/oversized title fields fail closed. This is the sole freeform-copy exception in TB4C.

The broad outbox payload contains only schema version, broad event identity, exact membership cycle, and the activity row ID/project ID. It does **not** duplicate `safe_payload_json`. Consumer rendering joins the immutable activity row and validates it through the registry.

## Initial internal registry and exact producer ownership

All entries have `emailDefault: "off"`, `channels: ["in_app"]`, and `backfill: "none"`.

### Live in TB4C

| Type | Category | Source key / safe payload | Exact existing owner to change | Noise and recipient rule |
|---|---|---|---|---|
| `project.team.member_added` | `team` | `project-member:<membershipCycle>:added`; `{ membershipCycle, roleOnProject: "photographer"|"editor" }` | Both owners: post-create `addProjectMemberWithAssignmentIntent()` (`portal/workers/app/src/lib/project-members.ts:74-139`, route `portal/workers/app/src/routes/projects.ts:476-503`) **and initial project creation** through `createProjectAtomically()` + `buildInitialProjectMemberStatementTuples()` (`portal/workers/app/src/routes/projects.ts:259-319`; `portal/workers/app/src/lib/project-members.ts:228-268`) | One activity per newly created role slot. If the same slot also creates targeted `project.assignment.created`, exclude that slot's user from that activity's broad fan-out; all other event-time-eligible Editors remain included. |
| `project.team.member_removed` | `team` | `project-member:<membershipCycle>:removed`; `{ membershipCycle, roleOnProject: "photographer"|"editor" }` | exact-cycle removal in `portal/workers/app/src/lib/project-members.ts:162-224`, route `portal/workers/app/src/routes/projects.ts:505-520` | Removed Editor cycle cannot receive its own removal because it no longer exists at fan-out. Other eligible Editors receive one; removing a Photographer also informs eligible Editors. |
| `project.deadline.schedule_changed` | `deadline` | Existing `project-deadline:<projectId>:version:<version>`; existing `{ version, operation }` | consume the existing intent from `saveProjectDeadlineSchedule()` at `portal/workers/app/src/lib/project-deadline.ts:189-205,271-337`; route publishes returned IDs | Exactly one per committed save. No second intent, no coalescing, no reminder conflation. |
| `project.priority.changed` | `priority` | `project-priority:<projectId>:change:<activityId>`; `{ priority }` | priority route `portal/workers/app/src/routes/projects.ts:375-394` | A priority value change is semantic; moving position alone is not. Same-value requests are no-ops. |
| `project.details.changed` | `project_metadata` | `project-details:<projectId>:change:<activityId>`; `{ changedFields: SafeProjectField[] }` | generic project patch `portal/workers/app/src/routes/projects.ts:417-473`, refactored to the single guarded batch below | One event per committed all-or-nothing save that changes at least one allowlisted safe field, not one per field. `services` is one allowlisted changed field. Only allowlisted safe field names are included; values are omitted. A blocked service delta, sensitive-only save, or no-op emits none. |
| `project.archived` | `coordination` | `project:<projectId>:archived:<auditId>`; `{}` | archive winner batch `portal/workers/app/src/routes/projects.ts:874-932` | One event when the guarded archive wins. |
| `project.restored` | `coordination` | `project:<projectId>:restored:<auditId>`; `{}` | restore branch `portal/workers/app/src/routes/projects.ts:874-933`, especially the non-atomic update/audit at `:927-931` | Refactor restore into a mutation guarded by `archived_at IS NOT NULL` + adjacent marker + activity fan-out. A restore call against an already-active project is a no-op and emits nothing. |
| `project.checklist.item_created` | `checklist` | `project-checklist:<itemId>:created`; `{ itemId, checklistTitle }` | POST in `portal/workers/app/src/routes/project-subtasks.ts:79-90` | One per created item. The bounded title is allowed only in registry-validated activity payload/copy; the broad outbox payload remains title-free. Existing targeted subtask assignment remains unchanged. |
| `project.checklist.item_updated` | `checklist` | `project-checklist:<itemId>:updated:<activityId>`; `{ itemId, checklistTitle, changes: ("title"|"completion"|"assignee")[] }` | PATCH in `portal/workers/app/src/routes/project-subtasks.ts:93-120` | One composite event per save. Map shipped route keys to registry names as specified below. Exclude `dueDate`; a due-date-only save is TB4D territory and emits no TB4C activity. |
| `project.checklist.item_deleted` | `checklist` | `project-checklist:<itemId>:deleted`; `{ itemId, checklistTitle }` | DELETE in `portal/workers/app/src/routes/project-subtasks.ts:166-173` | One per winning deletion, carrying the bounded pre-delete title returned by the guarded `DELETE ... RETURNING title`. |
| `project.comment.created` | `comment` | Existing `project-comment:<commentId>:created`; `{ commentId }` | existing intent and create batch in `portal/workers/app/src/lib/project-comments.ts:183-218,321-347` | One event; targeted mentions remain separately owned. |
| `project.comment.edited` | `comment` | Existing `project-comment:<commentId>:edited:<activityId>`; `{ commentId }` | existing intent and edit batch in `portal/workers/app/src/lib/project-comments.ts:183-218,349-373` | Persist every edit activity; coalesce delivery by project/comment/actor for five minutes. |
| `project.comment.deleted` | `comment` | Existing `project-comment:<commentId>:deleted`; `{ commentId }` | existing intent and delete batch in `portal/workers/app/src/lib/project-comments.ts:183-218,375-390` | One event. Deleted body is never retained in activity. |
| `project.collection.video_link_added` | `collection_delivery` | `project-video-link:<linkId>:added`; `{ linkId, collectionKind: "video" }` | POST batch `portal/workers/app/src/routes/collections.ts:165-180` | One user operation, no URL/label. |
| `project.collection.video_link_changed` | `collection_delivery` | `project-video-link:<linkId>:changed:<activityId>`; `{ linkId, collectionKind: "video", changedFields: ("url"|"label")[] }` | PATCH batch `portal/workers/app/src/routes/collections.ts:183-225` | One summary per save; changed field names only, never values. |
| `project.collection.video_links_reordered` | `collection_delivery` | `project-video-links:<collectionId>:reordered:<activityId>`; `{ collectionKind: "video", count }` | reorder batch `portal/workers/app/src/routes/collections.ts:228-280` | Collection operation is user-visible delivery ordering, so one collection summary is allowed. This is not project Kanban/checklist reorder. |
| `project.collection.video_link_removed` | `collection_delivery` | `project-video-link:<linkId>:removed`; `{ linkId, collectionKind: "video" }` | DELETE batch `portal/workers/app/src/routes/collections.ts:282-296` | One user operation, no URL/label. |
| `project.collection.document_completed` | `collection_delivery` | `project-document:<sessionId>:completed`; `{ collectionKind: "copy"|"floorplan", version, assetCount }` | completion batch `portal/workers/app/src/routes/collections.ts:364-411`, using existing `completionAuditId` | One upload session produces one summary, not one event per PDF/preview asset. Completed-idempotent retries emit none. |
| `project.workflow.manual_edited_ready` | `review_workflow` | `project-manual-edited:<jobId>:<assetId>:ready`; `{ collectionKind: "edited", count: 1 }` | winning publish batch in `portal/workers/background/src/workflows/manual-edited-publish.ts:85-118` | One background/user asset operation yields one summary; no destination, filename, or diagnostic. |
| `project.collection.raw_sync_completed` | `collection_delivery` | `project-raw-sync:<claimId>:completed`; `{ collectionKind: "raw", importedCount }` | reconciliation claim completion in `portal/workers/background/src/dropbox/sync.ts:342-385` | One claimed reconciliation operation produces one summary, never per imported asset. `newlyImported` is aggregated for that claim and the activity is marker-gated by the winning `running -> done` claim update. A queued continuation is a later claimed operation with its own key. A zero-import completion emits none. |

`SafeProjectField` is a finite enum of display-level fields approved for internal broad activity: `address`, `shootDate`, `timeWindow`, `agency`, `agent`, and `services`. It does not include contact details, notes, pricing, invoice/payment state, order IDs, RAW folder/provider fields, delivery URLs, or diagnostics. The build must map current patch keys to these safe names and test the denylist; it must not serialize the original patch object.

Checklist changes require the same explicit adapter. The shipped route's `changed` values are `"title" | "done" | "dueDate" | "assigneeId"` (`portal/workers/app/src/routes/project-subtasks.ts:101-107`); the producer must map `title -> title`, `done -> completion`, and `assigneeId -> assignee`, omit `dueDate`, and emit no TB4C activity when the mapped set is empty. It must never cast or serialize the route-local array as the registry's `changes` value.

All live entries declare their actor rule explicitly. Interactive app operations use `{ kind: "user", actorId }`; the two background completion summaries use `{ kind: "system", actorId: null }`. The actor-recipient rule is identical for every type: actor identity never adds a recipient; only the eligible Editor membership query does.

`notification_outbox.actor_id` is already `NOT NULL` and the consumer types it as `string` (`portal/packages/db/src/schema.ts:1040-1047`; `portal/workers/background/src/notification-delivery.ts:29-36`). TB4C does **not** rebuild that table or relax the column. `@quincy/shared` defines the fixed reserved UUID constant:

```ts
export const PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID = "00000000-0000-4000-8000-000000000000" as const;
```

This fixed v4-shaped UUID is transport-envelope compatibility only and is forbidden as a real `user.id`. The only live provisioning route generates IDs internally with `newId()` (`portal/workers/app/src/routes/users.ts:48-54`); TB4C imports the constant there and adds a defensive pre-insert equality rejection, migration/upgrade tests assert no existing user has it, and a repository audit must find no seed/migration path that inserts it. No API accepts a caller-supplied user ID. A user-authored broad outbox stores the real activity actor ID; a system-authored broad outbox stores the sentinel. The immutable activity row remains authoritative: `actor_kind='system'` requires `project_activity_events.actor_id IS NULL`, while `actor_kind='user'` requires its real ID. Broad parsing checks `outbox.actor_id = activity.actor_id` for a user activity and `outbox.actor_id = PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID` for a system activity.

The broad resolver and renderer may join an actor profile **only** through `project_activity_events.actor_id` when `actor_kind='user'`. For `actor_kind='system'` they skip the user join and use the registry's generic system copy. They never join or dereference `notification_outbox.actor_id`, so the sentinel can neither masquerade as a user nor leak into bell/Admin presentation. Tests seed a system activity with the sentinel outbox actor, prove successful rendering with no matching user row, and fail any implementation that joins the sentinel to `user`.

Existing Tonomo webhook application remains audit/provider bookkeeping in TB4C. Its multi-step order application at `portal/workers/background/src/tonomo/process.ts:154-180` is not a single marker-gated user-visible delivery winner today, and its current audit metadata contains order/assignment data. TB4C neither exposes that data nor emits per-service-link rows from `attachServiceLinks()` (`:40-53`). A future approved Tonomo summary must first define one safe, idempotent webhook-event marker and return to registry review; manual user-visible collection operations above are the initial delivery-link cutover.

### Existing seam classification

- **Existing typed intent, persist after its current winner:** Deadline (`portal/workers/app/src/lib/project-deadline.ts:189-205,271-337`) and comments (`portal/workers/app/src/lib/project-comments.ts:183-218,321-390`).
- **Existing marker-gated D1 batch, append activity/fan-out statements:** post-create membership add/remove, **initial project member tuples after all initial cycles are inserted**, archive, collection-link create/update/reorder, document completion, and manual edited promotion.
- **Needs a new adjacent winner marker or atomic refactor before emitting:** priority (`portal/workers/app/src/routes/projects.ts:375-394`), the all-or-nothing safe project/service patch (`:417-473`), restore (`:927-931`), checklist create/update/delete (`portal/workers/app/src/routes/project-subtasks.ts:79-120,166-173`), collection-link delete (`portal/workers/app/src/routes/collections.ts:282-296`), and RAW reconciliation completion (`portal/workers/background/src/dropbox/sync.ts:377-385`).
- A producer in the last class is not allowed to emit until the domain write, audit marker, activity insertion, fan-out, and returned publication IDs share one authoritative D1 winner boundary.

### Generic project-details/services winner boundary

The current `PATCH /projects/:id` pre-screens removals, then commits each guarded collection delete independently in `Promise.all`; if one loses its race, already-successful deletes remain committed, the route audits `partial: true`, and returns 409 before additions/project-field updates (`portal/workers/app/src/routes/projects.ts:437-471`). TB4C must remove that partial-commit shape before this producer is live. It does **not** define “successful save” as merely a 2xx response or omit mutations committed on a 409.

Refactor the route to one raw-D1 guarded batch for the complete requested service delta plus project fields:

1. retain the existing pre-screen only for useful blocked-detail diagnostics;
2. prepare one guarded `UPDATE projects ... RETURNING` as the operation winner; its `WHERE` requires the project, at least one actual canonical field/service-set delta, and a single common `NOT EXISTS` predicate proving that **every** requested non-RAW removal currently has zero received count, assets, links, manifests, and active document sessions;
3. write the adjacent `project.update` audit/winner marker only when that update returned a row;
4. execute every requested collection delete and every missing desired collection insert in the same D1 batch, each gated by that marker; every delete also retains its own destructive safety predicate;
5. place the `project.details.changed` activity/fan-out only after all service statements and gate it on the same marker plus a non-empty computed `SafeProjectField[]`; include `services` once when the desired service set differs;
6. after the batch, use the guarded update's own `RETURNING` result—not a sibling `changes()`—to classify success, publish only returned outboxes, trigger AutoHDR scaffold only after a committed relevant field change, and otherwise run the existing diagnostic query and return 409.

Extract the preparation/execution boundary into one route-owned service helper so the route and integration test execute the identical statement list. The race test captures the pre-screen/prepared operation, inserts a blocking link/asset for one target collection, and only then executes the prepared guarded batch; this is a deterministic test seam, not a production delay hook.

Because every delete shares the all-removals-safe predicate and D1 executes the batch as one transaction, a blocker inserted after pre-screen but before the batch makes the first guarded winner lose: **zero** collections are removed/added, zero project fields change, and zero audit/activity/outbox rows are written. A partial-removal audit is no longer a possible result. Sensitive-only field changes may still commit/audit but produce no broad activity; an exact no-op writes neither winner audit nor activity. The test must inject a blocker into one of at least two requested removals after pre-screen and prove the other collection, project fields, service set, audit, activity, and outbox all remain unchanged on 409.

### Explicit no-broad reorder paths

- `POST /projects/:id/board-position` remains audit-only for broad purposes (`portal/workers/app/src/routes/projects.ts:396-416`).
- A priority save may move a card as part of the operation, but it emits only `project.priority.changed` when priority itself changed.
- Checklist reorder remains audit-only (`portal/workers/app/src/routes/project-subtasks.ts:123-164`).

### Registered now, producer cutover deliberately reserved

These definitions are required so later work extends one registry, but they have `cutover: "reserved"` and cannot be emitted by TB4C:

| Type | Future owner | Reason TB4C does not emit |
|---|---|---|
| `project.stage.changed` | the future canonical `moveProjectStage`/Project Workspace Stage tracer bullet | Current Stage writes are spread across `portal/packages/db/src/stage-transition.ts:19-50`, app/manual routes, ingest, AutoHDR, and background reconciliation. Adding a partial producer would miss paths; adding a second producer beside direct `raw_ready`/`sent_to_editing`/`edited_landed`/`delivered` notifications would duplicate semantics. |
| `project.checklist.schedule_changed` | TB4D | TB4D owns checklist occurrence semantics and same-item/same-actor five-minute broad coalescing. TB4C reserves category, source-key, and coalescing shapes only. |
| `project.workflow.raw_ready`, `project.workflow.sent_to_editing`, `project.workflow.edited_ready`, `project.workflow.delivered` | their future canonical workflow/Stage cutover | Existing legacy `notifyProject()`/`emitNotifications()` producers remain live (`portal/workers/app/src/lib/notifications.ts:13-40`, `portal/workers/background/src/notifications.ts:15-44`, and `portal/packages/db/src/notifications.ts:122-188`). TB4C neither rewrites nor shadows them. |

Reserved definitions still declare category, safe payload, deep link, coalescing, email default, and no-backfill note, but runtime parsing rejects them as producer intents until their owning tracer bullet changes the cutover state. This keeps the registry complete without pretending incomplete production coverage.

## Recipient contract

### Occurrence-time eligibility

Broad recipient selection is a marker-gated SQL `INSERT ... SELECT`, never a JavaScript pre-read:

```sql
FROM project_activity_events activity
JOIN project_members member
  ON member.project_id = activity.project_id
 AND member.role_on_project = 'editor'
 AND member.created_at <= activity.occurred_at
JOIN user recipient
  ON recipient.id = member.user_id
WHERE activity.id = ?
  AND recipient.active = 1
  AND recipient.role IN (?, ?) -- imported shared editor-eligible roles
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
```

Additional rules:

- `membershipCycle` in the outbox payload is exactly `member.id`; `startedAt` is exactly `member.created_at`.
- `notification_outbox.recipient_membership_cycle_id` is also exactly `member.id` for every broad row. The duplicated scalar is an indexed admission/coalescing scope; delivery rejects any mismatch with the payload rather than trusting either copy independently.
- The actor is not unioned into the result. They receive the event only when they independently satisfy the same active `editor` membership-cycle and eligible-global-role contract.
- An unassigned Admin is excluded. Global Admin role alone never grants a broad recipient row.
- A removed cycle is absent and receives nothing.
- Removing and re-adding creates a new UUID row. Because the new `created_at` is later than an old event's `occurred_at`, the new cycle cannot inherit or recover the older event.
- There is no backfill on assignment, reactivation, role change, deploy, or registry activation.
- TB4C does not add a second recipient or subscription table.
- The membership cycle is the sole broad-delivery gate: TB4C neither prevents production nor suppresses delivery because a project is archived or has `stage_key = 'delivered'`. Existing domain commands retain their own archive/Delivered guards, but any semantic operation they permit to win still persists and fans out broad activity under the membership contract; in particular, `project.archived` itself remains deliverable. The occurrence and delivery SQL therefore do not join `projects` to add archive/Delivered predicates.
- The existing targeted mention resolver's archived-project suppression at `portal/workers/background/src/notification-delivery.ts:391` intentionally remains unchanged. An archived-project comment may therefore deliver its broad activity while a mention targeted to that archived project remains suppressed; TB4C does not align or rewrite those two contracts.

### Targeted new assignment suppression

For `project.team.member_added`, the same batch still creates TB4A's targeted `project.assignment.created` event for the assignee. The broad fan-out adds:

```sql
AND recipient.id <> :newAssigneeId
```

This suppresses only the duplicate broad roster row for that newly assigned user. It does not suppress the broad row for existing eligible Editors, and it does not change the targeted assignment's in-app/email preference behavior.

Initial project creation applies that rule per newly created slot, not once for the whole roster. `createProjectAtomically()` must keep `buildInitialProjectMemberStatementTuples()` as the owner of initial cycles/targeted assignment rows, then append TB4C statements in this exact order:

1. project insert and collections;
2. **all** statements returned by `buildInitialProjectMemberStatementTuples()` for every normalized slot, so every initial `project_members.id`, member-add audit, targeted outbox, and targeted ledger exists;
3. project-create audit;
4. one `project.team.member_added` activity per inserted initial cycle, each gated by that cycle's existing member-add audit;
5. each activity's broad fan-out over the now-complete initial Editor roster, excluding only `recipient.id = :newAssigneeId` from that activity's prepared slot metadata;
6. broad in-app ledgers, followed by post-commit publication of the returned targeted and broad outbox IDs.

The helper must therefore return each slot's `membershipCycle`, `memberAddAuditId`, `userId`, and result indexes—not only DTOs and targeted outbox IDs—so project creation can build and inspect the gated activity/fan-out statements without reconstructing identity. Initial Editors **do receive cross-roster broad rows for other initial slots**, because all initial cycles exist before fan-out; each receives only the targeted assignment, not a duplicate broad row, for their own slot. An initial Photographer receives only their targeted assignment and is never a broad recipient. With one initial Editor and no other slots, that Editor receives only the targeted assignment and the self-suppressed roster activity has no broad recipient.

The explicit assignment-suppression matrix is:

| Operation | Targeted assignment to newly assigned user | Broad roster row to that same user | Broad roster row to other eligible Editors |
|---|---:|---:|---:|
| Post-create Editor add | yes | no | yes |
| Post-create Photographer add | yes | not eligible unless independently assigned as Editor; if dual-role, suppress by user ID | yes |
| Initial Editor slot | yes | no for its own slot; yes for other initial slots | yes |
| Initial Photographer slot | yes | no for its own slot even if the user also has an initial Editor cycle; yes for other initial slots | yes |

### Delivery-time reauthorization

Extend `resolveRecipient()` with a `project.activity.broad` branch. Its read/parse pass joins:

- the outbox and immutable activity row;
- the exact `membershipCycle` from the payload;
- `project_members` on the same project, role `editor`, and `created_at <= occurred_at`;
- the active recipient user;
- shared global-role eligibility;
- registry cutover/category visibility.

That read pass is not the authorization boundary. After it produces safe rendered copy, the broad branch uses a dedicated `deliverBroadInApp()` D1 batch. The **final `INSERT INTO notifications ... SELECT` itself** repeats the complete exact-cycle predicate against committed rows:

```sql
FROM notification_outbox o
JOIN project_activity_events activity
  ON activity.id = o.source_key
 AND activity.project_id = o.project_id
JOIN user recipient
  ON recipient.id = o.recipient_id
JOIN project_members member
  ON member.id = o.recipient_membership_cycle_id
 AND member.id = json_extract(o.payload_json, '$.authorizationAtOccurrence.membershipCycle')
 AND member.project_id = o.project_id
 AND member.user_id = o.recipient_id
 AND member.role_on_project = 'editor'
WHERE o.id = :outboxId
  AND o.status = 'processing'
  AND o.lease_token = :leaseToken
  AND o.schema_version = 1
  AND o.event_type = 'project.activity.broad'
  AND json_extract(o.payload_json, '$.event.type') = o.event_type
  AND json_extract(o.payload_json, '$.event.sourceKey') = o.source_key
  AND json_extract(o.payload_json, '$.event.recipientId') = o.recipient_id
  AND json_extract(o.payload_json, '$.authorizationAtOccurrence.kind') = 'project_editor_membership'
  AND EXISTS (
    SELECT 1 FROM notification_delivery_ledger ledger
    WHERE ledger.outbox_id = o.id
      AND ledger.channel = 'in_app'
      AND ledger.status = 'processing'
  )
  AND json_extract(o.payload_json, '$.activity.id') = activity.id
  AND json_extract(o.payload_json, '$.activity.projectId') = activity.project_id
  AND member.created_at = json_extract(o.payload_json, '$.authorizationAtOccurrence.startedAt')
  AND member.created_at <= activity.occurred_at
  AND recipient.active = 1
  AND recipient.role IN (:sharedEditorEligibleRoles)
```

The eligible-role bindings come from `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`; SQL does not restate a private role list. The insert retains the existing `(type, source_key, user_id)` idempotency conflict handling.

Build that predicate from reusable `structuralAdmission` (lease/envelope/activity/project/payload agreement) and `authorizationAdmission` (exact cycle/start, active user, eligible global role) SQL fragments. The same D1 batch, in order, (1) moves the broad in-app ledger `pending -> processing` only under both fragments, (2) performs the predicate-bearing `notifications INSERT ... SELECT`, (3) converges the ledger to `sent` only when the idempotent notification row exists and both fragments still hold, (4) otherwise moves the still-pending/processing ledger to `suppressed` with `reauthorization_suppressed` only when `structuralAdmission` still holds and `authorizationAdmission` is false, (5) moves it to lease-fenced `failed` with the bounded matching permanent code when the structural fragment is false (including an activity deleted after the read pass), and (6) writes the adjacent safe suppression audit immediately after the suppression transition and the adjacent safe failure audit immediately after the failure transition. The audit from each winning terminal transition is therefore not inferred from a bare `changes() = 1` after both candidate transitions. (7) terminally completes/suppresses/fails the lease-owned outbox. This mirrors TB4B's atomic reminder-channel admission/convergence pattern (`portal/workers/background/src/notification-delivery.ts:598-651`) rather than relying on a second JavaScript resolver call. D1 executes the batch transactionally, so removal, deactivation, or global-role change committed after the read/parse pass but before this batch is rejected by the final insert; no commit can interleave between its insert and convergence/suppression/failure statements.

`deliverBroadInApp()` returns a terminal outcome—`"delivered" | "suppressed" | "failed"`—to `processNotificationMessage()`. The discriminator is the first winning terminal transition: statement (3) selects `"delivered"`, statement (4) selects `"suppressed"`, statement (5) selects `"failed"`; zero terminal transitions means lease loss or infrastructure failure and throws. It does not mirror `deliverInApp()`'s `changes !== 1` throw for convergence: statement (3) legitimately changes zero rows whenever statement (4) or (5) wins. Statements (1)–(7) must leave the lease-owned outbox non-`processing` for every terminal outcome, and the function throws only when lease ownership is lost before terminalization or an infrastructure exception prevents the batch from establishing a terminal result. `processNotificationMessage()` then performs its existing `readOutbox()` terminal check and acks suppression/permanent failure without Queue retry or user-visible error, as required by `docs/Implementation-Plan.md` A10 (“without retry”).

If current authorization fails, suppress the pending in-app ledger and outbox with the existing `reauthorization_suppressed` terminal vocabulary. Do not disclose whether exact-cycle removal, global-role ineligibility, or deactivation caused it. Structural/malformed/registry-cutover failures follow the distinct permanent-failure contract below and are never mislabeled as authorization loss.

TB4E later extends the registry visibility check and eligible global-role predicate; it does not replace the cycle join.

## Broad outbox and ledger contract

The broad outbox payload is versioned and minimal:

```json
{
  "schemaVersion": 1,
  "event": {
    "type": "project.activity.broad",
    "sourceKey": "<activity-id>",
    "recipientId": "<user-id>"
  },
  "authorizationAtOccurrence": {
    "kind": "project_editor_membership",
    "membershipCycle": "<project_members.id>",
    "startedAt": 0
  },
  "activity": {
    "id": "<activity-id>",
    "projectId": "<project-id>"
  }
}
```

For every admitted, non-coalesced eligible recipient:

- insert one `notification_outbox` row;
- insert exactly one `notification_delivery_ledger` row with `channel = 'in_app'`;
- insert **no** email ledger row;
- publish one unchanged Queue message referencing that outbox ID.

This is consistent with TB4's “mandatory in-app before optional email” rule: the mandatory channel exists and runs first; the optional email channel is absent, not preference-suppressed and not failed. Broad events must never create `preference_suppressed`, `sent`, `failed`, or `unknown` email ledger states because no email ledger exists.

Add a small defensive channel-plan dispatch to `processNotificationMessage()` so `project.activity.broad` completes after terminal in-app handling. The `readOutbox()` ack remains the normal terminal path; this dispatch must not become a second terminalization path. All other event types continue through their existing in-app/email behavior unchanged.

## Noise and coalescing

### General rules

- A producer emits only after a semantic domain mutation wins.
- A single save/batch is one activity event even if several safe fields change.
- Pure Kanban and checklist order changes emit no broad activity.
- One Deadline save consumes one TB4B intent and creates one activity.
- A collection/background operation creates one summary, never one row per file/object.
- Targeted assignment suppression is applied only as specified above; it is not a general targeted-vs-broad dedupe heuristic.

### Five-minute mechanism

The reusable coalescing declaration is:

```ts
type ProjectActivityCoalescing = null | {
  strategy: "leading_edge";
  key: string;
  windowSeconds: 300;
};
```

For `project.comment.edited`, the key is:

```text
project-comment-edit:<projectId>:<commentId>:<actorId>
```

Every winning semantic edit still inserts its immutable activity row. During recipient fan-out, suppress a new outbox only when an already-committed broad outbox for that same recipient has the same `recipient_membership_cycle_id`, the same `coalesce_key`, and:

```text
current.occurred_at >= previous.coalesce_until - 300000
current.occurred_at <  previous.coalesce_until
```

The first admitted outbox stores `coalesce_until = occurred_at + 300000`; the start is therefore derivable without a fourth column. The window does not slide and is not extended by suppressed edits. The first edit at or after the boundary creates a new outbox/window. Failed, dismissed, pending, delivered, and DLQ status do not change the window; coalescing is admission noise control, not a delivery-success retry mechanism.

The fan-out SQL must evaluate prior windows per recipient **and exact membership cycle** inside the marker-gated statement:

```sql
AND previous.event_type = 'project.activity.broad'
AND previous.recipient_id = member.user_id
AND previous.recipient_membership_cycle_id = member.id
AND previous.coalesce_key = :coalesceKey
```

This stored cycle scope is mandatory even though the semantic key already contains project/comment/actor. If the same user is removed and re-added inside five minutes, the old outbox belongs to the deleted UUID and cannot suppress the new UUID's first event-time-eligible edit. The new cycle still cannot receive any earlier edit because `member.created_at <= activity.occurred_at` remains required.

For non-coalesced activity, `coalesce_key` and `coalesce_until` are `NULL`; `recipient_membership_cycle_id` remains non-null for every broad outbox because delivery authorization always needs it.

TB4D reuses this exact mechanism with:

```text
project-checklist-schedule:<projectId>:<itemId>:<actorId>
```

but TB4C does not emit or interpret the TB4D activity type.

Coalescing never changes, deletes, or merges `project_activity_events`; it only decides whether a recipient-specific outbox/ledger is admitted.

## Producer implementation slices

### Slice 1 — shared registry and migration

1. Add migration `0034` and Drizzle schema.
2. Add the shared registry/parsers/renderers and generic outbox event constant.
3. Add the DB statement builder and result-index types.
4. Add migration, registry completeness, payload-denylist, and source-key tests before changing producers.

### Slice 2 — generic consumer and presentation

1. Add `project.activity.broad` dispatch to `resolveRecipient()`.
2. Add exact-cycle, activity, registry, active-user, and system-sentinel parsing without ever joining the sentinel to `user`.
3. Add the complete authorization predicate to the final `notifications INSERT ... SELECT`, with channel admission, convergence, suppression, and completion adjacent in the same D1 batch.
4. Add the in-app-only channel plan without changing mention, assignment, or Deadline reminder behavior.
5. Render title/body from the parsed safe registry payload plus already-authorized project/actor display names.
6. Extend finite notification types/routes and Admin event label.

Deployability rule: this slice must be production-safe before any producer can publish the new event type.

### Slice 3 — consume existing intents first

1. Construct TB4B's existing Deadline intent once, append its persistence/fan-out to the current save winner batch, and publish returned IDs from committed saves only.
2. Move the current comment activity intent type into `@quincy/shared` or adapt it to that exact shared shape; do not keep two unions. `parseProjectActivityIntent()` (or the equivalent single registry adapter) must convert the existing Deadline and comment intents' ISO-8601 string `occurredAt` values to epoch milliseconds before binding `project_activity_events.occurred_at`; SQLite affinity is not a conversion boundary.
3. Persist comment create/edit/delete activity beside their current winner markers.
4. Keep targeted comment mention producers and read-marker behavior unchanged.

### Slice 4 — team, coordination, project, and checklist producers

1. Add the roster activity/outbox statements to TB4A's post-create exact add/remove batches **and** to `createProjectAtomically()` after every initial member tuple has run.
2. Enforce per-slot new-assignee broad suppression in SQL while permitting initial Editors' cross-roster rows.
3. Refactor priority/project safe-field/archive/restore paths into guarded mutation + adjacent marker batches where they are not already atomic; restore specifically requires `archived_at IS NOT NULL`, and the generic project/service PATCH is one all-or-nothing batch that can no longer commit partial service removals on 409.
4. Refactor checklist create/update/delete into the same winner pattern, apply the explicit route-key-to-registry-change mapping, and capture the registry-bounded authoritative title.
5. Preserve targeted subtask-assignment delivery; exclude due-date-only changes and all reorder routes.

### Slice 5 — collection and selected workflow producers

1. Add one activity to each existing collection-link create/change/reorder/remove winner batch.
2. Add one document-completion activity keyed by the session/completion marker.
3. Add one manual-edited-ready activity beside the winning background publish transition.
4. Add one RAW reconciliation summary at the authoritative operation completion, carrying only aggregate count.
5. Prove no per-asset loop emits broad activity.

### Slice 6 — audits, QA, documentation, and rollout

Run every proof below, update live docs, deploy in safe order, perform passive production verification, and only then mark the plan implemented with the deployment commit.

## In-app surface

### Notification row types and copy

Add two final projection types to the current finite `NotificationType` union in `portal/packages/db/src/notifications.ts:5-20`:

- `project_activity` for project-root deep links;
- `project_collaboration_activity` for Collaboration deep links.

These two projection types are deliberately **not** added to `EMAIL_ENABLED_EVENTS` (`portal/packages/db/src/notifications.ts:18-20`). They are in-app projections for the generic broad consumer only; the legacy direct-email loop must continue to reject them by absence from that allowlist.

The immutable activity's registry deep-link kind selects the projection type. Suggested safe copy patterns are deliberately generic:

- Team: “Project team updated.”
- Deadline: “Deadline schedule was set/cleared/resumed.”
- Project: “Project details updated.” / “Project priority changed.”
- Checklist: “Checklist ‘{bounded checklist title}’ was added/updated/removed.”
- Comment: “A project comment was added/edited/removed.”
- Collection/workflow: “Video links updated.” / “Copy or floorplan upload completed.” / “Edited media is ready.” / “RAW import completed (N items).”

Actor display name and project display title may be joined from already-authorized current rows for presentation, but neither belongs in the broad payload. If actor/project display data is absent, fall back to the generic copy; do not fail delivery or reveal deleted historical profile data.

No copy contains comment content, filename, contact detail, URL, path, notes, or diagnostics. Checklist copy may contain only the registry-validated bounded title authorized above.

### Routes and dismissal

- Extend `projectNotificationRoute()` in `portal/packages/shared/src/staff-routes.ts:79-84` so `project_collaboration_activity` opens the project's Collaboration tab and `project_activity` opens the project root.
- Do not add arbitrary payload-driven paths or item anchors in TB4C.
- The notification API can keep returning the existing final row fields; it currently does not expose outbox/activity payloads (`portal/workers/app/src/routes/notifications.ts:11-30`).
- The top-bar list continues rendering title/body and the shared route, then dismissing the same row (`portal/apps/web/src/components/Topbar.tsx:145-155`). No new read-state table is needed.

### Admin delivery operations

- Add the generic event label “Project activity” to the existing finite Admin map.
- Keep payload JSON, activity safe payload, membership cycle, source IDs, contact details, and diagnostics out of the Admin response/UI.
- The existing `preference_suppressed` metric remains meaningful for Deadline reminder email. Broad activity has no email ledger and therefore contributes zero to that state.
- Existing retry/replay controls may operate on eligible failed/DLQ broad in-app work through the common recovery path; they may not add an email channel.

## Consumer compatibility and failure semantics

- Queue message schema and Queue/DLQ bindings remain unchanged.
- `claimOutbox()`, `releaseBeforeRetry()`, `completeIfTerminal()`, recovery, and DLQ handling remain common primitives; broad in-app delivery uses the atomic `deliverBroadInApp()` admission batch specified above rather than the lease-only final insert in today's generic `deliverInApp()`.
- `deliverBroadInApp()`'s `"delivered" | "suppressed" | "failed"` return is terminal, never a retry classification. After any returned outcome, the outbox is non-`processing`, so `processNotificationMessage()`'s existing post-delivery `readOutbox()` check acks the Queue message; only a lost lease or infrastructure exception throws into `releaseBeforeRetry()`.
- Unknown event types continue fail-closed behavior.
- Replace today's undifferentiated `{ ok: false, reason }` resolver failure (`portal/workers/background/src/notification-delivery.ts:141-147`) with this discriminated outcome across dispatch branches:

  ```ts
  type RecipientResolution<T> =
    | { ok: true; value: T }
    | { ok: false; kind: "suppress"; code: "reauthorization_suppressed"; reason: string }
    | { ok: false; kind: "permanent"; code: ProjectActivityPermanentCode };

  type ProjectActivityPermanentCode =
    | "project_activity_payload_invalid"
    | "project_activity_missing"
    | "project_activity_invalid"
    | "project_activity_project_mismatch"
    | "project_activity_type_reserved";
  ```

  Every existing mention/assignment/reminder `{ ok:false, reason }` maps to `kind: "suppress"` with the same finite reason and without changing its shipped terminal behavior; TB4C does not opportunistically reclassify old event families. The new broad resolver returns `suppress` only for current access loss (cycle removed, inactive recipient, or ineligible global role). It returns the bounded `permanent` codes for malformed outbox JSON/schema, missing activity, malformed/unsafe activity JSON or actor contract, outbox/activity project or identity mismatch, and reserved/non-live type respectively. Raw JSON and parser diagnostics never enter logs, audits, `last_error`, or Admin responses.
- Add `failWholeOccurrence()` as a lease-fenced D1 batch for `kind: "permanent"`: change every still-pending/processing broad ledger to `failed` with the bounded code, change only the matching `processing` outbox with the same lease token to `failed` and clear its lease, set `completed_at`, and write an adjacent `notification.delivery.failed` audit containing only event type, outbox ID, recipient ID, and bounded code. If lease ownership is lost, it changes nothing. It must not call `suppressWholeOccurrence()` and must not label malformed data `reauthorization_suppressed`.
- Add all five bounded codes to `safeNotificationErrorCode()`'s Admin allowlist (`portal/workers/app/src/routes/admin.ts:98-108`) and render one generic “Project activity could not be processed” label; the UI may show the safe code but never the stored raw error/payload.
- Only the two email-provider admission codes retry automatically as provider classifications. Pre-email D1/platform exceptions continue using the existing lease-release and Queue retry path (`portal/workers/background/src/notification-delivery.ts:896-903`); TB4C does not narrow those infrastructure retries or broaden provider retry classification.
- In-app insertion keeps the ledger processing until it is either durably inserted/idempotently present or terminally suppressed/failed.
- No broad path invokes the email provider, email preference lookup, or ambiguous-email logic.
- Mention, targeted assignment, and Deadline reminder tests must prove unchanged resolver branches, channel ledgers, preference behavior, and copy.
- Recovery republishes pending/expired broad outboxes using the same ID-only Queue message. It never synthesizes missing activity or membership cycles.

## TB4E readiness—design seam only

TB4C leaves one reusable recipient model:

```text
roleOnProject = editor
+ exact membership-cycle UUID
+ event-time start boundary
+ delivery-time existence
+ current active/eligible global role
+ registry category/payload projection
```

The registry categories are sufficient for TB4E to apply its approved external-safe allowlist: Stage, Deadline, safe team, checklist, comment, visible media/workflow, shoot, and service/deliverable categories. Categories involving contact detail, billing/order bookkeeping, agency notes, Dropbox/provider/Admin/pipeline state can be rejected before rendering/delivery.

TB4C structures each safe payload as a type-specific projection rather than a generic domain snapshot. TB4E may therefore add an external projection/parser per registry entry without migrating membership rows or creating a second recipient table.

TB4C builds none of that enforcement. Until TB4E ships, every registry entry's external audience state is `pending`/fail-closed, `external_editor` does not exist, and no External Editor gains staff Notice Board, directory, Admin, or global staff visibility.

## Automated test plan

### Shared registry tests

- Every live/reserved type declares all required registry fields.
- Duplicate event types/source shapes fail.
- Live intents round-trip through runtime parsers; reserved intents are rejected for production admission.
- Every TB4C entry has channels exactly `["in_app"]` and email default `off`.
- Deep links can only be project root or Collaboration for the same project.
- Safe-payload schemas reject comment bodies, filenames, freeform notes, email/phone, URL/path, billing/order/provider/diagnostic keys, unknown fields, and oversized JSON.
- Checklist payload schemas accept only a trimmed 1–500-character `checklistTitle` on `project.checklist.*`; they reject it on every other type and reject empty/oversized titles.
- Deadline's existing TB4B intent parses unchanged.
- Comment's existing coalescing key and 300-second window parse unchanged.
- `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES` remains the only role source.
- System intent parsing requires activity `actor_kind='system'`/`actor_id=null` plus the exact outbox sentinel; rendering succeeds without a sentinel user row and never queries that sentinel as a user. User intent parsing rejects the sentinel as its activity actor.

### DB/migration tests

- Apply the full migration chain through `0034` to an empty local D1.
- Apply `0034` to a populated `0033` fixture.
- Prove the table, constraints, unique key, indexes, all three nullable outbox columns, and Drizzle schema match.
- Prove invalid schema version, actor-kind/id combination, deep-link kind, invalid JSON, and non-integer timestamp storage fail; specifically, inserting an ISO-8601 string into `project_activity_events.occurred_at` is rejected by its `typeof(...) = 'integer'` check.
- Prove existing outbox rows remain readable/writable with null coalescing/cycle-scope columns, while every new broad outbox requires a non-null cycle scope matching its payload.
- Prove no existing `user.id` equals `PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID` and the Admin provisioning path rejects that reserved value defensively.
- Prove no migration SQL contains a `projects` rebuild, `DROP TABLE`, data rewrite, or foreign-key pragma toggle.
- Run `PRAGMA foreign_key_check` and `PRAGMA quick_check` after migration.

### Activity/fan-out tests

- Winning semantic mutation writes exactly one audit, one activity, one broad outbox per admitted recipient, and one in-app ledger per outbox.
- Losing guard/no-op writes none of activity/outbox/ledger.
- Replaying the same prepared source key cannot duplicate activity or recipient delivery.
- For every ephemeral-`activityId` mutable producer, rebuild an ambiguous-after-commit intent/request with a new activity ID while the first canonical result is still current; the equality guard must classify it as a no-op with no second audit/activity/outbox. Also prove an intervening state change ends that bounded retry identity and a later real change can emit.
- Event occurrence, not insertion time, controls cycle eligibility.
- Active assigned Editor receives; active assigned Admin with project editor membership receives; unassigned Admin does not.
- Actor receives only when independently eligible.
- Removed/deactivated/ineligible users receive none.
- Remove/re-add cannot receive an old-cycle event; the new cycle can receive later events.
- No assignment or deploy backfill occurs.
- Post-create new assignee gets targeted assignment delivery but no duplicate broad roster row; existing eligible Editors get the roster row.
- Initial project creation inserts all membership cycles before any broad fan-out. Each initial assignee gets its targeted assignment; each initial Editor is suppressed only from their own member-added broad row and receives cross-roster rows for other initial slots; a dual-role initial user is suppressed by user ID for each of their own slots.
- A project created with one initial Editor and no other slots creates the member-added activity and targeted assignment but zero broad rows for that self-suppressed activity; adding initial Photographer/second Editor slots produces the exact suppression-matrix counts.
- An allowed comment operation on an archived project still writes activity and fans out to the eligible membership cycles; neither archive nor `stage_key = 'delivered'` is introduced as a broad-admission predicate.
- Broad event creates no email ledger.

### Coalescing tests

- Every winning semantic comment edit persists a distinct activity; an equality-guarded ambiguous retry/no-op does not.
- Same project/comment/actor/recipient edits inside the fixed five-minute window create one outbox.
- Exact-boundary edit creates a new outbox.
- Different actor, comment, project, or recipient creates an independent window.
- The same user removed and re-added with a new `project_members.id` inside the old five-minute window receives the new cycle's first eligible alert; the old cycle's outbox cannot suppress it.
- Outbox status/dismissal/failure does not reopen or extend a window.
- A later eligible membership receives the later edit under its own cycle scope but not earlier activity.
- Non-coalesced types keep both coalescing columns null while retaining their non-null broad membership-cycle scope.
- Reserved TB4D key validates structurally but cannot be emitted.

### Producer tests

- Deadline: set, clear, and resume produce exactly one existing-intent activity only after committed version saves; stale/no-op attempts emit none; reminders stay separate.
- Team: post-create add/remove exact-cycle behavior, plus initial-project tuple ordering, cross-roster fan-out, returned-ID publication, and the complete targeted-new-assignee suppression matrix.
- Project: priority and allowlisted safe details/services produce one composite event; sensitive-only/no-op updates produce none. Inject a blocker after service pre-screen during a two-removal request and prove the 409 commits no partial removal, addition, project-field update, audit, activity, or outbox.
- Archive/restore: only the winning transition emits; restore is guarded by `archived_at IS NOT NULL`, so calling restore on an active project emits no audit/activity/outbox.
- Checklist: create/update/delete emit; one multi-field update emits once; due-date-only and reorder emit none.
- Comments: create/edit/delete emit; mention target changes do not duplicate activity; body is absent.
- Video links: one operation/summary, no URL/label in payload.
- Document completion: copy is one summary, floorplan PDF+preview is one summary, idempotent complete retry emits none.
- Manual edited publish: winning ready transition emits once; retry/already-ready/failure emits none.
- RAW reconciliation: one completion summary with aggregate count, no per-asset broad events, zero-import emits none, continuation chunks dedupe.
- Reserved Stage/legacy workflow types have no TB4C call site and no duplicate broad event.

### Consumer tests

- Generic branch parses registry/activity and exact membership cycle.
- Use a barrier immediately after the successful broad read/parse pass but before the final admission batch; separately remove the exact cycle, deactivate the user, and change the user to an ineligible global role, then release the barrier. In every case the predicate-bearing final `notifications INSERT ... SELECT` inserts zero rows and the adjacent batch suppresses/converges terminal state safely.
- At the same barrier, delete the activity/project in a separate case; the structural fragment must select bounded permanent failure, not authorization suppression.
- Missing activity, mismatched project, malformed payload, reserved type, unsafe JSON, and invalid system-sentinel/actor combinations produce their exact bounded **permanent** codes, lease-fenced `failed` ledger/outbox state, and safe failure audit—not `reauthorization_suppressed`.
- An otherwise well-formed broad event whose exact cycle is removed produces `kind:'suppress'` and `reauthorization_suppressed`, proving malformed permanent failure is distinguishable from authorization suppression.
- A suppressed broad event returns the terminal `suppressed` outcome and is acked exactly once, with zero Queue retries and zero DLQ entries.
- In-app row is idempotent across retries.
- Broad work completes after in-app and never reads email preference or invokes email.
- Only `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` retry automatically as email-provider admission classifications; a forced pre-email D1/platform exception still releases the lease and retries through the existing infrastructure path.
- Recovery and DLQ work for broad events without changing Queue body.
- Regression suites cover comment mention, project assignment, and Deadline reminder—including optional email, `preference_suppressed`, and ambiguous `unknown` handling.

### Web/UI tests

- Both new projection types render safe title/body.
- Project activity opens project root; comment/checklist activity opens Collaboration.
- Dismissal uses the existing notifications-row behavior.
- Missing actor/project presentation data falls back safely.
- Admin ops labels broad events without exposing payload/source/membership/contact data.
- `project_activity` and `project_collaboration_activity` remain absent from `EMAIL_ENABLED_EVENTS`.
- Existing bell and Deadline/mention/assignment rows are unchanged.

## Repository audits

Run from the repository root and record results in the implementation handoff:

```bash
rg -n 'project\.activity\.broad|PROJECT_ACTIVITY_REGISTRY|project_activity_events' portal
rg -n 'project\.deadline\.schedule_changed' portal
rg -n 'project\.comment\.(created|edited|deleted)' portal
rg -n 'emitNotifications|notifyProject' portal/workers portal/packages
rg -n 'stage_key\s*=|stageKey:' portal/workers portal/packages/db/src
rg -n 'board-position|project_subtask\.reorder' portal/workers/app/src
rg -n 'safe_payload_json|coalesce_key|coalesce_until|recipient_membership_cycle_id' portal
rg -n 'PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID|00000000-0000-4000-8000-000000000000' portal
rg -n 'comment.*body|originalFilename|original_filename|email|phone|dropbox|invoice|payment|diagnostic' portal/packages/shared/src/project-activity.ts portal/packages/db/src/project-activity.ts
rg -n 'project_activity|project_collaboration_activity' portal
```

Audit conclusions required:

- every live registry type has a complete finite call-site owner inventory; `project.team.member_added` includes both initial-create and post-create paths, and no two paths emit for the same semantic winner;
- every reserved type has zero producer call sites;
- Deadline uses the TB4B intent once;
- no pure Kanban/checklist reorder emits;
- no per-asset loop emits a collection summary;
- no broad event creates email ledger rows;
- no role eligibility logic is duplicated outside `@quincy/shared`;
- every broad coalescing lookup includes the exact stored membership-cycle scope;
- the system outbox sentinel is never used as an activity actor, user lookup, seed user, or presentation identity;
- no broad payload/UI/admin response contains denied fields;
- legacy direct notification producers are neither globally rewritten nor shadowed by a duplicate broad producer.

## Local migration and query-plan proof

Use a disposable local D1/database copy; never experiment on production data.

1. Apply migrations `0000` through `0034` from scratch.
2. Copy a representative `0033` local database and apply only `0034`.
3. Run a second `drizzle-kit generate` against the checked-in schema, `_journal.json`, and `0034_snapshot.json`; require no new migration and no `projects` or `notification_outbox` table rebuild.
4. Run `PRAGMA foreign_key_check;` and `PRAGMA quick_check;`.
5. Inspect `sqlite_master` for the exact activity table/constraints and outbox index.
6. Run `EXPLAIN QUERY PLAN` for:
   - semantic dedupe by `(event_type, source_key)`;
   - recipient fan-out from `project_members` by project/role/start time;
   - prior coalescing window lookup by event/recipient/**membership cycle**/key/time;
   - delivery-time join by activity ID and exact membership-cycle UUID;
   - recovery's existing outbox status/availability scan.
7. Seed competing assignment cycles, a same-user remove/re-add inside one coalescing window, unassigned Admin, deactivated user, ineligible role change, system sentinel, coalesced comment edits, and one reserved type; execute the actual prepared SQL.
8. Confirm expected indexes are used or document a bounded table/index change before implementation approval. Do not add speculative indexes without plan review.

## Required verification commands

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also run any new focused migration/background/app/shared tests during development. Recall that `npm run test --workspaces` does not include the shared package unless the separate Vitest command runs.

## Local mutating QA matrix

Use `http://localhost:8787`, after building the web app, with the seeded Admin signed in by the human. Use Admin impersonation to test Photographer/Editor roles. Browser QA is assigned under `docs/Subagent-Orchestration.md` §2.9/§2.10; the browser worker does not perform Google sign-in. Production verification later is passive-only.

| Case | Setup/action | Expected evidence |
|---|---|---|
| Assigned Editor | Admin changes a safe project field | One activity, one broad in-app row for each eligible assigned Editor; unassigned Admin absent. |
| Actor rule | Eligible Editor edits their project; then unassigned Admin edits it | Editor actor receives their own event; unassigned Admin actor does not. |
| Assignment suppression | Add a new Editor while another Editor is assigned | New assignee gets targeted assignment only; existing Editor gets broad roster event. |
| Initial roster | Create a disposable project with an Editor, Photographer, and second Editor | All cycles/targeted rows exist first; each Editor lacks only their own broad row and receives cross-roster rows; exact matrix counts match. |
| Remove/re-add | Remove Editor, make change, re-add, then make another | Removed/new cycle cannot get middle event; new cycle gets only later event. |
| Archived project | Archive a disposable project, then create a comment through the still-authorized project Collaboration API | The archive alert and later comment activity both fan out to eligible assigned Editors; archive state adds no broad suppression. |
| Final-admission races | Pause after broad resolver read; separately remove, deactivate, and role-demote recipient before resuming | No in-app row in all three cases; the final SQL predicate drives adjacent suppression without leaking reason. |
| Deadline | Set, clear, resume, retry same version/no-op | One broad schedule event per winning save; reminder occurrences remain separately typed. |
| Comment coalescing | Same actor edits same comment repeatedly before and after five minutes | Every edit has activity; first window has one alert; boundary starts a new alert. |
| Comment privacy | Create/edit/delete content containing sensitive strings | Bell/Admin ops/activity payload never contains the body. |
| Checklist | Create, edit title+completion, due-date only, reorder, delete | Broad rows for create/composite update/delete; none for due-date-only or reorder. |
| Project board | Reorder card; then change priority | No broad row for reorder; exactly one for priority. |
| Project service race | Request two service removals; add a blocker after pre-screen for one | 409 with neither service removed and no project/audit/activity/outbox partial commit. |
| Collection link | Add/change/reorder/remove URL/label | One summary per operation; no URL or label in durable broad data/UI. |
| Floorplan | Complete PDF+preview session | One collection summary, not two asset events. |
| RAW reconciliation | Import multiple files in one operation | One aggregate summary, no filenames, no per-file alerts. |
| Manual edited ready | Complete/retry one publish job | One winning workflow activity/alert. |
| Dismiss/deep link | Open both activity projection kinds and dismiss | Correct project/Collaboration route; existing dismissal persists. |
| Channel proof | Inspect broad ledger and provider mocks | One in-app ledger; zero email ledgers/provider calls. |
| Regression | Trigger mention, project assignment, Deadline reminder | Existing copy, channels, preferences, and recovery behavior remain intact. |
| Admin ops | Inspect pending/failed/retried broad work | Safe generic label/status only; `preference_suppressed` unaffected. |

## Deployment preflight and rollout

### Preflight

1. Rebase a branch from current `main`; confirm TB4B documentation closeout is resolved.
2. Confirm clean worktree and record commit SHA.
3. Confirm the production deployment baseline supplied for TB4B:
   - commit `dba2e40`;
   - background `2668a652-dca8-4a24-a2c8-f0b712b8ff0f`;
   - app `15b45ad1-620d-4c00-94e2-1b27484d29a0`.
4. Query remote production `d1_migrations`; require tail `0033`. Confirm local journal tail also `0033`, then claim `0034`.
5. Create a timestamped remote D1 recovery export in the established parent `db-recovery/` directory and record its exact path/checksum in the deploy log.
6. Record D1 row counts for projects, project members, notifications, outbox, ledger, and audit before migration.
7. Run the complete automated commands, repository audits, local full-chain/upgrade migration proof, and query-plan proof.
8. Complete the local mutating QA matrix. Do not use production for mutation tests.
9. Confirm no Queue/binding/Cron/secret/config change is present.
10. Confirm the background consumer recognizes `project.activity.broad` before any app producer build is deployed.

### Rollout order

1. Apply remote migration `0034` and verify `d1_migrations`, schema/indexes, `foreign_key_check`, and row counts.
2. Deploy **background first** from `portal/workers/background`.
   - This installs the consumer branch before app producers publish.
   - Background-owned RAW/manual-publish producers become active only in the same build that can consume them.
3. Verify background Worker version, Queue consumer health, recovery scan, and absence of unknown-event errors.
4. Deploy **app second** from `portal/workers/app`.
5. No webhook-ingress deploy is required unless the final diff unexpectedly changes it; if it does, return to plan review because this plan owns no webhook change.
6. Record deployed versions, migration result, commit SHA, and UTC/local timestamps.

### Passive production verification

Without creating or modifying production project data:

- verify app health/auth and existing bell dismissal/read paths;
- query migration/schema/index presence;
- observe Queue/Worker logs for malformed/unknown broad events, repeated retries, or DLQ growth;
- inspect aggregate outbox/ledger state only through privacy-safe operational queries;
- confirm broad outboxes, if normal human operations naturally create them, have exactly one in-app ledger and no email ledger;
- confirm mention/assignment/Deadline reminder traffic remains healthy;
- confirm no email-provider traffic is attributed to `project.activity.broad`;
- confirm no payload/contact data appears in Admin operations.

Do not manufacture a production event for smoke testing. If natural traffic has not exercised the new path, record that fact and rely on local mutation proof plus passive consumer/migration health; do not weaken acceptance silently.

### Documentation closeout

After verified production deployment:

- update `docs/todo.md`, `CLAUDE.md`, and mirrored `AGENTS.md` migration/deployment state;
- record final Worker versions and migration in this plan;
- change the status line to deployed with the commit hash;
- `git mv` this file to `docs/plans/implemented/` only when the deployed production behavior matches the plan.

## Rollback and fix-forward

The migration is additive and data-retaining. Prefer fix-forward.

### Application/producer fault

1. Deploy the last known-good app Worker first to stop app-owned broad production.
2. Keep the TB4C-aware background consumer live long enough to drain or terminally classify already-created broad outboxes.
3. If a background-owned producer is faulty, deploy a fix-forward background build that disables only that producer while retaining broad consumer support. Do **not** roll background to a pre-TB4C version while broad work remains pending/queued/processing.
4. Preserve activity, outbox, ledger, and notifications rows for diagnosis; do not delete or rewrite them.

### Consumer fault

1. Stop app producers by rolling app back if continued production increases risk.
2. Deploy a fixed TB4C-aware background consumer.
3. Let lease expiry/recovery republish the same outbox IDs.
4. Never add email ledgers during replay and never synthesize new semantic source keys.

### Migration/schema fault

- Do not drop `project_activity_events`, the new columns, or indexes during incident response.
- Previous application code ignores additive schema, so Worker rollback is compatible after pending broad work is made safe.
- Use the pre-migration recovery export only for catastrophic D1 recovery under explicit human authorization; routine rollback retains all data and migration history.

### Privacy fault

If an unsafe type/payload projection is detected:

1. disable that producer via code deploy;
2. make consumer registry parsing fail closed for that type;
3. retain durable rows and assess exposure with restricted operational queries;
4. do not paste payloads into logs/issues;
5. follow explicit incident direction for any user-visible row remediation. This plan does not pre-authorize destructive cleanup.

### Email ambiguity

Broad activity has no email channel, so there is no ambiguous email acceptance to replay. Existing targeted-event `unknown` rows remain governed by TB4 and must not be changed as part of rollback.

TB4C likewise does not change targeted email defaults: mentions, assignments, and Deadline reminders retain their shipped internal preference behavior and default-on contract. TB4E is responsible for applying the approved same default-on behavior to External Editors when that audience exists. Broad email remains off for both audiences.

## Acceptance checklist

### Architecture and registry

- [ ] One finite shared registry owns every required declaration and runtime parser.
- [ ] Every live type has a complete exact producer-call-site inventory with no overlapping emission for one winner; every reserved type has none.
- [ ] Initial project membership creation is an explicit producer; all initial cycles precede fan-out and its per-slot suppression matrix is proven.
- [ ] Activity, audit, outbox/ledger, notifications, and discussion read markers remain separate.
- [ ] Migration is additive, tail-numbered correctly, and does not rebuild `projects`.
- [ ] Drizzle schema, journal, and `0034_snapshot.json` match; a second `drizzle-kit generate` produces no migration and no `projects`/`notification_outbox` rebuild.
- [ ] Every committed approved semantic operation writes exactly one immutable safe activity; no history backfill exists.

### Recipient and delivery correctness

- [ ] Occurrence fan-out is marker-gated `INSERT ... SELECT`, not JS pre-read.
- [ ] Exact Editor membership cycle, event-time start, current existence, active state, and shared global-role eligibility are all enforced.
- [ ] The complete authorization predicate is inside the final in-app `INSERT ... SELECT`, with convergence/suppression in the same D1 batch.
- [ ] Actor inclusion, unassigned Admin exclusion, removal/deactivation suppression, and remove/re-add isolation are proven.
- [ ] Targeted new assignment suppresses only the new assignee's duplicate broad roster row.
- [ ] Coalescing is scoped by stored `project_members.id`, so remove/re-add starts an independent window.
- [ ] Every admitted broad recipient has one outbox and one in-app ledger; no broad email ledger exists.
- [ ] Queue body, common delivery/recovery/DLQ primitives, retry classifier, and existing targeted branches remain unchanged.

### Noise and privacy

- [ ] No project Kanban/checklist reorder broad events exist.
- [ ] Deadline saves consume exactly one TB4B intent and never conflate reminders.
- [ ] Every winning semantic comment edit activity persists while same-comment/same-actor delivery coalesces for the exact fixed five-minute window; equality-guarded retry/no-op requests emit none.
- [ ] One collection/background operation produces one safe summary, not per-asset alerts.
- [ ] Broad payload/copy/Admin operations contain no denied content/contact/provider/diagnostic data.
- [ ] System activities use the fixed outbox sentinel while retaining nullable activity actor semantics; no renderer or user join dereferences the sentinel.
- [ ] Malformed/structural broad work fails with bounded permanent codes distinct from authorization suppression.

### Surface and future seams

- [ ] Broad rows render safely, deep-link correctly, and dismiss through the existing bell path.
- [ ] Admin operations expose only safe generic operational state.
- [ ] TB4D can activate the reserved checklist schedule type using the same coalescing mechanism.
- [ ] TB4E can apply category/payload projection to the same `roleOnProject="editor"` cycle model without a second recipient table.
- [ ] No Calendar, External Editor, global activity UI, email/digest/SMS/push, legacy notification rewrite, or prototype work entered the diff.

### Proof and rollout

- [ ] Typecheck, web build, all workspace tests, and the separate shared Vitest suite are green.
- [ ] Repository producer/privacy/reorder/email audits are recorded.
- [ ] Full-chain and `0033 -> 0034` local migration/query-plan proof is recorded.
- [ ] Local mutating QA matrix is complete; production verification is passive.
- [ ] Recovery export exists and remote migration tail was verified before applying `0034`.
- [ ] Migration, background-first deploy, app deploy, version capture, and passive health checks succeeded.
- [ ] Documentation reflects live production and this plan moved to `implemented/` only after deployment.

## Expected implementation footprint

Exact test filenames may follow existing workspace conventions, but the implementation should remain within these owners:

- `portal/packages/db/migrations/0034_project_activity_events.sql`
- `portal/packages/db/migrations/meta/_journal.json`
- `portal/packages/db/migrations/meta/0034_snapshot.json`
- `portal/packages/db/src/schema.ts`
- new `portal/packages/db/src/project-activity.ts`
- new `portal/packages/shared/src/project-activity.ts` and shared exports/tests
- `portal/packages/shared/src/notification-outbox.ts`
- `portal/workers/app/src/routes/users.ts` (defensive rejection of the reserved system outbox actor ID)
- `portal/packages/shared/src/staff-routes.ts`
- `portal/packages/db/src/notifications.ts`
- `portal/workers/background/src/notification-delivery.ts` and tests
- `portal/workers/app/src/routes/admin.ts` and Admin tests for bounded permanent codes
- the exact app/background producer files enumerated in the registry table
- notification route/component/Admin tests and the smallest finite label/type changes
- current-state docs at deployment closeout

Any need to add a new recipient table, Queue/resource, global role, broad email, project-table rebuild, generic domain snapshot, Stage producer, or global migration of direct notifications is plan drift and requires returning to fresh-Sol review before implementation proceeds.
