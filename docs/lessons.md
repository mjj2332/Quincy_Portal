# Lessons — Quincy Portal build

- **Local dev Google OAuth was broken because `APP_ORIGIN` had no local override — better-auth
  derives its callback URL, `trustedOrigins`, and CORS/origin checks entirely from that one env
  var, not from the browser's actual address.** `wrangler.jsonc`'s base `vars.APP_ORIGIN` is the
  production URL, and nothing overrode it for local `wrangler dev`, so any local sign-in attempt
  tried to redirect through `https://quincy.flamingfire.my`'s callback — `redirect_uri_mismatch`
  at best. Fixed (2026-08-19) by adding `APP_ORIGIN=http://localhost:8787` to
  `portal/workers/app/.dev.vars` (gitignored) and registering `http://localhost:8787` as an
  Authorized JavaScript origin plus `http://localhost:8787/api/auth/callback/google` as an
  Authorized redirect URI on the existing "Quincy Portal" OAuth client (Google Cloud project
  `keen-virtue-502912-m2`) — both additive; the production entries were untouched. **Rule: browse
  `http://localhost:8787` directly for any local auth-gated testing, not the Vite dev server on
  `5173`** — `wrangler dev` serves the built SPA (`npm run build -w @quincy/web` first) and the API
  on one origin, so the browser's actual `Origin` header, better-auth's computed `redirect_uri`,
  and `APP_ORIGIN` all agree; splitting across Vite's proxy and the worker's own port works for
  ordinary API calls but adds an avoidable cross-origin variable to a flow that's already finicky
  to debug.
  Separately: this is a **closed staff system** — Google sign-up is disabled
  (`disableSignUp: true` in `workers/app/src/auth.ts`, enforced again by a `user.create` database
  hook that unconditionally throws), so only a user row that already exists in D1 can ever sign
  in. Local D1's only seeded user is the admin account from `packages/db/seed/0001_seed.sql`
  (`mjj2332@gmail.com`) — a real Google account, not a placeholder — so local browser testing that
  needs authentication can only ever be done by (or as) that account; there is no way to
  provision a second local test user without editing the seed.

