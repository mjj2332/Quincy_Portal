# Revamp TB4E — External Editor Assigned-Scope Access

**Status:** APPROVED FOR BUILD — 2026-08-28. Pipeline: Sol draft → fresh-Sol review ×2 (7B+3S then
4B, all folded) → Opus plan-tier revert 1 of 2 (3 Blocking + 7 Should-fix + 1 Nit) → fresh-Sol
revision (the transform-bearer state machine collapsed ~84→19 lines; migration `0036` shrank 6→3
columns) → **Opus plan-tier re-review APPROVED**: all 3 revert-1 Blocking verified fixed against
source; residual purge window + multipart-orphan story both ruled acceptable with conditions. Opus
left **9 Should-fix + 5 Nits** (carried into the build spec, not blocking) — notably SF-1 (route
manifest gate fails open — needs count reconciliation), SF-5 (registry policy `Record` vs per-entry
`externalProjection` circular import — use the separate `Record`), SF-2/SF-3 (dangling
conversion-state refs from the collapse), SF-6 (per-principal concurrent upload-session cap),
SF-8 (purge-exhaustion runbook), SF-9 (bound the incomplete-multipart lifecycle rule). Build →
self-check → fresh Sol diff review → fixes → Sol focused pass → Opus final-draft review → §5 gate →
deploy + commit. Move this file to `docs/plans/implemented/` after production deploy. No first
External Editor account is provisioned by this tracer bullet (acceptance bar).

## Purpose and review state

TB4E introduces `external_editor` as a reusable server-enforced authorization and privacy boundary.
An External Editor can perform the approved editing and Collaboration work on a currently assigned
project without learning that an unassigned project, unrelated person, internal note, contact,
billing record, Dropbox path, provider state, or Admin resource exists.

This is a security tracer bullet, not a visual feature. The implementation is incomplete if React
hides a field or route while an API, notification row, activity payload, media response, direct URL,
count, suggestion, cache entry, or error still reveals it. No first External Editor account may be
provisioned in production until every acceptance gate in this plan is green.

This draft was promoted from the TB4E roadmap brief after checking the dependency claims against
local `main` at `c7d559d`, which the release record identifies as matching production after TB4D.
Reviewers must review the plan, not infer permission to build it.

### Required review sequence

1. Fresh-Sol review rounds 1 and 2 are complete; this revision resolves their findings. The two-round
   cap is exhausted, so no third Sol review is scheduled.
2. Opus plan-tier revert 1 of 2 is folded here. A fresh Opus plan-tier re-review is next and checks
   architecture, privacy, lifecycle, rollout, and rollback; one revert remains.
3. A build may begin only after Opus approval is recorded in this status section.
4. The completed diff receives the build/review/verification pipeline in
   `docs/Subagent-Orchestration.md`; Agy is the Chrome QA operator. This revision does not run Opus
   review or authorize/consume any build review.

## Authority and conflict order

Implementation must resolve conflicts in this order:

1. `docs/Decision-Sheet.md`, especially D-02, D-06, and D-19. D-02 fixes Photographer at
   assigned-project/RAW-only scope (`docs/Decision-Sheet.md:19`); D-06 requires capabilities rather
   than role-shaped rewrites (`:23`); D-19 requires a distinct assignment-scoped global role and one
   shared external-safe server projection (`:32`).
2. `docs/Implementation-Plan.md`, especially A14 (`docs/Implementation-Plan.md:248-284`) and the
   existing capability/authorization contract.
3. `docs/plans/revamp_2026_portal/core/13-External-Editor-Authorization.md` in full.
4. `docs/plans/revamp_2026_portal/roadmap/TB4E-External-Editor-Assigned-Scope-Access.md` in full.
5. Core documents 05, 06, 07, 09, and 12 for freshness, Collaboration, notifications, migrations,
   and future Calendar behavior.
6. The shipped TB2/TB4A/TB4C/TB4D plans, then current source wherever shipped prose has drifted.

The repository rules in `AGENTS.md`/`CLAUDE.md` and the real failure modes in `docs/lessons.md` also
apply: `@quincy/shared` remains the single source for roles/capabilities; Hono middleware must be
path-scoped and exact gated paths must handle trailing slashes; D1 additions use bare additive SQL
where possible; deployment order is consumer before producer; closed Google OAuth remains closed.

## Verified foundation on `main`

### Production and migration base

- `docs/todo.md` records TB4D deployed on 2026-08-28 at merge `37c6219`, migration `0035`,
  background Worker `e7133940-5c55-4faf-9db6-4c15394dcb39`, and app Worker
  `65ad323b-4ba5-4c19-8b9e-5e838a3562e6`.
- Local HEAD is `c7d559d`. Migration files and `meta/_journal.json` end at index/tag `0035`; the
  next available number is therefore `0036`. Production's `d1_migrations` tail must still be queried
  and confirmed as `0035` during build preflight; this draft does not mutate or query production.
- TB4, TB4A, TB4B, TB4C, and TB4D are the live compatibility floor. TB4E must preserve all internal
  Admin, Photographer, and Editor behavior except for routing it through the shared scope/projection
  seams and tightening accidental data exposure.

### Capability model: all nine initial grants exist; two future grants do not

`portal/packages/shared/src/capabilities.ts:7-38` defines the closed `ROLES` and `CAPABILITIES`
unions, and `:51-112` defines `ROLE_CAPABILITIES: Record<Role, readonly Capability[]>` plus
`roleHasCapability()`.

The complete initial TB4E allow-list already exists, so TB4E adds **no initial capability string**:

| Capability | Current line | TB4E grant |
|---|---:|---|
| `uploadEdited` | `capabilities.ts:17` | yes, assigned project only |
| `viewRaw` | `:18` | yes, assigned project only |
| `annotateRaw` | `:19` | yes, assigned project only |
| `recommendRaw` | `:20` | yes, assigned project only |
| `compareFrames` | `:21` | yes, assigned project only |
| `viewEdited` | `:23` | yes, assigned project only |
| `reviewEdited` | `:24` | yes, assigned project only |
| `annotateEdited` | `:25` | yes, assigned project only |
| `collaborateOnProject` | `:35` | yes, assigned project only |

`moveProjectStage` and `viewProductionCalendar` are absent from `CAPABILITIES`. That absence is
correct: TB5A and TB5C own those strings and their implementations. TB4E documents/reserves their
future External Editor grants but must not add either string now.

The exact new role entry is:

```ts
external_editor: [
  "uploadEdited",
  "viewRaw",
  "annotateRaw",
  "recommendRaw",
  "compareFrames",
  "viewEdited",
  "reviewEdited",
  "annotateEdited",
  "collaborateOnProject",
]
```

It deliberately omits `viewAllProjects`, `publish`, `viewClientPreview`, `downloadFinal`,
`manageExtras`, `selectForEditing`, `uploadRaw`, `viewNoticeBoard`, `createProject`, `editProject`,
`archiveProject`, `manageUsers`, `adminBackend`, `manageIntegrations`, `managePipelineConfig`,
`manageDirectory`, and `prioritizeProjects`. AutoHDR send and provider/job diagnostics remain behind
existing Admin capabilities; capability possession never bypasses project scope.

### Database role storage: no role CHECK and no role migration

- `schema.user.role` is a Drizzle `text(..., {enum:[...]})` at
  `portal/packages/db/src/schema.ts:20-35`; the generated base migration is plain
  ``role text DEFAULT 'photographer' NOT NULL`` at
  `portal/packages/db/migrations/0000_lovely_changeling.sql:303-312`.
- `project_members.role_on_project` is a two-value Drizzle enum at
  `schema.ts:249-265`, but its database column is plain `text NOT NULL` at
  `0000_lovely_changeling.sql:206-216`. It remains exactly `photographer | editor`; TB4E does not
  widen it.
- The only current `authorRole` Drizzle enum is `annotations.author_role` at
  `schema.ts:891-910`; its database column is plain `text NOT NULL` at
  `0000_lovely_changeling.sql:39-48`. The old `comments.author_role` column was also plain text and
  its table was removed by migration `0021`; current `project_comments` has no `authorRole` column.
- A repository-wide migration audit finds no later role CHECK. Drizzle's `text(...,{enum})` is a
  TypeScript inference aid and did not emit a database constraint here.

Therefore widening `user.role` and `annotations.authorRole` to `external_editor` is a schema-type
change only. It must not generate a table rebuild or role-column migration. Migration `0036` is
still required for `projects.production_notes`, authorization/outbox epoch columns, and
the recoverable opaque External upload tables specified below; none is a role-enum migration.

### TB4A role-specific assignment and membership cycles

`portal/packages/shared/src/project-members.ts:3-13` keeps project roles at two values and defines:

```ts
photographer: ["photographer", "editor", "admin"]
editor: ["editor", "admin"]
```

TB4E changes only the second list to `['editor','external_editor','admin']`. The Photographer slot
does not admit External Editors. `routes/projects.ts:262-271` derives both Create Project candidate
queries from those arrays; `:293-369` rechecks the same eligibility in the atomic create command.
`lib/project-members.ts` uses the same source for add/remove membership commands. One delivery cycle
continues to mean one exact `project_members.id` UUID row; removal and later re-add create distinct
cycles and never reuse history.

### TB4C registry, durable recipient contract, and the legacy direct-delivery gap

Every activity registry entry currently has
`actorRecipientRule:'eligible_editor_membership_only'` and `audience:'internal'`
(`portal/packages/shared/src/project-activity.ts:106-145`). The live and reserved types are
enumerated at `:14-43` and `:162-194`. TB4E keeps that registry as the internal delivery inventory
and adds the separate exhaustive `EXTERNAL_PROJECT_ACTIVITY_POLICY` in
`external-project-policy.ts` as the External projection authority.

The broad activity builder already derives Editor-recipient global roles from
`PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`; the background delivery path reauthorizes the current
role, active state, exact Editor membership cycle, project visibility, and occurrence time. TB4E
must extend that mechanism, not add a second recipient or assignment table. Adding
`external_editor` to the shared Editor eligibility array intentionally admits an External Editor's
exact `project_members.id` cycle to the same outbox/ledger pipeline, while registry projection and
delivery-time gates decide whether content is safe.

That reauthorization is not sufficient across `editor ↔ external_editor`: both roles remain
Editor-slot eligible and preserve the same membership UUID. The live broad envelope has no global-
role version (`workers/background/src/notification-delivery.ts:401-405`) and
`resolveBroadRecipient()` currently checks only current role eligibility plus that preserved cycle
(`portal/workers/background/src/notification-delivery.ts:426-506`; the SQL admission itself is in
`broadAdmission()` at `:904-988`). TB4E adds the
durable per-user authorization epoch and outbox stamp specified below; membership-cycle provenance
and role epoch are independent, mandatory fences.

TB4C is not the only producer. `portal/packages/db/src/notifications.ts:5-22` declares thirteen
legacy `NotificationType` values and its email-enabled set. `projectNotificationRecipients()` at
`:58-80` returns every active project member plus active Admins without global-role privacy, and
`emitNotifications()` at `:126-190` directly inserts `notifications` and may immediately send email.
Current app/background callers include RAW/Edited workflow, Stage-to-editing, delivered,
AutoHDR-stalled, annotation feedback, checklist assignment, and due-today delivery
(`workers/app/src/lib/notifications.ts:13-118`; `workers/background/src/notifications.ts:15-210`).
The checklist-assignment direct path has neither membership-cycle nor current assignment-version
admission. None of these paths consults the separate TB4E External activity policy.

The lifecycle vocabulary is fixed by
`packages/db/migrations/0031_notification_outbox_and_delivery_ledger.sql:10-30,54-58`:
outbox is exactly `pending | queued | processing | completed | suppressed | failed | dlq |
discarded`; ledger is exactly `pending | processing | sent | suppressed | failed | unknown |
discarded`. TB4E does not invent a `cancelled` state or directly rewrite terminal history. Every
suppression contract below names the exact mutable source states and the consumer-owned processing
race.

TB4E therefore treats the durable registry and legacy emitter as one security inventory. The
exclusion choke point is **inside `emitNotifications()` itself**: it reloads every proposed
recipient and removes any whose current role is `external_editor` before inserting a row or sending
email. This covers all six current call sites (or, equivalently, every call site of
`emitNotifications()`), including `notifyNoticeBoardMentions()`, whose
recipient query bypasses `projectNotificationRecipients()` and whose Notice Board email contains a
staff-post excerpt (`workers/app/src/lib/notifications.ts:49-63`;
`packages/db/src/notifications.ts:112-123`). `projectNotificationRecipients()` may filter earlier
as defense in depth, but it is not the authority. An allowed External
event is reconstructed as an outbox/ledger event with exact project/membership/assignment provenance
and send-time authorization; a suppressed event produces no external outbox, ledger, notification,
or email. Internal recipients may continue through the compatible direct path until their owner
tracer bullets migrate them.

`GET /api/notifications` currently selects every notification row for a user and counts all unread
rows without project/category reauthorization (`routes/notifications.ts:11-30`). TB4E makes list,
unread count, mark-read, delete, and mark-all-read use one identical fail-closed SQL predicate for an
External principal. It excludes rows for projects without a current visible Editor membership,
legacy/unlinked rows, suppressed event types, and rows linked to a superseded membership cycle.

### TB4D checklist scheduling

- `project.checklist.schedule_changed` is live at `project-activity.ts:184-189` and uses the generic
  Editor membership-cycle path.
- The context-free Collaboration guard reloads `active` and admits Admin globally or any other
  current member (`middleware/capability.ts:31-42`). External Editors therefore receive normal
  checklist/comment/schedule rights on assigned, non-archived projects once the shared visibility
  gate is added.
- Project Deadline writes remain behind `editProject` in
  `routes/project-deadline.ts:22-38`; External Editors can read the external-safe Deadline but cannot
  mutate it.
- TB4D's final-role checklist cleanup is already part of the atomic membership removal command.
  TB4E reuses its `subtask_assignment_confirmation_required` count and does not invent a second
  cleanup path.

### TB2 freshness and current gap

Project resources already share the `['project-data', projectId, ...]` key family
(`apps/web/src/lib/project-data.ts:23-34`). `purgeProjectData`, `removeProjectData`, and
`clearPrincipalProjectData` cancel/remove the private prefixes, reset collaboration/media ledgers,
publish same-browser tombstones, and clear the whole principal cache
(`project-data.ts:312-358`). The provider is keyed by principal/role, so an observed role change
already replaces the QueryClient.

The gap is authorization freshness while a different browser removes a membership: Dashboard uses
a one-shot manual project fetch, and no always-mounted authorization snapshot exists. Open resource
queries can eventually discover a `403/404`, but quick detail, media references, and future Calendar
state have no single revocation signal. TB4E adds the narrow snapshot described below; membership
loss purges one project without signing the user out, while role change/deactivation revokes the
session and follows the full principal-clear path.

### Current authorization and serializer hazards

- `hasProjectAccessForUser()` returns true for `viewAllProjects`, otherwise requires membership,
  then adds the Photographer Stage filter (`middleware/capability.ts:44-55`). It does not accept
  `active`, does not own archived visibility, and returns only a boolean.
- `GET /api/projects` special-cases Photographer and otherwise returns every unarchived project
  (`routes/projects.ts:378-389`). Adding a fourth role without fixing this would expose the full
  project list.
- `details()` uses `select()` for the whole `projects` row and spreads it into the response
  (`routes/projects.ts:244-256`). The list similarly selects/spreads `schema.projects`. Both expose
  contact, billing, order, internal notes, and Dropbox fields if the UI type merely omits them.
- `media.ts:25-88` and `review.ts:20-87` contain hard-coded Admin/Editor or Photographer role
  branches. External authorization must become capability-driven, including the distinction between
  RAW recommendation and RAW selection/review metadata.
- Annotation responses expose `strokeR2Key`; External responses must expose an authorized annotation
  media URL/`hasMarkup` fact, never a storage key.
- Edited-upload preconditions currently inspect Dropbox fields and can return raw-folder/provider
  shaped errors. External upload responses must use bounded production-safe states and copy.
- `GET /api/projects/:id/manual-upload-jobs` is project-access gated but not Admin-capability gated;
  provider/job diagnostics must move behind `adminBackend`.

### Better-auth and user lifecycle

- The closed Google provider has both `disableImplicitSignUp:true` and `disableSignUp:true`, and the
  user-create hook always rejects implicit creation (`workers/app/src/auth.ts:33-63`). TB4E preserves
  this model.
- The better-auth Admin plugin currently maps only three roles (`auth.ts:28-48`). Session middleware
  validates against shared `ROLES`, so widening shared `ROLES` is the appropriate source change.
- Migration `0032` already added better-auth Admin compatibility fields (`banned`, `ban_reason`,
  `ban_expires`, `session.impersonated_by`) and the feature-flag table; no new auth column is needed.
- `PATCH /api/users/:id` currently updates role without revoking sessions and revokes sessions only
  for deactivation (`routes/users.ts:57-68`). It has no incompatible-membership guard and no atomic
  role/deactivation command. TB4E replaces this behavior.
- Runtime-gated Admin impersonation currently accepts only Photographer/Editor targets
  (`auth.ts:71-74`, `lib/impersonation.ts:40-42`, `App.tsx:112-113`). TB4E includes an active
  External Editor as an impersonable non-Admin target so local role-matrix QA can exercise the real
  session/projection path; impersonation remains Admin-only, toggle-gated, time-limited, and audited.

## Scope

### In scope

- Add the fourth global role, display label, exact capability entry, Drizzle enum widening, auth
  plugin mapping, exhaustive role handling, and runtime-gated impersonation support.
- Generalize all project access through one capability-driven, active-aware, archive-aware server
  scope used in both SQL lists and resource guards.
- Add explicit external-safe query projections/serializers for every currently reachable surface,
  plus fail-closed seams for future activity, Calendar, quick-detail, and export consumers.
- Add nullable `projects.production_notes`, internal-only create/edit controls for it, and read-only
  external presentation. Never backfill it from `projects.notes`.
- Add the opaque, expiring External edited-upload session protocol/table so storage keys and provider
  multipart IDs never enter an External request or response.
- Include active External Editors in Editor-slot/Create Project candidates only; preserve inactive
  assignments for display/removal.
- Add atomic role-transition, deactivation, and final-membership-removal delivery suppression,
  session revocation, audit, and blocker contracts.
- Add a monotonic per-user authorization epoch, bind every transform-source signature to its issuing
  principal's epoch, stamp it on every notification outbox recipient row,
  and make final delivery admission reject a pre-transition epoch even when membership is preserved.
- Keep the activity registry as the internal delivery inventory and add an explicit, exhaustive
  per-type allowed or suppressed External policy in `external-project-policy.ts`; enforce it at
  occurrence and delivery time.
- Extend TB2 freshness with an authorization snapshot and targeted cache/UI revocation behavior.
- Add automated security-boundary tests, repository audits, local authorization/projection proof,
  Agy role-matrix QA, migration proof, rollout, and data-retaining rollback.

### Hard non-goals

- No first production External Editor account is provisioned by TB4E rollout. Provisioning is a
  later explicit Admin action only after acceptance evidence is signed off.
- No Calendar UI, Calendar endpoint, range query, FullCalendar code, or `viewProductionCalendar`
  capability; TB5C owns them.
- No `moveProjectStage` capability or External Editor Stage mutation; TB5A owns it.
- No third `role_on_project` value, external assignment table, duplicated project copy, or second
  notification recipient table.
