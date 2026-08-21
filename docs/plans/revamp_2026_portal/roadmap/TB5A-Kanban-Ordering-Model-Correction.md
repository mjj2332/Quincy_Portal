# TB5A — Kanban Ordering-Model Correction

**Primary user outcome:** card order is understandable, authoritative and free of invisible side effects before the drag interaction is modernized.

**Precondition:** TB4A's card contract is live or established as the implementation baseline: show project due date/time when set and omit the Kanban-card RAW count.

## Scope

- Capture current production behavior with representative fixtures:
  - priority mutation changes `boardPosition`;
  - display-only non-null/null priority grouping;
  - flat persisted up/down neighbors;
  - shoot-date overrides;
  - stage-entry append behavior;
  - local sort preference.
- Decide the canonical meaning of priority, manual order and temporary sort modes.
- Recommended default:
  - `boardPosition` is the sole persisted manual order;
  - priority is metadata unless an explicit view-only Priority sort is selected;
  - shoot-date sorts are view-only;
  - metadata/sort changes do not rewrite manual order;
  - manual reorder controls appear only in Board order;
  - stage moves use one documented insertion rule.
- Make visible Board order and mutation-neighbor order identical.
- Remove successful no-visible-effect reorder behavior.
- Define deterministic ties and authoritative mutation responses.
- Add snapshot/version conflict guards where required.
- Decide whether existing values can be reinterpreted, need normalization, or require an additive schema/API change.
- Preserve audit/capability behavior.
- Update affected drift-register entries and matched Kanban evidence.
- Preserve TB4A due metadata and RAW-count removal without treating the deadline as a sort or ordering command.

## Required owner decisions

- Priority is:
  - metadata only;
  - metadata plus an explicit view-only sort; or
  - an ordering command.
- Target-stage insertion is:
  - append to bottom;
  - explicit destination neighbor; or
  - another documented policy.
- Whether users need both Priority and Shoot-date temporary sorts.
- Whether legacy manual order should be preserved byte-for-byte or normalized once.

## Non-goals

- dnd-kit or another drag engine;
- polling/focus refresh;
- project-card detail;
- project comments;
- generic task cards;
- rewriting historical implemented plans.

## Tests/QA

- current behavior fixture exists before correction;
- Board order equals authoritative persisted order;
- priority edit has the approved effect and no hidden extra effect;
- temporary sort switch performs no write;
- reorder control always yields visible movement or is disabled;
- stage-entry policy;
- deterministic ties;
- concurrent/stale mutation conflict;
- legacy-data normalization/reinterpretation;
- admin/non-admin access;
- audit exactly once;
- matched visual/control evidence for Board and temporary sort modes.
- due metadata/overdue state remains readable at approved widths and card RAW count stays absent.

## Acceptance

- one written ordering contract governs frontend, API and persisted data;
- no display-only grouping disagrees with mutation neighbors;
- no successful invisible reorder;
- no hidden manual-order rewrite from a view-only sort or metadata edit;
- migration/rollback is explicit;
- production remains coherent if the roadmap stops here with native drag still in place.

## Checkpoint

Approve the ordering contract and production behavior before TB5B begins.
