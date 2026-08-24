# PRD Delta — Runtime, UI, Freshness, Coordination, Collaboration, Scheduling, Access and Production Views

**Status:** Proposed product requirements for later promotion into `docs/PRD.md`  
**Baseline:** `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`  
**Implementation details remain in architecture and tracer-bullet documents.**

## 1. Product objective

Quincy Portal must remain a secure, deep-linkable, Cloudflare-native production application while upgrading to React 19.2, converging toward the Quincy design system, refreshing server data automatically, coordinating projects from the Project Workspace left rail, scheduling project/checklist work, supporting assigned-scope External Editors, delivering operational notifications durably, and presenting the same production work coherently in List, Kanban, and Calendar views.

## 2. Runtime and UI outcomes

- Production runs the latest stable pinned React `19.2.x` patch through an isolated compatibility release.
- Vite SPA, TypeScript, StrictMode, typed custom router, and Cloudflare deployment remain.
- React Compiler, SSR, Server Components, and product-level React feature refactors are outside the runtime upgrade.
- Migrated ordinary controls use Quincy-owned Tailwind v4/shadcn source with Base UI/Sera/Lucide and semantic CSS variables.
- Preflight is disabled initially; dark mode is excluded.
- Material visual differences are classified/evidenced at approved desktop, compact, and phone viewports.
- TB5C may add FullCalendar's official shadcn registry as one reviewed specialized exception after the base shadcn platform exists; FullCalendar does not become visual authority.

## 3. Workspace and freshness outcomes

- Stable URLs support direct navigation, Back/Forward, and multiple project/Calendar slices in separate tabs.
- Every server-backed screen defines query identity, stale/fresh behavior, focus/reconnect, polling, invalidation, cancellation, and draft/interaction preservation.
- Same-browser tabs receive narrow mutation invalidation; another session observes ordinary changes within bounded polling.
- Background refresh never destroys drafts, open controls, Lightbox position, selection, scroll, filters, or active drag/resize.
- Access removal clears inaccessible cached content and stops retrying permanently forbidden resources.

## 4. Canonical Project Workspace coordination

### 4.1 Surface ownership

The Project Workspace left rail is canonical for Stage, project Deadline/reminders, Photographers, and Editors. Collaboration is canonical for checklist/subtasks, project comments/discussion, and task-level collaboration. Project-level mutation controls are not duplicated permanently across both surfaces.

### 4.2 Team assignment

- Photographers and Editors are separate rows with accessible compact rosters and searchable anchored multi-select pickers.
- Per-person changes apply immediately through role-specific idempotent operations with membership-cycle conflict protection.
- Photographer eligibility: active Photographer/internal Editor/Admin.
- Editor eligibility after TB4E: active internal Editor/External Editor/Admin.
- External Editors never qualify for Photographer assignment.
- Inactive assigned users remain visible/removable but cannot be newly selected.
- Removing a final non-admin role warns about and atomically clears affected checklist assignments.
- Create Project retains initial assignment and gains External Editor candidates in the Editor selector when TB4E ships.

### 4.3 Stage mutation

- `moveProjectStage` is the shared guarded Stage command for rail, Kanban, keyboard, and non-drag movement.
- Initially eligible global roles: Admin, internal Editor, and External Editor within assigned project scope.
- Semantic progression remains `awaiting_raw → raw_review → editing_autohdr → edited_review → delivered` independent of display order.
- Confirm backward/skip/delivered/AutoHDR-sensitive transitions.
- Manual AutoHDR Stage change never starts/cancels integration work.
- Archived projects are read-only; External Editors cannot use ordinary archived-project views.

## 5. Project Deadline and reminder requirements

- One nullable project Deadline, independent from shoot date/time and checklist scheduling.
- One transactional left-rail Deadline/reminder editor.
- Canonical timezone `Australia/Sydney`; persist civil value, IANA zone, UTC offset/fold, UTC instant, schedule version.
- Reject nonexistent DST times and explicitly resolve repeated times.
- Reminder presets 1 day/4 hours/1 hour, none selected by default; custom 1 minute–30 days; max eight unique normalized offsets.
- Due-now always exists; past Deadline produces one overdue event and skips elapsed advances.
- One-minute scan targets mandatory in-app creation within two minutes.
- New schedule version supersedes old pending occurrences.
- Current active Editor membership cycles qualify at fire/delivery; after TB4E this includes active External Editors with Editor membership.
- Reminder email default-on after per-user Notification Preferences opt-out exists.
- Delivered/archive suppresses pending rows without clearing metadata; no silent resume.
- Kanban shows Deadline/overdue and omits only card-level RAW count.

## 6. Checklist scheduling requirements

### 6.1 States

A checklist item may be:

```text
Unscheduled        no start, no end
Due-only milestone end/due only
Scheduled range    start and end
```

- Existing due values remain end-only milestones.
- Existing date-only values remain literal Sydney calendar dates.
- Existing date-time values remain timed due milestones.
- Do not invent start values during migration.
- Start-only is invalid; for ranges start must be strictly before end.
- Same-day and multi-day ranges are allowed.
- Recurrence is not included.

