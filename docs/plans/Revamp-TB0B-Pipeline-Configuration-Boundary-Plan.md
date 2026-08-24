# Revamp TB0B — Pipeline Configuration Boundary Plan

> **Status: DRAFT — not implemented, verified, committed, or deployed. No schema migration is
> expected.** TB0B follows TB0A and must be live before TB1 begins.

## Authority and outcome

This plan implements the narrow boundary approved by
[`TB0B-Pipeline-Configuration-Boundary.md`](./revamp_2026_portal/roadmap/TB0B-Pipeline-Configuration-Boundary.md)
and the A10 amendment in [`Implementation-Plan.md`](../Implementation-Plan.md): ordinary Admins
retain Stage label and active/inactive management, but global Stage ordering is no longer an
ordinary self-service action. Stable Stage identities remain
`awaiting_raw → raw_review → editing_autohdr → edited_review → delivered`; display order does not
redefine automation.

The shipped outcome is deliberately small:

- `Admin → Pipeline` still reads and refreshes the five existing Stage rows, shows their current
  read-only order numbers, edits labels, and toggles activation under the existing guards;
- the Up/Down controls and their browser-side request path are gone;
- an authenticated Admin calling the former move URL receives the app's normal API `404` response,
  and no Stage row or audit row changes;
- the existing `display_order` values are not rewritten by TB0B; and
- future global order changes require the reviewed developer procedure in this plan.

## Current-main implementation, verified before drafting

The roadmap's current-main fact matches the source; there is no implementation discrepancy.

### Admin UI

[`portal/apps/web/src/screens/Admin.tsx`](../../portal/apps/web/src/screens/Admin.tsx) owns the
entire Admin screen and its `pipeline` tab. Its current Stage behavior is:

- `loadPipeline()` calls `GET /api/admin/stages`;
- `updateStage()` calls `PATCH /api/admin/stages/:key`, then refreshes both the local Pipeline list
  and the shared `StagesProvider` via `refreshStages()`;
- `reorderStage(index, direction)` calls `POST /api/admin/stages/:key/move`, then performs those
  same two refreshes; and
- the `Pipeline stages` row renders the read-only `displayOrder`, stable key, editable label,
  active checkbox, and Up/Down buttons. The first Up and last Down buttons are disabled.

[`portal/apps/web/src/styles/app.css`](../../portal/apps/web/src/styles/app.css) gives
`.admin-stage` five desktop grid columns, including a final action column, and defines
`.admin-stage__actions` plus a mobile placement rule. Those rules are part of the visible removal
scope; deleting only the buttons would leave a dead grid column and obsolete CSS.

### API and persistence

[`portal/workers/app/src/routes/admin.ts`](../../portal/workers/app/src/routes/admin.ts) declares:

- `GET /admin/stages`, exposed as `GET /api/admin/stages`, guarded by `adminBackend` and backed by
  `listPipelineStages()`;
- `PATCH /admin/stages/:key`, exposed as `PATCH /api/admin/stages/:key`, guarded by the same
  capability and accepting only `{ label?, active? }`; it preserves the existing
  `awaiting_raw` and active-project deactivation guards and audits `pipeline_stage.update`; and
- `POST /admin/stages/:key/move`, exposed as `POST /api/admin/stages/:key/move`. Its `stageMove`
  schema accepts `up | down`; the handler loads display-order-sorted rows, swaps the selected and
  adjacent `displayOrder` values in a D1 batch, audits `pipeline_stage.move`, and returns the new
  list.

[`portal/workers/app/src/index.ts`](../../portal/workers/app/src/index.ts) applies session
middleware to `/api/*` and has a terminal JSON 404 handler. Removing the move route therefore has
a defined result for an authenticated direct call: `404 { "error": "Not found" }`, rather than a
fall-through success or UI-only policy.

[`portal/packages/db/src/schema.ts`](../../portal/packages/db/src/schema.ts) persists
`pipeline_stages.display_order`; no uniqueness constraint or schema change is needed.
[`portal/packages/shared/src/stages.ts`](../../portal/packages/shared/src/stages.ts) is the shared
source of stable Stage keys, transitions, and the default `1…5` order. The seed in
[`portal/packages/db/seed/0001_seed.sql`](../../portal/packages/db/seed/0001_seed.sql) has the same
five key/order pairs. TB0B must not change either set of values.

