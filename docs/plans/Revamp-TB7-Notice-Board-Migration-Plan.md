# Revamp TB7 — Notice-Board Migration Plan

> **Status: Both slices built, committed, and diff-reviewed (Slice 1: 1 fresh-Sol diff review
> round, clean; Slice 2: 5 rounds, the last two closing two real concurrency bugs — see the Slice 2
> build correction below and `docs/plans/tb7-sol-diff-review-2.md` through `-5.md`) plus a
> whole-branch review (APPROVE WITH FOLLOWUPS, no blocking issues — `docs/plans/
> tb7-whole-branch-review.md`). Full automated gate (typecheck, web build, `test --workspaces`,
> shared package vitest config) green throughout. Pending: Opus final-draft review, Agy QA, and
> production deploy. Not yet implemented in production — stays in `docs/plans/` until deployed.**

> **Slice 2 build correction (2026-09-01):** Rule 3 was corrected during the Slice 2 build in
> response to Sol diff-review-2: equal-marker `latest` changes are now uniformly sequence-gated,
> including tuple-newer heads, because deletions make tuple order insufficient to prove freshness.

## Outcome and authority

TB7 moves the staff Notice Board's read/unread high-water mark from per-browser
`window.localStorage` to D1 so one user's state follows them across devices. It also brings the
Notice Board onto the already-shipped TB2/TB3 freshness rule: **a successful fetch is not proof of
reading; only a fresh fetch that starts and completes while the newest-post surface is visibly
presented may advance the marker.**

Authority, in order, is the root `CLAUDE.md` and `docs/todo.md`, the approved revamp decision set,
`docs/plans/revamp_2026_portal/core/06-Discussions-And-Notice-Board.md`, the TB7 roadmap stub, and
the implemented TB2/TB3 plans. This is an adapter migration over the existing Notice Board, not a
new discussion product.

The implementation must preserve:

- top-level newest-first posts, rich text, mentions, current 50-post list, and current visual
  treatment;
- the existing `viewNoticeBoard` router capability gate and Dashboard capability gate;
- author-only edit/delete, including no ordinary Admin exemption (runtime-gated impersonation
  continues to act as the effective user);
- the local collapse preference; and
- create/edit drafts through every poll, focus refresh, mutation settle, and transient failure.

External Editors remain excluded because they do not receive `viewNoticeBoard`. TB7 must not add
Notice Board data to their projections, global directory access, navigation, or notifications.

### Explicit non-goals

TB7 does not add replies/comments under notices, pinning, priority, expiry, acknowledgement
receipts, realtime delivery, social-feed ranking, external-platform integration, or a generic/
universal discussion-storage migration. It does not redesign the Notice Board, alter project
discussion, or touch media/R2 storage.

## Verified current state and implementation preconditions

- `portal/apps/web/src/components/NoticeBoard.tsx` stores collapse state under
  `quincy:dashboard:noticeboard:v2` and read state under
  `quincy:dashboard:noticeboard:seen:<userId>`. Its expanded 25-second list poll calls
  `markSeen()` after every successful response, even if the tab or panel is not actually visible.
  Its collapsed 60-second poll reads only `/api/notice-board/posts/latest`.
- `portal/workers/app/src/routes/notice-board.ts` already path-scopes
  `requireCapability("viewNoticeBoard")` to both `/notice-board` and `/notice-board/*`; retain those
  registrations. All new endpoints sit beneath that existing gate. Do not introduce
  `router.use("*", ...)`.
- `notice_board_posts` is ordered by `(created_at DESC, id DESC)` and already has
  `notice_board_posts_created_idx` on `created_at`. There is no server-owned Notice Board marker.
- Migration `0038_project_activity_feed_index.sql` is present in the migration directory and
  journal and `docs/todo.md` records it as applied to production on 2026-08-31. Therefore TB7 uses
  **`0039_notice_board_read_markers.sql`**. The builder must recheck all three sources and the
  production migration ledger immediately before implementation/deploy; if another branch has
  claimed `0039`, renumber the migration, journal entry, migration test, and this plan together.
- The existing post and edit routes call the direct legacy `notifyNoticeBoardMentions()` →
  `emitNotifications()` path. TB7 preserves that behavior unchanged. The project-oriented
  `notification_outbox` cannot represent global Notice Board events because `project_id` is
  `NOT NULL`; durable global delivery is separate future work, not a TB7 prerequisite or deliverable.

Implementation starts from current `main`, records the base commit, and repeats the migration-number
check. No work is authorized in `prototype/` or on media/R2 behavior.

