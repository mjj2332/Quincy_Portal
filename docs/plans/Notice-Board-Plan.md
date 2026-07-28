# Dashboard Notice Board — Plan

**Status: APPROVED by Terra (round 3, 2026-07-28). Ready to build whenever the user authorizes
it — not yet built.** One item still needs a user decision first: see "Open question" below
(global vs. project-scoped board) — Terra approved the plan *as designed* (global), but that
choice is the user's to confirm, not something to infer from silence.

User request: a collapsible panel on the dashboard where staff can post messages to each other,
like a lightweight chat box.

## Current state (verified against the code, not assumed)

- **No message-board or chat concept exists anywhere in this codebase.** The closest analog is
  `comments`/`annotations` (`schema.ts`, `annotationsRoutes` at
  `workers/app/src/routes/annotations.ts`), but those are asset-scoped review feedback, not a
  general staff message board — a different table, not an extension of that one.
- **No existing collapsible-panel component.** `Topbar.tsx`'s mobile nav menu
  (`Topbar.tsx:25-47,93-101`) is the one bespoke disclosure pattern in this codebase, but it's a
  **menu** (an overlay: focuses its first item and handles `Escape`/outside-click dismissal,
  `useId()` for `aria-controls` — corrected per Terra round 2: `Topbar.tsx:36-46` does *not*
  actually trap `Tab` focus inside the menu, so "focus-trap" in the round-1 wording overstated
  what it does; the conclusion not to copy its semantics stands, only this factual description
  needed fixing) — the panel here isn't an overlay and shouldn't copy menu-specific interaction
  semantics wholesale regardless. What this plan actually
  reuses from it is narrower: the `useState` open/closed pattern and `useId()`-linked
  `aria-controls`/`aria-expanded` for accessibility. The board panel itself is a plain inline
  disclosure (a toggle `<button aria-expanded={open} aria-controls={panelId}>` next to an
  always-in-document-flow region that grows/shrinks) — no focus trap, no `Escape` handler, no
  outside-click dismissal, since collapsing it isn't the same interaction as closing an overlay.
- **`Dashboard.tsx`'s view-preference pattern** (`view` state persisted to
  `window.localStorage.getItem("quincy:dashboard:view")`, `Dashboard.tsx:90-93,142-145`) is the
  direct precedent for persisting the panel's collapsed/expanded state across visits.
- **Every near-real-time behavior in this codebase is polling, not push** (confirmed again while
  researching the Notifications plan) — no shared `usePolling` hook exists; each screen
  reimplements a `setInterval`. This plan follows the same pattern rather than introducing new
  infrastructure.
- **Comment/annotation delete is author-only, no admin exemption**, per this repo's own
  convention (`CLAUDE.md`: "for audit integrity") and confirmed in code
  (`annotationsRoutes.delete("/comments/:id")`, `annotations.ts:158-177`:
  `if (comment.authorId !== c.get("user").id) return c.json({ error: "Forbidden..." }, 403)`,
  no role bypass). This plan follows the same convention for board posts.
