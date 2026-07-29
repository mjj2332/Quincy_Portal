# Dashboard Notice Board — Plan

## Amendment (2026-07-28) — default to visible (expanded), not collapsed

**Status: BUILT, verified, committed (`3da5b31`), and DEPLOYED to production (2026-07-28).**
Terra-APPROVED after 9 plan-review rounds before build. The base feature below is already built,
verified, and live in production. **Scope, corrected after this amendment's own review process
found it larger than first framed**: changes the panel's default open/closed state on first visit,
**plus** the
`localStorage` persistence logic (fixing a real pre-existing mount-write bug that would otherwise
make the default-flip invisible to almost every real user) **and** the storage key name itself (the
old key is abandoned, not migrated). Nothing about the schema, API, capability, or polling
mechanism itself changes — only how/when the collapse preference is read, written, and keyed.

**User request**: the notice board should be visible (expanded) by default, not collapsed.

**Current state (verified against the live code, not assumed)**:
`NoticeBoard.tsx:24` — `function readOpen(): boolean { return readStorage(COLLAPSE_KEY) === "true"; }`
— on first visit (no `localStorage` entry yet, or storage disabled/blocked) this returns `false`
(collapsed), matching the original plan's explicit design choice ("Default **collapsed** — this is
a secondary, ambient feature; it shouldn't compete with the primary project list for attention on
load"). That design reasoning is being explicitly overridden by this amendment, not reinterpreted.

**A second, more serious pre-existing bug found in round 4 of this amendment's own review — this
is why "just flip the default" isn't a one-line change after all.** The persistence effect
(`NoticeBoard.tsx:53-55`):

```ts
useEffect(() => {
  try { window.localStorage.setItem(COLLAPSE_KEY, String(open)); } catch { /* ... */ }
}, [open]);
```

fires unconditionally on **every** mount, not only after a genuine toggle click — React always runs
an effect once after the component's first commit, regardless of whether `open` "changed" from
some prior value (there is no prior value on first mount). So on the very first render, this effect
immediately writes back whatever `open`'s *initial* value was (today, `false`, since that's the
current default) — meaning **merely loading the dashboard, with zero interaction, already writes an
explicit `"false"` to storage today.** Given this feature has been live in production, that almost
certainly means **every admin/editor (the only roles the `viewNoticeBoard` capability grants this
panel to — photographers never render it at all) who has loaded the dashboard even once already
has `"false"`
stored for them right now** — not because they chose to collapse it, but as an unconditional side
effect of the component simply rendering. Under a read-side-only fix (`!== "false"`), this
already-stored `"false"` would be indistinguishable from a genuine explicit collapse, and the panel
would **stay collapsed for essentially every existing user** — the amendment would only visibly
change anything for a browser that has *never once* rendered this component, which in practice is
close to nobody. A read-only fix would ship and appear to do nothing.

**Root-cause fix, not a workaround — two parts:**

1. **Stop writing to storage on mount.** Only persist `open` when it changes as a result of a real
   user action (the toggle), not as a side effect of every render. Track whether the effect has run
   before with a ref, and skip the very first invocation:
   ```ts
   const lastPersisted = useRef(open); // whatever `open` was on this render's first pass
   useEffect(() => {
     if (lastPersisted.current === open) return; // nothing actually changed since we last wrote
     lastPersisted.current = open;
     try { window.localStorage.setItem(COLLAPSE_KEY, String(open)); } catch { /* ... */ }
   }, [open]);
   ```
   **Corrected per Terra round 4, which found a real flaw in an earlier `hasMounted`-boolean version
   of this fix**: this app renders under `<StrictMode>` (`apps/web/src/main.tsx:1,13`), which in
   development deliberately re-runs a freshly-mounted component's effects a second time (render →
   effects → cleanup → render → effects again) against the *same* component instance — refs persist
   across that replay, they are not reset. A simple `hasMounted` boolean would already read `true`
   by the second of those two effect runs and incorrectly write on it, defeating the fix in exactly
   the environment (local dev) where the mount-write bug is easiest to reproduce and hardest to
   debug. Comparing against the **last value actually written** instead of a boolean is immune to
   this: `open` itself doesn't change between StrictMode's replayed effect runs, so the comparison
   correctly no-ops both times regardless of how many times the effect happens to fire for the same
   value — it only ever writes when `open` has genuinely changed since the last write, which can
   only happen via a real `setOpen` call from the toggle. This is a genuine bug fix independent of
   the default-flip — the original design never needed to write on mount (nothing changed), and
   doing so anyway is what created the "everyone already has an accidental `false`" problem. Fixing
   it here, in the same build, because the default-flip is not correctly deliverable without it —
   not a separate, out-of-scope cleanup.