Runtime consumers continue to sort/read these values through
[`portal/workers/app/src/routes/stages.ts`](../../portal/workers/app/src/routes/stages.ts) and
[`portal/apps/web/src/lib/stages.tsx`](../../portal/apps/web/src/lib/stages.tsx). Project-level
movement is a separate command, `POST /api/projects/:id/stage`, in
[`portal/workers/app/src/routes/projects.ts`](../../portal/workers/app/src/routes/projects.ts);
TB0B does not modify it.

### Existing tests and evidence

[`portal/workers/app/test/api.test.ts`](../../portal/workers/app/test/api.test.ts) currently has one
combined Stage test that proves initial seeding, public Stage reads, label edits, a successful
self-service move, the required-Stage deactivation guard, and rejection of movement into an
inactive Stage. The successful-move assertions must be rewritten to prove the new boundary, not
deleted.

There is currently **no** `Admin`/Pipeline component test under `portal/apps/web/src`; this is a
real coverage gap, not a missing implementation. Existing project-stage coverage includes
`allows an editor to move an assigned project backwards through the pipeline`; it protects the
separate `POST /api/projects/:id/stage` behavior and must continue to pass unchanged.

The before-state evidence is
[`current-admin-1440-pipeline.png`](./revamp_2026_portal/baseline/TB0/evidence/current-admin-1440-pipeline.png),
whose Pipeline rows visibly include Up/Down. The
[`TB0 Baseline Report`](./revamp_2026_portal/baseline/TB0/Baseline-Report.md) records an exact
`1440×900` browser viewport; the screenshot service omitted some browser-surface pixels, so the
stored image is shorter than 900 pixels. The recorded browser viewport, not the PNG height, is the
matching criterion for TB0B's after-state.

## Scope constraints

### Hard-preserved behavior

The implementation must leave these paths and semantics intact:

- `Admin → Pipeline` access through the existing `adminBackend` capability;
- `GET /api/admin/stages`, including `ensurePipelineStages()` and display-order/key sorting;
- `PATCH /api/admin/stages/:key` for `label` and `active` only, including its current validation,
  active-project conflict checks, `awaiting_raw` protection, `pipeline_stage.update` audit, local
  list reload, and shared `refreshStages()` call;
- authenticated `GET /api/stages`, role-safe `editing_autohdr → editing` presentation, active flags,
  and Dashboard/other consumer refresh behavior;
- the five `STAGE_KEYS`, `DEFAULT_STAGES`, `STAGE_TRANSITIONS`, seed rows, and every persisted
  `display_order` value; and
- `POST /api/projects/:id/stage`, project-level authorization, active-target validation,
  `boardPosition` behavior, audit, and delivery notification behavior.

### Explicit non-goals

TB0B does not add or remove Stage rows, expose Stage creation/deletion, add a transition builder,
change the fixed semantic graph, create a Project Workspace Stage picker, change Kanban sorting or
`boardPosition`, introduce `moveProjectStage`, or correct Kanban ordering. It does not add a schema
migration, backfill, new capability, new operator API, or production data rewrite.

## Implementation plan

### 1. Remove ordering from the Admin UI without disturbing label/activation flows

In [`Admin.tsx`](../../portal/apps/web/src/screens/Admin.tsx):

1. Delete `reorderStage()` and the Up/Down action markup. Change `stages.map((stage, index) => …)`
   to a Stage-only map because the edge-button index is no longer needed.
2. Narrow `updateStage`'s TypeScript patch from `label | displayOrder | active` to `label | active`.
   The API already accepts only those two fields; tightening the UI type makes the TB0B boundary
   explicit without changing runtime behavior.
3. Keep `displayOrder` in the `Stage` response type and keep the read-only order number in each
   row. Removing ordering authority is not permission to hide or recompute the persisted order.
4. Leave `loadPipeline`, Refresh, label-on-blur, active-checkbox handling, `stageError`,
   `loadPipeline()`, and `refreshStages()` unchanged. `apiPost` remains imported because other
   Admin tabs still use it.