- No staff Notice Board, global directory, Admin surface, integration/provider diagnostics,
  pipeline configuration, priority/Kanban controls, AutoHDR send, publishing, client preview, final
  download, RAW selection, extras management, or project administration for External Editors.
- No automatic conversion of existing users; no domain/email/activity heuristic; no signup,
  invitation, or magic-link work.
- No change to Photographer Stage scope or internal Editor broad scope beyond expressing the current
  rules through the shared scope seam. A security regression discovered while doing so is fixed,
  documented, and tested rather than preserved.
- No copying `projects.notes` into `production_notes`, no provider/storage key normalization, and no
  destructive schema rollback.
- No `prototype/` changes, React migration, Tailwind, shadcn, or visual redesign.

## Exact role and capability contract

1. Add `external_editor` to `ROLES` and `Role`; export one shared `ROLE_LABELS` or
   `roleDisplayName(role)` authority with exact display text **External editor**. Replace local
   fall-through labels that would incorrectly call it “Editor.”
2. Add only the nine capabilities listed above to `ROLE_CAPABILITIES.external_editor`.
3. Add `external_editor` to `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`; do not add it to
   `.photographer` or `PROJECT_MEMBER_ROLES`.
4. Widen `schema.user.role` and `schema.annotations.authorRole` Drizzle enum arrays. Add no role
   migration and no DB CHECK as collateral work.
5. Add an external better-auth access-control role with no Admin permissions and include it in the
   plugin role map. Session creation/API validation reload `active` and `authorization_epoch`; the
   bounded session principal exposes `authorizationEpoch` to key private client
   state and still validates role through shared `ROLES`.
6. Make every role switch/type exhaustive. Delete hard-coded role arrays where a shared capability
   or assignment-eligibility helper is the real rule.
7. External status appears only where contextual identity is authorized: Admin user management,
   assigned Team rows, project mention/assignee results, comment author badges, and later
   Activity/Calendar participant filters. The visible label is subtle, not a permission substitute.

## One server-side visible-project scope

### Scope result and SQL form

Create a route-independent module such as
`workers/app/src/lib/visible-project-scope.ts`. It owns both:

```ts
type VisibleProjectContext = {
  principal: Pick<SessionUser, "id" | "role" | "active" | "authorizationEpoch">;
  projectId: string;
  membershipCycleId: string | null;
  roleOnProject: "photographer" | "editor" | null;
  projection: "internal" | "external";
};

visibleProjectWhere(principal, options): SQL
resolveVisibleProject(env, principal, projectId, options): Promise<VisibleProjectContext | null>
```

The principal is reloaded from D1 for authorization-sensitive commands and carries `active`; a
session-cached role is never the sole authority after an Admin transition. The predicate is:

```text
principal.active = true
AND (
  roleHasCapability(role, 'viewAllProjects')
  OR EXISTS (
    current project_members pm for principal/project
    AND (role != 'external_editor' OR pm.role_on_project = 'editor')
  )
)
AND (role != 'photographer' OR stage_key IN PHOTOGRAPHER_VISIBLE_STAGES)
AND (
  role != 'external_editor'
  OR archived_at IS NULL
)
```

Ordinary non-archive list mode also requires `archived_at IS NULL` for existing roles. Admin's
explicit archived mode remains capability-gated. An External Editor can see any assigned,
unarchived Stage, including active work and `delivered`; there is no Photographer Stage clause for
that role. An archived project is unavailable to an External Editor even if its membership row is
retained.

Lists compose `visibleProjectWhere` directly into the query; they do not query all rows and filter
in JavaScript. Resource routes resolve project visibility in the same SQL statement/join before
serializing the resource. Collaboration's context-free helper becomes a capability-plus-scope
wrapper: it requires `collaborateOnProject` and `resolveVisibleProject`, so inactive, unassigned, or
archived External Editors cannot collaborate.

### Non-disclosing error contract

- An unassigned, archived-for-external, nonexistent, or resource-under-invisible-project lookup
  returns the same `404 {"error":"Project not found"}` shape. Do not first reveal “you are not
  assigned,” the true project street, asset existence, collection kind, comment/checklist existence,
  or a different status.
- A malformed identifier may return bounded `400` before lookup; it confirms no database fact.
- Only after `resolveVisibleProject` succeeds may a route return a capability-specific `403`, field
  validation error, or resource-specific `404` within that known project.
- List/search/suggestion/count/filter surfaces silently omit invisible rows. No response contains a
  total computed before authorization.
- Capability middleware that returns the same response regardless of target existence may remain
  outside the lookup, but it must be registered for both bare and trailing-slash exact forms where
  applicable. Do not call a Hono middleware factory manually or mount `use('*', ...)` at `/`.
- The invisible and nonexistent arms of each project/child lookup execute the **same scoped SELECT or
  JOIN and the same response branch**. A zero-row result returns immediately; no resource-specific
  follow-up SELECT, R2 HEAD/GET, provider call, count, or diagnostic query runs after that miss.
  Integration tests record normalized SQL fingerprints/statement counts for both arms and require
  equality.
- Do not claim constant-time behavior. The local security regression runs 200 randomized paired,
  warmed probes for representative project, asset, annotation, comment, and checklist routes,
  discards the first 20 pairs, and requires the absolute median latency difference to remain within
  `max(3 ms, 3 × pooled median absolute deviation)` and the p95 difference within
  `max(8 ms, 4 × pooled median absolute deviation)`. A failure is investigated as query-path drift;
  the structural SQL-fingerprint assertion remains authoritative even when host timing is noisy.

### Exact cross-project/list/search/detail inventory

There is no separate server project-search or quick-detail endpoint on `main`. Dashboard search,
suggestions, visible result counts, Stage/filter option counts, and empty states are computed in the
browser from `GET /api/projects`. The exact current/new cross-project surfaces are:

| Endpoint/surface | Before TB4E | Required TB4E scope/projection |
|---|---|---|
| `GET /api/me` (`index.ts:58`) | Returns the authenticated principal and capability list | Principal-global; strict self-only response schema/decoder below, including current authorization epoch and no unrelated user data |
| `GET\|PATCH /api/notification-preferences` (`notification-preferences.ts:20,22`) | Reads/writes the signed-in user's Deadline-email preference | Principal-global and External-reachable; preserve strict personal preference semantics and add the exact response schema/decoder below |
| `GET /api/projects` (`routes/projects.ts:378`) | Photographer membership+Stage; every other role gets all matching archive rows; whole project rows are spread | Apply `visibleProjectWhere` in SQL; external gets only assigned/unarchived rows and external summary DTO; counts/search/filter options derive only from this result |
| Dashboard search/suggestions/counts/filters | Client-side derivation from the above response | No second data source; never retain an invisible row in local search index, count, Stage options, or suggestion cache |
| `GET /api/projects/:id` (`projects.ts:1131`) | Boolean guard, then full project spread | `resolveVisibleProject`; generic invisible `404`; external detail projection only |
| Project deep link / current quick-detail owner | Reuses project detail and client cache | Reuse the same detail response; no parallel full DTO or browser-only field deletion |
| `GET /api/project-assignment-candidates` (`projects.ts:391`) | Active eligible staff; create/edit capability required | Remains inaccessible to External Editors; Editor list includes active internal Editor, External Editor, Admin; Photographer list excludes External Editor |
| `GET /api/mentionable-users?projectId=...` (`mentionable-users.ts:15`) | Collaboration check, project members plus approved Admin candidates | Shared visible-project guard; return only project participants plus approved active Admin collaborators, contextual label, no unrelated email/global directory; invisible project is generic `404` |
| `GET /api/mentionable-users` Notice Board branch | All active users after `viewNoticeBoard` | Internal-only, and its SQL must add `user.role <> 'external_editor'`; capability denial alone does not prevent an External Editor from becoming a staff Notice Board mention candidate |
| `GET /api/notifications?limit&cursor` (`notifications.ts:11`) | All rows/counts for user | External role receives only current-scope, external-allowed/projected rows; unread count and cursor page are computed after the same visibility predicate |
| `POST /api/notifications/:id/read` (`notifications.ts:33`) | Mutates any unread row owned by the user | For External, update only IDs selected by the identical `external_visible_notifications` CTE; hidden/absent both return the existing notification-not-found 404 |
| `DELETE /api/notifications/:id` (`notifications.ts:44`) | Deletes any row owned by the user | For External, delete only IDs selected by that same CTE; hidden/absent are identical and the audit follows only a winning delete |
| `POST /api/notifications/read-all` (`portal/workers/app/src/routes/notifications.ts:55`) | Marks every owned unread row | For External, update only unread IDs selected by the same CTE; unlinked, invisible, suppressed, and superseded-cycle rows remain untouched |
| `GET /api/project-access-snapshot` (new) | Absent | Return only currently visible project IDs plus membership-cycle IDs for scoped roles and a deterministic authorization fingerprint; no project/contact fields |

`GET /api/stages` is a global configuration read, not a project list. It may return the role-safe
Stage vocabulary but no project counts. All `/api/admin/*`, `/api/users`, `/api/integrations`, and
Notice Board endpoints remain protected by capabilities External Editors do not have; their queries
must never be reused as an External assignment picker.

### Project-resource endpoint inventory

Every following current route must replace ad hoc `hasProjectAccess`/Collaboration checks with the
shared resolver and use the named projection family. Asset/comment/checklist IDs must be joined to a
visible project before their existence is disclosed.

| Family | Current endpoints | TB4E rule |
|---|---|---|
| Media lists/bytes | `GET /api/projects/:id/assets`; `GET /media/asset/:assetId/:variant`; `GET /media/annotation/:annotationId` | Scope first; then `viewRaw` or `viewEdited`; external media projector; no R2/storage/provider keys |
| Review | `POST /api/assets/:id/review`; `POST/DELETE /api/assets/:id/select` | Scope first. External may set only RAW `recommended` via `recommendRaw`, and edited review fields via `reviewEdited`; non-recommend RAW selection/review metadata remains behind `selectForEditing`; selection routes remain denied |
| Annotations | `GET/POST /api/assets/:id/annotations`; `PATCH/DELETE /api/annotations/:id` | Scope plus `annotateRaw`/`annotateEdited`; external-safe annotation DTO; existing author-only edit/delete, including intentional impersonation semantics, is unchanged |
| Collection links | `GET /api/projects/:id/links`; link create/patch/reorder/delete | External may read authorized deliverables via `viewEdited`; all writes remain behind existing `manageExtras`/`editProject`; omit provider source data from external DTO |
| Documents | document presign/direct/complete/abort routes under `/api/projects/:id/documents...` | External lacks `manageExtras`; no upload/session/provider diagnostics are reachable |
| Legacy edited uploads | `POST /api/uploads/presign`; `PUT /api/uploads/direct`; `POST /api/uploads/complete` | Preserve for internal roles. External gets a constant pre-provider 403 on all three, including trailing slash, because their schemas expose provider capabilities |
| External edited uploads | new `POST /api/external-uploads`; `PUT /api/external-uploads/:sessionToken/parts/:partNumber`; `POST /api/external-uploads/:sessionToken/complete`; `DELETE /api/external-uploads/:sessionToken` | Scope + active External role + epoch + exact membership cycle on creation and every request; same-origin `env.MEDIA` binding proxy and strict schemas below; no R2 URL/topology/identifier |
| RAW upload/status | `POST /api/projects/:id/upload-manifest`; `GET /api/projects/:id/ingest-status` | RAW upload denied (`uploadRaw` absent); ingest status is readable only if it is an approved visible RAW workflow summary and is projected to bounded counts/status |
| Collaboration summary/comments | `GET /api/projects/:id/collaboration-summary`; comment list/create/edit/delete; read-marker GET/PATCH | `collaborateOnProject` plus shared scope; return only the closed `ExternalParticipantDto`, `ExternalCommentDto`, and `ExternalCommentReadStateDto` shapes in the matrix; author-only comment mutation remains |
| Checklist | subtask list/create/patch/reorder/delete under `/api/projects/:id/subtasks...` | `collaborateOnProject` plus shared scope; existing command and TB4D schedule permission; return only the closed `ExternalChecklistItemDto`/`ExternalPersonDto` shapes in the matrix |
| Deadline | `PUT /api/projects/:id/deadline` | Shared scope then `editProject`; External sees Deadline via project DTO but write remains denied/read-only |
| Project team | membership add/remove paths registered in `routes/projects.ts` | Scope, then `editProject`; External cannot mutate team. Internal Admin/Editor removal command supplies access-loss warning/cleanup contract |
| Project diagnostics | AutoHDR status/history/coverage, job list/retry, Dropbox sync, manual-upload jobs | `adminBackend`/existing internal capability before returning data. Add the missing `adminBackend` gate to `GET /api/projects/:id/manual-upload-jobs` |
| Project delivery/download | selected RAW ZIP, download selection/ticket archive, cover, publish-related collection paths | Existing withheld capabilities remain authoritative; no External access or metadata leakage |
| Project mutations | priority, board position, patch, archive/restore/delete, Stage, AutoHDR send/fetch | Existing explicit capabilities remain; TB4E adds no Stage capability. Shared scope/error order applies where the target is resolved |
| Asset deletion | `DELETE /api/assets/:id` (`routes/assets.ts:30-58+`) | Remains behind constant pre-lookup `adminBackend` middleware. External receives the same 403 for existing/nonexistent IDs; no asset/project/job/provider query runs |
| Transform source | `GET /__transform-source/*` plus `/__transform-source` fallback (`index.ts:66-85`) | This remains the signed-capability protocol for non-External cold transforms. It is never emitted by an External response. Invalid/expired/malformed/nonexistent-key forms return the same existing `c.notFound()` 404 response; a valid internal bearer is tested as a bearer, not mistaken for session authorization |

There is no current Calendar, Activity-feed, general export, or separate quick-detail API. TB4E does
not create those product endpoints; it creates tested projection functions and an access contract
that TB5A–TB8 must call.

### Generated registered-route security manifest

The tables above explain product behavior but are not the completeness authority. Add a test helper
`workers/app/test/registered-route-manifest.ts` that reads the fully mounted Hono application's
`app.routes` after `index.ts` has attached all routers. Pinned Hono exposes only
`{method,path,handler}` and includes middleware registrations plus legitimate duplicate method/path
pairs, so the following normalization is itself a reviewed security contract:

1. Add a `terminalRoute(handler)` registration wrapper that sets a private exported `Symbol` marker
   on every terminal handler before it is passed to `get|post|put|patch|delete|all`. Middleware
   passed to `use()` is never marked. Do not infer terminality from handler arity: optional/unused
   `next` parameters make that heuristic refactor-sensitive.
2. Flatten the fully mounted `app.routes`, retain only handlers carrying that exact marker, and
   retain `ALL` and wildcard terminal registrations. Normalize only the method spelling and mounted
   path; do not drop either form.
3. Collapse identical terminal `{method,path}` pairs to one manifest key. The helper records the
   contributing registrations and fails if duplicates disagree on route class, scope/projection
   contract, or terminal response family. Middleware duplicates therefore disappear by rule while
   terminal duplicates cannot conceal different security behavior.

Require every normalized terminal route under `/api`, `/media`, and `/__transform-source`—including
fallbacks, capability-withheld routes, `DELETE /api/assets/:id`, and wildcard/bearer routes—to have
exactly one checked-in entry in `PROJECT_SECURITY_ROUTE_CLASSIFICATION`:

```ts
type ProjectSecurityRouteClass =
  | "scoped-project"
  | "scoped-child-resource"
  | "constant-capability-denial"
  | "principal-global"
  | "auth-protocol"
  | "bearer-protocol"
  | "withheld"
  | "terminal-fallback";
```

`withheld` means no External session can obtain a success response: ordinary authenticated routes
use constant pre-lookup 403, while the transform-source exception accepts only its separately tested
revocable internal bearer and returns the same 404 for every invalid/External-stale form. It is not
a synonym for dropping `ALL` or wildcard registrations.

The generated deduplicated actual set and classified expected set must be equal in both directions.
This gate is fail-closed by count as well as set equality: `app.routes.length` must equal
`markedTerminalRegistrations + checkedInMiddlewareRegistrations.length`, where the latter is an
explicit checked-in list of every `use()` registration. A route registration without
`terminalRoute()` is therefore counted but absent from both terminal set and expected set, making
the suite fail instead of silently expanding the accepted set. The marker inspection unwraps
`handler[COMPOSED_HANDLER]` from `hono/utils/constants` before checking the terminal symbol; the
manifest also asserts that the mounted application does not set a custom `onError`, because that
wrapper replaces handlers without preserving the terminal marker. The implementation scope is
approximately 125 terminal registrations across approximately 20 route files (including about 23
in `projects.ts`, 23 in `admin.ts`, 15 in `index.ts`, and 10 in `collections.ts`), each wrapped by
an identity `terminalRoute()` marker. The regression test must be red both when one wrapper is
deleted and when a new unwrapped route is added.
`ALL /__transform-source` and `GET /__transform-source/*` must both survive normalization and are
classified `withheld` from the External-client surface; their separate bearer-protocol probes still
exercise the valid internal signature and uniform failure behavior below. A newly
registered route makes the test fail until its class, scope resolver, projection family, and error
contract are reviewed. Static SPA and reserved client-delivery routes are recorded separately and
cannot be silently classified as project data.

For every route containing a project, asset, annotation, comment, checklist, membership, job,
download-ticket, or upload-session identifier, the manifest-driven integration suite sends:

1. an existing authorized target;
2. an existing but invisible target;
3. a syntactically valid nonexistent target; and
4. the trailing-slash form of all three.

`constant-capability-denial` routes may return a constant pre-lookup 403 for all valid IDs; tests
also assert zero domain SQL/provider calls, so the denial cannot be an existence oracle. Scoped
routes require the identical zero-row join/error path described above. Trailing slash may share the
same handler or be a terminal 404, but it must never reach a permissive wildcard or disclose a
different target fact. The `/__transform-source/*` cases include a valid current internal bearer,
expired/invalid signatures, an encoded nonexistent key, the bare path, and trailing slashes. Only
the valid bearer may read its exact object. Invalid/expired signatures stop before R2; a correctly
signed nonexistent key performs exactly one R2 miss; both yield the same `c.notFound()` 404. This protocol
does not accept a project/resource ID and possession of its unguessable signature is the authority,
so it is classified/tested separately from the scoped-resource timing contract. The suite separately
proves that no External API response can mint or reveal such a bearer.

## External-safe server projections

### Cross-Worker authority and exported surface

The external policy cannot live only in the app Worker because the background Worker owns recipient
resolution/admission and notification insertion. Add these source-owned modules to
`portal/packages/shared/src/` and export them from `@quincy/shared`:

