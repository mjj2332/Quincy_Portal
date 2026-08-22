# Discussions, Read State, Activity and Notice Board Architecture

**Status:** Settled proposal  
**Related:** [TB3](../roadmap/TB3-Project-Discussion-V2.md), [TB4C](../roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md), [TB6](../roadmap/TB6-Project-Card-Detail-And-Discussion.md), [TB7](../roadmap/TB7-Notice-Board-Migration.md)

## 1. Domain boundaries

Keep three distinct domains:

```text
Discussion
  human-authored project comments and notice posts

Activity
  immutable user-visible project operations

Notification
  recipient-specific delivery/read rows derived from discussion/activity
```

Security audit remains separate from all three and is never exposed wholesale as project activity.

A current Kanban card is a project, so card detail reuses project discussion/activity rather than creating a second `kanban_card` store.

## 2. Existing assets to preserve

- shared validated Tiptap document format;
- rich-text editor/renderer and byte guards;
- mention extraction/eligibility;
- project collaboration access;
- author-only comment/post edit/delete;
- cursor pagination and newest-first project comments;
- audit infrastructure;
- existing project-comment and notice-board data.

## 3. TB3 project discussion contract

TB3 remains focused:

- one flat project stream;
- current rich text and mentions;
- author-only edit/delete;
- current newest-first order;
- cursor pagination;
- automatic refresh and draft preservation;
- server-owned read state;
- adapter over current `project_comments`/mention storage.

Do not add in TB3:

- replies;
- reactions;
- attachments;
- named threads;
- subscription levels;
- universal thread/entry data migration.

A common service/query interface may be introduced, but common storage waits until TB7 proves a second real consumer.

## 4. Read-state semantics

Store per-user read state in D1:

```text
scope/thread id
user id
last-read entry id nullable
last-read timestamp
```

Mark read only after:

1. a successful fresh fetch; and
2. the discussion is visibly presented.

A hidden background poll does not mark read. Open/focus triggers a fresh fetch when stale. Marking is idempotent. Posting one's own comment may advance the author's read marker using the authoritative returned entry.

## 5. Structured activity

Persist one immutable event per semantic project operation:

```text
id
project_id
actor_id nullable
occurred_at
registry_version
activity_type
source_key
safe_payload_json
deep_link_context
```

Candidate types include:

- `project.stage_changed`;
- `project.priority_changed`;
- `project.team_changed`;
- `project.deadline_changed`;
- `project.checklist_changed`;
- `project.comment_created|edited|deleted`;
- `project.collection_changed`;
- `project.archived|restored`;
- `project.delivered`.

Pure position reorder may remain audit/activity-only and does not create broad inbox noise. Internal retries, cache writes, and delivery bookkeeping never create activity.

## 6. Comment activity/noise

- Comment create: one structured activity and broad Editor event.
- Comment delete: one content-free structured activity/event.
- Comment edit: coalesce repeated edits by the same actor to the same comment within five minutes into at most one broad “Comment updated” event.
- Targeted `@mention` delivery remains separate and may retain its approved excerpt policy.
- Broad comment notifications never contain the body excerpt.

## 7. Permissions and privacy

Project discussion:

- reuse collaboration-access semantics;
- mention only eligible active project participants/Admins;
- author-only edit/delete remains exact;
- Editor-wide delivery never grants discussion access;
- access is rechecked on request and delivery.

Activity payloads and broad notifications use minimal operational detail. Do not include comment body, filenames, project notes, client contacts, Dropbox paths, or provider diagnostics.

## 8. TB6 card detail

Use a URL-addressable responsive sheet:

- desktop side sheet;
- phone full-screen presentation;
- Back/Forward and refresh-safe URL state;
- native open-new-tab and canonical full workspace link.

Keep separate views:

- **Overview:** Stage, Priority, team, Deadline/reminder summary.
- **Activity:** immutable structured events.
- **Discussion:** human-authored comments and unread state.

Do not interleave Activity and Discussion into one undifferentiated feed.

## 9. TB7 notice-board contract

TB7 preserves:

- top-level notice-post model;
- rich text and mentions;
- current author-only rules;
- capability gating.

TB7 adds:

- server-owned read state;
- route/query freshness;
- durable mention delivery through the TB4 envelope.

Defer to separately reviewed work:

- replies/comments under notices;
- pinning;
- priority;
- expiry;
- required acknowledgement.

## 10. Tests

- project and collaboration-only access;
- mention eligibility;
- author-only mutation;
- pagination/order;
- open/focus/background read semantics;
- two-device read state;
- draft preservation;
- comment activity exactly once;
- edit coalescing and delete content privacy;
- targeted mention plus broad event remain distinct;
- removal before delivery suppresses content;
- TB6 URL/Back/focus/mobile behavior;
- notice-board role/read/freshness behavior.
