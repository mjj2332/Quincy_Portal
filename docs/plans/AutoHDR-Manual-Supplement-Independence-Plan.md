# AutoHDR Manual-Supplement Independence from FINAL/FINALS — Plan

**Status: §§1-3 APPROVED (Terra round 2) and BUILT. §4 APPROVED WITH CORRECTIONS (Terra round 3,
after 2 prior NOT APPROVED rounds on real gaps — see history below — round 3 found no further
data-loss race, confirmed the DO-alarm concurrency reasoning, confirmed the lease's scope is
proportionate to the risk, and required 2 small corrections, both applied: the release loop must
tolerate one failed release without leaking the rest, and the refresh-then-batch ordering must be
stated as a hard build/acceptance constraint).** Ready to build. §4's own history: round 1 found a
pre-acquisition race, lease theft, an insufficient fixed TTL, and a deferred error code; round 2
found refresh didn't check its own expiry, a single slow file could outlast a file-start-only
refresh, a non-lease `skipped` result wasn't treated as a page failure, and the try/finally didn't
cover acquisition.

## §4 — Addendum: close the retire-mid-batch data-loss race (added post-build)

**Provenance:** found by the round-1 diff review of §§1-3's build, in a fresh Terra context, cross-
checking against `33d56d0` ("fix: allow AutoHDR repeat sends to overlap an open delivery" —
`docs/plans/AutoHDR-Repeat-Send-Overlap-Guard-Removed.md`), a change that landed concurrently in a
separate session while §§1-3 were being built. Independently re-derived and confirmed by Sonnet 5
before writing this section — not accepted on the reviewer's word alone. §4's first design (a plain
upsert lease with a fixed 5-minute TTL) was itself reviewed and rejected: a fresh Terra pass found
it left a real pre-acquisition race (a retirement landing in the gap between the router reading
eligibility and the lease's INSERT committing would let the lease get acquired for an
already-retired mapping, giving false confidence while files still silently drop), no true mutual
exclusion (a second, unrelated acquire could overwrite the first's lease; either's release could
delete the other's), and a TTL that concrete arithmetic showed could be exceeded by staggering
alone on a large batch (250ms × ~1,200 files > 5 minutes, before any actual I/O). All three are
fixed in the design below; verified against the actual current SQL/bind order in `claims.ts`
directly, not assumed from the round-1 draft's description.

### The race, precisely

`ingestManualSupplement()` (§2) promotes a `pending_discovery` mapping to `active` on its first
manual file, then `workers/background/src/do/dropbox-sync.ts`'s `alarm()` handler (~lines 155-166)
processes any *remaining* manual files from the same Dropbox-delta page for that mapping
sequentially, each as its own independent `env.DB.batch()` call, staggered 250ms apart. Nothing
holds the mapping stable across that whole sequence.

Before `33d56d0`, a same-selection repeat send while readiness units were still "open" would have
been blocked by the basename-overlap check, which happened to make this race very hard to hit in
practice. `33d56d0` replaced that check with a narrower one (`ERR_SEND_IN_PROGRESS`, gating only on
whether the *previous round's raw-copy job* is still `queued`/`running`) — a deliberate, correct
change on its own terms, but it removes the incidental friction that used to cover this gap. Once a
mapping is `active` (including via §2's new manual promotion) and its raw-copy job is done, nothing
in `claimAutoHdrRepeatSend()` stops a repeat send from retiring it mid-batch.

If that happens between two manual files in the same page: the mapping flips to `state = 'retired'`;
the next file's asset-insert fence (`AND m.state = 'active'`, unchanged, §2) correctly refuses to
write it — but `ingestManualSupplement()` just returns `{status: "skipped"}` with a `console.warn`,
and the Dropbox-sync cursor advances past that page regardless (`dropbox-sync.ts`'s "work is durable
before the cursor commit" comment refers to *routed* work being retried on failure, not to a file
that was successfully routed but then permanently fenced out by a later, unrelated write). That
file is gone — never retried, no staff-visible record beyond a log line. A real client photo,
silently lost.

This is not solely introduced by `33d56d0` — the same class of race existed in principle for the
original, already-shipped manual-supplement plan (supplementing an *already*-active mapping while a
repeat send races in), just narrower before this plan's promotion-on-first-file behavior and
`33d56d0`'s loosened gate made it meaningfully easier to hit. Worth closing properly now rather than
treating it as pre-existing and out of scope.

### Design: a manual-ingestion lease, mirroring the existing `autohdr_fetch_claims` pattern —
with conditional acquisition, an ownership token, and mid-batch renewal

This codebase already solves an analogous problem for the FINAL/FINALS fetch path:
`claimAutoHdrRepeatSend()`'s retirement gate includes `AND NOT EXISTS (SELECT 1 FROM
autohdr_fetch_claims WHERE mapping_id = ? AND state IN ('starting','running'))` — retirement simply
refuses while a fetch claim says work is in flight. **Terra round-1 correction:** that existing
clause checks only `state`, not `autohdr_fetch_claims.lease_expires_at` — the two mechanisms are
not fully parallel, and this plan's manual lease deliberately *does* gate retirement on its own
expiry (below), which is a considered, new design choice for this table, not an assumed match to
the fetch-claims pattern's exact behavior.

Manual-supplement ingestion has no in-flight signal today because it was deliberately built without
a claim/lease mechanism (the original plan's "Option B" — no Workflow, no job row, just an inline
synchronous D1 batch per file). Add a minimal, purpose-built lease — but one with real mutual
exclusion, not just a table that happens to have one row per mapping:

**New table, `autohdr_manual_ingest_leases`** (new migration `0017`, no existing migration touched):

```sql
CREATE TABLE `autohdr_manual_ingest_leases` (
  `mapping_id` text PRIMARY KEY NOT NULL,
  `owner_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`mapping_id`) REFERENCES `autohdr_output_mappings`(`id`) ON UPDATE no action ON DELETE cascade
);
```

`owner_token` (a fresh `crypto.randomUUID()` generated at acquire time) is what makes this a real
lease rather than a shared mutable row: refresh and release are both scoped to the specific token
the caller acquired, so one invocation can never silently renew, steal, or clear a lease actually
held by a different one. Add the matching Drizzle table definition to `packages/db/src/schema.ts`
(`mappingId` as `.primaryKey().references(() => autoHdrOutputMappings.id, { onDelete: "cascade" })`,
`ownerToken` as `text().notNull()`, `leaseExpiresAt` as a `timestamp_ms` integer, plus the usual
`createdAt`/`updatedAt`).

**Acquire** — `acquireManualIngestLease(env, mappingId): Promise<string | null>` in
`manual-supplement.ts`, returning the fresh `ownerToken` on success or `null` on failure. **Terra
round-1 correction: conditional, not unconditional** — must only succeed if the mapping is
currently eligible (closes the pre-acquisition race: a retirement that already landed before this
call runs must make acquisition fail, not silently succeed for a dead mapping) *and* no other,
still-live lease is already held (true mutual exclusion — stealing is allowed only from an
*expired* lease):

```sql
INSERT INTO autohdr_manual_ingest_leases (mapping_id, owner_token, lease_expires_at, created_at, updated_at)
SELECT ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state IN ('pending_discovery', 'active'))
ON CONFLICT (mapping_id) DO UPDATE SET
  owner_token = excluded.owner_token, lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
WHERE autohdr_manual_ingest_leases.lease_expires_at <= excluded.created_at
```

Bind order: `mappingId, ownerToken, leaseExpiresAt, now, now, mappingId` (the `WHERE EXISTS`'s own
`mappingId` last). The `WHERE EXISTS` on the `SELECT` means: if the mapping isn't currently
eligible, the source rowset is empty, so there is nothing to insert *and* nothing to conflict
against — the whole statement is a genuine no-op, `changes() = 0`, with no risk of accidentally
falling through to the `ON CONFLICT` branch for an ineligible mapping. The `ON CONFLICT ... WHERE
<existing>.lease_expires_at <= excluded.created_at` means an existing *live* lease (someone else's,
not yet expired) blocks the update — `changes() = 0` — while an *expired* one is safely claimed by
the new caller. Check `changes() === 1` to determine success; on failure, return `null`.

**Refresh — Terra round-2 correction, must check its own expiry:** `refreshManualIngestLease(env,
mappingId, ownerToken, now, newExpiry): Promise<boolean>`. The round-2 draft's `WHERE mapping_id = ?
AND owner_token = ?` alone is not enough: if this exact invocation's lease already expired and
nobody else has raced in to steal it yet, the row on disk still carries *our* token, so a
token-only match would incorrectly report success and let the caller believe it still safely holds
the lease — even though retirement, checking `lease_expires_at > nowMs` independently, may already
have proceeded in the gap. Must also require the lease to still be live at refresh time:

```sql
UPDATE autohdr_manual_ingest_leases SET lease_expires_at = ?, updated_at = ?
WHERE mapping_id = ? AND owner_token = ? AND lease_expires_at > ?
```

bound `newExpiry, now, mappingId, ownerToken, now` (the trailing `now` checks the lease was still
live *before* this refresh extends it — use the same `now` value for both the update's `updated_at`
and the liveness check, not two separately-computed timestamps). Returns `changes() === 1`. A
`false` result means the caller no longer safely holds the lease (expired, possibly since stolen,
or the row is gone) and must abort — see below.

**Refresh timing — Terra round-2 correction, immediately before the write, not once at file-start:**
refreshing only once when a file's processing *begins* doesn't protect the file itself: this
codebase's own image sizes (per `docs/lessons.md`, 20-50MB raw/edited files) combined with
previously-observed Dropbox throttling mean a single file's `download()` step alone could plausibly
outlast the refresh taken before it started, leaving the actual D1 commit running under an already-
expired lease with no check immediately guarding it. Fix: call `refreshManualIngestLease()` from
*inside* `ingestManualSupplement()` itself, positioned **after `download()`/the R2 `put()` complete
and immediately before `env.DB.batch(statements)` runs** — i.e., refresh right before the moment
that actually needs protecting, not at an arbitrary earlier point whose margin depends on how long
the slow, network-bound download step took. This means `ingestManualSupplement()`'s signature gains
a required `ownerToken: string` parameter (not part of the existing optional `dependencies` bag —
this is a real required value every real caller must now supply, not a test-only override). If the
refresh fails, throw immediately, before attempting the batch — do not `return {status: "skipped"}`
for this specific case; a lease-refresh failure at this point means "we can no longer prove it's
safe to write," which must abort the whole page (below), not be treated as an ordinary, silent
per-file skip. **Build/acceptance criterion (Terra round-3 correction, stated explicitly so it
isn't silently reintroduced later):** the refresh call must run after `dependencies.beforeBatch?.()`
and be the last `await` before `env.DB.batch(statements)` — no other `await` (including a future
test hook) may be inserted between the refresh and the batch call, or the gap this section exists
to close reopens. **Every existing test in `autohdr-manual-supplement.test.ts` that calls
`ingestManualSupplement()` directly must be updated to first acquire a real lease and pass its
token** — this is a real, cascading signature change from §4, not just an internal implementation
detail; call it out explicitly during build rather than letting it surface as a surprise pile of
type errors.

**Alarm-loop handling of a non-lease `skipped` result — Terra round-2 correction:** the lease only
protects against retirement specifically. The asset-insert's own eligibility fence also covers
project archive/stage, handoff state, scaffold state, and connection — any of which could
independently change between lease acquisition and the write, causing `ingestManualSupplement()` to
correctly return `{status: "skipped"}` for a reason the lease never modeled. Rather than trying to
fold every one of those dimensions into the lease's own acquire condition, treat `{status:
"skipped"}` itself, for *any* reason, as a page failure in `dropbox-sync.ts`'s loop: if a call
returns `"skipped"`, throw (same whole-page-abort handling as a failed acquire/refresh). Do **not**
throw for `{status: "already_ingested"}` — that's a benign, successful replay, not a fenced-out
write.

**Release** — `releaseManualIngestLease(env, mappingId, ownerToken)`, token-scoped so a delayed or
duplicate release can't clear a lease a different invocation has since legitimately acquired:

```sql
DELETE FROM autohdr_manual_ingest_leases WHERE mapping_id = ? AND owner_token = ?
```

**TTL — Terra round-1 correction, refresh-based, not a single fixed window:** the round-1 draft
used one fixed 5-minute expiry set at acquire time with no renewal; concrete arithmetic in review
showed 250ms staggering alone exceeds 5 minutes past roughly 1,200 routed files, before any actual
Dropbox download / R2 write / D1 work — a real, demonstrated gap for large batches, not a
theoretical one. Fixed by refreshing before every file (above) with a per-refresh TTL of, e.g., 2
minutes (comfortably longer than one file's realistic download+write+D1 time, short enough that a
genuinely crashed/killed DO recovers within a couple of minutes rather than five). The **initial**
acquire TTL should match the same window (2 minutes) — there's no reason for the first acquire's
window to differ from every subsequent refresh's.

**`dropbox-sync.ts` wiring — whole-page abort on any lease or fence failure:**

Before the existing `for (const route of manualSupplementRouted.routes)` loop (~line 155), compute
the distinct set of `mappingId`s across `manualSupplementRouted.routes`. **Terra round-2
correction: the try/finally must wrap acquisition itself, not just the processing loop** (round-1's
draft had acquisition happen *before* the try/finally began, so a later mappingId's acquire failure
could throw without releasing an earlier mappingId's already-successful lease, leaking it until its
own TTL expiry instead of releasing immediately). Track acquired leases as they're won and release
exactly those in `finally`, regardless of where in the sequence a throw happens:

```ts
const acquired = new Map<string, string>(); // mappingId -> ownerToken
try {
  for (const mappingId of distinctMappingIds) {
    const token = await acquireManualIngestLease(env, mappingId);
    if (!token) throw new Error(`manual ingest lease unavailable for mapping ${mappingId}`);
    acquired.set(mappingId, token);
  }
  for (const route of manualSupplementRouted.routes) {
    if (workIndex++ > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const result = await ingestManualSupplement(
      env, route.projectId, route.handoffId, route.mappingId, route.connectionId, route.file,
      {}, acquired.get(route.mappingId)!,
    );
    if (result.status === "skipped") throw new Error(`manual ingest fenced out for mapping ${route.mappingId}`);
    routedProjectCount += 1;
  }
} finally {
  // Terra round-3 correction: release every acquired lease even if an earlier release rejects —
  // a plain sequential loop would stop at the first failure and leak the rest until TTL expiry.
  await Promise.allSettled(
    [...acquired].map(([mappingId, token]) => releaseManualIngestLease(env, mappingId, token)),
  );
}
```

(Illustrative — match this file's actual existing loop structure/variable names, e.g. the existing
`workIndex` staggering, when implementing; don't introduce a second, parallel loop structure.) Any
throw here — a failed acquire, a `"skipped"` ingest result, or (inside `ingestManualSupplement()`
itself, per above) a failed pre-commit refresh — propagates up through `alarm()`, leaving
`CURSOR_KEY` uncommitted for the entire page, so the next alarm tick retries it. This is
deliberately simple rather than building per-mapping partial-page retry tracking:
`ingestManualSupplement()`'s existing idempotency (the `asset_ingest_identities` unique-index
dedup, already relied on for retries today) makes safely reprocessing the *entire* page on retry —
including files that already succeeded, which come back as the benign `{status: "already_ingested"}`
— a correct, if slightly redundant, fallback, and this codebase already accepts that tradeoff
elsewhere. On the retry, the router re-evaluates eligibility fresh; a mapping that's now genuinely
retired for good (a real repeat-send moved the round on) simply stops matching and its remaining
manual files are no longer routed — an intentional, non-silent outcome once paired with the pinned
error code below, not a silent loss.

Do **not** acquire/release inside `ingestManualSupplement()` itself (its lifetime must span the
whole per-mapping batch, decided in `dropbox-sync.ts`) — but it **does** call
`refreshManualIngestLease()` internally, per above, immediately before its own D1 batch.

**Retirement guard** — add one clause to `claimAutoHdrRepeatSend()`'s existing single-statement
retirement gate. **Terra round-1 correction — exact current SQL and bind order, verified directly
against `claims.ts` (not assumed):** the statement currently has 14 placeholders, bound as `nowMs,
nowMs, mappingId, active.id, active.id, projectId, projectId, mappingId, active.id,
associationCountAtCheck, active.id, sentFilesCountAtCheck, mappingId, active.id`. Insert the new
clause immediately after the existing `AND NOT EXISTS (SELECT 1 FROM autohdr_fetch_claims WHERE
mapping_id = ? AND state IN ('starting','running'))` clause (the 8th placeholder) and before `AND
(SELECT COUNT(*) FROM autohdr_final_associations ...)`:

```sql
AND NOT EXISTS (SELECT 1 FROM autohdr_manual_ingest_leases WHERE mapping_id = ? AND lease_expires_at > ?)
```

giving the corrected 16-value bind order: `nowMs, nowMs, mappingId, active.id, active.id, projectId,
projectId, mappingId, mappingId, nowMs, active.id, associationCountAtCheck, active.id,
sentFilesCountAtCheck, mappingId, active.id` — the new clause's own `mappingId, nowMs` inserted
right after the fetch-claims clause's `mappingId`, everything after it shifted by two positions.
Write this out explicitly in the actual code and let typecheck/tests catch any mismatch — don't
trust this description's count over the real file at implementation time.

**Error code — Terra round-1 correction, pinned now, not deferred to build time:** the existing
post-batch fallback (`claims.ts`, after `results[0]?.meta.changes !== 1`) currently checks only for
an active fetch claim before falling back to a generic `ERR_HANDOFF_BLOCKED`, "The current AutoHDR
round changed while the repeat send was starting; try again" — not false, but it hides the
actionable cause for this new one. Add a new `ERR_MANUAL_INGEST_IN_PROGRESS` to `AutoHdrErrorCode`
(`errors.ts`) and check for an unexpired manual lease in that same fallback branch, alongside the
existing fetch-claim check, before falling through to the generic message. The existing
`POST /api/projects/:id/send-to-autohdr` route already forwards arbitrary AutoHDR error codes as
`{ error, code }` on a 409 — no route or frontend change needed.

### Known, accepted residual scope (state explicitly, don't discover it in review again)

- Deleting a project or mapping while a manual-ingest lease is held is not specially handled beyond
  the table's own `ON DELETE CASCADE` (the lease row simply disappears with its parent). This
  mirrors a pre-existing gap in the project-delete path generally (nothing today specially
  coordinates project deletion against an in-flight manual ingest either) — not worsened by this
  change, not fixed by it either.

### Testing (§4, in addition to §§1-3's existing test list)

- Acquire/release round-trip: acquiring a lease for a mapping, then attempting retirement, fails;
  releasing it (with the correct token), then retirement succeeds.
- **Pre-acquisition race (the round-1 gap):** retire a mapping, *then* attempt to acquire a lease
  for it — acquisition must fail (`null`), not silently succeed.
- **True mutual exclusion:** acquire a lease with token A; a second acquire attempt for the same
  still-live lease must fail; a *release* using a different/wrong token must not delete the real
  lease.
- **Refresh and expiry:** a refresh with the correct token succeeds and extends the lease; a refresh
  after the lease has *already expired* (even with the correct token, and with nobody else having
  re-acquired it yet) fails — the round-2 gap. An expired, never-refreshed lease does **not** block
  retirement (crash-recovery case).
- **Refresh happens at commit time, not file-start:** a test simulating a slow `download()` (e.g. a
  mock that delays past the lease's expiry before resolving) followed by an attempted commit must
  fail closed (the pre-commit refresh catches it), not succeed on stale lease state from before the
  delay.
- **Non-lease `skipped` still aborts the page:** simulate the asset-insert's own fence rejecting a
  file for an unrelated reason (e.g. project archived mid-batch) while the lease itself is still
  perfectly live — confirm the alarm-level loop still throws rather than silently continuing past a
  `{status: "skipped"}` result.
- **The actual regression this section exists to fix, end to end:** simulate the exact race —
  acquire a lease (standing in for "a manual batch is mid-flight"), attempt
  `claimAutoHdrHandoff({ startNewRound: true, ... })`, confirm it's refused with
  `ERR_MANUAL_INGEST_IN_PROGRESS`; release the lease, confirm a subsequent repeat send succeeds.
- Confirm the lease is genuinely per-mapping: a lease held for mapping A does not block retirement
  of an unrelated mapping B.
- An alarm-level test (not just direct `ingestManualSupplement()`/`claimAutoHdrHandoff()` unit
  tests) proving the lease genuinely spans every manual route for a mapping in one page and is
  released only after that mapping's whole grouped batch completes — and that a mid-batch acquire
  failure for one mapping still releases an already-acquired lease for a different mapping in the
  same page (the round-2 try/finally-scope gap).
- Update every existing direct call to `ingestManualSupplement()` in
  `autohdr-manual-supplement.test.ts` to acquire a real lease first and pass its token — the
  signature change is required, not optional (per the "Refresh timing" correction above).

## Provenance

Drafted by Sonnet 5 (this session) per `docs/Subagent-Orchestration.md` §2 policy 1.
User-triggered: a real production case on `6/120 Beach Street`
(`914714cd-d608-43e1-8582-528d8faa9228`) — AutoHDR was sent RAW photos for this project's first
round (generation 1, handoff `0f13cb33-a650-477e-91e8-63d7e6189f10`), but has never delivered
anything into either `04-FINAL-Photos` or `04-FINALS-Photos`, over 24 hours later. The mapping
(`6ef4f1f1-ac5d-465f-aa94-0437f31d8d43`) is stuck at `state = 'pending_discovery'`. The user placed
4 test images directly into `04-MANUAL-Photos` hoping Quincy Portal would pick them up as this
round's delivery — confirmed against live prod D1 that it did not, and could not, by design.

## Why this doesn't work today (confirmed by direct code read, not assumed)

`AutoHDR-Manual-Supplement-Fetch-Plan.md` (built and shipped earlier this session) added
`routeAutoHdrManualSupplementDelta()` / `ingestManualSupplement()` specifically so `04-MANUAL-Photos`
can supplement an AutoHDR delivery that's already arrived. That plan's round-3 review explicitly
scoped this to `mapping.state = 'active'` only, reasoning "a mapping still pending discovery has no
confirmed canonical path yet, which is irrelevant to this router" — a deliberate, reviewed decision,
not an oversight. Two independent gates enforce it today:

- `routeAutoHdrManualSupplementDelta()` (`workers/background/src/autohdr/routers.ts:127-163`) —
  the router itself only matches a project whose mapping `state = 'active'`
  (`routers.ts:160`), so a `pending_discovery` mapping's project is never even passed to the ingest
  function.
- `ingestManualSupplement()`'s write-time SQL fence (`workers/background/src/autohdr/
  manual-supplement.ts:114-134`) independently re-checks `m.state = 'active'`
  (`manual-supplement.ts:130`) — this codebase's established "statement-level eligibility fence"
  pattern, so even a caller bypassing the router would still be blocked at write time.

That design assumed AutoHDR's automated delivery would always arrive eventually; `04-MANUAL-Photos`
was purely a supplement on top of it. `6/120 Beach Street` is the case that assumption didn't cover:
AutoHDR never delivers at all, and there is currently no way to make `04-MANUAL-Photos` be the
*entire* delivery for a round that's never been discovered.

## Goal

Let `04-MANUAL-Photos` ingest files for a project's active handoff **regardless of whether the
mapping has already been discovered via FINAL/FINALS**. The first manual file for a
`pending_discovery` mapping promotes it to `active`, using the manual folder itself as the
mapping's canonical delivered path — exactly what FINAL/FINALS discovery already does for its own
candidate paths (`workers/background/src/autohdr/mapping.ts:117-135`, `routeAutoHdrDelta()`'s own
`pending_discovery` → `active` promotion), just triggered from the other router instead.

## What does *not* change

- `finals.ts` / `writeAutoHdrFinal()` — untouched. This plan follows the same "Option B, don't
  touch the hardened fence" choice the original manual-supplement plan made, for the same reason:
  smaller, independently-reviewable blast radius.
- `routeAutoHdrDelta()`'s own `pending_discovery` → `active` promotion for FINAL/FINALS — unchanged.
  **Terra round-1 correction — this safety claim only holds for `editing_autohdr`, stated
  precisely rather than as a blanket guarantee:** `routeAutoHdrDelta()` filters to
  `projects.stageKey = 'editing_autohdr'` exactly (`mapping.ts:96-103`) — it never examines a
  project sitting in `edited_review` at all, manually-promoted or not. So: for a project still in
  `editing_autohdr` when FINAL/FINALS later delivers after a manual promotion, the existing "both
  candidates observed" collision path (`mapping.ts:145-149`, blocking the mapping because
  `mappingState.finalPathKey !== winner.claim.pathKey`) does fire, confirmed by direct read of the
  actual condition — a human decides how to reconcile two sources of truth, nothing silently merges
  or is silently dropped. For a project already moved to `edited_review`, there is **no** automatic
  collision detection if FINAL/FINALS arrives afterward — this is pre-existing behavior (identical
  today for an *automatically*-promoted `edited_review` mapping, not something this plan introduces
  or worsens), but it means a manual promotion in `edited_review` is effectively final with no
  built-in reconciliation path if AutoHDR's automated delivery shows up later. Worth stating
  explicitly rather than implying full parity with the `editing_autohdr` case.
- `routeAutoHdrManualDropDelta()` / `routeImplicitFolders()` (the *implicit*, zero-handoff-only
  manual detection path) — untouched, unrelated; that path is for projects with no handoff at all.
- No new columns, no new table, no migration. Promotion reuses the mapping's existing `state`,
  `final_path`, `final_path_key`, `folder_id`, `observed_at`, `diagnostic` columns — the same ones
  `routeAutoHdrDelta()`'s own promotion already writes.

## Design

### 1. Router: `routeAutoHdrManualSupplementDelta()` (`routers.ts:127-163`)

Change the mapping-state predicate at `routers.ts:160` from `eq(autoHdrOutputMappings.state,
"active")` to `inArray(autoHdrOutputMappings.state, ["pending_discovery", "active"])`. No other
predicate changes — still requires `handoff.state = 'started'`, project `stageKey IN
('editing_autohdr', 'edited_review')`, scaffold `state = 'active'`, connection match, not archived.
A `blocked` handoff or `blocked_collision` mapping stays excluded (neither `pending_discovery` nor
`active` matches those states, so no change needed there).

### 2. Ingest: `ingestManualSupplement()` (`manual-supplement.ts:97-216`)

**D1 batch visibility — resolved, confirmed two independent ways:** Cloudflare's own D1 docs state
`batch()` statements execute sequentially, non-concurrently, as one SQL transaction, so a later
statement sees an earlier one's writes (and the whole batch rolls back only on a thrown error).
Independently reproduced directly against this repo's real `cloudflare:test` D1 harness this
session: a throwaway test proved a later statement's `EXISTS` subquery does observe an UPDATE from
an earlier statement in the same `env.DB.batch()` call (not just a `changes()` counter). Treat this
as settled; no further verification needed.

Add one new statement to the existing `env.DB.batch(statements)` call, **as the first statement in
the array**:

```sql
UPDATE autohdr_output_mappings
SET state = 'active', final_path = ?, final_path_key = ?, folder_id = NULL,
    observed_at = ?, diagnostic = NULL, updated_at = ?
WHERE id = ?
  AND state = 'pending_discovery'
  AND EXISTS (
    SELECT 1 FROM projects p
    JOIN autohdr_handoffs h ON h.project_id = p.id
    JOIN autohdr_output_mappings m ON m.handoff_id = h.id AND m.project_id = p.id
    JOIN autohdr_scaffold_claims s ON s.project_id = p.id
    WHERE p.id = ? AND p.archived_at IS NULL AND p.stage_key IN ('editing_autohdr', 'edited_review')
    AND h.id = ? AND h.connection_id = ? AND h.state = 'started'
    AND m.id = ? AND m.connection_id = ?
    AND s.connection_id = ? AND s.state = 'active' AND s.scaffold_path_key = ?
    AND ? = s.scaffold_path_key || '/04-manual-photos'
  )
```

**Terra round-1 correction:** the original draft's `EXISTS` subquery checked for *some* valid
project+handoff+scaffold combination without relationally tying it to the specific mapping row
being updated (`WHERE id = ?` alone) — weaker than the asset-insert's own fence, which explicitly
joins `autohdr_output_mappings` and checks `m.id = ?` / `m.connection_id = ?`. Fixed above by
joining `autohdr_output_mappings m` in the subquery and checking `m.id = ?` and `m.connection_id =
?`, mirroring the asset-insert fence exactly so a misrouted/stale `mappingId` can't promote the
wrong row.

Bind order, precisely (13 placeholders, in position):
`finalPath, finalPathKey, now, now, mappingId, projectId, handoffId, connectionId, mappingId,
connectionId, connectionId, scaffoldPathKey, manualFolderKey` — 13 values (the repeated
`connectionId` and `mappingId`/`manualFolderKey` are each bound once per occurrence in the SQL
above; count placeholders against bound values 1:1 when implementing, don't assume the count from
this description — write it out explicitly and let the build's own typecheck/test step catch a
mismatch). `final_path` = the **display-cased** parent directory:
`sourcePath.slice(0, sourcePath.lastIndexOf("/"))` (where `sourcePath` is the same
`file.path_display ?? file.path_lower` value already computed a few lines above for the asset
row) — not a re-derivation of `sourcePathParent()`'s lowercased key. `final_path_key` reuses the
already-computed `manualFolderKey` (the lowercased form) directly.

This statement is intentionally **not** gated on the current file being new/not-a-duplicate — the
mere existence of an eligible manual file proves manual delivery has begun for this round,
regardless of whether this particular delta scan is a first-sighting or a re-scan of something
already ingested. It's naturally idempotent: once `state` is no longer `'pending_discovery'`, the
`WHERE` clause matches zero rows and no-ops.

**Leave the existing asset-insert statement's fence condition itself exactly as-is**
(`manual-supplement.ts:118`, `AND m.state = 'active'` — do not relax it). Because the promotion
statement runs first in the same batch, the asset-insert's own `EXISTS` check will see the
just-promoted `'active'` state on a mapping's first manual file, and the already-`'active'` state
on every subsequent one.

**Terra round-1 correction — required change, not optional:** promotion becoming the new first
statement shifts the asset-insert to `result[1]`, but the existing result-handling code
(`manual-supplement.ts:188`, `if ((result[0]?.meta.changes ?? 0) === 0)`) still reads `result[0]`
— which, for the common case of an *already-active* mapping, is now the promotion statement's
result (correctly `changes: 0`, since it no-ops), not the asset-insert's. Unfixed, this makes the
function treat every already-active-mapping supplement (i.e. almost all of them, after the first)
as `{status: "skipped"}` and never call `enqueueRenditionSafely` — a real regression of already-
shipped behavior. **Fix:** update the index to `result[1]`, with an inline comment stating why
(promotion is index 0, asset-insert is index 1), and add a dedicated test asserting
`enqueueRenditionSafely` is still called for a supplement to an already-`active` mapping (locking
in the fix, not just the new pending_discovery path).

### 3. Downstream effects to confirm, not just assume

- `claimAutoHdrHandoff()`'s `mappingState === 'pending_discovery'` guard
  (`claims.ts`, the exact one `6/120 Beach Street` hit) — once promoted via manual, a later
  repeat-send attempt for this project will pass this check (mapping is `'active'`) and proceed
  into `claimAutoHdrRepeatSend()` normally. Confirm this is the actually-desired outcome (it should
  be — the whole point is "manual delivery counts as delivery").
- `claimAutoHdrRepeatSend()`'s own top guard (`!["active", "blocked_collision"].includes(active.mappingState)`)
  — same conclusion, already satisfied once promoted.
- Known, pre-existing, **out of scope** limitation (inherited from the original manual-supplement
  plan, not introduced or worsened by this change): `ingestManualSupplement()` does not create
  `autohdr_final_associations` rows, so assets delivered only via manual supplement never close
  their readiness units. A later repeat-send whose selection overlaps those units will still hit
  `ERR_SELECTION_OVERLAPS_OPEN_DELIVERY` regardless of this plan. Not fixing that here — flagging
  it so it isn't mistaken for a regression this change introduced.

## Testing

- Router test: a `04-MANUAL-Photos` file for a project with `mapping.state = 'pending_discovery'`
  (handoff started, stage eligible) is now matched and routed; still excluded when `blocked`/
  `blocked_collision`, and still excluded when stage or handoff state is wrong (existing coverage
  should mostly carry over, extend for the new state).
- Ingest test: first manual file for a `pending_discovery` mapping promotes it to `active` with
  `final_path`/`final_path_key` pointing at the manual folder, and the asset is created in the same
  call. A second manual file afterward creates its asset without re-promoting (statement no-ops,
  no error).
- **Result-index regression test (required, per Terra round-1 finding):** a manual supplement to
  an *already-`active`* mapping (the common case) still returns `{status: "created", ...}` and
  still calls `enqueueRenditionSafely` — proving the `result[1]` fix, not just the new
  `pending_discovery` path. This is the single most important test in this plan; without it, the
  most common case (supplementing an already-active mapping) silently regresses.
- Collision test: after manual promotion, simulate a FINAL/FINALS delivery arriving for the same
  mapping (`routeAutoHdrDelta()`) — confirm it hits the existing "both candidates observed"
  collision block rather than silently overwriting or being silently ignored.
- Regression test: existing manual-supplement tests for an already-`active` mapping must still
  pass unmodified (promotion statement no-ops; asset-insert fence unchanged).
