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

**Stage**:
The pipeline step a Project currently occupies. Keys are fixed in code; labels, active
state and display order are admin configuration.
_Avoid_: Status, state, column, phase

**Board**:
The cross-Project view that groups Projects into columns by Stage. One column per Stage.
_Avoid_: Kanban, dashboard, pipeline view

**Deadline**:
The civil-time commitment for a Project's delivery, held in the studio's timezone.
_Avoid_: Due date, ETA

### The two star scales

These are distinct concepts that share a 1–5 range, a nullable "unset", and a star
glyph. They are never the same number and never describe the same thing.

**Project priority**:
How urgently a Project should be worked, relative to other Projects. 1–5, or unset.
Set by hand; never derived.
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

- **RAW source** (`rawSource` on an Editor folder mapping): where the Project's Tonomo RAW folder was when the Editor tree was reserved. `tonomo` (the stored path existed), `missing` (gone; RAW arrives only through the Editor Input root). When the RAW shared link finds the folder elsewhere under the Tonomo RAW root, the Project is re-pointed first (audit action `project.raw_folder_path.changed`, actor `editor_scaffold`), the folder is scanned, and the next reconcile records `tonomo`.
- **Name source** (`nameSource`): which original-cased text named the Editor project folder. `tonomo_path_display` (Dropbox's own casing), `tonomo_formatted_address` (the order's formatted address from the latest Tonomo payload, "/" replaced by "-", Tonomo's numeric suffix kept), `project_address` (the Project's street and suburb).

