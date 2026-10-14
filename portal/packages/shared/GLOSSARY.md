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
names the tab being viewed, so a copied link reopens that tab. The Project whiteboard is not a
Workspace tab: an icon button beside Collaboration opens it over the workspace, with its own link
(`?whiteboard=open`).
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

**Project whiteboard**:
A Project's own shared canvas, edited live by everyone who can open it, with images and
videos placed on it. One per Project. It replaces the Project sheet's body while it is open,
and has its own link. Its media lives and dies with the Project.
_Avoid_: Canvas, board (the Board is a Dashboard view), sketch

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
A Project before Edited review moves there on its own once Edited media, from the Editor's
Output folder or uploaded in the Portal, has stopped arriving for 15 minutes. It never moves
back from Edited review or Delivered this way, and an Archived Project never moves.
_Avoid_: Status, state, column, phase

**Archived Project**:
A Project withdrawn from active work, and restorable. The Dashboard hides Archived Projects;
only an Admin can include them, or show nothing else, through the Archived filter (Hide /
Include / Only), in any Dashboard view. On the Board an Archived Project is shown but never moved.
Its Checklist, Team, Deadline and Project discussion are read-only (the discussion can still be read, and a person's read marker still advances), and its whiteboard is view-only.
_Avoid_: Status, deleted, closed

**Filter tree** (#461):
The Dashboard filter when the flat facets cannot spell it: a root `and` / `or` group of groups and rules, each rule one
of Stage, Priority, Archived, People, Shoot date, Deadline (a range or Overdue) or My tasks, optionally negated. It is
written `f=1:<tree>` (the `1:` is the grammar version) and never beside a legacy facet parameter; a filter the flat
parameters CAN spell is always written flat (with `forder` to keep the facet order), so an `f` holding one is rejected.
An empty root means no filter. A People rule naming only people outside the viewer's People universe is **not applied**:
it is dropped from its group (never TRUE inside an OR). Caps: 4096 encoded bytes, depth 3, 20 rules, 50 People ids.
_Avoid_: Query, expression, advanced filter

**Filter tree context**:
What People and My tasks mean for a rule, per surface. Projects list: a Project's Editor or the assignee of one of its
open Subtasks. Calendar Deadline events: the Project's Editors; Subtask events: that Subtask's assignees. Timeline: a
Project matches through its own Deadline context OR a visible Subtask matching in the Subtask context. Every other rule
reads the Project. On the Timeline, My tasks in the Subtask context means an Editor of the Subtask's Project OR its
assignee (#680), so a Project I edit lists all its Subtasks, while People stays per-assignee.

**Board**:
The Dashboard view that groups Projects into columns by Stage. One column per Stage. It was
called Kanban until the Dashboard took its Table / Board / Calendar / Timeline tabs; as when
#109 settled "Kanban", the glossary follows the word on the screen. Board order and Board
position already used this word.

Since #470 a column's order is derived, never stored or hand-arranged. Since #830 the viewer
chooses the date that orders every column, from the Display menu's Sort group: Shoot date
(the default) or Deadline, oldest first (Delivered newest first, #832), Projects with no such date last, then street and id.
Priority orders no column. The choice is remembered per browser. Dragging a card to another
column, or Move to in its menu, changes its Stage only, and the card lands where the chosen sort
puts it. A drop inside its own column is refused.
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
The civil-time commitment for a Project's delivery, held in the studio's timezone. A Project
whose Deadline is empty when it gains a shoot date is given an Automatic Deadline.
_Avoid_: Due date, ETA

**Automatic Deadline**:
A Deadline the system filled in: the first weekday (Monday to Friday) after the shoot date, at
17:00; public holidays are not skipped. It follows the shoot
date when that moves, until a person saves it. Once
anyone sets the Deadline by hand, it is an ordinary Deadline and is never moved again. A
Deadline already held is never replaced by an Automatic one. It carries the same reminders
as any Deadline.
_Avoid_: Default deadline, due date

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
the highest priority and 1 the lowest. Set by hand; never derived. It orders no Board column
(#830): a card's stars change without moving it.
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

### AI access

**AI client**:
An AI application that operates the Portal as a staff member, with no permissions of its own.
_Avoid_: Agent (an Agent is the real-estate Client), bot, assistant

**Connected app**:
One staff member's revocable grant letting one AI client act as them.
_Avoid_: Integration, API key, token

**Scope**:
What a Connected app was granted: read, write, or admin. Write and admin are separate, explicit
choices at consent.

**Via marker**:
The "via ‹client›" label on a comment, activity entry or audit record made by an AI client for the
staff member.

### Video review

**Video**:
A titled item in a Project's Video Collection. Its Versions are its cuts; reviewing it is separate
from the photo Stages.
Its title is the file name of its latest live Version (spaces trimmed, `.mp4` or `.mov` dropped, 200
characters at most, "Untitled film" if nothing is left). It moves when a Version is uploaded, removed
or restored (#828), and staff rename it only by renaming the latest Version's file name (#867), from a
Video card's ⋯ menu, which the next upload replaces.
_Avoid_: Asset (a Video is the group of its Versions)

**Version**:
One immutable uploaded Asset of a Video, numbered in upload order. A re-cut is a new Version, never
an edit. Notes, approvals and Releases belong to one exact Version.
_Avoid_: Revision, take

**Review status**:
Where a Video stands inside the studio: In review or Approved (internal), held by its latest Version,
or Published while that Version is in the latest Published set. A new Version starts In review. Guest
reviewers never see it.
_Avoid_: Status (bare), Stage (that is the photo pipeline), workflow state

**Approved (internal)**:
Staff's sign-off that a Version is ready for the client. It is not a Client approval, a Release or a
Publish, and only Admins and Editors can give it.
_Avoid_: Approved (bare), signed off, ready

**Client approval**:
A Guest reviewer's informational decision that a Version is approved. It releases and publishes
nothing.
_Avoid_: Approved (bare), sign-off

**Compare**:
Two Versions of one Video played as one: stepped, scrubbed and played together, side by side or
wiped. The shared position is A's frame number, so it may lie outside A's own range while A has not
started or has ended.
_Avoid_: Diff, A/B view

**Offset**:
How many B frames later Version B starts than Version A (negative: earlier), set per pair of Versions
to line up two cuts. Always a whole number of B frames, and bounded to leave at least one frame in
common.
_Avoid_: Sync, delay, shift

**Audible side**:
The one side of a Compare whose sound is heard; the other is always muted. The reviewer chooses it,
and a side with no audio cannot be chosen.
_Avoid_: Active side, solo

**Master side**:
The side whose presented frames set the shared position while playing: the audible side while it is
playing, else the other playing side. The other side follows it, corrected for drift. A browser
detail, never shown to the reviewer.
_Avoid_: Leader, primary

**Note visibility**:
Whether a note on a Video is public (a Guest reviewer can see it) or internal (studio only). A reply
inherits its parent's visibility, and a guest's note is always public.
_Avoid_: Private, hidden, staff-only

**Open note**:
A note thread on one Version not yet marked resolved. Counted per Version, and only among the notes
the viewer may see: a Guest reviewer counts public notes only.
_Avoid_: Unresolved, pending

**Marker export**:
A file of one Version's notes for an editing program, as DaVinci Resolve markers (an EDL) or Final Cut Pro
markers (FCPXML). Staff choose whether internal notes and which status (all, open, resolved) go in; internal
notes are left out unless ticked. Notes on one frame become one marker, and the file is a copy, not a sync.
_Avoid_: Notes export, NLE export (in staff-facing copy)

**Review link**:
A private link giving Guest reviewers access to one or more Videos from a single Project, with an
expiry, an optional passcode and the Versions granted on it. Delivers released video only. Staff
make it themselves (Admin, Editor and, on Projects they are assigned to, External editors, #834), and
may Revoke or Delete it; the one exception is the Delivery review link. Release stays a studio decision.
_Avoid_: Client link, share link, delivery link (the Delivery page is a different surface)

**Delivery review link**:
The one Review link per Project that the system makes and keeps for its Delivery page: every film
tile on the Delivery page opens it. It carries each film in the latest Published set, at its published
Version and every older one, until a later Publish leaves the film out. The published Version is
downloadable there because it is published, not because of a Release; older Versions behave as on any
Review link. It lives as long as the Delivery page does, has no passcode, always allows comments and
approval, and staff can neither Revoke nor Delete it. Unlike any other Review link, a guest downloads
there without verifying an email; writing a note or giving a Client approval still needs the code. A
locked Premium film has no way onto it until staff Unlock it.
_Avoid_: Default link, system link, delivery link

**Revoke**:
Ending a Review link's access at once. The link stays in staff's list, marked revoked, with its
history.
_Avoid_: Disable, expire

**End guest sessions**:
Signing everyone out of a Review link at once, without changing its address: every guest must verify
their email again, and keeps their email updates. Staff can do it on the Delivery review link only, where
it is the only change they can make (an ordinary link ends its sessions by Replace or Revoke). A guest can also sign themselves out ("Not you?
Sign out"), which ends only their own session. In storage, `client_links.token_generation` is the
session generation: Ending guest sessions raises it, and a session issued under an older one no longer
resolves (the column's name predates that use).
_Avoid_: Revoke (that closes the link), Replace (that changes the address)

**Delete (Review link)**:
Removing an already-revoked Review link from staff's list. Its notes, approvals and audit trail stay,
and it cannot be restored. Anyone who may Revoke a link may Delete it.
_Avoid_: Purge, remove

**Delete (Video)**:
Moving a Video and every one of its Versions to Trash, restorable until Trash empties. Unlike Delete
(Review link), it can be undone.
_Avoid_: Archive, purge

**Guest reviewer**:
A client with no Portal account who reviews through a Review link, identified by an email verified
with a one-time code.
_Avoid_: Client user, visitor, invitee

**Release**:
Staff's explicit act of making one specific approved Version downloadable on a Review link. A client's
approval alone never releases anything.
_Avoid_: Publish, deliver, approve (approval is the client's, informational decision)

**Version download (staff)**:
A staff member taking the original file of one live Version from the review viewer or a Video card's ⋯ menu, as an attachment named
`<Title> v<N>.mp4`. Separate from the stream (which never offers a download) and from a client's download on a
Review link; each full download is audited as `video_version.download`.
_Avoid_: Export (that is the NLE marker export), Release (a Release makes a Version available to a client)

**Social overlay**:
An agency-wide transparent 9:16 frame imitating one platform's on-screen UI, drawn over a film to show
how it reads once posted. Admins manage them; each Project chooses which ones it offers.
_Avoid_: Social profile, template, skin

**Default overlay**:
The one Social overlay that can never be archived, offered whenever a Project has no other usable
Social overlay.
_Avoid_: Fallback profile

**Social preview**:
Watching a Video through a Social overlay, the whole film fitted inside the 9:16 frame (never cropped).
Notes, marks and drawing work as usual while it is on. Staff and Guest reviewers can open it; staff can
also use it in a Compare, where both sides show the same Social overlay.
_Avoid_: Social mode, mockup

### Client delivery

**Delivery page**:
A Project's one public page, at a web address built from the property address, where its latest
Published set is viewed and downloaded with no sign-in and no code. Clients browse and download there;
tapping a film opens it on the Project's Delivery review link, where they watch and download with no
code and verify their email only to comment or approve.
_Avoid_: Gallery (as a domain term; fine as page copy), client portal, client link, Review link

**Publish**:
Staff's explicit act of freezing a chosen set of a Project's Assets as the next Published set. Nothing a
client sees changes until staff publish again.
_Avoid_: Release (that is per Version on a Review link), deliver, share

**Published set**:
The numbered, frozen set of Assets one Publish produced, across photos, Videos, Floorplans and Copy. A
later re-edit or re-upload never alters a Published set already made.
_Avoid_: Delivery, gallery, live collection

**Premium Asset**:
An Asset staff have marked as a paid extra. Premium can be undone until the Asset is published to a
Delivery page (in any set, current or old); after that it stays premium for good. Clients see it only as a watermarked preview
until staff Unlock it.
_Avoid_: Extra, add-on, paywalled (in staff-facing copy)

**Unlock**:
Staff's act of making one Premium Asset viewable and downloadable in full, for everyone who can reach it.
There is no payment in the Portal; a client asks, staff decide.
_Avoid_: Purchase, buy, release

**Web-size**:
The Client Delivery photo derivative a client sees and may download as a zip: a JPEG scaled to fit the
Delivery spec (`delivery_web`). Never the original.
_Avoid_: Web copy, preview, small

**Full-res**:
The original upload of a photo, as the client gets it from a single download or a Full-res zip.
_Avoid_: Original size, RAW (a RAW is a different Collection)

**Download all**:
The control on a Client Delivery page that zips the page's current photos, in Web-size or Full-res. It
includes unlocked Premium photos, leaves out locked ones (listed by label), and never includes Videos or PDFs.
_Avoid_: Bulk download, export

### Notifications

**Notification**:
The record a Recipient reads in the notification centre. Carries its own title and body,
written at delivery; the stored copy is the durable record, and enrichment at read only
ever adds to it or falls back to it. Kept for 30 days from delivery, read or unread, then
removed for good.
_Avoid_: Alert, message, toast

**Notification outbox**:
The queued intent to notify one Recipient about one occurrence, written in the same
transaction as the thing that happened. Not yet a Notification. Removed, with its Delivery ledger rows, once it
and the Notification it led to are both 30 days old.
_Avoid_: Queue, job, event log

**Delivery ledger**:
The per-channel record of what became of one outbox intent — sent, suppressed or failed —
and which Notification it produced. A short-lived record of delivery, kept for 30 days like
the outbox intent it settles; never an audit trail, and not a record of the occurrence.
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

**Email digest**:
One email that gathers a Recipient's pending Notifications, including Project activity that is
never emailed on its own (each Recipient may leave it out), and goes out at their
chosen cadence (Immediately, Hourly, Twice daily or Daily; Twice daily by default). Subtask
reminders and Deadline reminders never wait for it. The notification centre is never delayed
by it; only email is gathered.
_Avoid_: Summary, newsletter, batch

**Link preview**:
The card a post shows for a link inside it: the linked page's title, description and image,
fetched once, when the author adds the link (applies it in the editor), never again on save or
view. Only the post's author may remove one. At most three per
post.
_Avoid_: Unfurl, embed, OG card

**Embedded media**:
An image or video placed inside a post (a Project discussion comment, a Notice board post or a
note on a Video) or on a Project whiteboard. A public note's media is seen by Guest reviewers on
the Review link. Belongs to what holds it: deleted with its post, with its Project, or
a week after it is removed or left unposted. Not an Asset: it is never delivered.
_Avoid_: Attachment, upload, Asset

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

