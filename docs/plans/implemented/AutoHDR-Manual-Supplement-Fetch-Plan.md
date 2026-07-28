# AutoHDR Manual-Photos Supplement Fetch — Plan

**Status: APPROVED (Terra round 6, `codex exec` read-only review).** Planning only — nothing in
this document has been implemented yet.

## Provenance

Drafted by Sonnet 5 (this session) per `docs/Subagent-Orchestration.md` §2 policy 1. User-triggered:
a real production report on `225-227 Victoria Road` — a manual drop into `04-MANUAL-Photos` was
never fetched, while the same project's `04-FINAL-Photos` deliveries fetch correctly. Reviewed by
Terra across 6 rounds — round 1 found the core architectural blocker (`finals.ts`'s fence) and the
Option A/B trade-off; rounds 2–3 hardened the write-time guard to genuine atomicity and fixed the
dedup mechanism; round 4 found a real cross-router overlap requiring a scoped change to existing
`mapping.ts` code, plus a false automatic-retry claim; round 5 found an R2-immutability risk and a
narrow route-miss race, both now declared as explicit v1 limitations rather than silently ignored.

## What's actually happening (confirmed against live prod D1, not guessed)

`225-227 Victoria Road` (`979a46dd-999f-4ef7-b523-fb0bb383f41f`) has an **explicit** AutoHDR
handoff — `workflow_id: "autohdr-send-3a86cb59-..."` (the `autohdr-send-` prefix is
`claimAutoHdrHandoff()`'s own naming, confirming this came from a real "Send to AutoHDR" click,
not implicit detection), `state: "started"`, mapping `state: "active"`,
`final_path: ".../04-FINAL-Photos"`. Two `fetch_edited` jobs already succeeded from that path.

This is **not a bug** in the sense of something behaving contrary to its own design — it's the
implicit-scaffolding plan's `04-MANUAL-Photos` monitoring working exactly as specified: the
manual-drop router (`workers/background/src/autohdr/routers.ts`,
`routeAutoHdrManualDropDelta`/`routeImplicitFolders`) only matches a project via
`NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ...)` — **any** handoff at all,
regardless of state, excludes a project from implicit detection. That's correct for its original
purpose (auto-detecting a project that bypassed the "Send to AutoHDR" button entirely), but it
means a project that WAS explicitly sent gets zero `04-MANUAL-Photos` coverage, forever, even
though nothing about having an active handoff should make manually-placed content invalid — a
studio might get some frames back from AutoHDR automatically and supplement others by hand for the
same shoot.

**Goal of this plan:** let `04-MANUAL-Photos` be monitored and fetched for a project that already
has an active explicit (or implicit) handoff, as a genuinely parallel source alongside
`04-FINAL(S)-Photos` — not instead of it.

## The real architectural obstacle (found by reading `finals.ts`, not assumed)

The obvious-looking fix — extend the manual router to also match projects with an active handoff,
and route a `04-MANUAL-Photos` file through the exact same `claimAutoHdrFetch()` /
`AutoHdrFetch.runClaimed()` / `writeAutoHdrFinal()` machinery the FINAL/FINALS path already uses —
**does not work as a drop-in reuse**, and would silently quarantine every manual file if attempted
naively. `writeAutoHdrFinal()` (`workers/background/src/autohdr/finals.ts`) enforces this in
several places, confirmed by direct read (**Terra round-1 correction:** citations corrected —
path-containment check at `:109`, JS-level fence at `:137-141`, replay-path SQL fence at
`:167-169`, insert-path SQL fence at `:217-222`; the replacement branch reuses the same
`baseInsert` at `:262` rather than having its own separate fence, and `:244` is only the
stage-advancement UPDATE, not a fence check): the fetch context's `finalPathKey` **exactly
equals** the mapping's own single stored `autohdr_output_mappings.final_path_key` — the one
canonical path that resolved for that generation (`04-FINAL-Photos` **or** `04-FINALS-Photos`,
never both, by design — see the original plan's collision handling). Passing a `04-MANUAL-Photos`
path as `finalPathKey` while the mapping's real `final_path_key` still says `04-FINAL-Photos`
would fail the JS-level fence at `:137-141` (`fence.finalPathKey !== context.finalPathKey`) for
every single file, correctly quarantining them as "Final writer fence changed after routing" —
which is the fence doing exactly its job (this is deliberate, carefully-reviewed anti-staleness
protection, not a bug to route around).

This means the fix genuinely requires a design decision, not just a router change. Two real options:

### Option A — widen the fence to accept a registered manual candidate

`autoHdrPathClaims.candidate` already has a `"manual"` enum value (added for the original implicit
plan, unused for an explicit-handoff project today). Extend `writeAutoHdrFinal()`'s fence to accept
`context.finalPathKey` matching **either** the mapping's own `final_path_key` **or** an
`autohdr_path_claims` row with `candidate = 'manual'`, `state = 'active'`, for that same
`mapping_id` — i.e., a project's mapping gains a second, parallel accepted source path instead of
exactly one.

- Requires: a new "ensure manual path claim" step (mirroring the collision/tombstone-reactivation
  handling `claimImplicitAutoHdrHandoff()` already has for its own path claims) that creates this
  row the first time a project with an active handoff needs one; and modifying `finals.ts`'s fence
  — the JS check at `:137-141` **and** the SQL-embedded `WHERE ... final_path_key = ?` clauses at
  `:167-169` and `:217-222` (the replacement branch at `:262` reuses the same `baseInsert`, so
  fixing the insert-path clause covers it too) — to accept the widened match instead of a single
  bound value. **Terra round-1 correction:** this option's scope is larger than the router/writer
  alone — `mapping.ts:79-102`'s `routeAutoHdrDelta()` already treats any `autohdr_path_claims` row
  (including `candidate = 'manual'`) as a collision candidate for the explicit FINAL/FINALS router;
  adding an active `manual` path claim under Option A could cause `routeAutoHdrDelta()` to
  misidentify it as a competing candidate and block an otherwise-valid mapping. Confirmed by
  reading `mapping.ts:60-110` directly.
- **Risk:** `finals.ts` is deliberately hardened, multi-round-reviewed, atomic-fence-protected code
  (`docs/lessons.md`'s "insert-then-fence races" and "D1 error-shape" lessons trace back to exactly
  this file's lineage). Loosening its central invariant — "exactly one accepted path per
  mapping" — is real surgery on code that earned its correctness the hard way, not a small tweak.
- **Benefit:** manual content gets the SAME replace/supersede/quarantine/coverage-tracking
  machinery FINAL/FINALS content gets — same-hash replay detection, RAW↔Edited coverage matching,
  content-hash-based superseding if a manual file is re-dropped with different content, all for
  free.

### Option B — a separate, simpler ingest path, deliberately not touching `finals.ts`

Don't route manual-supplement content through `writeAutoHdrFinal()`/the fence at all. Build a new,
smaller ingest function specifically for this scenario — reusing the *sound, genuinely reusable*
parts of the existing pattern (download → R2 write → `assets` insert → `enqueueRenditionSafely`)
for idempotency across repeated delta scans — but with its **own**, simpler guard: project not
archived, stage in `('editing_autohdr', 'edited_review')`, handoff still `started`.
(**Terra round-3 correction:** this summary previously named `editedSourceClaims` as the dedup
mechanism; §2 below replaces that with the two actual backstops — the `assets_current_source_unique`
index and a new `asset_ingest_identities` reservation — see §2 for the full design.) No attempt to
integrate into the mapping's single-canonical-path fence, no replace/supersede-by-content-hash
logic (a manual re-drop with the same filename can just be treated as a distinct new source path
if that's simpler — implementer/Terra judgment call), no `autohdr_final_associations`
RAW↔Edited-coverage matching (manually-placed content has no reliable way to establish that
coverage relationship, unlike AutoHDR's own delivery which processes exactly the selected RAW set).

- **Risk:** some real logic duplication between this and `writeAutoHdrFinal()` — dedup pattern,
  R2/D1 write shape. Smaller surface than Option A, but not zero.
- **Benefit:** zero changes to `finals.ts`'s hardened fence. The new function is small, its own
  correctness is independently reviewable without re-litigating the existing file's invariants,
  and a bug in it can't corrupt the FINAL/FINALS path's behavior.

**Recommendation: Option B.** The manual-supplement scenario is semantically different enough from
AutoHDR's own canonical delivery (no coverage-matching guarantee, no single-source-of-truth
assumption, genuinely ad-hoc) that forcing it through machinery built around "exactly one
authoritative path per generation" is fighting the existing design rather than extending it
naturally. The safety framework this project already follows (`docs/Subagent-Orchestration.md` §5,
`docs/lessons.md`'s repeated emphasis on verifying fence/race logic directly) argues for the
smaller, independently-reviewable blast radius over reusing hardened code for a case it wasn't
designed for. **This is a real trade-off, not a foregone conclusion — flagging both options for
Terra's review and the user's own read rather than silently deciding.**

## Proposed design (Option B, in detail)

### 1. New router pass: manual-supplement delta

New function alongside the existing routers in `workers/background/src/autohdr/routers.ts` —
`routeAutoHdrManualSupplementDelta(env, connectionId, entries)` — same `directChildFiles(entries,
new Set(["04-manual-photos"]))` filtering `routeAutoHdrManualDropDelta` already uses, but the
opposite eligibility predicate: matches a project via its active scaffold claim **only when** it
**has** an active handoff (`autohdr_handoffs.state = 'started'`), whose mapping is
`state = 'active'` — **Terra round-3 correction:** `mapping.ts:98-100` actually permits
`pending_discovery` **or** `active` for the explicit router; the supplement router requires only
`active` (a mapping still pending discovery has no confirmed canonical path yet, which is
irrelevant to this router but worth stating precisely rather than implying full alignment). So:
same handoff predicate as `routeAutoHdrDelta`, but only the `active` subset of its mapping
predicate, with the stage predicate separately widened to two values; `mapping.ts:96-101`'s
explicit router permits only `editing_autohdr` and stays that way (it's routing FINAL/FINALS
content into an in-flight delivery, not a post-delivery supplement) — and whose project
`stageKey` is `editing_autohdr` **or** `edited_review`
(**Terra round-1 correction:** the router's stage predicate must match the writer's — see the
ingest function's guard below; a project that already completed its AutoHDR delivery and sits in
`edited_review` is exactly the case this plan's own motivating example targets, so excluding it
here would be an accidental gap, not a deliberate scope decision). A `blocked` handoff or
`blocked_collision` mapping is explicitly excluded — matching the existing collision semantics,
don't layer a manual fetch on top of an already-blocked mapping.

This does **not** call `claimImplicitAutoHdrHandoff()` (no new handoff needed — one already
exists) and does **not** call `claimAutoHdrFetch()`/`AutoHdrFetch.runClaimed()` (Option B avoids
the fence entirely) — it directly enqueues the new ingest function per matched file/folder, passing
along the resolved `mappingId` (see the ingest function's guard below — the write-time fence needs
it, not just the project/handoff ids).

**Terra round-4 correction — required change to existing code, not additive-only:** a project that
went through the **implicit** manual-drop path (auto-detected via `routeAutoHdrManualDropDelta`,
no explicit "Send to AutoHDR" click) ends up with an active handoff, an active mapping, **and** an
active `autohdr_path_claims` row with `candidate = 'manual'` registered against that mapping —
this is how the original implicit-scaffolding plan already works. From that point forward, that
project satisfies BOTH this new supplement router's eligibility (active handoff + active mapping)
AND `routeAutoHdrDelta()`'s claim-matching query (`mapping.ts:96-102`'s `WHERE` clause selects
claims by `state IN ('pending','active')` with no filter on `candidate` — confirmed by direct
read), because `matchingClaimRoutes()` (`mapping.ts:38-51`) matches path prefix against **any**
claim regardless of candidate type. A later `04-MANUAL-Photos` drop for such a project would be
matched and processed by **both** routers simultaneously. **Fix (requires touching existing code):**
restrict `routeAutoHdrDelta()`'s `WHERE` clause at `mapping.ts:96-102` to
`inArray(autoHdrPathClaims.candidate, ["final", "finals"])`, so the explicit router never
considers `manual`-candidate claims — leaving this new supplement router as the sole path for
`04-MANUAL-Photos` content once any handoff exists, matching its actual purpose (that router was
never meant to route manual-folder content in the first place; today it happens to work only
because no project has both a registered `manual` claim and new activity through that router at
the same time — this plan's own feature is what first creates that overlap). This is a genuine,
narrow modification to `mapping.ts`, not just new additive files — see the corrected "Files
touched" section below.

### 2. New ingest function (avoiding `finals.ts`'s fence, per Option B)

New function, suggested location `workers/background/src/autohdr/manual-supplement.ts`:

```ts
export type ManualSupplementDependencies = {
  download?: typeof download;
  beforeBatch?: () => void | Promise<void>;
};

export async function ingestManualSupplement(
  env: Env,
  projectId: string,
  handoffId: string,
  mappingId: string,
  connectionId: string,
  file: DropboxFile,
  dependencies: ManualSupplementDependencies = {},
): Promise<
  | { status: "created" | "already_ingested"; assetId: string }
  | { status: "skipped" }
> {
  // Re-check eligibility at write time, not just at routing time — the same TOCTOU discipline
  // finals.ts's fence exists for, just scoped down to what this simpler path actually needs.
  // ...
}
```

**Terra round-4 correction:** the result type must distinguish a guard-rejected write from a
success — `{ status: "skipped" }` carries no `assetId` (there is none). The `dependencies` type is
now explicit rather than implied: `beforeBatch` (a test-only seam, mirroring `finals.ts`'s
`FinalWriteDependencies.afterR2Write` pattern) must be invoked immediately before the
`env.DB.batch()` call, after the R2 write has already happened — so a test using it can mutate D1
state at the exact moment the embedded guard is about to evaluate it, proving the guard (not an
earlier read) is what rejects the write. `enqueueRenditionSafely()` must **never** be called for a
`"skipped"` result — only for `"created"` (and, per the existing dedup design, `"already_ingested"`
still re-enqueues, matching `finals.ts`'s own same-hash-replay behavior of re-enqueueing an
idempotent rendition job).

**Terra round-1 correction:** the write-time guard was under-specified ("`// ...`") for a
correctness-critical writer — the plan must state its exact predicate up front, matching the
rigor `finals.ts`'s own fence was held to. **Terra round-2 correction:** a preceding `SELECT`
re-bound into the batch is still not atomic — a write can land between the `SELECT` and the batch.
The guard must instead be the `WHERE EXISTS (...)` clause of the first-and-only unconditional
`INSERT` in the batch (the `assets` insert itself, matching exactly how `finals.ts:217-222`'s
`baseInsert` embeds its own fence), so the guard and the write it protects are the same atomic D1
statement. The `WHERE EXISTS` subquery must verify, joined across `projects`/`autohdr_handoffs`/
`autohdr_output_mappings`/`autohdr_scaffold_claims`:

- the project (`projectId`) is not archived and its `stage_key` is `editing_autohdr` or
  `edited_review`;
- the handoff (`handoffId`) belongs to that project and connection, and its `state` is `started`;
- the mapping (`mappingId`) belongs to that handoff and is `state = 'active'` (mirrors
  `finals.ts:137-141`'s `mappingState`/`handoffState` checks, scoped to what this path needs —
  no `manifestVersion`/`mappingGeneration`/`mappingConnectionId` pinning, since this path isn't
  frozen against a specific fetch claim generation the way `writeAutoHdrFinal()` is);
- the scaffold claim for this project/connection (`autohdr_scaffold_claims`, `state = 'active'`)
  still owns the `04-MANUAL-Photos` parent path the file was observed under (guards against a
  scaffold being retired between routing and write).

If `changes() === 0` after this insert attempt, treat it as "guard failed, skip" (log/metric, not
a hard error — a project moving stage or archiving mid-scan is an expected race, not a bug) unless
a unique-conflict error indicates the file was already ingested (see dedup below) — the two
outcomes are distinguished by error shape, not by a separate follow-up query. No `finals.ts`-style
quarantine table: this simpler path just doesn't write.

**Terra round-4 correction — the original "picked up again on the next delta if still eligible"
claim was false, and is removed.** Confirmed by reading `dropbox-sync.ts:155-159` directly: the
Dropbox delta cursor is committed unconditionally after the routing/ingest loop completes (unless
something throws), regardless of whether an individual file's write-time guard returned a skip.
Dropbox delta cursors are forward-only — a skipped file's delta entry will **not** be re-served on
a later scan unless the file changes again in Dropbox (a fresh upload, a touch, anything that
produces a new delta entry). So a guard skip is a one-shot decision for that particular delta
observation, not an automatic retry. This is an acceptable v1 limitation given what actually causes
a skip: every guard predicate above (archived, stage, handoff state, mapping state, scaffold-claim
state) is normally a **stable, non-flapping** per-project state in this codebase — a genuine
same-scan TOCTOU race where eligibility flips true→false→true within the few-hundred-millisecond
window between routing and the write is expected to be rare in practice, and the common case for a
guard failing is a permanent state change (project archived, handoff blocked) where "don't retry"
is the *correct* behavior, not a bug. Building a durable per-file retry/reconciliation mechanism to
cover the rare transient case would meaningfully grow this feature's footprint — deliberately not
done here (matches Option B's own stated preference for a smaller blast radius over completeness);
if this proves to matter in practice, staff can work around it by re-touching the file in Dropbox
to produce a fresh delta entry. Captured as a Non-Goal below, not left as an implicit gap.

- **Dedup (Terra round-1 correction — replaces the original `editedSourceClaims` proposal;
  Terra round-2 correction — explicit batch order and conflict handling):**
  use `asset_ingest_identities` (`packages/db/src/schema.ts:553-567`,
  `uniqueIndex("asset_ingest_identities_collection_key_unique").on(collectionId, identityKey)`)
  with `identityKey = "manual-supplement:" + sourcePathKey` as the dedup key. **Batch order matters
  because `asset_ingest_identities.asset_id` is a non-null FK to `assets.id`
  (`schema.ts:553-565`):** (1) the `assets` insert (carrying the write-time guard as its
  `WHERE EXISTS` clause, per above) must run **first**; (2) the `asset_ingest_identities` insert
  runs second, as `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM assets WHERE id = ? AND
  <this batch's own r2_key/content_hash>)` — chained off the first statement's success the same
  way `finals.ts:219-220`'s `edited_source_claims` insert chains off `WHERE changes() = 1`; (3)
  the collection-count and audit-log statements run last, each gated the same way. Two independent
  unique-conflict sources can reject step (1) or (2): the `assets` table's own
  `assets_current_source_unique` index (`schema.ts:349-350`, `(collection_id, source_path_key)
  WHERE superseded_at IS NULL AND source_path_key IS NOT NULL`) can reject the step-(1) insert
  directly; `asset_ingest_identities_collection_key_unique` can reject step (2) even if step (1)
  nominally "succeeded" in a prior partial attempt (the batch is atomic, so a step-(2) rejection
  rolls back the step-(1) insert too — no orphaned `assets` row is left behind). **Either conflict
  means "already ingested," but the winner lookup differs by which constraint fired**
  (**Terra round-3 correction:** the original text incorrectly said to resolve both conflict kinds
  through `assets_current_source_unique` — that's wrong for the `asset_ingest_identities` case,
  since that reservation's `asset_id` is not guaranteed to be the asset currently occupying the
  `(collection_id, source_path_key)` slot):
  - a conflict on `assets_current_source_unique` (matched by cause chain on
    `assets.collection_id` + `assets.source_path_key`) → look up the winner via that same
    `(collection_id, source_path_key)` pair against `assets`, **filtered by
    `superseded_at IS NULL`** (**Terra round-4 correction:** required — the partial unique index
    itself only constrains non-superseded rows, but a plain lookup without this filter could
    return an older superseded row at the same path instead of the actual current occupant);
  - a conflict on `asset_ingest_identities_collection_key_unique` (matched by cause chain on
    `asset_ingest_identities.collection_id` + `asset_ingest_identities.identity_key`) → look up
    the winner via `asset_ingest_identities`'s own `(collection_id, identity_key)` pair and return
    **that row's `asset_id`**, not a `assets_current_source_unique` lookup.

  Either way, return `{ status: "already_ingested", assetId: <the resolved winner> }`; do not
  treat either as a hard failure. Per `docs/lessons.md:151-157`'s D1 error-shape lesson, classify
  the conflict by walking `error.cause` (not just `error.message`) and matching against exactly
  these two named constraint/column-pair shapes — any other unique-conflict shape should surface
  as a real error rather than being silently swallowed.
- **R2 write (Terra round-5 correction — key must be generated before the D1 batch and made
  per-attempt-unique):** download the file and write it to R2 **before** the D1 batch, same
  ordering as `finals.ts`. The R2 key must include the freshly-generated `assetId` for this
  attempt — e.g. `projects/${projectId}/edited/dropbox/manual-supplement/${assetId}/${file.name}`
  — **not** a key derived only from `sourcePathKey`/content hash. Reason: if two concurrent
  processing attempts for the same file race (e.g. a duplicate delta observation before the first
  attempt's D1 conflict has resolved), a key that doesn't vary per-attempt could have the second
  attempt overwrite the first attempt's still-in-use R2 object before the D1 uniqueness conflict
  ever returns `already_ingested` for it — violating [CLAUDE.md](../../../CLAUDE.md)'s "media in R2
  is never deleted... write a new immutable key" rule. Including `assetId` (generated fresh per
  attempt, before the download) guarantees no two attempts can ever target the same R2 key, so a
  losing attempt's D1 rollback simply leaves an orphaned-but-harmless R2 object rather than
  corrupting the winner's bytes.
- Insert into `assets` with `source: 'dropbox'`, `section: 'AutoHDR'`, `autohdr_handoff_id:
  handoffId`, `source_path`/`source_path_key` populated (**Terra round-1 correction:** the
  original draft omitted these two columns — every other AutoHDR-origin asset populates them, and
  `assets_current_source_unique` depends on `source_path_key` being set), `publish_status: 'ready'`.
- **Terra round-1 correction — omitted side effects, now required in the same atomic batch:**
  `COLLECTION_RECEIVED_COUNT_SQL` (as `finals.ts:241-243` does — otherwise the Edited collection's
  received-count badge goes stale), and an `audit_log` row (`action: 'autohdr.manual_supplement_imported'`
  or similar — every other AutoHDR ingest path writes audit history; this one skipping it would be
  an inconsistency, not a simplification). The `assets` insert (with its embedded guard),
  `asset_ingest_identities` insert, collection-count update, and audit-log insert must all be
  **one atomic `env.DB.batch()` call**, in the order specified above — not sequential round-trips
  — matching `finals.ts`'s own discipline (this is exactly the kind of multi-statement write
  `docs/lessons.md`'s D1-race lessons are about).
- `enqueueRenditionSafely()` afterward (outside the batch, same as `finals.ts` does), matching
  every other ingest path in this codebase.
- **Explicitly does NOT**: attempt RAW↔Edited coverage matching (`autohdr_final_associations`) —
  there's no reliable signal that a manually-dropped file corresponds to a specific selected RAW
  asset the way AutoHDR's own delivery does; **does NOT** advance project stage — stage-advance
  logic (`editing_autohdr` → `edited_review`) is keyed on "every selected RAW asset now has a
  covering edited return," which this path has no way to evaluate soundly. If this turns out to be
  a real gap in practice (staff expect stage to advance from manual supplements too), that's a
  follow-up decision, not something to guess at silently here.
- **Same-path, different-content re-drop (Terra round-1 correction — decided, not deferred):**
  v1 behavior is **first-write-wins**. If a second file lands at the same `source_path_key` after
  the first has already been ingested (different content hash or not), it's treated as
  `already_ingested` and skipped — no replacement, no error. **Terra round-2 correction:** either
  of the two independent uniqueness backstops may be the one that actually rejects the write in
  practice — most commonly `assets_current_source_unique` (the `assets` insert itself is rejected
  before `asset_ingest_identities` is ever reached), but a partial-prior-attempt state could
  instead surface via `asset_ingest_identities_collection_key_unique` — the ingest function must
  treat both as equivalent "already ingested" outcomes, not assume only one can fire. This is a
  declared v1 limitation (a studio re-dropping a corrected file at the exact same manual-supplement
  path won't see the update propagate automatically), not an unspecified judgment call; a future
  round can add content-hash-aware replacement if this proves to matter in practice.

### 3. Wiring into the DO alarm

`workers/background/src/do/dropbox-sync.ts:124-156`'s existing three-pass loop
(`explicitRouted`/`manualRouted`/`providerRouted`, flattened into `allRoutes`, each fed through
`claimAutoHdrFetch`+`startClaimedFetch`) gets a **fourth, structurally different** pass — this
one's matches don't produce `RoutedAutoHdrMapping` objects for the shared claim/fetch loop, they go
straight to `ingestManualSupplement()` per matched file, paced the same way the existing loop
already paces its Dropbox calls (the existing `250ms` stagger between iterations,
`dropbox-sync.ts:147`).

**Terra round-1 correction — the original mutual-exclusion claim was wrong; precedence matters.**
Verified by reading `dropbox-sync.ts:110-153` directly: within one delta-page handling call, the
existing `manualRouted = await routeAutoHdrManualDropDelta(...)` call (line ~128) doesn't just
*read* state, it can *write* a new active handoff via `claimImplicitAutoHdrHandoff()` as part of
routing, synchronously, before the function returns. If the new supplement pass were appended
**after** `manualRouted`/`providerRouted` (the natural-looking place to add a fourth call), a
project with **no** prior handoff could get one created by `manualRouted` mid-scan, and the new
supplement pass — querying for "active handoff" moments later in the same scan — would then also
match the same `04-MANUAL-Photos` file the implicit path just claimed, double-processing it through
two different ingest mechanisms. **Fix: the new supplement pass must run FIRST**, before
`routeAutoHdrDelta`, `routeAutoHdrManualDropDelta`, and `routeAutoHdrProviderDelta`, so it only ever
observes handoff state as it stood **before any later in-call router mutation** (**Terra round-2
correction:** this is an ordering guarantee within one delta-page handling call, not a database
snapshot — it does not protect against an unrelated concurrent writer changing handoff state at
the same moment from outside this call). This ordering restores the mutual exclusivity the
original (incorrect) claim assumed for free, for the specific hazard identified (the manual-drop
router creating a handoff mid-scan), without claiming to eliminate every possible race. The build
round must add a regression test exercising this exact ordering — a project with no handoff, a
`04-MANUAL-Photos` file present, asserting the supplement pass does not match and the implicit
path proceeds normally afterward within the same simulated scan.

**Terra round-5 correction — the write-time guard does NOT cover every residual race; one gap is
undefended and must be declared, not implied-away.** Round 2's text claimed the write-time guard
in §2 catches "that residual race" from an external concurrent writer — this is only true for a
file that some pass actually routed. It is **not** true for a narrower, real gap: if an external
writer creates the project's handoff at the precise moment **between** the supplement pass's query
running (finds no handoff yet, doesn't match) and the existing `routeAutoHdrManualDropDelta()`'s
`NOT EXISTS` query running moments later (now finds a handoff, so also doesn't match — `NOT EXISTS`
is now false), **neither** router matches that file for that delta observation. The write-time
guard never runs at all in this case, because the file was never routed to any ingest function in
the first place — the guard can only protect a file that was routed, not catch one that no router
picked up. Combined with the cursor committing unconditionally (see the ingest function's own
declared limitation above), this specific file's delta entry is then gone for good unless it
changes again in Dropbox. **This is declared as a one-shot v1 limitation, not fixed by a
reconciliation pass** — the window is a single query-to-query gap within one delta-page handling
call (sub-millisecond in practice), and building cross-pass reconciliation to close it would be
disproportionate to a race this narrow; captured explicitly in Non-Goals below rather than left
implicit.

### 4. Frontend

None needed — this ingests directly into the existing Edited collection via the same `assets` table
shape every other AutoHDR-origin asset uses; `PhotoGrid`/`Lightbox`/the Edited tab all already
render whatever's in that collection with no changes.

## Non-goals for this round

- **Option A (fence-widening) is not being built in this round** — captured above as the
  alternative for the record, not pursued given the recommendation, unless Terra's review or the
  user prefers it after weighing the trade-off.
- **Stage-advance from manual-supplement content.** As noted in the ingest function's spec — no
  reliable coverage-matching signal exists for manually-dropped content, so this plan does not
  attempt it. A project stays in `editing_autohdr` until its real AutoHDR-delivered coverage is
  complete, exactly as today; manual supplements land as extra Edited content without being able to
  finish the stage transition on their own.
- **Replace/supersede semantics for a manual file dropped twice with different content.**
  (**Terra round-1 correction:** decided, not deferred — see the ingest function's spec above.)
  v1 is explicitly first-write-wins: a second file at the same `source_path_key` is skipped
  regardless of content. Content-hash-aware replacement is a real future gap, not pursued here.
- **Retroactive backfill** for projects that already have manual-photos content sitting unfetched
  (like `225-227 Victoria Road` right now). This plan covers the ongoing webhook-driven case only —
  **`225-227 Victoria Road`'s already-dropped file remains unfetched after this plan ships**, until
  a separate operator action runs (manually triggering a one-off delta scan, or a small operator
  endpoint, once this plan's ingest function exists to call). That follow-up is not scoped here.
- **Automatic retry of a write-time guard skip (Terra round-4 correction — new, was an implicit
  gap before):** as detailed in §2's ingest function spec, the Dropbox delta cursor commits
  unconditionally regardless of a per-file guard skip, and delta cursors don't replay unchanged
  entries — so a skip is a one-shot outcome for that observation, not an automatic future retry.
  A durable per-file retry/reconciliation mechanism is not built in this round; a skip caused by a
  genuine transient race (rare, given the guard's predicates are normally stable, non-flapping
  per-project state) requires the file to be re-touched in Dropbox to produce a fresh delta entry.
- **Cross-pass route-miss reconciliation (Terra round-5 correction — new, was an implicit gap
  before):** as detailed in §3's wiring section, an external writer creating a project's handoff
  in the narrow query-to-query window between the new supplement pass's routing query and the
  existing manual-drop router's `NOT EXISTS` query (both within the same delta-page handling call)
  can cause **neither** pass to match a file — the write-time guard cannot catch this, since it
  only runs for files that were actually routed. Combined with unconditional cursor commit, that
  file's delta entry is lost for that observation. Not fixed by reconciliation in this round: the
  window is a single sub-millisecond query gap, and cross-pass reconciliation logic would be
  disproportionate to how narrow and rare this race is. Same workaround as the guard-skip
  limitation above: a fresh Dropbox delta event (re-touching the file) recovers it.

## Files touched (implementation phase, not this planning round)

- `portal/workers/background/src/autohdr/routers.ts` — new `routeAutoHdrManualSupplementDelta`.
- `portal/workers/background/src/autohdr/manual-supplement.ts` (new file) — `ingestManualSupplement`.
- `portal/workers/background/src/do/dropbox-sync.ts` — wire the fourth pass into the alarm loop,
  running it **first**, before the three existing router calls (see §3).
- **Terra round-4 correction — this is no longer additive-only:**
  `portal/workers/background/src/autohdr/mapping.ts` — `routeAutoHdrDelta()`'s claim-selection
  `WHERE` clause (`:96-102`) must be narrowed to `candidate IN ('final', 'finals')`, so it stops
  considering `manual`-candidate claims once this plan's new router exists (see §1's detailed
  explanation of the overlap this prevents). This is the one genuine modification to existing,
  previously-hardened AutoHDR code this plan requires; it's a narrow, additive-to-a-`WHERE`-clause
  change, not a rewrite, and does not touch `finals.ts`, `claims.ts`, or `workflows/autohdr-fetch.ts`
  — those three stay exactly as built.
- No schema, no migration (Option B doesn't need the new path-claim row Option A would have).
- No frontend changes.

## Verification approach (for the eventual build round)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web` must be green, as
  always. **Terra round-1 correction:** also run the full test suites required by
  [CLAUDE.md](../../../CLAUDE.md) before considering the build round done — `npm run test
  --workspaces` **and**, separately, `npx vitest run --config packages/shared/vitest.config.ts`
  (the former silently misses `packages/shared`).
- New test coverage in `workers/background/test/` for `ingestManualSupplement()` and the new
  router pass, expanded per Terra's round-1 review beyond the original list:
  - fresh file ingests once, with `COLLECTION_RECEIVED_COUNT_SQL` and an `audit_log` row both
    present afterward;
  - re-scanning the same delta a second time is a no-op (idempotency via `asset_ingest_identities`);
  - a project whose handoff is `blocked` (or mapping `blocked_collision`) is never matched;
  - a project whose handoff doesn't exist at all still only matches the EXISTING manual-drop
    router, never this new one — **and specifically, a regression test for the ordering fix**:
    within one simulated delta-page handling call, a project with no prior handoff and a
    `04-MANUAL-Photos` file present must not be matched by the supplement pass, only by the
    existing implicit path, when the supplement pass runs first per the corrected wiring;
  - a project in `edited_review` (not just `editing_autohdr`) is matched by both the router and
    the writer's guard;
  - a missing/retired scaffold claim at write time causes a skip, not a write;
  - an archived project, or one that changed stage/handoff/mapping/scaffold-claim state, between
    routing and the batch call executing is refused (**Terra round-2 correction:** this test must
    exercise the guard itself, not a separate preflight check — mutate state after routing has
    already resolved the route but before `ingestManualSupplement()`'s batch runs, and assert the
    embedded `WHERE EXISTS` in the `assets` insert is what rejects the write, proving the guard is
    atomic with the write rather than a stale earlier read. **Terra round-3 correction:** this
    requires a deterministic test seam — `ingestManualSupplement()`'s `dependencies` parameter
    (mirroring `finals.ts`'s own `FinalWriteDependencies` pattern of injectable hooks like
    `afterR2Write`) should include a `beforeBatch` hook the test can use to mutate D1 state at the
    exact moment between routing and the batch call, so the test provably targets the embedded
    guard rather than accidentally passing via an earlier preflight check that doesn't exist);
  - two files landing at the same `source_path_key` (same delta or a later one) — the second is
    skipped, first-write-wins, with a test asserting no error and no duplicate asset;
  - **Terra round-2 correction — split into the two independent conflict sources, not one
    generic test:** (a) an existing current asset at that `source_path_key` with **no**
    corresponding `asset_ingest_identities` row (simulating a pre-existing/legacy asset or a
    partial prior attempt) — exercises `assets_current_source_unique` rejecting the `assets`
    insert directly, resolved to `{ status: "already_ingested", assetId: <the pre-existing
    asset's id> }` via the `(collection_id, source_path_key)` lookup against `assets`; (b) an
    existing `asset_ingest_identities` reservation at that identity key pointing at a **different**
    `asset_id` than whatever currently occupies the `(collection_id, source_path_key)` slot (or no
    asset occupying that slot at all) — exercises `asset_ingest_identities_collection_key_unique`
    rejecting the second insert, and (**Terra round-3 correction**) the test must assert the
    resolved `assetId` is looked up via `asset_ingest_identities`'s own `(collection_id,
    identity_key)` — i.e. the reservation's own `asset_id` — not via `assets_current_source_unique`,
    proving the two lookups aren't conflated.
  - **Terra round-4 correction — new tests for the `mapping.ts` overlap fix and the result/cursor
    corrections:** (a) a project with an active handoff and an active `candidate = 'manual'` path
    claim (the state an implicitly-adopted project ends up in) — a `04-MANUAL-Photos` drop must be
    matched **only** by the new supplement router, and `routeAutoHdrDelta()` must not also match it
    once its `WHERE` clause is narrowed to `candidate IN ('final', 'finals')`; (b) a guard-rejected
    write returns `{ status: "skipped" }` with no `assetId`, and `enqueueRenditionSafely()` is
    asserted **not** called for that result; (c) the winner lookup for the `assets_current_source_unique`
    conflict path excludes a superseded row at the same `(collection_id, source_path_key)` and
    returns the actual current occupant instead.
- Manual verification against `225-227 Victoria Road` itself once built (it's already in exactly
  the state this plan targets) — drop a file into its `04-MANUAL-Photos`, confirm it appears in the
  Edited collection without needing "Send to AutoHDR" run again or any button press. Note per the
  Non-Goals section: the file already dropped there before this ships will **not** retroactively
  appear — that drop needs a fresh delta (a new file drop, or a future backfill operator action).
