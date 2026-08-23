# Quincy Portal Revamp — High-Level Brief

**Status:** Revised owner/planning brief; decisions settled in the proposal package, authority promotion still pending  
**Revised:** 2026-08-23  
**Baseline:** `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`  
**Detailed documentation:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

## Purpose

Converge Quincy Portal toward its approved design system and prototype intent while modernizing runtime, UI, freshness, collaboration, scheduling, operational notifications, project coordination, access control, Kanban, and a new Production Calendar without losing the working product, deep links, security boundaries, or Cloudflare-native deployment model.

The work is an incremental program, not a rewrite.

## Program outcomes

1. Upgrade the production Vite SPA to the latest stable pinned React 19.2 patch in an isolated release.
2. Establish Tailwind CSS v4 and source-owned shadcn components as implementation tools for Quincy design convergence.
3. Restore route-safe automatic data freshness while preserving drafts and active interactions.
4. Keep project discussion and the staff Notice Board asynchronous and Quincy-owned.
5. Make notification delivery durable through a D1 outbox and Cloudflare Queue.
6. Make the Project Workspace left rail the canonical project-level coordination surface.
7. Add optional checklist start/end scheduling without destroying existing due-only values.
8. Add a distinct External Editor role whose project access is assignment-scoped and field-limited.
9. Correct Stage/Kanban semantics and modernize board interactions.
10. Add a filterable, shareable Production Calendar with guarded drag/resize scheduling.
11. Migrate remaining UI surfaces only after the foundations are proven.

## Canonical coordination model

Project-level operational metadata belongs in the **Project Workspace left rail**:

- Stage;
- Deadline and reminder rules;
- Photographers;
- Editors.

The **Collaboration panel** remains focused on:

- project checklist/subtasks;
- project comments/discussion;
- task-level collaboration.

### Team controls

Photographers and Editors are independent rows with immediate role-specific idempotent changes.

Baseline eligibility:

- Photographer slot: active Photographers, internal Editors, and Admins.
- Editor slot before TB4E: active internal Editors and Admins.
- Editor slot after TB4E: active internal Editors, External Editors, and Admins.
- External Editors are never eligible for the Photographer slot.

A person may hold both project roles only when their global account role is eligible for both. Removing one membership preserves another compatible membership. Removing a final role may atomically clear checklist assignments after warning.

`editProject` remains the mutation capability for team assignments and project Deadline configuration. Create Project retains initial assignment; after TB4E it may assign External Editors in the Editor slot.

### Stage controls

A new `moveProjectStage` capability is introduced and initially granted to Admins, internal Editors, and External Editors. The left-rail picker and every Kanban movement path share one guarded Stage command.

Semantic progression remains:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

Display order never redefines automation. Manual `editing_autohdr` entry/exit is Stage-only; it does not start, cancel, retire, or delete AutoHDR work. Backward, skipped, delivered, and AutoHDR-sensitive transitions use the approved confirmation behavior.

### Project Deadline

One nullable project Deadline remains separate from shoot date/time and checklist schedule values. It is versioned in `Australia/Sydney`, supports bounded reminder offsets, always materializes Due-now, handles DST gaps/folds explicitly, and suspends pending reminders while delivered/archived.

Kanban cards show Deadline/overdue metadata and omit only card-level RAW count.

## Checklist scheduling

TB4D extends checklist items additively:

```text
Unscheduled        no start, no end
Due-only milestone end/due only
Scheduled range    start + end
```

- Existing `dueDate` values remain truthful end-only milestones; no start is invented.
- Existing date-only due values remain date-only Sydney calendar dates.
- Existing timed due values remain timed Sydney values.
- New ranges require start and end; start-only is invalid and start must precede end.
- Same-day and multi-day ranges are allowed.
- `Australia/Sydney` is canonical; timed values persist deterministic civil/UTC/fold data suitable for range queries.
- The end boundary remains the checklist due/reminder boundary.
- No recurrence is introduced.
- Schedule writes are version/conflict guarded.
- Repeated broad checklist-schedule notifications for the same item/actor coalesce within five minutes while audit/activity still records actual committed operations.

## External Editor

TB4E adds global account role `external_editor`, displayed **External editor**. Project membership remains the existing `editor` role, so project-level notification, assignment, and collaboration domains do not gain a third membership kind.

### Access

External Editors:

- may be assigned to multiple projects in the Editors row or during Create Project;
- never receive `viewAllProjects`;
- require an explicit current project membership for project access;
- have no Photographer Stage-visibility restriction;
- retain normal assigned-project production capabilities, including future `moveProjectStage`;
- cannot create/edit/archive projects or use Admin/user/directory/integration/pipeline/prioritization capabilities;
- cannot see archived projects through their ordinary assigned-project surfaces;
- do not receive the staff Notice Board;
- receive an assigned-scope Production Calendar.

### External-safe projection

For an assigned project they may receive address/location, Agency/Agent display names, shoot date/time, Stage, Deadline, services/deliverables, project production notes, media needed for production, checklist, discussion, roster identities, and project-participant email addresses.

Do not expose agent/client email or phone, invoice/payment fields, internal order bookkeeping not required for editing, agency-directory notes, Dropbox paths/links, provider credentials/diagnostics, or Admin backend data.

This filtering is enforced server-side through role-safe DTO/projection contracts, not hidden only in React.

### Lifecycle

