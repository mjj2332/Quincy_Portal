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

## Open / in progress
- [ ] WP-AB (running): project cover images on grid + kanban cards, user-selectable cover
  (POST /projects/:id/cover, `editProject`-gated, audit-logged), and the prototype's List
  view as a third dashboard mode.
- [ ] WP-AA (queued): admin backend completion — agencies/agents directory, pipeline stage
  config, Tonomo health + poison-event operator screen (view payload / retry / discard).
- [ ] Phase 4 (queued): Vimeo link tiles, floorplan PDF+preview versioning, copy PDF upload.
- [ ] Phase 5 (queued): client-delivery Worker (signed links, gallery, favourites,
  pre-built zips, premium paywall) — Pixieset replacement, own launch gates.
- [ ] RAW↔Edited compare: synced zoom (deferred from the original compare build).
- [ ] Hardening: add expiry to the `/__transform-source` HMAC signature — currently
  unexpiring per-key URLs (`TODO(hardening)` in `portal/workers/app/src/routes/media.ts`).

## Waiting on user / external
- [x] Dropbox app registered by user (2026-07-20); `DROPBOX_APP_KEY`/`SECRET` in `.dev.vars`
  AND uploaded as Worker secrets (app + background; secret also on webhook-ingress).
  `INTEGRATION_KEK` generated + uploaded (app + background). `TONOMO_WEBHOOK_TOKEN`
  generated + uploaded (ingress); value in `.prod-secrets.local`. See `docs/Dropbox-Setup.md`.
- [x] First live Dropbox sync CONFIRMED WORKING by user (2026-07-21) — the earlier
  "4 McGowen Ave" failure was a mistyped RAW folder path, not a code issue; team-space
  Path-Root support is live and exercised.
- [ ] USER: in the Dropbox App Console — add the `sharing.read` scope. Still needed:
  Tonomo webhooks deliver `rawFolderLink` as `dropbox.com/scl/fo/…` shared links, which
  the sync resolves via sharing/get_shared_link_metadata (folder-PATH syncs work without
  it). Also verify redirect URI
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