## 1. Schema and migration

Add the matching Drizzle table to `portal/packages/db/src/schema.ts` and export it through the
existing DB package barrel in the same way as `projectCommentReadMarkers`:

```ts
export const noticeBoardReadMarkers = sqliteTable(
  "notice_board_read_markers",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    lastReadPostId: text("last_read_post_id").notNull(),
    lastReadPostCreatedAt: integer("last_read_post_created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
);
```

Migration `portal/packages/db/migrations/0039_notice_board_read_markers.sql` is exactly additive:

```sql
CREATE TABLE notice_board_read_markers (
  user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
  last_read_post_id text NOT NULL,
  last_read_post_created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (user_id)
);
```

There is deliberately no foreign key from `last_read_post_id` to `notice_board_posts`: deleting a
post must not regress another user's high-water mark. There is no secondary marker index: the
`user_id` primary-key auto-index is the exact lookup path, and this stream has no project dimension.
The existing post `created_at` index supports newest/range reads. No new CHECK is needed; this
mirrors the proven project-comment marker and avoids asserting more than the existing timestamp
schema asserts. The migration contains no `ALTER`, rebuild, backfill, copy, or destructive SQL.

Update `portal/packages/db/migrations/meta/_journal.json` and its snapshot through the repository's
normal migration bookkeeping. Add `portal/packages/db/test/migration-0039.test.ts`, modeled on the
0030 test, to prove the exact DDL, one row per user, user cascade, retained marker after post
deletion, primary-key lookup, clean foreign keys, and absence of destructive/backfill statements.

### High-water ordering invariant

The marker is the tuple `(last_read_post_created_at, last_read_post_id)`, ordered exactly like the
stream. A marker write must be monotonic and must never trust a timestamp from the browser:

```sql
INSERT INTO notice_board_read_markers (
  user_id, last_read_post_id, last_read_post_created_at, updated_at
)
SELECT ?, id, created_at, ?
FROM notice_board_posts
WHERE id = ?
ON CONFLICT(user_id) DO UPDATE SET
  last_read_post_id = excluded.last_read_post_id,
  last_read_post_created_at = excluded.last_read_post_created_at,
  updated_at = MAX(
    excluded.updated_at,
    notice_board_read_markers.updated_at + 1
  )
WHERE excluded.last_read_post_created_at > notice_board_read_markers.last_read_post_created_at
   OR (
     excluded.last_read_post_created_at = notice_board_read_markers.last_read_post_created_at
     AND excluded.last_read_post_id > notice_board_read_markers.last_read_post_id
   );
```

Random UUID order cannot resolve two Worker requests whose wall-clock values collide within one
millisecond. Refactor post creation behind a small Notice Board service/helper and allocate each new
`created_at` as `MAX(wall clock, MAX(posts) + 1, MAX(markers) + 1)`. The posts term orders
concurrent/precomputed same-millisecond requests; the retained-marker term keeps the invariant total
after the former high-water post is deleted and the clock has not advanced beyond it, including
clock anomalies. This is a correctness invariant for the single global stream, not a claim that
same-millisecond human actions are common or that Notice Board has TB3's import/batch concurrency.

Bind wall-clock time as `excluded.updated_at`; on a successful conflict update, the `MAX` expression
allocates `updated_at` as at least the existing value plus one, matching the Admin recovery
convention. Equal/older targets do not execute the update and leave it unchanged. Marker correctness
and client response ordering still use the marker/latest tuples and the §3 request-start sequence
rather than `updated_at`. Batch the
post insert, mention mappings, and author's marker upsert so an author who just submitted through
the visible composer has read through their own new post without incorrectly absorbing a concurrent
newer post. Preserve the existing audit and author-only rules.

## 2. API and server read-state service

Add a focused server module (for example
`portal/workers/app/src/lib/notice-board-read-state.ts`) rather than embedding raw marker SQL in
the route. It owns:

- the conditional upsert above;
- authoritative latest-post and unread-count queries using the same `(created_at, id)` tuple;
- `getNoticeBoardReadState(db, userId)`; and
- `advanceNoticeBoardReadMarker(db, userId, throughPostId)`.

The response contract is:

```ts
type NoticeBoardReadState = {
  marker: null | {
    throughPostId: string;
    throughCreatedAt: string;
    updatedAt: string;
  };
  latest: null | { postId: string; createdAt: string };
  unreadCount: number;
};
```