- Existing users are never auto-converted.
- Role transitions revoke sessions immediately.
- Conversion to External Editor is blocked until incompatible Photographer project memberships are removed.
- Deactivation preserves assignment history but blocks authentication/new assignment/pending content delivery.
- Removing the final project membership explicitly warns that project access will be lost and applies the approved checklist-assignment cleanup atomically.
- Access loss purges inaccessible cached data and closes project-specific UI on the next authorization/freshness signal.

## Production Calendar

Dashboard becomes:

```text
List | Kanban | Calendar
```

### Audience and scope

- Admin and internal Editor: normal authorized studio scope.
- External Editor: assigned projects only.
- Calendar filtering never broadens the underlying authorization set.

### Event model

Project event:

- one milestone at the project Deadline;
- Stage, checklist completion, overdue/delivered state as metadata;
- no project duration inferred from shoot date.

Checklist event:

- date-only/timed due milestone, or start/end range;
- title, assignee, completion/overdue state.

No shoot-date layer initially. No comments/uploads/activity rows become calendar events.

### Views and filters

Initial subviews:

- **Month**;
- **Week**;
- **Agenda**.

Calendar state is typed URL state: active date, subview, event layers, Editor filter, Stage filter, completion/delivery/overdue toggles. Back/Forward and copied links restore the same authorized slice.

Initial filters include Projects/Checklist items, multi-Editor OR filtering plus **Unassigned**, Stage, completed checklist visibility, delivered project visibility, overdue-only, and Dashboard search.

### Direct scheduling

- Project Deadline: draggable only with `editProject`; not resizable; confirmation shows old/new Deadline and reminder consequences.
- Due-only checklist item: draggable, not resizable.
- Checklist range: drag preserves duration; end-edge resize changes end; independent start editing uses the schedule editor.
- Month moves whole calendar days while preserving timed wall-clock values; Week uses 15-minute snapping; Agenda uses accessible Reschedule actions instead of drag.
- Direct manipulation uses guarded optimistic state; a stale `409` reverts to authoritative values and never auto-replays.
- DST gaps are rejected; ambiguous repeated times require explicit first/second occurrence.
- Every editable event has a keyboard-operable Move/Reschedule equivalent.

### Unscheduled panel

- Unscheduled project → Month drop creates 17:00 Sydney Deadline on that date; Week drop uses selected 15-minute slot; project confirmation still applies and no advance reminder offset is invented.
- Unscheduled checklist → Month drop creates a date-only due milestone; Week drop creates a one-hour range.
- External Editors may drag unscheduled checklist work on assigned projects but cannot create/move project Deadlines because they lack `editProject`.
- Empty calendar space does not create new projects/tasks.

### Workload collision

Overlapping timed checklist ranges for one assignee are allowed. Calendar shows a non-blocking conflict indicator; it never auto-moves work or treats a project Deadline as exclusive capacity.

### UI engine

TB5C uses the latest reviewed stable **FullCalendar Standard** React integration through FullCalendar's official shadcn registry. Use Standard Month/TimeGrid/List/Interaction capabilities only; no premium Scheduler/resource timeline. Quincy owns toolbar, filters, Unscheduled panel, event renderers, confirmation/editing UX, responsive layout, accessibility treatment, and token mapping. The FullCalendar flavor is selected by matched visual evidence at TB5C implementation time; it is not design authority.

## Data, discussion, and notifications

- Keep the typed custom router and incremental TanStack Query migration.
- Production Calendar uses a dedicated server-authorized range endpoint; do not N+1 fetch every project's checklist in the browser.
- Same-browser invalidation, focus/reconnect, bounded polling, access-loss cache purge, and active-drag reconciliation apply to Calendar.
- Project discussion remains flat and project-scoped.
- External Editors have normal assigned-project collaboration rights and may see project participants' email addresses in project context, but no global directory.
- TB4C/TB4E use role-safe notification/activity visibility. External Editors receive the external-safe subset of broad project events, Deadline reminders, targeted assignments, and mentions while assigned/active.

## Revised sequence

```text
TB0   Integrated decisions, authority proposal, baseline and drift register
TB0A  React 19.2 runtime upgrade
TB0B  Pipeline configuration boundary
TB1   Tailwind v4 + shadcn foundation
TB2   Route-safe Project Workspace freshness
TB3   Project discussion v2 and server-owned read state
TB4   Notification outbox + Cloudflare Queue
TB4A  Project Workspace assignment rail
TB4B  Project Deadline/reminders + Kanban due metadata
TB4C  Editor-wide project-change registry
TB4D  Checklist scheduling ranges
TB4E  External Editor assigned-scope access
TB5A  Project Stage and Kanban ordering contract
TB5B  Kanban interaction modernization
TB5C  Production Calendar
TB6   URL-addressable project-card detail
TB7   Notice-board synchronization migration
TB8   Evidence-driven surface-by-surface convergence
```

## Authority proposal

After a separate owner approval, TB0 should promote:

- **D-16:** UI platform and design convergence.
- **D-17:** Quincy-owned collaboration, freshness, pipeline, and Kanban architecture.
- **D-18:** Project Workspace coordination, Deadline, and Editor notifications.
- **D-19:** React 19.2 runtime baseline.
- **D-20:** Production Calendar and checklist scheduling.
- **D-21:** External Editor assigned-scope access.

Implementation Plan amendments should be **A8 through A14**, with A13 covering checklist scheduling/Calendar and A14 covering External Editor authorization. This package revision does not modify those authority files.
