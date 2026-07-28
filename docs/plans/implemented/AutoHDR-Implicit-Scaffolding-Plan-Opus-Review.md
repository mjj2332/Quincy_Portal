# Independent Opus Review — AutoHDR Legacy Cleanup & Implicit Scaffolding (Round 7)

Reviewer: independent Opus pass (round 7 of 7). Read-only; no repo code was modified.
Base: round-6 plan + Sol round-6 review + round-7 corrections, all verified against live code.

---

# VERDICT: APPROVE WITH CORRECTIONS

The architecture is sound and I confirmed it independently rather than inheriting Sol's
conclusion. Implicit handoff rows as specified (claim `active`, mapping `active`, handoff
`started`, project `editing_autohdr`, `manifest_version = 1`) satisfy both downstream fences
with zero changes to fetch/write logic:

- `routeAutoHdrDelta()`'s selector — `mapping.ts:96-102` requires claim state ∈ (pending,
  active), mapping state ∈ (pending_discovery, active), handoff state = started, project stage
  = editing_autohdr. Implicit rows match all four.
- The single-leaf shape passes `mapping.ts:110-114` (`distinctCandidateKeys.size > 1` blocks
  multi-leaf) and `mapping.ts:144-149` (`finalPathKey` must equal the winning claim's pathKey —
  identical by construction for a single-leaf mapping).
- `writeAutoHdrFinal()`'s fence at `finals.ts:137-141` requires exactly
  `mappingState === "active"`, `handoffState === "started"`, stage ∈ (editing_autohdr,
  edited_review), matching `finalPathKey`, matching `manifestVersion`. Implicit rows pass.
- `autoHdrOutputMappings.handoffId` is declared `.unique()` (`schema.ts:439`), which structurally
  enforces the one-handoff→one-mapping invariant the whole design rests on.

Round 7 genuinely closes 5 of Sol's 8 findings outright, and its two riskiest claims — the
`changes()` semantics and the three RPC call-site transcriptions — hold up under direct
verification. What remains is mechanical: four concrete defects (three of them
data-integrity or availability affecting) plus a factually incorrect premise in Fix 3d. All are
tightly scoped, none is architectural, and a diff-review follows implementation. Hence
corrections rather than REQUEST CHANGES — but items P1–P4 in the punch-list are must-fix
before the first line is written, not nice-to-haves.

---

# Per-fix findings

## Fix 1 — audit keyed to the stage UPDATE's `changes()` — **RESOLVED**

The coordinator asked whether `changes()` actually behaves as assumed across sequential
statements inside a D1 `batch()`, rather than assuming SQLite semantics carry through D1's batch
API. It does, and this is not an inference — it is **shipped production behavior in three
separate live call sites**:

- `claims.ts:52-55` (`confirmAutoHdrHandoff`): statement 0 is
  `UPDATE projects SET stage_key = 'editing_autohdr' ... WHERE ... stage_key = 'raw_review'`,
  statement 1 is `INSERT INTO audit_log ... SELECT ... WHERE changes() = 1`. This is exactly the
  pattern Fix 1 proposes, for exactly the same audit action (`stage.auto_advance`).
- `index.ts:397-399` (`resolveAutoHdrMapping`): `UPDATE autohdr_output_mappings` followed by
  `INSERT INTO audit_log ... WHERE changes() = 1`.
- `index.ts:451-452` (`reassignAutoHdrPathClaim`): `UPDATE autohdr_path_claims` followed by
  `INSERT INTO autohdr_path_claims ... WHERE changes() = 1`.

So D1 executes batch statements sequentially on one connection and `changes()` reflects the
immediately preceding statement. Fix 1 correctly mirrors `claims.ts:51`, and correctly states the
adjacency requirement.

Two things to carry into implementation:

1. **Cross-fix hazard.** Fix 1 says "no statement may be inserted between Step 5 and Step 6," but
   Fix 3b independently introduces a *new* UPDATE into the same batch without specifying its
   position. It must go at the Step 4 slot (replacing the conditional path-claim INSERT), never
   after the stage UPDATE. See P2.
2. The round-6 success check reads `results[1]?.meta.changes` (round6:254) to detect handoff
   creation. Index 1 remains the handoff INSERT because the only conditional statement sits at
   index 3. That indexing is still valid after Fixes 1, 2 and 3b — but it is fragile, and the
   implementer should capture the index in a named constant rather than a literal.

## Fix 2 — unified eligibility predicate — **RESOLVED**, with one scope hole

The coordinator asked whether a fourth inconsistent guard was missed. I checked every
eligibility-shaped predicate in the implicit path:

