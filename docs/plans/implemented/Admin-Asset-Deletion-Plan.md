# Admin Asset (Image) Deletion — Plan

**Status: BUILT, verified, committed (`9e51878`), and DEPLOYED to production (2026-07-29 —
background then app, per the documented deploy order).** Terra-approved after 10 plan-review
rounds — most spent narrowing, then finally closing, a cross-plan race with Dropbox sync by
reusing `raw_reconciliation_claims` as a continuously-renewed lease rather than a point-in-time
check — plus 3 diff-review rounds after building, which caught a cross-Worker source import that
would have bundled `workers/background`'s module graph into `workers/app` (moved the shared lease
constant into `packages/db` instead), a self-blocking bug in bulk-deleting multiple Dropbox-sourced
assets (fixed with a bounded retry against a sibling claim), a lightbox-closes-before-confirming-
success UI bug, and a bulk-delete bug that silently reported a real per-item failure as success.
489 tests passing across every workspace.

**User request** (2026-07-29): allow admins to permanently delete individual images from a
project.

**Confirmed with the user, across three rounds of clarification:**
1. **Permanent, hard delete** — not soft/restorable.
2. **Single and bulk** — a per-image action, plus a bulk action reusing the multi-select UI.
3. **Every asset kind** — RAW, edited, video, floorplan, copy. Requires two frontend surfaces
   (`PhotoGrid.tsx` for RAW/edited, `CollectionPanel.tsx` for video/floorplan/copy).
4. **Dropbox-sourced originals are also deleted from Dropbox itself**, not just from Quincy
   Portal — otherwise the next sync re-imports the file.
5. **Floorplans delete as a pair** — one PDF + one paired preview image, deleted together.

