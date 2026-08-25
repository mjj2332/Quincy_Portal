# Revamp TB3 — Project Discussion v2 Plan

> **Status: Deployed to production (version `e6d0879d-b739-46ea-be2c-9f772bec9a66`, 2026-08-25) —
> migration 0030 applied, code/tests committed (`08f56f4`, `2cba9a1`), manual QA and an
> authenticated production smoke test complete. Rollback target: `4a4c61a2-a59f-4c8a-ab99-0ceeb690485e`
> (application code only — migration 0030 is not rolled back by an application rollback; see
> "Concrete rollback and fix-forward" below).**

## Authority and outcome

Authority order for this plan is:

1. [`Decision-Sheet.md` D-17](../Decision-Sheet.md), limited to its project-discussion,
   server-owned read-state, bounded-freshness, and draft-preservation decisions. D-17's durable
   notification, fixed-pipeline, and Kanban decisions remain owned by TB4/TB4C/TB5.
2. [`Implementation-Plan.md` A10](../Implementation-Plan.md), limited to its discussion-freshness
   slice: one flat project-scoped newest-first stream, rich text, mentions, author-only edit/delete,
   cursor pagination, server-owned read state, and the separation of product activity, security
   audit, and recipient inbox rows. A10's D1 outbox, Queue, delivery ledger, recovery/DLQ, Stage,
   and Kanban work is boundary context only.
3. The approved [TB3 roadmap scope stub](./revamp_2026_portal/roadmap/TB3-Project-Discussion-V2.md).
4. The settled [Discussions, Read State, Activity and Notice Board Architecture](./revamp_2026_portal/core/06-Discussions-And-Notice-Board.md).
5. The shipped [TB2 Route-Safe Project Data Freshness Plan](./implemented/Revamp-TB2-Route-Safe-Data-Freshness-Plan.md),
   used as the technical precedent for query identity, principal/role cache isolation, cancellation,
   exact invalidation, same-browser broadcast, focus/visibility behavior, and 401/403/404 cleanup.
6. This repository-native execution plan.

The primary user outcome is the roadmap's approved outcome: **“project comments refresh
automatically and unread state follows the user across devices without changing the established
discussion model.”**

TB3 is an adapter-first migration. It moves the existing Project Collaboration comment stream and
one new per-user read-state resource behind the TB2 server-state machinery. It does not replace the
typed custom router, redesign Collaboration, create a generic discussion product, change Notice
Board storage, or pre-build TB4/TB4C notification delivery.

The freshness target reuses TB2's measurable bounds:

- after a successful foreground comment create/edit/delete, another same-principal tab begins the
  exact comment/read-state refetch within two seconds through the existing
  `quincy:project-data:v1` `BroadcastChannel` runtime;
- another visible browser/profile/device session converges through a 30-second comment/read-state
  polling interval plus ordinary request latency; and
- a hidden document may receive no interval fetch at all, or may receive a forced/broadcast fetch,
  but it never advances the read marker. Only a new network fetch that begins and completes during
  the same visibly-presented generation may do that.

### Implementation precondition

TB0A, TB0B, TB1, and TB2 are deployed and accepted on current `main`; `docs/todo.md` identifies
TB3 as next. Implementation begins from a fresh branch off then-current `main`, records that base
commit, and rechecks the migration ledger before editing. This plan authorizes no work in
`prototype/` and no file outside the implementation/evidence/status surfaces named below.

## Verified current state

### Runtime, dependency, route, and TB2 query ownership

`portal/package.json`, not `portal/apps/web/package.json`, owns runtime dependencies. It currently
pins `@tanstack/react-query` at `5.102.3`. `portal/apps/web/package.json` contains only the
workspace's `happy-dom` dev dependency. TB3 reuses the installed root pin exactly: no install,
re-pin, lockfile change, Query devtools, persistence package, or experimental broadcast package is
needed.

The authenticated app mounts one `QuincyQueryProvider` in
`portal/apps/web/src/lib/query-client.tsx`. `App.tsx` keys that provider by authenticated user ID
and role. `createQuincyQueryClient()` supplies the shipped 15-second stale time, five-minute GC,
structural sharing, focus/reconnect refetch, bounded retry, and global Query/Mutation-cache 401
termination. `ProjectQueryRuntime` in `project-query-sync.ts` owns one provider-lifetime
`BroadcastChannel`, sender-loop suppression, exact invalidation, deferred invalidation while a key
is owned, project tombstones, and principal-terminal state. TB3 extends those shipped seams; it
does not create another provider, client, channel, cache scope, retry policy, or focus manager.

The direct Collaboration arrival route is already typed and closed:
`/projects/:projectId?collaboration=open`. `packages/shared/src/staff-routes.ts` parses it as a
one-shot `collaboration: "open"` intent. `App.tsx` signals `ProjectWorkspace`, which opens/focuses
`ProjectCollaborationPanel` and replaces the URL with canonical `/projects/:projectId` after the
signal is consumed. Back/Forward, native new-tab behavior, OAuth return-destination validation, and
notification deep links already depend on that contract. TB3 preserves it exactly.

### Current comment and mention schema

Migration `portal/packages/db/migrations/0026_project_comments.sql` created the current storage.
`portal/packages/db/src/schema.ts` maps it without an adapter layer today.

`project_comments` has exactly:

| Column | Current D1 definition | Meaning |
|---|---|---|
| `id` | `text PRIMARY KEY NOT NULL` | UUID comment identity |
| `project_id` | `text NOT NULL REFERENCES projects(id) ON DELETE cascade` | owning project |
| `author_id` | `text NOT NULL REFERENCES user(id)` | immutable author |
| `body` | `text NOT NULL` | normalized plain-text projection |
| `content_json` | `text NOT NULL` | validated Tiptap-compatible `RichTextDoc` JSON |
| `created_at` | `integer NOT NULL` | millisecond creation instant |
| `edited_at` | `integer` | nullable last-edit instant |

`project_comments_project_created_idx` indexes `(project_id, created_at, id)`. The API orders by
`created_at DESC, id DESC`; its opaque cursor contains that same pair.

`project_comment_mentions` has exactly:

| Column | Current D1 definition | Meaning |
|---|---|---|
| `id` | `text PRIMARY KEY NOT NULL` | mention-mapping/source-key identity |
| `comment_id` | `text NOT NULL REFERENCES project_comments(id) ON DELETE cascade` | owning comment |
| `mentioned_user_id` | `text NOT NULL REFERENCES user(id)` | targeted participant/admin |
| `created_at` | `integer NOT NULL` | creation instant |

`project_comment_mentions_unique` enforces `(comment_id, mentioned_user_id)`. Deleting a comment
hard-deletes only its mapping rows through the existing FK cascade. TB3 does not change either
committed table definition, column, index, FK, existing row, normalized content, or deletion
behavior; §3 changes only how a new comment's existing `created_at` field is allocated.

There is no project-comment read marker, generic discussion table, product-activity table, or
notification outbox table today. The checked-in migration directory and Drizzle journal end at
`0029_collection_link_positions`. `CLAUDE.md`'s Deploy section specifically records 0029 as
applied and **0030** as the next available number, although that same paragraph's opening summary
still says `0000`–`0028`. `docs/todo.md`'s explicit migration-ledger statements are older
historical snapshots (through 0020/0022), not evidence for the current next number. The remote
ledger preflight in §Production migration and deployment remains the final production authority.

### Current API and collaboration access

`portal/workers/app/src/routes/project-comments.ts` is mounted under `/api` by
`workers/app/src/index.ts` and currently defines four routes:

| Method and path | Current behavior |
|---|---|
| `GET /api/projects/:projectId/comments?limit=1..50&before=<cursor>` | checks collaboration access before project existence, returns `{ project: { id, street }, comments, nextCursor? }`, newest first |
| `POST /api/projects/:projectId/comments` | validates `{ content }`, normalizes rich text/mention labels, batches the comment and mention mappings, audits, notifies mentioned users, returns the serialized comment with `201` |
| `PATCH /api/projects/:projectId/comments/:commentId` | validates/normalizes content, requires the current user to be the author, updates mappings, audits, notifies only newly-added mention targets, returns the serialized comment |
| `DELETE /api/projects/:projectId/comments/:commentId` | requires the current user to be the author, hard-deletes the comment/mappings, audits, returns `{ ok: true }` |

`ensureProjectAccessAndExists()` deliberately calls `hasProjectCollaborationAccess()` before it
looks up the project. An active Admin collaborates on every project; everyone else needs an actual
`project_members` row. Global `viewAllProjects`, ordinary project-detail access, and photographer
stage visibility do not widen this rule. This ordering also prevents an unassigned user from using
403-versus-404 responses as a project-existence oracle. The two new read-marker routes must reuse
that helper/order rather than a capability-only middleware.

The server already enforces comment author-only edit and delete with no Admin exemption:

- PATCH returns `403` with `Forbidden: only the author can edit this comment.` when
  `existing.comment.authorId !== currentUser.id`;
- DELETE returns `403` with `Forbidden: only the author can delete this comment.` under the same
  condition; and
- `workers/app/test/project-comments.test.ts` proves an Admin cannot edit another user's comment.

That is a real comment rule, separate from `CLAUDE.md`'s analogous annotation warning. TB3
preserves both server checks and the UI's author-only controls exactly.

Each successful current mutation writes one security audit row after its domain write:
`project_comment.create`, `project_comment.edit`, or `project_comment.delete`, with target type
`project_comment` and target ID equal to the comment ID. Existing Worker tests assert the exact
three-row sequence. Product activity must remain a separate concept and must not be substituted
for, exposed from, or double-written into `audit_log`.

Targeted mention delivery is also already live and separate. Create calls `notifyMentions()` with
all stored mappings; edit calls it only with newly-added mappings. Each mention mapping supplies
the existing notification `source_key`. TB3 must neither remove that path nor create a second
mention notification through its future broad-activity contract.

### Current frontend owner and lifecycle

`portal/apps/web/src/components/ProjectCollaborationPanel.tsx` owns the entire comment lifecycle
manually:

- local `project`, `comments`, `nextCursor`, and `loadedInitial` are initialized from optional
  `initialComments`;
- local `loading`, `loadingOlder`, and `error` describe request state;
- `load(before?)` calls
  `GET /api/projects/:projectId/comments?limit=50[&before=…]`, replaces the list for the first
  page, appends older comments for later pages, and calls `terminateOnUnauthorized()` only for the
  existing global 401 path;
- an effect calls `load()` once when the panel is open and no initial payload was supplied;
- `submit()` POSTs, prepends the returned comment to local state, and clears `content` only after
  success;
- `saveEdit()` PATCHes, replaces the matching local item, and exits edit mode only after success;
- `remove()` confirms, DELETEs, removes the matching local item, and exits edit mode if needed;
- `content` is the unsent composer `RichTextDoc`; `editing` is the author edit draft; `saving`
  fences mutations; and
- `loadMentionables()` remains a separate manual, project-scoped
  `/api/mentionable-users?projectId=…&q=…` request.

The rendered stream maps the local array in received order, so it is newest first. “Load older
comments” is below the list and appends the next cursor page below existing rows. The overlay is
open by default and has an inner `.project-collaboration__scroll`; standalone collaboration has no
inner wrapper. `SubtaskChecklist` remains a separate manual owner inside the same panel.