| Site | Round-6 predicate | After Fix 2 |
|---|---|---|
| Manual router (round6:710) | `state IN (starting,started,blocked)` | no state filter |
| Provider router (round6:773) | `state IN (starting,started,blocked)` | no state filter |
| Job INSERT (round6:169) | `state IN (starting,started,blocked)` | no state filter |
| Handoff INSERT (round6:188) | already no state filter | unchanged |

Those four are now consistent. There is a **fifth** site — the `activeWinner` early-return at
round6:90-104, which still filters `state IN ('starting','started','blocked')`. This is *not* an
inconsistency bug: with Fix 2 the routers only call the helper for projects with zero handoff
rows, so `activeWinner` is reachable only via an intra-page race, which is precisely the
reuse case it is meant to serve. Leave it.

Worth noting, though: Fix 2 makes the round-6 `activeWinner` early-return's
`&& activeWinner.finalPath && activeWinner.finalPathKey` condition (round6:106) benign where it
would otherwise have been dangerous. A `starting` explicit handoff has a `pending_discovery`
mapping with `finalPath` NULL (`claims.ts:137`); without Fix 2, that condition would fail, fall
through, and attempt a second handoff INSERT that trips
`autohdr_handoffs_active_project_unique` (`schema.ts:428`). With Fix 2 the batch guards make
every statement no-op and the function returns `null` cleanly. Still, prefer returning early
whenever `activeWinner` is non-null rather than conditioning on `finalPath` — the current shape
only works by accident of Fix 2. Minor, see P8.

**Scope hole introduced by Fix 2 (new finding).** Fix 2 deliberately narrows implicit detection to
projects that have *never* had any handoff, and points retired/failed projects at backfill. But
backfill's inclusion query requires `stage_key = 'editing_autohdr'` (round6:981). A project whose
explicit send failed before `confirmAutoHdrHandoff()` ran is still in `raw_review`
(`claims.ts:52` is what moves it), and it now has a `failed`/`blocked` handoff row. Such a project
is excluded from the implicit path (has a handoff) *and* from backfill (wrong stage). Dropping
manual edits into its folder does nothing, silently. Either widen backfill's inclusion query to
include `raw_review` projects with only terminal handoffs, or state the hole explicitly as
accepted scope.

## Fix 3a — widen `ClaimRoute.candidate` — **RESOLVED**, de-hedge it

Round 7 hedges: "if such a type exists." It does. `mapping.ts:24-37` defines `ClaimRoute` with
`candidate: "final" | "finals"` at **`mapping.ts:27`**, and it is populated directly from the
column inside `const claims: ClaimRoute[] = await db.select({... candidate: autoHdrPathClaims.candidate ...})`
at **`mapping.ts:79-92`**. Widening the Drizzle enum breaks this assignment exactly as predicted.

I grepped the full TS surface: `mapping.ts:27` is the **only** narrowing in `src/`. The one other
hit, `test/autohdr-mapping.test.ts:4`, is a test-helper *parameter* typed `"final" | "finals"` —
narrower arguments assign fine to a wider field, so it will still compile. No other site needs
touching. State these two locations explicitly in the plan so the implementer doesn't grep blind.

## Fix 3b — drop the state filter, and the same-project reactivation branch — **STILL BROKEN**

Dropping the state filter is **correct**. The permanent unique index
`autohdr_path_claims_connection_path_unique` on `(connection_id, path_key)` (`schema.ts:478`) has
no state exception, so a `tombstone` row genuinely still occupies the slot, and the live collision
lookup at `claims.ts:158-159` deliberately carries no state filter. Fix 3b mirrors it correctly.

The **same-project reactivation UPDATE is not safe as written.** The coordinator specifically
asked whether it is safe in the same atomic batch as the other INSERTs given it targets a
different existing row. FK-wise, yes: D1 executes batch statements sequentially in one
transaction, so by the time the Step 4 UPDATE runs, Steps 2 and 3 have already inserted the
handoff and mapping the UPDATE points at, satisfying the immediate (non-deferred) FKs at
`schema.ts:466-467`.

But that reasoning only holds **when Steps 2 and 3 actually inserted**. Fix 3b's UPDATE has no
existence guard:

```sql
UPDATE autohdr_path_claims SET state='active', handoff_id=?, mapping_id=?, updated_at=? WHERE id=?
```

Every other statement in this batch is guarded — round6:204 (`WHERE EXISTS ... autohdr_handoffs`),
round6:224 (`WHERE EXISTS ... autohdr_output_mappings`), round6:238 (`AND EXISTS ...`). If the
handoff INSERT no-ops (ineligible project or a concurrent creation), the mapping INSERT no-ops
too, and this unguarded UPDATE then rebinds a live path claim to a `handoff_id`/`mapping_id` that
were never inserted → FK violation → the entire batch throws. That converts the intended graceful
`return null` into an exception that propagates out of the router, out of `DropboxSyncDO.alarm()`,
and past the cursor commit at `dropbox-sync.ts:135` — whose own comment says "A thrown route/import
leaves this page retryable." The page then retries forever and wedges the AutoHDR monitor.

