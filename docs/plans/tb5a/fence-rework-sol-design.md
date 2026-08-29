# TB5A fence redesign — Sol round 3

## Round-3 changelog

| Finding | Resolution |
|---|---|
| N1 | Terminal assertion now aborts when either document is malformed: `NOT json_valid(...) OR ...`. Full statement is in §3. |
| N2 | Chose option **(b)**. `stage_required` ownership builders emit no ownership assertion. One terminal assertion evaluates the post-tail coupling state. Destination-only and collision bundles retain their own terminal assertion. Repeat-send always binds `expectedFinalHandoffState:"started"`. |
| N3 | A `raw_reconciliation` tail with `claimId:null` emits zero statements. `workflowTailAgrees` accepts an empty index set. Non-null Dropbox claims retain one marker statement. |
| N4 | Reactivation postconditions compare `pc.path_key`, not `pc.path` or `pc.candidate`. Insert paths still write all three columns. |
| N5 | `workflowTailAgrees` receives `oldBoardRevision`; completion tokens compare with `OLD`, entry tokens with `OLD + 1`. |
| N6 / item 1 | All requested load-bearing types and the final `commitAutomaticStage` signature are defined in §4, including the post-marker handoff-start slot. |
| N7 | `sourceJobKind` becomes `sourceJobKinds`, a compiler-validated non-empty set containing `"autohdr"` and/or `"autohdr_api_send"`. API send remains send-only today, but the fence no longer prevents a future legitimate completion path. |
| Item 2 | Ownership assertions are absent in `stage_required`; exact bound documents appear in the statement lists in §4. |
| Item 3 | The seventh `implicit_claim_collision` postcondition is given in §3. |
| Item 4 | All five workflow durable postconditions, using the renamed plural lifecycle keys, are given in §3. |
| Item 5 | API finalization is split into provider finalization → independent truth batch → Stage attempt → `done`. The catch is provider-aware, and the truth batch accepts both `running` and `done` replays. |
| Item 6 | `finals.ts` admits both `editing_autohdr` and `edited_review`; the latter reaches `already_at_destination` and returns `stageAdvanced:false`. |
| Item 7 | Every call-site return contract appears in §2 and §4. |
| Item 8 | Folded into N5. |
| Item 9 | Normative block order and collision-free selectors are specified in §4. |
| Item 10 | `pathClaims.length === 2` is enforced. The no-op JSON round-trip assertion is replaced with an exhaustive key-set comparison. |
| Item 11 | Destination-created rounds retain a NULL entry token and require named operator remediation. Diagnostic revision re-reads compare with the pre-batch `oldBoardRevision`. |
| Round-1 S1 | Delete `stage-transition.ts`, its tests, the `guardedStageTransition` barrel export, and all compatibility-only tests after the remaining production callers are migrated. |
| Confirm regression | `confirmAutoHdrHandoff` binds `expectedStates:["starting","started"]`; the tail accepts any non-empty subset of those states. |

---

## 1. Design summary

The settled Stage mechanism remains:

```text
workflow_premise AS MATERIALIZED
→ fence requires EXISTS(workflow_premise)
→ UPDATE projects ... FROM fence
→ stage.auto_advance audit marker
→ marker-gated state tail
→ marker-gated workflow tail
→ marker-gated token tail
→ terminal assertion
```

Each automatic attempt begins with:

```sql
SELECT
  stage_key AS stageKey,
  board_revision AS boardRevision,
  archived_at AS archivedAt
FROM projects
WHERE id = ?1;
```

Resolution is:

```ts
type ResolvedAutomaticStageDisposition =
  | {
      kind: "stage_required";
      oldBoardRevision: number;
      winnerRequired: boolean;
    }
  | {
      kind: "already_at_destination";
      boardRevision: number;
    }
  | {
      kind: "conflict";
      observedStage: StageKey | null;
    };

function resolveAutomaticStage(
  row: {
    stageKey: StageKey;
    boardRevision: number;
    archivedAt: number | null;
  } | null,
  input: {
    from: StageKey;
    to: StageKey;
    allowAlreadyAtDestination: boolean;
    couplingRequiresWinner: boolean;
  },
): ResolvedAutomaticStageDisposition {
  if (!row || row.archivedAt !== null) {
    return { kind: "conflict", observedStage: null };
  }
  if (row.stageKey === input.from) {
    return {
      kind: "stage_required",
      oldBoardRevision: row.boardRevision,
      winnerRequired: input.couplingRequiresWinner,
    };
  }
  if (
    input.allowAlreadyAtDestination &&
    row.stageKey === input.to
  ) {
    return {
      kind: "already_at_destination",
      boardRevision: row.boardRevision,
    };
  }
  return { kind: "conflict", observedStage: row.stageKey };
}
```

`winnerRequired=true` applies only to repeat ownership, implicit ownership, backfill ownership, and legacy job-entry provenance. Their pre-winner mutations must roll back when Stage does not win.

`already_at_destination` never fabricates a Stage winner and produces no Stage-derived effect:

```text
project Stage UPDATE             0
board_revision change           0
stage.auto_advance audit         0
Stage-derived token write        0
project.stage.changed activity   0
outbox / delivery-ledger write   0
legacy notification              0
```

Destination-only ownership/state/provenance bundles end in their own assertion. Pure completion and reconciliation destination paths perform only their specified read-only idempotency check, if any.

---

## 2. Outcomes and call-site contracts

```ts
type AutomaticStageOutcome =
  | { kind: "winner"; finalizer: CommittedStageFinalizerIntent }
  | { kind: "already_at_destination" }
  | { kind: "loser" }
  | { kind: "deferred" }
  | { kind: "conflict" }
  | { kind: "invariant_failure" };
```

- `winner`: Stage winner, marker, tails, terminal assertion, and postconditions committed.
- `already_at_destination`: exact destination existed and the call-site idempotency/effect contract passed.
- `loser`: uncoupled Stage winner lost without an assertion failure.
- `deferred`: Board feature flag was disabled before mutation.
- `conflict`: a required Stage or ownership prerequisite changed; the batch rolled back.
- `invariant_failure`: the assertion fired, but the post-rollback diagnostic still found the exact pre-batch Stage revision and all ownership prerequisites.
- Other SQL errors are rethrown.