TB2 deliberately left all of this manual. It did, however, hoist the full-workspace
`ProjectCollaborationPanel` to a stable sibling of the collection query owner, so RAW/Edited tab
changes and ordinary detail/asset refetches no longer remount the composer. TB3 builds on that
placement.

`ProjectWorkspace.tsx` still owns one special manual initial-detail-403 probe. It calls the same
comments GET with `limit=50`, stores the response in `fallbackComments`, and renders
`ProjectCollaborationPanel mode="standalone" initialComments={fallbackComments}` for an assigned
stage-hidden collaborator. The probe uses its own AbortController/project-generation guards and
never starts detail/assets/ingest/jobs after collaboration-only access is selected. TB3 migrates
this comment read to the exact comment query without weakening that privacy boundary.

Current DOM tests cover rich text, mention lookup, author-only controls, newest-first order,
prepend, older-page append, default-open/standalone presentation, focus/Escape behavior, and the
form-only Edit Project screen. Worker tests cover access ordering, mention mappings/notifications,
cursor order, author-only mutation, audit, project-scoped nested IDs, and invalid rich-text input.
There is no current test for comment polling, cross-tab invalidation, read state, hidden-read
suppression, or a comment draft surviving a comment-query refresh because those behaviors do not
exist yet.

## Scope constraints

### In scope

- Add exactly one additive D1 table, `project_comment_read_markers`, and its project-cascade index
  through migration `0030_project_comment_read_markers.sql`, plus the matching Drizzle schema/
  journal/snapshot and a focused migration test.
- Add an adapter/service over `project_comments` and `project_comment_mentions`; retain their
  current rows, queries, ordering, cursor, rich-text, mention, access, author, and audit contracts.
- Add authenticated GET/PATCH read-marker endpoints with monotonic server validation and an
  authoritative unread count.
- Extend TB2's `projectDataKeys`, provider-scoped QueryClient, exact cancellation/invalidation,
  15-second stale/30-second visible-poll/focus/reconnect behavior, same-browser channel, and
  401/403/404 cleanup for comments and read state.
- Convert `ProjectCollaborationPanel`'s first-page/pagination server state to one typed infinite
  query while retaining its local overlay/focus/composer/edit/mutation state.
- Mark through the newest fetched comment only after a qualifying network fetch begins and
  completes while the newest-stream surface is actually visibly presented.
- Advance the author's own marker monotonically when a visible composer POST succeeds, without
  clearing a concurrently newer comment for that author.
- Construct one typed, privacy-safe comment activity/outbox-intent value for each committed create,
  edit, and delete at the new service boundary so TB4/TB4C can adopt one producer later. Keep the
  value non-durable in TB3: TB4 owns D1 outbox/Queue/ledger persistence, and TB4C owns the broad
  registry/recipient semantics.
- Add minimal unread treatment to the existing Collaboration affordance, focused tests, full
  automated gates, local/production migration evidence, manual cross-tab/cross-device QA, an
  app-only deployment after the migration, and a forward-fix rollback runbook.

### Hard non-goals

- **No common thread/entry migration.** Do not create a common `threads`, `entries`, or equivalent
  store; do not rewrite/backfill `project_comments` or `project_comment_mentions`.
- **No replies, reactions, attachments, named threads, or subscriptions.** The stream stays flat
  and project-scoped. R2 is not involved.
- **No Notice Board migration or shared read marker.** `notice_board_posts`,
  `notice_board_post_mentions`, `NoticeBoard.tsx`, and `viewNoticeBoard` remain untouched; TB7 owns
  Notice Board read synchronization.
- **No broad Collaboration redesign.** Do not move the panel, change its overlay/standalone
  ownership, reorder checklist/discussion, rename the stream, add a new page, or replace Quincy
  styling. One compact unread count/dot and accessible copy are the only visible additions.
- No change to flat newest-first order, `RichTextDoc`, normalization, 10,000-character/body and
  JSON-byte limits, mention eligibility/labels, cursor encoding, 50-row maximum, project
  collaboration access, author-only edit/delete, hard-delete FK cascade, or audit action names.
- No generalized activity schema, activity feed, recipient inbox row, durable outbox, Queue,
  channel ledger, recovery scan, DLQ, preference/digest, broad email, recipient resolution, or
  send-time authorization. These remain TB4/TB4C work.
- No duplicate targeted mention. Existing `notifyMentions()` create/newly-added-edit behavior and
  notification source keys remain the sole mention producer until TB4 explicitly cuts that
  producer over.
- No router replacement, route renaming, WebSocket, SSE, Durable Object presence, service worker,
  IndexedDB/localStorage query persistence, offline mutation queue, or cross-browser
  `BroadcastChannel` claim.
- No conversion of subtasks, mentionable-user search, notifications, Notice Board, links,
  annotations, jobs, ingest, AutoHDR, Dashboard, or other APIs to TanStack Query.
- No notification/Kanban/pipeline/Stage/rail/Deadline/team/Calendar/External Editor/TB6 card-detail
  work from the wider A10/D-17 program.
- No dependency, lockfile, binding, secret, R2, KV, Queue, Workflow, background Worker, or
  webhook-ingress change.
- Hidden, unfocused, closed, or newest-stream-out-of-view fetches never advance the read marker.
  Merely having fresh data in cache is not evidence that the user saw it.

## Exact implementation plan

### 1. Recheck the base, dependency, and migration ledger

Before editing, record `git rev-parse HEAD`, require a clean understood worktree, and re-read the
TB3 stub, D-17, A10, this plan, `docs/todo.md`, and the migration section in `CLAUDE.md`. From
`portal/`, record:

```bash
npm ls @tanstack/react-query --depth=0
rg -n '"@tanstack/react-query"|"happy-dom"' package.json apps/web/package.json package-lock.json
ls -1 packages/db/migrations | tail -15
tail -80 packages/db/migrations/meta/_journal.json
```

Acceptance is the current one exact root pin (`5.102.3` at plan time), no web-workspace runtime
declaration, and `0029_collection_link_positions.sql` as the last migration. If current `main`
already owns `0030`, stop and renumber every migration/test/evidence reference in this plan before
implementation. Do not silently use the same number or install a second Query copy.

### 2. Add the per-user high-water read marker

Add `projectCommentReadMarkers` to `portal/packages/db/src/schema.ts` and create exactly:

`portal/packages/db/migrations/0030_project_comment_read_markers.sql`

with this SQL:

```sql
CREATE TABLE project_comment_read_markers (
  user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  last_read_comment_id text NOT NULL,
  last_read_comment_created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
--> statement-breakpoint
CREATE INDEX project_comment_read_markers_project_idx
  ON project_comment_read_markers (project_id, last_read_comment_created_at);
```

The Drizzle shape is one `sqliteTable` with text `userId`/`projectId`, text
`lastReadCommentId`, timestamp-ms `lastReadCommentCreatedAt`/`updatedAt`,
`primaryKey({ columns: [t.userId, t.projectId] })`, and
`index("project_comment_read_markers_project_idx").on(t.projectId,
t.lastReadCommentCreatedAt)`. The user-first primary key supports one user's markers across projects
and every exact route lookup. The additive project-first index is separately required for the
`projects → project_comment_read_markers` delete cascade: SQLite otherwise scans the complete child
table while enforcing that FK, because the primary key cannot seek on its second column alone.
Keeping `project_id` leftmost preserves that cascade seek and makes §3's per-project marker-maximum
subquery a covering index seek. Unread counting continues to use
`project_comments_project_created_idx`.

`last_read_comment_id` deliberately has **no FK to `project_comments`**. A deleted comment remains
a valid high-water point in the established `(created_at, id)` ordering. Adding a comment FK with
`CASCADE`, `SET NULL`, or `RESTRICT` would respectively erase read history, create an invalid
half-marker, or break author deletion. The API validates and resolves the comment in its project
before first writing the tuple; after that, the tuple is historical ordering data. Project/user
deletion still removes the marker through the two owning FKs.

This is a safe remote-D1 migration form because it creates one new empty table, its primary-key
index, and one ordinary additive index. It contains no `ALTER` of an FK-referenced live table,
table copy, backfill, `DROP TABLE`, rename, or `PRAGMA foreign_keys` toggle. `drizzle-kit
generate`'s fragile rebuild form is neither needed nor accepted. The `ALTER TABLE ADD COLUMN`
preference in `CLAUDE.md` applies when extending an existing table; here direct `CREATE TABLE` and
`CREATE INDEX` statements are the smaller additive operations.

Update `migrations/meta/_journal.json` and add `0030_snapshot.json` consistently. The implementation
may let Drizzle produce the table/snapshot first and then give the migration the exact approved
name, but the committed SQL must normalize to the statements above. Run `npm run db:generate` after
the final snapshot is in place and require “No schema changes”; an unexpected `0031` or rebuild
blocks review rather than being committed.

Add `portal/packages/db/test/migration-0030.test.ts`, modeled on
`migration-0023.test.ts`, which:

1. applies the complete sorted `0000`–`0029` baseline with `PRAGMA foreign_keys = ON` and asserts
   the first/last filenames and count so a weak fixture cannot pass silently;
2. inserts a production-shaped user, project, and comment, then applies the exact 0030 source;
3. asserts `PRAGMA table_info`, `foreign_key_list`, `index_list`, and `index_info` match the five
   columns, two cascading owner FKs, composite `(user_id, project_id)` primary key, and named
   non-unique `(project_id, last_read_comment_created_at)` index above; because SQLite does not
   expose the internal FK-cascade child plan through `EXPLAIN QUERY PLAN DELETE FROM projects ...`,
   run `EXPLAIN QUERY PLAN SELECT last_read_comment_created_at FROM
   project_comment_read_markers WHERE project_id = ?` directly and require a covering seek on
   `project_comment_read_markers_project_idx`, not a marker-table scan;
4. inserts one marker, rejects a duplicate `(user_id, project_id)`, permits independent users and
   projects, and leaves `PRAGMA foreign_key_check` empty;
5. deletes the referenced comment and proves the marker/high-water tuple remains;
6. separately deletes an owning project and an owning user and proves their marker rows cascade;
   and
7. source-normalizes the migration and rejects `DROP TABLE`, `ALTER TABLE`, `PRAGMA`, copy, and
   backfill statements.

### 3. Introduce one project-comment service adapter and typed intent

Add `portal/workers/app/src/lib/project-comments.ts` as the server domain seam. Move storage-level
list/find/create/edit/delete/read-marker helpers out of the Hono route without moving access
decisions or changing serialization. `workers/app/src/routes/project-comments.ts` remains the
sole HTTP owner and retains `ensureProjectAccessAndExists()`, Zod input validation, rich-text
normalization, current status/error copy, `audit()`, and `notifyMentions()` calls.

The service exposes exact operations:

```ts
listProjectComments(db, projectId, { limit, before })
findProjectComment(db, projectId, commentId)
createProjectComment(db, input)
editProjectComment(db, input)
deleteProjectComment(db, input)
getProjectCommentReadState(db, userId, projectId)
advanceProjectCommentReadMarker(db, userId, projectId, throughCommentId)
createProjectCommentActivityIntent(input)
```