```ts
// external-project-policy.ts
export type ExternalProjectionDecision =
  | { decision: "allowed" }
  | { decision: "suppressed"; reason: ExternalSuppressionReason };
export const EXTERNAL_PROJECT_ACTIVITY_POLICY: Record<ProjectActivityType, ExternalActivityPolicy>;
export const EXTERNAL_LEGACY_NOTIFICATION_POLICY: Record<NotificationType, ExternalLegacyPolicy>;
export const EXTERNAL_PROJECT_DETAIL_SAFE_FIELDS: readonly ExternalProjectDetailSafeField[];
export function projectExternalActivityPayload<T extends ProjectActivityType>(
  type: T,
  payload: ProjectActivityPayloadFor<T>,
): ExternalProjectedActivity<T> | null;
export function projectExternalLegacyPayload(
  type: NotificationType,
  payload: unknown,
): ExternalLegacyPayload | null;
export function isExternalNotificationEventAllowed(eventType: string): boolean;

// external-notification.ts
export const EXTERNAL_NOTIFICATION_OUTBOX_EVENT_TYPES: {
  projectSafeDirect: "project.external_safe.direct";
  subtaskAssigned: "project.subtask.assigned";
  subtaskDueToday: "project.subtask.due_today";
};
export const externalNotificationOutboxPayloadSchema: z.ZodDiscriminatedUnion<...>;
export function parseExternalNotificationOutboxPayload(value: unknown): ExternalNotificationOutboxPayload | null;
export function externalNotificationCopy(input: ExternalNotificationCopyInput): NotificationCopy;
export function externalNotificationChannels(type: ExternalAllowedNotificationType): readonly ("in_app" | "email")[];

// external-project-dto.ts
export const externalProjectSummarySchema: z.ZodObject<...>;
export const externalProjectDetailSchema: z.ZodObject<...>;
export const externalAssetSchema: z.ZodObject<...>;
export const externalAnnotationSchema: z.ZodObject<...>;
export const externalCollectionLinkSchema: z.ZodObject<...>;
export const externalIngestStatusSchema: z.ZodObject<...>;
export const externalChecklistItemSchema: z.ZodObject<...>;
export const externalCommentSchema: z.ZodObject<...>;
export const externalCommentReadStateSchema: z.ZodObject<...>;
export const externalMentionableUserSchema: z.ZodObject<...>;
export const externalNotificationListItemSchema: z.ZodObject<...>;
export const externalCalendarRangeSchema: z.ZodObject<...>;
export const externalProjectExportSchema: z.ZodObject<...>;
export const externalProjectListResponseSchema: z.ZodObject<...>;
export const externalAssetListResponseSchema: z.ZodObject<...>;
export const externalAnnotationListResponseSchema: z.ZodObject<...>;
export const externalCommentListResponseSchema: z.ZodObject<...>;
export const externalChecklistListResponseSchema: z.ZodObject<...>;
export const externalCollectionLinkListResponseSchema: z.ZodObject<...>;
export const externalMentionableListResponseSchema: z.ZodObject<...>;
export const externalNotificationListResponseSchema: z.ZodObject<...>;
export const externalMeResponseSchema: z.ZodObject<...>;
export const externalNotificationPreferenceResponseSchema: z.ZodObject<...>;
export const externalMutationOkResponseSchema: z.ZodObject<...>;
export const EXTERNAL_API_RESPONSE_SCHEMAS: Readonly<Record<ExternalApiSurface, z.ZodTypeAny>>;

// external-upload.ts
export const externalEditedUploadCreateRequestSchema: z.ZodObject<...>;
export const externalEditedUploadCreateResponseSchema: z.ZodObject<...>;
export const externalEditedPartResponseSchema: z.ZodObject<...>;
export const externalEditedCompleteRequestSchema: z.ZodObject<...>;
export const externalEditedCompleteResponseSchema: z.ZodObject<...>;
export const externalEditedAbortResponseSchema: z.ZodObject<...>;
export const externalEditedUploadErrorSchema: z.ZodDiscriminatedUnion<...>;
export const EXTERNAL_UPLOAD_SESSION_STATES: readonly ["open","completing","completed","aborting","aborted","expired"];
```

`external-project-policy.ts` owns the reviewer-approved conditional
`project.details.changed` safe-field intersection. Its input field name is a closed union generated
from `EXTERNAL_PROJECT_DETAIL_SAFE_FIELDS`; an unknown field is a TypeScript error for typed callers,
fails strict runtime parsing for stored input, and fails the exhaustive registry test. App and
background import this projector and `externalNotificationCopy`; neither maintains a local policy or
copies the internal renderer and redacts afterward.

The app Worker adds only app/SQL-specific
`workers/app/src/lib/external-project-query.ts`, exporting the explicit `EXTERNAL_*_SELECT` maps and
`selectExternalProjectSummary`, `selectExternalProjectDetail`, `selectExternalAssets`,
`selectExternalCollaboration`, and strict response constructors. It does not own activity policy or
notification copy. The background Worker imports the shared parsers/policy/copy from
`@quincy/shared` inside `resolveBroadRecipient`, `resolveRecipient`, `broadAdmission`, and
`deliverBroadInApp`.

`external-upload.ts` is the strict browser/app/background vocabulary for the Quincy proxy. It
contains no R2 hostname/key/upload-ID type. App owns `env.MEDIA` binding transport; background owns
known-session sweeps; web imports only these request/response schemas.

Move the closed `NotificationType` union from `@quincy/db` to `@quincy/shared` and re-export it from
`@quincy/db` for compatibility; otherwise the shared policy would create a forbidden shared→db
dependency. `EMAIL_ENABLED_EVENTS` remains an internal legacy-emitter concern and may import the
shared type.

All shared schemas are `.strict()`. App constructors use `satisfies` against `z.infer<typeof
schema>` and then call `schema.parse()` in tests/runtime boundary code. SQL uses explicit select maps
and restricted joins. Do **not** select a whole table row, spread it, then delete keys. A new selected
column or response key fails compile-time construction and the runtime unknown-key test rather than
appearing by default.

### Normative external query/DTO matrix

This matrix is the security schema. “None” under email means no participant email key is selected or
returned; it does not mean a nullable/redacted key. Shared nested schemas named below are closed too:

- `ExternalDeadlineDto` has exactly `version`, `deadline` (`null` or exactly `localCivil`, `zone`,
  `utcOffsetMinutes`, `fold`, `instant`), `reminderOffsetsMinutes`, `state`, `nextOccurrence` (`null`
  or exactly `kind`, `offsetMinutes`, `firesAt`), `canResume`, and optional
  `skippedReminderOffsetsMinutes`;
- `ExternalScheduleDto` is the existing closed `ChecklistScheduleDto` union with exactly its
  state-specific keys (`state`, `version`, `zone`, `start`, `end`, `due`, and only the documented
  `error` arm); an endpoint has exactly `kind`, `localCivil`, `instant`, `utcOffsetMinutes`, `fold`,
  `resolution`;
- `ExternalPersonDto` has exactly `id`, `name`, `roleLabel`, `isExternal`, `active`; only
  `ExternalParticipantDto` adds `email`, `membershipCycleId`, and `roleOnProject`.

| External-reachable surface | Exact selected columns and joins | Exact response keys | Participant email |
|---|---|---|---|
| Project summary / `GET /api/projects` | `projects`: `id,street,suburb,postcode,agency_name,agent_name,agency_id,agent_id,shoot_date,time_window,stage_key,production_notes,cover_asset_id,deadline_local_civil,deadline_zone,deadline_utc_offset_minutes,deadline_fold,deadline_at,deadline_reminder_offsets_json,deadline_version`; `LEFT JOIN agencies ON projects.agency_id=agencies.id` selecting **only** `agencies.name`; `LEFT JOIN agents ON projects.agent_id=agents.id` selecting **only** `agents.name`; RAW collection join selects only `id,kind,status,expected_count,received_count`; visible-scope predicate is in the same query | exactly `id,address:{street,suburb,postcode},agencyDisplayName,agentDisplayName,shootDate,timeWindow,stageKey,deadline,productionNotes,services:[{id,kind,status,expectedCount,receivedCount}],cover:{assetId,url}|null` | None |
| Project detail / `GET /api/projects/:id` | Same project/name-only directory select; additionally select only computed SQL expression `(projects.raw_folder_path IS NOT NULL OR projects.raw_folder_link IS NOT NULL) AS edited_upload_available`—never either path/link value; all collections select only `id,kind,status,expected_count,received_count`; member join selects `project_members.id,user_id,role_on_project,user.name,user.email,user.role,user.active`; grouped checklist count selects only `assignee_id,count(*)`; Deadline reader selects only canonical Deadline columns | exactly summary keys plus `editedUploadAvailable:boolean`, `collections:[{id,kind,status,expectedCount,receivedCount}]` and `members:[{id,userId,membershipCycleId,roleOnProject,name,email,roleLabel,isExternal,active,assignedSubtaskCount}]`; no duplicate internal project fields | **Present only in `members[]`** |
| Asset/media list / `GET /api/projects/:id/assets` | `assets`: `id,collection_id,kind,original_filename,bytes,width,height,rating_from_metadata,section,source_raw_asset_id,version,version_group_id,supersedes_asset_id,created_at,publish_status,superseded_at`; collection join selects `project_id,kind`; review join selects `stars,color_label,decision,recommended`; selection join selects only `id`; rendition join selects only `variant,spec_version,content_type`; never select asset/R2/source/provider paths | exactly `{assets:[{id,collectionId,kind,originalFilename,bytes,width,height,ratingFromMetadata,section,renditionStatus,createdAt,sourceRawAssetId,version,versionGroupId,supersedesAssetId,review:{stars,colorLabel,decision,recommended}|null,selected}]}` | None |
| Single asset bytes / `/media/asset/:assetId/:variant` | One scoped join selects only `assets.id,kind,original_filename,r2_key,publish_status,superseded_at`, `collections.project_id,kind`; durable-rendition lookup selects only `r2_key,content_type`; `r2_key` is an internal execution value and never serialized/logged | binary body only; headers exactly `content-type`, `cache-control: private, no-store`, `content-length` when known, `x-content-type-options:nosniff`, optional `etag`, and sanitized PDF `content-disposition`; missing rendition returns exactly `{error:"Rendition is still processing",code:"rendition_processing",renditionStatus:"processing"}` | None |
| Annotation list/create/edit item | Scoped asset join as above; annotation select only `id,asset_id,author_id,author_role,scope,stroke_r2_key,note_text,created_at,edited_at`; author join selects only `user.id,name,role,active`; storage key remains internal | exactly `id,author:{id,name,roleLabel,isExternal,active},scope,hasMarkup,markupUrl,noteText,createdAt,editedAt` | None |
| Annotation markup `/media/annotation/:annotationId` | One scoped annotation→asset→collection join selects only internal `stroke_r2_key`, project/collection visibility columns, publish status; no author/contact/provider columns | JSON stroke body only; headers exactly `content-type:application/json`, `cache-control:private, no-store`, `x-content-type-options:nosniff` | None |
| Collection links | `collection_links`: `id,url,label,position,created_at`; join collections only on `collection_id,project_id,kind`; **do not select `source`** | exactly `{links:[{id,url,label,position,createdAt}]}` | None |
| Ingest status | RAW collection selects only `id,expected_count,received_count`; manifest aggregate selects only `id,status,expected_count,count(assets.id),created_at`; no filenames, creator, asset keys, jobs, Dropbox/provider state | exactly `expectedCount,receivedCount,mismatch` | None |
| Checklist item | `project_subtasks`: `id,title,done,position,assignee_id,assignment_version,due_date`, eleven schedule columns, `schedule_version,created_by,created_at,updated_at`; assignee and creator joins each select only `user.id,name,role,active`; no raw user row | exactly `id,title,done,position,assignee:ExternalPersonDto|null,assignmentVersion,dueDate,schedule:ExternalScheduleDto,createdBy:ExternalPersonDto,createdAt,updatedAt` | None; raw `createdBy` ID is replaced by person object |
| Project comment | `project_comments`: `id,author_id,body,content_json,created_at,edited_at`; author join only `user.id,name,role,active`; mention labels are normalized only against the same scoped select that constructs `externalMentionableUserSchema` | exactly `id,author:ExternalPersonDto,body,content,createdAt,editedAt` | None |
| Comment read-marker | marker select only `last_read_comment_id,last_read_comment_created_at,updated_at`; latest select only `id,created_at`; unread aggregate only scoped comments | exactly `projectId,marker:null|{throughCommentId,throughCreatedAt,updatedAt},latest:null|{commentId,createdAt},unreadCount` | None |
| Collaboration summary / Team | project select only `id,street,stage_key`; members select exactly the Project-detail member join columns above | exactly `project:{id,street,stageKey},members:[ExternalParticipantDto plus assignedSubtaskCount]` | **Present only in `members[]`** |
| Project mentionable users | active user select only `id,name,role,active`; eligibility is current project membership OR approved active Admin collaborator, after visible-project scope; no `user.email` select | exactly `{users:[ExternalPersonDto]}` (maximum 20) | None |
| Notification list item | `notifications`: `id,user_id,project_id,type,title,body,read_at,created_at`; join sent ledger/outbox and current membership using the fail-closed predicate below; do not select email delivery/provider error fields or payload JSON into the response | exactly `id,projectId,type,title,body,readAt,createdAt` | None |
| Reserved Calendar range | visible project select uses summary columns but returns only `id,street,stage_key`; Deadline selects canonical schedule/version; checklist selects item/schedule/version plus assignee `id,name,role,active`; filter people are derived from visible events only | TB5C-owned seam: the field list is explicitly non-normative for TB4E; the endpoint must use the shared visible-project obligation above, while TB5C settles the final DTO and permissions | None |
| Reserved external export | Same explicit summary/detail, collection, asset, checklist, comment, participant selects as above; no alternate export query and no storage/provider columns | exactly `{schemaVersion:1,generatedAt,project:{all exact Project-detail keys except `cover.url` is regenerated},assets:[exact asset DTO],links:[exact link DTO],checklist:[exact checklist DTO],comments:[exact comment DTO]}` | **Present only in `project.members[]`** |

`agencyDisplayName` is exactly `COALESCE(agencies.name, projects.agency_name)` and
`agentDisplayName` is exactly `COALESCE(agents.name, projects.agent_name)`. A broken/null directory
join falls back to the stored project snapshot; if both are null the response is null. The query
must use `LEFT JOIN agencies ON projects.agency_id = agencies.id` and
`LEFT JOIN agents ON projects.agent_id = agents.id` while selecting only those two directory
`name` columns. `agencies.notes`, `agents.email`, and `agents.phone` never enter the SQL result set.

The annotation header row is a required behavior change: the current route returns
`cache-control: private, max-age=3600` and omits `x-content-type-options`
(`workers/app/src/routes/media.ts:108`). TB4E replaces that with the exact `private, no-store` and
`nosniff` headers above; this is not a restatement of current behavior.

### Strict outer response schemas and role-aware client adapters

Item schemas are insufficient at the HTTP boundary. Every success envelope reachable by an External
principal is a shared `.strict()` schema; optional means the key may be absent, never that arbitrary
siblings are accepted:

| Surface / method | Exact External success response |
|---|---|
| `GET /api/me` | `{user:{id,name,email,role:"external_editor",active:true,impersonatedBy:string|null,authorizationEpoch:number},capabilities:Capability[]}`; capabilities must equal the exact nine-item role grant |
| `GET\|PATCH /api/notification-preferences` | `{projectDeadlineReminderEmails:boolean}` |
| `GET /api/projects` | `{projects:ExternalProjectSummaryDto[]}` |
| `GET /api/projects/:id` | `ExternalProjectDetailDto` including `editedUploadAvailable` |
| `GET /api/projects/:id/assets` | `{assets:ExternalAssetDto[]}` |
| `GET /api/assets/:id/annotations` | `{annotations:ExternalAnnotationDto[]}` |
| annotation POST/PATCH; DELETE | item directly; `{ok:true}` |
| `GET /api/projects/:id/links` | `{links:ExternalCollectionLinkDto[]}` |
| `GET /api/projects/:id/ingest-status` | `ExternalIngestStatusDto` directly |
| `GET /api/projects/:id/collaboration-summary` | `{project:{id,street,stageKey},members:ExternalParticipantDto[]}` |
| `GET /api/projects/:id/subtasks` | `{subtasks:ExternalChecklistItemDto[]}` |
| checklist POST/PATCH; reorder; DELETE | item directly; `{position:number}`; `{ok:true}` respectively |
| `GET /api/projects/:id/comments` | `{project:{id,street},comments:ExternalCommentDto[],nextCursor?:string}`; the cursor is opaque, max 2048 characters, and absent at end |
| comment POST/PATCH; DELETE | item directly; `{ok:true}` respectively |
| comment read-marker GET/PATCH | `ExternalCommentReadStateDto` directly |
| `GET /api/mentionable-users?projectId=...` | `{users:ExternalPersonDto[]}` with max 20 |
| `GET /api/notifications` | `{notifications:ExternalNotificationListItemDto[],unreadCount:number}` |
| notification mark-read/delete/read-all | `{ok:true}` |
| asset review mutation | `{ok:true}`; withheld selection mutations never have an External success shape |
| External upload create/part/complete/abort | the four exact schemas in the upload protocol below |
| `GET /api/project-access-snapshot` | exact `ProjectAccessSnapshot` below |
| reserved Calendar / export | `ExternalCalendarRangeDto` / `ExternalProjectExportDto` directly |
| media/annotation bytes | binary/JSON body plus only the exact headers in the media matrix; no JSON envelope |

Mutation conflict/error arms are also strict discriminated schemas for the codes named in this plan;
they cannot echo an internal row or Zod input. The comment-list schema intentionally includes all
three live client dependencies—`project`, `comments`, and optional `nextCursor`—rather than validating
only each comment.

Add `apps/web/src/lib/external-api-response.ts`. It exports one exhaustive
`EXTERNAL_CLIENT_RESPONSE_DECODERS` record keyed by `ExternalApiSurface` and role-aware helpers
`decodeProjectListResponse`, `decodeProjectDetailResponse`, `decodeAssetListResponse`,
`decodeAnnotationResponse`, `decodeCollectionLinksResponse`, `decodeIngestStatusResponse`,
`decodeCollaborationResponse`, `decodeChecklistResponse`, `decodeCommentResponse`,
`decodeReadMarkerResponse`, `decodeMentionableResponse`, `decodeNotificationResponse`,
`decodeReviewMutationResponse`, `decodeExternalUploadResponse`, `decodeAccessSnapshotResponse`,
`decodeMeResponse`, and `decodeNotificationPreferenceResponse`.
For `external_editor`, each helper calls the matching shared strict schema before data reaches
QueryClient/local state; for other roles it calls the existing internal decoder/adapter. No `as
ProjectDetail`, shared loose generic, or “try External then fall back to internal” path is allowed.
The fetch wrapper requires a surface key, so a new External-reachable route fails the exhaustive
client-decoder test until both outer schema and adapter exist.

`GET /api/projects/:id` is the authoritative upload-gate carrier. The server computes
`editedUploadAvailable = raw_folder_path IS NOT NULL OR raw_folder_link IS NOT NULL` in SQL. The
External query selects only that boolean expression, never either Dropbox value. Internal detail may
continue returning its Admin edit fields, but also returns the same boolean. `ProjectWorkspace`
removes `Boolean(project.rawFolderPath || project.rawFolderLink)` and gates edited upload solely on
`project.editedUploadAvailable` for every role; Create/Edit Project retain their capability-gated
internal Dropbox controls. The upload create command recomputes the same expression server-side, so
the boolean is UX state, not mutation authorization.

### Project summary/detail allowed fields

The matrix above is exhaustive: the external project summary and detail contain exactly the keys
listed there and no “fields necessary” extension point. Database snapshot fields are renamed to
`agencyDisplayName`/`agentDisplayName` so their contact-free meaning is explicit. The internal DTO
may preserve current field names for compatibility; it cannot be passed to an external constructor.