Required: add `AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)` bound to the new
`mappingId`, matching round6:224.

Two secondary defects in the same UPDATE:

- It does not clear `diagnostic`. Both live reactivation precedents do —
  `index.ts:451` (`diagnostic = NULL`) and `index.ts:400`. A reactivated claim would carry a stale
  collision message into a healthy generation. Add `diagnostic = NULL`.
- It has no state restriction, whereas the live reassign UPDATE restricts
  `AND state in ('tombstone','blocked')` (`index.ts:451`).

**Also worth flagging: this branch is dead code in the implicit path.** `autohdr_path_claims.handoffId`
is NOT NULL with `onDelete: "restrict"` (`schema.ts:467`), so a path claim's existence implies a
handoff row exists. After Fix 2, any project owning a same-project claim necessarily has a handoff
and is therefore excluded by the routers before `claimImplicitAutoHdrHandoff()` is ever called.
The branch is genuinely needed in **backfill** (Fix 7d), where projects do have prior handoffs.
This is a sign Fixes 2 and 3b were authored independently. Keep the branch (defense in depth, and
backfill shares the helper shape), but fix the guard and note in the plan that it is unreachable
from the implicit entry point.

## Fix 3c — no SQL migration needed for the enum widening — **RESOLVED**

Verified directly. `packages/db/migrations/0013_overjoyed_scarlet_witch.sql:112` declares
`` `candidate` text NOT NULL `` with no CHECK constraint. Drizzle's `{ enum: [...] }` is a
TypeScript-level refinement only. No DDL required. Fix 3c is correct and the instruction to say so
explicitly in Part 2.2 is well judged.

## Fix 3d — manual-collision recovery — **PREMISE IS FACTUALLY WRONG**

Fix 3d states a manual-channel collision "is handled ONLY via the standard blocked-mapping/blocked-
handoff path (staff resolves manually through existing admin tooling)." I checked both existing
recovery RPCs against the rows an implicit collision actually produces, and **neither can resolve
it — for either channel, not just manual.**

The root cause is that round 6 deliberately **skips the path-claim INSERT entirely on collision**
(round6:214-230, "Executed ONLY if `!isCollision`"). So a collided implicit mapping has **zero**
`autohdr_path_claims` rows. Consequently:

- `resolveAutoHdrMapping()` selects the chosen claim under that mapping and throws
  `"Blocked AutoHDR mapping candidate was not found"` at **`index.ts:389`** when there is none.
  Unusable.
- `reassignAutoHdrPathClaim()` requires the path to be one of the target handoff's frozen
  candidates — `if (!candidates.map(dropboxPathKey).includes(source.pathKey)) throw ...` at
  **`index.ts:445`**, where `candidates` comes from `autoHdrFinalPathCandidates()` and yields only
  the two provider leaves. A `04-MANUAL-Photos` leaf is rejected outright. It then does
  `candidates.find(...)!` at `index.ts:446` assuming exactly two candidates. Unusable for manual.

Now compound that with Fix 2 and backfill: the collided project *now has a handoff row*, so the
routers will never re-detect it; and its handoff is `blocked`, which backfill's `activeHandoff`
pre-check (round6:856-858) treats as active and skips. **An implicit collision is a terminal
dead-end recoverable only by direct D1 surgery.**

Options, any of which is acceptable — but the plan must stop asserting a recovery path that does
not exist:
(a) On collision, still INSERT the path claim in state `blocked` when no row exists for that
    `(connection_id, path_key)` — but that is precisely the unique-index conflict case, so it only
    helps where the collision is same-project;
(b) extend `reassignAutoHdrPathClaim()` to accept a manual leaf; or
(c) accept the dead-end and document that resolution is a manual D1 operation, and add the
    collided state to an operator-visible surface so it is at least discoverable.

## Fix 4 — missing `autohdr_scaffold_claims_project_idx` — **RESOLVED**

Trivial and correct. The Drizzle definition at round6:305 declares it; the migration omitted it.
The added `CREATE INDEX IF NOT EXISTS` matches the naming convention used throughout 0013.

## Fix 5 — positional leaf index — **RESOLVED**

Correct. Both filters already establish `parts.length >= 4` and
`parts[parts.length - 2] === <leaf>` (round6:686-693, round6:747-755), so `parts.length - 2` is
exactly the validated leaf index and cannot disagree with the filter the way `findIndex()` could.
The retained `if (idx <= 1) continue` becomes dead (it is ≥ 2 by the `length >= 4` filter) but is
harmless.

