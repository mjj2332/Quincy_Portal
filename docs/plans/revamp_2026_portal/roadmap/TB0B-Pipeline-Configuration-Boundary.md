# TB0B — Pipeline Configuration Boundary

**Primary user outcome:** ordinary Admins can manage Stage labels and activation without being able to redefine global pipeline order.

**Sequence:** after TB0A, before TB1  
**Schema:** none expected

## Current-main fact

`Admin → Pipeline` currently supports label edits, active/inactive changes, and Up/Down global ordering through a self-service API.

## Approved contract

Retain:

- Stage label editing;
- Stage active/inactive management;
- existing Stage rows and display-order values.

Remove/disable for ordinary Admin self-service:

- Up/Down controls;
- the corresponding authenticated Stage-order move endpoint.

Future global ordering uses a reviewed developer migration or explicit maintenance script. Stage creation/deletion and generic workflow-builder features remain deferred.

## Scope

- Remove visible ordering controls and related ordinary UI state/tests.
- Remove or reject the self-service move route; do not rely on UI hiding.
- Preserve Stage list reads and label/active endpoints.
- Document the developer-managed order runbook boundary.
- Verify project-level Stage movement remains unaffected; TB5A later owns `moveProjectStage`.

## Non-goals

- adding/removing/custom Stages;
- changing current display order;
- dynamic transition graph;
- Project Workspace Stage picker;
- Kanban ordering correction.

## Tests/QA

- Admin Pipeline loads and refreshes;
- label edit and active toggle still work;
- Up/Down absent;
- direct self-service move call is unavailable/forbidden;
- existing order unchanged;
- active/inactive Stage consumers still refresh;
- matched Admin evidence and full gate.

## Rollback

Previous app/API can be restored, but doing so reopens Admin ordering and therefore requires explicit approval. No data migration.

## Acceptance

Policy is enforced in UI and API, labels/activation remain functional, order values are unchanged, and production remains coherent before TB1.
