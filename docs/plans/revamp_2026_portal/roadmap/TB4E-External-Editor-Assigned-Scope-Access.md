# TB4E — External Editor Assigned-Scope Access

**Primary user outcome:** an External Editor can perform normal editing work on explicitly assigned projects without discovering unrelated projects or internal-only data.

**Sequence:** after TB4D, before TB5A  
**Dependencies:** TB4A role-specific assignment contract, TB4C registry, TB4D checklist scheduling, TB2 access-loss freshness

## Role/model

Add global role `external_editor`, displayed **External editor**. Project membership remains existing `roleOnProject="editor"`; no third membership kind.

External status is shown subtly in Admin user management, Editor assignment/team UI, relevant comments/Activity, mention/assignee UI and Calendar filters.

## Capabilities

Grant only the explicit assigned-project allow-list: `uploadEdited`, `viewRaw`, `annotateRaw`,
`recommendRaw`, `compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and
`collaborateOnProject`, plus `moveProjectStage` when TB5A ships and `viewProductionCalendar` when
TB5C ships.

Withhold `publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`,
`uploadRaw`, `viewNoticeBoard`, project create/edit/archive, Admin/user/directory/integration/
pipeline/prioritization, the staff Notice Board, AutoHDR send, and provider/job diagnostic
capabilities. They also do not receive `viewAllProjects`.

## Assigned-project authorization

Generalize project access/list/search around capability:

1. `viewAllProjects` roles use their approved broad scope;
2. other roles require explicit project membership;
3. Photographer additionally requires Photographer-visible Stage;
4. External Editor has no Stage restriction.

Apply server-side to lists/search/detail/media/Collaboration/Calendar/quick-detail/deep-link APIs. Unassigned projects must not leak through search suggestions, counts, filters, errors or browser-only hiding.

Assigned active/delivered projects are accessible. Archived projects are unavailable to External Editors through ordinary surfaces.

## Assignment eligibility

Editor slot/Create Project candidates after TB4E: active internal Editor, External Editor, Admin. Photographer slot remains Photographer/internal Editor/Admin. External Editors never newly enter Photographer membership. Inactive assigned External Editors remain visible/removable.

Final External Editor membership removal warns that project access will immediately be lost plus any checklist-assignment cleanup count; mutation stays atomic.

## External-safe DTO

Allowed on assigned project:

- address/location;
- Agency/Agent display names;
- shoot date/time;
- Stage/Deadline/services/deliverables;
- `productionNotes` (a distinct external-safe field; existing `projects.notes` remains internal and
  is not copied into it);
- authorized production media/workflow;
- checklist/comments/team;
- project-participant names/role labels/email addresses.

Excluded:

- Agent/client email or phone;
- billing/invoice/payment;
- internal order bookkeeping not needed for production;
- `agencies.notes`;
- Dropbox paths/links;
- provider/integration credentials/status/diagnostics;
- Admin data;
- unrelated users/projects.

Enforce in server serializers/query projections, including Calendar/activity/notification/export contexts. UI hiding is insufficient.

## Collaboration/contact

External Editor has normal assigned-project participant Collaboration rights. Mention/assignee discovery and participant email visibility are project-scoped only; no global staff directory.

## Notifications/activity

Use the existing Editor membership-cycle delivery mechanism. External-safe categories include Stage, Deadline, safe team, checklist, comment, visible media/workflow, shoot and service/deliverable changes. Suppress hidden contact/billing/order/agency-note/Dropbox/provider/Admin/pipeline categories entirely.

Targeted assignment/mention and Deadline email defaults match internal Editor; broad email off. Personal Deadline-email preference available.

## Role/deactivation lifecycle

- no auto-conversion of existing users;
- closed Google OAuth provisioning remains;
- every role transition revokes all sessions and audits;
- conversion to External Editor blocked while Photographer memberships exist;
- conversion to Photographer blocked while Editor memberships exist;
- Admin UI identifies blockers; never silently deletes memberships;
- deactivation revokes sessions, preserves membership history, blocks new assignment/auth/pending content delivery; no missed-event backfill on reactivation.

## Access-loss client behavior

Membership removal purges inaccessible project/Calendar/checklist/comment/quick-detail/media cache on next auth/freshness signal, closes project-specific UI and navigates safely. Membership loss does not require global sign-out; role change/deactivation does.

## Calendar compatibility

Grant future `viewProductionCalendar` with assigned-project scope. External Editor sees all project/checklist scheduled work on assigned projects plus My Tasks quick filter. Project Deadline is read-only; checklist schedule drag/resize follows normal Collaboration permission. Unscheduled project entries are not draggable by External Editors.

## Tests/QA

Role/capability matrix; assigned/unassigned list/search/direct/API; no Photographer Stage restriction; archived denial/delivered access; safe DTO inclusion/exclusion; project participant email/global-directory isolation; assignment/Create eligibility; role transition/session revocation/membership blockers; deactivation/removal cleanup; Collaboration/Notice Board; notifications/Activity; Calendar scope/mutation; stale-cache purge; full gate/manual role-matrix QA.

## Acceptance

External Editor is a reusable security boundary, not a UI filter. No first External Editor account may be provisioned until list/search/detail projection, field privacy, session transition, and regression tests prove assigned-only behavior.
