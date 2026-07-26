# Round 7 Plan: AutoHDR Legacy Removal & Implicit Scaffolding Architecture (Final)

## Provenance

Rounds 1–6 went through the Agy-draft / Sol-review loop (`docs/Subagent-Orchestration.md`).
Round 6 was confirmed architecturally sound by Sol across three consecutive rounds (4, 5, 6);
the single-leaf, first-channel-wins design requires zero changes to `writeAutoHdrFinal()`, the
`AutoHdrFetch` workflow, or `claimAutoHdrFetch()`. Round 6's remaining defects were 8 concrete,
mechanical items, listed below with their fixes. This round was produced by the orchestrating
session directly (not Agy) per explicit user instruction, and is submitted for one independent
Opus review before being handed off for implementation.

Full round-6 base text: [`AutoHDR-Implicit-Scaffolding-Plan-Base-R6.md`](AutoHDR-Implicit-Scaffolding-Plan-Base-R6.md)
(same directory). Full independent Opus final review:
[`AutoHDR-Implicit-Scaffolding-Plan-Opus-Review.md`](AutoHDR-Implicit-Scaffolding-Plan-Opus-Review.md).
**Read this file (round 7/8, the corrections) together with the R6 base file — this file only
patches R6, it does not restate it.**

Everything not called out below is unchanged from round 6 and still applies: the overall
architecture (implicit handoffs single-leaf, first-channel-wins, `NOT EXISTS`-guarded), the
scaffold-claims table and its one-active-per-project partial unique index, the legacy code
removal inventory, and the general shape of Parts 1–8.

---

## Fix 1 — Audit-log guard must key off the stage UPDATE's own `changes()`, not a separate EXISTS

**Problem (Sol round 6, item 1):** the audit insert used
`WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ${handoffId})`, which is true regardless
of whether the immediately preceding stage UPDATE actually changed the project's stage. An
already-`editing_autohdr` project (stage UPDATE's `WHERE stage_key = 'raw_review'` clause matches
zero rows) still gets a false `raw_review -> editing_autohdr` audit entry.

**Fix:** change Step 6 (audit_log) in `claimImplicitAutoHdrHandoff()`'s batch to key off
`changes()` from the immediately preceding statement (the Step 5 stage UPDATE), matching the live
pattern at `claims.ts:51`:

```sql
-- Step 5: Stage UPDATE (unchanged from round 6)
UPDATE projects
SET stage_key = 'editing_autohdr', updated_at = ?
WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL
  AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?);

-- Step 6: Audit Log — now keyed to the stage UPDATE's own changes()
INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
SELECT ?, NULL, 'stage.auto_advance', 'project', ?, ?, ?
WHERE changes() = 1;
```

No statement may be inserted between Step 5 and Step 6 in the batch array, since `changes()`
reflects only the most recently completed statement on the connection.

---

## Fix 2 — Unify the eligibility predicate across router, job insert, and handoff insert

**Problem (Sol round 6, item 2):** three different eligibility checks disagreed. The job insert
and both routers excluded only handoffs in `('starting', 'started', 'blocked')`; the handoff
insert excluded ANY handoff row for the project. For a project with a retired/failed handoff, the
router would route it and the job insert would succeed, but the handoff insert would then no-op
(zero rows) — leaving a committed, orphaned `'done'` job with no handoff ever created.

**Fix:** every eligibility check in the implicit (never-sent) path must use the SAME predicate:
`NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ?)` — i.e. a project is eligible
for implicit auto-detection only if it has NEVER had any handoff row at all, in any state. A
project with a retired/failed handoff is not "never sent" and is explicitly out of scope for the
implicit path — it is instead a backfill candidate (Fix 7 covers backfill's own, deliberately
looser, eligibility).

Concretely:
- In `routeAutoHdrManualDropDelta()` and `routeAutoHdrProviderDelta()`, change the scaffold-claim
  query's `NOT EXISTS` subquery from
  `AND state IN ('starting', 'started', 'blocked')` to no state filter at all:
  `sql\`NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = autohdr_scaffold_claims.project_id)\``
- In `claimImplicitAutoHdrHandoff()`'s Step 1 (jobs) `WHERE` clause, change
  `AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ? AND state IN ('starting', 'started', 'blocked'))`
  to
  `AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ?)`
  — identical to Step 2's (handoff insert's) existing guard.

---

## Fix 3 — Enum, candidate-type, and collision-detection corrections

**3a. Widen the `ClaimRoute`/`RoutedAutoHdrMapping` candidate type.** The Drizzle schema's
`autoHdrPathClaims.candidate` is widened to `"final" | "finals" | "manual"` (round 6, correct).
Any TypeScript type elsewhere in `mapping.ts` (e.g. a `ClaimRoute.candidate` field, if such a
type exists and is populated from a query against this column) must be widened identically to
`"final" | "finals" | "manual"`, or the query result will no longer satisfy the narrower type.
Locate every place `autoHdrPathClaims.candidate` is typed narrower than the schema and widen it.

**3b. Collision detection must not ignore `tombstone` rows.** The permanent unique index on
`(connection_id, path_key)` (schema.ts:478) has NO state exception — a `tombstone` row still
occupies its slot. Round 6's collision precheck filtered
`inArray(autoHdrPathClaims.state, ["pending", "active", "blocked"])`, silently excluding
tombstoned rows from consideration; a fresh INSERT attempt against a tombstoned path then trips
the unique index and aborts the whole batch instead of being handled gracefully. Fix: drop the
state filter entirely (mirror the live pattern at `claims.ts:158`, which deliberately has none):

```ts
const collidingClaim = await db.select({ id: autoHdrPathClaims.id, projectId: autoHdrPathClaims.projectId, state: autoHdrPathClaims.state })
  .from(autoHdrPathClaims)
  .where(and(
    eq(autoHdrPathClaims.connectionId, connectionId),
    eq(autoHdrPathClaims.pathKey, targetPathKey),
  )).get();
```

Then branch three ways, not two:
- No row at all → proceed to INSERT a new claim (round 6's existing non-collision path).
- Row exists, owned by a DIFFERENT project → `isCollision = true` (round 6's existing collision
  path: blocked mapping/handoff, no claim insert attempted).
- Row exists, owned by THIS SAME project (a stale/tombstoned claim from a prior generation for
  this exact project) → do not INSERT a new claim row (would violate the unique index even though
  it's the same project); instead reactivate it in place as part of the same batch:
  `UPDATE autohdr_path_claims SET state='active', handoff_id=?, mapping_id=?, updated_at=? WHERE id=?`
  bound to the new `handoffId`/`mappingId` being created in this same transaction. This mirrors
  the reactivation pattern already used for `autohdr_scaffold_claims` and for backfill's tombstone
  reactivation (Fix 7).

**3c. The `candidate` enum widening needs no SQL migration.** The live `autohdr_path_claims`
column is unconstrained `TEXT` (confirmed against `0013_overjoyed_scarlet_witch.sql:113`), so
widening `candidate` to include `"manual"` is a TypeScript/Drizzle-schema-only change — remove any
implication that migration 0015 needs a DDL statement for this; it doesn't. State this explicitly
in Part 2.2 so an implementer doesn't go looking for SQL that isn't needed.

**3d. Manual-channel collisions and the live reassignment path.** The existing collision-recovery
mechanism at `index.ts:444` only validates the two provider candidates (`final`/`finals`) — it has
no equivalent for a manual-leaf collision. This plan does not extend that mechanism. State
explicitly: a manual-channel collision is handled ONLY via the standard blocked-mapping/blocked-
handoff path (staff resolves manually through existing admin tooling); automatic reassignment to
an alternate candidate is out of scope for the manual channel in this plan.

---

## Fix 4 — Add the missing `autohdr_scaffold_claims_project_idx` index to migration 0015

Round 6's Drizzle schema declares `index("autohdr_scaffold_claims_project_idx").on(t.projectId)`,
but the migration SQL only creates the two unique indexes. Add to the migration script, right
after the two existing `CREATE UNIQUE INDEX` statements for this table:

```sql
CREATE INDEX IF NOT EXISTS `autohdr_scaffold_claims_project_idx` ON `autohdr_scaffold_claims` (`project_id`);--> statement-breakpoint
```

---

## Fix 5 — Derive the leaf-folder index positionally, not via `findIndex()`

**Problem (Sol round 6, item 5, minor correction):** `parts.findIndex((p) => p === "04-manual-photos")`
finds the FIRST occurrence of that segment name in the path, which could disagree with the
already-validated direct-parent check (`parts[parts.length - 2] === "04-manual-photos"`) if the
segment name happens to repeat earlier in the path (e.g. inside a project folder name that
contains that literal string).

**Fix:** in both `routeAutoHdrManualDropDelta()` and `routeAutoHdrProviderDelta()`, replace the
`findIndex()` call with the positional index already implied by the filter step:

```ts
// Manual router — replace:
//   const manualIdx = parts.findIndex((p) => p === "04-manual-photos");
//   if (manualIdx <= 1) continue;
// with:
const manualIdx = parts.length - 2;
if (manualIdx <= 1) continue;
```

```ts
// Provider router — replace:
//   const finalIdx = parts.findIndex((p) => p === "04-final-photos" || p === "04-finals-photos");
//   if (finalIdx <= 1) continue;
// with:
const finalIdx = parts.length - 2;
if (finalIdx <= 1) continue;
```

This is safe because both routers' filter step already confirmed `parts[parts.length - 2]` is the
target leaf folder name before the entry reaches this code.

---

## Fix 6 — Migration 0015: delete and restore `edited_source_claims` in full, not partially

**Problem (Sol round 6, item 6):** `edited_source_claims.handoff_id` is nullable. The migration
deleted only `WHERE handoff_id IS NOT NULL` but the backup (`_bk_edited_source_claims`) captured
the FULL table via `SELECT *`. Restoring every backed-up row via plain `INSERT` then re-inserts
rows whose `handoff_id IS NULL` — which were never deleted — causing a primary-key conflict.

**Fix:** delete the full table, matching the full-table backup scope, so restore doesn't collide
with anything still live:

```sql
-- Was: DELETE FROM `edited_source_claims` WHERE `handoff_id` IS NOT NULL;
-- Now:
DELETE FROM `edited_source_claims`;--> statement-breakpoint
```

(Restore step is already `INSERT INTO edited_source_claims SELECT * FROM _bk_edited_source_claims`
and needs no change — it now has a clean table to insert into.)

---

## Fix 7 — Backfill: real service-method wiring, atomic re-checked eligibility, and collision handling

**7a. Add the actual `WorkerEntrypoint` method and RPC declaration**, not just the free function.
`workers/background/src/index.ts` needs a real method that the app route's `c.env.BACKGROUND.
backfillAutoHdrV2(...)` call resolves to:

```ts
// In the background worker's WorkerEntrypoint class (workers/background/src/index.ts):
async backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult> {
  return backfillAutoHdrV2Impl(this.env, params); // the free function from backfill.ts, renamed to avoid a name collision with this method
}
```

And in `workers/background/src/rpc-types.ts`, add the method signature to whatever interface
declares the background worker's public RPC surface (matching the existing declarations at
`rpc-types.ts:4` and following):

```ts
backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult>;
```

**7b. Fix the admin-route auth guard.** Round 6 used `requireCapability("adminBackend")`, which is
not the live pattern for `admin.ts` specifically (note: `projects.ts` DOES use a real
`requireCapability("adminBackend")` middleware for its own routes — the two route files use two
different real patterns; this route belongs in `admin.ts`, so it must match `admin.ts`'s own
pattern). Confirmed live in `workers/app/src/routes/admin.ts`:

```ts
function adminAllowed(c: Context<AppEnv>) {
  return ROLE_CAPABILITIES[c.get("user").role].includes("adminBackend");
}
```
used inline at every existing `admin.ts` route as `if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);`. Match it exactly:

```ts
adminRoutes.post("/admin/autohdr/backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const body = await c.req.json<{ dryRun?: boolean; limit?: number; cursor?: string }>().catch(() => ({}));
  const res = await c.env.BACKGROUND.backfillAutoHdrV2({
    dryRun: body.dryRun ?? false,
    limit: body.limit,
    cursor: body.cursor,
  });
  await audit(c.env, c.get("user").id, "admin.autohdr_backfill", "system", "backfill", { result: res });
  return c.json(res);
});
```

**7c. Re-check eligibility atomically inside `claimBackfillAutoHdrHandoff()`'s own INSERT**, not
just at the earlier SELECT in `backfillAutoHdrV2()`. The selection query and the actual write can
race (e.g. another process starts an explicit send between selection and write). Add the same
guards the inclusion query used, directly to the handoff INSERT's WHERE clause, and check the
batch result's row-count the same way the implicit path does:

```ts
// In claimBackfillAutoHdrHandoff(), the handoff INSERT becomes:
env.DB.prepare(`
  INSERT INTO autohdr_handoffs (
    id, project_id, connection_id, generation, manifest_version, selection_hash,
    selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path,
    initiated_by, expected_origin_stage, state, workflow_id, job_id,
    lease_expires_at, started_at, created_at, updated_at
  ) SELECT
    ?, ?, ?, ?, 1, 'backfill-v2',
    '[]', '[]', COALESCE(raw_folder_path, ''),
    NULL, stage_key, 'started', ?, ?,
    ?, ?, ?, ?
  FROM projects
  WHERE id = ? AND stage_key = 'editing_autohdr' AND archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM autohdr_handoffs WHERE project_id = ? AND state IN ('starting', 'started', 'blocked')
    )
`).bind(handoffId, projectId, connectionId, generation, workflowId, jobId, nowMs + 86400000, nowMs, nowMs, nowMs, projectId, projectId),
```

After `env.DB.batch(batchStatements)`, check the handoff-insert result's `changes` count (matching
the implicit path's existing verification pattern) and return `null` if it's zero, rather than
unconditionally returning success.

**7d. Handle a permanent path-claim collision during backfill**, rather than attempting a raw
unique-constrained INSERT and letting it fail. Before the path-claim INSERT/UPDATE branch, add
the same collision check as Fix 3b (query for any existing claim at this `connectionId`+
`pathKey`, regardless of state):

```ts
const collidingClaim = await db.select({ id: autoHdrPathClaims.id, projectId: autoHdrPathClaims.projectId })
  .from(autoHdrPathClaims)
  .where(and(eq(autoHdrPathClaims.connectionId, connectionId), eq(autoHdrPathClaims.pathKey, targetPathKey)))
  .get();
