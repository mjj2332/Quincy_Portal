# Quincy Portal — Phase 0–2 build (started 2026-07-19)

Orchestration: Claude = planner/orchestrator/contract-layer; Codex agents = groundwork.
Production code lives in `portal/` (new monorepo). Agents may not touch anything outside `portal/`.

## Phase 0 — Foundations
- [x] WP-ROOT (orchestrator): monorepo scaffold — workspaces, tsconfig, deps preinstalled (better-auth 1.6 / drizzle 0.45 / hono 4.12 / vite 8 / wrangler 4.112 / TS 7), wrangler configs for 3 workers, node_modules Dropbox-ignored
- [x] WP-CONTRACT (orchestrator): `packages/shared` (capabilities, stages, media, XMP parser, AES-GCM credential envelope) + `packages/db` (drizzle schema v1 → migration 0000 generated, seed SQL w/ stages + bootstrap admin). Both typecheck clean.
- [x] **Spike ④ VERIFIED**: shared XMP parser passes 43/43 real fixtures from a 256 KB range-read (8×1-star, 35 unrated; null ≠ 0 semantics correct)
- [x] WP-B (codex): `apps/web` — Vite SPA shell + design-system port, sign-in screen, dashboard. Verified: tsc clean (independent re-run), vite build produces dist, fonts/brand ported, session gating + capability-gated admin nav correct.
- [ ] WP-C (codex, running): `workers/app` — Hono API, better-auth (Google-only, closed signup), capability middleware, users/projects/uploads/media/integrations routes, audit log
- [ ] WP-D (codex, running): `workers/background` (queue consumer, Dropbox sync engine + DO cursor alarm, autoHDR Workflow skeleton) + `workers/webhook-ingress` (Dropbox webhook verify → RPC)
- [ ] WP-F (codex): tests (vitest-pool-workers; XMP parser against real fixtures; capability matrix) + GitHub Actions ordered deploy
- [ ] Integration pass: typecheck all workspaces, fix drift, run tests
- [ ] Spike ①–③ code paths in place with "verify on first deploy" TODOs (need real CF account)

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
