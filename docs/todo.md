# Quincy Portal — build tracker

Orchestration: Claude = planner/orchestrator/contract-layer; Codex/other agents = groundwork.

## Status (2026-07-21)
- **Awaiting-RAW cron — superseded in the proposed Dropbox webhook automation plan (2026-07-23):** The live hourly, date-driven `awaiting_raw → raw_review` reconciliation remains historical production behavior until the approved event-driven replacement ships. The replacement advances only after qualifying RAW media is durable in R2 and D1, covers Dropbox and direct uploads, writes a guarded transition audit, and removes the Background Worker `scheduled()` handler/cron; do not treat the historical cron as the target behavior for new work.
- **Dashboard + awaiting-RAW reconciliation wave (DEPLOYED + live-verified; 2026-07-22):** Grid is
  removed; active projects use Kanban (default) or List, archived projects use List only, and
  project ordering is server-authoritative by shoot date. The background Worker adds an
  hourly UTC cron that derives the Australia/Sydney business date and advances eligible existing
  `awaiting_raw` projects to `raw_review` with a guarded system audit; hourly runs reconcile
  existing eligible rows in bounded batches until drained. Edit Details protects services, order
  details, and notes while Create Project remains unchanged. Terra implementation plus four Luna
  review passes completed; Claude independently verified all six typechecks, **166 passing tests +
  1 intentional skip**, the production SPA build, real D1 transaction/scan behavior, and the local
  authenticated browser flow. Deployed versions: background `ff8fe38b`, webhook `41507d3c`, app
  `5c49a55f`. The first production cron used Sydney business date `2026-07-23`, advanced 12/12
  eligible projects, wrote 12 unique audits, and left zero due projects in `awaiting_raw`.
- **`main` is current** — `build/phase-0-2` merged to `main` via PR #3 (merge commit
  `3a7fe8d`). Branch off `main` for new work. Production live at `quincy.flamingfire.my`
  (staging + prototype preserved on their hostnames).
- **Phases 0–4 built, deployed, and live.** 0: foundations/auth/infra. 1: capture ingest +
  RAW QA. 2: autoHDR + Edited QA + review lightbox. 3: Tonomo intake (DO-serialized) +
  grid/list/kanban dashboard + selectable cover images + admin backend (users, directory,
  pipeline stages, Dropbox+Tonomo integrations w/ poison-event operator queue). 4:
  video/floorplan/copy — link tiles + PDF version groups.
- **Two production image outages fixed** (both in "Done" below): (a) spaced filenames broke
  the transform HMAC; (b) grid concurrency of live large-original transforms tripped
  Cloudflare edge rate-limiting. The 2nd fix (client concurrency-limited `LazyImage` +
  cacheable transforms) was **verified live in an authenticated browser: 69 media requests,
  all 200, zero 403** (grid + lightbox filmstrip).
- **New production image outage diagnosed, not fixed (2026-07-21):** Cloudflare's KUL PoP
  rejects the same-zone absolute transformation source with `403` / `cf-resized: err=9401`
  (origin not allowed), while fresh equivalent LAX transforms return `200` /
  `internal=ok`. Mac Safari is confirmed; the matching iPhone symptom is consistent with this
  failure but remains unconfirmed until its final response headers and PoP are captured. See
  the P0 plan under "Open / in progress".
- Latest verified state: 5/5 workspaces typecheck clean; `workers/app` **49/49**,
  `packages/shared` 23/23, `workers/webhook-ingress` 8/8; SPA build clean. D1 migrations
  0000–0003 applied to prod.
- **Local hardening repair (2026-07-21; not deployed):** pending/completing document
  reservations now have bounded recovery/abort ownership; final document writes and archive
  are archive-race guarded; collection links are deduped/count-reconciled in 0005 and their
  manual mutations are audit-atomic. CI now includes production+dev app configs, background,
  webhook, shared, and frontend unit suites. See `QA-Staging-Matrix.md` for unprovisioned
  staging/external prerequisites. Migration 0005 remains unapplied anywhere remote.
- **Deploy = terra(implement, gpt-5.6-terra) → sol(review, gpt-5.6-sol high) → Claude(gate)
  loop.** Verify agent claims independently (their sandboxes can't run vitest — EPERM
  loopback; they always report tests "couldn't start"). Deploy order: background →
  webhook-ingress → app.

## Next / open decisions
- **Rendition cache (Phases 2–3 of the thumbnail plan) — spec'd + Phase-1 SPIKE PASSED,
  awaiting user go-ahead.** It is not the immediate KUL repair. After the control-plane and
  cold multi-PoP gate are green, it is the durable way to remove browser request-time
  transformation dependency. See the "Thumbnail rendition cache" section below for the full
  plan and the proven `global_fetch_strictly_public` mechanism.