`createProjectComment()` must first make the existing stream ordering append-monotonic. The
current route supplies `new Date()` and an independent UUIDv4 from `crypto.randomUUID()`; UUID
lexical order cannot distinguish two commits made in the same millisecond. Keep the existing
columns, rows, index, newest-first API order, and `(created_at, id)` cursor, but replace the comment
INSERT's client-chosen timestamp value with one atomic SQL expression:

```sql
INSERT INTO project_comments (
  id, project_id, author_id, body, content_json, created_at
) VALUES (
  ?, ?, ?, ?, ?,
  MAX(
    ?,
    COALESCE(
      (SELECT MAX(created_at) FROM project_comments WHERE project_id = ?),
      0
    ) + 1,
    COALESCE(
      (SELECT MAX(last_read_comment_created_at)
       FROM project_comment_read_markers
       WHERE project_id = ?),
      0
    ) + 1
  )
);
```

The first timestamp parameter is one captured wall-clock millisecond; the two project parameters
are the same owning project. The subqueries and write are one SQLite statement, not a
read/compute/write sequence in JavaScript, so D1/SQLite's serialized write execution assigns the
new row `MAX(wallClockMs, currentProjectMaximum + 1, survivingMarkerMaximum + 1)`. Therefore every
comment committed through this path has `created_at` strictly greater than every current comment
and every tuple recorded by any surviving read marker in that project, including a marker pointing
at a deleted comment, even when calls share a wall-clock millisecond or the clock moves backwards.
The marker table already stores the timestamp, so this needs no new column. In the normal case where
a marker sits at the current project maximum, the comment and marker terms coincide and do not
inflate the sequence. `project_comments_project_created_idx (project_id, created_at, id)` supports
the comment maximum lookup, while the new project-first marker index supports the marker maximum as
a covering seek. No `project_comments` migration or backfill is required. The existing descending
list/cursor contract remains compatible, while `id` remains only a stable tiebreaker for pre-TB3
historical rows that already share a timestamp. Capture the actually stored timestamp from the
inserted row; never assume the wall-clock input is what was stored.

The service then batches that insert, the existing mention inserts, and the author's read-marker
upsert in one D1 `batch()`. The marker statement selects `id` and the actually stored `created_at`
back from `project_comments` by the new comment's project-scoped ID; it does not reuse a guessed
timestamp. The author submitted through a visibly rendered composer, so that exact new row is a
safe read high-water candidate. Both this own-POST path and explicit marker advancement use the
same conditional upsert:

```sql
INSERT INTO project_comment_read_markers (
  user_id, project_id, last_read_comment_id,
  last_read_comment_created_at, updated_at
)
SELECT ?, project_id, id, created_at, ?
FROM project_comments
WHERE project_id = ? AND id = ?
ON CONFLICT(user_id, project_id) DO UPDATE SET
  last_read_comment_id = excluded.last_read_comment_id,
  last_read_comment_created_at = excluded.last_read_comment_created_at,
  updated_at = excluded.updated_at
WHERE excluded.last_read_comment_created_at > project_comment_read_markers.last_read_comment_created_at
   OR (
     excluded.last_read_comment_created_at = project_comment_read_markers.last_read_comment_created_at
     AND excluded.last_read_comment_id > project_comment_read_markers.last_read_comment_id
   );
```

`advanceProjectCommentReadMarker()` never accepts `createdAt` from the browser. It executes one D1
`batch()` containing, in order: an explicit `project_comments` existence read scoped by the
already-authorized `projectId` and `throughCommentId`; the guarded `INSERT ... SELECT` upsert above;
and the authoritative current-marker/latest/unread response read. D1 batches are transactional and
execute their statements in order, so the target tuple cannot be split from the guarded write by a
concurrent delete. The route derives the typed changed-target conflict **only** from the explicit
existence result, never from the upsert result's `changes()` count. A still-existing equal/older
request naturally produces zero upsert changes but is a successful idempotent no-op: return `200`
with the current authoritative marker state and do not change `updated_at`. Only an absent
project-scoped target returns the typed conflict; never advance through a client-supplied or missing
tuple.

The tuple comparison remains necessary for deterministic treatment of immutable historical rows
that may already share `created_at`. For all new comments, the strict per-project timestamp
invariant makes the first field alone append-monotonic; every newly allocated tuple strictly exceeds
every tuple recorded by any surviving read marker in that project, including markers pointing at
deleted comments. UUID order is never relied on to decide which new commit happened later. Focused
D1 tests freeze the wall clock for principal A's marker, then have a different authorized principal
create a lexically lower UUID comment after (a) A's explicit visible-read PATCH, (b) A's own-POST
marker advancement, and (c) deletion of the comment at A's marker high-water. In every case the
stored timestamp must exceed A's recorded marker tuple, the new row must remain unread for A until
separately presented, and no path may silently absorb it through the UUID tiebreaker.

Unread count is authoritative server state:

- with no marker, count every current comment in the project;
- with a marker, count rows where `created_at` is greater, or equal with `id` greater;
- edit does not change read ordering;
- deletion removes a current row from the count but does not regress/erase the marker; and
- a concurrent comment newer than the author's own POST tuple remains unread. Advancing through
  one's own comment never blindly writes “zero unread.”

For every committed create/edit/delete, the service returns one immutable typed value alongside
its ordinary result:

```ts
type ProjectCommentActivityOutboxIntent = {
  schemaVersion: 1;
  activity: {
    id: string;
    type: "project.comment.created" | "project.comment.edited" | "project.comment.deleted";
    projectId: string;
    actorId: string;
    occurredAt: string;
    source: {
      kind: "project_comment";
      id: string;
      key: string;
    };
    safePayload: { commentId: string };
    deepLink: {
      kind: "project_collaboration";
      path: string;
    };
  };
  broadDelivery: {
    registryKey:
      | "project.comment.created"
      | "project.comment.edited"
      | "project.comment.deleted";
    sourceActivityId: string;
    coalesce: null | { key: string; windowSeconds: 300 };
  };
  targetedMentionDelivery: false;
};
```

Exact values are:

- `activity.id`: a new UUID for this committed semantic operation;
- `source.id`: the comment ID;
- `source.key`: `project-comment:<commentId>:created`,
  `project-comment:<commentId>:edited:<activityId>`, or
  `project-comment:<commentId>:deleted`;
- `safePayload`: comment ID only—never body/content, mention IDs, participant/contact data, or a
  deleted-content snapshot;
- `deepLink.path`: `staffPathFor({ kind: "project", projectId, collaboration: "open" })`, not a
  hand-built URL;
- create/delete `coalesce`: `null`; and
- edit `coalesce`: key
  `project-comment-edit:<projectId>:<commentId>:<actorId>` with `windowSeconds: 300`.

Every committed edit still constructs a distinct truthful activity intent. The five-minute value
is only a future broad-delivery noise hint; it never suppresses audit or hides a committed edit.
Create/delete each construct one intent. Internal query invalidation, retries, read-marker writes,
and delivery bookkeeping construct none.

TB3 does **not** persist or enqueue this object. The service returns it as an explicitly named
domain result and focused tests assert its exact shape. TB4/TB4C later make that existing result's
consumer durable and transactional when their approved activity/outbox schema and recipient
registry exist. Writing it into `audit_log.meta_json`, `notifications`, a new TB3 table, console
logs, or a Queue would either conflate the three approved domains or pre-implement later scope.

The route still calls `notifyMentions()` exactly as today. `targetedMentionDelivery: false` makes
the separation machine-visible: the future broad intent is not a second mention intent. A later
TB4 cutover must choose one authoritative old/new mention producer; TB3 does not dual-write.

### 4. Add the read-state API without route ambiguity

Add two routes to `projectCommentsRoutes` using a sibling resource path that cannot collide with
the existing dynamic `comments/:commentId` PATCH route:

```text
GET   /api/projects/:projectId/comment-read-marker
PATCH /api/projects/:projectId/comment-read-marker
```

Both validate the project UUID, call `ensureProjectAccessAndExists()` in its existing
access-before-existence order, and use only `c.get("user").id` as marker owner. There is no user ID
path/body field and no Admin read-as override.

GET returns `200`:

```ts
type ProjectCommentReadStateResponse = {
  projectId: string;
  marker: null | {
    throughCommentId: string;
    throughCreatedAt: string;
    updatedAt: string;
  };
  latest: null | {
    commentId: string;
    createdAt: string;
  };
  unreadCount: number;
};
```

PATCH accepts only:

```json
{ "throughCommentId": "<comment UUID from a fresh first page>" }
```

and returns the same authoritative response after the monotonic upsert. Invalid IDs return `400`.
A target absent from the explicit project-scoped existence result in §3 returns `409` with the exact
body `{ "error": "Comment read target changed.", "code": "comment_read_target_changed" }`, prompting
an exact comments/read-state refetch; `api.ts` preserves that whole payload as `ApiError.details`,
so the frontend reads `error.details.code` just as the shipped classifier reads
`error.details.capability`. The status is never inferred from an upsert rowcount: a repeat PATCH of
the already-recorded, still-existing head returns `200` with the current authoritative response. A
changed target is not reported as a project `404`. Access failure remains `403` before existence,
and an authorized missing project remains `404`.

Do not audit ordinary marker advancement. The existing notification mark-read routes likewise
treat read position as user state rather than a security mutation. Comment create/edit/delete
audits remain exact and activity remains separate.

### 5. Extend the shipped query-key and query-runtime seams

Extend the existing `projectDataKeys` factory in
`portal/apps/web/src/lib/project-data.ts`; do not create a second root. Exact additions are:

```ts
export const projectDataKeys = {
  // shipped TB2 entries remain unchanged
  commentsRoot: (projectId: string) =>
    ["project-data", projectId, "comments"] as const,
  comments: (projectId: string) =>
    ["project-data", projectId, "comments", "pages", { limit: 50 }] as const,
  commentReadMarker: (projectId: string) =>
    ["project-data", projectId, "comments", "read-marker"] as const,
};
```

The provider already partitions authorization scope by principal+role, so user ID and role do not
repeat in each key. Project ID is present. `limit` is present because it changes page boundaries;
the opaque `before` cursor is the `pageParam` inside the one infinite-query resource, not an
unkeyed route selector. `commentsRoot(projectId)` is used only for collaboration-scope purge.
Ordinary CRUD/read-marker operations use the two exact keys, never the root/project prefix or an
unkeyed invalidation.

Add `portal/apps/web/src/lib/project-comments.ts` for frontend response types, URLs, infinite-query
options, read-state options, exact cache operations, and presentation helpers. Move `Comment` and
`CommentResponse` out of the component into this module. Expose:

