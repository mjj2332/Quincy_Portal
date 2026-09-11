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

- **A new baseline-free guard merged *after* the code it governs turns `main` red without either
  PR ever being red — and "I ran the full suite" is not proof against it.** #92 added guard F
  (`test-seam.guard.test.ts`, rejects DOM-test selectors on a `data-slot` no Quincy file authors)
  on branch `feat/92-slice`, cut from `origin/main` at `5b6f1d0`. #81's board test — which reaches
  for `[data-slot="kanban-item"]` — landed in `1b8b267` *after* that worktree was created. The
  guard PR was green (371 + 798) because its base predated the violating test; the #81 PR was
  green because the guard did not yet exist. Both merged, and `main` at `62054e4` was red on a
  file neither PR touched. **Rule: for a PR that adds or tightens a guard, re-run the suite
  against `origin/main` merged into the branch immediately before merging, not against the branch
  alone.** A long-lived worktree makes this worse, because its base silently ages while other
  slices land. Fixed 2026-09-10 in `fix/92-guard-f-board-item`.

  The same merge sequence also cost the #81 commits entirely once: PR #89 was stacked on
  `feat/82-slice` and merged into it 65 seconds *after* that branch had itself merged into `main`,
  so GitHub reported #89 MERGED and auto-closed it while the commits sat on a dead end and `main`
  never received them. GitHub's stacked-PR auto-retarget only fires while the child is still open.
  **Verify a merge with `git cat-file -e origin/main:<a file the PR added>`, not the MERGED
  badge.**

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

