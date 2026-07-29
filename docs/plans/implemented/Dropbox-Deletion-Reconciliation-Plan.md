# Dropbox Delete-Then-Reupload Reconciliation — Plan

**Status: BUILT, verified, committed (`9baec1e`), and DEPLOYED to production (2026-07-29 —
`workers/background` only, single-worker deploy).** Terra-approved after 5 plan-review rounds and
1 diff-review round; the diff review's own build had two real bugs (a compensation guard bound to
the wrong, always-null timestamp, making that whole path dead code; a repoint query referencing a
nonexistent `assets.asset_id` column that would throw at runtime) plus several test-construction
issues, all found and fixed in-session before commit. 166/166 tests passing.

**User request** (2026-07-29): "Very often, users deleted an image and then uploaded an updated
image in the same filename. So I want Quincy Portal to be able to fetch the previously deleted
files, if the file is added to Dropbox by users." Confirmed scope: a **replace-in-place**
workflow — not general deletion-without-replacement detection (a separate, already-documented,
pre-existing gap this plan does not attempt to close).

Split out from `docs/plans/Admin-Asset-Deletion-Plan.md` — that plan is admin-initiated,
one-directional (portal → Dropbox) deletion; this is the reverse direction. **The two plans share
one real race, closed on the admin-delete side using a real, renewable mutual-exclusion lease** —
see § 2.

## Current state — the exact bug, confirmed by reading the sync code directly

`workers/background/src/dropbox/sync.ts` (`syncProjectRawFolder`) walks the RAW folder's complete
current listing every run. For each file: identity match, content/path match, else treated as
brand-new (`:256-289`) — downloads the file, inserts a new `assets` row via raw SQL with `ON
CONFLICT DO NOTHING`.

**The bug**: `assets_current_source_unique (collectionId, sourcePathKey) WHERE supersededAt IS
NULL AND sourcePathKey IS NOT NULL` (`packages/db/src/schema.ts:352-353`). A delete-then-reupload
at the same path produces a new file with a different `content_hash`, matching neither of the
first two steps — but the old row is still `supersededAt IS NULL`. The new row's insert silently
conflicts and is dropped.

## Design — revised across four rounds; this round fixes an unsafe compensation path

### 1. `workers/background/src/dropbox/sync.ts` — the only file that changes

**Step 1 (unchanged)**: the existing insert exactly as today, batched with the identity insert,
audit insert, and `COLLECTION_RECEIVED_COUNT_SQL`. Byte-for-byte unchanged for the common case.

**Step 2 — only on `results[0].meta.changes === 0`**: look up a live `staleOccupant` at this
`sourcePathKey`, scoped to `collectionId`.
- No live occupant: unchanged today's behavior — `continue`.
- A live occupant found: run one retry batch — guarded supersede, the retry insert (binding
  `supersedesAssetId = staleOccupant.id`), the identity insert, audit insert,
  `COLLECTION_RECEIVED_COUNT_SQL`.

**Both outcomes inspected independently.** Supersede `1`, retry insert `0`: the old row is
incorrectly superseded with no replacement confirmed. **Compensation, corrected this round — round
4 found the previous "always restore to current" logic unsafe.**

Within a single D1 batch, the supersede and retry insert are adjacent statements in one
transaction — no external writer can interleave *between* them, so a genuinely concurrent "third
writer wins the path" scenario cannot occur *within that batch*. But by the time this code
inspects the results and decides how to compensate, the situation it's reacting to could still
have changed since — this plan's earlier draft assumed `supersede: 1, insert: 0` always meant "the
path is now free, safe to blindly restore the old row to current" — **round 4 found this false**:
if some other legitimate write (an admin delete, a different ingest path) has, since this batch
committed, made a different row current at this exact `(collectionId, sourcePathKey)`, the
compensating `UPDATE assets SET superseded_at = NULL ... WHERE id = ?` would itself violate
`assets_current_source_unique` — two rows can't both claim the path as current. **Fixed: the
compensation checks which case it's actually in before acting**:
```sql
-- One statement, decides the branch atomically rather than assuming:
UPDATE assets
SET superseded_at = CASE WHEN NOT EXISTS (SELECT 1 FROM assets a2 WHERE a2.collection_id = ? AND a2.source_path_key = ? AND a2.superseded_at IS NULL AND a2.id != assets.id) THEN NULL ELSE superseded_at END,
    replaced_by_asset_id = CASE WHEN NOT EXISTS (SELECT 1 FROM assets a2 WHERE a2.collection_id = ? AND a2.source_path_key = ? AND a2.superseded_at IS NULL AND a2.id != assets.id)
      THEN NULL
      ELSE (SELECT a3.id FROM assets a3 WHERE a3.collection_id = ? AND a3.source_path_key = ? AND a3.superseded_at IS NULL AND a3.id != assets.id LIMIT 1)
    END,
    updated_at = ?
WHERE id = ? AND superseded_at = ?
```
followed by `COLLECTION_RECEIVED_COUNT_SQL` in the same batch (unchanged from the prior round's
fix — recomputing after this correctly-branched restore still produces the right count either
way, since it derives from live `assets` state regardless of which branch fired). In plain terms:
if nothing else now claims the path, restore the old row to current (the ordinary case — this is
what the earlier draft always assumed, and it usually holds); if something else now does, repoint
the old row's `replacedByAssetId` at that actual current occupant instead of trying to reclaim a
path that's legitimately no longer free — the old row stays superseded, correctly, because a real
replacement genuinely exists now, just not the one this code was attempting to create.

