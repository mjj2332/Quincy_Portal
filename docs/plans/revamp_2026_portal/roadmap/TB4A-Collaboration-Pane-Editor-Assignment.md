# TB4A — Collaboration-Pane Editor Assignment

**Primary user outcome:** an authorized coordinator can add or remove the right project editors directly in the collaboration pane without overwriting another user's concurrent membership change.

**Sequence:** after [TB4](./TB4-Notification-Outbox-And-Queues.md), before [TB4B](./TB4B-Project-Deadline-And-Reminders.md)  
**Dependencies:** TB2 route-safe freshness conventions, TB3 collaboration surface, and the accepted TB4 outbox/Queue envelope  
**Baseline reviewed:** `main` at `dfddccbaaaaeff4b0ce3146c58af338d070d345e`

## Current-main facts to preserve

- `project_members` already supports separate `photographer` and `editor` rows with a unique `(project_id, user_id, role_on_project)` key.
- The Edit Project form already selects multiple editors.
- The collaboration pane already has compact anchored assignee popovers, keyboard/focus behavior, comments, checklist state and a stage-hidden member fallback.
- Current `syncMembers()` synchronizes a caller-supplied full-list snapshot. Reusing that shape from two open panes can lose a concurrent membership change.
- Removing an editor may not remove the same person's photographer row or other access.
- Assignment notifications exist today but are direct/best-effort; TB4 supplies the durable delivery envelope.

## User-approved product contract

1. An authorized user can assign or remove multiple editors in the project collaboration pane without opening Edit Project.
2. The picker follows the checklist assignee interaction precedent: compact, anchored, keyboard accessible, searchable when needed and capable of showing multiple selections.
3. The existing project-membership model remains authoritative.
4. Users without the write capability can see the current roster but cannot mutate it.
5. The existing Edit Project selector remains a rollout fallback until pane parity is verified.

## Collaboration-pane experience

Add an **Editors** row near the top of the pane:

- selected editors appear as concise chips/avatars with accessible names;
- an Add or Manage action opens the picker;
- selected state is visible without opening the picker;
- an authorized user can add several editors and remove one without clearing the rest;
- empty, loading, error and no-eligible-editor states are explicit;
- save/refresh does not reset an unrelated comment draft, checklist popover or pane scroll;
- mutation success invalidates the roster wherever it is shown without a full reload.

The control must fit the existing collaboration-panel and phone-width contracts. Portalled popovers must remain unclipped and return focus to the trigger.

## Mutation contract

Prefer role-specific idempotent deltas:

```text
PUT    /projects/:projectId/editors/:userId
DELETE /projects/:projectId/editors/:userId
```

Equivalent endpoint names are acceptable. The reviewed implementation plan must define:

- the current `editProject`/admin capability gate unless the owner approves another role;
- server-side active/eligible-user validation;
- add with conflict-safe no-op semantics;
- remove only the `editor` row;
- an expected membership/project version or an equivalent conditional guard when a mutation spans more than one row;
- authoritative roster/version in the response;
- audit and assignment activity/outbox intent exactly once;
- no self-assignment privilege escalation;
- correct behavior when two tabs add/remove different editors concurrently.

Do not submit a possibly stale full editor list through the general project PATCH.

## Notifications and later slices

TB4A emits the targeted assignment event for a newly assigned editor through the TB4 envelope. It may emit a coordination activity event for audit/history, but it does not activate the broad “all project changes” fan-out.

[TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md) later makes the approved registry mandatory for every active assigned editor. TB4A must therefore preserve reliable membership-start evidence (`created_at` or an explicit membership version) so a remove/re-add cycle cannot receive an event from before the new assignment.

## Permissions and privacy

- Pane visibility never implies write access.
- Preserve the existing stage-hidden collaboration-only fallback.
- Validate targets on the server; never trust picker options as authorization.
- Deactivation or editor removal ends editor-only delivery eligibility.
- Audit only identifiers and before/after membership state; do not copy comment content into membership audit entries.

## Migration and rollout

- Prefer no schema change if role-specific deltas and existing `created_at` can satisfy concurrency and recipient-timing requirements.
- If a membership/project version is required, add it compatibly and make old Workers tolerate the field.
- Keep the Edit Project editor selector during rollout; both surfaces must call the same mutation contract before either is removed.
- Rollback hides/disables the pane control and restores the previous web bundle without deleting membership data.
- No production mutation is authorized by this planning file.

## Tests and manual QA

- add several editors and remove one;
- preserve a simultaneous photographer row;
- repeated add/remove requests are idempotent;
- reject inactive, ineligible and unauthorized targets;
- two-tab add/remove does not lose the other tab's change;
- audit and targeted assignment notification occur once;
- authoritative roster replaces optimistic state after conflict;
- current editor roster refreshes without closing drafts/pickers;
- keyboard open/select/remove/Escape/focus-return behavior;
- collaboration-panel and phone widths;
- stage-hidden collaboration-only access remains exact.

Run the repository full gate after targeted suites.

## Owner decision required

**Write capability:** retain current `editProject`/admin only (recommended), or allow a broader collaborator role to change the editor roster?

This decision is TB4A-gated; TB0 need only record the deferral.

## Non-goals

- project deadline/reminder schema or UI;
- Kanban card metadata;
- broad project-change notification registry;
- changing photographer assignment semantics;
- deleting the Edit Project fallback in the first release;
- weakening collaboration or workspace access rules.

## Acceptance

- multiple editors can be added/removed in the collaboration pane without opening Edit Project;
- concurrent role-specific changes cannot overwrite one another through a stale full list;
- removing the editor role preserves every other role;
- authorization, active-user validation, audit and targeted assignment delivery are exact;
- all roster surfaces converge through automatic freshness without losing local interaction state;
- targeted tests, full gate, matched UI evidence and manual browser QA pass;
- production remains coherent if the roadmap stops after TB4A.

## Checkpoint

Approve the write capability and a current-main-aware implementation plan before product changes. Accept TB4A before TB4B so deadline/reminder recipients use a proven roster contract.
