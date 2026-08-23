# External Editor Assigned-Scope Authorization

**Status:** Settled proposal; implementation pending  
**Related:** [TB4E](../roadmap/TB4E-External-Editor-Assigned-Scope-Access.md), [Scheduling/Calendar](./12-Production-Calendar-And-Checklist-Scheduling.md), [Notifications](./07-Notifications-On-Cloudflare.md), [Discussion/activity](./06-Discussions-And-Notice-Board.md)

## 1. Identity model

Add one global account role:

```text
external_editor
```

Display label: **External editor**.

Project function remains the existing membership:

```text
roleOnProject = "editor"
```

Do not add an `external_editor` project-membership kind or a separate external-assignment table.

## 2. Capability profile

External Editor keeps the normal production capabilities needed to perform editing work on an authorized project, including:

- RAW/Edited media view/upload as the internal Editor contract allows;
- annotation/recommend/compare/select/review operations;
- approved extras/publish/client-preview/final-download operations;
- `collaborateOnProject`;
- future `moveProjectStage`.

Do not grant:

- `viewAllProjects`;
- create/edit/archive project administration;
- manage users/directory/integrations/pipeline/Admin backend;
- project prioritization;
- staff Notice Board capability.

Capability possession does not bypass assigned-project scope.

## 3. Assigned-project access

Server access rule:

1. roles with `viewAllProjects` may use their approved broad project scope;
2. every other role requires explicit current project membership;
3. Photographer additionally requires Photographer-visible Stage;
4. External Editor has no Photographer Stage restriction.

Apply the same shared predicate to project list/search/detail, Calendar, quick detail, media APIs, Collaboration, notification deep links, and future cross-project queries. Do not rely on React filtering.

External Editors may access assigned active/delivered projects. Archived projects remain unavailable through ordinary External Editor surfaces even if the membership row is retained.

## 4. Assignment eligibility

Editor project slot after TB4E:

- active internal Editor;
- active External Editor;
- active Admin.

Photographer slot remains:

- active Photographer;
- active internal Editor;
- active Admin.

External Editors never newly enter Photographer membership.

External Editors are assignable during Create Project and from the Workspace Editors row. Inactive assigned external users remain visible/removable but cannot be newly selected.

## 5. External-safe project DTO

### Allowed on assigned project

- address/location;
- Agency/Agent display names;
- shoot date/time;
- Stage and project Deadline;
- service/deliverable set;
- project production notes (`projects.notes`);
- production media/workflow state allowed by capabilities;
- checklist and project discussion;
- project team identities/role labels;
- project-participant email addresses.

### Excluded

- Agent/client email and phone;
- invoice/payment data;
- order IDs/numbers and bookkeeping not needed for production;
- agency-directory notes (`agencies.notes`);
- Dropbox folder paths/links;
- provider/integration credentials/status/diagnostics;
- Admin backend data;
- unrelated projects/staff.

Enforce at server serializer/query boundaries across detail/list/Calendar/quick detail/activity/notification deep-link context/export/download metadata. UI hiding does not satisfy the contract.

## 6. Project-scoped people/contact behavior

External Editors may see participant names, role labels, and email addresses only inside projects they can access.

- Mention candidates remain current project participants plus approved Admin collaborator candidates.
- Checklist assignee picker remains project-safe; no global directory browse.
- Calendar filters expose only identities derived from authorized projects.
- Other project participants may likewise see the External Editor's email in project context.
- Search/autocomplete never leaks unrelated users/projects.

## 7. Collaboration

On assigned projects, External Editors have the same participant-level Collaboration rights selected for current project members:

- read/write project comments;
- project-scoped mentions;
- create/edit/complete/reorder/delete checklist items;
- assign eligible participants;
- set/change checklist schedule under TB4D.

Comment edit/delete remains author-only. External identity receives a subtle **External** designation in Team, assignment/mention UI, comments, relevant Activity and Calendar filter context.

## 8. Calendar

External Editor receives `viewProductionCalendar` but only over assigned projects.

- Show project Deadline and all checklist schedule entries on authorized projects.
- Provide **My tasks** as a quick assignee filter, not as the only default data.
- Project Deadline events are read-only because External Editor lacks `editProject`.
- Checklist schedule drag/resize and Unscheduled checklist drag follow normal checklist mutation permission.
- Unscheduled project Deadline entries are visible but not draggable by External Editors.
- Filter options never expand beyond authorized projects.

## 9. Notifications and activity

External Editor participates in Editor-membership delivery rules while active/assigned:

- targeted assignment;
- targeted mention;
- project Deadline reminders/Due-now;
- external-safe subset of broad registry events.

External-safe broad categories may include Stage, Deadline, safe team changes, checklist, comments, visible collection/media/workflow summaries, shoot date/time, and service/deliverable changes.

Do not deliver hidden client-contact, billing/order-bookkeeping, Dropbox/provider/Admin/pipeline categories merely as redacted placeholders.

Broad email remains off. Targeted assignment/mention and Deadline email defaults match internal Editors and obey personal preferences. Activity uses the same category/payload visibility policy.

## 10. Provisioning and role lifecycle

- Admin explicitly provisions/selects **External editor** under the existing closed Google OAuth model.
- No self-signup, automatic invitation acceptance, or magic-link scope is added.
- No existing user is auto-converted by email/domain/activity heuristics.
- Role change revokes all sessions immediately and is audited.
- `editor ↔ external_editor` preserves compatible Editor memberships.
- `admin → external_editor` preserves compatible Editor memberships but is blocked if Photographer memberships exist.
- Conversion to Photographer is blocked while Editor memberships exist.
- Conversion from Photographer to External Editor is blocked while Photographer memberships exist.
- Admin UI identifies blocking project memberships; never silently delete them.

## 11. Deactivation and assignment removal

Deactivation:

- revoke sessions;
- preserve membership rows/history;
- block auth/new assignment;
- suppress pending content-bearing delivery;
- render existing assignment as **Inactive · External editor** where truthful;
- reactivation restores only access backed by still-current memberships; no missed-event backfill.

Final membership removal:

- warn that project access will immediately be lost;
- include existing final-role checklist cleanup count;
- atomically remove membership/clear approved checklist assignments;
- suppress pending project content deliveries;
- keep delivered activity/notification history.

## 12. Access-loss client behavior

When a membership is removed or principal authorization changes:

- purge inaccessible project detail, Calendar, checklist/comments, quick detail, and sensitive media references from client query state;
- close project-specific editors/lightboxes/popovers;
- navigate to the nearest safe Dashboard/assigned-project view with an explanation;
- use same-browser invalidation to accelerate where possible;
- membership loss does not require global sign-out, while role change/deactivation does.

## 13. Test matrix

At minimum prove:

- role capability matrix;
- list/search/direct/API assigned-only access;
- no Photographer Stage restriction for External Editor;
- archived denial/delivered access;
- safe DTO field inclusion/exclusion;
- project participant email allowed, unrelated directory denied;
- Create/rail assignment eligibility and Photographer exclusion;
- role transition session revocation and incompatible-membership guards;
- deactivation/pending delivery suppression;
- final membership access warning/cleanup;
- comment/checklist rights and author-only comment rules;
- no Notice Board;
- Deadline/registry notification eligibility and external-safe categories;
- Calendar assigned-only data/filter/mutation behavior;
- stale cache/UI purge after access removal.