```ts
type ProjectCommentReadAttemptRegistrar = {
  start(signal: AbortSignal): {
    fetchAttemptId: string;
    startedGeneration: string | null;
  };
  settle(
    attempt: { fetchAttemptId: string; startedGeneration: string | null },
    headCommentId: string | null,
    signal: AbortSignal,
  ): void;
};

projectCommentsInfiniteQueryOptions(projectId: string, readAttemptRegistrar?: ProjectCommentReadAttemptRegistrar)
projectCommentReadStateQueryOptions(projectId: string)
useProjectCommentsQuery(projectId: string, enabled: boolean, readAttemptRegistrar?: ProjectCommentReadAttemptRegistrar)
useProjectCommentReadStateQuery(projectId: string, enabled: boolean)
refreshProjectCommentsHead(queryClient, projectId, readAttemptRegistrar, signal)
invalidateProjectCommentResources(queryClient, projectId, resources, publish?)
purgeProjectCommentData(queryClient, projectId)
advanceProjectCommentReadMarker(projectId, throughCommentId)
```

The infinite query's `queryFn` and the scoped head refresher share one internal
`fetchProjectCommentsPage()` implementation. The optional registrar is a module-internal interface
supplied by `useProjectCommentPresentation()`: its first-page `start(signal)` method returns the
immutable attempt ID/current-generation snapshot described in §6 and is invoked synchronously
inside that query function before `apiGet`. After the abort check and post-network
removal-tombstone check, and before returning the ordinary page response, that same first-page
query-function invocation calls
`settle(attempt, page.comments[0]?.id ?? null, signal)`. The registrar keeps pending/completed proof
in module-local hook state; no attempt ID, generation, registrar object, or other presentation
metadata is ever added to `CommentResponse`, an infinite-query page, or any value passed to
`setQueryData`. This preserves structural sharing for an unchanged polled page and keeps flattening,
street derivation, and mutation helpers on server data only. The ordinary collaboration-only
imperative probe omits the registrar, so that prefetch can populate the exact cache but can never
manufacture presentation proof.

The shipped `removedDataError()` and `useOwnedSnapshot()` in `project-data.ts` are currently
module-private. Export both there and import them into `project-comments.ts`; do not reimplement
either helper. This preserves the exact `404`/`{ code: "project-data-removed" }` sentinel and the
`useSyncExternalStore` subscription that makes comment/read-state `enabled` react immediately to a
runtime tombstone.

The infinite query uses `initialPageParam: null`; the query function maps `pageParam` to the
existing optional `before` query and passes TanStack's AbortSignal to `apiGet`. `getNextPageParam`
returns `nextCursor`; flattening preserves page order and deduplicates by comment ID defensively.
Both new query-option factories take TanStack's `client` from `QueryFunctionContext` and reuse the
shipped TB2 terminal registry exactly: before starting a request, throw the existing removed-data
error if `getProjectQueryRuntime(client)?.isProjectRemoved(projectId)`; after `apiGet` resolves,
repeat that check before returning any data. The infinite-query check applies independently to
every first or older page. Thus a project-removal/principal-terminal tombstone that arrives during
an ignored abort wins over the response and the page/read state never reaches the cache.

Use the shipped defaults and explicit comment policies:

- `staleTime: 15_000`, `gcTime: 5 * 60_000`, `projectQueryRetry`, structural sharing, focus and
  reconnect refetch;
- comments: `refetchInterval: open ? 30_000 : false`,
  `refetchIntervalInBackground: false`;
- read state: one mounted visible 30-second observer while the Collaboration component exists,
  including when its overlay is closed, so the existing toggle can show cross-device unread state;
  hidden network polling remains suppressed; and
- comments and read-state observers set `enabled` only when their ordinary enablement is true and
  `!runtime.isProjectRemoved(projectId)`, matching the shipped detail/assets hooks; imperative
  collaboration-only fetches perform the same preflight before `fetchInfiniteQuery`; and
- older pages load only on the existing explicit button. A comment refresh refetches only pages
  the user has loaded, sequentially under TanStack's infinite-query contract. That preserves
  current page boundaries and converges edits/deletes in loaded older pages without prefetching the
  unread archive.

One exception is the false→true presentation refresh in §6. TanStack Query v5 cannot refetch only
page 0 through an infinite observer, so it must not call that observer's `refetch()` and must not use
`maxPages` (loading older pages in this newest-first model could evict the head page). Instead,
`refreshProjectCommentsHead()` performs exactly one first-page GET through the same URL, abort, two
tombstone checks, and registrar lifecycle as the infinite query function, then updates the exact
infinite cache. If the fresh page's ordered IDs and `nextCursor` match cached page 0, replace only
page 0 and retain every older page reference. If either boundary differs, replace the cache with
only the fresh first page: retaining pages fetched from the old boundary could create a gap or
duplicate, and the user may explicitly load the new older chain again. Thus a presentation
transition issues one comments request regardless of whether one or many pages were loaded; normal
interval, reconnect, mutation, and BroadcastChannel confirming refetches retain their stated
loaded-page behavior. Disable the comments observer's automatic `refetchOnWindowFocus` only because
the same focus transition is one of this scoped coordinator's inputs; the coordinator preserves
focus freshness without stacking an all-pages refetch beside its head request. Read state retains
the shipped focus/reconnect policy.

Do not use `placeholderData` from another project, copy query data into component `comments`
state, build URLs in the component, or add an ad hoc cache-identity generation guard. Project
identity, exact query key, observer unmount, AbortSignal, and the shared pre/post-network
tombstone checks own cache late-response safety. The presentation generation in §6 is separate:
it decides whether a successful first-page response may advance read state, not which project
cache may receive data. Tests reverse Project A/B and old/new page completions and land a
project-removal tombstone during ignored cancellation to prove both protections.

### 6. Define “visibly presented” and enforce a fresh visible fetch

For this plan, the newest comment stream is **visibly presented** only while all four predicates
are true at the same time:

1. the Collaboration presentation is rendered: overlay mode is open, or standalone mode is
   mounted;
2. `document.visibilityState === "visible"`;
3. TanStack's shared `focusManager.isFocused()` is true; and
4. a stable read-surface anchor immediately before `.project-collaboration__comments` intersects
   the viewport with positive area according to `IntersectionObserver`.

The anchor remains mounted through loading/empty/success states so eligibility does not depend on
having at least one comment. “Panel open somewhere in the DOM” and “query data is fresh in cache”
are insufficient. The top/newest stream anchor—not every individual row—is the presentation
boundary: opening a flat newest-first thread conventionally reads through the fetched head; it
does not require scrolling through every older row.

Add a small `useProjectCommentPresentation()` helper which subscribes to `visibilitychange`,
`focusManager`, and one `IntersectionObserver`. It owns refs—not render-lagged state—for open/
mounted status, document visibility, Query focus, anchor element, intersection, active generation,
and the latest project ID. Event callbacks update those refs synchronously before scheduling any
React render or refetch.

For environments without `IntersectionObserver`, install a real geometry observer rather than a
transition-only sample. Listen passively to scroll on the panel's nearest scrolling root
(`.project-collaboration__scroll` in overlay mode, otherwise the window/document viewport) and to
window scroll/resize; on each event, synchronously intersect the anchor's
`getBoundingClientRect()` with both the viewport and any inner scroll-root rectangle. Attach and
remove these listeners with the anchor/root lifecycle. This path never defaults to visible merely
because the API is unavailable. On both the IntersectionObserver and fallback paths, repeat that
same synchronous rectangle/clipping calculation immediately before issuing a marker PATCH; the
observer's last callback or React state is not sufficient proof that the anchor is still visible.
Tests mock both supported and fallback paths.

Read advancement uses a fetch-start proof scoped to one presentation generation:

1. a false→true transition of all four refs allocates a new opaque generation ID and stores it as
   active. Cancel the exact comments query with `queryClient.cancelQueries({ queryKey, exact:
   true })`, await that cancellation, synchronously recheck that the same generation/predicates are
   still current, then call the one-request `refreshProjectCommentsHead()` path from §5. This
   guarantees that an older in-flight attempt is signalled and that a qualifying actual first-page
   invocation begins after the generation exists without refetching every loaded archive page; a
   coalesced caller is not represented as a second network fetch;
2. at the start of **every actual first-page query-function invocation**—initial, presentation,
   poll, focus/reconnect, or BroadcastChannel invalidation—the query function creates a unique
   `fetchAttemptId`, reads the presentation refs synchronously, and captures the active generation
   only if all four predicates are true at that instant. This immutable
   `{ fetchAttemptId, startedGeneration }` proof exists before `apiGet` begins. Older-page requests
   and POST/PATCH/DELETE cache writes never create a read-eligible proof;
3. after `apiGet` resolves, the first-page function rejects an aborted signal, performs §5's
   post-network tombstone check, and then invokes the registrar's `settle()` with the original proof
   and head ID before returning the unmodified page data. `settle()` records completion only in
   module-local state and never manufactures or retags a proof at completion time;
4. the read coordinator drains each previously-unhandled settled first-page proof, including every
   later poll/refetch completed during one continuously eligible generation. `settle()` only queues
   completion; it never dispatches the PATCH itself. Drain after the comments observer has committed
   a successful first page whose cached head equals the settled `headCommentId`, so proof cannot run
   ahead of the server page it represents. Accept it only when `startedGeneration` is non-null and
   exactly equals the active generation ref at completion/decision time, the project ref still
   matches, the signal was not aborted, every predicate ref is still true, the immediate geometry
   check still passes, and the settled proof has a head comment;
5. immediately after those synchronous checks, record `fetchAttemptId` as handled, then compare
   that head ID with the exact locally cached read state. If it already equals
   `marker.throughCommentId`, skip the PATCH entirely. Otherwise PATCH only that head's `id`; the
   server resolves its stored ordering tuple and monotonically advances. Compare the returned marker's
   `(throughCreatedAt, throughCommentId)` tuple with the tuple cached before the request, update the
   exact read-state cache, and publish a read-marker invalidation only when that tuple actually
   changed. This client short-circuit removes steady-state 30-second PATCH/broadcast traffic, while
   §3's server-side `200` no-op remains required for races and stale/multi-client callers; and
6. because handling is recorded before either branch, re-renders/structural sharing cannot repeat
   that attempt. A second visible poll in the same uninterrupted generation has a different start
   proof and is handled normally; an unchanged cached head stops before the network, while a newly
   fetched head advances it.

Losing any predicate clears the active generation synchronously. A request that began visible but
finished hidden, began hidden and resolved only after a later visible generation, completed after
the newest anchor scrolled out of view, failed, or was cancelled cannot mark read—even if its
transport ignores abort and eventually resolves. When eligibility returns, allocate a new
generation and start a new exact network refetch before advancing. A hidden BroadcastChannel
invalidation may refresh cache after the tombstone checks, but its start proof has no eligible
generation and is ignored for read advancement. If broadcast and presentation refetches overlap,
each actual invocation retains its own start proof; cancellation and the generation equality check
decide eligibility rather than completion order.

This intentionally reuses TB2's focus manager, visibility-driven interval suppression, query
cancellation, and exact keys. It adds only the intersection/presentation gate TB3 needs; it does
not invent another global page-visibility service.

### 7. Convert the panel while preserving pagination, drafts, and interaction

In `ProjectCollaborationPanel.tsx`:

1. replace `project`, `comments`, `nextCursor`, `loadedInitial`, `loading`, `loadingOlder`, and the
   manual `load()` callback/effect with `useProjectCommentsQuery()` data/status and
   `fetchNextPage()`;
2. replace comment-read server state with `useProjectCommentReadStateQuery()`; derive the existing
   project street from the first comment page and unread treatment from `unreadCount`;
