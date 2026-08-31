# Discussions, Read State, Activity and Notice Board Architecture

**Status:** Settled proposal  
**Related:** [TB3](../roadmap/TB3-Project-Discussion-V2.md), [TB4C](../roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md), [TB4E](../roadmap/TB4E-External-Editor-Assigned-Scope-Access.md), [TB6](../roadmap/TB6-Project-Card-Detail-And-Discussion.md), [TB7](../roadmap/TB7-Notice-Board-Migration.md)

## 1. Domain boundaries

Keep three distinct domains:

```text
Discussion   human-authored project comments and Notice Board posts
Activity     immutable user-visible project operations
Notification recipient-specific delivery/read rows derived from discussion/activity
```

Security audit remains separate and is never exposed wholesale as project activity.

## 2. Existing assets to preserve

Preserve validated Tiptap format, rich-text editor/renderer, mention extraction, project collaboration access, author-only comment/post edit/delete, cursor pagination/newest-first project comments, audit infrastructure, and existing project-comment/Notice Board data.

## 3. Project discussion/read state

TB3 remains one flat project stream with current rich text/mentions, author-only edit/delete, cursor pagination, refresh/draft preservation, server-owned read state, and adapter over current storage. Do not add replies/reactions/attachments/subscription models.

Mark read only after a successful fresh fetch while visibly presented. Hidden background polling never clears unread state.

## 4. Structured activity

Persist one immutable event per semantic project operation with project/actor/time/type/version/source key/safe payload/deep-link context. Security audit remains separate. Internal retries/cache/delivery bookkeeping never creates activity.

Candidate types include Stage, Priority, team, Deadline, checklist, comment, collection, archive/restore/delivery operations. TB4D adds checklist schedule-change activity under the checklist domain; it is not a separate Calendar event type merely because the mutation originated from Calendar.

## 5. Coalescing/noise

- Comment create/delete each create one useful event; same-comment/same-actor edits coalesce broad delivery within five minutes.
- Checklist schedule changes use the analogous same-item/same-actor five-minute broad-delivery coalescing from TB4D/TB4C.
- Every committed mutation remains audit/activity truthful as defined by its domain; coalescing applies to recipient noise, not hidden state changes.
- Targeted mentions remain separate from broad events.

## 6. Permissions and External Editor privacy

Project discussion reuses project collaboration access. TB4E External Editors on assigned projects receive the normal participant collaboration rights selected for current members.

Project-scoped people behavior:

- mention candidates remain project participants plus approved Admin collaborator candidates;
- External Editors may see participant names, role labels, and email addresses only in authorized project context;
- no global staff directory/search is exposed;
- `productionNotes` is visible to External Editors by explicit decision, while internal
  `projects.notes` remains excluded and is never copied into it; broad notification/activity copy
  still does not repeat note contents;
- agent/client contacts, billing/order bookkeeping, agency-directory notes, Dropbox/provider/Admin data remain external-hidden.

External Editors do **not** receive `viewNoticeBoard`; TB7 continues to apply only to roles with that capability.

## 7. Role-safe Activity

TB6 Activity uses the same role-safe event category/payload rules as notifications:

- internal Admin/Editor see the approved internal registry;
- External Editors see only external-safe categories/payloads for projects they currently may access;
- hidden categories are omitted, not rendered as mysterious redacted placeholders;
- losing membership removes Activity access along with project access.

## 8. TB6 card detail

Use a URL-addressable desktop side sheet / phone full-screen presentation with separate Overview, Activity, Discussion and a canonical full workspace link. External Editor Overview/Activity/Discussion all use external-safe project projections.

## 9. TB7 Notice Board

Preserve top-level posts, rich text/mentions, author-only rules, and the current direct mention-delivery path. Add server-owned read state and route/query freshness. Durable global/non-project mention delivery is separate, not-yet-scheduled future work and is not part of TB7. External Editors remain excluded by capability. Replies/pinning/priority/expiry/acknowledgement are separate later work.

## 10. Tests

Cover project/collaboration access, mention eligibility, author-only mutation, pagination/order, read semantics, draft preservation, coalescing/privacy, role-safe External Editor Activity/Discussion, participant email project scoping/no global directory, membership removal suppression, TB6 URL/focus/mobile behavior, and Notice Board role exclusion.
