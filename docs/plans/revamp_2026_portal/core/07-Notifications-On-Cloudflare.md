# Notifications on Cloudflare

**Status:** Settled reliable-delivery and project-event proposal  
**Related:** [TB4](../roadmap/TB4-Notification-Outbox-And-Queues.md), [TB4A](../roadmap/TB4A-Project-Workspace-Assignment-Rail.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB4C](../roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md), [TB4D](../roadmap/TB4D-Checklist-Scheduling-Ranges.md), [TB4E](../roadmap/TB4E-External-Editor-Assigned-Scope-Access.md)

## 1. Goal and flow

Keep notification rules/data Quincy-owned while using Cloudflare infrastructure for durable async delivery. A successful domain operation never depends on immediate Queue/email success.

```text
Domain mutation
  ├── domain state
  ├── security audit
  ├── safe activity where applicable
  └── notification_outbox intent
         ├── Queue publish
         └── Cron recovery

Queue consumer
  ├── claim/lease
  ├── recheck recipient membership/access/role-safe category
  ├── recipient/channel delivery ledger
  ├── mandatory in-app insert
  ├── optional email
  └── sent/failed/unknown/suppressed → retry or DLQ
```

Unique semantic delivery key remains `(event_type, source_key, recipient_id, channel)`, never Queue message ID.

## 2. Retry/email ambiguity

Definitive transient pre-acceptance email failure may retry. Ambiguous post-submission outcome is `unknown` and not automatically retried. Manual replay warns duplicate email is possible. Mandatory in-app delivery is independent of email outcome.

## 3. Recipient contracts

### Targeted assignment

New Photographer/Editor assignee receives one role-specific targeted event. After TB4E, an External Editor assigned in the Editor slot uses the same targeted assignment contract. Removal remains audit-only for the removed person; broad roster event goes to other eligible Editors without duplicating the new assignee.

### Project Deadline reminders

Resolve active Editor membership cycles at occurrence/delivery time. After TB4E this includes active External Editors with `roleOnProject="editor"`. Assignment before fire qualifies; removal/deactivation suppresses; remove/re-add cannot receive prior-cycle occurrence; unassigned Admins are not appended.

### Broad registry

Membership cycle must begin no later than event occurrence and still exist at delivery. Actor receives broad row only when eligible. External Editors use the same membership-cycle mechanics but only for external-safe categories/payloads.

## 4. Project Deadline schedule

TB4B remains authoritative: Sydney civil/UTC/fold versioned Deadline, bounded offsets, Due-now, one-minute scan/two-minute target, delivered/archive suppression, personal Deadline-email opt-out.

External Editors receive the same personal Notification Preferences access for their own Deadline-email setting.

## 5. Editor-wide registry

Each type defines stable version, producer, source key, actor/recipient rule, safe payload, deep link, coalescing, email default and cutover tests.

Internal categories remain the approved TB4C registry: team, Deadline, Stage, Priority, selected project metadata, checklist, comments, significant review/workflow, collection/delivery operations.

Noise rules:

- no broad event for pure Kanban/checklist reorder;
- one Deadline schedule event per save/version;
- comment edits coalesce same-comment/same-actor within five minutes;
- **checklist schedule edits coalesce same-item/same-actor within five minutes** for broad delivery;
- one user action/background job = one useful collection summary;
- no per-rendition/cache/retry events;
- new assignment targeted row suppresses duplicate broad roster row for new assignee.

## 6. External Editor event policy

External-safe broad categories may include:

- Stage;
- project Deadline/rules;
- safe team changes;
- checklist create/edit/complete/reopen/delete/assignee/schedule;
- project comment create/edit/delete under broad privacy rules;
- user-visible media/collection/workflow summaries;
- shoot date/time;
- service/deliverable changes.

Do **not** deliver to External Editors categories or payloads that reveal:

- agent/client contact-detail changes;
- billing/invoice/payment or internal order bookkeeping;
- agency-directory notes;
- Dropbox paths/links;
- provider/integration diagnostics;
- Admin/pipeline configuration.

Hidden categories are omitted entirely rather than represented as redacted placeholders. Project production-note content is visible on the assigned project by explicit product decision, but broad notification copy remains content-free for note changes.

## 7. Email defaults

```text
Category                         In-app        Email default
Targeted mention                 required      on, user-controlled
Targeted assignment              required      on, user-controlled
Project Deadline reminder        required      on, global per-user opt-out
Broad registry event             required      off
```

Same defaults apply to eligible External Editors. Per-project mute/digest remains deferred.

## 8. Copy/privacy

Broad rows/email may include actor name, project street/name, event category/outcome, safe link, checklist title, collection type/counts. Do not include broad comment excerpts, filenames, production-note contents, agent/client contacts, Dropbox paths, or provider diagnostics.

Project participant email visibility is a project-detail collaboration decision; it does not imply that notification payloads should expose email addresses.

## 9. Producer ownership/rollback

Exactly one authoritative producer owns a semantic event at a time. Old/new paths share stable delivery keys during cutover. Disabling a producer never deletes domain/activity/inbox data; pending outbox remains recoverable.

## 10. Tests

In addition to TB4/TB4B/TB4C tests, cover External Editor active/assigned eligibility, external-safe category suppression, role/membership removal before delivery, no hidden-field payload leaks, targeted/deadline defaults/preferences, checklist schedule coalescing, and no duplicate Calendar-specific notification semantics.