| Call site | Stage-required result | Destination result |
|---|---|---|
| Repeat send | Return the new owner only on `winner`; conflict/invariant becomes `ERR_HANDOFF_BLOCKED` and no owner exists. | Destination ownership assertion commits; return new owner with no token or notification. |
| Implicit claim | Return owner on `winner`; conflict returns `null`; invariant throws. | Return owner after destination ownership assertion; no notification. |
| Backfill | Return `{ok:true,handoff}` on `winner`. Conflict becomes `{ok:false,reason}`; invariant throws. | Return `{ok:true,handoff}` after destination assertion. |
| API send | Provider truth remains durable. Stage `winner` may notify. | Job becomes `done`; return `{stageAdvanced:false}`. |
| Confirm handoff | Return `true` on winner. | Destination start bundle succeeds and returns `true`; no notification. |
| Legacy job entry | Transfer proceeds on winner. | Provenance commits and transfer proceeds; no token or notification. |
| Fetch-job completion | `stageAdvanced:true` only on winner. | `stageAdvanced:false`; no notification. |
| Final completion | `stageAdvanced:true` only on winner. | `stageAdvanced:false`; no notification. |
| Hourly reconciliation | Return `true` only on winner. | Return `false`; this is an idempotent skip. |
| Dropbox reconciliation | Notify only on winner; claim completion continues. | No notification; claim completion continues. |
| Mapping entry | Winner after exact mapping/handoff checks. | Return destination only if its read-only durable postcondition passes. |

`finals.ts` changes its early condition to:

```ts
if (
  !coverage ||
  !["editing_autohdr", "edited_review"].includes(fence.stageKey)
) {
  return false;
}
```

A NULL `editingEntryBoardRevision` still returns `false` before a `stage_required` completion attempt. At `edited_review`, an available token may be supplied for the read-only completion check, but the returned `stageAdvanced` remains `false`.

### Lifecycle bindings

```text
confirm handoff:
  expectedStates = ["starting","started"]

repeat Stage premise:
  expectedStates = ["starting"]
  terminal repeat coupling expectedFinalHandoffState = "started"

repeat destination:
  inserted handoff state = "started"
  terminal repeat coupling expectedFinalHandoffState = "started"

implicit/backfill:
  expectedStates = ["started"]

API/legacy job entry:
  jobStates = ["running","done"]
  ("done" admits workflow replay; first execution is normally running)

job completion:
  jobStates = ["queued","running","done"]
  sourceJobStates = ["queued","running","done"]
  sourceJobKinds = ["autohdr","autohdr_api_send"]

final completion:
  handoffStates = ["started"]
  mappingStates = ["active"]
  fetchStates = ["starting","running"]

hourly reconciliation:
  claimId = null
  claimStates = ["running"]

Dropbox reconciliation:
  claimId = exact non-null claim
  claimStates = ["running"]

mapping entry:
  mappingStates = ["active"]
  handoffStates = ["starting","started"]
```

---

## 3. Complete normative SQL

### Corrected terminal assertion

The builder substitutes one of the complete workflow predicates and one of the complete coupling predicates below. For `"none"`, the predicate is literal `1`.

```ts
const TERMINAL_ASSERTION_SQL = String.raw`
WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS destination_stage,
    ?3 AS old_board_revision,
    ?4 AS premise_doc,
    ?5 AS stage_audit_id,
    ?6 AS winner_required,
    ?7 AS asserted_at,
    ?8 AS coupling_doc
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'stage.auto_advance.bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT json_valid(i.premise_doc)
  OR NOT json_valid(i.coupling_doc)
  OR (
    (
      i.winner_required = 1
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
    )
    OR (
      EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = i.stage_audit_id
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = i.project_id
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM projects p
          WHERE p.id = i.project_id
            AND p.stage_key = i.destination_stage
            AND p.board_revision = i.old_board_revision + 1
            AND p.archived_at IS NULL
        )
        OR NOT (
          ${workflowDurablePostconditionSql}
        )
        OR NOT (
          ${couplingDurablePostconditionSql}
        )
      )
    )
  );
`;
```

Bindings are always:

```text
?1 projectId
?2 destinationStage
?3 pre-batch oldBoardRevision
?4 canonical workflow premise document
?5 stage audit ID
?6 winnerRequired: 0 | 1
?7 assertedAt
?8 canonical coupling document
```

Malformed `?4` or `?8` now selects the NULL row unconditionally. `audit_log.id` rejects it, and D1 rolls back the complete batch, including pre-winner ownership.

A test-only scan of all automatic builder bindings must assert that no statement other than the ownership/provider/Stage terminal assertion binds JavaScript `null` to the first `audit_log.id` value.

### Ownership-only assertion

Destination-only ownership, destination handoff-start, destination provenance, collision, and provider truth use:

```ts
const OWNERSHIP_ASSERTION_SQL = String.raw`
WITH assertion_input AS MATERIALIZED (
  SELECT
    ?1 AS project_id,
    ?2 AS asserted_at,
    ?3 AS coupling_doc
)
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  NULL,
  NULL,
  'automatic.closed_bundle_assertion',
  'project',
  i.project_id,
  '{}',
  i.asserted_at
FROM assertion_input i
WHERE
  NOT json_valid(i.coupling_doc)
  OR NOT (
    ${couplingDurablePostconditionSql}
  );
`;
```

### Five workflow durable postconditions

#### Raw reconciliation

```sql
EXISTS (
  SELECT 1
  FROM projects p
  WHERE p.id = ?1
    AND p.shoot_date IS json_extract(?4, '$.shootDate')
)
AND (
  json_extract(?4, '$.claimId') IS NULL
  OR EXISTS (
    SELECT 1
    FROM raw_reconciliation_claims rc
    WHERE rc.id = json_extract(?4, '$.claimId')
      AND rc.project_id = ?1
      AND rc.state IN (
        SELECT value
        FROM json_each(json_extract(?4, '$.claimStates'))
      )
  )
)
```

#### Handoff entry

```sql
EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?4, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
    AND (
      json_extract(?4, '$.jobId') IS NULL
      OR h.job_id = json_extract(?4, '$.jobId')
    )
)
```

#### Mapping entry

```sql
EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  JOIN autohdr_handoffs h ON h.id = m.handoff_id
  WHERE m.id = json_extract(?4, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?4, '$.handoffId')
    AND m.connection_id = json_extract(?4, '$.connectionId')
    AND m.generation = json_extract(?4, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.mappingStates'))
    )
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state = 'started'
    AND h.editing_entry_board_revision = ?3 + 1
)
```

#### Final completion

