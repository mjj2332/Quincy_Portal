# TB4A — Project Workspace Assignment Rail

**Primary user outcome:** authorized coordinators manage Photographers and Editors from the canonical Project Workspace rail without stale full-list overwrites.

**Sequence:** after TB4, before TB4B  
**Dependencies:** TB2 freshness conventions, TB4 delivery envelope, accepted rail design evidence

## Rail shell

TB4A establishes the operational-first rail: header/status/address/location → Production (Stage, Shoot, Deadline) → Team (Photographers, Editors) → Client (Agency, Agent) → Collections/Dropbox. Stage is read-only until TB5A; Deadline activates in TB4B. Phone uses full-width Project Overview; controls never move into Collaboration.

## Team presentation

Separate Photographers and Editors rows, adaptive roster, anchored searchable multi-select, name/email/role search, viewport-contained popover/bottom-sheet, inactive truthful display.

## Eligibility

At TB4A baseline:

- Photographer: active Photographer/internal Editor/Admin.
- Editor: active internal Editor/Admin.

**TB4E later extends only the Editor candidate set to active External Editors. External Editors never become Photographer candidates.** Existing TB4A API/row contract is reused rather than forked.

## Mutation API

Use explicit role routes:

```text
PUT/DELETE /projects/:projectId/photographers/:userId
PUT/DELETE /projects/:projectId/editors/:userId
```

`editProject`; server eligibility; idempotent add; exact membership-cycle remove; stale remove/re-add `409`; preserve other roles; independent people/roles commute; authoritative response; audit once; targeted notification only for newly inserted membership. Never submit a full roster through project PATCH.

## Immediate picker and final-role cleanup

Optimistically change only one person, keep picker open, per-person pending/error/conflict state. Final non-admin role removal warns with checklist assignment count and atomically unassigns when confirmed. TB4E adds an explicit “will immediately lose project access” warning when that final membership belongs to an External Editor.

## Create/Edit rollout

Create Project retains initial team selection. After TB4E, External Editors are valid initial Editor candidates. Routine Edit Project team selectors retire after rail parity; temporary rollback surface must still use the role-specific contract.

## Collaboration-only summary

Stage-hidden collaborator receives presentation-safe Stage, Deadline/next reminder, and rosters only. This is distinct from TB4E External Editor's explicit assigned-project allow-list.

## Non-goals

Deadline schema/scheduler, Stage mutation, broad registry, External Editor authorization itself, pipeline configuration.

## Acceptance

The rail is canonical/responsive; team deltas are exact/concurrent/audited/notification-safe; later TB4E can extend Editor eligibility without duplicating mutation architecture.