2. **Retire the old storage key.** Fixing (1) alone doesn't undo what's *already* been written by
   the buggy version currently live — a browser with an accidental `"false"` from today would still
   read it as genuine and stay collapsed. Rename the storage key (e.g.
   `quincy:dashboard:noticeboard` → `quincy:dashboard:noticeboard:v2`), so every browser — with or
   without prior accidental state — starts genuinely fresh under the corrected default and the
   corrected (mount-write-free) persistence logic. `readOpen()` itself stays the simple inversion
   proposed originally, just pointed at the new key:
   ```ts
   const COLLAPSE_KEY = "quincy:dashboard:noticeboard:v2";
   function readOpen(): boolean { return readStorage(COLLAPSE_KEY) !== "false"; }
   ```
   The old key is simply abandoned (not read, not migrated, not deleted) — matching this codebase's
   own stated preference for simple, non-speculative fixes over new migration machinery for a
   client-side preference this low-stakes. **This is the one part of this amendment that discards
   state** (any already-stored collapse/expand preference, accidental or genuine) — named explicitly
   as a deliberate, scoped exception, not a silent side effect. **The asymmetry worth naming, per
   Terra round 4's review**: because the live buggy default was `false`, an old stored `"false"` is
   *inherently ambiguous* (could be the mount-write bug, could be a genuine collapse — no way to
   tell from the stored value alone), while an old stored `"true"` is more likely to represent a
   real, deliberate click (nobody would end up with `"true"` by accident under the current bug). A
   more conservative design could selectively preserve old `"true"` values while still abandoning
   old `"false"` ones — Terra's own assessment is that the simpler "abandon everything under the old
   key" rule is still acceptable given how young this feature is, but it *is* a real, asymmetric
   tradeoff, not a clean "nothing of value is lost" situation, and is recorded as a considered
   choice rather than an overlooked one. Reasonable specifically because of how recently the feature
   shipped — revisit the selective-preservation option if this pattern (a persisted UI preference
   needing a fast-follow default change) recurs on a feature that's been live longer.

**Edge case, unaffected by the above**: the comparison `!== "false"` still treats any value other
than the literal string `"false"` as open — including a hypothetically malformed/corrupted stored
value, not just "missing." In practice, once (1) is fixed, this key is only ever written by a
genuine `setOpen` call (`String(open)` on a boolean), so only ever literally `"true"` or `"false"`
— a third value should never occur, but if one somehow did, it's treated the same as missing
(open), not preserved as some third state.

**This preference is browser-wide, not per-user** (unlike the seen-cursor below) — corrected per
Terra review, which found "first-time account/session" imprecise: `COLLAPSE_KEY` (under its new
name) still carries no user-id suffix, so a second staff account signing in on a browser where
someone already interacted with the panel inherits *that* browser's stored preference, not a fresh
default. This is pre-existing, unaffected behavior of the collapse key, not a new sharing concern
this amendment introduces.

**Consequences worth naming explicitly, not glossing over**:
- Because of the key rename (above), **every browser** — not just ones that genuinely never
  rendered the component — sees the open default after this ships, including staff who already
  have an accidental `"false"` under the old key from today's mount-write bug. This is the intended
  effect of the fix, restated here because it changes what "who sees the new default" means
  compared to this amendment's earlier drafts.
