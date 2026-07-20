# Quincy Portal — build tracker

Orchestration: Claude = planner/orchestrator/contract-layer; Codex/other agents = groundwork.

## Status
- Branch `build/phase-0-2` (not yet merged to `main`). Production live at
  `quincy.flamingfire.my`; staging at `staging.quincy.flamingfire.my`; prototype preserved at
  `prototype.quincy.flamingfire.my`.
- Phases 0–2 built and deployed: foundations/auth/infra, capture ingest + RAW QA, autoHDR +
  Edited QA, and the review lightbox (comments, markup, edit/delete) through wave WP-O.
  Repo reorganized into `prototype/ · portal/ · docs/ · test-data/` with a fresh CLAUDE.md/AGENTS.md (2026-07-20).
- Latest verified state: 6/6 workspaces typecheck clean; tests `packages/shared` 13/13,
  `workers/app` 19/19, `workers/webhook-ingress` 3/3; SPA build clean.

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

**Repo hygiene**
- Reorganized repo into `prototype/ · portal/ · docs/ · test-data/`; wrote CLAUDE.md/AGENTS.md
  as the project guide (2026-07-20).

## Open / in progress
- [ ] RAW↔Edited compare: synced zoom (deferred from the original compare build).
- [ ] Hardening: add expiry to the `/__transform-source` HMAC signature — currently
  unexpiring per-key URLs (`TODO(hardening)` in `portal/workers/app/src/routes/media.ts`).

## Waiting on user / external
- [ ] Dropbox app registration (App Console: scoped app, `files.metadata.read` +
  `files.content.read/write`; redirect URI
  `https://staging.quincy.flamingfire.my/api/integrations/dropbox/callback`; webhook URI on
  the webhook-ingress worker) → put `DROPBOX_APP_KEY`/`SECRET` into `.dev.vars` + wrangler
  secrets. Blocks: live end-to-end Dropbox sync test and the Dropbox webhook LIVE path (DO
  alarm cursor sync) test — both are code-complete and deployed, just unverified live.
- [ ] Real interactive Google browser login check at `https://quincy.flamingfire.my` (sign-in
  attempted FROM staging still bounces to the prod origin — single `APP_ORIGIN`; use prod).
- [ ] Rotate/retire the production `BETTER_AUTH_SECRET`: the gate-rotation value still sits in
  gitignored `portal/workers/app/.prod-secrets.local` (confirmed present) — user should move
  it to the password manager and delete the file.