One caveat the plan should state: `parts.slice(0, idx)` is computed from `path_lower` while the
leaf path is computed from `displayParts` of `path_display`. This relies on `path_display` and
`path_lower` having identical segment counts. Dropbox guarantees that (same path, differing case),
and `path_display` is optional in the live type (`client.ts:29`, `client.ts:37`) so the
`?? entry.path_lower` fallback is right. Fine as written.

## Fix 6 — full delete/restore of `edited_source_claims` — **RESOLVED, genuinely safe**

The coordinator asked whether deleting the entire table risks conflicting with anything else
referencing these rows during the migration window. I verified: **nothing has a foreign key
referencing `edited_source_claims`.** It is a leaf table — `schema.ts:551-566` shows only outbound
FKs (to `collections`, `assets`, `autohdr_handoffs`). So the full delete cannot cascade or
restrict anything, and the restore replays exact rows into an empty table, so the unique index
`edited_source_claims_collection_path_unique` (`schema.ts:563`) is trivially satisfied.

Fix 6 is also the *correct* choice over the alternative: Sol's finding was a scope mismatch
between a full-table backup (round6:565) and a partial delete (round6:573). Matching the delete to
the backup keeps the row-count assertion at round6:638-639 meaningful, which restoring-a-subset
would not.

Three notes for implementation:

- **Unnecessary work, now removable.** The migration backs up, nulls, and restores
  `assets.autohdr_handoff_id` (round6:567, 575, 618). But `schema.ts:335` declares
  `autoHdrHandoffId: text("autohdr_handoff_id")` with **no `.references()`** — there is no FK to
  violate. Those three statements can be dropped entirely; if they are dropped, all three must go
  together.
- **Column-order safety — I verified this, it is fine.** `INSERT INTO autohdr_handoffs SELECT *
  FROM _bk_autohdr_handoffs` (round6:612) depends on the recreated table's column order exactly
  matching the original, or data shifts silently between compatible types. I diffed round6:580-604
  against the original `CREATE TABLE autohdr_handoffs` in `0013_overjoyed_scarlet_witch.sql`: all
  19 columns are in identical order, and the sole difference is
  `initiated_by text NOT NULL` → `initiated_by text`. Safe. Worth asserting in the migration test
  so a future edit can't silently break it.
- **The one real residual risk is transactionality**, not FK safety: the entire scheme (TEMP
  tables surviving across `--> statement-breakpoint` chunks, and a `CHECK` failure rolling back
  prior statements) depends on D1 applying the migration file as a single transaction. Sol
  verified this against the wrangler bundle and reproduced the CHECK failure locally; round 6
  already specifies a migration test (round6:1166-1168). Treat that test as a gate: run 0015
  against a populated copy before prod. Also run it during a quiet window — a concurrent
  `edited_source_claims` write landing between the DELETE and the restore would collide on the
  unique index.

## Fix 7a / 7b / 7e — **RESOLVED**

- **7a**: Confirmed the gap is real. `rpc-types.ts:4-16` declares the full RPC surface and contains
  no `backfillAutoHdrV2`. `backfillRenditions` at `rpc-types.ts:15` is a good precedent for the
  shape (optional params object, structured result). The rename to `backfillAutoHdrV2Impl` to
  avoid the method/free-function collision is correct.
- **7b**: Transcription verified **exact**. `admin.ts:23-25` defines
  `function adminAllowed(c: Context<AppEnv>) { return ROLE_CAPABILITIES[c.get("user").role].includes("adminBackend"); }`
  and `admin.ts:39` shows the inline usage
  `if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);`
  exactly as quoted. The observation that `projects.ts` uses a real `requireCapability` middleware
  while `admin.ts` uses this inline pattern is also correct (`projects.ts:228`, `:247`, `:258`).
- **7e**: Correct per `CLAUDE.md` (prod is `https://quincy.flamingfire.my`).

## Fix 7c — backfill atomicity — **INCOMPLETE, re-introduces the exact bug Fix 2 fixed**

On the coordinator's specific question — whether the re-checked eligibility guard disagrees with
`claimBackfillAutoHdrHandoff()`'s own earlier `activeHandoff` pre-check and produces a confusing
return value:

- The **handoff-state halves agree exactly.** Pre-check (round6:856-858) is
  `inArray(state, ["starting","started","blocked"])` → return null; the new INSERT guard is
  `NOT EXISTS (... state IN ('starting','started','blocked'))`. Same predicate. No disagreement.
