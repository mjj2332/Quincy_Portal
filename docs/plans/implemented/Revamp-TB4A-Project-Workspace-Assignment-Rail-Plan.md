# Revamp TB4A — Project Workspace Assignment Rail Plan

**Status:** BUILT AND VERIFIED, awaiting deploy decision (2026-08-26). Plan: 2 Sol review rounds + fix passes, 1 Opus plan-tier revert + fix pass, Opus final plan approval. Build: Luna build, Sol diff review (3 Blocking/2 Should-fix) + fix round, Sol final-focused pass (2 Blocking) + fix round, Sol final verification pass (2 lower-severity Blocking) + fix, Opus final-draft review (2 Blocking/1 Should-fix/4 Nit) + fix round — all findings resolved, verified independently by the orchestrating session outside Luna's sandbox after every round. Full verify sequence green: typecheck (6 workspaces), `apps/web` build, `apps/web` 288 tests, `workers/app` 210 tests/1 skipped, `workers/background` 207 tests, `packages/db` 42 tests, `packages/shared` 62 tests, `webhook-ingress` 13 tests. No migration required (confirmed true throughout). Deployment revised to a single canonical rollout (no separate compatibility Edit-page stage — see "Create/Edit rollout and project PATCH" below). Not yet committed or deployed — awaiting user go-ahead per `docs/Subagent-Orchestration.md` §2 policy 7.

## Authority and outcome

Authority order for this plan is:

1. [`Decision-Sheet.md` D-18](../Decision-Sheet.md), which makes the Project Workspace rail
   canonical for Stage, Deadline/reminders, Photographers, and Editors while retaining
   `editProject` for roster writes.
2. [`Implementation-Plan.md` A11](../Implementation-Plan.md), especially its exact eligibility,
   inactive-member, final-compatible-role, and membership-cycle rules.
3. The approved [TB4A roadmap brief](./revamp_2026_portal/roadmap/TB4A-Project-Workspace-Assignment-Rail.md).
4. The settled [notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md),
   which defines targeted assignment as one durable role-specific event and removal as audit-only.
5. Current `main`, at planning base `6a2ad3d`, re-verified directly as recorded below.

The primary user outcome is: **an authorized coordinator can add or remove one Photographer or
Editor from the canonical Project Workspace rail without a stale full-list write overwriting any
other person's or role's current membership.**

TB4A also establishes the complete operational-first rail shell. Stage remains read-only until
TB5A. Deadline and next-reminder rows are honest inactive placeholders until TB4B. Collaboration
continues to own checklist/subtasks and discussion; it does not acquire project-level controls.

### Implementation precondition

TB4 and the confirmation-modal/admin-impersonation feature are deployed on current `main`, and
`docs/todo.md` records migration 0032 as applied. Implementation starts from a fresh branch off the
then-current `main`, records that commit and the current app/background Worker versions, and
rechecks this plan against any intervening TB4 consumer or Project Workspace change. No work enters
`prototype/`.

## Verified current state

All claims in this section were checked against source during this drafting run. Where the
2026-08-24 audit is stale, this section says so.

### Runtime and shared authority

- Current installed runtime is React `19.2.8`, not the React 18 baseline still stated in
  `CLAUDE.md`: [`portal/package.json`](../../portal/package.json) pins React/React DOM 19.2.8 and
  `docs/todo.md` records TB0A as deployed. This discrepancy has no TB4A scope consequence.