With no marker, every surviving post is unread. With a marker, count only tuples greater than the
marker. Edits do not affect order or unread state. Deletes reduce the count of surviving unread
posts but never erase/regress the marker.

Add these routes under the existing gated `noticeBoardRoutes`:

| Method/path | Contract |
|---|---|
| `GET /api/notice-board/read-marker` | Return the current user's authoritative marker/latest/unread state. No write and no mark-on-GET side effect. |
| `PATCH /api/notice-board/read-marker` | Strict body `{ throughPostId: UUID }`; resolve the tuple server-side, apply the monotonic upsert, and return authoritative state. Return `409` with stable code `notice_board_read_target_changed` if the post disappeared. |

Register byte-identical bare and trailing-slash forms for both methods. This follows the current
Hono exact-route rule and defends byte-identical API behavior against a permissive fallback; the
existing `/notice-board` and `/notice-board/*` capability middleware remains present for both forms.
Add all four registrations to
`PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED` in `terminal-route.ts` as `withheld`, matching every
existing staff Notice Board route, and update the route-count/security-contract tests.

Use `PATCH`, matching the project-comment read-marker resource. Do not fold marker advancement into
`GET /posts`: a collapsed panel needs cheap unread state without fetching content, and a side-effecting
GET would make it impossible to enforce visible-presentation proof. Keep
`GET /notice-board/posts/latest` for compatibility during this tracer bullet, but remove it from
the frontend polling path; deletion can be considered only after a later caller audit.

Both routes inherit `requireCapability("viewNoticeBoard")`. Add route tests showing Admin,
internal Editor, and Photographer access where their current capabilities allow it; unauthenticated,
inactive, and `external_editor` principals remain denied by the existing middleware. Register no
new broad middleware and keep current author-only post mutation tests behaviorally unchanged,
adapted only for the new `{ post, readState }` response envelope.

The PATCH executes a D1 batch in project-comment style: target existence read, guarded upsert,
then authoritative marker/latest/unread reads. An equal/older target is a successful idempotent
`200` and does not change `updated_at`; only an absent target is `409`.

Change the existing post-create and post-edit server contracts from a bare serialized post to
`{ post: NoticePost, readState: NoticeBoardReadState }`. The create batch's authoritative reads run
after its author-marker upsert; edit returns the current authoritative state without advancing it.
This envelope is the mandatory mutation contract consumed by the fenced client settlement in §3.

## 3. Frontend freshness, presentation, and drafts

Create a narrow Notice Board query module (for example
`portal/apps/web/src/lib/notice-board-data.ts`) using the existing `QuincyQueryProvider`; do not
create another client, persistence layer, or event bus. Give posts and read state separate exact
keys. Use the shipped 30-second visible interval, focus/reconnect behavior, AbortSignal forwarding,
and retry policy:

- read-state polling remains enabled while the Notice Board component is mounted, including while
  collapsed, so the badge learns about another device's post/read action without reload;
- posts polling is enabled only while the panel is open; and
- ordinary interval polling pauses while `document.visibilityState === "hidden"` through the
  existing TanStack focus/online machinery.

`NoticeBoard.tsx` stops reading/writing `SEEN_KEY_PREFIX`, removes `seenId`, `latestId`,
`markSeen()`, and the bespoke expanded/collapsed timers, and derives `hasUnread` solely from the
authoritative read-state query (`unreadCount > 0`). It retains `COLLAPSE_KEY` and its current
StrictMode-safe “persist only after an actual toggle” behavior. Do not migrate collapse state: it
is a device-local UI preference, not shared domain state.

Mirror — but deliberately do **not** copy verbatim — the response-order fence in
`portal/apps/web/src/lib/project-comments.ts`'s `commitProjectCommentReadState()` /
`freshestReadState()`. The shipped project-comment rule accepts a differing `latest` only when the
incoming tuple is lexicographically newer, and that rule cannot represent the legitimate head
regression this plan's own deletion contract requires: deleting the newest post leaves the marker
unchanged and moves the authoritative `latest` back to an older surviving post (§2). Under the
shipped rule the deleting tab's own refetch and every other device's later poll would be rejected,
and because a subsequent qualifying PATCH through the surviving head is an idempotent no-op that
returns the same regressed snapshot, a deleted head and a stale unread badge could persist until an
unrelated new post arrives or the cache is dropped — reading the board would not clear it. TB7
therefore specifies this ordering contract explicitly:

1. Allocate a monotonic per-client request-start sequence **immediately before dispatching** every
   read-state-bearing request — read-state GET, create, edit, and the post-delete refetch — never
   when its response settles. Store the accepted sequence alongside the cached snapshot.
2. The marker tuple `(throughCreatedAt, throughPostId)` is server-monotonic and never regresses;
   reject any incoming snapshot whose marker tuple is older, whatever its sequence.
3. When marker tuples are equal, accept the incoming snapshot only if its request-start sequence
   is greater than or equal to the accepted sequence of the cached snapshot. Apply this uniformly
   whether `latest` is newer, equal, or older.

Rule 3 is uniform because, once deletions can regress `latest`, tuple order alone cannot distinguish
a genuinely advanced server head from a stale pre-deletion response. A slow GET started before a
newer PATCH or poll therefore cannot resurrect stale unread UI, while a legitimate newer post from
that older-started response may wait for the next qualifying visible poll. The worst case is bounded
staleness that self-heals on that poll, not a permanently stuck badge. `updatedAt` is never the client
ordering key, and `unreadCount` is never compared directly.

The same latent hazard exists in the shipped project-comment implementation. TB7 does not modify
`project-comments.ts`; record the equivalent project-comment fix as separate follow-up work in
`docs/todo.md` rather than widening this tracer bullet.

### Fetched is not presented

Use a compact Notice Board-specific presentation boundary. The newest-post surface is eligible only
while all are true:

1. the panel is open;
2. `document.visibilityState === "visible"`;
3. the shared TanStack `focusManager.isFocused()` is true; and
4. the actual newest rendered post element (or, for the empty state, the posts container's
   non-zero-area top surface) intersects the viewport with positive area.

Observe that concrete surface with `IntersectionObserver`, with a small real-geometry fallback and
a synchronous geometry recheck before PATCH. Keep focus/visibility refs, one presentation
generation, and one fresh-fetch-attempt token, following the client-side
`portal/apps/web/src/lib/project-comments.ts` pattern without its pagination, route, or custom
scroll-root apparatus. The attempt must start and finish in the same eligible generation, its head
must remain current, and eligibility must still hold immediately before PATCH. Each false-to-true
transition forces one fresh list request; closing, hiding, losing shared focus, scrolling the newest
surface away, principal change, or unmount invalidates the generation. Cached or failed data never
proves presentation, and a `409` refetches posts/read state without advancing from stale data.

POST create and PATCH edit return the explicit mutation envelope
`{ post: NoticePost, readState: NoticeBoardReadState }`. Create returns the author's authoritative
state after the atomic author-marker advance; edit returns authoritative state after the edit batch
without changing the marker. The client settles both exact query keys from that one response through
the same response-order fence, avoiding a second race-prone round trip and giving the current tab an
immediate coherent snapshot. Delete invalidates/refetches the exact posts/read-state keys because its
surviving unread count may change. No mutation issues a blind “mark latest” write. Other browser
profiles/devices converge within one visible 30-second interval.

Keep `content`, `editingId`, and `editingContent` as component-owned state outside the query cache.
Never key/remount a composer on query status or response identity, never hydrate a currently-active
edit draft from a polling response, and clear a draft only after its own successful create/save (or
explicit Cancel for edit). If the edited post changes remotely, keep the local edit draft and show
the refreshed saved post only after cancel/save resolution; if it is deleted remotely, retain the
draft long enough to report that the target changed rather than silently discarding typed text.

This plan does **not** modify `portal/apps/web/src/components/RichTextEditor.tsx`, its
`editorProps.handleKeyDown`, mention-Enter handling, `onUpdate`, or value-sync logic. Draft
preservation is achieved at the parent/query boundary. Therefore TB7 must not reopen either known
TipTap bug class. If implementation review finds that `RichTextEditor` itself must change, stop and
revise this plan first; that change requires real-browser verification because happy-dom/jsdom is
structurally blind to the documented no-op-transaction timing bug.

## 4. Mention delivery — explicitly out of scope

TB7 preserves the current direct `notifyNoticeBoardMentions()` → `emitNotifications()` behavior and
its existing create/edit mention semantics completely unchanged. Marker work must not touch that
helper, `notification_outbox`, `notification_delivery_ledger`, or the Queue consumer, and read-state
actions must never emit, suppress, or acknowledge mention notifications.

Durable delivery for global, non-project events requires a separately designed global-outbox
capability. Record that descriptively as possible future TB7B/global-outbox-prerequisite work; it is
not scheduled, promised, designed, or attempted by this read-state tracer bullet.

