# Master implementation sequencing plan (2026-07-24)

> **Status: READY FOR TERRY'S REVIEW.** Nothing described here has been built. This document
> exists to answer: in what order, by whom (which subagent), and with what dependencies do we
> implement everything currently queued up. Once approved, each wave below is handed to the
> Agy-drafts → Sol-reviews → Terra/Luna-builds → Sol-reviews-diff loop in
> `docs/Subagent-Orchestration.md`.

## What's being sequenced

| # | Item | Doc | Scope |
|---|---|---|---|
| 1 | Dropbox Webhook Automation | `docs/plans/implemented/Dropbox-Webhook-Automation-Plan.md` | Large — new DO monitor split, claim/mapping tables, AutoHDR versioning, retires legacy cron |
| 2 | Staff routing + deep links | `docs/plans/implemented/staff-routing-and-deep-link-plan.md` | Frontend-only SPA router + narrow Worker `/d/*` reservation |
| 3 | Capture-count manifest verification | `docs/plans/implemented/capture-count-manifest-verification-plan.md` | Fixes false "Capture count needs attention" banner |
| 4 | Cloudflare Images pilot | `docs/plans/Cloudflare-Images-Pilot-Plan.md` | **Deprioritized** — outage that motivated it resolved; not a cost saving. Conditional on Terry's go-ahead. |
| 5 | R2 rendition purge on project delete | new, this doc | Bugfix — renditions leak into R2 forever on delete |
| 6 | Mirror manual uploads to Dropbox | new, this doc | Gap — manual RAW/Edited uploads have no Dropbox backup copy |

Items 5 and 6 were discovered today (2026-07-24) and are recorded in `docs/todo.md`; they don't
have standalone plan docs yet because they're small enough to spec inline below.

## Prerequisite gate — SATISFIED (2026-07-24)

**D1 migration ledger reconciliation — done.** Checked the actual production `d1_migrations`
table directly (not inferred from docs): **`0000`–`0011` are all applied to prod.** This is
better than the previously-documented "only 0000–0003 confirmed" — that was stale. **Next
available migration number is `0012`.**

One loose end, not a blocker: this branch/worktree's local `packages/db/migrations/` only has
files through `0010` — migration `0011_dapper_tarantula.sql` (adds `rendition_dlq_events`,
from the separately-merged DLQ-monitoring fix, PR #9 on `main`) isn't in this working tree yet.
Since every wave below branches fresh off `main` anyway (see "Working-agreement notes"), each
builder will have `0011` present automatically — no action needed except **do not generate a
new migration from this stale branch**; generate it from a fresh `main` checkout so Drizzle
sees `0011` as the predecessor and correctly numbers the new one `0012`.

Production and staging `sqlite_master` table lists were also captured directly; no legacy-data
irregularities (duplicate RAW identities, orphaned AutoHDR claims, etc.) were checked in this
pass since none of the queued waves' migrations touch those tables — re-run that specific check
if Wave 3 (Dropbox Webhook Automation, which does touch AutoHDR claim state) needs it.

**This gate no longer blocks Wave 2 or Wave 3.**

## Wave 1 — start immediately, fully parallel, no shared files, no migrations

### 1a. Staff routing + deep links (item 2)

- **Builder:** Terra. **Reviewer:** the plan document itself already mandates both Agy and Sol
  review the *final plan* before implementation begins ("Cross-review before implementation"
  section) — this already matches the current Agy-drafts/Sol-reviews convention, since the
  plan is fully drafted. Run that review pass first (Agy + Sol, both read-only, both
  challenging route grammar/OAuth-destination-validation/`/d/*` isolation per the plan's own
  instruction), then Terra builds, then a fresh Sol reviews the diff.
- **Why it's independent:** pure frontend (`apps/web/src/lib/router.ts`, `App.tsx`, screen
  components) plus one narrow, session-free Worker 404 reservation. No D1 migration, no
  Background Worker or webhook changes. Explicitly stated in the plan itself.
- **Risk note:** the plan's own "Critical constraints and risks" section (staging OAuth
  feasibility, `/d/*` isolation, no open redirects) should be treated as blocking acceptance
  criteria, not nice-to-haves.

### 1b. R2 rendition purge on project delete (item 5, new)

