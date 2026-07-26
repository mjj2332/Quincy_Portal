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

One item genuinely still needs implementer confirmation, not resolved in this pass:
- The exact prop-threading path from the status hook's `autohdrStatus` state to whatever renders
  the fetch-edited button (e.g. does `ProjectWorkspace.tsx` pass button props down to a child
  component, or render the button inline) — this determines exactly where the blocked/disabled
  and "Discover & fetch" relabeling logic from earlier rounds' button-state table gets wired in.
  The orchestrating session did not read `ProjectWorkspace.tsx`'s full component tree to confirm
  this structurally.
- `publishManualUpload`'s real return shape, needed for the retry-route normalization in Fix 8b
  (assumed to still be a bare `{jobId}`, unchanged by this plan — not independently re-verified
  against live code in this pass).
