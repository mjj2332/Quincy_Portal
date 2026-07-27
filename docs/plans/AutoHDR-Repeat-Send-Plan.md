# AutoHDR Repeat Send — Plan

**Status: FULLY APPROVED — §§1-6 at Terra round 8, §7 (deselected-asset removal) at its own round 4.**
§7 was a post-approval addition: round 1 found the removal criteria itself unsafe (fixed with a new
`autohdr_sent_files` provenance table, the one schema addition in this whole plan); rounds 2-3 (both
APPROVED WITH CORRECTIONS) found precision gaps, most notably in round 3 a genuine race where the
retiring generation's own still-in-flight send could write content after cleanup already ran —
closed with the same dual-fence pattern (retirement-side + writer-side) already established in §4/
§5. Planning only — nothing in this document has been implemented yet.

## Provenance

Drafted by Sonnet 5 (this session) per `docs/Subagent-Orchestration.md` §2 policy 1. User-triggered:
a real production report — on `225-227 Victoria Road`, the user selected 12 RAW images and clicked
"Send to autoHDR." The images never showed up in the project's AutoHDR Dropbox folder. This turned
out to be the hardest plan of the session: 8 Terra review rounds, most rejecting real correctness
gaps in D1-batch atomicity, cross-generation collision risk, and previously-hardened `claims.ts`
code — not just precision polish. Round 1 found the core silent-failure bug and the
non-partial-unique-index architectural constraint; rounds 2-3 found the `raw_review`-only stage
gate and the quarantine/filename-collision risks the naive design would have introduced; rounds 4-6
repeatedly found the D1 `changes()`-chaining mechanism was subtly wrong (partial retirement,
un-atomic reactivation, a missing job insert, a wrong compensating-batch shape); round 7 caught a
real regression this plan would have introduced in the existing stuck-job retry mechanism. Read the
document in full for the reasoning behind each — the corrections are left inline throughout as
`**Terra round-N correction:**` annotations, matching this repo's established plan-review style.

## What's actually happening (confirmed against live prod D1 and direct code read, not guessed)

`225-227 Victoria Road` (`979a46dd-999f-4ef7-b523-fb0bb383f41f`) has exactly **one** row in
`autohdr_handoffs`, `state: "started"`, created 2026-07-26 from the project's original "Send to
autoHDR" click. `audit_log` shows **three** `project.send_to_autohdr` entries for this project —
including two from the user's just-now attempt — but all three carry the **identical**
`jobId: "5134aace-166f-4829-aea0-4d8e14d40334"`, the job from the *original* 2026-07-26 send. No
new job, handoff, or workflow instance was ever created for the 12 newly-selected images.

**Root cause**, confirmed by direct read of `claimAutoHdrHandoff()`
(`workers/background/src/autohdr/claims.ts:85-89`):

```ts
const active = await db.select({ id, jobId, workflowId }).from(autoHdrHandoffs)
  .where(and(eq(autoHdrHandoffs.projectId, projectId), inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"])))
  .get();
if (active) return { handoffId: active.id, jobId: active.jobId, workflowId: active.workflowId, reused: true };
```

If a handoff already exists for the project in any of `starting`/`started`/`blocked`, this
function returns immediately with that **existing** handoff's identifiers — every line below it,
which reads the *current* `selected_for_editing` set, computes a selection hash, and inserts a new
handoff row, never runs. `startAutoHdr()` (`workers/background/src/index.ts:75-115`) then sees
`handoff.state === "started"` and returns `{ ok: true, jobId: owner.jobId, ... }` — a **real
success response**, carrying the *stale* job id, for a click that changed nothing. The route
(`workers/app/src/routes/projects.ts:297-320`) writes an honest-looking audit entry and the
frontend (`ProjectWorkspace.tsx:251`) shows a normal `"Sent to autoHDR (5134aace…)."` toast. Nothing
in the response distinguishes "your click did real work" from "your click did nothing and here's
an old job id."

**This is not a narrow race condition — it's permanent, for every project, after its first send.**
Grepping every place in the codebase that ever changes `autohdr_handoffs.state` (or
`autohdr_output_mappings.state`, or `autohdr_path_claims.state`) turns up exactly one non-collision
path that ever moves a handoff to a terminal state: the project **archive** flow
(`workers/app/src/routes/projects.ts:496-511`), which retires the mapping, tombstones the path
claims, and retires the handoff — but only as a side effect of archiving the entire project.
There is no other way, today, for a handoff to leave `started`. That means: **once a project has
completed one successful "Send to autoHDR," the button silently stops doing anything for that
project, forever** — this will affect every project that needs a second editing round, not just
this one.

## The real architectural obstacle (found by reading the schema, not assumed)

The obvious-looking fix — just stop returning the stale handoff early, and let a second call fall
through to insert a fresh handoff/mapping/path-claims for a new generation — **cannot work as a
drop-in change**, because of a hard constraint discovered in `packages/db/src/schema.ts:481-500`:

```ts
uniqueIndex("autohdr_path_claims_connection_path_unique").on(t.connectionId, t.pathKey),
```

This index has **no partial `WHERE` clause** — unlike, say, `autohdr_handoffs_active_project_unique`
(`schema.ts:426-427`, scoped to non-terminal states only). It permanently reserves a given Dropbox
path to whichever `autohdr_path_claims` row claims it first, **even after that row is tombstoned**
— the table's own doc-comment confirms this is deliberate: *"Permanent connection-scoped
ownership. Rows are tombstoned, never deleted on archive."* And the candidate paths themselves
(`autoHdrFinalPathCandidates()`, `workers/background/src/autohdr/paths.ts:34-36`) are derived
purely from the project's immutable `rawFolderPath` — **identical** for every generation of the
same project. So a naive "just claim a new generation" attempt would try to `INSERT` a new
`autohdr_path_claims` row at the exact same `(connection_id, path_key)` the first generation
already owns, and D1 would reject it with a unique-constraint violation.

**This constraint already has a working precedent for exactly this situation**, confirmed by direct
read: `claimImplicitAutoHdrHandoff()` (`claims.ts:355-380`) and `claimBackfillAutoHdrHandoff()`
(`claims.ts:410-449`) both handle re-claiming a path whose existing `autohdr_path_claims` row
belongs to the *same* project and is currently `tombstone`/`blocked` — by **reactivating** that
row (`UPDATE ... SET state = 'active', handoff_id = ?, mapping_id = ?`) instead of inserting a new
one. A genuinely different project's claim on that path, or a claim not in a reactivatable state,
is correctly rejected as a real collision. This is the pattern to reuse, not reinvent.

## Proposed design

### 1. What "sending more" actually means, and the trade-off to make explicit

**Terra round-1 correction — the original §1 understated this risk; it is not merely
misattribution.** Retiring generation N's mapping/handoff has two distinct, more serious
consequences, both confirmed by direct read of `writeAutoHdrFinal()`:

- **An already-in-flight fetch for generation N is quarantined, not merely misattributed.**
  `writeAutoHdrFinal()`'s fence (`finals.ts:135-139`) rejects the write outright whenever
  `mappingState !== 'active'` or `handoffState !== 'started'` — both true the instant generation N
  is retired. A fetch claim that was already `starting`/`running` for generation N when retirement
  happens lands in `quarantine()` (`finals.ts:186-191`): **no asset is created, no rendition is
  queued** — the file does not silently attribute to the wrong generation, it silently produces
  nothing, with no existing operator path in this codebase to un-quarantine and retry it. This is a
  real, if narrow, data-loss risk, not just a bookkeeping one.
- **A later, genuinely new delivery can filename-collide with a still-open generation-N+1
  readiness unit and overwrite a correct asset.** `credibleCoverage()` matches purely by filename
  basename (`finals.ts:70-83`) against whichever handoff a fetch is currently framed against — it
  has no generation-provenance awareness. If the same RAW asset (or two assets whose delivered
  filenames coincide) is selected again in a later generation while an unrelated, late generation-N
  delivery for that same name is still able to arrive, `writeAutoHdrFinal()`'s replace branch
  (`finals.ts:144-145` onward) can supersede a currently-correct edited asset with an unrelated
  late file. This is a real correctness risk, not just an attribution nicety.

Both risks are eliminated by construction with two required preconditions (§2), rather than
disclosed-and-accepted as originally drafted:

Given that framing, two designs are worth naming for the outer UX layer (once the preconditions in
§2 make retirement actually safe to perform):

- **Automatic retirement**, firing the moment "Send to autoHDR" is clicked again with a changed
  selection. Zero extra clicks, matches the button's literal label ("Send N selected to autoHDR")
  with no added friction. Risk: a studio member could retire a round that's still genuinely
  delivering, without realizing it, and the mis-attribution above happens silently.