In [`app.css`](../../portal/apps/web/src/styles/app.css), change `.admin-stage` from five desktop
columns to four, remove the unused `.admin-stage__actions` rule, and remove it from the mobile
grid-column selector. Preserve the current order/key/label/toggle geometry and responsive stacking;
confirm the exact spacing against the matched screenshot rather than adding a redesign.

### 2. Enforce the boundary by deleting the self-service route

In [`admin.ts`](../../portal/workers/app/src/routes/admin.ts):

1. Delete the `stageMove` Zod schema and the complete
   `adminRoutes.post("/admin/stages/:key/move", …)` handler, including the adjacent-row lookup,
   D1 swap, and `pipeline_stage.move` audit writer.
2. Do **not** replace it with a hidden Admin route, new capability, feature flag, no-op 200, or
   compatibility alias. An authenticated Admin direct call will reach the existing terminal API
   handler and return `404 { "error": "Not found" }`.
3. Keep `GET /admin/stages`, `PATCH /admin/stages/:key`, `stagePatch`, `adminAllowed`,
   `ensurePipelineStages`, and `listPipelineStages` intact.

Deletion is preferred over a permanent 403/410 stub because the only production caller is the UI
being removed, the route has no supported developer client, and the approved future write path is
D1 migration/script rather than an elevated version of this endpoint. A 404 makes the ordinary
self-service operation genuinely unavailable while retaining the centralized authenticated API
boundary. Historical `pipeline_stage.move` audit rows remain immutable history; no cleanup occurs.

### 3. Align source-of-truth wording without changing order logic

Update the stale source comments without changing data or code behavior:

- in [`packages/shared/src/stages.ts`](../../portal/packages/shared/src/stages.ts), replace
  “Admin-editable labels/display order” with language that labels are Admin-managed and global
  display order is developer-managed; and
- make the same wording correction in
  [`packages/db/seed/0001_seed.sql`](../../portal/packages/db/seed/0001_seed.sql).

The older A4 in [`Implementation-Plan.md`](../Implementation-Plan.md) conflicts with its promoted
A10 amendment. This is an authority-file amendment, not comment cleanup. Before implementation,
match and quote the current A4 exactly as follows:

```markdown
### A4 — Pipeline stage model (resolves PRD §7 vs §6.9 vs D-03)

- Stages have **stable machine keys**; Admin-editable **labels and display order** live in a `pipeline_stages` config table. Code and transitions reference keys only.
- MVP keys: `awaiting_raw`, `raw_review`, `editing_autohdr`, `edited_review`, `delivered`. **`client_review` is not shipped** (D-03); the key is reserved for a future review-link feature. Stage *reordering* is display-order only — transition logic does not change when labels/order change.
```

Replace that complete A4 section, and only that section, with this exact wording:

```markdown
### A4 — Pipeline stage model (resolves PRD §7 vs §6.9 vs D-03)

- Stages have **stable machine keys**; Admin-editable **labels and active/inactive status**, together with developer-managed **display order**, live in a `pipeline_stages` config table. Global display order is not ordinary Admin self-service. Code and transitions reference keys only.
- MVP keys: `awaiting_raw`, `raw_review`, `editing_autohdr`, `edited_review`, `delivered`. **`client_review` is not shipped** (D-03); the key is reserved for a future review-link feature. Stage *reordering* is display-order only — transition logic does not change when labels/order change.
```

Do not change A10 or any other authority text. As in TB0's authority-promotion precedent, approval
of the TB0B implementation plan is not permission to make this edit. After the implementation diff
is otherwise reviewable, present the literal replacement above and obtain a separate written owner
instruction that identifies the reviewed plan revision and says: “Approve the TB0B A4 authority
wording; replace A4 exactly as quoted in §3.” Record that instruction verbatim in the execution
record before editing `Implementation-Plan.md`. If the owner changes the wording, update this plan,
review the revised authority diff, and obtain approval again; if current A4 no longer matches the
quoted text, stop and review the intervening authority change instead of applying a fuzzy edit.

### 4. Rewrite and add focused tests

In [`workers/app/test/api.test.ts`](../../portal/workers/app/test/api.test.ts), split or rename the
existing combined Stage test and replace the successful-move expectation with boundary assertions:

1. Seed/read the rows and assert the exact existing key/order tuples are still `1…5` in the
   approved semantic sequence.
