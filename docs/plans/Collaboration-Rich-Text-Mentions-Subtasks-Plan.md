# Collaboration Rich Text, Mentions, and Subtasks — Plan

> **Status: Phase 1 implemented, reviewed, and deployed to production 2026-08-17 (commit
> `df4844e`, migration `0025_collaboration_rich_text_notice_mentions.sql`). Phases 2 and 3 not
> started — this plan stays in `docs/plans/` until all three phases ship.**
> Planning history: Terra draft → two Terra self-review rounds → two independent Opus plan-tier
> reviews, each reverted to Terra for revision (reverts 1 and 2 of at most 2, exhausted) → a third
> Opus review that found 5 required and 2 optional wording-level issues, resolved by a direct Opus
> self-edit (the terminal case in
> [`docs/Subagent-Orchestration.md`](../Subagent-Orchestration.md) §2 policy 1/4) → a final, fresh
> Opus self-review approved that edit on 2026-08-16.
>
> **Phase 1 build history:** Terra build → a fresh Terra diff review found and a fix pass resolved
> 3 issues (a missing `drizzle-kit` migration snapshot, a mention-autocomplete accessibility bug,
> missing required test coverage) → a Terra final pass approved → an Opus final-draft review found
> 1 real blocker (pressing Enter to accept a mention corrupted the post — ProseMirror's own native
> keydown handling ran before React's synthetic interception could stop it) plus a minor
> LIKE-wildcard escaping nit, both fixed and independently re-verified → a final read-only Terra
> pass approved. The orchestrating session independently ran the full verification suite
> (typecheck, build, both test suites) at every stage and personally read the security-critical
> diff (the rich-text parser trust boundary, the notice-board route guards) before deploying. See
> `docs/lessons.md` for the ProseMirror/React event-ordering bug and a `codex exec` sandbox-stall
> failure mode recorded during this build. Live rollout: migration applied to `quincy-portal`
> remote D1 (schema confirmed via direct query), `app` Worker deployed, and a live production smoke
> check confirmed the new endpoint responding 200 with the rich-text UI rendering correctly and no
> console errors.

## Outcome and boundaries

Deliver three independently shippable collaboration surfaces:

1. Staff-wide notice-board rich text, `@mentions`, mention email/in-app notifications, and
   author-only edit/delete.
2. A per-project **comments-only** thread in an open-by-default side panel on the existing
   EditProject screen, with the same editor and mention flow. It is explicitly not an activity feed.
3. One flat, manually ordered project checklist: title, done state, optional current-project
   assignee, and optional due date. Assignment notifies; completion does not.

No images, attachments, R2 writes, queues, push, multiple checklists, task descriptions,
comment replies, Kanban-card modal, new route, or automatic project-mutation activity is in scope.
The old asset-only comments table was intentionally dropped in
[`0021_absurd_gorgon.sql`](../../portal/packages/db/migrations/0021_absurd_gorgon.sql#L1);
this is a new bounded project-comment model, not its revival.

## Drafting snapshot and shared design

The checked-in migration journal ends at `0024_download_selection_tickets`
([`_journal.json`](../../portal/packages/db/migrations/meta/_journal.json)); this plan reserves
`0025`–`0027`. Reconfirm the checked-in journal and remote D1 ledger before each phase:
if another change lands first, renumber all later references coherently.

The notice board currently stores only a plain `body` and supports create/delete
([`schema.ts:719-728`](../../portal/packages/db/src/schema.ts#L719-L728),
[`notice-board.ts:53-99`](../../portal/workers/app/src/routes/notice-board.ts#L53-L99)).
Its UI is a textarea plus a rendered paragraph
([`NoticeBoard.tsx:103-155`](../../portal/apps/web/src/components/NoticeBoard.tsx#L103-L155)).
No rich-text or autocomplete package currently exists.

### Rich-text contract established in Phase 1

Add `portal/packages/shared/src/rich-text.ts`, re-exported from
[`packages/shared/src/index.ts`](../../portal/packages/shared/src/index.ts#L1-L12). It defines
and validates a deliberately small JSON document, not HTML:

```ts
type RichTextDoc = { type: "doc"; content: Array<Paragraph | BulletList | OrderedList> };
type Text = {
  type: "text"; text: string;
  marks?: Array<{ type: "bold" | "italic" } | { type: "link"; href: string }>;
};
type Mention = { type: "mention"; attrs: { id: string; label: string } };
```

Only paragraphs, bullet/ordered lists, list items, text, bold, italic, HTTP(S) links, and mention
nodes are accepted. The shared parser rejects unknown nodes, marks, attributes, malformed mention
UUIDs, unsafe URLs, empty documents, excessive nesting, and oversized UTF-8 payloads. It exports
`richTextPlainText()` and `richTextMentionIds()`, so Worker code derives plain text and mentions
from validated content rather than accepting a parallel client-provided list. Derived plain text
includes each normalized mention label, so a mention-only document remains non-empty searchable
`body`/fallback content. A mention's client
`attrs.label` is display input only, never an asserted identity: after resolving every mentioned ID
against the operation's eligible-user set, each write path walks the parsed document and overwrites
that mention node's label with the resolved user's actual name, capped at the existing
200-character staff-name bound, before deriving `body` or persisting `contentJson`. The normalized
document is also the response DTO, so a forged or misleading label cannot survive a create or edit.
Rendering maps the model to React elements; no `dangerouslySetInnerHTML`.

Use TipTap only in the browser: add one locked compatible version of `@tiptap/react`,
`@tiptap/starter-kit`, `@tiptap/extension-link`, and `@tiptap/extension-mention` to
[`portal/package.json`](../../portal/package.json) and its lockfile together. Configure only the
allow-listed extensions; do not enable image/media/raw-HTML/code extensions. The shared parser,
not TipTap, remains the server boundary.

New reusable web components:

- `apps/web/src/components/RichTextEditor.tsx`: toolbar, keyboard behavior, counter, TipTap
  conversion, disabled state, and a `loadMentionables(query)` prop.
- `apps/web/src/components/MentionAutocomplete.tsx`: accessible listbox/active-descendant
  suggestion UI with keyboard, loading, and error handling; it never makes eligibility decisions.
- `apps/web/src/components/RichTextContent.tsx`: safe display of stored content, mention tokens,
  and external links for both surfaces. It does not accept a client-supplied link target: every
  rendered HTTP(S) user-supplied external link opens in a new tab with
  `target="_blank" rel="noopener noreferrer"`, matching
  [`CollectionPanel.tsx:28`](../../portal/apps/web/src/components/CollectionPanel.tsx#L28); all
  other target/rel behavior is absent.

**Judgment call for review:** retain the notice board’s existing 2,000-character semantic limit;
project comments use 10,000, matching annotation notes
([`annotations.ts:19-23`](../../portal/workers/app/src/routes/annotations.ts#L19-L23)).
Use a proposed 32 KiB JSON byte ceiling. The common editor takes the plain-text limit as a prop.

### Mention rows and notifications

Persist mappings for current mentions. On create/edit, validate the target set against the relevant
scope, diff mappings, retain unchanged rows, delete removed rows, and insert rows only for new
mentions. Each mapping ID is the notification `sourceKey`: retries cannot duplicate that mention
event, while removing and mentioning someone again creates a legitimate new event.

Add `"mentioned"` and `"subtask_assigned"` to `NotificationType` and
`EMAIL_ENABLED_EVENTS` in
[`packages/db/src/notifications.ts`](../../portal/packages/db/src/notifications.ts#L5-L17).
Also extend that module's exhaustive `notificationCopy()` switch—there is no default and
`emitNotifications()` uses it whenever a helper omits title/body—with:

```ts
case "mentioned": return { title: "You were mentioned", body: "You were mentioned." };
case "subtask_assigned": return { title: "Subtask assigned", body: `You have been assigned a subtask in ${projectLabel}.` };
```

Do **not** replace `"comment_added"`: it is currently emitted by annotation creation at
[`annotations.ts:97-98`](../../portal/workers/app/src/routes/annotations.ts#L97-L98), despite
the brief’s older description.

Add direct-recipient helpers to `workers/app/src/lib/notifications.ts`, each built on existing
`emitNotifications`:

- `notifyMentions(...)`: use exactly `{ title: "You were mentioned", body: "You were mentioned in
  a notice-board post." }` for notice-board maps and `{ title: "You were mentioned", body: "You
  were mentioned in a project comment." }` for project-comment maps; pass a project ID only for
  project comments and exclude the actor from self-notifications.
- `notifySubtaskAssignee(...)`: use exactly `{ title: "Subtask assigned", body: "You have been
  assigned a project subtask." }` for one active, newly assigned non-actor target; call it on
  create with an assignee or a true assignee change, never completion.

These helper bodies must not interpolate user-supplied rich/plain-text content, mentioner names,
project streets, or subtask titles directly into outbound HTML email. Any future dynamic body
copy requires appropriate HTML escaping and bounded truncation before it reaches `copy.body`.

**Judgment call for review:** both helpers re-check recipient eligibility immediately before
calling `emitNotifications`, rather than trusting the target that was valid when a mention map or
assignment was written. Notice mentions require an active staff user; project mentions and
subtasks require an active current project member or active admin, using the same
member-plus-admin, active-user query shape as `projectNotificationRecipients()`. A target that
has been deactivated or removed meanwhile receives neither in-app nor email delivery.
`notifyMentions()` passes the inserted mapping ID as its source key. `notifySubtaskAssignee()`
instead receives a persisted `assignmentVersion` and passes
`subtask-assignment:${subtaskId}:${assignmentVersion}` as its source key. The version increments
only when the persisted assignee changes (including a membership-removal clear): an emission retry
therefore finds the existing `(type, sourceKey, user)` notification and sends no duplicate email,
while an unassign/reassign produces a distinct later event. As with existing `emitNotifications`,
email is attempted only for a notification row actually inserted by the source-key conflict-safe
write.

These remain in-app plus `env.EMAIL` email delivery. A notification failure is best-effort and
cannot roll back content/task data, matching `notifyProject()`
([`lib/notifications.ts:18-36`](../../portal/workers/app/src/lib/notifications.ts#L18-L36)).

## Phase 1 — notice-board rich text and staff mentions

### Schema and migration

Create the Drizzle custom migration
`0025_collaboration_rich_text_notice_mentions.sql` so it receives a journal entry. It is additive
and must not use a table rebuild or `PRAGMA foreign_keys=OFF`.

```sql
ALTER TABLE notice_board_posts ADD COLUMN content_json text;
--> statement-breakpoint
ALTER TABLE notice_board_posts ADD COLUMN edited_at integer;
--> statement-breakpoint
CREATE TABLE notice_board_post_mentions (
  id text PRIMARY KEY NOT NULL,
  post_id text NOT NULL REFERENCES notice_board_posts(id) ON DELETE cascade,
  mentioned_user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX notice_board_post_mentions_unique
  ON notice_board_post_mentions (post_id, mentioned_user_id);
```

Mirror this in `schema.ts`: nullable `contentJson` and `editedAt` on `noticeBoardPosts`,
plus a `noticeBoardPostMentions` table with the listed foreign keys/index. Keep `body`
non-null as derived plain-text fallback/search content. Existing records stay
`content_json IS NULL`; serializers produce a one-paragraph rich document from their body. No
risky SQL JSON escaping/backfill is needed.

The bare nullable alters comply with the D1 no-rebuild guidance in
[`docs/lessons.md`](../lessons.md). Mapping records cascade only with their D1 parent. There are
no R2 objects, so media-retention rules are not implicated.

### API, permissions, audit, and notification wiring

Keep one `viewNoticeBoard` capability; view/post do not currently need separation. Grant it to
photographers in [`capabilities.ts`](../../portal/packages/shared/src/capabilities.ts#L50-L103),
opening view and posting to every active staff role. Retain the current path-scoped middleware;
never add a router-wide `use("*")`.

Revise `workers/app/src/routes/notice-board.ts`:

| Route | Contract | Required behavior |
|---|---|---|
| `GET /notice-board/posts?limit=1..50` | `{ posts: NoticePost[] }` | New DTO includes `content: RichTextDoc`, `editedAt`, author data, and timestamps. Legacy body becomes synthetic content; newest-first ordering stays. |
| `GET /notice-board/posts/latest` | unchanged | Preserve lightweight unread-cursor behavior. |
| `POST /notice-board/posts` | `{ content }` → `201 NoticePost` | Validate/derive text, validate active-staff mentions, atomically write post + maps, audit `notice_board.post`, then notify inserted maps. |
| `PATCH /notice-board/posts/:id` | `{ content }` → `NoticePost` | UUID validation and author-only check (admins not exempt); update content/body/editedAt, reconcile maps, audit `notice_board.edit`, notify newly added mentions only. |
| `DELETE /notice-board/posts/:id` | unchanged | Preserve author-only delete/audit; FK cascade removes maps. |

Add an authenticated dedicated lookup route instead of weakening admin-only `GET /users`
([`routes/users.ts:13-17`](../../portal/workers/app/src/routes/users.ts#L13-L17)):

`GET /mentionable-users?scope=notice-board&q=<optional>` requires `viewNoticeBoard`, returns
only active staff `{ id, name, role }`, filters case-insensitively, and caps at 20. `role` is a
non-PII same-name disambiguator; email is deliberately never returned or rendered by this picker.
Every mutation repeats validation; picker results are never authorization. Mount it explicitly
from `index.ts`, beneath the existing session middleware, as
`workers/app/src/routes/mentionable-users.ts` with the path-scoped pair
`use("/mentionable-users", mw)` and `use("/mentionable-users/*", mw)`; never use a root-mounted
`use("*", mw)`.

### Frontend

Replace `NoticeBoard`’s `body: string`, textarea, and `<p>` rendering with the common editor
and renderer. Add author-only **Edit** alongside Delete: load the stored document into an edit
composer, Save through PATCH or Cancel, replace from the server response, and label `editedAt`
without changing `createdAt` ordering/seen state. The new-post composer clears only after success.

Preserve expanded/collapsed state and polling
([`NoticeBoard.tsx:68-101`](../../portal/apps/web/src/components/NoticeBoard.tsx#L68-L101)).
Update `Dashboard-notice-board.dom.test.tsx` so photographers render the board, and replace the
old API test that expects photographer 403s. Add shared `.rich-text*` and
`.mention-autocomplete*` CSS near the existing notice-board styles
([`app.css:408-430`](../../portal/apps/web/src/styles/app.css#L408-L430)), rather than
board-specific duplicates.

### Tests and rollout

- Shared Vitest: valid docs, rejected node/mark/URL/UUID/nesting/byte cases, plain-text extraction,
  mention de-duplication, and legacy-body conversion.
- Update `packages/db/src/notifications.test.ts`: add both types to its exhaustive `ALL_TYPES`
  fixture and email-enabled count, and assert the two specified `notificationCopy()` fallbacks.
- Update `packages/shared/test/capabilities.test.ts`: its current notice-board assertion that
  `roleHasCapability("photographer", "viewNoticeBoard")` is false must become true, its exact
  photographer capability fixture must include that grant. Rename the enclosing test description at
  line 34 ("limits the notice board to admins and editors"), which this grant makes false, to
  reflect notice-board access for all staff roles. This file is in the separately invoked
  shared Vitest suite, not reliably covered by `npm run test --workspaces`.
- `workers/app/test/notice-board.test.ts`: photographer access; author-only edit/delete even for
  admin; persistence/edited timestamp; inactive/forged mentions rejected; mapping-diff
  notifications have type/source key/project-null/email behavior; a target deactivated after map
  persistence but before emission receives no notice/email; a forged client label is persisted and
  returned only as the resolved, bounded staff name; audits never copy content.
- Lookup tests: session/capability enforcement, active-only filtering, cap, no `manageUsers`
  dependency, same-name role disambiguation, and that no email field is disclosed.
- `NoticeBoard.dom.test.tsx`: toolbar/rendered lists/links (including safe external-link
  target/`rel` attributes), keyboard mention selection,
  POST/PATCH shapes, author controls, edit cancel, errors, and existing polling/seen tests.

Run from `portal/`: `npm run typecheck`, `npm run build -w @quincy/web`,
`npm run test --workspaces`, and
`npx vitest run --config packages/shared/vitest.config.ts`. Validate the generated migration on
real local D1 before remote use. Apply `0025`, then deploy only the app Worker.

## Phase 2 — project comments and EditProject collaboration panel

Phase 2 reuses Phase 1’s editor, renderer, parser, mappings, and notification helper unchanged. It
adds project scope, not a generic activity feature.

### Schema and migration

Create additive custom migration `0026_project_comments.sql`:

```sql
CREATE TABLE project_comments (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  author_id text NOT NULL REFERENCES user(id),
  body text NOT NULL,
  content_json text NOT NULL,
  created_at integer NOT NULL,
  edited_at integer
);
--> statement-breakpoint
CREATE INDEX project_comments_project_created_idx
  ON project_comments (project_id, created_at, id);
--> statement-breakpoint
CREATE TABLE project_comment_mentions (
  id text PRIMARY KEY NOT NULL,
  comment_id text NOT NULL REFERENCES project_comments(id) ON DELETE cascade,
  mentioned_user_id text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_comment_mentions_unique
  ON project_comment_mentions (comment_id, mentioned_user_id);
```

Add Drizzle definitions near the project domain, not the removed annotation comment history.
`body` is derived plain text, `contentJson` is the validated JSON, and `editedAt` is nullable.
Project deletion cascades comments/maps. An author delete removes D1 content but its audit record
remains; there is no R2 object to preserve.

### Project collaboration access and API

Do not use `hasProjectAccess()`. It grants editor global visibility and applies photographer
stage visibility ([`capability.ts:23-32`](../../portal/workers/app/src/middleware/capability.ts#L23-L32)),
both different from the confirmed rule. Add `hasProjectCollaborationAccess()` there:

- active admin: every project;
- everyone else: at least one `project_members` row for that project.

Use it for comments, project mention lookup, and Phase 3 subtasks. In particular, an unassigned
editor with `viewAllProjects` cannot participate.

**Judgment call for review:** an assigned photographer can collaborate even outside their normal
stage-visible dashboard window. That implements “assigned photographer + editor plus admins”
literally, rather than silently restricting the confirmed group by current project stage. The
existing dashboard filter and `GET /projects/:id`/`hasProjectAccess()` stage gate remain unchanged;
they must not become the collaboration entry path.

Add `workers/app/src/routes/project-comments.ts`, mounted explicitly from `index.ts`:

| Route | Contract | Enforcement |
|---|---|---|
| `GET /projects/:projectId/comments?limit=1..50&before=<opaque optional cursor>` | `{ project: {id, street}, comments, nextCursor? }` | collaboration access; default/maximum limit is 50. Select the newest page by `(createdAt,id)`, return that page ascending, and use `before` to request older stable pages, also returned ascending; a malformed `before` returns 400, matching `routes/notifications.ts:15-16`. `nextCursor` represents the oldest returned tuple; comments include author `{id,name}`, content, timestamps, editedAt; no activity rows. |
| `POST /projects/:projectId/comments` | `{ content }` → `201` comment | collaboration access; active current project-member/admin mention validation; map write; `project_comment.create` audit; new-mention notification. |
| `PATCH /projects/:projectId/comments/:commentId` | `{ content }` → comment | collaboration access plus strict author-only guard; reconcile maps; `project_comment.edit` audit; new mentions only. |
| `DELETE /projects/:projectId/comments/:commentId` | `{ok:true}` | collaboration access plus author-only guard; delete/maps cascade; `project_comment.delete` audit. |

Every project-scoped comment handler must validate the UUID and use the same explicit project
existence guard pattern already present in `routes/projects.ts`: return 404 for a missing project
before any mutation or audit write. This is required even though an active admin passes
`hasProjectCollaborationAccess()` for any ID; otherwise an admin request for an unknown UUID can
reach an FK failure or orphan audit path. Apply the same guard to the project-scoped mention lookup
for a consistent missing-project response.

Extend Phase 1 lookup with `projectId=<uuid>` (reject ambiguous `scope` + `projectId`).
After collaboration access, return deduplicated active admins/current project members. Mutation
validation uses the same resolver, so stale picker membership, inactive users, unrelated editors,
and forged IDs fail. Its DTO remains `{ id, name, role }`—never email—so the Phase 1 disclosure
boundary also applies to the project-scoped picker. No `comment_added` broadcast is introduced:
mentions are the only comment notification, avoiding the rejected activity/noise scope.

### EditProject panel and participant reachability

Current App routing blocks EditProject unless `editProject` exists
([`App.tsx:35-41`](../../portal/apps/web/src/App.tsx#L35-L41)), but photographers are confirmed
comment participants. Add a focused `collaborateOnProject` capability to shared capabilities and
grant it to all staff roles. It is only a UI route affordance; API endpoints retain the
membership/admin check.

- Allow the existing EditProject route with either `editProject` or `collaborateOnProject`;
  do not create a route.
- Extract `ProjectCollaborationPanel.tsx` from `EditProject.tsx`. It is a semantic side
  `<aside>`, toggled but **open by default**. It is alongside the project form on desktop and a
  focus-managed overlay drawer (Escape/return focus) at the narrow breakpoint.
- Existing `editProject` users keep the editable form and its existing PATCH guard
  ([`projects.ts:289-294`](../../portal/workers/app/src/routes/projects.ts#L289-L294)).
  Collaboration-only users see the same panel from the existing screen but no fake editable
  form/Save control. On the notification deep link, their screen must not call the stage-gated
  `GET /projects/:id`; it loads its minimal project label and all collaboration data from the
  collaboration-access-protected comments endpoint instead. Restructure the whole-screen early
  returns at [`EditProject.tsx:105-106`](../../portal/apps/web/src/screens/EditProject.tsx#L105-L106),
  which currently require that project-detail fetch to populate `project`, so the
  collaboration-only panel can render without it. Do not mount `ProjectFields` on that path:
  [`ProjectFields.tsx:67`](../../portal/apps/web/src/components/ProjectFields.tsx#L67) fetches
  admin-only `/api/users` and would otherwise create a second 403. The existing danger-zone
  deletion controls are already correctly gated by `can("adminBackend")` in `EditProject.tsx` and
  require no change.
- The panel loads on mount/open, composes/renders comments with shared components, offers
  author-only edit/delete, paginates older comments through the bounded cursor contract, and has
  no polling or derived activity list. Its layout reserves a checklist slot for Phase 3 without a
  Phase 2 placeholder feature.

Add `edit-project__collaboration*` styles next to existing EditProject styles; do not repurpose
lightbox markup/state.

### Topbar notification navigation

Implement the reachability affordance in
`apps/web/src/components/Topbar.tsx`; notification API data already includes `type` and nullable
`projectId`. For **only** `mentioned` and `subtask_assigned` notifications with a non-null
`projectId`, replace the current `button.topbar__notification-item` with the existing
`InternalLink` component (a real `<a role="menuitem">`) whose `to` is
`staffPathFor({ kind: "edit-project", projectId })`. This deliberately lets the existing
`shouldInterceptInternalLink()` handling in `lib/router.ts` progressively enhance ordinary mouse
clicks while retaining native keyboard/new-tab behavior. `staffPathFor()` already generates
`/projects/:id/edit`, and `parseStaffPathname()` accepts that route only for the app's canonical
lowercase UUID shape; generated project IDs meet that contract.

The link's `onClick` first starts the existing optimistic `markNotificationRead(notification)` and
then calls `closeNotifications()`; `InternalLink` then performs its usual interception/navigation
when appropriate. Thus navigation does not wait for the best-effort read request, the popover is
removed before the new screen renders, and the existing Escape, initial-focus, and outside-click
handlers remain valid. The adjacent dismiss button and its focus-after-delete behavior are
unchanged; do not nest an interactive element inside the anchor.

This best-effort mechanism has an accepted keyboard-navigation tradeoff: Enter activation can
perform native full-document navigation and abort the in-flight mark-read POST, so that
notification can remain unread after reload. Do not represent this phase as guaranteeing a read
state for keyboard activation.

Notice-board `mentioned` notifications have `projectId === null`, so they remain the existing
mark-read-only menu button with no invented project destination. All existing notification types,
including project-scoped `raw_ready`, `edited_landed`, `sent_to_editing`, `autohdr_stalled`,
`delivered`, and `assigned_to_project`, also remain non-navigable mark-read buttons in this phase;
this is intentionally scoped to the two new collaboration types, not a retroactive bell redesign.
No “Comments & tasks” project-workspace rail affordance exists today, and this plan adds none;
the scoped notification deep link is the collaboration-only reachability mechanism.

### Tests and rollout

Worker integration tests cover admin, assigned photographer/editor, unassigned editor, inactive
member, and cross-project caller: list/create/edit/delete, author-only admin rejection,
non-member 403, forged nested IDs, ascending order, scoped lookup/validation, mapping-diff email
and all audit actions, server-normalized mention labels, including suppression when a mapped
recipient is removed/deactivated before emission. They also prove a stage-hidden assigned
photographer still receives and can follow a
project mention deep link to collaboration data, while `GET /projects/:id` remains 403 for that
same principal. Cover missing-project 404-before-audit behavior for every comment mutation and
the project-scoped lookup, plus the 50-item cap, stable cursor, and ascending page ordering.
Extend `packages/shared/test/capabilities.test.ts`: update the photographer
exact-array fixture at lines 7–13 — the file's only `toEqual` capability fixture — a second time so
it also lists `collaborateOnProject`, and add `roleHasCapability` assertions for that capability for
photographer, editor, and admin. Editor and admin have no exact-array fixture in this file and none
should be added. This is the separately invoked shared Vitest suite, so retain the explicit
`npx vitest run --config packages/shared/vitest.config.ts` verification. Extend `Topbar.dom.test.tsx` to prove the two project-scoped new types render real
anchors, invoke mark-read and close the popover before SPA navigation, while project-null notice
mentions and every existing notification type remain buttons. Web DOM tests cover open default,
toggle/Escape/focus return, loading/error,
composer/edit/cancel/delete, scoped mentions, narrow drawer, notification deep-link navigation
without a project-detail fetch, and photographer route access without form saving. Strengthen the
collaboration-only EditProject DOM test to assert it issues neither `/api/projects/:id` nor
`/api/users`; keep existing EditProject form payload tests.

Apply `0026` before app deployment. It creates only new tables and needs no rebuild/PRAGMA;
background and webhook ingress are untouched. Run the same full verification sequence as Phase 1.

## Phase 3 — flat project checklist/subtasks

Phase 3 reuses the Phase 2 collaboration helper and panel. It changes neither rich text nor
comments.

### Schema and migration

Create additive custom migration `0027_project_subtasks.sql`:

```sql
CREATE TABLE project_subtasks (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE cascade,
  title text NOT NULL,
  done integer NOT NULL DEFAULT 0,
  position integer NOT NULL,
  assignee_id text REFERENCES user(id) ON DELETE SET NULL,
  assignment_version integer NOT NULL DEFAULT 0,
  due_date text,
  created_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX project_subtasks_project_position_idx
  ON project_subtasks (project_id, position, id);
--> statement-breakpoint
CREATE INDEX project_subtasks_assignee_idx
  ON project_subtasks (assignee_id);
```

Add the matching `projectSubtasks` definition near project comments: boolean-mode `done`,
integer `position`, nullable `assigneeId`/date-only `dueDate`, persisted integer
`assignmentVersion`, creator and timestamps. An initially assigned task starts at version `1`;
each persisted assignment or unassignment increments it, while unrelated task changes do not.
Keep due date as a validated `YYYY-MM-DD` string, including calendar/leap-year validation; never
Date-parse it, per the date-only lesson in [`docs/lessons.md`](../lessons.md).

**Judgment call for review:** assignment is validated against active current project members/admins.
When a project update removes a person from every project role, it clears that user’s existing
subtask assignments unless they remain an active admin, and records the clear count in the
project-update audit metadata. Refactor `syncMembers()`/the project PATCH orchestration
(`workers/app/src/lib/project-members.ts:26-38` and `routes/projects.ts:338-350`) to derive
the complete photographer/editor membership diff first, then run the membership inserts/deletes
and one conditional clear per distinct removed user in a single D1 batch/transaction, before the
audit write. Each clear runs only after the final membership diff and is guarded by `NOT EXISTS`
for any remaining `project_members` role for that user (and by no active-admin role); it sets
`assignee_id = NULL`, advances `assignment_version`, and updates `updated_at` in that same batch.
Use the conditional update results as the clear count in the subsequent project-update audit
metadata. Thus a failed batch leaves both membership and assignment intact, and retaining another
role never clears an assignment. The batch must preserve `syncMembers()`'s `{ added, removed }`
contract — `added` is derived from `insertProjectMembers()`'s INSERT…RETURNING and feeds
`notifyProjectAssignments()` — with a regression test asserting assignment notifications still fire
after the refactor. This preserves the “assignee drawn from project members”
invariant after team edits; a simple FK cannot express it because one person may have two
project-member role rows. No unassignment notification is sent. This atomic scrub intentionally
covers only the project-membership-removal path. A later admin `PATCH /users/:id` deactivation,
or a role change that demotes an admin assignee who has no `project_members` row, deliberately
does **not** clear existing subtasks in this phase: the stale assignee reference remains
display-only and emits no notification because the established send-time eligibility check rejects
an inactive/non-member/non-admin user. Expanding the scrub to those user-administration paths is
separate scope, not an implied general invariant.

### API, audit, ordering, and notifications

Add `workers/app/src/routes/project-subtasks.ts`, all routes using
`hasProjectCollaborationAccess()`:

| Route | Contract | Behavior |
|---|---|---|
| `GET /projects/:projectId/subtasks` | `{ subtasks }` | List in `(position,id)` order with an `{ id, name }` assignee summary — never email, matching the Phase 1/2 picker disclosure boundary. |
| `POST /projects/:projectId/subtasks` | `{title, assigneeId?, dueDate?}` → `201` task | Append at server-selected position; validate title/date/current scoped assignee; initialize `assignmentVersion` to `1` when assigned; audit `project_subtask.create`; notify new non-actor assignee with that persisted version. |
| `PATCH /projects/:projectId/subtasks/:id` | partial `{title, done, assigneeId, dueDate}` → task | Explicit null clears optional fields, omitted means unchanged; atomically increment `assignmentVersion` only for a persisted assignee change; audit changed field names only; notify only if persisted assignee changed to an active non-actor, using the returned version. |
| `POST /projects/:projectId/subtasks/:id/move` | `{direction:"up"|"down"}` → `{position}` | Guarded D1 batch swaps/resequences adjacent same-project tasks; end is a no-op; audit `project_subtask.move`. |
| `DELETE /projects/:projectId/subtasks/:id` | `{ok:true}` | Delete and audit `project_subtask.delete`. |

Every project-scoped subtask handler must validate the UUID and use the same explicit
missing-project 404-before-mutation/audit guard required for comments, including for active
admins. Run the collaboration-access check first and the existence check second, matching
`projects.ts:361-367`, so a non-member receives a uniform 403 and cannot use the status code as a
project-existence oracle.

Use integer positions with initial spacing (for example 1024) and resequence in a D1 batch when
needed. Directional moves avoid arbitrary stale client positions/cross-project insertion; guarded
statements verify the task and neighbor still belong to the project.

**Judgment call for review:** subtasks are shared project state. Any project participant/admin may
create, complete, edit, reorder, or delete them; author-only is deliberately limited to notice
posts/comments, where the user explicitly required it. This matches checklist collaboration and
needs confirmation before implementation.

`notifySubtaskAssignee()` sends `subtask_assigned` through in-app/email after a successful
create/reassignment, with the persisted assignment-version source key and send-time eligibility
check defined above. No completion notification, R2 work, queue, or new delivery mechanism.

### Frontend, tests, and rollout

Add `SubtaskChecklist.tsx` to the Phase 2 panel slot: title/count/empty state/add row, completion
checkbox, inline title edit, scoped assignee picker sourced from the Phase 2
`GET /mentionable-users?projectId=<uuid>` endpoint (same `{ id, name, role }` DTO, no email), date
input, delete, and up/down controls.
Disable only the in-flight task/action, reconcile server responses, use a local live region for
errors, and preserve focus after delete/reorder. Display due dates as strings without timezone
conversion. Use focused checklist CSS adjacent to panel styles; no task data is added to the
Dashboard/Kanban DTO.

Worker tests cover permissions, title/date/assignee rejection, append/move order, reassignment-only
notifications, retry-safe assignment source keys (including one fresh notification after a later
unassign/reassign), send-time ineligibility suppression, no completion notification, null clear
semantics, and the membership-removal transaction: final-role removal clears with the audit count,
retaining another role or active admin does not, and a failed batch leaves neither partial removal
nor stray assignment. Explicitly distinguish the intentionally unswept user-administration cases:
deactivation and admin-role demotion may leave a display-only stale assignee but must produce no
delivery. Also cover project cascade, every audit action, and stale/concurrent move safety. Web
DOM tests cover all checklist
operations, keyboard/focus, failed-request reconciliation, mobile panel layout, and Phase 2 panel
integration. Include missing-project 404-before-audit coverage for every subtask mutation.

Apply `0027`, then deploy app only after the same four required verification commands pass.
This migration is additive; it must not use D1 table rebuild pragmas.

## Cross-phase review and deployment checklist

1. Reconfirm migration numbering; generate custom migrations so journal metadata is correct. Inspect
   generated SQL and reject any silent table rebuild.
2. Review actual auth paths: no Hono middleware factory invocation inside a handler; path-scope any
   new middleware; retain author-only checks exactly where required.
3. Run from `portal/`: `npm run typecheck`, `npm run build -w @quincy/web`,
   `npm run test --workspaces`, and
   `npx vitest run --config packages/shared/vitest.config.ts`.
4. Apply the reviewed D1 migration before deploying the app Worker. If a future change touches other
   Workers, follow documented `background → webhook-ingress → app` order.
5. Smoke test real accounts: photographer notice post/mention, admin author-only rejection,
   project member vs unassigned-editor comments, a stage-hidden photographer following a
   notification deep link without a project-detail request, in-app/email mention and subtask
   assignment (including no delivery after removal/deactivation), and completion producing no
   notification.
6. Keep [`docs/todo.md`](../todo.md) and [`docs/lessons.md`](../lessons.md) current as work lands,
   including any new implementation status, test/deploy result, or reusable incident lesson.
7. Keep this plan in `docs/plans/` until all three phases are built, verified, committed, and
   deployed. Then update its status with commit hashes and `git mv` it to
   `docs/plans/implemented/`.

## Risks reviewers should check

- TipTap is not trusted input: parser, safe link policy, size limits, and renderer must cover POST,
  PATCH, and legacy notice bodies.
- Do not drift from comments-only into automatic activity instrumentation.
- Permission asymmetry is intentional: notice board = all staff; project collaboration = members
  plus admins; comments/posts = author-only; tasks = shared participant state.
- Reconcile mention mappings before notification selection and preserve annotation
  `comment_added` behavior.
- Collaboration-only EditProject navigation must not grant project PATCH or leak full project
  detail to non-members; stage-hidden photographer deep links must use collaboration endpoints,
  not the separately stage-gated `GET /projects/:id`.
- Every new notification event needs a persisted source key and must revalidate recipient
  eligibility at send time, so retries cannot duplicate in-app/email delivery.
- D1 migrations must remain additive: no `PRAGMA foreign_keys=OFF`, table rebuild, or SQL JSON
  backfill.
- The Phase 3 `syncMembers()`/project-PATCH change is a concentrated risk because it refactors an
  already shipped, tested membership path. Review the complete diff/transaction ordering and its
  focused regression tests, rather than treating the assignment-clear paragraph as an isolated
  subtask change.