### 6.2 Time and persistence

- `Australia/Sydney` is canonical for checklist scheduling.
- Timed start/end persist deterministic local civil values plus canonical UTC/offset-fold metadata for range query and conflict-safe Calendar operations.
- Date-only due remains a calendar date and does not receive a fabricated midnight instant.
- Checklist schedule/item version guards mutation.
- DST gaps reject; repeated times require explicit first/second occurrence.

### 6.3 Permission and reminders

- Preserve existing checklist collaboration mutation permission.
- End/due remains the reminder boundary; start does not create a new reminder category.
- End reschedule resets/reversions the due reminder state under a guarded mutation.
- Repeated broad schedule-update notification for the same item/actor within five minutes coalesces; committed audit/activity remains truthful.

## 7. External Editor requirements

### 7.1 Identity and assignment

- Add global role key `external_editor`, displayed **External editor**.
- Project role remains `editor`; no third project-membership type.
- External status is visibly distinguished in Admin management, Editor picker/team roster, relevant Calendar filters/Activity/Collaboration identity.
- External Editors may be assigned to multiple projects during Create Project or from the Editors rail.
- They are never newly eligible in the Photographer slot.

### 7.2 Access and capabilities

- External Editors do not receive `viewAllProjects`; explicit current project membership is required.
- They have no Photographer Stage restriction.
- Assigned active/delivered projects may be accessed; archived projects are unavailable through ordinary External Editor surfaces.
- Within assigned projects they receive only `uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`, `compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and `collaborateOnProject`, plus `moveProjectStage` once TB5A ships and `viewProductionCalendar` once TB5C ships.
- They are explicitly withheld `publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`, `uploadRaw`, `viewNoticeBoard`, project create/edit/archive, user/directory/integration/pipeline/Admin/prioritization, AutoHDR send, and provider/job diagnostic capabilities.
- Global list/search/Calendar/direct/quick-detail access all enforce the same assigned-scope predicate server-side.

### 7.3 External-safe project projection

May expose on assigned projects:

- address/location;
- Agency and Agent/client display names;
- shoot date/time;
- Stage, Deadline, services/deliverables;
- `productionNotes` (a distinct external-safe field; existing `projects.notes` remains internal and
  is not copied into it);
- approved production media/workflow state;
- checklist/comments/team;
- project-participant names, role labels, and email addresses.

Must not expose:

- Agent/client email or phone;
- invoice/payment information;
- internal order bookkeeping not needed for editing;
- agency-directory notes;
- Dropbox paths/links;
- provider/integration credentials or diagnostics;
- Admin backend data or unrelated staff/projects.

Filtering is server-side and shared across DTOs/queries; UI-only hiding is insufficient.

### 7.4 Collaboration, notifications, and lifecycle

- External Editors have normal assigned-project comments/mentions/checklist rights.
- Mention/assignee discovery and participant email visibility remain project-scoped; no global staff directory.
- They receive targeted assignment and mention events, Deadline reminders, and an external-safe subset of the broad Editor registry while active/assigned.
- Default-on targeted/deadline email policy matches internal Editors; broad event email remains off.
- Notification Preferences is available for their own Deadline-email setting.
- Role changes revoke all sessions. Conversion to External Editor is blocked until Photographer project memberships are removed; incompatible memberships are never silently deleted.
- No existing user is automatically converted.
- Deactivation preserves membership history but revokes auth and suppresses pending content delivery.
- Final membership removal warns that access is immediately lost and applies final-role checklist cleanup atomically.
- Access loss purges inaccessible client caches/project-specific UI at the next authorization/freshness signal.

## 8. Discussion, activity, and notifications

- Project discussion remains one flat newest-first stream with rich text/mentions/author-only edit/delete and server-owned read state.
- Each semantic project operation creates one immutable structured activity event separate from security audit and recipient inbox rows.
- Durable notification delivery uses D1 outbox + Cloudflare Queue + recipient/channel ledger + recovery/DLQ.
- Assigned-Editor membership-cycle rules remain authoritative for broad delivery.
- External Editors receive only event categories and safe payloads allowed by the external projection; hidden categories do not appear as redacted placeholders.
- Pure Kanban/checklist reorder does not broadly notify.
- Comment edits and checklist schedule edits use the approved five-minute same-item/same-actor coalescing rules.

## 9. Kanban requirements

- Card = project; column = Stage.
- `boardPosition` is sole persisted manual order within a Stage.
- Normalize current data once to preserve visible Board order.
- Priority and shoot-date views remain non-writing sorts.
- All Stage movement uses `moveProjectStage`; TB5B uses dnd-kit with pointer/touch/keyboard/non-drag support.
- Direct project links/open-new-tab remain.

## 10. Production Calendar requirements

### 10.1 Location, audience, and event layers

- Calendar is the third Dashboard view: `List | Kanban | Calendar`.
- Admin/internal Editor use their normal project scope; External Editor sees assigned projects only.
- Project event = one Deadline milestone with Stage/checklist completion/overdue/delivered metadata.
- Checklist event = due milestone or start/end range with title/assignee/completion/overdue state.
- Do not infer project start from shoot date; no shoot-date layer initially.
- No comments/uploads/activity rows become Calendar events.

### 10.2 Views, navigation, and responsive behavior

- Initial subviews: Month, Week, Agenda.
- First use opens Month/today; remember deliberate Calendar position/view when URL is absent.
- Week starts Monday, includes weekends, uses 24-hour Sydney time, and keeps full day reachable.
- Phone defaults to Agenda; Month remains available with compact day counts/list. Direct editing remains available even where drag is impractical.

### 10.3 Filters and URL state

- Event layer: Projects / Checklist items.
- Multi-Editor OR filter plus Unassigned.
- Project event matches selected Editor membership; checklist event matches selected assignee.
- Stage multi-select, completed checklist toggle, delivered project toggle, overdue-only, and Dashboard search.
- Active date/view/layers/filters/toggles are typed query parameters. Back/Forward and copied URLs restore the same slice subject to recipient authorization.

### 10.4 Calendar data API

- Use one dedicated range-bounded server-authorized Calendar projection, not project-list + checklist N+1.
- Query identity includes range, event layers, filters, scope and authorization-relevant principal state.
- Return only fields needed by Calendar and a bounded Unscheduled companion projection.
- Access/filtering is enforced server-side; inaccessible IDs never leak through counts/autocomplete/search.

### 10.5 Direct manipulation

- Project Deadline milestone drag requires `editProject`, is not resizable, and confirms old/new Deadline/reminder consequences.
- Due-only checklist milestone drag moves its due boundary and is not resizable.
- Checklist range drag preserves each endpoint's Sydney civil/wall-clock time-of-day on the moved
  dates, not elapsed duration, across DST; end-edge resize changes end; start-edge resize deferred.
- Month movement is whole-day and preserves each endpoint's Sydney civil/wall-clock time-of-day, not
  elapsed duration, across DST; Week snaps 15 minutes; Agenda uses accessible Reschedule actions.
- Do not silently convert timed ↔ date-only by drag.
- Optimistic display rolls back on guarded `409`; no stale auto-retry.
- Every editable event has keyboard-operable Move/Reschedule; focus and announcements are deterministic.

### 10.6 Unscheduled and overlaps

- Unscheduled project Month drop creates 17:00 Sydney Deadline; Week drop uses selected slot; no reminder offset invented and project confirmation required.
- Unscheduled checklist Month drop creates date-only due milestone; Week drop creates one-hour range.
- External Editor can directly schedule checklist work on assigned projects but project Deadline remains read-only.
- Empty Calendar selection does not create work.
- Same-assignee timed checklist overlaps are allowed and shown with non-blocking conflict indication; no automatic rescheduling.

### 10.7 Calendar UI engine

- Recheck and pin the latest stable FullCalendar Standard React/shadcn integration at TB5C implementation time.
- Use FullCalendar's official shadcn registry; no unrelated community calendar implementation.
- Use Standard Month/TimeGrid/List/Interaction capabilities; no premium Scheduler/resource timeline.
- FullCalendar owns scheduling geometry/interactions; Quincy owns surrounding composition, event renderers, permission treatment, dialogs, confirmations, responsive UX and semantic styling.
- Compare official FullCalendar shadcn flavors against Quincy evidence and pin the least-drift choice; no user theme switcher.

## 11. Project-card detail and Notice Board

- TB6 uses URL-addressable desktop side sheet/phone full-screen with separate Overview, Activity, Discussion and canonical workspace link.
- External Editor Activity/Overview obey role-safe projection/event visibility.
- TB7 preserves Notice Board model/read migration for roles with `viewNoticeBoard`; External Editors are excluded by capability.

## 12. Product-level acceptance

The program succeeds when authorized staff can:

1. Use stable routes/tabs without cross-project leakage.
2. Observe external changes without reload or lost local work.
3. Coordinate Stage/Deadline/team from the canonical rail.
4. Schedule checklist ranges without corrupting existing due-only meaning.
5. Use List, Kanban, and a shareable Month/Week/Agenda Calendar against one authorized production model.
6. Drag/reschedule authorized Calendar events with accessible alternatives, deterministic Sydney time, conflict rollback, reminder/activity consistency, and no invented recurrence/sync semantics.
7. Filter Calendar by Editor/Stage/status without revealing inaccessible projects.
8. Give External Editors only the explicit assigned-project production/collaboration allow-list while denying unrelated projects, global staff/Admin surfaces, delivery/publish/RAW-selection/extras scope, and restricted fields.
9. Revoke role/project access without stale-session or stale-cache leakage.
10. Receive durable, deduplicated, role-safe notifications with bounded noise.
11. Recognize every migrated surface as Quincy rather than stock framework appearance.
12. Stop safely after any accepted tracer bullet without leaving mixed ownership or authorization semantics.
