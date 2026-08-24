# Quincy Portal Revamp — High-Level Brief

**Status:** Revised owner/planning brief; decisions settled in the proposal package, authority promotion still pending  
**Revised:** 2026-08-24  
**Baseline:** `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`  
**Detailed documentation:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

> **This revision intentionally supersedes the linked `revamp_2026_portal/` package on four specific points**, pending TB0 propagating them into the package documents themselves. Until that propagation lands, this Brief is authoritative on each, and an implementer reading only the package would be misled:
>
> - **(a) Decision numbering.** The package (`Quincy-Portal-Revamp-Index.md`, `revamp_2026_portal/README.md`, `core/01-Decision-Register.md`, `core/10-Repository-Document-Update-Map.md`, `roadmap/TB0-Integrated-Architecture-And-Baseline.md`) still describes promoting six new decisions D-16 through D-21; this Brief promotes four new decisions D-16 through D-19 plus inline revisions to the existing D-15 and D-13.
> - **(b) External Editor capabilities.** `roadmap/TB4E-External-Editor-Assigned-Scope-Access.md` §Capabilities grants `publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, and `selectForEditing`; this Brief explicitly withholds all five.
> - **(c) Project notes field.** That same TB4E §External-safe DTO lists `projects.notes` as directly visible to External Editors; this Brief keeps `notes` internal-staff-only and introduces a new `productionNotes` column, a field name that exists nowhere else in the package.
> - **(d) Range drag and Month-move DST rule.** `roadmap/TB5C-Production-Calendar.md` still specifies duration-preserving range drag and Month moves; this Brief replaces that with wall-clock-preserving behavior across a DST transition.
>
> This Brief still does not modify the Decision Sheet or Implementation Plan authority files, and this pass does not edit the package documents either.

## Purpose

Converge Quincy Portal toward its approved design system and prototype intent while modernizing runtime, UI, freshness, collaboration, scheduling, operational notifications, project coordination, access control, Kanban, and a new Production Calendar without losing the working product, deep links, security boundaries, or Cloudflare-native deployment model.

The work is an incremental program, not a rewrite.

## Program outcomes

1. Upgrade the production Vite SPA to the latest stable pinned React 19.2 patch in an isolated release.
2. Establish Tailwind CSS v4 and source-owned shadcn components as implementation tools for Quincy design convergence.
3. Restore route-safe automatic data freshness while preserving drafts and active interactions.
4. Keep project discussion and the staff Notice Board asynchronous and Quincy-owned; TB7 synchronizes only each user's Notice Board read/unread state across their own devices, not message delivery or an external platform.
5. Make notification delivery durable through a D1 outbox and Cloudflare Queue. Every outbox/Queue dispatch re-checks the recipient's current authorization — active membership and role — immediately before send, not only when the notification is enqueued. Failed reauthorization silently drops the notification without retry or user-visible error and audit-logs the drop for traceability. This is a program-wide requirement on the TB4 outbox/Queue itself, not an External-Editor-only rule added later.
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

A new `moveProjectStage` capability is introduced in **TB5A** and initially granted to Admins, internal Editors, and External Editors. The left-rail picker and every Kanban movement path share one guarded Stage command.

Semantic progression remains:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

Display order never redefines automation. Manual `editing_autohdr` entry/exit is Stage-only; it does not start, cancel, retire, or delete AutoHDR work. Backward, skipped, delivered, and AutoHDR-sensitive transitions use the approved confirmation behavior.

### Project Deadline

One nullable project Deadline remains separate from shoot date/time and checklist schedule values. Deadline values use civil `Australia/Sydney` semantics, with DST gaps and folds represented explicitly. A single shared Deadline revision/conflict-guard token governs every mutation path, including both the left-rail Deadline/reminder editor and Calendar direct manipulation. Deadlines support bounded reminder offsets, always materialize Due-now, and suspend pending reminders while delivered/archived.

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
- New ranges require start and end; start-only is invalid and start must precede end.
- A range's endpoints must both be date-only or both be timed; mixed endpoints are invalid.
- Same-day and multi-day ranges are allowed.
- `Australia/Sydney` is canonical; timed values persist deterministic civil/UTC/fold data suitable for range queries.
- A date-only range's persisted end is the **inclusive final calendar date**, stored as a literal Sydney calendar date with no fabricated midnight instant: an August 1–3 range's stored due/end date is August 3. This matches TB4D's literal-calendar-date convention, and the persisted value is never shifted.
- FullCalendar's native exclusive end boundary is scoped to the Calendar's **wire/event representation only** — a rendering and API-response convention, not the persisted value. The Calendar range endpoint derives the exclusive end (August 4 for an August 1–3 range) when it serializes an event and converts back to the inclusive stored date on write. No other surface, query, or stored column sees the exclusive form.
- Timed ranges are half-open intervals with an inclusive start instant and an exclusive end instant.
- The end boundary remains the checklist due/reminder boundary, and it is the **persisted** boundary — the inclusive final calendar date for date-only ranges, the end instant for timed ranges. An August 1–3 range reminds against August 3, never the derived August 4 render value.
- No recurrence is introduced.
- Schedule writes are version/conflict guarded.
- Repeated broad checklist-schedule notifications for the same item/actor coalesce within five minutes while audit/activity still records actual committed operations.

## External Editor

TB4E adds global account role `external_editor`, displayed **External editor**. It is a genuine fourth value on the global account `Role` enum alongside `admin`, `photographer`, and `editor`, with its own explicit `ROLE_CAPABILITIES` entry; it is not inherited or derived by reusing the project-level `editor` membership role. Project membership remains the existing `editor` role, so project-level notification, assignment, and collaboration domains do not gain a third membership kind.

### Access

External Editors:

- may be assigned to multiple projects in the Editors row or during Create Project;
- never receive `viewAllProjects`;
- require an explicit current project membership for project access;
- have no Photographer Stage-visibility restriction;
- receive no capability outside the explicit allow-list `uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`, `compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and `collaborateOnProject`, plus `moveProjectStage` once TB5A ships and `viewProductionCalendar` once TB5C ships;
- are explicitly withheld `publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`, and `uploadRaw` on a least-privilege basis for a non-employee role;
- cannot create/edit/archive projects or use Admin/user/directory/integration/pipeline/prioritization capabilities;
- cannot see archived projects through their ordinary assigned-project surfaces;
- never receive `viewNoticeBoard` and do not receive the staff Notice Board;
- receive an assigned-scope Production Calendar through the `viewProductionCalendar` capability introduced in TB5C.