- **A `CHECK` can be narrowed the same way, without a rebuild, as long as it's still inline.**
  Migration 0040 (#78) narrowed `projects.priority` from a 1-10 `CHECK` to 1-5. `drizzle-kit
  generate` emitted the usual table-rebuild for this, which would have hit the exact 0020 hazard
  above — 20 tables reference `projects.id`, 18 with `ON DELETE CASCADE`. It was replaced by a
  four-statement column swap instead: add a new column carrying the narrower `CHECK`, backfill it
  by clamping (`min(n, 5)`, not compressing — see ADR 0001), drop the old column, rename the new
  one into place. This works only because migration 0020 gave `priority` an **inline** column
  `CHECK`, not a table-level named constraint — SQLite (and D1) permit `DROP COLUMN` on a column
  with an inline check without a rebuild, and `RENAME COLUMN` carries that check along with it. A
  historical activity-payload rewrite is ordered last, after the column swap, and touches no
  `projects` row.
  ```sql
  ALTER TABLE `projects` ADD COLUMN `priority_next` integer CHECK(...);
  UPDATE `projects` SET `priority_next` = min(`priority`, 5);
  ALTER TABLE `projects` DROP COLUMN `priority`;
  ALTER TABLE `projects` RENAME COLUMN `priority_next` TO `priority`;
  ```
  `packages/db/test/migration-fk-safety.guard.test.ts` now mechanises the rule this class of bug
  keeps proving: no migration may contain a `PRAGMA ... foreign_keys` toggle, `legacy_alter_table`,
  or a `CREATE TABLE __new_<x>` / `ALTER TABLE __new_<x> RENAME TO` table-rebuild — with no
  baseline and no exception list, so a future generated migration that reintroduces the hazard
  fails the build instead of shipping to production.

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
  in only one direction. (The fix and its regression test were documented in a plan under
  `docs/plans/`, retired 2026-09-04 — see `git log` for that history if needed.)

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

## `RichTextEditor` propagated no-op Tiptap transactions, silently reverting external resets (2026-08-25)

- **Real bug, found in TB3 manual QA and fixed** (`2cba9a1`). Tiptap/ProseMirror can dispatch a
  transaction whose resulting document is byte-identical to the one already committed — one
  concrete trigger is `editor.setEditable()` being toggled during a mutation's `saving` state (the
  comment composer disables itself via `disabled={saving}` while a POST is in flight). The old
  `onUpdate` handler propagated every transaction unconditionally via `onChangeRef.current(doc)`,
  so this no-op event could land in its own render pass right after an external
  `setContent(emptyDoc())` reset (the composer clearing after a successful post, or exiting edit
  mode) and silently re-populate the field with the stale pre-submit text — even though the
  comment/edit itself was already correctly persisted server-side.
- **No automated test caught this** — it needs real ProseMirror/browser transaction timing that
  mocked editors and fake timers don't reproduce. It was only found by manually exercising the real
  local dev server in a real browser, then root-caused via temporary `console.log`
  instrumentation directly in the live page (not guessed from source reading alone).
- **Fix:** guard `onUpdate` to compare the transaction's resulting document against the last
  *committed* value (`valueRef.current`) and skip propagating when unchanged, rather than checking
  Tiptap's `transaction.docChanged` flag directly — that flag proved environment-dependent between
  real Chrome and this repo's DOM test harness (which simulates typing via direct `textContent`
  assignment + a synthetic `InputEvent`, not real keyboard/composition events, and produced
  different transaction semantics for the same simulated edit).
- **Rule:** any future change to `RichTextEditor`'s `onUpdate`/value-sync logic should be verified
  live in a real browser against the real dev server, not just against the DOM test suite — this
  exact class of bug is structurally invisible to jsdom-based tests.

## Local `wrangler dev` (`quincy-app-worker-dev`) crashes intermittently under sustained request load (2026-08-25)

- **Observed repeatedly during TB3 manual QA** — the local app Worker dev server (`wrangler dev`
  via `.claude/launch.json`'s `quincy-app-worker-dev` config) died outright (process gone, `ps aux`
  confirms no surviving `wrangler dev`/`workerd serve` process) at least five separate times across
  one QA session, each time after a burst of API requests (batch comment creation, rapid
  page-load/mention-lookup cycles) — not under any unusually heavy load by production standards.
  No corruption, no error dialog, just a dead process; `preview_list` reports zero running servers
  afterward.
- **Not a TB3 regression** — reproduced identically against `main` before and after TB3's own
  changes, and the crash pattern (silent process death under moderate sustained local request
  volume) matches known `workerd`/Miniflare local-dev stability issues, not application code.
- **Recovery is reliable and lossless:** restarting via `preview_start` (or `npx wrangler dev`
  directly) brings it back within seconds, and local D1 state persists correctly across every
  restart (already-created rows, sessions, and memberships all survive) — this matches the
  session's established pattern of local D1 persistence surviving dev-server restarts.
- **Rule:** when running any local QA or scripted load against `quincy-app-worker-dev` (batch
  fixture creation, repeated polling, etc.), expect the server to die at least once and check for
  `ERR_CONNECTION_REFUSED` in network request results before concluding a fetch actually failed for
  an application reason — restart and retry rather than treating a connection-refused error as
  applicative evidence of anything.
- **A second manifestation observed during TB4 manual QA (2026-08-26):** rather than the server
  dying outright, a single request can return a live `500` with `D1_ERROR: Failed to parse body as
  JSON` surfacing from an otherwise-unrelated route (`workers/app/src/routes/projects.ts:205`,
  the project-membership `PATCH` handler) while every other request — including the actual feature
  under test — succeeds normally. Confirmed not a code bug: the same UI sequence (edit a project's
  membership, then edit a comment to re-add a mention for that member) was repeated three times in
  a row and the comment-edit request itself returned `200 OK` with the correct body every time; the
  membership route's `500` didn't reproduce on any of the three attempts, matching an intermittent
  local D1 binding/request-parsing hiccup rather than a deterministic defect.
- **Rule (extended):** a `500` observed during local QA that doesn't reproduce on a clean repeat,
  especially one whose stack trace points at a route unrelated to the change under test, is more
  likely this same local-dev/D1 instability than a real regression — repeat the exact sequence a
  few times before concluding a defect exists, and check whether the failing route is even the one
  you're testing.

- **A Hono exact-path route registered as a gate in front of a permissive wildcard fallback can be
  silently bypassed by a trailing slash** (found during final-draft review of the admin-
  impersonation feature, 2026-08-26). `app.post("/api/auth/admin/impersonate-user", requireSession,
  requireCapability("manageUsers"), requireImpersonationEnabled, handler)` was meant to gate that
  one better-auth admin-plugin endpoint before the generic `app.all("/api/auth/*", handler)`
  fallback serves everything else ungated. Hono's exact-path matching does not treat
  `/impersonate-user` and `/impersonate-user/` as equivalent, but better-auth's own internal router
  (`rou3`) does — so a request with a trailing slash skipped Quincy's three gates entirely and fell
  through to the wildcard, reaching the plugin directly. Not exploitable here (the plugin's own
  permission check and a separate `session.create.before` hook both independently re-validate), but
  the intended layered gate was silently skippable. **Rule:** when an exact-path Hono route exists
  specifically to gate one endpoint in front of a wildcard that serves everything else, register
  both the bare and trailing-slash forms of that exact path — don't assume the two are equivalent
  just because the thing being proxied to treats them the same way.

## dnd-kit Kanban interaction timing in a real browser (TB5B)

TB5B's dnd-kit rewrite shipped with green happy-dom / Node suites, but happy-dom cannot exercise
PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll,
scroll containers, screen-reader delivery, or browser focus timing. Those paths were verified
out-of-band before deploy (`578d2a1`, app Worker `2b515484`).

- **Observed behavior:** no real-browser defect that the unit suites missed. The Agy local-dev
  functional matrix (Chrome, admin + impersonated Editor/External) and a separate real-hardware
  pass (touch device + VoiceOver/NVDA) both came back clean. What the mocks could NOT have caught
  but the real passes confirmed: (a) dragging into an **empty** Stage column issues exactly one
  `POST /stage` `placement:{kind:"append"}` with the correct single polite announcement — this
  was the one real regression, found by cross-model plan review (not a browser), fixed in
  `71203f1` before QA, and then re-confirmed in Chrome; (b) touch-drag activates on the 250 ms
  hold and does not fight scroll-fling; (c) keyboard drag → confirmation-required keeps focus
  inside the modal across animation frames; (d) the assertive dnd-kit live region and the polite
  Dashboard region do not stomp each other under a real AT.
- **Root cause:** n/a — behaviour was correct in Chrome. The empty-column bug's root cause (see
  `71203f1`): `resolveSemanticGap` treated a Stage key **absent** from the server board map as
  `{stale:true}`, but the server omits the key entirely for an empty column (it is never `[]`), so
  every "drop into empty column" looked stale and silently cancelled.
- **Fix:** none needed at the browser layer. The only code fix was the pre-QA `?? []` fallback in
  `resolveSemanticGap` / `moveToPositionOptions` and server-shaped test fixtures (`71203f1`).
- **Rule:** dnd-kit reducer/placement and `DndContext`-handler mocks prove command wiring only.
  Any change to sensor activation constraints, collision detection, autoscroll config, the
  optimistic-overlay/reconcile boundary, live-region politeness, or focus restoration must be
  re-verified in a real browser (functional matrix) and, for touch/AT-facing changes, on real
  hardware — the happy-dom suite passing is necessary, never sufficient. Also: when a fixture
  encodes a server response shape, derive it from the actual server projection, not from what
  feels natural (`stageKey: []` for an empty column was wrong in every TB5B fixture until
  `71203f1`).

This follows the existing TipTap lessons: native listener / event timing and scroll/focus behavior
can pass happy-dom while failing Chrome.

## A circular import in `@quincy/shared` that only `vite serve` catches (2026-08-30)

- **Symptom:** `npm run dev -w @quincy/web` (or the `quincy-web-dev` launch config) rendered a
  blank page. Console: `Uncaught ReferenceError: Cannot access 'externalAssetSchema' before
  initialization` at `packages/shared/src/external-upload.ts`. `npm run build -w @quincy/web`,
  `npm run typecheck`, and every vitest suite were **green** — the bug was invisible to all of
  them.
- **Root cause:** `external-upload.ts` imported `externalAssetSchema` from `external-project-dto.ts`
  and used it **eagerly** at module-init (`z.object({ asset: externalAssetSchema })`);
  `external-project-dto.ts` imported the upload response schemas back and used them eagerly in its
  `EXTERNAL_API_RESPONSE_SCHEMAS` record. A cycle. The `@quincy/shared` barrel exports
  `external-project-dto` then `external-upload`, so under Vite dev's **unbundled, per-file, source-
  order ESM evaluation** the cycle resolved upload-first and hit `externalAssetSchema` in its TDZ.
  `vite build` (rollup) and vitest (imports specific modules, not the whole barrel in order) both
  reorder past it, so only the dev server broke.
- **Fix (`f6af664`):** extract `externalAssetSchema` / `ExternalAssetDto` (+ its private
  `reviewSchema`) into a new **leaf** module `external-asset-dto.ts` with zero shared-package
  imports. Both `external-upload.ts` and `external-project-dto.ts` import the leaf; neither imports
  the other's asset schema. `external-project-dto.ts` re-exports the two names so the barrel API is
  unchanged (no consumer edits). `external-project-dto.ts` still imports the upload response
  schemas one-directionally — that is fine, the cycle is gone.
- **Rule:** `npm run build` / `typecheck` / vitest all passing is **not** proof the app loads.
  After any change to `packages/shared` import structure — especially adding an import between two
  modules that already share a dependency — start `vite serve` and confirm `/` renders with a
  clean console. And in `@quincy/shared`, never let two modules import each other when either uses
  the imported value at module-init (zod schema composition counts); factor the shared value into a
  leaf module instead.

## Kanban cross-column drag white-screened the app — reflow / measurement feedback loop (2026-08-31)

- **Symptom (shipped in TB5B):** on a board with two or more cards in a column, a pointer or
  keyboard drag toward another card white-screened the whole SPA. Console: `Minified React error
  #185` ("Maximum update depth exceeded"). Reload recovered. Cross-column drags also frequently
  just cancelled ("Cancelled moving X. It remains in …") without moving.
- **Root cause:** `ProjectKanbanBoard` rebuilt the rendered card lists (`displayOrders =
  proposal?.orders`) on **every** `onDragOver`, physically reflowing the columns to preview the
  drop. With `measuring: { strategy: MeasuringStrategy.Always }`, dnd-kit re-measured every
  droppable on that reflow, re-ran collision detection against the moved geometry, and produced a
  new `over` → new proposal → new reflow. Near a card boundary a *stationary* pointer flip-flopped
  the target every frame; the synchronous state updates from dnd-kit's sortable layout-effect FLIP
  (`useDerivedTransform`) blew React's update-depth limit and unmounted the tree (no error
  boundary exists, so → blank page). Relocating the moving card's `<SortableKanbanCard>` between
  two different `<KanbanColumn>` subtrees also unmounted its live sortable/activator node, so
  dnd-kit aborted the drag (and the keyboard sensor's blur-cancel fired on the lost focus). A
  secondary trigger sat in `MoveToControl` / `ProjectTeamControl`: an **inline** `ref={(node) =>
  floating.refs.setReference(node)}` — `@floating-ui/react`'s `setReference` calls `setState` with
  no equality guard, so a new ref identity every render (the inline arrow) storms detach/attach.
- **Fix:** freeze the rendered order to the pre-drag snapshot for the whole drag (`displayOrders
  = baseOrders`); the DragOverlay carries the moving card, dnd-kit's sortable transforms open the
  gap, and `proposal.gap` drives only the drop indicator / Stage highlight / announcements.
  `proposal.orders` is still computed for the commit/settle path. Also: `measuring` →
  `BeforeDragging` (freeze rects at drag start), `handleDndOver` reuses the prior proposal object
  when the semantic gap is unchanged (idempotent `setProposal`), and both `setReference` call
  sites use a stable `useCallback` ref (matching the correct `ref={floating.refs.setReference}`
  pattern already in `SubtaskChecklist`).
- **Why QA missed it:** every Kanban DnD test mocks `@dnd-kit/core`'s `DndContext`, so real
  collision geometry / measurement / the layout-effect FLIP never run — the file itself says
  "active-drag rendering is QA-phase real-browser only." The functional QA matrix was run on
  sparse boards (≤1 card per column) where no card-vs-column collision partner exists to
  oscillate against.
- **Rule:** never rewrite a dnd-kit `SortableContext`'s `items` (or the DOM order it renders)
  from inside `onDragOver`. Let the sortable strategy's transforms show the gap and commit the
  reorder in `onDragEnd`. Pair any live-reordering board with `MeasuringStrategy.BeforeDragging`,
  not `Always`. And never pass an inline ref callback that calls `@floating-ui/react`'s
  `setReference` — use the stable `refs.setReference` directly or wrap it in `useCallback`.
  Real-browser drag verification on a **multi-card** column is mandatory for any change under
  `ProjectKanbanBoard` / dnd-kit config.

## Floating-UI focus restoration on Escape must be synchronous — a primitive-level invariant, not a one-off fix (TB8-02)

- **Rule:** any popover/menu built on `@floating-ui/react` that owns its own Escape handling
  must call `.focus()` on the reference/trigger element **synchronously**, in the same handler —
  never via `setTimeout`, `queueMicrotask`, `requestAnimationFrame`, or a `useEffect` reacting to
  the close. `AnchoredPopover.tsx`'s `useAnchoredPopover().onKeyDown` does this
  (`(floating.refs.reference.current as HTMLElement | null)?.focus()` runs directly inside the
  Escape branch, no deferral of any kind).
- **Why it matters, concretely:** a deferred focus call sits in a queue. If a *second* popover
  opens before that queued call fires, the stale timer still fires afterward and steals focus
  from — and can close — the popover that opened after it. This is not hypothetical: it shipped
  once as a live bug (`window.setTimeout(() => …focus(), 0)`, fixed by commit `08f4653`) and
  surfaced as a `ProjectCollaborationPanel` Escape test that failed only in the full suite, never
  in isolation — the exact signature of a cross-instance timer race.
- **Re-derived twice now:** first by `08f4653`'s own fix, second by this plan's §7.1 audit, which
  found the rule already correctly followed and made it an explicit, tested acceptance criterion
  (asserted by grepping `AnchoredPopover.tsx` for `setTimeout`/`queueMicrotask`/
  `requestAnimationFrame`, plus a same-task `document.activeElement` assertion with no timer
  flush). Two independent rediscoveries of the same invariant is the signal to write it down here
  rather than leave it findable only in a commit message or a future PR review.
- **Where this generalises:** the app's other overlay primitives (`Modal`, the shared `Menu`)
  either delegate Escape-focus-restore entirely to their library (`FloatingFocusManager`'s
  `returnFocus`, Base UI's `Menu.Root`) or, like `AnchoredPopover`, restore it by hand — in every
  case, the next person adding an Escape handler to a floating/portaled surface should default to
  "restore focus in the same synchronous call that closes it," not "restore it after the DOM
  settles."

## Two ways a green test quietly stops proving anything (TB8-04, 2026-09-02)

Both were found while building TB8-04. Neither is about the feature under test; both are about
assertions that *looked* precise and weren't.

**1. A hardcoded future date is a time bomb.** `KanbanCardPreview.dom.test.tsx` pinned a fixture
deadline at `2026-09-01T22:00:00.000Z` and asserted the card reads `Due 2026-09-02 08:00 Sydney`.
The card picks "Due" vs "Overdue" from `isDeadlineOverdue(project.deadlineAt)`
(`ProjectKanbanBoard.tsx:262`), whose `now` defaults to `Date.now()`
(`packages/shared/src/project-deadline.ts:140`) — so the test passed for as long as that instant
stayed in the future and has failed unconditionally since 2026-09-02, with
`expected 'Overdue …' to contain 'Due …'`. Fixed by freezing the clock
(`vi.useFakeTimers({ now: testNow })` / `vi.useRealTimers()`), the idiom
`Dashboard-kanban-sort.dom.test.tsx` already used — *not* by relaxing the assertion, which would
have thrown away the only thing the test proves. **Rule:** any test whose expected output depends
on the current time must freeze the clock. A date literal in a fixture is a countdown, and the
failure lands on whoever is mid-branch when it expires — far from the change that "caused" it.

**2. `expect(markup).not.toContain("disabled")` is unsafe on any Tailwind-painted surface.**
`ProjectFields.test.ts` asserted an input was not disabled by searching the rendered tag for the
bare substring `disabled`. That held only while the element carried no utility classes. The moment
`FIELD_BOX` landed on it — carrying `disabled:bg-surface-sunken`, `hover:not-disabled:…`,
`read-only:…`, and (on the tiles) `has-[:disabled]:…` — the assertion started matching a *class
token* and failed on a perfectly enabled input. Three instances in one file had the same shape.
Fixed by keying off the attribute rather than the word: `/\s(?:readonly|readOnly|disabled)=""/`
and `/\sdisabled=""/`. That is strictly *stricter*, not looser — a real `disabled` attribute is
still caught, a class token no longer produces a false positive. **Rule:** every Tailwind state
variant puts its own name into the class attribute, so a bare-word search over markup tests the
stylesheet as much as the DOM. Assert on the attribute (or query the DOM node's `.disabled`),
never on a substring of the tag. The same trap applies to `readonly`, `checked`, `required`,
`hidden`, `open`, `invalid`, and `selected`.

## `@cloudflare/vitest-pool-workers` leaked `SELF.fetch` dispatch — the `workers/app` timing flake (2026-09-03)

**Symptom.** One test in `workers/app/test/api.test.ts` — "manages and edits manual collection
links while preserving immutable Tonomo links" (`:3160`) — intermittently failed
`Test timed out in 5000ms`. It ran ~0.6s alone and **3.88s ± 0.07s** in-suite: not a stall, a
stable cost that happened to sit 22% under the budget, so any load tipped it over.

**Root cause.** `@cloudflare/vitest-pool-workers` 0.18.6 (and 0.22.0) leaks on its `SELF.fetch`
service-binding round trip: *every* `SELF.fetch` permanently raises the cost of every later
`SELF.fetch` **in the same test file**. Per-request cost is linear in prior request count, so
cumulative cost is quadratic. A ~20-line standalone probe, 8 rounds × 50 identical 404 requests,
no migrations and no seed:

```
CURVE appFetch  perRound=[12,6,5,5,5,6,5,5]                 <- app.fetch(req, env, ctx), FLAT
CURVE selfFetch perRound=[36,74,151,273,444,665,925,1265]   <- SELF.fetch(), 35x growth
```

`api.test.ts` is one 3,700-line file with **354** `SELF.fetch` calls across 121 `it` blocks, so its
late tests inherited the whole accumulated penalty — ~137ms for *any* request, including a 404 that
touches no route and no database.

**Fix: migrate to `@cloudflare/vitest-plugin` 1.1.3**, the supported replacement (pool-workers is
superseded, not merely behind). `cloudflareTest` is exported under the same name, so the change is
an import swap in `workers/app/vitest.config.ts`, `workers/app/vitest.dev.config.ts` and
`workers/background/vitest.config.ts` plus the dependency. Measured on `workers/app`, same 296
passed | 1 skipped, identical collected test-name set both ways:

| | pool-workers 0.18.6 | vitest-plugin 1.1.3 |
|---|---|---|
| suite wall time | 68.45s | 23.26s |
| slowest test in suite | **5668ms** | 2468ms |
| the reported test | 3975ms | 115ms |
| `selfFetch` curve | 35× growth | flat |

Note the baseline's *slowest* test was already **over** the 5000ms default — it only passed under a
raised measurement timeout. The flake surface was larger than the one test that got reported.

**Four wrong diagnoses died on the way here, all for the same reason — arithmetic instead of
measurement.** (1) "Intermittent 6–9× stall" — 8 timed runs showed 3850–3975ms, a 3.6% spread.
(2) "`--workspaces` runs suites concurrently and steals CPU" — npm 11.12.1 runs workspaces
*sequentially*, in `package.json` order. (3) "Unindexed `audit_log` scans": the shape was real
(`EXPLAIN` gives `SCAN audit_log`, no index leads on `action`) but the table holds **302 rows** —
30 unscoped queries cost 5ms vs 3ms scoped, i.e. 2ms of a 3300ms delta. No index and no migration
0040 was warranted. (4) "Leaked response bodies" — consuming every body changed nothing. What
actually localised it was a control: a 404 with no auth and no DB cost the same ~137ms as a route
reading 225 rows, while direct D1 `SELECT 1` stayed flat at 7–9ms. **When a cost is flat across
probes that do wildly different amounts of work, it is not in the work — it is in the transport.**

**Also worth keeping:** cost resets per test file (each file gets a fresh worker), so splitting a
huge test file is a real mitigation for this class of problem; and `isolatedStorage` does *not*
exist in this config — it belonged to the older `poolOptions.workers` API, not the `cloudflareTest()`
Vite plugin — which is why writes accumulate across tests in one file.

## Asserting a transient loading state is a race unless the test holds the window open (2026-09-03)

Found while verifying the fix above: a *second*, unrelated flake in
`apps/web/src/screens/ProjectWorkspace.dom.test.tsx` ("uses the comments probe for a 403
collaborator"), failing about 1 run in 12 under the full `npm run test --workspaces`.

```
AssertionError: expected 'Collaboration12 Example StBack to das…' to contain 'Loading project.'
```

The test asserted `host.textContent` contains `"Loading project."` immediately after `render()`.
Every mocked response resolved immediately, so the whole `403 on /api/projects/p1` -> collaboration
probe -> `collaboration-only` chain was pure microtask work and could complete *inside* `render`'s
own `await act(...)`. Whether it did depended on how many ticks act happened to drain — which is
exactly what machine load perturbs. The assertion was then looking at the final view, not the
loading view.

**Reproduce a load-only flake deterministically by injecting the thing load supplies.** Inserting
`await flush(3)` before the assertion failed it 100% of the time, with a byte-identical message to
the one observed under load. That converts "I saw it once in twelve runs" into a controlled
experiment, and it is the same trick for any assertion suspected of depending on elapsed ticks.

**Fix: gate the responses the transient state is waiting on**, using the `deferredPromise` helper
the file already had (the neighbouring "reuses a cached collaboration probe" test was already
written this way):

```ts
const probeGate = deferredPromise<void>();
// /api/projects/p1 still rejects 403 immediately — that is the input under test
if (path.includes("/collaboration-summary")) return probeGate.promise.then(() => collaborationSummaryFixture());
...
await render(<ProjectWorkspace … />);
await flush(3);                       // gate closed: any tick count gives the same answer
expect(host.textContent).toContain("Loading project.");
expect(host.textContent).not.toContain("Project unavailable.");
probeGate.resolve();                  // now let the probe land
await flushUntil(…);
```

This is *stronger* than what it replaced, not looser: it proves the screen holds the loading state
for as long as the probe is in flight and never flashes the terminal error, rather than proving
something was true at one arbitrary instant. Verified both directions — `flush(30)` instead of
`flush(3)` still passes (the tick dependence is gone), and changing the detail rejection from 403
to a terminal 401 still fails loudly with `expected 'Project workspaceBack to dashboard…'`.

**Rule:** never assert a state the component will leave on its own. Either hold it open with a
deferred you control, or don't assert it. And note `flush(n)`'s companion limitation: `setTimeout(…, 0)`
advances ~1ms, so no realistic `n` can outwait the query client's real 1–4s `retryDelay`
(`lib/query-client.tsx:21`) — wait on a condition with a real deadline (`flushUntil`) instead.

**Unrelated pre-existing quirk confirmed while measuring:** `npm run test --workspaces` **always**
exits 1 in this repo, because `packages/shared` has a vitest config but no `test` script and npm
reports `Missing script: "test"`. It still runs every other workspace. Judge that command by the
per-workspace summaries, never by its exit code — and keep running
`npx vitest run --config packages/shared/vitest.config.ts` separately, as `CLAUDE.md` says.

## Three CSS traps a Tailwind convergence walks straight into (TB8-04, 2026-09-03)

All three shipped into a branch that passed typecheck, build, every unit test and a DOM test
suite. All three were caught only by measuring computed style in a real browser. The common
shape: **a utility string is applied to a component that is more general than the one it was
written for**, and CSS's own defaults do the rest silently.

**1. `:read-only` matches every `<select>`, unconditionally.** Only `<input>`, `<textarea>` and
contenteditable elements are ever `:read-write`; a `<select>` is `:read-only` always, whether or
not it is disabled and regardless of any attribute. So a bare `read-only:` variant on the shared
field-box string (`FIELD_BOX` in `components/ui/input.tsx`, which `Input`, `Textarea` **and**
`NativeSelect` all render) painted every native select `--bg-sunken` + `--text-secondary` — the
exact treatment reserved for disabled and read-only fields. Enabled role selects on the Admin
screen became visually indistinguishable from the one genuinely disabled control next to them,
so the disabled signal stopped meaning anything. The regression is invisible to the DOM tests:
the markup is correct, only the painted colour is wrong. Detected with
`[...document.querySelectorAll('select')].map(s => s.matches(':read-only'))` → all `true`, then
confirmed against `HEAD`, where `app.css`'s `.admin-field select` rule gave selects
`--paper-050` + `--text-primary` like the inputs. Fixed with an arbitrary variant carrying an
explicit guard — `[&:read-only:not(select)]:bg-surface-sunken` — with a comment saying the
`:not(select)` is load-bearing, because it reads like a redundancy and will otherwise be
"cleaned up." **Rule:** a shared field-box string is applied to three different elements; every
state variant in it must be checked against all three, and pseudo-classes that look universal
(`:read-only`, `:required`, `:invalid`, `:in-range`) have element-specific defaults.

**2. Tailwind v4's `max-[Npx]` is exclusive, so `max-[N]` + `min-[N]` leaves N uncovered.**
`max-[720px]:` compiles to `@media not all and (width >= 720px)`, i.e. `width < 720` — *not* the
`@media (max-width: 720px)` (inclusive of 720) that the hand-written CSS it replaced used. Pair
that with `min-[720px]:` and the viewport at exactly 720px matches neither branch: the table is
not stacked and not laid out as a table, controls get neither the 38px nor the 44px height. The
repo's convention is now **`max-[721px]:` paired with `min-[721px]:`** — `max-[721px]` means
`≤ 720`, `min-[721px]` means `≥ 721`, and the two are exactly complementary with no gap and no
overlap. Verified by driving the layout across 722 / 721 / 720 / 719 and reading
`getComputedStyle(table).display` and the tab strip's `min-height`: 721 → `table` + 38px, 720 →
`block` + 44px. Do not "simplify" `721` to `720`; the off-by-one is the fix. **Rule:** when
porting a hand-written `max-width` media query to a Tailwind arbitrary variant, add 1 — and
prove the boundary by measuring at N-1, N and N+1, never by reading the class name.

**3. A responsive table that goes `display: block` silently loses its entire accessibility
tree.** Stacking a table for narrow viewports (`max-[721px]:block` on `table`, `tbody`, `tr`,
`td`) replaces the implicit `table` / `rowgroup` / `row` / `cell` / `columnheader` roles with
generic ones — the markup still says `<table>`, but a screen reader no longer announces a table,
row or column count, and header association is gone. This is invisible in every check that reads
markup rather than the computed accessibility tree. The fix that must accompany any such stacking
is to reapply the roles explicitly (`role="table"`, `role="rowgroup"` on both `thead` and
`tbody`, `role="row"`, `role="cell"`, `role="columnheader"`), keep `scope="col"` on every header,
hide the header row with `sr-only` rather than `display: none` (so it stays in the tree), and
carry a `data-label` on each body cell for sighted mobile users. Verify by reading
`getComputedStyle(el).display` **and** `el.getAttribute("role")` together at the narrow width —
a `display: block` with no explicit `role` is the defect. **Rule:** any `display` change on a
table element is an accessibility change; the role must be restored in the same commit.

### The method, which generalises

The emulated viewport in the browser tooling here is pinned (2560 CSS px, dpr 2) and window
resizing does not move it, so breakpoint work cannot be checked by resizing. The way through is
a **same-origin iframe**: `<iframe src="/" style="width:390px;height:844px">` evaluates media
queries against its own viewport, and being same-origin its `contentDocument` is fully
scriptable. Every measurement above — the 722/721/720/719 boundary sweep, the 44px touch-target
audit, the stacked-table role check, per-breakpoint overflow — was taken through one iframe,
resized between runs, with no dependence on the host viewport at all. Contrast measurement has a
matching trap: Tailwind opacity modifiers (`bg-signal-positive/8`) compute to `color-mix()` /
`oklab()`, which a naive `rgba()` regex cannot parse. Composite through a canvas instead —
`fillStyle = base; fillRect; fillStyle = colour; fillRect; getImageData` — which resolves any
colour space and alpha to the actual painted sRGB pixel.

## The unlayered-cascade trap has a second door: `tokens/base.css`, via shorthand (TB8-05, 2026-09-03)

`docs/subagents/Subagent-Orchestration.md` §7 states the cascade rule in terms of `app.css` — legacy
rules there beat Tailwind utilities because `index.css` imports it outside any layer. TB8-05 hit
the same trap through a **different file**, and the mechanism has a second half worth naming.

`index.css` imports *five token files plus `fonts.css`* unlayered, not just `app.css`:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "./tokens/colors.css";      /* ← all of these are unlayered */
@import "./tokens/spacing.css";
@import "./tokens/typography.css";
@import "./tokens/tailwind.css";
@import "./tokens/base.css";
@import "./fonts.css";
@import "./app.css";
```

`tokens/base.css:25` declares a global `:focus-visible { outline: var(--border-width-bold) solid
var(--focus-ring); outline-offset: 2px; }`. Being unlayered, it beats every layered utility.

The second half is the part that bites: **it is a shorthand.** `outline` sets `outline-color`,
so it does not merely lose a specificity contest with `focus-visible:outline-on-inverse` — it
*resets the longhand the utility sets*. On the ink impersonation banner the focus ring therefore
stayed `--focus-ring` (ink-on-ink, invisible) — the exact defect the release was fixing, in its
own fix. The working form is the important modifier:

```
focus-visible:!outline-on-inverse
```

**Rules.** (1) The unlayered set is every non-`layer()` `@import` in `index.css`, not `app.css`
alone — grep the whole list before assuming a utility will win. (2) A shorthand in an unlayered
rule silently resets longhands that layered utilities set, so an overriding utility for any
component of that shorthand needs `!`. Verify by reading the *computed* value at the live element
in the state that matters (`:focus-visible` can be forced), never by reading the class list.

## A grep gate that cannot fail is not a gate — twice in two releases (TB8-05, 2026-09-03)

TB8-04 shipped a verification gate that passed vacuously; TB8-05 authored **two more** and a test
that did the same, so this is a pattern, not an accident:

- Two of the plan's seven `grep` gates matched their own **explanatory comments** rather than the
  selectors they were meant to prove gone. Retiring the CSS while keeping a comment that names it
  left the gate green either way. Fix: strip comments before grepping CSS
  (`perl -0pe 's{/\*.*?\*/}{}gs'`), and require the quoted-string context for a class gate
  (`grep -rnE '"[^"]*button--text'`) so a prose mention cannot satisfy it.
- A test asserting an unmount guard checked `let active = true;` and the cleanup `return`, both of
  which survive deleting **every** `if (active)` guard in the effect. Fix: assert each guarded
  continuation by name plus `toHaveLength(3)` on `/if \(active\)/g`.

React 19 makes the runtime version of this worse: it **silently ignores** post-unmount state
updates instead of warning, so a runtime unmount-safety test observes nothing whether the guard is
present or not. (Note `portal/package.json` pins React **19.2.8**; `CLAUDE.md`'s "18.3.1 baseline"
is stale.)

**Rule: prove every gate can fail before trusting it.** Plant the thing it looks for, confirm
non-zero exit, remove it, confirm zero — for greps and assertions alike. A gate authored and never
falsified is decoration. Budget this as part of writing the gate, not as a later audit.

## A media query outside the range you read will invert your finding (TB8-06, 2026-09-03)

TB8-06's draft plan led with a touch-target defect: the Kanban board's drag handle (36px), reorder
arrows (28×26) and move-to button (30px) were "the board's primary reorder affordances and its
smallest targets, and they are the ones used on a phone." The plan built a whole evidence section
on it, and Sol's round-1 review demolished it in one line.

`app.css` had a `@media (pointer: coarse), (max-width: 640px)` block **six lines past the end of the
range the plan had read**, setting every one of those controls to 44px. The small geometry applies
only to fine-pointer desktop, where WCAG 2.5.5 Enhanced is not the operative bar and 2.5.8 AA
(24px) is comfortably met. There was no defect. The finding was not merely wrong, it was backwards:
the build's job became to **preserve** that block, not to fix it.

**The rule:** before asserting that a CSS value is what ships, grep the whole file for every rule
matching that selector — not the block you are editing. `grep -n '\.selector' file.css` costs one
command; a responsive override you never saw costs a plan section and a review round.

The same read also missed that `app.css:306` (`.wsbar`, a *different screen's* rule) sat inside a
range the plan had marked deletable. Both errors came from reading a contiguous line range instead
of querying by selector. Later slices located every target by selector grep, and after six slices of
deletions the plan's own line numbers were stale by 60-70 lines anyway — so selector-first is the
only durable habit.

## A shorthand always resets its longhands, and Tailwind's emission order is not your class order (TB8-06, 2026-09-03)

Three separate defects in one release, all the same shape:

1. **`tokens/base.css`'s `:focus-visible { outline: … }`** — unlayered, and `outline:` resets
   `outline-offset`. Every one of the board's six focus rings needed `!`, including the two whose
   offset is *inward* (`-2px`); without it they silently became the base rule's outward `2px`, and
   an outward ring **clips** inside the move-to popover's `overflow: auto` panel.
2. **`.ey { font: … }`** (`app.css:20`) — the plan told the builder to apply a bare
   `!leading-[1.25]`, but `.ey` is rendered inside `StatusBadge`, which takes no `className`. The
   fix was an arbitrary-descendant variant on the parent, `[&_.ey]:!leading-[1.25]` — the repo's
   first use of `[&_…]:`, and the right move when the target lives inside a shared component you
   should not widen scope to touch.
3. **`[font:inherit]` beside `text-xs`** — Tailwind emits `.text-xs` *before* `[font:inherit]`, so
   the shorthand reset the size and the popover options rendered at inherited size rather than 12px.
   The retired CSS had deliberately set `font-size` **after** `font: inherit`. Sol caught one of the
   two sites; the second (`--text-2xs` on move-to) was found by checking the built stylesheet.

**The rule:** when a rule you are retiring sets both a shorthand and a longhand of the same family,
the longhand needs `!` in its replacement. Class order in JSX does not decide this — Tailwind emits
utilities in *its* property order, so a utility can lose to a shorthand it appears after in your
markup. Confirm in the built stylesheet, comparing byte offsets, rather than reasoning about it.

## An undefined custom property in an inherited property falls back to `inherit`, not to the declaration above it (TB8-07, 2026-09-04)

`app.css` had, on consecutive lines:

```css
.subtask-schedule__error, .subtask-schedule__conflict { … color: var(--signal-critical); … }
.subtask-schedule__conflict { color: var(--signal-warning); }
```

`--signal-warning` is defined **nowhere** in this codebase. The intuition — "the invalid
declaration is discarded, so the `--signal-critical` on the line above wins" — is wrong, and the
reason is worth internalising because it applies to every `var()` in an inherited property.

A `var()` that references an undefined custom property makes the declaration **invalid at
computed-value time**. That is not the same as a syntax error. A syntax error is dropped at parse
time and the cascade proceeds as if it were never written. Invalid-at-computed-value-time
declarations *win the cascade first*, and only then resolve — to `unset`, which for an **inherited**
property like `color` means `inherit`. So the conflict block inherited ordinary ink from its
parent, and the schedule-conflict warning — the thing that tells you someone else's edit landed
first — had been rendering as plain body text since it shipped. It looked deliberate.

**What to take from it:**

- An undefined token in `color`, `font`, `visibility` or any other inherited property is
  *invisible in review*: it renders as something plausible rather than as nothing.
- `grep -c -- "--your-token:"` before trusting any `var()` you did not personally define. This
  release found two undefined tokens (`--signal-warning`, `--signal-red`); the second happened to
  carry a correct literal fallback, so it was harmless and had also gone unnoticed for months.
- The fix is never to define the missing token to make the symptom go away. `--signal-warning`
  stays undefined; the rule moved to `--signal-caution-text`, the token the palette already had
  for exactly this "caution as text" case.

## A hover-reveal affordance has no touch equivalent, so it does not degrade — it fails (TB8-07, 2026-09-04)

The subtask row hid its schedule and assignee triggers at `opacity: .06` (**1.10:1** — visually
absent) and revealed them on `:hover` / `:focus-within`. On a desktop that reads as a tidy,
uncluttered row. On the 390px viewport it means there is **no way to discover that the controls
exist at all**: a phone has no hover, and a sighted touch user would have to guess that an
invisible 24px target sits at a particular point in the row.

This is not a contrast nit that can be tuned. There is no opacity value that fixes it, because the
mechanic's *reveal trigger* is the thing phones lack. The release deleted the mechanic outright and
made every control visible at full strength, moving the three meta controls onto their own line at
≤721px so each gets a real 44px target.

**The general rule: when a control's visibility depends on an input a target device does not have,
that is a missing control on that device, not a styling preference.** Audit for `:hover`-gated
`opacity`, `visibility` and `display` the same way you audit for contrast — and check the finding
at the smallest supported viewport, not the one you are developing on.


## A trap documented in prose keeps shipping; a trap in a test does not (2026-09-04)

Three defect families in this repo have each shipped **more than once**, and one of them shipped
*after* being written up in a comment in the very file that then violated it — `ui/button.tsx`
describes the `font-size` collision, and TB8-09 shipped it anyway, rendering the Lightbox rating
stars at 18px where the code asked for 22px. It survived 1,763 passing tests and two review rounds.
The failure is not that people did not read the lesson. It is that a lesson has no failure mode.

`portal/apps/web/src/styles/design-system-guards.test.ts` mechanises the three:

1. **A `var(--x)` whose `--x` is defined nowhere.** Silent by construction — it renders the
   fallback, or, in an *inherited* property with no fallback, resolves to `inherit` rather than to
   the declaration above it.
2. **A `text-[length:…]` beside a `[font:…]` shorthand.** Tailwind emits the arbitrary-property
   rule later at equal specificity, so the shorthand always wins and the `text-[length:]` is dead
   — regardless of the order the classes appear in the class string.
3. **`outline: none | 0 | transparent` in unlayered CSS.** `app.css` and `production-calendar.css`
   are imported outside every cascade layer, so such a rule beats any utility and, on a specificity
   tie, also beats the global `:focus-visible` in `tokens/base.css`.

Two things are worth carrying forward beyond the guards themselves.

**Write the guard against the real historical defect before trusting it.** The first draft of the
`font-size` guard passed cleanly when the exact TB8-09 star defect was pasted back in. It scanned
single string literals, and the shipped bug spanned a reference — `ICON_BUTTON_BASE + " … text-
[length:…]"`, with the shorthand in another file entirely. A guard that only catches the tidy form
of a bug does not catch the form that actually ships. Reintroduce the original defect, watch the
test go red, then restore.

**Guards find more than the incidents that motivated them.** Three phantom tokens had been found by
hand, one release at a time; the guard found five more in one pass. The focus guard found
`.tile { outline: 0 }` — the photo grid gives a keyboard user no focus indicator anywhere — which
no review had ever reported. Both are recorded as TB8-10 D-09/D-10, in a baseline that **fails the
build if an entry is fixed but not deleted**, so the lists can only shrink.

## A percentage min-width inside a wrapping flex container is circular, and moving the element is what reveals it (TB8-10A, 2026-09-04)

The Dashboard search field carried `min-w-[min(100%,300px)]`. That is fine in a roomy container and
was fine for as long as the field lived in the page header. Moved into the board's control strip —
a `flex-wrap` container holding two groups — it stacked the `New shoot` button underneath itself at
**every** desktop width, making the toolbar 89px tall instead of 39px.

The mechanic: `100%` resolves against the group whose width depends on the field. During intrinsic
sizing the percentage contributes nothing, so the group measures **338px**; at layout the field
takes its 300px and the 104px button no longer fits beside it, so it wraps. `min-width: max-content`
does not rescue it — for a *wrapping* flex container, `max-content` **is** the already-wrapped size,
which is the same 338px. The fix is to remove the circularity: a plain `min-w-[300px]`.

Three things to carry forward.

**A percentage sizing constraint on a flex item is a latent bug wherever the container's own width
is content-derived.** It does not announce itself; it waits for a layout change. Prefer a fixed
value plus an explicit breakpoint override — which is what the field already had for phones
(`max-[721px]:min-w-0`), meaning the percentage was doing no work at any width.

**Moving an element is not a neutral operation, even when the diff is "DOM-only".** The review chain
confirmed, correctly, that no state, handler or conditional changed. Every one of those checks
passed and the layout was still wrong, because sizing depends on the *ancestor chain*, which a
DOM-only move is precisely what changes.

**Measure the mechanism before believing the symptom.** The first probe reported "the groups
wrapped", which pointed at the group structure. They had not: the right group's `ml-auto` had
resolved to 403px, proving both were on one line, and the y-difference was `items-center` on a
taller left group. The real fault was one level down. A layout assertion that reads bounding boxes
should check the property that actually distinguishes the hypotheses — here, the resolved auto
margin — not a proxy for it.

## A router that owns the URL will canonicalise it, and canonical is not the same as valid (#52, 2026-09-08)

Porting navigation to TanStack Router looked like a pure transport swap until the new route-tree
test caught `/%61dmin` rendering the **real Admin screen**, with the browser URL rewritten to
`/admin`. The old app left that URL alone and showed "not available", and
`lib/router.test.ts` has asserted `parseStaffPathname("/%61dmin") === not-found` since the route
contract was written.

The cause is `@tanstack/react-router`'s `Transitioner`, in a mount-time layout effect
(`Transitioner.js:26-42`). It rebuilds the location from `router.latestLocation.pathname` — which
`parseLocation` has already **percent-decoded** — and, when the rebuilt `publicHref` differs from
what arrived, issues `commitLocation({ replace: true, ignoreBlocker: true })`. It is
unconditional; there is no option to disable it, and `ignoreBlocker` means a navigation blocker
cannot stop it either.

Two things made this dangerous rather than cosmetic:

1. **It launders a rejected URL into an accepted one.** Quincy's parser rejects percent-encoded
   spellings of static segments *on purpose* — canonical staff paths contain no escapes, so an
   escape is evidence of someone probing. Decoding first and matching second inverts that.
2. **Sanitising the write did not help.** The rewritten destination `/admin` is a perfectly valid
   staff route, so `safeStaffDestination` passed it through. A write-side guard cannot catch an
   attack whose *output* is legitimate; the defect was that the input was ever decoded.

The fix was to stop the router owning the URL: `lib/staff-history.ts` gives it a history whose
`pushState`/`replaceState` are no-ops, so it observes the location and never writes it. All real
navigation continues through `locationStore()`, where sanitisation still runs.
`lib/routing-transport.guard.test.ts` fails the build if anything starts navigating through
TanStack, because against a read-only history that would silently do nothing.

**The first justification written for that fix was wrong, and the review caught it.** It claimed a
canonicalising replace "can only fire when the pathname contains an escape that decodes to
something else". It cannot: `parseHref`'s `sanitizePath` collapses a leading `//`, and a bare `?`
vanishes through the search codec — two triggers with no escape in them. The conclusion happened to
survive because those are also parser-rejected, which is exactly what makes this kind of error
dangerous: a load-bearing sentence that is false but reaches the right answer, and that the next
person extends into a case where it does not. The claim now stated is the converse, which is the
one that actually holds — *no location the parser accepts is ever rebuilt differently* — and it is
a test over every route kind, with a companion assertion proving the rewrite triggers exist so the
check cannot pass vacuously.

**Rules.**

- **A library that normalises URLs is making a security decision on your behalf.** If your route
  contract distinguishes spellings — encoding, case, trailing slash, duplicate parameters — check
  what the library does to the URL *before* your matcher sees it, and what it writes back.
- **Decode-then-match is the wrong order** whenever a rejected spelling is meaningful. Match the
  bytes that arrived.
- **The test that caught this did not exist yet.** The pre-existing suite stayed green through the
  whole regression, because nothing mounted Admin *through the router* — `App.dom.test.tsx`'s only
  `/admin` case returns early on the invalidated-impersonation path. Deleting four of the seven
  route leaves also left the suite green. Adding a new file that asserts every arm of a new
  structure is not ceremony; here it was the only thing standing between this and production.

## An asymmetric guard exempts the one root nothing else checks (#56, 2026-09-09)

Guard A of `config/reui-migration.guard.test.ts` held a root to the purity standard — no legacy
`components/ui/` primitive left in its closure — only once that root's own closure reached a
`components/reui/` module. The closure walk stopped at other roots, on purpose: without that rule
`App.tsx`'s closure would swallow every screen it imports and the guard would degenerate into "is
anything, anywhere, both migrated and unmigrated" — true forever, meaningless.

`App.tsx` imports the screens, which are themselves roots and therefore leaves under that rule. Its
own closure was `lib/auth`, `ImpersonationBanner`, `PrincipalFreshnessBoundary`, `lib/stages`,
`lib/query-client`, `lib/app-router`, `Topbar` — and none of them imported a `components/reui/`
module. So `App.tsx` read as unmigrated, and the asymmetry — deliberately built to protect
unmigrated screens from a guard that could never be satisfied — exempted it too.

Result: `Topbar`, `ImpersonationBanner` and `lib/app-router` sat on the legacy button through four
slices with the guard green the whole time, and #56 arrived believing `components/ui/` was already
empty because nothing had ever told it otherwise.

The asymmetry itself was RIGHT — without it the first migrated screen fails every other screen just
for existing. The gap is that the application shell is only ever reachable as an unmigrated root,
so nothing in the guard's design ever held it to the standard at all.

**Rules.**

- When a guard is deliberately asymmetric, write down which nodes the asymmetry EXEMPTS, and check
  that something else covers them. An exemption that covers the application shell is not a small
  exemption.
- "The directory is empty" is a property to verify directly and cheaply (`ls -A`), not to infer
  from a green guard whose preconditions you have not re-read.

## Two identical-looking `opacity-50` overrides, resolved in two different places (#98, 2026-09-11)

`reui/kanban.tsx` washes out both a disabled column (`:698`) and a disabled item (`:821`) with the
same unconditional `disabled && "opacity-50"`. The new Board overrides both, and the two fixes look
interchangeable. They are not, and swapping one for the other breaks something silently.

The column is overridden with a **plain** `opacity-100`. `cn` is `twMerge(clsx(...))`, so the
conflict is resolved in **JavaScript, at render time**: `opacity-50` is deleted from the class
string before it ever reaches the DOM. Verified directly —

```
twMerge("group/kanban-column flex flex-col", "opacity-50",
        "bg-[var(--paper-050)] min-w-0 opacity-100")
→ "group/kanban-column flex flex-col bg-[var(--paper-050)] min-w-0 opacity-100"
```

The item is overridden with a **variant**, `data-[disabled=true]:opacity-100`. tailwind-merge does
NOT treat a variant as conflicting with a bare utility, so both survive into the DOM together, and
the conflict is resolved in **CSS, by specificity**:
`.data-\[disabled\=true\]\:opacity-100[data-disabled="true"]` is (0,2,0) against `.opacity-50`'s
(0,1,0). Order-independent, which is what makes it safe.

Why the item cannot use the column's fix: the item's `opacity-50` has **two** sources — `disabled`,
which must be overridden, and `isSortableDragging`, which is the genuine drag ghost and must
survive. A plain `opacity-100` would win against both and delete the drag ghost. The variant is
gated on `data-disabled`, so it wins only while genuinely disabled. Conversely the column cannot use
the variant: its `disabled` is hardcoded (every column is a permanent drop target so empty columns
can still receive a card), so `data-disabled="true"` is present at rest on all five columns — the
variant would fire always, which is correct here only by accident, and column dragging is disabled
outright so there is no ghost to protect either way.

**Rules.**

- A class-string assertion does not prove an opacity fix. It proves the string. Whether the pixel
  changed depends on twMerge's conflict table *or* on CSS specificity, and a unit test that asserts
  `className` has not distinguished them. Confirm the computed value in a real browser once.
- Before "simplifying" a `data-[...]:` variant into the bare utility, ask what else sets the same
  utility. If a second source must survive, the variant is load-bearing and the bare class is a
  silent regression — the ghost just stops appearing.

## The normal path answered 409 and no test had ever seen it (#98, 2026-09-11)

Every cross-Stage move on real data answers `409 stage_confirmation_required`
(`workers/app/src/routes/projects.ts:1122`) before it answers 200, so the two-step confirm is the
ordinary path, not an edge case. `Dashboard-stage-interactions.dom.test.tsx` covered it — but only
at the default view, and only through the Move-to menu, a control the new Board's card does not
render. So for the new Board the entire confirmation round trip was unproven: it could have dropped
the confirmation, or pre-carried one and made the server's gate unreachable, and the suite would
have stayed green.

It surfaced in a browser pass, immediately, as a drag that appeared to do nothing — the agent's
first attempt to hold a write open failed because the confirmation is an in-app modal
(`confirm-modal-confirm`), not a native dialog its listener could accept.

**Rules.**

- When a second UI replaces a first, inventory the *controls* the old tests drove, not just the
  behaviours they asserted. A behaviour reachable only through a control the new UI does not have is
  uncovered, and the test file name will not tell you.
- The first request in a confirm round trip must be asserted to carry **no** confirmation. Only that
  assertion proves the server-side gate is still reachable from this screen.

## `onDragEnd` runs before `onMove`, so "clear the drag state" clears it too early (#98, 2026-09-11)

The vendored ReUI Kanban calls the consumer's `onDragEnd` and then resolves the move and calls
`onMove`. Both run inside one synchronous `handleDragEnd` invocation. That makes two
similar-looking decisions have opposite outcomes.

**Clearing the refresh barrier in `onDragEnd` is safe.** It is a parent `setState`, and `handleMove`
runs later in the same synchronous handler from a closure that already captured `projects`,
`columns`, `pendingMoves` and `dragDisabled`. React cannot re-render or flush effects mid-handler, so
nothing `handleMove` reads can change underneath it. Clearing **only** in `onMove` is the actual bug:
`onMove` never fires for a drop outside any column or an unresolved container, so the barrier latches
forever — every refetch queued permanently, the view control disabled for the rest of the session,
and nothing failing in happy-dom.

**Clearing a ref that a later `onMove` reads is NOT safe**, and this is where it actually bit. The
lifecycle clear reset `activeProjectRef`, and the Board's rejection path then asked it for "the
handle we were carrying" to restore focus. It got `undefined` and silently refocused nothing. No
error, no failed assertion in the happy path — only the same-Stage rejection test went red, and only
because it asserted `document.activeElement`.

**Rules.**

- Before clearing anything in a drag-end handler, list every callback the library still has to call
  in that same invocation, and what each one reads. `setState` is fine; a ref another callback
  dereferences is not.
- Pass the identifier explicitly to anything that runs after a clear, rather than having it read
  "current" state. `refocusHandle(projectId)` cannot go stale; `refocusActiveHandle()` can.
- A focus restore that targets nothing fails silently. Assert `document.activeElement`, not just that
  the handler ran.

## `RestoreFocus` is keyboard-only, so turning it off is also a scroll fix (#98, 2026-09-11)

dnd-kit's `RestoreFocus` looks like a general "put focus back after a drag" feature. It is not: it
fires **only for keyboard drags**, and it calls a plain `.focus()` with no options. Three consequences
that are easy to get wrong separately:

- Setting `accessibility.restoreFocus: false` **removes a real keyboard-cancel restore**. It cannot
  ship without a replacement, or Escape during a keyboard drag drops focus to `BODY`.
- Because that `.focus()` takes no `preventScroll`, leaving it on means the library can scroll the
  Board out from under the user on a keyboard cancel. Turning it off and refocusing with
  `focus({ preventScroll: true })` is therefore an accessibility fix *and* a scroll fix, which is why
  those two acceptance criteria could not be split into separate commits.
- Pointer drags were never covered by it at all, so any focus behaviour you observe after a mouse
  drag is yours, not the library's.

**Rule.** For a vendored a11y behaviour you are about to disable, find the code path that triggers it
before assuming what it covers. "Restores focus" meant "restores focus for one of the two input
methods, in a way that can scroll the page".
