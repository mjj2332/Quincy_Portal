# Plan (deferred): fix false "Capture count needs attention" via durable manifest verification

> **Status:** APPROVED-TO-STORE, NOT YET IMPLEMENTED. Deferred by Terry on 2026-07-24 to be
> picked up "when I'm ready." Do **not** implement or deploy without explicit go-ahead. This
> is a cosmetic warning-banner bug (uploads still work; it does not block ingest or stage
> progression), so it is lower priority than the live rendition/Cloudflare `err=9401` issue.
>
> This spec is the product of two independent review rounds (GPT-5.6-sol, high effort) that
> rejected two simpler drafts. It reflects verified repository facts as of commit `5848437`.

## Symptom (as reported)

Uploading 1 additional photo to a RAW collection that already contained 10 assets showed:

> **Capture count needs attention.** Expected 1, received 11.

The banner fires on a completely normal workflow — a "top-up" upload to a project that
already has RAW assets — even though ingestion worked perfectly.

## Root cause

`collections.expected_count` and `collections.received_count` use **incompatible semantics**:

- `received_count` is **cumulative** — the RAW ingest path recomputes it as the count of
  *ready* assets in the collection via `COLLECTION_RECEIVED_COUNT_SQL`
  (`portal/workers/app/src/lib/ingest.ts:22`, definition in
  `portal/packages/db/src/collection-count.ts:2-3`; RAW assets default to `ready`,
  `portal/packages/db/src/schema.ts:296`). So after 10 + 1 it is correctly 11.
- `expected_count` is **overwritten per-batch** — the manual upload manifest handler sets it
  to just the newest batch's size, unconditionally
  (`portal/workers/app/src/routes/uploads.ts:23`), so it becomes 1.
- `GET /projects/:id/ingest-status` compares the two directly and flags a mismatch
  (`portal/workers/app/src/routes/uploads.ts:122`); the banner renders at
  `portal/apps/web/src/screens/ProjectWorkspace.tsx:200`.

There is also a **second, conflicting writer** of `collections.expected_count`: Dropbox sync
derives a whole-shoot expectation from the RAW folder name and writes it, but only while the
column is still null (`portal/workers/background/src/dropbox/sync.ts:126-131`). The manual
handler clobbers that value on every manual upload — a real secondary bug.

## Why the two simpler fixes were rejected (do not retry these)

1. **`expected_count = received_count + batch_size`** (draft v1). Rejected:
   - Read-modify-write across two separate auto-committed D1 statements is not atomic →
     concurrent manifest calls double-count. (Only `batch()` is transactional in D1.)
   - **Silently masks genuine shortfalls**: if an earlier batch lost files, a later unrelated
     small upload recomputes the target from current `received_count` and makes the banner
     disappear without the missing files ever arriving — the opposite of what the feature is
     for.
   - Still writes the same column Dropbox owns → keeps the writer conflict.

2. **Per-manifest matching by `filenames_json` ↔ `assets.original_filename`** (draft v2).
   Rejected:
   - `assets.original_filename` is plain, non-unique text
     (`portal/packages/db/src/schema.ts:288`); there is **no** `(collection_id,
     original_filename)` uniqueness (`portal/packages/db/src/schema.ts:314`). The test suite
     even inserts two `capture.jpg` into one RAW collection
     (`portal/workers/app/test/api.test.ts:930` and `:933`). So an old file can satisfy a new
     manifest, duplicate names miscount, and reused names across manifests are
     indistinguishable.
   - Manifest validation constrains only array length
     (`portal/workers/app/src/routes/uploads.ts:14`), so duplicates are accepted; SQL `IN`
     set-membership ≠ array multiplicity.
   - A single `IN (...)` over up to 10,000 filenames exceeds **D1's 100 bound-parameter
     limit** (`docs/Implementation-Plan.md:33`) — fails on any ordinary large shoot.
   - "Newest manifest wins" (`ORDER BY created_at DESC LIMIT 1`) reproduces the same
     shortfall-masking as v1; `created_at` is millisecond-only
     (`portal/packages/db/src/schema.ts:10`) so "newest" is nondeterministic under
     concurrency.

## Approved design (v3): durable, server-owned manifest→asset association

The only sound way to know which assets belong to which upload batch is a durable,
server-written association — not filename inference.

### 1. Schema migration (new D1 migration file, next number in sequence)

- Add a nullable `manifest_id` column to `assets` referencing `upload_manifests.id`
  (`ON DELETE SET NULL`). Nullable because Dropbox-synced and Tonomo assets have no manifest.
- Add index `(manifest_id)` (and consider `(collection_id, manifest_id)`) for the count query.
- Add a manifest **lifecycle/status** column to `upload_manifests`
  (e.g. `status text NOT NULL DEFAULT 'active'` with values `active | complete | abandoned |
  superseded`) — needed so an abandoned partial batch does not nag forever. See open product
  question below.