**Spec:** `DELETE /projects/:id` ([projects.ts:333-366](../portal/workers/app/src/routes/projects.ts))
purges R2 only under `projects/${id}/` (line 351). Rendition objects are keyed by **asset ID**,
not project ID — `renditions/${assetId}/${contentHash}/${specVersion}/${variant}/${digest}.${ext}`
(`renditionR2Key()` in `packages/shared/src/media.ts`) — so this purge has never reached them.
Confirmed by Terry manually wiping both R2 prefixes to reclaim space.

**Fix, two parts:**
1. **Going forward:** before the D1 cascade deletes asset rows (currently line 364 deletes the
   project, cascading to collections/assets), enumerate the project's asset IDs and additionally
   list+delete `renditions/<assetId>/` for each one, folded into the same paginated purge loop
   that already exists for `projects/${id}/`.
2. **Backfill (one-off, separate from the code fix):** every project deleted since renditions
   launched has orphaned rendition objects with no D1 reference to find them by a normal query —
   they can only be found by diffing all `renditions/<assetId>/...` R2 keys against currently-
   existing asset IDs in D1. Decide whether this is worth doing given R2's low per-GB cost
   (per the Cloudflare Images plan's cost analysis, total rendition storage for all 401 current
   assets is roughly 29MB — trivial) — likely not worth a risky bulk-delete script for legacy
   cleanup; flag as a Terry decision, default to "don't bother," fix going forward only.

