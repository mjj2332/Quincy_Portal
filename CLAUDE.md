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
  React 18.3.1 current baseline + Vite SPA, Hono API on Cloudflare Workers, D1 / R2 / KV / Queues / Workflows,
  Google OAuth via better-auth.
- **`prototype/`** — the original Claude-Design export (CDN React, in-browser Babel, mock
  data, no backend). **Reference only: never extend it, never copy its structure into
  `portal/`.** Match its look and flows — its design system is already ported to
  `portal/apps/web/src/styles/`. Served at <https://prototype.quincy.flamingfire.my>.

## Read first

`docs/lessons.md` collects real bugs from this build — read it before touching auth, Hono
routing, or the review lightbox, and keep it current as you work.

Before delegating work to Codex or Sonnet subagents, read
`docs/subagents/Subagent-Orchestration.md` — Sonnet builds every build task now (§2.2), Luna tests
(§2.6), and §7 has what's additionally required for frontend/UI work: a new screen, a component
redesign, a visual convergence release, design-system adoption.

Authority order when docs conflict: `docs/PRD/PRD.md` → `Personas.md` / `Sitemap.md`. Auth is
**Google OAuth**, not Cloudflare Access; renditions use the **remote Image Transformation** path,
not a Container.

## Approved revamp targets — not live until their tracer bullet deploys

React 19.2 is a compatibility-only target. Tailwind/shadcn are incremental implementation tools
under Quincy visual authority. Future route/resource/range query keys must preserve drafts and
active drag/resize. The Project Workspace rail is the planned owner of Stage, Deadline, and team
coordination; Collaboration remains checklist/subtasks and discussion-focused. Membership changes
use role-specific deltas and cycles; `moveProjectStage` preserves fixed semantic Stage identities.
Project Deadline remains separate from shoot/checklist schedules. Checklist due/range scheduling and
an authorized Calendar range/direct-manipulation boundary are planned. The assignment-scoped
`external_editor` role uses one external-safe server projection and has no staff Notice Board,
global directory, or Admin scope. Calendar, External Editor, React 19, Tailwind, and shadcn remain
non-live until their owning tracer bullets deploy.

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
  `use("/x", mw); use("/x/*", mw)`. Also: an exact-path route registration
  (`app.post("/x/y", ...)`) does **not** match a trailing-slash request (`/x/y/`), even though a
  wildcard fallback (`app.all("/x/*", ...)`) or the underlying library being proxied to does — if a
  gated exact route sits in front of a permissive wildcard, register both the bare and
  trailing-slash forms of the gated path, or the trailing-slash variant silently skips the gate.