- **Migration must be applied to production D1 as a deliberate, gated step** — this repo's
  convention (see `CLAUDE.md`, `docs/todo.md`) is that migrations are applied explicitly, not
  on deploy. Do not stack it on top of an active production incident.

### 2. Backend

- `POST /projects/:id/upload-manifest`
  (`portal/workers/app/src/routes/uploads.ts:18-25`):
  - **Stop writing `collections.expected_count` entirely** — leave that column to the
    Dropbox folder-count writer. This removes the writer conflict.
  - Add the archived-project 409 check that `presign` already has
    (`portal/workers/app/src/routes/uploads.ts:31`) but the manifest handler lacks.
  - Optionally mark any prior `active` manifest for the same collection as `superseded` (a
    lifecycle decision — see open question).
- `POST /uploads/complete` (`portal/workers/app/src/routes/uploads.ts:55`) and
  `finalizeIngest` (`portal/workers/app/src/lib/ingest.ts`): accept an optional `manifestId`
  and **stamp it onto the created asset** (`assets.manifest_id`). Validate the manifest
  belongs to the same project/RAW collection.
- `GET /projects/:id/ingest-status`
  (`portal/workers/app/src/routes/uploads.ts:122`): compute per-manifest completion by
  **counting `assets` stamped with that `manifest_id`** vs `upload_manifests.expected_count`
  — a durable join, no filename inference, one bound parameter (the manifest id), so no D1
  parameter-limit problem. Decide which manifest(s) drive the banner per the lifecycle model.
  Keep the existing collection-level `expected_count`/`received_count` comparison as the
  fallback **only** when no manifest exists (pure-Dropbox projects), matching today's
  behavior for that path.

### 3. Frontend (required — v2 wrongly claimed none needed)

- `UploadDropzone.tsx:85` currently **discards** the returned `manifestId`; completion carries
  no association (`UploadDropzone.tsx:98`). The client must retain the `manifestId` from
  `upload-manifest` and pass it through each `/uploads/complete` call for that batch.
- `ProjectWorkspace.tsx:77` requests a generic collection-wide status and renders the banner
  at `:200` / type at `:16`. Decide whether the workspace reports the latest manifest's status
  or an aggregate; update the fetch + banner copy accordingly (e.g. "batch of N: received M").

### 4. Historical data repair (one-off)

Existing `collections.expected_count` values already clobbered by the current handler
(`uploads.ts:23`) remain contaminated and Dropbox will not repair non-null values
(`sync.ts:129`); the Dashboard keeps displaying them (`Dashboard.tsx:56`). Plan a one-off
reconciliation (script or gated admin action) to null out / recompute affected
`collections.expected_count` for projects touched by manual uploads. Enumerate affected
projects first; do not blanket-reset Dropbox-derived counts.

## Open product questions (need Terry's decision before/at implementation)

1. **Abandoned partial batches:** if a photographer selects 5 files, uploads 2, and walks
   away, should the banner nag indefinitely, be dismissible, or auto-expire the manifest to
   `abandoned` after some interval? This determines the lifecycle model and is a genuine
   product call, not a technical one.
2. **Hybrid Dropbox + manual top-up on the same RAW collection:** once a manual manifest
   exists, should the banner reflect the manifest or the Dropbox folder total? (No evidence
   this hybrid is in active use today.)

## Verification (mandatory full matrix per `AGENTS.md:77-83` + CI `portal.yml:62`)

All six workspace typechecks; `packages/shared`, `workers/app` (incl. the app-dev config CI
runs), `workers/background`, and `webhook-ingress` test suites; and `npm run build -w
@quincy/web`. Report exact command output/exit status, not summary claims.

New `portal/workers/app/test/api.test.ts` cases must cover, at minimum:
- Fresh collection, first manifest, full success → no mismatch.
- **Exact reported scenario:** collection already has 10 assets, new 1-file manifest, file
  lands → no mismatch, per-manifest expected 1 / received 1 (not 11).
- **Genuine shortfall preserved:** 3-file manifest, only 2 land → mismatch stays true.
- Old same-name asset must **not** satisfy a new manifest (the v2 collision case).
- Duplicate filenames within a manifest.
- Manifest larger than 99 filenames (D1 parameter-limit regression guard).
- Concurrent manifests.
- Partial batch followed by an unrelated later batch (shortfall must not be masked, per the
  chosen lifecycle model).
- Abandoned / superseded / retry lifecycle transitions.
- No-manifest Dropbox-only project → existing collection-level comparison unchanged.
- `upload-manifest` no longer clobbers a Dropbox-set `expected_count`.
- Archived project rejects manifest creation (409).
- Dashboard ratio (`Dashboard.tsx:56`) and project list/detail consumers
  (`projects.ts:110`, `:125`) still behave.

## Orchestration note

When picked up: run this spec through the review loop in
`docs/Subagent-Orchestration.md` — sol reviews the final plan, terra/luna implements,
sol reviews the diff, this session (Claude) is the final gate and re-runs the full
verification matrix independently before any migration/deploy.