**"Delete as a pair," precisely** (round 7 asked this be stated unambiguously, not just implied):
if a floorplan version's PDF **and** preview both currently exist, deleting either one deletes
both, atomically, via the all-or-none guarded batch in § 1 — there is no path to delete only one
half of an *existing* pair. If a version is already an incomplete legacy pair (its preview was
lost or never created, a pre-existing, real state this schema already tolerates — `CollectionPanel.
tsx`'s own `isLegacyIncomplete` flag exists for it), deleting the surviving half is a single-asset
delete, not a partial deletion of a pair that still exists — this is a different case, not a
loophole in the pair guarantee.

**Not in this plan**: a related but distinct bug the user separately raised — Dropbox sync
silently drops a re-uploaded file when a photographer deletes and re-uploads under the same
filename. See `docs/plans/Dropbox-Deletion-Reconciliation-Plan.md` (Terra-approved, 2026-07-29).

**The two plans share one real race, closed with a real, renewable mutual-exclusion lease.** Eight
review rounds across both plans converged on this. `packages/db/src/schema.ts:566-582`'s
`raw_reconciliation_claims` table is a per-project mutual-exclusion lease already used by
`workers/background/src/dropbox/sync.ts:128-168`'s `syncProjectRawFolder`. This plan's Dropbox-
touching path acquires the same claim under a new `trigger` value, held and **continuously
renewed** for the full duration of its operation — round 7 found the previous revision's renewal
still had gaps (a single renewal before R2 traversal doesn't cover a traversal that itself runs
long; the renewal's own result wasn't checked; claim-loss wasn't distinguishable from an ordinary
Dropbox error) — all fixed below, by renewing on every R2 page/batch and every Dropbox poll
iteration, checking every renewal result, and surfacing claim loss as its own distinct outcome.

## Current state (verified by direct research across eight rounds, not assumed)

**No per-asset delete mechanism exists today.** The only precedent is whole-**project** deletion
(`workers/app/src/routes/projects.ts:598`) — this plan follows its shape where it transfers (the
`activeJobs` precondition, kept as a cheap general courtesy check) and diverges where it doesn't
(ordering, and the real per-project claim the project-delete route itself never acquired — exactly
the gap `docs/lessons.md:140` documents it hit in production once already).

### Schema / FK landmines

`assets` (`packages/db/src/schema.ts:299-358`) has no `deletedAt`. Confirmed FKs to `assets.id`:

| Table | `onDelete` |
|---|---|
| `asset_renditions`, `selections`, `autohdr_sent_files`, `asset_ingest_identities`, `autohdr_final_associations`, `asset_review_state`, `annotations`, `publishes` | cascade (all 8, safe) |
| `edited_source_claims.currentAssetId` | **restrict** |
| `premium_unlocks.assetId` | `ON DELETE no action` — blocks like `restrict` |

**Non-FK pointers with no DB-level protection**: `assets.supersedesAssetId`/`replacedByAssetId`,
`assets.sourceRawAssetId` (`Lightbox` degrades gracefully), `projects.coverAssetId`,
`document_uploads.pdfAssetId`/`previewAssetId`, `rendition_dlq_events.assetId`.

**`document_uploads`** — `responseFor()` builds its response entirely from cached columns, no
live join; worst case a stale cached id 404s on a later media fetch. No code change here.

**`rendition_dlq_events`** — small fix in scope: extend `admin.ts:164-201`'s DLQ replay guard to
verify the asset still exists before enqueueing, returning 409 instead of a doomed job.

### R2 key structure

Renditions are always `renditions/${assetId}/...`. This plan deletes by the exact, already-stored
`assets.r2Key`, plus the `renditions/${assetId}/` prefix walk. Annotation R2 objects are retained.

### Shared infrastructure — two small, in-scope exports needed

Round 7 found the previous draft's code snippets referenced two things that don't currently exist
as importable symbols. Both are small, mechanical additions, not new design:

1. **`RAW_CLAIM_LEASE_MS`** (`workers/background/src/dropbox/sync.ts:27`) is currently a private,
   unexported `const`. **This plan exports it** (`export const RAW_CLAIM_LEASE_MS = 15 * 60_000;`)
   so both this plan's route and its own reuse of the value stay in sync with sync.ts's actual
   lease duration, rather than a second, driftable copy of the same number.
2. **A unique-constraint detector for this specific claim table**, matching the precision of this
   codebase's existing examples (`workers/app/src/routes/collections.ts:105-108`'s
   `uniqueVersionError`, `workers/app/src/lib/ingest.ts:68`'s identity-conflict check — both match
   a specific constraint, not a blanket "any UNIQUE violation"). **Round 8 review corrected the
   match target**: SQLite/D1 reports a unique-constraint violation by its indexed **table.column**,
   not the index's own name — `UNIQUE constraint failed: raw_reconciliation_claims.project_id`,
   not `...raw_reconciliation_claims_active_unique`. Matching the index name (the previous draft's
   mistake) would never match a real error, silently rethrow instead of returning 409, and turn
   every ordinary "sync is already active" case into an unhandled 500:
   ```ts
   function isRawClaimConflict(error: unknown): boolean {
     for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
       if (/UNIQUE constraint failed:\s*raw_reconciliation_claims\.project_id/i.test(cause.message)) return true;
     }
     return false;
   }
   ```
   (Mirrors `sync.ts:150-155`'s own cause-chain walk exactly, just scoped to this table's specific
   column rather than any `UNIQUE constraint failed` message, since a raw insert into this table
   could in principle fail for an unrelated constraint too.)

### Dropbox deletion — RPC contract, and the claim mechanism, with real continuous renewal

`workers/background/src/dropbox/client.ts:666-684` implements `deleteBatch()`/
`deleteBatchCheck()`. Both RAW sync and AutoHDR "finals" assets use `source: "dropbox"` (confirmed
round 6/7) with complete path metadata on the normal claimed-path flow; legacy AutoHDR rows without
that metadata are covered by the existing null-guard skip (§ "Called only when..." below), not
excluded by kind.

**Claim acquisition, sequencing already fixed (round 6) and unchanged this round**: sibling
discovery happens before claim acquisition; the claim is acquired once the full deletion-target set
is known, if **any** target satisfies `source === "dropbox" && sourcePath !== null && sourcePathKey
!== null`.