2. Capture `{ key, displayOrder }` and the count of `pipeline_stage.move` audit rows; make an
   authenticated Admin `POST /api/admin/stages/raw_review/move`; assert exact `404` JSON, byte-for-
   byte-equivalent order tuples afterward, and no new move audit row.
3. Retain the label PATCH assertion and then read through both `GET /api/admin/stages` and
   role-appropriate `GET /api/stages` to prove the new label reaches consumers without changing
   order.
4. Prove both successful activation directions through the API. Arrange a non-mandatory Stage with
   no unarchived project using it, PATCH `active: false`, assert `200` and `active: false` through
   both the Admin and public Stage reads, then PATCH `active: true` and assert `200` and
   `active: true` through both reads.
5. Cover both existing deactivation guards explicitly. Keep the `awaiting_raw` 409 assertion. Then
   arrange an unarchived project in a different active Stage, attempt to PATCH that Stage to
   `active: false`, and assert exact `409` JSON — `This stage is used by active projects and cannot
   be deactivated.` plus the expected `projectCount`. Re-read the row through the Admin and public
   endpoints to prove it remains active. Keep the inactive-target project-movement assertion as a
   separate preserved behavior.
6. Keep the separate successful `POST /api/projects/:id/stage` test unchanged and green, proving
   TB0B removed global configuration ordering rather than project Stage movement.

Add
[`portal/apps/web/src/screens/Admin.dom.test.tsx`](../../portal/apps/web/src/screens/Admin.dom.test.tsx)
to the existing happy-dom suite. Mock capabilities, `useStages`, and API helpers using current web
test conventions, open the Pipeline tab, and assert:

- the Stage rows and Refresh control render;
- no Pipeline-row button has `Up` or `Down` text and no request to a `/move` URL occurs;
- the read-only `1…5` values remain visible in the API-returned order;
- blurring a changed label calls `PATCH /api/admin/stages/:key` with only `{ label }`;
- changing the checkbox calls that same endpoint with only `{ active }`; and
- successful label/active mutations call both the Pipeline reload and `refreshStages()`.

Do not add brittle whole-page snapshots. Assert the policy controls, endpoint payloads, refresh
effects, and preserved fields directly.

## Developer-managed global order runbook

TB0B itself ships no order change and no migration. When an owner later approves a different
global order, use a **reviewed data migration by default**:

1. Record owner approval and a complete mapping for all five stable keys. Confirm that the change
   is presentation order only and does not alter `STAGE_KEYS`, `STAGE_TRANSITIONS`, project Stage,
   `boardPosition`, or automation semantics.
2. Before writing, capture the target environment with:
   `SELECT key, display_order FROM pipeline_stages ORDER BY display_order, key;`. Abort on missing,
   extra, or duplicate-order rows until the discrepancy is reviewed.
3. Update the five `DEFAULT_STAGES` and `0001_seed.sql` order values to the same approved mapping so
   `ensurePipelineStages()` and a fresh database do not recreate the old order. Do not change keys,
   labels, activation, transitions, or schema.
4. Re-check [`packages/db/migrations/meta/_journal.json`](../../portal/packages/db/migrations/meta/_journal.json)
   for the next number (currently `0030`; do not reserve it from this draft). From
   `portal/packages/db`, run
   `npx drizzle-kit generate --custom --name pipeline_stage_order_<reason>`, then replace the empty
   body with reviewed data-only SQL for already-seeded environments. Use one explicit
   `UPDATE … CASE key … END` covering all five keys so the full mapping is reviewable. Do not expose
   an API.
5. Test both lifecycle shapes: apply the new migration to a local database seeded at the previous
   version, and bootstrap a clean database through the full migration chain followed by the updated
   seed. Run the Stage integration tests and compare both postflight queries with the approved
   mapping. The custom migration and journal entry are committed and reviewed together; no schema
   snapshot is expected for a data-only migration.