- **Explicit confirmation**, matching this codebase's own established pattern for consequential,
  state-changing actions — `window.confirm()` is already used for exactly this class of decision in
  `EditProject.tsx` (archive/restore/delete), `Admin.tsx` (deactivate user), and `Lightbox.tsx`
  (delete comment/annotation). A short, honest confirm message ("Any autoHDR output for the
  previous round that hasn't arrived yet will be attributed to the new round instead. Continue?")
  puts the real, disclosed trade-off in front of the person taking the action, at the cost of one
  extra click on the (comparatively rare) case where a second send is actually needed.

**Recommendation: explicit confirmation.** It costs one click, it matches an established codebase
convention rather than introducing a new one. **Terra round-1 correction:** the confirm copy must
change to match the corrected risk in §1 — not "attributed to the new round instead" (implies a
harmless bookkeeping quirk) but something closer to "Any autoHDR output for the previous round
that's still being delivered may be lost. Wait until it's finished before starting a new round." —
because §2 below makes this the actual, disclosed, narrow residual risk once its own required
preconditions are in place. Coverage-based automatic gating (retire only once every readiness unit
has a matched delivery) was considered and rejected as the *sole* gate: `225-227 Victoria Road`'s
own `stage_key` is still `editing_autohdr` despite multiple successful `fetch_edited` jobs, meaning
its generation-1 coverage was never fully satisfied by the credibleCoverage-matching heuristic (a
real filename-matching gap, out of scope here) — a gate that *required* full coverage before
allowing a repeat send would never have unblocked the very project that reported this bug. Coverage
is instead used below only as an input to the *overlap* precondition, not as a blocking gate on its
own.

### 2. Two required preconditions before retirement is allowed

**Terra round-2 correction — a pre-check alone is not enough; both preconditions must be embedded
directly in the retirement batch's own guards, not just checked beforehand.** A precheck-then-batch
structure races with `claimAutoHdrFetch()` (`claims.ts:703-746`, which has no fence today against
the mapping/handoff it's claiming against being mid-retirement): a fetch claim can be inserted after
the precheck passes but before the batch commits, or the retirement batch itself can commit while a
fetch is concurrently starting. §4 below folds both preconditions into the **first** statement of
the retirement batch — the same statement, evaluated atomically at commit time, not a separate
earlier read:

- **No in-flight fetch for the current generation's mapping.** The retirement batch's first
  statement (§4, mapping retirement) must itself require
  `NOT EXISTS (SELECT 1 FROM autohdr_fetch_claims WHERE mapping_id = ? AND state IN ('starting', 'running'))`
  as part of its own `WHERE` clause — not a fact checked and trusted from moments earlier. This
  closes the quarantine risk from §1 for the retirement side. It does **not**, by itself, close the
  race from the other direction — see §4's note on `claimAutoHdrFetch()`.
- **No basename overlap between the new selection and the current generation's still-open
  readiness units.** **Terra round-2 correction — asset-ID overlap alone is insufficient**; §1's
  actual risk is *coincidental filename collision* between two *different* RAW assets across
  generations, which asset-ID equality can't catch. The check must compare **normalized basenames**
  (reusing `plainBasename()`/`strippedBasename()` from `finals.ts:49-54` — the exact functions
  `credibleCoverage()` itself uses, so the overlap check and the actual matching behavior it's
  guarding against use identical normalization — **Terra round-7 correction:** both are currently
  unexported, module-private functions in `finals.ts`; they need an `export` keyword added so
  `claims.ts` can import them directly, rather than being duplicated or reimplemented) between the
  new selection's RAW assets and the
  current generation's still-open readiness units. "Still open" means no row exists in
  `autohdr_final_associations` for `(handoff_id = <current handoff>, readiness_unit_key = <that
  unit>)` — **Terra round-2 correction:** `autohdr_final_associations` has no direct
  mapping/generation column (`schema.ts:589-603`); it's keyed by `handoff_id` and
  `readiness_unit_key`, joined against the current handoff's own `readiness_units_json`, not a
  generation number. If any normalized basename in the new selection matches any normalized
  basename among the current generation's still-open readiness-unit RAW assets, refuse. If the
  studio genuinely wants to resend a specific problem shot, this is a reasonable, disclosed limit for
  this round: they must wait for that asset's original delivery (or its absence) to resolve first.
  This closes the misattribution/overwrite risk from §1.

**A `pending_discovery` mapping is not eligible for `startNewRound` at all — not "closed by
precondition," excluded up front.** **Terra round-2 correction — the original round-2 draft's §4
step-1 fence (`mapping.state === 'active'`) accidentally excluded this case while also failing to
name it as a deliberate restriction.** A `started` handoff can still have a `pending_discovery`
mapping (`schema.ts:456-477`) — meaning AutoHDR hasn't delivered *anything* yet and the system
doesn't even know which of `04-FINAL-Photos`/`04-FINALS-Photos` will actually be used. Retiring an
undiscovered generation is uniquely dangerous: routing (`routeAutoHdrDelta`) has no coverage
awareness at all, only the write-time fence does, so a delivery that arrives for generation N after
its still-`pending` candidate claims are reactivated under generation N+1 would be silently and
completely attributed to N+1 with no trace of ever belonging to N — worse than the quarantine or
overwrite risks above, and not fixable by either precondition (neither one has anything to check
yet, since nothing has been discovered). **This round's answer: don't allow it.** `startNewRound` is
refused with a clear message ("autoHDR hasn't delivered anything for this project yet; wait for the
first result before starting a new round") whenever the current mapping is `pending_discovery`.

**Terra round-6 correction — a `blocked_collision` mapping is not *always* eligible, and the
original claim that it "necessarily already been through discovery" is false.**
`claimImplicitAutoHdrHandoff()`'s own collision-compensation path (`claims.ts:187-193`) can create a
`blocked_collision` mapping with **zero** path claims at all, for the unrelated implicit-detection
collision case — not every `blocked_collision` mapping came from the explicit-send discovery flow
this plan is built around. The real eligibility test is not the mapping's bare `state` value — it's
whether §4 step 1's own `COUNT(*) ... state IN ('active','pending','blocked')) = 2` guard passes,
which correctly and automatically refuses this zero-claim case (confirmed by Terra's round-6 review
tracing this exact scenario). No separate up-front eligibility check is needed for this specific
case beyond what step 1 already enforces; a `blocked_collision` mapping lacking two tombstonable
claims surfaces via the same generic step-1 refusal every other guard failure does, not a distinct
friendlier message — a reasonable limit given how rare this specific cross-feature combination is
(an implicit-detection collision on a project this plan's explicit repeat-send flow later touches).

**A `blocked` handoff must never be treated as idempotent-success** regardless of selection-hash
comparison (see §3) — it always requires the confirm-and-retry path, since it needs staff
resolution independent of what the user is currently selecting. The same policy applies to an
implicit handoff (`initiated_by IS NULL`) if one is ever encountered here — matching
`startAutoHdr()`'s own existing `ERR_HANDOFF_BLOCKED` handling for that case
(`workers/background/src/index.ts:101-107`), never silently reused as if it were an explicit one.

### 3. Backend: one endpoint, three outcomes for an active handoff

No new route. `POST /projects/:id/send-to-autohdr` gains one new optional body field,
`startNewRound?: boolean` (default `false`).

`claimAutoHdrHandoff()`'s active-handoff branch (`claims.ts:85-89`) must compute the **current**
`selected_for_editing` set's selection hash the same way the fresh-claim path already does
(`claims.ts:113-128`'s existing hashing logic, reused rather than duplicated) and branch:

- **Handoff is `starting`/`started` and selection hash matches**: genuine idempotent re-click. Keep
  today's behavior exactly — return the existing handoff/job as `reused: true`, `ok: true`. This is
  the one case where the current early-return is actually correct, not a bug.
- **Handoff is `blocked`, or `initiated_by IS NULL`, OR handoff is `starting`/`started` and selection
  hash differs, and `startNewRound` is not set**: **Terra round-4 correction — these all return the
  *same* `ERR_HANDOFF_ALREADY_ACTIVE` code, not different codes for the blocked/implicit case versus
  the changed-selection case.** Round 3's draft only described the changed-selection case using this
  code and left blocked/implicit handoffs without a defined response shape, which would have left
  §6's frontend branch unable to trigger confirmation for them at all. One code, one frontend branch
  (§6), covering every case that requires `startNewRound` to proceed — the route maps it to a real,
  non-2xx response the frontend can distinguish from a real failure and use to prompt confirmation,
  **not** a 200 with a stale job id. (The confirm copy can still vary — e.g. mentioning that a
  blocked handoff may also need separate staff resolution — but the *code* driving whether to prompt
  at all is the same in every case.)
- **`startNewRound: true`**: check §2's two preconditions first (return their own distinct,
  non-2xx outcomes if either fails); if both pass, perform the retire-and-reclaim batch below.

**Terra round-7 correction — a third mode is required, or this plan silently regresses the existing
job-retry mechanism.** `POST /jobs/:id/retry` (`projects.ts:467-484`) calls
`c.env.BACKGROUND.startAutoHdr(job.projectId, user.id)` directly — with no `startNewRound` and no
way to pass one — whenever staff retry a `stuck`/`failed` `autohdr`-kind job. Today, retrying a
handoff still in `starting`/`blocked` state simply reuses it regardless of the current selection
(the existing, unmodified active-handoff early-return). Without a fix, this plan's new
selection-hash comparison would treat *any* selection drift since the original failed attempt —
plausible for a long-stuck job — as "selection changed," return `ERR_HANDOFF_ALREADY_ACTIVE`, and
the retry route has no `startNewRound` to send back: **retrying a stuck/failed autoHDR job would
break** whenever the selection had changed in the meantime. **Fix**: `startAutoHdr()` gains a third,
distinct mode — `resumeExisting?: boolean` — set only by the retry route, that skips the
selection-hash comparison entirely and resumes the existing `starting`/`blocked` handoff/job as-is,
matching today's actual retry behavior byte-for-byte. This is orthogonal to `startNewRound`: normal
sends never set it; the retry route always does, and never sets `startNewRound`. The RPC signature
(`workers/background/src/rpc-types.ts:9`,
`abstract startAutoHdr(projectId: string, initiatedBy?: string): Promise<AutoHdrResult>;`) needs a
third parameter to carry this — an options object (`{ startNewRound?: boolean; resumeExisting?:
boolean }`) is cleaner than two more positional booleans, but the exact shape is a build-round
detail.

### 4. Retire-and-reclaim: stage-aware, one mandatory atomic batch, reusing established patterns

**Terra round-1 correction — this cannot reuse `claimAutoHdrHandoff()`'s fresh-claim logic
verbatim.** That logic hard-requires `project.stageKey === 'raw_review'`
(`claims.ts:96` and the `WHERE ... stage_key = 'raw_review'` fence at `claims.ts:149`) — but a
project with an active handoff is in `editing_autohdr` (confirmed via
`workflows/autohdr.ts:114-126`'s own stage-confirmation check requiring `editing_autohdr`, not
`raw_review`, at confirm time), and nothing moves it back to `raw_review` afterward. The
repeat-send reclaim must be its **own** batch.

**Terra round-2 correction — `edited_review` cannot complete a repeat send without an explicit
stage transition, and the fix must stay contained to this new batch, not spread into
`confirmAutoHdrHandoff()`/the Workflow.** Confirmed by direct read: `confirmAutoHdrHandoff()`'s own
handoff-state `UPDATE` (`claims.ts:70`) requires
`EXISTS (SELECT 1 FROM projects WHERE id = ? AND stage_key = 'editing_autohdr' ...)` — an *exact*
match, and the Workflow throws if that confirm doesn't succeed
(`workflows/autohdr.ts:122-126`). If the project is at `edited_review` when `startNewRound` fires
(generation N's own coverage already advanced it), confirm would fail and the whole send would
break. Rather than touching that hardened confirm/Workflow code, the retire-and-reclaim batch itself
must force `stage_key = 'editing_autohdr'` (transitioning back from `edited_review` if that's the
current state) as one of its own statements — so by the time the Workflow's existing, *unmodified*
confirm step runs, its exact-match guard is already satisfied. `claimAutoHdrHandoff()`'s own fresh
claim never needs this because it starts from `raw_review` and lets the Workflow do that specific
transition; a repeat send starts from a stage the Workflow's confirm doesn't transition *into*, so
this batch must do it directly.

**A `pending_discovery` mapping is excluded entirely** (§2) — this batch only ever runs against a
mapping in `active` or `blocked_collision`.

**Terra round-3 correction — the round-2 design was still not atomic, for two distinct reasons, and
the basename-overlap/stage checks were still application-level prechecks, not commit-time fences.**
Fixed as follows.

**The atomicity fix: one statement is the single authoritative gate; everything else chains via
`changes()` off it specifically, not off re-derived table state.** D1 batch statements execute
sequentially within one transaction on the same connection — this is *why* the established
`WHERE ... AND changes() = 1` chaining idiom (already used throughout `finals.ts` and
`manual-supplement.ts`) works at all: each statement can see the immediately-preceding statement's
row-count via SQLite's connection-level `changes()`. Round 2's mistake was splitting the safety
precondition across multiple statements independently (so one could pass while another failed,
leaving a real partial retirement) and, separately, re-deriving "did retirement happen" via
`EXISTS (... state = 'retired')` — which round 2's own review correctly notes can't distinguish
*this batch* retiring something from it having *already* been retired earlier. The fix: **step 1 is
the one statement carrying every precondition** (mapping state, handoff state via subquery, project
archived/stage, fetch-claim absence, and — see below — the basename-overlap and stage-transition
freshness checks), and **every subsequent statement chains via `changes() = 1` off the statement
immediately before it**, not via independent state re-checks — so a failure anywhere in the chain
propagates as a cascade of zero-row no-ops, and success anywhere in the chain is provably
attributable to *this* batch, not a stale echo of an earlier one.

**The basename-overlap and stage-eligibility checks become commit-time, via an optimistic-concurrency
count, not new SQL string-normalization logic.** Re-implementing `plainBasename`/`strippedBasename`'s
regex normalization in raw SQL would risk silently diverging from `finals.ts`'s actual behavior over
time — two independent implementations of "the same" logic drifting apart is worse than the gap
being fixed. Instead: immediately before building the batch, capture
`associationCountAtCheck = COUNT(*) FROM autohdr_final_associations WHERE handoff_id = <handoffId>`
as part of the *same* JS read that determines readiness-unit openness and basename overlap (§2).
Step 1's `WHERE` clause then includes
`AND (SELECT COUNT(*) FROM autohdr_final_associations WHERE handoff_id = <handoffId>) = <associationCountAtCheck>`
— an optimistic-concurrency check matching this codebase's own established idiom (`manifestVersion`/
`selectionHash` pinning elsewhere in `finals.ts`/`claims.ts`): if *any* new delivery lands for this
handoff between the JS-level overlap computation and the batch's commit — which would mean a
readiness unit the check thought was open just closed, exactly the race that could otherwise let a
stale overlap decision through — the count changes, step 1's guard fails, and the whole chain
cascades to a clean no-op. The stage check moves into step 1 too (see below), closing the same class
of gap Terra found for the `raw_review`/`blocked_collision` case.

One batch, in order:

1. **The gate.** Retire the current mapping (`state = 'retired', retired_at = ?`):
   ```
   UPDATE autohdr_output_mappings SET state = 'retired', retired_at = ?, updated_at = ?
   WHERE id = <mappingId> AND handoff_id = <handoffId> AND state IN ('active', 'blocked_collision')
     AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = <handoffId> AND project_id = <projectId> AND state IN ('starting','started','blocked'))
     AND EXISTS (SELECT 1 FROM projects WHERE id = <projectId> AND archived_at IS NULL AND stage_key IN ('editing_autohdr','edited_review'))
     AND NOT EXISTS (SELECT 1 FROM autohdr_fetch_claims WHERE mapping_id = <mappingId> AND state IN ('starting','running'))
     AND (SELECT COUNT(*) FROM autohdr_final_associations WHERE handoff_id = <handoffId>) = <associationCountAtCheck>
     AND (SELECT COUNT(*) FROM autohdr_path_claims WHERE mapping_id = <mappingId> AND state IN ('active','pending','blocked')) = 2
   ```
   **Terra round-5 correction — the last line is new.** Without it, steps 1–2 could still retire the
   mapping/handoff even when the current generation's path claims aren't both in a tombstonable
   state (an anomalous pre-existing condition), leaving the project with **no** active handoff at
   all once step 3 predictably under-tombstones and everything downstream cascades to a no-op. This
   count check, evaluated as part of the single authoritative gate, prevents *any* retirement from
   starting unless both candidates are confirmed retirable in the same atomic check.
2. Retire the current handoff, chained off step 1: `WHERE id = <handoffId> AND state IN
   ('starting','started','blocked') AND changes() = 1`.
3. Tombstone the current generation's path claims, chained off step 2: `WHERE mapping_id =
   <mappingId> AND state IN ('active','pending','blocked') AND changes() = 1`. Given step 1's new
   count guard, this is now expected to affect exactly 2 rows whenever the chain is intact — the
   *next* statement still chains off `changes() = 2` specifically, now backed by a real guarantee
   rather than a hopeful expectation.
4. Insert the new job, chained off step 3 via `changes() = 2`: `INSERT INTO jobs (...) SELECT ?,
   'autohdr', 'queued', ?, <projectId>, ?, 0, ?, ? WHERE changes() = 2`.
5. Insert the new handoff at `generation = prior + 1`, `state = 'starting'`, with the new job's id —
   chained off step 4 (`changes() = 1`), requiring `stage_key IN ('editing_autohdr',
   'edited_review')` (not `raw_review`), with the freshly-computed selection hash/readiness units
   for the *current* selection.
6. Insert the new mapping (`pending_discovery`), chained off step 5 (`changes() = 1`).
7. **Terra round-5 correction — steps 8/9/10 below no longer rely on `changes()`-adjacency at all,
   because they branch into multiple statements after step 6 and `changes()` only ever reflects the
   single statement immediately before the current one.** Round 5's draft placed the stage/audit
   pair between step 6 and per-candidate reactivation, so reactivation's `changes()` check silently
   saw the stage statement's (often-zero) result instead of step 6's — for an already-`editing_autohdr`
   project, both reactivations would have been skipped, the single most common case. **The fix**:
   every statement after step 6 that needs to know "did the mandatory chain through step 6 succeed"
   uses `EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = <the freshly-minted new mapping
   id>)` instead of `changes()`. This is a *safe* re-derivation-by-state, unlike the round-3 mistake
   Terra caught with the old handoff's `state = 'retired'` check: the new mapping's id is a UUID
   minted fresh by *this* operation, so its mere existence can only be explained by step 6 of *this*
   batch having run — there is no "predates the batch" ambiguity for a row that didn't exist before
   the batch started. Steps 8, 9, and 10 below are independent of each other and of statement order
   from this point on; each carries this same `EXISTS` check on its own.
8. Stage transition + its paired audit row: 8a: `UPDATE projects SET stage_key = 'editing_autohdr',
   updated_at = ? WHERE id = <projectId> AND stage_key = 'edited_review' AND archived_at IS NULL AND
   EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = <newMappingId>)` (fires *only* on a
   genuine `edited_review → editing_autohdr` transition). 8b: `INSERT INTO audit_log (...) SELECT ?,
   ?, 'stage.auto_advance', 'project', <projectId>, ?, ? WHERE changes() = 1` (chained off 8a
   specifically, via `changes()`, since 8a→8b *is* a genuine single-preceding-statement relationship)
   — pairing every automatic stage change with its audit row, matching
   `confirmAutoHdrHandoff()`'s/`guardedStageTransition()`'s own established shape.
9. **Per-candidate reactivation-or-insert, using each candidate's specific row `id`.** **Terra
   round-5 correction — the branch selection itself was wrong.** The round-5 draft only treated a
   pre-batch JS read of `tombstone`/`blocked` state as "reactivate," defaulting to a fresh `INSERT`
   otherwise — but the *ordinary* case for this whole feature is a project repeating a send, whose
   existing path-claim rows are read, pre-batch, in `pending`/`active` state (they haven't been
   tombstoned by step 3 *yet* — that happens later in the same batch). The fresh-`INSERT` branch
   would then collide with the still-existing row via `autohdr_path_claims_connection_path_unique`
   the moment step 3 actually tombstones it. **The fix**: the pre-batch JS read captures the row
   `id` for each candidate path whenever *any* row exists there for this project, regardless of its
   read-time state — reactivation is decided by row *existence*, not by its state at read time
   (which step 3, later in the same batch, is expected to change anyway). For each candidate,
   independently:
   - If a row exists (any state), issue `UPDATE autohdr_path_claims SET state = 'pending',
     handoff_id = ?, mapping_id = ?, folder_id = NULL, diagnostic = NULL, updated_at = ? WHERE id =
     <that exact row's id> AND project_id = <projectId> AND state = 'tombstone' AND EXISTS (SELECT 1
     FROM autohdr_output_mappings WHERE id = <newMappingId>)`. The `state = 'tombstone'` here is the
     row's *expected state at this statement's execution*, after step 3 has already run earlier in
     this same batch — not its state at the earlier JS read. Pinning the exact row `id` means a race
     that changed *that specific row* between the JS read and this statement's execution (e.g. it
     didn't actually get tombstoned, or something else claimed it) produces `changes() = 0` here —
     detectable, not silently accepted.
   - If no row exists at all for this project at that path, issue a plain `INSERT INTO
     autohdr_path_claims (...) SELECT ?, ... WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings
     WHERE id = <newMappingId>)` — a genuine collision (a different project's live claim already
     occupies this exact path) throws a real `UNIQUE` constraint violation, rolling back the entire
     D1 batch — the one place in this sequence where a real SQL error, not a `changes()`/`EXISTS`
     check, is the correctness mechanism, matching how `claimAutoHdrHandoff()`'s own fresh-claim
     path already relies on this same index (`claims.ts:166-198`).
10. **After the batch**, the caller must explicitly check that *both* candidate statements'
    `results[i].meta.changes === 1`. If either is `0` with no thrown error, retirement and the new
    job/handoff/mapping already committed, but reclaim is incomplete. **Terra round-5 correction —
    the compensating batch's own content was incomplete and didn't match its cited precedent.**
    Direct read of `claimAutoHdrHandoff()`'s own compensating batch (`claims.ts:156-165`) shows it
    marks the **job** `status = 'failed'`, not just the handoff/mapping — and
    `projects.ts`'s job-retry route (`:470`) only accepts `failed`/stuck jobs, so leaving the new job
    `queued` (as an earlier draft of this plan did) would make it permanently unretryable through the
    normal path. The corrected compensating batch must: mark the new job `status = 'failed'` with a
    diagnostic; mark the new mapping `blocked_collision`; mark the new handoff `blocked`; and mark
    **every** `autohdr_path_claims` row currently pointing at the new mapping (i.e. whichever
    candidate *did* successfully reactivate) `blocked` with the same diagnostic — the candidate that
    *failed* to reactivate needs no explicit handling, since its own statement never touched it (it's
    left exactly where step 3 put it, `tombstone`, untouched). The operation then surfaces as a
    clear, fully-consistent, operator-visible blocked state and an honest error to the user, rather
    than a queued-forever job or a half-transferred claim set.

### 5. `claimAutoHdrFetch()`: the race from the other direction, fixed precisely against its actual current structure

**Terra round-3 correction — the round-2 fix description was unbuildable as written.** Direct read
of the *full* function (`claims.ts:683-758`) shows both its `jobs` insert and its
`autohdr_fetch_claims` insert are **currently unconditional** `INSERT ... VALUES` statements inside
one `env.DB.batch()`, and the code never checks either statement's `changes()` afterward — it only
catches a thrown unique-conflict error. Naively fencing *only* the claim insert (as round 2
described) would leave the job insert unconditional: a fenced-out claim would still leave an
orphaned `queued` job with no corresponding claim, and — worse — the function would still return
`{ reused: false, ... }` as if a real claim existed, letting `startClaimedFetch()` create a Workflow
instance for a claim that was never actually written.

**The fix**, matching the same job-then-claim chaining shape used elsewhere:

- The `jobs` insert becomes the gate — **Terra round-4 correction: the two `EXISTS` checks in the
  round-3 draft verified two facts independently (a mapping with this id is active; a handoff with
  this id is started) without pinning that they're the *same pair* the route actually describes**,
  matching neither the mapping→handoff relationship nor the route's own project/generation/
  connection. Fixed to a single joined `EXISTS`, mirroring exactly how `routeAutoHdrDelta()` itself
  joins these tables (`mapping.ts:92-95`):
  ```
  INSERT INTO jobs (...) SELECT ?, 'fetch_edited', 'queued', ?, ?, ?, 0, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM autohdr_output_mappings m
    JOIN autohdr_handoffs h ON h.id = m.handoff_id AND h.project_id = m.project_id
    WHERE m.id = <route.mappingId> AND m.state = 'active' AND m.connection_id = <route.connectionId>
      AND m.generation = <route.generation> AND m.project_id = <route.projectId>
      AND h.id = <route.handoffId> AND h.state = 'started' AND h.generation = <route.generation>
      AND h.connection_id = <route.connectionId>
  )
  ```
  **Terra round-5 correction:** the round-4 draft pinned `h.generation` and `m.connection_id` but
  left `m.generation` and `h.connection_id` unchecked — the schema doesn't enforce these
  cross-row invariants itself, so both must be checked explicitly to fully pin the mapping and
  handoff as describing the *same* generation and connection the route claims, not just
  individually-plausible rows.
- The `autohdr_fetch_claims` insert becomes `INSERT INTO autohdr_fetch_claims (...) SELECT ?, ...
  WHERE changes() = 1` — chained off the job insert, mirroring the established pattern exactly.
- **After the batch**, the code must check the claim insert's own `results[1].meta.changes === 1` —
  not just catch a thrown unique-conflict error as it does today. If it's `0` with no thrown error,
  this is a *new*, distinct outcome this function doesn't have today: the route was stale (the
  mapping/handoff was retired between routing and this claim attempt). The function must **not**
  return `{ reused: false }` in that case — it needs its own explicit "route no longer valid" result
  that the caller (the DO's delta-processing loop) can use to skip this route rather than proceeding
  to `startClaimedFetch()` with a phantom claim. The exact return-type shape is a build-round detail;
  the requirement that it's never silently treated as success is not.
- **Terra round-6 correction — the reasoning above about the reuse path was wrong.** The existing
  "reuse an already-`starting`/`running` claim" early-return path (`claims.ts:703-715`) matches
  purely by `projectId` + `mappingGeneration`, **before** the joined fence above ever runs — and the
  round-5 draft's justification for skipping a check there ("§4 step 1's `NOT EXISTS` fetch-claim
  guard means retirement can't succeed while the claim is active") only accounts for *this plan's
  own* retirement path. It doesn't account for the **pre-existing, unrelated** project-archive flow
  (`projects.ts:507-511`), which retires a mapping/handoff with no fetch-claim check at all and
  predates this plan entirely. A project archived while a fetch claim is `starting`/`running` leaves
  that claim orphaned against a now-retired mapping/handoff — and the reuse path would happily return
  it as valid. **Fix**: the reuse path must apply the *same* joined mapping/handoff/generation/
  connection check as the fresh-claim gate above before returning an existing claim — either by
  adding the join as a `WHERE` condition on the reuse `SELECT` itself, or by reusing the exact same
  `EXISTS` subquery as an explicit guard before the early return. **Terra round-7 correction:** in
  addition to that joined mapping/handoff validity check, the reuse query must also pin the *claim
  row's own* `mapping_id`, `handoff_id`, and `connection_id` columns to equal `route.mappingId`,
  `route.handoffId`, and `route.connectionId` directly — not rely solely on `(project_id,
  mapping_generation)` matching being unique. `(project_id, generation)` is uniquely constrained on
  `autohdr_output_mappings` today, so in practice this can't currently diverge, but pinning the
  claim's own identity columns directly makes the fence correct by direct inspection at this call
  site, not by an indirect guarantee from a different table's index. If either check fails, the
  reuse path produces the same "route no longer valid" outcome the fresh-claim path does — one
  distinct outcome from `claimAutoHdrFetch()`, reachable via either path.
- **Terra round-6 correction — this outcome has three callers, not one, and all three need updating,
  not just "the DO's delta-processing loop."** Confirmed by direct read: `claimAutoHdrFetch()` is
  called from `index.ts:244` (the manual/RPC-triggered fetch path), `do/dropbox-sync.ts:170` (the
  delta-processing loop), and `autohdr/backfill.ts:162` (the operator backfill scan) — all three
  currently call `claimAutoHdrFetch()` then unconditionally call `startClaimedFetch()` with whatever
  comes back, with no handling for any "route invalid" result today. All three must check for the
  new outcome and skip the `startClaimedFetch()` call for that route instead of passing through a
  claim that was never validly established.

**Failure handling for §4's batch** reuses the established idiom from `claimAutoHdrHandoff()`'s own
`catch` block (`claims.ts:166-198`): if the batch throws a real SQL error (a genuine unique-
constraint collision on the new handoff/mapping insert), classify via `isUniqueConflict()`. If
instead the chain simply no-ops (no thrown error, but step 1's `changes()` came back `0`), nothing
in the batch will have taken effect — every downstream statement's guard chains strictly off step
1's actual success, so a failed attempt is a clean, verifiably-total no-op, safe to report as "try
again" without compensating cleanup. A workflow-creation failure *after* the D1 batch successfully
commits leaves the new `starting` handoff in the same operator-recoverable state the existing
retry-route (`projects.ts`'s `/jobs/:id/retry` handler) already knows how to resume, exactly like a
normal fresh claim's workflow-creation failure today.

### 6. Frontend

`sendToAutoHdr()` (`ProjectWorkspace.tsx:248-251`) gains a catch branch for the new
`ERR_HANDOFF_ALREADY_ACTIVE` code: show a `window.confirm()` with the corrected copy from §1
("...may be lost. Wait until it's finished..."), and on confirmation, re-call the same endpoint
with `startNewRound: true`. **Addition (post-approval, user-requested):** the confirm copy also
discloses §7's removal, using the count §7 computes — see §7 for the exact response-shape addition
this requires. The two §2 precondition failures get their own distinct, honest messages (no
`window.confirm()` needed for those — they're not consequential choices, they're "not possible
right now, try again shortly" / "resend that specific asset once its current delivery resolves").
No new button, no new route, no new screen — the existing "Send N selected to autoHDR" control
gains new resolution paths for cases it currently mishandles silently or not at all.

### 7. Removing deselected assets from the AutoHDR folder (addition — user-requested, post-approval, round 4)

**What prompted this**: the base plan (§§1-6, Terra-approved) only ever *adds* newly-selected RAW
assets to the AutoHDR intake folder — confirmed by direct read of `AutoHdrSend`'s only Dropbox
write, `copyBatch()`/`copy_batch_v2` (`workflows/autohdr.ts:174-186`), fed by a "skip-existing"
step (`:153-172`) that only ever *adds* filenames not already present. Quincy Portal has **never**
deleted anything from Dropbox — confirmed by grep across the entire background worker: no
`files/delete*` call exists anywhere today. Without this addition, a repeat send that adds new
photos while also deselecting previously-sent ones leaves the deselected ones' files sitting in the
AutoHDR folder forever — a real, disclosed gap in the base plan the user asked to close.

**Terra round-1 correction — the round-1 draft of this section is unsafe as written, for three
compounding reasons, and needed a real redesign, not a patch:**

1. **Selection membership isn't proof of a Dropbox write.** `selected_asset_ids_json` only records
   that an asset was *chosen*; it says nothing about whether the copy step's own "skip-existing"
   logic actually wrote a file for it, skipped it (name already present), or hit a conflict. Basing
   removal on selection membership alone risks deleting a file Portal never actually created there.
2. **A same-filename collision between a removed asset and a newly-added one is a real, not
   theoretical, way to delete the wrong file.** If old asset A and new asset B share a destination
   filename, generation N+1's own copy step *skips* B (the name already exists, from A) — B never
   gets its own confirmed write — while a naive removal step would still see "A is gone from the
   new selection" and delete the file, which by then may already represent B in every way that
   matters.
3. **Path drift.** The project's `rawFolderPath` (and therefore the derived AutoHDR intake path)
   can change between generations (confirmed: `dropbox/sync.ts:297` reconciles it). Re-deriving a
   removal path fresh from the *current* `rawFolderPath`, rather than the path actually used when
   the file was written, can target the wrong folder entirely.

**The fix: a minimal new table recording exactly what each generation's own copy step confirmed it
wrote, and a removal computation that only ever acts on that record — not on selection membership,
and not on a freshly re-derived path.**

```sql
-- migration 0016 (0015 is already applied to prod, confirmed earlier this session)
CREATE TABLE autohdr_sent_files (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES autohdr_handoffs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  dropbox_path TEXT NOT NULL,
  dropbox_path_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX autohdr_sent_files_handoff_asset_unique ON autohdr_sent_files(handoff_id, asset_id);
```

**Terra round-2 correction — migration number, cascade behavior, and column definition, all
fixed.** Migration `0015` already exists and is applied to prod (`0015_autohdr_v2_implicit_
scaffolding.sql`, confirmed earlier this session) — this is `0016`. `ON DELETE CASCADE` on both
foreign keys means rows survive ordinary retirement (handoffs are never actually `DELETE`d, only
`UPDATE`d to `retired`) but disappear if a handoff or asset is ever truly deleted — no `project_id`/
`connection_id` column needed, since every consumer joins through the handoff for those. **Two
columns, not one**, for the path — `dropbox_path` (the exact, mixed-case path actually used for the
Dropbox API call, matching `autohdr_path_claims`'s own existing `path`/`path_key` pairing) and
`dropbox_path_key` (`dropboxPathKey()`-normalized — lowercase, `dropbox/paths.ts:18-20` — matching
every other `_path_key` column in this schema). The delete call itself uses `dropbox_path`; lookups/
collision-exclusion comparisons use `dropbox_path_key`, consistent with how every other Dropbox path
pair in this codebase already works.

**Terra round-3 correction:** the table also needs a Drizzle definition in
`portal/packages/db/src/schema.ts` alongside the other AutoHDR tables — the raw migration SQL alone
isn't sufficient, matching the base plan's own established discipline (`drizzle-kit generate` must
report "no schema changes" after both the hand-written migration and the schema.ts addition are in
place, the same verification the original AutoHDR migration 0015 work used). **The shared
`computeRemovalAssetIds()` helper (below) must live in `@quincy/shared`, not in either worker's own
source** — `claims.ts` (background worker) and `projects.ts` (app worker) are two separately
deployed Cloudflare Workers; a helper defined in one isn't importable by the other. `@quincy/shared`
is already the established home for cross-worker pure logic in this codebase.

**Terra round-2 correction — recording must not be gated on the whole batch succeeding, and must
also cover the fallback-upload path.** `throwOnCopyFailures()` (`workflows/autohdr.ts:93-98`) throws
as soon as it finds *any* hard failure in a batch response — but a batch can contain confirmed
successes *before* that failure. The round-1 draft's "record after the batch, if it didn't throw"
design would silently lose provenance for every success in a batch that also contained one failure.
**Fixed**: record each successful entry as part of inspecting the response, *before* — not
conditional on — `throwOnCopyFailures()` deciding whether to throw. The `"record-sent-files"` work
happens inline with the existing per-chunk response inspection, not as a separate step gated on
overall success. Separately, the **fallback upload path** (`workflows/autohdr.ts:208-215`, for
non-Dropbox-sourced assets) writes files too and was missing from the round-1 draft entirely — each
`copy-fallback-${asset.id}` step already runs per-asset and already knows its own exact
`${inputPath}/${asset.originalFilename}` destination; it records its own provenance row immediately
after its `upload()` call succeeds, within the same step callback. **Both insert paths use `INSERT
... ON CONFLICT (handoff_id, asset_id) DO NOTHING`** — Workflow step retries can re-attempt a
partially-completed step, and a retry must not fail on a row it already successfully wrote the first
time. This runs on **every** generation's send (first-time and repeat alike), so a *future* repeat
send (generation N+2) has generation N+1's own record to work from too.

**Computing the removal set — inside the Workflow, at execution time, not threaded through job
payload.** `AutoHdrInput` (`workers/background/src/workflows/autohdr.ts:14-22`) gains one new
optional field: `retiredHandoffId?: string` — the handoff §4's retire-and-reclaim batch just
retired, if this is a repeat send. **Terra round-1 correction — the round-1 draft's description of
threading a precomputed filename list through `jobs.payload_json` was checked against the real code
and doesn't fit cleanly** (`index.ts`'s existing handoff query doesn't select `jobId` at all, though
`owner.jobId` from `claimAutoHdrHandoff()`'s own return value is already available separately —
this is corrected below rather than relied on). The simpler, more robust fix: `HandoffOwner`
(`claims.ts`'s return type) gains an optional `retiredHandoffId?: string`, set only by the
retire-and-reclaim path; `startAutoHdr()`'s existing `AUTOHDR_WORKFLOW.create({ params: {...} })`
call (`index.ts:117-125`) passes it straight through — no extra DB read, no job-payload threading.
The Workflow's new `"remove-deselected"` step then queries, fresh, at the moment it actually runs:
`SELECT asset_id, dropbox_path, dropbox_path_key FROM autohdr_sent_files WHERE handoff_id =
input.retiredHandoffId AND project_id = input.projectId AND asset_id NOT IN (<input.assetIds>)` —
**Terra round-3 correction: scoped by both `retiredHandoffId` *and* `projectId` explicitly**, not
relying solely on the foreign-key relationship for this correctness-sensitive query (requires
joining `autohdr_sent_files` through to `autohdr_handoffs.project_id`, or adding a denormalized
`project_id` column directly for a simpler query — an implementation detail either way). The
removal set is derived from a live table read at execution time, not a value computed earlier and
carried forward, closing the staleness class of concern for this specific computation (see below for
the *confirm-dialog* staleness question, which is separate). **Terra round-2 correction — the delete calls must use the
*retiring* handoff's own Dropbox connection, not the new generation's.** Integrations can change
between generations; using `input.connectionId` (the *new* handoff's connection) to delete a file
that was written under a *different* connection would target the wrong Dropbox account entirely.
The step reads `autohdr_handoffs.connection_id` for `input.retiredHandoffId` specifically and uses
that connection for every `getMetadata()`/`deleteBatch()` call in this step.

**Terra round-1 correction — the filename-collision risk (point 2 above) is closed by exclusion, not
by rejecting the whole send.** Before issuing any delete, the step computes the *current* selection's
own destination filenames (`input.assetIds`' `originalFilename`s, matching the copy step's own
`.toLowerCase()` normalization) and **excludes** any removal-candidate row whose `dropbox_path_key`
collides with one of them — that path now legitimately belongs to a currently-selected asset, and
must never be targeted for deletion regardless of which asset "owns" the provenance row.

**Terra round-1 correction — an existence check immediately before each delete, using the already-
existing `getMetadata()` function, not new metadata-parsing.** For each remaining removal candidate,
call `getMetadata()` (`dropbox/client.ts:549-563`) on its recorded `dropbox_path_key` immediately
before attempting to delete it. A `path_lookup/not_found`-class response (mirroring the existing
`path/not_found` detection idiom already used for `list_folder`, `dropbox/client.ts:464`) means the
file's already gone — treated as success (`alreadyGone`), not failure, the same idempotency
principle the copy step's own "skip-existing" check already relies on. **Terra round-3
correction:** the check must also confirm the entry is still tagged `"file"`, not `"folder"` — never
attempt to delete a folder that happens to now occupy the recorded path (an unlikely but real
possible Dropbox state if something else reused that exact name for a folder). This doesn't
eliminate every conceivable race (the file could theoretically change between this check and the
delete call a moment later), but it closes the realistic, non-adversarial cases without touching the
copy-response metadata-parsing landmine noted above.

**Terra round-3 correction — chunking and polling, matching the copy step's own established
pattern precisely.** Delete requests are chunked at the same `COPY_BATCH_MAX_ENTRIES` size (1,000
entries) already used for copy, with each chunk's `async_job_id` (if returned) polled via
`deleteBatchCheck()` the same way `copyBatchCheck()` is already polled, up to the same
`COPY_BATCH_MAX_POLLS` bound. Dropbox's `delete_batch` response entries are **positional** — they
correspond to request entries by array index, not keyed by path — so outcome-bucketing
(`removed`/`alreadyGone`/`failed`) must track each result against the specific removal-candidate row
it was requested for by position, not by re-matching on path after the fact.

**The new Dropbox client function.** Add `deleteBatch()`/`deleteBatchCheck()`, targeting Dropbox's
real `/files/delete_batch` and `/files/delete_batch/check` endpoints. **Terra round-1 correction —
this does not "mirror `copyBatch()`/`copyBatchCheck()` exactly," as the round-1 draft claimed**;
Dropbox's delete-batch contract has real shape differences from copy-batch. **Terra round-2
correction — specify the contract now, not "verify during the build round":**

- `deleteBatch()` (`/files/delete_batch`) returns one of: `complete` (with per-entry results, same
  shape as copy's `success`/`failure` tags), or `async_job_id` (poll via check) — matching copy's
  own two-shape result.
- `deleteBatchCheck()` (`/files/delete_batch/check`) returns one of **three** shapes, not two:
  `complete`, `in_progress` (matching copy's check endpoint), **and a top-level `failed` tag that
  copy's check endpoint does not have** — the parser must model this third case explicitly rather
  than throwing an "unsupported response type" error on it, since it's a real, documented outcome,
  not a parse anomaly.
- **Per-entry results**: a `success` tag needs no metadata parsing (matching copy's own principle —
  none is needed here either). A `failure` tag carries a reason; specifically, a
  `path_lookup/not_found`-shaped failure is mapped to the `alreadyGone` outcome bucket (§7's
  non-fatal contract, below) — not treated as a real failure. Any other failure reason is a genuine
  `failed` outcome.
- A top-level `failed` result from the check endpoint (the new third case above) is treated as a
  `failed` outcome for every entry in that batch chunk, not a thrown parser exception — consistent
  with the non-fatal contract's requirement that no Dropbox-side failure shape ever escapes as a
  thrown error from this step.

The build round should still confirm this against Dropbox's own current API reference before
implementing — API contracts can shift — but the *shape* this plan expects is specified here, not
deferred wholesale.

**The new Workflow step — non-fatal by construction, ordered after copy.** `AutoHdrSend.run()`
gains `"remove-deselected"`, running **after** the existing copy step(s) and the new
`"record-sent-files"` work succeed — copy (and record) the new files first, so a cleanup failure
never costs the new generation content it actually needs; a failed cleanup at worst leaves a stale
file behind, the same status quo as before this addition existed. **Terra round-1 correction — "copy
first" alone was not a sufficient safety argument; the provenance table, collision exclusion, and
existence check above are what actually make this safe, not step ordering by itself.**

**Terra round-2 correction — an archive-time guard, since this step performs a real, destructive
external write that can now happen well after the request that triggered it.** The pre-existing
project-archive route (`projects.ts:496-512`, unrelated to this plan, predates it) can archive the
project — and retire its mapping/handoff — while this Workflow step is still pending or mid-retry,
since Workflow steps execute asynchronously over time, not synchronously within the original
request. Immediately before issuing any `deleteBatch()` call (not just once at the start of the
step), re-check `EXISTS (SELECT 1 FROM projects WHERE id = input.projectId AND archived_at IS
NULL) AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = input.handoffId AND state = 'started')`
— the *new* generation's own project/handoff, confirming the send this cleanup is attached to is
still genuinely live. If either check fails, skip the remaining deletes for this run (non-fatal,
matching the rest of this step's contract) rather than performing a destructive Dropbox write on
behalf of a project the studio has since archived or a send that's no longer active.

**Terra round-1 correction — the non-fatal contract must be airtight, not just directionally
correct.** Every operation inside this step — the removal-set query, the collision exclusion, each
`getMetadata()` call, `deleteBatch()`/`deleteBatchCheck()`'s launch/poll/parse — is wrapped in its
own try/catch *inside* the step's callback. No exception may propagate out of the callback and reach
Cloudflare Workflow's own step-retry machinery, which would otherwise either retry a call that
already succeeded (given `deleteBatch`'s calls aren't naturally idempotent the way `INSERT ... WHERE`
guards are) or eventually fail the whole job. The callback always returns normally — a plain result
object summarizing outcomes per file (`removed` / `alreadyGone` / `failed`), never a thrown error.
**Terra round-3 correction — two specific failure modes must be explicitly named, not left implicit
under "every operation":** poll exhaustion (mirroring the copy step's own `"Dropbox copy_batch_v2
did not complete after N checks"` throw, `workflows/autohdr.ts:132`) and a failure in the summary
**audit-log write itself** must both land in the `failed` bucket / be logged, never escape the
step's callback as a thrown error — an implementer reading only "every operation" could plausibly
miss that the *audit write reporting the outcome* is itself an operation this contract covers.
**Terra round-1 correction — "on success, one audit entry" was insufficient**: every outcome bucket
gets recorded — a summary audit_log entry covering removed/already-gone/failed counts (and, for
`failed`, which specific files), not success-only logging.