```ts
const needsClaim = targets.some((t) => t.source === "dropbox" && t.sourcePath !== null && t.sourcePathKey !== null);
let claimId: string | null = null;
let deleteJobId: string | null = null;
if (needsClaim) {
  deleteJobId = await createJob(db, { kind: "asset_delete", projectId, correlationId: `asset_delete:${primaryAssetId}` });
  claimId = crypto.randomUUID();
  const now = new Date();
  await db.update(schema.rawReconciliationClaims).set({ state: "failed", updatedAt: now })
    .where(and(eq(schema.rawReconciliationClaims.projectId, projectId), eq(schema.rawReconciliationClaims.state, "running"), sql`${schema.rawReconciliationClaims.leaseExpiresAt} < ${now.getTime()}`));
  try {
    await db.insert(schema.rawReconciliationClaims).values({
      id: claimId, projectId, ownerJobId: deleteJobId, state: "running",
      leaseExpiresAt: new Date(now.getTime() + RAW_CLAIM_LEASE_MS),
      trigger: "asset_delete", createdAt: now, updatedAt: now,
    });
  } catch (error) {
    if (!isRawClaimConflict(error)) throw error;
    await db.update(schema.jobs).set({ status: "failed", error: "Dropbox sync claim unavailable", updatedAt: new Date() }).where(eq(schema.jobs.id, deleteJobId));
    return c.json({ error: "Dropbox sync is active for this project — wait for it to finish and try again." }, 409);
  }
}
```

**The `try`/`finally` shape — job status now tracks actual outcome, round 7's finding 5, timing
corrected in round 8.** The previous draft always marked the job `done` in `finally`. Round 8
found the fix itself was still wrong in two ways: `succeeded = true` appeared right after a
comment placeholder rather than after the real last step, and — since a Dropbox failure is
*returned as data* (`{ outcome: "failed" }`), not thrown — a bare `succeeded = true` reached at the
end of the `try` block would mark the job `done` even when the Dropbox deletion explicitly failed.
**Fixed**: `succeeded` is set only after every step has run, and only if **every** Dropbox outcome
(when any claim was needed at all) was one of the two genuinely successful outcomes — **round 9
found the prior fix still wrong**: overwriting a single `dropboxOutcome` variable each iteration
meant only the *last* asset's result was checked, so a request touching several Dropbox-sourced
assets in one batch (e.g. bulk delete resolving to more than one Dropbox-sourced target) could have
an earlier one fail and a later one succeed, and still be marked `done` — the failure would be
silently dropped from the success computation. **Fixed properly**: collect every outcome, and
require all of them to be successful, not just the most recent one:
```ts
let succeeded = false;
try {
  // ...guarded D1 delete batch, R2 deletion (with per-batch renewal)...
  const dropboxOutcomes: ("removed" | "alreadyGone" | "claimLost" | "failed")[] = [];
  for (const asset of dropboxSourcedDeletedAssets) {
    const result = await env.BACKGROUND.deleteDropboxSourceFile(asset.sourcePath!, claimId!, deleteJobId!);
    dropboxOutcomes.push(result.outcome);
    if (result.outcome === "claimLost") break; // stop attempting further Dropbox calls for this request
  }
  const lastDropboxOutcome = dropboxOutcomes.at(-1) ?? null; // kept separately, for the response only — not the success computation
  succeeded = dropboxOutcomes.every((outcome) => outcome === "removed" || outcome === "alreadyGone");
} finally {
  if (claimId && deleteJobId) {
    await db.update(schema.rawReconciliationClaims).set({ state: "done", updatedAt: new Date() })
      .where(and(eq(schema.rawReconciliationClaims.id, claimId), eq(schema.rawReconciliationClaims.ownerJobId, deleteJobId), eq(schema.rawReconciliationClaims.state, "running")));
    await db.update(schema.jobs).set({ status: succeeded ? "done" : "failed", updatedAt: new Date() }).where(eq(schema.jobs.id, deleteJobId));
  }
}
```
(A floorplan pair can have at most one Dropbox-sourced member in practice — RAW/AutoHDR-finals
kinds don't pair with a preview the way floorplan PDFs do — so "last outcome" is not actually
ambiguous across a pair; this loop shape is written generally only because bulk delete can still
process several independent Dropbox-sourced assets, each with its own claim, in the same request.)
The claim itself is always released as `done` regardless of outcome (it's not an error state for
the *lease* — the operation finished attempting its work, one way or the other, and the claim's
only job is to have kept sync out during that attempt); the *job* row's status reflects whether the
attempt actually succeeded, matching normal job-lifecycle semantics elsewhere in this codebase. An
ordinary Dropbox `"failed"` outcome and a `"claimLost"` outcome are both treated as not-succeeded
for the job's status — only the two outcomes that mean "the file is actually gone from Dropbox"
count as success.

