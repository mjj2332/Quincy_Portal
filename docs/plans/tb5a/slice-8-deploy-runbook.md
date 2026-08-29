# TB5A Slice 8 — deployment runbook

Status: prepared on 2026-08-29 from the reviewed Slice 8 build. This runbook is a preflight
checklist; migration `0037` and the flag have not been applied to production by this slice.

## 1. Pin the reviewed revision

- [ ] Record the reviewed source commit, the `background`, `webhook-ingress` (if changed), and
      `app` Worker artifact/version hashes.
- [ ] Confirm the reviewed DB migration directory contains `0037` immediately after `0036` and
      that the migration numbering checklist includes the marker, rollback table, and runtime
      index names.
- [ ] Confirm the Slice 8 proof’s largest green compaction benchmark is 500 destination rows.

## 2. Confirm the durable inert mechanism

- [ ] Confirm migration `0037` seeds exactly one permanent feature flag:
      `tb5a_board_contract_enabled = 0`.
- [ ] Before the marker table exists, the app/background revisions use only pre-`0037` columns and
      return bounded maintenance for Stage, reorder, archive, restore, creation, automatic Stage,
      and Priority mutation paths.
- [ ] After the marker exists but the flag is OFF, migration-aware reads and metadata-only
      Priority work operate; every Board-affecting winner SQL requires `enabled = 1` and remains
      inert. List/detail responses expose the real revision/contract fields and hide mutation
      controls while disabled.
- [ ] Do not build or deploy a second schema-aware revision to enable the feature. Enabling is a
      reviewed data write, not a deployment.

## 3. Freeze all Stage-capable writers

Complete this freeze before applying `0037`; no old Stage writer may execute after normalization.

- [ ] Drain notification/project Queues to recorded zero, or pause consumers and record backlog.
- [ ] Stop new Stage-capable Workflow instances and wait for all existing Stage-capable
      instances to become terminal.
- [ ] Disable Cron and hourly reconciliation triggers.
- [ ] Disable app service/RPC paths that can start Dropbox sync, AutoHDR send/fetch, Tonomo
      creation, or reconciliation.
- [ ] Pause app Board writes: creation, Stage, Priority-coupled legacy order, archive, restore,
      and manual reorder.
- [ ] Pause Dropbox reconciliation, Tonomo, AutoHDR claims/finals, Queue consumers, Workflow
      consumers, and any other Stage-capable background trigger.
- [ ] Query audits, jobs, workflows, queues, and Stage/position aggregates twice across a quiet
      interval. Stop for any unexplained change.

## 4. Pre-migration recovery and schema checks

- [ ] Create and verify the remote D1 recovery export for `quincy-portal`; record its timestamp,
      path, and checksum in the change record.
- [ ] Query remote `d1_migrations` and confirm the tail is `0036_external_editor_assigned_scope`.
- [ ] Record the unarchived project count per Stage. Require the largest destination column to be
      no larger than 500, the largest green Slice 8 benchmark. If it is larger, stop rollout for
      fresh performance review rather than extrapolating.
- [ ] Re-run the numbering-discipline, migration split, normalization, FK, quick-check, and
      query-plan proof against the reviewed commit.

## 5. Deploy the pre-schema-aware revision, then migrate

- [ ] With triggers still paused, deploy the reviewed background Worker:

      `cd portal/workers/background && npx wrangler deploy`

- [ ] Deploy `webhook-ingress` only if its reviewed artifact changed:

      `cd portal/workers/webhook-ingress && npx wrangler deploy`

- [ ] Deploy the reviewed app Worker in pre-schema maintenance mode:

      `cd portal/workers/app && npx wrangler deploy`

- [ ] Prove the deployed revisions use old-column projections before the marker exists, all six
      named pre-marker reads are explicit old projections or removed, and no SQL referencing a
      `0037` column was constructed or prepared.
- [ ] Apply migration `0037` only after the freeze and checks above are recorded:

      `cd portal/workers/app && npx wrangler d1 migrations apply quincy-portal --remote --config wrangler.jsonc`

- [ ] Re-query remote `d1_migrations`; require the tail to be
      `0037_project_board_order_contract`.

## 6. Verify with the flag OFF

- [ ] Verify the new project `board_revision` column and workflow token columns, permanent
      rollback table, runtime indexes, and `tb5a_board_contract_enabled = 0`.
- [ ] Verify rollback-row count equals the unarchived project count.
- [ ] Verify the normalized positions are `0, 1024, 2048, …`, every captured unarchived revision
      is `1`, archived rows are unchanged, and Stage/Priority values are unchanged.
- [ ] Verify the intentional External authorized-order correction and zero internal-order
      mismatches.
- [ ] Run `PRAGMA foreign_key_check` and `PRAGMA quick_check`; require an empty result and `ok`.
- [ ] Verify normal internal and strict External list/detail reads work, including authoritative
      authorized maps.
- [ ] Verify metadata-only Priority changes do not change Board revision.
- [ ] Verify every Board-affecting command returns bounded `503 board_contract_disabled` while
      the flag is OFF.
- [ ] Verify background remains inert while triggers are paused: no automatic Stage/position
      writes, no retry storm, and no unexpected 500s.

## 7. Enable and resume

- [ ] Confirm the same reviewed source commit and Worker artifacts remain active.
- [ ] Through the audited operator path, run a prepared, bound update that requires current OFF
      and returns exactly one row:

      `UPDATE feature_flags SET enabled = 1, updated_by = ?, updated_at = ? WHERE key = ? AND enabled = 0 RETURNING key`

      Bind the operator identity, timestamp, and `tb5a_board_contract_enabled`; record the
      feature-flag audit.
- [ ] Run an authorized disposable command smoke test.
- [ ] Resume Queue consumers.
- [ ] Resume new Workflow creation.
- [ ] Resume Cron/reconciliation.
- [ ] Prove only the reviewed background version handles new work.
- [ ] Monitor Stage conflicts, same-Stage forbidden responses, compaction-driven `409` churn,
      token losers, outbox failures, and workflow provenance failures.

## 8. Rollback and fix-forward

### App/UI/command fault

1. Set the flag OFF through the audited operator path.
2. Pause Stage-capable Queue, Workflow, Cron, reconciliation, and service triggers.
3. Keep the migration-aware version serving reads and bounded disabled writes.
4. Do not deploy a pre-TB5A app.
5. Preserve audit/activity/outbox/ledger history and fix forward.

### Background fault

Keep the flag OFF if continued production increases risk. Deploy a fixed TB5A-aware background
consumer, then resume only after it recognizes the Stage revision and source-owner contract.
Never restore a writer that mutates Stage or position without revision/token fencing.

### Migration fault before enablement

Keep the flag OFF. Use the all-or-zero rollback batch only if every captured row remains at
baseline revision `1` and explicit incident authority approves it. A count mismatch aborts the
complete rollback batch. Do not delete the permanent rollback table or edit `d1_migrations`.

### Fault after enablement

Do not bulk-restore positions, reset revisions, or deploy pre-TB5A writers. Fix forward. Use the
recovery export only for catastrophic recovery under explicit authority.

### Privacy fault

Immediately disable the flag, preserve restricted evidence, purge affected External projections
through TB4E’s mechanism, and repair the server SQL/strict DTO boundary. Do not fetch a broad
internal DTO and redact it in React.