- **Builder:** Terra (not Luna — this is destructive-operation logic; the blast radius of a
  scoping bug is data loss for *other* projects' renditions). **Reviewer:** Sol, explicitly
  asked to verify the deletion scope can never match another project's `renditions/` keys
  (asset IDs are UUIDs so cross-project collision isn't plausible, but verify the enumeration
  happens *before* the D1 cascade, not after — asset rows must still exist in D1 when the R2
  keys are being enumerated).
- **Tests required:** deleting a project purges both its `projects/` and all its assets'
  `renditions/` objects; deleting one project never touches another project's rendition
  objects; a project with assets that have zero renditions (never generated) deletes cleanly.

## Wave 2 — needs the prerequisite gate; bundle these two together

### 2a. Capture-count manifest verification (item 3) + mirror manual uploads to Dropbox (item 6)

**Why bundled:** both touch the exact same files (`uploads.ts`'s `/uploads/complete` handler,
`ingest.ts`'s `finalizeIngest`) and both need new D1 columns. Building them together avoids two
separate migrations landing back-to-back on the same hot path, and avoids the awkwardness of
whoever ships second having to rebase around the first's schema change mid-flight.

**2a-i. Capture-count fix:** full spec already in `docs/plans/implemented/capture-count-manifest-verification-plan.md`
(the durable `assets.manifest_id` + manifest lifecycle design, v3 — do not resurrect v1/v2,
both were independently rejected with reasons recorded in that doc).

**2a-ii. Dropbox mirror for manual uploads (item 6, new):**

**Spec:** Only manual **Edited** uploads publish to Dropbox today
(`publishManualEditedUpload`, gated on `data.collection === "edited"` at
[uploads.ts:66](../portal/workers/app/src/routes/uploads.ts)). Manual **RAW** uploads have no
equivalent — they land in R2 only. Extend the same publish-workflow pattern
(`ManualEditedPublish` in `workers/background/src/workflows/manual-edited-publish.ts`) to cover
manual RAW uploads too, generalizing it if needed rather than duplicating it.

**Open design question (Terry's call, needed before this starts):** what Dropbox destination
path should manual RAW uploads mirror to? Recommend something structurally parallel to the
existing Edited convention (`/AutoHDR/<listing>/Manual-Uploads/<asset-id>/<filename>`) but
**deliberately outside both `/Tonomo/Raw Files` and `/AutoHDR`** — e.g.
`/Manual-Uploads/<listing>/RAW/<asset-id>/<filename>` — so it does **not** fall under either of
the Dropbox Webhook Automation plan's root-scoped monitors (Wave 3, below) and can't trigger
spurious auto-reconciliation of a folder the automation wasn't watching for that reason.

- **Builder:** Sol (migration-class work). **Reviewer:** a separate, fresh Sol run.
- **Blocking questions before build starts** (all Terry's product calls, not technical):
  1. Abandoned partial-batch lifecycle (already flagged in the capture-count plan).
  2. Dropbox+manual-upload hybrid banner behavior (already flagged in the capture-count plan).
  3. The Dropbox destination path for mirrored manual RAW uploads (new, above).
- **Verification:** the full test matrix already specified in
  `capture-count-manifest-verification-plan.md`, plus: manual RAW upload completion triggers a
  Dropbox publish attempt; publish failure leaves the asset visible/usable in R2 (mirroring the
  existing Edited-upload safety behavior — never block the staff workflow on Dropbox); retry
  path for a failed mirror.

## Wave 3 — large, foundational; can start in parallel with Wave 2 once the prerequisite gate clears

### 3. Dropbox Webhook Automation (item 1)

Full spec in `docs/plans/implemented/Dropbox-Webhook-Automation-Plan.md` — its own internal 8-step sequence
(shared contracts → mapping/claim schema → root-scoped monitors → RAW reconciliation →
AutoHDR claims → versioning → tests → rollout) stays intact; this wave is only about *when* the
whole thing starts relative to everything else in this document.

- **Builder:** Sol (migration + large cross-system change, per the routing table in
  `docs/Subagent-Orchestration.md`). **Reviewer:** a separate Sol run at max effort, given size.
- **Coordination point:** if Wave 2 and Wave 3 are both mid-flight, only generate each
  migration file at the moment that wave is actually ready to apply — don't pre-claim
  migration numbers in either plan doc. Whichever lands first gets `0012` (confirmed next
  available, see prerequisite gate above), the other gets `0013`.
- **Deploy order** (per `CLAUDE.md`/`docs/todo.md` convention): background → webhook-ingress →
  app, for both this wave and Wave 2.

## Wave 4 — conditional, needs Terry's explicit go-ahead

### 4. Cloudflare Images pilot (item 4)

Full context and recommendation in `docs/plans/Cloudflare-Images-Pilot-Plan.md`: **not recommended to
proceed now.** The outage that originally motivated it has resolved on its own, and the cost
analysis (independently confirmed by two reviewers) shows Hosted Images could cost *more* than
the R2 originals it would touch, with real reliability/immutability trade-offs and no proven
benefit beyond a hedge against a repeat of an outage that's no longer occurring. If Terry still
wants to explore it as a resilience hedge: only Phase 0 (a cheap, reversible smoke test, no
schema/production changes) should proceed without a further go/no-go checkpoint.

## Summary: what can run right now, in parallel, without waiting on anything

```text
Prerequisite gate (Sol, read-only)  ─┐
                                      ├─→ Wave 2 (Sol builds, bundled)
Wave 1a (Terra) ──────────────────────────────────────────┐
Wave 1b (Terra) ──────────────────────────────────────────┤ all independent,
                                      ├─→ Wave 3 (Sol builds)  start immediately
Wave 4 (on hold, pending Terry)  ─────┘
```

Concretely: **Wave 1a, Wave 1b, and the prerequisite gate can all start right now, in
parallel.** Wave 2 and Wave 3 wait only on the prerequisite gate (not on each other, not on
Wave 1) plus, for Wave 2 specifically, Terry's three open design decisions above. Wave 4 stays
parked pending an explicit go-ahead.

## Decisions needed from Terry before full parallel execution

1. Capture-count plan: abandoned partial-batch lifecycle (nag forever / dismissible / auto-expire).
2. Capture-count plan: Dropbox+manual hybrid banner behavior.
3. New: Dropbox destination path convention for mirrored manual RAW uploads.
4. New: is the legacy rendition-orphan backfill (Wave 1b, part 2) worth doing, or accepted as
   sunk cost given the low storage cost involved?
5. Cloudflare Images pilot: proceed with Phase 0 smoke test only, or shelve entirely for now?

## Working-agreement notes for whoever builds

- Current git branch (`docs/codex-subagent-orchestration-policy`) is docs-only; every wave
  above should branch off `main` fresh, per `CLAUDE.md`.
- Full verification matrix (all six workspace typechecks, all four test suites, the web build)
  is mandatory before any deploy, independently re-run by this session — never on an agent's
  self-report alone, per `docs/Subagent-Orchestration.md` §5.
- Migrations are applied to production as a deliberate, gated step, never bundled silently into
  a deploy — consistent with existing repo convention.