- They **disagree on the project predicate.** The INSERT adds
  `stage_key = 'editing_autohdr' AND archived_at IS NULL`; the pre-check has neither, and the
  caller's inclusion query (round6:980-990) has `stageKey` but **not** `archived_at IS NULL`. Net
  effect: an archived project sitting in `editing_autohdr` is selected by the inclusion query,
  passes the pre-check, no-ops at the INSERT, and is reported as
  `"Handoff creation ineligible or active handoff exists"` (round6:1024) — a misleading reason,
  not a correctness bug. Add `isNull(projects.archivedAt)` to the inclusion query and give the
  no-op a distinct skip reason.

**The material defect Fix 7c misses:** it adds the guard to the handoff INSERT and adds a
`changes()` check, but leaves backfill's other three statements as unguarded plain `VALUES`
inserts:

- **jobs INSERT (round6:882-885)** — plain `VALUES`, no guard. When the handoff INSERT no-ops, the
  job row still commits. This is *precisely* Sol's item-2 orphaned-job defect, fixed for the
  implicit path by Fix 2 and reintroduced verbatim in backfill.
- **mapping INSERT (round6:901-906)** — plain `VALUES` referencing `handoffId`. When the handoff
  no-ops, this violates `autohdr_output_mappings.handoff_id → autohdr_handoffs.id`
  (`schema.ts:439`) and the **batch throws**. Which means Fix 7c's "check `changes()` and return
  null" logic is unreachable in the very scenario it was written for.
- **path-claim INSERT/UPDATE (round6:918-925)** — plain `VALUES` referencing `mappingId`; same
  failure against `schema.ts:466`.

All four statements must carry the implicit path's guard pattern (`WHERE EXISTS`/`NOT EXISTS`
against the row inserted immediately prior), as at round6:165-170, :204, :224.

## Fix 7d — backfill collision handling — **RESOLVED in intent, inherits 3b and 3d**

The collision pre-check mirroring Fix 3b is right. Two inherited issues: it needs the same
existence guard as P2 on its reactivation UPDATE, and the blocked rows it produces land in the
same unrecoverable state described under Fix 3d.

## Fix 8a — result/error types — **RESOLVED**

Correct and complete for the codes round 6's classifier actually emits (round6:413-416 maps
unmatched messages to `ERR_HANDOFF_BLOCKED`, so the union is closed). Updating
`rpc-types.ts:6-7` in the same change is mandatory, not optional — the app worker's typecheck
depends on it, and per `CLAUDE.md` `npm run typecheck` must be green.

## Fix 8b — the three RPC call sites — **TRANSCRIPTION VERIFIED EXACT; open question resolved**

I spot-checked all three against the live file, as asked. Every quoted "real current body" is
byte-accurate:

- **Site 1**, `POST /projects/:id/send-to-autohdr` — `projects.ts:242-244`:
  `const { jobId } = await c.env.BACKGROUND.startAutoHdr(id, c.get("user").id);` then the audit
  call then `return c.json({ jobId });`. Matches.
- **Site 2**, `POST /projects/:id/fetch-edited` — `projects.ts:253-255`. Matches. And the claim
  that round 6 missed this route entirely is correct — Sol's item 8 cited `projects.ts:242`,
  `:253` and `:396` but round 6's text only addressed the background-worker methods.
- **Site 3**, `POST /jobs/:id/retry` — `projects.ts:396-402`, the three-way ternary into
  `const { jobId }`. Matches, including that the manual-publish branch is a separate shape.

**The open item is resolvable and I am closing it:** `rpc-types.ts:11` declares
`abstract publishManualUpload(projectId: string, assetId: string): Promise<{ jobId: string }>`.
So the bare-`{jobId}` assumption holds and the `.then((r) => r.jobId)` normalization in Fix 8b is
correct as written. The implementer does not need to re-verify this.

One refinement: returning `409` for every error code is coarse. The live route already
distinguishes — `projects.ts:234` returns 409 for archived, `projects.ts:241` returns 400 for no
selection. Map `ERR_NO_RAW_SELECTION` → 400 and keep 409 for the rest, to preserve existing client
behavior.

## Fix 8c — restore job-failure cleanup — **CORRECT; its open question is also resolvable**

The regression is real: live `index.ts:152` does
`await setJobStatus(db, owner.jobId, "failed", ...)` in the catch, and round 6's rewrite drops it.

**The `jobId`-in-scope question has a definite answer, and it is "no."** In the live code
`const owner = await claimAutoHdrHandoff(this.env, projectId, initiatedBy);` sits at
**`index.ts:124`, outside the `try`** — the `try` opens at `index.ts:126`. That is exactly why
`owner.jobId` is in scope at the live cleanup on line 152. Round 6 moved the claim *inside* the
try (round6:377), which is what breaks the scope. The implementer must hoist
`let owner: HandoffOwner | undefined;` above the `try` and guard `if (owner) { ... }` in the
catch. No further investigation needed.