**Renewal — genuinely continuous over every step that can run long, tightened again in round 8.**
The previous draft renewed on every `MEDIA.list()` page but round 8 found two remaining gaps: the
actual `MEDIA.delete()` calls (`projects.ts:621`'s equivalent batching pattern — deletes happen in
their own loop, separate from the listing loop that discovers keys) weren't covered by a renewal
check of their own, and the Dropbox RPC only renewed *inside* the poll loop — if `deleteBatch()`
completes synchronously (no `async_job_id`, the common case for a single small delete), the poll
loop never runs at all and the claim is never renewed during the RPC call. **Fixed**: renewal now
covers every external call that can take meaningful time, checked immediately before each one:
```ts
// R2 key discovery — renew before every list page:
for (const prefix of r2Prefixes) {
  let cursor: string | undefined;
  while (true) {
    if (claimId && deleteJobId && !await env.BACKGROUND.renewDropboxDeletionClaim(claimId, deleteJobId)) {
      return c.json({ ok: false, error: "Dropbox sync claim was lost during cleanup — retry the delete", outcome: "claimLost" }, 409);
    }
    const page = await env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
}
// R2 deletion — renew before every delete batch, a separate loop from discovery above,
// mirroring projects.ts:621's own batching shape:
for (let index = 0; index < keys.length; index += 1000) {
  if (claimId && deleteJobId && !await env.BACKGROUND.renewDropboxDeletionClaim(claimId, deleteJobId)) {
    return c.json({ ok: false, error: "Dropbox sync claim was lost during cleanup — retry the delete", outcome: "claimLost" }, 409);
  }
  await env.MEDIA.delete(keys.slice(index, index + 1000));
}
```
(The D1 delete and audit have already committed by this point — a claim-lost abort here still
leaves R2 partially cleaned up, the same accepted "orphaned storage over broken live reference"
tradeoff as the rest of this plan, not a new failure mode.)

**Dropbox poll-loop renewal, and a genuinely distinct claim-lost outcome — round 7's finding 3.**
The previous draft's return type folded a lost-claim result into the same `{ outcome: "failed",
reason: string }` shape as an ordinary Dropbox API failure, and the route only exposed a free-text
`dropboxReason` — not a reliable discriminant a caller (or a test) could branch on. **Fixed**: a
distinct `outcome: "claimLost"` variant, threaded through to the route's response:
```ts
// workers/background/src/index.ts — QuincyBackground
async renewDropboxDeletionClaim(claimId: string, ownerJobId: string): Promise<boolean> {
  return renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId);
}

async deleteDropboxSourceFile(path: string, claimId: string, ownerJobId: string): Promise<
  | { outcome: "removed" }
  | { outcome: "alreadyGone" }
  | { outcome: "claimLost" }
  | { outcome: "failed"; reason: string }
> {
  const DELETE_BATCH_MAX_POLLS = 45; // matches workflows/autohdr.ts's COPY_BATCH_MAX_POLLS
  const db = dbFor(this.env);
  try {
    // Round 8: renew before the initial call too, not only inside the poll loop — if Dropbox
    // completes synchronously (no async_job_id), the poll loop below never runs at all, and the
    // claim would otherwise never be renewed during this RPC call regardless of how long the
    // single deleteBatch() request itself takes.
    if (!await renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId)) return { outcome: "claimLost" };
    let result: DropboxDeleteBatchResult | DropboxDeleteBatchCheckResult = await deleteBatch(this.env, db, [{ path }]);
    let asyncJobId = result[".tag"] === "async_job_id" ? result.async_job_id : null;
    for (let poll = 1; asyncJobId && poll <= DELETE_BATCH_MAX_POLLS; poll += 1) {
      if (!await renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId)) return { outcome: "claimLost" };
      result = await deleteBatchCheck(this.env, db, asyncJobId);
      if (result[".tag"] !== "in_progress") asyncJobId = null;
    }
    if (asyncJobId) return { outcome: "failed", reason: `did not complete after ${DELETE_BATCH_MAX_POLLS} checks` };
    if (result[".tag"] === "failed") return { outcome: "failed", reason: "Dropbox delete_batch failed" };
    if (result[".tag"] === "complete") {
      const entry = result.entries[0];
      if (entry?.[".tag"] === "success") return { outcome: "removed" };
      if (entry?.[".tag"] === "failure" && isDropboxPathNotFound(entry.failure)) return { outcome: "alreadyGone" };
      return { outcome: "failed", reason: "Dropbox delete_batch entry failed" };
    }
    return { outcome: "failed", reason: "unexpected Dropbox response shape" };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
