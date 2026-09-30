---
status: accepted
---

# Subtask assignees are a relation, not a column

A Subtask had one nullable `assignee_id`. The multi-assignee work (PRD #358) needs any number of
people per Subtask, so assignees move into `project_subtask_assignees`: one row per Subtask assignee,
keyed `(subtask_id, user_id)`, deleted with the Subtask and with the user (`ON DELETE cascade`).

## Per-person assignment version

Each row carries `assignment_version`, the Subtask's `assignment_version` when that person was added.
It is monotonic per Subtask, so removing and re-adding someone yields a new value, while people who
stay keep theirs and an unrelated add or remove never invalidates their pending notices. This is the
identity notification re-validation uses. The Subtask-level `assignment_version` stays as the
optimistic-concurrency fence for the whole set.

## Order

A Subtask's "first assignee", the DTO order and the legacy mirror are all
`assignment_version ASC, added_at ASC, user_id ASC` (`ASSIGNEE_ORDER_SQL` and `compareAssignees` in
`workers/app/src/lib/subtask-assignees.ts`).

## Expand, then contract

`project_subtasks.assignee_id` stays and mirrors the first assignee until #373 retires it. The
sequence is: expand (#364, this decision: table, backfill, dual-write), then move every reader and
writer (#368-#372), then detach the column in code, then drop it (#373).

**Invariant this step establishes.** While the column exists and the multi-assignee gate is closed,
`relation == { (s.id, s.assignee_id, s.assignment_version) : s.assignee_id IS NOT NULL }`. Every path
that changes `assignee_id` already bumps `assignment_version` (create sets 1, update adds 1, team
removal adds 1). `scripts/subtask-assignees-verify.sql` checks it and is valid only until the flag flip.

**Dual-write is application-level, not triggers.** The worker test harness splits migration SQL on
`;`, so a trigger body cannot be loaded and the repo has none. The relation statements are appended
at the end of the existing `D1.batch` (positional reads of earlier results stay valid) and each is
fenced by `EXISTS (SELECT 1 FROM audit_log WHERE id = ?)` on the winning audit row, so a lost
compare-and-swap writes nothing. Updates are **replace-one**: they delete the person the column held
and insert the new one, never "reset the relation to the column", so code running after a rollback
over multi-assignee data touches only the person the old UI knew about.

**More than one assignee is gated** by the `subtask_multi_assignee` feature flag until every reader
is migrated; otherwise a second assignee would silently miss due reminders, Calendar filters, team
removal counts and the Gantt.

## Rollback floors

| Live code | Safe rollback target | Why |
|---|---|---|
| #364 | anything | old code ignores the table, and drift is healed by the next migration (0049) |
| #368-#372, flag off | #364 or later, never below it once 0049 is applied | #364 dual-writes and nothing re-syncs after 0049 |
| any, flag on | #368 or later (#364 is degraded: it sees the first assignee only and keeps the rest) | #364's writes are replace-one and never delete unknown assignees |
| #373 detach | the previous PR (never below #368 once multi-assignee data exists) | earlier readers still read the mirror, which is stale once the detach writes without it |
| #373 drop | the detach PR or later only | the column is gone, and restoring it means Time Travel, which loses writes |