- The **full-list poll** (`EXPANDED_POLL_MS = 25_000`, the more frequent of the two poll intervals)
  is now what everyone experiences on their next dashboard load by default, instead of the slower
  `COLLAPSED_POLL_MS = 60_000` "latest post" check. This is a direct, intended consequence of
  "visible by default" (you can't show the list without fetching it) — flagged here so it's a
  known, accepted tradeoff rather than a silent side effect. **Quantified, per Terra round 4's
  review, which found "marginal" understated it**: 25s polling is roughly 2.4× the request
  frequency of 60s polling, and each of those requests fetches the full post list (larger response
  payload) rather than the single-row "latest" check — a real, not negligible, increase in ambient
  request volume for every open dashboard tab, not just a rounding-error difference. Still judged
  acceptable given this studio's staff-only, small-team scale and request volumes already normal
  elsewhere in this codebase (5s polling on other screens), but stated in real terms rather than
  hand-waved.
- **The initial expanded-state fetch also advances the seen-cursor** (`NoticeBoard.tsx`'s
  `loadPosts`, which calls `markSeen(newestId)` on every successful list fetch, per the base
  plan's own cursor-advancement design) — so on next load, the newest existing post is marked
  "seen" immediately as a consequence of the panel opening and successfully fetching, before the
  person has necessarily read it. This is very likely the intended/reasonable behavior (the post
  genuinely is on screen, visible, the moment the panel opens — "seen" in the literal sense) rather
  than a bug, but it's a real, direct behavioral consequence of defaulting to open that the base
  plan's cursor design never had to consider (previously, marking-seen only ever happened after a
  person *deliberately* expanded the panel). Not changing the cursor logic itself (out of scope,
  see below) — just naming this consequence so it's a documented, accepted outcome rather than an
  unnoticed one.

**Explicitly out of scope for this amendment**: no change to the unread-badge logic, the
cursor-advancement rules themselves, the poll intervals, the API routes, or the `viewNoticeBoard`
capability gate. The persistence-effect mount-write fix and the storage-key rename **are** in scope
— found to be necessary to actually deliver the requested default-flip, not optional cleanups —
see above for why a pure read-side change alone would not have worked.

**Testing requirements for this amendment's build**:
1. **Core regression test for the mount-write bug itself, the most important case in this
   amendment**: mounting `<NoticeBoard>` with no stored preference must **not** call
   `localStorage.setItem` for the *collapse* key specifically. **Scope this precisely, per Terra
   round 4's review**: don't assert "no `setItem` calls at all" — the initial expanded-state fetch
   legitimately calls `markSeen(...)`, which writes the separate per-user seen-cursor key
   (`SEEN_KEY_PREFIX`), and that write is correct, expected behavior, not a regression. Spy on
   `localStorage.setItem` and filter/assert specifically on calls whose key is the collapse key
   (`quincy:dashboard:noticeboard:v2`) — there should be zero on mount, then exactly one after a
   toggle click. This is the test that would have caught the original bug and must not regress;
   without it, the default-flip could silently break again the same way in the future. **Render
   under `<StrictMode>` for this specific test** (per Terra round 4's finding that a boolean
   `hasMounted` guard would pass under a plain render but fail under React's real double-invoke
   behavior) — this is the test that actually proves the `lastPersisted`-comparison fix (not a
   `hasMounted` boolean) is necessary, not just sufficient-looking.
2. `apps/web` (`NoticeBoard.dom.test.tsx`): the existing test
   "starts collapsed, persists the toggle, and switches polling modes without overlap" needs
   rewriting to match the new default and the renamed key — starts **expanded** with no stored
   preference under `quincy:dashboard:noticeboard:v2` (asserting `aria-expanded="true"` and the
   full-list poll firing, not the collapsed "latest" poll); collapsing it via the toggle persists
   `"false"` under the new key and switches to the collapsed poll; a remount after an explicit
   collapse stays collapsed (persistence still works in the closed direction, and only because of
   a real toggle click, per test 1 above — not because mounting itself wrote anything).
3. **Key-rename-specific case, replacing the amendment's earlier "explicit stored false" scenario**
   (which no longer applies the same way once the key is renamed): a browser with `"false"` already
   stored under the **old** key name (`quincy:dashboard:noticeboard`, nothing under the new
   `:v2` name) — simulating exactly the accidental-`"false"`-from-the-mount-write-bug state that's
   expected to exist on real staff browsers right now — still defaults to **expanded**. **Also
   assert the old key is left untouched (not read, not written, not cleared)**, per Terra round
   4's refinement — proves the old key is genuinely abandoned outright, not silently consulted as
   a fallback or migrated-then-deleted.
4. **Four existing tests, not two, implicitly depend on the old key name and/or the old
   collapsed-by-default behavior — expanded per Terra round 4's review, which found the amendment's
   own list incomplete**: `"shows unread activity from the collapsed latest cursor"` and `"keeps a
   stale unread badge when the fresh expand fetch fails"` rely on mounting with no stored
   preference to land in the *collapsed* state they're actually testing — each needs an explicit
   `window.localStorage.setItem("quincy:dashboard:noticeboard:v2", "false")` added to their setup
   (using the new key name) so they keep testing collapsed-state behavior regardless of the new
   default. Separately, `"marks messages seen on a successful expanded list tick before
   collapsing"` and `"scopes the seen cursor per account and only offers author deletes"` both
   already set the collapse key to `"true"` in their setup to force the expanded state they need —
   both need that call updated to the new key name (`quincy:dashboard:noticeboard:v2`), and should
   keep setting it explicitly to `"true"` (matching Terra's recommendation) rather than relying on
   the new default, so these tests keep proving their own intent — "expanded because we asked for
   it" — rather than merely passing because expanded now happens to be the default anyway. Without
   any of these four fixes, each test would silently start exercising the wrong code path (or, for
   the two `"true"`-setting tests, silently pass for a coincidental reason instead of the one they
   were written to prove) once the default and the key name both change.

**Routing**: contained to one file (`NoticeBoard.tsx`, plus its test file) — but fixes a genuine
pre-existing bug, changes a storage key, and changes default behavior for every dashboard visit,
discovered to be meaningfully larger than "one line" through this amendment's own review process.
Terra plan review at normal effort, then (once approved and the user authorizes) build directly
in-session, verify visually in a browser (including confirming the mount-write fix actually holds
under `<StrictMode>` in a real dev-server load, not just in tests), Terra diff review, §5 gate,
then commit/deploy.

---

**Status: BUILT, verified, committed (`dcc3213`), and DEPLOYED to production (2026-07-28).** Plan
approved by Terra (round 3, plus a focused capability-gating delta round). Built by Terra
(normal-feature routing). Full verify sequence green on the first real run (typecheck, `apps/web`
build, all four workspace test suites plus the separately-invoked `packages/shared` suite) — no
bugs found, independently re-verified outside the build's own sandbox (which couldn't run the
Cloudflare Worker integration suite). Terra diff review (fresh context) **APPROVED on first pass**.
Migration `0018` (`notice_board_posts`) applied to prod. **This base feature is live** — see the
"Amendment (2026-07-28)" section at the top of this doc for the currently-in-planning follow-up
change to its default open/closed behavior, not yet built.

User request: a collapsible panel on the dashboard where staff can post messages to each other,
like a lightweight chat box.

## Current state (verified against the code, not assumed)

- **No message-board or chat concept exists anywhere in this codebase.** The closest analog is
  `comments`/`annotations` (`schema.ts`, `annotationsRoutes` at
  `workers/app/src/routes/annotations.ts`), but those are asset-scoped review feedback, not a
  general staff message board — a different table, not an extension of that one.
- **No existing collapsible-panel component.** `Topbar.tsx`'s mobile nav menu
  (trigger button + menu markup at `Topbar.tsx:160-163`; line numbers re-verified 2026-07-28 round
  7 — the Notifications feature added state/hooks to this file after this section was first
  written, shifting every earlier line reference) is the one bespoke disclosure pattern in this
  codebase, but it's a **menu** (an overlay: `useId()`-linked `aria-controls`/`aria-expanded`,
  `Escape`-to-close at `Topbar.tsx:49-59` — corrected per Terra round 2: this handler does *not*
  actually trap `Tab` focus inside the menu, so "focus-trap" in the round-1 wording overstated
  what it does; the conclusion not to copy its semantics stands, only this factual description
  needed fixing) — the panel here isn't an overlay and shouldn't copy menu-specific interaction
  semantics wholesale regardless. What this plan actually
  reuses from it is narrower: the `useState` open/closed pattern and `useId()`-linked
  `aria-controls`/`aria-expanded` for accessibility. The board panel itself is a plain inline
  disclosure (a toggle `<button aria-expanded={open} aria-controls={panelId}>` next to an
  always-in-document-flow region that grows/shrinks) — no focus trap, no `Escape` handler, no
  outside-click dismissal, since collapsing it isn't the same interaction as closing an overlay.