- **`PRAGMA foreign_keys=OFF` does not reliably persist across statements in D1's remote migration
  execution, even though it worked fine against local Miniflare — a real production migration
  attempt (0020) failed on `DROP TABLE projects` with `FOREIGN KEY constraint failed`, even though
  the migration correctly opened with `PRAGMA foreign_keys=OFF` and every local
  test/`--local`-flag run passed clean.** This is `drizzle-kit generate`'s default table-rebuild
  form for a schema change requiring a `CHECK` constraint (recreate table, copy rows, drop old,
  rename new, `PRAGMA foreign_keys=ON`) — the correct, portable SQLite pattern, and it worked
  perfectly in every sandboxed/local check because none of those environments has real
  foreign-key-referencing rows across the many tables that reference `projects` the way production
  does. **The Miniflare-simulated D1 used by this repo's own test suites and `wrangler ... --local`
  did not reproduce this failure — a migration passing every local/sandboxed check is not proof it
  will apply cleanly against real remote D1.** Root-cause fix, not a workaround: avoid the
  table-rebuild path entirely when possible. SQLite (and D1) support adding a column with an
  inline `CHECK` constraint via a bare `ALTER TABLE ADD COLUMN col TYPE CHECK(...)`, **provided
  the check references only that same column and existing rows satisfy it under the column's
  default** (confirmed directly against `wrangler d1 execute --local` before ever touching prod
  again: a nullable column with a `... IS NULL OR (...)` check, defaulting new rows to `NULL`,
  passes trivially) — no `DROP TABLE`, no FK risk, no `PRAGMA` toggle needed at all. Prefer this
  over the generator's table-rebuild default whenever the check is single-column and
  NULL-satisfiable; verify the swap against a real local D1 (or, for something this consequential,
  a scratch table on the actual remote database) before applying to prod. Production was left in a
  clean, consistent state by the failed attempt (D1 migrations only mark a file applied on success;
  `projects`' schema and `d1_migrations` table were both unaffected) — always confirm that before
  re-attempting a fix, don't assume a failed remote migration rolled back cleanly.

- **Verify generated SQLite table-rebuild migrations against the pre-migration schema, if you do
  use one.** Drizzle correctly generated the new `CHECK`, but its 0020 copy `SELECT` also
  referenced the newly-added `priority` and `board_position` columns before they existed, so the
  migration would have failed on a real old `projects` table even before the FK issue above.
  Rule: run the full migration chain against a local SQLite/D1 fixture and replace new-column copy
  expressions with their defaults (`NULL`/`0`) when the generator emits an invalid pre-schema
  projection; then test the database constraint itself, including fractional values that API
  validation would normally reject. (This specific migration was ultimately replaced by the bare
  `ALTER TABLE` form above, which sidesteps this class of bug entirely — kept here since the
  underlying gotcha still applies to any table-rebuild migration this codebase generates in the
  future.)

- **Notification trigger correctness depends on each writer's own affected-row result.** The
  stage-transition surface is split between guarded helper calls, inline D1 batches, and ORM
  updates; a sibling `changes()` result can be successful while the stage write was fenced out.
  Rule: attach the shared post-success hook only to the helper's real transition, and at every
  inline site capture that statement's own result before fanout. Periodic stalled scans also need
  a partial unique source-key backstop so a repeated healthy cron tick is a true no-op.

- **Cron schedules are UTC; business rules may not be.** Cloudflare cron expressions fire in
  UTC, so a scheduled rule tied to a local operating day must derive that date from the scheduled
  instant with `Intl.DateTimeFormat(..., { timeZone: "Australia/Sydney" }).formatToParts()`.
  This keeps the rule correct through Sydney daylight-saving transitions.

- **Never `Date`-parse a date-only database value.** `yyyy-mm-dd` is a calendar date, not an
  instant; browser/runtime timezone conversion can display or compare the prior day. Validate its
  calendar components directly (including leap years), and leave malformed legacy text untouched.

- **Automatic stage changes need a guarded mutation and system audit in one transaction.** Guard
  the expected stage, archive state, and scanned source value in the `UPDATE`; insert the audit
  only when that update changed a row, in the same D1 batch. This makes retries idempotent and
  prevents a scheduler from overwriting a concurrent manual stage change.

- **Worker same-zone subrequests bypass the whole Cloudflare pipeline.** A Worker `fetch()` to
  its own zone hostname doesn't re-enter the Worker (loop prevention) and skips edge features —
  `fetch(url, {cf:{image}})` and an in-Worker `/cdn-cgi/image/...` fetch both dead-ended at the
  assets layer (404), while the identical URL worked as an eyeball request. **Rule:** to apply
  Image Transformations to a same-worker-served source, 302-redirect the client to
  `/cdn-cgi/image/<opts>/<signed-source-url>` instead of proxying — and test transform paths
  against the deployed zone, since local dev can't reproduce this.

- **Image Transformations source hostnames are exact, not inherited.** Enabling Transformations
  for `flamingfire.my` did not allow `staging.quincy.flamingfire.my` / `quincy.flamingfire.my`
  as sources (`cf-resized: err=9401`) — a parent domain is not a subdomain wildcard. **Rule:**
  add every exact source hostname in Images → Transformations → Sources; validate via
  `/cdn-cgi/image/` and inspect the `cf-resized` header; never cut over production until real
  rendition size/dimensions prove a transform actually happened (health-200 or original-fallback
  is not sufficient proof).

- **Synthetic media fixtures can fail platforms that real files pass.** A "valid" 50 MiB JPEG
  made by zero-padding a 1×1 image after EOI drew a Cloudflare Images internal error
  (err=9516), while real 28 MB and 84 MB photographs passed cleanly. **Rule:** gate
  media-pipeline tests with real photographs (or honest sips upscales of real photographs),
  never structurally degenerate synthetics; keep the fixture path overridable via env var.

- **Local Wrangler R2 must use one storage plane.** The app's local `MEDIA` binding is Miniflare's
  R2 simulator, but the production-shaped `wrangler.jsonc` also exposes remote R2 S3 credentials
  when they are present in `.dev.vars`. Before this fix, local presign used those credentials while
  completion verified the key through local `env.MEDIA`, producing `Uploaded object was not found
  in R2` after a successful remote PUT. **Rule:** local `.dev.vars` must set `APP_ENV=dev`, and
  the upload route must always choose its dev direct-PUT path in that mode; leave R2 S3 credentials
  blank for local uploads. A dev `MEDIA.put()` followed by `head()` succeeds, so this is a
  configuration/storage-plane split, not a Miniflare R2 persistence limitation.

- **Hono router-wide middleware leaks across sibling mounts.** `subRouter.use("*", mw)` +
  `parent.route("/", subRouter)` applies `mw` to every router mounted at `/` *after* it, not
  just the subrouter's own routes — two route files did this with capability gates, silently
  403-locking non-admin roles out of later-mounted routes; caught only by an integration test
  using a real photographer session. **Rule:** always path-scope router middleware
  (`use("/x", mw); use("/x/*", mw)`), never `use("*")` on a router mounted at `/`; a
  boot-and-curl check is not an authorization test — every capability needs at least one
  authenticated-session integration test per role. (Rule also lives in CLAUDE.md.)

- **Verify agent-reported success independently.** Codex sandboxes couldn't bind loopback
  ports, so their "boot verification" silently no-opped; one agent shimmed `@quincy/shared`
  types rather than fixing the root tsconfig cause. **Rule:** re-run every agent-claimed
  verification yourself, outside its sandbox; run a full-workspace typecheck after each wave
  (per-package green ≠ integration green); reject type shims/facades over workspace packages —
  fix the owning package's config instead.

- **Mid-session MCP registration doesn't become usable mid-session.** `claude mcp add` writes
  to `~/.claude.json`, but a running session's tool list is fixed at startup — `ToolSearch`
  won't surface a server registered after the session began, even once `claude mcp list` shows
  it "Connected." **Rule:** verify via ToolSearch after registering a new server; if empty,
  fall back to an already-authenticated CLI (wrangler, gh, etc.) for the actual work rather
  than blocking on a fresh session.

- **`codex exec` (non-interactive) can't approve MCP write actions.** Handing Codex a
  Cloudflare-provisioning task with its Cloudflare MCP configured failed silently
  ("account lookup was cancelled before execution") — `codex exec` runs with
  `approval: never`, and this MCP server's write actions need a per-call approval Codex can't
  grant non-interactively (read-only calls on the same server worked fine). **Rule:** for
  real-account write operations via an MCP a subagent can't self-approve, don't retry-tune the
  agent invocation — do it directly with an already-authenticated CLI instead.

- **D1 `exec()` processes SQL line-by-line.** Multiline statements fail with "incomplete
  input," and comment lines containing `;` break naive splitting. **Rule:** strip comment
  lines first, then split on statement boundaries, then flatten each statement to one line.

- **Follow explicit orchestration changes; don't infer intent from existing content.** The
  user switched from multi-agent to solo execution mid-task, and another agent-capability
  probe attempted afterward had to be stopped. Separately, an existing prototype already
  living at a hostname does not establish the user's intended target for that hostname — the
  actual instruction was to make it production and preserve the prototype elsewhere. **Rules:**
  (1) when the user explicitly changes orchestration mode, stop all agent work and don't
  probe/substitute other agents unless asked again; (2) check the user's stated target rather
  than inferring intent from what's already deployed; (3) for reversible domain cutovers, keep
  the old app live on a second hostname first as an immediate rollback target.

- **Style what's actually rendered — verify selector↔markup pairing.** Tile stars shipped
  as CSS targeting `.tstars svg`, but the component renders text `★` spans: the on/off
  distinction silently died and every rated tile read as 5★. **Rule:** when styling or
  reviewing a component, open the component and confirm the selectors match its real DOM
  (spans vs svg, class names) — a selector that matches nothing fails without any error.

- **Never invoke a Hono middleware factory manually with a body closure.**
  `requireCapability("x")(c, async () => c.json(...))` discards the closure's return value —
  the route falls through (404) on the success path. **Rule:** middleware goes in the route
  registration list; inside a handler body, do inline capability checks
  (`ROLE_CAPABILITIES[role].includes(...)`) and return the response directly.

- **Guard destructive operations at the writer, not only at the trigger.** Project deletion
  checked "no queued/running jobs" but a Dropbox sync could still start in the race window
  and write R2 objects under a purged prefix. **Rule:** background writers must re-check
  terminal state themselves (archived/deleted) before writing — trigger-side checks are
  TOCTOU by construction.

- **Purge every R2 keyspace before its D1 ownership rows cascade.** Project media is keyed by
  project ID, but renditions are keyed by globally unique asset ID. **Rule:** enumerate a
  project's asset IDs before deletion and include each `renditions/<assetId>/` prefix in the
  same object-purge batch; do not rely on the cascade to leave enough information afterward.

- **AutoHDR privacy is an API-boundary requirement, not a UI concern.** AutoHDR is an internal,
  Admin-only workflow. Editor/QA may select RAWs for editing, but only Admin may execute the
  handoff or receive provider, watch-folder, and handoff metadata. **Rule:** project/job
  endpoints must authorize the Admin-only operations and project those fields out of every
  non-admin response; expose the neutral **Editing** label/status to non-admin staff. Hiding an
  AutoHDR control in the SPA is not enforcement, because callers can bypass the UI.

## Image renditions / Cloudflare Images (2026-07-21)

- **Don't fire N concurrent live transforms of large originals.** Thumbnails were served by
  a per-view `/cdn-cgi/image/` transform whose SOURCE is the full 6–33 MB original. A project
  grid mounting fires 24–40 at once → Cloudflare EDGE rate-limiting returns 403 (an HTML
  error page, NOT a plain-text Images `ERROR 9xxx`). It looked like a regression because early
  test uploads were tiny and never stressed it; real Dropbox captures are large. **Rule:** the
  wire size of a thumbnail (~15 KB at 640px) was never the issue — the cost is transform
  concurrency on huge sources. Fix = limit client concurrency + make transforms cacheable.

- **Gate EVERY thumbnail consumer, not just the obvious grid.** The first image fix missed the
  lightbox filmstrip (raw `<img>` for all N assets) — opening the lightbox re-created the
  stampede. Audit all `/media/asset/.../thumb` `<img>` sites (grid, dashboard cover in
  grid/kanban/list, collection previews, lightbox filmstrip). Single hero images (`/web`) are
  fine ungated.

- **Concurrency-limited image loader = detached `new Image()` per attempt.** A module-level
  semaphore that toggles a rendered `<img>` src is fragile: reused DOM nodes let a late
  load/error event from a prior attempt release the wrong permit (over-issuing the pool), and
  a hung fetch (neither event fires) holds a permit forever → 4 hung = permanent pool
  starvation. **Rule:** preload each attempt through its own `new Image()` (fresh handlers, so
  stale events are structurally impossible), add a watchdog timeout (25s) that releases the
  permit for hung fetches, then render `<img src>` from the now-warm browser cache. See
  `apps/web/src/components/LazyImage.tsx`.

- **`width=N` alone is NOT a bounding box.** `/cdn-cgi/image/width=640` lets a portrait become
  640×960. Use `width=N,height=N,fit=scale-down` (preserves aspect, no upscale).

- **A Worker CAN fetch its own zone's `/cdn-cgi/image/` with `global_fetch_strictly_public`.**
  Spike ① found a same-zone Worker subrequest bypasses the CF pipeline (dead-ends at the
  assets layer) under DEFAULT fetch behavior. The `global_fetch_strictly_public` compat flag
  routes the fetch through Cloudflare's public front door instead — proven (2026-07-21) to
  transform a 35 MB original to WebP (`cf-resized: internal=ok`) and stream into R2. This uses
  the 100 MB REMOTE transform limit, NOT the 20 MB `env.IMAGES` binding cap (46% of our real
  captures exceed 20 MB). This is the mechanism for the durable server-side rendition cache.
  Cache Reserve does NOT store resized transform variants (only originals).

## Recurring drizzle/D1 error-shape trap (2026-07-21)

- **A D1 `UNIQUE constraint failed` message lives in `error.cause`, not `error.message`.** The
  installed drizzle wraps the D1 error in `DrizzleQueryError`; `.message` is just
  "Failed query...". A retry that tests `error.message` never fires → the first real
  concurrent collision 500s. **Rule:** walk the cause chain:
  `for (let e = error; e instanceof Error; e = e.cause) if (/UNIQUE constraint failed/i.test(e.message)) …`.
  (Same family as the earlier "scalar subquery renders 0 under drizzle/D1" lesson — never
  trust the top-level shape of a drizzle/D1 result or error; verify empirically.)

## Verification (2026-07-21)

- **Verify the real authenticated app in a browser once the user logs in.** After the user
  signed into `quincy.flamingfire.my`, `mcp__claude-in-chrome__*` (their logged-in Chrome, NOT
  the in-app Browser) confirmed the image fix end-to-end: `read_network_requests` showed 69
  `/media/asset` requests all HTTP 200, zero 403. Network-status verification beats a
  screenshot for "did the images actually load."
- **`codex exec` agents can't run vitest** (sandbox EPERM binding 127.0.0.1) — they ALWAYS
  report "tests couldn't start." Run the suites yourself before trusting a green claim.

## Renditions + transforms deploy (2026-07-21, session 2)

- **`err=9401 "Transformation origin is not in allowed origins list"` is a Cloudflare
  control-plane setting, not code.** Images → Transformations → **Sources** must list the
  **exact hostname** `quincy.flamingfire.my` under "Specified origins" — a `*.flamingfire.my`
  wildcard did NOT match, and the staged list must be **Saved** (an unsaved edit still rejects
  live). While broken it blocked ALL cold `/cdn-cgi/image` transforms on every PoP (LAX + KUL),
  so new uploads broke on all browsers, old images broke on Safari (Chrome served cache), AND
  rendition generation failed (the background worker's transform fetch hits the same 9401).
- **Never call native `fetch` as an object method.** The rendition generator stored bare
  `fetch` in a `{ store, fetch }` deps object and called `deps.fetch(...)` → `this = deps` →
  `TypeError: Illegal invocation` on EVERY job (0 renditions, silent unless you parse the queue
  `logs`). Wrap it: `fetch: (...a) => fetch(...a)`. Injected test fetchers are unaffected.
- **Cloudflare returns `image/jpeg` (not webp) for large `format=webp` transforms.** The 3200px
  `web` variant came back 200 / `cf-resized: internal=ok` / `content-type: image/jpeg`; the
  strict webp-only check dead-lettered every web message (thumbs, 640px, encode as webp fine).
  Renditions must be **format-agnostic**: accept webp OR jpeg, store the actual content_type,
  serve it back the same way, validate dims only for webp.
- **`wrangler r2 object get` can't read R2 keys containing spaces** — it returns "The specified
  key does not exist" for an object the Worker binding reads fine. Not a reliable existence check.
- **Codex-Chrome is policy-blocked on `quincy.flamingfire.my`** (raw CDP refused). Codex can read
  other sites, but authenticated mutations on the prod portal (e.g. the rendition backfill
  endpoint) must be run by the user via a DevTools console `fetch`, on the correct tab (a
  relative `/api/...` URL resolves against whatever origin the console is attached to).
- **wrangler tail JSON is pretty-printed** (multi-line per event); parse it as a stream of
  concatenated objects, and read queue-handler failures from each event's `logs`/`exceptions`
  (outcome can still be `ok` while a caught error is logged).
- **AutoHDR's own Dropbox docs contradict themselves on the output folder name.** Setup/Upload
  steps say `04-FINAL-Photos`; the Delivery step says `04-FINALS-Photos` (with an S)
  (`knowledge.autohdr.com/get-started/dropbox/*`, checked 2026-07-22). The input folder
  `01-RAW-Photos` is exact-case (they reject `01 RAW Photos`/`01-raw-photos`), and AutoHDR
  **creates the output folder itself** ("do not create this folder yourself"). **Rule:** never
  pre-create the finals folder; on read, try both `04-FINAL-Photos` and `04-FINALS-Photos`, and
  treat a Dropbox `path/not_found` on it as "no finals yet," not an integration error — otherwise
  every fetch before AutoHDR finishes records a false Dropbox connection error.
- **Dropbox `/files/upload` returns a `.tag`-less FileMetadata — don't parse it as a list entry.**
  `upload()` fed its response to `parseEntry` (which requires the `.tag` union discriminator that
  only appears on `list_folder` entries), so every upload threw `Dropbox response is missing .tag`
  AFTER the file was already written. In the AutoHDR send loop this failed the workflow on file #1
  (retries just re-overwrote it), so only 1 of 13 selected RAW reached `01-RAW-Photos`. Latent
  since the helper's inception — first exercised when AutoHDR paths went live (2026-07-22). **Rule:**
  parse concrete-endpoint metadata (`upload`, `get_metadata`, …) with a tag-less parser
  (`parseFileMetadata`); only `list_folder`/`Metadata`-union responses carry `.tag`. Diagnose
  partial-copy bugs from the **job's stored `error`**, not the destination file count.
- **AutoHDR merges brackets, so finished-filename→source-RAW is not guaranteed 1:1.** Several
  bracketed RAW can collapse into one final, and add-ons keep the original name plus a suffix
  ("add suffix VS / staged"). Basename matching must key RAW by extension+case ONLY (never
  suffix-strip a RAW name — `kitchen.jpg` and `kitchen_staged.jpg` would collide), and only
  suffix-strip the returned FINAL as a fallback lookup. Ingest unmatched finals with
  `source_raw_asset_id = null` (lose nothing) and gate any auto stage-advance on real matches.

## Manual edited Dropbox publication (2026-07-24)

- **A durable R2 upload is not yet a published edited asset.** A manual Edited JPEG first lands
  under its immutable R2 key with `publish_status='pending'`; only a successful Dropbox overwrite
  at `/AutoHDR/<listing>/Manual-Uploads/<asset-id>/<filename>` promotes it to `ready` and makes it
  visible/countable. **Rule:** failure must retain the R2 source and surface a retryable job;
  never treat an accepted browser upload as a completed external handoff.
- **Idempotency needs a database backstop, not merely a preflight query.** A queued/running
  partial unique job index on the asset-specific correlation key prevents two concurrent manual
  publish workflows. Destination paths include the immutable asset ID and Dropbox uses overwrite,
  so a retry after a lost response is safe even if Dropbox wrote the bytes before the workflow
  checkpoint persisted.
- **Preview readiness is independent of asset publication.** A ready asset with no valid current
  thumb and web renditions is still visible but must say `Processing preview…`, not `Image
  unavailable`. Both variants are required before the workspace opens the lightbox, because the
  lightbox requests `web` and must never fall through to a transform as a side effect of a
  thumb-only cache. Serving remains authoritative and verifies both D1 metadata and the R2 object.
- **Store the provider destination once publication succeeds.** The manual asset's `source_path`
  becomes its deterministic Dropbox destination at guarded promotion time; preserve that durable
  linkage alongside the system audit record so later investigations do not have to reconstruct a
  path from mutable project metadata.
- **List filtering is not an authorization boundary.** Pending/failed Edited rows can still be
  guessed by UUID and reached through media, review, cover, annotation, or nested-markup routes.
  **Rule:** centralize the condition `collection.kind !== 'edited' || publish_status === 'ready'`
  and apply it to every user-facing direct-ID lookup, returning the same not-found response as an
  unknown asset; do not accidentally gate RAW or non-Edited collections.
- **A post-publication rendition handoff must be retryable without undoing publication.** If the
  queue handoff reports false after Dropbox succeeded, failing the asset back to hidden is wrong.
  **Rule:** leave it `ready`, mark the workflow/job failed, and allow that failed job to replay the
  idempotent queue handoff only (no second Dropbox state transition). The same rule applies if
  creating that retry workflow itself fails: transition only `pending -> failed`; a ready asset

- **"Insert-then-fence" races still need a DB-level backstop, not just a reread.** Wave 3
  (Dropbox Webhook Automation) originally wrote a new "current" AutoHDR version row, *then*
  conditionally superseded the old one and swapped the pointer in the same `D1.batch()` — but a
  *losing* concurrent writer's batch still durably committed its own new row before its own
  pointer-swap failed, leaving a non-atomic cleanup `DELETE` as the only thing preventing two
  "current" rows from coexisting. An independent review caught this; the fix was a real partial
  unique index (`... WHERE superseded_at IS NULL`) plus reordering the supersede-UPDATE *before*
  the INSERT in the same batch, so the losing writer's own INSERT now violates the constraint and
  the *entire atomic batch* rolls back — no orphaned row, no separate cleanup call needed. **Rule:**
  whenever "exactly one current/active row" is a correctness requirement, enforce it with a
  partial unique index, not application-level check-then-write ordering, however carefully batched.
- **A same-wave build/review pair can still let a bug through — verify the fix, don't just re-run
  tests.** The fix pass for the finding above introduced its own bug: an `INSERT ... SELECT`
  statement had one extra `?` placeholder versus its column list (`D1_ERROR: 19 values for 18
  columns`), caught only because the full Workers-pool test suite was re-run independently after
  the fix (the fix's own sandbox couldn't run it — same loopback-EPERM limitation as the original
  build). **Rule:** a subagent's "all fixes applied, verification green" report is only as good as
  the tests it could actually run; always re-run the tests its sandbox couldn't, on every pass, not
  just the first one.
- **Removing a legacy cron and defaulting its replacement's flag off in the same deploy is a live
  regression, not a neutral no-op.** Wave 3 initially deleted `reconcileAwaitingRawProjects()` and
  its hourly cron trigger in the same diff that shipped the new root-scoped Dropbox monitors
  gated behind a flag defaulted to `"0"`. Deployed as committed, that diff would have silently
  removed the only live automatic RAW-reconciliation path with nothing active to replace it.
  **Rule:** when a plan's own rollout section says "retire the old mechanism only once the new one
  has live coverage," treat that as a hard constraint on what ships in *this* diff, not just
  ordering guidance for *when* to flip a flag later — keep the old mechanism's code and trigger
  in place as a safety net until the replacement is verified live, and remove it in a separate,
  later, low-risk deploy.
- **A worktree "branched from" another wave's branch name doesn't carry that wave's uncommitted
  changes.** Two waves' work each lived only as uncommitted changes in their own worktrees (per
  this project's own policy of never committing without being asked). Creating a third worktree
  via `git worktree add <branch>` for a branch that had zero commits just checked out the same
  commit as `main` — none of the "prior" wave's actual file changes came along, despite the
  branch name implying otherwise. **Rule:** uncommitted worktree state never transfers via branch
  name; if a later wave needs an earlier wave's in-flight changes, transplant them explicitly
  (`git diff` + `git apply`, or a direct file copy) and verify the transplant (typecheck) before
  building on top of it.
  must remain ready while its retry job records the failure.

## Rendition DLQ silent backlog (2026-07-24)

- **`TRANSFORM_SOURCE_SECRET` must be set identically in both Workers, and nothing enforces
  that.** `workers/app` signs (well, verifies — see `src/lib/transform-source.ts`) and
  `workers/background` issues/signs transform-source URLs (`renditions.ts`) using the *same*
  shared secret, set independently via `wrangler secret put TRANSFORM_SOURCE_SECRET` in each
  Worker. There is no automation, no CI step, and (before this entry) no doc beyond one line in
  the now-removed staging QA matrix doc. Drift between the two isn't a partial degradation — it's a 100%
  signature-rejection failure of every rendition job, indistinguishable at the UI layer from any
  other rendition failure (frames just show "Processing preview…" forever). **Rule:** when
  rendition generation fails for every asset (not just some), check secret parity across workers
  first, before assuming a code regression; re-set the secret identically in both with
  `wrangler secret put`.
- **A configured `dead_letter_queue` with no bound consumer is invisible by construction.** The
  `quincy-renditions` consumer (`portal/workers/background/wrangler.jsonc`) has always pointed
  `dead_letter_queue` at `quincy-renditions-dlq`, but nothing ever consumed that queue — 23 jobs
  piled up there silently with zero signal beyond the stuck-preview symptom above, until a human
  happened to go looking. **Rule:** a `dead_letter_queue` name in a queue consumer config is not
  monitoring by itself; it needs its own bound consumer (or a scheduled poll) or the backlog is
  structurally invisible. Fixed by binding a second consumer to `quincy-renditions-dlq` that
  records each arrival into an append-only `rendition_dlq_events` table (`open` → `replayed` |
  `discarded`) and acks immediately (retrying inside the DLQ itself just burns attempts before
  the root cause is fixed); surfaced via `GET/POST /admin/renditions-dlq*` and a card in the
  Integrations tab of `apps/web/src/screens/Admin.tsx`, mirroring the existing Tonomo
  poison-event pattern. No secondary DLQ is configured on this new consumer (would need
  provisioning a third Cloudflare queue resource) — a repeated D1 write failure on this consumer
  would still silently drop after 3 retries; this residual gap is intentionally left for a future
  pass rather than adding infrastructure speculatively.

## A dormant Workflow-id bug that only a feature flag could expose (2026-07-25)

- **Cloudflare Workflow instance ids must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` — `:` is
  rejected outright at `create()`** with `(instance.invalid_id) Instance has invalid id`, no
  compile-time or type-level warning. Both V2 AutoHDR id builders in
  `workers/background/src/autohdr/claims.ts` used `:` as a separator
  (`` `autohdr-send:${handoffId}` ``, `` `autohdr-fetch:${projectId}:${generation}:${n}` ``) —
  present since the feature was written, but never exercised because `DROPBOX_HANDOFF_V2_ENABLED`
  defaulted `"0"`. The legacy AutoHDR paths pass a bare UUID `jobId` and never touched this code,
  so nothing caught it until the very first real V2 send in production. **This meant AutoHDR
  auto-fetch could never have worked in any configuration reachable before that day** — send and
  fetch were both broken, just invisibly, for the entire time V2 existed.
  **Rule:** when a feature is built behind a flag that defaults off, its unique code paths get
  **zero** production exercise until flip day — treat "the flag has been off since this shipped"
  as "this code is untested," not "this code is stable." A unit test asserting the id format
  against the platform's actual constraint (not just "it doesn't throw") would have caught this
  before the flag was ever touched; one was added as part of the fix.
  **Recovery note:** the claim/handoff/mapping rows created before the `create()` call are
  correct and don't need to be discarded — only the `workflow_id` stored on the handoff needs
  repairing (it's reused verbatim on retry) before re-sending.

## Workers plan tier was the root cause of a whole day of "bugs" (2026-07-25)

**Resolved by upgrading to Workers Paid.** This entry is kept because the *diagnostic* failure
was expensive: three wrong root causes were shipped before the plan page was ever opened.

- **The account was on Workers Free, whose limits made this app structurally unable to run.**
  Free caps **subrequests at 50 per request** (Paid: 10,000), requests at **100,000/day**, and
  CPU at 10 ms/invocation. A RAW file costs ~9-10 subrequests (2 Dropbox content calls, an R2
  put, a rendition enqueue, several D1 statements), so **~5 images exceeded a whole invocation's
  budget**. Every "Too many subrequests by single Worker invocation" failure traces here.
- **Exhausting the daily request quota looks like unrelated application bugs.** Once the
  100k/day cap was hit (~14:57 UTC, after a 192-image import plus hundreds of renditions plus a
  60s DO alarm), *all* queue writes started throwing at once: `Rendition enqueue failed`
  (`RENDITION_QUEUE.send()`), `Dropbox root monitor failed` every 60s (`INGEST_QUEUE.send()` in
  the DO alarm), and `Worker's code had hung and would never generate a response`. Renditions
  stopped dead for ~8 hours with **queue backlog 0** and nothing in the DLQ — because the
  messages were never accepted, not because a consumer had died. **Rule:** when *multiple
  independent* subsystems fail simultaneously and the queue backlog is empty, suspect the
  platform/account tier before the application.
- **A `limits` block is rejected on Free and fails the entire deploy** — *"CPU limits are not
  supported for the Free plan"* (code 100328) — after passing `wrangler deploy --dry-run` and
  CI, briefly leaving `main` undeployable. **Rule:** `--dry-run` does not validate plan-gated
  fields; never merge a `wrangler.jsonc` change on dry-run evidence alone.
- **Check the plan page first.** This was mis-diagnosed three times — queue batching
  (`max_batch_size` 10 → 1), then a paid account on the pre-Feb-2026 1,000-subrequest default,
  then a dead queue consumer. Each was plausible, each produced a shipped change, none was the
  cause. The answer took ~30 seconds once the Workers plans page was opened. **Rule:** when a
  platform limit is hit, read the account's actual plan and its published limits *before*
  designing around an assumed value — and treat "I inferred the limit" as an untested premise.
- **Sizing note that still stands:** a per-run cap is really a subrequest budget and fans out
  ~10× per file. `MAX_DOWNLOADS_PER_RUN` is 40 (≈400 subrequests), comfortable under Paid's
  10,000 but far over Free's 50. Rely on the continuation/re-enqueue path for the remainder.

## Dropbox 429 burst amplification + Tonomo formatted_address fallback (2026-07-25)

- **A cursor-reset re-list can turn "one new file" into a Dropbox traffic-limit ban.** One
  AutoHDR image landing in Dropbox produced `[dropbox:transient] Dropbox files/download failed
  (429) ... this link has been automatically turned off for now` on the Admin dashboard.
  Confirmed NOT a hard-coded shared-link fetch — `download()`
  (`workers/background/src/dropbox/client.ts`) is a properly authenticated
  `content.dropboxapi.com/2/files/download` call; the shared-link-flavored 429 wording is
  explained by the *content* being served from a Dropbox shared folder (mounted via
  `sharing.read`), which Dropbox can traffic-throttle even on authenticated calls. The real bug:
  on a missing/invalidated delta cursor, `DropboxSyncDO.alarm()` re-lists the **entire**
  `/AutoHDR` tree (intentional recovery behavior, not the bug), which can match many
  `editing_autohdr` projects and start several `AutoHdrFetch` Workflows concurrently — and
  nothing in the stack paced downloads or respected Dropbox's `Retry-After` header on a 429, so
  a cold cursor could burst enough traffic to trip the limit. **Rule:** any code path that can
  fan out N downloads from a single trigger (delta re-list, batch reconciliation, etc.) needs
  both (a) explicit 429/`Retry-After` handling that backs off correctly — not just a generic
  "transient, retry on the usual cadence" bucket — and (b) some pacing/stagger between
  Dropbox calls, even a small fixed delay (100-250ms), so a burst doesn't compound. Fixed by
  adding `DropboxRateLimitError` (carries `retryAfterSeconds`, parsed from the `Retry-After`
  header with a JSON-body fallback), a `rate_limited` error classification that self-heals like
  `transient`, `Retry-After`-aware alarm rescheduling in `dropbox-sync.ts`, and pacing/stagger in
  `dropbox/sync.ts` (RAW downloads) and `workflows/autohdr-fetch.ts` (paced via the
  Workflows-native `step.sleep`, not a bare `setTimeout`, so the delay survives Workflow
  retries correctly).
- **`property_address.formatted_address` is a real, always-present fallback for a missing
  `.street`, but the parser never checked it.** Tonomo webhooks for manually-entered addresses
  (`property_address.isManualEntered`) can arrive with `.street` blank but
  `.formatted_address` (a full Google-Places-style string) still populated by their geocoder —
  `parseTonomoOrder()` (`packages/shared/src/tonomo.ts`) rejected these with "missing required
  street address" and poisoned the webhook event, even though a sibling helper
  (`addressFromManual`) already knew to look for `formatted_address` on a *different* field
  (`manualPropertyAddress`) but not on `property_address` itself. **Rule:** when a parser has
  several near-identical fallback-lookup helpers for different source objects, check that each
  one actually covers the same key set — an asymmetry between "helper A checks keys X/Y/Z" and
  "helper B (for a sibling field) checks only X" is an easy silent gap. Fixed by adding
  `property_address.formatted_address`/`formattedAddress` to the `street` fallback chain,
  ordered after the structured `.street` field (preferred when present) and before the looser
  `manualPropertyAddress`/order-name fallbacks. `projects.street` is free text, so the full
  formatted string can be used directly with no component parsing.

## Capture manifests + manual RAW Dropbox mirrors (2026-07-24)

- **Collection lifetime totals cannot verify a newly selected browser batch.** A collection with
  ten older assets plus a new one-file upload must report `1/1`, not `1/11`. **Rule:** carry the
  server-created manifest ID through every completion and stamp it on the immutable asset row;
  compute batch receipt by `assets.manifest_id`, never by filenames or collection totals. Keep
  every incomplete manifest active indefinitely so a newer batch cannot hide an older shortfall.
- **Provider-derived collection counts and browser manifests have different owners.** Dropbox
  sync owns folder-derived `collections.expected_count`; a manual upload manifest owns only its
  own `upload_manifests.expected_count`. **Rule:** manifest creation must never overwrite the
  collection count, and ingest status may fall back to collection totals only if the RAW
  collection has no manifests at all.
- **Verify path-depth assumptions relative to the configured sync root.** The canonical RAW
  folder is the listing folder itself, so a mirror at `Manual-Uploads/<filename>` has two relative
  components. The shipped `sectionForDropboxFile()` accepts that as a section even though it is
  four folders below `/Tonomo/Raw Files`. **Rule:** explicitly exclude the provider-owned
  `Manual-Uploads` subtree from RAW sync; global-root depth is not the ingest boundary.
- **A RAW mirror is a side effect, not a visibility gate.** R2/D1 become authoritative as soon as
  upload finalization succeeds. **Rule:** Dropbox mirror failures create retryable
  `manual_raw_publish` jobs and audits but never change the RAW asset's ready state or turn a
  successful upload response into a failure. Persist the exact Dropbox destination in
  `source_path` only after provider success.
- **When a background step controls visibility, its preconditions belong at the API boundary.**
  The inverse of the rule above: an *edited* manual upload is invisible until
  `ManualEditedPublish` writes it to Dropbox, so every precondition that Workflow needs is really
  an upload precondition. Shipping the check only inside the Workflow meant a project with no
  `raw_folder_path`/`raw_folder_link` (both optional at create, and Tonomo-owned so Portal cannot
  create one) accepted the upload end to end — presign 200, R2 bytes written, D1 row committed,
  HTTP 202 — and only failed minutes later, leaving `publish_status = 'failed'` and an asset no
  listing would ever return. To the uploader that is indistinguishable from data loss, and the
  only recovery (`/api/jobs/:id/retry`) sat behind `adminBackend` while `editor` is the role that
  actually holds `uploadEdited`. **Rule:** if a durable background step gates visibility, validate
  its inputs synchronously before accepting bytes, and return a machine-readable code the UI can
  turn into an actionable message. A 202 is a promise; only make it when it can be kept.
- **Distinguish provider folders you own from ones you don't.** `/AutoHDR/*` is Portal-owned, so
  the publish Workflow creates its own destination chain explicitly (each `create_folder_v2`
  absorbing `path/conflict`) rather than leaning on the provider's implicit parent creation —
  same shape as the AutoHDR hand-off's `ensure-dest-folder`. The Tonomo listing folder is *not*
  ours: the RAW branch deliberately creates only its own child so a missing listing parent fails
  loudly instead of being conjured. **Rule:** derive the chain from the destination path itself,
  so the folders created are provably the parents of the object written and cannot drift.

- **Queued reconciliation messages should carry identity, not mutable snapshots.** AutoHDR
  scaffold jobs originally looked simple enough to carry `raw_folder_path`, but PATCH, Tonomo,
  and Dropbox reconciliation can all update that field while an older delivery is waiting or
  retrying. The safe contract is only `{projectId, jobId}`: re-read the project row at execution
  time and fence every claim mutation against that same live value. A guarded UPDATE returning
  zero changes is a stale read, not success; restart the bounded read-decide-write sequence.

- **An auto-detected AutoHDR handoff is evidence, not a frozen send manifest.** Implicit
  handoffs intentionally store empty `selected_asset_ids_json` and `readiness_units_json`; any
  coverage UI must call that “auto-detected — no frozen manifest,” never “0 of 0 covered.”
  Their `workflow_id` is also an ownership placeholder, not a Workflow instance that was
  created. Recovery lookups for an explicit send must therefore require an eligible active
  state and a real `initiated_by` identity before returning that workflow ID.

- **"Never had a handoff" is not the same as "eligible for implicit AutoHDR."** Picking a live
  project to test the manual-drop auto-detect feature (2026-07-26), a project with zero
  `autohdr_handoffs` rows turned out to already be at `stage_key = 'edited_review'` — it had gone
  through the *pre-V2 legacy* send/fetch flow, which never wrote to the V2 handoff tables at all,
  so the absence of a handoff row didn't mean "untouched." Dropping a file into its
  `04-MANUAL-Photos` correctly matched the scaffold-claim router (`matched_count` incremented) but
  `claimImplicitAutoHdrHandoff()`'s own `stage_key IN ('raw_review','editing_autohdr')` guard
  correctly refused it — a silent, correct no-op, not a bug. **Rule:** when picking or querying for
  an implicit-eligible project, filter on `stage_key` explicitly in addition to handoff absence;
  a project can be fully processed and still show zero V2 handoff rows if it predates this feature.

- **The `secrets` context is not allowed in a job-level `if:` in GitHub Actions.** Using it there
  (e.g. `if: ${{ ... && secrets.FOO != '' }}` on a job) doesn't fail loudly — it invalidates the
  *entire* workflow file. Every run then shows "This run likely failed because of a workflow file
  issue" with zero jobs created (`.../actions/runs/<id>/jobs` returns `{"jobs":[]}`), for *every*
  job in the file, not just the one with the bad condition. This silently broke `portal.yml` for
  4 days (2026-07-21 → 2026-07-25, commit `143575d`) across every push/PR/merge to `main`, and
  looked exactly like an Actions-minutes/billing exhaustion (private repo, 0 jobs, ambiguous
  message) until cross-checked against the account's billing page (0/2000 min used) and
  githubstatus.com (all operational) ruled that out. **Rule:** never reference `secrets` in a
  job-level `if:`; gate on a job-level `env:` var instead (`env:` *can* read secrets; `if:`
  cannot). When `gh run view <id>` says "workflow file issue" but `python -c "import yaml;
  yaml.safe_load(...)"` says the YAML is valid, suspect a *semantic* validation rule like this one,
  not a syntax error — check every job's `if:` for context values it can't use (`secrets`, and
  `env` values scoped to the same job's `env:` block are also unavailable at job level).

- **CI jobs don't share a filesystem — a sibling job's build output isn't there for you.**
  `workers/app`'s tests serve the SPA through the Assets binding (`apps/web/dist`), but the `test`
  job only ran `npm ci`, never `npm run build -w @quincy/web`; the sibling `build-web` job builds
  it, but each GitHub Actions job gets its own fresh runner/checkout. Locally this was invisible
  because a stale `dist/` from a previous manual build was already sitting there. **Rule:** any
  job whose tests read another workspace's build artifacts must build that artifact itself (or via
  `actions/upload-artifact` + `download-artifact`), never rely on a sibling job having produced it.
  To catch this class of bug locally, `rm -rf apps/web/dist` before running `workers/app` tests.

- **A TipTap/ProseMirror editor's own native `keydown` listener fires before a React `onKeyDown`
  prop on a wrapper element, even though the wrapper visually contains the editor.** React 18
  delegates synthetic events to the root container and dispatches them during the event's bubble
  phase; TipTap attaches ProseMirror's listener directly to the actual contenteditable DOM node
  via `addEventListener`, which is the event's *target* — so it runs during the target phase,
  before the event ever bubbles to where React's synthetic dispatch happens. Concretely: the
  notice-board rich-text editor (`RichTextEditor.tsx`) intercepted `Enter` for mention-selection
  and Cmd/Ctrl+Enter submit via a wrapper `onKeyDown` prop; since `Enter` is a key ProseMirror's
  default keymap already handles (`splitBlock`), PM had already split the paragraph and moved the
  selection before the React handler's `event.preventDefault()` ever ran — corrupting the
  document (stray leftover query text, or a spurious extra paragraph) on every Enter-accepted
  mention, the default way users accept an autocomplete suggestion. Mouse-click selection and Tab
  were both unaffected (click never goes through PM's keymap at all; Tab has no default PM
  binding), which is exactly why a loose `expect.objectContaining`/`arrayContaining` test assertion
  passed anyway — it tolerated the corrupted leftover node instead of catching it. **Rule:** any
  key interception meant to run *before* or *instead of* ProseMirror's own default handling for
  that key must go through `editorProps.handleKeyDown` in the `useEditor(...)` options (TipTap's
  documented hook for this — it runs inside PM's own keymap resolution and can suppress default
  behavior by returning `true`), never a React-level `onKeyDown` on a wrapper element. Since
  `handleKeyDown` is captured once at editor construction, anything it reads from props/state that
  can change later (submit callback, char limit, disabled flag) needs a ref, not a closed-over
  value. And test this class of interception with a strict/exact assertion on the resulting
  document — a loose matcher can pass right through a real corruption bug.

- **A `codex exec` sub-agent can get stuck in a long, silent retry loop trying to run a command its
  own sandbox structurally can't support, instead of giving up and reporting the failure** — a
  distinct failure mode from the documented stdin-hang (`docs/subagents/codex-cli.md`), which prints
  a specific log line. Here, a fix-pass Codex instance tried repeatedly to run the `workers/app`
  Vitest suite (which needs Miniflare/wrangler) inside its own restricted sandbox, hit `EPERM`
  writing wrangler's own log file and a `Cannot find package 'cloudflare:test'` resolution error,
  and kept retrying rather than stopping — for **2.5 hours of wall-clock time while accumulating
  only ~2.8 seconds of CPU time**, with the run log showing the same file's full content dumped
  repeatedly rather than steady new progress. The actual code fix it had already written was
  correct and had already landed on disk via `apply_patch` (which persists immediately, independent
  of whatever the session does afterward) — only the post-fix *verification* attempt was looping.
  **Diagnose:** `ps -o pid,lstart,etime,time -p <pid>` — elapsed time wildly out of proportion to
  accumulated CPU time, especially past 30-45 min (normal `codex exec` rounds in this repo run
  15-30 min), is the signal; then check the run log for repeated/looping content (e.g.
  `grep -c "<a distinctive line from the file>" run.log` returning many hits) rather than forward
  progress. **Fix:** kill the process (`kill <pid pid pid>` for the shell/node/codex trio), confirm
  via `git status`/reading the changed files directly that the actual code edits are already
  correct and complete (don't assume a stuck session means bad output — `apply_patch` writes
  survive a later hang), then run the real verification suite yourself in a normal shell rather
  than trusting the sub-agent's own sandboxed attempt. For any Codex invocation whose *only* job is
  confirming a fix (not building it), explicitly forbid it from running
  Workers/Miniflare-dependent commands in the prompt — read-only code review doesn't need to
  execute them, and telling it not to try avoids this exact trap.

## Rich-text link marks silently lost on edit-load, not just on submit (2026-08-18)

- **A one-way JSON clone is not a schema translation, even when both shapes look almost
  identical.** The portable `RichTextDoc` contract stores a link mark flat —
  `{type:"link", href}` (`packages/shared/src/rich-text.ts:6`) — while TipTap/ProseMirror's `Link`
  mark schema treats `href` as a node **attribute**: `{type:"link", attrs:{href}}`. `toTiptap()` in
  `RichTextEditor.tsx` (shared by project comments and notice-board posts) was `JSON.parse(JSON.
  stringify(doc))` — a deep clone, not a shape conversion — so loading a comment that already
  contained a link fed ProseMirror a mark with no `attrs` key at all. `Mark.fromJSON` then calls
  `type.create(undefined)`, which falls back to the schema default (`href: null`) for every
  attribute; the link rendered with no `href`, reading to the user as "the link disappeared."
  Editing after that round-tripped the null straight back to the server, where `parseMarks()`'s
  `httpUrl()` check rejected it and the PATCH failed with 400 — so "the link vanished" and "I can't
  save" were the *same* bug, not two.
- **The reverse direction (`tiptapToRichTextDoc`) was already correct and had been for a while** —
  it reads `attrs.href` back out into the flat stored shape on every `onUpdate`. That asymmetry is
  exactly why *creating* a brand-new link via the toolbar's `setLink()` always worked (TipTap's own
  command populates `attrs.href` through its API, bypassing `toTiptap()` entirely) while *editing
  an existing* linked comment never did — the bug only bites on the load path, so it's easy to
  miss if your manual test is "type a link and save" rather than "open something that already has
  one."
- **Rule:** whenever a component owns a bidirectional conversion between a stored/wire format and
  a third-party editor's in-memory schema, treat both directions as independent code paths that
  need their own explicit mapping and their own test — a clone that happens to satisfy one
  direction is not evidence the other direction is a no-op too. If the two shapes differ only in
  *where* a value lives (top-level vs. nested under `attrs`), that's exactly the kind of mismatch
  that produces no type error (both are `Record<string, unknown>` as far as TypeScript is
  concerned) and no crash (the schema just silently substitutes its default) — so it has to be
  caught by a round-trip test that mounts the real editor, not by types or by testing serialization
  in only one direction. See the fix and its regression test:
  `docs/plans/implemented/RichText-Link-Edit-Roundtrip-Fix-Plan.md`.

## `ON CONFLICT DO NOTHING` needs its status code checked client-side, not just server-side (2026-08-18)

- **A dedup endpoint that returns 200-vs-201 to distinguish "already existed" from "created" is
  only useful if a caller actually reads it.** `POST /projects/:id/links`
  (`portal/workers/app/src/routes/collections.ts`) has a unique index on `(collection_id, url)`
  and inserts with `ON CONFLICT DO NOTHING`, then correctly returns 200 when the row already
  existed vs 201 when it created one. But `CollectionPanel.tsx`'s `addLink` called the shared
  `apiPost` helper, which (like the rest of `lib/api.ts`) only ever returned the parsed body and
  discarded `response.status` — so a duplicate-URL submission on a project's video-links tab
  looked byte-for-byte identical to success: same "Link added." toast, same cleared form, and
  silently zero rows written. A staff user hit this in production, diagnosed against the live D1
  audit log (fixed in commit `feb4ded`).
- **Rule:** when a backend intentionally overloads a single 2xx endpoint to mean two different
  outcomes (create vs. no-op-because-duplicate, upsert vs. insert, etc.), the frontend needs an
  explicit path to read the distinguishing signal — don't assume "the request succeeded" and
  "the thing you asked for happened" are the same fact. `lib/api.ts`'s `apiPost`/`apiGet`/etc.
  intentionally throw away `response.status` for ergonomics; where a caller needs it, use the
  new `apiPostWithStatus` (built on the same `requestWithStatus` internals, zero behavior change
  for every other caller) rather than re-deriving status from the response body's shape.

## Presigned provider uploads have two separate trust boundaries (2026-08-24)

- **Keep the provider credential on the Worker that owns the outbound operation.** The AutoHDR
  button is initiated through the app Worker, but the background Worker reads R2 and performs the
  provider calls, so `AUTOHDR_API_KEY` belongs only in that Worker's `.dev.vars`/Wrangler secret.
  Passing it through the app service response or browser would expand the credential boundary for
  no functional benefit.
- **A presigned object URL is already its own authorization token.** The AutoHDR Bearer key is used
  for photoshoot creation and finalization only. The S3 `PUT` must contain the raw JPEG bytes and
  signed-request headers, but never the AutoHDR `Authorization` header; leaking it to the storage
  host is both unnecessary and a credential disclosure. Test these headers as distinct requests.
- **Do not let a secondary notification rewrite the truth of an irreversible provider action.**
  Once finalization, the job update, and guarded Stage transition are durable, a later notification
  failure is logged for operations but cannot turn the send job back to `failed`. Otherwise a
  Workflow retry can replay only its cached post-commit tail and leave the UI claiming failure even
  though AutoHDR already accepted the paid work.

## Base UI `Input` without a `Field.Root` shares one module-level ref across every instance (2026-08-25)

- **Discovered while investigating a false-positive TB1 QA finding**, not a real bug in the
  shipped code — recorded here so it doesn't become one. `@base-ui-react`'s `Input` resolves its
  field context via `useFieldRootContext()`; TB1's `components/ui/input.tsx` renders it with no
  ancestor `Field.Root` anywhere in the app (confirmed by grep), so every instance falls back to
  the library's single shared `DEFAULT_FIELD_ROOT_CONTEXT`. In that fallback, `validation.commit`,
  `validation.change`, `registerFieldControl`, `setDirty`, `setFilled`, `setTouched`, and
  `setFocused` are all no-ops — which is exactly why `Input` behaves as a plain controlled
  `<input>` today and is safe to use this way.
- **The hazard:** `DEFAULT_FIELD_ROOT_CONTEXT.validation.inputRef` is one module-level
  `{ current: null }` object, and `FieldControl` attaches it as a ref to *every* `Input` instance
  in the app — last-mounted instance wins. Inert today because nothing reads that ref and no
  Base UI validation/`autoFocus` surface is in use. It becomes a real cross-field aliasing hazard
  the moment any future consumer wraps some `Input`s in a genuine `Field.Root` (enabling Base UI's
  own validation/`autoFocus` machinery) while others remain bare — the wrapped and unwrapped
  instances would silently contend for the same ref.
- **Rule:** if a future TB-phase introduces `Field.Root` anywhere in the app, audit every existing
  bare `Input` usage at the same time — either wrap them consistently or confirm the mixed
  bare/wrapped state is intentional and the shared-ref hazard is actually inert for that specific
  combination, rather than assuming today's "it's just a no-op" analysis still holds.