Related caution: `claimAutoHdrHandoff()` already marks the job failed on its own eligibility abort
(`claims.ts:145`) and inserts a pre-failed job on the collision path (`claims.ts:174`). Since
those throw *before* `owner` is assigned, the hoisted-`owner` guard naturally avoids
double-failing. Good — but only if the guard is on `owner`, not on a separately tracked `jobId`.

## Fix 8d — reuse the already-live status endpoint — **TRANSCRIPTION VERIFIED EXACT**

Verified against `projects.ts:258-292`. Every detail in round 7 is accurate:

- Same path, same guard: `projectsRoutes.get("/projects/:id/autohdr-status", requireCapability("adminBackend"), ...)`
  at `projects.ts:258`.
- "loads the latest-generation handoff joined to its mapping" — confirmed: inner join at
  `projects.ts:274`, `.orderBy(desc(schema.autoHdrHandoffs.generation)).get()` at `projects.ts:276`.
- `if (!handoff) return c.json({ handoff: null });` at `projects.ts:277`. Confirmed.
- The nine listed fields (`id`, `generation`, `state`, `readinessUnitsJson`, `selectionHash`,
  `manifestVersion`, `mappingState`, `finalPath`, `diagnostic`) match `projects.ts:263-272`
  exactly, and the response spreads them plus `readinessUnits` and `associations`
  (`projects.ts:285-291`). Exact.

The route conflict Sol flagged is genuine, and deleting round-6 Part 7.1 rather than reconciling
it is the right call.

**One gap in 8d's derivation table (new finding).** The live query has **no state filter** — it
returns the latest handoff whatever its state. So after a handoff is retired or fails, the poll
returns a non-null handoff with `state: "retired" | "failed"`. 8d's four rules have no case for
those, so they fall through to "Any other combination → in progress, keep polling," which is
wrong and polls forever. Add an explicit terminal case: `retired`/`failed` → treat as
none/terminal and stop polling.

## Fix 8e — frontend hook stores state — **RESOLVED in intent; two implementation notes**

The `lastMappingState` transition guard is a genuine improvement over round 6's refresh-every-tick.
Two corrections:

- `lastMappingState` is a plain closure variable, re-initialized to `null` every time the effect
  re-runs. `refreshAssets` is in the dependency array (round7:489); if its identity is not stable
  the effect tears down and rebuilds, resetting the guard and re-triggering the refresh. Use a
  `useRef` so the last-seen state survives effect re-runs.
- Unbounded 5s polling for as long as the project sits in `editing_autohdr`. Per
  `docs/lessons.md:350` this account is on the Workers **Free** plan (100k requests/day); each
  open workspace costs 12 req/min indefinitely. Stop polling on terminal/blocked states and back
  off after the mapping goes active.

The prop-threading item is explicitly flagged as implementer-confirm in round 7, so per the review
brief I am not treating it as a defect.

---

# Independent findings — round-6 sections round 7 did not touch

## N1. Router per-file fan-out will exhaust the Free-plan subrequest budget — **highest-severity finding**

Both routers loop over every matching **file** (round6:697, round6:760). Per file they run a
scaffold-claim `SELECT` (round6:704-711) and then a full `claimImplicitAutoHdrHandoff()`, which
itself costs an `activeWinner` SELECT (round6:90), a collision SELECT (round6:121), and a
`DB.batch()` (round6:251) — so **≥4 D1 round-trips per file**, of which all but the first file's
are redundant work that lands on the `reused: true` early-return.

This is not theoretical. `docs/lessons.md:350` records that this account's Workers **Free** plan
caps subrequests at **50 per invocation**, and that "Every 'Too many subrequests by single Worker
invocation' failure traces here." `docs/todo.md:142` confirms the Free plan, and the two most
recent commits on `main` (`c00abbe` "remove limits block — unsupported on the Workers Free plan",
`03ca78f` "fix: dropbox-sync subrequest budget") show this has already bitten this exact
Durable Object.