The external envelope must not contain, even as `null`:

- `projects.notes`, `agentEmail`, `agentPhone`, any client email/phone;
- `invoiceAmount`, `paymentStatus`, billing/invoice/payment objects;
- `orderNo`, `orderId`, internal bookkeeping or Tonomo identifiers;
- `agencyId`, `agentId`, `agencies.notes`, directory records beyond allowed display names;
- `rawFolderPath`, `rawFolderLink`, Dropbox claim/mapping/path/link data;
- `priority`, `boardPosition`, prioritization/Admin coordination metadata;
- `archivedBy`, Admin audit/user data, integration/provider credential/status/error/diagnostic data;
- R2 keys, multipart IDs, job IDs, provider source paths, webhook payloads, or unrelated users/projects,
  with no exception for upload: the isolated handshake returns only an opaque token and same-origin
  Quincy proxy URLs; no raw key, provider hostname, or provider upload ID/ETag is ever returned.

The absence contract is structural: forbidden keys are not present, rather than present with null or
redacted text. Tests use sentinel values in every excluded column and assert recursively that none
appears by key or value.

The External designation is also required when an internal viewer reads an External-authored
comment. Extend the existing internal web `Comment.author` DTO at
`apps/web/src/lib/project-comments.ts:33-36` to exactly `{id,name,roleLabel,isExternal}`. Extend the
app `CommentRow` author select with `user.role`, and populate `roleLabel` plus
`isExternal: authorRole === 'external_editor'` in `serializeProjectComment()`
(`workers/app/src/lib/project-comments.ts:449-457`). Both internal and External comment adapters
consume that designation; it is not inferred from the viewer role or from current project members.

### `productionNotes`

- Add nullable `projects.productionNotes` mapped to `production_notes TEXT`.
- Add it to internal create/edit validation, atomic insert/update SQL, audit changed-field metadata,
  and `project.details.changed` safe field names. Do not include note text itself in broad activity
  payload or notification copy.
- Add a minimal existing-form control labelled clearly as production notes visible to External
  editors. Only users with `createProject`/`editProject` can write it; External Editors see it
  read-only in the existing project workspace.
- Never copy, migrate, fall back to, or coalesce from `projects.notes`. A null production note stays
  null even when the internal note is populated.

### Media/workflow projection

- External asset DTOs contain exactly the asset-matrix keys. They contain no R2/Dropbox/provider key,
  provider job ID, diagnostic, webhook field, or transform-source URL.
- `originalFilename` is allowed only as the name of media already authorized on the assigned project;
  broad notification/activity payloads continue to exclude filenames.
- Annotation JSON returns the closed `ExternalPersonDto`, scope, note, timestamps, and
  `hasMarkup`/authorized markup URL. It never returns `strokeR2Key` or `thumbnailR2Key` externally.
- Collection-link output exposes the authorized deliverable URL/label/order, not provider `source`
  or diagnostics. Dropbox links are never treated as deliverables merely because they are URLs.
- Edited upload uses the opaque session protocol below; no completion response exposes a background
  job, storage, mirror, or provider diagnostic object.

### Revocation-safe External media delivery

The cold Image Transform redirect remains an internal-role performance path, but it is never an
External Editor authorization mechanism. On every request, `/media/asset/:assetId/:variant` first
reloads the session/current role and uses the single scoped asset join. If that role is
`external_editor`:

- `original` and a ready durable `web|thumb` rendition stream from R2 only after the same-request
  project/collection capability, publish-state, and current-asset check, with `Cache-Control:
  private, no-store`;
- a missing durable `web|thumb` rendition returns `409` with exactly
  `{error:"Rendition is still processing",code:"rendition_processing",renditionStatus:"processing"}`;
  this branch never calls `issueTransformSource`, redirects, or exposes a source/storage URL;
- `/media/annotation/:annotationId` performs the same session/current-scope check on every request
  and returns markup with `Cache-Control: private, no-store`;
- a valid session with a zero-row scoped media/annotation join returns the same constant `403
  {error:"Media access denied"}` for invisible and nonexistent identifiers; a missing/revoked
  session returns the parent `401` before any resource query.

For Admin, Photographer, and internal Editor, the existing durable-or-cold-transform behavior may
remain, but `/__transform-source` becomes a revocable signed bearer. Bump
`TRANSFORM_SOURCE_VERSION`; include the issuing principal ID and that principal's
`authorization_epoch` in `payload()` alongside version/cacheVersion/expiry/key; and carry both as
canonical query fields covered by the HMAC. The new canonical query-name set is exactly
`ae,exp,p,sig,v` (`p` is principal ID and `ae` is the base-10 epoch); duplicate, extra, malformed,
negative, or unsafe-integer fields return the uniform 404. `signTransformSource()` and issuance
reject a missing or invalid principal/epoch exactly as they reject a mismatched `cacheVersion`
(`packages/shared/src/transform-source.ts:32-46,55-69`). On the root, sessionless
`/__transform-source/*` route (`workers/app/src/index.ts:67`), the app-side wrapper
`portal/workers/app/src/lib/transform-source.ts:10` performs one primary-key read of that issuing
user and fails closed unless the row exists, is active, is not `external_editor`, and its current
epoch equals the signed epoch. The shared `verifyTransformSource()` only verifies the HMAC over
the principal ID and epoch parameters; it has no D1 dependency. This mirrors the existing
`cacheVersion` equality check; the D1 read is intentionally paid only on the cold/slow source-fetch
path (`workers/app/src/routes/media.ts:63-67`). The External branch still must neither issue nor serialize
this URL/signature.

Set `TRANSFORM_SOURCE_TTL_SECONDS = 120`. This is the maximum source-fetch authorization window, not
a promise about the transformed edge object's lifetime. The trade-off is explicit: if an old `<img
src>` later gets an edge miss after that 120-second window, the source returns 404 and the transform
cannot be rebuilt; the client must request `/media/asset/...` again to obtain a fresh URL. Tests use
the 30-second clock-skew rule already present and prove expiry/future-bound checks with the new TTL.

Keep a full-zone purge because it is the sole control for the residual already-cached-edge-HIT window
after conversion: the repository establishes only that the Images cache lasts **at least** one hour
(`packages/shared/src/transform-source.ts:5-8`), not an upper bound,
and an existing edge HIT does not call the revocation check. The ordinary one-batch role-change
command commits conversion and enqueues an idempotent fire-and-forget purge job under its winner
marker. The role write does not wait for purge success and has no conversion state machine. The
background-owned job retries with bounded backoff and alerts internally on exhaustion; it carries
only the winner audit/user/epoch IDs. After a purge, replay of a captured old URL produces an edge
MISS, reaches the epoch check, returns the uniform 404 before R2, and cannot repopulate the cache.
Opus must scrutinize the residual interval in which a pre-existing edge HIT can survive between the
winning role commit and purge completion; the revocable signature prevents replay-based re-caching,
while the purge removes already cached output. On bounded retry exhaustion, the job records the
retry count and deadline, freezes External Editor provisioning/conversion, and requires a manual
Cloudflare zone purge before provisioning is unfrozen; the runbook records the operator evidence.

Automated/local tests obtain the ordinary `/media/asset/...` and `/media/annotation/...` URLs as an
assigned External Editor, fetch successfully, remove the final membership, and reuse the identical
URLs: both return 403 with no R2 read. They repeat with restored membership followed by role-change
session revocation/deactivation: both return 401 with no R2 read. Tests also assert every External
JSON/header/redirect contains none of `/cdn-cgi/image`, `/__transform-source`, `sig`, `exp`, R2 key,
or `Location`. The URL reused in the revocation test is the authenticated Quincy `/media/...` URL,
not an internal-role transform bearer that External Editors are forbidden to receive.

### Opaque External edited-upload session

Choose a Quincy-owned multipart proxy implemented exclusively through the `env.MEDIA` R2 binding.
Raw/internal legacy uploads retain their current presigned S3 protocol, but External transport never
imports or calls `r2s3.ts`, `AwsClient`, `createMultipartPresign`, `endpoint`, or an S3 HTTP fetch;
that helper is credential-dependent and deliberately returns no multipart presign in dev
(`workers/app/src/lib/r2s3.ts:9-12,34-40`).
All External network requests remain same-origin Quincy URLs and require both the better-auth session
and a 256-bit random base64url session token; D1 stores only `SHA-256(token)`. The app uses
`R2Bucket.createMultipartUpload(key)`, persists the returned internal `uploadId`, and on later
requests reconstructs the handle with `env.MEDIA.resumeMultipartUpload(key, uploadId)`. The finite
lease/abort recovery follows the landed document-upload precedent
(`routes/collections.ts:76-91,430-480`). The pinned Worker types define this complete API and the
exact `{partNumber,etag}` result at
`node_modules/@cloudflare/workers-types/index.d.ts:2481-2503`.
No provider URL, hostname, account, bucket, signed headers/query, completion XML, or outbound
`Content-Length`/SigV4 streaming decision exists in this branch.

Creation is exactly `POST /api/external-uploads` with:

```ts
type ExternalEditedUploadCreateRequest = {
  projectId: string;       // UUID
  collection: "edited";   // required literal, no default
  filename: string;        // accepted JPEG, 1..500 safe display chars
  bytes: number;           // integer 1..5 GiB
};
type ExternalEditedUploadCreateResponse = {
  sessionToken: string; assetId: string; expiresAt: string;
  parts: Array<{
    partNumber: number;
    uploadUrl: `/api/external-uploads/${string}/parts/${number}`;
    expectedBytes: number;
  }>;
  completeUrl: `/api/external-uploads/${string}/complete`;
  abortUrl: `/api/external-uploads/${string}`;
};
```

Creation resolves visible non-archived project + stored edited collection in one query, checks
`uploadEdited`, `editedUploadState='available'`, exact Editor membership cycle, active
`external_editor` role and current `authorization_epoch`, then creates the R2 multipart upload.
Before creating R2 state, it counts the principal's current `status='open'` sessions and rejects
the request with `409 edited_upload_unavailable` when the principal already holds three open
sessions. The `external_edited_upload_sessions_principal_status_idx` on
`(created_by,status,expires_at)` exists to support this per-principal cap query (and expiry
housekeeping); it is not an unbounded-session convenience index. It
inserts the session plus one expected-part row per part in one D1 batch. The session holds the
principal/project/collection/cycle/epoch/asset/filename/bytes, internal R2 key and binding upload ID,
token hash, expiry, and `status='open'`; each part row holds its expected byte count. The response
is constructed only from the token and same-origin route templates above. Part geometry is fixed at
64 MiB (`67,108,864` bytes) except the final remainder (`1..67,108,864`), so a 5 GiB maximum upload
has at most 80 requests; creation rejects any geometry outside those bounds. Opus/build preflight
must confirm the deployed Workers request-body limit remains above 64 MiB or lower this reviewed
constant and recompute the maximum count before implementation—not buffer or bypass the proxy.

Each part upload is exactly
`PUT /api/external-uploads/:sessionToken/parts/:partNumber`. Its request body is raw bytes with
`Content-Type: application/octet-stream`, required decimal `Content-Length` equal to that part's
stored `expected_bytes`. The exact success body
is `{partNumber:number,state:"accepted",receivedBytes:number}`; it never returns the R2 ETag.
On every part, the app hashes the token, reloads the current session user/role/active/epoch, exact
membership cycle, project/archive state, collection, session `open` state/expiry and part row, and
requires `uploadEdited`. Token possession without the matching signed-in principal is a uniform 404.
Missing/invalid membership, epoch, role, project, session, or token is the same 404 and performs no
R2 request. Responses set `Referrer-Policy: no-referrer`; request/audit/error logs replace the token
path segment with `[external-upload-token]` and may record only the internal session ID.

The Worker does not call `arrayBuffer()` or retain a whole part. After the header bound passes, it
passes `c.req.raw.body` directly to
`env.MEDIA.resumeMultipartUpload(r2Key,uploadId).uploadPart(partNumber, body)`. The request-level
`Content-Length` is only an early rejection bound. `received_bytes` is counted server-side as
the stream is consumed, not asserted from that header. The end-to-end integrity control is the
final R2 `HEAD` size comparison (not the client's `Content-Length`). A non-decodable or
non-JPEG asset must never leave `rendition_processing`; the rendition pipeline adds the
decode/type gate before ready publication. Fixed `image/jpeg` content type plus
`X-Content-Type-Options: nosniff` is the XSS control. The returned
`R2UploadedPart {partNumber,etag}` is stored only in the guarded part row and never returned. A
per-part `pending→uploading` lease prevents concurrent proxy writers; a stale lease is recoverable,
and an already uploaded part returns the same success only when its stored expected/received lengths
match, otherwise it is re-uploaded under a new winning lease.
The 64 MiB part remains below the stated 100 MB Free/Pro request-body limit and is tested through
Miniflare without buffering.

Completion and abort are exactly:

```ts
type ExternalEditedCompleteRequest = Record<string, never>; // exact JSON {}
type ExternalEditedCompleteResponse = {
  asset: ExternalAssetDto;
  workflow: { state: "processing" | "ready" };
};
type ExternalEditedPartResponse = {
  partNumber: number; state: "accepted"; receivedBytes: number;
};
type ExternalEditedAbortResponse = { state: "aborted" };
type ExternalEditedUploadError =
  | { error: "Invalid edited upload"; code: "invalid_edited_upload" }
  | { error: "Edited upload not found"; code: "edited_upload_not_found" }
  | { error: "Edited upload is unavailable"; code: "edited_upload_unavailable" }
  | { error: "Upload service is unavailable"; code: "upload_service_unavailable" };
```

`POST /api/external-uploads/:sessionToken/complete` accepts no part list or provider identity. It
repeats the complete token/principal/role/epoch/membership/project/collection checks and requires all
part rows `uploaded` with contiguous numbers and exact total bytes. It claims
`open→completing` with a random completion lease token and
`completion_lease_expires_at=now+5 minutes`. While that lease is live, a second complete returns
`409 edited_upload_unavailable` plus integer `Retry-After: ceil((leaseExpiry-now)/1000)`, bounded
`1..300`; `completed` returns the identical prior 200 body.

After a stale `completing` lease, a retry may steal it under the old-token/old-expiry fence, but must
**HEAD the server-held final R2 key before recompletion**. If an exact JPEG object already exists
with stored byte count/content type, binding completion succeeded earlier and the command skips it.
If no final object exists, it loads the complete ordered `R2UploadedPart[]` exclusively from the
stored part rows and calls
`env.MEDIA.resumeMultipartUpload(r2Key,uploadId).complete(parts)`. It then HEAD-verifies again and
runs one lease-token-fenced D1 batch
that inserts the media row with the predetermined asset ID, inserts audit/activity/outbox state,
reconciles the collection, and changes `completing→completed`. A crash between binding completion
and this D1 batch is therefore recoverable without duplicate media; a duplicate predetermined asset
ID plus a matching completed session is idempotent, while any mismatched asset is a hard 409 and
internal alert.

`DELETE /api/external-uploads/:sessionToken` repeats authorization. `open→aborting` calls
`env.MEDIA.resumeMultipartUpload(r2Key,uploadId).abort()`, then commits `aborting→aborted`. A stale
`completing` session must
first win a recovery lease and HEAD the final key: if the final object exists it follows completion
recovery and abort returns 409 `completed`; only a missing final object may change to `aborting` and
abort the multipart. `aborted` or `expired` returns `200 {state:"aborted"}` on every retry; a live
completion lease or `completed` returns 409. A binding already-aborted result after the
missing-final-object check is success; transient R2 failure leaves `aborting` for the same idempotent
retry/sweeper.

Creation failure immediately best-effort aborts an R2 upload created before the D1 INSERT. The R2
binding has no multipart-enumeration surface, so this plan does not invent an orphan-list scan. Build
preflight must verify/configure the bucket lifecycle rule to abort incomplete multipart uploads after
**7 days**, with recorded configuration evidence. The crash-only create-before-D1 orphan is a zero-part,
unreferenceable, uncompletable storage/billing-hygiene item—not a privacy item—and is reclaimed by
that rule. Miniflare cannot exercise a bucket lifecycle rule, so lifecycle reclamation is a preflight
configuration check, not an automated test assertion. The D1
sweep claims expired `open` sessions as `aborting`, resumes their stored upload ID through the
binding, aborts, and commits `expired`; it retries stale
`aborting` rows. It never expires a live `completing` lease; stale completion follows the HEAD-first
recovery path above. A crash after the D1 INSERT but before the create response leaves a tracked
`open` session which expires through this same sweep; the undisclosed token cannot be reconstructed.
Completed media/R2 objects remain immutable. Incomplete multipart parts are not
completed media, never create an `assets` row, and never appear in project/media/activity DTOs.
TB4E does not delete terminal D1 session/part rows; a later retention policy requires its own
reviewed migration/cleanup plan and must preserve completion/audit provenance.

Status/error mapping is exact: unauthenticated is bounded 401; malformed create/body/part headers or
geometry is `400 invalid_edited_upload`; unknown token and real-but-unowned/invisible/epoch-stale
session are both `404 edited_upload_not_found`; live lease, expired/aborted/completed conflict,
binding/HEAD/size mismatch is `409 edited_upload_unavailable`; binding/R2 failure is `503
upload_service_unavailable`. No error includes raw R2 text. Successful create is 201, part and
abort are 200, and completion is 200. The registered-route manifest and browser-network tests assert
every actual External request hostname equals `APP_ORIGIN` and every path matches only the four
Quincy routes above; no redirect or provider topology may appear in URL, body, or headers.

### Collaboration/people projection

- Collaboration summary, Team, comments, mentions, and checklist assignees derive people only from
  authorized current project memberships plus the already approved active Admin collaborator
  candidates.
- Participant email is allowed only in the assigned-project Team/context DTO. Mention search may
  return only the minimum required person fields and never becomes a global email directory.
- Inactive assigned External Editors remain visible as `Inactive · External editor` and removable;
  they are excluded from new assignment and assignee candidate lists.
- Comment/checklist serializers attach a bounded role label/External designation to an authorized
  author/assignee. They do not attach global Admin fields or unrelated memberships.
- Comment edit/delete stays author-only; Admin impersonation acts as the impersonated user under the
  shipped, audited exception.

### Activity, notification, Calendar, and export projection

- Activity and notification projection starts from the registry decision, validates the strict safe
  payload, reauthorizes the project/membership cycle, then constructs safe copy. It never redacts a
  forbidden event into a visible placeholder.
- The notification list applies the same predicate to rows and unread count. Read/delete/read-all
  can mutate only rows visible to that principal; an old hidden row is indistinguishable from absent.
- The Calendar projector accepts only a `VisibleProjectContext` and the approved project/checklist
  schedule DTOs. It exists as a tested seam or documented interface only; TB4E creates no Calendar
  route/data fetch.
- The export projector is fail-closed for External Editors and can emit only the same external-safe
  fields if a later approved export exists. Current final/download capabilities remain absent.
- A regression gate enumerates every External-reachable route and asserts that it calls the shared
  scope and correct projection family. Every later tracer bullet touching an External-reachable DTO
  must rerun this gate.

## Assignment and membership lifecycle

### Eligibility and contextual UI

- Editor-slot candidates are active internal Editor, active External Editor, and active Admin.
- Photographer-slot candidates remain active Photographer, active internal Editor, and active Admin.
- Create Project and Workspace Team use the same server candidate endpoint and shared role arrays;
  neither duplicates role logic in React.
- External Editors cannot call the global candidate endpoint themselves. Their mention/assignee
  discovery is project-scoped.
- Candidate queries and atomic create/add/assignee commands recheck current role and active state.
  An existing inactive member stays in authorized Admin Team context with status/role and cleanup
  count but cannot be newly selected.

### Final External Editor membership removal

The existing atomic `removeProjectMemberCycle` remains the sole command. Extend its strict DELETE
body with `confirmAccessLoss:boolean`; the first request sends `false`. Before an internal user
confirms a final External Editor removal, the command returns the existing confirmation code even
when the cleanup count is zero:

```json
{
  "code": "subtask_assignment_confirmation_required",
  "assignmentCount": 3,
  "accessWillBeLost": true,
  "message": "Project access will be lost immediately. 3 checklist assignments will be cleared."
}
```

`accessWillBeLost` is true only when removing the target External Editor's final membership that
currently authorizes the project. The confirmation UI always shows the immediate-access-loss warning
for that case, including a zero cleanup count; it never hides the warning because no checklist item
is assigned. The retry sends `confirmAccessLoss:true`, the exact `membershipCycle`, and the existing
`clearSubtaskAssignments`/`confirmedAssignmentCount` fields. A nonzero cleanup count requires
`clearSubtaskAssignments:true`; zero uses false/zero. The command rechecks membership finality and
the count inside its serialized batch, returning the same `422` with fresh values if either changed.

On confirmed removal, one D1 batch must:

1. conditionally delete the exact membership-cycle row under the pre-read fence;
2. clear checklist assignees only where no remaining compatible project role exists, using TB4D's
   current final-role rule;
3. insert the membership-removal audit row immediately after the winning DELETE using
   `INSERT ... SELECT ... WHERE changes()=1`; this audit ID is the sole winner marker;
4. gate checklist cleanup, activity, ledger suppression, outbox suppression, and project timestamp
   with `EXISTS (SELECT 1 FROM audit_log WHERE id=:winnerAuditId)`;
5. return the authoritative removed cycle, cleanup count, access-loss fact, and committed publication
   IDs only if the winner batch committed.

The membership suppression statements are exact:

```sql
UPDATE notification_delivery_ledger AS l
SET status='suppressed', last_error_code='membership_removed',
    last_error='Recipient project membership ended.', updated_at=:now