**Frontend disclosure, with a real, commit-fenced freshness mechanism.** One shared helper — e.g.
`computeRemovalAssetIds(oldSelectedIds, newSelectedIds, collidingDestinationFilenames)` — is used
identically everywhere the *asset-id-level* removal set matters: computing the count/hash for the
`ERR_HANDOFF_ALREADY_ACTIVE` response, and re-verifying inside the retire-and-reclaim batch. (The
Workflow's own `"remove-deselected"` step, per above, is necessarily table-driven — it operates on
recorded `autohdr_sent_files` rows, not a fresh selection diff — but its inputs, the retiring
handoff's selection and the new selection, are the same two sets this shared helper consumes, so
both stay consistent by construction rather than by two independently-written diff computations
drifting apart.)

**Terra round-2 correction — the round-1 hash wasn't actually fenced at commit time.** The removal
hash covers `computeRemovalAssetIds(...)`'s output (the *post-collision-exclusion* asset-id set, not
a raw diff), and `startNewRound: true` must echo it back — but §4 step 1's existing guard only pinned
§2's *association*-count freshness check, which is a different concern. **The fix**: step 1's guard
gains a second, parallel count check specifically for §7 — `(SELECT COUNT(*) FROM autohdr_sent_files
WHERE handoff_id = <handoffId>) = <sentFilesCountAtCheck>` (captured in the same JS-level pre-batch
read, mirroring the existing `associationCountAtCheck` idiom exactly) — so if the retiring
generation's *own* send Workflow is still active and writes a *new* `autohdr_sent_files` row between
the dialog's computation and the batch's commit (a real possibility — Workflow steps can still be
retrying at that point, since nothing in §4 gates retirement on the *old* generation's own send
having fully finished, only on it having no *active fetch claim*, a different concern), the count
diverges, the gate fails, and the whole chain cleanly cascades to a no-op — the same "try again"
outcome the rest of §4's fencing already produces. §6's `window.confirm()` copy is extended to name
the count explicitly — e.g. *"Starting a new round will also remove 3 previously-sent image(s) from
the AutoHDR folder, since they're no longer selected. Continue?"*