A single realistic drop — 40 photos into one `04-FINAL-Photos` folder arriving in one delta page —
costs ~160 D1 calls in one `alarm()` invocation. That blows the 50-subrequest cap, throws, and
because the cursor is only committed *after* the routing loop (`dropbox-sync.ts:135`, with the
comment "Work is durable before the cursor commit. A thrown route/import leaves this page
retryable"), the page retries forever. **The AutoHDR monitor wedges permanently on the first real
manual drop.**

Fix is simple and must be in the plan before implementation: **dedupe entries by
`scaffoldPathKey` before the loop** and call `claimImplicitAutoHdrHandoff()` once per distinct
folder, not once per file. That reduces a 40-photo drop from ~160 calls to ~4. Additionally cap
the number of distinct folders processed per alarm pass.

## N2. `matchedCount` mixes two different units

round6:820 computes
`matchedCount = explicitRouted.matched + manualRouted.matched + providerRouted.matched`. But
`routeAutoHdrDelta()` returns `matched: matches.size` — a count of **mappings**
(`mapping.ts:104`, `mapping.ts:164`) — whereas both new routers increment `matched++` once per
**file** (round6:714, round6:777). That sum then feeds
`skippedCount: page.entries.length - matchedCount` in the health row (`dropbox-sync.ts:151`),
which can now go negative. Telemetry-only, but it corrupts the monitor-health signal operators
rely on. Pick one unit; deduping per N1 makes "distinct folders matched" the natural choice.

## N3. Implicit handoffs carry an empty readiness manifest — UI consequence

round6:181-182 writes `selection_hash = 'implicit-autodetect'` with `selected_asset_ids_json` and
`readiness_units_json` both `'[]'`. That is inherent to implicit detection — there is no frozen
selection to snapshot. But the live status endpoint parses that into `readinessUnits: []`
(`projects.ts:288`), and `POST /projects/:id/autohdr-coverage` (`projects.ts:315`) will compute
coverage against zero units. The UI must not render an implicit handoff as "0 of 0 covered" or
"0% complete" — it needs a distinct "auto-detected, no frozen manifest" presentation. Worth a line
in the plan so this doesn't surface as a bug report after ship.

## N4. Implicit handoffs store a `workflow_id` for a Workflow that is never created

round6:134 sets `workflowId = \`autohdr-implicit-${projectId}-g1\`` to satisfy the NOT NULL +
UNIQUE column (`schema.ts:417`), but nothing ever calls `AUTOHDR_WORKFLOW.create()` for an
implicit handoff. That is fine by itself, but round 6's own `startAutoHdr()` already-exists
recovery path (round6:408-410) looks up a handoff by `projectId` and returns
`existing.workflowId` to the caller as if it were a live Workflow. Reachability is low —
`claimAutoHdrHandoff()` requires stage `raw_review` (`claims.ts:82`) and an implicit handoff has
already moved the project to `editing_autohdr` — but the recovery SELECT at round6:409 has no
state filter and could pick up an implicit row. Add a state filter there, and document that
implicit `workflow_id` values are placeholders.

## N5. `expected_origin_stage` records the current stage rather than a constant

round6:183 selects `stage_key` from the project into `expected_origin_stage`, so a project already
in `editing_autohdr` records `'editing_autohdr'`. The column defaults to `'raw_review'`
(`schema.ts:416`) and the explicit path hardcodes `'raw_review'` (`claims.ts:135`). Nothing
currently reads it, so this is not a live bug — but it is an audit-semantics field and the
divergence should be deliberate, not incidental. Recommend hardcoding `'raw_review'` for
consistency with the explicit path.

## N6. Collision still advances the project stage

The Step 5 stage UPDATE (round6:232-240) is guarded only on the handoff existing, not on
`!isCollision`. So a collided implicit detection moves the project `raw_review → editing_autohdr`
with a `blocked` handoff, a `blocked_collision` mapping, and no path claim. Combined with Fix 3d's
non-existent recovery path, this actively worsens the dead-end — the project has now also lost its
`raw_review` stage, which is what `claimAutoHdrHandoff()` requires (`claims.ts:82`), so even a
manual explicit re-send is blocked. Decide deliberately: either don't advance the stage on
collision, or make the collision recoverable per Fix 3d.

---

# Punch-list — must be resolved before implementation starts

Ordered by severity. P1–P4 are blockers for the *implementation*, not for approving the plan.

**P1. Dedupe router entries by `scaffoldPathKey` before calling `claimImplicitAutoHdrHandoff()`.**
Per-file fan-out (round6:697, round6:760) costs ≥4 D1 calls per file against a 50-subrequest
Free-plan cap (`docs/lessons.md:350`); a 40-photo drop wedges the monitor permanently via the
retry path at `dropbox-sync.ts:135`. One claim call per distinct folder. Also cap folders per pass.

**P2. Add an existence guard to Fix 3b's reactivation UPDATE**, matching round6:224:
`AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)`. Also add `diagnostic = NULL`
and a `state IN ('tombstone','blocked')` restriction, per `index.ts:451`. Without the guard an
ineligible project turns a graceful `return null` into an FK-violation throw that wedges the alarm.

**P3. Apply the guard pattern to all four of backfill's batch statements, not just the handoff
INSERT.** round6:882-885 (jobs), round6:901-906 (mapping), round6:918-925 (path claim) are plain
`VALUES`. As written, Fix 7c leaves an orphaned-job path identical to Sol's item 2 and makes its
own `changes()` check unreachable (the mapping FK throws first).

**P4. Correct Fix 3d — the stated recovery path does not exist.** A collided implicit mapping has
zero path claims, so `resolveAutoHdrMapping()` throws at `index.ts:389` and
`reassignAutoHdrPathClaim()` rejects at `index.ts:445`. Either provide a real recovery mechanism
or document the dead-end explicitly and make it operator-visible. Decide N6 (stage advance on
collision) as part of this.

**P5. Fix batch-position coupling between Fix 1 and Fix 3b.** The reactivation UPDATE must occupy
the Step 4 slot, before the stage UPDATE, or it breaks the `changes()` adjacency Fix 1 depends on.
State this in the plan; capture the handoff-result index (round6:254) as a named constant.

**P6. Add the terminal-state case to Fix 8d's derivation.** The live endpoint has no state filter
and orders by `desc(generation)` (`projects.ts:275-276`), so `retired`/`failed` handoffs are
returned and currently fall into "keep polling forever."

**P7. Close the Fix 2 coverage hole**, or document it as accepted: a project with only a
terminal handoff, still in `raw_review`, is excluded from both the implicit path (has a handoff)
and backfill (round6:981 requires `editing_autohdr`).

**P8. Smaller, mechanical:**
- Name `mapping.ts:27` explicitly as the sole `ClaimRoute.candidate` narrowing (Fix 3a is hedged);
  `test/autohdr-mapping.test.ts:4` needs no change.
- Fix `matchedCount` unit mixing (N2, round6:820 → `dropbox-sync.ts:151`).
- Drop the unnecessary `assets.autohdr_handoff_id` backup/null/restore trio (round6:567, 575, 618)
  — `schema.ts:335` has no FK. All three together or none.
- Add `isNull(projects.archivedAt)` to backfill's inclusion query (round6:980) and give the
  INSERT no-op a distinct skip reason.
- Hoist `let owner: HandoffOwner | undefined` above the `try` in `startAutoHdr()` — Fix 8c's open
  question is answered: `owner` is not in scope in round 6's catch (live code has it at
  `index.ts:124`, outside the try).