```sql
EXISTS (
  SELECT 1
  FROM edited_source_claims esc
  JOIN collections c ON c.id = esc.collection_id
  JOIN autohdr_handoffs h ON h.id = esc.handoff_id
  JOIN autohdr_output_mappings m
    ON m.id = json_extract(?4, '$.mappingId')
   AND m.handoff_id = h.id
  JOIN autohdr_fetch_claims f
    ON f.id = json_extract(?4, '$.fetchClaimId')
   AND f.project_id = ?1
   AND f.handoff_id = h.id
   AND f.mapping_id = m.id
  WHERE esc.collection_id = json_extract(?4, '$.collectionId')
    AND esc.source_path_key = json_extract(?4, '$.sourcePathKey')
    AND esc.current_asset_id = json_extract(?4, '$.currentAssetId')
    AND esc.handoff_id = json_extract(?4, '$.handoffId')
    AND c.project_id = ?1
    AND c.kind = 'edited'
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?4, '$.connectionId')
    AND h.generation = json_extract(?4, '$.generation')
    AND h.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.handoffStates'))
    )
    AND h.manifest_version = json_extract(?4, '$.manifestVersion')
    AND h.editing_entry_board_revision = ?3
    AND m.project_id = ?1
    AND m.connection_id = json_extract(?4, '$.connectionId')
    AND m.generation = json_extract(?4, '$.generation')
    AND m.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.mappingStates'))
    )
    AND m.final_path_key = json_extract(?4, '$.finalPathKey')
    AND f.connection_id = json_extract(?4, '$.connectionId')
    AND f.mapping_generation = json_extract(?4, '$.generation')
    AND f.job_id = json_extract(?4, '$.fetchJobId')
    AND f.state IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.fetchStates'))
    )
)
```

#### Job completion

```sql
EXISTS (
  SELECT 1
  FROM jobs completion
  JOIN jobs source
    ON source.id = json_extract(?4, '$.sourceJobId')
  WHERE completion.id = json_extract(?4, '$.jobId')
    AND completion.kind = json_extract(?4, '$.jobKind')
    AND completion.project_id = ?1
    AND completion.status IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.jobStates'))
    )
    AND json_valid(completion.payload_json)
    AND json_extract(completion.payload_json, '$.projectId') = ?1
    AND json_extract(
          completion.payload_json,
          '$.stageEntrySourceJobId'
        ) = source.id
    AND json_extract(
          completion.payload_json,
          '$.stageEntryGeneration'
        ) = json_extract(?4, '$.generation')
    AND source.kind IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.sourceJobKinds'))
    )
    AND source.project_id = ?1
    AND source.status IN (
      SELECT value
      FROM json_each(json_extract(?4, '$.sourceJobStates'))
    )
    AND json_valid(source.payload_json)
    AND json_extract(source.payload_json, '$.projectId') = ?1
    AND json_extract(
          source.payload_json,
          '$.stageEntrySourceJobId'
        ) = source.id
    AND json_extract(
          source.payload_json,
          '$.stageEntryGeneration'
        ) = json_extract(?4, '$.generation')
    AND source.stage_entry_board_revision = ?3
)
```

The job-entry postcondition is the `job_entry_provenance` coupling predicate below plus:

```sql
AND j.stage_entry_board_revision = ?3 + 1
```

### Seven coupling postconditions

#### `handoff_start`

```sql
EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.state = 'started'
    AND h.started_at IS NOT NULL
)
```

#### `job_entry_provenance`

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = json_extract(?8, '$.jobKind')
    AND j.project_id = ?1
    AND j.status IN (
      SELECT value
      FROM json_each(json_extract(?8, '$.jobStates'))
    )
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') =
        json_extract(?8, '$.generation')
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') =
        json_extract(?8, '$.jobId')
    AND json_extract(j.payload_json, '$.stageEntryGeneration') =
        json_extract(?8, '$.generation')
)
```

For ownership-only assertions, replace `?8` with `?3`.

#### `autohdr_api_finalize`

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?3, '$.jobId')
    AND j.kind = 'autohdr_api_send'
    AND j.project_id = ?1
    AND j.status IN ('running', 'done')
    AND j.error IS NULL
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(j.payload_json, '$.projectId') = ?1
    AND json_extract(j.payload_json, '$.generation') = 1
    AND json_extract(j.payload_json, '$.stageEntrySourceJobId') =
        json_extract(?3, '$.jobId')
    AND json_extract(j.payload_json, '$.stageEntryGeneration') = 1
    AND json_extract(j.payload_json, '$.phase') = 'finalized'
    AND json_extract(j.payload_json, '$.uid') =
        json_extract(?3, '$.uid')
)
AND EXISTS (
  SELECT 1
  FROM audit_log a
  WHERE a.id = json_extract(?3, '$.finalizedAuditId')
    AND a.action = 'project.autohdr_api_send.finalized'
    AND a.target_type = 'project'
    AND a.target_id = ?1
    AND json_valid(a.meta_json)
    AND json_extract(a.meta_json, '$.provider') = 'autohdr_api_v4'
    AND json_extract(a.meta_json, '$.jobId') =
        json_extract(?3, '$.jobId')
    AND json_extract(a.meta_json, '$.uid') =
        json_extract(?3, '$.uid')
    AND json_extract(a.meta_json, '$.assetCount') =
        json_extract(?3, '$.assetCount')
    AND json_extract(a.meta_json, '$.retrievalEnabled') = 0
)
```

#### `repeat_claim`

```sql
EXISTS (
  SELECT 1
  FROM autohdr_output_mappings old_m
  WHERE old_m.id = json_extract(?8, '$.retiredMappingId')
    AND old_m.handoff_id = json_extract(?8, '$.retiredHandoffId')
    AND old_m.project_id = ?1
    AND old_m.state = 'retired'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs old_h
  WHERE old_h.id = json_extract(?8, '$.retiredHandoffId')
    AND old_h.project_id = ?1
    AND old_h.state = 'retired'
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims old_pc
  WHERE old_pc.mapping_id = json_extract(?8, '$.retiredMappingId')
    AND old_pc.state IN ('active', 'pending', 'blocked')
)
AND EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'queued'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.handoffId') =
        json_extract(?8, '$.handoffId')
    AND json_extract(j.payload_json, '$.generation') =
        json_extract(?8, '$.generation')
    AND json_extract(j.payload_json, '$.connectionId') =
        json_extract(?8, '$.connectionId')
    AND json_extract(j.payload_json, '$.retiredHandoffId') =
        json_extract(?8, '$.retiredHandoffId')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.selection_hash = json_extract(?8, '$.selectionHash')
    AND h.state =
        json_extract(?8, '$.expectedFinalHandoffState')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = json_extract(?8, '$.generation')
    AND m.state = 'pending_discovery'
)
AND (
  SELECT COUNT(*)
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.state = 'pending'
) = 2
AND json_array_length(json_extract(?8, '$.pathClaims')) = 2
AND NOT EXISTS (
  SELECT 1
  FROM json_each(json_extract(?8, '$.pathClaims')) expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM autohdr_path_claims pc
    WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
      AND pc.handoff_id = json_extract(?8, '$.handoffId')
      AND pc.project_id = ?1
      AND pc.connection_id = json_extract(?8, '$.connectionId')
      AND pc.path_key = json_extract(expected.value, '$.pathKey')
      AND pc.state = 'pending'
  )
)
```