**Terra round-3 correction — the request contract for the echoed hash must be explicit, not
implied.** `POST /projects/:id/send-to-autohdr` accepts a new field, `removalSetHash`, alongside
`startNewRound: true`. `rpc-types.ts`'s `startAutoHdr()` signature carries it through;
`claimAutoHdrHandoff()` compares it against a **freshly computed** `computeRemovalAssetIds()` result
at the point the retire-and-reclaim batch actually runs (not the value from the original error
response) and returns a **distinct** outcome — a new `ERR_REMOVAL_SET_CHANGED` code, not a reused
`ERR_HANDOFF_ALREADY_ACTIVE` — telling the frontend to re-fetch a fresh count and re-prompt rather
than silently retrying with a stale hash.

**Terra round-3 correction — the two count fences (§2's association count, §7's sent-files count)
protect the *moment* of retirement, but don't prevent the retiring generation's *own* send Workflow
from continuing to write *after* retirement succeeds.** If generation N's send Workflow is still
`queued`/`running` when generation N+1's retirement fires — a real possibility, since nothing in §4
today requires the *old* generation's own send to have finished, only that it has no active *fetch*
claim (a different, inbound-side concern) — it can keep copying/uploading/recording files into what
is now generation N+1's folder *after* `"remove-deselected"` has already run, leaving a file behind
that should have been cleaned up but didn't exist yet at cleanup time. **Fixed with the same
dual-fence pattern already used for the fetch-claim race in §4/§5** — defense in depth, not a single
point of protection:

- **Retirement side**: §4 step 1's gate gains a third condition — the retiring handoff's own `job`
  (`autohdr_handoffs.job_id`) must have `jobs.status NOT IN ('queued', 'running')` — retirement is
  refused (clean no-op, same as any other step-1 guard failure) while the old generation's own send
  is still actively in flight.
- **Writer side**: `AutoHdrSend.run()`'s existing copy-chunk loop, the fallback-upload loop, and the
  new `"record-sent-files"` work all gain a check, immediately before each write —
  `EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = input.handoffId AND state = 'started')` — if
  the workflow's *own* handoff has since been retired (superseded by a later repeat send that raced
  past the retirement-side fence, or simply completed its own retirement while this workflow was
  between steps), the workflow stops issuing further copies/uploads/records for the remainder of
  its run and completes gracefully (not a job failure — being superseded by a legitimate later send
  is an expected outcome, not an error) rather than continuing to write content nothing will ever
  clean up.

## Non-goals for this round

- **Automatic/coverage-based retirement as the primary gate.** Considered and rejected in §1 — not
  reliable in practice given `225-227 Victoria Road`'s own coverage history, and explicit
  confirmation matches existing codebase convention better. (Coverage is still used, narrowly, as
  one input to the §2 overlap precondition.)
- **Fixing why `credibleCoverage()`'s filename matching apparently never resolved full coverage for
  `225-227 Victoria Road`'s generation 1** (stage never advanced past `editing_autohdr` despite
  multiple successful `fetch_edited` jobs). Noted as supporting evidence for §1's recommendation,
  not something this plan attempts to diagnose or fix — a separate concern from repeat-send support.