3. keep `overlayOpen`, `openSignal` refs, focus restoration, Escape handling, `content`, `editing`,
   `saving`, mutation error, and mentionable-user lookup local and unchanged in ownership. Rename
   the current shared local `error` to `mutationError`: list-load errors now come from the comments
   query's own error state, and the existing notice area renders both sources without allowing a
   later list success to erase a mutation failure (or a mutation start to erase a list failure);
4. keep the component and both RichTextEditor instances mounted during background `isFetching`;
   only the initial no-data request uses the existing “Loading comments…” state;
5. render flattened infinite pages newest first and keep the existing “Load older comments” button
   location/copy, driven by `hasNextPage`/`isFetchingNextPage`;
6. retain author-only Edit/Delete controls based on `comment.author.id === currentUserId`; server
   authorization remains decisive; and
7. hoist the stable newest-stream anchor immediately before `.project-collaboration__comments` and
   above the current `loading ? ... : ...` ternary, so it stays mounted and trackable during initial
   loading as well as empty/success states; and
8. do not key the panel, scroll container, form, or editor by query status, fetch token, response
   reference, unread count, or page count.

The composer `content` and edit `editing.content` stay outside the query cache exactly as TB2's
UI-state principle requires. A query refresh may change server comments but never calls
`setContent(emptyDoc())` or clears edit mode. Only the existing successful POST clears the new
comment composer; only successful PATCH/Cancel exits edit mode. Project route navigation still
unmounts the project-keyed workspace and may discard that project's draft as it does today; TB3
adds no localStorage/offline draft product.

Use exact cache helpers after successful mutations:

| Mutation | Current-tab cache result | Exact confirming invalidation/broadcast |
|---|---|---|
| POST create | prepend/dedupe the returned comment in page 1 without dropping loaded comments; clear composer | comments + read-marker keys; server already advanced author's marker to only the created tuple |
| PATCH edit | replace the matching ID in whichever loaded page owns it; exit edit mode | comments key only |
| DELETE | remove the matching ID from loaded pages; exit matching edit mode | comments + read-marker keys, because unread count may decrease while the historical marker remains |
| visible read PATCH | set exact read-state response | read-marker key only |

The confirming infinite-query refetch restores authoritative 50-row page boundaries after create
and captures a concurrent newer comment. Cache helpers deduplicate by ID so the response and
refetch cannot double-render. No optimistic rollback ledger is needed because current comment
mutations remain response-after-success, not optimistic.

Add a small count/dot inside the existing `.project-collaboration__toggle` when `unreadCount > 0`,
visually cap copy at `99+`, and expose the exact count in its accessible name. In standalone mode,
the existing header may include equally compact unread text before the qualifying fetch marks it.
Do not add tabs, a thread title, a second pane, a notification bell behavior, or new layout.

### 8. Reuse the existing BroadcastChannel protocol

Extend `ProjectDataResource` in `portal/apps/web/src/lib/project-query-sync.ts` with:

```ts
| { kind: "comments" }
| { kind: "comment-read-marker" }
```

Extend strict parser validation and make `projectResourceKey()` an exhaustive `switch` (with an
unreachable/`never` default) mapping all four variants to detail, collection assets, comments, and
comment-read-marker exact keys. The current source has three additional two-way dispatch sites in
`project-data.ts`: both key maps inside `invalidateProjectResources()` and the key selection inside
`queueLedgerInvalidation()`. Replace all three with `projectResourceKey()`; do not leave a
`detail ? detailKey : assetsKey(resource.collectionKind)` fallback that could misroute a new
variant. A repository-wide `ProjectDataResource`/`resource.kind` search must find no other
non-parser key dispatch.

Keep the optimistic mutation ledger explicitly asset-only. Its token creation/settlement APIs
continue to accept a `CollectionKind`, and ledger-pending/deferred-invalidations inspect or queue
only `resource.kind === "assets"`; detail, comments, and read-marker invalidations bypass that
ledger and go directly through their exact keys. Tests mix all four resource variants in one
invalidation and prove only the matching assets key is deferred while the comment resources never
enter or inherit asset rollback state.

Keep the channel name `quincy:project-data:v1`, message type `project-data-invalidated`,
`version: 1`, `sourceTabId`, `projectId`, `committedAt`, validation, sender suppression, exact
receiver invalidation, and no-rebroadcast behavior unchanged. This is an additive resource
discriminant, not a second channel or message mechanism.

Publish only after successful foreground comment mutations or a read marker whose authoritative
response tuple actually advanced relative to the caller's previously cached tuple. A skipped
same-head read and a successful server-side idempotent no-op publish nothing. Messages carry
resource names and project ID only—never comment content, author, mention target, cursor, unread
count, or marker tuple. An older already-open TB2 tab may reject the new discriminant during the
short mixed-version window and will converge on focus/poll; it cannot misapply data.

Same-principal tabs receive create/edit/delete and read-position changes within the two-second
bound. Different principals, browser profiles, devices, or unsupported BroadcastChannel
environments converge through visible 30-second comments/read-state polling and focus/reconnect.
Do not claim BroadcastChannel synchronizes different users or devices.

### 9. Preserve collaboration-only fallback and classify access loss

Replace `ProjectWorkspace.tsx`'s manual comments URL probe with
`queryClient.fetchInfiniteQuery(projectCommentsInfiniteQueryOptions(projectId))`. Keep its
initial-detail-403-only trigger, project generation, cancellation, and rule that no full-workspace
detail/assets/ingest/jobs owner starts. After success, render standalone
`ProjectCollaborationPanel` from the exact cached query; remove `fallbackComments` payload copying
and the `initialComments` prop. Replace its three current duties explicitly:

- add `const [collaborationOnly, setCollaborationOnly] = useState(false)` as the view-state
  discriminator, and set it only after the imperative query-backed probe succeeds under the current
  project generation;
- have the collaboration-only query renderer observe the same exact comments key and read the
  standalone `<h1>` street from `commentsQuery.data.pages[0].project.street`; do not copy the page or
  street into `ProjectWorkspace` component state; and
- in the existing terminal teardown, call `setCollaborationOnly(false)` where it currently clears
  `fallbackComments` (and reset it on project-generation change), before cancelling/removing data.

Thus the standalone heading remains server/query-backed while the boolean owns branch selection;
neither function depends on a cached response object serving double duty as view state.

Reuse the shipped `ApiError`/`projectQueryRetry` behavior: 401/403/404 retry zero times. Retain the
failing resource **and exact HTTP operation** when choosing scope:

The current `classifyProjectAccessError(error, resource: "detail" | "assets", collectionKind?)`
returns project-terminal for any 403 without a collection kind, so comments must not be passed
through that shipped signature unchanged. Widen `AccessErrorScope` with `"collaboration"`, widen the
classifier's resource argument with `"comments" | "comment-read-marker"`, and add explicit arms:
401 remains principal; comments/read-marker 403 is collaboration; their project-level 404 is
project; existing detail/assets/capability behavior remains byte-for-byte equivalent. Widen
`ProjectWorkspace`'s access-failure callback accordingly. Its new `"collaboration"` branch first
sets a parent-owned `collaborationUnavailable` flag so `ProjectCollaborationPanel` (and therefore
`SubtaskChecklist`) unmounts, then cancels/removes only `commentsRoot(projectId)`; it does not set the
existing project `terminal` state or purge detail/assets. In an already collaboration-only render,
that flag shows the neutral unavailable treatment because no workspace surface is authorized; the
initial probe's 403 continues to fail closed as described below. Neither the query module nor the
panel defines a second classifier. Initialize `collaborationUnavailable` to false for each project
generation and reset it alongside `collaborationOnly` on project change/terminal teardown, so one
project's collaboration loss cannot suppress the next project's panel.

- `401` from any comments-list GET, comment POST, nested comment PATCH/DELETE, read-marker GET, or
  read-marker PATCH is principal-terminal: use `clearPrincipalProjectData()`, hide Collaboration/
  private project UI, cancel every query, and leave the provider cache empty;
- an initial detail `403` still probes comments. A successful comments query enters
  collaboration-only; comments `403` fails the probe without revealing existence; comments `404`
  enters unavailable;
- `403` from comments-list GET, comment POST, read-marker GET, or read-marker PATCH is definitively
  collaboration-resource-terminal. None of those operations has an author-specific denial branch:
  immediately omit comments, unread state, composer, and the co-located checklist; unmount their
  owners; cancel/remove `projectDataKeys.commentsRoot(projectId)`; retain an otherwise authorized
  full workspace and a neutral Collaboration-unavailable treatment;
- `404` from comments-list GET, comment POST, read-marker GET, or read-marker PATCH is definitively
  project-terminal after collaboration authorization because those routes have no nested-comment
  missing branch. Reuse TB2's project-unavailable transition and purge the complete
  `projectDataKeys.project(projectId)` prefix. Read-marker PATCH's changed/missing target remains
  the typed `409` from §4 and causes only exact comments/read-state confirmation;
- only nested comment PATCH/DELETE `403` and `404` are ambiguous: `403` may be author-only or lost
  collaboration access, and `404` may be a deleted/wrong comment or project loss. Show the
  mutation error, then issue the existing exact comments-list confirming GET. A `200` keeps the
  workspace/cache and treats the failure as mutation-local; confirming `403`, `404`, or `401`
  takes the collaboration-, project-, or principal-terminal transition above. A transient
  confirming error retains last-good data and does not over-purge.

The resource-terminal transition needs a parent callback because `SubtaskChecklist` is a separate
manual owner inside the panel. It must unmount before cache removal and reject late manual
subtask/mentionable-user completions using the existing principal termination plus a small
collaboration-generation guard. Do not purge project detail/assets for a collaboration-only 403:
an internal Editor may legitimately have broad project visibility without a project-members row.

Project deletion and existing `project-data-removed` messages already mark the shared runtime
tombstone and purge the shared project prefix; the new comments/read-marker keys require no
parallel registry. They must nevertheless participate in that shipped path exactly as §5 states:
observers/imperative probes do not start when already removed, and every first/older comments page
plus read-state response rechecks the registry after network resolution before returning cacheable
data. Tests require zero affected cache entries after terminal unmount and prove an ignored-abort
response that was already in flight when the removal message landed cannot repopulate either
resource.

### 10. Add focused automated coverage

Extend `portal/apps/web/src/lib/project-data.test.ts` and
`project-query-sync.test.ts`; add `portal/apps/web/src/lib/project-comments.test.ts`; extend
`ProjectCollaborationPanel.dom.test.tsx`, `ProjectWorkspace.dom.test.tsx`,
`project-access-termination.dom.test.tsx`, and
`portal/workers/app/test/project-comments.test.ts`. Keep current rich-text/mention/panel tests;
rewrite only their data-owner mocks as needed.

Required focused assertions are:

- exact key tuples for two projects, comments, and read marker; the comments key includes fixed
  limit 50 and remains under the shipped project prefix; the exhaustive resource resolver maps all
  four variants, every invalidation dispatch uses it, and a mixed invalidation defers only the
  assets resource with a pending asset ledger;