The Stage terminal binds `?8` to the post-tail document with:

```json
{"kind":"repeat_claim","expectedFinalHandoffState":"started"}
```

plus all identity fields. No pre-tail assertion evaluates it.

#### `implicit_claim`

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?8, '$.targetPath')
    AND json_extract(j.payload_json, '$.isCollision') = 0
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = 1
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = 1
    AND m.state = 'active'
    AND m.final_path_key = json_extract(?8, '$.targetPathKey')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.path_key = json_extract(?8, '$.targetPathKey')
    AND pc.state = 'active'
)
```

No assertion depends on `pc.path` or `pc.candidate`. The mapping still preserves the display path in `final_path`; path ownership is defined by the normalized indexed key.

#### `backfill_claim`

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?8, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.status = 'done'
    AND j.project_id = ?1
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.backfill') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?8, '$.targetPath')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?8, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?8, '$.connectionId')
    AND h.generation = json_extract(?8, '$.generation')
    AND h.job_id = json_extract(?8, '$.jobId')
    AND h.workflow_id = json_extract(?8, '$.workflowId')
    AND h.state = 'started'
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?8, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?8, '$.handoffId')
    AND m.connection_id = json_extract(?8, '$.connectionId')
    AND m.generation = json_extract(?8, '$.generation')
    AND m.state = 'active'
    AND m.final_path_key = json_extract(?8, '$.targetPathKey')
    AND m.folder_id = json_extract(?8, '$.folderId')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?8, '$.mappingId')
    AND pc.handoff_id = json_extract(?8, '$.handoffId')
    AND pc.project_id = ?1
    AND pc.connection_id = json_extract(?8, '$.connectionId')
    AND pc.path_key = json_extract(?8, '$.targetPathKey')
    AND pc.folder_id = json_extract(?8, '$.folderId')
    AND pc.state = 'active'
)
```

#### `implicit_claim_collision`

```sql
EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = json_extract(?3, '$.jobId')
    AND j.kind = 'autohdr'
    AND j.project_id = ?1
    AND j.status = 'failed'
    AND j.error = json_extract(?3, '$.diagnostic')
    AND json_valid(j.payload_json)
    AND json_extract(j.payload_json, '$.implicit') = 1
    AND json_extract(j.payload_json, '$.targetPath') =
        json_extract(?3, '$.targetPath')
    AND json_extract(j.payload_json, '$.isCollision') = 1
)
AND EXISTS (
  SELECT 1
  FROM autohdr_handoffs h
  WHERE h.id = json_extract(?3, '$.handoffId')
    AND h.project_id = ?1
    AND h.connection_id = json_extract(?3, '$.connectionId')
    AND h.generation = 1
    AND h.job_id = json_extract(?3, '$.jobId')
    AND h.workflow_id = json_extract(?3, '$.workflowId')
    AND h.state = 'retired'
    AND h.last_error = json_extract(?3, '$.diagnostic')
)
AND EXISTS (
  SELECT 1
  FROM autohdr_output_mappings m
  WHERE m.id = json_extract(?3, '$.mappingId')
    AND m.project_id = ?1
    AND m.handoff_id = json_extract(?3, '$.handoffId')
    AND m.connection_id = json_extract(?3, '$.connectionId')
    AND m.generation = 1
    AND m.state = 'blocked_collision'
    AND m.final_path_key = json_extract(?3, '$.targetPathKey')
    AND m.diagnostic = json_extract(?3, '$.diagnostic')
)
AND NOT EXISTS (
  SELECT 1
  FROM autohdr_path_claims pc
  WHERE pc.mapping_id = json_extract(?3, '$.mappingId')
     OR (
       pc.connection_id = json_extract(?3, '$.connectionId')
       AND pc.path_key = json_extract(?3, '$.targetPathKey')
       AND pc.project_id = ?1
     )
)
```

The last disjunct ensures the new mapping owns no claim and the foreign claim was not rewritten to the new project.

### Marker-gated state tail

```sql
UPDATE autohdr_handoffs
SET
  state = 'started',
  started_at = COALESCE(started_at, ?2),
  updated_at = ?2
WHERE id = ?3
  AND project_id = ?1
  AND connection_id = ?4
  AND generation = ?5
  AND state IN (
    SELECT value FROM json_each(?6)
  )
  AND EXISTS (
    SELECT 1
    FROM audit_log
    WHERE id = ?7
      AND action = 'stage.auto_advance'
      AND target_type = 'project'
      AND target_id = ?1
  )
RETURNING
  id,
  project_id,
  connection_id,
  generation,
  state,
  started_at,
  editing_entry_board_revision;
```

Destination-only form removes only the audit `EXISTS` and its `?7` binding; it retains every identity and state predicate.

### Corrected raw-reconciliation tail

```ts
if (kind === "raw_reconciliation") {
  if (prerequisite.kind !== "raw_reconciliation") {
    throw new Error(
      "raw_reconciliation tail requires its matching prerequisite",
    );
  }

  if (prerequisite.claimId === null) {
    return {
      statements: [],
      indexes: { kind: "raw_reconciliation" },
    };
  }

  const marker = prerequisite.db.prepare(`
    SELECT
      rc.id,
      rc.project_id,
      rc.state
    FROM raw_reconciliation_claims rc
    WHERE rc.id = ?1
      AND rc.project_id = ?2
      AND rc.state IN (
        SELECT value FROM json_each(?3)
      )
      AND EXISTS (
        SELECT 1
        FROM projects p
        WHERE p.id = rc.project_id
          AND p.shoot_date IS ?4
      )
      AND EXISTS (
        SELECT 1
        FROM audit_log a
        WHERE a.id = ?5
          AND a.action = 'stage.auto_advance'
          AND a.target_type = 'project'
          AND a.target_id = rc.project_id
      );
  `).bind(
    prerequisite.claimId,
    prerequisite.projectId,
    JSON.stringify(prerequisite.claimStates),
    prerequisite.shootDate,
    prerequisite.auditId,
  );

  return {
    statements: [marker],
    indexes: {
      kind: "raw_reconciliation",
      prerequisiteMarker: 0,
    },
  };
}
```

Hourly reconciliation therefore has no tail result to require. Dropbox retains its exact one-row marker.

---

## 4. Type, compiler, builder, and statement contracts

### Complete types