- **A recovery/un-quarantine path for a fetch that got quarantined by an unrelated, pre-existing
  race** (not caused by this plan — `writeAutoHdrFinal()`'s fence has always been able to quarantine
  a fetch for other reasons). This plan's §2/§4 fences prevent *this feature* from causing a new
  quarantine; it doesn't add general quarantine-recovery tooling, which doesn't exist today either.
- **Repeat-sending while the current generation's mapping is `pending_discovery`.** Excluded
  entirely in §2 — the studio must wait for AutoHDR's first delivery to be discovered before a new
  round can start. Not a precondition to relax later without also solving the routing-layer
  provenance gap named in §2 (`routeAutoHdrDelta` has no coverage awareness at all).
- **Retroactively fixing this project's stuck state via a one-off script.** Once this plan ships,
  the user can use the normal "Send to autoHDR" → confirm → new round flow on
  `225-227 Victoria Road` itself; no special-cased backfill is needed the way the original implicit-
  scaffolding plan needed one (that gap was about pre-existing Dropbox folders with no scaffold
  claim at all; this project already has everything it needs except a working repeat-send path).
- **§7 addition: full AutoHDR-folder reconciliation.** Deliberately rejected in §7's own scope
  decision — only removes files Portal has direct evidence it added on this exact project's behalf
  (the retiring generation's own prior selection), never a blanket "delete anything not in the
  current selection." A human-placed, Portal-unrelated file in that folder is never touched.
- **§7 addition: retry/recovery tooling for a failed cleanup delete.** A failed removal is logged
  and non-fatal to the send itself, but this plan doesn't add an operator-facing retry path for the
  cleanup specifically — a stale file left behind after a failed delete requires manual removal,
  the same as the pre-existing status quo for any Dropbox file this plan doesn't touch.
- **§7 addition: cleanup for assets deselected without ever starting a new round.** Nothing removes
  a previously-sent file just because it's been unchecked in the UI — cleanup only happens as part
  of an actual `startNewRound: true` confirmation; deselecting and never sending again leaves the
  file exactly where it was, matching the base plan's whole framing of "nothing happens until the
  user explicitly acts."

## Files touched (implementation phase, not this planning round)

- `portal/workers/background/src/autohdr/claims.ts` — `claimAutoHdrHandoff()`'s active-handoff
  branch gains selection-hash comparison, the blocked/implicit-always-requires-confirm policy, the
  `pending_discovery` exclusion, the two §2 precondition checks (basename overlap reusing
  `finals.ts`'s normalization plus the §4 association-count freshness check), and the new
  stage-aware retire-and-reclaim batch (§4, now including its own new-job insert) — a sibling
  function to the existing fresh-claim path, not a modification of its `raw_review`-gated body, but
  sharing its per-candidate reactivation-vs-insert branch shape already proven in
  `claimImplicitAutoHdrHandoff()`. **Terra round-3 correction:** `claimAutoHdrFetch()`'s fix (§5) is
  larger than originally scoped — both its `jobs` and `autohdr_fetch_claims` inserts change from
  unconditional to chained-and-fenced, and its post-batch success check changes from
  catch-unique-conflict-only to also checking the claim insert's own `changes()`, adding a new
  distinct "route no longer valid" outcome the caller must handle — a real, if still contained,
  change to previously-hardened code, not a one-line addition.
- `portal/workers/background/src/index.ts` — `startAutoHdr()` passes through the new
  `startNewRound`/`resumeExisting` modes (**Terra round-7 addition:** `resumeExisting`, set only by
  the job-retry route, to preserve existing retry behavior — see §3) and the new error codes
  (below). **Terra round-6 addition:** the manual-fetch call site (`:244`) also gains handling for
  `claimAutoHdrFetch()`'s new "route no longer valid" outcome.
- `portal/workers/background/src/do/dropbox-sync.ts` — **Terra round-6 addition:** the delta-
  processing loop (`:170`) skips `startClaimedFetch()` for a route reported as no longer valid.
- `portal/workers/background/src/autohdr/backfill.ts` — **Terra round-6 addition:** the operator
  backfill scan (`:162`) gains the same handling.
- `portal/workers/background/src/autohdr/finals.ts` — **Terra round-7 addition:** `plainBasename()`
  and `strippedBasename()` (currently module-private) gain `export` keywords so `claims.ts` can
  import them directly for the §2 overlap check, rather than duplicating their logic.
- `portal/workers/background/src/rpc-types.ts` — **Terra round-7 addition:** `startAutoHdr()`'s
  signature (`:9`) gains a third parameter carrying `startNewRound`/`resumeExisting`.
- `portal/workers/background/src/autohdr/errors.ts` — add three codes to `AutoHdrErrorCode`
  (additive, matching the precedent set by `ERR_FETCH_CLAIM_FAILED` in
  `Unified-Dropbox-Fetch-Plan.md`): `ERR_HANDOFF_ALREADY_ACTIVE` (§3's changed-selection case),
  `ERR_FETCH_IN_PROGRESS` (§2's first precondition), `ERR_SELECTION_OVERLAPS_OPEN_DELIVERY` (§2's
  second precondition) — exact naming is a build-round detail, not load-bearing here.
- `portal/workers/app/src/routes/projects.ts` — `/projects/:id/send-to-autohdr` accepts the new
  optional `startNewRound` body field and maps the new error codes. **Terra round-7 addition:** the
  job-retry route (`:470`) passes `resumeExisting: true` when retrying a `stuck`/`failed`
  `autohdr`-kind job, preserving today's actual retry behavior regardless of any selection drift
  since the original attempt.
- `portal/apps/web/src/screens/ProjectWorkspace.tsx` — `sendToAutoHdr()` gains the confirm-and-retry
  branch plus the two non-confirm precondition-failure messages. **§7 addition:** the confirm copy
  names the removal count.
- **§7 addition (new capability, not in the original approved scope; round 4 corrected):**
  - **New migration 0016** *and* a matching `autohdr_sent_files` Drizzle definition in
    `portal/packages/db/src/schema.ts` (both required — `drizzle-kit generate` must report no
    outstanding schema changes once they match) — the one schema change this whole plan needs,
    confined entirely to §7. `(id, handoff_id, asset_id, dropbox_path, dropbox_path_key,
    created_at)`, `ON DELETE CASCADE` on both foreign keys, unique on `(handoff_id, asset_id)`.
  - `portal/packages/shared/src/*` — new `computeRemovalAssetIds()` pure helper, importable by both
    workers (a worker-local helper wouldn't be — `claims.ts` and `projects.ts` are separately
    deployed).
  - `portal/workers/background/src/dropbox/client.ts` — new `deleteBatch()`/`deleteBatchCheck()`
    plus a delete-specific response parser modeling `complete`/`async_job_id`/`in_progress`/a
    top-level `failed` tag on the check endpoint (copy's contract doesn't have this fourth shape),
    positional per-entry results, `COPY_BATCH_MAX_ENTRIES`-sized chunking and polling matching the
    copy step's own pattern — verified against Dropbox's live API reference during the build round.
    The first delete capability this codebase has ever had against Dropbox.
  - `portal/workers/background/src/workflows/autohdr.ts` — `AutoHdrInput` gains
    `retiredHandoffId?: string`; the copy loop, the fallback-upload loop, and the new
    `"record-sent-files"` work all gain a per-write check that `input.handoffId` is still `started`
    (the writer-side half of the round-3 dual fence, stopping gracefully if superseded by a later
    repeat send), and record successful entries inline (not gated on the whole batch succeeding,
    using `INSERT ... ON CONFLICT (...) DO NOTHING` for retry-idempotency); `AutoHdrSend.run()`
    gains the non-fatal `"remove-deselected"` step (runs only when `retiredHandoffId` is set),
    scoped by both `retiredHandoffId` and `projectId`, using the *retiring* handoff's own
    `connection_id`, requiring a `getMetadata()` file-tag (not folder) check before each delete, and
    re-checking the new generation's project/handoff are still live immediately before each delete
    call.
  - `portal/workers/background/src/autohdr/claims.ts` — `HandoffOwner`'s type gains
    `retiredHandoffId?: string`, set by the retire-and-reclaim path (§4); §4 step 1's gate gains a
    second parallel count fence (`autohdr_sent_files` count for the retiring handoff) *and* a third
    condition — the retiring handoff's own `jobs.status NOT IN ('queued', 'running')` (the
    retirement-side half of the round-3 dual fence) — so a still-in-flight old-generation send can
    neither silently invalidate an already-confirmed removal count nor race past retirement
    entirely. Compares an echoed `removalSetHash` (below) against a freshly computed
    `computeRemovalAssetIds()` result, returning `ERR_REMOVAL_SET_CHANGED` (a new, distinct code) on
    mismatch.
  - `portal/workers/background/src/rpc-types.ts` — `startAutoHdr()`'s signature carries
    `removalSetHash` through alongside `startNewRound`/`resumeExisting`.
  - `portal/workers/app/src/routes/projects.ts` — `/projects/:id/send-to-autohdr` accepts
    `removalSetHash` in the request body; the `ERR_HANDOFF_ALREADY_ACTIVE` response body gains the
    removal count and its hash (via `computeRemovalAssetIds()`).
  - `portal/workers/background/src/index.ts` — `startAutoHdr()`'s existing workflow-creation call
    (`:117-125`) passes `retiredHandoffId` through from `owner` — no extra DB read needed, since
    `owner` (from `claimAutoHdrHandoff()`) already carries everything required.
- §§1-6 need no schema change — every state value they use (`retired` on handoffs/mappings,
  `tombstone` on path claims) already exists in the current enum definitions. §7 is the one
  exception (the new `autohdr_sent_files` table above, migration `0016`).

## Verification approach (for the eventual build round)

- `npm run typecheck` (all six workspaces), `npm run build -w @quincy/web`,
  `npm run test --workspaces`, and separately
  `npx vitest run --config packages/shared/vitest.config.ts` (per `CLAUDE.md`).
- **Terra round-1 correction — expanded to cover the actual failure modes found in review, not just
  the happy path:**
  - Repeat send from `editing_autohdr` succeeds; repeat send from `edited_review` succeeds (the
    stage-preservation fix in §4, not the old `raw_review`-only path).
  - Same-selection re-click against a `starting`/`started` handoff stays idempotent (`reused: true`,
    no new handoff); against a `blocked` handoff, is **never** idempotent even with an identical
    selection — always requires `startNewRound`.
  - Different-selection without `startNewRound` returns `ERR_HANDOFF_ALREADY_ACTIVE` and creates
    nothing new.
  - **Terra round-2 additions, testing the corrected atomicity/precondition mechanism directly:**
    §2/§4 precondition 1 is embedded in the retirement batch itself, not a separate precheck: an
    active `autohdr_fetch_claims` row (`starting`/`running`) for the current mapping causes the
    retirement statements to no-op (`changes() === 0`) even when `startNewRound: true`, and
    generation N is left fully intact — assert this by starting a fetch claim, then immediately
    attempting `startNewRound` in the same test, not by checking a precheck response in isolation.
    A fetch claim inserted *during* the batch (simulated via a dependency-injection seam, mirroring
    the `beforeBatch` pattern from `AutoHDR-Manual-Supplement-Fetch-Plan.md`) must also cause the
    retirement to no-op, proving the fence is evaluated at commit time, not read time.
  - `claimAutoHdrFetch()`'s new mapping-active/handoff-started fence: a claim attempt against an
    already-retired mapping/handoff is refused, not silently accepted — the other half of the race
    closed in §4.
  - §2 precondition 2, using **normalized basename** comparison, not asset-ID equality: two
    *different* RAW assets across generations whose delivered-filename basenames coincide (per
    `plainBasename`/`strippedBasename`) is refused with `ERR_SELECTION_OVERLAPS_OPEN_DELIVERY`, not
    just an identical asset ID re-selected.
  - Two RAW assets with coincidentally identical delivered-filename basenames, one in generation N
    (already covered/closed — has an `autohdr_final_associations` row) and one in the new
    generation-N+1 selection, do **not** trigger the precondition — the check only blocks *open*
    (uncovered) overlaps, confirmed as intentional, not a gap.
  - A mapping in `pending_discovery` refuses `startNewRound` outright, with a distinct message, even
    when both other preconditions would otherwise pass.
  - **Terra round-6 correction:** a `blocked_collision` mapping with exactly two `blocked` path
    claims (the explicit-send collision case) **is** eligible for `startNewRound` — its claims are
    correctly tombstoned in step 3 and reactivated in step 9 the same as an `active` mapping's
    would be. A `blocked_collision` mapping with **zero** path claims (the unrelated implicit-
    detection collision case, `claims.ts:187-193`) is correctly **refused** by step 1's count guard
    — assert both cases explicitly, not just the eligible one.
  - Repeat send from `editing_autohdr` succeeds; repeat send from `edited_review` succeeds and the
    retire-and-reclaim batch's own stage-forcing statement (§4 step 8a) transitions it back to
    `editing_autohdr` — verify `confirmAutoHdrHandoff()`/the Workflow are exercised **unmodified**
    (no changes to those files in the diff) and still succeed against the now-corrected stage.
  - With both preconditions satisfied and `startNewRound: true`: generation N retires, generation
    N+1 is created at the next generation number, and the *same* `autohdr_path_claims` rows are
    reactivated (`UPDATE`, verified by row `id`, not a fresh `INSERT`) under the new handoff/mapping
    for **both** candidates independently, with stale `folder_id`/`diagnostic` cleared.
  - A late generation-N delivery that arrives *after* a legitimate retirement is quarantined by
    `writeAutoHdrFinal()`'s existing fence (per §1's corrected framing) — confirm it produces no
    asset and a quarantine audit entry, not a misattributed one.
  - Workflow-creation failure after a successful retire-and-reclaim batch leaves the new `starting`
    handoff resumable via the existing job-retry route, exactly like a fresh claim's own
    workflow-creation failure today.
  - A batch whose retirement statements no-op for any reason (concurrent archive, mapping already
    moved, in-flight fetch) leaves generation N fully `started`/`active` and untouched — no partial
    retirement, verified by checking *every* affected row (mapping, handoff, path claims), not just
    the top-level response.
  - A third-party path collision (different project entirely) is still correctly rejected, unaffected
    by any of the above.
  - **Terra round-3 additions:**
    - The new job row (§4 step 4) is created and correctly referenced by the new handoff's `job_id`
      — a repeat send must never violate the `NOT NULL` foreign key, and a build-time regression
      test should assert the FK is actually satisfiable (not just that the code compiles).
    - A concurrent delivery landing for the current handoff *between* the JS-level overlap
      computation and the batch's commit (simulated via the same `beforeBatch`-style seam) causes
      step 1's association-count freshness check to fail, cascading the whole chain to a no-op —
      proving the overlap check is genuinely commit-time, not a stale read.
    - The stage-transition step (§4 step 7a/7b, now placed *after* every mandatory step, per round
      4) fires its audit row only on a genuine `edited_review → editing_autohdr` transition, never
      when the project was already `editing_autohdr` — and step 4 (job insert) still succeeds in
      *both* cases, since it's chained off step 3 directly, not step 7.
    - `claimAutoHdrFetch()`'s new distinct "route no longer valid" outcome (not `{ reused: false }`)
      when its own fence rejects a claim attempt against an already-retired mapping/handoff — and
      the caller correctly skips that route rather than calling `startClaimedFetch()` with it.
    - No orphaned `jobs` row is left behind when `claimAutoHdrFetch()`'s fence rejects a claim
      attempt — the job insert and claim insert either both happen or neither does.
  - **Terra round-4 additions:**
    - Step 3's tombstone chains the job insert (step 4) off `changes() = 2` specifically, not
      `= 1` — a test where only one of the two candidate path claims was in a tombstonable state
      beforehand (an anomalous pre-existing condition) must prevent the whole chain from proceeding,
      not silently continue with an incomplete tombstone.
    - **The compensating-batch path for step 9's per-candidate reactivation**: simulate a race where
      one candidate's specific pre-read row `id` changes state between the JS read and the batch
      (via a `beforeBatch`-style seam) — confirm the retirement/new-handoff/new-mapping rows are
      left committed (not rolled back, since D1 can't do that here), but a *second*, compensating
      batch correctly marks the new job `failed`, the new mapping `blocked_collision`, the new
      handoff `blocked`, **and** the successfully-reactivated candidate's path claim `blocked` too
      (not left dangling `pending` against a now-blocked mapping) — and the caller returns an
      honest error, not a silent partial success.
    - A genuine third-party collision on the plain-`INSERT` branch of step 9 throws a real
      `UNIQUE` constraint error and rolls back the *entire* batch via D1's real error-based
      rollback — confirmed as the one step in this sequence where that mechanism, not `changes()`
      chaining, is load-bearing.
    - **Terra round-5 additions:**
      - The ordinary repeat-send case — both candidate rows read pre-batch in `pending`/`active`
        state (not yet tombstoned) — correctly takes the reactivation (`UPDATE`) branch for both,
        not the fresh-`INSERT` branch; a test using only the round-4 draft's read-time-state branch
        logic would have wrongly hit a unique-constraint collision against step 3's own tombstoning
        of those same rows.
      - Step 1's new count guard (`COUNT(*) ... state IN ('active','pending','blocked')) = 2`)
        prevents *any* retirement — not just an incomplete one — when the current generation's path
        claims aren't both present in a tombstonable state; assert the old handoff/mapping are left
        completely untouched in this case, not partially retired.
      - The stage-transition pair (step 8a/8b) and per-candidate reactivation (step 9) both use the
        new mapping's `EXISTS` check, not `changes()`-adjacency — a test asserting reactivation
        succeeds even when step 8a legitimately produced zero changes (project already
        `editing_autohdr`), proving the two are no longer accidentally coupled.
    - `claimAutoHdrFetch()`'s corrected joined gate rejects a claim attempt where the mapping and
      handoff IDs are both individually valid/active/started but don't actually belong to each
      other (a deliberately mismatched pair in the test) — proving the join, not just two
      independent `EXISTS` checks, is what's enforced.
    - **Terra round-6 additions:**
      - The **reuse** path (`claims.ts:703-715`), not just the fresh-claim insert path, rejects a
        stale route: simulate a project archived (or otherwise retired outside this plan's own
        retirement flow) while a fetch claim is `starting`/`running` for its mapping, then attempt
        to reuse that claim via a route describing the now-retired mapping/handoff — must produce
        the "route no longer valid" outcome, not the stale claim.
      - All three callers (`index.ts:244`, `do/dropbox-sync.ts:170`, `autohdr/backfill.ts:162`)
        correctly skip `startClaimedFetch()` for a route that comes back "no longer valid," rather
        than only the delta-processing loop being tested.
    - A `blocked` handoff and an `initiated_by IS NULL` handoff both surface the *same*
      `ERR_HANDOFF_ALREADY_ACTIVE` code as a changed-selection `starting`/`started` handoff does —
      one frontend branch (§6) correctly handles all three without a missing case.
  - **Terra round-7 additions:**
    - `POST /jobs/:id/retry` on a `stuck`/`failed` `autohdr`-kind job resumes the existing
      `starting`/`blocked` handoff/job exactly as it does today, **even when the current
      `selected_for_editing` set has changed** since the original attempt — must not return
      `ERR_HANDOFF_ALREADY_ACTIVE` or require confirmation; this is the regression round 7 caught.
    - The overlap check (§2) actually imports and uses the real, exported `plainBasename()`/
      `strippedBasename()` from `finals.ts`, not a reimplementation — a test changing one function's
      normalization behavior should observably change the other's, proving they're the same code.
    - The fetch-claim reuse fence rejects a claim whose stored `mapping_id`/`handoff_id`/
      `connection_id` don't match the route even when the joined mapping/handoff validity check
      alone would have passed (a deliberately constructed inconsistent test fixture) — proving the
      identity pin is independently enforced, not redundant with the join check.
  - **§7 additions (round 2 corrected):**
    - `"record-sent-files"` inserts exactly one `autohdr_sent_files` row per entry the copy
      response tags `"success"` — and **not** for an entry that was skipped (already present) or
      failed — confirmed by inspecting the actual rows written, not just the step's return value.
    - A repeat send that deselects a previously-sent asset while adding a new, non-colliding one
      removes exactly the deselected asset's recorded file and leaves everything else untouched —
      assert against the actual Dropbox folder listing, not just the internal computation.
    - **The filename-collision case**: old asset A and new asset B share a destination filename:
      generation N+1's copy step skips B (name already present from A); the removal step must
      **exclude** that path from deletion, since it's now a collision with the current selection —
      confirm the file remains, not deleted, and that this is the collision-exclusion logic doing
      the work, not an accident of ordering.
    - A repeat send whose new selection is a pure superset of the old one (nothing deselected)
      computes an empty removal set and `"remove-deselected"` is a no-op — no spurious delete or
      `getMetadata()` calls.
    - A `getMetadata()` existence check for a file that's already gone (deleted manually, or by an
      earlier retry) causes that entry to be treated as `alreadyGone`, not `failed` — the
      idempotency requirement, exercised through the real not-found detection path, not assumed.
    - A genuine deletion failure (simulated via a dependency-injection seam, matching this plan's
      established `beforeBatch`-style pattern) does not fail the Workflow/job — the new files are
      still copied and recorded, the send still succeeds, and the failure lands in the `failed`
      bucket of the summary audit entry, not thrown.
    - The `ERR_HANDOFF_ALREADY_ACTIVE` response's removal-set hash actually gates the retry: a test
      where the selection changes *between* the error response and the confirmed `startNewRound`
      call (an echoed hash that no longer matches what the batch computes fresh) is refused with the
      distinct "removal set changed" outcome, not silently proceeding on the stale count.
    - A file present in the AutoHDR folder that was never recorded in `autohdr_sent_files` for this
      project at all (simulating a human-placed, unrelated file, or a file from a completely
      different, unrelated project) is never targeted for removal, regardless of the current or
      prior selection — confirming §7's scope decision is enforced by the provenance table itself,
      not just stated in prose.
    - `retiredHandoffId` correctly flows from `claimAutoHdrHandoff()`'s return value through
      `startAutoHdr()` into `AUTOHDR_WORKFLOW.create()`'s params with no extra DB read — and is
      absent (not just falsy) for a first-ever send or a same-selection idempotent re-click, so
      `"remove-deselected"` never even attempts to run for those cases.
    - **Round 2 additions:**
      - A batch that contains both successes and one hard failure records provenance for every
        confirmed success *before* the failure propagates — not lost because the batch as a whole
        threw. A retried step that re-runs after a partial success doesn't fail on the
        already-recorded row (`ON CONFLICT DO NOTHING` exercised directly).
      - A fallback-upload asset (non-Dropbox source) gets its own `autohdr_sent_files` row
        immediately after its `upload()` call succeeds — not silently excluded from provenance the
        way the round-1 draft would have left it.
      - The delete calls target the *retiring* handoff's own connection, not the new generation's —
        a test with two different connections for the two generations confirms the correct one is
        used.
      - The parser correctly handles all four documented response shapes (`complete`,
        `async_job_id`, `in_progress`, and the check endpoint's top-level `failed`) without
        throwing, and a `path_lookup/not_found` per-entry failure is bucketed as `alreadyGone`, not
        `failed`.
      - A project archived (or its handoff otherwise deactivated) *after* a repeat send is confirmed
        but *before* `"remove-deselected"` actually runs causes the step to skip its remaining
        deletes non-fatally — no destructive Dropbox write happens against an archived project.
      - The `sentFilesCountAtCheck` fence: a test where the *retiring* generation's own send
        Workflow inserts a new `autohdr_sent_files` row (simulating it still being in-flight)
        between the dialog's count computation and the confirmed retry causes step 1 to fail its
        gate and cascade to a clean no-op, not a stale-count removal.
    - **Round 3 additions:**
      - `computeRemovalAssetIds()` lives in `@quincy/shared` and is imported (not reimplemented) by
        both `claims.ts` and `projects.ts` — a test changing the shared helper's behavior should
        observably change both call sites' outputs identically.
      - `removalSetHash` mismatch: confirm a real, distinct `ERR_REMOVAL_SET_CHANGED` outcome (not a
        reused `ERR_HANDOFF_ALREADY_ACTIVE`) when the echoed hash doesn't match a fresh
        `computeRemovalAssetIds()` result at commit time.
      - **The dual fence for a still-in-flight old-generation send**: (a) retirement-side —
        `startNewRound` is refused while the retiring handoff's own `jobs.status` is `queued`/
        `running`; (b) writer-side — a send Workflow whose handoff gets retired *mid-run* (simulated
        via the `beforeBatch`-style seam) stops issuing further copies/uploads/records for the rest
        of that run without failing the job. Test both independently, and confirm the writer-side
        check alone (without the retirement-side one) would still prevent the late-write scenario if
        the retirement-side race were somehow bypassed — genuine defense in depth, not redundant
        code.
      - A `getMetadata()` response tagged `"folder"` (not `"file"`) at a recorded path is never
        targeted for deletion, regardless of what's recorded — the file-vs-folder check is real, not
        assumed from existence alone.
      - Delete requests chunk at 1,000 entries and poll each async chunk, mirroring the copy step's
        own tested pattern; outcome-bucketing correctly matches positional response entries back to
        the specific removal-candidate row each was requested for.
      - Poll exhaustion and a failed summary audit-log write both land in the step's `failed`
        handling, never escape as a thrown error — exercised directly, not just implied by "every
        operation."
- Manual verification against `225-227 Victoria Road` once built: confirm §2's overlap precondition
  first (its generation-1 readiness units are apparently still open, per the coverage history noted
  in Non-goals — the first real attempt may need to select RAW assets that don't overlap
  generation 1's original selection to get past precondition 2, which is itself worth confirming
  behaves as intended rather than surprising the user again). Then select a fresh, non-overlapping
  batch of RAW assets, click "Send to autoHDR," confirm the `window.confirm()` prompt appears —
  including §7's removal count — confirm it, and verify a real new handoff/job is created, the new
  images appear in the project's AutoHDR Dropbox folder, and any deselected images from the prior
  attempt are actually gone.
