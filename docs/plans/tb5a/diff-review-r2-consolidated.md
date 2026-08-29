# TB5A second diff review — consolidated (3 Sol reviews of `35766b3..HEAD`)

All 3 areas: **REVISE**. The fence core is sound (A/B/C/L/J/SF2/SF3/SF8 + D/E/F/G/H/K/SF4 CLOSED).
6 blocking + 3 should-fix, all call-site / durability gaps against the fence design.

## VERIFIED CLOSED

B (N5 off-by-one), C (reconcile shoot-date code), D, E, F, G, H, J (schema CHECK/snapshot faithful,
0037 + journal untouched), K, L (full final-claim fence), SF2 (featureFlagKey gone), SF3 (variant
cache reject-evict), SF4 (web reason validation), SF8 (best-effort notification).

## BLOCKING

### R2-B1 — job-entry provenance closed-bundle contract is broken (DB-1 + BG overlap)
`packages/db/src/stage-board-bundles.ts:509-510, 652-668, 1812-1819` +
`workers/background/src/lib/automatic-stage.ts:287-296` + `workers/background/src/workflows/autohdr.ts:302-307`.
- `workflowDurablePostconditionSql()` returns literal `1` for **every** job-entry workflow → an
  API-send / legacy-job Stage winner's **terminal assertion cannot roll back** if its Stage-entry
  token tail returned zero rows. The winner + audit commit; the token is never written; nothing aborts.
- `job_entry_provenance` coupling postcondition unconditionally includes
  `j.stage_entry_board_revision = ?3 + 1`, but in the **ownership** assertion `?3` is the coupling
  JSON doc, so SQLite coerces it to `0` and compares the token to `1` — always mismatches for a
  real token.
- The destination path "fixes" this by **omitting the ownership assertion entirely**
  (`automatic-stage.ts:287-296`), and `autohdr.ts:302-307` has a comment preserving the deviation.
- **Fix (per design §3/§4):** (a) the `job_entry_provenance` **coupling** predicate = the
  token-free provenance predicate (job id/kind/project/status + payload self-provenance +
  generation), NO token term; (b) the job-entry **workflow durable** predicate (used by the
  terminal assertion, where `?3` = `oldBoardRevision`) = that same predicate **plus**
  `j.stage_entry_board_revision = ?3 + 1`; (c) append `OX(job_entry_provenance)` to the
  destination-only provenance batch (`automatic-stage.ts` + `autohdr.ts`); (d) delete the
  compatibility comment/exemption.

### R2-B2 — repeat-send `already_at_destination` inserts the handoff as `starting`, assertion needs `started`
`workers/background/src/autohdr/claims.ts:545, 585, 589-604, 629-638`. The repeat-send destination
bundle inserts the new handoff `state='starting'`, but its `repeat_claim` ownership assertion
requires `expectedFinalHandoffState:"started"` → **every repeat send initiated while the project is
already in `editing_autohdr` aborts on its own assertion.**
- **Fix:** build a destination-specific repeat ownership bundle that inserts `state='started'` +
  `started_at`, then runs `OX(repeat_claim)` and returns the owner. Add a destination-path test:
  ownership commits, **zero** Stage/revision/audit/notification footprint.

### R2-B3 — implicit / backfill return a committed owner on `deferred` / `loser`
`workers/background/src/autohdr/claims.ts:855-895, 1074-1138` + `automatic-stage.ts:250`. A flag
flip between the caller's initial `automaticBoardWritesEnabled` check and `commitAutomaticStage`
yields `deferred` **before any ownership batch runs**, yet implicit falls through to a minted owner
and backfill returns `{ok:true}`. `loser` is similarly unhandled.
- **Fix:** return success only for `winner` **or** `already_at_destination`; map every other outcome
  (`deferred`, `loser`, `conflict`, `invariant_failure`) to the caller's specified conflict/failure
  result (implicit → `null`; backfill → `{ok:false, reason}`; repeat → `ERR_HANDOFF_BLOCKED`). Add
  a flag-flip-gap test per path: no owner returned, no ownership rows exist.

