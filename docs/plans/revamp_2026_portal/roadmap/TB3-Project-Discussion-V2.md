# TB3 — Project Discussion v2

**Primary user outcome:** project comments refresh automatically and unread state follows the user across devices without changing the established discussion model.

## Scope

- Adapter/service over current project-comment and mention storage.
- Apply TB2 query/freshness conventions.
- Preserve flat newest-first stream, rich text, mentions, cursor pagination, collaboration access, author-only edit/delete, and audit.
- Add D1 per-user read marker.
- Mark read only after a fresh fetch while visibly presented.
- Hidden background polls never mark read.
- Preserve drafts during refresh.
- Emit structured comment activity/outbox intent compatible with TB4/TB4C while keeping targeted mention semantic separate.

## Non-goals

- common thread/entry storage migration;
- replies, reactions, attachments, named threads, subscriptions;
- notice-board migration;
- broad Collaboration redesign.

## Acceptance

- another tab/user comment appears without reload;
- two-device read state;
- hidden poll does not mark read;
- own post may advance own marker safely;
- drafts, pagination/order, mentions, access, audit remain exact;
- create/edit/delete activity semantics correct;
- direct Collaboration deep link remains;
- full gate/manual QA.