WHERE l.recipient_id=:userId AND l.status='pending'
  AND EXISTS (SELECT 1 FROM audit_log WHERE id=:winnerAuditId)
  AND EXISTS (
    SELECT 1 FROM notification_outbox o
    WHERE o.id=l.outbox_id AND o.project_id=:projectId
      AND o.recipient_id=:userId
      AND (
        (o.event_type IN ('project.activity.broad','project.external_safe.direct',
             'project.deadline.reminder','project.subtask.assigned','project.subtask.due_today')
          AND o.recipient_membership_cycle_id=:membershipCycle
          AND json_valid(o.payload_json)
          AND json_extract(o.payload_json,'$.authorizationAtOccurrence.membershipCycle')=:membershipCycle)
        OR (o.event_type='project.assignment.created' AND o.source_key=:membershipCycle
          AND json_valid(o.payload_json)
          AND json_extract(o.payload_json,'$.assignment.membershipCycle')=:membershipCycle)
        OR (o.event_type='project.comment.mentioned' AND json_valid(o.payload_json)
          AND EXISTS (SELECT 1
            FROM json_each(o.payload_json,'$.authorizationAtOccurrence.membershipIds') AS cycle
            WHERE cycle.value=:membershipCycle))
      )
  );

UPDATE notification_outbox AS o
SET status='suppressed', last_error_code='membership_removed',
    last_error='Recipient project membership ended.',
    completed_at=:now, updated_at=:now
WHERE o.project_id=:projectId AND o.recipient_id=:userId
  AND o.status IN ('pending','queued')
  AND EXISTS (SELECT 1 FROM audit_log WHERE id=:winnerAuditId)
  AND (
    (o.event_type IN ('project.activity.broad','project.external_safe.direct',
         'project.deadline.reminder','project.subtask.assigned','project.subtask.due_today')
      AND o.recipient_membership_cycle_id=:membershipCycle
      AND json_valid(o.payload_json)
      AND json_extract(o.payload_json,'$.authorizationAtOccurrence.membershipCycle')=:membershipCycle)
    OR (o.event_type='project.assignment.created' AND o.source_key=:membershipCycle
      AND json_valid(o.payload_json)
      AND json_extract(o.payload_json,'$.assignment.membershipCycle')=:membershipCycle)
    OR (o.event_type='project.comment.mentioned' AND json_valid(o.payload_json)
      AND EXISTS (SELECT 1
        FROM json_each(o.payload_json,'$.authorizationAtOccurrence.membershipIds') AS cycle
        WHERE cycle.value=:membershipCycle))
  )
  AND NOT EXISTS (
    SELECT 1 FROM notification_delivery_ledger l
    WHERE l.outbox_id=o.id AND l.status IN ('pending','processing')
  );
```

The parenthesized cycle fragment above is byte-identical in both statements; it is the exact SQL,
not pseudo-SQL or a SQLite user function. Its arms are: broad/direct/subtask/Deadline outbox cycle
column **and** strict payload cycle equal the removed ID; assignment `source_key` and payload
assignment cycle equal it; comment mention payload occurrence `membershipIds` contains it. Because
this command runs only on final External access
loss, all matching project content is suppressed; unrelated projects/cycles are untouched.

The command does not take ownership of an outbox/ledger already `processing`: changing it would
break the lease/status CHECK and race the consumer. Every consumer admission arm rechecks the exact
cycle/current assignment immediately in its lease-fenced D1 delivery batch. If removal serializes
first, that batch changes its `pending|processing` ledger to `suppressed` with
`reauthorization_suppressed`/`membership_removed`, inserts no notification/email, and completes the
leased outbox after no pending/processing channels remain. If delivery serializes first, its already
committed `sent` row is delivered history and is not erased. No partial delete/cleanup/suppression
result is accepted. Removal does not delete the user, delivered activity, media, or R2 objects and
does not revoke the user's global sessions.

## Notification and activity external policy

### Registry type and payload decisions

`RegistryEntry.externalProjection` is removed because it was only a type-level `"pending"` placeholder,
not a per-entry policy or authority. Put the actual External policy in the separate, exhaustive
`external-project-policy.ts` module:

```ts
type ExternalProjectionPolicy =
  | { decision: "allowed"; projector: ExternalProjectActivityProjector }
  | { decision: "suppressed"; reason: ExternalSuppressionReason };
```

There is no default in `EXTERNAL_PROJECT_ACTIVITY_POLICY`; adding a future activity type fails
TypeScript/tests until its External policy is explicit. `project-activity.ts` does not import
projector types, so there is no circular dependency. `audience` is derived in
`external-project-policy.ts` from that separate policy: allowed project activity types are
internal-and-external only when their safe projector succeeds; suppressed types remain internal-only.

Current exact classification:

| Registry type | External decision | Projection rule |
|---|---|---|
| `project.team.member_added` | allowed | safe member name/project role/External designation only |
| `project.team.member_removed` | allowed | same safe team summary; removed recipient does not receive after cycle loss |
| `project.deadline.schedule_changed` | allowed | bounded schedule-change summary; no internal note/contact |
| `project.priority.changed` | suppressed | prioritization is explicitly withheld |
| `project.details.changed` | allowed conditionally | intersect changed fields with address, display names, shoot date/time, services/deliverables, `productionNotes`; suppress if intersection is empty; values/note text are not copied |
| `project.archived` | suppressed | archived projects are not ordinary External surfaces |
| `project.restored` | suppressed | no archive/history placeholder; restored assignment becomes visible through normal freshness |
| checklist item create/update/delete | allowed | bounded title/state/assignee-safe payload already approved |
| `project.checklist.schedule_changed` | allowed | TB4D bounded checklist/schedule summary |
| comment create/edit/delete | allowed | bounded project-comment event; broad copy has no comment excerpt |
| video-link add/change/reorder/remove | allowed | generic visible deliverable summary, no arbitrary URL/provider source in notification payload |
| document completed | allowed | generic visible deliverable-ready summary, no storage/provider identifiers |
| `project.workflow.manual_edited_ready` | allowed | generic edited-media-ready summary |
| `project.collection.raw_sync_completed` | allowed | generic RAW-ready/sync summary, no Dropbox/provider claim data |
| reserved `project.stage.changed` | allowed when TB5A activates it | role-safe Stage summary; TB4E does not activate or grant Stage movement |
| reserved workflow raw-ready/sent-to-editing/edited-ready/delivered | allowed when owner activates | bounded visible workflow summary; TB4E does not activate them |

No current registry types represent contact, billing/order, agency note, Dropbox/provider/Admin, or
pipeline changes. If such a type is later added it defaults to **compile failure**, not external
delivery; its reviewed policy must be `suppressed` unless a higher authority explicitly approves a
bounded external payload.

### Complete legacy `NotificationType` classification

`EXTERNAL_LEGACY_NOTIFICATION_POLICY` is exhaustive over the shared thirteen-value union. The
generic direct emitter reloads each recipient role and removes every `external_editor` before any
INSERT/email; allowed External events enter only the durable path named here:

| Legacy `NotificationType` | External decision | Durable provenance/channels |
|---|---|---|
| `raw_ready` | allowed visible workflow | `project.external_safe.direct`; exact current Editor membership cycle; in-app only |
| `edited_landed` | allowed visible workflow | same; in-app only |
| `sent_to_editing` | allowed visible workflow | same; in-app only |
| `autohdr_stalled` | **suppressed** | provider/diagnostic event; no outbox/ledger/row/email |
| `delivered` | allowed visible workflow | `project.external_safe.direct`; exact cycle; in-app only |
| `comment_added` | allowed annotation/review feedback | `project.external_safe.direct`; exact cycle; in-app only; bounded generic copy, no note/filename |
| `assigned_to_project` | allowed targeted assignment | existing `project.assignment.created`; source key/payload exact membership cycle; in-app + email |
| `mentioned` | allowed only for project comment mention | existing `project.comment.mentioned`; exact mention mapping plus occurrence/current membership snapshot; in-app + email. Notice Board/unlinked mention is suppressed |
| `subtask_assigned` | allowed targeted assignment | new `project.subtask.assigned`; exact subtask ID, assignee ID, assignment version, project, membership cycle; in-app + email |
| `subtask_due_today` | allowed targeted due alert | new `project.subtask.due_today`; exact subtask ID, assignee ID, assignment version, canonical due value, claim token/time, project, membership cycle; in-app + email |
| `project_deadline_reminder` | allowed targeted Deadline | existing `project.deadline.reminder`; exact occurrence/version/membership cycle and personal preference; in-app + preference-controlled email |
| `project_activity` | allowed only as registry-rendered broad output | existing `project.activity.broad`; explicit registry policy/current cycle; in-app only; generic direct emitter rejects |
| `project_collaboration_activity` | allowed only as registry-rendered broad output | same; in-app only; generic direct emitter rejects |

`project.external_safe.direct` payload is strict and contains exactly
`schemaVersion,event:{type,sourceKey,recipientId},authorizationAtOccurrence:{kind:'project_editor_membership',membershipCycle,startedAt},legacy:{type,projectId,sourceId}`.
`sourceId` is the immutable producer fact (asset/claim/transition/annotation ID), never a provider
path or arbitrary copy. Each app/background producer supplies an idempotent source key; a producer
without one is not externally deliverable.

`project.subtask.assigned` payload contains exactly
`schemaVersion,event,authorizationAtOccurrence,assignment:{projectId,subtaskId,assigneeId,assignmentVersion}`.
Delivery requires the current subtask row to match all four fields and the exact membership cycle.
`project.subtask.due_today` adds exactly `dueDate,claimAt`; delivery requires the row still assigned,
incomplete, with the same assignment version/due value and claimed reminder timestamp. These paths
replace the current External direct `notifySubtaskAssignee`/due-today call; they do not coexist with
it. The internal direct recipient set continues to exclude External users.

For **every** External path, `externalNotificationChannels()` is the sole channel authority.
Registry/direct broad events return `['in_app']`; assignment/mention return `['in_app','email']`;
Deadline returns in-app plus email only when its existing personal preference permits it. No other
legacy `EMAIL_ENABLED_EVENTS` membership can cause External email.

`externalNotificationCopy()` is also a closed allow-list, never an internal renderer followed by
redaction. It returns the following exact title/body literals; project address, participant name,
checklist title, comment/annotation text, filename, URL, Stage detail, and provider/error text are
never interpolated:

| Allowed External event | Exact `title` | Exact `body` |
|---|---|---|
| `raw_ready` / RAW-sync registry event | `RAW media ready` | `RAW media is ready for review.` |
| `edited_landed` / manual-edited/document/video deliverable event | `Edited media updated` | `Edited project media was updated.` |
| `sent_to_editing` | `Editing workflow updated` | `The project was sent to editing.` |
| `delivered` | `Project delivered` | `The assigned project was delivered.` |
| `comment_added` | `New annotation feedback` | `Annotation feedback was added to assigned media.` |
| project assignment | `Project assigned` | `You were assigned to a project.` |
| project-comment mention | `You were mentioned` | `You were mentioned in a project comment.` |
| checklist assignment | `Checklist item assigned` | `A checklist item was assigned to you.` |
| checklist due today | `Checklist item due today` | `An assigned checklist item is due today.` |
| Deadline reminder | `Project deadline reminder` | `An assigned project deadline is approaching.` |
| team add/remove | `Project team updated` | `The assigned project team was updated.` |
| safe project details | `Project details updated` | `External-visible project details were updated.` |
| checklist create/update/delete/reorder/schedule | `Project checklist updated` | `The assigned project checklist was updated.` |
| project comment create/edit/delete | `Project discussion updated` | `The assigned project discussion was updated.` |
| future Stage event | `Project stage updated` | `The assigned project stage was updated.` |

Every allowed type maps to exactly one row above in an exhaustive `Record`; suppressed and unknown
types have no copy. Tests compare the literal output and prove all payload sentinel strings are
ignored. The notification list may use its authorized `projectId` for navigation, but it does not
decorate copy by joining the project, Agency, Agent, or user directory.

### One fail-closed External notification-row predicate

Add `workers/app/src/lib/external-notification-visibility.ts` exporting one SQL fragment builder
`externalVisibleNotificationWhere(principalId)`. All five notification operations—list page, unread
count, mark-read, delete, and mark-all-read—compose this **identical** predicate; no route maintains
its own type list or looser mutation filter.

For an External principal the predicate requires all of:

```text
n.user_id = principalId
AND n.project_id IS NOT NULL
AND EXISTS sent notification_delivery_ledger l
AND EXISTS matching notification_outbox o
AND l.notification_id = n.id
AND l.recipient_id = principalId
AND l.channel = 'in_app' AND l.status = 'sent'
AND o.id = l.outbox_id AND o.recipient_id = principalId AND o.project_id = n.project_id
AND EXISTS active user principal with role='external_editor'
    and o.recipient_authorization_epoch=user.authorization_epoch
AND EXISTS current project_members pm
    where pm.project_id=n.project_id and pm.user_id=principalId and pm.role_on_project='editor'