```ts
type LifecycleSet<T extends string> = readonly [T, ...T[]];
type ClosedSet<T extends string> = readonly [T, ...T[]];

type ClosedPathClaimPlan =
  | {
      kind: "reactivate";
      claimId: string;
      candidate: "final" | "finals";
      path: string;
      pathKey: string;
    }
  | {
      kind: "insert";
      claimId: string;
      candidate: "final" | "finals";
      path: string;
      pathKey: string;
    };

type ClosedAutomaticCoupling =
  | {
      kind: "handoff_start";
      handoffId: string;
      connectionId: string;
      generation: number;
    }
  | {
      kind: "job_entry_provenance";
      jobId: string;
      jobKind: "autohdr" | "autohdr_api_send";
      generation: number;
      jobStates: LifecycleSet<"running" | "done">;
    }
  | {
      kind: "autohdr_api_finalize";
      jobId: string;
      uid: string;
      assetCount: number;
      finalizedAuditId: string;
    }
  | {
      kind: "repeat_claim";
      retiredHandoffId: string;
      retiredMappingId: string;
      handoffId: string;
      mappingId: string;
      jobId: string;
      workflowId: string;
      generation: number;
      connectionId: string;
      selectionHash: string;
      expectedFinalHandoffState: "started";
      pathClaims: readonly [ClosedPathClaimPlan, ClosedPathClaimPlan];
    }
  | {
      kind: "implicit_claim";
      handoffId: string;
      mappingId: string;
      jobId: string;
      workflowId: string;
      connectionId: string;
      targetPath: string;
      targetPathKey: string;
    }
  | {
      kind: "backfill_claim";
      handoffId: string;
      mappingId: string;
      jobId: string;
      workflowId: string;
      connectionId: string;
      generation: number;
      targetPath: string;
      targetPathKey: string;
      folderId: string;
    }
  | {
      kind: "implicit_claim_collision";
      handoffId: string;
      mappingId: string;
      jobId: string;
      workflowId: string;
      connectionId: string;
      targetPath: string;
      targetPathKey: string;
      diagnostic: string;
      collisionOwnerProjectId: string;
    };

type HandoffStartBundle = PreparedStatementBundle<{
  handoffStart: number;
}> & {
  kind: "handoff_start";
  coupling: Extract<
    ClosedAutomaticCoupling,
    { kind: "handoff_start" }
  >;
};

type JobEntryProvenanceBundle = PreparedStatementBundle<{
  payloadUpdate: number;
  ownershipAssertion?: number;
}> & {
  kind: "job_entry_provenance";
  coupling: Extract<
    ClosedAutomaticCoupling,
    { kind: "job_entry_provenance" }
  >;
};

type ClosedOwnershipBundle =
  | (
      PreparedStatementBundle<{
        retireMapping: number;
        retireHandoff: number;
        tombstonePaths: number;
        insertJob: number;
        insertHandoff: number;
        insertMapping: number;
        pathClaims: readonly [number, number];
        ownershipAssertion?: number;
      }> & {
        kind: "repeat_claim";
        coupling: Extract<
          ClosedAutomaticCoupling,
          { kind: "repeat_claim" }
        >;
      }
    )
  | (
      PreparedStatementBundle<{
        job: number;
        handoff: number;
        mapping: number;
        pathClaim: number;
        ownershipAssertion?: number;
      }> & {
        kind: "implicit_claim";
        coupling: Extract<
          ClosedAutomaticCoupling,
          { kind: "implicit_claim" }
        >;
      }
    )
  | (
      PreparedStatementBundle<{
        job: number;
        handoff: number;
        mapping: number;
        pathClaim: number;
        ownershipAssertion?: number;
      }> & {
        kind: "backfill_claim";
        coupling: Extract<
          ClosedAutomaticCoupling,
          { kind: "backfill_claim" }
        >;
      }
    )
  | (
      PreparedStatementBundle<{
        job: number;
        handoff: number;
        mapping: number;
        ownershipAssertion: number;
      }> & {
        kind: "implicit_claim_collision";
        coupling: Extract<
          ClosedAutomaticCoupling,
          { kind: "implicit_claim_collision" }
        >;
      }
    );
```

`ownershipAssertion` is absent for `stage_required` repeat/implicit/backfill/provenance. It is present for their destination-only forms and mandatory for collision.

The prerequisite union is:

```ts
type GuardedTransitionPrerequisite =
  | { kind: "none" }
  | {
      kind: "raw_reconciliation";
      projectId: string;
      claimId: string | null;
      claimStates: LifecycleSet<"running">;
      shootDate: string | null;
    }
  | {
      kind: "autohdr_handoff";
      projectId: string;
      handoffId: string;
      jobId: string | null;
      generation: number;
      connectionId: string;
      expectedStates: LifecycleSet<"starting" | "started">;
      expectedPriorToken: number | null;
    }
  | {
      kind: "autohdr_mapping";
      projectId: string;
      mappingId: string;
      handoffId: string;
      generation: number;
      connectionId: string;
      mappingStates: LifecycleSet<"active">;
      handoffStates: LifecycleSet<"starting" | "started">;
      expectedPriorToken: number | null;
    }
  | {
      kind: "autohdr_final_claim";
      projectId: string;
      collectionId: string;
      sourcePathKey: string;
      currentAssetId: string;
      handoffId: string;
      mappingId: string;
      fetchClaimId: string;
      fetchJobId: string;
      generation: number;
      connectionId: string;
      mappingStates: LifecycleSet<"active">;
      handoffStates: LifecycleSet<"started">;
      fetchStates: LifecycleSet<"starting" | "running">;
      manifestVersion: number;
      finalPathKey: string;
      expectedPriorToken: number;
    }
  | {
      kind: "autohdr_job";
      mode: "entry";
      projectId: string;
      jobId: string;
      jobKind: "autohdr" | "autohdr_api_send";
      generation: number;
      jobStates: LifecycleSet<"running" | "done">;
      expectedPriorToken: number | null;
    }
  | {
      kind: "autohdr_job";
      mode: "completion";
      projectId: string;
      jobId: string;
      jobKind: "fetch_edited";
      jobStates: LifecycleSet<"queued" | "running" | "done">;
      sourceJobId: string;
      sourceJobKinds: ClosedSet<"autohdr" | "autohdr_api_send">;
      sourceJobStates:
        LifecycleSet<"queued" | "running" | "done">;
      generation: number;
      expectedPriorToken: number;
    };
```

### Compiler completeness

