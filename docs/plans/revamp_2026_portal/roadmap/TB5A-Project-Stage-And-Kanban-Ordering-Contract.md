# TB5A — Project Stage and Kanban Ordering Contract

**Primary user outcome:** authorized Admins, internal Editors, and assigned External Editors can change Stage from the rail or board through one guarded command, and Board order is authoritative, understandable, and free of hidden Priority effects.

**Sequence:** after TB4E, before TB5B  
**Preconditions:** TB4B Deadline/no-card-RAW contract, TB4E assigned-scope authorization, and TB2 freshness are accepted implementation baselines

## Scope A — `moveProjectStage`

- Add capability to Admin, internal Editor, and External Editor.
- External Editor use is always additionally gated by current assigned-project access; capability alone never grants project visibility.
- Replace Stage movement authorization based on `selectForEditing`.
- Use one command for left-rail picker, native board drag during transition, keyboard/non-drag path, and later dnd-kit.
- Expected current Stage/board revision; `409` on changed premise, no auto retry.
- Rail/non-drag append to target bottom; positional drag may supply exact neighbours; same-Stage rail choice is no-op.
- Preserve Priority as metadata.
- Audit/activity/outbox exactly once and return authoritative state.

## Transition contract

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

- normal one-step public forward: immediate;
- backward: confirm;
- skipped forward: confirm;
- delivered entry/exit: confirm and Stage-only, no publish/revoke side effect;
- `editing_autohdr` entry/exit: dedicated confirmation; allowed to Admin/internal Editor/assigned External Editor; Stage-only, no start/cancel/retire/delete;
- internal and External Editors see neutral **Editing**; Admin may see internal label;
- active destinations only except current inactive Stage remains visible/escapable;
- archived project rejected/read-only; External Editor ordinary archive scope remains unavailable;
- automatic AutoHDR completion cannot silently reassert Stage after expected Stage changed.

## Scope B — ordering correction

- Capture current priority grouping/positions/sorts as fixtures.
- Normalize each Stage once to current visible order with deterministic tie-break; record rollback state.
- Make `boardPosition` sole persisted manual order.
- Priority becomes metadata; optional view-only sort `1` highest through `10`, null last, tie `boardPosition`, then ID.
- Shoot-date sorts remain view-only.
- Priority/sort changes perform no manual-order write.
- Manual reorder controls only in Board order.
- Visible Board order equals persisted/mutation-neighbour order.

## Authorization/query boundary

Board/list data must be server-authorized. Internal Admin/Editor use approved broad scope; External Editor receives only current assigned projects. No hidden all-project payload may be fetched and filtered client-side.

## Deadline/notification behavior

- Preserve card Deadline/overdue and absence of card RAW count.
- Deadline never affects order.
- Stage/Priority changes notify eligible Editors under role-safe TB4C/TB4E rules.
- Pure position reorder creates no broad inbox row.
- Entering delivered supersedes pending Deadline occurrences through TB4B.

## Non-goals

- dnd-kit replacement (TB5B);
- Production Calendar (TB5C);
- global pipeline order/configuration;
- Stage creation/deletion/custom transition graph;
- card-detail feature;
- Deadline sorting.

## Tests/QA

Normalization/manual-order identity, Priority/temp sorts/no hidden writes, rail append/drag neighbour/no-op, all confirmation paths, internal/External neutral label, inactive escape, archived rejection, assigned/unassigned External authorization, expected-state conflict, AutoHDR/delivery side-effect separation, audit/activity/outbox once, reorder notification exclusion, native-board transition path, Deadline/no RAW, matched rail/board evidence and full gate/manual QA.

## Acceptance

One Stage/order contract governs rail, API, native board, persisted state, notifications, External Editor assigned scope, and future dnd-kit. Production remains coherent with native drag if roadmap stops before TB5B.
