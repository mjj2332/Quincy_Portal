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
- [ ] First-deploy checklist: spikes ①–③ verification, better-auth Google account-linking test for provisioned users, real CF resource IDs

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
(appended as work completes)
