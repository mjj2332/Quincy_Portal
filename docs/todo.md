# Quincy Portal — build tracker

Orchestration: Claude = planner/orchestrator/contract-layer; Codex/Agy = groundwork (see
`docs/Subagent-Orchestration.md`).

> **Compressed 2026-07-24.** Detailed historical narrative (bug mechanisms, review-round
> counts, full diagnostic transcripts) has been cut in favor of what/when/deploy-state. See
> `docs/lessons.md` for incident mechanics, and `docs/reviews/` for full QA-sweep detail.

## Current state (2026-07-24)

- **`main` is source of truth** — `build/phase-0-2` merged via PR #3. Production live at
  `quincy.flamingfire.my` (staging + prototype on their own hostnames). Branch off `main` for
  new work.
- **Phases 0–4 shipped and live**: foundations/auth/infra; capture ingest + RAW QA; AutoHDR +
  Edited QA + review lightbox; Tonomo intake + dashboard (Kanban/List) + admin backend;
  video/floorplan/copy collections.
- **D1 migrations: reconciled 2026-07-24.** Prod's `d1_migrations` table confirms `0000`–`0011`
  all applied (checked directly, not inferred) — **next available migration number is
  `0012`**. This branch's local `packages/db/migrations/` only goes to `0010`; `0011_dapper_tarantula.sql`
  (adds `rendition_dlq_events` — the DLQ-monitoring fix from `main`, PR #9) lives on `main`
  already and will be present once this branch is rebased/a fresh branch is cut from `main`.
  The prerequisite gate in `docs/Implementation-Sequencing-Plan.md` is satisfied — no further
  reconciliation needed before Wave 2/3.
- **Rendition pipeline is live and working**: background queue generates thumb/web WebP on
  ingest/AutoHDR-return, served from R2 with a live-transform fallback (the "thumbnail
  rendition cache" plan from 2026-07-21 — Phases 1–3 all shipped as part of the 2026-07-24
  manual-edited-publish wave, below). The 2026-07-24 Cloudflare-side outage (see "Resolved
  incidents") is unrelated to this pipeline's own code, which was independently exonerated.
- **Deploy loop**: terra/agy (implement) → sol (review) → Claude (gate), full verification
  matrix re-run independently every time (agent sandboxes can't run vitest — always report
  tests "couldn't start"; never trust that as a pass). Deploy order: background →
  webhook-ingress → app.
- **Master sequencing plan ready for review**: `docs/Implementation-Sequencing-Plan.md` ties
  together every pending item below into waves with builder/reviewer assignment and
  dependencies — read that first before picking up any individual item.
- **Waves 1a, 1b, 2, 3 built and independently verified — none committed/merged/deployed yet.**
  Each lives in its own git worktree/branch off `main`, awaiting a merge/PR decision:
  - **1a** `feat/staff-routing-deep-links` — SPA History-API router, `/d/*` Worker reservation,
    mandatory OAuth callback allowlist.
  - **1b** `fix/r2-rendition-purge-on-delete` — R2 renditions now purged on project delete.
  - **2** `feat/capture-count-and-dropbox-mirror` — durable manifest-based capture count, manual
    RAW uploads now mirror to Dropbox.
  - **3** `feat/dropbox-webhook-automation` (worktree `/tmp/quincy-wave3-dropbox-webhook-automation`,
    built on top of Wave 2's changes — needs Wave 2 merged/rebased first) — event-driven Dropbox
    intake, dual root-scoped monitors, AutoHDR handoff/claim/versioning model, migrations `0013`
    + `0014`. All three new automation flags (`DROPBOX_RAW_AUTOMATION_ENABLED`,
    `DROPBOX_AUTOHDR_AUTOMATION_ENABLED`, `DROPBOX_HANDOFF_V2_ENABLED`) default `"0"` — this ships
    as a no-op until deliberately enabled per the plan's staged-rollout section. The legacy hourly
    cron is deliberately still present as a safety net (see `docs/lessons.md`) — do not remove it
    in the same deploy that enables the new monitors. An independent review caught and a follow-up
    fix pass resolved 8 real races/gaps before this was considered done — see `docs/lessons.md`
    for the two most reusable patterns (partial-unique-index backstop for "exactly one current
    row"; never retire a legacy safety mechanism in the same deploy that defaults its replacement
    off). Four rollout doc updates (`docs/Dropbox-Setup.md`, `docs/Implementation-Plan.md`) are
    still outstanding — the plan's step 8 documentation checklist has not been applied yet.

## Waiting on user / external

- [ ] Configure Tonomo with the webhook URL:
  `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/tonomo?token=<see .prod-secrets.local>`.
- [ ] Real interactive Google browser login check at `https://quincy.flamingfire.my` (staging
  sign-in bounces to prod origin — single `APP_ORIGIN`; use prod for this check).
- [ ] Rotate/retire production `BETTER_AUTH_SECRET`: still sits in gitignored
  `portal/workers/app/.prod-secrets.local` — move to password manager, delete the file.
- [x] Dropbox app registered, secrets uploaded, `sharing.read` scope added + connection
  re-authorized, first live sync confirmed working (all 2026-07-20/21).

## Open, not yet fixed

- [ ] **P1** Comment/annotation *creation* fails silently — `postComment()`/`saveAnnotation()`
  in `Lightbox.tsx` have no `catch` (unlike their edit-handler siblings). Annotation create
  schema is `z.unknown()` for strokes while edit validates properly
  (`workers/app/src/routes/annotations.ts`).
- [ ] **P1** No mutation-safe staging QA corpus / E2E test matrix for RAW↔Edited compare,
  collections/PDF versioning, Extras ingest, or background Dropbox sync.
- [ ] **P2** Narrow-screen (≤720px) nav loses Admin + Sign-out, no mobile-menu replacement.
- [ ] **P2** Floorplan PDF+preview version pairing not enforced (independent per-kind
  counters); external collection links never bump `receivedCount`; collection tab-switch race
  can apply a stale response; compare-mode layout not reset on an unpaired asset; no
  CSRF/origin guard on custom `/api` mutations; `LazyImage` terminal failure looks identical
  to loading (no retry).
- [ ] **P3** Lightbox synced zoom (RAW↔Edited compare, deferred, works-as-designed gap) · move
  50MB document uploads off `formData()` onto presigned upload.
- [ ] Hardening: add expiry to the `/__transform-source` HMAC signature (currently unexpiring
  per-key URLs — `TODO(hardening)` in `portal/workers/app/src/routes/media.ts`).
- [ ] Harden project DELETE: a stale `queued`/orphaned job can block it forever (409) — reap
  jobs past a staleness threshold, or clear terminal-eligible jobs on archive.
- [ ] Add a partial unique index on `(collection_id, content_hash) WHERE content_hash IS NOT
  NULL` (+ dedup existing rows) so concurrent Dropbox syncs can't insert duplicate assets.
- [ ] Validate JPEG magic bytes from R2 on ingest (RAW and edited currently trust the
  extension).
- [ ] **USER/testing:** validate the AutoHDR fetch flow against a real `04-FINAL(S)-Photos`
  sample once one exists — confirm exact finals-folder spelling and finished-filename ↔ RAW
  basename mapping for bracket-merged sets. Code currently reads both spellings and ingests
  unmatched finals as `source_raw_asset_id = null` (nothing lost meanwhile).
- [ ] Phase 5 (queued, own launch gates): client-delivery Worker — signed links, gallery,
  favourites, pre-built zips, premium paywall (Pixieset replacement).

## Resolved incidents (kept for pattern-recognition; see `docs/lessons.md` for mechanics)

- **Cloudflare `err=9401` rendition outage (2026-07-21 diagnosed → 2026-07-24 resolved).**
  Every `/cdn-cgi/image/` transform on the zone was rejected, reproduced even for a trivial
  static PNG untouched by our code/signing. Verified not our config (Sources allow-list,
  master toggle, secrets all correct). Resolved on its own — likely the paid Images plan
  Terry added took hours to propagate; confirmed via a zero-R2-involvement test flipping from
  failing to succeeding, and production D1 showing real recovery (not just one test). Two
  independent reviews (git blob-SHA diff + Sol read-only) exonerated the code entirely —
  `renditions.ts`/`transform-source.ts`/`media.ts`/app `wrangler.jsonc` were byte-identical
  across every suspected commit and HEAD. `ALLOW_PRODUCTION_RENDITION_BACKFILL=1` is still set
  on the background worker from the recovery attempt — clear it.
- **Spaced-filename HMAC bug (WP-AC, 2026-07-21):** the `/__transform-source` signature was
  verified against the percent-encoded path while signed over the raw R2 key. Fixed
  (per-segment encode on issue, decode-before-verify on receipt); regression test pins the
  round-trip.
- **Grid-concurrency rate-limit outage (2026-07-21):** 24–40 simultaneous live-transform
  thumbnails tripped Cloudflare edge rate-limiting. Fixed with `LazyImage` (4-permit
  semaphore, watchdog, retry+backoff) across grid/dashboard/lightbox filmstrip; transforms
  made immutable+cacheable. Verified live: 69 media requests, all 200, zero 403.
- **Same-zone subrequest bypass (Spike ①, pre-2026-07-21):** a Worker's same-zone subrequest
  bypassed the whole Cloudflare pipeline; fixed via a signed `/cdn-cgi/image/` redirect. Gate
  passed at 28.4MB and 83.8MB/88MP real photos.
- **Stale P1 (webhook reliability) — already fixed at HEAD, caught 2026-07-24.** Old entry
  claimed Dropbox webhook failures were acked 200 and never rewoke the DO. Current
  `workers/webhook-ingress/src/index.ts` already wakes on both new/duplicate deliveries,
  writes `last_event_at` unconditionally, and returns 503 (not 200) on failure so Dropbox
  retries. The sticky-error-status behavior mentioned in the original report is unverified —
  recheck separately if it resurfaces.

## New findings (2026-07-24)

**Bug: rendition R2 objects never purged on project deletion.** `DELETE /projects/:id`
([projects.ts:351](../portal/workers/app/src/routes/projects.ts)) purges R2 only under
`projects/${id}/`. Rendition objects are keyed by **asset ID**, not project ID —
`renditions/${assetId}/${contentHash}/${specVersion}/${variant}/${digest}.${ext}` — so every
deletion has leaked its renditions into R2 forever. Discovered when Terry manually wiped both
prefixes to reclaim space. Fix + backfill decision spec'd in
`docs/Implementation-Sequencing-Plan.md` Wave 1b.

**Gap: manual RAW/Edited uploads never mirror to Dropbox.** Only manual Edited uploads publish
to Dropbox (`publishManualEditedUpload`, gated on `collection === "edited"` at
[uploads.ts:66](../portal/workers/app/src/routes/uploads.ts)). Manual RAW uploads go to R2
only — no backup copy, though Terry expects one. Spec'd in `docs/Implementation-Sequencing-Plan.md`
Wave 2a-ii; needs a destination-path decision before it starts.

**Agy can build, not just plan.** Confirmed 2026-07-24: Agy (`gemini-3.6-flash-high`, this
account's default) is now a second, independent build pipeline alongside Codex. Requires
`--mode accept-edits` (no `--sandbox` — combined with accept-edits it silently blocks writes
with zero error) and `--add-dir "<repo root>"` (writes outside Agy's `trustedWorkspaces`
allowlist are silent no-ops otherwise). Full mechanics in `docs/Subagent-Orchestration.md` §3a.

## Pending plans (built in worktrees, see "Current state" above for status — see
## `docs/Implementation-Sequencing-Plan.md` for how they all fit together)

- **`docs/Dropbox-Webhook-Automation-Plan.md`** — Wave 3, built and verified, not merged. See
  "Current state" above.
- **`docs/staff-routing-and-deep-link-plan.md`** — Wave 1a, built and verified, not merged.
- **`docs/capture-count-manifest-verification-plan.md`** — Wave 2, built and verified, not merged.
- **`docs/Cloudflare-Images-Pilot-Plan.md`** — renditions-only Cloudflare Images pilot.
  **Not recommended to proceed now**: the outage that motivated it resolved on its own, and an
  independent two-reviewer debate (Agy + Sol) on a related idea (moving originals to Dropbox)
  concluded reject — Hosted Images could cost more than the R2 storage it would touch.

## Reference: infra & credentials (stable, rarely changes)

- Cloudflare account `5649541c0660b8c9b45d114a868ebc13`: D1 `quincy-portal`
  (`1d36b42e-f1e6-4659-8c9e-70afe822b6fa`), KV `quincy-portal-sessions`, Queue
  `quincy-ingest`, R2 `quincy-portal-media`.
- Google OAuth client `keen-virtue-502912-m2` (secret only in password manager/Worker
  secrets, never in the repo).
- R2 S3 API token for presigned multipart uploads; credentials in gitignored `.dev.vars`.
- Repo layout: `prototype/ · portal/ · docs/ · test-data/`; `CLAUDE.md`/`AGENTS.md` are the
  project guide (kept in sync, identical content).
