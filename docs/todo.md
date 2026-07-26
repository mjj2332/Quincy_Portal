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
- **D1 migrations: `0000`–`0014` confirmed applied to prod (2026-07-24).** Next available
  migration number is `0015`.
- **Rendition pipeline is live and working**: background queue generates thumb/web WebP on
  ingest/AutoHDR-return, served from R2 with a live-transform fallback (the "thumbnail
  rendition cache" plan from 2026-07-21 — Phases 1–3 all shipped as part of the 2026-07-24
  manual-edited-publish wave, below). The 2026-07-24 Cloudflare-side outage (see "Resolved
  incidents") is unrelated to this pipeline's own code, which was independently exonerated.
- **Deploy loop**: terra/agy (implement) → sol (review) → Claude (gate), full verification
  matrix re-run independently every time (agent sandboxes can't run vitest — always report
  tests "couldn't start"; never trust that as a pass). Deploy order: background →
  webhook-ingress → app.
- **Plan docs live in `docs/plans/`** (`docs/plans/implemented/` for shipped ones) — see
  "Implemented plans" and "Open plans" below.
- **Waves 1a, 1b, 2, 3 merged to `main` and deployed to production (2026-07-24).** PRs #12–#15
  (docs housekeeping was #11). Deploy order `background → webhook-ingress → app` completed;
  migrations `0012`–`0014` applied to prod; smoke-tested (`/`, `/api/session`, `/d` reservation
  all responding correctly).
  - **1a** `feat/staff-routing-deep-links` — SPA History-API router, `/d/*` Worker reservation,
    mandatory OAuth callback allowlist. **Live.**
  - **1b** `fix/r2-rendition-purge-on-delete` — R2 renditions now purged on project delete. **Live.**
  - **2** `feat/capture-count-and-dropbox-mirror` — durable manifest-based capture count, manual
    RAW uploads now mirror to Dropbox. **Live.**
  - **3** `feat/dropbox-webhook-automation` — event-driven Dropbox intake, dual root-scoped
    monitors, AutoHDR handoff/claim/versioning model. Shipped dormant, then **progressively
    enabled 2026-07-25**: `DROPBOX_RAW_AUTOMATION_ENABLED="1"` and
    `DROPBOX_AUTOHDR_AUTOMATION_ENABLED="1"` are now live; `DROPBOX_HANDOFF_V2_ENABLED` is the
    last one still `"0"` and is **required** to complete AutoHDR auto-fetch — see the
    webhook-triggered auto-fetch entry under "Open, not yet fixed" for the sequenced plan.
    The legacy hourly cron is deliberately still present as a safety net — do not remove it in
    the same deploy that enables the new monitors. An independent review caught and a
    follow-up fix pass resolved 8 real races/gaps before this was considered done — see
    `docs/lessons.md` for the two most reusable patterns (partial-unique-index backstop for
    "exactly one current row"; never retire a legacy safety mechanism in the same deploy that
    defaults its replacement off). **Still outstanding:** four rollout doc updates
    (`docs/Dropbox-Setup.md`, `docs/Implementation-Plan.md` — the plan's step 8 checklist).

- **Branch `fix/gate-manual-edited-upload-on-raw-folder` (2026-07-25) — not yet merged or
  deployed.** Manual *edited* uploads were accepted (presign 200 → R2 bytes → D1 row → 202) on
  projects with neither `raw_folder_path` nor `raw_folder_link`, then failed minutes later in
  `ManualEditedPublish` and landed at `publish_status = 'failed'` — permanently invisible, because
  the edited listing filters on `'ready'`. Recovery was `adminBackend`-only, while `editor` holds
  `uploadEdited`. Now refused up front (409 `raw_folder_missing` / `raw_folder_invalid`) on
  presign, complete and dev direct-PUT, with the Edited dropzone replaced by a notice telling the
  user to create the shoot folder in Tonomo. Portal never creates that folder — Tonomo owns it.
  The Portal-owned `/AutoHDR/{name}/Manual-Uploads/{assetId}` chain is now created explicitly by
  the Workflow (`ensure-manual-edited-folder`), matching the AutoHDR hand-off's `ensure-dest-folder`
  instead of relying on the provider's implicit parent creation. RAW is deliberately *not* gated:
  a failed RAW mirror never hides the asset. No migration. **Still open:** existing prod assets
  already stuck at `publish_status = 'failed'` are not backfilled — check with
  `SELECT count(*) FROM assets WHERE publish_status = 'failed';` after deploy, then set each
  project's RAW folder and retry the job.

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
- [ ] **Operator action:** fix the `TRANSFORM_SOURCE_SECRET` drift between `workers/app` and
  `workers/background` (`wrangler secret put` in both) — the root cause behind the rendition DLQ
  incident below. The DLQ monitoring/replay tooling is live, but the drift itself is unfixed.
- [x] **Webhook-triggered auto-fetch for RAW *and* AutoHDR edited — DONE and verified live
  end-to-end, 2026-07-25 (user-required feature).** A new file landing in either a Tonomo RAW
  folder or an AutoHDR `04-FINAL-Photos` folder is now ingested automatically off the Dropbox
  webhook, no button press. Both flags live: `DROPBOX_RAW_AUTOMATION_ENABLED="1"`,
  `DROPBOX_AUTOHDR_AUTOMATION_ENABLED="1"`, `DROPBOX_HANDOFF_V2_ENABLED="1"`.
  - **RAW**: the monitor matches changed paths against `projects.raw_folder_path` directly, no
    claims needed. Verified: a file dropped into 12 Brompton's folder ingested unprompted.
  - **AutoHDR**: routes via `autohdr_path_claims`/`autohdr_output_mappings`, created only by the
    V2 send path — chosen over deriving the folder name from `raw_folder_path` (the RAW
    approach) specifically because that has no collision detection, and two live projects were
    found sharing a folder name differing only in case (Dropbox paths are case-insensitive).
    `autohdr_path_claims`' unique index catches exactly that and parks it in `blocked_collision`
    for a human — do not replace this with path-derived routing.
  - **Verified end-to-end 2026-07-25**: sent 168 Botany to AutoHDR via V2 → path claim +
    output mapping created (`pending`/`pending_discovery`) → dropped `places-04.jpg` into its
    `04-FINAL-Photos` → claim resolved to `active`, mapping's `final_path` populated, a
    `fetch_edited` job appeared on its own (`trigger: "dropbox_delta"` in its payload, not a
    click) → asset ingested with 2 renditions within 10 seconds.
  - **Scope**: auto-fetch applies to projects *sent through V2*. A project sent on the legacy
    path has no claim and always needs the manual button.
  - **Real bug hit and fixed along the way** — see `docs/lessons.md`: both V2 Workflow instance
    ids used `:`, which Cloudflare rejects (`instance.invalid_id`). Broke V2 send *and* fetch;
    stayed invisible until the day V2 was actually switched on, because the legacy paths use a
    bare UUID and never exercised the bad format. Fixed with a regression test.
  - **Also found while getting there** (kept as open follow-ups, not blocking):
    - A project sent to AutoHDR with **zero** RAW assets in `selected_for_editing` can never
      leave `editing_autohdr` — `advance-stage` requires `selectedRawAssets.length > 0` before
      it will even check readiness. Worth a guard or a surfaced warning at send time.
    - The account was found to be on the Workers **Free** plan (50 subrequests/request, 100k
      requests/day), which made the whole pipeline unable to run reliably at real volume.
      Upgraded to Workers Paid 2026-07-25 — see `docs/lessons.md` for how much this looked like
      unrelated application bugs before the plan tier was checked.
  - **Optional backstop, safe only after V2:** an hourly cron sweep over `editing_autohdr`
    projects as a missed-webhook safety net (claims make folder→project ownership unambiguous).

## Resolved incidents (kept for pattern-recognition; see `docs/lessons.md` for mechanics)

- **Dropbox `files/download` 429 from cursor-reset burst amplification (2026-07-25).** One new
  AutoHDR image triggered a shared-content traffic-limit 429 on the Admin dashboard. Root
  cause: a cursor-reset full re-list of `/AutoHDR` could match several projects and start
  concurrent `AutoHdrFetch` Workflows, with no `Retry-After`-aware backoff and no pacing
  between downloads anywhere in the stack. Fixed: `DropboxRateLimitError` +
  `rate_limited` classification (self-heals like `transient`), `Retry-After`-aware alarm
  rescheduling, and pacing/stagger in `dropbox/sync.ts` and `workflows/autohdr-fetch.ts`. Not
  escalated to Dropbox Support — fully explained by this code gap; escalate only if the
  affected link/folder is still throttled after ~24-48h or a 429 recurs post-fix.
- **Tonomo webhooks poisoned on manually-entered addresses (2026-07-25).** `parseTonomoOrder`
  never checked `property_address.formatted_address` as a fallback when `.street` was blank
  (common for manually-entered addresses that skip Tonomo's place-autocomplete). Fixed by
  adding it to the fallback chain, ordered after the structured `.street` field. See
  `docs/lessons.md` for the asymmetric-fallback-helper pattern this exposed.
- **Rendition DLQ had zero consumers bound (2026-07-24, merged via PR #9).** Exhausted
  rendition jobs (root cause: `TRANSFORM_SOURCE_SECRET` drift between `workers/app` and
  `workers/background`) piled up in `quincy-renditions-dlq` with no signal beyond stuck
  "Processing preview…" tiles. Fixed with a bound DLQ consumer recording arrivals into
  `rendition_dlq_events` (migration `0011_dapper_tarantula`, confirmed applied to prod), plus
  `GET/POST /admin/renditions-dlq*` (list/replay/discard) and an Admin.tsx card. The root-cause
  secret drift itself is a separate, still-pending operator action — see "Open, not yet fixed".

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

**Agy can build, not just plan.** Confirmed 2026-07-24: Agy (`gemini-3.6-flash-high`, this
account's default) is now a second, independent build pipeline alongside Codex. Requires
`--mode accept-edits` (no `--sandbox` — combined with accept-edits it silently blocks writes
with zero error) and `--add-dir "<repo root>"` (writes outside Agy's `trustedWorkspaces`
allowlist are silent no-ops otherwise). Full mechanics in `docs/subagents/agy-cli.md`.

## Implemented plans (see `docs/plans/implemented/`)

- **`Dropbox-Webhook-Automation-Plan.md`** — Wave 3: event-driven Dropbox intake, dual
  root-scoped monitors, AutoHDR handoff/versioning. Live (automation flags off by default).
- **`staff-routing-and-deep-link-plan.md`** — Wave 1a: SPA History-API router, `/d/*` Worker
  reservation. Live.
- **`capture-count-manifest-verification-plan.md`** — Wave 2: fixed the false "Capture count
  needs attention" banner on top-up uploads; manual RAW uploads now mirror to Dropbox. Live.
- **`Implementation-Sequencing-Plan.md`** — the master plan that sequenced all of the above
  (plus the R2 rendition-purge fix, Wave 1b, which had no standalone plan doc) into
  dependency-ordered waves. Kept for provenance now that every wave has shipped.
- **`AutoHDR-Implicit-Scaffolding-Plan.md`** — legacy pre-V2 AutoHDR send/fetch paths and their
  feature flag removed; AutoHDR intake folders now scaffold automatically at project-create/
  RAW-path-set time (five real writers converging on a fenced, concurrency-safe D1 write), and a
  Dropbox drop into `04-MANUAL-Photos` or `04-FINAL(S)-Photos` auto-detects and claims the handoff
  with no button click, closing the auto-fetch scope gap noted above. Operator backfill
  (`POST /admin/autohdr/backfill`) covers projects sent through the legacy path before V2
  existed. Migration 0015 (`autohdr_scaffold_claims`, widened `candidate` enum) applied to prod
  2026-07-26; all three Workers redeployed same day (background → webhook-ingress → app), smoke
  test clean. Went through 9 rounds of Terra pre-build review (rounds 7-15 of the plan doc, after
  the earlier 6 Agy/Terra-Sol rounds plus an independent Opus pass — read all three doc files
  together for full provenance) plus a separate fresh-context diff review. Independent
  verification outside the builder's own sandbox caught and fixed three issues the build missed:
  a typecheck regression, migration 0015 originally using `CREATE TEMP TABLE` (a documented,
  broken Cloudflare D1 limitation that would have failed against real D1 entirely), and a flaky
  cross-test-pollution bug in a test fixture — see `docs/lessons.md`. A new
  `POST /admin/autohdr/scaffold-backfill` route (dry-run capable) was added same-day to retroactively
  scaffold the 21 pre-rollout projects that already had `raw_folder_path` set before the automatic
  trigger existed — run once against prod 2026-07-26, all 21 succeeded, zero failures. **Verified
  end-to-end live 2026-07-26** on 29 Stanley Street: a manual drop into `04-MANUAL-Photos` was
  picked up by the Dropbox webhook within seconds, auto-created the handoff, advanced the project
  raw_review → editing_autohdr, fetched the file, and published it to the Edited collection — no
  button ever clicked. RAW-side webhook auto-fetch reconfirmed working on the same project. See
  `docs/lessons.md` for a gotcha hit while picking a test project (a project can have zero
  `autohdr_handoffs` rows yet still be ineligible, if it went through the pre-V2 legacy flow and is
  already past `raw_review`/`editing_autohdr` — check `stage_key` too, not just handoff absence).

## Open plans (see `docs/plans/`)

- **`Cloudflare-Images-Pilot-Plan.md`** — renditions-only Cloudflare Images pilot.
  **Not recommended to proceed now**: the outage that motivated it resolved on its own, and an
  independent two-reviewer debate (Agy + Sol) on a related idea (moving originals to Dropbox)
  concluded reject — Hosted Images could cost more than the R2 storage it would touch.
- **`Multi-Role-Staff-Identity-Plan.md`** — general-purpose multi-role staff identity
  (`user_roles` join table replacing the single `role` column). **Not scheduled**: the
  immediate need (one staff member who is both photographer and editor) is already solved
  with zero code changes — `editor`'s capability set is already a strict superset of
  `photographer`'s, so setting that person's `role` to `"editor"` works today. Kept as a
  ready-to-execute reference in case the workaround's tradeoffs (unscoped project visibility,
  lost photographer-only review restriction) become a real problem.

## Reference: infra & credentials (stable, rarely changes)

- Cloudflare account `5649541c0660b8c9b45d114a868ebc13`: D1 `quincy-portal`
  (`1d36b42e-f1e6-4659-8c9e-70afe822b6fa`), KV `quincy-portal-sessions`, Queue
  `quincy-ingest`, R2 `quincy-portal-media`.
- Google OAuth client `keen-virtue-502912-m2` (secret only in password manager/Worker
  secrets, never in the repo).
- R2 S3 API token for presigned multipart uploads; credentials in gitignored `.dev.vars`.
- Repo layout: `prototype/ · portal/ · docs/ · test-data/`; `CLAUDE.md`/`AGENTS.md` are the
  project guide (kept in sync, identical content).
