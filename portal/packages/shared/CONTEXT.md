# Quincy production domain

The vocabulary of the studio's media pipeline: the projects that move through it, the
people assigned to them, and the two independent 1–5 scales that both render as stars.
`packages/shared` is where these concepts are typed, so this is where they are named.

## Language

### Work

**Project**:
One property shoot and everything delivered from it. The unit the pipeline moves.
_Avoid_: Job, listing, shoot

**Asset**:
One media file in a Project, at a known point in the RAW-to-delivered progression.
_Avoid_: Image, photo, file, frame

**Collection**:
One of a Project's five Asset buckets: Raw, Edited, Video, Floorplan, Copy. Holds Assets
(or links) and nothing else.
_Avoid_: Folder, gallery, tab

**Project collaboration**:
A Project's discussion, subtasks and activity history. Not a Collection: it holds no Assets.
_Avoid_: Comments panel, chat

**Workspace tab**:
One selectable view of a Project's workspace: each Collection, plus Project collaboration.
Project collaboration is the tab a Project opens on, unless its link names another Workspace
tab (`?tab=<collection>`; Collaboration's own is `?collaboration=open`). A Project's link always
names the tab being viewed, so a copied link reopens that tab.
_Avoid_: Collection (for the Collaboration tab)

**Project workspace**:
Everything about one Project in one place: its header, its Workspace tabs and their content.
Every Project has its own link that opens its workspace directly.
_Avoid_: Project page, project detail

**Dashboard**:
The staff home: every Project the viewer can see, shown through one Dashboard view at a time.
_Avoid_: Home page, production desk

**Dashboard view**:
One way of laying out the Dashboard's Projects: Table, Board, Calendar or Timeline, chosen
from the Dashboard's tabs — the only place a Dashboard view is chosen. The tabs are the control;
the Dashboard view is what they select. The viewer's last choice is remembered.
_Avoid_: Mode, layout, List (now Table), Kanban (now Board), Gantt (now Timeline)

**Table**:
The Dashboard view that lists Projects as sortable rows, one Project per row, ungrouped unless
the viewer groups them.
_Avoid_: List, grid

**Project sheet**:
The Project workspace presented floating over the Dashboard, covering the whole window.
Dismissing it returns to the same Dashboard view underneath. A Project's own link opens the
sheet over the viewer's last Dashboard view.
_Avoid_: Modal, drawer, project page

**Notice board**:
The studio-wide staff bulletin, not tied to any Project. Has a page of its own, not a
Dashboard section.
_Avoid_: Announcements, news feed

**Stage**:
The pipeline step a Project currently occupies. Keys are fixed in code; labels, active
state and display order are admin configuration.
_Avoid_: Status, state, column, phase

**Archived Project**:
A Project withdrawn from active work, and restorable. The Dashboard hides Archived Projects;
only an Admin can include them, or show nothing else, through the Archived filter (Hide /
Include / Only), in any Dashboard view. On the Board an Archived Project is shown but never moved.
_Avoid_: Status, deleted, closed

**Board**:
The Dashboard view that groups Projects into columns by Stage. One column per Stage. It was
called Kanban until the Dashboard took its Table / Board / Calendar / Timeline tabs; as when
#109 settled "Kanban", the glossary follows the word on the screen. Board order and Board
position already used this word.
_Avoid_: Kanban, dashboard, pipeline view

**Timeline**:
The Dashboard view that lays Projects and their Subtasks out against time, one bar per span.
It was called Gantt until the Dashboard took its tabs.
_Avoid_: Gantt, roadmap

**Shoot date**:
The civil day, in the studio's timezone, a Project's property is shot. A date, never a time.
A Project with none is given today's date when it leaves the Awaiting RAW Stage by any route,
or when its Deadline is set after it has already left that Stage. Only an empty shoot date is
filled; one already held, even as unparsed Tonomo text, is never replaced this way.
_Avoid_: Shoot time, appointment

**Deadline**:
The civil-time commitment for a Project's delivery, held in the studio's timezone.
_Avoid_: Due date, ETA

**Subtask**:
One unit of work inside a Project's collaboration, with any number of Subtask assignees and a
Subtask range. Completion is shared: whoever ticks it off completes it for everyone. The
screen's "Add task" label is kept; the concept is Subtask.
_Avoid_: Checklist item, task, to-do
The UI deliberately labels a Subtask "checklist item" on preference and notification surfaces (ADR 0016); that is intended, not drift.

**Subtask assignee**:
A person responsible for a Subtask. A Subtask may have none, one or several; each is reminded
of its due, and only a newly added one is told they were assigned. Assignees live in
`project_subtask_assignees` only; the single assignee field and column are retired (#373).
_Avoid_: Owner, responsible

**Per-person assignment version**:
The Subtask's assignment version at the moment a person was added as a Subtask assignee, stored on
that person's `project_subtask_assignees` row. It is the identity notification re-validation uses:
removing and re-adding someone yields a new value, and an unrelated add or remove leaves everyone
else's unchanged.
_Avoid_: Assignment token, assignee revision

**Subtask range**:
The span a Subtask is scheduled across, from a start moment to a later end moment, both civil
date-times in the studio's timezone; every Subtask has one. A date picked without a time takes the
preset time: 09:00 for a start, 17:00 for an end. A Subtask's "due" is simply the end of its
range. When none is given, it is copied once from the Project (shoot date at 09:00 to the
Deadline) and is the Subtask's own thereafter.
_Avoid_: Schedule mode, all-day, date-only, unscheduled, due-only, milestone

**Project default range**:
The Subtask range a new Subtask takes when none is chosen, and the popup's "Project default"
shortcut: the Project's shoot date at 09:00 through its Deadline at its own time. It falls back to
the Project's Sydney creation date without a shoot date, to 09:00-17:00 that day without a
Deadline, and to a start on the Deadline's own day (or the day before) when the Deadline is not
after the start. A one-time copy: the Subtask's range is its own thereafter.
_Avoid_: Default schedule, inherited range

**Subtask reminder**:
A moment, counted back from a Subtask's due, when every Subtask assignee is reminded. "Due now"
is always one; up to 8 offsets in all. A new Subtask starts with "1 day before" and "Due now".
One set per Subtask, shared by its assignees. Completing the Subtask or archiving its Project
cancels the ones not yet sent. Reminders go to the assignees at the moment they fire, in-app
always and by email unless the person turned Checklist item reminder emails off.
_Avoid_: Alert, due-today notice

### The two star scales

These are distinct concepts that share a 1–5 range, a nullable "unset", and a star
glyph. They are never the same number and never describe the same thing.

**Project priority**:
How urgently a Project should be worked, relative to other Projects. 1–5, or unset; 5 stars is
the highest priority and 1 the lowest, so the Priority sort lists 5 first and unset last.
Set by hand; never derived. It orders Projects only in the Priority sort — a Stage's Board
order is Board position alone, so Priority never moves a card on the Kanban (#106).
_Avoid_: Rank, urgency, importance, weight, project rating

**Asset rating**:
The quality mark carried by a single Asset, read from its embedded capture metadata.
1–5, or unset. Describes one photograph, not the Project it belongs to.
_Avoid_: Score, quality, priority, stars

### People

**Editor**:
Someone assigned to a Project to produce its edited media.
_Avoid_: Retoucher, post

**External editor**:
An Editor outside the studio. Sees a deliberately narrowed view of a Project.
_Avoid_: Contractor, freelancer, outsourcer

**Default editor**:
A user an Admin has marked on Admin → Users to be added as an Editor of every Project created
afterwards, by hand or from Tonomo, while their account is active and their role can hold an Editor
membership (editor, external editor, admin). Applied once, at creation: removing them from one
Project sticks, and restoring an archived Project adds nobody.
_Avoid_: Auto-assign, sticky editor

**Photographer**:
Someone assigned to a Project to capture its RAW media. Assigned Projects only, and
only while the Project remains in the early Stages.
_Avoid_: Shooter, creative

### Notifications

**Notification**:
The record a Recipient reads in the notification centre. Carries its own title and body,
written at delivery; the stored copy is the durable record, and enrichment at read only
ever adds to it or falls back to it.
_Avoid_: Alert, message, toast

**Notification outbox**:
The queued intent to notify one Recipient about one occurrence, written in the same
transaction as the thing that happened. Not yet a Notification.
_Avoid_: Queue, job, event log

**Delivery ledger**:
The per-channel record of what became of one outbox intent — sent, suppressed or failed —
and which Notification it produced. The audit trail of delivery, not of the occurrence.
_Avoid_: Receipt, delivery log

**Project activity event**:
The durable, Project-scoped record of something that happened, from which broad
Notifications are derived. Outlives any Notification being dismissed.
_Avoid_: Feed item, history row

**Actor**:
Who caused the thing a Notification is about. Never the Recipient: a Notification is not
sent to its own Actor. System occurrences have no Actor.
_Avoid_: Sender, author, user

**Recipient**:
Who is being told. Conflating Recipient with Actor produces "You commented on your own
Asset".
_Avoid_: Target, receiver, subscriber

**Subject**:
The thing a Notification is about — the Asset a comment names, the subtask assigned, the
comment that mentions someone. Not every Notification has one.
_Avoid_: Object, entity, item

**Day bucket**:
The grouping unit of the notification centre: one calendar day in the studio's timezone,
labelled Today, Yesterday, or the date. Keyed by the day, never by the label.
_Avoid_: Group, section, date header

### Editor folder provenance

- **Reconcile skip reason** (`jobs.error` on a done `editor_reconcile` job; `lastReconcile.reason` on the candidate endpoint): a stable code plus a sentence saying why an automatic pass created no Editor tree. The pass did not fail; something about the Project stops the tree (no shoot date, no active photographer, RAW folder outside the Tonomo root, a RAW sync still in flight, ...).
- **Shoot date source** (`shootDateSource` on a parsed Tonomo order): where the order's `shootDate` came from. `start_time` (Tonomo's structured appointment time in the property's timezone), `iso` (already `YYYY-MM-DD`), `display` (Tonomo's "Thursday, 17 Sep, 2026" text, weekday cross-checked), `text` (unparsed, stored verbatim), or null. Only the first three are verified and may move a stored canonical date (audit `project.shoot_date.changed`); `text` against a canonical date is declined (audit `project.shoot_date.declined`).
- **Editor folder move** (a ready or hand-linked mapping, reconcile skip reasons `editor_folder_move_*`): when the Project's shoot date changes after its Editor tree exists, the tree's day folder is relocated to match; the old (now empty) day folder is left in place, never deleted. Hand-linked mappings (`reviewed_by` set) move too, keeping their existing folder name and casing, and `reviewed_by`/`reviewed_at` survive the move untouched. A root whose current parent is not the derived day folder for its own stored shoot date is never guessed at — it is `blocked` (`editor_folder_move_nonstandard_parent`) until an operator relocates it by hand. Delivered/archived Projects never *start* a move, though one already in flight is still allowed to finish. `editor_folder_move_conflict` (a destination name or another mapping's target already claims that path), `editor_folder_move_source_missing` (the mapping's Dropbox root no longer resolves), `editor_folder_move_moved_elsewhere` (Dropbox left the tree somewhere the Portal never expected and never adopts), `editor_folder_move_deferred` (an in-flight job, an active RAW reconciliation claim, an upload quiet period, or a concurrent pass — no operator action, a later pass retries), `editor_folder_move_in_flight` (another pass already holds the move's lease), and `editor_folder_move_orphan_upload` (a file appeared under a root a move vacated; reported, never merged). Each landed move opens its own **orphan-upload watch** on the root it left (#195), so a second reschedule does not drop the first watch. A watch with a file under it becomes `found` and stays until an admin acknowledges it; one still empty after 30 minutes ends by itself, and so does one whose root a mapping lives at again. A landed move's own note is `editor_folder_moved`, not a skip reason.
- **RAW source** (`rawSource` on an Editor folder mapping): where the Project's Tonomo RAW folder was when the Editor tree was reserved. `tonomo` (the stored path existed), `missing` (gone; RAW arrives only through the Editor Input root). When the RAW shared link finds the folder elsewhere under the Tonomo RAW root, the Project is re-pointed first (audit action `project.raw_folder_path.changed`, actor `editor_scaffold`), the folder is scanned, and the next reconcile records `tonomo`.
- **Name source** (`nameSource`): which original-cased text named the Editor project folder. `tonomo_path_display` (Dropbox's own casing), `tonomo_formatted_address` (the order's formatted address from the latest Tonomo payload, "/" replaced by "-", Tonomo's numeric suffix kept), `project_address` (the Project's street and suburb).

