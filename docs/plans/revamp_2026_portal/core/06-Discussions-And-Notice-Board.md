# Discussions and Notice Board Architecture

**Status:** Proposed Quincy-owned asynchronous collaboration model  
**Related:** [Messaging research](../research/Messaging-And-Commenting-Research.md), [TB3](../roadmap/TB3-Project-Discussion-V2.md), [TB7](../roadmap/TB7-Notice-Board-Migration.md)

## 1. Product model

Quincy is an asynchronous project-collaboration application, not a chat system.

Discussion targets may eventually include:

- project;
- notice-board post;
- asset/review item;
- a non-project task/card if such a product is later added.

The current project Kanban card is the project itself, so it should reuse project discussion rather than create a duplicate `kanban_card` discussion.

## 2. Current assets to reuse

- Shared Tiptap `RichTextDoc` schema and parser.
- Mention extraction, label normalization and eligibility checks.
- Rich-text editor and read-only renderer.
- Byte guards.
- Project collaboration access middleware.
- Author-only edit/delete policy.
- Audit infrastructure.
- Existing project comment and notice-board data.

## 3. Target domain boundaries

Separate these concepts:

```text
Discussion
  human-authored posts, comments, replies, mentions, reactions

Activity
  immutable system events such as stage move, assignment or due-date change

Notification
  recipient-specific delivery/read item derived from discussion/activity events
```

The UI may combine discussion and activity into a chronological timeline, but storage and mutation rules remain distinct.

## 4. Proposed common schema

Exact table names are a plan decision. Conceptual model:

```text
discussion_threads
  id
  scope_type              project | notice_post | asset | future
  scope_id
  title nullable
  status                  open | resolved | archived
  created_by
  created_at
  updated_at

discussion_entries
  id
  thread_id
  parent_entry_id nullable
  author_id
  body
  content_json
  created_at
  edited_at nullable
  deleted_at nullable

discussion_mentions
  id
  entry_id
  mentioned_user_id
  created_at

discussion_reactions
  entry_id
  user_id
  reaction
  created_at

discussion_subscriptions
  thread_id
  user_id
  level                    all | replies_mentions | mentions | muted
  updated_at

discussion_reads
  thread_id
  user_id
  last_read_entry_id nullable
  last_read_at

discussion_attachments
  id
  entry_id
  object_key
  original_name
  content_type
  byte_size
  uploaded_by
  created_at
```

This is a target model, not approval to create every table in TB3.

## 5. Migration strategy options

### Option A — adapter first (recommended)

- Keep existing `project_comments` and notice-board tables initially.
- Build a common service/query interface over project comments.
- Add server-side read state and route-aware refresh.
- Prove the API/UI contract.
- Migrate storage only when a second consumer makes the common schema valuable.

Advantages: smallest data migration and easiest rollback.

### Option B — common schema in TB3

- Create new thread/entry tables.
- Backfill project comments.
- Dual-read or cut over behind a feature flag.
- Keep old tables read-only until verification.

Advantages: earlier unification; higher risk and larger release.

TB0/TB3 plan review should choose based on required first-release features.

## 6. Project discussion v2

Initial recommended scope:

- one project discussion stream;
- current rich text and mentions;
- current author edit/delete;
- cursor pagination;
- delayed refetch/focus refresh;
- server-side read marker;
- no mandatory reactions, attachments or nested replies in the first slice;
- preserve collaboration-only access behavior for stage-hidden project members.

## 7. Replies

Product decision required:

- flat top-level stream only;
- one-level replies (recommended if replies are needed);
- arbitrary nesting.

One-level replies generally matches Trello/Facebook-style context without creating a deeply nested mobile experience or complex unread semantics.

## 8. Notice board

A notice-board post is conceptually a thread root with staff-wide visibility.

Potential notice-specific metadata:

```text
priority
pinned_at
expires_at
requires_acknowledgement
created_for_role/audience
```

Potential behavior:

- top-level post authoring;
- comments/replies if approved;
- mentions;
- server-side unread/read;
- pinning and expiry;
- acknowledgement records for critical notices.

Do not force notice behavior to match project comments exactly.

## 9. Permissions

Project discussion:

- reuse `hasProjectCollaborationAccess` semantics;
- mention only currently eligible project participants/admins;
- edit/delete remains author-only unless explicitly changed;
- every mutation remains audited.

Notice board:

- use capability gating for viewing/posting;
- mention only active staff;
- decide whether admins may moderate others' posts; current behavior is author-only.

Access must be rechecked on every API request and before queued notification delivery.

## 10. Read state

Move notice/project read state to D1.

Recommended semantics:

- mark a thread read after a successful fresh fetch and visible presentation;
- store last-read entry/time;
- compute unread counts relative to entries after that marker;
- do not mark read merely because a background poll succeeded while the surface was hidden;
- make marking idempotent;
- provide first-unread deep-link/scroll behavior later if useful.

## 11. Polling and sync

No realtime requirement.

- project discussion open: 15–30 second interval;
- closed: stop or slow interval;
- notice board open: retain a similar 25–30 second pattern;
- focus/open: immediate refetch if stale;
- own mutation: cache update + targeted invalidation;
- incremental `after` cursor may reduce payload later.

## 12. Activity timeline

Use a separate `activity_events` domain:

```text
project.stage_changed
project.assignment_changed
project.due_changed
project.asset_uploaded
project.delivered
project.priority_changed
project.board_position_changed
```

Event payloads should be structured/versioned. Users cannot edit them. The project/card UI may display them alongside comments with filters.

## 13. Attachments

Defer unless approved for the active slice.

When added:

- R2 stores bytes;
- D1 stores metadata and ownership;
- upload requires current project access;
- download rechecks current access;
- short-lived presigned PUT may be used for large direct uploads;
- read can be Worker-proxied for stricter authorization;
- file policy and retention are explicit.

## 14. Tests

- project access and collaboration-only access;
- mention target validation;
- author-only mutation;
- pagination/order;
- cross-tab/poll refresh;
- read marker across simulated devices;
- access removal;
- draft preservation;
- notification outbox intent written exactly once;
- notice-board role/capability behavior;
- migration/backfill parity when storage changes.

## 15. Non-goals

- Slack-like channels.
- typing/presence.
- managed comments vendor.
- unbounded nested social network.
- replacing Tiptap.
- deleting current data before verified migration.
