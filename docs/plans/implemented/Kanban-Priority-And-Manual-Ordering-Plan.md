# Kanban Project Priority + Manual Ordering — Plan

**Status: BUILT and verified (2026-07-28) — the sixth and final plan of this batch.** Plan approved
by Terra (round 9). Built by Terra, which confirmed the coordination point with
`Notifications-Plan.md` worked as designed: found `workflows/autohdr.ts:277-279` already guarded
(built immediately before this one) and spliced `boardPosition` into the existing guarded statement
rather than re-adding the guard. Independent verification in this session (the Cloudflare Worker
integration suites Terra's own sandbox couldn't run) passed clean on the first real run — no bugs
found, unlike the two preceding plans in this batch. Terra diff review (fresh context) found one
test-coverage gap on first pass — the `CHECK` constraint was only verified against `node:sqlite`,
not this repo's actual D1/Miniflare test harness — fixed with a proper Miniflare-backed test.
Second-pass diff review **APPROVED**. Full verify sequence green: typecheck (6 workspaces),
`apps/web` build, all five workspace test suites plus the separately-invoked `packages/shared`
suite. Migration `0020`. Not yet committed — awaiting the user's go-ahead. Tied with the sibling
`Notifications-Plan.md` (approved at round 8) for the
deepest review in this batch of 6 plans. Substantially reworked at every round: the writer
inventory kept growing (§3a mandates a build-time exhaustive re-grep rather than trusting this
plan's own enumeration — treat that as a required pre-implementation step); the atomic-write
design changed from a separate statement to a SQL expression spliced into each site's own existing
guarded statement (with a cross-plan coordination point with the sibling `Notifications-Plan.md`
at `workflows/autohdr.ts:277-279` — check which plan builds first); rounds 4-9 progressively found
and fixed two real formula bugs, a missing integer-type check, an unspecified concurrency gap (now
a detect-and-reject 409), an under-specified renumbering safety net, and a subtle contradiction
between that safety net and §3's core "only the edited card changes" guarantee — all now
explicitly reconciled; and — per explicit user decision — the ordering semantics changed from "any
priority edit resorts the whole column" to "a priority edit repositions only the edited card."

Two requested features that both answer the same underlying question — "what order do
projects sit in within a Kanban stage column?" — so they're planned together:

1. A `priority` value (1–10) per project; setting it via an admin dropdown repositions that
   project among its column siblings by descending priority (§3) — `boardPosition`, not `priority`
   directly, is the column's sort key (corrected per Terra round 5, which found this summary still
   described the pre-user-decision "column sorts by priority" design after §3 had already moved to
   single-card repositioning).
2. Manual up/down reordering of projects within a Kanban column, independent of (but
   coexisting with) the priority value — admin can nudge a project's position directly.

Both are scoped **admin-only** per the request ("a dropdown menu for admin to set project
priority", "admin can move projects up and down").

## Current state (verified against the code, not assumed)

- **No ordering field exists on `projects` today.** `packages/db/src/schema.ts:132-166` has no
  `priority` or position column. The only "order" concept in the schema is
  `pipeline_stages.displayOrder` (`schema.ts:110`), which orders the stage *columns*
  themselves, not projects within a column.
- **Kanban column order today is just a filtered slice of the dashboard's global order.**
  `GET /api/projects` (`workers/app/src/routes/projects.ts:126-138`) orders all projects by
  `dashboardProjectOrder` — shoot date descending, nulls last (`projects.ts:28-31`), tie-broken
  by a Unicode-aware street-name collator (`projects.ts:33-51`). `Dashboard.tsx`'s Kanban
  render (`Dashboard.tsx:242-254`) does `filteredProjects.filter(p => p.stageKey === stage.key)`
  — no independent sort. This is also what drives the List view, so it must stay untouched:
  the request is Kanban-only.
- **Drag-and-drop only moves projects *between* stage columns today**, not within one.
  `beginDrag`/`moveProject` (`Dashboard.tsx:147-171`) call `POST /projects/:id/stage`
  (`projects.ts:584-598`), gated by the `selectForEditing` capability (granted to admin *and*
  editor, `capabilities.ts:57,78`) — that capability is deliberately broader than what this
  plan needs, since priority/reorder are admin-only.
- **No existing capability fits admin-only project-priority/ordering.** `editProject` is
  admin-only (`capabilities.ts:48`, absent from `editor`'s list) but semantically covers project
  *field* edits (street, agency, services…) via `PATCH /projects/:id` — reusing it would
  conflate "edit project details" with "reorder the board." `adminBackend` is also admin-only
  but is the admin-*panel* capability (used for archived-view access; `projects.ts:590` checks
  it to gate setting the `editing_autohdr` stage directly, while the separate deactivated-stage
  check is at `projects.ts:594-595` — corrected per Terra round 1, which found the original
  citation conflated the two) — a semantic mismatch for a dashboard-board action. A new, narrow
  capability is the closest fit to this codebase's existing granularity (`selectForEditing`,
  `annotateRaw`, `manageExtras` are all similarly narrow) — confirmed by Terra round 1 as the
  right call over reusing either existing capability.
- **House style for positional/tie-break logic is JS, not SQL** — `orderDashboardStreetTies`
  (`projects.ts:37-51`) already resolves ties in application code rather than a SQL `ORDER BY`
  expression, because D1/Drizzle mis-renders some correlated-subquery SQL (`projects.ts:67-68`
  comment). This plan's board-position logic follows the same precedent.

## Design

### 1. Schema (migration 0018 — next available; 0000–0017 confirmed/in-flight per
`packages/db/migrations/meta/_journal.json`)

```ts
// packages/db/src/schema.ts — add to the `projects` table definition
priority: integer("priority"), // 1-10, nullable — unset means "no priority assigned"
boardPosition: real("board_position").notNull().default(0), // sole Kanban-column sort key
```

**Corrected per Terra round 2**: hand-authoring the migration SQL (as the round-1 draft did,
two bare `ALTER TABLE ADD COLUMN` statements) is the wrong approach and, worse, silently dropped
the `CHECK` constraint entirely — every migration actually shipped in this repo so far is
generated by `npx drizzle-kit generate` from a `schema.ts` change, not hand-written from scratch,
and a `CHECK` constraint on a new column may require D1/SQLite's table-rebuild migration form
(recreate table, copy data, drop, rename) rather than a bare `ALTER TABLE ADD COLUMN`, which
`ALTER TABLE` alone cannot always express. **This plan specifies the schema.ts change, which is
the actual source of truth; the migration SQL is whatever `drizzle-kit generate` produces from
it, verified by inspection before applying to prod** — not hand-predicted here:

```ts
// packages/db/src/schema.ts — add to the `projects` table definition
priority: integer("priority"), // 1-10, nullable — unset means "no priority assigned"
boardPosition: real("board_position").notNull().default(0), // sole Kanban-column sort key
```
```ts
// add to the `projects` table's constraint array (t) => [...]
check("projects_priority_check", sql`${t.priority} IS NULL OR (typeof(${t.priority}) = 'integer' AND ${t.priority} >= 1 AND ${t.priority} <= 10)`),
```
**The `typeof(...) = 'integer'` clause is required, not decorative — corrected per Terra round 4**,
which found the range-only check insufficient: SQLite's `INTEGER` column affinity is a storage
hint, not a strict type enforcement — a dynamically-typed SQLite column can still store `5.5` if
a caller writes it directly (bypassing Zod's own integer validation at the API layer), and a bare
`priority >= 1 AND priority <= 10` check would accept that value. `typeof(...) = 'integer'` makes
the database itself reject a non-integer regardless of what wrote it. Matches this schema's
existing `check()` usage precedent (`schema.ts:271-272`, `document_uploads`) and confirmed
`check`/`sql` imports (`schema.ts:6`, corrected per Terra round 1 which miscited this as `:5`).
Run `npx drizzle-kit generate`, read the generated SQL, and confirm it correctly expresses the
`CHECK` (a table rebuild if that's what D1/SQLite requires) before treating the migration as
final.

**Backfill — corrected per Terra round 1, which found the original approach not actually
buildable.** The original draft pointed at
`0009_legacy_manual_edited_recovery.sql`/`0010_retire_legacy_manual_edited_recovery.sql` as a
"data migration" precedent — Terra checked and those are index-only DDL, not a data-backfill
precedent at all. More fundamentally, **pure SQL cannot do this backfill correctly**: the
existing visual order this needs to preserve depends on `orderDashboardStreetTies`'s
Unicode-aware `Intl.Collator("en-AU")` tie-break (`projects.ts:33-51`), which has no SQL
equivalent — D1/SQLite's `lower()` is ASCII-only (the same reason `orderDashboardStreetTies`
exists as a JS post-processing step in the first place, per its own comment at `projects.ts:33-35`).

**Corrected mechanism**: the migration is DDL-only (whatever `drizzle-kit generate` produces from
the schema.ts change above). The backfill runs as a **separate, one-time JS step with D1 access**
— a temporary admin-only route (`POST /admin/backfill-board-position`, gated by `adminBackend`,
called once manually after the migration is applied to prod, then deleted from the codebase in a
follow-up commit once confirmed) that reuses the dashboard's exact ordering logic, not a
re-derived approximation. **Corrected per Terra round 2**: `orderDashboardStreetTies` and
`dashboardProjectOrder` are currently private, unexported functions in
`workers/app/src/routes/projects.ts:28-50` — a Worker other than `workers/app` (or a route
outside that file) cannot import them as-is. Fix: **move both functions to `packages/db`**
(e.g. `packages/db/src/dashboard-order.ts`), **export them through `packages/db/src/index.ts`
alongside the existing `guardedStageTransition` export** (`index.ts:4-6` — added per Terra round
3, which found the relocation alone insufficient without an explicit package-level export entry),
and have `projects.ts` import them back (pure relocation — no behavior change to the existing
route). This makes them reachable from wherever the backfill route ends up living (recommend
`workers/app`, alongside the existing `admin.ts` routes, since that's this codebase's existing
home for admin-only one-off operations — `workers/background` could also reach D1 but has no
existing precedent for admin-gated HTTP routes). The backfill then: fetches all non-archived
projects grouped by `stage_key`, runs each group through the relocated
`dashboardProjectOrder`/`orderDashboardStreetTies`, assigns stepped `board_position` values
(`1024, 2048, 3072, …`), and writes them via a single `db.batch([...])` call (batched, not N
sequential awaits — see §3b on atomicity).

**Backfill race, added per Terra round 3**: the backfill's read-then-batch-write can be
invalidated by a live stage move or a new project arriving between its read and its write — a
project that changed stage in that window would get a `board_position` computed for its *old*
stage, not its current one. **This is a one-time, manually-triggered operation, not routine
traffic**, so the fix is operational, not a new concurrency mechanism: run it during a brief
window with no in-flight stage changes (e.g. outside business hours, after confirming no active
uploads/AutoHDR jobs via the existing admin job-status view), and **follow it with a verification
pass** — re-fetch every project immediately after the write and confirm each one's `board_position`
was computed for the `stage_key` it's *currently* in (not the `stage_key` read at backfill time);
any mismatch (a project that moved stages mid-backfill) gets re-run individually through the same
append-to-bottom logic for its actual current stage. Do not declare the backfill complete until
this verification pass reports zero mismatches.

### 2. New capability

```ts
// packages/shared/src/capabilities.ts
export const CAPABILITIES = [
  // ...existing...
  "prioritizeProjects", // admin-only: set project priority, manually reorder Kanban columns
] as const;

// ROLE_CAPABILITIES.admin: add "prioritizeProjects"
// ROLE_CAPABILITIES.editor / .photographer: do NOT add it
```

### 3. Ordering semantics — decided by the user directly (not a full-column resort)

`boardPosition` is the **sole, authoritative sort key** for a Kanban column (ascending).
`priority` is a per-project attribute, shown on the card, that repositions **only the edited
project itself** when set/changed — in the normal path, it never touches any other card's
`board_position`; **the sole exception is §3b's renumbering safety net** (added per Terra round 8,
which found this line still made the unqualified claim after the exception was already reconciled
elsewhere in this document). This resolves the round-1 approval checkpoint: presented with the choice between a full-column resort
(simpler, but silently erases other cards' manual nudges) and resorting only the edited card
(leaves every sibling untouched, needs a concrete tie-break rule), **the user chose the latter**.
The tie-break rule the round-1 draft flagged as "no obviously-correct answer" is resolved below.

- **Setting/changing a project's `priority`** (via the dropdown) repositions *only that project*:
  - **Special case, resolved explicitly per Terra round 3** (which found the anchor rule below
    self-contradictory for this case — "no anchor" was written to mean both "top" and "bottom" in
    different places): **clearing priority to `null` always appends the project to the bottom of
    its column** (via the same `appendToStageBottomExpr` primitive used for cross-column
    arrivals, §3a) — skip the anchor search entirely for this case. A `null` priority carries no
    ranking claim, so "no priority" belongs at the bottom, not wherever an anchor-search
    coincidentally lands it.
  - **For a numeric priority (1–10)**: load the project's current stage column's other members,
    each with their current `board_position` and `priority`, ordered by `board_position ASC`.
    Find the **anchor**: the last (bottom-most by current `board_position`) sibling whose
    `priority` is `>=` the edited project's new priority — treating a sibling's `null` priority as
    lower than any numeric value, so it never qualifies as an anchor for a numeric edit.
  - **Ties**: if one or more siblings share the *exact same* priority as the new value, the
    anchor is the *last* (bottom-most) such sibling — the edited card sorts to the bottom of its
    own priority tier, arriving after existing same-tier peers. This is a simple, deterministic,
    "arrives last within its tier" rule, not an attempt to guess relative importance among equal
    priorities.
  - **Insert**: using the same `computeInsertPosition(before, after)` primitive as the up/down
    leapfrog (§4) — insert the edited project's new `board_position` between the anchor and the
    anchor's own next sibling (leapfrogging past whatever came right after the anchor), or at the
    very top if no anchor exists (every sibling has a `null` or lower numeric priority than the
    new value), or at the very bottom if the anchor is the last sibling in the column.
  - **No other project's `board_position` changes — in the normal path.** A manually-nudged
    sibling stays exactly where it was, regardless of this edit. **The sole, rare exception is the
    renumbering safety net (§3b)** — if it fires, it reassigns every sibling's position as an
    unavoidable consequence of resolving a numeric-precision collision; this is documented there
    as an explicit exception, not a silent contradiction of this guarantee.
- **Manual up/down** (§4) adjusts only the moved project's `board_position` via the same
  `computeInsertPosition` primitive, relative to its current immediate neighbors — it does not
  touch `priority` and, in the normal path, does not affect any other card's `board_position`;
  **the same §3b renumbering-safety-net exception applies here too** (added per Terra round 8).
- **Worked example** (the exact scenario round 1 used to justify the full-resort checkpoint,
  now resolved under the chosen design): `[A, B, C]`, no priorities set. Admin sets A's priority
  to 8 → A has no sibling with priority `>= 8` (B, C are both `null`), so A gets no anchor → moves
  to the top: `[A, B, C]` (unchanged, since it was already first). Admin manually nudges B up a
  slot → `[B, A, C]`. Admin sets C's priority to 5 → C's siblings are B (`null`) and A (`8`); the
  anchor is A (the only sibling with priority `>= 5`), so C inserts immediately after A:
  `[B, A, C]` (unchanged — C was already last, and its anchor is directly above it). **B's manual
  nudge is preserved**, unlike the full-resort design this replaces.
- **Cross-column moves always append to the bottom, regardless of priority — decided explicitly**:
  a project arriving in a new stage column, whether via admin drag or an automated worker
  transition (§3a), gets `board_position` computed by the atomic `appendToStageBottomExpr`
  expression below (`(max board_position in the destination stage, excluding itself) + 1024`, or `0` if the
  column is empty) — **its `priority` value is untouched and does *not* trigger a repositioning
  in the destination column**, even if that priority would otherwise rank it higher there.
  Reasoning: re-ranking on arrival would mean every automated background-worker stage transition
  (§3a) silently repositions a card the moment it lands, as an invisible side effect of something
  that isn't even a Kanban action a human took. If priority ordering should apply in the new
  column too, the admin re-asserts it the normal way — editing any project's priority there (or
  the moved project's own, again) triggers the single-card repositioning already designed above.
  This keeps "arriving in a column" and "asking for priority order" two separate, deliberate
  actions.
- **New project creation** (`POST /projects`, `projects.ts:139-151`): append to the bottom of
  `awaiting_raw` the same way (every new project starts there per `stageKey: "awaiting_raw"` at
  `projects.ts:142`).

### 3a. Every writer that changes a project's stage or creates one — the complete inventory,
substantially expanded across Terra rounds 1-3, with an explicit build-time re-verification
mandate given how consistently this list has needed correction

**This list has been wrong or incomplete in every one of the first three review rounds** — round
1 added 4 sites the original draft missed; round 2 found more; round 3 found still more
(`reconcile-awaiting-raw.ts`'s exact site, and two additional `claims.ts` transitions this plan
had dropped from an earlier revision). Rather than present a fourth guess as final, **this plan
requires a fresh, exhaustive grep across `workers/background/src/` and `workers/app/src/` for
every direct write to `projects.stage_key`/`stageKey` (raw SQL and Drizzle alike) as a build-time
step, before implementation — cross-checked against this list, not trusting this list alone.**
Known sites as of this round:

**Routed through the shared `guardedStageTransition()` helper** (`packages/db/src/stage-transition.ts:17-40`):
- `workers/background/src/dropbox/sync.ts:311-322` (awaiting_raw → raw_review)
- `workers/app/src/lib/ingest.ts:107-117` (awaiting_raw → raw_review, `direct_upload` path —
  runs in `workers/app`, not background)
- `workers/background/src/autohdr/finals.ts:190-202` and `:285-295` (editing_autohdr →
  edited_review, two call sites)

**A third, direct (non-helper) `finals.ts` site — added per Terra round 4, which found this plan
had only counted the two `guardedStageTransition()` calls in this file and missed a third:**
- `workers/background/src/autohdr/finals.ts:244-247` — advances editing_autohdr → edited_review
  directly, outside `guardedStageTransition()`. Treat like the inline-guarded sites below (confirm
  its own guard shape at build time and splice the position expression into its own statement).

**Inline-guarded, not via the shared helper** (each hand-rolls its own `d1.batch([...])` with a
`WHERE stage_key = ...` guard):
- `workers/background/src/reconcile-awaiting-raw.ts:52` (a second, scheduled awaiting_raw →
  raw_review path, distinct from `dropbox/sync.ts`'s)
- `workers/background/src/autohdr/claims.ts:120` (`confirmAutoHdrHandoff`, raw_review →
  editing_autohdr — the original "sent to AutoHDR" trigger site)
- `workers/background/src/autohdr/claims.ts:362` (edited_review → editing_autohdr,
  "autohdr_repeat_send")
- `workers/background/src/autohdr/claims.ts:592-605` (`claimImplicitAutoHdrHandoff`) and
  `:773-799` (`claimBackfillAutoHdrHandoff`) — **confirmed as genuinely distinct writers from the
  `:120`/`:362` sites above, per Terra round 4's direct verification** (named explicitly now,
  resolving the round-3 uncertainty about whether these were re-citations of the same sites).
  `claims.ts` now has **four** confirmed distinct transition sites total, not two.
- `workers/background/src/workflows/autohdr-fetch.ts:179-182` (editing_autohdr → edited_review,
  legacy path)

**Unguarded legacy path** (no `WHERE stage_key = ...` fence at all):
- `workers/background/src/workflows/autohdr.ts:277-279` — sets `editing_autohdr` directly when
  `input.handoffId` is undefined; the same pre-existing gap `Notifications-Plan.md` already flags
  for its own reasons (no audit insert either). This plan doesn't fix that guard — out of scope
  here — but the board-position assignment still needs adding to whatever this path does today.

**Direct project creation, bypassing `POST /projects` entirely:**
- `workers/background/src/tonomo/process.ts:95-101`

**The two `workers/app` API routes** already in this plan's original scope: `POST /projects`
(creation) and `POST /projects/:id/stage` (manual admin move). **Note on `/projects/:id/stage`'s
own guard shape, added per Terra round 4**: this route currently updates by
`WHERE id = ?` only (`projects.ts:596`) — no `stage_key = <from>` guard at all, because it's an
unconditional admin override (any admin can set any active stage directly), not a guarded
transition in the same sense as the automated sites above. See the conditionality note below for
how this affects the splice design at this specific site.

**Fix — a SQL *expression* spliced into each site's own existing guarded statement, not a
separate statement or a standalone helper call — corrected per Terra round 3, which found two
problems with the round-2 design: (a) a separate position-update statement wasn't actually tied
to the stage-key update's own guard succeeding, so a failed/no-op transition could still reposition
a project with an unchanged stage; (b) `createDb(...).batch()` (Drizzle) doesn't accept the raw
`D1PreparedStatement` the round-2 helper returned, and at least one site (`autohdr.ts:277-279`)
has no existing batch at all to append to.**

```ts
// packages/db/src/board-position.ts — a SQL fragment, not a standalone statement
export function appendToStageBottomExpr(stageKey: StageKey, excludeProjectId: string): SQL {
  return sql`(SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ${stageKey} AND archived_at IS NULL AND id != ${excludeProjectId})`;
}
```

Every call site splices this expression into the **`board_position` column of its own existing
stage-changing statement** — never as a second, independent statement — so the position update is
automatically conditional on exactly the same guard as the stage-key change, with no separate
tracking needed:

- **Raw-SQL sites** (`guardedStageTransition`, `claims.ts`, `reconcile-awaiting-raw.ts`): add
  `, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?)`
  to the existing `UPDATE projects SET stage_key = ? ...` statement's `SET` clause, binding the
  destination stage key and the project's own id alongside the existing params — same statement,
  same `WHERE stage_key = <from>` guard, so it only applies when the transition actually happens.
- **Drizzle sites** (if `autohdr.ts:277-279` or others turn out to be Drizzle `.update()` calls
  rather than raw SQL, per the build-time re-verification above): use the same expression via
  Drizzle's `sql` tag in `.set({ stageKey: to, boardPosition: appendToStageBottomExpr(to, id) })`,
  still one statement, same `.where(...)` guard.
- **Unconditional single-target updates — narrowed per Terra round 4**, which found the blanket
  "conditional on the same guard" claim didn't fit two sites that have no from-stage guard at
  all: `POST /projects/:id/stage` (`WHERE id = ?` only, an intentional unconditional admin
  override — any admin can set any active stage directly, so there's no "guard" to tie
  conditionality to) and `workflows/autohdr.ts:277-279` (unguarded today). For
  `/projects/:id/stage`, splicing the expression into the same single `UPDATE` statement is still
  correct and still atomic — it's just **unconditionally** correct, since the statement itself has
  no guard to gate on, not a weaker guarantee than the guarded sites above, just a different one
  appropriate to an intentional admin override. **`autohdr.ts:277-279` is a coordination point
  with the sibling `Notifications-Plan.md`**, added here for consistency: that plan's own review
  found it needs to add a real `WHERE stage_key = 'raw_review' AND archived_at IS NULL` guard to
  this same update (to fix a TOCTOU race in its own notification-emission logic) — if that lands
  first, this plan's position-expression splice becomes conditional on that guard automatically,
  same as every other guarded site; if this plan builds first, add the position expression to the
  statement as currently unguarded, and the Notifications build should find its guard composes
  cleanly with an already-present `board_position` splice. Either build order works; just don't
  assume the other plan hasn't already touched this exact statement.
- **Creation** (Tonomo, `POST /projects`): no existing guarded update to merge into — these are
  `INSERT`s, so `board_position` is simply one more column in the same `VALUES`/`.values()` call,
  using the same expression (unconditional, since there's no guard concept for a fresh insert).

This design means the atomicity/concurrency guarantee (§3b) is inherited directly from whatever
guarantee each site's existing statement already has — no new conditional logic to get wrong, and
no dependency on Drizzle vs. raw-D1 batch mechanics matching across sites.

### 3b. Atomicity and concurrency — split between automated writers (real guarantee) and
interactive admin operations (accepted last-write-wins), corrected/expanded per Terra rounds 1-2

- **Automated writers appending to a stage's bottom** (§3a): get a genuine atomicity/concurrency
  guarantee via the `appendToStageBottomExpr` splice-into-existing-statement design — no separate
  read-then-write window, safe under concurrent automated arrivals into the same stage, per §3a's
  reasoning about D1/SQLite's single-writer serialization (confirmed against
  [D1's batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) —
  batches execute sequentially, non-concurrently, per database). This is the case that actually
  experiences meaningful concurrent load (multiple background transitions can plausibly land
  around the same cron tick), so it gets a real fix, not an accepted tradeoff.
- **Interactive admin operations** (priority-set's single-card reposition, §3; up/down leapfrog,
  §4) **read the column's siblings, compute a position in JS, then write** — genuinely a
  read-then-write sequence, not reducible to one blind SQL statement the way append-to-bottom is,
  since it depends on a rank/neighbor condition across multiple sibling rows. **Concurrent admins
  acting on the exact same column at the exact same moment**: accepted as last-write-wins for v1,
  matching this codebase's general lack of optimistic-concurrency/compare-and-swap infrastructure
  elsewhere (no other route in this codebase guards a similar race with version tokens or
  locking). Two admins simultaneously dragging/prioritizing within the exact same column at the
  exact same moment is a narrow, low-frequency scenario for a small internal team — not worth new
  concurrency-control infrastructure for v1. Revisit only if this turns out to matter in practice.
  Each individual read+write is still wrapped in as few round-trips as practical (the sibling read,
  then a single `UPDATE` for the computed position — not multiple sequential writes).
- **Shared position-math primitive** — extracted per Terra round 2's implicit ask to avoid
  duplicating the leapfrog formula between up/down and priority-set:
  ```ts
  // packages/db/src/board-position.ts
  export function computeInsertPosition(before: number | null, after: number | null): number {
    if (before === null && after === null) return 0; // empty column
    if (before === null) return after! - 1024; // inserting above the current first
    if (after === null) return before + 1024; // inserting below the current last
    return (before + after) / 2; // leapfrog midpoint
  }
  ```
  Both up/down (§4) and priority-set (§3) compute their `before`/`after` neighbor pair differently
  (immediate neighbors vs. the priority-rank anchor and its next sibling), then call this same
  pure function — no DB access, trivially unit-testable in isolation.
- **Renumbering safety net — explicitly reconciled with §3's "only the edited card changes"
  guarantee, per Terra round 7**, which found the two claims contradicted each other as originally
  written (§3 said siblings never change; this safety net renumbers the whole column): if a
  computed position from `computeInsertPosition` is numerically equal to `before` or `after`
  (theoretically possible after enough repeated fractional bisection between the same two
  neighbors, though astronomically unlikely at any realistic usage volume before float64 precision
  is exhausted), the server renumbers the whole column (reassign stepped values in current sorted
  order) before applying the requested move. **§3's guarantee is the normal-path behavior; this
  safety net is an explicit, narrow, rare exception to it** — when it fires, every sibling's
  `board_position` is reassigned as an unavoidable consequence of resolving the precision
  collision, not a silent violation of §3's claim. This is a rare-fallback correctness net, not the
  normal path — it does not run on every request, and its renumbering is the *only* case in this
  entire plan where a priority-set or up/down operation touches a sibling's position.
- **Recompute the final position after renumbering, not before — added per Terra round 7, sequencing
  made fully explicit per Terra round 8** (which found the round-7 fix didn't rule out an
  implementer writing the renumber, reading it back from D1, then recomputing — breaking the
  single-batch atomicity this design otherwise relies on): if the safety net fires, the neighbor
  `board_position` values it's about to assign are different from the ones `computeInsertPosition`
  was originally called with — the pre-renumber computed position is now stale and must not be
  reused. **The entire sequence happens in memory, before any write occurs, then applies as one
  batch**: (1) compute the renumbered stepped values for the whole column *in memory* (JS
  objects, not yet written); (2) using those in-memory renumbered neighbor values — not a
  re-read from the database — call `computeInsertPosition` a second time to get the final move's
  position; (3) construct a single `db.batch([...])` containing every renumbering `UPDATE`
  *followed by* the guarded final-move `UPDATE` (with its stage-snapshot guard, §4), and execute
  it once. There is no intermediate read from D1 between the renumber and the final move — the
  renumbered values used for the recomputation are the same in-memory values about to be written,
  never a round-trip read-back.

### 4. API

```ts
// POST /api/projects/:id/priority — body: { priority: number | null }
// Gated by `prioritizeProjects`. 1-10 or null (clears it). On success, repositions only this
// project (§3's anchor rule, via computeInsertPosition) and returns { priority, boardPosition }
// (the server-computed value, including a post-renumbering value if the safety net fired —
// added per Terra round 5, which found the response shape unspecified; the frontend must treat
// this as authoritative, not re-derive it locally) — simpler than the original full-resort
// design, since no sibling's board_position changes in the normal path (the renumbering safety
// net, §3b, is the sole, rare, explicitly-documented exception). Audit: "project.priority_set",
// { from, to }.
// 409 (not 200-with-no-op) if the stage-key snapshot guard below detects a concurrent stage
// change — see "Concurrency guard for read-then-write operations" below.

// POST /api/projects/:id/board-position — body: { direction: "up" | "down" }
// Gated by `prioritizeProjects`. Returns { boardPosition } (server-computed, including a
// post-renumbering value if that fired — added per Terra round 5). Audit:
// "project.board_position_set", { direction }. Same 409 behavior on a concurrency-guard miss.
```

**Concurrency guard for read-then-write operations.** Both routes read the column's siblings,
compute a position in JS, then write (§3b) — a genuine gap exists between that read and the
write: an automated background transition could move the *target* project to a different stage in
that window, and the subsequent write would then apply a position computed for a column the
project is no longer even in.

- **Scope of the guard, narrowed per Terra round 6** (which found the round-5 prose overclaimed
  protection against a *neighbor* moving too, when the guard as designed only ever checked the
  target project's own stage): this guard specifically catches **the target project's own stage
  changing** between read and write — not a neighbor's stage change, and not a neighbor's
  `board_position` changing (e.g. from an unrelated concurrent up/down on that same neighbor).
  Those remain within the existing, explicitly accepted last-write-wins tradeoff (§3b) — a
  genuinely rarer, lower-stakes case (the computed position would just be based on slightly stale
  neighbor data, not "wrong column entirely," which is what the target-stage guard specifically
  prevents). No column-version/snapshot mechanism is added to cover the neighbor case — that would
  be new concurrency-control infrastructure §3b already declined to build.
- **`priority`-set's write must be a single atomic statement covering both columns — corrected
  per Terra round 6**, which found the round-5 sketch only guarded `board_position`, leaving
  `priority` itself as a separate, ungated write that could succeed even when the position write's
  guard failed, producing an inconsistent row (new `priority`, stale `board_position`). Fix: one
  statement — `UPDATE projects SET priority = ?, board_position = ? WHERE id = ? AND stage_key = ?`
  — never two separate writes for this route.
- **The renumbering safety net must be tied to the same guard, not run independently — corrected
  per Terra round 6**, which found that if renumbering fires first and the guarded move then
  returns 409, the column would already be mutated for a move that never actually applied. Fix:
  when the safety net triggers, its renumbering statements carry the **identical**
  `stage_key = <snapshot>` condition as the final move (via `AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND stage_key = ?)`
  referencing the target project and its snapshotted stage) on every renumbering `UPDATE`, bundled
  in the same `db.batch([...])` as the final move — if the target's stage changed, every statement
  in the batch (renumbering included) becomes a no-op together, not just the final move. This
  keeps the guarantee tied to one shared condition rather than trusting D1 to roll back a batch
  based on an affected-row count (which it does not do — only a thrown SQL error rolls back a
  batch).

The route returns **409 Conflict** (not a silent 200) when the guard fails, so the frontend can
refetch and retry rather than trusting a stale optimistic update. This is a detect-and-reject
guard, not a retry loop or a lock.

**Leapfrog semantics, made precise — corrected per Terra round 1, which found the original
"neighbor ± 1024 at a column edge" description didn't actually specify the sign or the
equal-position tie-break; now expressed via the shared `computeInsertPosition` primitive (§3b)**:

1. Load the project's current stage column, ordered `board_position ASC, id ASC` (the explicit
   `id` tie-break — added per Terra round 1 — makes the order deterministic even if two rows ever
   share a `board_position`, e.g. immediately after the migration backfill's stepped assignment
   before any reorder has happened).
2. Find the project's index in that ordered list. `direction: "up"` looks at index `i - 1`
   (call it `A`) and `i - 2` (call it `B`); `direction: "down"` looks at `i + 1` (`C`) and `i + 2`
   (`D`) — i.e. "leapfrog" means landing between the immediate neighbor in the requested direction
   and *that neighbor's own* next neighbor further in the same direction.
3. **No-op cases** (return 200, unchanged, not an error): `"up"` when the project is already at
   index 0 (no `A` exists); `"down"` when it's already last (no `C` exists).
4. **New position**: `"up"` calls `computeInsertPosition(B?.boardPosition ?? null, A.boardPosition)`;
   `"down"` calls `computeInsertPosition(C.boardPosition, D?.boardPosition ?? null)`.
5. **Renumbering safety net** (§3b) applies identically here.

**Priority-set's single-card reposition (§3) uses the same primitive**: `anchor` = the last
sibling with `priority >= new priority` (nulls-as-lowest, ties broken to the last such sibling,
§3). **`anchorNext`, corrected per Terra round 4** (which found the original rule left both
`anchor` and `anchorNext` null whenever no anchor exists, so `computeInsertPosition(null, null)`
incorrectly returned `0` — the empty-column case — instead of positioning before the column's
actual first sibling): when an anchor exists, `anchorNext` is whatever currently sits immediately
after it (or nothing, if `anchor` is last). **When no anchor exists** (every sibling's priority is
lower than the new value, or the column has no siblings at all), `anchorNext` is the column's
current *first* sibling by `board_position`, if any exist — only when the column is genuinely
empty (no siblings whatsoever) is `anchorNext` also null. New position =
`computeInsertPosition(anchor?.boardPosition ?? null, anchorNext?.boardPosition ?? null)` — this
now correctly resolves to "insert before the current first sibling" (via
`computeInsertPosition(null, firstSibling.boardPosition)` → `firstSibling.boardPosition - 1024`)
rather than `0`, whenever siblings exist but none qualify as an anchor.

Both routes follow the existing `/projects/:id/stage` shape (`idCheck` → `hasProjectAccess` →
capability check → `jsonInput` validation → update → audit → JSON response, `projects.ts:584-598`)
— no new pattern introduced.

**Existing `/projects/:id/stage` route also needs a response-shape addition — added per Terra
round 1**, which found the frontend's existing `moveProject` only updates `stageKey` optimistically
today, with no way to reflect the new bottom-of-column `board_position` (§3's cross-column-append
rule) without a full refetch: the route's success response gains the newly-assigned
`boardPosition` for the moved project, and `moveProject` (`Dashboard.tsx:154-171`) applies it to
local state alongside `stageKey` in the same optimistic update.

`GET /api/projects` (`projects.ts:126-138`) response gains `priority: number | null` and
`boardPosition: number` per project — purely additive fields; the existing `ORDER BY` and List
view are untouched.

### 5. Frontend (`Dashboard.tsx`)

- `ProjectSummary` (`Dashboard.tsx:11-23`) gains `priority: number | null; boardPosition: number`.
- Kanban column render (`Dashboard.tsx:242-254`): `stageProjects` becomes
  `filteredProjects.filter(...).sort((a, b) => a.boardPosition - b.boardPosition || a.id.localeCompare(b.id))`
  — the `id` tie-break (matching §4's server-side ordering) is added so equal `board_position`
  values (possible right after backfill, before any reorder) don't produce a flickering/
  nondeterministic client-side order. List view (`ProjectListRow`, unaffected) keeps the current
  server order.
- `canPrioritize = can("prioritizeProjects")` alongside the existing `canMoveStages`
  (`Dashboard.tsx:85`).
- **Control placement — corrected per Terra round 1**, which found the original draft didn't
  address that `KanbanCard`'s entire content sits inside one `<InternalLink className="kcard">`
  anchor (`Dashboard.tsx:53-61`) — nesting a `<select>` and buttons inside an `<a>` is invalid
  HTML and behaves inconsistently across browsers. **This codebase already has the right
  precedent to follow, not a new pattern to invent**: the existing "Retry cover image" button
  (`Dashboard.tsx:62`) is already a sibling of `<InternalLink>` inside `.kcard-wrap`, specifically
  to avoid this exact problem. The priority `<select>` and the up/down arrow buttons go the same
  place — siblings of `<InternalLink>` within `.kcard-wrap`, not children of it — so no
  `stopPropagation`/`preventDefault` workaround is needed to keep them from triggering navigation.
- `KanbanCard`: when `canPrioritize`, render the priority `<select>` (1–10 plus a "—" / unset
  option, placed per the control-placement fix above) that posts to `/projects/:id/priority` on
  change, with the same optimistic-update-then-rollback-on-failure pattern already used for stage
  moves (`moveProject`, `Dashboard.tsx:154-171`) — update local state immediately, toast on
  failure, revert.
- Up/down: **recommend two small arrow buttons on the card** (admin-only, calling
  `POST /projects/:id/board-position` with `{ direction }`, placed per the control-placement fix
  above) rather than extending the existing HTML5 drag-and-drop to detect same-column reorder
  targets. Reasoning: the current drag handlers (`beginDrag`/`onDragOver`/`onDrop`,
  `Dashboard.tsx:147-171,247`) operate at the *column* level (`onDrop` fires on the
  `<section className="kcol">`, not per-card) — detecting "dropped between card A and card B
  within the same column" needs card-level drag targets and a way to distinguish "same column,
  reorder" from "different column, stage change" mid-drag, which is meaningfully more surface
  area for a feature the request itself describes as "move... up and down" (arrow semantics, not
  drag semantics) — confirmed accurate by Terra round 1's own read of the drag handlers. Arrow
  buttons are a direct, small, testable match for the literal request. **Open question for the
  user**: if a drag-to-reorder feel is actually wanted instead of buttons, that's a legitimate
  alternative — flagging the tradeoff rather than assuming.

## Explicitly out of scope

- List view ordering (unaffected; keeps today's shoot-date-based order).
- Priority/reordering for non-admin roles (editor, photographer) — read-only display of the
  priority value on the card, no controls, for those roles.
- Any change to the existing cross-column stage-drag capability (`selectForEditing`) or its
  editor-level access.
- Refactoring `claims.ts`/`autohdr-fetch.ts`/`autohdr.ts:277-279` onto the shared
  `guardedStageTransition()` helper, and fixing `autohdr.ts:277-279`'s missing stage-transition
  guard/audit insert — both legitimate future cleanups, out of scope here (§3a).

## Testing requirements for the build

1. `packages/shared/test`: `prioritizeProjects` is admin-only (`ROLE_CAPABILITIES.editor`/
   `.photographer` don't include it).
1a. `packages/db/test` (corrected per Terra round 5, which found this plan specified
   `computeInsertPosition`/`appendToStageBottomExpr` as living in `packages/db/src/board-position.ts`
   §3a/§3b, but placed their tests under `packages/shared/test` — a package mismatch). **Also
   corrected per Terra round 6**: `packages/db` has no `test` script today, and the root
   `npm run test --workspaces` uses `--if-present`
   (`portal/package.json:17`) — so a test file placed here would silently never run, the exact
   trap `packages/shared` already fell into (per this repo's own documented gotcha requiring a
   separate `npx vitest run --config packages/shared/vitest.config.ts` invocation). **Add a
   vitest config and a minimal `test` script to `packages/db/package.json`** (`packages/db` has
   never needed tests before this plan gave it its first pure-function logic), and add its
   explicit invocation — `npx vitest run --config packages/db/vitest.config.ts` — as a
   **required, separately-documented step** in Verification below, not left to the ambient
   `--workspaces` run to discover. `computeInsertPosition` — pure-function unit tests: both-null
   (empty column), before-only, after-only, both-present (midpoint), and the exact values that
   should trigger the renumbering safety net.
2. `workers/app/test`: priority set/clear round-trips and rejects out-of-range values (0, 11,
   non-integer); non-admin gets 403 from both new routes; **priority-set repositions only the
   edited project in the normal path** (corrected per Terra round 7 — this claim excludes the
   renumbering-safety-net case, tested separately below, since that's the one documented
   exception) — construct the exact worked-example fixture from §3 (`[A,B,C]` → priority edits
   interleaved with a manual nudge, none of which come anywhere near the renumbering threshold)
   and assert every non-edited sibling's `board_position` is byte-for-byte unchanged, not just that
   the edited one moved correctly; the anchor/tie-break rule (§3) is correct for: no qualifying
   sibling **in a non-empty column** (moves before the current first sibling, not to a coincidental
   `0` — the exact bug Terra round 4 found in the `anchorNext`-null case, construct a fixture with
   a nonzero-`board_position` column to catch a regression here), an exact priority tie (sorts last
   within tier), and a `null` priority (moves to bottom); board-position up/down leapfrogs
   correctly per §4's precise sign convention, including both column edges (no-op, not an error);
   **renumbering-safety-net path, tested as its own explicit case per Terra round 7**: construct a
   fixture that forces the safety net to fire (either from a priority-set or an up/down request)
   and assert (a) every sibling's `board_position` *is* reassigned (the documented exception, not
   a regression), (b) the final requested move lands using positions *recomputed from the
   renumbered values*, not the stale pre-renumber computation — construct this specifically to
   catch a stale-recomputation bug, not just that *some* valid-looking position resulted;
   cross-column stage move appends to the bottom of the
   destination column using the correct empty-column formula (`board_position` is `0` for the
   first project in an empty stage, not `1024` — the formula bug Terra round 4 found) and every
   subsequent one is strictly greater than its predecessors, **and does not reposition the
   destination column even if the moved project's priority would otherwise rank it higher**; new
   project creation appends to the bottom of `awaiting_raw`; both routes return the
   server-computed `boardPosition` in their success response (added per Terra round 5); a
   simulated concurrent stage change between the sibling-read and the write causes the
   stage-key-snapshot guard to fail, returning **409**, not a silent 200 with a stale-column
   position (added per Terra round 5's concurrency-guard finding).
3. `workers/background/test` and `workers/app/test` (`ingest.ts`): **the complete writer
   inventory from §3a — first do the exhaustive re-grep §3a mandates, then test every site that
   grep finds**, not just the list as currently enumerated (which has needed correction in every
   round so far): `dropbox/sync.ts`, `ingest.ts` (`workers/app`), all three `autohdr/finals.ts`
   sites (the two via `guardedStageTransition()` plus the direct `:244-247` site added in round
   4), all four confirmed `autohdr/claims.ts` transition sites (`:120`, `:362`, `:592-605`
   `claimImplicitAutoHdrHandoff`, `:773-799` `claimBackfillAutoHdrHandoff`),
   `reconcile-awaiting-raw.ts:52`, `autohdr-fetch.ts`'s legacy path, `autohdr.ts:277-279`'s
   unguarded legacy path, and Tonomo's direct creation (`tonomo/process.ts:95-101`) — each
   produces a correctly-appended `board_position` in its destination stage. **For every guarded
   site**, the position only changes when the stage-key guard actually succeeds (construct a
   fixture where the guard fails — project already moved elsewhere — and confirm `board_position`
   is untouched). **For the two unconditional sites** (`/projects/:id/stage`, `autohdr.ts:277-279`,
   § conditionality note above), confirm the position update always applies alongside the stage
   change, since there's no guard to test against for those two. **Concurrency test**: two
   simulated concurrent stage-transition calls targeting the same destination stage produce two
   distinct, correctly-ordered `board_position` values, never the same value — this is the test
   that actually proves the atomic-expression design resolves the concurrent-writer race, not just
   that the SQL looks right.
4. `apps/web` (Vitest/Node, matching this repo's existing component-test convention): Kanban
   column sorts by `boardPosition` ascending (with the `id` tie-break) regardless of the
   underlying array order; priority dropdown and arrow buttons render only when `canPrioritize`,
   **and render outside `<InternalLink>` so they don't trigger navigation** (added per §5's
   control-placement fix); optimistic update rolls back on a failed request, matching the existing
   `moveProject` rollback test coverage; `moveProject`'s optimistic update applies the response's
   new `boardPosition` alongside `stageKey` (added per §4's response-shape fix).
5. Migration: **inspecting the generated SQL is not sufficient on its own, per Terra round 3** —
   apply the generated migration to a local D1 fixture and prove an actual invalid `priority`
   insert is rejected by the database itself, not just by Zod validation at the API layer: `0`,
   `11`, **and specifically `5.5`** (a non-integer within the valid numeric range — added per
   Terra round 4, which found that without the `typeof(...) = 'integer'` clause, SQLite's
   dynamically-typed columns would silently accept this value despite the range check). Backfill:
   a fixture with several pre-existing projects across
   stages, same-date ties, and null shoot dates — after backfill (run via the temporary admin
   route, §1, using the relocated `orderDashboardStreetTies`/`dashboardProjectOrder` from
   `packages/db` directly, not a re-derived SQL approximation), `board_position` order matches the
   pre-migration visual order exactly; and the round-3 verification pass (§1) correctly detects
   and corrects a project whose stage changed during a simulated backfill window.

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and** `npx vitest run --config packages/shared/vitest.config.ts`
  (the latter is silently skipped by the workspaces script per this repo's own gotcha) **and**
  `npx vitest run --config packages/db/vitest.config.ts` (added per Terra round 6 — this new
  config, added by this plan, has the identical no-`test`-script gap `packages/shared` already
  has, so it needs the same explicit separate invocation, not an assumption that `--workspaces`
  will find it).
- Manual smoke: create three projects in the same column, set priorities on two of them, confirm
  the expected order; manually nudge the third; set the first project's priority again and confirm
  the manually-nudged third project's position is untouched (§3's worked example); drag one to a
  different stage and confirm it lands at the bottom of the new column without affecting its
  priority.

## Rollout

1. Migration (DDL from `drizzle-kit generate`, verified to include the `CHECK` per §1 — the
   backfill is a separate step below) — safe to apply to prod independent of any code deploy.
2. `packages/db`: the relocated `orderDashboardStreetTies`/`dashboardProjectOrder` (§1),
   `appendToStageBottomExpr` and `computeInsertPosition` (§3a/§3b), and `guardedStageTransition()`
   extended to splice the position expression into its own existing batch (corrected per Terra
   round 6, which found "post-success hook" wording here conflicting with §3a's actual
   same-statement-splice design — that hook terminology belongs to the sibling
   `Notifications-Plan.md`'s separate extension of this same function for notification emission,
   not to this plan's board-position change).
3. `packages/shared`: new `prioritizeProjects` capability (admin-only).
4. **`workers/background`** — updated per Terra round 5, which found this step still listed the
   round-1-era `claims.ts ×2` count rather than §3a's actual complete inventory: the direct
   `autohdr/finals.ts:244-247` site, `reconcile-awaiting-raw.ts:52`, all four confirmed
   `autohdr/claims.ts` transition sites (`:120`, `:362`, `:592-605`, `:773-799`),
   `autohdr-fetch.ts`'s legacy path, `autohdr.ts:277-279`'s position-only (unconditional) addition,
   and Tonomo's creation path (`tonomo/process.ts:95-101`) — corrected across Terra rounds 1-5,
   which found this Worker omitted entirely, then understated how many distinct sites within it
   need touching (three separate times), then found this rollout step itself had gone stale
   relative to §3a's own corrections. Deploys first, matching this repo's existing background →
   webhook-ingress → app order (`CLAUDE.md`).
5. `workers/app`: the two new routes (`/priority`, `/board-position`); `ingest.ts`'s use of the
   extended `guardedStageTransition()`; `GET /projects` field additions; the existing
   `/projects/:id/stage` route's response-shape addition and append-on-move logic; the temporary
   `POST /admin/backfill-board-position` route — deploys after step 4, same existing order.
6. **Run the one-time backfill** against prod, then confirm `board_position` matches the
   pre-migration visual order before considering this rollout complete. Remove the temporary
   backfill route in a small follow-up commit once confirmed.
7. `apps/web`: Dashboard changes — depends on step 5's response shape being live.

## Routing (per Subagent-Orchestration.md §2 routing table)

Schema + capability + API + frontend + **many individually-touched writers across both Workers**
(substantially broader than originally scoped — see §3a's complete inventory), coordinated,
large size — Terra plan review, then (when the
user authorizes a build) Terra build, Terra diff review, Opus final read, §5 gate.
