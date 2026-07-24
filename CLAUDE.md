<!--
  CLAUDE.md and AGENTS.md are identical mirrors of this project guide.
  Update BOTH together. CLAUDE.md is read by Claude Code; AGENTS.md is the
  cross-tool equivalent for any other coding agent.
-->

# Quincy Portal — project & agent guide

**Scope:** this repository is the **Quincy Portal software project** only. The broader
Quincy Productions studio workflow (job orders, customer vault, document templates, render
scripts) lives in the parent Dropbox workspace, not here — do not expect those folders in
this repo.

## What this is

Quincy Portal is an internal media-pipeline + client-delivery web app for a real-estate
photography studio, replacing a Pixieset site. It runs the pipeline from RAW capture →
internal QA/markup → editing handoff → client delivery.

Two things live in this repo, and they are **not** the same:

1. **`portal/` — the PRODUCTION app.** Live at <https://quincy.flamingfire.my>. A TypeScript
   monorepo: React 18 + Vite SPA, Hono API on Cloudflare Workers, D1, R2, KV, Queues,
   Workflows, Google-OAuth auth (better-auth). This is where implementation happens.
2. **`prototype/` — the original design prototype.** Claude-Design-exported HTML/CSS/JS
   (React via CDN, mock data, no backend). **Reference only** — its look and flows guide the
   real build; it is not extended. It is served for demo at
   <https://prototype.quincy.flamingfire.my>.

## Repo layout

```
portal/        PRODUCTION app (monorepo — see below)
prototype/     design prototype — reference only, do not extend
docs/          product + planning docs, to-do, lessons, reviews (see "Source of truth")
test-data/     local-only test fixtures (media is gitignored; see test-data/README.md)
chats/         early design conversation transcript (archival)
CLAUDE.md      this guide (read by Claude Code)
AGENTS.md      identical mirror of this guide (for other agents)
README.md      human-facing repo overview
.github/       CI (portal.yml — typecheck/test/build; deploy scaffold)
```

`portal/` structure:

```
portal/
  apps/web/                 Vite + React SPA (the staff UI)
  workers/app/              staff API (Hono) + better-auth + serves the SPA
  workers/background/       Queue consumers, Workflows, Dropbox-sync Durable Object
  workers/webhook-ingress/  thin public webhook receiver (Dropbox; Tonomo later)
  packages/shared/          @quincy/shared — capabilities, pipeline stages, JPEG/media
                            rules, XMP star-rating parser, AES-GCM credential crypto
  packages/db/              @quincy/db — Drizzle D1 schema, migrations, seed
```

## Source of truth (in order; earlier overrides later)

1. **`docs/Decision-Sheet.md`** — approved product decisions D-01…D-15. Authoritative.
2. **`docs/Implementation-Plan.md`** — current architecture + phase plan. Supersedes
   `docs/Implementation-Proposal.md` where they conflict (notably: auth is **Google OAuth**,
   not Cloudflare Access; image renditions use the **remote Image Transformation** path, not
   a Container).
3. **`docs/PRD.md`, `docs/Personas.md`, `docs/Sitemap.md`** — product requirements & UX.
4. **`docs/todo.md`** — live phase-by-phase checklist. **Read this first** before starting
   new work to see what's done / in progress / blocked.
5. **`docs/lessons.md`** — real bugs & patterns from this build. Read before touching
   auth, Hono routing, or the review lightbox.

> This project keeps the to-do list and lessons in **`docs/`** (not a top-level `tasks/`
> folder). If a global convention tells you to write `tasks/todo.md`, use `docs/todo.md` here.

Other useful docs: `docs/Google-OAuth-Setup.md` (standalone handoff for configuring the
OAuth client), `docs/Subagent-Orchestration.md` (how subagents are driven),
`docs/reviews/` (archived architecture/consistency audits).

## Build & verify (run from `portal/`)

Before committing **any** change, all of these must be green:

- **Typecheck** each workspace: `npx tsc -p <ws>/tsconfig.json` for `packages/shared`,
  `packages/db`, `apps/web`, `workers/app`, `workers/background`, `workers/webhook-ingress`.
- **Tests:** `npx vitest run --config packages/shared/vitest.config.ts`,
  `npx vitest run --config workers/app/vitest.config.ts`, and the webhook-ingress suite.
- **Build:** `npm run build -w @quincy/web`.

The `packages/shared` XMP test validates against real fixtures in `test-data/` when present,
and **skips cleanly** when absent (so CI passes without the 614 MB media).

## Deploy — production is LIVE

- Hosts: `quincy.flamingfire.my` (production), `staging.quincy.flamingfire.my` (staging),
  `prototype.quincy.flamingfire.my` (the old prototype).
- Deploy order matters (service bindings resolve at deploy time):
  **background → webhook-ingress → app**. From each: `cd portal/workers/<x> && npx wrangler deploy`.
- Cloudflare resources are provisioned on the real account: D1 `quincy-portal`, KV
  `quincy-portal-sessions`, Queue `quincy-ingest`, R2 `quincy-portal-media`. Prod secrets are
  Worker secrets; local dev reads `portal/workers/app/.dev.vars` (gitignored — never commit).
- **`main` is the source of truth (2026-07-21).** `build/phase-0-2` was merged to `main`
  via PR #3 after Phases 0–4 shipped. New work: branch off `main`. D1 migrations **0000–0011
  are confirmed applied to prod** (verified directly against the remote `d1_migrations` table
  2026-07-24 — next available migration number is `0012`). **Read `docs/todo.md` for the
  live phase-by-phase status** — that is the current-state source, not this guide.

## Working agreements

- Don't run `npm install` in `portal/` without checking `package.json` — deps are pinned and
  installed.
- `@quincy/shared` is the **single source** for capabilities, pipeline stage keys, JPEG
  ingest rules, and XMP parsing — extend it, never duplicate its logic.
- **Hono routers:** never `router.use("*", mw)` on a router mounted at `/` — it leaks the
  middleware onto sibling routers (this shipped a 403 bug once). Path-scope instead:
  `use("/x", mw); use("/x/*", mw)`. See `docs/lessons.md`.
- Comment/annotation **edit and delete are author-only** (admins are *not* exempt) for audit
  integrity; every mutation is audit-logged.
- Media in R2 is **never deleted** on edit/delete — new immutable keys are written and old
  objects retained.
- Keep `docs/todo.md` and `docs/lessons.md` current as you work.

## Prototype (`prototype/`) — reference only

- `prototype/index.html` is the entry point; match its visual output and flows, but do
  **not** copy its internal structure (globals + in-browser Babel) into `portal/` — that has
  already been rebuilt as typed Vite/React modules.
- `prototype/_ds/` (the Quincy design system) is already ported into
  `portal/apps/web/src/styles/`.

## Brand quick reference

Colours — Ink `#0a0a0a`, Warm Paper `#faf8f2`, Signals `#3f5b3a` / `#9a6a1f` / `#7a2420` /
`#2f3b4d`. Fonts — Mazius Review (display), Apfel Grotezk (UI/body), Messapia (statement),
Athelas (long-form serif).