const isCollision = Boolean(collidingClaim && collidingClaim.projectId !== projectId);
```

If `isCollision`, follow the same pattern as the implicit path: write the mapping as
`state: 'blocked_collision'` and the handoff as `state: 'blocked'`, and skip the path-claim
insert/update entirely (do not attempt it against an already-claimed path owned by another
project).

**7e. Fix the production origin in the auth example.** Production is `https://quincy.flamingfire.my`
(per `CLAUDE.md`), not `portal.quincy.com`:

```bash
curl -X POST "https://quincy.flamingfire.my/api/admin/autohdr/backfill" \
  -H "Cookie: __Secure-better-auth.session_token=<ADMIN_SESSION_TOKEN>" \
  -H "Origin: https://quincy.flamingfire.my" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false, "limit": 50}'
```

---

## Fix 8 — RPC error types, real call-site wiring, job cleanup, and frontend state

**8a. Define the result types that Part 3 uses but never declares.** Add to
`workers/background/src/autohdr/errors.ts` (or wherever the plan's Part 3 intends them to live):

```ts
export type AutoHdrErrorCode =
  | "ERR_PROJECT_ARCHIVED"
  | "ERR_NO_RAW_SELECTION"
  | "ERR_MAPPING_BLOCKED"
  | "ERR_HANDOFF_BLOCKED"
  | "ERR_HANDOFF_DISAPPEARED"
  | "ERR_FOLDER_NOT_READY";

export type AutoHdrResult =
  | { ok: true; jobId: string; handoffId: string; workflowId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string };

export type AutoHdrFetchResult =
  | { ok: true; jobId: string; fetchClaimId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string };
```

Add both to `rpc-types.ts`'s return-type declarations for `startAutoHdr` and `fetchEditedFromAutoHdr`.

**8b. Wire the actual Hono route call sites to branch on `.ok`.** Round 6 only fixed the two
background-worker methods; the app-side callers were never updated. Confirmed live, there are
THREE call sites in `workers/app/src/routes/projects.ts`, not two — round 6 missed
`/fetch-edited` entirely (the very route whose missing error handling was the original regression
this whole plan traces back to). Real current code for all three:

```ts
// 1. POST /projects/:id/send-to-autohdr — real current body:
const { jobId } = await c.env.BACKGROUND.startAutoHdr(id, c.get("user").id);
await audit(c.env, c.get("user").id, "project.send_to_autohdr", "project", id, { jobId });
return c.json({ jobId });

// Fixed:
const result = await c.env.BACKGROUND.startAutoHdr(id, c.get("user").id);
if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
await audit(c.env, c.get("user").id, "project.send_to_autohdr", "project", id, { jobId: result.jobId });
return c.json({ jobId: result.jobId });
```

```ts
// 2. POST /projects/:id/fetch-edited — real current body:
const { jobId } = await c.env.BACKGROUND.fetchEditedFromAutoHdr(id);
await audit(c.env, c.get("user").id, "project.fetch_edited", "project", id, { jobId });
return c.json({ jobId });

// Fixed:
const result = await c.env.BACKGROUND.fetchEditedFromAutoHdr(id);
if (!result.ok) return c.json({ error: result.message, code: result.code }, 409);
await audit(c.env, c.get("user").id, "project.fetch_edited", "project", id, { jobId: result.jobId });
return c.json({ jobId: result.jobId });
```

```ts
// 3. POST /jobs/:id/retry — real current body (autohdr/fetch_edited branches only; the
// manual-publish branch is unaffected by this plan):
const { jobId } = job.kind === "autohdr"
  ? await c.env.BACKGROUND.startAutoHdr(job.projectId, c.get("user").id)
  : job.kind === "fetch_edited"
    ? await c.env.BACKGROUND.fetchEditedFromAutoHdr(job.projectId)
    : await c.env.BACKGROUND.publishManualUpload(job.projectId, manualAssetId!);
await audit(c.env, c.get("user").id, /* ...existing action-name ternary... */, "project", job.projectId, { previousJobId: id, jobId });
return c.json({ jobId });

// Fixed — the autohdr/fetch_edited branches now return a discriminated result, the
// manual-publish branch is untouched (still returns a bare jobId), so the retry route needs
// its own small branch to normalize both shapes before continuing:
const outcome = job.kind === "autohdr"
  ? await c.env.BACKGROUND.startAutoHdr(job.projectId, c.get("user").id)
  : job.kind === "fetch_edited"
    ? await c.env.BACKGROUND.fetchEditedFromAutoHdr(job.projectId)
    : { ok: true as const, jobId: await c.env.BACKGROUND.publishManualUpload(job.projectId, manualAssetId!).then((r) => r.jobId) };
if (!outcome.ok) return c.json({ error: outcome.message, code: outcome.code }, 409);
const jobId = outcome.jobId;
await audit(c.env, c.get("user").id, /* ...existing action-name ternary... */, "project", job.projectId, { previousJobId: id, jobId });
return c.json({ jobId });
```
(Implementer: confirm `publishManualUpload`'s real return shape — the normalization above assumes
it still returns a bare `{jobId}`, unchanged by this plan; adjust the `.then()` line if that
return shape differs from what's shown.)

**8c. Restore job-failure cleanup on workflow-create failure.** Round 6's `startAutoHdr()` catch
block returns an error result but no longer marks the claimed job as failed, regressing the live
cleanup behavior at `index.ts:150`. Add that cleanup back inside the catch, before returning:

```ts
} catch (error) {
  if (isWorkflowAlreadyExists(error)) {
    // ...existing round-6 handling...
  }
  // Restore live cleanup behavior (index.ts:150): mark the claimed job failed on workflow-create failure
  if (typeof jobId !== "undefined") {
    await db.update(jobs).set({ status: "failed", error: error instanceof Error ? error.message : String(error) }).where(eq(jobs.id, jobId));
  }
  const message = error instanceof Error ? error.message : String(error);
  const code: AutoHdrErrorCode = /* ...existing round-6 classification... */;
  return { ok: false, code, message };
}
```
(Implementer: confirm `jobId` is in scope at this point — it comes from `owner.jobId` after
`claimAutoHdrHandoff()` succeeds; if the failure can occur before that point, guard accordingly.)

**8d. Do not add a new status endpoint — `GET /projects/:id/autohdr-status` already exists.**
Confirmed live in `workers/app/src/routes/projects.ts`, at the EXACT path round 6 proposed to
add. Its real, current response shape:

```ts
// Already live — do not redefine this route:
projectsRoutes.get("/projects/:id/autohdr-status", requireCapability("adminBackend"), async (c) => {
  // ...loads the latest-generation handoff joined to its mapping...
  if (!handoff) return c.json({ handoff: null });
  return c.json({
    handoff: {
      id, generation, state,                 // handoff.state: starting | started | blocked | retired | failed
      readinessUnitsJson, selectionHash, manifestVersion,
      mappingState,                           // mapping.state: pending_discovery | active | blocked_collision | retired
      finalPath, diagnostic,
      readinessUnits,                         // parsed from readinessUnitsJson
      associations,                           // final-association rows for this handoff
    },
  });
});
```

Round 6's plan to add a differently-shaped route at this same path was a genuine conflict, exactly
as Sol flagged. Delete Part 7.1 from round 6 entirely — no route change is needed here. Instead,
the frontend hook (8e) must poll this REAL existing endpoint and derive UI state from its REAL
shape:
- `handoff === null` → no active AutoHDR handoff ("none" state).
- `handoff.state === 'blocked'` or `handoff.mappingState === 'blocked_collision'` → blocked,
  needs staff resolution.
- `handoff.state === 'started' && handoff.mappingState === 'active'` → ready; edited content has
  landed, safe to refresh the Edited collection.
- Any other combination (e.g. `started` + `pending_discovery`) → in progress, keep polling.

**8e. Make the frontend hook actually store and render state**, not just poll and refresh assets.
Round 6's polling effect fetched status but only called `refreshAssets("edited")` on `"active"` —
it never stored the state or used it to drive the blocked-state display / button relabeling that
earlier rounds specified (the "Discover & fetch" / disabled-on-collision button table). Fix:

```tsx
interface AutoHdrStatusResponse {
  handoff: {
    id: string;
    generation: number;
    state: "starting" | "started" | "blocked" | "retired" | "failed";
    mappingState: "pending_discovery" | "active" | "blocked_collision" | "retired";
    finalPath: string | null;
    diagnostic: string | null;
  } | null;
}

const [autohdrStatus, setAutohdrStatus] = useState<AutoHdrStatusResponse["handoff"]>(null);

useEffect(() => {
  if (!canAdminBackend || !projectId || data?.stageKey !== "editing_autohdr") return;
  let isMounted = true;
  let lastMappingState: string | null = null;
  const pollAutoHdrStatus = async () => {
    try {
      const { handoff } = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
      if (!isMounted) return;
      setAutohdrStatus(handoff);
      // Refresh Edited assets only on the transition INTO active, not on every poll tick
      if (handoff?.state === "started" && handoff.mappingState === "active" && lastMappingState !== "active") {
        void refreshAssets("edited");
      }
      lastMappingState = handoff?.mappingState ?? null;
    } catch {
      // Ignore polling errors
    }
  };
  void pollAutoHdrStatus();
  const interval = window.setInterval(pollAutoHdrStatus, 5_000);
  return () => { isMounted = false; window.clearInterval(interval); };
}, [canAdminBackend, data?.stageKey, projectId, refreshAssets]);
```

And pass `autohdrStatus` through to whatever renders the fetch-edited button, so it can show the
blocked/disabled state and relabel per the button-state table specified in earlier rounds
(Round 4/5's Part 5.2) — implementer must confirm the exact prop-threading against the live
component tree, which the orchestrating session did not verify line-by-line.

---

## What remains for the implementer to verify directly (not independently re-confirmed by this round)

This round was produced by direct textual correction against Sol's round-6 findings. Four of the
originally-flagged verification gaps were resolved by reading the live code directly during this
pass: `admin.ts`'s real `adminAllowed` guard (Fix 7b), the real bodies of all three RPC call sites
including the previously-missed `/fetch-edited` route (Fix 8b), and the real, already-live
`GET /projects/:id/autohdr-status` endpoint and response shape (Fix 8d/8e) — round 6's plan to add
a second, conflicting route at that path is deleted, not merely reconciled.

## Round 8 — corrections from independent Opus review (final round)

An independent Opus pass reviewed this round-7 document against live code and returned **APPROVE
WITH CORRECTIONS**. Full review: `wp-autohdr-opus-review.md` in this scratchpad. It confirmed the
architecture is sound (independently re-derived, not inherited from Sol) and that Fix 1's
`changes()` assumption and Fix 8b/8d's live-code transcriptions are exactly correct. It found 4
must-fix blockers (P1–P4) and 4 lower-severity items (P5–P8), listed here with fixes applied.

### P1 (highest severity, new finding) — dedupe router entries by folder before claiming

**Problem:** both routers loop per matched *file*, and each iteration costs ≥4 D1 round-trips
(`claimImplicitAutoHdrHandoff()` alone runs an `activeWinner` SELECT, a collision SELECT, and a
batch). A 40-photo drop into one folder in a single delta page is ~160 D1 calls in one
`alarm()` invocation — this account is on the Workers **Free** plan, capped at 50 subrequests per
invocation (`docs/lessons.md`; this exact Durable Object has already hit this twice this session,
per the two most recent commits on `main`). The alarm throws, the sync cursor is only committed
*after* the routing loop, so the page retries forever — **the AutoHDR monitor wedges permanently
on the first real manual drop.**

**Fix:** in both `routeAutoHdrManualDropDelta()` and `routeAutoHdrProviderDelta()`, group the
filtered entries by `scaffoldPathKey` before the loop, and call `claimImplicitAutoHdrHandoff()`
at most once per distinct folder (using any one representative entry from that folder for the
`representativeChangedPath`), not once per file:

```ts
// After filtering to validManualEntries (or validProviderEntries), group by folder:
const byFolder = new Map<string, typeof validManualEntries[number]>();
for (const entry of validManualEntries) {
  const parts = entry.path_lower.split("/");
  const idx = parts.length - 2; // per Fix 5
  if (idx <= 1) continue;
  const scaffoldPathKey = parts.slice(0, idx).join("/");
  if (!byFolder.has(scaffoldPathKey)) byFolder.set(scaffoldPathKey, entry); // first entry wins as representative
}

for (const [scaffoldPathKey, entry] of byFolder) {
  // ...existing per-entry body, now running once per distinct folder instead of once per file...
}
```

Also add a hard cap on the number of distinct folders processed in one alarm pass (e.g. 10), to
bound worst-case subrequest cost even if many different never-sent projects receive drops in the
same delta page; any folders beyond the cap are naturally picked up on the next alarm tick since
nothing about this design assumes single-pass completion.

### P2 — guard Fix 3b's reactivation UPDATE, and match the live reassignment's clearing behavior

**Problem:** the same-project reactivation UPDATE specified in Fix 3b has no existence guard,
unlike every other statement in the same batch. If the handoff/mapping INSERTs earlier in the
batch no-op (ineligible project, concurrent creation), this UPDATE still fires, rebinding a live
path claim to a `handoff_id`/`mapping_id` that were never actually inserted — an FK violation that
throws the whole batch instead of returning `null` gracefully, which (per P1's same failure
pattern) wedges the alarm on retry.

**Fix:**

```sql
-- Was:
-- UPDATE autohdr_path_claims SET state='active', handoff_id=?, mapping_id=?, updated_at=? WHERE id=?

-- Now:
UPDATE autohdr_path_claims
SET state = 'active', handoff_id = ?, mapping_id = ?, diagnostic = NULL, updated_at = ?
WHERE id = ?
  AND state IN ('tombstone', 'blocked')
  AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
```

This matches the live reassignment precedent at `index.ts:451` exactly: it clears `diagnostic`
(a reactivated claim must not carry a stale collision message into a healthy generation) and
restricts to the same source states that live code restricts to.

Note (from review, not a defect to fix): this reactivation branch is unreachable from the
*implicit* entry point after Fix 2 — a same-project claim's existence implies a handoff row
exists (immediate FK), which means the routers would have already excluded that project. It is
reachable, and needed, in **backfill** (see P3), which deliberately targets projects that DO have
a prior handoff. Keep the branch in the shared helper for that reason; just document in the plan
that it's dead code on the implicit path specifically.

### P3 — apply the same guard pattern to ALL FOUR of backfill's batch statements

**Problem:** Fix 7c added the eligibility guard and a `changes()` check only to the backfill
handoff INSERT. The other three statements in `claimBackfillAutoHdrHandoff()` — the jobs INSERT,
the mapping INSERT, and the path-claim INSERT/UPDATE — are still plain, unguarded `VALUES`
inserts. This reintroduces exactly the orphaned-job defect Fix 2 fixed for the implicit path: if
the handoff INSERT no-ops, the job row still commits (orphan), and the mapping INSERT — which
references the handoff — throws an FK violation before `changes()` is even checked, making Fix
7c's own verification logic unreachable in the scenario it exists to handle.

**Fix:** every statement in `claimBackfillAutoHdrHandoff()`'s batch must carry the same
guard-against-the-immediately-prior-insert pattern already used in
`claimImplicitAutoHdrHandoff()` (Fix 7c's own handoff INSERT, and the implicit path's Steps 1–4):
job INSERT guarded on project eligibility (same predicate as the handoff INSERT), mapping INSERT
guarded on `WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)`, and the path-claim
INSERT/UPDATE guarded on `WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)` (the
UPDATE branch additionally gets P2's guard). Mirror the implicit path's structure exactly rather
than writing a parallel, independently-guarded version — the whole point of sharing this shape is
that both paths get the same safety property.

Also (minor, from the review): add `isNull(projects.archivedAt)` to backfill's inclusion query —
currently only the eligibility re-check inside the INSERT has this condition, so an archived
project sitting in `editing_autohdr` gets selected, passes the earlier pre-check, then silently
no-ops at the INSERT and is reported with the same generic "ineligible" reason as a real
collision. Give that specific no-op case ("project was archived between selection and write") its
own distinct skip reason in the result `items` array.

### P4 — Fix 3d's stated recovery path does not exist; decide a real resolution

**Problem:** Fix 3d claimed a collided implicit mapping "is handled ONLY via the standard
blocked-mapping/blocked-handoff path (staff resolves manually through existing admin tooling)."
This is false for both channels. Because collision skips the path-claim INSERT entirely, a
collided mapping has ZERO `autoHdrPathClaims` rows — and both existing recovery RPCs require at
least one: `resolveAutoHdrMapping()` throws when it finds none, and `reassignAutoHdrPathClaim()`
requires the target path to be one of the two hardcoded provider candidates, rejecting a manual
leaf outright and assuming exactly two candidates exist. **An implicit collision as specified is
a genuine dead end, recoverable only by direct database surgery** — compounded by the fact that
the collided project now also has a handoff row (excluding it from ever being re-detected
implicitly) and its handoff is `blocked` (which backfill's own pre-check treats as "has an active
handoff" and skips).

**Fix — adopt option (c) from the review, the smallest correct change:** accept that automatic
collision recovery is out of scope for this plan (extending `reassignAutoHdrPathClaim()` to
handle a three-candidate/manual-inclusive case is a larger change than this plan should carry),
but make the dead-end explicit and operator-visible rather than silent:
- Update Fix 3d's language to state plainly that an implicit collision requires manual staff
  intervention via direct database correction (not "existing admin tooling," which cannot handle
  it) — and add this as an explicit, named limitation in the plan's scope section, not just a
  code comment.
- **Decide the stage-advance question (review finding N6) as part of this fix**: the Step 5 stage
  UPDATE is currently guarded only on the handoff existing, not on `!isCollision`, so a collision
  still advances the project from `raw_review` to `editing_autohdr` — which then also blocks a
  manual explicit re-send, since `claimAutoHdrHandoff()` requires the project to be in
  `raw_review`. Fix: guard the Step 5 stage UPDATE with `AND NOT ${isCollision}` equivalent (skip
  the stage advance entirely on the collision path) so a collided project stays in `raw_review`
  and a human can still trigger an explicit send as the practical recovery mechanism, rather than
  being stuck in `editing_autohdr` with no handoff able to progress it further. This makes "ask a
  human to explicitly send it" the real recovery path, which does work once the project isn't
  wrongly stranded in `editing_autohdr`.

### P5 — batch statement ordering constraint between Fix 1 and Fix 3b/P2

The reactivation UPDATE (Fix 3b, now P2) must occupy the Step 4 slot in
`claimImplicitAutoHdrHandoff()`'s batch (replacing the conditional path-claim INSERT when the
same-project-reactivation branch applies), strictly BEFORE the Step 5 stage UPDATE — never after
it. This preserves the `changes()` adjacency Fix 1 depends on (the audit INSERT at Step 6 must
immediately follow the Step 5 stage UPDATE with nothing in between). Also: capture the handoff
INSERT's batch-array index (used for the `results[1]?.meta.changes` success check) as a named
constant rather than a literal `1`, since the array composition is now conditional across three
different fixes (P2's reactivation branch, the base collision branch, and the normal path) and a
literal index is fragile against future edits.

### P6 — add a terminal-state case to the frontend status derivation (Fix 8d/8e)

The live `/projects/:id/autohdr-status` endpoint has no state filter and returns the
latest-generation handoff regardless of its state — so once a handoff is `retired` or `failed`,
the endpoint keeps returning that non-null handoff. Fix 8d's four-rule derivation table has no
case for this and falls through to "in progress, keep polling," which polls forever. Add an
explicit fifth rule: `handoff.state === 'retired' || handoff.state === 'failed'` → treat as
terminal/none, stop polling.

### P7 — close the Fix 2 coverage hole in backfill's inclusion query

A project whose explicit send failed before `confirmAutoHdrHandoff()` ran is still in
`raw_review` (that function is what performs the stage move) but now has a `failed`/`blocked`
handoff row. After Fix 2, such a project is excluded from the implicit path (it has a handoff row)
AND from backfill (whose inclusion query requires `stage_key = 'editing_autohdr'`) — dropping
files into its folder silently does nothing. Fix: widen backfill's inclusion query to also match
projects in `raw_review` that have ONLY terminal (`retired`/`failed`) handoff rows and no
active one, so these genuinely-stranded-before-ever-advancing projects are backfillable too.

### P8 — smaller mechanical corrections, bundle into implementation

- Fix 3a: state explicitly that `mapping.ts`'s `ClaimRoute.candidate` type (the sole narrowing in
  `src/`) is the one place that needs widening to `"final" | "finals" | "manual"` — no other
  source location needs touching; a test-helper parameter with the narrower type still compiles
  fine against a widened field.
- Fix N2 (new, from review): the manual/provider routers' `matched` counters count files, while
  the existing explicit router's `matched` counts distinct mapping folders — these get summed
  into one `matchedCount` for monitor-health telemetry, corrupting that signal (can go negative).
  After P1's per-folder dedup, make both new routers count distinct folders too, for unit
  consistency with the explicit router.
- Drop the unnecessary `assets.autohdr_handoff_id` backup/null/restore trio from migration 0015 —
  that column has no FK reference, so nothing needs it evacuated before the parent table drop.
  Remove all three statements together (the backup, the nulling, and the restore), not partially.
- In `startAutoHdr()`, hoist `let owner: HandoffOwner | undefined;` above the `try` block (the
  live code has the equivalent claim call OUTSIDE the try, at `index.ts:124`, which is exactly why
  the live catch-block job-failure cleanup at `index.ts:150` can reference `owner.jobId` — round
  6/7's rewrite moved the claim call inside the try, which breaks this). Guard the restored
  cleanup in Fix 8c's catch block on `if (owner) { ... }`.
- In the three RPC call-site fixes (Fix 8b), return `400` (not `409`) specifically for
  `ERR_NO_RAW_SELECTION`, matching the live route's existing distinction between "no selection"
  (400) and other preconditions (409) — don't collapse all error codes to one status.
- In the frontend hook (Fix 8e), replace the plain closure variable `lastMappingState` with a
  `useRef`, since a closure variable resets on every effect re-run if `refreshAssets`'s identity
  isn't stable across renders. Also stop polling (or back off significantly) once the state is
  terminal/blocked per P6, rather than polling every 5 seconds indefinitely for as long as a
  project sits in `editing_autohdr` — this account is on the Workers Free plan and per-open-
  workspace polling cost adds up across concurrent users.
- Document two UI/data consequences that aren't bugs but need conscious handling: implicit
  handoffs have an empty readiness manifest (`selected_asset_ids_json`/`readiness_units_json`
  both `'[]'`, since there's no frozen selection to snapshot) — the coverage UI must not render
  this as "0 of 0 covered," it needs a distinct "auto-detected, no frozen manifest" state. And
  implicit handoffs get a placeholder `workflow_id` for a Workflow that's never actually created —
  harmless on its own, but the existing "handoff already exists" recovery lookup in `startAutoHdr()`
  should filter by state so it can't mistakenly hand back a live-looking `workflowId` for an
  implicit row.
- For consistency with the explicit path (which hardcodes `expected_origin_stage: 'raw_review'`),
  hardcode the same constant in the implicit path too, rather than recording whatever the
  project's current stage happens to be at creation time — nothing reads this field today, but it's
  an audit-semantics field and the divergence should be a deliberate choice, not incidental.

---

## Round 9 — corrections from Terra's plan-approval review (pre-build gate)

Per `docs/Subagent-Orchestration.md` §2 policy 1, Terra (codex exec, read-only, high effort,
fresh context) reviewed round 7/8 as the mandatory gate before any build starts. **Verdict: NOT
APPROVED**, 8 findings (T1–T8). Terra also confirmed several things as solid and unchanged:
the migration SQL (validated in-memory against 0000–0014 with populated parent/child rows,
`PRAGMA foreign_key_check` clean), all three Fix 8b call-site transcriptions, `adminAllowed`,
the `/autohdr-status` endpoint shape, and `changes()` semantics. Both of round 7/8's remaining
"needs implementer confirmation" items are now resolved as facts (folded into T7/T8 below), not
open questions.

The orchestrating session (Sonnet 5, this pass) independently re-verified T1 directly against
`docs/plans/AutoHDR-Implicit-Scaffolding-Plan-Base-R6.md` before accepting it — confirmed real,
not a misread: the base plan defines the `autohdr_scaffold_claims` table and two routers that
*query* it (`routeAutoHdrManualDropDelta`/`routeAutoHdrProviderDelta`, R6 §5.1, lines 667–799),
but no code anywhere — in either plan document or the live repo — ever inserts a row into it or
creates the Dropbox folder it should point at. This round designs that missing piece and fixes
the other 7 findings.

### T1 (highest severity) — the scaffold-creation writer was never specified

**Problem:** the plan's own namesake feature — "scaffold AutoHDR intake folders at project-create
time" — has no writer. `autohdr_scaffold_claims` is read-only in every prior round.

**Design decision (confirmed with the user):** trigger scaffold creation at both of Portal's own
project-create route and Tonomo's RAW-path backfill — concretely, at every real code path where a
project's `raw_folder_path` can transition from `NULL` to non-`NULL`, since that's the earliest
point `deriveAutoHdrFolderName()` becomes computable. Three real call sites do this today:

1. `workers/app/src/routes/projects.ts:134-142` (`POST /projects`) — an operator supplies
   `rawFolderPath` directly at creation.
2. `workers/background/src/tonomo/process.ts:90-103` (`createProject`) — a Tonomo order arrives
   with `rawFolderPath` already populated, no prior Portal project existed.
3. `workers/background/src/tonomo/process.ts:105-124`, specifically line 121
   (`if (!project.rawFolderPath && order.rawFolderPath) changes.rawFolderPath = order.rawFolderPath;`)
   inside `updateProject` — an existing project's RAW path is backfilled later. `rawFolderPath` is
   write-once in the existing code (both Tonomo functions and the schema only ever fill a null —
   nothing overwrites a populated one), so no scaffold-retirement/supersede path is needed here.

**New background RPC method**, mirroring `triggerDropboxSync`'s fire-and-forget queue shape
(`workers/background/src/index.ts:47-62`):

```ts
// workers/background/src/index.ts — new method on QuincyBackground
async ensureAutoHdrScaffold(projectId: string, rawFolderPath: string): Promise<{ jobId: string }> {
  const db = dbFor(this.env);
  const jobId = await createJob(db, { kind: "autohdr_scaffold", projectId, correlationId: `autohdr_scaffold:${projectId}` });
  try {
    await this.env.INGEST_QUEUE.send({ type: "autohdr_scaffold", projectId, jobId, rawFolderPath });
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
```

Add `"autohdr_scaffold"` to the `jobs.kind` enum in `packages/db/src/schema.ts` (mirror how
`"dropbox_sync"` etc. are already listed there — implementer: locate the exact enum array) and to
the `IngestMessage` union in `workers/background/src/messages.ts` (mirror `DropboxSyncMessage`'s
shape: `{ type: "autohdr_scaffold"; projectId: string; jobId: string; rawFolderPath: string }`).
Add a `case "autohdr_scaffold":` branch to the `queue()` switch (`index.ts`, alongside the
existing `case "dropbox_sync":` at line 542) that calls the new handler below and acks.

**New file `workers/background/src/autohdr/scaffold.ts`:**

```ts
import { and, eq } from "drizzle-orm";
import { autohdrScaffoldClaims } from "@quincy/db/schema";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { dropboxPathKey, AUTOHDR_ROOT } from "../dropbox/paths";
import { deriveAutoHdrFolderName, autoHdrManualDropPath } from "./paths"; // autoHdrManualDropPath is new — see below

export async function ensureScaffold(env: Env, projectId: string, rawFolderPath: string): Promise<void> {
  const db = dbFor(env);
  const connectionId = await canonicalDropboxConnectionId(db);
  const folderName = deriveAutoHdrFolderName(rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);
  const now = new Date();

  // Same three-way collision branch as Fix 3b: no row / different project (permanent, case-
  // insensitive Dropbox folder-name collision — the exact hazard docs/todo.md already documents
  // for path claims) / same project (retired -> reactivate).
  const colliding = await db.select({ id: autohdrScaffoldClaims.id, projectId: autohdrScaffoldClaims.projectId, state: autohdrScaffoldClaims.state })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.connectionId, connectionId), eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey)))
    .get();

  if (colliding && colliding.projectId !== projectId) {
    console.error("AutoHDR scaffold path collision", { projectId, scaffoldPathKey, ownedBy: colliding.projectId });
    return; // no claim, no folders — same operator-visible dead end as an unresolved path-claim collision
  }
  if (colliding && colliding.state !== "active") {
    await db.update(autohdrScaffoldClaims).set({ state: "active", updatedAt: now }).where(eq(autohdrScaffoldClaims.id, colliding.id));
  } else if (!colliding) {
    try {
      await db.insert(autohdrScaffoldClaims).values({ id: crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, state: "active", createdAt: now, updatedAt: now });
    } catch {
      return; // lost a create-time race; the winning row already covers this project, or a real collision — the next call detects it via the branch above
    }
  }
  // Idempotent regardless of whether the claim row was just created, reactivated, or already
  // active — createFolder absorbs path/conflict, so a prior call that wrote the claim row and
  // then failed/retried before folder creation ran is safely repaired here, not skipped.
  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
}
```

(`createFolder` import from `../dropbox/client` — same primitive the AutoHDR send Workflow and
manual-edited-publish Workflow already use, `workers/background/src/dropbox/client.ts:565-588`.)

**New constants/helper in `workers/background/src/autohdr/paths.ts`**, mirroring the existing
`autoHdrRawInputPath` pattern exactly (confirmed no `04-MANUAL-Photos` constant exists anywhere
in the repo today):

```ts
export const AUTOHDR_MANUAL_DROP_SUBFOLDER = "04-MANUAL-Photos";
export function autoHdrManualDropPath(folderName: string): string {
  return `${AUTOHDR_ROOT}/${folderName}/${AUTOHDR_MANUAL_DROP_SUBFOLDER}`;
}
```

**Wiring the three call sites** (best-effort, non-blocking — a Dropbox hiccup must never fail a
project create or poison Tonomo event processing; this mirrors how rendition-generation failures
never block asset ingest elsewhere in this codebase):

```ts
// projects.ts:134-142, after the schema.projects insert:
if (fields.rawFolderPath) void c.env.BACKGROUND.ensureAutoHdrScaffold(id, fields.rawFolderPath)
  .catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
```

```ts
// tonomo/process.ts — createProject, after the insert (rawFolderPath known at line 99):
if (order.rawFolderPath) void env.BACKGROUND.ensureAutoHdrScaffold(id, order.rawFolderPath)
  .catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
```

```ts
// tonomo/process.ts — updateProject, after the db.update at line 122:
if (changes.rawFolderPath) void env.BACKGROUND.ensureAutoHdrScaffold(project.id, changes.rawFolderPath)
  .catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: project.id, error }));
```

Implementer: confirm `env.BACKGROUND` is actually reachable from `tonomo/process.ts`'s existing
call signature (it runs inside the background Worker already, so this should be a plain
service-binding call or a direct function call to the same `ensureScaffold` used by the RPC
method — whichever avoids an unnecessary self-referential RPC hop; check how this file already
reaches other background-worker capabilities, if any, and match that convention) and thread
`fields.rawFolderPath`/`order.rawFolderPath`/`changes.rawFolderPath` through correctly against
each function's real local variable names.

Add to Migration 0015 (per R6 §4.2's existing table-creation shape, already correct in R6 lines
543-558 — no change needed there beyond what Fix 4 already added) and confirm
`autohdrScaffoldClaims` is exported the T8 way (`export * as schema`), not R6 §2.3's named block.

### T2 — the promised legacy-removal inventory was never written, and every round's own rewrites still retained the fallback

**Problem:** confirmed directly against live code and against R6's own Part 3.1/3.2 (the very
snippets meant to fix `startAutoHdr()`/`fetchEditedFromAutoHdr()`): every round's rewritten
version of these two methods *still* opens with
`if (!automationFlag(this.env.DROPBOX_HANDOFF_V2_ENABLED)) return this.startAutoHdrLegacy(...)`
(R6 line 365) and the fetch equivalent (R6 line 428) — restating "remove legacy paths" as a goal
in prose while never actually deleting the branch in the code samples that were supposed to
implement it.

**Fix — the final `startAutoHdr()`/`fetchEditedFromAutoHdr()` bodies (per Fix 8a/8c's
`AutoHdrResult`-returning shape) must NOT contain a `DROPBOX_HANDOFF_V2_ENABLED` branch at all.**
Concretely, remove:
- `startAutoHdrLegacy()` in full — `workers/background/src/index.ts:64-94`.
- `fetchEditedFromAutoHdrLegacy()` in full — `workers/background/src/index.ts:96-119`.
- The fallback line inside `startAutoHdr()` — `index.ts:122`.
- The fallback line inside `fetchEditedFromAutoHdr()` — `index.ts:158`.
- `DROPBOX_HANDOFF_V2_ENABLED` from the `Env` interface — `workers/background/src/env.ts:21`.
- Its value wherever it's set (`wrangler.jsonc` vars, `.dev.vars`, any prod secrets file) —
  implementer must grep for the literal string across `workers/background/` and `workers/app/`
  and remove every occurrence, not just `env.ts`'s declaration.
- The now-unused `automationFlag` import in `index.ts`, if nothing else in that file still calls
  it (check before removing — `do/dropbox-sync.ts` has its own separate import and is unaffected).
- Any tests referencing `startAutoHdrLegacy`, `fetchEditedFromAutoHdrLegacy`, or
  `DROPBOX_HANDOFF_V2_ENABLED`.

### T3 — the per-folder-dedup cap can silently drop entries; the Free-plan framing is stale

**Problem:** confirmed — the manual/provider routers in R6 §5.1 (lines 677-799) do not yet exist
anywhere in the repo (this is entirely new code this plan is adding), so P1's per-folder dedup and
10-folder cap need to be designed correctly from scratch, not patched into existing code. The DO
alarm (`do/dropbox-sync.ts`, full method read directly) commits its delta cursor
(`this.ctx.storage.put(CURSOR_KEY, page.cursor)`) once, after the whole routing loop, with nothing
resembling a partial-page continuation — so any design that silently skips folders past a cap
within a single page loses those entries permanently once the cursor advances past them.
Separately: Workers **Paid** is confirmed live (`docs/todo.md:142`, `docs/lessons.md:346`), so the
original 50-subrequest Free-plan framing that motivated a hard cap no longer applies at the
severity P1 described it.

**Fix:** keep per-folder dedup in `routeAutoHdrManualDropDelta()`/`routeAutoHdrProviderDelta()`
(genuinely useful — it turns "N D1 round-trips per file" into "N D1 round-trips per distinct
folder," independent of plan tier) but **drop the hard 10-folder cap entirely** — it has no safe
implementation without also building durable overflow persistence (which nothing in this plan
needs today, on Paid). If a single alarm page's folder count ever becomes a real operational
problem, address it later with an explicit continuation mechanism, not a page-truncating skip.

### T4 — the collision "recovery via explicit resend" doesn't actually work

**Problem:** confirmed directly against live code. P4's fix only guards the Step 5 stage UPDATE
(`AND NOT isCollision`) so a collided project stays in `raw_review` — but `claimAutoHdrHandoff()`
(`autohdr/claims.ts:71-75`) looks up an existing handoff by
`inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"])` and reuses/returns it as the
active owner; `startAutoHdr()` (`index.ts:136`) then explicitly refuses a `blocked` handoff. A
`blocked` implicit-collision handoff can never be resent through the ordinary explicit-send path
regardless of the project's stage — P4's fix address the wrong half of the problem.

**Fix:** on an implicit collision, write the **handoff** as `state: 'retired'` (not `'blocked'`),
with `last_error` describing the collision — the mapping stays `blocked_collision` as already
designed (that's what keeps it operator-visible via `inspectDropboxMonitor`/the admin panel).
`retired` is already a valid `autohdr_handoffs.state` enum value, and both
`claimAutoHdrHandoff()`'s active-lookup (`claims.ts:73`) and the
`autohdr_handoffs_active_project_unique` partial index (`WHERE state in ('starting','started',
'blocked')`) already exclude `retired` rows — so this requires no other code change: a human
clicking "Send to AutoHDR" on the project afterward hits the completely ordinary, already-working
`claimAutoHdrHandoff()` path and gets a genuinely fresh handoff generation. No new RPC, no new
recovery state, no DB surgery. Combined with the terminal-state frontend rule already fixed in P6
(`retired`/`failed` → treat as none/terminal, stop polling), the UI correctly stops showing the
dead collision the moment this lands, with zero additional frontend work beyond what P6 already
specifies. Keep P4's existing correction to Fix 3d's prose (state plainly that recovery from an
implicit *mapping-level* collision — as opposed to the handoff, which this fix now un-sticks — is
still investigate-via-`inspectDropboxMonitor`-and-Dropbox-directly, not a self-service admin flow).

### T5 — P7 widens backfill's *selection* query but not its atomic *writer*

**Problem:** confirmed — the writer (`claimBackfillAutoHdrHandoff`, R6 lines 844-941) only ever
inserts a handoff/mapping/claim; it never advances a project's stage. P7 widens backfill's
*inclusion* query to also select `raw_review` projects with only terminal handoffs, but such a
project would then have its handoff/mapping/claim created while remaining stuck in `raw_review` —
and the live router (`mapping.ts:101`, `eq(projects.stageKey, "editing_autohdr")`) requires
`editing_autohdr` before it will ever route anything for that project, so it silently never
progresses.

**Fix:** when backfill's writer creates a handoff for a project currently in `raw_review`, it must
also perform the SAME guarded stage advance `confirmAutoHdrHandoff()` already does
(`autohdr/claims.ts:51-59`) — `UPDATE projects SET stage_key = 'editing_autohdr' ... WHERE
stage_key = 'raw_review' AND archived_at IS NULL`, immediately followed by its own
`changes()`-gated audit INSERT (no statement between them, per Fix 1's adjacency rule) — as two
more statements in the SAME atomic batch as the handoff/mapping/claim inserts (extending P3's
"guard all four statements" to six, when backfilling a `raw_review` project specifically; the
stage UPDATE/audit pair is skipped entirely — not merely no-opped — when the project is already
`editing_autohdr`, since it would have nothing to guard against there).

### T6 — backfill marks a folder "active" without ever observing it or starting a fetch

**Problem:** confirmed directly against R6 §6.2 (`backfillAutoHdrV2()`, lines 970-1030): it
hardcodes `candidatePath = /AutoHDR/${folderName}/04-FINAL-Photos` — only one of the two known
real spellings (`docs/lessons.md`'s "AutoHDR's own Dropbox docs contradict themselves on the
output folder name" entry — this exact bug class already bit this codebase once) — and never
calls anything to check Dropbox before `claimBackfillAutoHdrHandoff()` inserts the mapping
directly as `state: 'active'`, `observed_at: nowMs`. Nothing ever calls `claimAutoHdrFetch()` /
`startClaimedFetch()`; the one `jobs` row backfill creates is hardcoded `status: 'done'` (R6 line
884) for a job that never ran. Fix 8d's frontend rule then reads `started + active` as "content
has landed," which is simply false for every backfilled row until someone happens to click the
manual fetch button anyway — defeating backfill's purpose.

**Fix**, per project being backfilled:
1. Compute both real candidates via the existing `autoHdrFinalPathCandidates(folderName)` helper
   (`autohdr/paths.ts`) — not a single hardcoded path.
2. Check each candidate against Dropbox with the existing `listFolderIfExists()` helper (already
   used identically in `fetchEditedFromAutoHdr()`'s `pending_discovery` branch, `index.ts:191`).
3. **Neither exists yet:** skip with reason `"No AutoHDR final folder observed yet — re-run
   backfill once AutoHDR delivers"`; create no handoff. (Backfill is operator-triggered and
   idempotent/re-runnable — re-running it later after AutoHDR finishes is the intended recovery
   path. A scheduled sweep to make this automatic is explicitly out of scope for this plan; it's
   already tracked separately in `docs/todo.md`'s "Optional backstop... hourly cron sweep" bullet
   under Open, not yet fixed — do not build it as part of this round.)
4. **Both exist:** treat as the same ambiguity `routeAutoHdrDelta`'s `blockMapping` already handles
   when both provider candidates are observed concurrently — block for staff, don't guess which one
   is authoritative.
5. **Exactly one exists:** proceed with `claimBackfillAutoHdrHandoff()` using the real observed
   path and its real `folder_id` from the listing response (matching what the ordinary router
   stores, `mapping.ts:127`) — then, once the atomic batch (T5's version, with the six-statement
   raw_review case where applicable) succeeds, build a `RoutedAutoHdrMapping` from the result and
   call `claimAutoHdrFetch()` + `startClaimedFetch()` exactly as `fetchEditedFromAutoHdr()`'s
   manual path and the DO alarm's router loop both already do (`index.ts:207-208`) — so a real
   fetch actually launches instead of the mapping sitting `active` with nothing having happened.
   The synthetic `jobs` row backfill inserts for the handoff-generation FK requirement stays
   `status: 'done'` as R6 designed it (that row exists only to satisfy `autohdr_handoffs.job_id
   NOT NULL`, since there's no send-side Workflow to run for a backfilled generation) — the REAL,
   externally-visible job is the one `claimAutoHdrFetch()` creates (`kind: 'fetch_edited'`), same
   as every other fetch path in this codebase.

### T7 — the UI button-state table doesn't exist anywhere; resolved against the real component

**Problem:** confirmed — `ProjectWorkspace.tsx` is 227 lines total (not the 150-320 range assumed
in round 7/8); no button-state table exists in any prior round or R6. This is now resolved as a
fact, not an open question: the fetch-edited button is rendered **inline** in this same component
(`apps/web/src/screens/ProjectWorkspace.tsx:215`) — no prop-threading to a child component is
needed. The relevant existing pieces: `canAdminBackend` (line 30), the `fetchEdited()` handler and
`isFetching` state (lines 168-174), the existing 5-second polling `useEffect` gated on
`canAdminBackend && jobs.some(activeJob)` (lines 121-126, the pattern to extend rather than
duplicate), and the current button JSX:

```tsx
{canAdminBackend && activeTab === "edited" && canSelect && <div className="hdr"><div className="grow"><strong>Fetch from autoHDR</strong><div className="muted">Pull finished edits from autoHDR's 04-FINAL-Photos into this collection.</div></div><button className="button" type="button" disabled={isFetching} onClick={() => void fetchEdited()}>{isFetching ? "Fetching…" : "Fetch edited from autoHDR"}</button></div>}
```

**Fix — concrete replacement**, wiring Fix 8e's `autohdrStatus` state (with P6's terminal-state
rule and P8's `useRef` correction already folded in) directly into this same block:

```ts
const autohdrBlocked = autohdrStatus?.state === "blocked" || autohdrStatus?.mappingState === "blocked_collision";
const autohdrLabel = isFetching ? "Fetching…"
  : autohdrBlocked ? "Blocked — staff resolution needed"
  : autohdrStatus?.state === "started" && autohdrStatus?.mappingState !== "active" ? "Discover & fetch"
  : "Fetch edited from autoHDR";
const autohdrMessage = autohdrBlocked
  ? (autohdrStatus?.diagnostic ?? "AutoHDR output needs staff resolution before it can be fetched.")
  : "Pull finished edits from autoHDR's 04-FINAL-Photos into this collection.";
```

```tsx
{canAdminBackend && activeTab === "edited" && canSelect && <div className="hdr"><div className="grow"><strong>Fetch from autoHDR</strong><div className="muted">{autohdrMessage}</div></div><button className="button" type="button" disabled={isFetching || autohdrBlocked} onClick={() => void fetchEdited()}>{autohdrLabel}</button></div>}
```

This also resolves round 7/8's other open item as a fact: `publishManualUpload()` returns bare
`Promise<{ jobId: string }>` (`workers/background/src/index.ts:212`, `rpc-types.ts:12` — Terra
confirmed by direct read), so Fix 8b's `.then((r) => r.jobId)` normalization in the retry route is
correct exactly as written — no change needed there.

### T8 — two smaller live-code corrections

1. **No named-export block.** `packages/db/src/index.ts:4` is `export * as schema from
   "./schema"` — a namespace re-export. R6 §2.3's proposed named-export block for
   `autohdrScaffoldClaims` is unnecessary and inconsistent with how every other table in this repo
   is exported; delete R6 §2.3 entirely. Declaring the table in `schema.ts` (R6 §2.1, unchanged)
   is sufficient.
2. **Validate the new admin backfill route body with Zod**, matching the existing
   `/admin/renditions/backfill` route (`workers/app/src/routes/admin.ts:18, 36-48`) exactly,
   instead of trusting a compile-time-only generic on `c.req.json()`:

```ts
const autohdrBackfillInput = z.object({ dryRun: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().uuid().optional() });

adminRoutes.post("/admin/autohdr/backfill", async (c) => {
  if (!adminAllowed(c)) return c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
  const input = await jsonInput(c, autohdrBackfillInput); if (input instanceof Response) return input;
  const res = await c.env.BACKGROUND.backfillAutoHdrV2(input);
  await audit(c.env, c.get("user").id, "admin.autohdr_backfill", "system", "backfill", { result: res });
  return c.json(res);
});
```

---

## Round 10 — corrections from Terra's second pre-build review

Terra reviewed Round 9 fresh, no memory of the prior pass. **Verdict: NOT APPROVED.** Confirmed
fixed: T2, T3, T4, T8. T7 mostly fixed (one precedence bug). **Still broken: T1 (the scaffold
writer — the central piece), T5, T6.** The orchestrating session independently re-verified
Terra's more surprising claims directly against live code before accepting them (per
`docs/lessons.md`'s standing rule to verify subagent claims, not just trust a report) — all
confirmed real:

- `packages/db/src/schema.ts:760` — `jobs.kind` is plain `text("kind")`, no enum. Round 9's
  instruction to "add to the enum" was simply wrong; there's nothing to add to.
- `workers/background/src/queue-dispatch.ts:15-35` — `parseQueueBody()` only recognizes
  `asset_ingested`, `dropbox_sync`, `autohdr_check` on the ingest queue. An unrecognized `type`
  returns `null`, and the queue consumer's own code (`index.ts:529`) throws `"Invalid queue body"`
  for a `null` parse — so Round 9's `autohdr_scaffold` message would never reach its switch case,
  it would just retry forever as an invalid body.
- `rawFolderPath` is genuinely NOT write-once system-wide, contradicting Round 9's stated
  assumption: `PATCH /projects/:id` (`workers/app/src/routes/projects.ts:19,194`,
  `editFields = projectFields.partial()`) writes it unconditionally, and the Dropbox
  reconciliation sync (`workers/background/src/dropbox/sync.ts:296`,
  `if (project.rawFolderPath !== rawFolderPath) ...`) writes it whenever it differs, not only
  from null. Two more real writers than Round 9 accounted for.
- `workers/app/src/routes/projects.ts:438` — project DELETE refuses while any job is
  `queued`/`running`. A scaffold job that never transitions out of `queued` blocks deletion
  forever.
- `workers/background/src/dropbox/client.ts:45` — `DropboxFolderPage` (the `listFolderIfExists()`
  return type) carries `entries`/`cursor`/`has_more`, no folder id. `getMetadata()` (used exactly
  this way already at `index.ts:390-393`) is the right call for a real `folder_id`.

### T1 — the scaffold writer redesigned for real executability

**Fix 1: the queue/RPC pipeline.**

Add `"autohdr_scaffold"` handling to `parseQueueBody()`'s `INGEST_QUEUE_NAME` branch
(`queue-dispatch.ts`), validating all three carried fields, mirroring the existing
`autohdr_check`/`dropbox_sync` cases in the same function:

```ts
if (value.type === "autohdr_scaffold" &&
    typeof value.projectId === "string" && value.projectId.length > 0 &&
    typeof value.jobId === "string" && value.jobId.length > 0 &&
    typeof value.rawFolderPath === "string" && value.rawFolderPath.length > 0) {
  return { queue, body: { type: "autohdr_scaffold", projectId: value.projectId, jobId: value.jobId, rawFolderPath: value.rawFolderPath } };
}
```

Add the matching variant to the `IngestMessage` union in `messages.ts`. **Drop Round 9's `jobs.kind`
enum instruction entirely — `kind` is plain text, `"autohdr_scaffold"` needs no schema change.**

Extract a shared free function instead of routing Tonomo through a nonexistent self-RPC binding
(`workers/background/src/env.ts:9-33` has no binding back to itself — confirmed, Terra was right):

```ts
// workers/background/src/autohdr/scaffold.ts
export async function enqueueAutoHdrScaffold(env: Env, projectId: string, rawFolderPath: string): Promise<{ jobId: string }> {
  const db = dbFor(env);
  const jobId = await createJob(db, { kind: "autohdr_scaffold", projectId, correlationId: `autohdr_scaffold:${projectId}` });
  try {
    await env.INGEST_QUEUE.send({ type: "autohdr_scaffold", projectId, jobId, rawFolderPath });
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
```

The RPC method on `QuincyBackground` becomes a thin wrapper calling this (used by the app-side
`projects.ts:134` call site, a real cross-worker binding call). **Tonomo's two call sites import
and call `enqueueAutoHdrScaffold(env, ...)` directly** — `tonomo/process.ts` already runs inside
`workers/background`, so this is a plain same-worker function call, not an RPC hop.

All three call sites become **awaited with a caught error**, not `void`-fired — a Promise neither
awaited nor passed to `waitUntil` can be cancelled once a Worker's response returns or a Durable
Object's handler resolves:

```ts
// projects.ts:134-142, after the schema.projects insert:
if (fields.rawFolderPath) await c.env.BACKGROUND.ensureAutoHdrScaffold(id, fields.rawFolderPath)
  .catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
```
(Tonomo's two call sites: same shape, `await enqueueAutoHdrScaffold(env, ...).catch(...)`.)

**Fix 2: real writers (four, not three) and safe race/collision handling.**

Round 9 assumed `rawFolderPath` was write-once; it isn't (see confirmed writers above). Rather
than retrofitting write-once enforcement across four call sites in three different files, redesign
`ensureScaffold()` to handle a **changed** path explicitly — retiring the project's own prior
scaffold claim and creating/reactivating one for the new path — and to make its own job's terminal
status precise, since project deletion depends on it:

```ts
// workers/background/src/autohdr/scaffold.ts
export async function ensureScaffold(env: Env, jobId: string, projectId: string, rawFolderPath: string): Promise<void> {
  const db = dbFor(env);
  const connectionId = await canonicalDropboxConnectionId(db);
  const folderName = deriveAutoHdrFolderName(rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);
  const now = new Date();

  const ownActive = await db.select({ id: autohdrScaffoldClaims.id, scaffoldPathKey: autohdrScaffoldClaims.scaffoldPathKey })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.projectId, projectId), eq(autohdrScaffoldClaims.state, "active")))
    .get();
  if (ownActive?.scaffoldPathKey === scaffoldPathKey) {
    // Already scaffolded for this exact path. createFolder is idempotent, so re-running it here
    // safely repairs a prior job that wrote the claim but died before folder creation ran.
    await createFolder(env, db, scaffoldPath, connectionId);
    await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
    await setJobStatus(db, jobId, "done");
    return;
  }

  const holder = await db.select({ id: autohdrScaffoldClaims.id, projectId: autohdrScaffoldClaims.projectId })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.connectionId, connectionId), eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey)))
    .get();
  if (holder && holder.projectId !== projectId) {
    const diagnostic = `AutoHDR scaffold path collision at ${scaffoldPathKey}; owned by project ${holder.projectId}.`;
    console.error("AutoHDR scaffold path collision", { projectId, scaffoldPathKey, ownedBy: holder.projectId });
    await setJobStatus(db, jobId, "failed", diagnostic); // permanent until a human resolves the folder-name clash; do not retry
    return;
  }

  const statements = [];
  if (ownActive) {
    // rawFolderPath was edited after this project was already scaffolded (PATCH or Dropbox
    // reconciliation) — supersede the stale claim rather than leaving two active rows, which the
    // active-project-unique index would reject anyway.
    statements.push(env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active'")
      .bind(now.getTime(), ownActive.id));
  }
  if (holder) {
    // Same project reclaiming a path it previously retired (e.g. an edit reverted).
    statements.push(env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'active', updated_at = ? WHERE id = ?")
      .bind(now.getTime(), holder.id));
  } else {
    statements.push(env.DB.prepare("INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
      .bind(crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, now.getTime(), now.getTime()));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A genuine unique-constraint race (another writer claimed the same path, or this project's
    // own active slot, between our reads and this batch) is safe to drop — re-running
    // ensureAutoHdrScaffold (the next writer that fires) picks up whatever the winner left. Any
    // other error must surface so the queue retries a real transient failure instead of silently
    // eating it. Export and reuse `isUniqueConflict` from `autohdr/claims.ts` rather than
    // re-inlining the same cause-chain walk.
    if (isUniqueConflict(error)) { await setJobStatus(db, jobId, "done"); return; }
    throw error;
  }

  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
  await setJobStatus(db, jobId, "done");
}
```

On any other thrown error (Dropbox API failure, network error), this function throws out of the
queue handler, which is left uncaught by design — the existing `queue()` catch-all
(`index.ts:557-569`) logs it and calls `message.retry()`, leaving the job `queued` for a natural
retry, same as every other queue-driven job kind in this file.

### T5 — the widened predicate never actually reached the guarded statements

**Problem:** Round 9 added a stage-UPDATE/audit pair but never replaced the hardcoded
`stage_key = 'editing_autohdr'` eligibility guard already present in Fix 7c's own SQL (the job and
handoff INSERTs). A `raw_review` project's INSERT still no-ops before the new stage-transition
statements ever run — the cure was added without removing the disease.

**Fix:** broaden the SAME predicate Fix 7c/P3 established, consistently, across every guarded
statement in `claimBackfillAutoHdrHandoff()`'s batch (job INSERT, handoff INSERT, mapping INSERT,
path-claim INSERT/UPDATE) from `stage_key = 'editing_autohdr'` to
`stage_key IN ('raw_review', 'editing_autohdr')`. Thread which branch actually applied back to the
caller (or re-select the project's stage once, before building the batch, and branch on it) so the
stage-UPDATE/audit pair — unchanged from Round 9's design — is included in the batch array only for
the `raw_review` case, and omitted entirely (not merely a no-op) when the project is already
`editing_autohdr`.

### T6 — three remaining backfill gaps

1. **Real folder id.** Round 9's "`folder_id` from the listing response" doesn't exist —
   `listFolderIfExists()` returns `DropboxFolderPage` (`entries`/`cursor`/`has_more`, no id,
   confirmed at `dropbox/client.ts:45`). After confirming a candidate exists, call `getMetadata()`
   (same call `resolveAutoHdrMapping()` already makes, `index.ts:390-393`), require a folder
   result, and pass its real `.id` into the atomic writer — store it on both the mapping and the
   path claim, matching the ordinary router's own fields (`mapping.ts:127`, `:150`).
2. **Both-candidates-exist branch.** The private `blockMapping()` doesn't apply — it operates on
   an already-existing mapping row, and backfill hasn't created one yet at this point. Simplest
   sound behavior: skip with an explicit ambiguity reason ("both FINAL and FINALS candidates
   exist — staff must determine which is authoritative before backfill can proceed"), create
   nothing.
3. **Backfill's own path-claim collision.** Round 9 left this on Fix 7d's original "write a
   blocked handoff/mapping" behavior — T4 only changed the *implicit* router's collision handling
   (to `retired`), not backfill's. Since backfill is a bounded, re-runnable operator scan (not a
   Dropbox-delta-triggered event that needs a permanent operator-visible trail the way the live
   router does), the simpler and sufficient fix is: on a path-claim collision, insert nothing at
   all — no handoff, no mapping, no claim — and report a structured collision skip reason in the
   result's `items` array. Staff resolves the underlying Dropbox naming clash and re-runs backfill.

### T7 — terminal-state precedence and a real self-rescheduling poll

**Problem:** `autohdrBlocked` was computed from `mappingState === "blocked_collision"` without
checking terminal state first, so a `retired` handoff with a leftover `blocked_collision` mapping
(exactly the shape T4's fix produces) rendered as "Blocked" instead of terminal/none — contradicting
both T4 and P6. Separately, the concrete polling code installed an unconditional 5-second
`setInterval` with no stop/back-off on terminal or blocked state, contradicting Fix 8e/P8's own
stated intent.

**Fix — terminal check first:**

```ts
const autohdrTerminal = autohdrStatus?.state === "retired" || autohdrStatus?.state === "failed";
const autohdrBlocked = !autohdrTerminal && (autohdrStatus?.state === "blocked" || autohdrStatus?.mappingState === "blocked_collision");
```

**Fix — self-rescheduling `setTimeout` instead of `setInterval`**, so the poll simply stops
rescheduling on terminal/blocked rather than needing separate interval-clearing logic layered on
top (replaces Fix 8e's `useState`/`setInterval` sketch and P8's `useRef` note with one concrete
implementation):

```tsx
const autohdrStatusRef = useRef<AutoHdrStatusResponse["handoff"]>(null);
useEffect(() => {
  if (!canAdminBackend || !projectId || data?.stageKey !== "editing_autohdr") return;
  let isMounted = true;
  let timer: number | undefined;
  const poll = async () => {
    try {
      const { handoff } = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
      if (!isMounted) return;
      setAutohdrStatus(handoff);
      const wasActive = autohdrStatusRef.current?.mappingState === "active";
      if (handoff?.state === "started" && handoff.mappingState === "active" && !wasActive) void refreshAssets("edited");
      autohdrStatusRef.current = handoff;
      const terminal = handoff === null || handoff.state === "retired" || handoff.state === "failed";
      const blocked = handoff?.state === "blocked" || handoff?.mappingState === "blocked_collision";
      if (isMounted && !terminal && !blocked) timer = window.setTimeout(poll, 5_000);
    } catch {
      if (isMounted) timer = window.setTimeout(poll, 5_000);
    }
  };
  void poll();
  return () => { isMounted = false; if (timer) window.clearTimeout(timer); };
}, [canAdminBackend, data?.stageKey, projectId, refreshAssets]);
```

---

## Round 11 — corrections from Terra's third pre-build review

Terra reviewed Round 10 fresh. **Verdict: NOT APPROVED**, but confirmed T2/T3/T4/T8, the
migration, the Fix 8b callers, `adminAllowed`, and the status endpoint shape all still hold, and
that `parseQueueBody()`, the self-RPC fix, the `getMetadata()` swap, and T7's precedence fix are
all now directionally correct. Five remaining findings, all in genuinely new territory this plan
hadn't reached before (real concurrency edge cases in freshly-designed code, not misreads).

### T1 — redesigned to make staleness structurally impossible, not just handled

**Problems, all confirmed:**
- Two more real writers than Round 10's "three call sites": `PATCH /projects/:id`
  (`projects.ts:194`) and Dropbox reconciliation (`sync.ts:296`) — five total.
- The new RPC method needs a declaration in `rpc-types.ts` (the app's `BACKGROUND` binding is
  typed as `Service<QuincyBackground>` against that abstract class, `env.ts:11` — confirmed) or
  the app-side call site simply won't typecheck.
- The race analysis: passing `rawFolderPath` as a payload value and fencing against it is the
  wrong shape entirely — two concurrent jobs carrying two different target paths, or a queue
  redelivery replaying a stale payload after a newer write, can each converge to the wrong state
  no matter how carefully the fencing is written.
- A message that exhausts `quincy-ingest`'s `max_retries: 3` (`wrangler.jsonc:26`, no DLQ bound to
  this queue) is dropped by Cloudflare with the job left permanently `queued`, blocking project
  deletion (`projects.ts:438`) forever.

**Fix — stop passing `rawFolderPath` at all; re-read it fresh at execution time.** Every trigger
just signals "re-check this project's scaffold now" — the source of truth is always the project
row at the moment the job actually runs, never a value carried in a message. This eliminates the
staleness/ordering race by construction: regardless of which of several racing jobs for the same
project executes first, last, or gets redelivered late, each execution converges to whatever
`raw_folder_path` the project row actually holds *at that moment* — there is no older/newer
payload to order against.

```ts
// workers/background/src/autohdr/scaffold.ts
export async function enqueueAutoHdrScaffold(env: Env, projectId: string): Promise<{ jobId: string }> {
  const db = dbFor(env);
  // No single-flight dedup needed — execution always re-reads current state (see below), so
  // multiple concurrent scaffold jobs for one project are harmless, not a correctness risk.
  const jobId = await createJob(db, { kind: "autohdr_scaffold", projectId });
  try {
    await env.INGEST_QUEUE.send({ type: "autohdr_scaffold", projectId, jobId });
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}
```

(No `rawFolderPath` field on the queue message at all — drop it from the `parseQueueBody()`
validation Round 10 added too; only `type`/`projectId`/`jobId` need checking now.)

```ts
export async function ensureScaffold(env: Env, jobId: string, projectId: string, attempt = 0): Promise<void> {
  const db = dbFor(env);
  const project = await db.select({ rawFolderPath: projects.rawFolderPath }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) { await setJobStatus(db, jobId, "done"); return; } // deleted before this ran
  const connectionId = await canonicalDropboxConnectionId(db);
  const ownActive = await db.select({ id: autohdrScaffoldClaims.id, scaffoldPathKey: autohdrScaffoldClaims.scaffoldPathKey })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.projectId, projectId), eq(autohdrScaffoldClaims.state, "active")))
    .get();

  if (!project.rawFolderPath) {
    // Cleared to null (PATCH). Retire any existing active claim — nothing to scaffold anymore.
    if (ownActive) await db.update(autohdrScaffoldClaims).set({ state: "retired", updatedAt: new Date() })
      .where(and(eq(autohdrScaffoldClaims.id, ownActive.id), eq(autohdrScaffoldClaims.state, "active")));
    await setJobStatus(db, jobId, "done");
    return;
  }

  const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);
  const now = new Date();

  if (ownActive?.scaffoldPathKey === scaffoldPathKey) {
    await createFolder(env, db, scaffoldPath, connectionId);
    await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
    await setJobStatus(db, jobId, "done");
    return;
  }

  const holder = await db.select({ id: autohdrScaffoldClaims.id, projectId: autohdrScaffoldClaims.projectId })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.connectionId, connectionId), eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey)))
    .get();
  if (holder && holder.projectId !== projectId) {
    const diagnostic = `AutoHDR scaffold path collision at ${scaffoldPathKey}; owned by project ${holder.projectId}.`;
    console.error("AutoHDR scaffold path collision", { projectId, scaffoldPathKey, ownedBy: holder.projectId });
    // Deliberate design choice: do NOT retire ownActive here. A project's existing, working
    // scaffold must never be torn down just because its NEW target is blocked — that would leave
    // the project with no scaffold at all instead of a stale-but-functional one. A human resolves
    // the Dropbox-side naming clash; any future write to raw_folder_path (or a manual re-trigger)
    // picks the new target back up once it's clear.
    await setJobStatus(db, jobId, "failed", diagnostic);
    return;
  }

  const statements = [];
  if (ownActive) statements.push(env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active'")
    .bind(now.getTime(), ownActive.id));
  if (holder) statements.push(env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'active', updated_at = ? WHERE id = ?")
    .bind(now.getTime(), holder.id));
  else statements.push(env.DB.prepare("INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
    .bind(crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, now.getTime(), now.getTime()));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (!isUniqueConflict(error) || attempt >= 3) throw error; // export isUniqueConflict from autohdr/claims.ts
    // Lost a race to another writer for this project's active slot or this path key. Since
    // execution always re-reads current state rather than trusting a payload, the correct
    // response to any unique conflict is simply "run the whole read-decide-write sequence again"
    // — whichever write actually landed becomes the new ownActive/holder on the next pass,
    // converging to the current DB value regardless of which racing job actually won. Bounded to
    // 3 attempts as a pathological-contention backstop, not an expected path.
    return ensureScaffold(env, jobId, projectId, attempt + 1);
  }

  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
  await setJobStatus(db, jobId, "done");
}
```

**All five call sites** now pass only `projectId` — simpler than Round 10's per-site payload
threading, and uniform:

```ts
// projects.ts:137 (create) and :194 (PATCH, including clearing to null) — both react to any
// write that touches rawFolderPath, not just a null->value transition:
await c.env.BACKGROUND.ensureAutoHdrScaffold(id).catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
```
```ts
// tonomo/process.ts:94 (createProject) and :121 (updateProject) — direct function call, same worker:
await enqueueAutoHdrScaffold(env, id).catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
```
```ts
// dropbox/sync.ts:296, right after the existing rawFolderPath UPDATE:
await enqueueAutoHdrScaffold(env, projectId).catch((error) => console.error("AutoHDR scaffold trigger failed", { projectId, error }));
```

Add to `workers/background/src/rpc-types.ts`'s abstract class:
```ts
abstract ensureAutoHdrScaffold(projectId: string): Promise<{ jobId: string }>;
```

**The queued-forever-after-final-retry gap** is specific to this job kind's queue handler, not a
general fix to `quincy-ingest`'s retry architecture (out of scope — it would affect every existing
job kind on that queue, which this plan has no reason to touch). Give the `autohdr_scaffold` case
its own try/catch inside `queue()`, separate from the shared catch-all, so the LAST allowed attempt
terminalizes the job instead of leaving it `queued` after Cloudflare silently drops the message:

```ts
case "autohdr_scaffold":
  try {
    await ensureScaffold(this.env, parsed.body.jobId, parsed.body.projectId);
    message.ack();
  } catch (error) {
    if (message.attempts >= 3) { // matches quincy-ingest's configured max_retries — verify against wrangler.jsonc:26
      await setJobStatus(dbFor(this.env), parsed.body.jobId, "failed", error instanceof Error ? error.message : String(error));
      message.ack(); // already recorded terminal; no point letting Cloudflare's own final retry run and drop it silently
    } else {
      throw error; // falls through to the existing shared catch-all's message.retry()
    }
  }
  break;
```

### T5 — always include the stage-transition pair; drop the pre-read branch entirely

**Problem:** Round 10's "re-select the project's stage once, decide which branch, include the pair
only for `raw_review`" is a TOCTOU race — the live stage-advance route
(`workers/app/src/routes/projects.ts:477`) can change the project's stage between that read and the
batch commit, with no guard tying them together.

**Fix — simpler than Round 10's, and race-free:** always append the guarded
`raw_review -> editing_autohdr` UPDATE and its adjacent `changes()`-gated audit INSERT to
backfill's batch, unconditionally — exactly matching the live, already-correct pattern
`confirmAutoHdrHandoff()` uses (`autohdr/claims.ts:51-59`), which needs no pre-read because the
guard clause itself (`WHERE stage_key = 'raw_review'`) naturally no-ops when the project is already
`editing_autohdr`. No branching, no separate stage read, no race window.

### T6 — collision requery and re-runnability after a fetch-start failure

1. **Collision catch/requery.** Another writer can claim the target path between backfill's
   pre-check and its atomic batch; the permanent unique index correctly rolls the batch back, but
   nothing turns that into the promised structured skip. Wrap the batch in a try/catch for
   `isUniqueConflict` (same exported helper as T1) and, on conflict, report the same structured
   collision-skip result as the pre-detected case — no requery/convergence loop needed here (unlike
   T1's scaffold writer), since backfill doesn't need self-healing: it's a bounded, operator-driven,
   safely re-runnable scan, and the operator re-running it later is already the designed recovery
   path for every other backfill skip reason.
2. **Re-runnability after `startClaimedFetch()` fails.** Not a bug to fix in backfill itself: once
   the atomic batch commits, the handoff is `state: 'started'` — indistinguishable from any
   ordinarily-routed project's handoff. If `claimAutoHdrFetch()`/`startClaimedFetch()`
   subsequently fails to start, recovery is the SAME existing mechanism every other project already
   has — `claimAutoHdrFetch()`'s own orphaned-starting-lease recovery (`claims.ts:213-224`) plus the
   ordinary manual "Fetch edited from autoHDR" button, or the next Dropbox delta. Re-running
   *backfill* is correctly not the recovery path here (backfill's own inclusion query intentionally
   excludes projects with a `started` handoff — that's backfill's job being done, not a bug); state
   this explicitly rather than building resumption logic backfill doesn't need.

### T7 — scope the transition-detection ref to project + handoff, not just mapping state

**Problem:** `autohdrStatusRef` survives across effect reruns, but `refreshAssets`'s identity
changes with `projectId`/tab (`ProjectWorkspace.tsx:67`). Navigating between two different projects
that are both already `active` reads `wasActive` as true from the PRIOR project and suppresses the
new project's refresh; the same blind spot hides a genuinely new handoff generation for the same
project.

**Fix:**

```tsx
const autohdrStatusRef = useRef<{ projectId: string; handoffId: string; mappingState: string } | null>(null);
// ...inside poll(), after setAutohdrStatus(handoff):
const prev = autohdrStatusRef.current;
const enteringActive = handoff?.state === "started" && handoff.mappingState === "active"
  && !(prev && prev.projectId === projectId && prev.handoffId === handoff.id && prev.mappingState === "active");
if (enteringActive) void refreshAssets("edited");
autohdrStatusRef.current = handoff ? { projectId, handoffId: handoff.id, mappingState: handoff.mappingState } : null;
```

---

## Round 12 — corrections from Terra's fourth pre-build review

Terra reviewed Round 11 fresh. **Verdict: NOT APPROVED**, but confirmed T5 is race-safe, all five
`rawFolderPath` writers are now correctly accounted for, the RPC declaration/signature is right,
and no regression anywhere else (T2/T3/T4/T8, migration, Fix 8b callers, `adminAllowed`, status
endpoint shape). Four findings remain, all engineered-correctness gaps in freshly-designed code —
per explicit user direction, this round closes every one of them rather than trading correctness
for scope (no reliance on `max_concurrency: 1` as an implicit safety net, and the UI gets real
`raw_review`-workspace polling rather than punting on it).

### 1 — `ensureScaffold()`: true optimistic-concurrency convergence, not an implicit `max_concurrency: 1` dependency

**Problem:** confirmed. Two concurrent executions can each read pre-mutation state, then both
issue UPDATEs that succeed against a stale precondition without ever tripping a unique-constraint
exception — the retire-UPDATE was guarded (`WHERE state = 'active'`) but its `changes()` result was
never checked, so a lost race was silently invisible rather than triggering a retry. This was only
"safe" because `wrangler.jsonc:26` happens to set `max_concurrency: 1` today — an unstated
dependency, not a designed property. Separately: a failed or collision-blocked `autohdr_scaffold`
job has no recovery surface — the jobs list and retry route both exclude this kind
(`projects.ts:381`, `:390`).

**Fix — every guarded mutation checks its own `changes()`; any staleness triggers a bounded
full re-run from a fresh read**, so correctness no longer depends on queue concurrency configuration
at all:

```ts
export async function ensureScaffold(env: Env, jobId: string, projectId: string, attempt = 0): Promise<void> {
  const db = dbFor(env);
  const project = await db.select({ rawFolderPath: projects.rawFolderPath }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) { await setJobStatus(db, jobId, "done"); return; }
  const connectionId = await canonicalDropboxConnectionId(db);
  const ownActive = await db.select({ id: autohdrScaffoldClaims.id, scaffoldPathKey: autohdrScaffoldClaims.scaffoldPathKey })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.projectId, projectId), eq(autohdrScaffoldClaims.state, "active")))
    .get();

  const retry = (): Promise<void> => {
    if (attempt >= 5) throw new Error(`AutoHDR scaffold convergence failed after ${attempt} attempts for project ${projectId}`);
    return ensureScaffold(env, jobId, projectId, attempt + 1);
  };

  if (!project.rawFolderPath) {
    if (!ownActive) { await setJobStatus(db, jobId, "done"); return; }
    const result = await env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active'")
      .bind(Date.now(), ownActive.id).run();
    if ((result.meta.changes ?? 0) !== 1) return retry(); // pre-read was stale — someone else already changed this row
    await setJobStatus(db, jobId, "done");
    return;
  }

  const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);
  const now = new Date();

  if (ownActive?.scaffoldPathKey === scaffoldPathKey) {
    await createFolder(env, db, scaffoldPath, connectionId);
    await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
    await setJobStatus(db, jobId, "done");
    return;
  }

  const holder = await db.select({ id: autohdrScaffoldClaims.id, projectId: autohdrScaffoldClaims.projectId, state: autohdrScaffoldClaims.state })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.connectionId, connectionId), eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey)))
    .get();
  if (holder && holder.projectId !== projectId) {
    const diagnostic = `AutoHDR scaffold path collision at ${scaffoldPathKey}; owned by project ${holder.projectId}.`;
    console.error("AutoHDR scaffold path collision", { projectId, scaffoldPathKey, ownedBy: holder.projectId });
    await setJobStatus(db, jobId, "failed", diagnostic); // recoverable: see the retry-route wiring below
    return;
  }

  const statements: { stmt: ReturnType<typeof env.DB.prepare>; mustChange: boolean }[] = [];
  if (ownActive) statements.push({
    stmt: env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active'").bind(now.getTime(), ownActive.id),
    mustChange: true,
  });
  if (holder) statements.push({
    stmt: env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'active', updated_at = ? WHERE id = ? AND state = ?").bind(now.getTime(), holder.id, holder.state),
    mustChange: true,
  });
  else statements.push({
    stmt: env.DB.prepare("INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
      .bind(crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, now.getTime(), now.getTime()),
    mustChange: false, // an INSERT either succeeds or throws a unique-constraint error; changes() staleness detection doesn't apply
  });

  let results;
  try {
    results = await env.DB.batch(statements.map((s) => s.stmt));
  } catch (error) {
    if (!isUniqueConflict(error) || attempt >= 5) throw error;
    return retry();
  }
  // Every guarded UPDATE must have actually applied. If the pre-read was stale (another writer
  // already changed the row between our SELECT and this batch), the WHERE guard makes it a
  // silent no-op instead of a thrown error — checking changes() here is the only way to detect
  // that and retry, since D1 has no cross-statement optimistic-lock primitive of its own.
  if (statements.some((s, i) => s.mustChange && (results[i]?.meta.changes ?? 0) !== 1)) return retry();

  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
  await setJobStatus(db, jobId, "done");
}
```

**Recovery surface**: widen the project jobs listing's kind filter at `projects.ts:381` to include
`"autohdr_scaffold"` (implementer: confirm the exact filter shape at that line — Terra has full
read access and can verify the precise change on the next pass) so a failed or collision-blocked
scaffold job is actually visible to staff, and add a fourth branch to the retry route's outcome
ternary (`projects.ts:390`, extending Fix 8b's existing three-way branch):

```ts
const outcome = job.kind === "autohdr"
  ? await c.env.BACKGROUND.startAutoHdr(job.projectId, c.get("user").id)
  : job.kind === "fetch_edited"
    ? await c.env.BACKGROUND.fetchEditedFromAutoHdr(job.projectId)
    : job.kind === "autohdr_scaffold"
      ? { ok: true as const, jobId: await c.env.BACKGROUND.ensureAutoHdrScaffold(job.projectId).then((r) => r.jobId) }
      : { ok: true as const, jobId: await c.env.BACKGROUND.publishManualUpload(job.projectId, manualAssetId!).then((r) => r.jobId) };
```

### 2 — off-by-one in the terminal-attempt threshold

**Problem:** confirmed against the installed `@cloudflare/workers-types` — `Message.attempts`
starts at **1** on first delivery, so `max_retries: 3` (`wrangler.jsonc:26`) means the final
delivery has `attempts === 4`, not 3. Round 11's `attempts >= 3` discarded one legitimate retry.

**Fix:**

```ts
const INGEST_QUEUE_MAX_ATTEMPTS = 4; // 1 initial delivery + max_retries: 3 (wrangler.jsonc) — Message.attempts starts at 1
// ...
if (message.attempts >= INGEST_QUEUE_MAX_ATTEMPTS) { /* mark job failed, message.ack() */ } else { throw error; }
```

### 3 — backfill's collision catch conflates unrelated unique constraints

**Problem:** confirmed — the batch can violate any of several distinct unique constraints
(`autohdr_handoffs`'s project+generation or active-project-unique, `autohdr_output_mappings`'s
project+generation or one-mapping-per-handoff, `autohdr_path_claims`'s connection+path-key or
mapping+candidate — `schema.ts:427,440,478`). Treating every `isUniqueConflict` as "path collision"
misreports a genuinely different scenario (a concurrent write racing backfill for the same
project) as the wrong kind of skip.

**Fix — requery to disambiguate which constraint actually fired, in order:**
1. Re-check for an active handoff on this project (`state IN ('starting','started','blocked')`).
   If one now exists that isn't the row backfill just tried to create, report a distinct skip
   reason — `"A concurrent handoff claimed this project during backfill — skipping, it's no
   longer stranded"` — not a collision.
2. Re-check the target path key for a holder belonging to a **different** project. If found,
   that's the genuine path collision — report exactly as the pre-detected case does.
3. Anything else: rethrow. An unexplained unique-constraint hit that doesn't match either known
   cause must not be silently swallowed.

### 4 — the UI never discovers an implicit stage-advance while a `raw_review` workspace is open

**Problem:** confirmed, and structurally significant — this plan's own purpose is detecting
AutoHDR activity a staff member never explicitly triggered, but the polling effect only starts
once the project's *locally loaded* `stageKey` already reads `editing_autohdr`
(`ProjectWorkspace.tsx:121`, current draft). A staff member with a `raw_review` project open when
a Dropbox delta implicitly advances it server-side has no mechanism to discover that without a
manual page refresh — exactly the gap this plan exists to close, reappearing in the UI layer.
Separately: mapping activation happens *before* the fetch actually launches
(`do/dropbox-sync.ts:120`), so refreshing assets the instant `mappingState` reads `"active"` can
fire before any asset has actually landed.

**Fix — poll in `raw_review` too; on activity, hand off to the existing job-poller instead of
racing it; reset state on project change:**

```tsx
const autohdrStatusRef = useRef<{ projectId: string; handoffId: string; mappingState: string } | null>(null);
useEffect(() => {
  if (!canAdminBackend || !projectId || (data?.stageKey !== "raw_review" && data?.stageKey !== "editing_autohdr")) return;
  let isMounted = true;
  let timer: number | undefined;
  setAutohdrStatus(null);
  autohdrStatusRef.current = null;
  const poll = async () => {
    try {
      const { handoff } = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
      if (!isMounted) return;
      setAutohdrStatus(handoff);
      const prev = autohdrStatusRef.current;
      const enteringActive = handoff?.state === "started" && handoff.mappingState === "active"
        && !(prev && prev.projectId === projectId && prev.handoffId === handoff.id && prev.mappingState === "active");
      if (enteringActive) {
        // Don't refresh assets directly here — mapping "active" only means the fetch job was
        // just started (dropbox-sync.ts:120), not that anything landed yet. Surface the new job
        // to the EXISTING job-polling effect (lines 121-126 in the pre-Round-12 draft), which
        // already refreshes assets every 5s while a job is queued/running and stops once
        // terminal — avoids reimplementing "wait for job completion" a second time.
        void refreshJobs();
      }
      // A handoff appearing/advancing while the project was locally still raw_review means the
      // server-side stage actually moved — refresh project state to pick up the real stageKey.
      if (handoff && data?.stageKey === "raw_review") void refreshProject();
      autohdrStatusRef.current = handoff ? { projectId, handoffId: handoff.id, mappingState: handoff.mappingState } : null;
      const terminal = handoff === null || handoff.state === "retired" || handoff.state === "failed";
      const blocked = handoff?.state === "blocked" || handoff?.mappingState === "blocked_collision";
      if (isMounted && !terminal && !blocked) timer = window.setTimeout(poll, 5_000);
    } catch {
      if (isMounted) timer = window.setTimeout(poll, 5_000);
    }
  };
  void poll();
  return () => { isMounted = false; if (timer) window.clearTimeout(timer); };
}, [canAdminBackend, data?.stageKey, projectId, refreshJobs, refreshProject]);
```

This supersedes Round 11's T7 snippet (same ref-scoping fix, folded in) rather than layering on
top of it.

---

## Round 13 — corrections from Terra's fifth pre-build review

Terra reviewed Round 12 fresh. **Verdict: NOT APPROVED.** Confirmed correct this pass: the
`INGEST_QUEUE_MAX_ATTEMPTS = 4` fix, backfill's disambiguated collision requery, and no regression
in T2/T3/T4/T5/T8, the migration, Fix 8b callers, `adminAllowed`, or the status endpoint shape.
Three findings remain — the user has been asked again whether to hold the line on full
correctness at this depth and **confirmed continuing**; this round closes all three.

### 1 — `ensureScaffold()`: fence every mutation against the live `projects` row, not a value snapshot

**Problem:** confirmed with a concrete failing interleaving — Round 12 snapshotted
`rawFolderPath` once, then never re-checked it in any of the later mutations. Two executions
racing a real `PATCH`-driven path change (A→B) can each apply a self-consistent-looking
retire/reactivate pair without ever tripping a unique constraint, converging to the WRONG final
state (the old path, when the project's real current path is the new one) with no retry
triggered — because `changes()` was checked against claim-table guards only, never against
whether the snapshotted project path was still current. Also confirmed: an off-by-one in the
retry bound (`attempt >= 5` with an initial call at `attempt = 0` allows six total executions
while the thrown message claims five).

**Fix — every mutating statement additionally requires the project's CURRENT `raw_folder_path` to
still equal the snapshot, via an inline `EXISTS` subquery against `projects`** (the same shape
`claimAutoHdrHandoff()`'s own INSERT already uses to guard against live project state,
`autohdr/claims.ts:135`) — not a value carried separately. This makes every mutation self-fencing:
if the real row has moved since the snapshot read, the guard silently fails and `changes()` is 0,
which is now checked on **every** statement including the INSERT (which can no longer be assumed
to only ever fail via a thrown unique-constraint exception, now that it carries its own `EXISTS`
guard) and the previously-unguarded **fast path**:

```ts
export async function ensureScaffold(env: Env, jobId: string, projectId: string, attempt = 0): Promise<void> {
  const db = dbFor(env);
  const project = await db.select({ rawFolderPath: projects.rawFolderPath }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) { await setJobStatus(db, jobId, "done"); return; }
  const connectionId = await canonicalDropboxConnectionId(db);
  const ownActive = await db.select({ id: autohdrScaffoldClaims.id, scaffoldPathKey: autohdrScaffoldClaims.scaffoldPathKey })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.projectId, projectId), eq(autohdrScaffoldClaims.state, "active")))
    .get();
  const now = new Date();

  const MAX_SCAFFOLD_ATTEMPTS = 5; // total executions, including this one
  const retry = (): Promise<void> => {
    if (attempt + 1 >= MAX_SCAFFOLD_ATTEMPTS) throw new Error(`AutoHDR scaffold convergence failed after ${MAX_SCAFFOLD_ATTEMPTS} attempts for project ${projectId}`);
    return ensureScaffold(env, jobId, projectId, attempt + 1);
  };

  if (!project.rawFolderPath) {
    if (!ownActive) { await setJobStatus(db, jobId, "done"); return; }
    const result = await env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path IS NULL)")
      .bind(now.getTime(), ownActive.id, projectId).run();
    if ((result.meta.changes ?? 0) !== 1) return retry();
    await setJobStatus(db, jobId, "done");
    return;
  }

  const folderName = deriveAutoHdrFolderName(project.rawFolderPath);
  const scaffoldPath = `${AUTOHDR_ROOT}/${folderName}`;
  const scaffoldPathKey = dropboxPathKey(scaffoldPath);

  if (ownActive?.scaffoldPathKey === scaffoldPathKey) {
    // Fast path also fences against the live row before terminalizing the job — closes Round
    // 12's remaining gap where a race between this read and folder creation could retire the
    // claim out from under an about-to-succeed job.
    const confirm = await env.DB.prepare("UPDATE autohdr_scaffold_claims SET updated_at = ? WHERE id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?)")
      .bind(now.getTime(), ownActive.id, projectId, project.rawFolderPath).run();
    if ((confirm.meta.changes ?? 0) !== 1) return retry();
    await createFolder(env, db, scaffoldPath, connectionId);
    await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
    await setJobStatus(db, jobId, "done");
    return;
  }

  const holder = await db.select({ id: autohdrScaffoldClaims.id, projectId: autohdrScaffoldClaims.projectId, state: autohdrScaffoldClaims.state })
    .from(autohdrScaffoldClaims)
    .where(and(eq(autohdrScaffoldClaims.connectionId, connectionId), eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey)))
    .get();
  if (holder && holder.projectId !== projectId) {
    const diagnostic = `AutoHDR scaffold path collision at ${scaffoldPathKey}; owned by project ${holder.projectId}.`;
    console.error("AutoHDR scaffold path collision", { projectId, scaffoldPathKey, ownedBy: holder.projectId });
    await setJobStatus(db, jobId, "failed", diagnostic);
    return;
  }

  const statements = [
    ownActive && env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?)")
      .bind(now.getTime(), ownActive.id, projectId, project.rawFolderPath),
    holder
      ? env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'active', updated_at = ? WHERE id = ? AND state = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?)")
        .bind(now.getTime(), holder.id, holder.state, projectId, project.rawFolderPath)
      : env.DB.prepare("INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ?)")
        .bind(crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, now.getTime(), now.getTime(), projectId, project.rawFolderPath),
  ].filter((s): s is NonNullable<typeof s> => Boolean(s));

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (!isUniqueConflict(error) || attempt + 1 >= MAX_SCAFFOLD_ATTEMPTS) throw error; // export isUniqueConflict from autohdr/claims.ts
    return retry();
  }
  // Every statement — including the now-guarded INSERT — must have actually applied. Any
  // changes !== 1 means the live row moved since our read; D1 has no cross-statement optimistic
  // lock of its own, so this is the only way to detect that and reconverge instead of committing
  // a self-consistent-looking but stale result.
  if (results.some((r) => (r?.meta.changes ?? 0) !== 1)) return retry();

  await createFolder(env, db, scaffoldPath, connectionId);
  await createFolder(env, db, autoHdrManualDropPath(folderName), connectionId);
  await setJobStatus(db, jobId, "done");
}
```

### 2 — the scaffold retry recovery surface: both allowlists, the audit action, and frontend visibility

**Problem:** confirmed against the real routes — `projects.ts:381` (jobs listing) and `:390`
(retry eligibility) are two SEPARATE allowlists, both currently
`["autohdr", "fetch_edited", "manual_edited_publish", "manual_raw_publish"]`; Round 12 only widened
the first. Every scaffold retry attempt would 404 before ever reaching the new outcome branch
(which itself begins at `:396`, not `:390` — a citation correction, not a code change). A retry
would also be misattributed to the audit action `project.retry_manual_edited_publish` without a
distinct branch of its own.

**Fix:**
1. Add `"autohdr_scaffold"` to **both** allowlists at `projects.ts:381` and `:390`.
2. Add a distinct case to the existing action-name selection feeding the retry route's audit call
   (Fix 8b referenced this as "...existing action-name ternary..." without ever adding this case):
   `job.kind === "autohdr_scaffold" ? "project.retry_autohdr_scaffold" : ...`.
3. Add `"autohdr_scaffold"` to the frontend `Job` type's `kind` union
   (`apps/web/src/screens/ProjectWorkspace.tsx:18`, currently `"autohdr" | "fetch_edited" |
   "manual_edited_publish"` — note `"manual_raw_publish"` is ALSO already missing from this
   frontend union despite being in the backend allowlist; pre-existing, out of scope for this
   plan, do not fix it as a drive-by).
4. Give it an explicit label in the job-history render instead of falling through to `"Send"`
   (`ProjectWorkspace.tsx:222`): extend the existing ternary chain with
   `job.kind === "autohdr_scaffold" ? "Scaffold" : ...` before the `"Send"` fallback.

### 3 — the polling redesign: discovery from `raw_review`, and real fetch-job-outcome observation

**Problem, confirmed with concrete failure windows:**
- Round 12 treated `handoff === null` as terminal and stopped rescheduling — but `null` is exactly
  the STARTING state of an open `raw_review` workspace before any implicit activity happens. It
  polls once, sees `null`, stops, and never discovers the handoff that appears later. This is the
  plan's own namesake gap resurfacing a second time.
- Mapping activation and fetch-job creation are two separate steps
  (`do/dropbox-sync.ts:120` routes, `:124` claims/starts the fetch) — a status poll can observe
  `mappingState: "active"` in the window before the fetch job exists. Round 12's one-shot
  `refreshJobs()` call on that transition can return before the job exists, and nothing retries.
- A fast-completing fetch can finish before that one-shot `refreshJobs()` call even resolves — the
  existing job-polling effect (`ProjectWorkspace.tsx:121-126`) only starts once local `jobs` state
  already contains something `queued`/`running`; a job that arrives already-terminal is invisible
  to it, so no asset refresh ever happens for a fetch that completed fast.

**Fix — never treat `null` as terminal; keep checking on every tick until the fetch job's outcome
is actually resolved, not just once on the activation transition.** This also needs `refreshJobs()`
to return the fetched array (a minimal, backward-compatible signature change — every existing
caller ignores the return value already):

```tsx
// ProjectWorkspace.tsx:80 — widen the return type, existing callers unaffected:
const refreshJobs = useCallback(async (): Promise<Job[]> => {
  if (!projectId || !canAdminBackend) return [];
  const fetched = (await apiGet<JobsResponse>(`/api/projects/${projectId}/jobs`)).jobs;
  setJobs(fetched);
  return fetched;
}, [canAdminBackend, projectId]);
```

```tsx
const autohdrFetchObservedRef = useRef<string | null>(null); // handoffId whose fetch-job outcome is already resolved
useEffect(() => {
  if (!canAdminBackend || !projectId || (data?.stageKey !== "raw_review" && data?.stageKey !== "editing_autohdr")) return;
  let isMounted = true;
  let timer: number | undefined;
  setAutohdrStatus(null);
  autohdrFetchObservedRef.current = null;
  const poll = async () => {
    try {
      const { handoff } = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
      if (!isMounted) return;
      setAutohdrStatus(handoff);
      const isActive = handoff?.state === "started" && handoff.mappingState === "active";
      if (isActive && autohdrFetchObservedRef.current !== handoff.id) {
        const freshJobs = await refreshJobs();
        if (!isMounted) return;
        const fetchJob = freshJobs.filter((job) => job.kind === "fetch_edited").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (fetchJob && (fetchJob.status === "queued" || fetchJob.status === "running")) {
          // The existing job-polling effect (ProjectWorkspace.tsx:121-126) depends on the same
          // `jobs` state this refreshJobs() call just updated — it now owns the rest on its own.
          autohdrFetchObservedRef.current = handoff.id;
        } else if (fetchJob && (fetchJob.status === "done" || fetchJob.status === "failed" || fetchJob.status === "stuck")) {
          // Finished before we ever saw it active — the existing effect's own gate
          // (jobs.some(activeJob)) never fires for a job it never observed active.
          void refreshAssets("edited");
          autohdrFetchObservedRef.current = handoff.id;
        }
        // else: no fetch_edited job yet — the race window before dropbox-sync.ts's own
        // claimAutoHdrFetch call lands. Leave unresolved; the next tick checks again.
      }
      if (handoff && data?.stageKey === "raw_review") void refreshProject(); // pick up the real (now-advanced) stageKey
      const terminal = handoff !== null && (handoff.state === "retired" || handoff.state === "failed");
      const blocked = handoff?.state === "blocked" || handoff?.mappingState === "blocked_collision";
      if (isMounted && !terminal && !blocked) timer = window.setTimeout(poll, 5_000);
    } catch {
      if (isMounted) timer = window.setTimeout(poll, 5_000);
    }
  };
  void poll();
  return () => { isMounted = false; if (timer) window.clearTimeout(timer); };
}, [canAdminBackend, data?.stageKey, projectId, refreshJobs, refreshAssets, refreshProject]);
```

This supersedes Round 11's and Round 12's polling snippets in full (not layered on top of either).

---

## Round 14 — corrections from Terra's sixth pre-build review

Terra reviewed Round 13 fresh. **Verdict: NOT APPROVED**, but with real progress: **the core
fenced-mutation convergence design is now confirmed sound** — Terra traced it against D1's actual
batch/transaction semantics (sequential, atomic, rolls back as a unit) and found no further
interleaving. Retry arithmetic, both allowlists, the audit action, frontend kind/label handling,
null-no-longer-terminal polling, and the Round 11/12 supersession are all confirmed correct. Three
narrower findings remain.

### 1 — the poll can resolve the wrong `fetch_edited` job

**Problem:** confirmed with a concrete interleaving — Round 13 matched "the newest `fetch_edited`
job for the project," with no correlation to the specific handoff/generation that's actually
active. A stale historical job (from a prior generation) observed in the window before the NEW
generation's fetch job exists gets misread as this handoff's outcome, permanently marking it
"resolved" — the real job that appears moments later is never discovered, because the resolved
flag was keyed only on `handoff.id` and nothing rechecks after that.

**Fix — correlate by the fetch claim's own `correlation_id`** (already
`fetch_edited:${projectId}:${generation}`, confirmed at `claims.ts:267`
`` `fetch_edited:${route.projectId}:${route.generation}` `` — not something new to invent), and
track the resolved **job id**, not just the handoff id, so a later manual retry (which creates a
genuinely new `jobs` row for the same handoff/generation) can also be discovered:

1. Widen `/api/projects/:id/jobs`'s response to include `correlationId` (implementer: locate the
   exact route and SELECT — Terra has full read access to confirm the precise shape next pass).
2. Add `correlationId: string | null` to the frontend `Job` type (`ProjectWorkspace.tsx:18`).
3. Match against the handoff's own `generation` field, already present in the
   `/autohdr-status` response (confirmed live at `projects.ts:265`).

```tsx
const autohdrObservedRef = useRef<{ handoffId: string; jobId: string } | null>(null);
// ...inside poll(), replacing Round 13's autohdrFetchObservedRef logic:
if (isActive) {
  const freshJobs = await refreshJobs();
  if (!isMounted) return;
  const fetchJob = freshJobs.find((job) => job.kind === "fetch_edited" && job.correlationId === `fetch_edited:${projectId}:${handoff.generation}`);
  const alreadyObserved = autohdrObservedRef.current?.handoffId === handoff.id && autohdrObservedRef.current?.jobId === fetchJob?.id;
  if (fetchJob && !alreadyObserved) {
    if (fetchJob.status === "queued" || fetchJob.status === "running") {
      autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id }; // existing job-poller now owns it
    } else if (fetchJob.status === "done" || fetchJob.status === "failed" || fetchJob.status === "stuck") {
      void refreshAssets("edited"); // finished before we ever saw it active
      autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id };
    }
    // else fetchJob undefined: not created yet — leave unresolved, next tick re-checks
  }
}
```

### 2 — the "absent path" fence disagrees with a live-accepted empty string

**Problem:** confirmed — `projectFields`'s `rawFolderPath: nullable(z.string())`
(`projects.ts:18`) accepts `""` as distinct from `null`/absent, with no trimming or minimum
length. Round 13's JS-side check (`if (!project.rawFolderPath)`) already correctly treats `""` as
"nothing to scaffold" — but the SQL fence guarding that branch's retirement UPDATE only matched
`raw_folder_path IS NULL`. A project with `raw_folder_path = ''` and an existing active claim
would see every attempt fence-fail (`changes = 0`, since the row is `''` not `NULL`), retry to
exhaustion, and throw — even though the live row never actually changed underneath it.

**Fix:** widen the absent-path branch's fence to match both representations:

```ts
if (!project.rawFolderPath) { // catches null, undefined, and "" — all mean "nothing to scaffold"
  if (!ownActive) { await setJobStatus(db, jobId, "done"); return; }
  const result = await env.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'active' AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND (raw_folder_path IS NULL OR raw_folder_path = ''))")
    .bind(now.getTime(), ownActive.id, projectId).run();
  if ((result.meta.changes ?? 0) !== 1) return retry();
  await setJobStatus(db, jobId, "done");
  return;
}
```

(The "has a path" branches are unaffected — JS's falsy check already routes any `""` value into
the branch above before those fences, which bind the exact non-empty snapshot, are ever reached.)

### 3 — `autohdrStatus` isn't reset for every project change

**Problem:** confirmed — Round 13's `setAutohdrStatus(null)` reset lives inside the SAME
eligibility-gated effect it shares with the poll, after the early-return check
(`if (!canAdminBackend || !projectId || (stageKey !== "raw_review" && stageKey !== "editing_autohdr")) return;`).
Navigating from a project with a set `autohdrStatus` to one OUTSIDE those two stages hits the
early return before ever reaching the reset — the stale value lingers in state, potentially
visible (e.g. a `delivered` project, which opens straight on the Edited tab per
`ProjectWorkspace.tsx:102`).

**Fix — split the reset into its own effect that isn't gated on polling eligibility:**

```tsx
useEffect(() => {
  setAutohdrStatus(null);
  autohdrObservedRef.current = null;
}, [projectId]);
```

This runs on every `projectId` change unconditionally; the polling effect (Round 13's version,
with finding 1's `autohdrObservedRef` correlation fix applied) keeps its own eligibility gate but
no longer needs to perform this reset itself.

---

## Round 15 — corrections from Terra's seventh pre-build review

Terra reviewed Round 14 fresh. **Verdict: APPROVED WITH CORRECTIONS** — one finding left. The
job-correlation fix, the empty-string fence, the reset-effect split, and everything previously
confirmed (scaffold mutation fencing, retry bounds/allowlists, audit action, collision handling,
migration, RPC callers, terminal/null polling semantics) all hold.

### 1 — the polling gate can pass using the PREVIOUS project's stage during navigation

**Problem:** confirmed — `data` (`ProjectWorkspace.tsx:32`) isn't cleared when `projectId`
changes; the loading effect (`:83`) fetches the new project but doesn't null out the old `data`
first. Because `await apiGet(...)` inside the poll resumes asynchronously, the polling effect can
re-run on the new `projectId`, evaluate its eligibility gate against the STILL-STALE previous
project's `stageKey` (which may happen to be `raw_review`/`editing_autohdr`), fire a status
request for the new (possibly ineligible) project, and repopulate `autohdrStatus` — racing past
the separate `[projectId]`-keyed reset effect, which isn't ordered relative to this async resumption
either.

**Fix — make the gate identity-aware, not just stage-aware:**

```tsx
useEffect(() => {
  if (!canAdminBackend || !projectId || data?.id !== projectId || (data.stageKey !== "raw_review" && data.stageKey !== "editing_autohdr")) return;
  // ...unchanged poll() body from Round 14, with the autohdrObservedRef correlation fix...
}, [canAdminBackend, data?.id, data?.stageKey, projectId, refreshJobs, refreshAssets, refreshProject]);
```

(Depend on the primitive `data?.id`/`data?.stageKey`, not the whole `data` object — Round 15's
first draft used `data` directly, but `refreshProject()` always replaces `data` with a fresh
response object of a new identity, so a terminal/blocked handoff whose project stays `raw_review`
would re-run this effect on every single poll tick regardless of whether `id`/`stageKey` actually
changed, defeating the terminal branch's own decision not to schedule another timeout.)

The separate `[projectId]` reset effect from Round 14 is unchanged and stays correct as-is.

### 2 — jobs-route `correlationId`, resolved precisely (was left for implementer confirmation in Round 14)

Terra located the exact route this pass: `GET /projects/:id/jobs` (`projects.ts:374`), whose
direct Drizzle projection (`projects.ts:378`) currently selects `id`, `kind`, `status`, `error`,
`createdAt`, `updatedAt` with no separate DTO mapper (`c.json({ jobs: rows })` returns the
selected fields directly). Add exactly:

```ts
correlationId: schema.jobs.correlationId,
```

to that projection — the backing column already exists as nullable text (`schema.ts:764`). Add
`correlationId: string | null` to the frontend `Job` type (`ProjectWorkspace.tsx:18`). The route
is already ordered newest-first (`projects.ts:381`), so Round 14's `.find(...)` correctly resolves
to the newest job matching the exact generation's correlation id.

---

This round is submitted back to Terra, fresh context, for the same pre-build approval gate —
build does not start until Terra approves (§2 policy 1).