- User external actions still open: configure Tonomo with the webhook URL + token; retire the
  prod `BETTER_AUTH_SECRET` from `.prod-secrets.local` (see #3 below — canonical value is
  already a Worker secret + belongs in the password manager). Dropbox `sharing.read` scope
  was enabled 2026-07-21 (re-auth the connection to pick it up — see "Waiting on user /
  external" below).

## Done

**Phase 0 — Foundations**
- Monorepo scaffold (workspaces, tsconfig, deps, wrangler configs for 3 workers).
- `packages/shared` (capabilities, stages, media rules, XMP parser, AES-GCM credential
  envelope) + `packages/db` (Drizzle schema, migration 0000, seed). XMP parser verified
  43/43 real fixtures (Spike ④).
- `apps/web`: Vite SPA shell + design-system port, sign-in, dashboard.
- `workers/app`: better-auth Google-only closed signup, capability/membership middleware,
  users/projects/uploads/media/integrations/review routes, audit log.
- `workers/background`: Dropbox client (refresh rotation), sync engine (JPEG-only,
  content-hash idempotent, XMP rating), DropboxSyncDO cursor alarm, AutoHdrRoundtrip workflow.
- `workers/webhook-ingress`: constant-time HMAC verification, dedupe, fast-ack.
- Phase-1 UI: ProjectWorkspace, UploadDropzone, PhotoGrid, Lightbox. Test suite + CI stood up.
- Fixed critical Hono middleware-leak bug (403-locked non-admin roles out of later-mounted
  routes) — see `docs/lessons.md`.
- Cloudflare resources provisioned on the real account: D1 `quincy-portal`
  (`1d36b42e-f1e6-4659-8c9e-70afe822b6fa`), KV `quincy-portal-sessions`
  (`1344f43c2da84b28bc8729ac15c36925`), Queue `quincy-ingest`, R2 `quincy-portal-media`
  (account `5649541c0660b8c9b45d114a868ebc13`). Schema (24 tables) + seed applied to remote D1.
- Google OAuth client: project `keen-virtue-502912-m2`, Client ID
  `544815162886-4rm94a760isbac5h0e5l11uh562m0gh6.apps.googleusercontent.com` (secret lives
  only in the user's password manager / Worker secrets, never in the repo).
- R2 S3 API token for presigned multipart uploads (`quincyportal presigned uploads`);
  credentials in gitignored `.dev.vars`.
- First deploy hardened: better-auth Google-linking regression tests, Spike ② (67 MB R2
  multipart upload) and Spike ③ (deployed routing) both passed, all 3 workers deployed in
  dependency order, prototype preserved on its own hostname.
- Admin backend UI (WP-H): Users provisioning/deactivation + Integrations (Dropbox connect)
  tabs, replacing the placeholder.
- Scripted Spike-① transform gate (WP-I): `portal/scripts/verify-transform-gate.mjs`,
  one-command re-verification with strict temp-data cleanup.
- Spike ① closed + production cutover: root cause was a Worker's same-zone subrequest
  bypassing the whole Cloudflare pipeline; fixed via a signed `/cdn-cgi/image/` redirect.
  Gate passed at 28.4 MB and 83.8 MB/88 MP real photos. `quincy.flamingfire.my` cut over to
  `quincy-portal-app`.

**Phase 1 — Capture ingest + RAW QA**
- Dashboard, project workspace, RAW grid, upload UI, file-count verification, RAW QA tooling.
- New-shoot project-creation UI (WP-J): full manual CreateProject form, capability-gated CTA.
- Quick-create + edit-details-later (WP-K): address-first quick create; deferred-details Edit
  screen; additive-only PATCH semantics (never deletes ordered services/members).

**Phase 2 — autoHDR + Edited QA + review lightbox**
- Workflow round-trip, Edited QA, RAW↔Edited compare, jobs/retry with stuck recovery.
- Comment/annotation edit (WP-L): author-only PATCH on comments/annotations, audit-logged,
  inline edit UI with optimistic updates.
- Lightbox markup UX (WP-M): always-visible drawings, author-only drawing edit, click-to-highlight.
- Lightbox comment delete + keyboard-shortcut hint bar (WP-N).
- Annotation delete + discussion race hardening (WP-O): fixed two latent race bugs in the
  shared discussion-refresh code (stale-asset refresh clobbering the current asset; edit
  rollback not asset-guarded).

**Wave: deletion + Dropbox team-space + stars (2026-07-20, deployed)**
- Star display fix (WP-V): tile stars are text `★` spans, not svg — CSS retargeted; bright
  gold `#f0a020` on tiles, darker `#9a6a1f` in the lightbox star picker (light panel contrast).
- Two-step project deletion (WP-W): archive first, then admin-only typed-street-confirmed
  DELETE — audit-first, paginated R2 prefix purge, 409 while background jobs are
  queued/running, writer-side archived guard in Dropbox sync (TOCTOU defense).
- Dropbox Business team-space support (WP-X/Y): `Dropbox-API-Path-Root` header resolved
  once per sync and applied to ALL file calls including shared-link resolution; shared
  `normalisePath` (Finder-path stripping needs a segment (^| )Dropbox$); canonical path
  persisted after successful sync so webhook matching can't silently miss.
- EXTRAS upsell folder (WP-X/Y): one-level `EXTRAS/` JPEGs ingest as `isPremium`;
  Captures/Extras grid sections with visual-order shift-selection and matching lightbox
  navigation order; project+raw-scoped content-hash dedupe that updates `isPremium` when a
  file moves between root and EXTRAS.

**Phase 3 (in progress) — Tonomo intake (WP-Z/Z2/Z3, 2026-07-21, deployed)**
- Real-payload parser in `@quincy/shared` (`parseTonomoOrder`): built/tested against the
  two captured webhooks (canonical copies: `test-data/tonomo/*.json`). Handles
  `property_address`, `listingAgents`, `bookingFlow`, `services_a_la_cart`,
  `deliverablesLinks` (Floor Plan/Video/PDF→copy; Photos skipped; content-hash dedupe of
  duplicated share links), ISO shootDate from `when.start_time` in property timezone,
  `customQuestions`→notes, tri-state invoice/payment (explicit null clears).
- `TonomoProcessorDO` (fixed-ID) serializes all event processing: FIFO drain, alarm
  retries (5 attempts then poison), deterministic errors (parse failures, archived-project
  order match, ambiguous address match) poison immediately for the operator screen;
  pendingDrain guard so a drain arriving mid-drain is never dropped.
- Reconciliation: orderId → exact; else UNIQUE normalised street+postcode among
  unlinked non-archived projects (ambiguous → poison; separators normalise to spaces so
  1/23 ≠ 123); else create with stage `awaiting_raw`.
- Zero re-keying: project pre-filled from the order (contact snapshot, `rawFolderLink`/
  `rawFolderPath` additive → Dropbox sync source), photographer auto-assigned by active
  user email, finished deliverable links land in new `collection_links` table (migration
  0002, applied to prod; remote migration tracking backfilled — 0000/0001 were manual).
- Ingress wakes the DO on every stored OR deduped delivery (stranded-row rescue).
- PR #3 opened (build/phase-0-2 → main): https://github.com/mjj2332/Quincy_Portal/pull/3

**Repo hygiene**
- Reorganized repo into `prototype/ · portal/ · docs/ · test-data/`; wrote CLAUDE.md/AGENTS.md
  as the project guide (2026-07-20).

**Wave: covers + List view (WP-AB/AB2, 2026-07-21, deployed)**
- Effective cover per project (stored-if-valid else first RAW by filename), chunked
  queries under D1's 100-param limit, photographer-safe RAW fallback for Edited covers.
- POST /projects/:id/cover set/clear (`editProject`, audit-logged); ◈ tile button with
  clear-on-current-cover; workspace "Cover" tag matches the dashboard's effective cover.
- Dashboard: cover images on grid + kanban cards (monogram placeholder), NEW List view
  (prototype parity), view preference persisted. Tonomo payload fixtures made canonical
  at `test-data/tonomo/` (committed; parser tests read them).

**Wave: thumbnail outage fix + admin backend completion (WP-AC + WP-AA/AA2, 2026-07-21, deployed)**
- WP-AC (outage): spaced filenames broke every rendition — the /__transform-source HMAC
  was verified against the percent-encoded path while signed over the raw R2 key. Fixed
  (per-segment encode on issue, decode-before-verify on receipt, malformed % → 404),
  hotfix-deployed from a clean worktree, verified live against prod with a real signed
  spaced-key fetch. Regression tests pin the signed-source round-trip.
- WP-AA/AA2 (admin backend, closes Phase 3): agencies/agents directory CRUD (no deletes);
  pipeline stage config that is actually CONSUMED (session-gated GET /api/stages + SPA
  stages context with post-mutation refresh; kanban columns/badges/drop targets honour
  label/order/active; stage-change 409s onto inactive stages; awaiting_raw undeactivatable);
  atomic single-batch stage reorder; Tonomo operator queue (paginated poison list,
  payload viewer, race-proof guarded retry/discard with per-row locking) + health card
  ("Receiving"/"Awaiting first event"). App suite 45/45.

**Wave: image grid outage fix + Phase 4 collections (2026-07-21, deployed, commit 8f1415e)**
- Image outage (2nd, distinct from WP-AC): every thumbnail was a LIVE Cloudflare transform
  of the full 6–33 MB original; a grid firing 24–40 at once tripped Cloudflare EDGE
  rate-limiting → 403 broken tiles (real captures are large; earlier test uploads were tiny
  so never hit it). Fix: `LazyImage` — module-level 4-permit semaphore preloading each
  thumb via a detached `Image()` (fresh per attempt → no stale-event permit corruption),
  25 s watchdog frees hung fetches, retry+backoff, neutral placeholder; used by PhotoGrid,
  Dashboard covers (grid/kanban/list), CollectionPanel previews, AND the Lightbox filmstrip
  (the filmstrip stampede sol caught). `/__transform-source` now immutable + Content-Length
  + ETag (transform once, then cache). Transforms use width=N,height=N,fit=scale-down
  (true bounding box). Verified live. Sol took 4 review rounds (caught: loader deadlock via
  hung-fetch permit hold, D1 error-cause unique-retry, double-escaped filename regex,
  stale-event permit release, filmstrip gap, width-only non-bounding-box).
- Phase 4 (D-08): video link tiles + floorplan/copy PDF versioning — collections.ts
  (/links manual+immutable-Tonomo, /documents immutable versioned uploads, per-(group,kind)
  chains atomic via UNIQUE + cause-chain retry, viewEdited-gated, URL-sanitised,
  nosniff/Content-Disposition), CollectionPanel UI. Migration 0003 applied to prod. 49/49.

## Thumbnail rendition cache (sol-cross-reviewed plan, 2026-07-21)
- Q: thumbnails are already 640px/~15KB — payload was never the issue; the cost is
  cold-transforming huge originals per view. Durable fix = cache derived sizes in R2
  (`asset_renditions`, scaffolded but unused). 46% of originals >20MB exceed the Images
  BINDING cap. Key mechanism (sol): `global_fetch_strictly_public` compat flag lets a
  Worker fetch its own `/cdn-cgi/image/` (100MB remote limit) instead of the same-zone
  bypass — unlocks server-side generation for ALL sizes.
- [x] Phase 1 SPIKE — **PASSED (2026-07-21)**. Background Worker with
  `global_fetch_strictly_public` fetched its own `/cdn-cgi/image/…?format=webp` for a
  **35 MB** original (binding can't; remote limit is 100 MB): status 200,
  `content-type image/webp`, `cf-resized: internal=ok` (engine ran), valid WebP magic,
  58 KB out, streamed to R2 and read back intact; 2nd run `cf-cache-status: HIT` (transform
  edge-caches). Confirms server-side generation works for ALL sizes. Harness reverted;
  spike secrets deleted from the background worker.
- [ ] Phase 2 (pending spike): `quincy-renditions` queue (max_concurrency 1), generate
  web+thumb WebP on asset_ingested + AutoHDR-return, serve stored rendition from R2 with
  live-transform fallback; extend asset_renditions (content_type/width/height/spec_version).
- [ ] Phase 3 (pending): backfill 106 existing assets via the queue (not a browser grid).

## Open / in progress
- [ ] Phase 5 (queued): client-delivery Worker (signed links, gallery, favourites,
  pre-built zips, premium paywall) — Pixieset replacement, own launch gates.
- [ ] RAW↔Edited compare: synced zoom (deferred from the original compare build).
- [ ] Hardening: add expiry to the `/__transform-source` HMAC signature — currently
  unexpiring per-key URLs (`TODO(hardening)` in `portal/workers/app/src/routes/media.ts`).

### P0 — Safari-visible image outage (diagnosed 2026-07-21; no fix implemented yet)

- **Confirmed failure point (Mac Safari):** `/media/asset/:id/thumb` authenticates and returns
  its expected 302, but the final `/cdn-cgi/image/...` request is rejected by Cloudflare at KUL.
  A cache-bypassing request returned `403`, `cf-cache-status: MISS`,
  `cf-resized: err=9401`, Ray `a1e8ce67d99a4a9b-KUL`, and body
  `Transformation origin is not in allowed origins list`. An earlier cached failure was Ray
  `a1e8ca80cdbd4a9b-KUL` and advertised `max-age=14400`.
- **Cross-PoP proof:** fresh, uncached transforms of both a normal filename and a spaced
  filename succeed through LAX (`200 image/*`, `cf-resized: internal=ok`; Rays
  `a1e8cf3c6ca32a92-LAX` and `a1e8cf87dd73c3a8-LAX`). The signed source objects themselves
  also return `200`. This rules out Safari codecs/rendering, R2 absence, HMAC/path encoding,
  CORS/CSP, the prior filename bug, and the prior transform-rate-limit failure.
- **iPhone scope:** the supplied screenshots show the same terminal `LazyImage` placeholders,
  but screenshots do not establish the final HTTP status or serving PoP. Capture `cf-ray` and
  `cf-resized` through Remote Web Inspector. If it also returns `9401` from KUL, the shared
  outage is confirmed.
- **Configuration uncertainty:** Cloudflare documents same-zone sources as allowed and exact
  subdomains as separate origins, yet KUL and LAX enforce different state. The current
  Wrangler OAuth credential can list the zone but gets `403` reading
  `transformations_allowed_origins`, so it remains to determine whether the dashboard lost
  `quincy.flamingfire.my` or Cloudflare has a regional propagation/enforcement defect.
- [ ] **Control-plane repair:** in Images → Transformations → `flamingfire.my` → Sources,
  verify and re-save exact `quincy.flamingfire.my` with no unintended path restriction (and
  staging separately, or an intentional `*.flamingfire.my` entry). Do not switch to "any
  origin" except as a time-boxed emergency measure.
- [ ] **Cold multi-PoP gate:** after the save, test fresh transform keys from KUL and LAX with
  an image-capable `Accept`; require `200`, `Content-Type: image/*`, valid decoded dimensions,
  and `cf-resized: internal=ok`. If KUL remains `9401`, escalate to Cloudflare with the paired
  MISS Ray IDs above and the fact that transform and source use the same hostname.
- [ ] **Candidate code mitigation — spike before implementation:** hand-construct an
  equivalent transform using Cloudflare's supported origin-relative source path
  (`.../cdn-cgi/image/<opts>/__transform-source/...`) and test it at KUL against the
  absolute-source equivalent. Only implement this in `workers/app/src/routes/media.ts` if the
  relative form returns `200` while the absolute form returns `9401`; KUL may apply the same
  origin enforcement to both forms. If adopted, keep the HMAC-bound source route and add a
  production-mode test for the exact encoded 302 `Location`.
- [ ] **Cache recovery:** version the media/transform URL so repaired responses do not reuse
  browser and/or KUL edge caches' four-hour 9401 response, and replace the authenticated
  redirect's current private 24-hour TTL with an explicit short-lived/no-store policy
  consistent with expiring HMACs. Validate logout/access-revocation and secret-rotation
  behavior as part of this change.
- [ ] **Client resilience (secondary, not this outage's cause):** refactor `LazyImage` so its
  four-permit semaphore governs the actual rendered `<img>` request rather than a detached
  preload followed by a second cache-dependent element; add an explicit failed state with a
  user-triggered retry. Cover cold/disabled-cache and timeout cases in WebKit tests.
- [ ] **Durable removal of the request-time browser/PoP dependency:** after the cold multi-PoP
  transform gate passes, prioritize rendition-cache Phases 2–3 above. Generate and validate
  `thumb`/`web` renditions in the background, reject any non-image/`9401` response, retry
  safely, and serve stored R2 renditions directly with the live transform only as a temporary
  fallback. Background generation still depends on Cloudflare transformations, so do not
  begin generation/backfill while the multi-PoP gate is red.
- [ ] **Release verification:** extend the transform gate beyond its current single egress,
  then verify dashboard covers, the 103-image grid, lightbox hero, and filmstrip in Mac Safari
  and iPhone Safari using network status/headers (not screenshots alone). The existing app
  test explicitly skips the production 302 path under `APP_ENV=dev` and must be supplemented.

### Live QA sweep findings (2026-07-21, terra→sol→gate, test-only — see
### `docs/reviews/2026-07-21-live-qa-sweep-terra-sol.md` for full detail; no code changed yet)
- [ ] **P1** Dropbox delivery reliability + honest health status: webhook handoff failures are
  acked 200 (Dropbox never retries) and don't re-wake the DO on a deduped delivery, unlike
  Tonomo; the integration-status `error` is sticky (clears only on token refresh/OAuth
  reconnect, never on a successful ordinary sync); `lastEventAt` is never written so admin
  always shows "No events recorded". Currently showing `Error` / "Durable Object reset because
  its code was updated" in prod — likely a benign deploy-time artifact, but the sticky-health
  bug is real. Verify via a manual reconnect whether it clears to green.
- [ ] **P1** Comment/annotation *creation* fails silently — `postComment()`/`saveAnnotation()`
  in `Lightbox.tsx` have no `catch` (unlike their edit-handler siblings, which do). Also
  annotation create schema is `z.unknown()` for strokes while edit validates properly
  (`workers/app/src/routes/annotations.ts`).
- [ ] **P1** Mutation-safe staging QA corpus + E2E/background-worker test matrix — no live
  coverage exists for RAW↔Edited compare, collections/PDF versioning, Extras ingest, or any
  form-submit path; background Dropbox sync has no dedicated automated test suite.
- [ ] **P2** Narrow-screen (≤720px) nav loses Admin + Sign-out with no mobile-menu
  replacement (`Topbar.tsx`/`app.css`).
- [ ] **P2** Floorplan PDF+preview version pairing not actually enforced (independent
  per-kind counters); external collection links never bump `receivedCount`; collection
  tab-switch race can apply a stale response; compare-mode layout not reset on navigating to
  an unpaired asset; no CSRF/origin guard on custom `/api` mutations (required by
  Implementation-Plan); `LazyImage` terminal failure looks identical to loading (no retry).
- [ ] **P3** Lightbox zoom (works-as-designed gap, not a regression — see synced-zoom item
  above) · move 50MB document uploads off `formData()` onto presigned upload.

## Waiting on user / external
- [x] Dropbox app registered by user (2026-07-20); `DROPBOX_APP_KEY`/`SECRET` in `.dev.vars`
  AND uploaded as Worker secrets (app + background; secret also on webhook-ingress).
  `INTEGRATION_KEK` generated + uploaded (app + background). `TONOMO_WEBHOOK_TOKEN`
  generated + uploaded (ingress); value in `.prod-secrets.local`. See `docs/Dropbox-Setup.md`.
- [x] First live Dropbox sync CONFIRMED WORKING by user (2026-07-21) — the earlier
  "4 McGowen Ave" failure was a mistyped RAW folder path, not a code issue; team-space
  Path-Root support is live and exercised.
- [x] USER: in the Dropbox App Console — add the `sharing.read` scope (done 2026-07-21).
  Needed so Tonomo `dropbox.com/scl/fo/…` shared-link RAW folders resolve via
  sharing/get_shared_link_metadata (folder-PATH syncs already work without it).
  **CAVEAT — re-auth required:** a scope added in the console does NOT apply to the
  existing Dropbox connection's refresh token, which was granted under the old scope set.
  The connection must be re-authorized (disconnect + reconnect via the Integrations tab, or
  first-time consent) before the token actually carries `sharing.read`. Verify on the first
  real `scl/fo/…` sync; a 401/`missing_scope` there means the token is stale, not the config.
  Also verify redirect URI
  `https://quincy.flamingfire.my/api/integrations/dropbox/callback` + webhook URI
  `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/dropbox` per
  `docs/Dropbox-Setup.md`.
- [ ] USER: configure Tonomo with the webhook URL (deployed with the current wave; orchestrator
  confirms when live): `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/tonomo?token=<see .prod-secrets.local>`.
- [ ] Real interactive Google browser login check at `https://quincy.flamingfire.my` (sign-in
  attempted FROM staging still bounces to the prod origin — single `APP_ORIGIN`; use prod).
- [ ] Rotate/retire the production `BETTER_AUTH_SECRET`: the gate-rotation value still sits in
  gitignored `portal/workers/app/.prod-secrets.local` (confirmed present) — user should move
  it to the password manager and delete the file.

**Wave: AutoHDR per-project send + fetch (2026-07-22, DEPLOYED to prod — pending real-sample test)**
- [x] Follow-up (approved scope, 2026-07-22): review asset order is deterministic by case-insensitive filename, exact filename, then ID; API-to-PhotoGrid order propagation and AutoHDR direct/`Listing Images` path derivation are covered by focused tests.
- Deployed from branch `fix/p0-p3-qa` (pushed; NOT yet merged to `main` — prod is ahead of main).
  background version `2e037ae2`, app version `08061c24`. Live route `POST /api/projects/:id/fetch-edited`
  verified 403-gated in prod; homepage 200.
- Replaced the fixed-path `AutoHdrRoundtrip` (48h auto-poll) with two decoupled per-project
  operations against AutoHDR's own Dropbox layout (`/AutoHDR/<listing>/01-RAW-Photos` in,
  `04-FINAL-Photos` out — see `docs/lessons.md` for the doc discrepancies).
- `<listing>` folder name = the final RAW path segment for direct folder paths; if that segment is exactly `Listing Images` (case-insensitive), use its parent instead (`.../4 McGowen Ave.../Listing Images` → `4 McGowen Ave...`); pure helper + unit tests in `workers/background/src/autohdr/paths.ts`.
- **Send** (`AutoHdrSend`): one-shot per-file copy of selected RAW → `01-RAW-Photos`
  (Dropbox auto-creates parents); refuses duplicate case-insensitive filenames; stays
  `editing_autohdr`.
- **Fetch** (`AutoHdrFetch`, on-demand button on the Edited tab): lists `04-FINAL-Photos`
  (falls back to `04-FINALS-Photos`; missing folder = "0 finals yet", not an error via
  `listFolderIfExists`), ingests new JPEGs (accepted-photo filter) into the `edited`
  collection, pairs to RAW by plain basename with a `_vs`/`_staged` suffix fallback,
  advances `editing_autohdr → edited_review` only when every selected RAW has a returned
  edit (conditional, no stage regression). **This is current live behavior, but the proposed
  Dropbox webhook automation plan supersedes it for the future event-driven design:** the first
  successfully imported current final with credible frozen-handoff coverage begins Edited Review;
  complete handoff coverage becomes a separate QA/readiness diagnostic.
- Concurrency: `fetchEditedFromAutoHdr` is single-flight per project (returns the active
  queued/running job) since edited assets have no unique DB constraint. Both routes reject
  archived projects (409); jobs panel + retry handle `fetch_edited` alongside `autohdr`.
- **Deferred (known, revisit with a real AutoHDR output sample):** exact final-folder
  spelling; whether bracket-merged finals map 1:1 to RAW basenames (if not, unmatched
  finals still ingest with `source_raw_asset_id = null` — no data lost — but auto
  stage-advance may stall and need a manual move).
**Wave: Dropbox two-level grouping + AutoHDR privacy boundary (2026-07-22, completed locally — integration pending)**
- [x] Extend Dropbox RAW grouping from root/immediate-folder to root plus up to two nested
  folder levels (`Parent/Child`, preserving Dropbox display casing) and skip deeper paths.
- [x] Safely reconstruct missing legacy `assets.source_path` only when every reconstructed
  segment remains under the configured RAW root; otherwise use the existing R2-copy fallback.
- [x] Keep AutoHDR internal to Admin: non-admin project/stage API payloads present neutral
  `editing`; operational routes, jobs, diagnostics, polling, controls, and retry remain admin-only.
- [x] Add API/UI/classifier/path regression coverage; full typechecks, 145 tests plus 1 intentional
  app-test skip, production web build, and independent review passed.

**Wave: durable Dropbox sync + server-side copy_batch send (2026-07-22, DEPLOYED + live-verified)**
- `assets.source_path` captured at ingest (migration 0007, applied to prod directly as
  `ALTER TABLE assets ADD COLUMN source_path text`). Sync bounds downloads at 150/run with an
  auto-continuation (fixes "Too many subrequests" on large folders); reconciles hashless files by
  source_path so continuations terminate.
- AutoHDR send now copies Dropbox-sourced RAW **server-side** via `/files/copy_batch_v2` (R2-upload
  fallback for non-Dropbox assets) — **user-verified near-instant** in prod. copy_batch parsing is
  defensive to Dropbox's inconsistent union serialization (never throws post-copy); destination-
  conflict tolerance makes re-sends idempotent. background version `f9c7427d`.
- Follow-ups (not blocking):
  - [ ] Harden project DELETE: a stale `queued`/orphaned job blocks it forever (409). A stale
    `queued` dropbox_sync on `0bd99fef` blocked the McGowen dedupe; reaped manually 2026-07-22.
    Reap/ignore jobs past a staleness threshold, or clear terminal-eligible jobs on archive.
  - [ ] Add a partial unique index on `(collection_id, content_hash) WHERE content_hash IS NOT NULL`
    (+ dedup existing rows first) so concurrent sync runs can't insert duplicate assets (queue
    at-least-once redelivery race; sol F+G #2).

**Wave: archived view + manual edited uploads + Edited-QA sectioning (2026-07-22, DEPLOYED)**
- Admin **Archived projects view** (`GET /projects?archived=1`, adminBackend-only + Dashboard
  Active/Archived toggle) — fixes the catch-22 where archived projects were unreachable for
  restore/delete. app `b3ec2faf`.
- **Manual edited uploads**: new `uploadEdited` capability (admin+editor); upload pipeline
  (presign/direct/complete/`finalizeIngest`) parameterized by collection → can target the edited
  collection (`source='upload'`, no RAW pairing); Edited-tab uploader beside "Fetch edited from
  autoHDR". All upload routes now reject archived projects.
- **Edited-QA sectioning**: AutoHDR fetch tags `section='AutoHDR'`, manual upload tags `'Manual'`;
  Edited tab groups by section like RAW QA. Fetch dedup scoped to `source='dropbox'` so a manual
  edit can't suppress an AutoHDR result.
- Follow-up (not blocking): [ ] validate JPEG magic bytes from R2 on ingest (both RAW and edited
  currently trust the extension — pre-existing gap; sol H+I+J #3).
- [ ] **USER/testing (not yet available):** validate the fetch flow against a real AutoHDR
  `04-FINAL(S)-Photos` sample once one exists — confirm the exact finals-folder spelling
  (`04-FINAL-Photos` vs `04-FINALS-Photos`) and the finished-filename ↔ RAW basename mapping,
  especially for bracket-merged sets. Adjust the fetch matcher / stage-advance rule if names
  don't map 1:1. Code currently reads BOTH spellings and ingests unmatched finals as
  `source_raw_asset_id = null` so nothing is lost meanwhile.

**Wave: manual edited Dropbox publication + explicit rendition readiness (2026-07-24, local — not deployed)**
- [x] Edited upload completion now creates an asset as `publish_status='pending'`, retains its
  immutable R2 source, and queues one single-flight `ManualEditedPublish` Workflow per asset.
  The workflow uploads with Dropbox overwrite semantics to
  `/AutoHDR/<listing>/Manual-Uploads/<asset-id>/<filename>`; `<listing>` reuses the established
  direct-folder / `Listing Images` parent derivation.
- [x] The Edited collection and its received count include only `publish_status='ready'` assets.
  Dropbox failure marks the asset/job failed without deleting R2; admins can retry the failed job,
  while uploaders see an explicit failed/publishing state rather than a false completed upload.
- [x] Publication writers re-check archived state, persist the deterministic Dropbox destination
  as the manual asset `source_path`, use the asset ID destination for replay-safe overwrites, and
  enqueue durable thumb/web rendition work only after publication succeeds. A failed enqueue keeps
  the published asset ready but fails the retryable workflow/job; replay skips Dropbox and retries
  only the queue handoff. If creating that retry workflow fails, the ready asset still remains
  ready while its job is failed. Grids distinguish BOTH valid current thumb and web renditions from
  `Processing preview…`; media serving still prefers validated stored renditions and falls back
  only when necessary.
- [x] A centralized user-facing visibility guard returns not-found for non-ready Edited assets
  reached by direct ID (media originals/renditions, cover choice, review, annotations/comments,
  and annotation markup); RAW and non-Edited assets are unaffected. App-side publication-start
  failures now atomically retain R2, persist a failed job, and transition the pending asset to
  `failed` for a normal admin retry.
- [x] Fetch-edited UI now says **queued** and polls jobs, project state, and Edited assets through
  terminal completion instead of claiming that photos were already fetched.
- [ ] **Before deploy:** apply D1 migration `0008_manual_edited_publish` (including its active
  manual-publisher unique index), then exercise a real Dropbox success, retry-after-failure, and
  archive-race scenario against a non-production fixture.
- [x] **Pilot rendition diagnostics (local, 2026-07-24):** replaced raw rendition queue-error
  logging with allowlisted failure metadata only (queue/type/asset ID, stage, status, recognized
  content type, and `cf-resized` flags/codes). Retry/DLQ behavior remains `message.retry()`;
  focused Background tests/typecheck plus the full workspace verification matrix pass. Deployment
  is deliberately pending explicit authorization; only then may the existing pilot rendition
  message be retried to determine its production root cause.
- [x] **Rendition DLQ monitoring (local, 2026-07-24):** `quincy-renditions-dlq` had zero
  consumers bound, so exhausted rendition jobs (root cause was `TRANSFORM_SOURCE_SECRET` drift
  between `workers/app` and `workers/background` — see `docs/lessons.md`) piled up with no
  signal. Added a second background queue consumer that records each DLQ arrival into a new
  append-only `rendition_dlq_events` table (D1 migration `0011_dapper_tarantula`), plus
  `GET/POST /admin/renditions-dlq*` (list/replay/discard, gated `adminBackend`) and an
  Integrations-tab card in `Admin.tsx` mirroring the existing Tonomo poison-event UI. Full
  workspace typecheck/vitest/build passes.
  - [ ] **Before deploy:** apply D1 migration `0011` (same as the existing 0008/0009/0010
    callouts above), then redeploy `workers/background` before `workers/app` (service-binding
    order). Fixing the actual `TRANSFORM_SOURCE_SECRET` drift (`wrangler secret put` in both
    Workers) is a separate, still-pending operator action.