```ts
const EXPECTED_KEYS = {
  none: ["kind"],
  raw_reconciliation: [
    "kind",
    "projectId",
    "claimId",
    "claimStates",
    "shootDate",
  ],
  autohdr_handoff: [
    "kind",
    "projectId",
    "handoffId",
    "jobId",
    "generation",
    "connectionId",
    "expectedStates",
    "expectedPriorToken",
  ],
  autohdr_mapping: [
    "kind",
    "projectId",
    "mappingId",
    "handoffId",
    "generation",
    "connectionId",
    "mappingStates",
    "handoffStates",
    "expectedPriorToken",
  ],
  autohdr_final_claim: [
    "kind",
    "projectId",
    "collectionId",
    "sourcePathKey",
    "currentAssetId",
    "handoffId",
    "mappingId",
    "fetchClaimId",
    "fetchJobId",
    "generation",
    "connectionId",
    "mappingStates",
    "handoffStates",
    "fetchStates",
    "manifestVersion",
    "finalPathKey",
    "expectedPriorToken",
  ],
  autohdr_job_entry: [
    "kind",
    "mode",
    "projectId",
    "jobId",
    "jobKind",
    "generation",
    "jobStates",
    "expectedPriorToken",
  ],
  autohdr_job_completion: [
    "kind",
    "mode",
    "projectId",
    "jobId",
    "jobKind",
    "jobStates",
    "sourceJobId",
    "sourceJobKinds",
    "sourceJobStates",
    "generation",
    "expectedPriorToken",
  ],
} as const;
```

After constructing the canonical object:

```ts
function assertExactKeys(
  discriminator: keyof typeof EXPECTED_KEYS,
  object: Record<string, unknown>,
): void {
  const expected = EXPECTED_KEYS[discriminator];
  const actual = Object.keys(object);

  if (
    actual.length !== expected.length ||
    expected.some((key, index) => actual[index] !== key)
  ) {
    throw new Error(
      `Guarded premise key mismatch for ${discriminator}: ` +
      `expected ${expected.join(",")}; got ${actual.join(",")}`,
    );
  }

  for (const key of expected) {
    if (object[key] === undefined) {
      throw new Error(
        `Guarded premise ${discriminator}.${key} is undefined`,
      );
    }
  }
}
```

The compiler also rejects:

- unknown input keys;
- empty strings;
- duplicate or empty lifecycle sets;
- non-safe integers;
- `null` for final `currentAssetId`, `handoffId`, or `finalPathKey`;
- any repeat coupling where `pathClaims.length !== 2`;
- duplicate repeat `pathKey` values;
- any coupling/prerequisite key not exhaustive against its own `EXPECTED_KEYS` table.

It explicitly emits nullable `claimId`, `jobId`, and prior-token fields as `null`. The previous stringify/parse identity assertion is removed.

### Final `commitAutomaticStage` signature

```ts
export async function commitAutomaticStage(input: {
  env: AutomaticStageBindings;
  projectId: string;
  from: StageKey;
  to: StageKey;
  auditId: string;
  auditActorId?: string | null;
  auditMetaJson: string;
  now?: number;
  oldBoardRevision?: number;

  workflow: GuardedTransitionPrerequisite;

  coupling?: ClosedAutomaticCoupling;

  preWinnerOwnership?: ClosedOwnershipBundle;
  preWinnerProvenance?: JobEntryProvenanceBundle;

  postMarkerHandoffStart?: HandoffStartBundle;

  alreadyAtDestination:
    | { allowed: false }
    | {
        allowed: true;
        effect:
          | { kind: "none" }
          | {
              kind: "handoff_start";
              bundle: HandoffStartBundle;
            }
          | {
              kind: "ownership";
              bundle: ClosedOwnershipBundle;
            }
          | {
              kind: "job_provenance";
              bundle: JobEntryProvenanceBundle;
            }
          | {
              kind: "workflow_check";
              workflow: GuardedTransitionPrerequisite;
            };
      };

  legacyWorkflowNotification?:
    CommittedStageFinalizerIntent["legacyWorkflowNotification"];
}): Promise<AutomaticStageOutcome>;
```

Invalid combinations are rejected before preparing SQL:

```text
preWinnerOwnership/provenance present
  → coupling required
  → winnerRequired derived true
  → matching alreadyAtDestination effect required when allowed

postMarkerHandoffStart present
  → workflow kind must be autohdr_handoff or autohdr_mapping
  → its IDs/generation/connection must equal workflow and coupling

no pre-winner mutation
  → winnerRequired false

already_at_destination
  → never composes Stage/audit/token/activity/notification statements
```

`composeStageBundle` order is exactly:

```text
1. pre-winner ownership or provenance
2. Stage winner
3. stage.auto_advance audit marker
4. marker-gated handoff state tail
5. marker-gated workflow tail
6. marker-gated Stage-entry token tail
7. terminal assertion
```

### Statement lists and bound documents

`W` means the append winner with the settled premise CTE; `A` is its audit marker; `S` the start tail; `WF` the named workflow marker; `T` the token tail; `X` the corrected terminal assertion; `OX` the ownership-only assertion.

#### Repeat send

`stage_required`:

1. Retire old mapping — existing optimistic IDs/counts/leases bound from the pre-read.
2. Retire old handoff.
3. Tombstone its two claims.
4. Insert queued job.
5. Insert `starting` handoff.
6. Insert `pending_discovery` mapping.
7. Reactivate/insert first path claim.
8. Reactivate/insert second path claim.
9. `W`, bound to `autohdr_handoff` with `expectedStates:["starting"]`.
10. `A`.
11. `S`, bound to `expectedStates:["starting"]`.
12. `WF`, handoff post-state `started`.
13. `T`, expected prior token `null`, resulting token `OLD+1`.
14. `X`, `winnerRequired=1`, coupling `repeat_claim` with `expectedFinalHandoffState:"started"`.

There is no ownership assertion between statements 8 and 9.

`already_at_destination`:

1–8. Same ownership statements, except the handoff is inserted directly as `started` with `started_at=now`.
9. `OX`, bound to the same post-state `repeat_claim` document.

#### Implicit claim

`stage_required`:

1. Insert `done` implicit job.
2. Insert `started` handoff.
3. Insert active mapping.
4. Reactivate or insert the active claim.
5. `W`, `autohdr_handoff`, `expectedStates:["started"]`.
6. `A`.
7. `S`, `expectedStates:["started"]`.
8. `WF`.
9. `T`, prior token `null`.
10. `X`, `winnerRequired=1`, coupling `implicit_claim`.

`already_at_destination`: statements 1–4 followed by `OX(implicit_claim)`.

`collision`: failed job → retired handoff → blocked-collision mapping → `OX(implicit_claim_collision)`. No path-claim mutation and no `commitAutomaticStage`.

#### Backfill claim

`stage_required`: job → handoff → mapping → path claim → `W` → `A` → `S` → `WF` → `T` → `X(backfill_claim,winnerRequired=1)`.

`already_at_destination`: the four ownership statements followed by `OX(backfill_claim)`.