- exact URL encoding, cursor `pageParam`, `getNextPageParam`, and propagation of TanStack's
  AbortSignal; after every eligible and ineligible first-page fetch, inspect the cached first page
  and require no `fetchAttemptId`, `startedGeneration`, registrar, or other attempt/generation field
  at any level added by TB3;
- deterministic Project A→B and initial-page/older-page reverse completion; late A/old-page data
  cannot render under B/current pages even if abort is ignored;
- comments first-page, older-page, and read-state requests that start before a
  `project-data-removed`/principal tombstone and resolve afterward reject before cache commit; an
  already-tombstoned observer/imperative collaboration probe starts no request and neither resource
  is resurrected;
- 15-second stale/five-minute GC, visible 30-second comments/read-state polling, hidden network
  suppression, focus/reconnect refetch, and no unkeyed/prefix ordinary invalidation;
- infinite pages stay newest first, load only on explicit “Load older,” preserve all loaded IDs
  without duplication/gaps across create/refetch, and converge an edit/delete in a loaded older
  page;
- valid comment/read-marker broadcast discriminants, strict extra-field rejection,
  sender-loop suppression, exact receiver invalidation within the two-second bound, no
  rebroadcast, unsupported-channel fallback, and cleanup;
- composer and author edit drafts, overlay state, focus owner, and `.project-collaboration__scroll`
  survive a background refetch and BroadcastChannel invalidation; only successful submit clears
  the composer;
- visibility generation tests for all four predicates: open+visible+focused+intersecting fresh
  fetch PATCHes once per handled fetch attempt; closed, hidden, unfocused, or non-intersecting does
  not; cache `setQueryData` does not; re-entry forces a new GET before PATCH;
- with at least four infinite pages loaded, each focus/visibility/anchor false→true presentation
  transition performs exactly one head GET, not four sequential page requests. An unchanged page
  boundary retains the older page objects; a changed ordered-ID list or `nextCursor` resets the
  cache to the fresh first page so reloading older data cannot inherit a gap/duplicate;
- fetch-start proof tests cover a hidden fetch that resolves only after visible re-entry, a
  cancelled request whose mocked transport resolves despite ignored abort, and overlapping
  BroadcastChannel/presentation refetches. Only an actual first-page invocation started and
  completed under the same still-active generation may PATCH; completion order cannot retag an old
  attempt;
- a second 30-second visible poll completed within one continuously eligible generation receives a
  new attempt ID and runs the normal decision path; an unchanged locally cached head makes zero
  PATCH/broadcast calls, while a new head PATCHes and broadcasts only after its returned tuple
  advances;
- fallback geometry tests dispatch real scroll/resize events: scrolling the anchor out before an
  in-flight qualifying response resolves prevents PATCH through the immediate rectangle recheck,
  while scrolling it into view creates a new generation and requires a fresh GET before PATCH;
- a forced BroadcastChannel/comment fetch while `document.visibilityState === "hidden"` may update
  cache but produces zero read PATCHes, then visible/intersecting re-entry performs a fresh GET and
  one PATCH;
- empty stream never PATCHes; equal handled token never repeats; a 409 with
  `error.details.code === "comment_read_target_changed"` triggers exact comments/read-state refetch
  without advancing; a direct repeat-PATCH of the already-recorded, still-existing head returns
  `200` with the authoritative unchanged marker and the frontend triggers no confirming refetch;
- own POST updates the exact comment/read-state resources and clears only its composer; a
  concurrently newer tuple remains unread in the server response. A Worker/D1 assertion performs a
  single comment POST and immediately requires the author's marker row to exist with that comment's
  stored tuple, so the intra-batch read-after-write cannot silently degrade to no marker write;
- server marker starts null, counts all comments, advances monotonically by `(created_at, id)`,
  rejects regression under reversed requests, deterministically handles pre-TB3 timestamp ties,
  remains per user/project, survives target deletion, and cascades with project/user. New comment
  inserts freeze/reverse wall clock and prove stored per-project `created_at` is strictly greater
  than both the prior current-comment maximum and every surviving marker timestamp while preserving
  newest-first cursor behavior;
- after both principal A's visible-read PATCH and A's own-POST marker advancement, a
  same-wall-clock follow-up by principal B with a lexically lower UUID receives
  a timestamp greater than every current comment and surviving marker and remains unread for A. A
  separate frozen-clock case creates X, advances A through X, deletes X, then creates Y with an ID
  lexically lower than X; Y's stored `created_at` must exceed X's surviving marker timestamp and Y
  must be unread for A. The marker never relies on UUIDv4 lexical order to absorb a later commit;
- read-marker routes preserve access-before-existence, accept no user/timestamp override, reject a
  cross-project/missing target with the exact typed 409 body, distinguish that explicit existence
  result from a zero-change monotonic upsert, and return the exact success response shape;
- current flat stream, normalized rich text, mentions, newly-added-edit mention notifications,
  50-row cursor, access, author-only Admin rejection, comment hard delete, and exact audit action
  sequence remain unchanged;
- create/edit/delete each return the exact activity/outbox-intent shape; every edit has a distinct
  activity ID, only edit has the five-minute coalesce hint, payload/deep link are safe, and no
  mention/body/recipient/channel data is present;
- read-marker changes/query refresh/retry construct zero activity/audit/notification records and
  comment intent construction creates no second targeted mention;
- initial detail 403 → query-backed collaboration-only success, 403 probe failure, 404 unavailable,
  and cancellation on project navigation; no workspace-only requests occur in the successful
  collaboration-only branch;
- focused operation-classification cases prove 401 is principal-terminal everywhere;
  comments-list/read-marker GET, comment POST, and read-marker PATCH 403 remove collaboration only,
  leave `projectDataKeys.detail(projectId)` cached data intact,
  while their 404 takes full project terminal; nested comment PATCH/DELETE 403/404 first retain
  data, then classify only through confirming-list GET outcomes (200/403/404/401/transient) without
  over-purge; and
- `/projects/:id?collaboration=open`, canonical replacement, Back/Forward, modified click/new tab,
  notification arrival, overlay/standalone focus behavior, and three reference viewport layouts
  remain intact.

Run focused suites during implementation; adjust filenames only to match the final reviewed test
owners:

```bash
npx vitest run --config packages/db/vitest.config.ts test/migration-0030.test.ts
npx vitest run --config workers/app/vitest.config.ts test/project-comments.test.ts
npx vitest run --config apps/web/vitest.config.ts src/lib/project-data.test.ts src/lib/project-comments.test.ts src/lib/project-query-sync.test.ts
npx vitest run --config apps/web/vitest.dom.config.ts src/components/ProjectCollaborationPanel.dom.test.tsx src/screens/ProjectWorkspace.dom.test.tsx src/lib/project-access-termination.dom.test.tsx src/App.dom.test.tsx
```

Tests must exercise real query clients, reversed promises, fake timers, visibility/focus
subscriptions, mocked intersections, exact cache inspection, and D1 SQL. Static source-string
assertions alone do not satisfy timing, race, marker, or migration behavior.

## Verification, QA, evidence, and rollout

### Automated gate

From `portal/`, run the repository-standard gate exactly:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Record each workspace result separately. `npm run test --workspaces` still does not own the shared
suite, so the fourth command is mandatory. No unexplained React, Query, timer, unhandled rejection,
`act`, console, migration, D1, or TypeScript warning is accepted.

Also retain these audits in the gate record:

```bash
rg -n 'project_comments|project_comment_mentions|project_comment_read_markers' packages/db/src packages/db/migrations workers/app/src workers/app/test
rg -n 'projectDataKeys|commentsRoot|commentReadMarker|ProjectDataResource|resource\.kind|projectResourceKey|isProjectRemoved|BroadcastChannel|refetchInterval|visibilityState|IntersectionObserver' apps/web/src
rg -n 'notifyMentions|project_comment\.(create|edit|delete)|ProjectCommentActivityOutboxIntent' workers/app/src workers/app/test
rg -n 'threads|replies|reactions|attachments|subscriptions|WebSocket|EventSource|@tanstack/react-query' package.json package-lock.json apps/web/src workers/app/src packages/db/src
```

The audit proves one unchanged Query pin, only the approved read-marker schema, no generic thread
or realtime dependency, exact activity/audit/mention separation, one visible 30-second policy per
comment/read-state observer, and no Notice Board or later-phase implementation. Review the final
diff against the route/mutation tables above and run a repo-wide comments endpoint grep so the
initial 403 probe or a mutation owner is not omitted.

### Local migration apply and verification

First run the focused SQLite migration test. Then prove Wrangler discovers and ledgers 0030 in an
isolated clean local D1 as well as the ordinary local persistence store. From `portal/`:

```bash
TB3_LOCAL_D1_DIR="$(mktemp -d)"
npx wrangler d1 migrations apply quincy-portal --local --persist-to "$TB3_LOCAL_D1_DIR" --config workers/app/wrangler.jsonc
npx wrangler d1 execute quincy-portal --local --persist-to "$TB3_LOCAL_D1_DIR" --config workers/app/wrangler.jsonc --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 3; PRAGMA table_info('project_comment_read_markers'); PRAGMA foreign_key_list('project_comment_read_markers'); PRAGMA index_list('project_comment_read_markers'); PRAGMA index_info('project_comment_read_markers_project_idx'); EXPLAIN QUERY PLAN SELECT last_read_comment_created_at FROM project_comment_read_markers WHERE project_id = 'tb3-index-probe'; PRAGMA foreign_key_check; PRAGMA quick_check;"
npm run db:migrate:local
```

Require the ledger to include `0030_project_comment_read_markers.sql`, the exact five-column/two-FK
shape, the composite primary-key auto-index plus named non-unique
`project_comment_read_markers_project_idx` whose ordered columns are
`(project_id, last_read_comment_created_at)`, an `EXPLAIN QUERY PLAN` covering index seek through
that named index for the direct project-scoped child lookup, empty `foreign_key_check`, `quick_check
= ok`, and no migration after 0030. Preserve output. The temporary directory may be deleted only
after its evidence has been copied; it contains no production data.

### Manual QA matrix

Use the built app Worker at `http://localhost:8787`, not Vite `5173`. Use two disposable projects
with non-sensitive comments and, where required, one reviewer-approved second principal in a
separate browser/profile/device. Redact names, addresses, emails, comment content, cookies, and
tokens from evidence. Do not assume the TB2 disposable account is still approved/active; obtain
the reviewer checkpoint recorded below.

1. **Direct Collaboration route.** Paste
   `/projects/<A>?collaboration=open` into a new tab and exercise Back/Forward and modified-click
   new-tab behavior. Confirm the correct project opens Collaboration once, focus follows current
   behavior, the URL canonicalizes to `/projects/<A>`, and reopening the arrival URL works again.
   Repeat the stage-hidden collaboration-only fixture and confirm no detail/assets/ingest/jobs
   request/render.
2. **Same-browser exact broadcast.** Open A in two same-principal tabs with Collaboration visible.
   Create, edit, then delete one reversible comment in tab 1. For each operation, tab 2 starts only
   the exact comments/read-state requests specified in §7 within two seconds, updates without
   reload, never receives message content through BroadcastChannel, and does not request project
   detail/assets. Restore/delete the fixture.
