# TB5A branch diff review — consolidated findings

4 fresh Sol reviews (shared+db, workers-app, workers-bg, web), each adversarial, plan-referenced.
**All 4 verdicts: REVISE.** §5 gate is green — these are correctness/security/rollout gaps the
gate's tests don't exercise (tests always enable the flag, use invalid bodies for withheld routes,
assert Stage-moved without checking side-effect footprint).

Orchestrator spot-verified the 4 highest-impact findings against the actual code — **all confirmed
exactly as reported.** Every blocking finding is a **build defect against the APPROVED plan**, not a
plan defect (the plan's `## Automatic workflow safety and ABA fencing` explicitly requires the
workflow premise *in the winner's fence*; the build put it only in trailing SELECTs).

---

## BLOCKING (15)

### A. Winner bundle does not transactionally fence the workflow prerequisite — ABA bypass
**#1-B1, #3-B1.** `packages/db/src/stage-board-bundles.ts` `NON_COMPACTING_EXACT_SQL` /
`NON_COMPACTING_APPEND_SQL` — the `fence AS MATERIALIZED` checks only the feature flag + expected
destination-column state. It does **not** fence the handoff/mapping/job/claim identity, generation,
connection, state, or prior token. `workers/background/src/lib/automatic-stage.ts:140-176` composes
the winner, runs the batch, then checks the workflow tail with post-hoc `SELECT`s. **A zero-row
tail is not a SQL error → D1 commits the Stage move + `board_revision` bump + `stage.auto_advance`
audit**, and `commitAutomaticStage` only *then* returns `invariant_failure`. ABA scenario (plan
~1623): entry rev5→ human out rev6 → human back rev7 → stale completion still moves the project to
`edited_review` at rev8 and writes the audit; the fence never stopped it.
- Plan (~1508): *"fences the precise handoff or job identity, generation, project, and expected
  prior token **in its winner premise**"* … *"The winning Stage predicate contains the same owner
  identity, generation, project, and prior-token premise, so a Stage winner cannot legitimately
  produce a zero-row token tail."* The build did not do this.
- **Fix:** compile the closed typed `WorkflowTailPrerequisite` into the winner's `fence AS
  MATERIALIZED` (and the compacting winner's fence) as additional `AND EXISTS(...)` premises, so a
  stale premise makes the winner UPDATE match zero rows and nothing commits. Keep the tails as
  confirmation/RETURNING, but add a **terminal batch-aborting assertion** (a statement that raises
  on inconsistent shape) so any surviving inconsistency rolls back the whole batch. Remove the
  ungated `prefix` facility (`automatic-stage.ts:132,166-167`) — arbitrary caller statements run
  before the fence and commit regardless.
- **Tests:** full-bundle stale-premise matrix (wrong generation / connection / state / token /
  missing provenance / ABA) each asserting **zero** Stage, revision, audit, activity, outbox,
  notification, token footprint.

### B. Editing-completion revision comparison is off by one — every valid completion misreported
**#1-B2.** `automatic-stage.ts:103-108` `workflowTailAgrees` compares the stored source entry
token against `winner.row.boardRevision` (the **post-update** revision N+1). A legitimate
completion recorded token N at entry and the winner moves N→N+1, so `N === N+1` is false →
`invariant_failure` → the `edited_landed` notification is skipped on every real completion.
- **Fix:** compare the stored entry token against the **pre-update** revision (`oldBoardRevision`,
  == `winner.row.boardRevision - 1`), while the winner fence pins the source row to exactly that
  revision.
- **Tests:** valid completion → `winner` + notification; ABA (stored ≠ pre-update) → zero footprint.

### C. Hourly reconciliation lost its shoot-date fence
**#3-B2.** `workers/background/src/reconcile-awaiting-raw.ts:85` calls `commitAutomaticStage` with
`workflow.kind: "none"`. The pre-TB5A path required `shoot_date = ?<scanned value>`. A project
whose shoot date changes between the scan and the write still advances out of `awaiting_raw`.
- **Fix:** add a typed `raw_reconciliation` premise (exact project id + `shoot_date IS <scanned>`)
  to the winner fence (the `GuardedTransitionPrerequisite` union + `WorkflowTailIndexes` already
  have `raw_reconciliation`; wire it). Test: changed date between scan and write → no Stage/audit.

### D. Retained legacy `{direction:"up"|"down"}` reorder path bypasses the exact-neighbour contract
**#2-B2, #4-B2.** `workers/app/src/lib/project-board-order.ts:72,326,334-343` accepts
`{direction}`, synthesizes `expected` from **current** DB state (so a stale caller is undetectable),
and `directionPlacement` collapses any drop to a one-slot move. `routes/projects.ts` board-position
route + `apps/web/src/screens/Dashboard.tsx:479,511,410` build/send that legacy body; a
multi-card same-column drop moves one slot and silently rebases; a non-bottom→bottom same-Stage
move is rejected as "append".
- Plan `### Canonical hidden-neighbour rule` (~648): same-Stage reorder is the exact
  `{expected:{stageKey,boardRevision}, targetStageKey, placement:{between|append}}` command with
  `{projectId, boardRevision}` neighbours from the authorized `orderedProjectIdsByStage` map.
- **Fix:** delete the `{direction}` arm from `moveProjectBoardOrder` + its type; `/board-position`
  accepts only `MoveProjectStageRequest`. Dashboard same-column drag builds the placement with
  `cardDropPlacement` and submits the full contract; arrow / keyboard controls derive an exact
  adjacent `{projectId, boardRevision}` placement. Server decides the true no-op.
- **Tests:** far-boundary drop, bottom-append of a non-bottom card, stale-revision neighbour,
  unchanged-slot.

### E. Project creation is still feature-flag-gated in the INSERT
**#2-B1.** `workers/app/src/routes/projects.ts:~292` — `createProjectAtomically`'s conditional
INSERT still ends `AND EXISTS (SELECT 1 FROM feature_flags WHERE key =
'tb5a_board_contract_enabled' AND enabled = 1)`, contradicting the route comment at ~379 and
accepted deviation 3. Flag-OFF → INSERT writes 0 rows → `422 ineligible_project_assignments`
(misleading; the studio cannot onboard shoots during the rollout window).
- **Fix:** remove that `AND EXISTS(feature_flags…)` line only (keep the `pre_0037` 503 + the
  eligibility predicates + `board_revision` default 0 + append position). Add a flag-OFF creation
  test: succeeds, appends at Stage bottom, `board_revision = 0`. Apply the identical rule to Tonomo
  project creation if it has the same predicate.

### F. Both Stage routes classified `withheld` though assigned External Editors are authorized
**#2-B3.** `workers/app/src/lib/terminal-route.ts:170-171` lists `POST /projects/:id/stage` and
`/stage/` as `withheld`. External Editors with `moveProjectStage` are authorized for assigned
projects. The manifest test sends `{}` and reads the resulting `400` as an External denial — it
can detect neither an accidental lockout nor an unsafe success body.
- **Fix:** reclassify both as assigned-project / external-safe surfaces; probe a **valid**
  `MoveProjectStageRequest` for assigned / unassigned / archived / nonexistent External projects,
  asserting `moveProjectStageResponseSchema` (assigned) and generic `404` (the rest, before any
  existence-revealing branch).

### G. Auth ordering — schema/flag admission precedes constant capability denial
**#2-B4.** `project-board-order.ts:317-322` and `routes/projects.ts:965-969` (archive/restore)
return `503 board_schema_maintenance` / `503 board_contract_disabled` **before** checking the
principal's capability. A flag-OFF External Editor hitting a withheld board-position / archive /
restore route learns the rollout state (`503`) instead of getting their TB4E constant `403`.
- **Fix:** resolve + reload the principal and check the capability first on withheld endpoints,
  then the operational schema/flag responses. Add flag-OFF External probes → constant `403`.

### H. Same-Stage neighbour validity evaluated before the `prioritizeProjects` check
**#2-B5.** `workers/app/src/lib/project-stage.ts:153-159` — a placement-changing same-Stage
request from an Editor (no `prioritizeProjects`) returns `409` when the neighbour tokens are stale
or malformed, instead of the required constant `403 project_board_reorder_forbidden` with zero
mutation footprint.
- **Fix:** classify whether the requested logical slot changes (using the authorized projection),
  deny an unauthorized change with the constant `403` first, then validate revisions / fencing.

### I. Pre-enable position rollback is unsafe once flag-OFF creation exists
**#1-B3.** `packages/db/src/board-order-rollback-0037.ts:7` `rollbackBoardOrder0037PreEnable`
restores every captured row but has no same-batch guard for **unarchived projects absent from the
0037 capture** (a flag-OFF-created rev-0 row) and no monotonic **never-enabled** evidence check.
Result: rollback "succeeds" while leaving the new row at a colliding/re-ordered position; an
enable→disable history also stays eligible.
- **Fix:** add same-batch guards — abort if any unarchived project lacks a capture row, and if the
  flag has ever been enabled (durable evidence). Tests for both.

### J. `schema.ts` omits the three new columns' CHECK constraints
**#1-B4.** `packages/db/src/schema.ts` `projects.boardRevision` (~171),
`autohdrHandoffs.editingEntryBoardRevision` (~635), `jobs.stageEntryBoardRevision` (~1040) are
declared without the safe-integer `CHECK(...)` that migration `0037` applies; `0037_snapshot.json`
therefore omits them. A future `drizzle-kit` table rebuild would silently drop the physical
constraints.
- **Fix:** model the three named checks in `schema.ts` + regenerate so `0037_snapshot.json`
  carries them, **without** turning `0037` into a rebuild migration and with `generate` still a
  no-op afterward and the migration/schema diff clean.

### K. Web Priority editor is flag-gated
**#4-B1.** `apps/web/src/screens/Dashboard.tsx:619` gates the Priority editor on
`boardContractEnabled`. Priority is metadata-only and flag-exempt. The companion test
`Dashboard-kanban-sort.dom.test.tsx:76` codifies the wrong behaviour with an impossible
post-marker populated list + empty order map.
- **Fix:** gate Priority editing/view on `canPrioritize` + post-schema map availability only,
  independent of the Board mutation flag. Fix the test to seed the project in
  `orderedProjectIdsByStage` and assert Priority stays available while only Stage drag / manual
  reorder are disabled.

### L. Weak final-completion prerequisite (autohdr finals)
**#3-B3.** `workers/background/src/autohdr/finals.ts:126` passes only the natural-key final claim
+ handoff/mapping ids. It does not carry the fetch claim, mapping generation/connection/project/
state, handoff generation/state, or the manifest fence re-read at 182-213. A mapping or fetch
owner retired between the read and the Stage batch still permits `edited_review`.
- **Fix:** keep the accepted natural-key claim identity, but expand the same-batch prerequisite
  (now in the winner fence per A) to the full handoff/mapping/fetch identity + current states.
  Test each independently-stale field → no Stage/audit/revision/notification.

### M. Claim ownership commits before the Stage batch (repeat / implicit / backfill)
**#3-B4.** `workers/background/src/autohdr/claims.ts:394,664,923` write repeat/implicit/backfill
ownership rows, then run a **separate** Stage batch. Repeat-send returns success for `loser` /
`deferred`; implicit + backfill return successful owners even when Stage did not advance. A manual
move in the gap leaves a retired prior owner or a new `starting`/`started` handoff with no
Editing-entry token.
- **Fix:** fold claim ownership + Stage + audit + token into one rollback-capable batch (ownership
  statements become part of the fenced bundle / `betweenStageAndWorkflow`), or fail the whole claim
  transaction via the terminal guard when Stage loses. Never return a successful owner on a Stage
  loss — return conflict. Gap-race tests for all three.

### N. `claims.ts:160` / `autohdr.ts:280` idempotent-success fallback ignores the entry token
**#3-B5.** `claims.ts:160` treats *any* `started` handoff whose project is currently in
`editing_autohdr` as idempotent success — ignoring input project / connection / generation /
archive state / whether `editing_entry_board_revision` equals the current `board_revision`. After a
`5→6→7` move-out/re-entry an old handoff passes.
- **Fix:** require exact project + connection + generation, active state, unarchived
  `editing_autohdr`, and stored entry token == current `board_revision`. Same recheck at
  `workflows/autohdr.ts:280`.

---

## SHOULD-FIX (8)

1. **#1-S1 / #3-S3** — remove `guardedStageTransition` compat shim + `packages/db/src/index.ts:7`
   barrel export + stale compat tests entirely (it accepts arbitrary `string` Stage keys via
   `as never`, no workflow premise). Plan's final-interface requires the removal; all production
   callers are gone. Rewrite the remaining tests to exercise `commitAutomaticStage`.
2. **#1-S2** — `stage-board-bundles.ts:148` `featureFlagKey` param lets any caller substitute an
   unrelated enabled flag. Remove it; bind `BOARD_CONTRACT_FLAG` internally.
3. **#1-S3** — `board-schema-variant.ts:29` caches a **rejected** marker-query promise forever
   (eviction only on success). Evict the pending promise on rejection so a transient D1 failure
   doesn't poison the isolate.
4. **#4-S1** — `apps/web/src/lib/stage-move.ts:22` casts an unvalidated error-payload array to
   `StageMoveConfirmationReason[]`. Validate against `STAGE_MOVE_CONFIRMATION_REASONS` +
   uniqueness + constant order; a malformed confirmation response is a contract error, no second
   request. Malformed/duplicate/reordered tests.
5. **#3-S1** — `workflows/autohdr.ts:260` + `autohdr-api-send.ts:26` "defer" by returning from the
   Workflow, which **completes** it permanently. A flag disabled after claim but before execution
   strands the job with no resume. Use a durable paused/retryable state with bounded backoff,
   preserving the frozen owner + job until the flag is enabled.
6. **#3-S2** — `workers/background/src/index.ts:766` acks maintenance-window queue messages without
   replay intent; `do/dropbox-sync.ts:127` deletes its alarm; `do/tonomo-processor.ts:49` keeps an
   event without scheduling a drain. One maintenance-window event can be lost/stalled. Preserve
   durable work + schedule one bounded retry/resume.
7. **#2-S1** — `routes/projects.ts:1009-1013` reports every lost archive fence as "Active document
   uploads," including a concurrent Stage/revision change. Distinguish document-session rejection
   from optimistic-snapshot loss → `409 project_stage_conflict` for the latter.
8. **#3-S4** — `workers/background/src/index.ts:94` passes `notifyProject` into the hourly winner
   callback and `reconcile-awaiting-raw.ts:127` awaits it inside the mutation result — a
   notification outage turns an already-committed winner into a reported reconciliation failure the
   next scan can't retry. Best-effort catch+log after counting the committed winner.

---

## Assessment

- All blocking = build defects against the approved plan → **fix loop, handed to Luna** (not a plan
  revision).
- **A is architectural** — it re-shapes the Slice 3 winner-fence SQL + Slice 6 automatic writers +
  every token tail. L, M, N, C all fold into A's "premise in the fence" rework.
- D + K + #4-S1 are the web/route half; E, F, G, H are route-auth fixes; I, J are migration-adjacent.
- Estimate: 1 large Luna fix pass for A+C+L+M+N (db + background), 1 for D+E+F+G+H (routes) + K +
  #4-S1 (web), then §5 gate + a fresh focused Sol pass on the fence rework + Opus final-draft.
  Realistically 2–4 Luna rounds.