### External-safe projection

For an assigned project they may receive address/location, Agency/Agent display names, shoot date/time, Stage, Deadline, services/deliverables, `productionNotes`, media needed for production, checklist, discussion, roster identities, and project-participant email addresses.

The projection does not expose the internal-staff-only `notes` field, agent/client email or phone fields, invoice/payment fields, internal order bookkeeping not required for editing, agency-directory notes, Dropbox paths/links, provider credentials/diagnostics, or Admin backend data.

`projects.notes` is split into two real columns: the existing `notes` column remains internal-staff-only, and a new `productionNotes` column is the project-notes field External Editors may see. Existing `notes` content migrates as internal-only and nothing is auto-promoted into `productionNotes`. Checklist items have no notes field at baseline, so there is nothing to split there. Project discussion deliberately remains one shared user-authored thread rather than being split or content-redacted; that is an explicit scope boundary, not an overlooked DTO field.

TB4E must deliver one shared server-side External-Editor projection function, not per-endpoint filtering logic, plus an automated regression test asserting that every DTO surface reachable by an External Editor passes through that function. Every phase after TB4E from TB5A through TB8 that adds or touches a DTO must run against the same regression test as a release gate.

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
- Checklist range: drag preserves its civil/wall-clock start and end time-of-day values on the moved dates, not elapsed duration, across a DST transition; end-edge resize changes end; independent start editing uses the schedule editor.
- Month moves whole calendar days while preserving timed wall-clock values, consistent with the same wall-clock-preserving range-drag rule; Week uses 15-minute snapping; Agenda uses accessible Reschedule actions instead of drag.
- Direct manipulation uses guarded optimistic state. Project Deadline manipulation uses the same shared Deadline revision/conflict guard as the left-rail editor; a stale `409` reverts to authoritative values and never auto-replays.
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
TB7   Notice Board per-user read-state migration
TB8   Evidence-driven surface-by-surface convergence
```

**TB0B — Pipeline configuration boundary.** Ordinary Admins retain Stage label and active/inactive management, while global Stage ordering moves out of self-service UI/API and into a reviewed developer migration or maintenance script; project-level Stage movement remains unaffected and is owned later by TB5A. See the [TB0B roadmap](./revamp_2026_portal/roadmap/TB0B-Pipeline-Configuration-Boundary.md).

**TB4C — Editor-wide project-change notifications.** Every active, event-time-eligible assigned Editor receives one privacy-safe durable in-app alert for each approved semantic project change, using membership cycles, a defined event registry, and noise/coalescing rules to avoid storms, duplicates, and access leakage. See the [TB4C roadmap](./revamp_2026_portal/roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md).

**TB6 — Project-card detail and shared discussion.** Authorized users can inspect a project's summary, structured activity, and existing discussion from URL-addressable production views without duplicating project data, comments, activity, or Calendar state; External Editors receive only the TB4E external-safe projection for assigned non-archived projects. See the [TB6 roadmap](./revamp_2026_portal/roadmap/TB6-Project-Card-Detail-And-Discussion.md).

**TB7 — Notice Board per-user read-state migration.** Notice Board read/unread state moves from localStorage to a per-user D1 record so it follows that user across their own devices, while mentions reuse the proven refresh and durable-delivery foundations. The Notice Board remains asynchronous: this adds neither realtime delivery nor an external platform. See the [TB7 roadmap](./revamp_2026_portal/roadmap/TB7-Notice-Board-Migration.md).

## Authority proposal

After a separate owner approval, TB0 should promote four new decisions:

- **D-16:** UI platform and design convergence.
- **D-17:** Quincy-owned collaboration, freshness, pipeline, and Kanban architecture.
- **D-18:** Project Workspace coordination, Deadline, and Editor notifications.
- **D-19:** External Editor assigned-scope access.

TB0 should also propose two inline revisions using the Decision Sheet's existing house convention: add `(revised 2026-08-24)` to the affected resolution text and carry the write-up in a new Implementation Plan amendment.

- **D-15 revision:** the approved resolution currently specifies **“A — React 18 + TypeScript + Vite SPA reusing the Quincy design system, internal API via Hono RPC.”** Revise only the React runtime to the latest stable pinned React 19.2 patch; retain TypeScript, the Vite SPA, Quincy design system, and Hono RPC.
- **D-13 revision:** the approved resolution currently says **“A — defer. Keep the data model focused on projects, members, stages, and assets.”** Revise the Schedule-nav deferral to authorize the Production Calendar and checklist scheduling; Clients remain deferred.

The proposed decision-to-phase and amendment map is:

| Decision | Governed TB phase(s) | Implementation Plan amendment subject line(s) |
|---|---|---|
| D-16 — UI platform and design convergence | TB1, TB5B, TB5C, TB6, TB8 | A8 — UI platform and design convergence (D-16) |
| D-17 — Quincy-owned collaboration, freshness, pipeline, and Kanban architecture | TB0B, TB2, TB3, TB4, TB5B, TB7 | A9 — Route-aware server-state freshness (D-17); A10 — Discussions, activity, durable notifications, fixed pipeline semantics, and Kanban (D-17) |
| D-18 — Project Workspace coordination, Deadline, and Editor notifications | TB4A, TB4B, TB4C, TB5A | A11 — Project Workspace coordination, including the `moveProjectStage` Stage capability and the Stage/order contract TB5A delivers (D-18) |
| D-19 — External Editor assigned-scope access | TB4E; TB5A–TB8 where a phase adds/touches a DTO reachable by an External Editor (per the TB4E regression gate) | A14 — External Editor assigned-scope authorization (D-19) |
| D-15, revised 2026-08-24 — React 19.2 runtime | TB0A | A12 — React 19.2 compatibility-only runtime upgrade (D-15, revised 2026-08-24) |
| D-13, revised 2026-08-24 — Production Calendar | TB4D, TB5C | A13 — Checklist scheduling and Production Calendar (D-13, revised 2026-08-24) |

This is a proposal for what the later authority promotion should contain. It does not perform that promotion, and this package revision does not modify the Decision Sheet or Implementation Plan authority files.