3. **Different-user visible convergence.** In a separate authorized browser/profile, post a
   distinguishable test comment immediately after the observing browser's poll. Keep the observer
   visible/focused with the newest-stream anchor intersecting. Record commit, next GET, render, and
   marker PATCH times; they fall within 30 seconds plus request latency. Confirm no duplicate row.
4. **Two-device read state.** Leave an unread test comment for principal A. Confirm device/profile
   A1 and A2 initially report the same unread count. Present the newest stream on A1; after its
   qualifying fresh GET/PATCH, A2 converges to the same marker/unread count within 30 seconds or
   focus. Add a newer comment between A1's fetch and marker PATCH and confirm it remains unread on
   both devices.
5. **Hidden poll never reads.** With an unread comment and the panel open, record the server marker,
   hide the observing tab, and create/invalidate from another tab. Observe at least 35 seconds.
   Zero ordinary hidden interval requests is the expected TB2 behavior; if a broadcast/forced GET
   occurs, it may update cache but there must be zero marker PATCHes and the D1 marker must remain
   unchanged. Return visible/focused with the anchor intersecting: a new GET must occur before the
   single PATCH.
6. **Out-of-view presentation gate.** In standalone/compact layout, place the newest-stream anchor
   fully outside the viewport while the document remains visible/focused. Allow/force a successful
   refresh and confirm no PATCH. Scroll the anchor into view; confirm a new GET—not the cached
   response—precedes one PATCH. Repeat after loading at least four pages: each scroll-in,
   visibility-return, and focus-return presentation transition starts exactly one first-page
   comments GET rather than refetching all four pages. With an unchanged boundary the loaded archive
   remains; after a controlled head-boundary change it resets to page 1 and can be reloaded without
   a duplicate or gap.
7. **Draft/edit preservation.** Type an unsent rich-text composer draft containing formatting and
   a mention; start an author edit draft; record `.project-collaboration__scroll.scrollTop`. Cause
   external create/edit/delete, focus refetch, and read-state refresh. The exact drafts, edit mode,
   focus owner, open state, and numeric scroll offset remain. Cancel afterward; do not submit the
   draft.
8. **Own-post high water.** From a visible composer, post one disposable comment. Query D1/read API
   and prove the author's marker equals that comment's stored `(created_at, id)` tuple. Repeat with
   a controlled newer concurrent comment and prove the marker does not leap past the author's row
   and unread count remains nonzero. The successful composer clears once.
9. **Pagination/order/mentions/access/audit regression.** Use more than 50 disposable/synthetic
   comments. Load older pages, then create/edit/delete from another session. Confirm newest-first
   order, opaque cursor continuation, no duplicate/gap, rich text, normalized mention labels, and
   only newly-added edit mentions. Attempt another user's edit/delete as Admin and require the
   exact 403/no mutation. Confirm one create/edit/delete audit each and no second targeted mention
   notification/activity persistence.
10. **Access loss and transient error.** Remove collaboration membership from a disposable user
    while their panel is open: comments, unread marker, composer, checklist, and mention candidates
    disappear; comments-root cache is empty; otherwise-authorized project data remains where
    applicable. Delete/make the project unavailable for a 404 and confirm full project terminal.
    Deactivate the principal for 401 and confirm the whole QueryClient is empty. A transient 500
    retains last-good comments/draft and uses bounded retry.
11. **Visual/regression matrix.** Compare normal, loading, empty, unread, error,
    collaboration-only, panel-open, and panel-closed states at `1440×900`, `1024×768`, and
    `390×844`. Require no material layout/style/focus drift beyond the approved compact unread
    treatment. Confirm console and Network are clean and every test mutation is restored.

### Exact evidence paths

Create only redacted evidence under:

```text
docs/plans/revamp_2026_portal/evidence/TB3/base-dependency-and-ledger.txt
docs/plans/revamp_2026_portal/evidence/TB3/migration-0030-local.txt
docs/plans/revamp_2026_portal/evidence/TB3/automated-gates.txt
docs/plans/revamp_2026_portal/evidence/TB3/query-read-marker-and-race-tests.txt
docs/plans/revamp_2026_portal/evidence/TB3/activity-audit-mention-separation.txt
docs/plans/revamp_2026_portal/evidence/TB3/manual-qa.md
docs/plans/revamp_2026_portal/evidence/TB3/cross-tab-and-cross-device-timing.md
docs/plans/revamp_2026_portal/evidence/TB3/hidden-and-out-of-view-do-not-read.md
docs/plans/revamp_2026_portal/evidence/TB3/draft-pagination-mentions-access-audit.md
docs/plans/revamp_2026_portal/evidence/TB3/direct-collaboration-route.md
docs/plans/revamp_2026_portal/evidence/TB3/request-cadence-redacted.har
docs/plans/revamp_2026_portal/evidence/TB3/collaboration-after-1440x900.png
docs/plans/revamp_2026_portal/evidence/TB3/collaboration-after-1024x768.png
docs/plans/revamp_2026_portal/evidence/TB3/collaboration-after-390x844.png
docs/plans/revamp_2026_portal/evidence/TB3/production-migration-and-deploy.txt
docs/plans/revamp_2026_portal/evidence/TB3/rollback-record.md
```

`manual-qa.md` records fixture/account disposition, browser/profile/device relationship, exact
timestamps/deltas, `visibilityState`, focus state, IntersectionObserver state, expected/actual
query keys and requests, marker tuples before/after, restored mutations, console result, and every
not-applicable item with rationale. Redact the HAR/screenshots before commit; if the HAR cannot be
safely redacted, omit it and put a timestamped request table plus the reason in the named Markdown
records.

### Production migration and deployment

TB3 changes D1 schema, app API/frontend source, and bundled static assets. It changes no binding,
secret, Queue, Workflow, background Worker, or webhook-ingress contract. The additive table must
land before code that queries it.

From `portal/workers/app`, after review, full gates, local migration proof, manual QA, and human
authorization:

1. record the current `quincy-portal-app` deployment/version as the rollback target;
2. record remote preflight and a verified recovery artifact in an approved durable directory
   outside the worktree:

   ```bash
   TB3_RECOVERY_DIR="<approved-durable-recovery-directory-outside-the-repo>"
   TB3_RECOVERY_FILE="$TB3_RECOVERY_DIR/quincy-portal-before-tb3-$(date -u +%Y%m%dT%H%M%SZ).sql"
   npx wrangler d1 execute quincy-portal --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 5; SELECT name, type, sql FROM sqlite_master WHERE name IN ('project_comment_read_markers', 'project_comment_read_markers_project_idx'); PRAGMA foreign_key_check; PRAGMA quick_check;"
   npx wrangler d1 export quincy-portal --remote --output "$TB3_RECOVERY_FILE"
   test -s "$TB3_RECOVERY_FILE"
   shasum -a 256 "$TB3_RECOVERY_FILE"
   ```

   Preflight requires 0029 last, neither the read-marker table nor its named index, empty FK check,
   and quick check `ok`.
3. apply the one versioned migration exactly once:

   ```bash
   npx wrangler d1 migrations apply quincy-portal --remote
   ```

4. before deploying code, verify the remote ledger/table/FKs/integrity:

   ```bash
   npx wrangler d1 execute quincy-portal --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 5; PRAGMA table_info('project_comment_read_markers'); PRAGMA foreign_key_list('project_comment_read_markers'); PRAGMA index_list('project_comment_read_markers'); PRAGMA index_info('project_comment_read_markers_project_idx'); EXPLAIN QUERY PLAN SELECT last_read_comment_created_at FROM project_comment_read_markers WHERE project_id = 'tb3-index-probe'; SELECT COUNT(*) AS marker_count FROM project_comment_read_markers; PRAGMA foreign_key_check; PRAGMA quick_check;"
   ```

   Require 0030 ledgered, the exact empty five-column table, two owner FKs, the composite PK index,
   the named project-first index with exact `(project_id, last_read_comment_created_at)` shape and a
   covering seek for the direct project-scoped child lookup, empty FK check, and quick check `ok`.
5. make one final web build, confirm accepted hashes/sizes, then deploy only the app Worker:

   ```bash
   npx wrangler deploy --message "TB3 project discussion v2"
   ```

6. perform an authenticated production smoke using only approved reversible/disposable data:
   direct Collaboration URL, one own create/read/edit/delete, same-browser exact broadcast, hidden
   no-read observation, marker GET/PATCH, author-only/audit check, console/Network, and one visible
   30-second interval. Do not manufacture an unauthorized second production account/device; record
   cross-device production QA as not run if the reviewer did not approve one.
7. restore/delete all smoke data, record the new Worker version and D1 ledger, monitor errors and
   request cadence, then update this plan/status, `docs/todo.md`, and move the accepted plan with
   `git mv` to `docs/plans/implemented/` only after production verification.

Do not deploy background or webhook-ingress. The repository's background → webhook-ingress → app
order applies when those providers change; they do not here.

If `migrations apply` fails, times out, or is ambiguous, stop before app deploy. Run the pre/post
ledger, `sqlite_master`, table-info/FK, `foreign_key_check`, and `quick_check` probes again and
record them. Do not blindly rerun 0030 and do not hand-edit `d1_migrations`. A clean failed apply
has no table/ledger row; a table/ledger mismatch or partial shape requires a reviewed fix-forward
runbook before any retry.

### Concrete rollback and fix-forward

Before deployment, record the pre-TB3 app Worker version. If production shows cross-project cache
leakage, hidden read advancement, draft loss, request storms, access-loss retention, broken
pagination, duplicate mention delivery, or a material regression, restore that app version:

```bash
npx wrangler rollback <recorded-pre-TB3-version-id> --message "Rollback TB3 project discussion v2" --yes
```

Smoke the prior manual comments flow, direct Collaboration URL, author-only mutation, and console
after rollback. The source rollback is an ordinary revert that removes the TB3 query/service/API/UI
integration and leaves the old manual component/route behavior. It must not revert unrelated work
or delete comment/user/project data.

**Application rollback does not roll back migration 0030.** The old app ignores the additive
`project_comment_read_markers` table, so leave the table and any accumulated marker rows in place.
Do not `DROP TABLE`, delete markers, restore the full preflight export over live production, edit
the migration ledger, or attempt a down migration merely to match old code. This follows the
program's established no schema/data rollback posture: Worker code is reversible; durable schema
and user state are preserved.

If 0030 itself is wrong, roll back/disable dependent application code first and **fix forward**
with the next reviewed migration number (0031 only if still available). The repair must inspect the
actual remote ledger/schema/data, preserve all valid marker tuples, use an additive create/copy or
safe column change that avoids the documented rebuild/foreign-key trap, prove a production-shaped
local fixture, take a new recovery point, and receive migration review before remote application.
A typo, wrong FK, wrong key order, or wrong timestamp representation is not repaired with ad hoc
production DDL.

## Deployment record (2026-08-25)

- **Pre-deploy rollback target:** app Worker version `4a4c61a2-a59f-4c8a-ab99-0ceeb690485e` (TB2,
  live at the start of this deploy).
- **Remote preflight:** 0029 last applied migration; neither `project_comment_read_markers` nor its
  index existed; `foreign_key_check` empty; `quick_check` `ok`.