- Annotation edit and delete are **author-only** — admins are *not* exempt — for audit
  integrity. Every mutation is audit-logged. (The separate "Comments" thread feature existed
  briefly and was removed 2026-07-29 — annotations' own note field covers that need.) **One
  deliberate exception**: while an Admin is impersonating a user via the runtime-gated user-
  impersonation feature (`docs/Guides/Admin-Impersonation.md`), they act as that user for every
  author-only check, including this one — that bypass is intentional, toggle-gated, and
  audit-logged (`metaJson.impersonatedBy`), not a bug to fix.
- Media in R2 is **never deleted** on edit or delete: write a new immutable key and retain the
  old object.
- `portal/workers/app/.dev.vars` holds local dev secrets and is gitignored — never commit it.
- **Local dev Google sign-in works as of 2026-08-19**: `.dev.vars` sets
  `APP_ORIGIN=http://localhost:8787`, and that origin/redirect is registered on the OAuth client.
  Browse `http://localhost:8787` directly (build `apps/web` first) — not the Vite 5173 proxy — and
  sign in as the seeded admin (`mjj2332@gmail.com`; this is a closed system, `disableSignUp: true`,
  no other account works locally). See `docs/lessons.md` for why.
- **Chrome-browser QA/testing goes to Luna**, not this session, by default —
  `docs/subagents/Subagent-Orchestration.md` §2.6 has the unsandboxed invocation and the local-dev
  fallback when Luna is blocked; §2.8 has Agy's danger-mode/YOLO-mode/self-minting mechanics,
  dormant but kept current for reactivation. One habit worth stating here since it's easy to reach
  for a second sign-in instead: once signed in as Admin, use admin impersonation
  (`docs/Guides/Admin-Impersonation.md`) to test as a Photographer/Editor — one sign-in covers every role.
- **PR #44 AutoHDR preservation:** direct send is Admin-only and send-only, distinct from Stage
  movement; credentials remain on the background Worker. Later phases must not revive direct-path
  retrieval/polling or duplicate semantic delivery.

## Deploy

Order matters, because service bindings resolve at deploy time: **background →
webhook-ingress → app**, each via `cd portal/workers/<x> && npx wrangler deploy`. Host:
`quincy.flamingfire.my` (prod) — there is no staging environment (removed 2026-08-18; it shared
production's D1/R2/`APP_ORIGIN`, so it offered no real isolation and its Google OAuth never
worked). Prod config lives in Worker secrets. D1 migrations 0000–0028 are confirmed applied to prod (0021 dropped the `comments` table;
0022 migrated the seed admin's id to a real UUID; 0023 added `autohdr_handoffs.stalled_notified_at`,
applied 2026-07-30; 0024 added the `download_selection_tickets` table, applied 2026-08-04; 0025
added notice-board rich text/mention columns and the `notice_board_post_mentions` table, applied
2026-08-17; 0026 added `project_comments`/`project_comment_mentions`, applied 2026-08-17; 0027
added `project_subtasks`, applied 2026-08-17; 0028 added `project_subtasks.due_reminder_sent_at`,
applied 2026-08-17; 0029 added persisted `collection_links.position` with a per-collection
`created_at, id` backfill, applied 2026-08-19; 0030 added the additive
`project_comment_read_markers` table plus its project-cascade index, applied 2026-08-25 — this
pipeline's first live-production schema migration, with a verified pre-migration recovery export
saved to `/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/
db-recovery/`, reused for future migrations; 0031 added the additive `notification_outbox` and
`notification_delivery_ledger` tables plus seven named indexes, applied 2026-08-26 (TB4); 0032
added better-auth admin-plugin compatibility columns (`user.banned`/`ban_reason`/`ban_expires`,
`session.impersonated_by`) plus the additive `feature_flags` table (seeded OFF), applied
2026-08-26; 0033 added the additive project Deadline columns/`project_deadline_occurrences`/
`notification_preferences` tables plus a `notification_outbox` index, applied 2026-08-27 (TB4B);
0034 added the additive `project_activity_events` table plus three nullable `notification_outbox`
columns (`coalesce_key`, `coalesce_until`, `recipient_membership_cycle_id`) and one index, applied
2026-08-27 (TB4C); 0035 added 11 nullable `project_subtasks` schedule columns plus
`schedule_version` (all bare `ALTER TABLE ADD COLUMN`, single-column NULL-safe CHECKs), applied
2026-08-28 (TB4D); 0036 added `projects.production_notes`, `user.authorization_epoch` (NOT NULL
DEFAULT 0, `>= 0` CHECK), a nullable `notification_outbox.recipient_authorization_epoch`, and the
additive `external_edited_upload_sessions`/`external_edited_upload_parts` tables plus three indexes,
applied 2026-08-28 06:57:57 UTC (TB4E); 0037 added `projects.board_revision` (NOT NULL DEFAULT 0)
plus nullable `autohdr_handoffs.editing_entry_board_revision` and `jobs.stage_entry_board_revision`,
seeded the `tb5a_board_contract_enabled` flag OFF, normalized every unarchived project's
`board_position` to per-Stage gap-1024 ranks with `board_revision = 1` (preflight + postflight
CHECKs, 76-row `project_board_order_0037_rollback` capture table), and added a
`projects(stage_key, archived_at, board_position, id)` index, applied 2026-08-29 (TB5A); 0038
added a `project_activity_events(project_id, occurred_at DESC, id DESC)` covering index (no schema
change), applied 2026-08-31 13:54:53 UTC (TB6 Slice 0); 0039 added the additive
`notice_board_read_markers` table (`user_id` primary key, no FK to `notice_board_posts` so a
deleted post never regresses another user's high-water mark), applied 2026-09-01 to prod D1 via
the Cloudflare dashboard SQL console (wrangler's D1 API endpoints were returning consistent
server-side errors — `cf-d1: err=7500` — at deploy time; a Time Travel bookmark was taken
immediately before as the recovery point in place of a `wrangler d1 export`) (TB7) — next
available number is **0040**. Branch off `main`.
**Prefer a bare `ALTER TABLE ADD COLUMN col TYPE CHECK(...)` over `drizzle-kit generate`'s
table-rebuild form when the check is single-column and NULL-satisfiable** — the rebuild form's
`PRAGMA foreign_keys=OFF` doesn't reliably persist across D1's remote migration execution even
though it passes every local/Miniflare check (see `docs/lessons.md`), so a rebuild migration that
looks clean locally can still fail against real prod data.

## Brand

Ink `#0a0a0a`, Warm Paper `#faf8f2`; signals `#3f5b3a` / `#9a6a1f` / `#7a2420` / `#2f3b4d`.
Fonts — Mazius Review (display), Apfel Grotezk (UI/body), Messapia (statement), Athelas
(long-form serif).
