# Opus FINAL verification of Sol fence r3 — VERDICT: APPROVE WITH FIXES

6 mechanical changes, exact text supplied, **no further design round**. Build-ready for Luna (xhigh),
1–2 rounds. Opus reproduced N1/F1/F2 in SQLite 3.51 and column-checked all new SQL vs schema.ts.

## Per-finding

| Finding | Status |
|---|---|
| N1 fail-open assertion | CLOSED — inversion verified; malformed doc aborts, legit winner no-ops. Two residual 3VL leaks → Fix 2. |
| N2 repeat_claim double-eval | CLOSED — one document, one evaluation point (post-tail); terminal coupling postcondition is a strict superset of the removed mid-batch check. |
| N3 hourly reconciliation | CLOSED — `workflowResultIndexes` → `[]` for `{kind:"raw_reconciliation"}`; `workflowTailAgrees` → `true`; premise + durable postcondition both 2VL fail-closed. |
| N4 path-column/case mismatch | CLOSED — postconditions compare `pc.path_key` only; connection/project already pinned correctly by the collision lookup; no remaining unwritten pinned column. |
| N5 off-by-one | CLOSED for entry + fetch-job-completion paths. **X1: re-created on `autohdr_final_completion`** → Fix 1. |
| N6 undefined types | CLOSED structurally — all 4 types defined, `workflow: GuardedTransitionPrerequisite`, post-marker start-tail slot exists. **X2** (missing kind→tail-kind map), **X3** (`workflow_check` effect has no `?3`) → Fixes 3, 4. |
| N7 sourceJobKinds | CLOSED at premise; **not at the tail** (`kind = ?`) → Fix 6. |
| Item 3 (7th collision postcondition) | CLOSED — column-clean; last disjunct not vacuous. |
| Item 4 (5 postconditions restated) | CLOSED — no stale singular key; all 2VL fail-closed. |
| Item 5 (API-send control flow) | CLOSED — `catch` shape correct; `providerFinalized` re-set on replay; `status IN ('running','done')`; `:180` throw → log + `stageAdvanced:false`. |
| Item 9 (APPEND selector) | PARTIAL — APPEND fix real, but the new `UPDATE autohdr_handoffs` start-tail literal collides with `NORMATIVE_HANDOFF_EDITING_ENTRY_TOKEN_SQL`'s selector → Fix 5. |
| Item 10 (key-completeness) | CLOSED — ordered exhaustive key check + undefined scan; `pathClaims.length === 2` enforced. |
| Item 11 (B1 remediation) | CLOSED — `moveProjectStage` remediation (option 2) is workable; option 1 unspecified but unneeded. |

## New blocking (both die to one COALESCE wrapper)

- **F1** — `?8 = NULL` reopens N1. `json_valid(NULL)` → NULL (not 0), so `NOT json_valid(coupling)` is
  NULL, never TRUE. r2's C4 blessed a `?8`-bound-NULL trick. Reproduced: valid premise + `?8=NULL` +
  NULL coupling predicate → no abort.
- **F2** — `json_array_length(json_extract(?8,'$.pathClaims')) = 2` (r3:686) is the only non-2VL
  conjunct in all 12 postconditions. Valid doc + absent `$.pathClaims` → NULL → `NOT (NULL)` → whole
  WHERE NULL → no abort. Reproduced.

## The 6 fixes (all exact text in the Opus report)

1. **X1** — `stage-board-bundles.ts:951` handoff-state SELECT: add `, editing_entry_board_revision`
   to the projection (index unchanged).
2. **F1+F2** — wrap every 3VL site in `TERMINAL_ASSERTION_SQL` + `OWNERSHIP_ASSERTION_SQL` with
   `COALESCE(..., 0)`: `NOT COALESCE(json_valid(i.premise_doc),0)`,
   `NOT COALESCE((${workflowDurablePostconditionSql}),0)`, etc. AND `?8` is always a canonical JSON
   string — bind `'{"kind":"none"}'` for `coupling:{kind:"none"}`, never JS `null`. Compiler
   assertion + test.
3. **X2** — add `workflowTailKindFor(p: GuardedTransitionPrerequisite): WorkflowTailKind` mapping
   (`autohdr_handoff`→`autohdr_handoff_entry`, `autohdr_job`+mode→`_entry`/`_completion`, …) and call
   `workflowTailAgrees(results, workflowTailKindFor(input.workflow), …, oldBoardRevision)`.
4. **X3** — `effect.kind === "workflow_check"` binds `?3 = boardRevision - 1`, permitted ONLY for
   `autohdr_handoff` / `autohdr_mapping` premises. For `autohdr_job` completion + `autohdr_final_claim`
   the destination effect must be `{kind:"none"}` and the caller returns `stageAdvanced:false`. Strike
   the "read-only job/final-completion durable predicate" rows from §2 table + r3:1521/1527.
5. **Item 9 residual** — `stage-board-bundles.test.ts:169`: disambiguate the two `UPDATE
   autohdr_handoffs` normative literals with compound `.includes(...)` selectors
   (`editing_entry_board_revision = (` vs `state = 'started'`).
6. **N7 tail** — `stage-board-bundles.ts:976`: `kind = ?` → `kind IN (SELECT value FROM
   json_each(?))`, bound `JSON.stringify(prerequisite.sourceJobKinds ?? ["autohdr"])`.

## Builder conditions (no design left — carry into the Luna spec)

- Keep `Object.entries(indexes).find(...)` accessor in `workflowTailAgrees` (narrowing `kind`
  doesn't narrow the `WorkflowTailIndexes` union).
- Write the coupling `EXPECTED_KEYS` table (7 entries) mirroring the prerequisite table.
- Job-entry workflow postcondition: substitute `?8`→`?4`; place `AND j.stage_entry_board_revision =
  ?3 + 1` INSIDE the `EXISTS` where alias `j` is in scope.
- Add an e2e `writeAutoHdrFinal` → `edited_landed` test (mirrors r3:1832) — catches X1.
- `OWNERSHIP_ASSERTION_SQL` also pins `EXISTS (projects p WHERE p.id=?1 AND p.stage_key=<dest> AND
  archived_at IS NULL)` — stage key only, never `board_revision`.
- `composeStageBundle`'s `append()` must skip `undefined` optional index values or they become `NaN`.
- `finals.ts:126` must now supply `fetchClaimId`, `fetchJobId`, `generation`, `connectionId`,
  `manifestVersion`, `finalPathKey`, `expectedPriorToken` — all from `context` + the `fence` read at
  `finals.ts:180-195`.
- `reconcile-awaiting-raw.ts:85` — `kind:"none"` → `raw_reconciliation` with `claimId:null`,
  `shootDate: project.shootDate`.

## Build sequence Opus recommends

Fix 2 + the compiler first (close the fence) → tail/`workflowTailAgrees` corrections (Fixes 1, 3, 6)
+ the two token regression tests → call-site migration → API-send rewrite → `stage-transition.ts`
deletion.
