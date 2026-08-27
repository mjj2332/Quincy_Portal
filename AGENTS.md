<!--
  Everything below this comment is mirrored verbatim in CLAUDE.md (read by Claude Code).
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

`docs/todo.md` is the live phase-by-phase status — the current-state source of truth, ahead of
this file. Check it before starting new work. `docs/lessons.md` collects real bugs from this
build; read it before touching auth, Hono routing, or the review lightbox. Keep both current
as you work.

When docs conflict, earlier wins: `docs/Decision-Sheet.md` (approved decisions D-01–D-19; D-13/D-15 revised 2026-08-24) →
`docs/Implementation-Plan.md` → `docs/PRD.md` / `Personas.md` / `Sitemap.md`. The Plan
supersedes `docs/Implementation-Proposal.md` — notably auth is **Google OAuth**, not
Cloudflare Access, and renditions use the **remote Image Transformation** path, not a
Container.

To-do and lessons live in **`docs/`**, not a top-level `tasks/`. Before delegating work to
Codex or Agy subagents, read `docs/Subagent-Orchestration.md`.

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

Plan docs live in `docs/plans/`. Once a plan's change is built, verified, committed, **and**
deployed to production, update its own status line to say so (with the commit hash) and move the
file to `docs/plans/implemented/` (`git mv`, to keep history). Leave a plan in `docs/plans/` while
it's still drafted/not built, or explicitly superseded/historical (its own status line will say
so) — `implemented/` means "matches what's live in production right now," not "was built at some
point."

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
  impersonation feature (`docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`),
  they act as that user for every author-only check, including this one — that bypass is
  intentional, toggle-gated, and audit-logged (`metaJson.impersonatedBy`), not a bug to fix.
- Media in R2 is **never deleted** on edit or delete: write a new immutable key and retain the
  old object.
- `portal/workers/app/.dev.vars` holds local dev secrets and is gitignored — never commit it.
- **Local dev Google sign-in works as of 2026-08-19**: `.dev.vars` sets
  `APP_ORIGIN=http://localhost:8787`, and that origin/redirect is registered on the OAuth client.
  Browse `http://localhost:8787` directly (build `apps/web` first) — not the Vite 5173 proxy — and
  sign in as the seeded admin (`mjj2332@gmail.com`; this is a closed system, `disableSignUp: true`,
  no other account works locally). See `docs/lessons.md` for why.
- **Chrome-browser QA/testing tasks go to Agy (danger-mode or YOLO-mode — see
  `docs/Subagent-Orchestration.md` §2.8–§2.10), not Luna and not the orchestrating session by
  default.** Agy took the testing role over from Luna 2026-08-27. Agy drives a human-authenticated
  dedicated Chrome over CDP (`docs/subagents/agy-cli.md` Option A) and never runs Google OAuth
  itself, on `mjj2332@gmail.com`, the disposable QA account (`tsseotsseo@gmail.com`), or anywhere.
  If a task needs an authenticated session that Chrome doesn't already have, Agy stops and reports
  it — it never works around the gap, proceeds unauthenticated, forges a session, or reads
  `BETTER_AUTH_SECRET`. The sanctioned fallback when Agy is blocked is the orchestrating session
  driving local-dev QA in its own Browser pane after a human sign-in. **Once signed in as Admin,
  use admin impersonation (`docs/Admin-Impersonation.md`) to test as a Photographer/Editor instead
  of a second sign-in** — one sign-in covers every role. YOLO-mode additionally permits real writes
  during a smoke test, but only while impersonating the disposable QA test account, which has no
  real memberships; danger-mode alone stays passive-only. Open-ended bug diagnosis that outruns Agy
  escalates to Luna (`codex exec`, xhigh).

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
2026-08-28 (TB4D) — next available number is **0036**. Branch off `main`.
**Prefer a bare `ALTER TABLE ADD COLUMN col TYPE CHECK(...)` over `drizzle-kit generate`'s
table-rebuild form when the check is single-column and NULL-satisfiable** — the rebuild form's
`PRAGMA foreign_keys=OFF` doesn't reliably persist across D1's remote migration execution even
though it passes every local/Miniflare check (see `docs/lessons.md`), so a rebuild migration that
looks clean locally can still fail against real prod data.

## Brand

Ink `#0a0a0a`, Warm Paper `#faf8f2`; signals `#3f5b3a` / `#9a6a1f` / `#7a2420` / `#2f3b4d`.
Fonts — Mazius Review (display), Apfel Grotezk (UI/body), Messapia (statement), Athelas
(long-form serif).
