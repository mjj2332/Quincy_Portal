# TB4C — Editor-Wide Project-Change Notifications

**Primary user outcome:** every active event-time-eligible assigned Editor receives one privacy-safe durable in-app alert for each approved semantic project change without storms, duplicates, or access leakage.

**Sequence:** after TB4B, before TB4D  
**Dependencies:** TB4 envelope, TB4A membership cycles, TB4B schedule events, TB3 activity direction

## Structured activity and recipient contract

Persist one immutable safe activity event per semantic operation; audit remains separate. Resolve active `editor` membership cycles whose cycle began by event occurrence and still exists at delivery. Include actor only if eligible; removal/deactivation suppresses; remove/re-add cannot receive older-cycle event; no history backfill; unassigned Admin excluded.

Because project membership role remains `editor`, **TB4E External Editors reuse this membership-cycle mechanism**. TB4E adds role-safe category/payload filtering rather than a second recipient table.

## Registry/noise

Every type defines producer/source/actor-recipient/safe payload/deep link/coalescing/email/cutover. Initial internal registry covers safe coordination/project, checklist, comments, selected review/workflow and user-visible collection/delivery operations.

Noise rules:

- no broad pure Kanban/checklist reorder;
- one Deadline event per save;
- same-comment/same-actor edits coalesce within five minutes;
- **TB4D schedule changes use same-item/same-actor five-minute broad coalescing**;
- one background/user collection operation = one summary;
- targeted new assignment suppresses duplicate broad roster row to the new assignee.

## External-safe extension in TB4E

External Editor may receive Stage, Deadline, safe team, checklist, comment, visible media/workflow, shoot and service/deliverable categories. Hide contact-detail, billing/order-bookkeeping, agency-note, Dropbox/provider/Admin/pipeline categories entirely. Broad content still omits comment body, filename, production-note contents, client contacts, Dropbox path and diagnostics.

## Email defaults

Mandatory in-app for approved eligible events. Broad email off. Targeted mentions, assignments and Deadline reminders default on under preferences for both internal and External Editors.

## Acceptance

Registry/activity/producer ownership and exact cycle rules are complete before TB4D/TB4E extend schedule and audience semantics; no later feature duplicates the delivery architecture.