- Map `ERR_NO_RAW_SELECTION` → 400, not 409, matching `projects.ts:241`.
- Use a `useRef` for `lastMappingState` and stop/back off the 5s poll (Fix 8e).
- Handle N3 (empty readiness manifest in the coverage UI), N4 (phantom `workflow_id` — add a state
  filter at round6:409), N5 (`expected_origin_stage`).

**Verification gates carried forward:** run the 0015 migration test (round6:1166-1168) against a
populated copy before prod, asserting handoff column order explicitly; `npm run typecheck` and
`npm run build -w @quincy/web` green; and `npx vitest run --config packages/shared/vitest.config.ts`
per `CLAUDE.md`.

---

# Items I verified and am closing — no implementer action needed

- `changes()` semantics across D1 `batch()` — confirmed by three live production usages
  (`claims.ts:52-55`, `index.ts:397-399`, `index.ts:451-452`). Fix 1's assumption is shipped
  behavior, not an inference.
- `publishManualUpload` returns `Promise<{ jobId: string }>` — `rpc-types.ts:11`. Fix 8b's
  normalization is correct as written; round 7's open question is resolved.
- `owner` scope in `startAutoHdr()`'s catch — resolved above (P8), no investigation needed.
- Migration handoff column order — diffed round6:580-604 against
  `0013_overjoyed_scarlet_witch.sql`; identical 19-column order, sole diff is the intended
  `initiated_by` nullability. `SELECT *` restore is positionally safe.
- `edited_source_claims` full delete/restore FK safety — nothing references the table
  (`schema.ts:551-566` is outbound-only). Genuinely safe.
- The `candidate` enum needs no DDL — `0013_overjoyed_scarlet_witch.sql:112` is unconstrained TEXT.
- Fix 7b's `adminAllowed` transcription — exact (`admin.ts:23-25`, usage at `admin.ts:39`).
- Fix 8b's three call sites and Fix 8d's status endpoint — all transcriptions exact
  (`projects.ts:242-244`, `:253-255`, `:396-402`, `:258-292`).
- The `DropboxEntry` union — `client.ts:41`, matches what the routers narrow against; the
  `deleted` variant lacks `name`, and the routers' `.tag !== "file"` early return narrows
  correctly before touching `e.name`.