- **`Dashboard.tsx`'s view-preference pattern** (`view` state persisted via
  `initializeDashboardView({ read: () => window.localStorage.getItem("quincy:dashboard:view"),
  write: ... })` at `Dashboard.tsx:111-113`, re-written on selection at `Dashboard.tsx:166`; line
  numbers re-verified 2026-07-28 round 7) is the direct precedent for persisting the panel's
  collapsed/expanded state across visits.
- **Every near-real-time behavior in this codebase is polling, not push** (confirmed again while
  researching the Notifications plan) — no shared `usePolling` hook exists; each screen
  reimplements a `setInterval`. This plan follows the same pattern rather than introducing new
  infrastructure.
- **Comment/annotation delete is author-only, no admin exemption**, per this repo's own
  convention (`CLAUDE.md`: "for audit integrity") and confirmed in code
  (`annotationsRoutes.delete("/comments/:id")`, `annotations.ts:161-179` (re-verified 2026-07-28
  round 8):
  `if (comment.authorId !== c.get("user").id) return c.json({ error: "Forbidden..." }, 403)`,
  no role bypass). This plan follows the same convention for board posts.
- **Content-mutating routes in this codebase write an `audit()` call** (`lib/audit.ts`, used at
  every content route touched during this session's research) — board post create/delete follow
  suit. Narrowed 2026-07-28 round 7: the original "every mutation" phrasing overclaimed —
  `workers/app/src/routes/notifications.ts`'s `POST /notifications/:id/read` and
  `POST /notifications/read-all` are mutations with no `audit()` call, since marking a
  notification read isn't user-generated content and has no deletion/audit-integrity concern.
  Board posts are user-authored content subject to author-only delete, so they follow the
  content-mutation convention, not the read-state exception.

## Design

### 1. Schema (migration number: **historical planning note, now moot** — this section originally
reasoned about "0018 or 0019 depending on build order" before either this plan or
`Kanban-Priority-And-Manual-Ordering-Plan.md` had built. In fact this plan built and used `0018`;
`0018`-`0020` are now all applied to prod (`0020` fixed post-deploy, see that plan's own doc and
`docs/lessons.md`); next available is `0021`. Kept here for provenance, not as current guidance —
if this doc is ever used as a template for reasoning about a future migration number, confirm
against `packages/db/migrations/meta/_journal.json` directly, don't reuse any number mentioned in
this historical section)