6. **Recovery point.** Neither `CLAUDE.md` nor `docs/lessons.md` currently defines a concrete
   pre-migration recovery procedure; their D1 backup/restore guidance is conceptual. Until a
   repository-wide runbook supersedes this one, create and verify a Stage-table export. From
   `portal/workers/app`, choose an approved durable recovery directory outside the worktree, then
   run:

   ```bash
   TB0B_RECOVERY_DIR="<approved-durable-recovery-directory-outside-the-repo>"
   TB0B_RECOVERY_FILE="$TB0B_RECOVERY_DIR/quincy-portal-pipeline-stages-$(date -u +%Y%m%dT%H%M%SZ).sql"
   npx wrangler d1 export quincy-portal --remote --table pipeline_stages --output "$TB0B_RECOVERY_FILE"
   test -s "$TB0B_RECOVERY_FILE"
   shasum -a 256 "$TB0B_RECOVERY_FILE"
   TB0B_RESTORE_DIR="$(mktemp -d)"
   npx wrangler d1 execute quincy-portal --local --persist-to "$TB0B_RESTORE_DIR" --file "$TB0B_RECOVERY_FILE"
   npx wrangler d1 execute quincy-portal --local --persist-to "$TB0B_RESTORE_DIR" --command "SELECT key, label, display_order, active FROM pipeline_stages ORDER BY display_order, key;" --json
   ```

   Require every command to exit zero, the export to be non-empty, and the scratch-restore query
   to reproduce all five production rows. Record the durable artifact path, SHA-256, UTC capture
   time, and restored result in the owning change plan; do not commit the production export. Stop
   if the artifact cannot be restored and queried.
7. **Production preflight.** After the verified recovery point, repeat the read-only remote query
   from step 2 and retain its JSON output. Abort on any mismatch with the locally tested before-map
   or with the approved five-key preconditions.
8. **D1 migration.** From `portal/workers/app`, apply the reviewed ledger entry with
   `npx wrangler d1 migrations apply quincy-portal --remote`. Stop on any error; do not deploy a
   Worker against an uncertain migration result.
9. **App Worker deployment.** From that same directory, run `npx wrangler deploy` so the app Worker
   now contains the reviewed `DEFAULT_STAGES` mapping that matches the migrated D1 rows and updated
   seed.
10. **Production postflight.** Repeat the exact remote order query and compare all five tuples with
    the approved mapping; also confirm labels and active flags still equal the captured before-map.
11. **Smoke test.** Check Admin Pipeline and Dashboard columns against the approved mapping, then
    record the migration name, app Worker version, before/after maps, recovery artifact/hash,
    approval, and result in the owning change plan/todo entry.

This production order is deliberate: the existing Worker already reads persisted
`pipeline_stages.display_order`, so the reviewed data-only migration can safely land first. Deploying
the new Worker first would create a window where its compiled defaults disagree with production D1
and could seed a missing row with the new mapping before the migration's full-map preconditions run.
Stopping after D1 would leave the opposite drift: a later `ensurePipelineStages()` call from the old
Worker could recreate a missing row with the old defaults. Migration then app deployment minimizes
the drift window and makes both persisted rows and fallback seeding agree before postflight QA.

An explicit maintenance script is the exceptional alternative when a one-time ledger migration
cannot safely express the operation. Follow the checked-in
[`portal/scripts/bulk-archive-delete-july-2026.mjs`](../../portal/scripts/bulk-archive-delete-july-2026.mjs)
precedent: put the reviewed script under `portal/scripts/`, default to dry-run, require an explicit
`--live`, print current and proposed complete maps, abort on any precondition mismatch, use one
idempotent guarded update, stop on failure, and print a postflight map. The script must not call or
recreate `/api/admin/stages/:key/move`, and an ad hoc remote `UPDATE` pasted into a terminal is not
an approved ordering path.

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run all four repository-standard commands:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

The workspace command's repository-documented missing-`test`-script handling for
`@quincy/shared` must not hide a real suite failure: record every workspace suite result, and use
the fourth command for the shared suite. The gate is green only when every actual suite and the
dedicated shared suite pass.

Before and after the implementation, run the same read-only local/target query and retain the
result with the verification record:

```sql
SELECT key, display_order
FROM pipeline_stages
ORDER BY display_order, key;
```

The two results must be identical for TB0B. No migration is applied in this change.

### Browser/API QA checklist

Using the local app Worker at `http://localhost:8787` and the documented seeded Admin:

1. Open `Admin → Pipeline`; confirm it loads all five rows and Refresh reloads them without console
   or network errors.