- Shared roles remain exactly `admin | photographer | editor` in
  [`capabilities.ts` lines 7–8](../../portal/packages/shared/src/capabilities.ts#L7).
- Only Admin currently has `editProject`; internal Editor has `viewAllProjects` but not
  `editProject`, and Photographer has neither
  ([`capabilities.ts` lines 51–107](../../portal/packages/shared/src/capabilities.ts#L51)). TB4A
  keeps capability authorization rather than hard-coding Admin, so a later approved coordinator
  role can reuse the same routes.
- There is no existing shared project-assignment eligibility helper. `@quincy/shared` is the
  repository authority for roles/capabilities, so TB4A adds the small role-to-slot eligibility
  primitive there instead of duplicating arrays in the Worker and web app.

### Membership rows, cycles, and checklist assignments

- `project_members` already has one UUID primary key per membership row, role values
  `photographer | editor`, and a unique key on `(project_id, user_id, role_on_project)`
  ([`schema.ts` lines 191–207](../../portal/packages/db/src/schema.ts#L191)). A person can therefore
  hold both project roles as two independent rows.
- That existing row UUID is already Quincy's occurrence-cycle precedent: TB4 snapshots
  `project_members.id` values and rejects remove/re-add inheritance. TB4A therefore defines a
  **membership cycle** as the lifetime of one exact `project_members` row, identified by its `id`:

  ```text
  add role -> new project_members.id = cycle C1
  remove C1 -> C1 ends permanently
  re-add same person/role -> new id = cycle C2; C1 != C2
  ```

  No timestamp, project-wide version, or new version column is introduced.
- `project_subtasks` has one nullable `assignee_id` plus integer `assignment_version`
  ([`schema.ts` lines 252–270](../../portal/packages/db/src/schema.ts#L252)). Assignment changes
  already increment that version.
- The current full-roster helper derives removals from a caller snapshot, batches role inserts and
  deletes, and clears subtask assignments only when the person's final membership is gone and they
  are not an active Admin
  ([`project-members.ts` lines 51–112](../../portal/workers/app/src/lib/project-members.ts#L51)).
  It is atomic, but it cannot report an exact-cycle stale delete: it currently reports every
  snapshot-derived removal even if the `DELETE project_members.id = ?` changed zero rows.
- Global-role changes update the `user` row without cascading membership cleanup
  ([`users.ts` lines 57–66](../../portal/workers/app/src/routes/users.ts#L57)). Combined with truthful
  idempotent PUT of an existing membership, a residual row that is no longer globally eligible for
  its project slot is reachable state, not merely corrupted data.

**Helper decision:** replace the full-roster sync API with role-delta primitives in the same
`project-members.ts` module, preserving its proven D1-batch and final-membership/active-Admin
predicates. Keep a bulk initial-member statement builder for inclusion in Create Project's one
domain batch; it must not execute a later independent membership batch. Do not wrap
`syncProjectMembersAndClearSubtaskAssignments()`: its stale full-snapshot input is the architecture
TB4A is retiring, and retaining it would leave an attractive route back to roster overwrites.

### Current project routes and notification producer

- `POST /projects` and `PATCH /projects/:id` share a schema that accepts
  `photographerUserIds[]` and `editorUserIds[]`
  ([`projects.ts` lines 20–23](../../portal/workers/app/src/routes/projects.ts#L20)). Create inserts
  the project, collections, then memberships and calls `notifyProjectAssignments()`
  ([`projects.ts` lines 228–244](../../portal/workers/app/src/routes/projects.ts#L228)).
- `PATCH /projects/:id` reads both role snapshots, submits the full desired arrays to the sync
  helper, then writes one broad `project.update` audit and calls the same direct assignment helper
  ([`projects.ts` lines 289–367](../../portal/workers/app/src/routes/projects.ts#L289)). It does not
  validate membership target active/global-role eligibility server-side.
- Existing 403/404 ordering is privacy-preserving: validate the project ID, check ordinary project
  access, check `editProject`, then return 404 only to an authorized principal when the project
  does not exist ([`projects.ts` lines 289–296](../../portal/workers/app/src/routes/projects.ts#L289)).
  TB4A's role routes match that order.
- `notifyProjectAssignments()` reloads active users, separates role-specific copy, and invokes the
  existing `emitNotifications()` path
  ([`notifications.ts` lines 43–81](../../portal/workers/app/src/lib/notifications.ts#L43)). It has
  no `sourceKey`, outbox, or delivery ledger. This is a current-main change relative to the settled
  durable architecture, not a reason to invent a second mechanism.
- TB4's deployed outbox/ledger schema is deliberately event-extensible, but the current shared
  constant and background payload parser accept only `project.comment.mentioned`
  ([`notification-outbox.ts` lines 1–9](../../portal/packages/shared/src/notification-outbox.ts#L1),
  [`notification-delivery.ts` lines 63–88 and 133–148](../../portal/workers/background/src/notification-delivery.ts#L63)).
  TB4A extends this discriminated consumer for one new targeted assignment event; it does not add a
  parallel Queue or table.

### Current rail, Edit/Create surfaces, and collaboration fallback

- The 2026-08-24 audit remains correct that the current rail renders only Photographer rows. Source
  filters `project.members` to Photographers and renders the current order as header → Agency/Agent/
  Shoot/Stage → Photographers → Collections → Dropbox
  ([`ProjectWorkspace.tsx` lines 368–400](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L368)).
- At widths up to 1080px the current rail already stops being sticky and becomes a full-width block
  above the workspace ([`app.css` lines 748–753](../../portal/apps/web/src/styles/app.css#L748)).
  TB4A refines this into the named Project Overview shell rather than introducing a second mobile
  surface.
- `ProjectFields` fetches the broad Admin `/api/users` registry, computes Photographer candidates as
  Photographer/Editor/Admin and Editor candidates as Editor/Admin, and keeps inactive selected users
  visible ([`ProjectFields.tsx` lines 64–77](../../portal/apps/web/src/components/ProjectFields.tsx#L64)).
  Create and Edit both render that component.
- Edit serializes both full membership arrays in its normal project PATCH
  ([`EditProject.tsx` lines 20–32 and 68–80](../../portal/apps/web/src/screens/EditProject.tsx#L20)).
  Create posts the selected initial arrays once
  ([`CreateProject.tsx` lines 29–40](../../portal/apps/web/src/screens/CreateProject.tsx#L29)).
- Ordinary workspace access and collaboration access are intentionally different. `hasProjectAccess`
  grants `viewAllProjects` or a membership subject to the Photographer Stage gate, while
  `hasProjectCollaborationAccess()` grants active Admin or any explicit membership regardless of
  Stage ([`capability.ts` lines 18–45](../../portal/workers/app/src/middleware/capability.ts#L18)).
- A Stage-hidden member currently falls back to a standalone collaboration-only page containing
  only the street and Collaboration panel; it mounts no rail
  ([`ProjectWorkspace.tsx` lines 297–319](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L297)).
  The comments probe exposes only `{id, street}`
  ([`project-comments.ts` lines 41–70](../../portal/workers/app/src/routes/project-comments.ts#L41)).
  TB4A deliberately extends this fallback with a separate presentation-safe summary read; it does
  not weaken `GET /projects/:id`, mount assets, or broaden ordinary workspace access.
- The real collaboration-loss purge is `purgeProjectCommentData()`: it first bumps the
  QueryClient/project-scoped `commentDataGenerations` counter and resets both comment read-state
  sequence maps, then cancels and removes `commentsRoot`
  ([`project-comments.ts` lines 63–85 and 254–260](../../portal/apps/web/src/lib/project-comments.ts#L63)).
  `ProjectWorkspace` calls it when `collaborationUnavailable` becomes true
  ([`ProjectWorkspace.tsx` lines 241–244](../../portal/apps/web/src/screens/ProjectWorkspace.tsx#L241)).
  The parent `isCurrent()` predicate does not include `collaborationUnavailable`, so TB4A must extend
  this real generation fence; it cannot rely on a generic project-generation guard that does not
  exist for this transition.
- Project detail uses `staleTime: 15_000`, a `30_000` ms interval while its key is not mutation-
  owned, `refetchIntervalInBackground: false`, and focus/reconnect refetch while unowned
  ([`project-data.ts` lines 95–103](../../portal/apps/web/src/lib/project-data.ts#L95)). Project
  comments independently confirm the same 15-second stale/30-second visible polling cadence and
  background-tab pause
  ([`project-comments.ts` lines 157–171](../../portal/apps/web/src/lib/project-comments.ts#L157)).
  Query defaults alone do not provide this bounded refresh.
- `SubtaskChecklist` currently commits its manual checklist and assignee GET results directly to
  component state after `await`, with no collaboration-generation check
  ([`SubtaskChecklist.tsx` lines 103–115](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L103)).
  TB4A includes that local completion path in the same extended collaboration fence.

### Confirmation, audit, routing, and D1 lessons applied

- The shipped confirmation seam is `confirm(options): Promise<boolean>`
  ([`confirm.ts` lines 1–46](../../portal/apps/web/src/lib/confirm.ts#L1)); its singleton host uses a
  real, focus-managed DOM dialog with stable test IDs
  ([`ConfirmDialog.tsx` lines 10–22](../../portal/apps/web/src/components/ConfirmDialog.tsx#L10)).
  TB4A uses this seam and introduces no native `window.confirm()`.
- Batched/direct audit metadata must use `auditMeta()` so an impersonated request retains
  `metaJson.impersonatedBy` ([`audit.ts` lines 5–25](../../portal/workers/app/src/lib/audit.ts#L5)).
- [`docs/lessons.md` lines 64–69](../lessons.md#L64) records that a producer must inspect its own
  affected-row result rather than infer success from a sibling statement, and
  [`lines 228–236`](../lessons.md#L228) records that a wrapped D1 UNIQUE error may live in the cause
  chain. TB4A avoids exception-string idempotency entirely: `ON CONFLICT DO NOTHING RETURNING` is
  the add authority.
- The router-wide Hono leak rule applies: no `projectsRoutes.use("*", ...)` is added. The trailing-
  slash gate-bypass rule does **not** require duplicate registrations for these new routes: they are
  ordinary application routes behind the parent `/api/*` session/origin middleware, with no
  permissive wildcard proxy behind them. A trailing-slash variant may 404; it cannot bypass a gate.
  Tests must prove that conclusion rather than assume it. These rules are the production incidents
  recorded at [`docs/lessons.md` lines 116–123](../lessons.md#L116) and
  [`lines 786–799`](../lessons.md#L786).

## Scope constraints

### In scope

- Establish the approved rail order and responsive Project Overview shell.
- Add separate adaptive Photographer and Editor rosters with immediate role-specific controls.
- Add exact role eligibility queries and a narrow candidate API; inactive current members remain
  truthful/removable but are never new candidates.
- Add idempotent single-role PUT and exact-cycle DELETE routes.
- Preserve another role and make different person/role operations commute at the database and UI
  merge seams.
- Warn before a final compatible role removal that would clear checklist assignments, and perform
  the exact delete plus assignment clear atomically after confirmation.
- Write exactly one audit for each database-confirmed membership insert/remove and none for no-op or
  conflict paths.
- Cut targeted assignment from the legacy direct helper to TB4's outbox/Queue/ledger only for newly
  inserted membership cycles; removals create no notification.
- Retain Create Project initial team selection and make the canonical Project Workspace rail the
  sole routine owner of team membership controls; Edit remains a detail/lifecycle form only.
- Make Create Project one conditional atomic D1 domain batch so a candidate eligibility race or any
  statement failure leaves no partial project, collection, membership, audit, outbox, or ledger
  residue; trigger external work only after commit.
- Give a Stage-hidden collaborator a presentation-safe read-only summary without granting ordinary
  project access.
- Add focused API/domain/background/UI coverage, matched visual evidence, local mutating QA, passive
  production verification, and explicit rollback checkpoints.

### Hard non-goals

- **No Deadline schema, scheduler, mutation, real due value, or reminder calculation.** TB4A renders
  only an honest inactive `Deadline — Not scheduled` / `Next reminder — None` slot for TB4B.
- **No Stage mutation.** The rail reads presentation-safe Stage only. Existing Stage routes remain;
  `moveProjectStage` belongs to TB5A.
- **No broad user-registry surface.** The existing Admin `/api/users` remains Admin management. The
  new candidate read returns only assignment-eligible active people and only to an authorized
  assignment coordinator.
- **No External Editor role, authorization, projection, session lifecycle, or candidate.** TB4E will
  extend only the Editor eligibility set and reuse the exact role route/cycle/outbox contract. The
  same picker/removal seam must let TB4E add its explicit “will immediately lose project access”
  warning for a final External Editor membership without changing this API; TB4A does not render or
  authorize that warning now.
- No pipeline configuration, Calendar, checklist scheduling/ranges, broad Editor activity registry,
  broad team-change notification, Kanban, dnd-kit, or Collaboration ownership change.
- No permanent duplicate team controls in Collaboration or Edit Project.
- No project-wide membership version, roster ETag, new Queue, new notification table, or second
  assignment producer.

## Exact contracts

### Shared eligibility and DTOs

Add to `@quincy/shared`:

```ts
export const PROJECT_MEMBER_ROLES = ["photographer", "editor"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const PROJECT_ASSIGNMENT_ELIGIBLE_ROLES = {
  photographer: ["photographer", "editor", "admin"],
  editor: ["editor", "admin"],
} as const satisfies Record<ProjectMemberRole, readonly Role[]>;

export function isProjectAssignmentEligible(
  roleOnProject: ProjectMemberRole,
  globalRole: Role,
): boolean;
```

TB4E later adds `external_editor` only to `PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor`; it does not
fork route names, project-role values, membership DTOs, or outbox event type.

The full-workspace member projection becomes:

```ts
type ProjectMembershipDto = {
  id: string; // exact project_members.id membership cycle
  userId: string;
  roleOnProject: "photographer" | "editor";
  name: string;
  email: string;
  globalRole: Role;
  active: boolean;
  assignedSubtaskCount: number;
};
```

`details()` obtains the count with one grouped query, not a correlated scalar subquery:

```sql
SELECT assignee_id AS userId, count(*) AS assignedSubtaskCount
FROM project_subtasks
WHERE project_id = ? AND assignee_id IS NOT NULL
GROUP BY assignee_id;
```

It joins that map onto every membership. A dual-role person receives the same current count on each
row; the UI warns only when removing their final compatible row.

### Candidate read

Add `GET /project-assignment-candidates` to `workers/app/src/routes/projects.ts` on the existing
`projectsRoutes` router. It is mounted under `/api` by the current
`api.route("/", usersRoutes).route("/", projectsRoutes)...` chain in
`workers/app/src/index.ts`; do not create a second top-level router or mount. The handler requires
either `createProject` or `editProject`; otherwise 403
`{ error: "Forbidden", capability: "editProject" }`. It returns 200:

```ts
type ProjectAssignmentCandidatesResponse = {
  photographers: Array<{
    id: string; name: string; email: string; globalRole: Role; active: true;
  }>;
  editors: Array<{
    id: string; name: string; email: string; globalRole: Role; active: true;
  }>;
};
```

Use two explicit shared-constant-backed Drizzle queries, ordered by case-folded name, then email and
ID for stable rendering:

```ts
db.select({
  id: schema.user.id,
  name: schema.user.name,
  email: schema.user.email,
  globalRole: schema.user.role,
  active: schema.user.active,
}).from(schema.user).where(and(
  eq(schema.user.active, true),
  inArray(schema.user.role, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.photographer),
)).orderBy(sql`lower(${schema.user.name})`, sql`lower(${schema.user.email})`, schema.user.id);

// Editor query is identical except for PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor.
```

This is not a renamed `/users`: it omits inactive/non-eligible people, timestamps, Admin controls,
and every user-management operation. Current inactive assignees come from project detail, not this
candidate response.

### Role mutation routes

Register these four bare paths in `projects.ts`:

```text
PUT    /projects/:projectId/photographers/:userId
DELETE /projects/:projectId/photographers/:userId
PUT    /projects/:projectId/editors/:userId
DELETE /projects/:projectId/editors/:userId
```

Use one internal route factory mapping URL segment to `roleOnProject`; do not duplicate policy. For
every route:

1. validate both IDs as UUIDs; invalid input is 400;
2. call `hasProjectAccess(c, projectId)` and return the existing non-disclosing 403
   `{ error: "Forbidden: you are not assigned to this project" }` on failure;
3. require `editProject` and return 403 `{ error: "Forbidden", capability: "editProject" }`;
4. load the project; an authorized request for an unknown project is 404
   `{ error: "Project not found" }`;
5. load/validate the target user as specified below; an unknown target is 404
   `{ error: "User not found" }`.

No route-level wildcard middleware is added. Do not register trailing-slash aliases: there is no
permissive wildcard fallback to protect, and a slash variant must remain a terminal 404 rather than
an alternate contract.

#### PUT add

Request body: none. Success response:

```ts
type PutProjectMembershipResponse = {
  outcome: "created" | "unchanged";
  membership: ProjectMembershipDto;
};
```

- **201** with `outcome: "created"` only when this request inserted the exact role row.
- **200** with `outcome: "unchanged"` when the same `(project,user,role)` already exists. Return its
  current canonical row even if the user has since become inactive/ineligible; idempotency must not
  turn an already-present truthful membership into an error.
- If no row exists, the target must be active and globally eligible for that slot at the guarded
  INSERT itself. An existing but inactive/ineligible target returns **422**:

  ```json
  { "error": "User is not eligible for this project role", "code": "ineligible_project_member", "roleOnProject": "photographer" }
  ```

The insert is `INSERT ... SELECT FROM user WHERE active=1 AND role IN (...) ON CONFLICT DO NOTHING
RETURNING ...`; do not use check-then-insert or parse a UNIQUE exception. Concurrent PUTs therefore
produce one 201 and one 200. Only the winner creates one membership audit, one assignment outbox,
and two delivery-ledger rows. The no-op creates none and schedules no Queue publication.

#### DELETE exact-cycle remove

After the two path UUIDs pass syntax validation, parse the method-specific body with `jsonInput()`
and this strict schema; then preserve the common access-before-project/target-existence ordering
above. Missing/malformed JSON, unknown keys, and wrong field types are 400:

```ts
const deleteProjectMembershipInput = z.discriminatedUnion("clearSubtaskAssignments", [
  z.object({
    membershipCycle: z.string().uuid(), // ProjectMembershipDto.id currently rendered to the human
    clearSubtaskAssignments: z.literal(false),
    confirmedAssignmentCount: z.literal(0),
  }).strict(),
  z.object({
    membershipCycle: z.string().uuid(),
    clearSubtaskAssignments: z.literal(true),
    confirmedAssignmentCount: z.number().int().nonnegative(),
  }).strict(),
]);
```

`confirmedAssignmentCount` binds the destructive retry to a server-verified checklist count, so a
different set of assignments than the count displayed by the client can never be silently cleared.
It does not prove that a human saw or accepted a dialog: any `editProject` holder can submit a
value, and the server enforces count agreement. An unconfirmed probe always sends
`{ clearSubtaskAssignments: false, confirmedAssignmentCount: 0 }`.

Success is **200**, deliberately not 204, because the approved contract requires an authoritative
per-person result:

```ts
type DeleteProjectMembershipResponse = {
  outcome: "removed";
  removed: {
    membershipCycle: string;
    userId: string;
    roleOnProject: "photographer" | "editor";
  };
  subtaskAssignmentsCleared: number;
};
```

The DELETE matches all four values: `id`, `project_id`, `user_id`, and `role_on_project`. If it
changes zero rows because the cycle was already removed or replaced, return **409**:

```ts
{
  error: "Project membership changed; refreshed current assignment";
  code: "membership_cycle_changed";
  requestedMembershipCycle: string;
  currentMembership: ProjectMembershipDto | null;
}
```

The client replaces only that `(userId, roleOnProject)` cell from `currentMembership`, refetches the
exact detail/collaboration-summary resources, keeps the picker open, and shows an inline conflict.
It never retries DELETE automatically with the new cycle. A human must act on the refreshed row.

If the exact cycle is current, no other **currently globally eligible** project-role row remains,
and the target has no active-Admin fallback, the server computes the current assignment count at the
DELETE batch's serialization point. With `clearSubtaskAssignments: false` and a nonzero current
count, or with `clearSubtaskAssignments: true` and a current count different from
`confirmedAssignmentCount`, return **422** without mutation:

```ts
{
  error: "Checklist assignment state changed; confirm final-role removal again";
  code: "subtask_assignment_confirmation_required";
  assignmentCount: number;
  currentMembership: ProjectMembershipDto;
}
```

After the real-DOM confirmation, retry the same cycle with `clearSubtaskAssignments: true` **and the
exact displayed count as `confirmedAssignmentCount`**. The guarded DELETE recomputes the count; a
change in either direction returns the same 422 shape with the new authoritative count and forces a
fresh confirm-and-retry cycle. If the cycle changed while the dialog was open, the exact DELETE
returns 409. If another role row remains whose project role is compatible with the target's
**current global role**, or the target is an active Admin, no assignment is cleared and no
confirmation is required. Thus a still-eligible Photographer/Editor counterpart preserves
assignments, while a stale membership row made ineligible by a later global-role change does not.
The last serialized removal of the final currently compatible role is the only operation that can
clear assignments.

No DELETE success emits an assignment notification. A successful remove writes one
`project.member.remove` audit; 409/422/no-op paths write none.

### Atomic membership helpers and exact SQL behavior

In `project-members.ts`, replace the snapshot-sync exports with:

```ts
addProjectMemberWithAssignmentIntent(...): Promise<{
  created: boolean;
  membership: ProjectMembershipDto;
  notificationOutboxIds: string[];
}>;

removeProjectMemberCycle(...): Promise<
  | { outcome: "removed"; subtaskAssignmentsCleared: number }
  | { outcome: "stale"; currentMembership: ProjectMembershipDto | null }
  | { outcome: "confirmation_required"; assignmentCount: number; currentMembership: ProjectMembershipDto }
>;

buildInitialProjectMemberStatementTuples(...): {
  statements: D1PreparedStatement[];
  memberships: ProjectMembershipDto[];
  notificationOutboxIds: string[];
};
```

The initial-member function is a statement builder, not a separately executing helper: the Create
route must include its returned tuples in the one Create domain batch described below. It must not
open a second membership batch after the project/collections commit.

The single add batch contains, in order:

1. guarded `project_members INSERT ... SELECT ... ON CONFLICT DO NOTHING RETURNING` with a generated
   membership-cycle UUID;
2. a read-only exact-row/user-eligibility diagnostic SELECT used only after prioritizing the
   guarded INSERT's own returned row for classification;
3. `project.member.add` audit INSERT gated by existence of that generated membership ID, with
   `auditMeta(principal, { projectId, userId, roleOnProject, membershipCycle })`;
4. one `notification_outbox` INSERT for `project.assignment.created`, gated by the same ID;
5. `in_app` and `email` ledger INSERTs gated by outbox existence; and
6. a guarded `projects.updated_at` update.

Any failure rolls back membership, audit, outbox, both ledgers, and timestamp together. Classify the
request from that batch's own results: a row returned by the guarded INSERT means `created`; no
returned INSERT row plus an exact existing `(project,user,role)` row observed by a same-batch
diagnostic SELECT means `unchanged`; neither means the batch-observed ineligible/not-found route
result. A post-batch reload, if retained, may hydrate the full `ProjectMembershipDto`
(`name`/`email`/`globalRole`/`active`/`assignedSubtaskCount`) only after that classification is fixed;
it must never decide or rewrite `created`/`unchanged`/ineligible. Thus a membership removed after a
successful insert commits cannot make that request misreport the write that produced its audit,
outbox, and ledgers. The route calls `publishNotificationOutbox()` through
`c.executionCtx.waitUntil()` only for the returned new outbox ID, after the batch commits.

Both membership audit actions use `target_type = 'project_member'` and
`target_id = membershipCycle`. Their exact action/meta contracts are:

```text
project.member.add    { projectId, userId, roleOnProject, membershipCycle }
project.member.remove { projectId, userId, roleOnProject, membershipCycle }
```

`auditMeta()` adds `impersonatedBy` when applicable. There is no second broad `project.update` audit
for the same membership delta.

Build one `eligibleRemainingRoleSql` fragment from the shared
`PROJECT_ASSIGNMENT_ELIGIBLE_ROLES` constants and reuse it in the diagnostic read, DELETE guard,
and subtask-clear statement. Its semantic SQL is:

```sql
EXISTS (
  SELECT 1
  FROM project_members remaining
  JOIN user target ON target.id = remaining.user_id
  WHERE remaining.project_id = ?
    AND remaining.user_id = ?
    AND remaining.id <> ? -- omit only in the post-DELETE subtask statement
    AND (
      (remaining.role_on_project = 'photographer' AND target.role IN (<photographer eligible roles>))
      OR
      (remaining.role_on_project = 'editor' AND target.role IN (<editor eligible roles>))
    )
)
```

The bound role lists come from the shared constants; do not duplicate freehand role arrays in this
module. Deliberately do not count a merely existing row: if a global-role change makes that row
ineligible for its slot, it cannot preserve checklist assignments.

The remove operation is one D1 batch. Its first statements are read-only diagnostics that capture,
at the batch serialization point: (a) whether the requested exact cycle exists, (b) the canonical
current same-role membership DTO if any, (c) whether an eligibility-compatible other row remains,
(d) whether the target has the active-Admin fallback, and (e) the current project-subtask assignment
count. The following guarded DELETE uses the same predicates and this shape:

```sql
DELETE FROM project_members
WHERE id = ? AND project_id = ? AND user_id = ? AND role_on_project = ?
  AND (
    EXISTS (
      SELECT 1 FROM user
      WHERE id = ? AND role = 'admin' AND active = 1
    )
    OR <eligibleRemainingRoleSql including id <> requested cycle>
    OR (
      ? = 0 -- clearSubtaskAssignments
      AND NOT EXISTS (
        SELECT 1 FROM project_subtasks
        WHERE project_id = ? AND assignee_id = ?
      )
    )
    OR (
      ? = 1 -- clearSubtaskAssignments
      AND (
        SELECT count(*) FROM project_subtasks
        WHERE project_id = ? AND assignee_id = ?
      ) = ? -- confirmedAssignmentCount
    )
  )
RETURNING id;
```

Therefore `true` is not unconditional authority to clear: for a final compatible-role removal, the
current count must equal the submitted server-observed display count. A drift from 2→3, 2→1, or
2→0 all returns 422 with the newly observed count; none silently clears a set whose count differs
from the one bound to the retry.

Immediately after a successful exact DELETE, insert the `project.member.remove` audit using the
repository's adjacent `changes() = 1` pattern. Use its generated audit ID as the batch marker for the
subsequent subtask update and project timestamp update. The subtask statement is:

```sql
UPDATE project_subtasks
SET assignee_id = NULL,
    assignment_version = assignment_version + 1,
    updated_at = ?
WHERE project_id = ? AND assignee_id = ?
  AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
  AND NOT <eligibleRemainingRoleSql without the deleted-cycle exclusion>
  AND NOT EXISTS (
    SELECT 1 FROM user WHERE id = ? AND role = 'admin' AND active = 1
  )
RETURNING id;
```

Count that statement's own returned rows; do not infer from another batch result. If the guarded
DELETE returns zero, the batch has no marker and every later write is a no-op. Classify the response
**only from the diagnostic SELECT results returned by that same batch**: an absent/replaced exact
cycle is 409 with the batch-observed canonical same-role row; an exact cycle blocked because
confirmation is absent or its count mismatches is 422 with the batch-observed authoritative count.
Do not perform a post-batch reload to choose 409 versus 422. A normal client refetch may happen only
after the response is classified and cannot rewrite what was true at the DELETE serialization
point. Different people and roles do not share a project-wide fence, so successful operations
commute; the D1 batch serialization plus current global-role eligibility, active-Admin, and count
predicates decide which final-compatible-role removal, if any, clears tasks.

For Create Project, normalize the two inputs into unique **slot tuples**
`(userId, roleOnProject)`. Duplicate IDs within the Photographer array collapse to one Photographer
tuple, and duplicates within the Editor array collapse to one Editor tuple. Do **not** deduplicate a
user across the two roles: the same eligible Editor/Admin in both arrays intentionally produces two
independent membership rows, cycle IDs, `project.member.add` audits, and
`project.assignment.created` outbox events.

The early candidate lookup still provides a useful 422 before constructing work, but it is not the
write authority. `POST /projects` executes one atomic D1 Create domain batch whose eligibility
diagnostics and writes observe the batch serialization point:

1. for every normalized slot tuple, select whether that user exists, is active, and has a global role
   allowed by the shared eligibility constant for that exact project role;
2. conditionally insert the project with `RETURNING id` only if **every** slot tuple is eligible in
   that same batch-observed state (an empty team makes this condition vacuously true);
3. insert every requested collection only when that returned/project ID exists;
4. append the same membership/add-audit/outbox/two-ledger tuple for each normalized slot tuple, with
   every statement gated by both the created project and its generated membership ID; and
5. insert the single `project.create` audit, including `auditMeta()` impersonation metadata, only
   when the project marker exists.

All project, collection, membership, `project.create`, `project.member.add`, outbox, and ledger writes
therefore commit or roll back together. A candidate deactivation or global-role change after the
prevalidation but before batch execution makes the conditional project INSERT return zero; classify
that result from the batch's eligibility diagnostics as **422** and leave no project residue:

```ts
{
  error: "One or more project assignments are not eligible";
  code: "ineligible_project_assignments";
  ineligibleSlots: Array<{
    userId: string;
    roleOnProject: "photographer" | "editor";
  }>;
}
```

`ineligibleSlots` names every offending normalized slot observed by the batch, sorted by
`roleOnProject` then `userId`; it deliberately does not distinguish unknown, inactive, and
role-ineligible users. An empty array is invalid for this response. A thrown
statement failure returns 500 and D1 rolls back the whole batch. The project/collection/member
statements return the complete canonical fields needed for the Create response; assemble the 201
from those same batch results and the batch-observed candidate projections. Do not make a fallible
post-commit `details()` reload decide whether an already-committed request appears to fail. After
the successful commit, the route may schedule `publishNotificationOutbox()` for the database-
returned outbox IDs and, when `rawFolderPath` requests it, call
`BACKGROUND.ensureAutoHdrScaffold()`, then complete the 201 response with every selected eligible
slot present. Preserve the scaffold
trigger's existing caught/logged failure behavior; neither external call runs before commit, and a
Queue publication failure leaves durable pending intents for recovery. This is a bulk initialization
convenience over the same per-role semantics, not a full-roster synchronization API.

### Durable targeted-assignment event

Extend the shared notification event constants to a discriminated set:

```ts
export const NOTIFICATION_OUTBOX_EVENT_TYPES = {
  projectCommentMentioned: "project.comment.mentioned",
  projectAssignmentCreated: "project.assignment.created",
} as const;
```

The new payload is exactly:

```ts
type ProjectAssignmentCreatedPayload = {
  schemaVersion: 1;
  event: {
    type: "project.assignment.created";
    sourceKey: string;  // new project_members.id
    recipientId: string;
  };
  assignment: {
    projectId: string;
    userId: string;
    roleOnProject: "photographer" | "editor";
    membershipCycle: string; // same sourceKey
  };
};
```

Store `event_type = 'project.assignment.created'`, `source_key = membershipCycle`,
`recipient_id = assigned user`, and `actor_id = effective requesting user`. The existing ledger key
`(event_type, source_key, recipient_id, channel)` provides exact once-per-cycle/channel semantics.
Payload contains no name, email, street, client/contact, Dropbox, comment, or checklist data.

Refactor `notification-delivery.ts` around an event-specific parser/resolver plus a common resolved
delivery DTO. Preserve the mention resolver byte-for-byte in behavior. The assignment resolver must
reload and require immediately before each channel:

- payload/outbox version, event type, source key, recipient, project, and membership-cycle equality;
- current project existence;
- current recipient existence and `active = 1`;
- current global role eligibility for the payload's project role through the shared helper; and
- the exact current `project_members` row matching cycle/project/user/role.

Two mention-only gates are deliberately **not** assignment gates. The current mention resolver
rejects `recipientId === actorId` as `self_mention` and rejects an archived project through its
`projectArchivedAt` visibility check. Assignment delivery must not copy either condition into the
shared/event-dispatch layer: a coordinator assigning themself and an otherwise-valid exact
membership on an archived project remain deliverable assignment occurrences. The assignment gates
are exactly the list above; self-recipient equality and `projects.archived_at` do not suppress one.

Removal, deactivation, global-role ineligibility, or remove/re-add suppresses the pending assignment
before send and writes the existing content-free `notification.delivery.suppressed` audit. A current
eligible assignment resolves:

```text
notifications.type = assigned_to_project
notifications.source_key = project_members.id
title = Assigned to project
body = You have been assigned as the <role> for <project street>.
link = /projects/<projectId>
email default = on, using the same role-specific copy
```

Generalize `deliverInApp()` and `finishEmail()` to use resolved type/copy/link/email content rather
than mention literals. Generalize the DLQ audit metadata to the row's actual `event_type`; it
currently hard-codes the mention constant. Claim, lease, retry, unknown-email, recovery, Admin
replay/discard, and Queue message `{type:'notification_outbox', outboxId}` remain unchanged.

At cutover, remove `notifyProjectAssignments()` and both live call sites. Create initial assignments
and rail PUTs become the sole `project.assignment.created` producer. Do not leave a direct fallback
branch. Existing historical direct notification rows remain untouched.

### Create/Edit rollout and project PATCH

Create Project keeps its current initial Photographer/Editor selectors and POST arrays. Change only
their candidate source from `/api/users` to `/api/project-assignment-candidates`. Before creating,
the server prevalidates every distinct `(userId, roleOnProject)` slot against the exact active/role
rules, then reauthorizes every slot inside the conditional atomic Create domain batch above. Its
bulk statement builder creates one add audit plus one durable assignment event per inserted role
cycle. Deduplication is scoped only to `(userId, roleOnProject)`: repeats within one role array
collapse, while the same eligible user selected as both Photographer and Editor creates both rows
and both independent delivery cycles. TB4E later changes only the Editor candidate rule.

Split create/edit schemas in `projects.ts`:

```ts
const createProjectFields = baseProjectFields.extend({
  photographerUserIds: z.array(z.string().uuid()).optional(),
  editorUserIds: z.array(z.string().uuid()).optional(),
});
const editProjectFields = baseProjectFields.partial().strict(); // no roster arrays
```

Final `PATCH /projects/:id` never reads memberships, never calls a membership helper, never calls an
assignment producer, and never places roster data in `project.update` audit metadata. A PATCH that
includes either legacy roster key returns 400 invalid input; do not silently strip it.

The role-route APIs, durable producer cutover, Create integration, and canonical rail ship together
in one app deployment. There is no temporary Edit-page rollback surface or separate compatibility
stage: `ProjectFields` renders its Team selector only in Create mode, while Edit retains its
detail/lifecycle form and the rail's “Edit details” link. No UI submits a full roster through PATCH.

### Rail shell and Team components

Extract the current monolithic rail markup into a Project Overview component owned by the workspace
(suggested files: `components/ProjectOverviewRail.tsx` and `components/ProjectTeamControl.tsx`). The
exact full-workspace order is:

```text
Header       StatusBadge → street → suburb/postcode
Production   Stage (read-only) → Shoot → Deadline (Not scheduled placeholder)
             → Next reminder (None placeholder)
Team         Photographers roster/control → Editors roster/control
Client       Agency → Agent
Collections  existing collection navigation/counts
Dropbox      existing guarded sync control
```

This moves existing Agency/Agent below Team, moves existing Shoot/Stage into named Production,
adds Editors, and adds only placeholder Deadline rows. Collections and Dropbox behavior remain
unchanged. Keep the existing full-width <=1080px behavior; at <=720px label the block “Project
Overview”, use one-column full-width sections and touch targets, and never move controls into the
Collaboration panel.

`ProjectTeamControl` receives the current member DTOs, `canEdit`, candidate query, and a narrow cache
patch callback. It renders separate role rows with compact adaptive chips/list items. Each member
shows name; email/global-role context appears in the picker; inactive assigned users remain in the
roster with a visible “Inactive” label and a remove action, but never appear as selectable additions.

Each role trigger opens a dedicated `@floating-ui/react` picker:

- anchored to its role row at desktop/tablet with `autoUpdate`, `offset`, `flip`, `shift`, and `size`
  middleware so width/height stay within 8px viewport padding;
- a fixed, safe-area-aware bottom sheet at <=720px, max-height bounded by `100dvh`, with the same
  search/results—not a second data/control implementation;
- search input initially focused; filter case-insensitively over `name + email + global-role label`;
- accessible dialog/listbox naming, visible selected state, keyboard traversal, Escape/outside close,
  and focus return to the trigger; and
- selection leaves the picker and its search draft open.

Do not generalize the existing `AnchoredPopover` blindly: its source explicitly describes itself as
checklist-facing. A project-team-specific wrapper may reuse its proven Floating UI mechanics and
confirmation-portal boundary, but must own the wider responsive bottom-sheet behavior.

### Optimistic per-person state and freshness

Use one state map keyed by `${roleOnProject}:${userId}`:

```ts
type PersonMutationState =
  | { kind: "pending"; intent: "add" | "remove" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string };
```

Only one request per key may run; different keys remain enabled and may run concurrently. Before a
request, snapshot only that target cell. Optimistically add a temporary cell or remove the exact
rendered cycle. On success, merge only the returned target membership/removal into project detail;
never replace the full roster from a response. This makes out-of-order successes for different
people/roles commute and preserves a person's other role.

- PUT 201 replaces the temporary membership with the canonical DTO; PUT 200 converges to the
  returned existing DTO.
- DELETE 200 retains the optimistic removal and updates duplicate per-user assignment counts by the
  returned clear count.
- 409 replaces only the target cell with `currentMembership`, sets `conflict`, and refetches exact
  detail and collaboration-summary resources. It does not close the picker or retry.
- 422 confirmation-required rolls back that one optimistic cell, invokes the real-DOM confirmation
  with the server count, and—only on acceptance—reapplies the target optimistic change and retries
  the same cycle with `clearSubtaskAssignments: true` and
  `confirmedAssignmentCount: assignmentCount`. If that retry receives another 422, remove the
  optimistic overlay again and repeat the confirm cycle using only the new server count.
- Other failures roll back only the target snapshot, retain search/open state, render a retryable
  per-person error, and pass 401 through the existing principal-termination seam.

Add both typed transport seams to `apps/web/src/lib/api.ts` beside the current helpers:

```ts
apiPutWithStatus<T>(path: string): Promise<{ data: T; status: number }>;
apiDeleteWithBody<T, TBody>(path: string, body: TBody): Promise<T>;
```

`apiPutWithStatus()` preserves the meaningful 200/201 distinction. `apiDeleteWithBody()` sets
`method: "DELETE"`, `Content-Type: application/json`, and `JSON.stringify(body)` through the
existing `request()` path; do not widen or replace the body-less `apiDelete()` used by existing
callers.

Protect those per-cell patches from canonical refetches with a project-membership mutation ledger
in `project-data.ts`, following the existing asset ledger's QueryClient-scoped shape rather than a
component-local response race:

- keep ordered tokens in a `WeakMap<QueryClient, ...>` keyed by project; each token owns one
  `${roleOnProject}:${userId}` cell, its add/remove intent, its base cell, and any committed
  canonical cell result;
- expose the ledger through `useSyncExternalStore` and render detail/summary members as
  `applyProjectMembershipOverlay(canonicalData, tokens)`, applying pending and settled-but-not-yet-
  drained tokens in token order over whatever canonical query result most recently landed;
- cancel exact detail/summary reads before opening the first token and teach
  `invalidateProjectResources()` to queue `detail`/`collaboration-summary` invalidations and their
  cross-tab publication while any membership token is pending, just as asset invalidations are
  deferred today;
- when one token succeeds, commits, fails, or conflicts, update/drop only that token and reapply the
  remaining overlays. A success/refetch for person A therefore cannot erase person B's still-pending
  cell; and
- after the last pending token settles, merge committed per-cell results into the canonical caches,
  discard the ledger, then issue one queued exact refetch/publication. Access-loss purge discards the
  project ledger before removing caches so no late token can resurrect private data.

Picker open/search state and comment drafts remain outside query data and outside this ledger.

Treat `assignedSubtaskCount` in project detail as advisory display data, never as confirmation
authority. **Every** removal attempt—including a cached known-positive final-role case—first sends
the exact cycle with `{ clearSubtaskAssignments: false, confirmedAssignmentCount: 0 }`. It may use
the normal single-cell optimistic overlay while that request is pending, but it must roll that cell
back before showing a 422 confirmation. Only the server's 422 count is shown in the dialog:

```ts
await confirm({
  title: "Remove final project role?",
  message: `Removing ${name}'s final project role will unassign ${count} checklist item${count === 1 ? "" : "s"}. Continue?`,
  confirmLabel: "Remove and unassign",
  danger: true,
});
```

On acceptance, send the displayed server count as `confirmedAssignmentCount`; never send a bare
`clearSubtaskAssignments: true`, and never skip the initial unconfirmed request because a cached
count looks known. The server's 422 remains mandatory for count, compatibility, and final-role
drift, and every 422 starts a fresh confirmation using its authoritative count.

Extend TB2's project data keys/resources with `collaboration-summary`. In
`apps/web/src/lib/project-query-sync.ts`, update all three contract surfaces together:
`ProjectDataResource` gains the discriminant, the hand-written runtime `isResource()` allowlist
accepts only its exact one-key shape, and exhaustive `projectResourceKey()` maps it to the exact
summary query key. The type and key switch alone are insufficient: `parseProjectDataSyncMessage()`
rejects the whole message when any resource fails `isResource()`.

A confirmed membership mutation invalidates and cross-tab publishes exactly `detail` plus
`collaboration-summary` in one message, subject to the membership-ledger deferral above; it does not
invalidate assets/comments/read markers or close active controls. Candidate data has its own stable
query key and background refresh must not reset picker search/open/pending state.

The summary query has the established bounded visible-refresh contract, specified rather than left
to QueryClient defaults:

```ts
staleTime: 15_000,
retry: projectQueryRetry,
refetchInterval: membershipLedgerOwnsSummaryKey ? false : 30_000,
refetchIntervalInBackground: false,
refetchOnWindowFocus: membershipLedgerOwnsSummaryKey ? false : true,
refetchOnReconnect: membershipLedgerOwnsSummaryKey ? false : true,
```

Thus another browser/device converges within the next 30-second visible-tab poll even when no
same-browser broadcast exists. A background tab does not poll. Only the membership mutation ledger
that owns this exact summary key defers its timer/focus/reconnect refetches; after its last token
settles, the queued invalidation/refetch described above resumes the normal contract.

### Collaboration-only summary

Add `GET /projects/:projectId/collaboration-summary`. Validate UUID, call
`hasProjectCollaborationAccess()` **before** project existence, return the existing 403 body to a
non-member, and 404 only after collaboration authorization. Return 200:

```ts
type ProjectCollaborationSummary = {
  project: {
    id: string;
    street: string;
    stageKey: ProjectStageKey; // passed through projectStageForRole()
  };
  members: Array<{
    id: string;
    userId: string;
    roleOnProject: "photographer" | "editor";
    name: string;
    active: boolean;
  }>;
};
```

It deliberately omits email, suburb/postcode, shoot/time, Agency/Agent/contact, billing/order/notes,
collections, Dropbox, assets, counts, and mutation candidates. The Stage-hidden fallback changes
from the current comments-only page to:

```text
street header
read-only summary: presentation-safe Stage
                   Deadline — Not scheduled (TB4B placeholder)
                   Next reminder — None (TB4B placeholder)
                   Photographer roster
                   Editor roster
existing standalone Collaboration panel
```

It renders no team trigger even if stale client capabilities say `editProject`, makes no ordinary
detail/assets/ingest/jobs/AutoHDR/candidate request, and does not alter `hasProjectAccess()` or
`GET /projects/:id`. The initial detail-403 probe may use this summary endpoint as the collaboration
proof, then start the ordinary comments query; a summary 403/404 remains unavailable.

Add `"collaboration-summary"` to the central access-error classifier rather than handling it inside
the rail component. A later refetch failure after previously successful summary data is terminal for
that resource:

- **403:** synchronously enter the real collaboration-generation purge fence described below before
  any late completion can commit, set the parent-owned `collaborationUnavailable` state so the
  summary, Collaboration panel, checklist, drafts, and their manual owners unmount, and discard any
  membership overlay ledger. The purge then cancels/removes the exact summary query and comments
  root. Render the neutral “Collaboration unavailable” view and retain no previously successful
  Stage/roster/comments/checklist data. Do not retry and do not fall back to cached success data.
- **404:** take TB2's project-terminal path: mark the mounted view unavailable, discard the
  membership ledger, enter the same collaboration-generation purge fence, then cancel/remove the
  complete `projectDataKeys.project(projectId)` prefix through `purgeProjectData()`, and never retry.
  No stale summary, comments, or checklist state remains renderable.
- **401:** retain the existing principal-terminal `clearPrincipalProjectData()` behavior, but bump
  the same collaboration generation for every affected mounted project before clearing the client.

Do not invent a parallel generic guard. Extend/rename the existing
`commentDataGenerations`/`projectCommentDataGeneration()` mechanism and
`purgeProjectCommentData()` into the collaboration-wide fence (for example,
`projectCollaborationDataGeneration()` plus `purgeProjectCollaborationData()`). The purge's first
synchronous steps remain the shipped ones: increment the QueryClient/project generation and reset
both comment read-state sequence maps; only then cancel/remove the summary and `commentsRoot` keys.
The 403 path calls this extended function directly. `purgeProjectData()` and
`clearPrincipalProjectData()` must compose its generation bump before their broader removals so
404/401 receive the same tombstone.

Every summary/comments/checklist read captures the current collaboration generation before issuing
its request. After its **final `await`**, after the abort check, and before returning success to
TanStack Query or calling any `setQueryData`/React state setter, it compares the captured value with
`projectCollaborationDataGeneration(queryClient, projectId)`. A mismatch is the tombstone: summary
and comment query functions throw an `AbortError` through the existing expected-cancellation path
instead of committing (not an `ApiError` 404 that could spuriously promote the transition to project-
terminal); the component-local checklist/assignee loaders return without calling `setSubtasks`,
`setUsers`, or later focus/loading state for that run. Extend the direct comments page query with
this check while preserving `refreshProjectCommentsHead()`'s existing generation comparison.
Checklist operations also retain their mounted/project identity check, but parent `isCurrent()`
alone is explicitly not the fence because a `collaborationUnavailable` transition does not
currently make it false.

## Migration and resource statement

**TB4A requires no schema migration and no new Cloudflare resource.** Existing
`project_members.id` is the cycle, its unique index is the add-idempotency backstop,
`project_subtasks.assignment_version` already supports atomic unassignment, and TB4's existing
outbox/ledger columns and Queue accept the new runtime-validated event type.

Do not create migration 0033, edit Drizzle schema for a fictitious cycle/version, create a second
Queue, or take a migration recovery export for TB4A. At implementation review, recheck
`docs/todo.md`, the checked-in/remote migration tail, and schema shape anyway. If an unforeseen
schema change becomes genuinely necessary, stop and revise/re-review this plan; recheck the next
available number then rather than assuming 0033 from this draft.

## Focused automated coverage

### Existing TB4 guardrail migration (part of TB4A, not cleanup discovered during build)

TB4A intentionally removes public helpers and widens source shape that current tests pin. Update
these existing tests in the same implementation diff; Luna must not first encounter them as
surprise gate failures:

- `portal/packages/db/test/tb4-contracts.test.ts` reads production source as text. Add
  `projects.ts` and `project-members.ts` to its read fixtures. In test **4**, retain the current
  project-comment single-outbox and direct Notice Board/Subtask assertions, but replace the positive
  `notifyProjectAssignments` assertion with architecture guards that (a)
  `notifyProjectAssignments` is absent from both `notifications.ts` and `projects.ts`, and (b) the
  app producer-source fixture set contains `project.assignment.created` exactly once, in
  `project-members.ts`. In test **15**, preserve the current-main direct exports by their verified
  names—`notifyProject`, `notifyNoticeBoardMentions`, and `notifySubtaskAssignee`—plus their
  `emitNotifications` use and the comment-route negative guard; replace the assignment-helper
  export assertion with negative assertions for `notifyProjectAssignments` in both
  `notifications.ts` and `projects.ts`. These are replacement guardrails, not deleted coverage:
  together tests 4 and 15 prove one producer per event while preserving every direct producer TB4A
  does not migrate.
- Preserve the function names and source order in
  `portal/workers/background/src/notification-delivery.ts`: `resolveRecipient` remains the common
  event-dispatch resolver; `releaseBeforeRetry` remains before `completeIfTerminal`; and the existing
  `const secondResolution = await resolveRecipient` before `INSERT INTO notifications` plus
  `const reauthorized = await resolveRecipient` before `beginChannel(..., "email")` call shapes
  remain. This is practical because event-specific parsing/resolution can sit behind the common
  dispatcher without renaming or moving the claim/retry seams. Therefore
  `tb4-contracts.test.ts` tests **6, 8, and 16 stay green unmodified**, retaining their claim-batch,
  per-channel reauthorization-order, and retry-release-order guarantees.
- `portal/workers/app/test/notifications.test.ts` currently imports
  `notifyProjectAssignments` and directly invokes it in the assignment block of “includes active
  admins...”. Remove that import and direct-helper block while preserving the `notifyProject` and
  `notifySubtaskAssignee` coverage; replace the lost assignment behavior at its new owners with the
  route/domain/background tests below, including role copy, inactive suppression, one in-app row,
  and one email attempt from the durable occurrence.
- `portal/workers/app/test/api.test.ts` currently imports `notifyProjectAssignments`,
  `insertProjectMembers`, and `syncMembers`. Rewrite “emits assignment alerts only for confirmed
  active role assignments” to assert eligible Create produces the exact assignment outbox/ledger
  occurrences and an ineligible Create returns the coded 422 with zero project residue. Rewrite
  “returns database-confirmed membership inserts and emits one matching assignment alert” against
  `addProjectMemberWithAssignmentIntent()`/the PUT route, proving INSERT-`RETURNING` classification,
  one outbox, and no direct notification. Replace “does not report an addition from a stale empty
  syncMembers snapshot” with the exact-role concurrent PUT/no-full-sync regression. Drop all three
  retired imports; do not keep a test-only export of a removed production helper.
- `portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx` imports and calls
  `purgeProjectCommentData`. TB4A takes the plan's explicit rename to
  `purgeProjectCollaborationData`; update that import/call and retain the late read-marker completion
  assertion, now proving the collaboration-wide generation tombstone rather than weakening it.

Add tests at the existing owners. At minimum prove:

1. shared eligibility permits active/global Photographer, internal Editor, and Admin in the
   Photographer slot; only internal Editor/Admin in Editor; no inactive target and no External
   Editor literal exists;
2. candidate API requires an assignment capability, returns exact active role sets in stable order,
   omits ineligible/inactive/user-management fields, and supports name/email/role search client-side;
3. PUT validates IDs/access/capability/project/user in the specified order; the guarded INSERT's own
   `RETURNING` row fixes `created`/201, a no-return plus same-batch exact-row diagnostic fixes
   `unchanged`/200, and neither fixes the ineligible 422 with no write. A forced membership removal
   after batch commit but before optional DTO hydration cannot rewrite any classification;
4. repeat and concurrent PUT return one 201 plus one 200, one membership cycle, one
   `project.member.add` audit, one outbox, two ledger rows, one Queue publication, one in-app row, and
   one email attempt—never direct `notifyProjectAssignments()`;
5. add-batch fault injection at membership/diagnostic/audit/outbox/each ledger statement rolls the
   complete operation back; Queue publication failure leaves the committed pending intent
   recoverable;
6. `apiDeleteWithBody()` sends one JSON DELETE body, and DELETE rejects invalid project/user/cycle
   UUIDs, missing/malformed JSON, extra keys, and invalid boolean/count types with 400; capability
   denial and non-member access remain 403 before project existence, authorized missing project and
   target lookups are 404 in that order, and valid exact-cycle DELETE returns 200 once, 409 on
   absent/replaced cycles with the batch-observed canonical current row, never removes C2 with a C1
   request, never audits a 409, and never notifies on remove;
7. removing one of two currently eligible roles preserves the other and assignments; different
   person/role operations and out-of-order requests commute without a project-wide roster fence;
8. final non-active-Admin removal with assigned subtasks returns 422 when unconfirmed; a matching
   confirmed count atomically deletes the exact membership, clears every affected assignee,
   increments each assignment version once, updates timestamps, and writes one audit; a currently
   eligibility-compatible remaining role or active Admin preserves assignments; and after a
   dual-role member's global role changes so one residual row is ineligible, removing the still-
   eligible row treats it as the final compatible role and clears assignments rather than letting
   the stale row suppress cleanup;
9. a concurrent role/membership/task change around DELETE yields only coherent outcomes—200 with
   exact final-state cleanup, 409 stale cycle, or 422 confirmation required—never partial delete/
   audit/unassignment; changing the assignment count after the client displays and submits a
   confirmation but before DELETE produces 422 with the new count and no writes, and a forced state
   change after batch completion
   but before any external refetch cannot change the response classification captured by the
   batch's diagnostic SELECTs;
10. assignment outbox parser accepts only the exact v1 shape; delivery requires current active,
    global-role-eligible, exact-cycle membership and suppresses deactivation/removal/role change/
    remove-re-add before each channel, while neither `recipientId === actorId` nor an archived
    project suppresses an otherwise-valid assignment occurrence;
11. assignment in-app/email copy is role-specific, source key is membership ID, link is the project,
    and duplicate Queue/Cron/replay remains one row/channel. All TB4 mention **behavioral** claim/
    lease/retry/unknown/DLQ tests remain green; `tb4-contracts.test.ts` source-shape assertions are
    updated exactly as specified in “Existing TB4 guardrail migration” with equivalent or stronger
    one-producer and ordering guarantees, never silently deleted;
12. Create Project retains initial selections and executes one conditional atomic domain batch:
    deactivating a selected candidate or changing its global role after prevalidation but before the
    batch yields `code: "ineligible_project_assignments"` plus every offending normalized
    `{userId, roleOnProject}` slot and no project/collection/member/audit/outbox/ledger residue;
    fault injection at every eligibility diagnostic and at the project INSERT, every collection
    INSERT, every membership/add-audit/outbox/ledger statement, and the `project.create` audit
    yields 500 with the same zero-residue result; otherwise
    201 contains every eligible selected slot. Duplicate IDs within one role array collapse by
    `(userId, roleOnProject)`, while one eligible user selected in both arrays produces two membership
    rows, two distinct cycles, two `project.member.add` audits, and two
    `project.assignment.created` outbox events. Outbox publication and the AutoHDR scaffold trigger
    are observed only after commit, and Create no longer invokes the direct assignment helper;
13. final PATCH accepts ordinary detail edits but rejects either roster-array key with 400 and never
    queries or mutates membership;
14. collaboration summary uses collaboration access, returns safe Stage/rosters to a Stage-hidden
    member, returns indistinguishable 403 to a non-member, 404 after authorized missing-project
    lookup, and serializes none of the forbidden fields. Fake-timer coverage proves a visible,
    unowned summary polls at 30 seconds and converges without broadcast, pauses while hidden,
    refetches on focus/reconnect, and defers only while the membership ledger owns its key. An
    access-loss-while-visible test removes membership and lets the next timer refetch return 403:
    it synchronously unmounts and purges summary/comments/checklist into Collaboration unavailable.
    For each of 403, project 404, and principal 401, hold one summary response, one comments response,
    and one checklist/assignee response past the purge, then release them; the shared bumped
    collaboration generation rejects every completion after its final `await`, no cache/local state
    is repopulated, none of 401/403/404 is retried, and no last-good data is rendered;
15. trailing-slash variants cannot reach a mutation handler or bypass authorization, and no
    router-wide middleware affects sibling routes;
16. ProjectTeamControl keeps the picker/search open after selection; shows separate roles and
    inactive truth; filters name/email/role; disables only the pending cell; and renders accessible
    desktop popover/mobile bottom-sheet states;
17. optimistic add/remove changes exactly one cell; 200/201 converge canonically; ordinary error
    rolls back one cell; 409 merges one conflict cell/refetches; concurrent out-of-order different
    cells do not clobber each other or drafts; specifically, let person A succeed and its detail
    refetch land while person B is still pending, and prove the membership ledger keeps B's overlay
    until B settles. In `project-query-sync.test.ts`, a single
    `{detail, collaboration-summary}` message must round-trip through
    `parseProjectDataSyncMessage()` and a sibling runtime must invalidate both exact query keys;
    omission from the hand-written runtime allowlist must make this test fail;
18. cached-known and cached-unknown final-removal paths both first send the exact cycle with
    `clearSubtaskAssignments: false`/count 0 and use only the resulting 422's count in the singleton
    confirmation; Cancel makes no retry DELETE, Confirm sends the exact cycle, true clear flag, and
    displayed confirmed count; a concurrent count change makes the retry receive 422, removes its
    optimistic overlay, shows a fresh dialog with the new count, and sends that new count only after
    the second confirmation; no `window.confirm` appears;
19. full workspace rail order and collaboration-only safe summary match the contract at desktop,
    tablet, and phone; Stage/Deadline remain noninteractive; and Collaboration owns no team control;
20. Create retains Team, the canonical rail uses role deltas with a roster-free PATCH, final Edit
    contains no Team selector, and the rest of Edit lifecycle/detail behavior remains green.

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run the repository gate exactly:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Record every workspace result separately. The shared invocation is mandatory because the workspace
test command silently misses it. No unexplained TypeScript, React, Hono, D1, Queue, timer, focus,
console, or unhandled-rejection warning is accepted.

Also run source audits proving:

```bash
rg -n 'photographerUserIds|editorUserIds|syncProjectMembersAndClearSubtaskAssignments|notifyProjectAssignments' workers/app/src apps/web/src
rg -n 'project.assignment.created|project.comment.mentioned|NOTIFICATION_OUTBOX_EVENT_TYPES' packages/shared/src workers/app/src workers/background/src
rg -n 'confirmedAssignmentCount|apiDeleteWithBody|PROJECT_ASSIGNMENT_ELIGIBLE_ROLES' packages/shared/src workers/app/src apps/web/src
rg -n 'window\.confirm|window\.alert' apps/web/src
rg -n 'projectsRoutes\.use\("\*"|/photographers/:userId|/editors/:userId|collaboration-summary' workers/app/src
rg -n 'notifyProjectAssignments|insertProjectMembers|syncMembers|purgeProjectCommentData' workers/app/test packages/db/test apps/web/src --glob '*test*'
rg -n 'project\.assignment\.created|resolveRecipient|releaseBeforeRetry|completeIfTerminal|collaboration-summary' packages/db/test workers/app/test apps/web/src --glob '*test*'
```

Expected final result: roster arrays occur only in Create contracts; full-sync/direct-assignment
symbols have no live source call; exactly one durable assignment producer exists; DELETE count
binding and shared eligibility have one source-owned implementation; no native confirm exists; no
router-wide projects middleware exists. Test-tree hits are accounted for by the explicit guardrail
migration above: retired helper names appear only in negative source-shape assertions (if retained
there), durable assignment/collaboration coverage is present at the new owners, and tests cannot
silently retain direct-helper imports or the old purge name.

### Manual local browser QA matrix

Mutation walkthroughs run against the built app Worker at `http://localhost:8787`, never Vite 5173
and never production. A human signs in once as the seeded Admin; use the shipped Admin impersonation
flow for Photographer/Editor views where fixtures permit. Luna performs browser QA under the
repository's §2.9/§2.10 rules; it never signs in itself or forges a session. Expect documented local
`wrangler dev` instability: distinguish/retry `ERR_CONNECTION_REFUSED` or a one-off D1 body-parse
500 before filing an application defect.

1. **Rail/layout.** At 1440×900, 1024×768, and 390×844 verify exact shell order, sticky-to-full-width
   transition, Project Overview mobile treatment, Stage read-only behavior, honest Deadline/reminder
   placeholders, Team separation, unchanged collection navigation/Dropbox control, and clean
   Console/Network.
2. **Picker accessibility.** Open each role picker, search by name/email/role, keyboard through
   results, Escape/outside close and focus return, verify viewport containment at every size and the
   phone bottom sheet, and confirm selection never closes or clears search.
3. **Eligibility/inactive truth.** Confirm Editor/Admin appear in both allowed sets as specified,
   Photographer appears only in Photographer, inactive assigned users remain labeled/removable and
   absent from add results, and direct ineligible PUT returns 422.
4. **Idempotent/concurrent add.** Add one role, immediately repeat it, and issue different person/
   role adds without waiting. Confirm only the target cells pend, other interactions remain usable,
   one membership/audit/outbox/in-app/email exists per new cycle, and repeat is a truthful no-op.
5. **Independent dual roles.** Give one internal Editor both rows. Remove Photographer and confirm
   Editor/access/checklist assignment remain; restore Photographer, remove Editor, and confirm the
   inverse. Then change the user's global role so one retained row is no longer eligible for its
   slot; remove the still-eligible row and confirm the stale ineligible row does not prevent final-
   compatible-role cleanup. Restore the fixture.
6. **Final-role cleanup.** Assign at least two checklist items, attempt the final compatible role
   removal, Cancel the real-DOM dialog, then Confirm. Verify count copy, exact membership deletion,
   atomic null assignees, version increments, one audit, no removal notification, and picker stays
   open. In a second tab, change the assignment count while the first confirmation is open; require
   the first confirmed DELETE to return 422 without writes and a fresh dialog with the new count
   before success. Repeat with active Admin fallback and require no cleanup.
7. **Stale cycle.** Hold a C1 delete, remove/re-add via another local tab to create C2, then release
   C1. Require 409, visible conflict, C2 preserved, only that cell refreshed, no automatic retry, and
   no unrelated optimistic state lost.
8. **Failure recovery.** Fault-inject ordinary 500/Queue publication failure. Ordinary route failure
   rolls back only the target UI/atomic DB batch; Queue admission failure preserves membership,
   audit, pending outbox/ledgers and later Cron delivery.
9. **Create/Edit rollout.** In the single TB4A deployment, Create still selects both roles and
   assigns them on creation; select one eligible Editor/Admin in both Create arrays and verify the
   two independent membership cycles/audits/outbox events. Confirm the canonical rail changes team
   through the role routes, Save details sends a roster-free PATCH, and routine Edit has no team
   selector.
10. **Collaboration-only boundary.** As a Stage-hidden explicit Photographer, verify street, safe
    Stage, placeholder Deadline/reminder, both rosters, and Collaboration. Require no email/contact,
    Agency/Agent, Shoot, notes/order/billing, collections, Dropbox, assets, jobs, candidate request,
    or mutation control in DOM/network/cache. Keep the tab visible with same-browser broadcast
    disabled and verify the summary issues its next request within 30 seconds; hide it for more than
    one interval and verify polling pauses, then returns through focus/reconnect refetch. While the
    summary stays visible, remove the viewer's membership from another tab and require the next
    timer-driven 403 to bump the collaboration fence, purge summary/comments/checklist, and render
    Collaboration unavailable with no stale roster/Stage; force a project 404 separately and require
    a terminal full-project purge, then exercise user deactivation/401 and require the existing
    principal-wide purge plus the same generation bump. As a non-member, require unavailable with no
    summary.
11. **Cross-tab freshness.** Keep pickers/drafts open in one tab while mutating another. Require
    same-browser broadcast convergence and, with broadcast disabled to represent another browser or
    device, visible-tab convergence by the next 30-second summary poll, without closing controls,
    resetting search, losing a draft, or invalidating assets/comments unnecessarily. Also hold person
    B's cell mutation pending while person A succeeds and a detail refetch lands; B's optimistic cell
    must remain overlaid until its own request settles.

Every mutated fixture is clearly disposable and restored or archived locally. No real staff email
address is used for fault/retry tests; use deterministic Worker mocks for provider outcomes.

### Matched visual evidence

Record redacted evidence under:

```text
docs/plans/revamp_2026_portal/evidence/TB4A/base-current-state.txt
docs/plans/revamp_2026_portal/evidence/TB4A/automated-gates.txt
docs/plans/revamp_2026_portal/evidence/TB4A/route-cycle-atomicity-and-delivery-tests.txt
docs/plans/revamp_2026_portal/evidence/TB4A/manual-qa.md
docs/plans/revamp_2026_portal/evidence/TB4A/rail-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB4A/rail-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB4A/rail-390x844.png
docs/plans/revamp_2026_portal/evidence/TB4A/picker-desktop.png
docs/plans/revamp_2026_portal/evidence/TB4A/picker-phone-bottom-sheet.png
docs/plans/revamp_2026_portal/evidence/TB4A/collaboration-only-safe-summary.png
docs/plans/revamp_2026_portal/evidence/TB4A/production-passive-smoke.md
docs/plans/revamp_2026_portal/evidence/TB4A/rollback-record.md
```

Compare the three rail captures against the accepted rail design evidence and Quincy tokens, then
record discrepancies/approvals in `manual-qa.md`. Screenshots must redact client streets, names,
emails, and contacts. Do not preserve cookies, tokens, raw notification payloads, or provider errors.
`rollback-record.md` must record outstanding `project.assignment.created` outbox counts grouped by
`pending`/`queued`/`processing` before deployment and again immediately before any background Worker
rollback decision; a background rollback is barred while any of those counts is nonzero.

### Deployment and production verification

No migration or resource provisioning occurs. This changes the background notification consumer and
the app Worker/API/frontend, not webhook-ingress.

1. Record current background/app Worker versions, current remote schema/migration/Queue health, and
   outstanding `project.assignment.created` outbox counts by `pending`/`queued`/`processing` in
   `rollback-record.md`.
2. Deploy background first so it accepts both the existing mention event and new assignment event;
   run a passive health check. No assignment producer exists yet.
3. Deploy the single app Worker containing the role-route APIs, durable producer cutover, Create
   integration, and canonical Project Workspace rail together. Record the pre-TB4A app version as
   the rollback target; there is no compatibility app or temporary Edit team control.
4. Perform only passive production checks: routes/assets load, existing memberships render, no
   console/network/Worker errors, Queue/Admin delivery operations remain healthy. Confirm Edit is
   detail/lifecycle-only and the rail is the sole routine team surface. All mutating membership
   walkthroughs remain local per `Subagent-Orchestration.md` §2.9.
5. After production acceptance, update this plan status/deployment record and `docs/todo.md`,
   commit evidence, and `git mv` the plan to `docs/plans/implemented/` with the live commit hash.

This follows the binding rule as `background → app`; webhook-ingress is skipped because unchanged.

### Concrete rollback and fix-forward

- If the canonical rail UI or role API/producer is faulty, roll the app Worker back to the recorded
  pre-TB4A version. That restores the old static rail, Edit full-roster PATCH behavior, and direct
  assignment producer for **new** requests. Keep the TB4A-capable background Worker live to drain
  any already-committed assignment outbox rows. Never deploy a single app version that invokes both
  producers for one insert.
- If the background assignment resolver is faulty, roll the **app** Worker back first to stop new
  assignment intents. Then pause the `quincy-notifications` consumer, or leave the TB4A-capable
  background Worker live while fixing forward. Record outstanding `project.assignment.created`
  outbox counts by `pending`/`queued`/`processing` in `rollback-record.md` before any background
  rollback decision. Do **not** deploy a pre-TB4A background Worker while any assignment row is in
  one of those states: its mention-only `safePayload()` returns `payload_invalid`,
  `processNotificationMessage()` drives the occurrence through `suppressWholeOccurrence()` to the
  terminal `suppressed` state, and `recoverNotificationOutbox()` republishes only `pending`/`queued`
  rows. Only the paused-consumer or TB4A-capable-background paths preserve those D1 intents for
  recovery; do not manually insert direct notifications for them.
- There is no schema rollback, table drop, Queue purge, membership restoration, audit deletion, or
  notification-history deletion. Source/data defects fix forward through reviewed code. A mistakenly
  removed membership is restored through a new PUT and therefore a new cycle; never resurrect the
  old row ID.

At the accepted deployment checkpoint, production is coherent if later roadmap work stops: Stage and
Deadline remain read-only/placeholders, team writes are exact, Collaboration remains focused, and
TB4E can extend Editor eligibility without replacing the contract.

## Acceptance checklist

- [ ] Work begins from recorded current `main`; TB4 and confirmation/impersonation remain live; no
      work touches `prototype/` or later tracer bullets.
- [ ] Rail order is header → Production → Team → Client → Collections/Dropbox; phone is full-width
      Project Overview; Stage is read-only; Deadline/next reminder are honest placeholders only.
- [ ] Photographer and Editor rosters are separate, adaptive, searchable, accessible, viewport-
      contained, and inactive-truthful.
- [ ] Shared eligibility and both server query shapes exactly implement the TB4A baseline; no broad
      registry or External Editor work appears.
- [ ] PUT/DELETE role paths implement exact auth/404 ordering, strict JSON validation, typed
      `apiPutWithStatus()`/`apiDeleteWithBody()` transport, exact bodies/statuses/DTOs, and no
      trailing-slash/wildcard bypass.
- [ ] `project_members.id` is the sole membership cycle; no schema/version timestamp is added.
- [ ] PUT is idempotent and concurrent-safe: its own guarded INSERT `RETURNING` plus same-batch
      exact-row diagnostic—not a post-batch reload—fixes created/unchanged/ineligible; no duplicate
      membership, audit, outbox, ledger, notification, or email results.
- [ ] DELETE matches exact cycle/project/person/role, returns 409 from same-batch diagnostics on
      staleness, preserves only a remaining role eligible under the target's current global role,
      and never retries against a refreshed cycle automatically.
- [ ] Final compatible non-active-Admin removal binds the destructive retry to the
      server-verified `confirmedAssignmentCount`; count drift returns 422 with no writes, and a
      matching count clears assignments/version atomically. This is a count-agreement guarantee,
      not proof a human saw a dialog. A currently compatible role or active Admin preserves them; a
      stale globally ineligible row does not.
- [ ] Different people/roles commute in DB and UI; per-person pending/error/conflict state never
      clobbers another optimistic cell or picker draft, including when a canonical detail refetch
      lands while another cell remains pending under the membership ledger.
- [ ] Every successful membership mutation audits exactly once with impersonation metadata; no-op,
      conflict, confirmation-required, and failed batches audit zero times.
- [ ] Targeted assignment uses one TB4 outbox event only for newly inserted cycles; removal is
      audit-only; the old direct assignment producer has no live call.
- [ ] Assignment delivery reauthorizes active/global-role/exact-cycle membership before each channel,
      suppresses remove/re-add, deliberately permits self-assignment and otherwise-valid archived-
      project assignment occurrences, and preserves all existing TB4 mention/retry/unknown/DLQ
      behavior.
- [ ] Create retains initial selection and commits project/collections/memberships/audits/outbox/
      ledgers in one batch conditional on batch-observed slot eligibility; a candidate race returns
      coded 422 with every offending normalized slot and zero residue, any statement fault also
      leaves zero partial residue, and external dispatch/scaffold work starts only post-commit.
      Deduplication is per `(userId, roleOnProject)`, so same-role repeats collapse but a user
      selected for both roles receives two rows/cycles/add audits/outbox events.
- [ ] The canonical rail uses role deltas; routine Edit has no team selector; PATCH rejects roster
      keys and handles project fields only.
- [ ] Stage-hidden explicit collaborators receive only safe Stage, placeholder Deadline/reminder,
      rosters, and Collaboration; ordinary workspace authorization/data stays closed; later summary
      403 invokes the extended real comment-generation/reset fence and purges summary/comments/
      checklist into Collaboration unavailable; 404/401 compose the same generation tombstone before
      broader purges, and delayed completions cannot repopulate cache or local state.
- [ ] Collaboration summary uses 15-second staleness and visible-tab 30-second polling with background
      pause plus focus/reconnect refetch; only membership-ledger ownership defers that key, and timer-
      driven convergence/access-loss coverage is green without relying on same-browser broadcast.
      `ProjectDataResource`, `isResource()`, and `projectResourceKey()` all recognize
      `collaboration-summary`, and a `{detail, collaboration-summary}` parser/runtime test invalidates
      both exact keys.
- [ ] No migration/resource change occurs; remote/checked-in state is still rechecked at review.
- [ ] Focused automated tests—including every named existing-test migration and equivalent/stronger
      TB4 source-shape guardrail—full four-command gate, source/test-tree audits, local mutation QA,
      matched visual evidence, and passive production smoke are green with no unexplained warning.
- [ ] Background-first/single-app rollout records the pre-TB4A rollback target and assignment
      outbox state counts; production remains coherent at the deployment checkpoint, and no
      pre-TB4A background Worker consumes outstanding assignment intents.
- [ ] After verified production acceptance, plan/todo/evidence status is updated and this file moves
      to `docs/plans/implemented/` with the live commit hash.

## Reviewer-first judgment calls

There are no blocking product questions in this draft. The next reviewer should scrutinize these
resolved architecture choices first:

1. targeted assignment is cut over from the current direct helper to TB4's durable outbox in TB4A,
   because the settled architecture explicitly assigns this event to the durable envelope;
2. DELETE uses a strict JSON cycle/clear/confirmed-count precondition, same-batch diagnostic
   classification, current-global-role-compatible remaining-row checks, 200 authoritative success,
   409 stale cycle, and 422 count-bound confirmation rather than a body-less 204;
3. the old full-roster sync helper is removed after extracting its atomic final-role cleanup into
   exact single-delta helpers;
4. collaboration-only presentation uses a new safe summary resource rather than widening ordinary
   project detail or coupling roster data to paginated comments, with the existing comment-generation
   fence extended across summary/comments/checklist and an explicit 30-second visible refresh;
5. Create is one eligibility-conditional atomic D1 domain batch, while deduplication remains scoped
   to a role slot so supported dual-role membership is preserved; and
6. rollout deploys the role APIs, durable producer cutover, Create integration, and canonical rail
   together, with the pre-TB4A app Worker as the rollback target and no temporary Edit fallback.