AND projects.archived_at IS NULL
AND one exact event-provenance arm below is true
```

Exact event arms:

- `project.activity.broad` and `project.external_safe.direct`:
  `o.recipient_membership_cycle_id=pm.id`, with strict shared policy/payload validation;
- `project.assignment.created`: `o.source_key=pm.id` and
  `json_extract(payload,'$.assignment.membershipCycle')=pm.id`;
- `project.deadline.reminder`: outbox cycle column and payload
  `authorizationAtOccurrence.membershipCycle` both equal `pm.id`;
- `project.comment.mentioned`: current mention mapping still equals recipient/comment, and at least
  one `authorizationAtOccurrence.membershipIds` value equals `pm.id`;
- `project.subtask.assigned|project.subtask.due_today`: outbox cycle column and payload cycle equal
  `pm.id`, and current subtask assignment/version (plus due/claim for due-today) still match.

An event type absent from these arms is hidden. A direct legacy notification with no sent ledger /
outbox link is hidden. A removed/re-added membership has a different `pm.id`, so old-cycle rows are
hidden even though the project is accessible again. Cursor pagination selects from this predicate
before `ORDER BY/LIMIT`; unread count uses it before `count(*)`; mark-all updates only its subquery.
Mark-read/delete for a hidden ID return the same 404 as absent. Implement the fragment as one
`WITH external_visible_notifications AS (...)` CTE reused byte-for-byte by all five statements.
Each event arm includes `json_valid`, exact schema/event/recipient/project/cycle/mapping checks, and
the enumerated shared-policy event set. A ledger reaches `sent` only in the same consumer batch that
successfully ran the strict shared parser/projector/copy constructor. Thus list and count do not have
a looser post-SQL parsing asymmetry; malformed/corrupt envelopes fail the CTE and are audited by an
internal integrity scan, never counted or returned.

### Occurrence and delivery behavior

- Keep `notification_outbox`, `notification_delivery_ledger`, `deliverBroadInApp`, and exact
  `project_members.id` cycles. Do not add a recipient table.
- `user.authorization_epoch` is the monotonic global authorization version. Every outbox producer—
  broad, assignment, mention, Deadline, and the three External-safe legacy adapters—constructs each
  recipient row with `recipient_authorization_epoch` selected from that recipient's current active
  `user` row in the **same occurrence INSERT ... SELECT** that validates its role/mapping. A caller
  cannot supply the epoch. Newly-produced External-capable rows carry the exact current stamp;
  legacy NULL rows remain internal-only and are not publishable to External recipients.
- At occurrence time, internal Editor cycles are admitted as today. For an External Editor cycle, a
  suppressed policy creates no external in-app ledger/notification row. An allowed conditional
  projector that yields no safe fields also creates no row.
- At resolve and again in the final lease-token-fenced admission batch, join the recipient `user`
  row and require exact epoch equality for every stamped row; a legacy NULL stamp is accepted only
  for a non-External internal recipient and is rejected for an External recipient. Alongside that
  compatibility arm, require active role, exact membership cycle/mapping, project archive state,
  and registry/legacy policy. Equality—not `<=`—is the only admission. A role transition cannot
  cause a previously queued internal-only event to render; an old/missing-epoch External row is
  suppressed with `authorization_epoch_changed` and creates no notification/email.
- Leasing is not authorization. If a consumer leased a row before an epoch bump but its final
  admission serializes after the winning role-change batch, that same token-owned D1 batch changes
  every `pending|processing` channel to `suppressed`, inserts no `notifications` row or email work,
  and terminalizes the outbox `suppressed`. If final admission serializes first, delivery's
  authorization linearization point precedes the later role transition. No external email call or
  in-app INSERT may occur before that final epoch admission succeeds.
- External copy is constructed only from strict safe payload plus allowed display context selected
  by explicit columns. Do not reuse internal copy and redact strings afterward.
- Broad email remains off for all broad activity.
- Targeted checklist assignment, project mention, and Deadline email/default behavior matches an
  internal Editor through the durable mappings above. Replace hard-coded role arrays in the targeted
  resolvers with shared capability/assignment eligibility. Existing personal Deadline email
  preference applies unchanged.
- Targeted assignment and mention delivery must reauthorize active user, non-archived visible
  project, current membership, safe category, and exact mapping/cycle at send time.
- Reactivation creates no history backfill and does not reset suppressed/discarded ledger rows.

The epoch invariant applies to every resolver (`resolveBroadRecipient`, `resolveRecipient`, Deadline,
assignment, mention, direct-safe legacy, checklist assignment/due) and every admission helper,
including the legacy-path equivalent of `broadAdmission`. Tests deliberately pause a consumer after
lease acquisition, commit `editor→external_editor` and `external_editor→editor` transitions that
preserve the same membership ID, then resume it; both rows must finish suppressed with no in-app row
and no email-provider call.

In the shipped `broadAdmission()`, epoch equality belongs specifically in the
**`authorization` fragment** at `workers/background/src/notification-delivery.ts:955-968`, alongside
current membership/role/active checks. It must not enter `structural`: the consumer's suppressed arm
is `structural AND NOT authorization`, while `NOT structural` is the failed/corrupt arm. Replace the
suppressed update's hard-coded `reauthorization_suppressed` code
(`notification-delivery.ts:1028-1040`) with a bounded CASE that yields
`authorization_epoch_changed` when the structural outbox/user join exists but the stamped/current
epochs differ, and `reauthorization_suppressed` for the other authorization failures. The matching
audit reason uses the same computed code. Every other admission helper follows the same partition,
so an epoch mismatch is suppressed, never failed and never mislabeled.

## Role transition, deactivation, and session lifecycle

### One guarded user mutation command

Replace the loose `PATCH /api/users/:id` update sequence with a route-independent guarded command.
Name/profile-only changes may retain the simple path, but any role or active-state change uses one D1
batch and an authoritative reread. One request may change **either** role or active state, never
both; a combined request returns `400 {"code":"one_lifecycle_transition_at_a_time"}` before a
write so each winning transition has one unambiguous fence/audit/session policy.

For any `existing.role !== requested.role`:

1. pre-read the target role/active state and all incompatible memberships;
2. reject conversion to `external_editor` while any
   `project_members.role_on_project='photographer'` row exists;
3. reject conversion to `photographer` while any
   `project_members.role_on_project='editor'` row exists;
4. never delete or reinterpret a membership automatically;
5. conditionally update the role and increment `authorization_epoch` under the complete pre-read
   role/active/updated-at/current-epoch fence and `RETURNING id,authorization_epoch`;
6. immediately insert `user.role_change` with `INSERT ... SELECT ... WHERE changes()=1`; its ID is
   the sole winner marker;
7. delete **all** better-auth sessions for the target user in the same D1 batch with
   `DELETE FROM session WHERE user_id=? AND EXISTS(winner marker)`, including impersonation sessions;
8. suppress every unsent content-bearing recipient delivery under the exact status rules below;
9. record previous/new role, session revocation count, suppression count, and impersonation
   provenance in bounded audit metadata; never copy project/contact/content.

Compatible Editor memberships survive `editor ↔ external_editor` and `admin → external_editor`.
Admin-to-external still blocks if any Photographer membership exists. External-to-Admin needs no
membership conversion. Every successful role direction revokes all sessions, even when the new role
would have equal or broader access.

Conflict response:

```json
{
  "code": "role_membership_conflict",
  "targetRole": "external_editor",
  "blockingMemberships": [
    { "projectId": "...", "projectLabel": "12 Example St", "roleOnProject": "photographer" }
  ]
}
```

Only an authorized Admin receives blocker identities. Admin UI restores the prior select value,
names every blocking project/role, and directs the Admin to remove it explicitly. It never silently
retries, deletes, or converts memberships.

better-auth is configured with the D1 Drizzle adapter (`workers/app/src/auth.ts:33-49`) and its
sessions are the repository `session` table (`packages/db/src/schema.ts:38-54`). The guarded table
DELETE is therefore the authoritative revocation. Do not call the Admin plugin's out-of-band revoke
API: it would execute outside the role-write D1 batch and could leave either the new role with an old
session or a revoked session with a losing role update.

The role-change batch statement order is normative for every direction. For a winning conversion to
External, append the winner-gated purge-job INSERT after statement 4:

```text
0  UPDATE user SET role=:nextRole,authorization_epoch=authorization_epoch+1,updated_at=:now
     WHERE id=:userId AND role=:oldRole AND active=:oldActive
       AND authorization_epoch=:oldEpoch AND updated_at=:oldUpdatedAt
       AND NOT EXISTS(incompatible membership query)
     RETURNING id,authorization_epoch
1  INSERT audit_log(:winnerAuditId,...,'user.role_change',...)
     SELECT ... WHERE changes()=1
2  DELETE FROM session
     WHERE user_id=:userId AND EXISTS(SELECT 1 FROM audit_log WHERE id=:winnerAuditId)
3  UPDATE notification_delivery_ledger
     SET status='suppressed',last_error_code='role_changed',...
     WHERE recipient_id=:userId AND status='pending'
       AND EXISTS(winner marker)
4  UPDATE notification_outbox
     SET status='suppressed',lease_token=NULL,lease_expires_at=NULL,
         completed_at=:now,last_error_code='role_changed',...
     WHERE recipient_id=:userId AND status IN ('pending','queued')
       AND EXISTS(winner marker)
       AND NOT EXISTS(ledger status IN ('pending','processing'))
```

Suppressing every unsent recipient event on **any** role transition is deliberate: the user signs in
fresh under a new principal contract and receives no missed-event backfill. Ledger `sent`, `failed`,
`unknown`, `discarded`, and already `suppressed` rows are immutable here. Outbox `completed`,
`suppressed`, `failed`, `dlq`, and `discarded` are immutable. A `processing` outbox/ledger remains
lease-owned; every resolver/admission reloads current role **and epoch** and rejects the
pre-transition envelope, then changes its `pending|processing` channel to suppressed and completes
the outbox under its token with `authorization_epoch_changed`.
All statements 2–4 are gated by the same winner marker; a zero-row UPDATE changes no session,
delivery, or audit beyond the absent marker.

### Conversion-to-External bearer revocation

Conversion to `external_editor` uses the same one-batch guarded role transition as every other role
direction. The winning `UPDATE` changes the role and increments `authorization_epoch` once; that
single epoch bump immediately makes every saved transform-source signature fail on its next origin
fetch. The batch then audits, deletes sessions, suppresses unsent delivery, and inserts one
idempotent `external_role_conversion_cache_purge` job under the same winner marker. There is no
init/final split, no `external_conversion_state`, transition token/timestamps, 409 interlock,
failed-purge retry/cancel UI, or rollback prohibition based on a transition state.

The purge job is cleanup, not authorization to finalize the role. Its strict payload contains only
`{userId,roleChangeAuditId,authorizationEpoch}`; the audit ID is its idempotency/correlation key. The
background Worker alone holds `CLOUDFLARE_ZONE_ID` and the zone-scoped Cache Purge secret, performs
`purge_everything`, records only bounded request/result IDs, retries transient failure, and raises an
internal alert after bounded exhaustion. It never writes the user role or epoch. Replaying an old
URL after a successful purge must miss at the edge, fail the epoch check before R2, and remain
uncacheable. A losing role mutation inserts neither audit nor purge job.

This deliberately retains the broad purge because no maximum transform-cache lifetime is
established, but removes the distributed conversion transaction: three `user` columns, five states,
two winner boundaries, the signed-out pending role, retry/cancel UX, and second epoch bump all
disappear. The remaining review question is the short best-effort interval before the asynchronous
purge removes an already-cached HIT; signature replay cannot extend that interval by re-caching.

### Deactivation/reactivation

Deactivation is one guarded batch:

- set `active=false` and increment `authorization_epoch` under the same
  role/active/epoch/updated-at pre-read fence and `RETURNING id,authorization_epoch`;
- insert `user.deactivate` immediately with `WHERE changes()=1` as the winner marker;
- delete every `session` row only where that marker exists;
- preserve all `project_members` rows and historical audit/activity/notification rows;
- change every recipient ledger in `pending` to `suppressed` with `recipient_inactive`, then change
  outboxes in `pending|queued` to `suppressed` only after no pending/processing ledger remains, all
  gated by the winner marker;
- leave `processing` to the lease-fenced resolver, which rechecks `active=1` in its final admission
  batch and suppresses with `recipient_inactive` rather than inserting/sending;
- audit revocation/suppression counts without content.

The statement/status contract is the role-change form with a distinct winner and reason:

```text
0  UPDATE user SET active=0,authorization_epoch=authorization_epoch+1,updated_at=:now
     WHERE id=:userId AND role=:oldRole AND active=1
       AND authorization_epoch=:oldEpoch
       AND updated_at=:oldUpdatedAt
     RETURNING id,authorization_epoch
1  INSERT audit_log(:winnerAuditId,...,'user.deactivate',...)
     SELECT ... WHERE changes()=1
2  DELETE FROM session
     WHERE user_id=:userId AND EXISTS(winner marker)
3  UPDATE notification_delivery_ledger
     SET status='suppressed',last_error_code='recipient_inactive',...
     WHERE recipient_id=:userId AND status='pending' AND EXISTS(winner marker)
4  UPDATE notification_outbox
     SET status='suppressed',lease_token=NULL,lease_expires_at=NULL,
         completed_at=:now,last_error_code='recipient_inactive',...
     WHERE recipient_id=:userId AND status IN ('pending','queued')
       AND EXISTS(winner marker)
       AND NOT EXISTS(ledger status IN ('pending','processing'))
5  UPDATE audit_log SET meta_json=:boundedCounts
     WHERE id=:winnerAuditId AND EXISTS(winner marker)
```

The role-change batch uses the same final bounded-count update. This is the only post-winner audit
write; it is itself winner-gated. No losing mutation deletes sessions, suppresses delivery, or emits
any audit row. For both commands, a consumer that already owns `processing` is the sole writer of
that state: its final lease-token-fenced batch changes `pending|processing` ledger channels to
`suppressed`, inserts neither `notifications` nor email work, and completes the outbox only when no
pending/processing ledger remains.

Existing active checks then block authentication, new project/checklist assignment, and delivery.
Team UI renders retained External memberships as `Inactive · External editor`.

Reactivation increments the epoch, sets `active=true`, and audits it but does not recreate a session,
requeue suppressed delivery, backfill missed events, or recreate removed memberships. A future
successful Google login derives access only from memberships still present.

## Client access-loss and freshness extension

### Authorization snapshot

Add authenticated `GET /api/project-access-snapshot`. It calls `visibleProjectWhere` and returns:

```ts
type ProjectAccessSnapshot = {
  principal: { id: string; role: Role; authorizationEpoch: number };
  authorizationFingerprint: string;
  projects: Array<{ projectId: string; membershipCycleIds: string[] }>;
};
```

For `viewAllProjects` roles, membership cycles may be empty; for scoped roles they are the sorted
current cycles that contribute to visibility. The fingerprint is a deterministic hash/version over
principal ID, reloaded role/active/authorization-epoch state, visible project IDs, and relevant cycle
IDs. It contains no
street, contact, Stage, notes, or hidden project ID. The response itself is authorization data and is
never persisted outside the principal-scoped QueryClient.

An always-mounted `PrincipalFreshnessBoundary` owns query key
`['authorization-scope', principalId, role, authorizationEpoch]`, refetches at the existing bounded 30-second active
interval and on focus/reconnect, and also refetches the auth session. It pauses while hidden under the
same TB2 rules. Same-browser project-data tombstones remain the acceleration path, not the only path.

Dashboard currently owns `projects` as local React state (`portal/apps/web/src/screens/Dashboard.tsx:135,161-191`), so there is
no QueryClient entry for a freshness boundary to purge. TB4E moves the authoritative Dashboard fetch
to `apps/web/src/lib/dashboard-projects.ts` with key
`['dashboard-projects',principalId,role,authorizationEpoch,{archived:false}]`.
`useDashboardProjects()` is the sole owner;
Dashboard derives search text, suggestions, counts, Stage/filter options, and visible cards directly
from that query result and removes the old `setProjects` fetch owner. The access-snapshot diff calls
`queryClient.setQueryData` synchronously to filter every lost/cycle-changed project ID from all
matching principal Dashboard keys **before** publishing the UI-loss signal, then invalidates/refetches
those exact keys. No stale local search index remains.

### Exact purge predicate and navigation

When a previously visible project ID disappears, or its membership cycle set changes:

1. cancel in-flight requests for that project;
2. remove every key satisfying
   `key[0] === 'project-data' && key[1] === lostProjectId`;
3. remove/invalidate `['project-quick-detail', lostProjectId, ...]` if introduced; synchronously
   filter the principal-scoped `dashboard-projects` query through
   `removeProjectFromDashboardQueries(queryClient,principalId,lostProjectId)` and refetch it; remove
   the entire future `['production-calendar', ...]` range family because a mixed range may contain
   the lost project;
4. clear asset/blob/object-URL ledgers, comment/read-marker/subtask/team drafts, selection state, and
   project-specific media references through the existing tombstone helpers;
5. broadcast `project-data-removed` so other tabs perform the same purge;
6. close lightbox, comparison, annotation editor, Team picker, checklist editor, comment composer,
   quick-detail popover, and any project-specific modal;
7. if the current route belongs to the lost project, replace it with the nearest safe Dashboard /
   assigned-project route and show bounded copy: “Your access to that project changed.” Do not name
   an unassigned project in the explanation.

This is a membership/access-scope transition, **not global sign-out**. Other project queries and the
session remain.

If the session refetch observes no session after a role change/deactivation, or any authenticated API
returns principal-terminal `401`, call `clearPrincipalProjectData`, unmount the principal QueryClient,
close all project UI, and show the existing sign-in path. Because every role transition deletes all
sessions, there is no in-place role upgrade/downgrade with stale cached fields.

## Calendar readiness — design only

TB4E reserves this immutable contract for TB5C and builds no Calendar code:

- TB5C adds `viewProductionCalendar` and grants it to External Editor at assigned-project scope.
- Every Calendar range/list/filter query composes the same `visibleProjectWhere`, the app-owned
  explicit Calendar select map, and shared `externalCalendarRangeSchema`; no Calendar-only access
  predicate or full internal event DTO exists.
- External Calendar contains project Deadlines and all checklist scheduled work for assigned,
  unarchived projects. **My tasks** is a quick assignee filter, not the only data returned.
- Project Deadline is read-only because External lacks `editProject`.
- Checklist drag/resize and Unscheduled checklist drag use the normal Collaboration command and
  TB4D optimistic/version rules.
- Unscheduled project Deadline entries may be visible but are not draggable by External Editors.
- Calendar project/person/filter options are derived only from the authorized range result and never
  broaden scope.
- Membership loss invalidates the full Calendar range query family on the next freshness signal.

The field-level Calendar shape in the DTO matrix (including `permissions.canDrag` and
`permissions.canResize`) is explicitly **non-normative for TB4E**; it is a reserved TB5C seam, not an
endpoint or schema built by this plan. TB5C owns the final fields while retaining the shared
`visibleProjectWhere` obligation.

## Additive migration `0036`

### Exact schema change

Migration `0036` now contains three bare additive columns, the recoverable opaque upload session/part
tables, and three indexes. The role enums remain schema-type-only:

```sql
ALTER TABLE `projects` ADD COLUMN `production_notes` text;
ALTER TABLE `user` ADD COLUMN `authorization_epoch` integer NOT NULL DEFAULT 0
  CHECK (`authorization_epoch` >= 0);
ALTER TABLE `notification_outbox` ADD COLUMN `recipient_authorization_epoch` integer;

CREATE TABLE `external_edited_upload_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `token_hash` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
  `collection_id` text NOT NULL REFERENCES `collections`(`id`) ON DELETE cascade,
  `asset_id` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `user`(`id`),
  `membership_cycle_id` text NOT NULL,
  `authorization_epoch` integer NOT NULL CHECK (`authorization_epoch` >= 0),
  `original_filename` text NOT NULL,
  `bytes` integer NOT NULL CHECK (`bytes` > 0 AND `bytes` <= 5368709120),
  `r2_key` text NOT NULL,
  `r2_upload_id` text NOT NULL,
  `part_bytes` integer NOT NULL CHECK (`part_bytes` > 0),
  `part_count` integer NOT NULL CHECK (`part_count` > 0),
  `status` text NOT NULL DEFAULT 'open'
    CHECK (`status` IN ('open','completing','completed','aborting','aborted','expired')),
  `completion_lease_token` text,
  `completion_lease_expires_at` integer,
  `expires_at` integer NOT NULL,
  `completed_at` integer,
  `terminal_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (
    (`status`='completing' AND `completion_lease_token` IS NOT NULL
      AND `completion_lease_expires_at` IS NOT NULL)
    OR (`status`!='completing' AND `completion_lease_token` IS NULL
      AND `completion_lease_expires_at` IS NULL)
  ),
  CHECK (
    (`status`='completed' AND `completed_at` IS NOT NULL AND `terminal_at` IS NOT NULL)
    OR (`status` IN ('aborted','expired') AND `completed_at` IS NULL AND `terminal_at` IS NOT NULL)
    OR (`status` IN ('open','completing','aborting') AND `completed_at` IS NULL AND `terminal_at` IS NULL)
  )
);

CREATE TABLE `external_edited_upload_parts` (
  `session_id` text NOT NULL REFERENCES `external_edited_upload_sessions`(`id`) ON DELETE cascade,
  `part_number` integer NOT NULL CHECK (`part_number` > 0),
  `expected_bytes` integer NOT NULL CHECK (`expected_bytes` > 0),
  `received_bytes` integer,
  `etag` text,
  `status` text NOT NULL DEFAULT 'pending'
    CHECK (`status` IN ('pending','uploading','uploaded')),
  `upload_lease_token` text,
  `upload_lease_expires_at` integer,
  `uploaded_at` integer,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`session_id`,`part_number`),
  CHECK (
    (`status`='uploading' AND `upload_lease_token` IS NOT NULL AND `upload_lease_expires_at` IS NOT NULL)
    OR (`status`!='uploading' AND `upload_lease_token` IS NULL AND `upload_lease_expires_at` IS NULL)
  ),
  CHECK (
    (`status`='uploaded' AND `received_bytes`=`expected_bytes`
      AND `etag` IS NOT NULL AND `uploaded_at` IS NOT NULL)
    OR (`status`!='uploaded' AND `etag` IS NULL AND `uploaded_at` IS NULL)
  )
);

CREATE UNIQUE INDEX `external_edited_upload_sessions_token_hash_idx`
  ON `external_edited_upload_sessions` (`token_hash`);
CREATE INDEX `external_edited_upload_sessions_principal_status_idx`
  ON `external_edited_upload_sessions` (`created_by`,`status`,`expires_at`);
CREATE INDEX `external_edited_upload_sessions_sweep_idx`
  ON `external_edited_upload_sessions` (`status`,`expires_at`,`completion_lease_expires_at`,`id`);
