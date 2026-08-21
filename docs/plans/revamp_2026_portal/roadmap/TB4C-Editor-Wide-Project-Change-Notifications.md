# TB4C — Editor-Wide Project-Change Notifications

**Primary user outcome:** every active assigned editor receives one durable in-app alert for each approved user-visible project change without notification storms, duplicate deliveries or content leakage after removal.

**Sequence:** after [TB4B](./TB4B-Project-Deadline-And-Reminders.md), before [TB5A](./TB5A-Kanban-Ordering-Model-Correction.md)  
**Dependencies:** TB4 delivery envelope, TB4A editor-membership contract and TB4B coordination/deadline event shapes  
**Baseline reviewed:** `main` at `dfddccbaaaaeff4b0ce3146c58af338d070d345e`

## Current-main facts to preserve

- Notifications are stored per user in D1 and selected events use `sourceKey` deduplication.
- Request-path email is currently direct/best-effort; TB4 replaces this with a durable outbox/Queue path.
- Existing mention, project-assignment, subtask-assignment and due notifications are targeted events and remain additive.
- `projectNotificationRecipients()` always appends active admins, even with `editorOnly`; it cannot implement this assigned-editor-only guarantee unchanged.
- `project_members.created_at` can distinguish assignment cycles if event ordering uses a compatible clock/version.
- A broad registry spans routes and background jobs; it cannot be implemented safely as one generic database hook.

## User-approved product contract

1. Every active assigned editor receives one mandatory durable in-app notification for each event in the approved project-change registry.
2. This includes the actor when the actor is an assigned editor.
3. Email is an additional channel under its approved reliability/preference contract.
4. “All changes” means a finite versioned registry of user-visible domain events, not every database write.
5. Existing targeted mention/assignee notifications remain additional events.
6. Removal or deactivation prevents future content delivery.

## Versioned event registry

Each entry must define:

- stable event type and registry version;
- owning producer route/job;
- semantic source key;
- actor and project;
- safe summary/copy payload;
- deep link;
- editor-recipient rule;
- bulk coalescing rule;
- old/new producer cutover owner;
- tests and observability fields.

Proposed initial categories for owner approval:

| Category | Candidate user-visible events |
|---|---|
| Coordination | editor added/removed; deadline set/moved/cleared; reminder rules changed |
| Project | project details updated; stage changed; priority changed; board position changed |
| Checklist | item created, edited, completed/reopened, reordered/deleted; assignee or due value changed |
| Comments | project comment created, edited or deleted; mention remains an additional targeted event |
| Collections | user-visible item/batch added, updated or removed across photos/RAW/edited assets, videos, floorplans, copy, links and delivery artifacts |

Rules:

- one human mutation emits one useful event;
- reorder/multi-row writes emit one semantic summary, not one event per row;
- one high-volume import/background job emits one operation summary, not one event per file;
- delivery bookkeeping, cache writes and internal retries never emit user alerts;
- event copy states the user-visible outcome, not an implementation detail;
- registry version changes are reviewed and backward compatible for queued events.

## Exact recipient contract

Resolve mandatory recipients from active `project_members` rows with `role_on_project = 'editor'` only.

- Do not automatically append administrators who are not assigned editors.
- Include the actor only when that actor has an eligible editor membership.
- The membership must have begun no later than the event occurrence.
- Recheck active user, current editor membership and project access immediately before delivery.
- A remove/re-add cycle is a new membership interval; it must not receive events from the earlier interval.
- A newly assigned editor receives the assignment event and later events, never delivered history.
- Proposed default: exclude queued events whose occurrence predates the new membership.
- Preferences/mute may affect optional email/digest, but not the mandatory in-app row while eligibility remains.
- Each recipient/channel delivery is idempotent by registry event/source/recipient/channel key.

If existing `created_at` precision cannot order a same-batch assignment and event unambiguously, add an explicit membership version/interval identifier or persist the recipient snapshot in the outbox. The implementation plan must choose one deterministic contract.

## Producer integration and rollout

The repository-native plan must inventory every current producer before coding. Maintain a cutover table with:

| Event | Current producer | New producer | Source-key rule | Coalescing | Cutover state |
|---|---|---|---|---|---|

Roll out categories in bounded increments behind an internal cohort/feature gate where useful. Exactly one legacy or registry producer is authoritative for a semantic event at a time; both paths share the recipient-delivery key during cutover.

TB4C is accepted only when every owner-approved initial category is live. If that registry proves too large for one safe release, reduce and approve the initial registry or split TB4C again before implementation; do not hide multiple unreviewed releases inside one “complete” checkbox.

## Notification behavior

- Mandatory in-app insertion is durable and does not roll back a successful domain mutation.
- Queue retry/recovery creates one row per eligible recipient.
- Existing mention or subtask-assignment events may coexist because their semantic type/source keys are distinct.
- Optional email follows the TB4 provider idempotency or explicit ambiguous-acceptance policy.
- Access/editor removal suppresses content at delivery and records a non-error suppression outcome.
- Deep links use the shared project notification route and open the appropriate collaboration/project context.

## Observability

Support must be able to answer:

- was the domain event recorded;
- which registry version and producer owned it;
- which editor memberships were eligible and why;
- which recipients were suppressed and why;
- whether outbox, Queue, in-app and optional email stages completed;
- whether a message is retrying/in the DLQ;
- whether replay is safe.

## Migration and rollback

- Add versioned event/delivery fields or tables compatibly with the TB4 schema.
- Preserve old producers only for unrelated or explicitly unmigrated semantic events.
- Disabling a registry producer must not delete domain data or already-created notifications.
- Keep additive event/outbox data for safe replay or forward fix.
- A rollback uses the producer-ownership table to restore exactly one authoritative path.
- No production mutation is authorized by this planning file.

## Tests and manual QA

- one event for every owner-approved checklist/comment/project/collection/coordination registry case;
- acting assigned editor receives the mandatory row;
- acting unassigned admin does not receive an editor-only row solely because of admin role;
- all event-time-eligible current editors receive exactly one row;
- newly assigned editor does not receive an older queued event under the proposed rule;
- remove/re-add interval does not leak earlier events;
- removal/deactivation between mutation and delivery suppresses delivery;
- mention plus editor-wide comment event deduplicate independently;
- bulk import and reorder use approved summaries/coalescing;
- duplicate Queue, recovery and replay converge on one recipient/channel delivery;
- persistent failure is observable/recoverable;
- deep links and copy match each registry entry;
- automatic freshness shows new alerts without a full reload.

Run the repository full gate after targeted suites.

## Owner decisions required

1. **Initial registry:** approve the exact producer/event list; decide whether board reorder and comment edit/delete are useful enough to alert.
2. **Noise/coalescing:** approve per-operation versus timed-window summaries for high-volume collection/background activity.
3. **Queued eligibility:** exclude events created before a new membership (recommended) or snapshot recipients at event time under another explicit rule?
4. **Optional email:** which registry categories email by default, can users mute them, and what digest behavior applies?
5. **Copy/privacy:** how much project/comment/collection detail may appear in notification bodies and email?

These are TB4C-gated; TB0 need only record the deferral.

## Non-goals

- notifying on every D1 row or storage write;
- realtime presence/WebSockets;
- external notification-orchestration vendors;
- replacing targeted mentions or assignee notifications;
- silently notifying every admin;
- changing domain authorization or moderation rights;
- claiming exactly-once email without provider support.

## Acceptance

- the approved versioned registry has a complete producer/copy/source-key/coalescing table;
- each approved event reaches every eligible active assigned editor, including an assigned actor, through exactly one mandatory in-app row;
- unassigned admins are not silently included;
- newly assigned or removed editors follow the approved deterministic timing rule with no content leakage;
- high-volume operations use approved summaries and do not create alert storms;
- optional email follows the disclosed provider contract;
- observability and safe replay identify every delivery outcome;
- targeted tests and the full gate pass;
- production remains coherent if the roadmap stops after TB4C.

## Checkpoint

Approve the registry, noise, queued-eligibility, email and copy/privacy contracts before the repository-native implementation plan. Accept TB4C before TB5A/TB5B.