Supersede `0`: the retry insert can still legitimately succeed on its own; the new row's
`supersedesAssetId` may point at a fully-deleted id — an accepted, narrow, cosmetic residual (§ 2).

**Identity-race compensation** (unchanged from the prior round's fix — round 3 approved this part):
orphan-delete + collection-scoped, `NULL`-guarded winner repoint + `COLLECTION_RECEIVED_COUNT_SQL`,
one combined follow-up batch.

**Residual risk, honestly bounded.** A crash between the retry batch and either compensating batch
above is a real, accepted residual specific to this plan's own process reliability, distinct from
the cross-writer race § 2 addresses — the old row is left superseded with no confirmed replacement
in that narrow case, and is picked up correctly on the next sync attempt for the same path (which,
finding the row already superseded, falls through to the ordinary "genuinely new asset" path).
Self-correcting, not a permanent corruption.

### 2. Coordination with the admin-delete plan — the real fix, now with renewal

The admin-delete plan's Dropbox-deletion path acquires the same `raw_reconciliation_claims`
per-project lease this plan's `syncProjectRawFolder` already must acquire before any work
(`sync.ts:134-168`), held for that route's full operation window. **Round 6 review of the admin-
delete plan found its first version of this fix insufficient on its own**: a static lease with no
renewal could expire mid-operation (if R2 traversal or the Dropbox async-delete poll loop ran
long), letting this plan's sync reap and re-acquire the claim while the admin route was still
mid-flight — reopening the exact race the claim was meant to close. **That plan's current revision
fixes this by renewing the same lease throughout its operation** (before R2 traversal, and on
every Dropbox poll iteration), using the identical `renewRawReconciliationClaim` function this
plan's own sync code already depends on for its own long-running loop.

**This plan's sync code still needs zero changes for this** — the fix is entirely on the renewal
discipline of whichever side holds the claim at any given moment; this plan's existing claim-
acquisition `try`/`catch` (`sync.ts:138-168`) doesn't distinguish who it lost the race to, and
doesn't need to. A claim held-and-renewed by the admin-delete route is, from this file's
perspective, indistinguishable from a claim held by another concurrent sync run — the same
unique-constraint-violation handling applies either way, and continues to work correctly as long
as whoever holds the claim keeps it renewed for as long as they need it, which is now the other
plan's explicit responsibility, verified in its own testing section.

### 3. What is explicitly out of scope

- **AutoHDR "finals" ingest** — its normal replacement flow already performs a guarded supersede-
  before-insert and does not exhibit this exact silent-drop bug in its normal claimed-path flow.
  Note: round 6 review of the admin-delete plan confirmed AutoHDR finals assets also use `source:
  'dropbox'` — relevant to that plan's claim-scoping, not to this plan's own logic, which only
  ever touches RAW-collection assets.
- **Detecting deletion without a reupload** — already a known, pre-existing, documented gap.

## Testing requirements for the build

1. **The core bug, fixed**: seed a live asset at `sourcePathKey` X, hash A; sync a different file
   (hash B) at the same path. New row created, `supersedesAssetId` → old row, old row
   `supersededAt` non-null with `replacedByAssetId` → new row.
2. No regression on the ordinary new-file or ordinary update path.
3. Archived-project race: old row remains current, no orphaned new row.
4. **Supersede commits, retry insert fails, path genuinely free** — assert the compensating
   restore branch fires, old row back to current, count correct.
5. **Supersede commits, retry insert fails, but another row is now legitimately current at the
   same path** (construct this directly — seed a third row claiming the path between the retry
   batch and the compensation check) — assert the compensation's other branch fires: the old row
   stays superseded, `replacedByAssetId` repoints at the actual current occupant, no unique-
   constraint error, count correct. **This is the specific scenario round 4 found the prior
   design couldn't handle — must be tested as its own case, not folded into test 4.**
6. Identity-race: orphan-delete, collection-scoped `NULL`-guarded repoint, and count reconciliation
   all commit together atomically.
7. No-winner guard: `replacedByAssetId` left at its prior value rather than overwritten with `NULL`.
8. Genuine double-race, two distinct scenarios: a valid competing replacement wins (old row
   superseded, points at the actual winner) vs. no replacement exists (old row remains current).
9. Idempotency across repeated sync runs; multiple replacements over time; hashless files.
10. **The shared admin-delete race, exercised as true concurrency with a deterministic barrier**
    (matching the admin-delete plan's own test 6 requirement) — both orderings, exactly one
    proceeds, the loser backs off cleanly. Additionally: run this plan's sync against a project
    whose admin-delete claim is actively being **renewed** (not just held statically) — assert
    sync's own claim attempts continue to correctly lose for as long as renewal continues, not
    just at the moment of initial acquisition.
11. A real integration-level test driving `syncProjectRawFolder` itself through this scenario.
12. Full repo verify sequence per `CLAUDE.md` ("Verify before committing").

## Rollout

`workers/background` only — no schema change, no new route, no `workers/app`/`apps/web` change. No
deploy-order coupling to `docs/plans/Admin-Asset-Deletion-Plan.md`.

## Routing (per Subagent-Orchestration.md §2 routing table)

A small file-count change to a critical, high-traffic ingest path, carrying real concurrency and
compensation logic refined across four rounds of review that found genuine corruption paths in
earlier drafts — **normal feature or refactor** row, reviewed at a higher bar than that usually
implies given what's already been found: Terra plan review (loop until approved) → Terra build →
Terra diff review, fresh context → §5 gate → (once the user authorizes) commit and deploy.
