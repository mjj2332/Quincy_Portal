<!--
  Everything below this comment is mirrored verbatim in AGENTS.md (for non-Claude agents).
  Update BOTH together.
-->

# Quincy Portal

Internal media-pipeline + client-delivery web app for a real-estate photography studio,
replacing a Pixieset site: RAW capture → internal QA/markup → editing handoff → client
delivery. **Production is live** at <https://quincy.flamingfire.my>.

This repo is the *software project* only — the studio's job orders, customer vault, document
templates and render scripts live in the parent Dropbox workspace, not here.

## Two codebases, not one

- **`portal/`** — the production app, and the only place implementation happens. TS monorepo:
  React 18 + Vite SPA, Hono API on Cloudflare Workers, D1 / R2 / KV / Queues / Workflows,
  Google OAuth via better-auth.
- **`prototype/`** — the original Claude-Design export (CDN React, in-browser Babel, mock
  data, no backend). **Reference only: never extend it, never copy its structure into
  `portal/`.** Match its look and flows — its design system is already ported to
  `portal/apps/web/src/styles/`. Served at <https://prototype.quincy.flamingfire.my>.

## Read first

`docs/todo.md` is the live phase-by-phase status — the current-state source of truth, ahead of
this file. Check it before starting new work. `docs/lessons.md` collects real bugs from this
build; read it before touching auth, Hono routing, or the review lightbox. Keep both current
as you work.

When docs conflict, earlier wins: `docs/Decision-Sheet.md` (approved decisions D-01…D-15) →
`docs/Implementation-Plan.md` → `docs/PRD.md` / `Personas.md` / `Sitemap.md`. The Plan
supersedes `docs/Implementation-Proposal.md` — notably auth is **Google OAuth**, not
Cloudflare Access, and renditions use the **remote Image Transformation** path, not a
Container.

To-do and lessons live in **`docs/`**, not a top-level `tasks/`. Before delegating work to
Codex or Agy subagents, read `docs/Subagent-Orchestration.md`.

## Verify before committing (from `portal/`)

`npm run typecheck` (covers all six workspaces) and `npm run build -w @quincy/web` must be
green. For tests, `npm run test --workspaces` **silently misses `packages/shared`** — it has a
vitest config but no `test` script — so also run
`npx vitest run --config packages/shared/vitest.config.ts`. That suite validates against real
fixtures in `test-data/` and skips cleanly when the media (gitignored, 614 MB) is absent, so
CI stays green without it. `apps/web` now has its own `test` script (a Node config for plain
logic plus a `happy-dom` config for component tests, chained together) and is correctly picked
up by `npm run test --workspaces` — no separate invocation needed for it.

## Gotchas

- Deps are pinned and installed — check `package.json` before any `npm install`.
- `@quincy/shared` is the single source for capabilities, pipeline stage keys, JPEG ingest
  rules and XMP parsing. Extend it; never duplicate its logic.
- **Hono:** never `router.use("*", mw)` on a router mounted at `/` — it leaks the middleware
  onto sibling routers (this shipped a 403 bug once). Path-scope instead:
  `use("/x", mw); use("/x/*", mw)`.
- Comment/annotation edit and delete are **author-only** — admins are *not* exempt — for audit
  integrity. Every mutation is audit-logged.
- Media in R2 is **never deleted** on edit or delete: write a new immutable key and retain the
  old object.
- `portal/workers/app/.dev.vars` holds local dev secrets and is gitignored — never commit it.

## Deploy

Order matters, because service bindings resolve at deploy time: **background →
webhook-ingress → app**, each via `cd portal/workers/<x> && npx wrangler deploy`. Hosts:
`quincy.flamingfire.my` (prod), `staging.quincy.flamingfire.my`. Prod config lives in Worker
secrets. D1 migrations 0000–0020 are confirmed applied to prod (verified against the remote
`d1_migrations` table 2026-07-28) — next available number is **0021**. Branch off `main`.
**Prefer a bare `ALTER TABLE ADD COLUMN col TYPE CHECK(...)` over `drizzle-kit generate`'s
table-rebuild form when the check is single-column and NULL-satisfiable** — the rebuild form's
`PRAGMA foreign_keys=OFF` doesn't reliably persist across D1's remote migration execution even
though it passes every local/Miniflare check (see `docs/lessons.md`), so a rebuild migration that
looks clean locally can still fail against real prod data.

## Brand

Ink `#0a0a0a`, Warm Paper `#faf8f2`; signals `#3f5b3a` / `#9a6a1f` / `#7a2420` / `#2f3b4d`.
Fonts — Mazius Review (display), Apfel Grotezk (UI/body), Messapia (statement), Athelas
(long-form serif).