```

There is no role CHECK to widen, no annotation/user table rebuild, no `project_members` change, and
no semantic data backfill: existing users receive epoch `0`, while legacy outbox rows retain a
`NULL` recipient epoch and therefore fail closed for External admission. Pre-TB4E internal delivery
remains compatible until the first authorization transition bumps that user. `membership_cycle_id` is
intentionally an immutable snapshot without a foreign key:
final membership deletion must not be blocked or cascade away the upload audit binding. Every live
operation still requires the matching current `project_members.id`; removal makes the session
unusable. `asset_id` has no asset foreign key because the asset does not exist until completion.
The nullable project and outbox epoch columns, the user epoch default, and unused upload tables are
compatible with all currently deployed Workers. Drizzle models all fields and internal-only R2 binding values; none is
part of a shared External DTO.

No new **membership-scope** index is planned; the three new indexes belong only to upload lifecycle
lookup. The membership-scoped list begins from/filter-joins
`project_members.user_id`, which is already covered by `project_members_user_idx`
(`schema.ts:263-264`), and then reaches projects by primary key. The unique
`(project_id,user_id,role_on_project)` index supports exact project/cycle checks. Local prod-shaped
`EXPLAIN QUERY PLAN` must prove those indexes and no unacceptable full scan. If it does not, stop and
amend/re-review this plan before adding an index; do not improvise a second `0036` shape during build.

### Numbering and generation discipline

1. Preflight production with `SELECT id,name,applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5`
   and stop unless tail is `0035`.
2. Take and checksum the established pre-migration D1 recovery export under the parent
   `db-recovery/` workspace.
3. Update Drizzle schema, run the repository's pinned `drizzle-kit generate`, then reconcile its
   SQLite rebuild output to the reviewed bare-ALTER form using
   `packages/db/migrations/0035_project_subtask_scheduling_ranges.sql:1-21` (and `0020`) as the exact
   precedent. Drizzle-kit's SQLite differ has no ALTER-ADD-CHECK path, so this snapshot-reconciliation
   technique—not accepting the generated rebuild—is what makes the second generation a no-op.
   Require output tag `0036_external_editor_assigned_scope` (or reviewed equivalent) with exactly
   the three bare `ALTER TABLE ... ADD COLUMN` statements, two `CREATE TABLE` statements, and three
   indexes above.
4. Update `meta/_journal.json` and add `0036_snapshot.json`. Never hand-edit a snapshot into a shape
   that disagrees with schema.
5. Run a second `drizzle-kit generate`; it must be a no-op.
6. Apply from a fresh local database and upgrade a TB4D-shaped database; run foreign-key check and
   `quick_check` in both.
7. Reject any generated table rebuild or `PRAGMA foreign_keys=OFF` sequence. The remote D1 failure
   recorded in `docs/lessons.md` makes such a migration unacceptable.

## Implementation slices

Keep the build reviewable in this order; no slice provisions a production account.

1. **Shared role contract:** add role/label/capabilities/assignment eligibility, widen shared types,
   add exhaustive tests, and reserve future capabilities only in prose/tests.
2. **Schema and projection types:** add `productionNotes`, authorization and outbox epoch fields,
   outbox epoch stamp, recoverable upload session/part tables and indexes in migration `0036`, strict
   shared external DTO/policy/notification modules, app-only
   explicit select maps, and migration/projection sentinel tests.
3. **Visible scope:** implement SQL/list and single-resource resolver, active/archive/error rules,
   then cut every project/media/Collaboration/upload route to it.
4. **Project/media/Collaboration/upload serializers:** replace whole-row spreads and hard-coded role
   checks; implement the External no-transform/no-store media branch, provider-neutral upload gate,
   and create/part-proxy/complete/abort handshake; add minimal production-note UI and contextual labels.
5. **Assignment and user lifecycle:** extend candidates, atomic membership suppression, guarded
   role/deactivation epoch bumps, winner-gated conversion purge job, blocker UI, auth
   plugin/session/impersonation support.
6. **Activity/notifications:** stamp every outbox row with the producer-selected recipient epoch;
   make every registry and legacy `NotificationType` policy explicit in
   shared code; exclude External recipients from generic direct insertion/email; route allowed
   External occurrences through exact-cycle durable events; add consumer projection/admission and
   the identical five-operation read CTE.
7. **Freshness:** add authorization snapshot, principal freshness boundary, query-key purge,
   cross-tab tombstone, UI closure, and safe navigation.
8. **Proof and release:** automated suites, source audits, migration/query proof, Agy local role
   matrix, full gate, recovery export, consumer-first rollout, passive production verification, and
   documentation closeout.

## Automated test plan

### Shared role/capability tests

- Assert `ROLES` has exactly `admin | photographer | editor | external_editor` and display label is
  exactly “External editor.”
- Assert the External capability set equals the nine-item allow-list—no omissions and no extras.
- Assert `moveProjectStage` and `viewProductionCalendar` are absent until their owner bullets.
- Assert Editor-slot eligibility includes active External Editor and Photographer-slot eligibility
  excludes it; project membership roles remain exactly two.
- Assert every `Role` switch/record is exhaustive and `roleHasCapability` returns the exact matrix.

### Migration/schema tests

- Fresh and TB4D-upgrade databases produce nullable `projects.production_notes` and preserve every
  existing value/count.
- Fresh/upgrade databases produce the exact three additive columns (including nullable outbox epoch),
  the user epoch default/CHECK, upload
  session/part columns/CHECKs/FKs, and three indexes; membership deletion is not
  blocked and a removed cycle cannot use its retained session.
- TB4D-upgrade fixtures give every existing user row epoch zero and leave legacy outbox epoch stamps
  NULL (which fail closed for External admission); a new shared producer row carries the recipient's
  selected current epoch, and hashed upload tokens are unique through their named index. Invalid
  negative epoch or illegal session/part state
  shapes fail their CHECKs.
- `PRAGMA table_info(user)` and migration SQL prove `role` remains plain text with no CHECK;
  `annotations.author_role` likewise accepts the widened type without migration.
- Migration SQL contains exactly three bare `ALTER TABLE ... ADD COLUMN`, two table creates, three
  indexes, no rebuild/copy/drop/rename and no `PRAGMA foreign_keys=OFF`.
- Foreign-key check and quick check pass; second generate is no-op.
- `projects.notes='INTERNAL_SENTINEL'` never populates `production_notes`.

### Scope and endpoint authorization tests

Build a fixture matrix with Admin, Photographer, internal Editor, active External Editor, inactive
External Editor; assigned/unassigned membership cycles; RAW-visible/edited/delivered/archived
projects; and a remove/re-add cycle.

For each route generated by the registered-route security manifest, test direct HTTP/API
access—not component visibility—and prove:

- External list contains assigned active and delivered projects at every Stage, never unassigned or
  archived projects; Photographer remains membership+Photographer-Stage; internal Editor remains
  broad unarchived.
- External unassigned and archived direct project/comment/subtask/collection API URLs return the
  same generic `404` as nonexistent resources. Session media/annotation URLs return the same
  constant 403 for invisible/nonexistent IDs; a revoked session returns 401.
- Dashboard search results, suggestions, Stage/filter options, visible/empty counts, and access
  snapshot contain no unassigned project fact.
- Asset-by-ID, annotation-by-ID, comment-by-ID, and subtask-by-ID cannot reveal existence before the
  project scope join.
- External can view/annotate/recommend RAW, compare frames, upload edited, view/review/annotate edited,
  and collaborate on assigned projects.
- External cannot upload RAW, select RAW for editing, set non-recommend RAW review metadata, publish,
  preview client delivery, download final, manage extras, prioritize, edit/archive/create projects,
  move Stage, send AutoHDR, or read jobs/provider/Admin/Notice Board/directory endpoints.
- Exact/trailing-slash variants of gated routes share authorization and do not fall through to a
  permissive wildcard.
- Generated terminal-only, deduplicated `app.routes` and checked-in classifications are equal;
  middleware registrations are excluded only by the explicit terminal marker, duplicate contracts
  agree, and `DELETE /api/assets/:id`, every capability-withheld route, `ALL
  /__transform-source`, and `GET /__transform-source/*` are present. Both transform routes classify
  `withheld` for External while their separate valid/invalid bearer probes remain green.
- SQL trace fingerprints/statement counts match for invisible/nonexistent misses and no follow-up
  query/R2/provider call occurs. The randomized paired timing regression remains within its stated
  median/p95 noise bands without claiming constant time.

### External projection privacy tests

Seed a unique sentinel into **every** included and excluded field, including linked Agency/Agent
records, and test summary, detail, media, annotation, collection link, Collaboration, checklist,
comment, notification, and future projection seams.

- Assert every allowed field is present with correct semantics: location, display names, shoot
  date/time, Stage, Deadline, services/deliverables, production notes, authorized media/workflow,
  checklist/comments/team, participant names/role labels/emails.
- Assert every excluded field/key/value is absent recursively: internal notes, contact email/phone,
  invoice/payment, order IDs, directory IDs/notes, Dropbox paths/links, priority/board position,
  R2/storage/multipart/job/provider/webhook/diagnostic/Admin data, unrelated people/projects.
- Assert external output is constructed from explicit select maps; adding a fake internal project
  property fails the strict serializer instead of appearing automatically.
- Assert every outer list/mutation envelope is strict, including comment
  `{project,comments,nextCursor?}`. For each surface, inject an unknown sibling/item key and require
  both the server-boundary schema and External client decoder to fail; internal decoders remain
  role-distinct and cannot be used as fallback.
- Assert `/api/me` returns/decodes only the exact self principal plus nine capabilities, and both
  notification-preference methods return/decode exactly the personal Deadline-email boolean.
- Assert `productionNotes` never falls back to internal `notes` and its text never enters broad
  activity/notification/audit payload.
- Assert participant email is visible in assigned Team context, while global mention/assignee/user
  search and unrelated project contexts return no person/email.
- Assert the staff Notice Board candidate query excludes `external_editor` even when active, and a
  forged External Notice Board mention recipient is removed by `emitNotifications()` before both
  row insertion and excerpt email.
- Assert annotation markup works through authorized media response without returning R2 keys.
- Reuse previously authorized External Quincy asset/annotation URLs after membership removal (403)
  and session revocation (401); assert `no-store`, no R2 read on denial, and no transform redirect/
  source URL. Separately prove the bearer route accepts only a valid internal signed capability and
  gives the uniform 404 for expired/invalid/nonexistent-key forms; no External response contains one.
  Capture an epoch-N internal bearer, commit conversion to External/epoch N+1, and prove an origin
  fetch fails before R2 immediately; after the purge, replay the same browser-facing transform URL
  must edge-miss into that same failure and cannot repopulate. Advance beyond 120 seconds and prove
  an old `<img src>` miss 404s until the client re-requests `/media/asset/...`.
- Exercise opaque External create/part-proxy/complete/abort through browser-observed requests. Every
  request URL must be same-origin `/api/external-uploads/...`; assert no redirect/R2 hostname,
  account, bucket, key, upload ID, ETag, Dropbox/job diagnostic, or raw session column in
  URL/body/header. Verify binding-streamed exact part sizes, stale part leases, role/epoch/cycle
  recheck, safe error bodies, and server-stored `R2UploadedPart` ETags only.
- Fault-inject after binding multipart creation/before D1 INSERT; after session/part INSERT/before
  response; before and after each binding `uploadPart`; after part success/before part-row commit;
  after completion lease claim; after binding completion/before HEAD; after HEAD/before the media
  batch; at every statement of the atomic media batch; after abort claim; after binding abort/before
  terminal commit; and during the known-session expiry sweep. Record preflight evidence that the
  incomplete-multipart lifecycle is configured for seven-day reclamation of the untracked
  create-before-D1 crash orphan; Miniflare cannot assert bucket lifecycle behavior. Each retry converges to exactly one
  completed asset or one aborted/expired session, with no stuck live lease and no visible incomplete
  part. Stale completion always HEADs first; abort is idempotent.
- Assert `editedUploadAvailable` is the only Workspace gate for all roles, matches the server-side
  Dropbox boolean, and the External detail SQL/result contains neither Dropbox field/value.

### Assignment, role, and session tests

- Create Project and Editor Team candidates include active External Editor; Photographer candidates
  do not. Inactive existing members remain visible/removable but absent from candidates.
- Atomic create/add/assignee commands recheck role+active state and reject a stale/
  ineligible candidate even if UI prevalidation passed.
- Final External membership removal always returns immediate-access warning plus exact checklist
  cleanup count, commits membership delete/approved cleanup/audit/activity/pending suppression
  together, and preserves delivered history.
- Removing one of multiple compatible Editor memberships does not falsely report access loss or
  clear assignments; removing the final authorizing cycle does.
- Membership removal purges only that project and does not revoke the user's global session.
- Every successful role direction revokes every session and emits exactly one final
  `user.role_change`; conversion-to-External additionally inserts exactly one winner-gated purge job.
- Losing guarded role/deactivation writes produce no winner marker, session deletion, ledger/outbox
  transition, or audit. Winning batches suppress exactly ledger `pending` and outbox
  `pending|queued`; processing races are suppressed only by the lease-fenced consumer; sent history
  remains.
- Conversion to External blocks with named Photographer memberships; conversion to Photographer
  blocks with named Editor memberships; no membership row changes on conflict.
- Compatible Editor memberships survive internal↔external conversion. Admin→external applies the
  same Photographer blocker.
- Conversion to External is the same one-batch role/epoch/session/suppression path and enqueues one
  fire-and-forget purge job. A captured pre-conversion transform URL fails after purge because its
  signed epoch no longer matches; replay cannot re-cache it. Purge retry/alert never gates or
  rewrites the role. External→Editor remains the same one-batch path without a purge job.
- Deactivation revokes sessions, preserves memberships, suppresses pending delivery, blocks auth/new
  assignment/delivery; reactivation causes no backfill/requeue/session creation.
- Impersonation accepts an active external target only while the runtime flag/Admin session permits
  it, preserves audit provenance, and gets the external projection—not Admin projection.

### Activity/notification/background tests

- Registry test enumerates every current live/reserved type and asserts no `pending`/default external
  policy remains.
- Exhaustively test every row in both the registry classification and all thirteen legacy
  `NotificationType` classifications for External occurrence fan-out, strict payload, copy, and
  exact channels.
  Suppressed types produce no external ledger and no redacted notification.
- Prove the `emitNotifications()` choke point reloads and excludes an External recipient for all six
  current call sites, including the direct Notice Board mention path; earlier filtering in
  `projectNotificationRecipients()` is defense in depth. Each allowed legacy event enters its
  specified durable event; broad events never get an
  email ledger, while assignment/mention/Deadline obey their exact channel/preference contract.
- Checklist assignment and due-today delivery require current subtask assignee, assignment version,
  due/claim mapping, project, and membership cycle at send time.
- `project.details.changed` projects only approved changed-field names and suppresses an
  internal-only change with an empty safe intersection.
- Same Editor membership-cycle SQL produces recipients for internal and External Editors; no second
  table/query path exists.
- Every new External-capable outbox producer stamps the recipient epoch via INSERT-SELECT; a missing
  or stale stamp is not publishable to an External recipient. Legacy NULL stamps remain internal-only.
  Pause a consumer after leasing, then commit `editor→external_editor` and separately
  `external_editor→editor` while preserving the membership UUID. Resumed final admission must change
  the row/channels to suppressed with `authorization_epoch_changed`, insert no notification, and
  make no email-provider call. A final admission committed before a later epoch bump remains the
  explicit delivery linearization ordering.
- Delivery reauthorization suppresses removed cycle, inactive user, role change, archived project,
  invalid payload, and external-suppressed type. Remove/re-add does not deliver the old cycle.
- Allowed external events get safe copy only; forbidden sentinels cannot appear in outbox payload,
  ledger error, notification title/body, email, audit meta, or log fixture.
- Targeted assignment, mention, and Deadline delivery/default preferences match internal Editor;
  broad email remains off; self/removed-mapping/current-access rules remain.
- Notification list pagination, unread count, mark-read, delete, and mark-all-read use byte-identical
  `external_visible_notifications` CTE predicates. Unlinked legacy, malformed, suppressed,
  unassigned, archived, and superseded-cycle rows are neither counted, returned, nor mutated.

### Web/freshness/UI tests

- External role labels render exactly and never fall through to internal Editor styling/copy.
- Admin blocker UI lists incompatible projects and restores the previous role selection.
- Removal confirmation always includes access-loss copy and exact cleanup count.
- Authorization snapshot diff for a removed/replaced cycle invokes the exact project query-key
  predicate, clears blob/media/collaboration state, closes all project UI, broadcasts a tombstone,
  and navigates with `replace` to a safe route.
- Other authorized project cache survives membership loss; the session remains signed in.
- Role/deactivation session loss clears the entire principal QueryClient and returns to sign-in.
- Focus/reconnect/30-second freshness triggers work; a hidden tab does not spin and refetches on
  return.
- Dashboard search/filter/count state cannot retain an ID removed by the access snapshot.
- Dashboard has no local `projects` fetch owner: `useDashboardProjects()` owns the identified
  principal key, and `removeProjectFromDashboardQueries()` synchronously removes a lost ID before
  invalidation/refetch and visible rendering.
- Draft/interaction regression tests prove unrelated active comments/checklist drafts survive a
  different project's removal, while drafts for the lost project are destroyed.

## Repository audits

Run and review, not merely execute, audits equivalent to:

```bash
rg -n 'select\(\)|select\(\{ project: schema\.projects|\.\.\.project|\.\.\.r\.project' \
  workers/app/src
rg -n 'notes|agentEmail|agentPhone|invoiceAmount|paymentStatus|orderNo|orderId|rawFolder|agencyId|agentId|priority|boardPosition|R2Key|jobId|provider' \
  workers/app/src apps/web/src
rg -n 'hasProjectAccess|hasProjectCollaborationAccess|Forbidden: you are not assigned' \
  workers/app/src
rg -n '\["admin", "editor"\]|role === "editor"|role !== "editor"|ROLES|Role>' \
  packages workers apps
rg -n 'EXTERNAL_PROJECT_ACTIVITY_POLICY|audience: "internal"' packages workers
rg -n 'external_editor' packages/db/migrations
rg -n 'role_on_project.*external|PROJECT_MEMBER_ROLES.*external' packages workers apps
rg -n 'moveProjectStage|viewProductionCalendar' packages/shared/src/capabilities.ts
rg -n 'emitNotifications|projectNotificationRecipients|NotificationType' packages workers
rg -n 'authorization_epoch|recipient_authorization_epoch|broadAdmission|resolveRecipient' packages workers
rg -n 'issueTransformSource|liveTransformLocation|/__transform-source|cdn-cgi/image' workers apps packages
rg -n 'uploadId|r2_key|rawFolder|jobId|r2.cloudflarestorage.com|X-Amz-' \
  workers/app/src/routes apps/web/src
rg -n 'createMultipartPresign|AwsClient|r2s3|cloudflarestorage.com|X-Amz-' \
  workers/app/src/routes/external-uploads.ts workers/app/src/lib/external-upload*
rg -n 'rawFolderPath \|\| project.rawFolderLink|editedUploadAvailable' apps/web/src
```

Required conclusions:

- no External-reachable serializer spreads a full project or storage/provider row;
- every project/resource route appears in the reviewed scope manifest/test;
- every hard-coded role branch is either replaced by the correct capability/eligibility helper or
  documented as a true identity rule;
- no pending registry projection remains;
- no migration adds `external_editor` to `role_on_project` or rebuilds a role table;
- deferred capabilities remain absent;
- no staff/global directory/Notice Board/Admin link is rendered for External Editor;
- no generic direct emitter can admit External recipients; every legacy type appears in the shared
  exhaustive policy and every allowed External path has durable provenance/channel tests;
- every outbox producer derives a recipient epoch in SQL and every final admission checks equality;
  no processing delivery path relies on preserved membership alone;
- no External route issues/reveals a transform bearer; the source wildcard remains confined to the
  existing valid internal signed-capability protocol and all invalid/expired/nonexistent forms are
  uniform 404;
- every transform-source signature carries principal ID/current epoch, uses a 120-second TTL, and
  fails before R2 after role/deactivation epoch change; conversion inserts one winner-gated purge
  job and has no transition-state machine;
- External edited upload uses only same-origin proxy URLs and the `env.MEDIA` multipart binding;
  R2 URL/account/bucket/key/upload ID/ETag remains confined to server state, and Workspace no longer
  gates on Dropbox strings;
- route-scoped middleware and trailing-slash gates follow repository gotchas.

## Local migration and authorization/query proof

From `portal/`, using isolated local D1 databases and no production data:

1. Apply through `0035`, seed the full role/project/sentinel matrix, snapshot counts/values, apply
   `0036`, and compare all pre-existing values byte-for-byte.
2. Apply all migrations fresh and verify schema parity with the upgraded database.
3. Run `PRAGMA table_info(projects)`, `PRAGMA foreign_key_check`, and `PRAGMA quick_check`.
4. Prove with `EXPLAIN QUERY PLAN` that assigned list/snapshot queries use
   `project_members_user_idx` and project primary-key lookup; exact-resource checks use the existing
   unique/member indexes. Record plans in QA evidence.
5. Generate the actual Hono route manifest and send direct HTTP requests as every role for every
   classified route. Use unpredictable sentinel IDs and compare unassigned/archived/nonexistent
   status/body/length classes, SQL fingerprints/statement counts, and the bounded paired timing
   distribution.
6. Capture JSON for every external projection family and run recursive forbidden-key/value checks.
7. Queue every registry and legacy type, pause leases, remove/re-add memberships, transition both
   Editor directions, deactivate, run the local background consumer, and inspect exact outbox epoch/
   ledger/notification/session transitions and absence of email calls.
8. Exercise same-origin proxied multipart sessions through success, expiry, membership/epoch loss,
   replay, concurrent/stale completion, abort/lifecycle recovery, size mismatch, and every named
   fault-injection boundary.
9. Run the second generate no-op proof after all schema work.

## Required verification commands

From `portal/`, all must pass before any release candidate is considered:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also run the focused app/background/db/web integration suites added by TB4E, local migration upgrade
and fresh-db proofs, Drizzle no-op generation, route/projection audits, and Wrangler dry-run/config
validation used by the shipped tracer bullets. `npm run test --workspaces` does not replace the
explicit shared suite.

## Manual local role-matrix QA

Agy performs Chrome QA at high effort using the sanctioned local authenticated session. Agy never
runs Google OAuth, reads secrets, forges a session, or proceeds unauthenticated. A human signs in as
the seeded Admin at `http://localhost:8787`; Admin impersonation covers Photographer, Editor, and
External Editor roles. Local QA may mutate disposable fixtures; production QA is passive only.

Required local matrix:

1. Provision/convert a disposable local user to External Editor after clearing incompatible
   memberships; verify blocker UI first with seeded Photographer membership, then the one-batch
   role/epoch/session change, single winner-gated purge job, and final role audit using a local purge
   adapter.
2. Assign it only in an Editor slot on one active and one delivered project; keep one unassigned and
   one archived assigned project with unique sentinels.
3. As External, exercise Dashboard list/search/count/filter, direct deep links, RAW/Edited review,
   annotation, compare, the exact same-origin create/part-proxy/complete/abort handshake, Team email,
   mentions, comments, checklist CRUD/assignee/scheduling, Deadline read-only, and contextual labels.
   Inspect the browser network log to prove every upload request stays on `APP_ORIGIN` and contains no
   provider hostname/account/bucket/key/upload ID/ETag, provider job object, or transform redirect.
4. Attempt every withheld surface directly by URL/API, including Notice Board, Admin/directory,
   priority, Stage, RAW selection/upload, publish/download, extras, AutoHDR, manual jobs/provider
   diagnostics. Verify no target facts leak.
5. Generate every registry category and all thirteen legacy notification types. Verify allowed copy,
   targeted/default email channels, broad-email suppression, suppressed absence, and byte-identical
   list/count/read/delete/read-all visibility after cycle replacement.
6. With the External project open in another tab, remove the final membership as Admin. Verify exact
   warning/count, atomic cleanup, bounded freshness delay, cache/media/editor closure, safe navigation,
   continued global sign-in, and reuse of the already-loaded Quincy asset/annotation URLs yielding
   403 rather than cached content.
7. Re-add the membership and prove old-cycle notification is not delivered and no missed-event
   backfill appears.
8. Change role and separately deactivate while the target tab is open; verify all sessions end and
   the complete principal cache clears. Reactivate and verify no automatic session/backfill.
9. Recheck Photographer and internal Editor regression flows.

Save Agy's action log, screenshots, API evidence, and exact fixture cleanup record in the established
QA evidence location. No real studio project/user is used for mutation.

## Deployment preflight and rollout

### Preflight

Before migration/deploy:

1. Rebase/branch from current `main`; confirm TB4D versions and no overlapping auth/projection work.
2. Confirm fresh-Sol and Opus plan approvals are recorded, then build/diff reviews and the full gate
   are complete.
3. Query production `d1_migrations`; stop unless tail is `0035` and next is `0036`.
4. Query count only: `user.role='external_editor'` must be zero before migration. Do not create one
   to test production.
5. Create/checksum the pre-migration D1 recovery export in the parent `db-recovery/` workspace and
   record the path/hash in this plan.
6. Verify migration `0036` is the exact three additive columns, two upload tables and three indexes,
   local upgrade/fresh proofs are green, second generation is no-op, and visible-scope query plans
   use existing membership indexes.
7. Provision background-only `CLOUDFLARE_ZONE_ID` and secret
   `CLOUDFLARE_CACHE_PURGE_TOKEN`, limited to Cache Purge on that zone; validate credentials without
   purging, confirm both are absent from app/web bindings/logs, verify/configure the incomplete-
   multipart bucket lifecycle rule to abort uploads after seven days (record configuration evidence),
   and verify the
   known-session expiry/recovery sweep configuration. Lifecycle reclamation is a preflight
   configuration check, not an automated Miniflare assertion.
8. Record current background/app Worker rollback version IDs and Queue/cron health. Webhook ingress has no
   TB4E change.
9. Confirm consumer compatibility: new background understands both old epoch-zero internal rows and explicit
   external policies before an app can write/assign the new role.

### Rollout order

1. Apply D1 migration `0036`. It is additive; old Workers ignore the nullable fields/tables and use
   epoch defaults of zero.
2. Deploy **background Worker first**. Verify Queue consumption, epoch-zero internal notification
   paths, dormant cache-purge job, and non-mutating upload-sweep scan.
3. Do not redeploy webhook ingress when its artifact/config is unchanged; the repository's general
   background → webhook-ingress → app binding rule is satisfied because no binding change exists.
4. Deploy **app Worker second**. This is the first artifact capable of accepting the new role,
   serving strict external projections, and selecting the no-transform/no-store branch for an
   External principal. Existing internal signed-transform behavior remains compatible.
5. Do not provision or convert a production user to External Editor. TB4E rollout proves the boundary
   is installed; the first account remains a separate post-acceptance Admin decision.

### Passive production verification

Using existing internal accounts and read-only/admin-safe diagnostics only:

- verify migration tail `0036`, production/auth/conversion/outbox epoch columns, exact upload tables/
  indexes, FK check, and quick check;
- verify the external-role user count remains zero;
- verify Admin/Photographer/Editor project lists, detail, media, Collaboration, notifications, and
  Deadline/checklist paths have no regression;
- verify background Queue/outbox/ledger health and no new suppression/failure spike;
- verify `/api/project-access-snapshot` returns correct internal principal scope without sensitive
  fields and bounded refresh does not loop;
- verify existing internal cold-transform/durable media behavior has no regression, invalid/expired/
  nonexistent transform bearers stay uniform 404, and no internal response is accidentally switched
  to an External DTO;
- inspect Worker logs only for bounded IDs/error codes—no private payloads;
- record deployed version IDs and passive evidence. No external role conversion, membership change,
  notification injection, or real-project mutation is part of production verification.

### Documentation closeout

Only after migration, deploy, passive verification, and acceptance are complete:

- update this Status with merge/commit, migration proof/export hash, Worker IDs, rollback IDs, review
  sequence, full gate, QA evidence, and the explicit fact that zero production External Editor
  accounts were provisioned during rollout;
- move this file with `git mv` to `docs/plans/implemented/`;
- update `docs/todo.md`, `docs/lessons.md` for any real auth/privacy/D1 discovery, and both
  `AGENTS.md`/`CLAUDE.md` if a mirrored rule changes.

## Rollback and fix-forward

### App/projection/authorization fault

- Freeze External Editor provisioning/conversion immediately.
- Because rollout requires zero production External users, roll the app back to the recorded TB4D
  version while leaving every additive `0036` column/table in place; old code ignores them. Rollback
  is forbidden after any External account exists because TB4D does not
  understand that role or its projection—not because TB4E changed internal bearer behavior.
- If any External role row exists despite the gate, do **not** roll back to code that rejects or
  misinterprets it. Deactivate/revoke that explicitly authorized test account if applicable, suppress
  pending delivery, and forward-fix or deploy a reviewed compatibility build.
- Preserve audit, memberships, production notes, and media. Never convert external users to internal
  Editor as a rollback shortcut.

### Consumer/notification fault

- Stop app-side provisioning/role conversion and Queue publication if necessary; retain outbox rows.
- Roll background back only if no External recipient rows can exist. Otherwise deploy a forward fix
  that suppresses unknown/external content by default.
- Suppress affected pending ledger channels with bounded reason; never send redacted placeholders or
  replay them after privacy is restored. Delivered history remains immutable.

### Schema/migration fault

- All `0036` columns and upload tables are additive/data-retaining. Roll application code back and
  leave them; do not drop/rebuild existing tables or delete retained upload-session audit state.
- Use the recovery export only for catastrophic D1 recovery under a separately reviewed procedure,
  not ordinary rollback.
- Correct schema metadata with a forward migration if required; never rewrite an applied migration.

### Privacy incident

- Treat any unassigned project ID, hidden field, provider datum, notification, cache residue, or
  differentiated existence error as Blocking.
- Freeze first-account provisioning; revoke affected sessions; suppress pending content; preserve
  logs/audits; capture the exact route/type/cycle; patch the shared scope/projection rather than a
  React component.
- Add the incident fixture to the permanent projection/authorization regression gate before
  redeployment.

### Transform purge exhaustion runbook

- The asynchronous full-zone purge is the sole control for the residual already-cached-edge-HIT
  window after conversion.
- A bounded retry exhaustion records the retry count and deadline, freezes External Editor
  provisioning/conversion, and pages the operator. Do not unfreeze or provision another External
  Editor until an operator performs and records a manual Cloudflare zone purge, verifies the purge
  response and the affected zone, and confirms the signed principal/epoch source route remains
  revoked. The role/session epoch transition itself is never rolled back to wait for the purge.

## Opus scrutiny points

Fresh-Sol round 1 approved archive/restore suppression, External impersonation for QA, and the
minimal internal `productionNotes` control. It also approved the direction for conditional
`project.details.changed`, atomic pending-delivery suppression, and no extra membership index; this
revision makes those three exact through the shared projector, winner/status/cycle SQL, and mandatory
prod-shaped `EXPLAIN` stop gate. They are no longer open builder choices.

Sol round 2 affirmed the prior repairs. Opus plan-tier revert 1 of 2 then returned three Blocking,
seven Should-fix, and one Nit; this fresh-Sol revision folds all eleven while leaving Opus-affirmed
inventories, scope/oracle, epoch placement, DTO field coverage, and additive migration discipline
intact. With Sol rounds exhausted, fresh Opus should scrutinize these consequences:

1. **Transform revocation:** confirm the principal/epoch-bound signature, 120-second source-fetch
   TTL, one-read fail-closed verification, and one-batch conversion eliminate replay re-caching.
   Scrutinize the retained asynchronous full-zone purge—especially the residual pre-purge edge-HIT
   interval, credential isolation, bounded retry/alert, and whether a documented cache upper bound
   would permit removing it later.
2. **Authorization epoch:** confirm `user.authorization_epoch` plus the producer-stamped outbox
   epoch (nullable for legacy rows, which fail closed for External) and final lease-fenced equality
   check establishes the intended delivery linearization across both preserved-membership role
   directions.
3. **Opaque upload recovery:** confirm the same-origin `env.MEDIA` binding proxy, internal token
   hash/R2 fields, session/part lease CHECKs, HEAD-first `resumeMultipartUpload` recovery, known-
   session expiry sweep, bucket lifecycle handling of untracked create-before-D1 orphans, and
   immutable-media boundary without turning either upload table into an authorization source.
4. **Dual notification convergence:** confirm every legacy type classification, the rule that generic
   direct delivery always excludes External recipients, the three new durable event types, the
   identical five-operation visibility CTE, and the choice to suppress all unsent delivery on every
   global role transition.
5. **Normative DTOs:** check every key/select/join and strict outer response/client decoder, especially
   comment pagination and `editedUploadAvailable`. Any missing field requires an explicit plan-tier
   amendment; no implementation-time “necessary field” escape hatch exists.

## Acceptance checklist

### Role, schema, and assignment

- [ ] Global `external_editor` exists with exact label and exact nine capabilities.
- [ ] `moveProjectStage`/`viewProductionCalendar` remain deferred and absent.
- [ ] `role_on_project` remains two values; External is eligible only for Editor slot.
- [ ] Role/annotation enum widening creates no role migration or table rebuild.
- [ ] Migration `0036` has the exact three additive columns, two recoverable opaque-upload tables and
  three indexes; internal notes are not copied and no existing table is rebuilt.
- [ ] Active/inactive candidate and membership behavior matches the contract.

### Server authorization and privacy

- [ ] Every list/search/suggestion/count/filter/detail/deep-link/resource route uses shared server
  scope; no browser-only authorization remains.
- [ ] External assigned active/delivered projects work at all Stages; unassigned/archived projects do
  not appear and direct probes match nonexistent errors.
- [ ] Every External-reachable DTO uses explicit allowed-column query plus the shared projection.
- [ ] Every External list/mutation has a strict outer schema and role-aware client decoder; comment
  pagination validates `{project,comments,nextCursor?}` and unknown keys fail closed.
- [ ] Every included field and every excluded field is covered by sentinel tests.
- [ ] Participant email is project-scoped; no staff directory/Notice Board/Admin/provider surface is
  reachable.
- [ ] Hard-coded role checks in media/review/upload paths are capability-driven and least-privilege.
- [ ] Generated Hono route manifest has no unclassified registration; existing/invisible/nonexistent/
  trailing-slash probes cover capability-withheld routes, asset delete, and transform source.
- [ ] External media is session-rechecked/no-store, transform bearers are not issued to External
  principals, annotation is no-store, and reused Quincy URLs fail after membership/session revocation.
- [ ] `editedUploadAvailable` is the sole all-role Workspace gate and reveals no Dropbox value.
- [ ] External upload uses only same-origin Quincy create/streamed-part/complete/abort requests,
  returns no provider URL/topology/identifier, and recovers/aborts every injected crash boundary.

### Lifecycle, notifications, and freshness

- [ ] Role transitions revoke all sessions/audit and enforce named membership blockers.
- [ ] Every outbox row carries the selected recipient epoch; final admission equality suppresses a
  consumer leased before both `editor→external_editor` and `external_editor→editor` epoch bumps.
- [ ] Conversion to External uses the one-batch guarded role/epoch/session/suppression command,
  inserts exactly one winner-gated purge job, and a captured old source URL fails after purge without
  re-caching; there are no transition-state/retry/cancel user flows.
- [ ] Deactivation preserves history/memberships but blocks auth/assignment/pending delivery; no
  reactivation backfill.
- [ ] Final External membership removal warns, atomically cleans/suppresses, and does not globally
  sign out.
- [ ] Every registry and legacy notification type has an explicit allowed/suppressed External policy;
  generic direct emission excludes External recipients and suppressed events produce no row/email.
- [ ] Allowed broad/targeted/Deadline delivery uses current assignment cycle, safe payload, and
  send-time reauthorization; broad email remains off.
- [ ] Notification list/count/read/delete/read-all share the identical fail-closed current-cycle CTE.
- [ ] Role/deactivation/membership winner markers gate exact pending/queued suppression; processing
  races recheck cycle/role/epoch in the final lease-fenced admission and delivered history is retained.
- [ ] Membership loss purges exactly the inaccessible project/Calendar-family/private media caches,
  closes project UI, and navigates safely on the next bounded signal.
- [ ] Role/deactivation loss clears the whole principal cache and signs out.

### Proof and rollout

- [ ] Migration fresh/upgrade/no-op/query-plan proofs are recorded.
- [ ] Typecheck, web build, all workspace tests, explicit shared suite, audits, and focused suites pass.
- [ ] Agy's local role-matrix QA and regression evidence pass without Google OAuth or real data.
- [ ] Recovery export/hash and rollback Worker IDs are recorded.
- [ ] Background deploy precedes app; webhook is unchanged; External media never issues a bearer;
  internal media remains compatible; purge credential/job, incomplete-multipart lifecycle, and
  known-session upload sweeps are configured; passive
  production verification passes without executing a real conversion.
- [ ] Production External Editor count remains zero throughout TB4E rollout.
- [ ] Only after all above is the security boundary accepted and first-account provisioning eligible
  for a separate explicit Admin decision.

## Expected implementation footprint

Likely touched files/modules (builder must refine from source, not treat this as permission to miss a
surface):

- `portal/packages/shared/src/capabilities.ts`, `project-members.ts`, `project-activity.ts`, shared
  role labels/types, plus new `external-project-policy.ts`, `external-notification.ts`,
  `external-project-dto.ts`, `external-upload.ts`, their barrel exports, and exhaustive shared tests;
- `portal/packages/db/src/schema.ts`, `notifications.ts` compatibility re-export/generic-recipient
  exclusion, migration `0036`, journal/snapshot, and migration/schema tests;
- `portal/packages/db/src/project-activity.ts` recipient SQL;
- new `portal/workers/app/src/lib/visible-project-scope.ts`, `external-project-query.ts`,
  `external-notification-visibility.ts`, External upload proxy/streaming helpers, plus project-
  members/user-lifecycle/activity helpers;
- app middleware/session/auth/impersonation and routes: projects, media, review, annotations,
  collections, uploads, assets, project deadline/subtasks/comments, mentionable users,
  notifications, users, Admin/integration capability boundaries, `index.ts` route mounting, generated
  `registered-route-manifest.ts`, and route tests;
- `portal/workers/background/src/notification-delivery.ts`, direct workflow/AutoHDR/checklist due
  producers, Deadline/assignment/mention recipient paths, fire-and-forget conversion purge job,
  multipart expiry/completion recovery sweep, config/secrets, and background tests;
- web role/Admin/ProjectFields/Team/Collaboration/comment/assignee/upload components, project DTO/
  query modules, new `external-api-response.ts` and `dashboard-projects.ts`, Query provider/runtime,
  Dashboard/Workspace access-loss handling, and tests;
- `docs/todo.md`, `docs/lessons.md` only at implementation closeout if warranted; this plan moves to
  `implemented/` only after verified production deployment.
