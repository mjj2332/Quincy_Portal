# TB5A — Project Stage and Kanban Ordering Contract

**Primary user outcome:** authorized Admins/Editors can change Stage from the rail or board through one guarded command, and Board order is authoritative, understandable, and free of hidden Priority effects.

**Sequence:** after TB4C, before TB5B  
**Precondition:** TB4B Deadline/no-card-RAW contract is live or implementation baseline

## Scope A — `moveProjectStage`

- Add capability granted initially to Admins/Editors.
- Replace Stage movement authorization based on `selectForEditing`.
- Use one command for left-rail picker, native board drag during transition, keyboard/non-drag path, and later dnd-kit.
- Expected current Stage/board revision; `409` on changed premise, no auto retry.
- Rail/non-drag append to target bottom.
- Positional drag may supply exact before/after neighbours.
- Same-Stage rail choice is no-op.
- Preserve Priority as metadata.
- Audit/activity/outbox exactly once and return authoritative state.

## Transition contract

Semantic progression:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

- normal one-step public-stage forward: immediate;
- backward: confirm;
- skipped forward: confirm;
- delivered entry/exit: confirm and Stage-only, no publish/revoke side effect;
- `editing_autohdr` entry/exit: dedicated confirmation; allowed to Admins/Editors; Stage-only, no start/cancel/retire/delete;
- Editor sees **Editing**, Admin may see internal label;
- active destinations only, except current inactive Stage remains visible and escapable;
- archived project rejected/read-only;
- automatic AutoHDR completion cannot silently reassert Stage after expected Stage changed.

## Scope B — ordering correction

- Capture current priority grouping/positions/sorts as fixtures.
- Normalize each Stage once to current visible order: non-null Priority group, current `boardPosition`, deterministic tie-breaker.
- Record pre-normalization rollback data.
- Make `boardPosition` sole persisted manual order.
- Priority becomes metadata.
- Add view-only Priority sort: `1` highest through `10`, null last; tie `boardPosition`, then ID.
- Shoot-date sorts remain view-only.
- Priority/sort changes perform no manual-order write.
- Manual reorder controls only in Board order.
- Visible Board order equals persisted/mutation-neighbour order.
- Successful reorder visibly moves or reports no-op honestly.

## Deadline/notification behavior

- Preserve card Deadline/overdue metadata and absence of card RAW count.
- Deadline never affects order.
- Stage and Priority changes notify eligible Editors.
- Pure position reorder does not create broad inbox row, though audit/activity may record it.
- Entering delivered supersedes pending Deadline occurrences through TB4B contract.

## Non-goals

- dnd-kit interaction replacement;
- global pipeline order/configuration;
- Stage creation/deletion/custom transition graph;
- card-detail feature;
- duplicate comments;
- Deadline sorting.

## Tests/QA

- normalization preserves visible order and deterministic rollback record;
- Board/manual identity;
- Priority/temp sorts and no hidden writes;
- rail append, drag-neighbour, same-stage no-op;
- normal/backward/skip/delivered/AutoHDR confirmations;
- Editor neutral label and active handoff warning;
- inactive escape, archived rejection;
- expected-state conflict/picker preservation;
- AutoHDR/delivery side effects separate;
- audit/activity/outbox once and reorder notification exclusion;
- native board path temporarily uses accepted command;
- Deadline/no RAW preserved;
- matched rail/board evidence and full gate/manual QA.

## Acceptance

One written Stage/order contract governs rail, API, native board, persisted state, notifications, and future dnd-kit. Production remains coherent with native drag if roadmap stops before TB5B.