2. Confirm no Up/Down controls, action-column gap, keyboard focus target, or `/move` request exists.
3. Change a label locally, blur, confirm it persists after Refresh and reaches a Stage consumer;
   restore the original label before evidence capture.
4. On a locally verified unused Stage, toggle inactive and active again. Confirm the Admin row and
   Dashboard Kanban Stage consumer refresh each time; restore the original active state.
5. With an authenticated Admin session, call `POST /api/admin/stages/raw_review/move` directly and
   confirm `404 { "error": "Not found" }`; repeat the order query and confirm no change.
6. Move a disposable local project through the existing project-level Stage path and confirm it
   still succeeds under its current authorization/active-target rules. Do not use this check to
   add the future Project Workspace picker or `moveProjectStage` contract.

### Matched evidence

Use the TB0 before-state
[`current-admin-1440-pipeline.png`](./revamp_2026_portal/baseline/TB0/evidence/current-admin-1440-pipeline.png)
for direct comparison. Set the browser page viewport to exactly `1440×900`, verify
`window.innerWidth`/`window.innerHeight`, restore original labels and active states, and capture the
after-state as:

`docs/plans/revamp_2026_portal/evidence/TB0B/admin-pipeline-after-1440.png`

Visually inspect and record that the rows, order numbers, labels, toggles, Refresh control, Quincy
typography, spacing, and borders match the baseline except for the intentional removal and grid
reflow of Up/Down. Redaction-check before committing the PNG using TB0's evidence rules. Record the
before/after paths, viewport, console/network result, direct-call result, and order-query equality
in this plan's eventual implementation status note.

### Deployment

TB0B changes only the web bundle and app Worker API. After review and the full gate, deploy the app
Worker (which serves `apps/web/dist`) with:

```bash
cd portal/workers/app
npx wrangler deploy
```

No background or webhook-ingress deploy and no D1 migration are required. Smoke-test production
Admin Pipeline, the direct move URL, label/activation behavior, shared Stage consumers, and the
unchanged order query. Only after production verification should the plan status be updated with
the commit, `docs/todo.md` be updated, and this file be moved with `git mv` to
`docs/plans/implemented/`.

## Rollback constraint

The code has no data migration to reverse, but reverting it would restore both the ordinary Admin
ordering UI and the authenticated move writer. That reopens the policy boundary A10 and TB0B
deliberately close. Therefore rollback of this specific change is **not** a routine automatic
revert: it requires the same explicit owner approval as the original boundary decision, with the
reason and exposure window recorded. Without that approval, fix forward while keeping the move
route absent. Any approved rollback must re-run the order query before and after so an accidental
move is not concealed.

## Acceptance checklist

- [ ] `Admin → Pipeline` loads and Refresh works with all five existing rows and read-only order
      numbers.
- [ ] Up/Down controls, `reorderStage`, action CSS, and every browser caller of the move URL are
      absent.
- [ ] Authenticated `POST /api/admin/stages/:key/move` returns the centralized 404, writes no Stage
      values, and adds no `pipeline_stage.move` audit row.
- [ ] `GET /api/admin/stages`, `PATCH /api/admin/stages/:key`, and `GET /api/stages` retain current
      authorization, validation, guard, audit, role-projection, and refresh behavior.
- [ ] Label editing and active/inactive toggling pass component, Worker integration, and manual QA;
      active/inactive Stage consumers refresh.
- [ ] `DEFAULT_STAGES`, seed values, persisted key/order tuples, Stage transitions, and existing
      project Stage values are unchanged; pre/post order evidence is identical.
- [ ] Existing `POST /api/projects/:id/stage` tests and manual smoke remain green; no Project
      Workspace, Kanban ordering, creation/deletion, or dynamic-transition scope has entered TB0B.
- [ ] The developer-managed order runbook is reviewable and no replacement ordinary API exists.
- [ ] Matched 1440×900 before/after Admin evidence is captured, redaction-checked, and visually
      reviewed.
- [ ] Typecheck, web build, every workspace test suite, the dedicated shared suite, API/manual QA,
      production smoke, and order-query comparison are green.
- [ ] Any rollback has explicit owner approval because it reopens Admin ordering.