## 5. Build slices

Keep the build to two reviewable slices; do not split UI details into artificial lanes.

1. **Schema and server contract:** migration/schema/journal/migration test; Notice Board read-state
   helper; monotonic post and marker timestamps; author-marker batch; GET/PATCH read-state routes;
   `{ post, readState }` create/edit envelopes; focused Worker tests. Reconfirm the real next
   migration against the production ledger and fold the required `CLAUDE.md`/`AGENTS.md` ledger
   correction into this slice's deploy-time documentation work.
2. **Frontend freshness and preservation:** exact query keys/hooks, presentation-generation proof,
   response-order-fenced read state and mutation settlement, `NoticeBoard.tsx` migration away from
   seen localStorage/timers, parent-owned create/edit drafts, and focused DOM/query tests.
   `COLLAPSE_KEY` remains local.

Each slice must leave existing author/access behavior green. No slice touches `prototype/`, media,
R2, Calendar, project discussion storage, or Notice Board product features outside this plan.

## 6. Test and verification plan

### Migration and server

- Apply the complete pre-0039 migration baseline in the Node SQLite migration test; assert exact
  additive DDL, table shape, PK lookup, cascade on user deletion, marker retention after post
  deletion, foreign-key cleanliness, and no destructive/backfill SQL.
- Prove initial empty state, no-marker unread count, latest tuple, monotonic advancement, equal/older
  idempotent no-op with unchanged `updated_at`, and missing/deleted target `409`.
- Freeze/precompute the clock and create lexically lower UUID posts in concurrent-request ordering,
  then after deletion of a marker target; the timestamp allocator must preserve strict ordering and
  make each later post unread. Treat these as invariant tests, not simulations of common human
  timing. Add a concurrent-newer-post case proving an author's own create marker does not clear
  someone else's newer post. Prove successful marker advances allocate monotonic `updated_at`, while
  equal/older no-ops leave it unchanged.
- Prove edits do not change order/read state and deletes reduce only surviving unread count.
- Exercise GET/PATCH capability gating, including unauthenticated/inactive denial and explicit
  External Editor denial; retain Admin/Editor/Photographer allowed-role coverage and current
  author-only edit/delete assertions. Prove bare and trailing-slash GET/PATCH forms are
  byte-equivalent and pass through the same capability boundary.
- Preserve existing rich-text normalization, mention eligibility, audit, direct create/edit mention
  source-key, and delivery tests behaviorally unchanged (adapted only for the response envelope
  where a test unwraps a mutation response). Prove no marker action creates a notification or
  outbox row, and add no global-outbox/Queue tests to TB7.

### Client

- Expanded/open, visible, focused, intersecting fresh fetch advances through its returned head;
  initial cached data alone does not.
- Collapsed polling updates `unreadCount`/badge but never PATCHes; expanded polling in a hidden tab,
  unfocused shared focus state, or off-viewport panel never PATCHes. Returning to a qualifying
  presentation forces a fresh fetch before PATCH.
- Reverse old/new posts-fetch completions and change eligibility mid-request; only the current
  successful presentation generation may advance. Separately reverse a read-state GET/PATCH
  completion (including equal-tuples/different-sequence and a newer-marker case): the older-started
  GET must not overwrite the PATCH or fresher device snapshot. Failed list fetch, failed PATCH, and
  target-changed `409` preserve unread state and recover on a later eligible fetch.
- Prove the deletion-regression cases the §3 ordering contract exists for: deleting the newest post
  locally, and observing another device's head deletion on a later poll, must both commit the
  server's regressed `latest`/`unreadCount` under an unchanged marker and clear a now-stale badge —
  including the case where a qualifying PATCH through the surviving head returns an idempotent
  no-op snapshot. Also prove that an older-started GET carrying a pre-deletion (older-sequence)
  snapshot still loses to the newer accepted snapshot, so regression acceptance does not reopen the
  resurrection hole. Sequences must be allocated at dispatch: assert a mutation started before, and
  one started after, competing polling responses settle correctly.
- Prove create/edit mutation envelopes settle both posts and read-state caches through the same
  response-order fence without a follow-up read-state request; delete refetches both exact keys.
- A new notice appears without reload while expanded, and produces an unread badge without reload
  while collapsed. A marker written on device A is reflected on device B's next visible read-state
  poll/focus refresh.
- Composer and author edit drafts, selection/editor identity, open state, and error copy survive
  posts/read-state polling, focus refresh, mutation settle, and transient errors. Success clears
  only the draft that was submitted; failure retains it.