```
The route's response type gains a matching discriminant (`dropboxOutcome: "removed" |
"alreadyGone" | "claimLost" | "failed"`, alongside the existing `dropboxDeleted`/`dropboxReason`)
so callers and tests can distinguish "Dropbox said no" from "we lost the lease mid-operation,
someone else may now be writing this path" — operationally a much more important distinction than
a shared free-text reason would communicate.

Both RPC methods declared on `rpc-types.ts` alongside the existing surface.

**Called only when `asset.source === "dropbox" && asset.sourcePath != null && asset.sourcePathKey
!= null`** — nullable legacy fields skip the Dropbox call, claim acquisition, and all renewal
machinery entirely.

### Frontend — two surfaces

**`PhotoGrid.tsx`**: `multi: Set<string>` selection state is private to this component.

**`CollectionPanel.tsx`**: version-history entries need restructuring into a wrapper with the `<a>`
as a sibling of a new delete `<button>`, not nested inside it.

**Delete gating**: `canDeleteAssets = can("adminBackend")`, distinct from `canManageCollections`,
passed as a distinct `canDelete` prop to both components. The API's `adminBackend` middleware is
the authoritative defense; this is defense-in-depth.

**`ProjectWorkspace.tsx`**: the lightbox-open-asset state is `openAssetId`. The bulk-delete flow's
post-batch refresh calls each need their own `.catch()` swallowing only `AbortError`, attached to
`refreshAssets()` and `refreshProject()` individually, not wrapped broadly around a combined
`Promise.all(...)`.

### Testing precedent

`workers/app/test/api.test.ts:1310-1509` (the project-delete suite) is the direct template.

## Design

### 1. API — new file `workers/app/src/routes/assets.ts`

**Capability check**: `requireCapability("adminBackend")`, path-scoped middleware.

**Route wiring**: add the import and `.route("/", assetsRoutes)` to `workers/app/src/index.ts`.

**Steps, in order**:

1. Load the asset (404 if missing): id, `collectionId`, `kind`, `r2Key`, `source`, `sourcePath`,
   `sourcePathKey`, `versionGroupId`, `version`, and `projectId` via the collection.
2. **General active-job courtesy check** — cheap early UX signal, not the correctness mechanism.
3. **If `kind` is `floorplan_pdf` or `floorplan_preview` and `versionGroupId` is set**: look up the
   paired sibling. If found, both delete together (all-or-none, § "Delete as a pair," precisely,
   above); if not found, the primary alone is a single-asset delete against an already-incomplete
   legacy pair, not a partial deletion of an existing one.
4. **Claim acquisition** (above), only if any resolved target is Dropbox-sourced with both path
   fields present.
5. **One atomic D1 batch, single combined `DELETE`** covering both ids at once when a pair:
   ```sql
   DELETE FROM assets
   WHERE id IN (?, ?)
     AND (SELECT count(*) FROM assets WHERE id IN (?, ?)) = ?  -- 2 for a pair, 1 for a single asset
     AND NOT EXISTS (SELECT 1 FROM premium_unlocks WHERE asset_id IN (?, ?) AND scope = 'asset')
     AND NOT EXISTS (SELECT 1 FROM edited_source_claims WHERE current_asset_id IN (?, ?))
   ```
   Genuinely all-or-none, including a sibling disappearing between lookup and batch (the
   `count(*)` check). Confirmed against SQLite/D1 semantics (verified against documentation and
   empirically): an uncorrelated subquery in a `DELETE`'s `WHERE` clause evaluates once, against
   the table's state as of the start of the statement.
   - **Audit log**, same batch, immediately following, gated `WHERE changes() > 0`.
   - **Pointer-nulling**, each gated `NOT EXISTS (SELECT 1 FROM assets WHERE id IN (?, ?))`.
   - **Collection count reconciliation**: `COLLECTION_RECEIVED_COUNT_SQL`, unconditional, always
     correct; a harmless `updated_at` bump is the only side effect when blocked.
   - `results[0].meta.changes === 0` → blocked or missing; re-`SELECT` to distinguish 404 from
     409 — stop here, R2/Dropbox untouched, claim released via `finally`.
6. **R2 deletion**: exact `r2Key` per deleted asset, plus `renditions/${assetId}/` prefix walk,
   paginated at 1000 keys per `MEDIA.delete()`, **renewing the claim on every page iteration if one
   was acquired** (above), aborting cleanly with a `claimLost` response if renewal ever fails.
7. **Dropbox deletion**, for each deleted Dropbox-sourced asset with both path fields present:
   `env.BACKGROUND.deleteDropboxSourceFile(sourcePath, claimId, deleteJobId)` — self-renewing on
   every poll iteration, returning a distinct `claimLost` outcome if renewal fails mid-poll. An
   ordinary Dropbox failure surfaces as `dropboxDeleted: false, dropboxOutcome: "failed"` without
   rolling back the committed D1/R2 work; `claimLost` is surfaced distinctly for operator attention
   since it signals the race window was actually approached, not just a transient API error.
8. **`finally`**: release the claim (`done`) and finalize the job (`done` on success, `failed`
   otherwise — above). Return `{ ok: true, deletedAssetIds: string[], deletedObjects: number,
   dropboxDeleted: boolean, dropboxOutcome?: "removed" | "alreadyGone" | "claimLost" | "failed",
   dropboxReason?: string }`.

**Bulk delete**: one `DELETE /api/assets/:id` per selected asset from the frontend. Each
Dropbox-sourced asset in a batch independently acquires/renews/releases its own claim.

### 2. `workers/background` — RPC methods

`deleteDropboxSourceFile` (claim-aware, self-renewing, distinct `claimLost` outcome) and
`renewDropboxDeletionClaim`, on `QuincyBackground`, both declared on `rpc-types.ts`.

### 3. Frontend

- **`PhotoGrid.tsx`**: `canDelete: boolean` prop, single-tile delete button, `onBulkDelete:
  (assetIds: string[]) => Promise<{ succeededIds: string[]; failedIds: string[] }>` for bulk —
  `ProjectWorkspace`'s implementation runs individual `DELETE`s via `Promise.allSettled` with no
  refresh inside the loop, then calls `refreshAssets()` and `refreshProject()` once each, each
  independently wrapped in its own `AbortError`-swallowing `.catch()`.
- **`CollectionPanel.tsx`**: delete action per version-history entry, gated on `canDelete`.
- **`ProjectWorkspace.tsx`**: `deleteAsset`/`deleteAssets`; closes the lightbox first if the
  deleted asset (or sibling) matches `openAssetId`.

### 4. What is explicitly *not* changing

- Whole-project deletion — untouched (documented opportunity to adopt the same claim pattern
  later, per `lessons.md:140`'s identical documented gap there).
- The "retain forever" R2 policy for annotation objects — untouched.
- No new capability. No schema change — reuses `raw_reconciliation_claims`/`jobs` as-is, plus
  exporting one existing constant.
- `document_uploads` rows — untouched. General Dropbox-deletion reconciliation — its own plan.

## Testing requirements for the build

1. Successful delete, each asset kind: exact R2 keys removed, cascading D1 rows gone, annotations
   retained, `collections.receivedCount` correct, response shape matches.
2. Floorplan pair, all-or-none: both guards pass → both delete; either blocked → neither deletes,
   409 names the blocker; sibling disappears mid-flight → the `count(*)` check catches it.
   **Distinct from**: a version whose pair was *already* incomplete before the request (no live
   sibling at lookup time) — deleting the surviving half succeeds as a single-asset delete, and
   this must be tested as its own case explicitly distinguished from the all-or-none guarantee,
   per round 7's clarity finding — not evidence the guarantee has a bypass.
3. Sibling isolation, adapted to asset scope.
4. Capability: non-admin 403; `manageExtras`-only editor also 403'd at the API layer.
5. `edited_source_claims`/`premium_unlocks` guards: 409, untouched; clears then succeeds.
6. **Claim acquisition and renewal — the core mechanism**:
   - Active unexpired claim → Dropbox-sourced delete refused 409 before any mutation; the
     just-created `jobs` row is left `failed`, not `queued`.
   - True concurrency with an explicit deterministic barrier/latch (not two sequential calls) —
     both orderings, exactly one proceeds, the other backs off cleanly.
   - **Continuous renewal actually covers a long R2 traversal**: seed an asset with enough
     rendition keys to require multiple `MEDIA.list()` pages (or mock the pagination), use a short
     test lease, and assert renewal fires on every page — not just once upfront — keeping the
     claim alive through the whole traversal. This is the test that would have caught round 7's
     blocking finding.
   - **Renewal loss during R2 traversal** stops further R2/Dropbox work and returns the
     `claimLost` response distinctly.
   - **Renewal loss during the Dropbox poll loop** returns `{ outcome: "claimLost" }` from the RPC,
     distinct from `{ outcome: "failed", reason }` — assert callers/tests can actually branch on
     this discriminant, not just a free-text reason string.
   - The claim is always released `done`; the job is `done` only on actual success, `failed`
     otherwise (including on `claimLost`) — assert this distinction, not just "job is terminal."
   - A floorplan pair where only the *sibling* is Dropbox-sourced still triggers claim acquisition.
   - A non-Dropbox-sourced delete never attempts claim acquisition.
7. A Dropbox-sourced asset with `sourcePathKey === null` skips the Dropbox call and claim
   acquisition entirely.
8. Race test on the guarded-delete's own `NOT EXISTS` conditions: confirm 409 not a false success.
9. Audit-transaction test: force the audit insert to fail — asset deletion also does not commit.
10. Guard-blocked batch leaves derived state untouched: pointer-nulling did not fire;
    `collections.receivedCount` remains numerically correct either way.
11. Rendition DLQ replay guard: 409 for a since-deleted asset; unaffected for a live one.
12. Stale frontend state: `PhotoGrid` prunes `multi` after single delete; bulk delete correctly
    prunes even when a later unrelated caller aborts its own post-batch refresh, while a genuine
    non-abort failure from either refresh call still surfaces; open-in-`Lightbox` asset closes it.
13. `CollectionPanel` markup: valid restructured markup, correct single-version targeting,
    `canDelete` gated separately from `canManage`.
14. Confirmation dialogs: single and bulk, count-inclusive copy, declining leaves everything
    untouched.

## Rollout

Deploy order matters (**background → webhook-ingress → app**):

1. `workers/background`: export `RAW_CLAIM_LEASE_MS` from `sync.ts`; `deleteDropboxSourceFile`
   (claim-aware, distinct `claimLost` outcome) and `renewDropboxDeletionClaim` RPC methods, plus
   `rpc-types.ts` declarations.
2. `workers/app`: new `assets.ts` route file (claim acquisition/continuous renewal/release,
   `isRawClaimConflict` helper), its registration in `index.ts`, and the small `admin.ts`
   DLQ-replay guard.
3. `apps/web`: `PhotoGrid.tsx`, `CollectionPanel.tsx`, `ProjectWorkspace.tsx`.
4. Deploy **background first, then app** — no `webhook-ingress` change, no migration.

## Routing (per Subagent-Orchestration.md §2 routing table)

A genuinely destructive, admin-gated operation spanning D1 (atomic pair-delete, transactional
audit, a real continuously-renewed cross-process mutual-exclusion claim), R2, a cross-worker RPC
surface with async polling and per-iteration lease renewal, and two frontend surfaces with a real
refresh-ordering fix — **large cross-system change**: Terra plan review (loop until approved) →
Terra build, max effort → Terra diff review, fresh context, max effort → §5 gate → (once the user
authorizes) commit and deploy, background before app.
