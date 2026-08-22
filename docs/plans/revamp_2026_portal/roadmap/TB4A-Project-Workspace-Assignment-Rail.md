# TB4A — Project Workspace Assignment Rail

**Primary user outcome:** authorized coordinators manage Photographers and Editors from the canonical Project Workspace rail without stale full-list overwrites.

**Sequence:** after TB4, before TB4B  
**Dependencies:** TB2 freshness conventions, TB4 delivery envelope, accepted rail design evidence

## Rail shell

TB4A establishes the operational-first Project Workspace rail:

1. header/status/address/location;
2. Production: Stage, Shoot, Deadline location;
3. Team: Photographers, Editors;
4. Client: Agency, Agent;
5. Collections/Dropbox.

Stage renders read-only in its final location until TB5A. Deadline may render only as a clearly unavailable/not-yet-enabled layout state where useful; it must not imply functionality before TB4B.

At phone width the rail becomes a full-width Project Overview above workspace content. Team/Client may use compact disclosures. It never moves into Collaboration.

## Team presentation

Separate **Photographers** and **Editors** rows:

- none: `Not assigned`;
- one/two: initials plus visible names;
- three or more: first two plus `+N`;
- full roster remains available to assistive technology and picker;
- Add/Manage trigger opens anchored searchable multi-select;
- search name, email, and role from the start;
- viewport-contained popover/bottom-sheet behavior at narrow widths.

## Eligibility

Photographer slot:

- active Photographer;
- active Editor;
- active Admin.

Editor slot:

- active Editor;
- active Admin.

Inactive currently assigned users remain visible with **Inactive**, may be removed, and cannot be newly selected. A user may hold both roles.

## Mutation API

Use explicit role routes sharing one internal implementation:

```text
PUT    /projects/:projectId/photographers/:userId
DELETE /projects/:projectId/photographers/:userId
PUT    /projects/:projectId/editors/:userId
DELETE /projects/:projectId/editors/:userId
```

Contract:

- `editProject` capability;
- server-side active/eligible validation;
- add idempotent and returns authoritative membership row/cycle;
- remove identifies the exact current membership cycle;
- stale remove after remove/re-add returns `409` and cannot delete the new cycle;
- removing one role preserves every other role;
- changes to different people/roles commute independently;
- response includes authoritative role roster and cleanup count;
- audit exactly once;
- targeted assignment notification only for a newly inserted membership;
- no self-assignment privilege escalation.

Do not submit a full roster through project PATCH.

## Immediate picker behavior

- Optimistically change only the selected person's state.
- Show a per-person pending indicator and disable only repeated toggle for that person.
- Keep picker open.
- Ordinary failure reverts that person and shows inline error.
- Membership-cycle conflict replaces with authoritative state and explains another tab changed it.
- **Done** closes only; it does not batch-save.

## Final-role checklist cleanup

When removal would eliminate the person's final project role and they are not an active Admin:

- preflight/report the number of checklist assignments that will clear;
- require confirmation;
- remove membership and unassign checklist items atomically;
- preserve assignments when another role or active Admin access remains.

## Notifications

- New assignee receives one role-specific targeted row, including self-assignment.
- Removal is audit-only for the removed user.
- TB4C later informs already-assigned Editors of team changes; the new Editor is suppressed from a duplicate broad row.

## Collaboration-only summary

For a stage-hidden collaborator, add a limited read-only Project Overview outside the Collaboration panel:

- presentation-safe Stage;
- Deadline/overdue/next reminder when later available;
- both rosters;
- no mutation controls, client/media/Dropbox/AutoHDR diagnostics.

## Edit/Create behavior and rollout

- Create Project retains initial team selection.
- Routine Edit Project team selectors retire after rail parity is accepted.
- During rollout, a feature flag/rollback path may re-enable the old controls, but both surfaces must use the role-specific contract.
- Rollback hides rail mutation without rewriting memberships.

## Non-goals

- Deadline schema/scheduler;
- Stage mutation;
- broad Editor registry;
- changing role eligibility;
- pipeline configuration;
- Collaboration ownership changes beyond keeping project-level controls out.

## Tests/QA

- all eligibility combinations, inactive display/removal;
- dual-role preservation;
- idempotent add/remove;
- stale remove/re-add conflict;
- simultaneous different-person/role changes;
- per-person optimistic/error state;
- final-role checklist warning/atomic cleanup;
- unauthorized/ineligible targets;
- targeted notification/audit once;
- cross-tab freshness without closing picker/draft;
- desktop/compact/phone and keyboard/focus/Escape;
- collaboration-only summary privacy;
- Create/Edit rollout behavior;
- full gate/manual QA.

## Acceptance

The rail is canonical and responsive; team deltas are exact, concurrent, audited, and notification-safe; other roles/checklist state are preserved correctly; production remains coherent if later bullets stop.