- Only `quincy:dashboard:noticeboard:v2` is read/written. No
  `quincy:dashboard:noticeboard:seen:*` read/write/removal remains, and existing values are left
  harmlessly untouched rather than treated as migration authority.
- Existing rich-text, byte-limit, keyboard mention selection, Cmd/Ctrl+Enter, author controls,
  Dashboard capability gate, StrictMode collapse persistence, and responsive tests remain green.

The implementation phase runs the repository's full `CLAUDE.md` verification gate from `portal/`:
typecheck, web build, all workspace tests, and the separately invoked shared Vitest suite. This
planning pass intentionally runs none of them. Automated tests do not replace a real-browser pass
for viewport/focus/poll timing or editor transaction behavior.

### Manual QA

Use the sanctioned authenticated-browser QA path after implementation. With one internal user on
two browser profiles/devices:

1. read a notice visibly on device A and confirm device B clears its badge on its next visible
   read-state refresh without reload;
2. create a notice from the other device while the observer is collapsed, open but backgrounded,
   and open but scrolled away; each must remain unread until a fresh fetch completes while visibly
   presented;
3. leave the panel visibly open and confirm the new notice arrives within one 30-second interval;
4. type both a new-post draft and an edit draft across polling/focus cycles and a simulated
   transient request failure; confirm exact content remains and mention Enter/Cmd/Ctrl+Enter still
   behaves correctly;
5. verify desktop and phone open/collapsed layout, badge, keyboard focus, scroll visibility, and
   touch behavior; and
6. verify Admin/Editor/Photographer access as currently authorized, author-only mutation, and no
   External Editor Notice Board navigation or direct API access.

## 7. Acceptance criteria

TB7 is accepted only when all of the following hold:

- **Two-device read state:** D1 is authoritative per user; device A's marker is observed by device B
  without copying browser storage.
- **Hidden/background semantics:** collapsed, hidden, unfocused, off-viewport, cached, failed, or
  stale fetches never clear unread state; a same-generation fresh visible fetch does.
- **New notice without reload:** visible expanded posts and collapsed unread badge converge within
  the documented polling/focus bounds.
- **Mention delivery:** current direct create/edit mention delivery and its tests are preserved
  unchanged; TB7 introduces no global outbox, delivery-ledger, Queue-consumer, or Admin-operation
  work, and durable global delivery remains separate unscheduled future work.
- **Author/access rules:** rich text/mentions and author-only edit/delete are unchanged;
  `viewNoticeBoard` remains the server and UI boundary; External Editors remain excluded.
- **Drafts:** post and edit drafts survive polling/refetch/error paths and clear only on their own
  success or explicit cancel. `RichTextEditor.tsx` remains untouched unless a revised plan and
  real-browser verification are approved.
- **Desktop/phone:** disclosure, badge, viewport eligibility, focus, scroll, and touch behavior are
  usable at both sizes.
- **Full gate/manual QA:** migration proof, server/client suites, full repository verification, and
  authenticated manual matrix are recorded before deploy.

## 8. Deployment and rollback

Before migration, verify `0039` is still next against the migration directory, journal, and live D1
migration ledger; do not infer production application from repository docs alone. Specifically
reconfirm that `0038_project_activity_feed_index.sql` is production-applied. If another branch has
claimed `0039`, renumber all TB7 migration artifacts together. Create the production recovery export
and record its path/hash, then apply the reviewed additive migration before deploying the app Worker
that queries it. Only the app Worker changes (it bundles the web build); background and
webhook-ingress are not redeployed.

After `0039` is confirmed applied, update the root `CLAUDE.md` migration ledger and its
verbatim-mirrored `AGENTS.md` line together: add the verified production details for both `0038` and
`0039`, and name the then-next available number. This correction is required deploy-time
documentation maintenance, not an assumption made by this draft.

This plan deliberately performs no localStorage backfill: the server begins with no marker, so
existing notices are unread until first qualifying visible presentation. Treating any one browser's
local value as user authority would be unsafe.

As this plan's additive-migration rollback decision, application rollback restores the prior app
Worker but leaves the marker table and rows in place. Old code ignores the table and resumes local
seen state, while a fix-forward can redeploy TB7 without losing markers. Additive compatibility
makes dropping the table or rewriting rows both unnecessary and riskier. After successful deploy
and passive production verification, update this status with commit/version evidence and move the
plan to `docs/plans/implemented/` only when it matches what is live.
