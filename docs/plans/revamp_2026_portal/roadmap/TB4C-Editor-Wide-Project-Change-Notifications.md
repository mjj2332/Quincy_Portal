# TB4C — Editor-Wide Project-Change Notifications

**Primary user outcome:** every active event-time-eligible assigned Editor receives one privacy-safe durable in-app alert for each approved semantic project change without storms, duplicates, or access leakage.

**Sequence:** after TB4B, before TB5A  
**Dependencies:** TB4 envelope, TB4A membership cycles, TB4B schedule events, TB3 activity direction

## Structured activity foundation

Persist one immutable safe activity event per semantic operation:

- project/actor/occurrence time;
- event type and registry version;
- stable source key;
- safe versioned payload;
- deep-link context.

Security audit remains separate. Notification delivery references/derives from activity. Internal retry/bookkeeping never creates new activity.

## Exact recipient contract

- Resolve only active `editor` project membership cycles.
- Cycle begins no later than event occurrence and still exists at delivery.
- Include actor only when actor is an eligible assigned Editor.
- Removal/deactivation suppresses pending delivery.
- Remove/re-add cannot receive older-cycle events.
- No history backfill.
- Do not append unassigned Admins.
- Mandatory in-app rows ignore project/email mute while eligibility remains.

## Registry entry requirements

Every type defines:

- type/version and owning producer;
- source-key rule;
- actor/recipient rule;
- safe copy/payload;
- deep link;
- coalescing;
- email default;
- old/new producer ownership and tests.

## Initial registry

### Coordination/project

- team changed;
- Deadline set/moved/cleared/rules updated (one event per Save);
- Stage changed;
- Priority changed;
- address/location, Agency/Agent/contact, shoot date/window, service set, production notes changed (content-free for notes);
- archived/restored.

Exclude order IDs/numbers, invoice/payment, Dropbox paths/links, cover image, and internal provider fields.

### Checklist

- create/edit/complete/reopen/delete;
- assignee or due changed.

Pure checklist reorder does not create broad inbox row.

### Comments

- create;
- delete with content-free copy;
- edit coalesced per same comment/actor within five minutes.

Targeted mention remains separate.

### Collections/review/delivery

- service collection added/removed;
- user-visible asset batch ingested/published/replaced/deleted;
- Edited fetch/publication completion;
- video/floorplan/copy/link/delivery artifact material add/update/remove;
- explicit RAW selection submitted/sent for editing;
- explicit Edited approve/reject/publish workflow operation;
- annotation create/edit/delete with no annotation body.

Do not notify on per-frame rating/color/recommendation/cover/unsubmitted toggle or internal rendition/cache/manifest/retry bookkeeping.

## Noise/coalescing

- one human mutation = one useful event;
- one background job = one project summary;
- no timed cross-operation digest initially;
- pure Kanban position reorder does not notify;
- newly assigned Editor receives targeted assignment only; existing Editors receive broad roster change;
- removed user receives no content-bearing removal row.

## Email defaults

- mandatory in-app for every approved registry event;
- broad event email off by default;
- targeted mentions, targeted assignments, and Deadline reminders remain default-on under preferences;
- later category/digest controls are separate work.

## Copy/privacy

May include actor, project, category/outcome, safe link, checklist title, collection type/counts. Do not include broad comment excerpt, filename, production-note content, client contacts, Dropbox paths, or provider diagnostics.

## Producer cutover

Inventory every existing producer. Exactly one legacy or registry producer owns a semantic event at a time. Share stable delivery keys during cutover. Keep a producer-ownership table/document and roll back one owner at a time.

## Tests/QA

- each approved event exactly once;
- assigned actor/unassigned Admin behavior;
- all eligible cycles and remove/re-add isolation;
- removal/deactivation suppression;
- targeted assignment/mention overlap remains distinct without duplicate;
- reorder exclusions;
- Deadline Save one event;
- comment edit coalescing/delete privacy;
- collection/background one-operation summary;
- email defaults/preferences;
- copy/deep link/privacy;
- Queue/recovery/replay deduplication;
- observability/producer ownership;
- automatic inbox freshness;
- full gate/manual QA.

## Acceptance

The versioned registry, activity records, producer table, exact recipient rules, coalescing, copy, and delivery outcomes are complete for the approved initial scope. If implementation proves too large, split it before coding rather than hiding multiple releases.