### R2-B4 — Finding N NOT CLOSED — handoff-confirmation idempotent recheck is token-blind
`workers/background/src/autohdr/claims.ts:150-170` + `workers/background/src/workflows/autohdr.ts:263-275`.
`confirmAutoHdrHandoff` does not treat the closed destination bundle's `already_at_destination` as
success; it keeps a weak post-hoc `loser` fallback that checks **only** handoff `state` + project
`stage_key`. The Workflow ignores the returned boolean and repeats that weak check — omitting
archive state, connection, generation, project identity, and
`editing_entry_board_revision = projects.board_revision`. An old handoff passes after a `5→6→7`
ABA re-entry.
- **Fix (design §4 idempotent recheck SQL):** treat `already_at_destination` as success; delete the
  weak fallback; the Workflow **requires** the returned confirmation result; the recheck is the
  exact query — `h.id = ?1 AND h.project_id = ?2 AND h.connection_id = ?3 AND h.generation = ?4 AND
  h.state = 'started' AND h.editing_entry_board_revision IS NOT NULL AND p.archived_at IS NULL AND
  p.stage_key = 'editing_autohdr' AND p.board_revision = h.editing_entry_board_revision`. Add the
  identity/archive/token ABA regression matrix.

### R2-B5 — Finding I PARTIAL — never-enabled evidence is not durable
`packages/db/src/board-order-rollback-0037.ts:40-52`. The guard uses `updated_by IS NOT NULL` as
"ever enabled" evidence, but `feature_flags.updated_by` is `ON DELETE SET NULL`
(`schema.ts:62`, `0032_admin_impersonation.sql:12`). enable → disable → delete the enabling user →
row is `enabled=0, updated_by=NULL` → rollback wrongly admitted despite prior enablement.
- **Fix:** record enablement in **immutable, non-FK** evidence. Cleanest: the enable operation
  (wherever the flag is flipped to 1 — the admin flag-toggle route) writes a fixed
  `audit_log` event (e.g. `action = 'feature_flag.tb5a_board_contract_enabled.enabled'`,
  `target_type='feature_flag'`) transactionally with the flag update; `rollbackBoardOrder0037PreEnable`
  aborts if any such event exists. (`audit_log` has no FK to `user` that nulls on delete — verify;
  if it does, use a dedicated marker table with no FK.) Add an enable→disable→updater-deletion
  rollback-refused test.

### R2-B6 — SF7 PARTIAL — archive loser classifier mis-orders upload vs Stage-conflict
`workers/app/src/routes/projects.ts:1012` (+ the no-source branch at `:983`). The classifier checks
for an active `document_uploads` row **before** comparing current Stage/revision with `source`. If
both changed, it returns the upload message even though the optimistic snapshot was lost.
- **Fix:** one centralized loser classifier, in order: missing/already-archived → (Stage or
  `board_revision` != `source`) → `409 { code: "project_stage_conflict", current }` → active upload
  → the upload-specific `409` → otherwise generic `project_stage_conflict`. Same for `:983`. Test:
  simultaneous revision change + active upload → `project_stage_conflict`; no-source concurrent
  restore race.

## SHOULD-FIX

- **R2-SF1** — `workers/app/src/routes/projects.ts:34, 448`: `/board-position` parses with the
  generic `moveProjectStageRequestSchema`, so it accepts the moving project itself as a `between`
  neighbour → later a misleading `409` instead of a clean reject. Parse with
  `moveProjectStageRequestSchemaForProject(id)` (matches `/stage` and the shared contract).
- **R2-SF2** — `packages/db/test/stage-board-bundles.test.ts:414-480`: the stale-premise matrix
  exercises the token tail in isolation, not the composed winner bundle. Add composed exact /
  append / compacting bundle runs with each independently-stale premise field + malformed
  premise/coupling, asserting the full zero-footprint matrix (Stage row, revision, audit, activity,
  outbox, ledger, notification, token, ownership rows).
- **R2-SF3** — `workers/background/test/autohdr-versioning.test.ts:126` + `reconcile-awaiting-raw.test.ts:55`:
  add the independently-stale handoff/mapping/fetch/manifest/final-path matrix for final completion
  (finding L), and a real-D1 `shoot_date`-changed-between-scan-and-write race test (finding C) —
  each asserting zero Stage/audit/notification footprint.

## Assessment

All build defects against the fence design. One Luna fix round: R2-B1 (fence SQL — the biggest),
R2-B2/B3/B4 (`claims.ts` + `autohdr.ts` ownership/idempotency), R2-B5 (needs the enable-op to write
an immutable marker — small design decision, resolved above), R2-B6 + R2-SF1 (routes), + the 3 test
matrices. Then §5 gate → Opus final-draft.