#### API send

Independent finalization batch:

1. Replay-safe finalized payload update.
2. Replay-safe finalized audit.
3. `OX(autohdr_api_finalize)`.

Then `stage_required`:

1. `W`, `autohdr_job/entry`, `jobStates:["running","done"]`.
2. `A`.
3. `WF` job provenance marker.
4. `T` job entry token.
5. `X`, `winnerRequired=0`, coupling `none`.

`already_at_destination`: no Stage batch; proceed to `done`.

#### Confirm

`stage_required`: `W → A → S(["starting","started"]) → WF → T → X(handoff_start, winnerRequired=0)`.

`already_at_destination`: destination-only `S(["starting","started"]) → OX(handoff_start)`.

#### Legacy job entry

`stage_required`: provenance update → `W → A → WF → T → X(job_entry_provenance,winnerRequired=1)`.

`already_at_destination`: provenance update → `OX(job_entry_provenance)`.

#### Job completion

`stage_required`: `W → A → completion WF statements → X(none,winnerRequired=0)`.

`already_at_destination`: read-only job-completion durable predicate; return destination if true, otherwise conflict.

#### Final completion

`stage_required`: `W → A → final-completion WF statements → X(none,winnerRequired=0)`.

`already_at_destination`: read-only final-completion durable predicate; return `stageAdvanced:false`.

#### Hourly reconciliation

`stage_required`: `W → A → X(none,winnerRequired=0)`. The workflow tail has zero statements because `claimId:null`.

`already_at_destination`: no batch; return `false`.

#### Dropbox reconciliation

`stage_required`: `W → A → one exact reconciliation-claim marker → X(none,winnerRequired=0)`.

`already_at_destination`: no Stage batch; claim completion continues without `raw_ready`.

#### Mapping entry

`stage_required`: `W → A → S(["starting","started"]) → mapping WF → T → X(none,winnerRequired=0)`.

`already_at_destination`: read-only mapping-entry durable predicate; return destination only if it passes.

### `workflowTailAgrees` correction

```ts
function workflowTailAgrees(
  results: D1Result<unknown>[],
  kind: WorkflowTailKind,
  indexes: WorkflowTailIndexes,
  oldBoardRevision: number,
): boolean {
  const resultIndexes = workflowResultIndexes(kind, indexes);

  // This is the intended hourly-reconciliation case:
  // raw_reconciliation + claimId:null has no indexes.
  for (const index of resultIndexes) {
    if (!exactOne(results[index])) return false;
  }

  if (
    kind === "autohdr_handoff_entry" ||
    kind === "autohdr_mapping_entry" ||
    kind === "autohdr_job_entry"
  ) {
    const tokenIndex = indexes.editingEntryToken;
    const token = exactOne(results[tokenIndex]);
    const revision =
      token?.editing_entry_board_revision ??
      token?.stage_entry_board_revision;

    return (
      typeof revision === "number" &&
      revision === oldBoardRevision + 1
    );
  }

  if (kind === "autohdr_job_completion") {
    const source = exactOne(results[indexes.sourceEntryJob]);
    return (
      typeof source?.stage_entry_board_revision === "number" &&
      source.stage_entry_board_revision === oldBoardRevision
    );
  }

  if (kind === "autohdr_final_completion") {
    const handoff = exactOne(results[indexes.handoffState]);
    return (
      typeof handoff?.editing_entry_board_revision === "number" &&
      handoff.editing_entry_board_revision === oldBoardRevision
    );
  }

  return true;
}
```

Call site:

```ts
workflowTailAgrees(
  results,
  input.workflow.kind,
  offsetWorkflowIndexes(bundle.indexes.workflow, offset),
  oldBoardRevision,
)
```

It no longer receives `winner.row.boardRevision`.

### Plan block ordering and selectors

The plan’s normative SQL blocks appear in this order:

1. standalone `APPEND_STAGE_BOTTOM_SQL`;
2. exact non-compacting winner;
3. append non-compacting winner;
4. compacting winner;
5. audit and tail literals.

Selectors become:

```ts
const appendBottomBlock = blocks.find((block) =>
  block.trimStart().startsWith(
    "SELECT COALESCE(MAX(board_position) + 1024, 0)",
  ),
);

const exactBlock = blocks.find((block) =>
  block.includes("board_position = ?8") &&
  block.includes("workflow_premise AS MATERIALIZED") &&
  !block.includes("changed_plan AS"),
);

const appendWinnerBlock = blocks.find((block) =>
  block.includes("workflow_premise AS MATERIALIZED") &&
  block.includes("MAX(board_position) + 1024") &&
  block.includes("UPDATE projects AS p"),
);

const compactingBlock = blocks.find((block) =>
  block.includes("changed_plan AS") &&
  block.includes("workflow_premise AS MATERIALIZED"),
);
```

`NORMATIVE_NON_COMPACTING_APPEND_SQL` is exported as its own literal; `.replace(...)` is removed.

### API workflow ordering and catch

Finalization statements are replay-safe:

```sql
UPDATE jobs
SET
  error = NULL,
  payload_json = ?1,
  updated_at = ?2
WHERE id = ?3
  AND kind = 'autohdr_api_send'
  AND project_id = ?4
  AND status IN ('running', 'done')
RETURNING id, project_id, status, payload_json;
```

```sql
INSERT INTO audit_log (
  id,
  actor_id,
  action,
  target_type,
  target_id,
  meta_json,
  created_at
)
SELECT
  ?1,
  ?2,
  'project.autohdr_api_send.finalized',
  'project',
  ?3,
  ?4,
  ?5
WHERE EXISTS (
  SELECT 1
  FROM jobs j
  WHERE j.id = ?6
    AND j.kind = 'autohdr_api_send'
    AND j.project_id = ?3
    AND j.status IN ('running', 'done')
    AND j.payload_json = ?7
)
ON CONFLICT(id) DO NOTHING
RETURNING id;
```

`finalizedAuditId` is deterministic for the job, for example:

```ts
const finalizedAuditId =
  `autohdr-api-finalized:${input.jobId}`;
```

Workflow ordering:

```ts
let providerFinalized = false;

try {
  // setup/load/create/upload/verify steps

  await step.do("finalize-autohdr-photoshoot", async () => {
    await finalizeAutoHdrPhotoshoot(apiKey, photoshoot.uid);
    return { uid: photoshoot.uid, finalized: true };
  });

  // Runs on both first execution and replay after the cached step.
  providerFinalized = true;

  await step.do("record-autohdr-finalization-truth", async () => {
    const bundle = buildAutoHdrApiFinalizeBundle(/* deterministic IDs */);
    await this.env.DB.batch(bundle.statements);
    return { recorded: true };
  });

  const stageResult = await step.do(
    "attempt-autohdr-api-stage-entry",
    async () => {
      const outcome = await commitAutomaticStage(/* no provider prefix */);
      if (outcome.kind === "invariant_failure") {
        console.error("AutoHDR API Stage entry invariant failed", {
          projectId: input.projectId,
          jobId: input.jobId,
          providerFinalized: true,
        });
      }
      return {
        stageAdvanced: outcome.kind === "winner",
        outcome: outcome.kind,
      };
    },
  );

  await step.do("mark-autohdr-api-send-done", async () => {
    await setJobStatus(dbFor(this.env), input.jobId, "done");
    return { status: "done" };
  });

  if (stageResult.stageAdvanced) {
    // notify; notification failure is logged only
  }
} catch (error) {
  if (providerFinalized) {
    console.error("AutoHDR API post-finalization failure", {
      projectId: input.projectId,
      jobId: input.jobId,
      error: errorMessage(error),
    });
    throw error;
  }

  try {
    await setJobStatus(
      dbFor(this.env),
      input.jobId,
      "failed",
      errorMessage(error),
    );
  } catch (statusError) {
    console.error("Unable to mark pre-finalization API send failed", {
      projectId: input.projectId,
      jobId: input.jobId,
      error: errorMessage(statusError),
    });
  }
  throw error;
}
```

No error after provider finalization—truth persistence, Stage read/composition, assertion classification, `done`, or notification—runs the `failed` transition.

### Compatibility cleanup

After all writers use the new contract:

- delete `packages/db/src/stage-transition.ts`;
- delete `packages/db/src/stage-transition.test.ts`;
- remove `guardedStageTransition` and `GuardedStageTransitionInput` from `packages/db/src/index.ts`;
- remove stale raw-stage/compat tests that exercise only the wrapper;
- retain behavior tests through the actual automatic writer bundles.

---

## 5. Test matrix

### Assertions and compiler

- Invalid premise document with successful pre-winner ownership aborts and rolls ownership back.
- Invalid coupling document does the same.
- Every canonical document contains its exact expected key set in declared order.
- Unknown, absent, and `undefined` fields are rejected.
- Nullable fields serialize explicitly as `null`.
- Repeat `pathClaims` accepts exactly two distinct normalized keys.
- Empty lifecycle arrays are rejected.
- Only assertion builders can bind NULL to `audit_log.id`.
- Duplicate non-null Stage audit ID raises `UNIQUE constraint failed` and is rethrown.

### N2 regression

- Repeat `stage_required` has no ownership assertion before the winner.
- Inserted `starting` handoff becomes `started`.
- The single terminal coupling document requires `started`.
- Repeat destination inserts `started` and passes its destination assertion.

### Reconciliation

- Hourly `claimId:null` emits zero tail statements and can win.
- Dropbox non-null claim emits exactly one marker and requires exactly one row.
- Shoot-date changes fence both paths.
- Destination paths do not notify.

### Tokens and notification regression

- Entry token equals `oldBoardRevision + 1`.
- Job completion source token equals `oldBoardRevision`.
- Final completion handoff token equals `oldBoardRevision`.
- Preserve explicit `5 → 6 → 7` ABA tests.
- Add an end-to-end fetch-job completion test asserting:
  - Stage becomes `edited_review`;
  - outcome is `winner`;
  - `edited_landed` notification fires exactly once.
- Do not rely only on `advanceFinalStage`, whose existing final-completion agreement branch was previously unconditional.

### Reactivation and collision

- Mixed-case stored `path` with the same lowercase `path_key` succeeds.
- Reactivation does not require candidate/path rewrites.
- Foreign collision produces exactly failed job, retired handoff, blocked mapping, diagnostic, and no new path ownership.
- Breaking any collision postcondition rolls all three writes back.

### API finalization

- First finalization from `running` succeeds.
- Replay while `running` succeeds.
- Replay after job is `done` succeeds.
- Existing deterministic finalized audit is accepted.
- Stage winner notifies.
- Stage conflict/already-destination/invariant leaves provider truth durable and job `done`.
- Every post-finalization failure leaves the job non-failed and is retryable.
- Pre-finalization failure marks it failed.

### Destination outcomes

For every admitted destination path, assert zero:

```text
Stage UPDATE
board_revision change
stage.auto_advance audit
Stage-derived token
project activity
outbox
ledger
legacy notification
```

Then assert only the named destination effect or read-only check occurs.

### Diagnostics

The post-rollback diagnostic query must include:

```sql
SELECT
  stage_key AS stageKey,
  board_revision AS boardRevision,
  archived_at AS archivedAt
FROM projects
WHERE id = ?1;
```

Classification compares:

```ts
row.stageKey === from &&
row.boardRevision === oldBoardRevision &&
row.archivedAt === null
```

It must not compare against a freshly read or winner-derived revision.

If state changes between rollback and diagnostic, return `conflict` but log:

```text
classification: "conflict"
diagnosticRacePossible: true
preBatchOldBoardRevision: OLD
diagnosticBoardRevision: observed
```

This acknowledges that a post-rollback race can mask an invariant defect without weakening safety.

---

## 6. Migration and rollout impact

Migration `0037` remains byte-for-byte unchanged. There is no `0038` and no persistent schema object.

Rollout consequences:

- A round created through `already_at_destination` has `editing_entry_board_revision = NULL`.
- `autohdr_final_claim.expectedPriorToken` remains a required number.
- Therefore that round cannot later auto-advance `editing_autohdr → edited_review`.
- This is especially relevant to repeat-send initiated while the project is already in `editing_autohdr`.

Named remediation: **Repair Editing Entry Token**.

An operator may use either:

1. an explicit controlled re-entry command that performs a real semantic Stage re-entry and writes the handoff/job entry token under the normal winner contract; or
2. the existing authorized `moveProjectStage` command to move the project manually to `edited_review` after confirming returned-final completeness.

Do not backfill a token by copying the current revision directly: that would manufacture continuous occupancy and defeat the ABA fence.

Dropbox and hourly reconciliation hard-fence the shoot date read before composition. A concurrent shoot-date edit can intentionally leave the project in `awaiting_raw` for later reconciliation/operator handling.

---

## 7. Open questions

None. The remaining implementation choices are closed by repository state:

- option (b) resolves the repeat assertion contradiction;
- collision has a seventh closed postcondition;
- destination-created NULL tokens have an explicit operator remediation;
- API truth is replay-safe and provider-aware;
- final-completion destination handling is reachable;
- source job kind is a closed set rather than a permanently frozen literal;
- all central types, statement ordering, outcome contracts, and token comparisons are specified.