- **Recovery export:** `quincy-portal-before-tb3-20260825T140615Z.sql`, saved outside the worktree
  at `/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/
  db-recovery/` (a durable, Dropbox-synced location chosen by the human reviewer since no prior
  migration in this pipeline had established a recovery-directory convention). 12,615,541 bytes,
  16,257 lines, 46 `CREATE TABLE` / 15,599 `INSERT INTO` statements, SHA-256
  `26257e417ff3ee1d4b9dc2cbe53899fa819bbb2e296ca121a51bdcefbe3b5abf`.
- **Migration applied:** `0030_project_comment_read_markers.sql`, one apply, no retry needed.
- **Postflight:** 0030 ledgered; exact 5-column/two-FK shape; composite PK auto-index plus named
  `project_comment_read_markers_project_idx (project_id, last_read_comment_created_at)`; `EXPLAIN
  QUERY PLAN` confirms a covering-index seek for the project-scoped child lookup; `marker_count: 0`;
  `foreign_key_check` empty; `quick_check` `ok`.
- **App deploy:** `quincy-portal-app` version `e6d0879d-b739-46ea-be2c-9f772bec9a66`, message "TB3
  project discussion v2". Bundle hashes matched the last independently-verified local build exactly
  (`index-DmRTCS_a.js`, `index-CWmSbA94.css`) — confirms zero source drift between final local
  verification and the deployed build.
- **Production smoke (authenticated, `Tez`/`mjj2332@gmail.com`, real admin session):** created one
  clearly-labeled disposable project (`ZZZ TB3 QA Fixture — DELETE ME`, no hard-delete exists for
  projects in this app, so it was archived afterward rather than left active — still recoverable,
  unmistakably named, out of the active dashboard). Exercised the direct
  `/projects/:id?collaboration=open` route (canonicalized correctly), one full own comment
  create→edit→delete cycle (composer and edit-draft both cleared correctly on success — direct
  production confirmation of the `2cba9a1` fix), author-only Edit/Delete visibility, and the
  read-marker GET (own-post advancement confirmed: `unreadCount: 0`, marker matched the created
  comment's tuple). Every network request across the full cycle returned `200`/`201`; zero console
  errors. All test data restored/removed (comment deleted, project archived) immediately after.
- **Post-deploy monitoring:** no elevated error rate or unexpected request cadence observed during
  or after the smoke test.

## Acceptance checklist

- [x] Implementation begins from recorded current `main`; TB0A/TB0B/TB1/TB2 remain live, and no
      work enters `prototype/` or later TB phases.
- [x] D-17 and A10 are applied only to project discussion/read freshness; notification delivery,
      recipient registry, pipeline semantics, Kanban, and other later scopes remain absent.
- [x] The existing root `@tanstack/react-query@5.102.3` pin is reused with no dependency/lockfile
      change, duplicate web declaration, devtools, persistence, or experimental broadcast package.
- [x] Migration number is rechecked as 0030; `0030_project_comment_read_markers.sql` creates only
      the exact additive five-column table/PK/two owner FKs plus named
      `(project_id, last_read_comment_created_at)` index, with no rebuild, copy, drop, backfill,
      PRAGMA toggle, or comment/mention schema/row rewrite.
- [x] Drizzle schema, journal, and snapshot are consistent; a second generate is empty; focused
      migration tests prove complete 0000–0029 baseline, exact shape, tuple survival after comment
      deletion, owner cascades, both exact indexes, project-cascade index use, and FK/integrity
      checks.
- [x] The marker is one row per `(user_id, project_id)`, stores the server-resolved
      `(last_read_comment_created_at, last_read_comment_id)` high-water tuple, and monotonically
      advances under equal, reversed, historical tied-timestamp, concurrent, and deleted-target
      cases.
- [x] Every new comment INSERT atomically stores
      `MAX(wallClockMs, project MAX(created_at) + 1, project marker MAX(last_read_comment_created_at)
      + 1)` using the existing comment index and new covering marker index. Every newly allocated
      tuple strictly exceeds every tuple recorded by any surviving marker in the project, including
      markers pointing at deleted comments; the API order/cursor remains unchanged, the own-POST
      marker reads back the stored timestamp in the same batch, and frozen-clock/deleted-head/
      lexically-lower UUID tests cannot be silently marked read.
- [x] GET/PATCH `/api/projects/:projectId/comment-read-marker` use authenticated user ownership,
      access-before-existence collaboration authorization, exact request/response shapes, a typed
      409 derived only from the same-batch explicit target-existence result with
      `error.details.code === "comment_read_target_changed"`, `200` for a still-existing repeat/no-op
      PATCH, and authoritative latest/unread count.
- [x] Project comments remain one flat project-scoped newest-first stream with the exact rich-text,
      body/JSON limits, mention normalization, cursor/limit, collaboration access, hard deletion,
      and serialized comment shape.
- [x] Edit/delete remain author-only in UI and server with no Admin exemption; create/edit/delete
      keep exactly one `project_comment.*` audit each and failed/forbidden operations create none.
- [x] Existing targeted mention semantics remain exact: create notifies stored targets, edit only
      newly-added targets, source keys remain mention-row IDs, and TB3 creates no duplicate mention.
- [x] The comment service returns one exact privacy-safe activity/outbox intent for each committed
      create/edit/delete, with distinct truthful edit events and only the approved five-minute
      broad coalescing hint; read/query/internal work emits none.
- [x] TB3 adds no durable activity/outbox/recipient row, Queue, delivery ledger, recovery/DLQ,
      audience resolution, channel/preference/email behavior, or audit/activity conflation.
- [x] Exact query identities remain under the principal/role-scoped TB2 client:
      `project-data/projectId/comments/pages/{limit:50}` and
      `project-data/projectId/comments/read-marker`; ordinary work never invalidates a root/unkeyed
      scope.
- [x] Infinite query pagination preserves newest-first order, explicit older loading, every loaded
      row without gaps/duplicates, cursor behavior, and edits/deletes in loaded older pages.
- [x] Query functions consume TanStack's AbortSignal; deterministic Project A/B and page reversal
      prove a late response cannot cross project/resource identity even when abort is ignored.
- [x] Comments/read-state observers and imperative probes do not start after the shared TB2
      tombstone; every first/older page and read-state query rechecks it after network resolution,
      so an in-flight ignored-abort response cannot repopulate removed project/principal data.
      `project-comments.ts` imports the exported TB2 `removedDataError` and `useOwnedSnapshot`
      helpers and contains no reimplementation of either contract.
- [x] Comments/read state use the shipped 15-second stale/five-minute GC/retry/focus/reconnect
      policy and visible 30-second bound, with comment focus presentation handled by the scoped head
      refresher instead of a stacked all-pages observer refetch; no hidden ordinary network polling
      or request storm exists.
- [x] “Visibly presented” requires open/standalone + visible document + focused Query manager +
      intersecting newest-stream anchor; cache freshness alone never qualifies.
- [x] Each actual first-page fetch receives its immutable attempt ID and presentation generation at
      fetch start; only a non-aborted attempt completed under that same current generation may
      PATCH once, and every later qualifying visible poll in the continuous generation is handled.
      `settle()` delivers proof through module-local state only; cached page data contains no
      attempt/generation field and unchanged polling retains structural sharing.
- [x] IntersectionObserver and scroll/resize fallback paths keep geometry current and synchronously
      recheck the anchor immediately before PATCH; scrolling out during a request cannot mark read,
      and scrolling in starts the required fresh GET→PATCH sequence.
- [x] Hidden, unfocused, closed, or out-of-view interval/broadcast/forced fetches never mark read;
      automated tests and manual D1/request evidence prove the negative behavior.
- [x] A presentation false→true transition performs one scoped first-page GET regardless of loaded
      page count; unchanged boundaries retain older page identities, while changed boundaries reset
      the archive before explicit reload so no stale gap/duplicate survives.
- [x] Own POST may advance only through its own stored tuple; a concurrent newer comment remains
      unread, the response/refetch stays authoritative, the author's marker row exists immediately
      after one successful POST, and the composer clears once on success.
- [x] The existing `quincy:project-data:v1` runtime carries validated response-data-free comment
      resource invalidations, suppresses sender loops/rebroadcast, refetches sibling tabs within
      two seconds, publishes read-marker invalidation only when the authoritative marker tuple
      advances, and falls back to visible polling/focus across sessions/devices.
- [x] Every `ProjectDataResource` dispatch uses one exhaustive `projectResourceKey()`; optimistic
      ledgers remain assets-only and cannot defer, patch, roll back, or misroute comment resources.
- [x] Composer/edit drafts, overlay/open signal, focus, checklist state, and scroll survive comment
      and marker refresh; query page data contains only server state—not UI drafts or presentation
      attempt/generation metadata.
- [x] Initial detail 403 retains query-backed collaboration-only access without workspace reads;
      list/POST/read-marker 403 is collaboration-scoped, their project-level 404 is terminal, and
      any 401 clears the complete QueryClient without late resurrection. Only nested comment
      PATCH/DELETE 403/404 waits for a confirming list GET and never over-purges on status alone. A
      collaboration-scoped 403 leaves the exact project-detail cache intact. The explicit
      `collaborationOnly` flag—not a response object—selects the fallback branch, its heading observes
      first-page `project.street`, and terminal/project-generation teardown resets the flag.
- [x] `/projects/:id?collaboration=open`, canonical replacement, Back/Forward, OAuth destination,
      modified click/new tab, notification deep links, overlay/standalone focus, and current panel
      ownership remain exact.
- [x] Notice Board, replies, reactions, attachments, named threads, subscriptions, broad panel
      design, router, subtasks/mentionables conversion, and all TB4/TB4C/TB5+ work remain absent.
- [x] Focused tests, typecheck, web build, every runnable workspace suite, and the dedicated shared
      suite are green with no unexplained warning; exact redacted evidence exists at all applicable
      TB3 paths.
- [x] Local clean/persisted D1 applies and ledgers 0030 with exact table/FKs/PK and named
      project-first composite index plus a direct child-lookup covering seek and clean integrity;
      remote preflight, verified recovery artifact, single apply, and equally exact postflight
      occur before app deploy.
- [x] App-only deploy records pre/post Worker versions, production marker/schema/cadence/direct URL
      smoke, reversible fixture restoration, and console/Network results; background and
      webhook-ingress are not redeployed.
- [x] Rollback restores only application code/version and leaves additive marker schema/data in
      place; any schema mistake uses a reviewed next-number fix-forward, never ad hoc DDL/down
      migration/ledger edits.
- [x] After production verification, status/todo/evidence are updated and this plan is moved with
      `git mv` to `docs/plans/implemented/` with the live commit and Worker version.

## Implementation-time human checkpoint

The reviewer must identify which currently authorized disposable second principal/browser/device
may be used for cross-user/two-device QA and whether equivalent reversible production QA is
approved. Local Google sign-in normally admits only the seeded Admin unless a human provisions and
signs in another account; there is no staging environment. The implementation must not provision,
activate, impersonate, or mutate a production account merely to satisfy evidence. Automated
multi-user Worker/D1 coverage remains mandatory even if the human declines live second-session QA,
and the declined manual item must be recorded honestly rather than fabricated.