- **Every mutation in this codebase writes an `audit()` call** (`lib/audit.ts`, used at every
  route touched during this session's research) — board post create/delete follow suit.

## Design

### 1. Schema (migration number: **next available at build time** — currently 0018;
becomes 0019 only if `Kanban-Priority-And-Manual-Ordering-Plan.md`'s migration lands first;
confirm against `packages/db/migrations/meta/_journal.json` immediately before generating it,
not from either plan's own guess — corrected after Terra round 1 flagged the original wording as
presenting 0019 as settled when it isn't)

```ts
// packages/db/src/schema.ts
export const noticeBoardPosts = sqliteTable(
  "notice_board_posts",
  {
    id: id(),
    authorId: text("author_id").notNull().references(() => user.id), // no onDelete: "cascade" —
    // corrected after Terra round 1: `comments.authorId` (schema.ts:706-708) references `user.id`
    // with no onDelete clause (Drizzle/SQLite's restrictive default), not a cascade — this table
    // should match that existing convention, not invent a different one. A cascade here would
    // silently erase a staff member's message history the moment their account is deleted, which
    // no other content table in this schema does.
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("notice_board_posts_created_idx").on(t.createdAt)],
);
```

No `editedAt`/edit support — a chat-style board where messages can be deleted (author-only) but
not silently rewritten keeps the audit trail simple; add edit later only if it turns out to
matter (same "don't build for a hypothetical" reasoning used elsewhere in this codebase's own
plans).

**Open question, raised by Terra round 1 — needs a user decision before this is built**: is this
board meant to be a single global stream (no `projectId`, as designed above), or should posts
optionally attach to a project? The original request ("a collapsible panel on the dashboard...
like a chat box") reads most naturally as global to the drafting session, and a global design is
simpler to build and matches "chat box" better than a per-project comment thread would — but the
request doesn't explicitly rule out project association, and Terra correctly flagged that this
plan shouldn't quietly decide that on the user's behalf. **Proceeding with the global,
no-`projectId` design as the default** unless told otherwise; this is the one open item blocking
a clean approval, not a build blocker in the sense of needing rework — just needs a yes/no.

### 2. API (`workers/app/src/routes/notice-board.ts`, new file, same shape as `annotations.ts`'s
comment routes)

- `GET /api/notice-board/posts?limit=50` — most recent posts, newest first. **Server validates the
  requested limit properly** (corrected per Terra round 2: the round-1 fix,
  `Math.min(Number(query.limit) || 50, 50)`, doesn't reject negative or fractional input —
  `Number("-5") || 50` still yields `-5`. Use this repo's existing Zod query-validation pattern
  instead, matching `admin.ts:107`'s `optionalQuery(z.coerce.number().int().min(1).max(200))`:
  `optionalQuery(z.coerce.number().int().min(1).max(50))`, defaulting to 50 when absent, `400` on
  an invalid value rather than silently coercing it). Ordered `ORDER BY created_at DESC, id DESC`
  — the explicit `id` tie-break (raised by round 1) makes ordering deterministic for posts
  created in the same millisecond, rather than leaving SQLite's tie order unspecified. Response
  shape:
  ```ts
  { posts: { id: string; authorId: string; authorName: string; body: string; createdAt: string }[] }
  ```
  Any authenticated user (no capability gate — matches the notifications API's reasoning:
  nothing here is project-scoped or role-sensitive).
- `GET /api/notice-board/posts/latest` — added per Terra round 1's polling-gap finding (§3 below):
  returns just `{ id: string | null, createdAt: string | null }` for the single newest post, cheap
  enough to poll slowly even while the panel is collapsed.
- `POST /api/notice-board/posts` — body `{ body: string }` (trim, `min(1).max(2000)` — shorter
  than the 10,000-char comment cap, matching a "quick message," not a long review note). Inserts,
  audits `"notice_board.post"`, returns the created row in the same per-post shape as `GET`
  above.
- `DELETE /api/notice-board/posts/:id` — author-only (`post.authorId !== c.get("user").id` → 403,
  no admin exemption, matching the comment/annotation convention above). Audits
  `"notice_board.delete"`.

### 3. Frontend

- **New component** `NoticeBoard.tsx` (`apps/web/src/components/`), rendered in `Dashboard.tsx`
  near the top (`pagehead`/`stats` area — exact placement is a layout call for the build, not a
  planning blocker).
- **Current-user wiring** (added per Terra round 1, which found `Dashboard` currently receives no
  user data at all — `App.tsx` renders it as bare `<Dashboard />`): thread a `currentUserId`
  prop down the same way `Shell` already does for `Admin` (`App.tsx`: `<Admin
  currentUserId={user.id} />`) — change `<Dashboard />` to `<Dashboard currentUserId={user.id} />`
  and have `Dashboard` pass it through to `NoticeBoard`, used to decide which posts show a delete
  control.
- **Collapsed/expanded state**: `useState`, persisted to
  `window.localStorage.getItem("quincy:dashboard:noticeboard")`, same read/write-with-try/catch
  pattern as `Dashboard.tsx:90-93,142-145` (storage can be disabled by the browser). Default
  **collapsed** — this is a secondary, ambient feature; it shouldn't compete with the primary
  project list for attention on load.
- **Unread indicator while collapsed** (added per Terra round 1: the original draft stopped all
  polling on collapse with no way to know a message arrived, a real gap for something explicitly
  framed as a chat box people are meant to actually see). While collapsed, poll
  `GET /api/notice-board/posts/latest` on a slow interval (recommend 60s — cheap enough that
  "collapsed" doesn't mean "silent", but far less aggressive than the expanded view since nobody's
  looking at it) and compare its `id` against the last-seen post ID. Show a small dot badge on the
  collapsed toggle when the latest ID is newer than last-seen.
  **User-scoped storage, corrected per Terra round 2**: the last-seen ID must be keyed per user
  (e.g. `` `quincy:dashboard:noticeboard:seen:${currentUserId}` ``), not a single shared
  `localStorage` key — a shared key on a shared browser/machine would leak one staff member's
  seen-state to whoever's account is active next. The collapse/expand preference itself is not
  sensitive and may stay a single shared key.
  **Cursor-advancement logic, corrected per Terra round 2** (the round-1 draft only advanced the
  seen cursor on the expand click, using whatever `latest` happened to be cached — two related
  gaps):
  1. **While expanded**, each successful list-poll response (§ below) also advances the seen
     cursor to that response's newest post ID — otherwise a message that arrives *while already
     expanded* is visible in the list but never marked seen, so collapsing afterward would
     incorrectly show it as unread again.
  2. **On expand**, don't clear the badge from a possibly-stale cached `latest` value — trigger an
     immediate fresh fetch (of the list, since expanding needs the list anyway) and mark seen
     using *that* response's newest post ID, only after it succeeds. If the fetch fails, leave the
     badge showing rather than clearing it optimistically.
- **List + composer**: when expanded, fetch `GET /api/notice-board/posts` once (immediately on
  expand, doubling as the seen-cursor-advancing fetch above) and poll on a fixed interval only
  while expanded (switching from the slower collapsed-state "latest post" poll to the fuller list
  poll, each successful tick also advancing the seen cursor per above) — recommend 20-30s,
  matching the interval already proposed for the notification bell in `Notifications-Plan.md`,
  for the same "not urgent enough to need sub-10s" reasoning. A simple textarea + "Post" button
  composer at the bottom (or top — build detail), Enter-to-submit optional (build detail, not a
  planning decision).
- **Each post**: author name, relative/short timestamp, body text, and a delete control shown
  only when `post.authorId === currentUserId` (mirrors the existing per-comment author-only
  delete UI pattern already used in the review lightbox, if one exists there — confirm the exact
  existing UI treatment at build time and match it rather than inventing a new one).

## Explicitly out of scope

- Project-scoped or thread/reply structure (unlike `comments`, this is a single flat stream, no
  `parentId`).
- Editing an existing post.
- Rich text, attachments, @mentions, or per-message read receipts (the collapsed-state unread
  badge in §3 is a coarse "new activity exists" signal only, not per-message tracking).
- Real-time/push delivery — polling only, matching every other near-real-time feature here.
- Admin moderation/delete-any-post — author-only delete, no exemption, matching this repo's
  existing comment/annotation convention.
- Pagination beyond the most-recent-50 cap (revisit if usage shows it's needed).

## Testing requirements for the build

1. `workers/app/test`: post create/list/delete round-trip; delete is 403 for a non-author
   (including admin — no bypass); body length validation (empty, over 2000 chars) rejected;
   `GET` returns newest-first with a deterministic `id` tie-break for same-millisecond posts,
   capped at 50 regardless of a larger requested `limit`; `GET /posts/latest` returns the correct
   newest post (and a null id when the board is empty).
2. `apps/web`: collapsed-by-default on first visit, persists the toggle across a remount
   (matching the existing `initializeDashboardView`-style test coverage); the slow "latest post"
   poll runs while collapsed and the full-list poll runs while expanded, never both at once (a
   mocked timer confirms the correct one fires in each state); the unread badge appears when
   `latest.id` differs from last-seen; a message arriving **while already expanded** is correctly
   marked seen by the next list-poll tick (collapsing afterward shows no badge); expanding
   correctly clears the badge only after a fresh fetch succeeds, and leaves it showing if that
   fetch fails (no optimistic clear against a stale cached value); the last-seen storage key is
   scoped per `currentUserId` (a second account on the same browser sees its own unread state, not
   the first account's); delete control only rendered when `post.authorId === currentUserId`.

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and**
  `npx vitest run --config packages/shared/vitest.config.ts` (silently skipped by the
  workspaces script otherwise, per this repo's own gotcha).
- Manual smoke: post a message as one staff account, confirm it's visible (after a poll tick) to
  a second account; confirm the second account cannot delete the first account's post.

## Rollout

1. Migration (additive: `notice_board_posts`) — safe to apply to prod independent of any code
   deploy.
2. `workers/app`: new route file, mounted alongside the existing routers in the `/api` parent
   router (confirm the mount point doesn't accidentally leak middleware — this repo's own
   documented Hono gotcha: never `router.use("*", mw)` on a router mounted at `/`).
3. `apps/web`: `NoticeBoard.tsx` + `Dashboard.tsx` wiring — depends on step 2's API being live.

## Routing (per Subagent-Orchestration.md §2 routing table)

Schema + API + frontend, small-to-moderate size, single new concern (no cross-cutting changes to
existing routes/tables) — Terra plan review, then (when the user authorizes a build) Terra build,
Terra diff review, Opus final read, §5 gate.