```ts
// packages/db/src/schema.ts
export const noticeBoardPosts = sqliteTable(
  "notice_board_posts",
  {
    id: id(),
    authorId: text("author_id").notNull().references(() => user.id), // no onDelete: "cascade" —
    // corrected after Terra round 1: `comments.authorId` (schema.ts:708-710, re-verified
    // 2026-07-28 round 8) references `user.id`
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

**Open question, raised by Terra round 1 — RESOLVED by the user, 2026-07-28**: is this board meant
to be a single global stream (no `projectId`, as designed above), or should posts optionally
attach to a project? **User confirmed: global, no `projectId`** — matching the design above.

**New requirement from the same 2026-07-28 confirmation, not present in Terra's round-3
approval**: the board is visible to **admin and editor only — photographers must not see or
access it at all**, front or back end. The user framed the feature as a staff notice board, not a
chat box, and was explicit that photographers are excluded. This needs a dedicated capability
(see §1a and §2 below) rather than the "any authenticated user" access Terra approved in round 3.
Delete was also reconfirmed as author-only, no admin exemption — this matches what the plan
already specified (see §2's `DELETE` route and "Explicitly out of scope" below); no change needed
there.

### 1a. Capability (`packages/shared/src/capabilities.ts`)

New capability `viewNoticeBoard`, added to `CAPABILITIES` and granted to `admin` and `editor`
only — **not** added to `photographer`'s list. This follows the existing pattern used for
`viewAllProjects` (also admin+editor, not photographer) rather than overloading an unrelated
existing capability; the notice board is its own concern and deserves its own named permission,
matching how every other capability in this file maps to one concern. Backend gates the whole
router on it — **both**
`noticeBoardRoutes.use("/notice-board", requireCapability("viewNoticeBoard"))` **and**
`noticeBoardRoutes.use("/notice-board/*", requireCapability("viewNoticeBoard"))`, matching the
exact two-line pattern at `users.ts:15-17` (corrected after this delta's Terra review, 2026-07-28:
the bare, non-wildcard form alone doesn't cover descendant routes like `/posts` — a photographer
would 403 on `/notice-board` itself but not on the actual endpoints underneath it). Skipping this
would be the mirror image of this repo's own documented Hono gotcha in `CLAUDE.md` (mounting only
`"*"` leaks middleware onto siblings; mounting only the bare path leaves descendants ungated —
both lines are required, not either/or). Rather than gating each route individually, this
whole-router gate means a photographer gets a 403 on every notice-board endpoint, including
`POST`/`DELETE`, not just a hidden `GET`. Frontend gates rendering of `<NoticeBoard />` in
`Dashboard.tsx` on `useCapabilities().can("viewNoticeBoard")`, matching the `canMoveStages`
pattern already at `Dashboard.tsx:104` (line re-verified 2026-07-28 round 7; both capability
checks — `canMoveStages` and the now-shipped `canViewNoticeBoard` — sit together at
`Dashboard.tsx:104,107`).

### 2. API (`workers/app/src/routes/notice-board.ts`, new file, same shape as `annotations.ts`'s
comment routes)

- `GET /api/notice-board/posts?limit=50` — most recent posts, newest first. **Server validates the
  requested limit properly** (corrected per Terra round 2: the round-1 fix,
  `Math.min(Number(query.limit) || 50, 50)`, doesn't reject negative or fractional input —
  `Number("-5") || 50` still yields `-5`. Use this repo's existing Zod query-validation pattern
  instead, matching `admin.ts:148`'s `optionalQuery(z.coerce.number().int().min(1).max(200))`
  (the shared `optionalQuery` helper itself is defined at `admin.ts:21`; line numbers re-verified
  2026-07-28 round 7 — the round-1/round-2 citation of `admin.ts:107` no longer matches this
  pattern, since later admin-route additions shifted it):
  `optionalQuery(z.coerce.number().int().min(1).max(50))`, defaulting to 50 when absent, `400` on
  an invalid value rather than silently coercing it). Ordered `ORDER BY created_at DESC, id DESC`
  — the explicit `id` tie-break (raised by round 1) makes ordering deterministic for posts
  created in the same millisecond, rather than leaving SQLite's tie order unspecified. Response
  shape:
  ```ts
  { posts: { id: string; authorId: string; authorName: string; body: string; createdAt: string }[] }
  ```
  **Gated on `viewNoticeBoard` (corrected 2026-07-28 — the user confirmed this board excludes
  photographers, unlike the notifications API this originally matched reasoning against). See
  §1a.**
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
  planning blocker). **Rendered only when `useCapabilities().can("viewNoticeBoard")` is true**
  (added 2026-07-28 — see §1a); photographers get no `<NoticeBoard />` in the tree at all, not
  just a hidden one, since the backend also 403s them.
- **Current-user wiring** (added per Terra round 1, which found `Dashboard` currently receives no
  user data at all — `App.tsx` renders it as bare `<Dashboard />`): thread a `currentUserId`
  prop down the same way `Shell` already does for `Admin` (`App.tsx`: `<Admin
  currentUserId={user.id} />`) — change `<Dashboard />` to `<Dashboard currentUserId={user.id} />`
  and have `Dashboard` pass it through to `NoticeBoard`, used to decide which posts show a delete
  control.
- **Collapsed/expanded state**: `useState`, persisted to
  `window.localStorage.getItem("quincy:dashboard:noticeboard")`, same read/write-with-try/catch
  pattern as `Dashboard.tsx:111-113,164-166` (helper: `dashboard-helpers.ts:24-36`'s
  `initializeDashboardView`; re-verified 2026-07-28 round 8 — storage can be disabled by the
  browser). Default
  **collapsed** — this is a secondary, ambient feature; it shouldn't compete with the primary
  project list for attention on load. **Superseded by the "Amendment (2026-07-28)" section at the
  top of this doc**: the storage key is now `quincy:dashboard:noticeboard:v2`, the default is
  **expanded**, and the persistence effect no longer writes on mount (only on a genuine toggle) —
  see the amendment for the full design and the bug it fixes. This paragraph is left as the
  original historical design record, not current behavior.
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
   newest post (and a null id when the board is empty). **A photographer account gets 403 on every
   route (`GET /posts`, `GET /posts/latest`, `POST /posts`, `DELETE /posts/:id`)** — added
   2026-07-28 per the capability gate in §1a/§2. **An editor account succeeds on every route**
   (explicit positive-path test, added per this delta's Terra review — the photographer-denial
   cases alone don't confirm the gate isn't over-broad and blocking editor too).
   **`packages/shared/test/capabilities.test.ts`**: assert `roleHasCapability("admin",
   "viewNoticeBoard")` and `roleHasCapability("editor", "viewNoticeBoard")` are `true`,
   `roleHasCapability("photographer", "viewNoticeBoard")` is `false` — added per this delta's
   Terra review.
2. `apps/web`: collapsed-by-default on first visit, persists the toggle across a remount
   (matching the existing `initializeDashboardView`-style test coverage — **superseded by the
   "Amendment (2026-07-28)" section's own testing requirements, which now specify expanded-by-
   default and the mount-write-free persistence fix; this item is the original historical
   requirement, not the current one**); the slow "latest post"
   poll runs while collapsed and the full-list poll runs while expanded, never both at once (a
   mocked timer confirms the correct one fires in each state); the unread badge appears when
   `latest.id` differs from last-seen; a message arriving **while already expanded** is correctly
   marked seen by the next list-poll tick (collapsing afterward shows no badge); expanding
   correctly clears the badge only after a fresh fetch succeeds, and leaves it showing if that
   fetch fails (no optimistic clear against a stale cached value); the last-seen storage key is
   scoped per `currentUserId` (a second account on the same browser sees its own unread state, not
   the first account's); delete control only rendered when `post.authorId === currentUserId`.
   **A photographer account never renders `<NoticeBoard />` at all** — added 2026-07-28, matching
   the `can("viewNoticeBoard")` gate in §3.

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
