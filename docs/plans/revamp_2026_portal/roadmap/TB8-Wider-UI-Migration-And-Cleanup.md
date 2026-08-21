# TB8 — Wider UI Migration and Cleanup

**Primary user outcome:** proven patterns spread across Quincy while duplicated legacy paths are retired safely.

## Preconditions

- UI foundation accepted.
- query conventions accepted.
- project discussion live.
- notification outbox proven.
- board modernization live.
- notice-board direction proven.

## Scope candidates

- remaining project/admin forms;
- standard menus/dialogs/popovers;
- notification UI;
- board filters/card controls;
- collaboration panel decomposition;
- legacy component fetch-state removal;
- old notification emission paths;
- dead CSS selectors;
- final Preflight/base-layer decision.

## Rules

- group by real feature surfaces, not file-extension cleanup;
- remove old path only when its last consumer is migrated;
- preserve historical plans;
- keep specialized CSS/libraries where clearer;
- continue one reviewed release at a time.

## Acceptance

- docs describe live architecture;
- no long-lived dual write/read/style owner;
- legacy CSS is intentional;
- query/polling logic is centralized by feature;
- old notification path is removed only after all event types migrate;
- final visual/accessibility/full gate passes.
