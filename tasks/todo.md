# Quincy Portal — Phase 0–2 build (started 2026-07-19)

Orchestration: Claude = planner/orchestrator/contract-layer; Codex agents = groundwork.
Production code lives in `portal/` (new monorepo). Agents may not touch anything outside `portal/`.

## Phase 0 — Foundations
- [x] WP-ROOT (orchestrator): monorepo scaffold — workspaces, tsconfig, deps preinstalled (better-auth 1.6 / drizzle 0.45 / hono 4.12 / vite 8 / wrangler 4.112 / TS 7), wrangler configs for 3 workers, node_modules Dropbox-ignored
- [x] WP-CONTRACT (orchestrator): `packages/shared` (capabilities, stages, media, XMP parser, AES-GCM credential envelope) + `packages/db` (drizzle schema v1 → migration 0000 generated, seed SQL w/ stages + bootstrap admin). Both typecheck clean.
- [x] **Spike ④ VERIFIED**: shared XMP parser passes 43/43 real fixtures from a 256 KB range-read (8×1-star, 35 unrated; null ≠ 0 semantics correct)
- [x] WP-B (codex): `apps/web` — Vite SPA shell + design-system port, sign-in screen, dashboard. Verified: tsc clean (independent re-run), vite build produces dist, fonts/brand ported, session gating + capability-gated admin nav correct.
- [x] WP-C (codex): `workers/app` — better-auth Google-only closed-signup (user-create hook throws; disableSignUp+disableImplicitSignUp; inactive→session reject; deactivate revokes sessions), capability + membership middleware, users/projects(archive-only)/uploads/media/integrations/review routes, audit. Verified: tsc, boots locally, /api/health + auth route respond.
- [x] WP-D (codex): background worker (Dropbox client w/ refresh rotation, sync engine — JPEG-only/content_hash-idempotent/XMP-rating, DropboxSyncDO cursor alarm, AutoHdrRoundtrip workflow w/ source_raw_asset_id pairing + stuck detection) + webhook-ingress (constant-time HMAC, dedupe, fast-ack). Verified: tsc, both boot, challenge echo + 404 surface.
- [x] Integration fixes (orchestrator): removed WP-D's @quincy/shared type shim → unified lib ES2022+DOM incl. shared's own tsconfig; added missing POST /api/projects/:id/dropbox-sync route + typed Service<QuincyBackground> binding; 6/6 workspaces tsc green. Committed e6d3719 + 91ee387 on build/phase-0-2.
- [x] WP-E (codex): Phase-1 UI — ProjectWorkspace, UploadDropzone, PhotoGrid, Lightbox (+ added GET /projects/:id/assets route). Verified: tsc + build.
- [x] WP-F (codex): tests + CI. Verified: shared 13/13 (incl. 43-fixture XMP scan), worker 3/3 after orchestrator fixes.
- [x] Integration fixes wave 3 (orchestrator): **critical Hono middleware-leak bug** (use("*") capability gates 403-locking photographers out of later-mounted routes — caught by the photographer-session test, fixed by path-scoping, regression now locked); test-harness BACKGROUND stub + D1 SQL flattening; presign devDirect contract. Committed f9f30fe. Lessons → tasks/lessons.md.
- [x] WP-G (codex): Phase 2 — startAutoHdr RPC + workflow job lifecycle (queued→running→done/stuck@48h/failed), send-to-autohdr + jobs + retry routes, Edited QA tab, RAW↔Edited compare (sourceRawAssetId), annotations/comments API + freehand markup, threaded comments. Verified: 6/6 tsc, 13+3 tests, build. Deferred: synced zoom in compare.
- [x] Cloudflare resources provisioned (orchestrator, direct via authenticated wrangler — Codex's MCP path hit a non-interactive approval wall, abandoned): D1 `quincy-portal` (1d36b42e-f1e6-4659-8c9e-70afe822b6fa, account 5649541c0660b8c9b45d114a868ebc13), KV `quincy-portal-sessions` (1344f43c2da84b28bc8729ac15c36925), Queue `quincy-ingest` — all fresh, no collisions. Real IDs written into all 3 wrangler.jsonc (zero placeholders remain, tsc clean). Schema (24 tables) + seed applied to REMOTE D1; verified via query: 5 pipeline stages + bootstrap admin (mjj2332@gmail.com, active) present.
- [x] Cloudflare R2 enabled by user through the dashboard; MEDIA bucket `quincy-portal-media` created via wrangler (Standard storage class). Both `workers/app` and `workers/background` wrangler.jsonc already referenced it by name only — no ID edit needed.
- [x] Google OAuth client created by user: project "Quincy Portal" (`keen-virtue-502912-m2`), consent screen External/Testing, owner added as test user. Client ID `544815162886-4rm94a760isbac5h0e5l11uh562m0gh6.apps.googleusercontent.com`. Client secret deliberately kept out of chat (in user's password manager) — not written anywhere by the orchestrator.
- [x] `portal/workers/app/.dev.vars` created (gitignored, verified via `git check-ignore`): BETTER_AUTH_SECRET generated (openssl rand -base64 32), GOOGLE_CLIENT_ID filled in, GOOGLE_CLIENT_SECRET left blank for the user to paste directly into the file. Boot-verified: /api/health + /api/auth/get-session respond 200; Google sign-in route correctly 404s until the secret is pasted in (auth.ts only registers the provider when both ID+secret are present — expected, not a bug).
- [x] Google Client Secret added to the gitignored `portal/workers/app/.dev.vars`; local/provider configuration and production secret-name upload verified without exposing values.
- [x] R2 S3 API token created for presigned multipart upload (`quincyportal presigned uploads`, Object Read & Write, all current and future buckets). `R2_ACCOUNT_ID`, `R2_S3_ACCESS_KEY_ID`, and `R2_S3_SECRET_ACCESS_KEY` are set in the gitignored `portal/workers/app/.dev.vars`.
- [ ] First-deploy checklist:
  - [x] Better Auth Google linking is regression-tested: a verified Google identity links to the existing unverified `seed-admin`, creates one Google account + session, unknown identities cannot sign up, and inactive users cannot create sessions (8/8 app Worker tests green).
  - [x] Spike ②: real two-part R2 S3 multipart upload passed at 67,109,888 bytes; CORS preflight passed, `ETag` was browser-readable, completion size matched, and cleanup left zero spike objects.
  - [x] Spike ③: deployed routing passed — authenticated unknown `/api/*` + `/media/*` return JSON 404; `/` + unknown client routes return the SPA shell.
  - [x] First Worker deploy completed in dependency order: background `f11aa6a7-9fd8-4bc5-bdb3-5b0dc2795c9a`, webhook `c677c1bb-ca40-420e-b971-219ba465020b`, app current `4bf0994b-9f63-4ca3-bb91-e96c782f1f73`. Queue producer/consumer, Workflow, DO migration, D1/KV/R2/service/assets bindings, health endpoints, and six app secret names verified.
  - [x] Existing prototype preserved at `https://prototype.quincy.flamingfire.my`; new app remains live at `https://staging.quincy.flamingfire.my` and `https://quincy-portal-app.mjj2332.workers.dev`.
  - [ ] Spike ① / production cutover blocked by Cloudflare Image Transformations source policy. Cloudflare returned `cf-resized: err=9401` (`Transformation origin is not in allowed origins list`). In **Images → Transformations → flamingfire.my → Sources**, add exact source hostname `staging.quincy.flamingfire.my` (adding `flamingfire.my` does not cover subdomains), rerun the 50 MiB transform gate, then cut `quincy.flamingfire.my` to `quincy-portal-app`. The attempted cutover was automatically rolled back; production currently and deliberately remains on `quincyportal`.
  - [ ] Real interactive Google browser login remains to be performed after successful production cutover; automated link/callback contract and real Google initiation URL are verified.

## Phase 1 — Capture ingest + RAW QA
- [ ] WP-E (codex): dashboard (role-filtered) + project workspace + RAW grid + upload UI (multipart client) + file-count verification UI
- [ ] WP-G (codex): RAW QA tooling — ratings (pre-filled from XMP), labels, approve/flag, recommend, select-for-editing, lightbox, compare, freehand markup → R2
- [ ] Dropbox manual sync UI + studio OAuth connect (minimal)

## Phase 2 — autoHDR + Edited QA
- [ ] Workflow round-trip (copy selected → watch → ingest returns via source_raw_asset_id)
- [ ] Dropbox webhook live path (DO alarm cursor sync)
- [ ] Edited QA + RAW↔Edited compare + stuck-recovery screen

## Deferred to user (external prep — cannot be done by agents)
- [ ] Cloudflare account: create D1 db, R2 buckets, KV, Queues; paste real IDs into wrangler.jsonc files
- [ ] Google OAuth client (redirect URIs per env) → .dev.vars / wrangler secrets
- [ ] Dropbox app registration + studio account authorization
- [ ] First admin user email for seed

## Review log
- 2026-07-19 first deploy: full workspace typecheck green (6/6), tests green (11 total: app 8 + webhook 3), web build green; all three Wrangler dry-runs and startup analyses passed. Remote state verified at 24 D1 tables, 5 stages, active bootstrap admin, correct KV/R2/Queue; R2 CORS applied for production/staging workers.dev/local origins with PUT + `Content-Type` and exposed `ETag`.
- Workers deployed and healthy; app secrets uploaded as encrypted Worker secrets. Prototype copied to `prototype.quincy.flamingfire.my`; staging points to the new app. Production cutover health/SPA/Google-initiation checks passed, but the image gate returned Cloudflare 9401, so `quincy.flamingfire.my` was restored to `quincyportal` and verified. Temporary R2 object, D1 project/collection/asset/session rows, generated 50 MiB fixture, and local Wrangler state were all removed.
