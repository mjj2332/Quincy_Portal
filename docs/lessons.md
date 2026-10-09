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
  and `APP_ORIGIN` all agree. The Vite dev server on `5173` is fine for everything except the
  sign-in flow itself: its proxy rewrites a same-origin `Origin` to `APP_ORIGIN` (#191; see that
  entry below).
  Separately: this is a **closed staff system** — Google sign-up is disabled
  (`disableSignUp: true` in `workers/app/src/auth.ts`, enforced again by a `user.create` database
  hook that unconditionally throws), so only a user row that already exists in D1 can ever sign
  in. Local D1's only seeded user is the admin account from `packages/db/seed/0001_seed.sql`
  (`mjj2332@gmail.com`, applied by `npm run db:migrate:local` since #252) — a real Google account,
  not a placeholder — so local browser testing that
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
  authenticated-session integration test per role. (Rule also lives in AGENTS.md.)

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
Tags: media-renditions, workers-runtime

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
Tags: d1-migrations

- **A D1 `UNIQUE constraint failed` message lives in `error.cause`, not `error.message`.** The
  installed drizzle wraps the D1 error in `DrizzleQueryError`; `.message` is just
  "Failed query...". A retry that tests `error.message` never fires → the first real
  concurrent collision 500s. **Rule:** walk the cause chain:
  `for (let e = error; e instanceof Error; e = e.cause) if (/UNIQUE constraint failed/i.test(e.message)) …`.
  (Same family as the earlier "scalar subquery renders 0 under drizzle/D1" lesson — never
  trust the top-level shape of a drizzle/D1 result or error; verify empirically.)

## Verification (2026-07-21)
Tags: qa-browser, deploy-ci

- **Verify the real authenticated app in a browser once the user logs in.** After the user
  signed into `quincy.flamingfire.my`, `mcp__claude-in-chrome__*` (their logged-in Chrome, NOT
  the in-app Browser) confirmed the image fix end-to-end: `read_network_requests` showed 69
  `/media/asset` requests all HTTP 200, zero 403. Network-status verification beats a
  screenshot for "did the images actually load."
- **`codex exec` agents can't run vitest** (sandbox EPERM binding 127.0.0.1) — they ALWAYS
  report "tests couldn't start." Run the suites yourself before trusting a green claim.

## Renditions + transforms deploy (2026-07-21, session 2)
Tags: media-renditions, deploy-ci

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
Tags: dropbox

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
Tags: queues-workflows, media-renditions

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
Tags: queues-workflows

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
Tags: workers-runtime, deploy-ci

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
Tags: dropbox

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
Tags: dropbox

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
Tags: rich-text

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
Tags: d1-migrations, workers-runtime

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
Tags: permissions, workers-runtime

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
Tags: reui-vendor

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
Tags: rich-text

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
Tags: workers-runtime, agent-tooling

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
Tags: board-dnd, qa-browser

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
Tags: testing-guards, agent-tooling

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
Tags: board-dnd · #185

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
Tags: focus-overlays

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
Tags: testing-guards

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
Tags: testing-guards, workers-runtime

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
Tags: testing-guards

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
`npx vitest run --config packages/shared/vitest.config.ts` separately, as `AGENTS.md` says.

## Three CSS traps a Tailwind convergence walks straight into (TB8-04, 2026-09-03)
Tags: css-tokens

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
Tags: css-tokens

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

**Superseded for surfaces by #532.** The `!outline-on-inverse` override is gone. Tailwind's
`transition-colors`/`transition-all` animate `outline-color`, and an unfocused element's outline
colour is `currentcolor`, so a paper-text control (checked checkbox, primary button, inverse-surface
button) faded its ring paper -> ink over 150ms on focus. `tokens/base.css` now sets
`outline-color: var(--focus-ring)` on all elements inside `@layer base` (rest state = ring colour,
nothing to fade from; layered so explicit `outline-*` utilities still win). An ink surface that is
not a `data-surface="inverse"` scope (the impersonation banner, the toast) sets
`[--focus-ring:var(--text-on-inverse)]` on itself instead of overriding the outline colour per
control. A `!outline-on-inverse` override would reintroduce the fade from the rest colour.
Guarded in `design-system-guards.test.ts`. Verify live: read the computed outline colour on the
frame of focus, the next frame and settled.

**Rules.** (1) The unlayered set is every non-`layer()` `@import` in `index.css`, not `app.css`
alone — grep the whole list before assuming a utility will win. (2) A shorthand in an unlayered
rule silently resets longhands that layered utilities set, so an overriding utility for any
component of that shorthand needs `!`. Verify by reading the *computed* value at the live element
in the state that matters (`:focus-visible` can be forced), never by reading the class list.

**Tab focus ring (#550).** `TabStrip`'s tabs draw the ring as a `focus-visible:after:` box, not an `outline`. An
outset outline put its bottom edge on the 2px active underline, and an inset one needed side padding that indented the
label and widened the underline. The tab is `relative px-0` with `focus-visible:!outline-none` (the `!` beats the
unlayered global rule), and the `::after` is absolute with `inset-y-[var(--space-1)]` (above the bottom border),
`-inset-x-[var(--space-1)]` (4px past the label), a `--border-width-bold` `--focus-ring` border and `pointer-events-none`.
Because the ring extends 4px outward, a strip inside an `overflow` clip needs `px-[var(--space-1)]` to avoid cutting
it; no current consumer is clipped.

## A grep gate that cannot fail is not a gate — twice in two releases (TB8-05, 2026-09-03)
Tags: testing-guards

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
present or not. (Note `portal/package.json` pins React **19.2.8**; `AGENTS.md`'s "18.3.1 baseline"
is stale.)

**Rule: prove every gate can fail before trusting it.** Plant the thing it looks for, confirm
non-zero exit, remove it, confirm zero — for greps and assertions alike. A gate authored and never
falsified is decoration. Budget this as part of writing the gate, not as a later audit.

## A media query outside the range you read will invert your finding (TB8-06, 2026-09-03)
Tags: css-tokens, qa-browser

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
Tags: css-tokens

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
Tags: css-tokens

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
Tags: css-tokens, qa-browser

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
Tags: testing-guards

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
3. **`outline: none | 0 | transparent` in unlayered CSS.** `app.css` (and, until #224,
   `production-calendar.css`) are imported outside every cascade layer, so such a rule beats any utility and, on a specificity
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
Tags: css-tokens

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
Tags: routing · #52

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
Tags: testing-guards, reui-vendor · #56

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
Tags: css-tokens, board-dnd · #98

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
Tags: board-dnd, testing-guards · #98

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
Tags: board-dnd · #98

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
Tags: focus-overlays, board-dnd · #98

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

## The hovered card is not the successor when you drag downwards (#99, 2026-09-11)
Tags: board-dnd · #99

A drop is stored as "before project X", so the Board has to turn the primitive's `overIndex` into a
successor id. The obvious reading is that the hovered card is the successor (`event.over.id`). That is
right across Stages and when dragging **up** within a column. It is wrong when dragging **down**
within a column, and one of the two planners argued for it.

`overIndex` is the hovered card's index in the column *as rendered, mover included*. Take the mover
out first and index into what remains:

```ts
const withoutMover = (columns[overContainer] ?? []).filter((p) => p.id !== projectId);
const successor = withoutMover[overIndex]?.id ?? "end";
```

Dragging down, removing the mover shifts every later index by one, so the successor becomes the card
*after* the hovered one: the card lands after the card it was released on, which is what the user
saw. `over.id` lands every downward move one slot early. In a three-card column, releasing the top
card on the middle one then resolves to "before the middle card", exactly where it already was, and
the move silently becomes a no-op. A column hit reports `overIndex === length` and falls off the end
to `"end"`.

**Rule.** When converting a drop index into a neighbour, write down the three cases (cross-container,
same container up, same container down) and pin the downward one with a test first. It is the only
case in which the obvious answer is wrong.

## A focus test can pass because something else restored focus (#99, 2026-09-11)
Tags: focus-overlays, testing-guards · #99

The Move-to chooser closes by refocusing its trigger with `focus({ preventScroll: true })`. Its
Cancel and Escape tests asserted `document.activeElement === trigger`. Deleting the refocus left both
tests **green**. The anchored popover returns focus to its reference element on close by itself, so
the assertion was satisfied whether or not the chooser's own code ran. The test pinned the popover,
not the code it was written for, and only a revert-proof showed it.

What the chooser's refocus actually adds is `preventScroll`, because a bare `.focus()` on a trigger
low on a long Board scrolls it. The test now spies on the trigger's `focus` and asserts it was called
with `{ preventScroll: true }`. That goes red when the refocus is removed.

**Rule.** When two layers can both produce an outcome, asserting the outcome proves neither of them.
Revert your line and watch the test. If it stays green, assert what only your line contributes.

## A NUL byte made `grep` report nothing, and nothing looked wrong (#99, 2026-09-11)
Tags: agent-tooling, testing-guards · #99

A template-literal separator was typed as a raw NUL character. The code compiled and every test
passed. But `grep` now treated `board.tsx` as a binary file, so `grep -n` and `grep -c` against it
printed nothing, not even `0`. That reads exactly like "no match". A verification step
("is the old name gone?") briefly reported success against a file it had never actually searched.
`file` gave it away: `data` instead of `UTF-8 text`.

**Rule.** When `grep` prints nothing for a string you have just written, distrust the grep before
the file. Check `file <path>` or use `grep -a`. Separators in keys should be visible characters
(`|`), never control characters.

## A workspace with no `test` script is silently absent from "the full suite" (#83, 2026-09-12)
Tags: testing-guards, deploy-ci · #83

`portal/package.json`'s `test` is `npm run test --workspaces --if-present`. `packages/shared` had a
`typecheck` script and no `test` script, so its 20 files and 145 tests — including the entire staff
route grammar, the closed `view` allow-list that #83 changes — never ran in the root suite. They ran
only when invoked directly in that directory. Nothing failed; the suite simply reported a smaller,
greener world. `--if-present` is what makes the omission silent.

**Rule.** After adding tests to a workspace, confirm the ROOT suite count moves. If a package has
tests, it needs a `test` script, or `--if-present` quietly excludes it forever.

## The vendored board hard-codes the measuring strategy a shipped white-screen banned (#83, 2026-09-12)
Tags: board-dnd, reui-vendor · #83

The #185 entry above ends with a rule: *pair any live-reordering board with
`MeasuringStrategy.BeforeDragging`, not `Always`.* The old Board obeyed it explicitly. Its
replacement is composed on vendored `reui/kanban.tsx`, which hard-codes
`measuring: { droppable: { strategy: MeasuringStrategy.Always } }` and exposes no prop to change it.
The cutover therefore ships the precondition of that defect.

It is safe for one reason only: the new Board never rewrites the rendered column arrays during a
drag. Hover moves a drop indicator that is absolutely positioned and zero-layout, so there is no
reflow for `Always` to re-measure and no feedback loop to enter. The safety argument lives in that
invariant, not in the configuration — which is exactly the kind of fact that is one "small
simplification" away from being lost, and happy-dom cannot see the loss.

**Rule.** When a vendored primitive hard-codes something a lesson here forbids, pin the replacement
invariant with a test and say in the test's comment which defect it is standing in for. The pins for
this one are the `Always` assertion on the captured `DndContext` props and the
"never rewrites SortableContext order from the drag proposal" test — neither is legacy, and a
multi-card real-browser drag stays mandatory for any change under dnd-kit config.

## An `aria-label` is not a test id, and renaming one can void an absence assertion (#83, 2026-09-12)
Tags: testing-guards, board-dnd · #83

The new Board shipped behind a flag as `aria-label="Project pipeline board (kanban2)"`. The issue
licensed keeping `kanban2` in internal filenames and test ids, and the suffix looked like exactly
that. It was not: it is copy a screen reader reads aloud. Worse,
`Dashboard-kanban-sort.dom.test.tsx` asserts `[aria-label="Project pipeline board"]` is **absent** in
archived scope. After the cutover that assertion would have passed because the label no longer
matched, not because the Board had unmounted — a real test silently converted into a tautology by a
string it did not own.

**Rule.** An internal-naming licence covers identifiers no user perceives. It never covers an
accessible name. And when you rename any string another test asserts the ABSENCE of, that test must
be re-proved red — absence assertions fail silently upwards.

## Two orders, one list: the authorized map is not the displayed order (#83, 2026-09-12)
Tags: board-dnd, permissions · #83

`moveToPositionOptions` built the Move to… list from the authorized Board map. Correct for placement,
wrong for presentation: under Priority or shoot-date sort the column renders in sorted order, so the
chooser offered "Before X — position 1" for the card the user could see sitting third. The old Board
listed the visual successor and had a test saying so; the replacement lost it, and only the ported
Dashboard suite — carried over assertion-for-assertion rather than rewritten — caught it.

The fix orders the list by the displayed order and changes nothing else: the successor ids stay the
same, so placement stays semantic and resolves against the authorized map as before, and a model with
no authorized map still fails closed.

**Rule.** A semantic placement system has two orders, and they are not interchangeable: the authorized
map decides where a card LANDS, the display order decides what the user is OFFERED. Any list of
positions shown to a person is presentation. And port an old suite assertion-for-assertion — the
regression it catches is the reason it was worth porting.

## A browser "regression" that was the server's read order, and the fixture that revealed it (#83, 2026-09-12)
Tags: qa-browser, board-dnd · #83

A browser acceptance pass blocked the #83 cutover: a cross-Stage drop onto a middle card sent
`between(Target C, Target D)` — in both the unconfirmed request and the confirmed retry — and the card
rendered at the BOTTOM of the target column. It read as a placement defect in the new Board.

It was not. `authorizedInternalBoardOrder` (`workers/app/src/routes/projects.ts`) orders each Stage
**Priority-set before Priority-null**, and only then by `board_position`. The test fixtures had a
mover with no Priority and targets with Priorities 5, 2, 1, 4, so the mover sorted below all of them
no matter what position was stored. A throwaway server probe settled it: the placement stored `3500`
between `3000` and `4000`, and the authorized order still returned the mover last. No Board could
have shown otherwise — in Board sort the client orders purely by `boardRank`, taken from that server
map — and the Board being replaced consumed the identical map, so it behaved the same way.

Two things made this expensive to diagnose. The symptom pointed at the layer that had just changed,
which is the natural suspect and was the wrong one. And the earlier acceptance passes had used
uniform fixtures — every Project unprioritised — so the rule had never been exercised; the new pass
seeded mixed Priorities and exposed behaviour that had been there all along.

**Rule.** When a browser pass reports a placement that disagrees with a correct request body, the
request is evidence: the write is right, so suspect the READ. Re-run the case with the confounding
dimension held uniform (here, one priority tier) — if it passes, the layer under test is innocent and
the finding belongs to whatever re-orders the result. And vary fixtures along a dimension the
production data actually varies: a suite where every row shares a value cannot see a rule keyed on
that value.

**Resolved (#106, 2026-09-17).** The owner chose "Board position wins": every server read of Board
order now goes through one comparator, `compareBoardOrder` (`workers/app/src/lib/project-board-order.ts`),
which is position then id. The tiered rule had been copied into three places (the placement
planner, `authorizedInternalBoardOrder`, and the external-editor list), so fixing one would have left
the others disagreeing. Priority still orders the client's local Priority sort. Migration 0037 and its
test keep the tiered comparator on purpose, because that is how the migration normalised positions
back then.

## Two reviewers, one bug, opposite fixes — and the behaviour you replaced is the tiebreaker (#110, 2026-09-12)
Tags: agent-tooling, testing-guards · #110

Consolidating four per-screen `useState` toast arrays into one module-level store moved a lifetime
question out of React and into our own hands, and the two reviews caught it from opposite sides.
Sol: the last viewport unregisters, a cleanup microtask is queued, a `pushToast()` lands, the
microtask runs `clearToasts()` and eats it — announced zero times, violating the AC. Luna, with a
real `UploadDropzone` request rejected after unmount: the same push *survives* in the module
snapshot and the **next screen's** viewport renders it — one project's error surfacing on another.

Both were real. Each one's obvious fix is the other's regression: preserve post-unmount pushes and
you guarantee the leak; discard them and you guarantee the eaten toast. Neither reviewer could see
that, because each had half the picture.

What settled it was not adjudicating between the reports but asking what the code being replaced
did. A per-screen `useState`: `setToasts` after unmount is a no-op, so a toast raised by a screen
that is gone was *discarded, never carried forward*. That is one rule covering both reports —
discard a toast pushed with no viewport mounted, on a microtask, **unless** a viewport registers
before it runs. The exception is not a special case either: effects run child-first, so a screen's
own mount-time push (a route `notice`) fires before its sibling viewport's registration effect, and
by microtask time the registration has happened in the same commit.

**Rule.** When a refactor moves lifetime management from the framework into your own code, the
replaced implementation's lifetime semantics are the specification — write them down before you
choose a mechanism. And when two reviewers hand you contradictory fixes for one area, that is
evidence neither has the whole failure mode: find the rule that explains both reports before
writing either patch.

## A `new Set()` of filenames cannot catch the duplicate it exists to catch (#110, 2026-09-12)
Tags: testing-guards · #110

The consolidated toast surface must be rendered exactly once per screen — two viewports means every
toast renders and announces twice. The test written to pin that collected filenames containing
`<ToastViewport` into a `Set` and compared it to the expected three. It passed, and it could not
have failed for the thing it was for: `Set` discards multiplicity, so a second `<ToastViewport />`
added to Dashboard still yields the same three filenames. It also scanned comment text, the failure
already recorded above in this file.

The fix is to count occurrences per file and assert an exact map. The part worth keeping is that
the defect was found by asking "what edit should turn this red?" and then *making that edit* —
adding a duplicate to `Admin.tsx`, watching it fail, reverting. This repo's standing rule ("a grep
gate that cannot fail is not a gate") was already written down; it was still shipped again because
the gate was green and green reads as working.

**Rule.** A gate over a *count* must assert the count. Set-membership, `.includes()` and
"is it present" answer a different question than the one a duplicate-detection gate is asking — and
running the mutation that should turn it red is the only thing that tells you which question you
actually asked.

## `Extract` on a union you do not own can quietly resolve to `never` (#111, 2026-09-13)
Tags: reui-vendor · #111

`screens/Dashboard.tsx` re-derived a route type of its own, instead of importing the shared one:
`Extract<DashboardRouteArm, { dashboardView: "list" | "kanban" }>`. That worked while the shared
`dashboardView` union in `packages/shared/src/staff-routes.ts` held only those two literals. #111
widened the union to add `"calendar"`. The local `Extract` did not raise an error at that point. It
just stopped matching, and its result type silently became `never`.

The failure did not show up where the union changed. It showed up far away, as
`src/screens/Dashboard.tsx(166,123): error TS2339: Property 'dashboardView' does not exist on type
'never'`. That is because `never` is a valid type, not an error condition. TypeScript accepts a
narrowing operator that matches nothing, and only later code that tries to use the result finds
out there is nothing left to use.

The fix was to stop re-deriving the type and import the shared one directly, so a future widening
of the union is reflected automatically instead of needing every local copy to be found and
re-pinned. `Dashboard.tsx:140-144` now names this reasoning in a comment, so the next person who
adds a `dashboardView` value does not rediscover it the same way.

**Rule.** Do not re-derive a narrowing type (`Extract`, `Exclude`, a manual conditional type) over
a union you do not own. Import the narrowed type, or the union itself, from its source. A type
operator that matches nothing degrades to `never` without complaint, and the error it eventually
causes will point at the use site, not at the change that broke it.

## A 404 on `@reui/<name>` sent two tickets looking in the wrong registry (#111, #112, 2026-09-13)
Tags: reui-vendor · #111, #112

#111's spec said to install the ReUI sidebar. `@reui/sidebar`, `@reui/sheet` and `@reui/tooltip`
all returned HTTP 404 while `@reui/kanban` and `@reui/badge` returned 200 on the same key, and #111
concluded the components did not exist. That conclusion was wrong. `sidebar`, `sheet`, `tooltip`
and `breadcrumb` are shadcn **base-nova** primitives: bare names served by shadcn's default registry,
and the same bare names ReUI's own blocks list in `registryDependencies`. `npx shadcn@latest view
sheet` resolves them.

The cost: #111 vendored shadcn's `new-york-v4` sidebar (the wrong style) into
`components/reui/sidebar.tsx` by hand, and #112 planned a hand-rolled Sheet and breadcrumb on
Base UI Dialog before the owner caught it. #112 moves both onto the base-nova `sheet` and
`breadcrumb`, vendored through the sandbox per `docs/reui-reuse.md`.

**The new-york-v4 lineage is closed.** #122 (`docs/adr/0005-…`) replaces `sidebar.tsx` with
base-nova's own primitive, adopted whole with three behavioural patches, and vendors
`tooltip.tsx` alongside it. A future reader finding `reui/sidebar.tsx` should find base-nova's
shape there, not new-york-v4's — if it looks like the latter, something has regressed, not a
decision still pending.

**Rule.** A 404 on `@reui/<name>` sends you to the bare base-nova name, then to ReUI MCP `search`.
Only when both miss is the component absent, and that is a scope decision for the spec's author.

## Three guards in one branch read documentation prose as code (#111, 2026-09-13)
Tags: testing-guards · #111

`docs/lessons.md` already records one gate that scanned comment text as if it were the code it was
checking. #111 hit the same trap three more times, in one branch.

`portal/apps/web/src/styles/sidebar-token-bridge.guard.test.ts` failed on its first run. The header
comment of `portal/apps/web/src/components/reui/sidebar.tsx` explains that `ring-sidebar-ring` was
REMOVED from the vendor component. The guard's extractor read that sentence as a live consumption
of the token, not as prose about its absence.

`portal/apps/web/src/lib/routing-transport.guard.test.ts` rejected
`portal/apps/web/src/components/quincy/NavigationRail.tsx`. That file's own doc comment spells out
`useNavigate()` and `router.navigate()` by name, while explaining that neither one works in this
app. The guard's matcher looks for call syntax anywhere in the file, including comments, so writing
the forbidden call in prose was itself enough to trip it.

`portal/apps/web/src/styles/app-railed.test.ts` failed on its own first run for a third, different
reason. A `/* … */` comment block sitting between two CSS rules gets swallowed into the next rule's
selector capture by a naive regex. The comment above `.app--railed` contains commas, so the
selector list it produced never matched the intended selector.

Two of the three were fixed by stripping comments out of the text before scanning it. The third —
the routing-transport guard — was left as it is, and the comment in `NavigationRail.tsx` was
reworded instead, because that guard is shared across the codebase and its "match anywhere,
comments included" behaviour is correct on purpose.

**Rule.** Documentation must be able to name the exact syntax it is warning against, without
tripping the mechanism that forbids that syntax. When you write a guard that scans source text,
decide up front whether it should see comments, and strip them if it should not — and when it
should see them by design, say so where the guard is defined.

## A lazy Suspense boundary does not retry after the update that made it reachable (#111, 2026-09-13)
Tags: routing · #111

`screens/Dashboard-calendar-intent.dom.test.tsx` asserted the Calendar surface rendered after
landing on the bare `/?view=calendar` intent. It never got past the Suspense fallback,
`"Loading calendar…"`. Adding more settle time changed nothing, which is what proved the failure
was not a timing problem.

The real cause: the Dashboard only switches to the Calendar view AFTER the canonicalising URL
replace commits, one render past the initial mount. React does not re-attempt a lazy boundary on
its own; it needs a further update to retry, and the settle loop in the test never produced one
that mattered, because the fallback had already committed and nothing invalidated it. This
codebase has no `waitFor`; its DOM tests settle by awaiting two `Promise.resolve()` ticks inside
`act`, and no number of those ticks makes a lazy chunk resolve if nothing prompts a retry.

The fix was to narrow that test's claim: assert that the Calendar branch owns the viewport (no
Kanban board mounted, the Calendar's own loading region present), and leave the assertion that the
Calendar surface itself renders to `screens/Dashboard-calendar.dom.test.tsx`, which mounts with
the calendar facet already in hand and so has the surface in its first commit.

**Correction (#217 build, step 7).** The premise above was wrong, not just the test. The Calendar
surface never resolving under the intent harness was NOT a property of the lazy-boundary timing —
it was an invalid fixture: `filterFacets.myTasksUserId: null` in this file's own response fixture,
which the strict `z.string().uuid()` schema rejects, so every load sat in react-query's retry loop
and never left the loading state. With an honest fixture the range decodes on the first commit and
the surface renders directly, same as any other Calendar-facet arrival —
`Dashboard-calendar-intent.dom.test.tsx`'s own "gives the viewport to the Calendar" test asserts
the surface directly now, not the Suspense fallback. The general rule below about a lazy boundary
needing a further update to retry is still true; it just was not what this particular test was
hitting.

**Rule.** When a lazy boundary becomes reachable only as the RESULT of an update (a redirect, a
canonicalising replace, a route change), do not expect it to resolve within that same settle loop.
Split the assertion: one test for which branch became active, a separate test — one that mounts
with the target state already present — for what that branch renders. And before blaming the
harness's timing, check the fixture is actually valid against the schema the real code path
enforces — an invalid fixture that silently retries forever looks exactly like a timing problem.

## Vite only replaces `import.meta.env` when it sees a literal member access (#111, 2026-09-13)
Tags: deploy-ci · #111

`portal/apps/web/src/lib/app-router.tsx` first read the navigation-rail flag by passing the whole
`import.meta.env` object into a predicate that indexed it with a variable key. It worked in
development and under Vitest. A production `vite build` behaves differently: it substitutes a
literal `import.meta.env.VITE_X` with that variable's value, but an object indexed by a variable
key cannot be substituted, so it emits the whole env object instead. The flag's NAME was therefore
observable in the shipped bundle, twice, together with every other `VITE_`-prefixed value.

Writing the key out literally dropped that to the one occurrence that is a named constant in
`lib/feature-flags.ts`. Note what this did NOT buy: the value still reaches a function call, so
neither form lets Vite fold the branch away and drop the unused chrome. Getting dead-code
elimination as well would need the comparison inline at the branch, which would cost the pure,
node-testable predicate. That trade was not taken.

`vi.stubEnv` reaches the literal form under Vitest just as well, so the indirection had not been
buying any testability either. Nothing was lost by removing it.

Separately, the flag is compared with `=== "1"` rather than checked for truthiness. Env values
arrive as strings, and a truthiness check would treat `"false"`, `"0"` and `"off"` as all
equally on.

**Rule.** Read `import.meta.env.VITE_X` with the literal, dotted key. Indexing the env object with
a variable reads the same in development and ships the whole object, so what leaks is decided by a
line that looks equivalent. And compare a string-valued env flag against its exact "on" string,
never for truthiness.

## Tonomo changed envelopes and Editor Dropbox cutover (2026-09-13)
Tags: dropbox, scheduling

The recent missing-address poison events were not missing addresses: `action: "changed"`
wraps a full order under `order`, while the outer `id` identifies the appointment rather than
the order. Normalize the confirmed envelope before parsing and validate outer/nested order
references; ingress deduplication must use the same identity contract. Payloads without any
order identity remain invalid. The regression fixture reproduces the original missing-street
failure before normalization.

Editor folder mappings are separate from Tonomo RAW paths because the latter still determine
AutoHDR identity. Cut over RAW intake only when the Editor mapping is ready, and explicitly
sync existing files after reviewed linking: an already-consumed root cursor cannot discover
unchanged historical files. Folder-create conflicts are not ownership proof; retain the
reservation and request review when a root was not durably proven created by this mapping.

`Error.message` is non-enumerable. A recursive JSON-field walker for Dropbox `not_found`
responses does not detect an `Error` wrapping the same response; inspect the message/cause
chain at that boundary. Otherwise normal absence aborts every attempt to create a new folder.

Real DNG fixtures matter: the Canon EOS R5m2 sample's review-size previews use JPEG XL
compression 52546, while its JPEG thumbnail is only 256×171. A synthetic JPEG-in-TIFF test
cannot prove that these studio DNGs render. Keep original bytes immutable, validate the
embedded encoding and size, and prove real preview decoding before activation.

## Adopting base-nova's sidebar: five couplings to file names and comment text, not all of them guards (#122, 2026-09-14)
Tags: reui-vendor, routing · #122

#122 replaced `components/reui/sidebar.tsx` wholesale — #111's hand-trimmed, provider-less copy for
base-nova's full primitive (`docs/adr/0005-…`). None of the guards this touches read intent; they
read exact paths and exact prose, so a faithful re-vendor still needs to reproduce five couplings
that have nothing to do with the primitive's actual behaviour.

**(a) `config/no-document-cookie.guard.test.ts` requires `reui/sidebar.tsx` to CONTAIN the string
`document.cookie`**, inside a comment, describing why the vendor's cookie write was removed. A
header that documents patch 1 without ever spelling out the literal string it is patching away
trips the guard's own negative-fixture test (`sidebarSource).toContain("document.cookie")`), not
the positive one — deleting the cookie code is not enough; the prose has to name it.

**(b) `styles/sidebar-token-bridge.guard.test.ts` hard-reads `components/quincy/NavigationRail.tsx`
by path**, independent of the primitive, and asserts that file alone consumes at least one
`*-sidebar*` role (`hover:bg-sidebar-accent` on the account-menu trigger, today). Move that last
`-sidebar` utility out of the rail — say, by re-deriving every colour from Quincy's own aliases —
and this specific assertion goes red even though nothing about the bridge itself broke.

**(c) That same guard strips exactly `const ACCOUNT_MENU_ITEM = cn(…);` before scanning the rail**
for re-scoped-role violations, by name and by that literal `cn(...)` shape. Renaming the constant,
or refactoring the account-menu class string to a template literal or a second `cn()` call, moves it
back into the scan — which would then flag `hover:bg-secondary` and friends as the rail depending on
a role, when it is `quincy/menu.tsx`'s portalled panel that reads them, not the rail surface.

**(d) `styles/shell-breakpoint.guard.test.ts`'s `SHELL_FILES` list is a fixed path+kind array,
checked for an EXACT count and an exact path-by-path match**, not a floor. #122 appended
`components/reui/sidebar.tsx` and `components/reui/tooltip.tsx` to it (patch 2's rewritten
responsive variants live there now). The list only grows; renaming or deleting a shell file this
guard already names is a deliberate edit to the guard itself, not a side effect of moving code.

**(e) `styles/tokens/reui.css`'s own header prose (`:148-189`) explains, by name, why
`--sidebar-ring` is absent** — the focus-ring removal correction, cross-referenced to
`reui/badge.tsx` and `reui/button.tsx`. #122 kept the same correction and the same absence, so the
comment needed no edit; a future change to WHY the ring is removed (not just re-vendoring the file
it is removed from) would leave this comment naming the wrong reason.

**Rule.** A vendored primitive's own diff is not the full change surface. Before re-vendoring
`reui/sidebar.tsx` (or reading its guards as merely descriptive), grep this repo for the primitive's
own path and for the literal strings its header names — `document.cookie`, `ACCOUNT_MENU_ITEM`,
`--sidebar-ring` — and expect every hit to still be true after the edit, not just the file's own
tests.

**A third door on the unlayered-cascade trap: `a { color: inherit }`.** Luna's Chrome pass measured
the rail's rows painting the wrong text colour — an inactive row computed `--text-primary` instead
of `--text-secondary`. Every row here renders as `InternalLink`, a real `<a>`, and `styles/tokens/
base.css:21` declares `a { color: inherit }`, imported UNLAYERED (`index.css`) the same way the
outline shorthand and the focus ring already documented above (`docs/lessons.md § "The unlayered-cascade trap has a second door"`) are —
so it beats any LAYERED `text-*` utility on an anchor regardless of merge order or specificity, and
the row inherited the sidebar's own `--sidebar-foreground` instead. Same fix as those two: the `!`
important modifier on the text-colour utilities, not moving `base.css` into a layer. A row rendered
as a link is the tell — a `<button>`/`<div>` row has no inherited `color` fighting it, so this door
only opens for the anchor-rendered rows a routing constraint (`InternalLink`, not `<button>`) forces
into existence.

**P2 (notifications popover):** two more findings. **A fourth door on the same unlayered-cascade
trap:** `tokens/base.css`'s unlayered `h1..h4 { font-weight: regular }` beats a Popover's own
`font-medium` the same way the outline shorthand, the focus ring and `a { color: inherit }` do
above — `NotificationBell.tsx`'s `TITLE_WEIGHT = "!font-medium"` is the fix. **Base UI's Popover
outside-press is `"intentional"` for a mouse when `modal={false}`** (`PopoverRoot`'s `useDismiss`),
reacting only to the terminal `click` of a press-release pair, unlike `quincy/menu.tsx`'s Menu
(`"sloppy"`, a bare `pointerdown`) — a DOM test for the popover's outside-dismiss needs a real
`click` event, not the `pointerdown` that sufficed for the Menu-based panel it replaced.

**P3 (account/search):** `Dialog.Popup`'s `finalFocus` callback treats a `void`/`undefined` return
IDENTICALLY to `false` (`FloatingFocusManager.mjs`'s `getReturnElement`), not as "use the default".
A callback that returns `undefined` for the closes it does not care about therefore disables
Base UI's own return-focus for every one of them — the callback must return `true` to opt back
into default behaviour, confirmed by `App-navigation-rail-shell.dom.test.tsx`'s existing
Escape-returns-focus assertion going red the moment `RailSheet` gained a `finalFocus` prop.

**P3, Sheet account menu:** a Menu inside a modal Dialog loses the return-focus race — the Dialog's own
`restoreFocus: "popup"` reclaims it a frame later, so move focus to the trigger synchronously in
`onOpenChange` instead. Root Menu collision avoidance has no axis fallback; pick `side` explicitly.

**P3 again, the Project header Deadline popover (#662):** inside the modal Project sheet, Escape (and Apply/Cancel, where
Apply disables its own button and leaves focus on `<body>`) landed focus on the sheet, not the Deadline trigger: the sheet's
`restoreFocus: "popup"` reclaims homeless focus a frame after close, ahead of the popover's own return. The 1280 reading that
looked like a width difference was the Timeline cell, which is not in a sheet. Fix: `ProjectHeaderDeadline`'s one
`closePopover` helper focuses the connected trigger synchronously with `preventScroll` (when focus is in the popup, homeless,
or was in the cell when a save began, via `focusAtRequest`), then closes; every close path uses it. The same guard
`quincy/menu.tsx` has. Test it nested in the real `ProjectSheet` and assert focus immediately and after a frame
(`ProjectHeaderDeadline-sheet.dom.test.tsx`); a standalone test passes without the fix.

**P3 a third time (#669):** the Dropbox, Checklist-schedule and Shoot-date popovers had the same defect, because the fix lived in
one consumer. Two copies of the predicate (`menu.tsx` and `closePopover`) collapsed into one helper,
`lib/return-focus-before-close.ts` (`parkedFocusReturnTarget`), and `reui/popover.tsx` (QUINCY ADAPTATION 10) now returns focus
to the trigger on the controlled open true to false edge, inside an `OverlayContainerContext` only, and never when the caller
passes `finalFocus`. Consumers carry no trigger-refocus of their own (`popover-in-sheet.dom.test.tsx`). Known gap: a trigger
that is `disabled` while closing (Checklist Apply, `disabled={busy}`) is refused by the helper.

## Tonomo's created webhook carries a display date, and null-fill never upgrades it (2026-09-14)
Tags: scheduling

**Symptom:** Editor folder candidate discovery treated every one of these projects as
`needs_review` with "Invalid shoot date", and the hourly awaiting-RAW reconciliation silently
skipped ~50 production rows — both readers require `projects.shoot_date` to already be ISO.

**Cause:** Tonomo's `created` webhook often omits `when.start_time`; `shootDateFrom`
(`packages/shared/src/tonomo.ts`) then fell back to the payload's human-readable text (e.g.
"Thursday, 17 Sep, 2026") and stored it verbatim. A later `changed` event usually carries
`when.start_time`, but `updateProject` (`workers/background/src/tonomo/process.ts`) only fills
fields that are currently `NULL` — a non-null display string was never replaced.

**Fix:** normalise at ingest (`parseTonomoDisplayDate` converts the exact weekday/day/month/year
shape to ISO, validating the weekday against the calendar date so a malformed string is rejected
rather than accepted); a narrow `updateProject` rule lets a canonical incoming `shootDate` replace
a non-canonical stored one (and only that field — manual edits to every other snapshot field still
win); and migration 0042 backfills the display text already sitting in production.

`awaiting_raw` rows are excluded from 0042 on purpose: converting a past-dated display string to
ISO there would make every one of them due in the same reconciliation run at once. They're held
for a separate, later migration that accounts for that side effect — rows still showing
`needs_review` with "Invalid shoot date" in `awaiting_raw` are expected until then.

Migration 0043 converts those `awaiting_raw` rows. To bound the resulting notification fan-out
(each advance to `raw_review` emails every active admin and the project's editors), the same
release temporarily lowers `RECONCILE_AWAITING_RAW_BATCH_SIZE`
(`workers/background/src/reconcile-awaiting-raw.ts`) from 100 to 15 so the backlog drains over
several hourly runs instead of one; the constant was restored to 100 once the backlog had drained
(2026-09-14).

## A guard that checks a class is present cannot see that its layout rule was deleted (#113, 2026-09-15)
Tags: testing-guards, css-tokens · #113

**Symptom:** the rail bell's unread badge rendered as an inline pill beside the icon rather than
overlaid on its corner, with the whole DOM suite green.

**Cause:** c5e246f deleted the `.topbar__notification-badge` rule from `app.css` (position,
min-width, height, padding, radius, line-height) when the bell moved to Tailwind utilities, but
the badge span only received the colour utilities. Every test that touched the badge asserted its
text, its `99+` cap, or its absence at zero; nothing asserted the layout utilities, so the loss of
the rule was invisible to the suite and only visible in a browser.

**Fix:** the badge carries `absolute top-0 right-[-3px] min-w-[16px] h-[16px] …` again, and
`NotificationBell.dom.test.tsx` asserts `absolute` and `min-w-[16px]` on it. The general rule: when
an `app.css` rule is deleted in favour of utilities, the commit that deletes it must show where each
declaration went, and a test should pin the utilities that carry layout, not just paint.

## The Positioner's OffsetFunction gets sizes, not positions (#113, 2026-09-15)
Tags: focus-overlays, reui-vendor · #113

Base UI's `sideOffset`/`alignOffset` callbacks receive `{ side, align, anchor: { width, height },
positioner: { width, height } }` and nothing about where the anchor is. To align a panel's top with
a trigger inside a taller anchor (the bell inside the rail), the callback has to read both elements'
`getBoundingClientRect()` itself. Happy-dom lays nothing out, so the DOM test can prove the callback
runs and reads the trigger's rect, and the arithmetic is a pure exported function with its own
tests; the pixel result is a browser check.

## The bell's narrow-header grid keys off `placement`, not a breakpoint; a decorative thumbnail must silence its own placeholder's `role="status"` (#114, 2026-09-15)
Tags: notifications, css-tokens · #114

`shell-breakpoint.guard.test.ts` forbids `sm:`/`md:`/`lg:`/`max-[…]`/`min-[…]` in
`NotificationBell.tsx` and its extracted `NotificationList.tsx` — "one collapse breakpoint, JS-owned"
(AC11) — and happy-dom evaluates no `@media` query at all regardless, so a CSS breakpoint there
would be untestable as well as a second source of truth. `"header"` placement already means
`ShellHeader`'s own below-772px shell, so the notification row's narrower 3-track grid (no
thumbnail column) keys off the `placement`/`showThumbnails` prop the component already threads
through, not a width query of its own.

Separately: `LazyImage`'s loading and failed states are each `role="status"` — correct for a single
hero image reporting its own progress, wrong for up to 25 decorative row thumbnails all mounting at
once when the panel opens, which would fire 25 live-region announcements. The thumbnail's wrapper
`<span>` carries `aria-hidden="true"` for exactly that reason (and `LazyImage`'s own `alt=""` keeps
a loaded `<img>` out of the tree the same way) — hiding the wrapper, not patching `LazyImage` itself,
since other callers still want its live region.

## Renaming the scaffold's child folders broke resume of a half-built tree (2026-09-15)
Tags: dropbox

**Symptom (caught in review, not production):** with `EDITOR_INPUT_FOLDER` changed from `Input`
to `0. Input`, a mapping still `pending` that had already recorded `<root>/Input` would, on its
next reconcile, strict-create `<root>/0. Input` beside it and go `ready` with BOTH paths in
`inputRoots`, so `delta.ts` would route DNGs from two folders and manual publish would pick the
first. Three reviewers (the /code-review pair and Sol) found it independently; the first draft had
only documented it as a deploy-window rule.

**Cause:** `scaffold.ts` looked up an already-recorded child by the exact path it was about to
create (`existingChildId(mapping, role, path)`), so a rename of the constant made every recorded
child invisible to the resume path.

**Fix:** `CHILD_SPECS` carries a `pattern` beside each `name`, and `persistedChild()` finds the
recorded child for a role by pattern directly below the root (`EDITOR_INPUT_NAME_PATTERN` /
`EDITOR_OUTPUT_NAME_PATTERN` in `paths.ts`, the same two patterns reviewed linking uses). `name`
is only consulted when nothing is recorded. The regression test reserves a mapping, records a
plain `Input` child, and asserts the resumed tree keeps it and never creates `0. Input`.

**Rule:** anything the scaffold records durably must be re-found by identity (role + recorded
path), never by re-deriving the path from a constant that can change between deploys.

## Two write paths reach `notifications`, so `ledger → outbox.actor_id` exists only for some types (#116, 2026-09-15)
Tags: notifications · #116

`packages/db/src/notifications.ts#emitNotifications` inserts a `notifications` row directly, with no
`notification_outbox` row and no ledger row; the durable path (`workers/background/src/notification-delivery.ts`)
inserts with a ledger row linking `notification_id → outbox_id`. Which path a type takes depends on the
emitter *and* the recipient: `packages/db/src/external-notifications.ts` only writes outbox rows for
`external_editor` recipients of `comment_added`, `subtask_*` and the stage events, so a staff
`comment_added` has no outbox row while an external one does. Anything that wants the actor at read
time therefore cannot assume the ledger walk: #116's resolver joins the *source* row where it names
the actor (annotation author, comment author, post author) and uses the ledger only for
`assigned_to_project` and the activity types, which are durable for everyone. Staff `subtask_assigned`
has neither — no outbox row and no assigner column on `project_subtasks` — so its actor is
unrecoverable without a write-path change. Rule: before promising an actor for a type, find the
`INSERT INTO notification_outbox` for that type *and* that recipient role.

**Update (#141, 2026-09-29):** staff `subtask_assigned` is now durable too
(`emitStaffSubtaskAssignedNotification`), and `emitNotifications` refuses the type, as it already
did `project_deadline_reminder`. One `event_type` (`project.subtask.assigned`) now carries two
payload shapes: the consumer tells them apart by `recipient_membership_cycle_id` (NULL for staff,
the membership cycle for external) and parses each with its own strict parser. The staff arm
re-checks eligibility (active, non-external, admin or member, current assignment version) in SQL at
every channel admission, not only in the resolver. Building the tests surfaced #319: the external
arm had never delivered at all.

## Cookie-session scripts must send an `Origin` header or every mutation is a 403 (2026-09-15)
Tags: auth, agent-tooling

**Symptom:** `scripts/bulk-archive-delete-sep-2026.mjs --live`, modelled line for line on the July
2026 script, passed its dry run (GETs only) and then stopped on the very first archive POST with
`403 {"error":"Forbidden: invalid request origin"}`. Nothing was mutated, because the script stops
on first failure.

**Cause:** `workers/app/src/middleware/origin.ts` (`requireAppOrigin`) rejects any
POST/PUT/PATCH/DELETE outside `/api/auth/` whose `Origin` header is not exactly `APP_ORIGIN`. It is
the CSRF guard for cookie sessions and was added after the July script, so the precedent silently
stopped being a working template. A dry run cannot catch it: GETs are exempt.

**Fix:** the script's `api()` helper sends `origin` (the same value it fetches against) beside the
cookie, which is exactly what the browser does.

**Rule:** any script that reuses an admin browser session must send `Origin: <APP_ORIGIN>` on
mutating requests, and a dry run that only issues GETs does not prove the live path is authorised.
Copy the `api()` helper from the September script, not the July one.

## A list ordered by `(a, b)` but paged on `a` alone silently loses rows (#115, 2026-09-15)
Tags: search-filters · #115

`GET /notifications` ordered by `created_at DESC, id DESC` and filtered the cursor with
`created_at < ?`. Two rows written in the same millisecond straddling a page boundary: the first is
the last row of page 1, the cursor is its timestamp, and the second — equal, not less — never
appears on page 2. Nothing paginated in production, so it never fired; #115 built the first paging
client and fixed it properly: an opaque cursor over both fields and the keyset predicate
`(created_at < ?) OR (created_at = ? AND id < ?)`, the same shape `routes/project-activity.ts`
already used. Two rules. The cursor covers every column in the ORDER BY, or it is wrong. And the
regression fixture must share a timestamp on purpose — with distinct timestamps the bug is
unobservable, which is exactly why it survived.

## Tonomo's RAW folder path is not stable, and the Portal froze its first copy (2026-09-15)
Tags: dropbox

**Symptom:** 26 active projects reported `path/not_found` for their stored `raw_folder_path` on the
day Editor auto-creation went live. For 12 of them Tonomo's later webhooks carried a different
`rawFolderPath`; the Portal never applied it.

**Cause:** Tonomo's path encodes the assigned photographer and the shoot date
(`/tonomo/raw files/<photographer>/<dd-mm-yyyy>/<address>`), so it changes on reassignment or
reschedule. `updateProject` in `tonomo/process.ts` only null-filled `rawFolderPath` (a canonical
`shootDate` was frozen the same way until PR-D1, see the reschedule entry below). Tonomo also
sometimes recomputes the string without moving the folder (Rosemont: folder and 67 assets at the stored path, Tonomo reporting another), so blindly
accepting the newer path would have broken a working project.

**Fix:** a differing incoming path is adopted only after `get_metadata` confirms it is a folder,
never when an Editor mapping is `ready` (RAW intake has moved to the Editor tree), and never when
the address leaf differs (Editor and AutoHDR names derive from it). The write is a guarded UPDATE
fenced on the path this event read, with the audit row in the same D1 batch, plus an explicit
`dropbox_sync` job (a D1-only edit produces no Dropbox delta) and an AutoHDR re-scaffold.

**Rule:** a third party's path string is a claim, not a fact. Verify it against Dropbox before
writing it, fence the write on the value you read, and nudge every consumer that only wakes on
Dropbox deltas.

## A ready Editor mapping owns RAW intake, so a missing Tonomo folder is not a reason to skip the tree (2026-09-15)
Tags: dropbox

**Symptom:** 26 active projects were silently skipped by the scaffold because `get_metadata` on
their stored Tonomo RAW path returned `path/not_found`; the reconcile job finished "done" with no
mapping and no error. The first plan said "an Editor tree for a project with no RAW serves nobody".

**Cause:** that reading missed `resolveRawSyncPlan` (`dropbox/sync.ts`): once a mapping is `ready`,
RAW intake comes only from the Editor Input roots and the RAW monitor stops watching the Tonomo
folder for that project. The Tonomo folder is identity and name source, not the working folder.

**Fix:** `resolveRawIdentity` in `scaffold.ts` resolves the RAW shared link when the stored path
is gone (Dropbox follows moves), adopts a folder found under the RAW root, reports one found
elsewhere, and otherwise creates the tree from Tonomo's original-cased `formatted_address` (the
stored path is `path_lower`, so its casing is gone). The mapping records `rawSource` and
`nameSource` in `photographer_evidence_json`, which the candidate endpoint surfaces.

The same ownership rule cuts the other way, which Sol's review caught: adopting the recovered
path, queueing a RAW sync and creating the tree in one pass lets the tree go `ready` before the
sync runs, and the sync then reads the Editor Input root instead of the folder it was queued for.
So link recovery re-points the Project, queues the scan and returns without a mapping; the
reconcile also refuses to provision while a `dropbox_sync` job for the project is queued or running.

A silent skip was the original symptom: `reconcileEditorFolder` returned `null` for a dozen
different reasons and the queue consumer marked the job `done`. The fix is not a new job status
but a typed outcome (`reconcileEditorFolderOutcome`) whose reason lands in `jobs.error` with
status `done`, so retry gates (which key on `failed|stuck`) are untouched and the workspace job
list simply shows the text. The candidate endpoint reads that latest job rather than re-running
the classification, because classification is not read-only (link recovery re-points the Project).

**Rule:** before deciding a tree is pointless, check which side owns intake after the mapping goes
ready, and never let the tree go ready while a scan of the old side is still queued. A background
pass that ends without its expected side effect must say why somewhere durable. Never derive
a user-visible folder name from `path_lower`; find the original-cased source or use the Portal's
own address. Tonomo webhook payloads are stored as posted, and Tonomo posts a one-element array
as often as a bare object, so any SQL over `webhook_events.payload_json` unwraps `$[0]` first.

## A missing path turned the Dropbox connection red (2026-09-15)
Tags: dropbox

**Symptom:** minutes after the owner reconnected Dropbox with `sharing.read`, Admin → Integrations
showed the connection in `error` with `[dropbox:configuration] Dropbox /files/get_metadata failed
(409): path/not_found`.

**Cause:** `authorisedJson` in `dropbox/client.ts` writes every failed call to the connection's
`last_error`, and `classifyDropboxError` files any 409 under the sticky `configuration` class,
which no later success clears. Since #144 the Editor scaffold asks `get_metadata` about a stored
Tonomo RAW path precisely to learn that it has moved, and it probes every new Editor root before
creating it. A normal answer about a path was being recorded as a broken integration.

**Fix:** a `get_metadata` 409 `path/not_found` throws `DropboxPathNotFoundError` without touching
the connection; callers already judge it with `isDropboxPathNotFoundError`. Every other failure
is still recorded.

**Rule:** only record on the connection what is true of the connection. A lookup whose negative
answer is expected belongs to the caller, as `list_folder`'s `allowNotFound` already did.

## A canonical shoot date was frozen, so Tonomo reschedules never reached the Portal (2026-09-15)
Tags: scheduling

**Symptom:** a Project rescheduled in Tonomo kept its original `shoot_date`, and its Editor tree sat
under the old day folder with a `done` reconcile job and no note.

**Cause:** the Tonomo processor only upgraded a non-canonical date to a canonical one; a canonical
stored date was never overwritten, by design, because the parser passes unrecognised text through
verbatim and a bad parse must not clobber a good date. The guard could not tell a real reschedule
from noise because the parsed order did not say where its date came from.

**Fix:** `parseTonomoOrder` now returns `shootDateSource` (`start_time`, `iso`, weekday-checked
`display`, or `text`). A verified source moves the date through one fenced D1 batch
(`projects/shoot-date.ts`): the UPDATE is guarded on the date the processor read and on no
`project.shoot_date.changed` audit whose `eventReceivedAt` is later than this event's `received_at`
(receipt time, not processing time, or a lagging newer event would be refused), and the audit INSERT
fires only if that UPDATE landed. `text` is declined and audited once. The guard only sees changes
it recorded: a date set at creation or by the display-to-ISO upgrade has no receipt time to compare.
At the time, the Editor tree was not moved: a ready mapping reported `editor_folder_not_moved`, and
a pending mapping that created nothing was re-pointed inside its provisioning lease. **Superseded by
#153**, which moves a ready tree too and removed that code; the pending re-point is unchanged.

**Rule:** a field that is "never overwritten" needs a provenance tag before it can be safely
overwritten; fence the write on both the value read and the event's age, since webhook redelivery
is ordered by processing, not by when Tonomo made the change. Moving a Dropbox tree is not a path
update: anything keyed by path (Edited assets, pinned publish destinations) must follow first.

## The rail and the Dashboard computed "which view is showing" independently, and drifted (#119, 2026-09-15)
Tags: routing, search-filters · #119

**Symptom:** with Projects archived, clicking the rail's Kanban pushed `/?view=kanban` and marked
Kanban current, while the screen kept rendering the archived List. Separately, an explicit List
switch followed by Back left the Dashboard showing Kanban (its own pinned mount-time snapshot)
while the rail, re-reading `localStorage` for the new location, marked List.

**Cause:** the navigation model (`lib/staff-navigation.ts`) computed the active view from the
parsed route and the remembered preference. The Dashboard computed its own rendered view from
private screen state — archive scope, a fixed per-document Back snapshot — that never reached the
route. Two surfaces deriving the same answer from different inputs drifts the moment one of them
holds information the other does not.

**Fix:** `lib/dashboard-view-store.ts`, a module-level store following the toast-store precedent
(#110) — no React context, since `Dashboard` mounts standalone in its own DOM tests with no
provider. The Dashboard publishes the view it is actually rendering, keyed by an opaque owner
object so a stale instance's release can never clear a live publication. The navigation model
treats that publication as authoritative and stops re-deriving or re-coercing it; the route/
remembered derivation is now only the pre-mount fallback. A published view that matches no render
branch (a role losing the Calendar capability mid-flight) publishes `"none"` rather than a guess,
so the rail marks nothing rather than a view the screen is not showing.

**Rule:** the screen that renders owns the answer to "what is currently showing"; navigation chrome
reads that publication rather than re-deriving or re-coercing it, or the two will eventually see
different inputs and disagree.

## #147 fixed only future Tonomo reschedules; the historic ones needed a one-off backfill (2026-09-15)
Tags: scheduling, d1-migrations · #147

**Symptom:** after #147 shipped, 10 active Projects still showed shoot dates that their latest
Tonomo event had already moved.

**Cause:** the fix changes how the processor applies an event. Events processed before it were
already `processed`, so nothing replays them, and the frozen dates stayed frozen.

**Fix:** an owner-approved operator backfill (2026-09-15 ~12:15Z, backup first) set the 10 dates
through a fenced batch (only while still the old date and with no Editor mapping) with one
`project.shoot_date.changed` audit each, meta `actor: "operator_backfill"` and `eventReceivedAt: 0`
so any real Tonomo reschedule still wins the stale-event guard.

**Rule:** a fix to how events are applied needs a separate look at what the old behaviour already
wrote. Say in the PR whether historic rows need a backfill, and give it an age that loses to real
events.

## Display what the RAW-sync consumer reads, not what it could recompute (#155, 2026-09-16)
Tags: dropbox · #155

**Symptom:** once a project's Editor folder mapping goes `ready`, RAW sync reads only its Input
roots and the RAW-scope monitor stops watching the Tonomo folder — but the project page kept
showing the Tonomo `raw_folder_link`/`raw_folder_path` as if they were still the monitored
location, so staff believed the Portal was watching a folder nothing reads from any more.

**Cause:** the Tonomo path and the Editor Input path are two different, legitimately independent
fields once a mapping is `ready`: Tonomo's still drives change detection (#142), RAW identity
recovery and AutoHDR naming, while the Editor mapping's `input_roots_json` is what `dropbox/
sync.ts` actually polls. Nothing wrote the wrong value; the page just never learned there were now
two folders and picked the wrong one to display.

**Fix:** the monitored-folder projection (`workers/app/src/lib/editor-folders.ts`) reads
`input_roots_json` directly and derives nothing from `root_path + "0. Input"`, `tonomo_raw_folder_
path`, or any date/name constant — those can all recompute a path RAW sync no longer reads once a
legacy `Day/Input` root or a manual re-link has diverged the mapping from its own naming
convention. Same rule as the "Tonomo's RAW folder path is not stable" entry above, aimed the other
way: a path is only trustworthy as *display* when it is read from the exact field the consumer it
describes actually reads, never recomputed from the rule that (usually) produces it. The rail and
Edit Project notice are two independent surfaces reading the one projection, so a projection bug
shows up the same way on both instead of silently agreeing with each other by accident.

**Open question:** the "Open in Dropbox" link points at `https://www.dropbox.com/home/<path>`,
which resolves under whichever Dropbox namespace the signed-in browser session defaults to. D1
records no team-namespace ID for the studio's Dropbox account, and no automated test can drive a
real signed-in Dropbox tab to prove the link lands in the studio's team space rather than the
individual's. It needs one real click by the owner before this is provably correct, not just
plausibly correct.

## A Calendar or Board unmount left the Dashboard's controls stuck disabled (#152, 2026-09-16)
Tags: gantt-calendar, board-dnd · #152

**Symptom:** starting a Calendar deadline drop or a Kanban drag, then pressing Back or clicking a
different rail child mid-interaction, left List/Kanban/Calendar disabled and Archived a silent
no-op until reload.

**Cause:** each surface told its parent about its barrier only through an effect keyed on its own
state (`useEffect(() => onAcceptGateChange?.(gate), [gate, ...])`), and reset that state in its
unmount cleanup — a state update on an unmounting component, which React drops. The effect never
ran again, so the parent's copy of the barrier never cleared. Separately, dnd-kit does not detach
an active sensor when `DndContext` unmounts, so a drag left running when the Board unmounted could
still deliver a drag end from a board that was gone, and the confirm a Calendar drop had opened
stayed open with no way to withdraw it once the component owning its continuation was gone.

**Fix:** both surfaces keep the parent's callback in a ref, updated every render (the
`move-to-control.tsx` precedent), and call it directly from unmount cleanup rather than waiting on
their own effect. `lib/confirm.ts` gained an optional `signal` field on the confirm request, so a
component can withdraw exactly the confirm it opened, on unmount, without disturbing the queue's
other entries; the field is destructured out before the request is stored, since `ConfirmDialog`
spreads the stored options onto a DOM component. `kanban2/board.tsx` gained an `unmountedRef` that
every dnd-kit handler (`onDragStart`/`onDragOver`/`onDragEnd`/`onDragCancel`/`onMove`) checks
first, so a handler dnd-kit still fires after unmount is a no-op rather than a write from a dead
board.

**Rule:** a component that raises a barrier in its parent must lower it in unmount cleanup through
a ref'd callback, not its own state — a state update on an unmounting component never runs the
effect that would have told the parent. And a component that hands a callback to a third-party
library must fence that callback against firing after unmount, since the library's own teardown is
not guaranteed to run first.
## `move_v2` needed its own error vocabulary and its own response shape, not `get_metadata`'s or `create_folder_v2`'s (#153)
Tags: dropbox · #153

**Symptom:** wiring `/files/move_v2` the same way the two existing Dropbox endpoints were wired
would have reintroduced #148 for a new endpoint, and mistyped a routine response.

**Cause:** #148 only carved `get_metadata`'s `path/not_found` 409 out of "every failure is recorded
on the connection"; `authorisedJson`'s generic branch still recorded anything else, and `move_v2`
has its own 409 vocabulary that isn't `path/not_found` at all — `to/conflict` when something already
occupies the destination, `from_lookup/not_found` or `to/not_found` when the source or the
destination's parent is gone. Both are facts about the *paths* being moved, not about the
connection, exactly like #148's lesson, but the code that recognised #148's shape had no reason to
also recognise this endpoint's. Separately, `create_folder_v2` always returns a folder, so
`createFolder` never has to look at what it got back; `move_v2` returns a Metadata **union**
(file/folder/deleted) tagged by `.tag`, and assuming "it's a folder" the way `createFolder` does
would silently mistype a relocated file as a moved folder instead of throwing.

**Fix:** the first pass enumerated the 409s it knew about — `to/conflict` as
`DropboxRelocationConflictError`, `from_lookup/not_found`/`to/not_found` as the existing
`DropboxPathNotFoundError` — and review caught that this was #148 a third time in waiting: the
unlisted variants (`no_write_permission`, `insufficient_quota`, `too_many_files`, and whatever
Dropbox adds next) still fell through to the generic branch and marked the connection. An
enumeration of a union that grows is a bug with a delay on it. So the carve-out became a type
instead of a list: `DropboxPathError` is the base for "a fact about a path, not the connection",
`authorisedJson`'s catch tests that one type, and **every** `move_v2` 409 is one of its subclasses
— a 409 on that endpoint is by definition about the two paths in the request. A new path-scoped
error now only has to extend the base to be excluded. `moveFolderStrict` separately runs the same
`parseEntry()` every other endpoint uses on the returned metadata and rejects a non-folder `.tag`
instead of assuming one.

**Rule:** #148's rule ("only record on the connection what is true of the connection") is not a
fact about `get_metadata` — apply it fresh to every new endpoint's actual documented error shapes.
And the third time you write the same carve-out, stop writing carve-outs: make the safe behaviour
the default for the whole endpoint, so the next unlisted variant costs nothing. Never assume one
endpoint's response shape (a bare folder, a union) carries over to the next just because both
return something with an `id` and a `path_lower`.

## The commit after an irreversible external change is the one that must not retry forever (#153)
Tags: dropbox, queues-workflows · #153

**Symptom:** if the D1 batch that records an Editor folder move failed *after* Dropbox had already
moved the tree, the mapping stayed `moving` — which correctly fences editor sync, manual publishing
and RAW reconciliation — and every later pass took the lease over and failed the same way. The
project's whole Editor pipeline was silently switched off, with nothing in the UI, no audit row and
no note saying why.

**Cause:** retry is the right answer for a transient failure and the wrong one for a deterministic
failure, and the code could not tell them apart. A UNIQUE collision on the destination fails
identically every minute forever. The fence that protects the data during a move is the same thing
that strands the project when the move never completes.

**Fix:** count the attempts durably (`move_commit_attempts`, migration 0045, reset by a successful
commit or a release) and escalate at three: keep `moving` so nothing syncs against a path that is
no longer there, stop taking the lease over, and write both an audit row
(`editor_folder.move.commit_stuck`) and a plain-language note saying the Dropbox folder has already
moved and the Portal could not record it.

**Rule:** when an operation changes the outside world before it records that change, the recording
step needs a bounded number of attempts and an escalation a human can see — not an unbounded retry.
"The world has changed and the database does not know" is the state to design an alarm for, because
it is the one state that will not fix itself and will not announce itself.

## An Editor tree move needed a version fence, not a path fence, and a human upload has no signal before the move commits (#153)
Tags: dropbox · #153

**Symptom:** an early design for the reschedule move fenced every writer on `root_path_key` alone,
and treated a run of Dropbox's `list_folder` at claim time as sufficient proof the tree was quiet.

**Cause:** a path key is not a version. A mapping can occupy key A, move to key B on one
reschedule, and move back to key A on a second, so a writer (an Output sync, a RAW sync) that
started against key A before the first move could still match key A's *second* occupation days
later — the key repeats, but the tree underneath it does not. Separately, a human dragging files
into Dropbox produces no signal to the Portal until the next time something asks; a single
`list_folder` at the instant of claiming cannot see an upload that starts a second after that call
returns, so "no recent files right now" is not "safe to move."

**Fix:** `root_revision` is a counter the mapping's own commit batch bumps by exactly one, never by
anything else, so it only ever moves forward even if the path key it's attached to cycles back.
Every writer that touches a mapped tree — the move's own claim and commit, `sync-output.ts`, the
RAW-mapped branch of `dropbox/sync.ts` — reads the revision once at the start of its run and binds
every subsequent write to that exact value plus a live `move_status != 'moving'` check, so a run
that starts before a move cannot land under the tree the move produces even if the key matches
again later. The move itself never claims off one snapshot: it requires 30 quiet minutes before
claiming, takes the same reading again immediately after claiming (a check-then-commit gap is still
a gap) and releases if that second check finds an upload, and — because even that cannot see an
upload Dropbox has not yet reported — leaves the emptied old path on the mapping after landing and
watches it for another 30 minutes, reporting rather than merging anything that turns up there.

**Rule:** a value that can repeat is not a version; fence concurrent writers on a counter that only
moves forward, not on whatever identifies the row today. A background process guarding against an
unannounced, asynchronous write (a human's own upload) cannot infer "quiet" from one absence-of-
activity check at decision time — pair a quiet period before acting with a sweep after, and never
let the sweep adopt what it finds.


## A passing test that opens a real socket — the origin happy-dom hands you is a real one (#167)
Tags: testing-guards · #167

**What happened:** adding the DOM suite to CI (#158) surfaced `ECONNREFUSED ::1:3000` in every run.
Eight of the 94 files were opening real TCP connections to `localhost:3000` — around forty per run —
and all eight passed. happy-dom gives the document a default origin of `http://localhost:3000`, so
anything the app requests during a test resolves against it and vitest dials out for real. The
connection is refused on a machine with nothing on that port, the rejection lands after the test has
ended, and vitest prints it as stderr rather than failing the run.

Refusal was doing all the work. With `npm run dev` listening on :3000 those same requests *succeed*
against a real local API — so the tests read one way on a developer's machine and another on CI,
which surfaces as flakiness with no visible cause and no stack that points anywhere useful.

**The diagnosis was wrong the first time.** The issue named `SubtaskChecklist.tsx`'s
mentionable-users `apiGet` as the source, which was plausible and false: all eight files already
mocked `lib/api`. The actual caller in every case was better-auth's client — `lib/auth.ts`'s
`useSession` polling `/api/auth/get-session` through `@better-fetch/fetch`, an absolute URL built
from `window.location.origin`. What found it was hooking `fetch` and printing a stack, after a first
guard that hooked `fetch` in `beforeEach` caught nothing at all: the call is issued from a timer, so
it lands between tests or after teardown, outside any hook's window.

**Fix:** `apps/web/src/testing/no-unmocked-fetch.ts`, a `setupFiles` entry for the DOM config, swaps
`fetch` for one that records the attempt and rejects — installed at module scope, before any test
file imports the app, and reasserted per test. Failing is done by *recording* and throwing in
`afterEach`/`afterAll`, not by the rejection: components catch their own fetch errors and swallow a
bare one. The eight files got the mock the other twenty already had:
`vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }))` —
`data: null` because that is the state they already ran against, so no capability-derived branch
silently changed.

**Rule:** a test that passes is not a test that stayed local. When a DOM environment invents an
origin, every relative URL in the app becomes a live address — assume the network is reachable
unless something in the suite makes it unreachable, and put that something in `setupFiles` where no
individual test can forget it. When a leak is issued from a timer, a `beforeEach` hook is the wrong
instrument: it is not running when the call happens. And a guard that lives in a config field is one
deleted line from decorative — guard the wiring too (`dom-fetch-guard-wiring.guard.test.ts`).

## A staged rollout leaves two states, and dev was stuck in the older one (#160)
Tags: deploy-ci, d1-migrations · #160

`0037_project_board_order_contract` seeded `tb5a_board_contract_enabled` at `0`. That was correct:
the Board contract shipped off and production was flipped on deliberately afterwards. What nobody
wrote down is that flipping it was the *second half* of the rollout — so while production ran the
post-rollout configuration, every local database sat in the pre-rollout one forever. The Kanban
renders "Board interactions are temporarily unavailable", every drag handle carries
`data-disabled="true"`, and no drag can be started by mouse or keyboard. Each git worktree has its
own `.wrangler/state`, so this recurred per worktree and was rediscovered by hand each time.

It surfaced in the #152 browser pass: three of five checks could not execute at all and were logged
inconclusive. Not a test failure — an *absence* of testability, which is harder to notice, because
nothing turns red. Together with the DOM suite being absent from CI (#158), a Kanban drag regression
was caught at neither the automated nor the manual layer.

**Where the fix does not go.** `packages/db/seed/0001_seed.sql` is the all-environments seed, so
enabling a flag there would reach production — and it uses `INSERT OR IGNORE`, which would not
update the row 0037 has already created at `0`, so it would not even work. Nor does a bare
`d1 execute --file`: applying SQL proves nothing unless something checks it landed, and printing the
row is not checking it. `packages/db/setup-local.mjs` runs the migrations, enables the flag, then
*asserts* the flag reads `1` and exits non-zero otherwise. `db:migrate:local` is now that script.

`workers/app/wrangler.jsonc` carries the production D1 `database_id`, so `--local` is the only thing
between a dev-setup script and the real database. It is hard-coded, never taken from the caller, and
`--remote` / `--env` / `--config` / passthrough are refused before a subprocess is spawned.

### The same migration was quietly able to revoke the flip

0037's insert ended `ON CONFLICT(key) DO UPDATE SET enabled = 0, updated_by = NULL, ...`. Seeding a
default is right; *restamping* a live value is not. Replaying that statement against a database
where an operator had enabled the Board switched it off for every user and erased who had turned it
on — no schema change, no error, nothing to explain the outage. A feature-flag row is operator-owned
the moment it exists. It is now `ON CONFLICT(key) DO NOTHING`, with
`migration-feature-flag-ownership.guard.test.ts` failing the build on the next one.

Two corrections to how that was first written up, both worth keeping:

- **Whole-file replay was never the reachable path.** 0037's three `ALTER TABLE ... ADD COLUMN`
  statements sit above the flag insert and abort on the duplicate column first. Only the single
  statement can reach the conflict clause, which is what the test replays. A hazard you cannot
  reproduce is a hazard you have not actually verified.
- **Editing an applied migration was safe here, and that is narrower than it sounds.** Wrangler's
  ledger is `id / name / applied_at` and matches by *name*; drizzle's `_journal.json` entry is
  `{idx, version, when, tag, breakpoints}`. Neither stores a checksum, so an environment that has
  applied a migration never re-reads the file and cannot detect the edit. This does **not** make
  migrations editable in general — it made this edit free because it provably could not change the
  fresh-apply path (row absent → INSERT branch → `enabled = 0`, which the existing 0037 tests
  already assert). A new migration was the alternative and would have been ceremony: running after
  0037 on a replay, it cannot restore a value it never knew.

One thing that is *not* a defect, and must stay as it is:
`workers/background/src/external-role-cache-purge.ts` also re-asserts on conflict
(`DO UPDATE SET enabled = 1`). That one is a latch deliberately asserting a freeze after the bounded
zone purge exhausts, not a default being restamped — converting it would break the freeze. The guard
reads migrations only, so it is excluded structurally rather than by an allowlist. (Its release is
the audited admin PATCH `/api/users/external-provisioning-freeze`, added in #161.)

**Rule:** a migration may establish a flag's default, never re-assert it. And when a rollout has a
manual second step, the step is part of the rollout — automate it into dev setup or it becomes a
permanent divergence nobody can see, because the environment that is wrong is the one with no users
complaining. Be honest about what the guards prove: they gate the wiring, not your `.wrangler/state`.
Nothing in CI can assert your local database has the flag on; only a browser pass closes that.

## A green CI step that runs nothing is worse than a missing one (#170)
Tags: testing-guards, deploy-ci · #170

`.github/workflows/portal.yml` ran `npx vitest run --config workers/app/vitest.dev.config.ts` for
almost two months. The step passed every time and executed nothing: `133 skipped, 0 passed`. That
config exists for exactly one behaviour — Miniflare's direct R2 PUT fallback, the path dev uses for
document uploads — so that behaviour had no executing test anywhere, while the workflow displayed a
green step implying it did. Behind it sat a completion batch that had never worked (#171).

**Why the gate never flipped.** The test is gated on `process.env.DOCUMENT_DIRECT_TEST === "true"`
and the config flipped it with `define: { "process.env.DOCUMENT_DIRECT_TEST": JSON.stringify("true") }`.
Vite does **not** substitute `process.env.*` define keys in the workerd/SSR transform. The
expression survived to runtime and read an empty `nodejs_compat` `process`, so `documentDirectIt`
was permanently `it.skip`. Exporting the variable in the shell does not help either — the shell's
environment is not the isolate's.

The fix is the idiom the same config already relied on and which demonstrably does reach the module:
a bare identifier (`__DOCUMENT_DIRECT_TEST__`, like `__PORTAL_MIGRATION_SQL__`), declared with
`declare const` in the test file.

Two things were ruled out by experiment rather than by reading, and both were worth the five
minutes: `testNamePattern` works fine under that config (point it at another test in the same file
and that test runs), and a probe test under the config observed `process.env.DOCUMENT_DIRECT_TEST`
as `undefined` while `typeof process === "object"`, which is what distinguishes "not substituted"
from "substituted with the wrong value".

**Why nothing caught the emptiness.** `vitest run` exits 0 when every test it collected was skipped,
and `passWithNoTests` does not cover it — that option is consulted only when zero *modules* were
collected. Verified, not assumed: `npx vitest run --config packages/shared/vitest.config.ts -t
"zzz-no-such-test-name" --passWithNoTests=false` reports `240 skipped` and exits **0**. There is no
built-in knob for the all-skipped case in vitest 4.1.10.

So `packages/shared/src/testing/require-executed-tests.ts` fails any run that executed nothing, and
`ci-vitest-configs.guard.test.ts` — which already discovered configs from the filesystem for #158 —
now also asserts every config wires it. The guard checks the *resolved config object*, not the
source text: a reporter added under the wrong key, or clobbered by a later spread, still reads
correct in review and still exits 0.

Three details that are load-bearing:

- **Set `process.exitCode`, do not throw.** Vitest assigns the exit code before reporters run and
  does not catch reporter errors, so a throw surfaces as a misleading startup banner.
- **The rule is per invocation, not per file or per test.** One executed test alongside 132 skips is
  green; so is one all-skipped file among many. Only "this whole run executed nothing" fails. That
  is the weakest rule that catches #170 and it leaves legitimate skips alone.
- **Reporters run in the vitest host process**, which is why this works where the `define` did not.
  workerd and happy-dom never see it.

One more thing the gate could not tell us about itself. It was proven red three ways — a permanent
subprocess test, the wiring guard, and the real dev invocation — and a read-only review still found a
hole in it: vitest replaces every configured reporter when the CLI passes `--reporter`, so
`vitest run --config … --reporter=default` drops the gate and an all-skipped run exits 0 again. The
reviewer could execute nothing (its sandbox blocked vite's temp writes) and found it by reading
vitest's dist, pinned to an exact line. The fix was to narrow the claim rather than widen the code:
the gate is per *config*, the reporter says so in its own header, and the absence of `--reporter` in
the workflow is asserted directly rather than left to `configsRunByTestJob` rejecting the step for an
unrelated-sounding reason. A gate that fires correctly and lies about why costs the next reader more
than a clean failure does.

Two caveats on leaning on a review like that: it reported on a snapshot, so anything committed after
it is simply unreviewed — silence there covers nothing — and anything it could not run is a reading
of the source, which is worth reproducing before acting on. Both of its findings reproduced.

**Rule:** being invoked is not being run. A step's exit code answers "did anything fail", never "did
anything happen" — assert the second separately, and prove the assertion red before trusting it.
`require-executed-tests.test.ts` runs a real `vitest run` against fixture files and asserts the child
process's exit code, because every part of a gate like this can look right while the run still exits
0. That is precisely how #170 survived review for two months.

## A timeout is a budget someone chose, and nobody had chosen this one (#188)
Tags: queues-workflows, testing-guards · #188

Four CI failures in one day were timeouts with **zero failing assertions**: the gated
`api.test.ts` document-direct test (#170), `tb5a-migration-proof.test.ts` (#181), the notice-toast
dismissal test added in #184, and `route-manifest.test.ts:289`. Each was diagnosed on its own, and
three were patched on their own with a per-test or per-`describe` budget. That is three fixes for
one defect, and it leaves the next slow test starting from the same place.

The measurement is what settled it. All eight vitest configs, local wall clock against the same
step on one green CI run:

| config | local | CI | factor |
|---|---|---|---|
| `apps/web/vitest.dom.config.ts` | 7.49s | 164.72s | **22.0x** |
| `packages/db` | 2.17s | 23.83s | 11.0x |
| `apps/web/vitest.config.ts` | 1.42s | 15.34s | 10.8x |
| `workers/background` | 11.97s | 116.09s | 9.7x |
| `workers/app` | 18.25s | 139.36s | 7.6x |
| `packages/shared` | 1.59s | 9.60s | 6.0x |
| `workers/webhook-ingress` | 0.25s | 0.76s | 3.0x |
| `workers/app` (dev config) | 4.75s | 13.39s | 2.8x |

The tempting split — a tight budget for the fast pure-logic suites, a loose one for workerd — does
not survive this table. `apps/web` is 10.8x with no workerd in sight, **worse** than `workers/app`
at 7.6x, and the DOM suite is the worst of the eight. The cause is the runner, so the budget is
repo-wide. At 22x, a test taking 228ms locally is already at the 5s default's edge, and 228ms is an
ordinary DOM test.

Two things made this hurt more than a flaky test normally would. The `test` job runs seven configs
as **sequential steps**, so a failure at step 8 destroys the evidence for steps 9–13. And a timeout
names a line number and explains nothing, so each one cost a diagnosis cycle to establish that it
was a budget rather than a defect.

Worth saying plainly, because it looks like the opposite: **raising a timeout is not loosening an
assertion.** None of those tests asserted anything weaker afterwards. They ran out of wall clock
before reaching their assertions at all, and a hung test still fails — 25s later. The one real
cost is in that direction, which is why the guard bounds the budget from **both** sides rather than
setting a floor: an unbounded floor would let a later bump to 300s through silently, and that is
the only direction anyone priced a cost for.

One self-inflicted case is worth separating from the other three. The #184 dismissal test was slow
because it *slept* — it waited out the real 3.6s toast TTL, spending 75% of the default budget
doing nothing. A bigger budget would have hidden that. Fake timers took it from 3744ms to 18ms. Ask
which kind you have before reaching for the budget: a test that is slow because the runner is slow
wants a budget, and a test that is slow because it waits wants to stop waiting.

**Rule:** an inherited default is not a decision. Before treating a timeout failure as a defect,
check whether any assertion failed — if none did, you are looking at a budget, and the question is
what the budget should be for the machine that actually runs it. Measure before choosing, fix the
class rather than the instance, and bound the answer from both ends.

## A failure handler outside `step.do` is not durable, and "the row now matches" is not "my write landed" (#154)
Tags: queues-workflows · #154

`ManualEditedPublish` did its failure bookkeeping in a plain `catch`. If that write threw, or the
instance died before reaching it, the job stayed `running` and the Edited asset `pending` forever —
and nothing in the system ever wrote `stuck`, so Retry never appeared. The fix was two parts, since
neither covers the other: the bookkeeping runs inside `step.do`, and a minute-cron sweep asks the
Workflow binding (`get(jobId).status()`; the instance id *is* the job id) about aged active jobs.

Four traps came up in the build and review, each of which passed a green test first:

- **Age proves nothing about a Workflow.** An unconfigured `step.do` can legitimately run ~52 min
  (5 attempts × 10 min + backoff), and this Workflow has 8 of them. Age only pre-selects rows; the
  instance status decides. Only `errored`/`terminated`/`complete` and `instance.not_found` recover;
  `unknown` and every other lookup error skip.
- **Miniflare conflates not-found.** Its `get()` rethrows *any* `status()` failure as
  `instance.not_found`, so local tests cannot tell a missing instance from a failed lookup. It does
  report a terminated instance as `terminated` — a comment claiming otherwise was wrong and was
  caught only by re-reading the probe output.
- **Gate dependent writes on `changes() = 1`, not on the row's resulting values.** The first cut
  let the asset update fire if the job row *now* equalled the tuple the batch wrote. A duplicate
  delivery of the same sweep matches that tuple without having changed anything, and would re-fail
  an asset an operator retry had just reset. `changes()` of the preceding statement asks the right
  question: did *this* batch's transition land. The same bug hid in the sweep's counter, which
  called a lost CAS "recovered" — and a test had encoded that.
- **A bounded, oldest-first page starves.** Skipped rows keep their `updated_at`, so 25 sticky
  rows fill every page forever and hide the dead instance behind them. Random order restores
  progress without a cursor.

**Rule:** a fixed page over a set you do not shrink is not bounded work, it is a queue that never
advances; and a guard that checks state rather than your own write's effect is a guard a replay
passes.

## A latch is only half-built until something a human reads says it is set (#163)
Tags: notifications, queues-workflows · #163

#153 and the provisioning freeze both latched correctly and wrote their reasons down carefully —
into `move_note`, `feature_flags` and `audit_log`, none of which any screen read. A stuck project was
found when someone noticed the Editor pipeline had gone quiet. #163 added one read path
(`workers/app/src/lib/attention.ts`) behind Admin → Pipeline and a project banner.

Things the reviews caught before the build, each of which would have shipped a wrong answer:

- **Not every latch pauses the same thing.** Only `moving` is fenced by
  `EDITOR_MAPPING_NOT_MOVING_SQL`; a `blocked` move leaves sync running against the old folder. A
  banner saying "paused" for both would have been false for the common case.
- **A latch can outlive its relevance.** A block is only cleared by a reconcile pass, and the cron
  stops selecting a row once the shoot date reverts or the project is archived/delivered — so the
  row stays `blocked` indefinitely. The reader filters to blocks that still apply, but keeps a
  `moving` row whatever the project state, because its fence is still up.
- **`updated_at` is "last written", not "since".** Other writers bump it. The UI says "Last updated".
- **A capped list must not be able to hide a global state.** The freeze is returned beside the
  project list, not inside it.
- **A failed load must never render the empty state.** "Nothing needs attention" on a 500 is the
  exact silence this surface exists to end.

Separately, a trap in the web test tooling: `npx vitest run src/…/X.dom.test.tsx` in `apps/web`
uses `vitest.config.ts`, which includes only `*.test.ts`. On its own it prints "No test files
found"; alongside any `.test.ts` file it runs those and reports green with the DOM file silently
skipped. (Fixed since: `apps/web/vitest.config.ts` has `unit` and `dom` projects, so a path finds either; `--project dom` selects the DOM suite.)

**Rule:** when you add a latch, add the place a human sees it in the same change — and when you
read one, ask what it actually stops, and whether it can outlive the reason it was set.

## A dev proxy that forwards the browser's Origin unchanged fails every exact-Origin check (#191)
Tags: auth, workers-runtime · #191

**Symptom:** in `npm run dev` (Vite on `:5173`), every POST/PUT/PATCH/DELETE returned
`403 {"error":"Forbidden: invalid request origin"}`. Reads worked, so the app looked healthy until a
write. It surfaced as "the Kanban drag is broken" during the #160 browser pass.

**Cause:** `requireAppOrigin` demands `Origin === APP_ORIGIN`, and the dev `APP_ORIGIN` is
`http://localhost:8787` on purpose (Google OAuth is registered there, first entry above). Vite's
proxy changed the destination but forwarded `Origin: http://localhost:5173` untouched, so the two
could never agree. `APP_ORIGIN` was right; the proxy was wrong.

**Fix:** `apps/web/src/config/dev-proxy.ts` rewrites `Origin` to the proxy target, but only when the
Origin is the dev server itself (its host equals the request's `Host`). A cross-site page keeps its
own Origin and is still rejected. `dev-proxy.test.ts` drives a real Vite proxy against a real HTTP
server, and also asserts that `vite.config.ts` uses the helper for `/api` and `/media`.

**Rule:** a proxy in front of an origin check must decide what Origin it presents. Rewrite it only
for the pages it serves itself, never for every request, or the proxy launders a cross-site request
into a trusted one.

## A bounded page is only bounded if every row on it can move (#194)
Tags: search-filters · #194

The minute cron's move-recovery select took 10 `moving` rows with an expired lease, oldest first. A
commit-stuck mapping (`move_commit_attempts` at the limit) always matches that, and
`resumeEditorFolderMove` returns before writing anything, so it never stops being the oldest. Ten
of them filled the page for good — the #154 starvation again, from a different starting point. The
same select also had two conditions that could never end: a `queued`/`running` reconcile job with no
age bound (one that died mid-run hid its project forever), and `move_expires_at < now`, which is
never true for NULL, so a lease with no expiry could never be taken over.

- **Exclude what nothing will act on, at the top level.** The stuck clause sits beside
  `state = 'ready'`, not inside the `moving` arm: a stuck row with an old orphan watch matched the
  orphan arm and would have taken the slot anyway. A mutation that moved it into the arm failed a test.
- **A throttle on "in flight" needs an end.** The job only throttles while `updated_at` is inside
  `JOB_STALE_MS`. Use `updated_at`, not `created_at`: a retried delivery is old and still alive. A
  second pass next to a slow live one is safe, because every move write is fenced on the lease token.
- **NULL fences need `IS`.** Treating a NULL expiry as expired in the reader is not enough on its own:
  the takeover CAS compared `move_token = ? AND move_expires_at = ?`, which never matches NULL. Only a
  test with *both* columns NULL caught the token half, and a mutation run is what showed that test was missing.

**Rule:** for every row a bounded page can select, name the write that takes it off the page. If
there isn't one, the row doesn't belong in the select.

## One column can only watch one thing, and a report nobody can clear is not a latch (#195)
Tags: queues-workflows, dropbox · #195

#153 kept the orphan-upload watch in `editor_folder_mappings.moved_from_path`. A second reschedule
inside the 30-minute window overwrote it, and the first old root stopped being watched without any
error. A found orphan was only an audit row, so #163 had no state it could list or clear. #195 moved
the watch into `editor_folder_orphan_watches`, one row per committed move revision, with a durable
`found` state that an admin acknowledges.

What the blind plan reviews caught:

- **A watch list must forget a root the tree has moved back onto.** Under the single column, A→B→A
  overwrote the watch on A. Once watches accumulate, the watch on A would report the live tree as
  an orphan. The commit deletes overlapping watches, and the sweep skips any root a mapping lives
  at or is moving to.
- **A child insert in a fenced batch has to be fenced on the same win.** Guarding the watch insert
  on "the mapping is now at revision N" is also true for a replayed batch. It is chained on
  `changes() = 1` right after the fenced UPDATE, ahead of the audit row that uses the same chain.
  The batch's positional result indexes shift with it.
- **A lapse delete races a found update.** Delete only `WHERE status = 'watching' AND
  watch_until = <what you read>`. Write the found update and its audit row in one batch.
- **A cron arm needs the same reach as the pass it enqueues.** An inactive project's reconcile
  pass returned before the sweep, so a due watch there was re-enqueued every ten minutes and held a
  slot in the page of 10: #194's starvation in a different place. The pass now sweeps inactive
  projects too, and the arm selects them.
- **A caught failure must still move the row off the page.** Catching a Dropbox error so the move
  can run left the watch due and the mapping unchanged, so a revoked connection would be picked
  again every throttle window. A due watch whose check fails now pushes its own `watch_until`
  out by 30 minutes and logs; it is retried, never dropped.
- **"The path exists" is not "a file was uploaded."** Dropbox can bring back an empty folder, so
  the sweep only counts a file.

**Rule:** a column that stores "the latest X" is a list the moment X can happen twice inside the
window you care about. And before a report goes on a screen, decide what clears it.

## A focusable child inside a composite that owns keydown is a trap until you say otherwise (#206)
Tags: focus-overlays · #206

The Team chip's × is a real `<button>`, but Base UI ships it with `tabIndex=-1` and expects
removal to come from the chip's own Backspace/Delete path. #204 rejects that path on purpose
(reason `"none"`), so keyboard users had no way to remove a member. Making the × a Tab stop
(`removeProps.tabIndex = 0`) was the smallest fix and both blind plan reviews proposed it.

What Sol's diff review caught, and the Base UI source confirmed:

- **The parent chip answers every key it does not recognise with "stay here".** `ComboboxChip`'s
  keydown returns its own index for Tab and then calls `.focus()` on the chip `div`. The
  browser's default Tab then steps *from the chip div* to the next tabbable, which is the × inside
  it. Forward Tab bounced back onto the same button. jsdom does no default Tab move, so
  "activeElement is still the ×" after a bubbled Tab keydown is exactly the assertion that fails
  before the fix and passes after: the parent did not steal focus.
- **Stop the key, not the move.** `stopPropagation` on Tab in the ×'s own keydown keeps it from
  the chip; `preventDefault` would have killed the traversal we were trying to enable. Arrow keys
  still bubble so chip-to-chip navigation keeps working.
- **The vendor's own gate can skip your handler.** The first fix used `onKeyDown`. Base UI's
  `useButton` wraps the merged bubble handler and returns early while `disabled`, and the pending
  × is disabled *and* still focusable (`focusableWhenDisabled`), so mid-removal the guard never
  ran and that one state stayed trapped. The Spec review caught it from the `useButton` source;
  `onKeyDownCapture` runs before the gate. When you attach a handler through a vendor's props
  merge, read what wraps it, not just what it merges with.
- **A named element's naming rules travel with its role.** `aria-label` on a plain `<div>` is not
  a name, it is a lint error waiting for a checker. `role="group"` made the Deadline reminder
  summary a legal target. Only a fixture with a deadline *set* renders that block, so the a11y
  scan has to run against one.

Two smaller ones from the same ticket:

- **`ruleBody` finds the first matching selector, not the one in your media block**, and it splits
  selector lists on commas, so a comment with a comma inside the block hides the rule that follows
  it. Walk the braces to the block's end and strip comments before handing it the slice.
- **A browser pass against a local Worker is only as current as the local D1.** Luna's first run
  reported every criterion BLOCKED: the project API returned 500 because `0046` (#195) had never
  been applied locally. `npx wrangler d1 migrations list DB --local` before a pass, not after.

**Rule:** when a vendor composite owns keyboard handling and you make one of its children
tabbable, read the parent's keydown for what it does with keys it does not handle. "Nothing"
is rarely the answer.

## A ticket without the design file builds the ticket, not the design (#213)
Tags: agent-tooling · #213

Five header tickets (#202–#206) shipped, each with Sol's diff review, Luna's browser pass and a
spec/standards code review, and the result still did not look like the prototype the owner had
signed off. Row 2 carried the old rail's "Production / Team / Dropbox" section headings, a nested
"Dropbox" label under the "Dropbox" heading, ISO dates in a dashed box, and a Sync-only popover.
Every gate had passed because every gate compared the code against the ticket, and the ticket
never carried the picture.

How it happened, step by step:

- `/to-spec` wrote #201 from the prototype in words: ReUI example ids (`c-select-19`,
  `c-combobox-19`), behaviours, test seams. It did not link the design file or attach a screenshot.
- `/to-tickets` split #201 into a behaviour-preserving scaffold (#202, "port the rail's controls
  **unchanged**") plus one ticket per control. "Unchanged" carried the rail's section chrome into
  the header. No ticket said "and remove it".
- Each builder (fast-worker for #202, peers for #203–#205) had the ticket text and the codebase.
  None had the prototype. They built exactly what they were given.
- #206's planning noted "three sections, not four controls" and judged no restructuring needed —
  correct for a responsive/a11y ticket, wrong for the product. The gap was visible and nobody
  owned it.
- The prototype itself had a bug: no CSS rule for its `.hrow` container, so Claude Design rendered
  row 2 stacked while its own caption said "Row 2: Stage · Team · Deadline · Dropbox". Read the
  markup and the caption, not just the render, before treating a prototype as truth.

What fixed it (#213): a ticket that links the design file, embeds a side-by-side screenshot of
prototype and build, and lists each delta as its own acceptance criterion. Luna's pass then has
something to compare against.

Three build-level lessons from the same ticket:

- **A copy change on a control is an accessible-name change.** The first cut kept the Deadline
  trigger's `aria-label` at "Deadline: Not set" while the visible text became "Set deadline", to
  avoid re-freezing the external-visibility inventory. Sol caught it: WCAG 2.5.3 (Label in Name)
  wants the name to contain the visible text, or a speech-control user saying "Set deadline" hits
  nothing. The name is now the visible text with the cell's key in front ("Deadline: Set
  deadline"), and the inventory was re-frozen on purpose — that is what the freeze is for.
- **Viewport breakpoints cannot see the rail.** The control row first wrapped on
  `@media (max-width: 1024px)`; at 1025–1279px with the rail open the four columns still ran and
  Team collapsed to 33px whenever a Deadline was set. The header is now its own container
  (`container: project-header / inline-size`) and the row wraps on the header's width, measured
  against the worst-case cell contents, not on the viewport. One trap: a container query reads the
  content box, so the 720px "stacks" state — where the header's padding also shrinks and its
  content (688px) is wider than a 1024px railed viewport's (693px) — stays a viewport rule placed
  after the container rules.
- **Do not ask `Intl` for a three-letter month.** Recent ICU data abbreviates September as
  "Sept" for en-AU and en-GB. A twelve-entry table is the whole fix.

**Rule:** a UI ticket links the design file and carries a "matches the prototype at 1280px"
criterion with a screenshot. Review axes that never look at the design cannot catch a design
deviation, however many of them run. The browser pass is therefore two stages
(`docs/subagents/Subagent-Orchestration.md` §2a): Luna measures, then an Opus design-reviewer
looks at the screenshots as a designer and audits her table.

Two more from the owner's follow-up on the same header (deadline popover as 1b, Team box narrowed,
crumb and hairline from 2a):

- **"Render only" is a claim the plan reviewers should test.** The 1b popover has no "Edit"
  step, so the editor had to be live from mount — and the old `open`/`closeEditing` pair also
  owned the project-detail query (`runtime.acquireOwner`) and released it after a save. Opus and
  Codex both read the plan's "rewrite the render only" and pointed at the lifecycle underneath:
  who closes the popover on success, who holds the owner for a read-only viewer, and — the one
  that failed a test — that `invalidateProjectSurfaces` defers the detail invalidation behind the
  very owner the editor holds, so it only ever flushed because the old `closeEditing` released
  it. The editor now holds the owner in an effect (writers only) and cycles it after a save.
- **A grid column that should hug its content is `auto` with `justify-content: start`, not
  `1fr`.** `1fr` stretches the Team cell to whatever the other three leave, and a chips box in
  it fills that width with white space. `minmax(0, auto)` sizes the track to its content, packs
  the row from the start, and still shrinks when the row is short of room; the chips box is then
  `w-fit` and the "Add…" input `flex-none`, since a flexing input is what claimed the rest of
  the line. The candidate list stops copying the anchor's width the moment the anchor becomes
  content-sized, or a one-member team gets a one-chip-wide list.

## The shell search (#217): a debounce and a popstate race, an envelope that must stay unfiltered, and an escape sequence that stopped being text
Tags: search-filters, routing · #217

Four defects from replacing the Dashboard's own search field with a single rail-owned store and
server-side `q`, each the kind this file exists for because none showed up in a type error.

- **A debounce timer and a popstate landing in the same tick is a race, and the debounce must lose
  every time.** `lib/dashboard-search-store.ts`'s `adoptDashboardSearchFromUrl` (Back/Forward, or
  a route the URL itself carries `q` on) cancels the pending debounce timer *before* adopting the
  URL's value — not after, and not by relying on the timer's own guard. A keystroke typed a moment
  before Back is pressed schedules a commit 300ms out; if that commit is allowed to fire after the
  popstate has already landed, it silently overwrites the destination the user actually navigated
  to with whatever they were mid-typing when they left. The fix is one call ordered first in the
  function, not a comparison — there is no correct value to compare against once both writers are
  racing for the same field.
- **Two adoption effects both touching the same field is itself a race, and effect declaration
  order decides who wins.** Dashboard.tsx's principal-reset effect
  (`resetDashboardSearchForPrincipal`) and its route-reconciliation effect (which adopts a route's
  `q` into the store) both run on first mount. React commits effects in hook-declaration order,
  not dependency order, so the reset effect has to be declared *before* the reconciliation effect
  — the store's `principalId` starts empty on a cold module, genuinely different from any real
  `currentUserId`, so an out-of-order reset would clobber the URL's adopted search a commit after
  it landed. Declaring the "generic" adoption call unconditionally at the top of the
  reconciliation effect had the same class of bug from a different angle: `currentDashboardRoute`
  (URL-derived) and `effectiveRouteCalendar` (which falls back to a `calendar` PROP that can
  outlive the URL that produced it, per this file's own docblock) can disagree about which branch
  governs, and adopting from the route on every pass — including while the Calendar-prop branch is
  the one actually deciding — fought that branch's own adoption of the identical field and looped
  (a "Maximum update depth exceeded" React error, caught by `Dashboard-calendar.dom.test.tsx`
  before the fix shipped). The rule that generalizes: when two effects write the same
  external-store field from different sources of truth, scope each write to the exact branch that
  owns it, never a shared prelude both branches fall through.
- **The Board's authorized-order envelope has to be built from the unfiltered row set, not the
  search-filtered one, or reorder math silently corrupts.** `/api/projects?q=...` runs two
  queries — the base project list (still every authorized row) and a separate `SELECT DISTINCT
  p.id` matching query — and only the SECOND filters. `board.orderedProjectIdsByStage` and
  `total` are built from the first. Read as "filter, then build the envelope" instead, `boardRank`
  becomes a rank-within-the-filtered-set, and a drag computed against it lands the dropped card at
  the wrong neighbor the moment fewer than all rows match. Reading the issue text alone this was
  invisible; only tracing where `boardRank` is consumed downstream (Kanban's own reorder gap math)
  surfaces it.
- **An edit tool that accepts backslash-`u`-style escape text in a parameter is not guaranteed to
  preserve it as source text.** Typing a fresh character-class regex literal covering the NUL byte
  through the DEL byte (the same control-character class the client-side search sanitizer already
  strips) into an `Edit` call rewrote it into three *raw control bytes* in the committed file —
  confirmed with `file(1)` (reported "data", not "ASCII/UTF-8 text") and `od -c` (literal control
  bytes where six-character escape text should have been) — silently, with no error from the tool
  and no complaint from `tsc` (it happily typechecks a NUL byte inside a regex literal). `grep` on
  the corrupted file returned "binary file matches" instead of line numbers, which was the first
  visible symptom. The fix was mechanical once found — rewrite the same character-class check as
  `codePointAt(0)` numeric comparisons against hex code-point constants, which has no
  backslash-escape sequences for anything downstream to misinterpret — but the rule going forward
  is to treat any freshly-typed backslash-`u` escape in an edit as suspect and verify the file
  round-trips as clean text (`file`, or `grep` returning line numbers instead of "binary file
  matches") before trusting it compiled correctly, since a passing `tsc` run is not evidence the
  bytes on disk are what was intended.

## A module-singleton store outlives whatever mounted it — scope its reset to the identity that owns it, not the component that happened to create it (#217 fix round 3)
Tags: search-filters · #217

Sol's whole-branch review, after the shell search (#217) had already shipped several rounds of
debounce/race fixes (the section above): `lib/dashboard-search-store.ts` is a module-level
singleton — deliberately, so the rail's `ShellSearch` (mounted on every staff route) and
`Dashboard.tsx` read the same `draft`/`query` without a React context or provider. Its principal
reset (`resetDashboardSearchForPrincipal`) lived only inside `Dashboard.tsx`, guarded correctly
against races on the SAME principal — but scoped to the wrong lifetime entirely: a module
singleton has no idea a principal changed unless something tells it, and the only thing that told
it was a component that is not even mounted for most of the app. Sign out, or switch who you are
impersonating, while parked on `/admin` or a project route (no Dashboard instance to run that
reset), and the NEXT principal's rail search box showed the PREVIOUS principal's draft/committed
text until a Dashboard happened to mount again — an actual cross-principal data leak in the UI, not
merely stale cache.

**The rule: a module singleton's reset belongs at the identity boundary the WHOLE APP already
tracks, not inside whichever screen first needed the reset.** `components/PrincipalFreshnessBoundary.tsx`
already wraps every staff route and is already keyed off `principalId` for its own cache-purge
concerns — that is the right home, not a second one. `Dashboard.tsx`'s own reset was kept
alongside it rather than deleted, and that is deliberate, not an oversight: on a COLD mount landing
directly on a Dashboard route, both mount in the same commit, and child effects run before the
parent's (React's bottom-up commit order) — Dashboard's own reset sets the store's `principalId`
first, so the boundary's later reset in the same commit finds it already current and is a
guaranteed no-op, rather than a race that could occasionally clobber the URL's own adopted search.
Removing the "local" reset once a "global" one exists can silently break the one ordering guarantee
the local one was providing.

A related trap in the same store: distinguish a writer being TORN DOWN AND RE-REGISTERED (identity
churn while the owning component is still mounted — a pending debounce must survive it, since
there is still somewhere for it to land) from the owning component actually UNMOUNTING (a pending
debounce must NOT survive it — there is no writer left to receive it, and letting the timer fire
anyway writes into whatever mounts next with no relation to who typed it). The fix was registering
a STABLE writer once per mount, through a ref updated every render rather than a dependency list
that changed on every view/facet switch — which turns "was this an unregister-then-reregister, or
a real unmount?" from something the store had to guess (and had guessed wrong twice already,
across two earlier rounds) into something structurally impossible to conflate: unmount becomes the
ONLY unregister the component ever triggers.

## An effect-only fix to a module singleton's identity scoping still has a gap: the render that shows the stale value happens before the effect that would clear it (#217 fix round 4, item 3)
Tags: search-filters · #217

Round 3's fix above (`PrincipalFreshnessBoundary` resetting `dashboard-search-store.ts` on every
principal change) closed the "no Dashboard mounted to run the reset" gap, but it is still a
PASSIVE effect — scheduled after commit, after paint in production. Three narrower gaps survived
it: (1) the NEW principal's very first render, before that effect has had any chance to run,
still shows the PREVIOUS principal's draft — a real, if brief, cross-principal flash, not merely a
timing curiosity; (2) a debounce timer armed by the old principal a few milliseconds before it
fires has a genuine (if narrow) chance to win a race against the effect that would have cancelled
it; (3) sign-out unmounts the boundary with no NEXT principal to reset FOR, so the mount-time
reset's own `id === principalId` guard — correct for suppressing a no-op on every ordinary
re-render — makes signing back in as the SAME person a no-op too, and their old search reappears.

The fix generalizes past this one store: a component that reads external, principal-scoped state
should compare the CURRENT, render-time-known principal against the state's own recorded owner
DURING RENDER (`getDashboardSearchSnapshotForPrincipal`), not lean on an effect to have already
reconciled them by the time the render happens — a render-time comparison cannot be "too late" the
way an effect can. `ShellSearch.tsx` itself gained a second, EARLIER write-side guard for the same
reason: a `useLayoutEffect` claiming ownership on its own `principalId` prop change, deliberately
duplicating `PrincipalFreshnessBoundary`'s passive-effect reset rather than replacing it — React
flushes every layout effect in a commit, tree-wide, before it flushes any passive effect in that
same commit, which is a scheduling GUARANTEE, not a timing coincidence, and is what actually closes
gap (2) rather than merely making it rarer. Gap (3) needed a third, different shape: not a
render-time read (nothing renders during sign-out) and not a faster effect (there is no next
principal to reset FOR), but an UNCONDITIONAL drop of the recorded owner on the boundary's own
unmount (`dropDashboardSearchOwnership`, deliberately a new function rather than removing the
existing guard on `resetDashboardSearchForPrincipal` — that guard is load-bearing for
`Dashboard.tsx`'s own COLD-mount ordering the previous lesson entry describes, and an unconditional
reset there would have reintroduced exactly the clobber-the-URL's-adopted-search race that entry
already fixed once).

A testing note worth keeping: proving "before any effect has run" in a DOM test cannot rely on a
raw, un-`act`-wrapped `render()` call — React 18+ concurrent roots do not commit synchronously
outside `act`, so reading the DOM right after one reads the PREVIOUS commit, not the new one, and
can pass or fail for the wrong reason regardless of what the component under test does.
`useLayoutEffect` in a sibling "Probe" component is the reliable technique: React guarantees every
layout effect in a commit runs before any passive effect in that same commit, so capturing inside
one genuinely observes the render-committed DOM before ANY passive effect (including the one under
test) has had a chance to run — inside one ordinary `act(() => {...})` call, no unwrapped `render()`
needed.

## `<StrictMode>`'s mount-cleanup-mount replay can cancel state that predates the component it replays (#217 fix round 4, item 4)
Tags: search-filters · #217

`Dashboard.tsx`'s writer-registration effect (previous section) registers once per mount and
cancels the shared store's pending debounce on its own cleanup — correct for a genuine unmount.
`main.tsx` mounts the whole app under `<StrictMode>`, which double-invokes an INITIAL mount's
effects (mount, cleanup, mount again) synchronously, in the same commit, specifically to surface
effects that are not safely re-runnable. That synthetic cleanup ran the same unconditional
cancellation a real unmount does, which cancelled a debounce armed OFF-Dashboard (the rail's
`ShellSearch`, mounted everywhere, typed on `/admin`) an instant before Dashboard's own first
mount — even though, once the double-invoke dance settled, Dashboard was still mounted with a
perfectly good writer to receive that debounce's eventual commit. The fix is a generation counter
bumped at the top of the effect body, read by its own cleanup through `queueMicrotask`: StrictMode's
replay is entirely synchronous (mount → cleanup → mount, no microtask boundary between them), so by
the time the deferred cancellation check runs, a same-tick re-registration has already bumped the
counter and the check backs off; a REAL unmount has no such follow-up invocation, so the counter is
unchanged when the microtask fires and it cancels exactly as before. The general shape: when a
cleanup's action is only safe for ONE of the two events that can trigger it (a real unmount, not a
same-tick synthetic replay), defer the action past the point where a same-tick replay would have
already announced itself, rather than trying to tell the two events apart from inside the cleanup
itself (they look identical at that point).

**Correction (#217 build, step 6).** The generation-counter/`queueMicrotask` mechanism this entry
describes is deleted, not just described in the past tense: #217 build, step 5 removed the reason
it existed. Once a commit with no writer registered is simply dropped (there is no local committed
copy left for it to update either), the cleanup can unregister unconditionally with no deferred
check — a StrictMode replay re-registers a writer before the timer can fire (still commits); a
real unmount never re-registers one (never commits). The general shape the entry closes with —
defer a cleanup action that is only safe for one of two same-looking triggers — is still a real
technique worth knowing; it is just no longer what this particular file does, because the
asymmetry it was working around (a fire with no writer used to silently update local state) no
longer exists.

## A mocked-fetch DOM suite hid a client/route id mismatch in both directions (#226)
Tags: testing-guards · #226

The Calendar's checklist event/unscheduled-entry `id` is a `checklist:`-prefixed ENTITY id —
FullCalendar/DOM ids, focus descriptors, `data-event-id`/`data-unscheduled-id`, optimistic
overlays, and the unscheduled-panel drag dataset all depend on that prefix staying on the wire.
`PATCH /api/projects/:projectId/subtasks/:subtaskId` needs the bare uuid. Two bugs lived either
side of that boundary at once, and neither showed up in the DOM suite:

- The client sent the prefixed entity id straight into the PATCH URL (`ProductionCalendar.tsx`'s
  `runChecklistMutation`) → the route's `idParam.uuid()` guard rejected it with 400 on every drag,
  resize, unscheduled drop, schedule-editor save, and phone reschedule.
- The PATCH response carries the BARE subtask uuid (the route's real contract), but
  `adoptChecklistResult` compared it against — and wrote it back as — the prefixed entity id: the
  dedup filter removed nothing and the client kept a duplicate, un-prefixed row until the next
  authoritative refetch quietly overwrote it.

Both were invisible to `ProductionCalendar-checklist.dom.test.tsx` because its mocked-fetch PATCH
stub (a) discarded the request URL entirely, so a wrong URL was unobservable, and (b) returned the
prefixed entity id as the response `id`, which is not what the worker actually sends — the fixture
was answering the question "does the reducer round-trip an id" rather than "does the reducer
handle the id shape the server really returns."

**Rule:** a mocked-fetch DOM suite that stands in for a cross-layer contract (client shape ↔ route
shape) has to assert on the request URL/method it captures, not just the request body, and its
response fixtures have to mirror what the real endpoint actually returns — not what is convenient
to round-trip. Pin the contract itself with one worker integration test that takes a real response
id from one route and feeds it into the route that consumes it (here: GET the Calendar range,
PATCH the subtasks route with the id verbatim, expect 400 for the raw id and 200 for the unwrapped
one) — a unit test on either side alone can drift with the other without failing.

## A copy of URL state in a store is a seam that finds a new bug every review round — delete the copy, not the bug (#217 build)
Tags: routing, search-filters · #217

The shell search's committed query lived in two places at once: the URL (`q` on bare/List/Kanban/
calendar-intent, and the calendar facet's own `q`) and a `query` field the shared store also kept,
"adopted" from the URL by a passive effect. Seven review rounds each found a DIFFERENT bug living
in the seam between the two — a Back/Forward race, two adoption effects fighting over declaration
order, a stale adoption marker that ignored the principal, a render reading a ref mutated in an
effect, and, the release blocker that finally forced the redesign: a role without Calendar
capability returned from the reconciliation effect before ever adopting a bare/List/Kanban route's
own `q`, so the filter, chip and Kanban movement gate fell back to an empty store after the first
commit while the URL still said `q=smith`. Every fix landed in the seam itself — tightening an
adoption effect's guard, reordering two effects, scoping a marker to a principal — and every fix
left the seam standing, so the next round found the next bug in it.

The actual fix was structural, not another patch to the seam: stop keeping a second copy at all.
`Dashboard.tsx` now derives the committed query at RENDER, straight from the currently governing
parsed route (`committedQuery = dashboardSearchOf(route) ?? ""`), for every role and every view —
there is no adoption effect left to lag behind, and no store copy left to disagree with the URL for
even one render. The store keeps only what genuinely is not in the URL: the DRAFT (what is showing
in the input, including an uncommitted trailing space or mid-debounce keystroke), the debounce
timer, IME composing state, and the owning principal. Committing is a URL write through a writer
the currently-mounted Dashboard registers; with no writer registered (off-Dashboard, or after this
component's own unmount) a debounce firing is simply dropped — there is nothing local left for it
to fall back to, which is itself new behaviour now that there is no copy to fall into.

What replaced the seam is ONE stateless sync rule, not a smarter adoption effect:
`syncDashboardSearchDraftFromLocation(routeQuery, viewerId)`, called exactly once, in `ShellRoute`'s
own `useLayoutEffect` keyed on location + principal. For a non-Dashboard route it returns
immediately — the route's lack of a `q` is not authoritative off-Dashboard, since an Enter on the
rail must still navigate with whatever was typed. Otherwise: claim ownership, cancel the pending
timer UNCONDITIONALLY (the Back/Forward race fix, generalised — a location change must never let an
in-flight debounce fire after the fact and overwrite what the URL now says), then compare the draft
NORMALISED against the route's own `q` before ever overwriting it. That comparison is what keeps
the store's own debounced write from fighting the very typing that produced it: the write emits
exactly `normalize(draft)`, so the resulting location compares equal once it lands back here, and a
raw draft (trailing space, mid-collapse whitespace) is left alone. Only a location carrying a
GENUINELY different committed search — a rail click to a different `q`, Back/Forward, a pasted deep
link — ever overwrites the draft. One function, one call site, one comparison rule; nowhere left
for a seventh bug to hide, because there is no longer a second field for two sources of truth to
disagree about.

**Rule.** When a value already has one authoritative source (here, the URL), a component-local
"cache" of it that gets "kept in sync" by an effect is not a performance optimisation — it is a
second source of truth, and every review round will find the next place the two can disagree. If a
value is cheap to derive from its authoritative source at render (a route parse, here), derive it
at render and delete the copy entirely, rather than making the sync effect that maintains the copy
progressively smarter. The one exception worth keeping a local copy for is genuinely
NOT-yet-authoritative state — the DRAFT here, which is real user input the authoritative source
does not have yet — and even that copy needs exactly one function that reconciles it against the
authoritative source on every change, not one adoption path per call site.

## A cache key that omits one of the query's inputs patches an entry nobody is looking at (#230)
Tags: search-filters · #230

`Dashboard.tsx`'s `dashboardKey` (~:291, feeding `updateProjects`'s `setQueryData` writes) was built
from `currentUserId`/`role`/`authorizationEpoch`/`viewingArchived` only — no `q` — while the
`useDashboardProjects` query it was meant to coordinate with (~:289) is keyed WITH the committed
search (`committedQuery`, the fifth argument `dashboardProjectsKey` has carried since #217). At
`/?q=smith`, `setProjectPriority`'s optimistic write, its confirmed write, and its failure rollback
all landed in the q-LESS cache entry — a CACHE MISS: the write patched an entry nothing was reading,
not merely an entry the rendered control happened not to reflect (the accepted-snapshot barrier is a
separate, later reason the rendered control wouldn't have shown it either regardless, #232). The
searched entry the Staff member was actually looking at kept whatever it already held until
`queueDashboardRefresh()`'s own refetch of the ACTIVE (searched) key — deliberate, not a
coincidental unrelated refetch — pulled the real confirmed value back in from the server on its next
successful fetch; a failed save, meanwhile, rolled back an entry nobody was reading at all. The fix
is one line: pass `committedQuery` as `dashboardKey`'s own fifth argument, so it is the SAME key the
read side already uses — not a second, parallel "scope identity" computed differently for reads and
writes.

**The rule for sibling entries a mutation's write has to reach, once the exact key is fixed.** A
resource can have more than one cache entry alive at once for genuinely different reasons (here: the
current search's entry, plus a q-less entry left over from before the Staff member searched) — a
mutation against ONE entry has to decide, explicitly, what happens to the others:
- **The OPTIMISTIC write and its ROLLBACK stay EXACT-KEY.** An unconfirmed value must never land in
  an entry nobody is currently looking at — if the write reaches a scope that isn't rendering right
  now, whoever DOES look at that scope later sees a value the server never actually returned.
- **The CONFIRMED response, once the server has actually agreed to it, fans out to every EXISTING
  sibling entry** (here, `queryClient.setQueriesData` on the `["dashboard-projects", currentUserId]`
  prefix — precedent: `removeProjectFromDashboardQueries`, `lib/dashboard-projects.ts` ~:128-136).
  Without this, a value confirmed while searched only updates the searched entry; clearing the
  search a moment later shows the STALE q-less entry until its own refetch happens to land, because
  `queueDashboardRefresh()` only refetches the currently-ACTIVE observer's key and
  `invalidateProjectSurfaces(..., producer: "dashboard")` deliberately skips the in-tab Dashboard
  scan — neither of those touches an inactive sibling entry on its own.
- **The fan-out must never CREATE an entry that didn't already exist.** `setQueriesData` only
  updates queries already present in the cache by construction (it iterates `findAll`'s matches, not
  every key that could theoretically match) — a Staff member who deep-links straight into a search
  and never had an unfiltered load must not get a phantom q-less entry manufactured for them.
- **The fan-out itself still needs freshness protection, once it exists at all** (Sol review round
  1): cancel every sibling's own in-flight fetch FIRST, or its late result can resolve after the
  fan-out and put the stale value back; never patch an item whose cached `boardRevision` is already
  newer than the confirmed response's, or a slow write can regress a sibling a later change already
  moved past; then mark the patched siblings stale WITHOUT refetching them now (`refetchType:
  "none"`) so a same-revision race self-heals the next time that entry is actually observed again,
  rather than firing a request for a scope nobody is looking at right now.
- **Placeholder data must never be stamped as accepted under a new key.** `keepPreviousData`
  (`placeholderData`) serves the PREVIOUS query's rows while a new committed-query's fetch is still
  in flight — accepting that placeholder as though it were the NEW key's own confirmed result means
  a subsequent failure on that fetch gets silently absorbed, and the wrong query's rows stay on
  screen presented as correct. Gate acceptance on `isPlaceholderData`; let the existing key-mismatch
  fallback keep rendering the placeholder in the meantime, so refusing to accept it costs no
  loading/empty flash.

**A cache-write test must assert on the cache, not the rendered control.** `Dashboard.tsx` renders
the `acceptedProjects` SNAPSHOT, not the query cache, and the accept effect deliberately defers
while `interactionBlocked` is true (which includes `pendingOrdering.size > 0`). Until #232 that
meant the control could not show an optimistic priority at all; since #232 it shows the
`priorityOverlay`, which reads the same whichever cache entry the write landed in. Either way the
rendered `<select>` says nothing about the cache key, so "did the optimistic/confirmed/rollback
write land in the right place" is `queryClient.getQueryData` on the exact key.

## An optimistic value has to outlive its own request (#232)
Tags: search-filters · #232

The optimistic priority write went into the query cache, but the Dashboard renders the accepted
snapshot, whose accept effect defers for the whole POST, so the control showed the old value for
the full round trip. The fix is a render-time `priorityOverlay` over whichever base wins
(`boardOverlay`, accepted snapshot, or query data), so it also covers a Board move in flight.
Letting priority through the accept deferral would let a refetch reshuffle the Board mid-interaction,
which is the reason the deferral exists.

The trap is when the overlay entry goes away. Clearing it in `finally`, when the POST settles,
flashes the OLD value: the queued refresh is only fired after `pendingOrdering` clears, and the
snapshot catches up only when that refetch is accepted. A confirmed entry therefore stays until
`acceptDashboardProjects` accepts a fetch whose `dataUpdatedAt` is no older than the confirmation.
`boardRevision` cannot mark that point: the priority UPDATE never bumps `board_revision`. A failed
second edit restores the first edit's confirmed entry rather than the original value.
`dataUpdatedAt` is stamped on ARRIVAL, so a fetch started before the POST could in principle look
"newer" than the confirmation while carrying the old value; it is never accepted, because the accept
effect defers while blocked and the queued `refetch()` supersedes it. That test pins the behaviour;
if either of those ever changes, the prune needs a fetch-start signal instead. Pinned by the `(#232)`
block in `Dashboard-priority-coordinator.dom.test.tsx`; the revert-trap, re-edit restore and
third-party-wins tests each fail when their guard is removed.

## A captured key or a captured timestamp is only as fresh as the render that captured it (#230, Sol review round 2)
Tags: search-filters · #230

Three more bugs in this same fan-out/accept machinery, all one shape: something captured a value from
"the current key" at one point in time and kept trusting it after the world moved on.

- **The sibling fan-out's own predicate used the CLICK-time key, not the CONFIRMATION-time key.**
  Corrected (Sol review round 3, item 2 — the original write-up here mis-described this): the
  predicate (`isSiblingDashboardQuery`) is not what gates the confirmed-value fan-out at all — that
  write (`updateProjects`/`updateAllProjectScopes`) is unconditional. The predicate only decides which
  entries `cancelQueries`/`invalidateQueries` treat as "a sibling" of the entry the confirmed write
  just targeted directly. `setProjectPriority` computed that key once, at the top of the handler, from
  whatever search was committed when the Staff member clicked, then reused that same captured value
  when the POST resolved. If the committed search changed while the POST was still in flight, the
  predicate was comparing against a key nobody is looking at anymore: the entry ACTUALLY active at
  confirmation time no longer matched the stale captured key, so the predicate wrongly treated it AS a
  sibling — its in-flight fetch got cancelled and it got marked stale, even though it's the entry
  `queueDashboardRefresh` owns and was about to refresh itself. Meanwhile the OLD origin key, now
  genuinely inactive, still matched the stale captured key, so the predicate wrongly EXEMPTED it from
  the cancel+invalidate every other inactive sibling gets. Fix: read the key fresh at the point the
  confirmed response lands, not at the point the click happened — the two are the same render only if
  nothing changed in between, and the whole point of this bug class is that something did.
- **The queued-refresh effect's own `.then()` is a stale closure, exactly like the fan-out predicate
  above.** `queueDashboardRefresh()` (fired after a confirmed mutation settles while `interactionBlocked`
  was true) issues its OWN `projectsQuery.refetch()` from inside a `useEffect` closure bound to whatever
  key was active when that effect ran. `QueryObserver#fetch()`'s promise resolves with
  `this.#currentResult` READ AT SETTLE TIME, not at issue time — if the committed query changed again
  while that refetch was in flight, the promise resolves with the OBSERVER'S NEWER result (a different
  key's rows, possibly still placeholder), and the stale `.then()` was accepting it unconditionally,
  stamping it under the STALE key it was issued for. Same fix shape as the primary accept effect's own
  key-mismatch guard (round 1, `## Placeholder data must never be stamped as accepted under a new key`
  above): re-read the CURRENT key via a ref at settle time, compare it against the key the refetch was
  issued for, and refuse (along with `result.isPlaceholderData`) rather than accept.
- **`acceptedQueryUpdatedAtRef`'s dedupe compared `dataUpdatedAt` ALONE, with no key attached.** The
  accept effect's own re-entrancy guard was "skip if this exact timestamp was already accepted" — but
  the ref held a bare number, not a `{key, updatedAt}` pair. Two DIFFERENT committed searches' results
  can legitimately carry the same `dataUpdatedAt` (react-query stamps it with `Date.now()`, 1ms
  resolution; two fetches issued close together, or literally in the same test tick, collide easily) —
  when they do, the guard treats the SECOND key's first-ever acceptance as though it were a duplicate
  of the FIRST key's already-accepted result, and silently drops it forever (there is no future retry
  trigger once the query itself stops fetching). The dropped key then relies entirely on the
  key-mismatch fallback to `queryProjects` to look correct — which works right up until that key's own
  cache entry is evicted or a later fetch for it fails, at which point the Dashboard shows the "Projects
  are unavailable" error instead of the accepted-snapshot resilience the round-1 fix was for. Fix: key
  the dedupe ref on `{key: dashboardKeyString, updatedAt: dataUpdatedAt}` and require BOTH to match
  before skipping.

**Two testing techniques worth keeping, both surfaced the hard way while proving these three failing
first:**
- **React's controlled `<select>` never assigns `.value`.** It sets `.selected` on each `<option>` to
  match the desired value (`ReactDOMSelect`'s update path), on both mount and update. A DOM test that
  patches `HTMLSelectElement.prototype.value`'s setter to catch a transient wrong render will silently
  record nothing and look like the bug never fires. Patch `HTMLOptionElement.prototype.selected`
  instead if you need to catch a value that gets corrected within the same commit.
- **A wrongly-stamped `acceptedProjects` snapshot is not durably observable through rendered content by
  itself**, because the key-mismatch fallback (`acceptedProjects?.key === dashboardKeyString ?
  accepted : queryProjects`) shows the CORRECT cache content anyway whenever the stamped key doesn't
  match the currently-viewed key — and the primary accept effect self-heals a wrong stamp the moment
  its OWN key's data next changes with a genuinely different timestamp, which happens well within a
  single `act()` flush. Proving the queued-refresh key-mismatch bug (item above) required both (a)
  draining only MICROTASKS between two competing async resolutions — react-query's own cache write
  (`Query.setData`) is visible to `queryClient.getQueryData` after a handful of microtask hops, but the
  React re-render that would let the primary effect self-heal only happens after react-query's
  subscriber-notify scheduler runs, which defers to a real `setTimeout(0)` macrotask — so resolving two
  competing fetches with only microtask ticks in between lets you land the buggy accept BEFORE the
  correct one has a chance to claim the dedupe slot, and (b) a scenario where the corruption's
  consequence PERSISTS (the dedupe-poisoning chain above) rather than one where the very next normal
  render quietly fixes it, since a persisted consequence is asserted with an ordinary settled-DOM check
  while a merely-transient one is not.

**Correction (Sol review round 3, item 1): the "self-heal needs a real macrotask" claim just above is
wrong, and it is what let test (l) below stop discriminating.** `useQuery`'s `useSyncExternalStore`
re-reads a FRESH cache snapshot on EVERY render, for ANY reason, not only when react-query's own
`setTimeout(0)` notify fires — so the very re-render a wrong accept's own `setAcceptedProjects` causes
already observes a sibling key's real, already-cached-but-un-notified data, and that sibling's OWN
primary accept effect self-heals `acceptedProjects` back to its own key as a passive effect off THAT
SAME render, no macrotask involved. Measured empirically (hop-by-hop instrumentation, one
`await Promise.resolve()` logged per hop): a corrupted accept lands within ~4 microtask hops of the
resolution that causes it; the correctly-keyed sibling's self-heal follows within ~9-10 — both inside
ONE continuous flush. `act()` fully drains all pending work, including every subsequent effect, before
its own call resolves, so there is no external "pause partway through" available from a SEPARATE,
later `act()`/microtask-draining call, no matter how few hops it drains — by the time any later call is
reached, both the corruption and its self-heal have already happened. Test (l) originally returned to
search A in a separate `act()` call after resolving the stale refetch, on the theory that staying
"microtask-only" (no `flush()`) would keep it ahead of the self-heal; empirically it did not, and the
test passed even with its own guard deleted. The fix: return to A from INSIDE the SAME, still-open
`act()` call that resolves the stale refetch — and assert the transient probe both DID see the
corrupted value and DID see the eventual correct one, not just that it never saw the corrupted value,
so a future change to how React writes controlled `<select>` selections can't make the assertion pass
vacuously by observing nothing at all.

A single fixed hop count is itself a second, narrower version of the same brittleness this correction
exists to fix: a React or react-query upgrade that shifts exactly where the corrupted-accept/self-heal
window falls would make a hard-coded hop count pass vacuously (landing outside the window on both
sides) without the guard doing any work. Test (l) does not pick one — it sweeps EVERY hop count from 0
to 16 inclusive (`it.each`, fresh render/`QueryClient` per iteration), a range chosen to generously
bracket the measured window on both sides regardless of where a future build moves it. With the guard
in place, every swept hop count passes. Disabling the guard (`Dashboard.tsx`'s
`if (dashboardKeyStringRef.current !== refreshKey || result.isPlaceholderData) return;`) and
re-running makes hop counts 5 through 16 fail — 5-9/11/13-15 because the probe never observed the
sibling's self-heal back to "2" inside that return-to-A window (only the corrupted "3"), and 10/16
because it observed both "3" and "2", i.e. the corrupted value was genuinely selected before the
self-heal corrected it — both failures are the guard doing its job, for the right reason, not test
noise. Hop counts 0-4 land before the corrupted accept happens at all, so they pass with or without
the guard; that's expected and does not weaken the sweep, since the failing majority of the range is
what proves the guard matters.

## A key-equality guard is ABA-blind; read provenance from the cache entry, not the observer's result (#230, item 1)
Tags: search-filters · #230

The round-2 fix above (`if (dashboardKeyStringRef.current !== refreshKey || result.isPlaceholderData)
return;`) still had a gap: it re-checks the key AFTER the refetch settles, but only ever inspects
`result` — `QueryObserver#fetch()`'s own resolved value, read from `this.#currentResult` at settle time.
If the committed search goes A → B → A while a refetch issued for A is still in flight, by the time it
settles `dashboardKeyStringRef.current` can be back to A (the key check passes) while `result` still
carries B's rows and `result.isPlaceholderData` is `false` (B's data is real, not a placeholder) —
because the observer's own current result was computed while its `#currentQuery` was still B. A
key-equality check alone cannot see this: it compares "the key I issued this for" against "the key
that's active now," but never checks whether the PAYLOAD in hand actually belongs to either one. Fix:
once you have the key you issued a fetch for, don't trust anything the fetch's own promise resolves
with — read that key's own cache entry directly (`queryClient.getQueryState(key)`) and act on ITS
`status`/`data`/`dataUpdatedAt`. The cache entry is written by the underlying `Query#fetch()` inline, off
the same settling promise, so it is always current for that key specifically, unaffected by whatever
key the observer has since moved on to.

**A flaky pass/fail correlated with same-millisecond timestamps means a dedupe is masking a bug, not
that the bug is intermittent.** The hop sweep proving this (test (l)) went from "fails reliably at
hop=4" to "passes even at hop=4" across otherwise-identical runs, with no code change — traced to
`acceptedQueryUpdatedAtRef`'s own `(key, updatedAt)` dedupe (round 2, item 3, above): a fast synchronous
test can complete multiple `Date.now()`-stamped fetches within the same real millisecond, and when it
does, the dedupe treats the corrupted accept this test exists to catch as "already accepted" and
silently no-ops it — the test then passes because the write never visibly happened, not because the
guard held. The fix is not a looser assertion or a retry; it's removing the ambiguity the dedupe was
exploiting: pin `Date.now()` with a monotonically-incrementing spy (a plain `mockReturnValue` collides
by construction; a spy that increments on every call cannot) so every `dataUpdatedAt` the scenario
produces is provably distinct, then re-run to confirm the failure is deterministic before fixing it.

**Not every theoretically-corrupted branch is independently observable, and forcing a test through one
that isn't produces a permanently-vacuous green, which is worse than no test.** The mirror-image bug —
an observer's stale `result.isError` (reflecting a DIFFERENT key's real failure) wrongly read as the
issuing key's own outcome — is real and the fix above closes it for both directions (success wrongly
trusted, error wrongly trusted) via the same provenance read. But constructing a DOM test that catches
the error direction specifically, across two different producers of this same queued refresh (a Priority
save, and a Board move settling), found that Dashboard's OWN primary accept effect (`## Placeholder
data must never be stamped as accepted under a new key`, round 1) already self-heals both of this
bug's candidate observables — `acceptedProjects` and, less obviously, `movementSettlePending`/
`recoveryReason` too, since that same effect unconditionally releases the settle barrier whenever it
successfully accepts ANY fresh data for the currently-active key — the instant the Staff member returns
to the original key with anything already cached, independent of whether the specific stale refetch
under test has resolved yet at all. Swept 0-16 (matching test (l)'s bracket) and then 0-59 for the
Board-move producer specifically; every hop count passed even with the whole guard+provenance block
disabled, because `movementSettlePendingRef.current` reads `false` by the time the corrupted `.then()`
even runs — the self-heal wins the race unconditionally in this construction, not just usually. Confirm
a branch is actually reachable at the DOM layer (instrument and read the values the code branches on,
the way test (m)'s `Date.now` collision was confirmed above) before spending a sweep's worth of effort
trying to catch it there.

## Tailwind v4 preflight makes a bare `border`/`border-b` paint near-black — fixed at the cause in PR B, after two rounds of fixing it at the call site (#219, 2026-09-20)
Tags: css-tokens · #219

`gantt-nav.tsx`'s toolbar and `gantt-view.tsx`'s tree/timeline splitter both shipped a bare
`border-b`/`border` with no colour utility beside it, and both painted near-black instead of the
app's hairline grey. The cause is Tailwind v4's own preflight: it resets every element to
`border: 0 solid currentColor`, so a class that only sets `border-width` (`border`, `border-b`,
`border-t`, …) paints whatever `color` the element already has, not a border token — and most
Quincy text sits on `--ink-900`-adjacent colours, so the reset border is nearly black on nearly
every surface. Contrast with the sibling shadcn convention: some registries ship a global
`* { border-color: var(--border) }` compat rule specifically to neutralise this reset. **This repo
does not have one** — `styles/tokens/base.css` has no such rule — so every bare `border*` class
anywhere in the app is silently exposed to this hazard, not only inside the Gantt.

**PR B fixed the cause, and that is the actual lesson here.** PR A answered this twice at the call
site — two hand-applied `border-border` fixes plus `gantt-skin.guard.test.ts` Detector 6, a detector
scoped to nine files that only ever watched the vendored Gantt tree while the paragraph above
correctly described the hazard as repo-wide. PR B then vendored `@reui/event-calendar` and found
**zero occurrences of `border-border` across all 13 files and roughly 48 bare `border*` classes** —
every hairline in a month grid, a time grid, a resource grid and an agenda list. At that scale the
call-site fix stopped being a fix and became a tax: 48 more edits inside a vendored tree, 48 more
lines for a future re-vendor to replay, and still nothing protecting the rest of the app.

So `styles/tokens/base.css` now carries the one line that was missing all along:

```css
@layer base {
  *, *::before, *::after { border-color: var(--border); }
}
```

Three things about it are load-bearing:

- **It must be inside `@layer base`.** Unlayered — the way the `:focus-visible` rule directly above
  it in the same file deliberately is — it would beat `@layer utilities` and override every
  intentional border colour in the app. Layered, utilities still win, which is the entire point. It
  lands after preflight's own `layer(base)` import in source order, so within that one layer it
  beats `currentColor`.
- **`--border` is a role token, so the rule is surface-aware for free.** `inverse.css` re-scopes it
  for `[data-surface="inverse"]` (greige-500, which reads on ink) and restores it for a nested
  `[data-surface="default"]` panel. A bare border inside the Lightbox gets the ink hairline without
  anyone writing a variant.
- **It was verified in a real browser, not reasoned about.** Four probes: a bare `border-b` on paper
  paints `#cfc7b6` while the element's own `color` is near-black (so it no longer follows
  `currentColor`); `border-b border-primary` still paints `#0a0a0a` (so utilities still win);
  the same bare class inside `[data-surface="inverse"]` paints `#6d6657`; and inside a nested
  `[data-surface="default"]` it returns to `#cfc7b6`. A cascade argument that has not been measured
  is a guess — layer order is exactly the kind of claim that reads correct and renders wrong.

The calendar tree corroborates the same point independently: all 13 files, zero `border-border`
classes, roughly 48 bare hairlines, and every one of them the compat rule coloured correctly with
no per-site edit — the evidence that fixing the cause beat fixing 48 call sites.

**Detector 6 was deleted in the same commit, on purpose.** A guard whose premise has been removed
does not become a harmless extra check — left passing, it goes on asserting a hazard that no longer
exists, and teaches the next reader to keep paying a cost that has been retired. The general rule:
when you fix a defect class at its cause, delete the detector that pinned it at the call site, in
the same commit, and say so where the detector used to live. Reinstating it now would require
deleting the compat rule first.

## `outline-none` + `focus-visible:ring-*` still adds a second focus indicator — the fourth, fifth and sixth time (#219, 2026-09-20)
Tags: css-tokens, focus-overlays · #219

`styles/tokens/reui.css:160-166` already records this correction twice over (`reui/badge.tsx`
correction 2, `reui/button.tsx` divergence 5): `styles/tokens/base.css:25` declares an unlayered
`:focus-visible { outline }` that beats Tailwind's `@layer utilities`, so a vendored component's
own `outline-none focus-visible:ring-2 focus-visible:ring-ring/50` pair does not REPLACE the
global outline — it paints a SECOND indicator beside it that `tailwind-merge` cannot collapse away
(different property, not a conflicting utility class). #219 PR A hit it twice more, independently,
in two different vendored Gantt files — the bar's own focus state (`gantt-bar.tsx`, dr-219a HIGH
#2) and the tree/timeline splitter (`gantt-view.tsx`, dr-219a HIGH #2 and HIGH #3) — bringing the
running count to five. #219 PR B hit a sixth, in the vendored event-calendar's own chip:
`event-calendar/event-calendar-event.tsx` carried the identical
`outline-none focus-visible:ring-ring/50 focus-visible:ring-2` pair.

Four occurrences in two unrelated adoptions (the sidebar block, then the Gantt) is no longer a
coincidence worth re-discovering per file: any newly vendored ReUI/shadcn component that ships its
own `focus-visible:ring-*` should have that ring dropped on sight, the same way a bare `border` is
now checked on sight above — `tokens/base.css:25`'s global outline is the only focus indicator this
app wants, and the vendor's own ring is never additive, only redundant.

**Verifying the fix needs a REAL keyboard press.** A programmatic `element.focus()` does not match
`:focus-visible` (Chrome gates it on the last interaction having been keyboard), and dispatching
a synthetic `KeyboardEvent` does not flip that heuristic either because the event is untrusted.
Both read back `outline-style: none` on a correctly-fixed element. PR B initially misread that
as the app's outline being clipped by the chip's `overflow-hidden`. Measured with a real Tab
keypress the chip shows `outline: 2px solid rgb(10,10,10)` at `outline-offset: 2px` — and the
offset is why `overflow-hidden` cannot clip it: the outline paints outside the box.

## A guard widened to make a build pass is a guard that has already failed once (#219, 2026-09-20)
Tags: testing-guards · #219

`test-seam.guard.test.ts`'s Guard F (`DATA_SLOT_SELECTOR`) required quotes around an attribute
selector's value — `[data-slot="x"]` — and so was blind to the equally-valid unquoted CSS form,
`[data-slot=x]`. Three call sites in this branch used the unquoted form and were invisible to the
guard for the entire time they existed (item 1 of the #219 PR A standards review; see this file's
`## A grep gate that cannot fail is not a gate` entry above, and the widened matcher itself). The
`ps-`/`ms-` classifier hole in the same guard file is the identical shape one round earlier: a
prior fix widened `UTILITY_PREFIX`'s bare-prefix families to accept the logical-property spacing
classes (`ps-`/`pe-`/`ms-`/`me-`) so a build would pass, using a bare-prefix match with no suffix
validation — which accepted `ms-fraction` (a plausible Quincy BEM name) exactly as readily as
`ms-2`, and would have slipped straight past guard C. Caught a round later, not at the time the
widening landed.

Both are the same failure with a different regex: **a guard change made to unblock a build is not
validated by the build passing.** The build passing only proves the guard did not fire on the
CURRENT diff — it proves nothing about what the guard would now let through on a DIFFERENT diff
that happens to share the widened shape. The `ps-`/`ms-` fix's own grep check ("no real Quincy
class in this repo begins ps-/pe-/ms-/me- TODAY") was true and irrelevant: the classifier itself
must not depend on nothing having collided YET. Any widening of a guard's matcher needs its own
negative fixture — a case the widening should still catch — checked BEFORE the widening lands, the
same "prove a gate can fail before trusting it" rule `## A grep gate that cannot fail is not a
gate` names, applied to a guard's *matcher* as well as its presence.

## A guard's matcher must be validated against forms that actually exist (#219, 2026-09-20)
Tags: testing-guards · #219

PR A's skin-guard Detector 3 matched a hex literal inside a Tailwind arbitrary value only when
the `#` came immediately after `[` or after a type hint (`bg-[#0a0a0a]`, `bg-[color:#fff]`). The
calendar tree contains
`@max-[10rem]:[mask-image:linear-gradient(to_right,#000_calc(100%-0.75rem),transparent)]` — a
hex buried arbitrarily deep inside the value. The regex could not see it. The guard would have
reported green on a tree containing the exact thing it exists to forbid.

This is the same failure as the earlier "a guard widened to make a build pass" lesson, one step
earlier in its life: not a matcher loosened under pressure, but a matcher whose shape was never
checked against the shapes in the wild.

What PR B did: added the negative fixture FIRST, widened to match a hex anywhere inside `[...]`,
allowlisted the single real site with its reason (`#000` there is a mask ALPHA stop, not paint —
any fully opaque colour is equivalent), and back-ported the identical widening and fixture to
`gantt-skin.guard.test.ts` in the same commit so two sibling guards cannot silently diverge.

The generalisation: when you port a detector to a second tree, run it against that tree and
confirm it can still FAIL there. A detector that has only ever been green is untested.

## A detector scoped to the wrong element is vacuous (#219, 2026-09-20)
Tags: testing-guards · #219

PR A's Detector 7 forbids `destructive` on the now-indicator by matching the element that
carries `data-slot="event-calendar-now-indicator"` and testing its opening tag. In the calendar
tree that slot is a bare wrapper and the three `destructive` classes sit on three CHILD divs.
Ported verbatim the detector returns green while the violation ships.

Rescoping it to the whole FILE would be wrong in the other direction — `destructive` is
legitimate elsewhere in that same file. PR B scoped it to the `EventCalendarNowIndicator`
function body, and landed a negative fixture proving a `destructive` in a NEIGHBOURING function
body does not fire, in the same commit.

The generalisation: a detector carries an implicit claim about where the thing it forbids can
appear. Re-check that claim in every tree you port it to, and pin both directions with fixtures.

## Wall-clock minutes and elapsed minutes are different units; mixing them breaks only on DST days (#219, 2026-09-20)
Tags: scheduling, gantt-calendar · #219

The vendored calendar computed a day's lower/upper render bounds as
`Math.min(dayEndHour * 60, getDayTotalMinutes(day, timeZone))`. `dayEndHour * 60` is WALL-CLOCK
minutes (hour 24 = end of day); `getDayTotalMinutes` returns ELAPSED minutes (1500 on a 25-hour
day, 1380 on a 23-hour day). `Math.min` of the two is meaningless. Everything the calendar
positions is in elapsed minutes from zoned midnight.

Consequence on Australia/Sydney's 25-hour autumn day: the bound clamps to 1440, an event at
wall-clock 23:15 has an elapsed offset of 1455, the visibility filter is `startMin < boundsEndMin`
— so the event is SILENTLY INVISIBLE, cannot be dropped there either, and the now-indicator
disappears for the last hour of that day. Browser-confirmed with a control: the same fixture
renders on a 24-hour day and on a 23-hour day, and vanishes only on the 25-hour one.

The fix is not a special case for hour 24. It is a helper that converts a wall-clock hour to
elapsed minutes for THAT day, used for both bounds: `elapsedMinutesAtWallClockHour`.

The generalisation: any time a `* 60` sits next to a timezone-aware duration, one of them is the
wrong unit. Name the unit in the identifier, and put a DST day in the fixtures — a 24-hour day
cannot distinguish the two.

Honest note: this fix trades a silent failure for a visible one. On transition days the shared
hour gutter now disagrees with the transition day's column by one hour-height, because the gutter
renders a fixed 24 labels while stretching to the tallest column. Losing an hour of data is worse
than losing alignment, so the trade is right, but it is a trade and the residual misalignment is
tracked separately as #241.

**Resolved (#241, 2026-09-21).** Owner decision: keep the gutter shared and PAINT every column on
its wall-clock axis (the Google/Apple Calendar model) — data, bounds and gestures stay in elapsed
minutes, and one object (`wallClockColumn`) converts at paint time and pointer time. The skipped
hour is an empty slot; the repeated hour's two passes share one slot, packed side by side, and a
pointer there means the first pass. Browser-measured at 64px/hour: gutter and all seven columns
1536px on both transition weeks, the 23:15 probe at 1488px on the 25-hour day.

Two things worth keeping from it. A shared axis can only be right if every column is drawn in the
AXIS's unit — the unit a thing is stored in and the unit it is drawn in are separate decisions.
And happy-dom (20.x) silently discards any `calc()` containing a `var()` assigned through
`el.style`, which is how React's client renderer writes styles: a live-rendered element shows no
such height or top at all. Assert that geometry on `renderToStaticMarkup` output, where the
`style` attribute is a string no CSS parser has touched.

## A typed config key can be silently dropped by a runtime allow-list (#219, 2026-09-21)
Tags: reui-vendor, gantt-calendar · #219

`@reui/event-calendar` resolves its view configuration through `VIEW_CONFIG_KEYS`, an explicit
array of key names, and copies only those keys into the context its views read. The TYPE
(`EventCalendarViewConfig`) and the runtime list are maintained separately and nothing ties them
together.

Adding `eventClassName` to the interface and consuming it in the chip therefore typechecked
cleanly at every call site — including the consumer passing the prop — and rendered nothing. The
browser showed the vendor's own default styling with no error, no warning, and no failing test.
`tsc` cannot see this: as far as the type system is concerned the prop was accepted.

What caught it was rendering the component and asserting on the result. What would NOT have caught
it: a unit test of the callback, a typecheck, a lint rule, or reading the diff.

The generalisation, which is not specific to this block: **when a library resolves configuration
through a hand-maintained list of key names, adding to its type is only half the change.** Look
for the list — `*_KEYS`, a `pick(...)`, a destructure with explicit names, a reducer over a
literal array — and add the key there too. Then pin it with a test that RENDERS, because every
cheaper check passes.

`event-calendar-done-dim.dom.test.tsx` is that test, and its failure message names
`VIEW_CONFIG_KEYS` directly so the next person does not have to rediscover the mechanism. Deleting
the key from the list turns three of its five cases red.

## A consumer `eventClassName` must override every state the vendor tints; tailwind-merge only drops same-variant utilities (2026-09-28)
Tags: gantt-calendar, reui-vendor

**Symptom.** A selected Deadline chip drew ink-900/30 under paper-050 text (2.03:1), and a hovered
Deadline row in the agenda went paper-050 on paper-100 (1.07:1). Both class strings looked right
on their own.

**Cause.** The vendored chip builds its class as `cn(vendor tint, eventClassName(...), row class)`.
tailwind-merge drops a vendor utility only when a later class supplies the SAME variant: the
Deadline branch set rest and `hover:` but no `data-selected:`, so the vendor's
`data-selected:bg-(--ec-event-color)/30` survived. In the agenda the row's own `hover:bg-muted`
comes AFTER the consumer class, so it dropped the Deadline's `hover:bg-(--ink-800)` instead.

**Rule.** A consumer branch that sets a fill owns every state the vendor tints — rest, `hover:`,
`data-selected:` (fill and ring). Where a later vendor class wins on source order, win on
specificity instead (`data-[view=agenda]:hover:` is 0,3,0 against 0,2,0) and note the coupling to
the vendor attribute. Read the MERGED class off the rendered chip; the consumer's string alone
cannot show the defect.

**Pinned by** `components/ProductionEventCalendar-chip-contrast.dom.test.tsx`. It reads the real
merged class of every Deadline, active and done checklist chip in all five Production views (month,
week, day, 3-day, agenda), and resolves it against the token files. It then asserts 4.5:1 for every
element inside the chip that renders text, in every reachable state (the agenda has no selected
state) over each paper ground. Its self-test fails the pre-fix classes. One named baseline records
a failure that is not the chip's own: the vendored agenda time column is `text-muted-foreground`
(the app-wide `--text-muted`), 2.86–3.57:1 on checklist rows, tracked as a follow-up. Deadline
chips may never be baselined. The pattern test in `lib/production-event-calendar-adapter.test.ts`
covers the class strings themselves.

## A consumer allow-list keyed only on path, over a restricted set with more than one member, grants ALL of them (#220, 2026-09-21)
Tags: permissions, gantt-calendar · #220

`harness-reachability.guard.test.ts`'s detector (ii) polices two vendored trees at once
(`components/reui/gantt/`, `components/reui/event-calendar/`) through one list,
`ALLOWED_VENDOR_SCHEDULING_CONSUMERS`: any file whose path started with an entry on the list was
exempt from detector (ii) entirely, for BOTH trees. That was fine while every entry on the list was
either the harness (legitimately allowed to import both, as the shared sandbox for exercising
every vendored primitive) or a vendored tree's own self-reference (a gantt file importing a
sibling gantt file has to be exempt from a detector that is, definitionally, about imports FROM
OUTSIDE the tree).

#220 gave the Gantt tree its first real, narrowly-scoped production consumer —
`components/ProductionGantt.tsx`, which needs `components/reui/gantt/` and has no legitimate
reason to import `components/reui/event-calendar/` at all. Adding its path to the existing
bare-path list would have compiled, typechecked, and passed the existing self-tests — none of them
happened to plant an import of the OTHER restricted tree from a real, narrowly-scoped consumer,
only from the harness (which is supposed to reach both) or from within a tree itself (same). The
gap was only found by writing the build spec's own required proof directly — plant `import
"@/components/reui/event-calendar/…"` inside the new consumer and confirm the guard still goes
red — rather than trusting that "the file is on the allow-list" was itself sufficient.

The fix: the allow-list became a map from consumer path to WHICH of the restricted set that
specific consumer may reach (`{ consumerPrefix, allowedVendorPrefixes }`), with the harness and
each tree's self-reference kept at "all", and the new narrow consumer scoped to exactly the one
prefix it needs.

The generalisation: **a permission list checked only by "is this actor on the list", against a
restricted SET with more than one member, is a promise that the actor may touch NOTHING in the
restricted set — never mind which member it was actually granted for.** The moment a real,
narrowly-scoped consumer joins a list whose older members were all broad ones (a sandbox, a
tree's own self-reference), re-derive what "allowed" should mean per entry, don't just append a
path. And when a build spec asks for a specific negative proof ("plant X, show it red, remove it"),
do exactly that by hand before trusting a refactored detector — a self-test with fixture data can
still share the SAME wrong assumption as the code it exercises if both were written by the same
reasoning at the same time.

## A render-override prop gated on its own PRESENCE, not its per-call return value, is global even when you only meant it for one case (#220, 2026-09-21)
Tags: gantt-calendar, reui-vendor · #220

`gantt-bar.tsx` computes `consumerOwnsContent = children !== undefined || !!viewConfig.renderEvent`
— true the moment `<Gantt renderEvent={...}>` is passed AT ALL, gating BOTH the automatic
milestone diamond and the default title text, for every bar the component renders, not only the
one call a consumer's override actually wanted to change. The build spec for this pass asked for
"a conditional `renderEvent` for the hollow-start marker only, leaving stock bars and diamonds
intact" — a reasonable-sounding ask that is not implementable against this particular gate: there
is no way to make the PROP present for one bar and absent for the next render of a sibling bar in
the same tree, because the prop lives on the shared `<Gantt>` element, not per-bar, and the gate
reads whether the prop exists at all, never what a given invocation of it chose to return.

The fix was not a workaround inside the callback (returning `undefined` to "opt out" for the
common case does not un-set `consumerOwnsContent`, which was already computed from the prop's mere
presence before any call happened). It was reproducing both stock looks — the title label, the
milestone diamond — inside the override itself, so every bar keeps its intended appearance and
only the one genuinely different case (a missing shoot date's hollow-start marker) adds anything
new. `ProductionGantt.tsx`'s own header flags this as a place the build spec's design was wrong
about the vendor's actual contract, rather than silently routing around it.

The generalisation: **before designing "a conditional override for just this one case," check
whether the override PROP is gated on its presence or on what a given call returns.** A
presence-gated override (common in headless/vendored component libraries, where "did the consumer
customize this at all" is cheaper to check than "did the consumer customize THIS instance")
is all-or-nothing per component instance, not per render call — reproduce the stock behaviour
inside the override for every case you are not actually changing, rather than assuming the
override can stay silent for the common path.

## A production guard checked once at the top proves nothing about the statement that runs last (#220 follow-on, 2026-09-21)
Tags: testing-guards, d1-migrations · #220

Building the local QA scheduling fixture (`portal/packages/db/qa-seed/`), the obvious design was a
single preflight check — "does this database look like local dev?" — before running a batch of
generated INSERT/DELETE statements. That is not enough: an executor that continues past a failed
statement, or a fixture statement copied out of the batch and run alone, never sees the preflight
at all. The fix that actually holds is a **capability fence**: a local-only table
(`__quincy_local_capability`, created only by `setup-local.mjs`, never a migration, never
`seed/0001_seed.sql`) that every generated mutator statement — insert and teardown delete alike —
references directly (`WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability =
…)`). A statement missing that table fails with `no such table`, whether it runs as part of the
batch, alone, or copied into an unrelated script. Verified directly: the exact generated SQL run
against a migrated-and-seeded scratch database that never ran `setup-local.mjs` fails on its first
statement with that error and leaves zero rows, not a subset.

Paired with that: the same fixture generates every checklist-schedule row through
`normalizeChecklistSchedule` and round-trips it through `serializeChecklistSchedule` — the exact
pure functions the real API calls — rather than hand-computing the resolved instant/offset/fold a
timed row stores. A single wrong offset in a hand-written fixture does not raise an error; it
silently serializes to `invalid` and the row disappears from every surface that reads it, which is
indistinguishable from the bug the fixture exists to help catch. Running the same validator the API
runs turns that into a build-time exception instead of a browser-pass mystery.

The generalisation: **a guard checked once, before the write, is a guard for the FIRST statement,
not for the batch.** If a mechanism generates many mutator statements, put the check in the
statement itself (a referenced marker row, an `EXISTS` predicate) rather than only in the caller
that assembles them — and if a mechanism generates rows a validator elsewhere in the codebase
already knows how to reject, run that exact validator at generation time rather than re-deriving
its rules by hand.

## `spawnSync`'s default `maxBuffer` fails silently as the child's own crash, not as a clear "buffer exceeded" (#220 follow-on, 2026-09-21)
Tags: testing-guards, agent-tooling · #220

The same fixture's transport (`cli.mjs`) spawns a `tsx`-run generator and captures its JSON output
via `child_process.spawnSync(..., { stdio: ["ignore", "pipe", "inherit"] })` with no explicit
`maxBuffer`. The default (1 MiB) is far smaller than the ~3+ MB of SQL statements the fixture's
opt-in density tier generates. Exceeding it does not surface as "maxBuffer exceeded" from the
parent — it kills the child mid-write, and the child's own next `process.stdout.write()` call
throws `Error: write EPIPE`, printed (via the inherited stderr) as if the *generator* had crashed.
Nothing about that message points at the parent's `spawnSync` options at all; tracking it down
meant reproducing the same generator invocation without going through the parent to see it succeed
cleanly at 3.2 MB, which only made sense once `maxBuffer` was considered.

The generalisation: **when a subprocess you spawn to capture output can plausibly produce more than
a few hundred KB, set `maxBuffer` explicitly and generously — do not wait to discover the default
via an `EPIPE` that looks like the child's own bug.** The failure mode is maximally confusing
specifically because the error surfaces from the wrong process.

## Local D1 caps a compound SELECT at 5 terms, and `wrangler --json` puts the error on stdout (#220 follow-on, 2026-09-26)
Tags: d1-migrations · #220

The QA fixture's graph-driven teardown built its post-delete checks as one `UNION ALL` of per-table
`COUNT(*)`s, 40 terms per statement. Every `node:sqlite` test passed. The first real run against a
scratch `--persist-to` local D1 deleted the fixture and then failed on that check: local D1 runs
SQLite with `SQLITE_LIMIT_COMPOUND_SELECT` lowered to **5** (measured: a 5-term `UNION ALL` runs, a
6-term one fails `too many terms in compound SELECT: SQLITE_ERROR`), where stock SQLite allows 500.

It took longer to find than it should have. With `--json`, wrangler reports a D1 error as
`{"error":{"text":...}}` on **stdout**, not stderr. `qa-seed/cli.mjs` captured stdout, saw the
non-zero exit and threw "exited with 1", so the SQLite error never reached the terminal.
`runWrangler` now includes it ("D1 reported: ...").

The fix was a multi-row `VALUES` of scalar subqueries
(`SELECT column1 AS label, column2 AS n FROM (VALUES ('t', (SELECT COUNT(*) ...)), ...)`), which is
not subject to the compound limit (local D1 accepted 120 rows). The qa-seed test executor now opens
its database with `limits: { compoundSelect: 5 }` (`LOCAL_D1_LIMITS` in
`test/qa-seed-sqlite-executor.ts`) and probes that a 6-term compound fails, so this class of failure
shows up in `npm test`, not only in a real run. The constructor option needs Node >= 24.12 (the
`db.limits` setter first used here needs 25.8 and broke CI on Node 22), which is why CI runs Node 24;
older Node ignores the option silently, hence the probe rather than trust.

The generalisation: **a `node:sqlite` (or any stock-SQLite) test executor is not local D1.** Mirror
every D1 limit you have measured into the test database, and run a new statement shape once through
real `wrangler d1 execute --local --persist-to <scratch>` before trusting it.


## A test that hard-codes dates must pin `Date` to them — and "which tests do?" is measured, not read (2026-09-26)
Tags: testing-guards, scheduling

`event-calendar-done-dim.dom.test.tsx` fixed `ANCHOR = 2026-09-21T02:00Z` and a done chip on
2026-09-23 that it asserts is "future". The vendored ReUI calendar derives `data-past` from the real
clock, not from the `date` it is given, so from 2026-09-23 the chip was past and `main` went red
(`expected 'true' to be null`). The same is true of anything whose code reads the clock — vendored
calendar/gantt, date-fns `isPast`/`isToday`, a schema `$defaultFn(() => new Date())`. A date
literal in a fixture is a countdown (see TB8-04 above).

**Fix:** pin `Date` to the date the test already assumes, in a top-level `beforeEach`:
`vi.useFakeTimers({ toFake: ["Date"], now: ANCHOR })`, and `vi.useRealTimers()` in `afterEach`
(or `vi.setSystemTime(ANCHOR)` if the file already fakes timers). Fake only `Date` — faking every
timer stalls React's scheduler and Testing Library's `waitFor`/`findBy`. Never loosen the
assertion instead. If pinning makes a *different* test fail, it was passing on two clocks at once.
`editor-folder-move.test.ts` handed the code `deps().now = FIXED_NOW` while the schema default
stamped jobs with the real clock, so four move-twice tests passed only because the first move's
queued `editor_sync` job looked hours stale. Production reads one clock; the fix was to model what
production sees (mark that job `done` before the second move), not to pick a pin that keeps the
accident green.

**Detection — the shift matrix.** Reading 34 date-literal files does not tell you which ones read
the clock; running them with the clock moved does. Add an uncommitted setup file and a config that
`mergeConfig`s the package's own config with `setupFiles: [it]` and
`define: { __CLOCK_SHIFT_TO__: JSON.stringify(process.env.CLOCK_SHIFT_TO ?? "") }` (`define`, not
`process.env`, so it reaches workerd too). Name the config so it does NOT match
`vitest(.*).config.ts`, or `ci-vitest-configs.guard` will demand it run in CI:

```ts
import { beforeEach, vi } from "vitest";
import "@date-fns/tz"; // load Date subclasses BEFORE faking, or TZDate silently goes local-time
declare const __CLOCK_SHIFT_TO__: string;
const to = __CLOCK_SHIFT_TO__;
const pin = () => vi.useFakeTimers({ toFake: ["Date"], now: new Date(to), shouldAdvanceTime: true, advanceTimeDelta: 1 });
if (to) {
  pin();
  beforeEach(() => { if (!vi.isFakeTimers()) pin(); }); // survive a file's own useRealTimers()
}
```

Run every config (web unit + DOM, shared, db, the three workers) unshifted, then at a date before
the fixtures (`2026-09-20`), three months on, a year on, **and a control at the real current
time**. A test that fails under a date shift but passes the control reads the real clock. Lessons
from the first run:

- **Use `shouldAdvanceTime` for detection.** A frozen `Date` produced 11 false positives (9 web DOM
  Dashboard/ProductionCalendar tests, 1 each in workers/app and workers/background — code expecting
  time to pass between two reads): they failed in the frozen *control* too and passed with an
  advancing clock. Frozen is right for the fix, wrong for the detector; a test whose code needs time
  to pass may need `shouldAdvanceTime` in its fix too.
- **Faking before `@date-fns/tz` loads** makes fake-timers' Date constructor return a plain Date,
  so `TZDate` loses its prototype: 18 more web DOM false failures that looked like DST bugs.
- **Tests that compare SQLite's clock with JS's** (`default-editors-backfill`) fail under any shift
  by design — shifting only JS cannot pass them. Leave them unpinned.

## A test that asserts a server count must count the way the server does (2026-09-27)
Tags: testing-guards

The QA fixture's draw-cap tier (`packages/db/qa-seed/`) exists to push the Gantt past
`PRODUCTION_GANTT_DRAW_CAP`. Its coverage test asserted `2130 > 2000` and passed — while the real
server count in the default view was **1,704**, under the cap. The test's helper counted every
fixture project; the server's authorized-projects CTE (`workers/app/src/lib/production-scope-sql.ts:89`)
drops `stage_key = 'delivered'` unless the delivered filter is on, and 6 of the tier's 30 projects
were delivered. The fixture would have shipped unable to show the draw cap at all.

- **Mirror the query, and name the lines you mirror** in the helper's comment, so a later change to
  the server's filters has a visible twin to update.
- **Prove it once against the real query.** The fix was only trusted after running the server's own
  `productionGanttProjectsSql("admin")` against a scratch local D1 with default binds, which
  returned `matched_rows: 2208`. A reimplementation checked against itself proves nothing.
- **Leave margin over a threshold.** The tier now clears the cap by more than 10%, so ticking a
  few children done during a browser pass cannot quietly drop it back under.

## A test harness that rebuilds the setup by hand hides the step the real setup forgot (#252, 2026-09-27)
Tags: testing-guards · #252

`db:migrate:local` (`packages/db/setup-local.mjs`) applied migrations, the Board flag and the QA
capability fence, but never `seed/0001_seed.sql`. A fresh local D1 had no pipeline stages and no
bootstrap admin, so nobody could sign in and `db:qa:apply` refused to run. Nothing went red, because
the qa-seed integration tests built their database with their own hand-written copy of the sequence
(`freshFixtureDatabase`: migrations → seed → fence), and that copy *did* include the seed. Every test
passed against a database state the real command never produced. The gap was then written up in the
fixture guide as a "known gap" with a manual workaround instead of being fixed.

- **One sequence, two transports.** `setupLocal(executor, log)` is now the only copy of the setup
  order. `main()` runs it through `wranglerSetupExecutor` (every call still built by
  `wranglerArguments`, so `--local` pinning is unchanged); `freshFixtureDatabase` runs the same
  function through `sqliteSetupExecutor`. A step dropped from the script now drops out of every
  fixture test too, and `local-setup-wiring.guard.test.ts` asserts an empty database comes out with
  the five stages and the admin.
- **Assert what the seed can guarantee, not operator choices.** The seed is `INSERT OR IGNORE`, so it
  can make rows *exist* but never change them. The postcondition fails on a missing stage key or a
  missing admin id, and only warns on an inactive stage or admin, which are legitimate Admin-managed
  local states. A missing admin id is the case to shout about: `user.email` is unique, so a
  different-id row holding the owner's email makes the seed's insert skip silently.
- **A root script that forwards to a workspace needs a trailing `--` to pass the caller's arguments
  on.** `db:migrate:local` was `npm run migrate:local -w @quincy/db` with no `--`, so from `portal/`
  the inner npm swallowed `--persist-to` as its own config and only the bare path reached the
  script, which refused it as an unknown argument (safe, but useless). Fixed in #265, together with
  `db:generate`; the wiring guard now requires every root `db:*` script whose workspace flag names
  `@quincy/db` (`-w` or `--workspace`, space- or `=`-separated) to end in `--`, as the `db:qa:*`
  scripts already did. `npm run db:migrate:local -- --persist-to <absolute dir>` from `portal/` is
  the scratch-database command.

## A banner that says "narrow your filter" must be tested against the controls the surface renders; a legend comes from the role-aware stage set (#255, #254, 2026-09-27)
Tags: search-filters · #255, #254

The Gantt's draw-cap notice told users to "narrow your filter" for a whole release while the Gantt
rendered no filter controls at all — its filters were hard-wired to defaults (#255). Every test of
the notice checked that it appeared, none checked that the thing it asked for was on screen.

- **Test the instruction, not just the message.** A test for advice copy should find the control
  the copy points at on the same surface. `ProductionGantt-filters.dom.test.tsx` now asserts the
  filters bar is rendered beside the banner.
- **Build a legend from the role-aware stage options, not the colour map (#254).** `stageColors`
  carries both `editing` and `editing_autohdr`; a non-admin receives `editing_autohdr` projects as
  `editing` (`packages/shared/src/stage-move.ts`'s `stageTransportKeyForRole`), so one of the two
  entries is always a colour this viewer never sees. Where no stage label matched, the legend fell back to
  the raw key. `ganttLegendEntries` (`lib/production-gantt-filters.ts`) derives entries from the
  same options the filters bar offers, and drops `Delivered` unless delivered projects are shown.

## A URL-backed chip bar keeps its own query: an unfinished chip has no URL spelling (#255, 2026-09-27)
Tags: search-filters, routing · #255

The Gantt's filters moved from a reused checkbox panel to a ReUI `Filters` chip row
(`components/ProductionGanttFiltersBar.tsx`). A checkbox is always a complete value, so the panel
could be fully controlled by the URL. A chip is not: picking a field creates a rule with no
condition and no value, which the URL cannot hold. Driven straight from the URL, the first echo of
any other edit wiped it.

- **Hold a local `FilterQuery`, push only when its projection changes the URL, and re-seed only when
  the URL changes to something the local query does not already say.** The bar's own push echoes
  back equal and must not rebuild the query — a rebuild resets chip ids, an open value menu and
  focus. Compare facets by a canonical key (`ganttFacetKey`), never by object identity: the
  Dashboard hands a fresh object every render.
- **Give the query stable ids** (`gantt-stage`, `gantt-show`), so a genuine re-seed (Back/Forward,
  the empty state's Clear) still hands React the same chip keys.
- **Veto what the mapping cannot read, then also hide the route to it.** `onBeforeQueryChange`
  refuses any query `queryToGanttFacet` maps to `null`; the picker disables a field once a chip for
  it exists (removing it from `fields` would render an "unknown" chip instead); and the rule menu's
  Duplicate/Negate rows are hidden by `ruleMenu`, an additive Quincy prop on the vendored `Filters`,
  because upstream had no option for it.
- **The vendored create path always asks for the condition.** `filters.tsx` commits a new rule with
  `operator: ""` on purpose, so a field with exactly one operator still shows a one-row condition
  menu. There is no supported option to skip it; we did not fork for it.
- **happy-dom drives the whole flow, with two gaps named in the tests:** it does not turn Enter on a
  `<button>` into a `click` (a browser does), and Base UI's ScrollArea needs an
  `Element.prototype.getAnimations` stub.

## Sibling retained dialogs must namespace their open-token keys (#221 PR C, 2026-09-27)
Tags: focus-overlays, gantt-calendar · #221

`useOpenToken` returns a small integer that starts at 0 and bumps on each open, and the retained-dialog
pattern uses it as the dialog's `key`. Two retained dialogs rendered as siblings each reach token `1`
the first time they open. Once both retained refs are set, React sees two children with key `1` under
one parent and silently drops one of them. The only sign is a console warning ("Encountered two
children with the same key"). In the Gantt, the Deadline confirmation never appeared after the move
dialog had been opened once.

- **Prefix every open-token key with its dialog** (`key={`move-dialog:${token}`}`), as
  `ProductionGantt.tsx` now does for its fold, move and Deadline-confirm dialogs.
- **`ProductionCalendar.tsx` still has the collision:** `key={moveDialogToken}` and
  `key={checklistFoldToken}` are siblings in the same `<section>` (around line 513 and line 526). Not
  fixed in #221 PR C, because it is out of scope.

## `overflow: hidden` is still a scroll container; a registry `data-horizontal:` variant matches nothing under Base UI (2026-09-28)
Tags: css-tokens, reui-vendor

The Gantt's `gantt-view` wrapper measured 145–445px wider in `scrollWidth` than its own width, and
`bar.scrollIntoView({inline})` slid the whole view sideways — resource column cropped to
"esources", stuck until reload. Two separate facts, both worth keeping:

- **`overflow-hidden` clips but still scrolls programmatically.** `scrollIntoView`, find-in-page and
  focus can all move it. Use `overflow-clip` for a box that must never scroll, after checking that no
  `position: sticky` descendant anchors to it (sticky binds to the nearest scroll container).
- **The Collaboration checklist rail (#377) sticks only because #376 removed the panel section's
  `overflow-auto`**, which never scrolled but still captured `position: sticky`. Keep that class off
  the section. The rail's own `overflow-y-auto` is what keeps a checklist taller than the sheet
  reachable, and its sticky offset (`--collab-rail-top`, set on `.project-sheet__body`) must clear the
  sheet's absolutely positioned close button: 44px at `top`/`right` space-4, `.worktools` gives it the
  same clearance.
- **A registry class like `data-horizontal:flex-col` is dead under Base UI 1.7.0**, which emits
  `data-orientation="horizontal|vertical"`, never a bare `data-horizontal`. `reui/tabs.tsx` hit this
  in #202; `reui/scroll-area.tsx` shipped it too, so the horizontal thumb's `flex-1` beat its inline
  width, filled the track, and was translated past the pane (the scrollbar is positioned against
  the ScrollArea root, outside the viewport's clip, so the spill reached `gantt-view`). Vertical
  scrollbars were 2px of padding with a 0-wide thumb — invisible. When vendoring a base-nova item,
  grep it for `data-horizontal:` / `data-vertical:` and rewrite them as `data-[orientation=…]:`.
  `reui/separator.tsx` still has them.
- **Finding what overflows:** a bounding-rect scan misses it when the culprit is transformed or
  sits inside another scroll container. Hiding each child in turn (`display: none`) and re-reading
  the ancestor's `scrollWidth` finds it in one pass.

## A cascade-only delete misses every table whose id column has no FK (2026-09-28)
Tags: d1-migrations

**Symptom:** after the late-September bulk archive-then-delete, D1 held 349 `notification_delivery_ledger`,
322 `notification_outbox` and 527 `rendition_dlq_events` rows for projects and assets that no longer
existed. They had to be swept by hand.

**Cause:** `DELETE /projects/:id` deletes the project row and relies on FK cascades.
`notification_outbox.project_id` and `rendition_dlq_events.asset_id` have no FK, so no cascade reaches
them. Archive guarantees the outbox orphans, because its own batch enqueues `project.archived` broadcast
rows. There was a second way back in: the rendition DLQ consumer recorded any asset id it received,
so a late dead letter could recreate an orphan after the delete.

**Fix:** the route's final batch now deletes ledger rows, then outbox rows, then DLQ rows. The order
matters: `ledger.outbox_id` is `ON DELETE RESTRICT`, and SQLite checks RESTRICT immediately. All three
deletes run before `DELETE FROM projects`, and the DLQ delete uses a subquery over the project's assets
rather than bound ids, because D1 caps bound parameters per statement. Outbox rows are deleted in every
status. The delivery worker acks a row that has disappeared, and email admission requires
`archived_at IS NULL`. The DLQ consumer now inserts only `WHERE EXISTS` the asset.
`project_board_order_0037_rollback` was left alone: it is migration 0037's inert snapshot.

**Rule:** `NO_FK_ID_COLUMNS` in `packages/db/qa-seed/teardown-graph.ts` lists every id column without an
FK. When you add a project-owned entry there, add its delete to `DELETE /projects/:id` too. A regression
test for a delete path has to create the orphan through the real producer (archive, in this case), or
it proves nothing.

## A controlled calendar drawn from `query.data` unmounts on every navigation; draw from the accepted baseline (#222, 2026-09-28)
Tags: gantt-calendar · #222

Round 2 of the event-calendar renderer mounted `<EventCalendar>` only when `query.data` existed. Every
prev / next / view / filter change is a new query key, so `query.data` went `undefined` for one fetch
and the whole grid fell back to the skeleton — a full-page flash per click, and the vendor lost its
scroll and focus. The FullCalendar renderer never had this because it drew from the controller's
`acceptedResponse`, which survives a key change.

- **Draw from `commands.acceptedResponse ?? (!interactionBlocked ? query.data : null)`**, and once
  anything has loaded keep the grid mounted with `loading` on the vendor; the skeleton is first-load only.
- **Focus return needs a Quincy hook on the new renderer's chip.** The shared controller looked chips up
  by `[data-event-id]` (FullCalendar's card), so a cancelled command dropped focus to the page. Matching
  the vendor's `data-ec-event-id` from `lib/` trips the skin guard (`data-ec-*` is vendor-internal), so
  the chip CONTENT carries `data-event-id` and `focusDescriptor` climbs from a non-focusable match to
  its enclosing `<button>` (the FullCalendar card is focusable and is still focused itself).
- **A drag outlives the render that started it.** `useEventCalendarExternalDrop().begin(e, { canDrop,
  onDrop })` keeps the callbacks from pointer-down, so a command that starts mid-drag was not seen by
  `canDrop`. Pass stable wrappers that read a ref refreshed every render.
- **`"deferred"` is silent by design**: the vendor neither moves the chip nor announces, so the surface
  must hold the dropped chip itself (a local `pending` range until the controller's overlay lands —
  a Deadline has none before its confirmation) and the controller owns every announcement.

## Two surfaces, one advisory rule: the out-of-range schedule warning lives only in `lib/schedule-bounds.ts` (#288, 2026-09-28)
Tags: scheduling · #288

The Gantt and the event-calendar renderer each had their own "outside the project window" check:
the Gantt's `scheduleWindowWarnings` (shoot date, else the Sydney created date; a `due_only` checked at
its end) and the Calendar's `checkScheduleBounds` (shoot date only, no `due_only` lower bound,
different copy). The same drag warned on one surface and not the other.

- **The rule lives only in `portal/apps/web/src/lib/schedule-bounds.ts`.** Each surface builds a
  `ScheduleBounds` through `scheduleBoundsFrom` (`ganttScheduleBounds`, `calendarScheduleBounds`), the
  controller runs `scheduleWindowWarnings` over the port's `boundsFor` — in the plan and over the
  server-SAVED schedule for the announcement — and `scheduleWarningText` renders it. There is no
  per-port `committedWarningText` any more. `schedule-bounds.test.ts` runs one table through both
  surface paths; add a case there, never a second rule beside it.
- **Calendar bounds carry `createdAt`** (`ProductionCalendarProjectBounds`, ISO instant, required) so
  the created-at fallback works on the Calendar too. The Sydney civil DATE of that instant is the
  bound, not the UTC date.
- **The wire decoder is strict**, so an already-open tab on the event-calendar renderer that predates
  this change errors on its `bounds=1` response (unknown `createdAt` key) until it reloads. Old bundles
  that never send `bounds=1` are unaffected.

## Flipping a renderer default strands the old path unless its value is honoured explicitly (#223, 2026-09-28)
Tags: gantt-calendar · #223

#222 read the Calendar renderer as "exactly `"event-calendar"` opts in; anything else is the default".
Flipping `CALENDAR_RENDERER_DEFAULT` alone would have made FullCalendar unreachable: no stored value
could select it any more, so the promised per-browser opt-out would not exist.

- **Honour every renderer name explicitly before flipping the default.** `readCalendarRenderer` now
  returns the stored value when it is exactly `"fullcalendar"` or `"event-calendar"` and the default
  otherwise. That change ships first, on its own, with no behaviour change, so the flip is a
  one-line constant change that can be reverted by itself.
- **The event calendar makes two range requests per load, not one**: the `bounds=1` main range and the
  up-next agenda. Both poll. Tests from the FullCalendar era that pinned request counts silently
  measured nothing after the flip. In `Dashboard-search-request-stability` the lazy
  `ProductionEventCalendar` chunk was never preloaded before fake timers, so it made zero requests
  and passed every `<=` ceiling. Before trusting a pinned count after a renderer change, assert that the
  renderer actually drew. Give each renderer its own derived count (FullCalendar 2, event calendar 4:
  identity × StrictMode replay per query).

## A stale lazy chunk after a deploy took down the whole shell; every `lazy()` view needs a boundary (#292, 2026-09-28)
Tags: deploy-ci, routing · #292

**Symptom:** a tab left open across a deploy (or a rollback) switched to the Gantt or Calendar and the
entire app shell was replaced by TanStack's error screen: rail, header and view switcher all gone.

**Cause:** the old tab asked for the old hashed chunk (`ProductionGantt-<oldhash>.js`). That file no
longer exists, and the asset layer's SPA fallback answered with `200 text/html` (index.html), so the
dynamic `import()` rejected — `Failed to fetch dynamically imported module` in Chromium, `Importing a
module script failed` in Safari, `error loading dynamically imported module` in Firefox. React `lazy`
caches that rejection, and so does the browser's module map, so retrying the import in place cannot
recover; only a full reload fetches the new index.html and its new hashes. With no error boundary
around the lazy view, the rejection climbed to TanStack's global CatchBoundary, which replaced the shell.

**Fix:** `components/ViewLoadBoundary.tsx` wraps each lazy view in `screens/Dashboard.tsx`, outside its
`<Suspense>`. A chunk-load error (`lib/chunk-load-error.ts`) shows a caution notice — "The Portal may
have been updated. Reload to open the …" — with a Reload button; any other error shows the error empty state
with the same button. The switcher stays usable, leaving the view unmounts (resets) the boundary, and
returning shows the notice again because the rejection is cached. The boundary does not swallow the
error: React 19's default `onCaughtError` still logs it.

- **Rule: every `lazy()` view sits inside a `ViewLoadBoundary`.**
- **Recovery is a user-initiated reload, never an automatic one** (no `vite:preloadError` listener, no
  reload-on-error). There is no global write-in-flight signal — scheduling writes are raw
  `apiPut`/`apiPatch` — so an automatic reload could discard a write the user just made.
- `Dashboard-view-load-error.dom.test.tsx` pins it through the real lazy path: the mocked module's
  export is a getter that throws the chunk-load `TypeError`, so the Dashboard's own
  `import(...).then(...)` rejects.

## An Undo's refetch is a settle refetch: a failure must enter recovery, not announce success (#291, 2026-09-28)
Tags: search-filters · #291

`runUndo` in `lib/use-scheduling-commands.tsx` awaited `refetchAuthoritative()` after a successful
compensating write, ignored the result, and announced "Change undone.". On the Gantt this was hidden:
`onUndone` patches the row locally. The event calendar draws only from the controller-owned
`acceptedResponse`, so a failed refetch left the forward-saved chip on screen under a success message.

- **Bracket the Undo refetch exactly like a forward save's**: release the accept gate and command lock,
  `setSettle({ type: "winner" })`, the in-flight flag, then `refetch-succeeded` + "Change undone." or
  `refetch-failed` + the settle-failed announcement. `refetch-failed` is inert unless settle is already
  pending, so the `winner` step is not optional, and pending settle is what `canStartCommand` refuses,
  so releasing the gate early does not let a second command in. Holding the gate through the refetch
  instead disabled the Dashboard's view buttons for as long as the refetch took. The undecodable-body
  branch gets the same bracket. Every Undo now reports a settle cycle through `onSettleStateChange`.
- **Test a failed refetch with a 4xx, not a 5xx.** `projectQueryRetry` retries 5xx with backoff, so a
  503 fixture hangs past the test instead of failing the refetch.
- **The Undo toast lives in `lib/use-scheduling-undo-toast.ts`** (`useSchedulingControllerWithUndoToast`),
  not in a surface. Its dismiss effect keys on the controller's full reset deps (`resetKey` plus
  identity), because the Calendar's `calendarResetKey` has no identity in it.

## The `producer` skip covers a surface's every in-tab query, not just the one it refetches (#295, 2026-09-29)
Tags: search-filters · #295

`invalidateProjectSurfaces(..., producer: "calendar")` skips in-tab invalidation of every query on
the `production-calendar` prefix, on the assumption that the producing surface refetches its own
data. The event calendar owns two such queries — the main range (`bounds=1`) and the Up next rail
(agenda from today, no `bounds`) — but only the main one was refetched, so the rail kept an item's
old time after a save or an Undo until its own 30s interval or a remount.

- **Refresh the secondary query at commit, from `onCommitted` / `onUndone`, not from the port's
  `refetch`.** The first fix hung it off `port.refetch`, and review found the hole: the settle
  refetch runs after the awaited `invalidateProjectSurfaces` and behind an operation-token check,
  so a navigation during that await skips it. The main range recovers (its key changes); the rail's
  key does not (its date and subview are fixed), so it stayed stale. The commit hooks fire
  synchronously before any await, and only for a real save — not for a no-op, a rollback, recovery
  or a queued cross-tab refetch.
- **Known gap:** the undecodable-body branches (a write that happened but whose response no decoder
  accepts) return before either hook, so the rail waits for its interval there.
- **Don't await the rail refresh.** It sits outside the accept gate and renders its own error state.
- **Narrowing the skip to the producing key was rejected**: without a `ProjectQueryRuntime`,
  `invalidateProjectSurfaces` returns before `converge`, and it changes every producer at once.
- **A "not double-fetched" test needs a live runtime**, or the producer skip never runs and the
  assertion proves nothing. The #295 block in `ProductionEventCalendar-undo.dom.test.tsx` constructs
  one and asserts exactly one main-range GET and one rail GET per save; turning the skip off fails it.

## Retiring a renderer: its files were still load-bearing, and its stylesheet was never loaded (#224, 2026-09-29)
Tags: gantt-calendar · #224

Deleting FullCalendar looked like `rm` plus test legs. Three things made it a two-commit job.

- **"Old" files still exported live code.** The ReUI Calendar and the Gantt imported
  `ProjectCalendarAnchor`, the schedule-editor button label, `civilParts`/`validCivil`, the
  compact-field class and `COARSE_TAP_TARGET` from files named for FullCalendar, and
  `ProductionCalendarMoveConfirmation` is the body of two live confirmation dialogs. So the first
  commit moved every survivor to a home that outlives the deletion (old files re-importing from
  it, so the old guard stayed green), and only the second deleted anything. Grep the importers of a
  module before trusting a delete list, including one written in the issue.
- **A lazily imported stylesheet only styles what loads its chunk.** `production-calendar.css` was
  imported by the lazy `ProductionCalendarSurface` alone, and Vite code-splits CSS with the chunk.
  Since #223 made the event calendar the default, the schedule editor's fold fieldset and the
  Gantt's Modal dialogs had been unstyled in production for everyone who never opened
  FullCalendar. The fold now uses reui `FieldSet`/`FieldLegend`; the Gantt renders the shared
  `ProductionEventCalendarDialogs`. When a surface shares components with a lazy one, check where
  their CSS is actually imported.
- **Retire a guard only after its replacement exists.** `ProductionCalendarChrome.guard` pinned
  focus rings and reduced motion by the old surface's class names. Its replacement pins what the
  event calendar actually relies on: Guard 3b/3c in `design-system-guards.test.ts` (the unlayered
  global `:focus-visible` and `prefers-reduced-motion` rules) and
  `ProductionEventCalendar.focus-motion.guard.test.ts` (no `!important` outline or motion
  utilities on the Calendar surfaces). Each has a planted-fixture self-test. happy-dom resolves
  neither cascade layers nor media queries, so the runtime check stays in the browser pass.
- **Porting a FullCalendar-driven DOM test to `testing/event-calendar-fake.tsx`**: the default
  test viewport draws the Calendar's narrow layout, so the facets rail sits behind the Filters
  toggle and must be opened first; Base UI's ScrollArea needs the `Element.getAnimations` polyfill
  other suites already carry; and request counts are re-derived per the #223 entry (main range
  plus Up next), not copied.
- **Base UI's default focus restoration was enough for the Gantt.** Moving the Gantt from the old
  Modal move dialog to the ReUI alert-dialog needed no `finalFocus`: 6c pins focus arriving in the
  confirmation and 6e pins Cancel returning it to Set deadline.


## A test written against an adapter can pin an invariant only that adapter could break (2026-09-29)
Tags: testing-guards · #224

`submitDeadlineProposal` was the FullCalendar handlers' entry point into the scheduling controller,
and it outlived FullCalendar (#224) with no production caller. Two tests in
`use-scheduling-commands.dom.test.tsx` still drove it. Moving them to `submitProposal`, the entry
point `ProductionEventCalendar` uses, showed that neither invariant could be written the same way:

- **The stale-snapshot leak** needed an entry point that ran a proposal *without*
  `acceptForInteraction`. Only the adapter did that. Every surviving entry point accepts first, and
  `cancelMoveDialog` returns early when no dialog is open. So the generic-invalid branch's
  `snapshotRef` clear is now defensive. The test now pins the case the Calendar can reach: B's
  cancelled announcement names B and never A.
- **"Map from `snapshot.event`, not the positional `event`"** needed the two to disagree. No
  surviving caller can make that happen: `beginCalendarInteraction` clones the event it is handed,
  and each caller passes that same event alongside the snapshot. The test now drives
  `mapAndRunDropProposal` through its one remaining caller, a drag's fold-dialog retry
  (`submitMoveDialog`), and pins the snapshot's version and offsets in the PUT.
- **Rule:** when you delete an adapter, re-derive each of its tests from a production entry point.
  Do not keep the old assertions as they were: an assertion the new path can never violate passes
  whatever the code does. Mutation-check the replacement, and write down which invariant became
  unreachable.

## A data barrier is not a UI lock; split them, and build a move's baseline from the pre-overlay list (#306, 2026-09-29)
Tags: board-dnd · #306

`interactionBlocked` in `Dashboard.tsx` did two jobs. It deferred accepting refetched data, and it
disabled the view switcher, the sort and (via the Board's `movementLocked`) every card's movement.
A priority save needs the first job: a refetch that started before the POST must never land
mid-save (#232). It never needed the second. The board-wide lock came from #98 as a general "no
second interaction mid-write" caution, with no failure behind it. The result was one star click
freezing the whole Board.

- **The split:** `interactionBlocked` stays the data barrier and still includes `pendingOrdering`.
  `movementInteractionActive` drives the UI and leaves it out. A pending priority now locks only
  its own card (`pendingOrdering.has(id)`); a pending *move* still locks every card, because moves
  are single-writer.
- **The trap the split uncovered:** `runBoardMovement` built its baseline from `projects`, which
  already carries `priorityOverlay`. While the lock was board-wide no move could start during a
  priority save, so it never mattered. Once another card can move, that move stamps X's
  *unconfirmed* priority into `acceptedProjects` and `boardOverlay`. If X's save then fails,
  removing the overlay entry reveals the stamped value, not the original.
- **And the first fix was half wrong.** Building the baseline from the bare `baseProjects` dropped
  *confirmed* priorities too. The move's response bumps the moving card's `boardRevision` past the
  confirmation's, the overlay's freshness rule lets that base row win, and a card moved right after
  its own save showed its old priority until the refetch landed. The baseline carries confirmed
  values only (`confirmedPriorities`); pending ones are re-applied at render. Two tests pin the two
  directions: (b) fails if a pending value gets in, (c) fails if a confirmed one is left out.
- **Known, accepted:** the priority `UPDATE` is guarded on the card's own `board_position` and
  `board_revision`, and a move can compact the column. A move committing inside the milliseconds
  between the save's SELECT and UPDATE fails the save with a 409 and a rollback. Another user could
  always trigger that, so it does not justify a board-wide lock. A move's focus restore also still
  waits for any pending priority save to settle (`useLayoutEffect` gate); that is a sub-second delay.
- **Rule:** before relaxing a lock, list every path the lock made unreachable. Each is a latent bug
  the relaxation exposes. Both #306 baseline tests in `Dashboard-priority-coordinator` were mutation-checked.

## dnd-kit does not animate a reorder outside a drag; the Board owns that FLIP (#304, 2026-09-29)
Tags: board-dnd · #304

- **Symptom:** under Priority sort, the optimistic overlay (#232) re-sorted a card in one frame. The
  card left the pointer, and a quick second click at the same spot hit another project's stars.
- **Why dnd-kit did not help:** outside a drag `useSortable`'s `newIndex` is whatever the *last*
  drag left behind (it is only written while sorting), and the vendored `KanbanItem` forces
  `wasDragging: true`. So a non-drag reorder either paints instantly or is offset from a stale
  droppable rect. Repairing that path was ruled out: fixed 200ms `ease`, no reduced-motion path,
  and `useDerivedTransform` is the white-screen loop in the TB5B entry above.
- **Fix:** `lib/kanban-flip.ts` + `FlipScope` in `kanban2/board.tsx`. The "first" rects are read
  in `getSnapshotBeforeUpdate` (the only point after render and before commit), and the FLIP is
  played on a Board-owned `[data-flip-id]` wrapper, never on `KanbanItem`, whose transform React
  and dnd-kit own. `boardAnimateLayoutChanges` switches dnd-kit's layout animation off outside a
  drag and its 50ms settle window, so the two never stack. Skipped under reduced motion, in the
  drop's commit, and on a sort-mode change.
- **The FLIP alone does not stop the misclick.** A pointer star commit whose card then moves arms
  a short guard (`lib/star-click-guard.ts`): a pointer commit on a *different* card within 16px and
  900ms (one `--dur-slow` flight plus a double-click interval) is dropped. A pointer commit is told
  from a keyboard one by a click point recorded in the
  Board's capture phase, because a star commits on `click` and keyboard commits never produce one.
- **Trap caught in review, invisible to the tests:** the first version cleared that point in a
  `queueMicrotask`. React dispatches capture and bubble from two *separate* native listeners on the
  root, and on a real user click the microtask queue drains between them, so the point was gone
  before the star's `onClick` read it and the guard never armed. A scripted `dispatchEvent` keeps
  the stack busy, so no checkpoint runs and happy-dom passed it. Clear the point in the Board's own
  bubble-phase `onClick` (after the star's) and on `keydown` capture; never across a phase boundary
  in a microtask.
- **Rule:** any code that reorders the Board outside a drag goes through the same FLIP for free.
  Do not add a second animation to `KanbanItem`. happy-dom has no layout, so the geometry is
  checked in the browser pass.

## TanStack resets the scroll after every notified render, even with restoration off (#266, 2026-09-29)
Tags: routing · #266

- **Symptom:** on a phone, changing a Gantt or Calendar filter, or committing a search, threw the
  reader back to the top of the Dashboard (`scrollY` 433 → 0). The #255 empty-state Clear focused
  and scrolled the Add-filter trigger into view, and the router's reset then undid it.
- **Why:** TanStack's `setupScrollRestoration` always registers its `onRendered` subscriber on the
  client, *past* the `scrollRestoration` option check, so "restoration off" only turns off saved
  positions — the reset to top still runs after every render the history is notified of. Every
  staff write notifies it (`staff-history.ts` → `history.notify`).
- **Fix:** the staff history tells the router, before each notify, whether the pathname changed,
  and the router sets `_scroll.next` from it — the same flag its own `resetScroll: false`
  navigation option sets. Query-only changes keep the scroll position; a new screen lands at the top.
- **Rule:** `_scroll` is router-internal. `app-router-scroll.dom.test.tsx` pins the behaviour, so a
  TanStack upgrade that renames it fails a test rather than the phone layout. Do not "fix" this with
  a `scrollRestoration` function: a truthy option also turns on the scroll cache and sets
  `history.scrollRestoration = "manual"`.

### An API narrowing lands before its data backfill (#340, ADR 0011) (historical: #342 removed everything it describes)

Historical. #342 deleted the mappers, the Unscheduled drop, `oneDaySubtaskRange` and
`ProductionEventCalendar-unscheduled.dom.test.tsx`; only the lesson (narrow the API, then backfill, then
remove the legacy readers) still applies.

- **What happened:** #340 made the Subtask create/update API accept only a range, while about 13 production rows are
  still unscheduled or due-only until the #341 backfill. The calendar's diamond move, Unscheduled drop and undo-to-legacy
  gestures still send due-only or unscheduled payloads (`production-calendar.ts` `checklistMoveSchedule`, the month drop,
  `scheduling-undo.ts`), so on those legacy rows they now get a 400.
- **Behaviour to expect:** the zod `.strict()` 400 body is `{ error: "Invalid input", details }` with no `code`, so
  `classifyChecklistFailure` returns null and the generic failure path rolls the optimistic move back and announces the
  failure. `ProductionEventCalendar-unscheduled.dom.test.tsx` pins that. No data changes.
- **Rule (at the time):** do not rewrite those mappers in the interim: #342 deletes them. Run #341 right after
  deploy. Until #342, both editors converted a legacy row by seeding a one-day range for the user to confirm.

### An old tab still holds the pre-range wire (#342, ADR 0011)

- **What happened:** #342 removed the checklist `unscheduled` / `due_only` / `legacy_unresolved` / `invalid` DTO
  states, `permissions.canScheduleRange`, the calendar response's `unscheduled` list and
  `filterFacets.unscheduled`. The web decoders are strict, so a tab opened before the deploy, on the old bundle,
  fails to parse the new calendar and Gantt responses until it reloads.
- **Behaviour to expect:** the tab shows its normal load-error state; a reload fixes it. No data is affected. The
  other direction is not a concern: the API only accepts ranges since #340.
- **Rule:** do not add a compatibility shim for the old shape. A deploy that changes a strict wire shape
  needs the tab to reload; the same holds for any future one. Storage that is not a valid range now throws
  (`ChecklistScheduleStorageError`, an unhandled 500 with the subtask id in the log), so the #341 backfill must
  have run and been verified at 0 non-range rows (`scripts/subtask-range-backfill-verify.sql`) before #342 ships.
  #343's constraint follows #342.

### The database requires every Subtask to be a range (#343, migration 0047)

- **What it is:** `project_subtasks.schedule_range_required integer NOT NULL DEFAULT 1 CHECK (...)`, one bare
  `ADD COLUMN`. The CHECK is `schedule_range_required = 1 AND COALESCE(<range predicate>, 0) = 1`, and the predicate
  is exactly `portal/scripts/subtask-range-backfill-verify.sql`, so the pre-merge production verify returning 0
  guarantees the migration applies. SQLite tests an added column's CHECK against every existing row, so 0047
  refuses to apply while a range-less row exists. It is not a table rebuild (see the 0020 entry) and has no trigger.
  `migration-0047.test.ts` pins the verify/CHECK equivalence over a matrix of row shapes.
- **Why `COALESCE(...) = 1`:** a CHECK passes when its expression is NULL, so a NULL anywhere in the predicate would
  otherwise accept the row. The `schedule_range_required = 1` term also stops a write of NULL or 0 to the marker.
- **Rule: a later migration that drops a schedule column or `due_date` must first drop this column**
  (`ALTER TABLE project_subtasks DROP COLUMN schedule_range_required`): SQLite refuses to drop a column an existing
  CHECK references. Rollback of 0047 itself is that same forward `DROP COLUMN`.
- **Not proven on remote D1 (the 0020 caveat above):** the "same column only" advice came from a rebuild failure, and
  this CHECK references other columns. Local D1 (`wrangler d1 ... --local`) and `node:sqlite` accept it; a rehearsal on
  a throwaway remote database was not run here.
- **Test fixtures:** raw `INSERT INTO project_subtasks` in Worker and DB tests must carry a complete range. Neutral
  rows use a far-future one-day date range (`2099-12-31`, so no reminder scan claims them). A test that simulated a
  concurrent writer corrupting a schedule column can no longer do so; only moves between valid ranges are reachable.

## `?collaboration=open` is frozen by stored activity deep links; Collection tabs got `?tab=` (#337, 2026-09-29)
Tags: routing, notifications · #337

- **Context:** #337 made every Project notification open the Workspace tab it is about. The obvious
  shape was one uniform `?tab=<workspace tab>` parameter, with `?tab=collaboration` replacing
  `?collaboration=open`.
- **Why that breaks production data:** `projectActivityDeepLink` (`packages/shared/src/project-activity.ts`)
  builds a Collaboration activity's deep link through `staffPathFor`, and `parseProjectActivityRow`
  rejects any persisted `deep_link_path` that is not byte-equal to it. Changing what `staffPathFor`
  emits for Collaboration would turn every stored `project_collaboration` activity row and every
  in-flight outbox payload into `payload_invalid` -- a silent suppression of real notifications.
  Accepting `tab=collaboration` as an alias would break the read-only router's invariant that no
  accepted location is rebuilt differently (`staff-history.test.ts`).
- **Shape:** Collaboration keeps `?collaboration=open` as its only spelling; the five Collections use
  `?tab=raw|edited|video|floorplan|copy`. `?tab=collaboration`, unknown kinds and mixed/duplicate
  params are `not-found`. `staff-routes.test.ts` pins the Collaboration output with a comment naming
  the constraint.
- **Rule:** before changing any `staffPathFor` output, grep for places that persist its result and
  compare it byte-for-byte later. Changing the Collaboration spelling needs a data migration of
  `project_activity_events.deep_link_path` and outbox payloads first.
- **Also found:** `InternalLink` only intercepts a pointer click (`event.detail !== 0`); a
  programmatic `.click()` in a DOM test falls through to happy-dom's own navigation, which changes
  `location` without notifying `locationStore`. Dispatch a `MouseEvent` with `detail: 1`.
  **#366: keyboard activation is intercepted too** (the `detail === 0` exclusion is gone); `detail: 1`
  in tests is now realism, not a requirement. Ctrl/Meta/Shift/Alt+Enter still open natively.
- **Also found:** a ref callback created fresh on every render, handed to a Base UI `TabsTrigger`,
  loops (Base UI re-registers the trigger with a state update on each ref change). Keep per-item
  ref callbacks stable (`ProjectHeader.tsx`'s `tabRefCallbacks`).

## Server-Timing / D1 metering (#361)
Tags: workers-runtime, d1-migrations · #361

- **Never build the metered `env` or `DB` per request.** `getAuth` (#360) and `boardSchemaVariant`
  cache on the identity of `env` and `env.DB`; a fresh wrapper per request silently rebuilds
  better-auth and re-runs the `sqlite_master` probe every time and no test notices. `derivedEnv`
  and `meteredD1` in `lib/server-timing.ts` are memoised per raw object, and the per-request
  numbers travel through `AsyncLocalStorage`. `server-timing.test.ts` pins `authInstanceBuildCount() === 1`.
- **Meter statements by shadowing methods on the genuine `D1PreparedStatement`, not with a Proxy:**
  `DB.batch()` must receive real statements. A statement someone else already wrapped (a test's
  Proxy overriding `bind`) is left unmetered: shadowing it recurses through the real statement.
- **D1 `meta` (rows read, region) is partial.** Only `.all()`, `.run()` and `.batch()` return it;
  `.first()`, `.raw()` and Drizzle's field-selecting reads do not. Do not turn `raw()` into `all()`
  to get it (object rows collapse duplicate column names in joins). `d1-meta` is the coverage counter.

## Thumbnails moved from `no-store` to `private, max-age=300` (#362, 2026-09-30)
Tags: media-renditions · #362

- **Change:** an authorised `thumb`/`web` rendition served from `GET /media/asset/:assetId/:variant`
  (stored-rendition branches for staff and External Editor) now carries
  `Cache-Control: private, max-age=300` and `Vary: Cookie`. Before, every Dashboard visit refetched every
  cover, and each cost a session check, about three D1 lookups and an R2 read.
- **Why it is safe:**
  - `private` means Cloudflare and any other intermediary never store it; only the viewer's own browser does.
  - The lifetime is 5 minutes. After it the browser refetches and the Worker re-runs session, principal and
    project-access checks, so revocation and sign-out take effect within 5 minutes at most.
  - `Vary: Cookie` makes a different principal in the same browser (sign-out then sign-in, Admin
    impersonation) miss the cache instead of seeing another principal's thumbnails.
- **What is still exposed:** the same principal, after a revocation, role change or External Editor
  transition, can keep seeing already-loaded thumbnails for up to 5 minutes. The zone purge in
  `Cloudflare-Cache-Purge-Setup.md` does not reach a browser cache. A regenerated rendition (spec change)
  can likewise show stale for up to 5 minutes, because the URL is stable per asset id. The Worker sends an
  ETag but never returns 304, so a revalidation still costs the full read.
- **Stays `no-store`:** `original`, annotation markup, the dev direct fallback, the 302 to the live
  transform, `__transform-source`, every 409 "processing", and every error. Errors never set a header
  themselves, so `middleware/media-cache-default.ts` (registered before `requireSession` on `/media`,
  and listed in `CHECKED_IN_MIDDLEWARE_REGISTRATIONS`) adds `private, no-store` to any `/media` response
  that has none, including the 401.
- **Covers now load near the viewport:** the Dashboard List and Kanban covers use visible-only
  `LazyImage` (`src=`), not `preload="background"`, so off-screen covers are no longer fetched on idle.
  `lazy-image-observer.ts` sets `scrollMargin` beside `rootMargin`: `rootMargin` only grows the viewport
  box, so covers inside a scrolling column would otherwise load only on entering the scrollport.
  `Dashboard-cover-lazy.dom.test.tsx` flushes the idle trigger, so it fails if background preloading returns.

## No triggers in migrations (2026-09-30, #364)
Tags: d1-migrations · #364

- **The worker test harness loads migration SQL by splitting on `;` (after dropping `--` lines),
  so a `CREATE TRIGGER ... BEGIN ...; END;` cannot be loaded and would break every worker suite.**
  53 files do this (`workers/app/test/project-subtasks.test.ts:18` is one) and the repo has no
  triggers. Keep a mirror column and its relation in step in application code instead: append the
  relation statements at the **end** of the existing `D1.batch` (so every positional
  `results[n]` read stays valid) and fence each with `EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`
  on the winning audit row, so a lost compare-and-swap writes nothing. No `;` in a migration
  comment either. See `docs/adr/0012-subtask-assignees-are-a-relation.md`.
- **Also found:** the Workers test runtime cannot read the host filesystem, so a worker test cannot
  load a `scripts/*.sql` file. Prove the script in a `packages/db` node test and inline the
  invariant in the worker test.

## Polling the query cache does not prove a component rendered it (2026-09-30)
Tags: testing-guards

- **`PrincipalFreshnessBoundary.dom.test.tsx` flaked on main CI (run 36680115640, line 149,
  `expected false to be true`).** Its tests waited until the first access snapshot was in the
  cache, then overwrote it with a smaller one. The boundary diffs the snapshots it *rendered*
  (`previous.current`), not the cache. React-query hands the observer's update to React on its own
  `setTimeout(0)` (`notifyManager`'s default scheduler), so the cache write and the render are two
  separate events. When the fetch settled after more than 5ms of main-thread work, the test's
  5ms poll timer fired before that notification. The poll saw the data, the test overwrote it, and
  the boundary only ever rendered the second snapshot. With no prior snapshot there was no purge.
- **Reproduced deterministically** by busy-waiting 10ms inside the mocked `apiGet`: it failed 3/3,
  and "redirects a lost Workspace project" failed the same way. It was not #360, because
  `useSession` is mocked in that file.
- **Fix:** in that describe, `notifyManager.setScheduler((callback) => callback())` in `beforeEach`
  and `setScheduler(defaultScheduler)` in `afterEach`. This is the same pattern as
  `lib/project-data.dom.test.tsx`. Then "in the cache after an `act`" means the component has
  committed it. Alternatively, wait on something the component rendered. More ticks or a longer
  poll only move the race.

## Every reader of a relation-backed assignment moves together (2026-09-30, #368)
Tags: d1-migrations, permissions · #368

- **Every reader of a relation-backed assignment must move in the PR that makes a second assignee
  possible. The channel admission SQL (`notification-delivery.ts`, staff `legacyAdmission` and the
  external `project.subtask.*` arm) is a reader too.** A notice is only deliverable while its
  recipient still has a `project_subtask_assignees` row at the version the payload carries. The
  resolver is checked first, so a reader missed in the admission SQL passes every resolver test and
  only fails in the race between the in-app and email channels: test it with a `batch` wrapper that
  deletes the relation row after the second batch (`notification-delivery.integration.test.ts`).
- **The per-person version is `assignment_version` at the moment the person was added, not the
  Subtask's current one.** A retained person keeps theirs, so adding or removing someone else never
  suppresses their pending notice, and remove-then-re-add gets a new value. Under the write gate the
  sole assignee's row version equals the Subtask's, which is why pre-#368 pending rows still deliver.

- **A native assignee delta that loses the compare-and-swap to any concurrent edit is a 409
  `subtask_item_conflict`, not a 200 no-op (#368, deliberate deviation from the PR2 spec).** The UPDATE
  is guarded by every column the request read, so a concurrent title or completion edit makes the delta
  match no row. Returning the `noop` there reports success for an assignee change that was never
  applied and the user silently loses it. The client refetches from the conflict body instead. A
  translated legacy `assigneeId` write keeps the old 200 no-op (an open old tab cannot act on a
  conflict); test in `project-subtask-command.test.ts` by gating both `batch` calls on a barrier.

## The Project sheet: four traps (#366, 2026-09-30)
Tags: focus-overlays, css-tokens · #366

- **A nested `Dialog.Root` renders no backdrop unless `forceRender` is set.** `RailedShell` wraps the
  whole content column in its own `<Sheet>` Root, so the Project sheet's Root is nested, and
  `dialog/backdrop/DialogBackdrop.js` is `enabled: forceRender || !nested`. No scrim means an inset
  press does nothing. `ProjectSheet` passes `overlayProps={{ forceRender: true }}`; the rail sheet is
  not nested and needs nothing.
- **A body portal drops the shell's custom properties.** A modal Base UI portal renders into `body`,
  outside `.app` and `[data-rail-mode]`, so `--shell-header-height` is undefined there, and an
  undefined `top: var(--shell-header-height)` makes `.worktools` stop sticking. `.project-sheet__body`
  re-declares it (as `0px`) and `--toast-inset-inline-start` in `app.css`.
- **Base UI's dialog Esc `stopPropagation()`s on `document`, which starves a `window` keydown
  listener (the Lightbox), and it calls `onOpenChange` more than once per Escape.**
  `details.allowPropagation()` (with `details.cancel()`) is the opt-out. Decide "is an inner layer
  open?" at window-capture, before any handler runs, and READ that snapshot in `onOpenChange` — do
  not consume it: the second call would then close the sheet.
- **A selector like `[role="dialog"] a[href^="/projects/<id>"]` now also matches inside the Project
  sheet** (it is itself a `role="dialog"` holding the `/edit` link). Address rows by their own test id.
- **Keyboard activation of an in-app link is intercepted too** (see the entry above on `InternalLink`
  and `detail`); `detail: 1` in a DOM test is realism, not a requirement.

## Discussion restyle: three traps (#376, 2026-09-30)
Tags: css-tokens, rich-text · #376

- **`InputGroup`'s `has-disabled:bg-surface-sunken` is a deep `:has(:disabled)`, not "the input is
  disabled".** The rich-text field puts the toolbar inside the group, and Undo/Redo are disabled on
  every empty editor, so the whole field paints sunken. `RichTextEditor variant="field"` overrides
  it with `has-disabled:bg-card` and re-keys the sunken ground to the wrapper's own `data-disabled`
  (`data-[disabled]:bg-surface-sunken!` — important, because the `:has()` rule has higher
  specificity). Disabled toolbar buttons go transparent through `cn()` so tailwind-merge drops the
  base's `disabled:bg-surface-sunken`; a plain string append would leave two conflicting utilities.
  Assert class **tokens**, not substrings: `aria-disabled:bg-surface-sunken` contains the other.
- **The read anchor needs the real scroll container, and the ref callback that wires it must be
  stable.** Inside the Project sheet the scroller is the sheet body, which fires no window scroll,
  and `geometryVisible()` clips only by the window unless a root is set, so an anchor scrolled above
  the body (but inside the window) counted as visible. The panel resolves
  `nearestScrollContainer(section)` and hands it to the presentation. An inline ref callback is
  called with `null` then the node on every render and each call sets state in the presentation: a
  render loop. Keep it in a `useCallback` over a latest-ref. And the panel `<section>` must not be
  an `overflow-auto` box itself, or the walk returns the section.
- **A guard that pins "the file contains `<time dateTime=`" pins the file, not the behaviour.**
  Moving the element into a shared component (`quincy/CollaborationTimestamp`) broke
  `tb8-07-regressions`; the assertion moved with it. Likewise the DOM test seam bans class and
  vendor-`data-slot` selectors, so new hooks (`initials-avatar`, `rich-text-field`,
  `collaboration-timestamp-absolute`) are `data-testid`s on Quincy-owned elements.

## Activity feed vs notification copy (#378, 2026-09-30)
Tags: notifications · #378

- **The actor prefix belongs to notifications only.** `renderProjectActivityNotification(…, actorName)`
  prefixes `"${actorName} — "`; a notification has no `actor` field, so it needs it. The Activity feed
  item carries `actor` structurally and the row renders it once (bold), so
  `projectActivityFeedItemFromRow` passes `null` and the sentence stays actor-free, exactly as the
  External feed already ships it. Do not re-add the name to the feed body, and do not strip the prefix
  in the client by parsing prose. A test pins that the notification body is still
  `"<actor> — <feed body>"`.
- **`actor === null` does not mean "System".** It is also a user actor whose profile has no name
  (`workers/app/src/routes/project-activity.ts`). The row shows the sentence alone with an empty
  avatar slot; "System" is the name of the Background jobs view, not of an event author.
- **Removing the Background jobs card must not remove the jobs.** It rendered under every Workspace
  tab, but the same `jobs` state drives the active-job poll, the AutoHDR hand-off and the Collection
  body. `ProjectWorkspace` still owns the fetch, poll and retry; `jobs` / `onRetryJob` are threaded to
  the panel (admins only) and shown under Activity > System.

- **Detach before drop: a drizzle full-row select is a hidden column read.** `select({ subtask: schema.projectSubtasks })`
  names every column in `schema.ts`, so a column is only safe to drop once its field is gone from `schema.ts` in an
  earlier code PR. Prove it by running the `DROP` ad hoc in a test (`subtask-assignee-column-dropped.test.ts` in
  the app and background workers) and driving every path over HTTP: any `no such column` is a 500 there, not in
  production.

## DOM tests must not depend on in-file order (#389)
Tags: testing-guards · #389

- **Replay an order failure with the seed.** Run the DOM suite shuffled:
  `npx vitest run --project dom --sequence.shuffle --sequence.seed=<n>`
  (from `portal/apps/web`). Vitest prints `Running tests with seed "<n>"`; pass that `<n>` to reproduce a
  failure exactly. The default reporter lists tests in declaration order, not execution order.
- **State that outlives a test** is the usual cause: module-level timestamps in vendored code
  (the event-calendar gesture-suppression windows swallow a slot click within 250-300ms of a
  drag), a library singleton's one-shot flag (better-auth fetches the initial session once per
  module, so a "first mount fetches" assertion belongs in its own file), and an `afterEach` that
  disposes state the test never built (make it nullable and clean up only what was set). Give each
  test its own precondition; do not loosen the assertion.

## Tonomo re-created deleted Projects (order tombstones, 0051)
Tags: scheduling, d1-migrations

- **Cause.** Tonomo sends a webhook whenever anything changes on an order. `findProject` matched only
  `projects.order_id`, so deleting a Project (`DELETE /projects/:id`) lost the order id and the next webhook
  created the Project again. Bulk resends of old orders also created Projects the Portal never had.
- **Rule: a live `order_id` match beats a tombstone.** `findProject` order is: live Project by `order_id`
  (an archived one still throws) -> `tonomo_order_tombstones` by order id -> address link -> none. A
  tombstoned order is ignored: the event is marked `processed` with `error` starting `Ignored:`, and nothing
  else is written (no collections, audit row or Editor reconcile). Never throw `TonomoApplyError` for an
  ignore: the processor DO marks those poison. The tombstone also blocks the address link, so a manual
  Project at the same address is not pulled onto a dead order.
- **Write path.** The delete route inserts the tombstone in the same `DB.batch` as the `DELETE FROM projects`,
  before it, selecting `order_id` from the row it is about to delete. 0051 seeds older deletions from
  `audit_log`. The column is `deleted_project_id`, not `project_id`, because the Project is gone and the QA
  teardown guard pattern-matches `project_id`.
- **Create cutoff.** `TONOMO_CREATE_MIN_SHOOT_DATE` (`"2026-09-01"`, owner decision 2026-10-01) in
  `workers/background/src/tonomo/process.ts`: a NEW order (no Project, no tombstone, no address link) with a
  canonical shoot date before it is ignored the same way. Null and non-canonical dates still create. Updates
  and address links are not affected. Move the constant, not the logic.

## Gantt landing row (#414, #415): no `scrollIntoView`, and pagination decides the landing
Tags: gantt-calendar · #414, #415

- **Place the row by writing `scrollTop`, never `scrollIntoView`.** `scrollGanttRowToTop`
  (`ProductionGantt.tsx`) reads the timeline row's rect against the viewport and the sticky timeline
  header, then writes that `scrollTop` to the Timeline's single scroller. Since #727 the tree is a sticky
  column inside that scroller, so one write moves tree rows and bars together; before it there were two
  pane viewports and the write (and the vendor wheel handler) mirrored both. `scrollIntoView` scrolls every ancestor (the page itself on a phone, the hazard in the earlier Gantt
  horizontal-displacement lesson) and `block: "start"` parks the row under the sticky header. `scrollLeft`
  is never written, so the vendor's centre-on-now survives. Do not clamp against `scrollHeight`: browsers
  clamp natively and happy-dom reports 0.
- **The landing needs the page walk.** The API returns 100 Projects oldest-first, so when every loaded row
  is in the past the current Project is on a later page. `ganttLandingProject` returns `undecided` until a
  match, a loaded row starting after today, or a complete walk; the request stays armed and fetches the next
  page through the scroll-paging latch (bounded by the draw cap, which counts as complete).
- **Wait for the drawn rows, not just the loaded pages.** The chart draws the scheduling controller's
  accepted rows, which can trail `query.data` by a commit. Deciding when `hasNextPage` flipped but the drawn
  rows still lacked the new page picked the old last row. The effect returns until every loaded Project id
  is in `displayProjects`.
- **One request per mount, plus Today.** The request lives in a ref outside the conditionally rendered chart.
  A refetch, pagination append, filter change or Project sheet close only changes deps and exits at the null
  check. `GanttNavToday` spreads `{...props}` after its own `onClick={today}`, so a consumer `onClick` would
  REPLACE the horizontal re-centre: `ProductionGanttNav` calls `useGanttNavigation().today()` itself, then
  re-arms the request.
- **Test seam.** happy-dom lays nothing out: stub `clientHeight` and a scroll-following
  `getBoundingClientRect` (a static rect makes "refetch leaves scrollTop alone" vacuous), and identify the
  vendor viewport by a `dataset.slot` read rather than a `[data-slot]` selector (test-seam guard F). There
  is exactly one viewport now: assert `toHaveLength(1)`, because an "all viewports equal" check over two
  (or zero) passes vacuously.

## Native scrolling needs one passive scroller; the sticky tree lives inside it (#722, #727)
Tags: gantt-calendar, css-tokens · #722, #727

- **A non-passive wheel listener turns the thread-scrolled path into a main-thread one.** The Timeline cancelled vertical wheel and forwarded it in JS to keep two panes in step. Under Safari GPU-memory pressure rAF fell to a few per second and the tree lagged or froze while the browser's own scroll (Table, Board) stayed smooth. Mirroring a second scroller from `scroll` events drifts under the same conditions, so neither "forward the wheel" nor "mirror passively" is a fix.
- **Make it one scroller.** The tree is a `sticky start-0` column and each column's header is `sticky top-0`, all inside one scroller, so there is one `scrollTop` to drift from and the browser scrolls it natively. The guard `reui/gantt/gantt-single-scroller.guard.test.ts` allows exactly one `scrollTop =` write in `gantt-view.tsx` (`revealRowNearest`) and one non-passive wheel listener (the zoom one; #728 gates it on a held modifier).
- **What sticky inside a scroller costs.**
  - The tree column must be `overflow-x-clip`, never `hidden`/`auto`: either would be its own scroll container and trap the sticky header (see the `overflow: hidden` lesson above). So the tree can no longer scroll sideways on its own; the desktop splitter minimum equals the columns (396px) so Name, People and Due always fit.
  - Everything that read "the pane" now measures an overlay that sits OUTSIDE the scroller: the splitter, a lane overlay (zoom control, offscreen chips) and a tree overlay (reorder indicator). `anchorZoomPointer`, drag clamping and edge auto-scroll use the lane overlay's rect, because the scroller's rect now spans the tree.
  - Track geometry subtracts the tree inset from widths only: `start` stays `|scrollLeft|`, `visibleWidth = clientWidth - inset`, `trackWidth = scrollWidth - inset` (`scrollerGeometry`). Any "not laid out yet" test is `visibleWidth <= 0`, not `=== 0`: an unlaid scroller reads negative.
  - The width is one CSS variable, `--gantt-tree-inset`, on the body; a splitter drag writes it once and the column, overlays, scroll-padding, the axis-group label offset and the horizontal scrollbar start all follow. Scroll-padding (65px top, the inset at the inline start) keeps focus and reveals from parking under the sticky parts.
  - The timeline column is `isolate` so bars, ghosts, the now line and dependencies cannot paint over the tree column.

Guards: `reui/gantt/gantt-single-scroller.guard.test.ts`, `reui/gantt/gantt-single-scroller.dom.test.tsx`, `reui/gantt/gantt-track-geometry.dom.test.tsx`.

## Icon-only rail (#426): what retiring the expanded rail left behind
Tags: css-tokens, reui-vendor · #426

- **Retiring a state retires its guards' targets, not the guards.** The expanded/collapsed split took
  the `quincy:shell:rail` preference, `isRailShortcut`, the vendor-patched ⌘B handler and the 260px rule
  with it. `config/retired-rail-collapse.guard.test.ts` fails the build if any non-test source names them
  again; the ⌘B rejection cases (Alt, Shift, repeat, IME, handled, editable targets) moved onto
  `isShellShortcut`/`isSearchShortcut` rather than being dropped, and `sidebar.dom.test.tsx` now asserts
  ⌘B does nothing and `sidebar.tsx` registers no keydown listener.
- **A pinned-closed `SidebarProvider` needs no `onOpenChange`.** The rail never toggles, so the provider is
  `open={false}` with no handler; the narrow Sheet is a separate variant, not a state of the same rail.
- **The rail no longer renders Dashboard views.** Tests that clicked a rail child now navigate through
  `locationStore().push(...)` (the transport `InternalLink` uses) because the Dashboard's segmented control
  is disabled mid-drag and absent while archived, which is exactly when those cases need a view choice.
  "The rail agrees" became "the Dashboard icon is current and the breadcrumb names the view".
- **A popover search needs its trigger opened first.** Wide `ShellSearch` is a popover; tests open
  `shell-search-trigger` before typing and, after an arrival that closes it, reopen it to read the draft,
  which lives in `dashboard-search-store`, not the DOM. With fake timers, reopen with
  `advanceTimersByTimeAsync`; a real-timer helper in a fake-timer test hangs until the 30s timeout.
- **A bell at the bottom grows upward.** The panel's top-aligned offset put it off-screen once the bell
  moved to the rail's bottom; `alignEndOffsetFor(triggerBottom, anchorBottom)` aligns its bottom edge.
- **The photo-grid breakpoint follows the rail width.** 72px rail + 5×205 + 4×14 + 64 = 1217px, not the old
  1405px; update the comment and the media query together.

## Dashboard tabs, toolbar search and view rename (#427)
Tags: search-filters · #427

- **Renaming a persisted route value keeps the old spelling readable.** Views are `table`/`board`/
  `timeline`/`calendar`; `list`/`kanban`/`gantt` still parse (to the new route, Timeline facets
  included), are never emitted, and `canonicalLegacyDashboardLocation` is the one predicate `ShellRoute`
  uses to replace an old address-bar spelling once. Stored `quincy:dashboard:view` goes through the
  normaliser on read and is written back new; the boot-timing beacon accepts both enums so an old-bundle
  tab cannot 400 it. The `quincy:dashboard:kanbanSort` storage key was deliberately not renamed.
- **Tabs are `role="tab"`, not buttons.** Selection is `aria-selected`, disabled is `aria-disabled`
  (Base UI keeps it focusable), and a click re-renders the tab: tests re-query `[role="tab"]` after every
  click rather than holding a ref, and query by role/name, never vendor `data-slot`.
- **The search lives in the Dashboard, so "off-Dashboard draft" means "typed, then navigated away".**
  Tests type into `dashboard-search`, leave through a rail link, and assert the store draft still rides on
  the rail's Dashboard href. The `Dashboard` mock in `App-navigation-rail-shell` mounts the real
  `DashboardSearch` with the shell's focus request, so ⌘K is exercised end to end.
- **⌘K is a focus request, never a navigation of its own.** Off-Dashboard it moves to the Dashboard (carrying
  the draft) and then focuses the field; on the Dashboard it only focuses (no history push). When the
  narrow Sheet is open it closes without returning focus to the hamburger, or it would steal the field back;
  an ordinary Sheet close still restores it.
- **The Display menu is a `reui/dropdown-menu` radio group.** A radio item leaves the menu open; tests open
  it with `openDisplay` and close it with Escape. Priority is offered, and accepted by the handler, only
  with the authorised board map, so a stored `priority` falls back to Board order otherwise.
- **The Active/Archived row went with #428**: the view bar now follows the heading directly, and Archived is
  a field of the shared Filter (see the #428 entry below).
- **Review round (#427).** One effective Board sort (`canPrioritize && hasAuthorizedBoardMap`, else Board
  order) feeds the menu and the cards. The Calendar/Timeline tabs in Archived scope leave Archived (a
  Calendar push bypasses `navigateCalendar`, whose closure still sees the archived scope). The tab row's
  rule is the view bar's own border: tabs stretch to it with `-mb-px` and `after:bottom-[-1px]`, and below
  722px the controls go above the tabs (`flex-col-reverse`) so the tabs stay on the rule. Display renders
  on every view, disabled off Board, so the search never moves. A pointer-focused tab is not re-focused by
  the focus-restore path (only a `:focus-visible` one is), or the global ring paints on a mouse click.

## #428 Shared Dashboard Filter (Stage, Priority, Archived)
Tags: search-filters · #428

- **The filter is the URL's, and only two route helpers touch it.** `dashboardFilterOf(route)` projects the
  `{ stageKeys, priorities, archived }` out of whichever arm carries it (Table/Board `filter`, Timeline `gantt`,
  Calendar state); `withDashboardFilter(route, f)` puts one back. `Dashboard` derives it at render: no state
  copy, no adoption effect (the lesson on state copies of the URL). Every writer that builds a URL from a route
  (`selectView` including the Calendar-entry branch, `navigateCalendar`, `navigateGantt`, the search writer,
  `handleCalendarAccessLoss`) carries it, reading `currentHistory.getLocation()` at fire time like the Timeline
  branch always did. The bare `/` and the Calendar intent arm carry no filter: a Calendar URL is canonical
  (date, sub, layers) before it can hold one, so tests append `&archived=only` to the canonical form.
- **Serialise -> parse -> serialise is a fixed point, and old URLs are byte-identical.** `priority` and
  `archived` are written right after `stages` in the one shared param writer, so every pre-#428 Calendar and
  Timeline URL round-trips unchanged (literal URLs are pinned in the shared `staff-routes` tests). Lists are
  canonical (`%2C`-encoded comma, `5,4,3,2,1,none`): a raw comma is a not-found, as for `stages`. `archived=hide`
  is never emitted and does not parse.
- **Archived is Admin-only on the server, not just in the UI.** `/api/projects`, Calendar and Timeline answer a
  non-Admin `archived=include|only` with 403 (the old `archived=1` is `only`, Admin only); a pasted URL from a
  non-Admin is read as Hide in the client and never sent. `Only` returns no Board map (`{}`); `Include`
  builds it from the active rows alone, so an archived card never shifts a Board position.
- **Stage and Priority filter in memory, after the order is fixed.** `/api/projects` filters `matchedRows` (where
  the search already filters), never `orderedRows`, so `boardRank` and the Board map do not change under a
  Priority filter. `editing` maps to the stored `editing_autohdr` the way `production-gantt.ts` does.
- **A narrowed Board does not drag.** `boardNarrowed = searchActive || priorities.length > 0 || archived !== "hide"`
  replaces the search-only gate for moves, reorders and `runBoardMovement`; a Stage filter alone does not narrow
  a column. A drop that still reaches the server on an archived Project is a 409 `project_archived_read_only`
  and rolls back like `project_stage_conflict`.
- **The dashboard-projects key's trailing object is `{ archived: mode, q?, stages?, priority? }`**, defaults
  omitted. `placeholderData` is gated on an equal mode: an Archived list must never flash as the Active list's
  placeholder. A Priority or Stage edit invalidates the cached entries that carry a `stages`/`priority` facet
  instead of patching a row into a list it no longer matches.
- **One state machine, two bars.** `lib/use-filter-query-binding.ts` holds the chip query, pending writes and
  the URL re-seed rules for both the Dashboard Filter and the Timeline's Editor/Show bar (Stage left the
  latter; it still carries the shared facets through every write). The Dashboard's trigger and chips are one
  `Filters` root (`DashboardFilterProvider`) rendered in two places; `FiltersRow builder={false}` is a Quincy
  addition to the vendored `filters.tsx`. The Filter locks with the same
  `movementInteractionActive || calendarInteractionBlocked` as Display; below 722px the trigger is icon-only
  with `aria-label="Filter"`.
- **Characterisation, not guard.** `project-search.test.ts` pins the Calendar SQL by SHA-256; changing
  `authorizedProjectsBaseCte` (archived mode and request priorities) re-pins it in the same commit. That is the
  fixture doing its job, not a loosened assertion.
- **Tests that mock `../lib/stages`** now need `presentationStages` too: the Dashboard builds its Stage options
  from it (`productionStageFilterOptions`).

## #422 Deadline uses the date-time popup
Tags: scheduling · #422

- **The Deadline editor is the popup, not a form beside it.** `ProjectDeadlineControl` is now a mutation
  adapter (version, 409, Clear confirm, Resume, query owner) around `DateTimePopup`; the header and the
  Timeline cell render it inside `DateTimePopoverContent`, and the Calendar Reschedule / Timeline Set-Fix
  dialog embeds `DateTimeField variant="date-time"`. Tests drive it through `testing/date-time-popup.ts`
  (roles and names only), never `Deadline date` / `Deadline time` inputs.
- **A seeded draft is already dirty, including a seeded clear.** A 409's Review-and-reapply seeds the popup
  with the attempted draft; `seed.localCivil === null` must start as `clear`, or Apply on an untouched
  draft just closes and the clear is silently dropped.
- **A popover inside an alert dialog needs a higher layer.** `--z-popover` (90) is below `--z-dialog` (95),
  so `reui/popover` takes a `positionerClassName`; the Move dialog passes `z-[calc(var(--z-dialog)+1)]`.
  Escape on a control inside the popup closes the popup only (dispatch it on the focused element, as a real
  key press would, not on `document`).
- **Do not install a `getAnimations` stub suite-wide.** It makes a closing Base UI popup unmount one tick
  later, which NotificationBell's synchronous assertions caught. `testing/dom-polyfills.ts` is imported by
  `testing/date-time-popup.ts` only, so just the files that render the popup get it.
- **Reminder offsets travel with the dialog draft.** `submitMoveDialog(localCivil, disambiguation,
  reminderOffsetsMinutes)` carries them through the drop/place retry paths and the no-op check (a
  reminders-only edit is a change); a rejected attempt reopens the dialog on the whole draft.
- **A tall popup must not fall back to the side axis.** The date-time popup (~530-680px) fits neither below nor above
  a field in a dialog, so Base UI opened it to the right, half off the dialog. `DateTimePopoverContent` passes
  `collisionAvoidance={{ fallbackAxisSide: "none" }}` so it stays above/below and its body scrolls.
- **The saved-schedule line is not the draft.** In the editable popup the next-reminder line is labelled "Currently saved:
  next reminder", drawn locally as "Wed 7 Oct · 16:00" (not `formatSydneyInstant`, shared with notifications) and
  quietened once the draft differs; the three-line reminder summary is read-only only.

## #423 Every Subtask end is a moment
Tags: scheduling · #423

- **A shared popup that serves two callers must keep Cancel and close apart.** The range popup's
  `onClose` runs after a successful Apply and on Cancel; the Checklist keeps a failed save's draft for the
  conflict review, so only Cancel (`onCancel`) discards it. Discarding on every `onOpenChange(false)` lost
  the retained draft on Escape and on an outside press.
- **Base UI closes a popover on an outside press.** Tests that used to write a draft, then click a
  checkbox or a title with the popover still open, must reopen it: the retained draft survives, the open
  popup does not. A popup's `aria-label` also trails a title change by a render, so find it by its
  `subtask-popover-<id>-schedule` id when the title changes under it.
- **An untouched Apply only closes.** A range popup whose draft was never edited calls no `onApply`, so a
  test (or a user) that needs a PATCH has to change something first.
- **Read a cached value with no observer.** `useProjectSubtaskDefaultRange` subscribes to the query cache
  and calls `getQueryData`. An observer (`useQuery({ enabled: false })`) rebuilds its entry after a principal
  clear or a Project removal, which `project-access-termination.dom.test.tsx` caught.
- **The external list schema is strict and now requires `projectDefaultRange`.** A mocked external
  checklist response without it fails decoding, and the screen sits on "Loading checklist…" with no error.
- **A date-picker pick on a range popup does not set both ends.** Picking while Start is active sets the
  start, pulls the end onto that day only when it was earlier, and hands the toggle to End; a second pick
  sets the end. Tests that want a one-day range at a new date pick the day twice.
- **A stored fold is only a choice while the minute repeats.** `foldChoiceFor` keeps `disambiguation` out of
  an editor draft for a unique minute; otherwise every untouched save sent `earlier` for every end.
- **Hand-built `{ kind, instant: null }` schedule DTOs cannot come back.** Fixtures go through
  `testing/subtask-schedule.ts` (`presetScheduleDto`, `momentScheduleDto`), which runs
  `normalizeChecklistSchedule`, so a fixture is what the API would return.
- **The migration is pure SQL and bounded to 2008-2040.** The DST rule is hard-coded; the preflight in
  `docs/Guides/CI-Deploy.md` ("Subtask presets (0052)") is what guards the floor, and
  `migration-0052.test.ts` proves every day in that window against `normalizeChecklistSchedule`.

- **A range `Calendar` with `selected` and no `onSelect` is uncontrolled.** react-day-picker kept its own
  highlight after a shortcut or an endpoint edit changed the draft. `CalendarPane` passes a stable no-op
  `onSelect` so the grid mirrors the draft; picks arrive through `onDayClick`.
- **A migration's rollback needs the executor's transaction to be tested.** `db.exec(file)` autocommits each
  statement, so `migration-0052.test.ts` applies the file inside one `BEGIN`/`COMMIT` (as D1 does) to prove a
  failing ALTER undoes the UPDATE.

## #429 People, dates, Overdue and My tasks in the shared Filter
Tags: search-filters · #429

- **`mine=1` changed meaning.** It is "People = me" in every view: Table/Board = I am an Editor or assigned an OPEN
  Subtask; Calendar/Timeline Deadline items = I am an Editor, Subtask items = assigned to me. It used to mean Subtasks
  only on the Calendar, so a pre-#429 `mine=1` link now also keeps Deadlines of Projects the viewer edits. The session
  user is always the server's, never a client-supplied id. **Amended by #680 (Timeline only):** a Timeline
  Subtask item matches when I am an Editor of its Project OR assigned to it, so a Project I edit lists all its Subtasks.
  See "My tasks on the Timeline lists every Subtask of a Project I edit (#680)".
- **Unassigned alone used to narrow nothing on the Calendar.** The old `selected.requested = 0 OR selected.valid = 0`
  gate read "no valid person" as "no filter", so `unassigned=1` with no editors returned everything. The gate is now
  "a person filter is active when a valid person is picked OR Unassigned is on". Do not reintroduce a
  "no valid ids -> pass through" shortcut.
- **One People source.** `dashboardPeopleCte` (`lib/production-scope-sql.ts`) feeds `GET /api/dashboard/people` and the
  id validation of every endpoint, so a chosen person can never drop out of the options. It includes inactive users
  (labelled) and, for an External Editor, team-member assignees only. An unknown id is dropped; all-unknown with no
  Unassigned means People is not applied.
- **A Project row can be on the Timeline only as context.** Under People / My tasks a Project is listed when its
  Deadline matches OR it has a visible matching child; the second case sets the request-gated `dm=1` mark so the
  adapter does not draw an unmatched Deadline bar. The child-page cursor carries a fingerprint of the People / My
  tasks filter, so a continuation that repeats a different one is a 400.
- **The vendored `Filters` cannot preselect an operator.** `defaultOperator` is only a fallback, so a valueless field
  (My tasks, Deadline "is overdue") is field -> operator -> committed, two clicks, not one.
- **An always-mounted live region.** The Filter chips' status ("0 filters applied") is always mounted, so a test
  that asserts "no announcement" with `querySelector('[aria-live]')` now sees it; exclude
  `[data-testid="dashboard-filter-chips"]`.
- **Fetch harnesses that hand the first reply to the first request.** The People options request is issued after the
  Projects one on purpose (`useDashboardPeople` follows `useDashboardProjects`/`useDashboardProjectSearch` in
  `Dashboard.tsx`); a `mockResolvedValueOnce` list reply must still reach `/api/projects`. People options refetch only
  on a team or assignee commit (`invalidateProjectSurfaces({ people: true })`), not on every priority or stage edit.
- **The URL is the source of truth for People on the Calendar.** `Dashboard` spreads the route's shared filter over the
  Calendar state, so a test that passes `calendar={...editorIds}` with a bare location silently loses the Editor.

## #431 Dashboard Table on the ReUI data-grid
Tags: reui-vendor · #431

- **`manualPagination: true` is mandatory.** The vendored grid's default page size is ten; without it the Table
  silently shows ten Projects. Sorting is `manualSorting` too: `sortTableRows` (pure, in
  `lib/dashboard-table-model.ts`) sorts before grouping, with missing values last in both directions and ties kept
  in the server's order. A header click cycles ascending, descending, cleared (back to server order).
- **Cells read volatile values from context, never from the column closure.** The grid renders `columnDef.cell`
  as a component, so a column array rebuilt per render (a fresh `onPriorityChange`, a new `pendingOrdering` set)
  hands React a new component type per cell and remounts every row: lost focus, a closed Deadline popover, a
  restarted cover retry on any refetch. Columns depend on the width bucket alone; the rest travels by `CellContext`.
- **The row opens through a real link, not `onRowClick`.** The Address cell's `InternalLink` stretches over the row
  with `after:absolute after:inset-0` (`tr` is `relative`); stars, the Deadline trigger and the cover retry sit in
  `relative z-[1]` wrappers outside the `<a>`. A bare `<tr onClick>` has no keyboard path.
- **A popup portalled out of a row still bubbles through React to the row.** The Deadline popup's clicks must never
  navigate; the Dashboard-table suite presses inside the popup and asserts the URL is unchanged.
- **`safeStaffDestination` only intercepts a Project id that parses as a staff route.** A fixture id like `p2` is
  not-found, so `InternalLink` falls through to the browser; link tests use a UUID. happy-dom also performs an
  anchor's default navigation itself, so assert `defaultPrevented` rather than the pathname alone.
- **An External Editor's Dashboard list goes through a strict DTO decoder** (`externalApiGet`). A DOM suite that
  only wants the Table mocks `lib/external-api-response`, or the query never leaves pending.
- **Collapsed groups belong to the Group by they were collapsed under.** Keep the key beside the set and reset it
  during render when the Group by differs, or switching Stage -> Client -> Stage revives the old collapse.
- **Per-viewer prefs live in `localStorage` under `quincy:dashboard:table:<principal>`**, normalised on read, every
  access in try/catch. Role-invisible columns (Priority for an External Editor) and the narrow-screen set are computed
  at render and never stored, so a saved choice survives a role or width change.

## #424 Subtask reminders fire
Tags: scheduling, notifications · #424

- **Decide the recipients when the reminder fires, not when it is scheduled.** The occurrence row is keyed by the Subtask
  and its `schedule_version`, never by an assignee, and the fire batch joins the assignee relation. Storing recipients at
  schedule time would miss a late assignee and remind a removed one.
- **Every write path uses one SQL builder.** `buildSubtaskReminderMaterialization` is used by create, reschedule, offset
  change and the hourly reconcile, and migration 0053's backfill is a literal copy pinned to it by a parity test. Two
  hand-written copies of "which occurrences should exist" drift.
- **Retiring a producer is a cutover, not a delete.** The 08:00 scan stays safe only because 0053 suppresses undelivered
  legacy due-today rows, delivery refuses a late one, and a Subtask whose legacy alert was already sent gets no
  occurrences. `subtask-due-today-retired.guard.test.ts` fails if a due-today producer returns.
- **Apply-then-deploy leaves a window.** An old Worker saving a Subtask between the 0053 apply and the deploy writes no
  occurrences; the hourly reconcile heals it. Log the inserted count: non-zero is a warning, not normal.
- **A new audit `target_type` must be planted in the QA seed.** `qa-seed-app-rows.ts` enumerates every `audit(...)`
  target type the workers write; the reminder fire adds `project_subtask_reminder_occurrence`, and the planted audit row
  needs a real occurrence row to target or teardown (which follows captured ids) leaves it orphaned.
- **A partial PATCH must not reset the other switch.** The preference upsert uses `COALESCE(?, existing)` per column and
  `COALESCE(?, 1)` on insert, and the screen sends one switch per request.


## #430 Calendar and Timeline join the shared Filter and Display
Tags: gantt-calendar, search-filters · #430

- **Display content per view.** Calendar: Layers (Project deadlines / Subtasks) then Show (delivered Projects / completed Subtasks). Timeline: Show only. Board and Table are unchanged. `completed=` and `delivered=` are real server filters on both views, so they keep a control (Show) rather than going URL-only; the Calendar's Show is a deliberate departure from the issue's "Layers only".
- **No parser or serialiser change.** Old Calendar and Timeline URLs resolve byte-identically (cold-URL tests in `Dashboard-calendar` and `Dashboard-gantt`). Display writes go through `navigateCalendar` / `navigateGantt`, so every toggle pushes.
- **The Delivered pair now runs from Display.** `writeTimelineDisplay` -> `ganttFacetForWrite` -> `ganttPairingNotice` -> `setAnnouncement`. The visible pair notice is gone; only the Dashboard live region announces it.
- **Last layer disabled.** The only checked Calendar layer is `disabled`, and the handler also refuses an empty set. Layers are written in canonical order (`project,checklist`).
- **Gantt empty-state focus.** The Filter and Display triggers are outside the lazy Gantt, so it takes `focusFilterTrigger` / `focusDisplayTrigger` callbacks (Dashboard queries by `data-testid`). Clear filters -> Filter trigger; "Show delivered projects" -> Display trigger. The scroll-after-render flag now scrolls whichever trigger got focus; both triggers carry the `scroll-mt` that clears the sticky header.
- **Test-mock trap.** A Calendar mock that always answers with fixed `appliedFilters.layers` makes the Dashboard's reconcile rewrite the URL back after a layer toggle. Echo the requested layers.
- **Base UI checkbox items** keep the menu open; Display state is per view and is dropped on a tab switch.
- Follow-up (not done): `useFilterQueryBinding`'s `forWrite`, `noticeFor`, `reconcile` options have no caller left.

## #432 Board cards on `frame`
Tags: board-dnd, reui-vendor · #432

- **dnd-kit's post-drag click suppression only calls `stopPropagation`.** With the card's link as the drag handle,
  the click that follows a drag still reaches the anchor's default action and does a full page load. The Board adds a
  capturing `window` click listener on drag start that `preventDefault()`s and `stopPropagation()`s, and removes it
  ~100ms after the drag ends or cancels (and on unmount).
- **Nest the handle inside the context-menu trigger, never the other way round.** Base UI's `ContextMenuTrigger`
  stops `touchstart` propagation, so a handle beneath it never sees the touch that begins a long-press drag. Also
  `preventBaseUIHandler()` on its `touchstart` and on a touch- or drag-originated `contextmenu`, or its own 500ms
  long-press opens a menu over a live drag.
- **A Base UI prop override needs a present `undefined`.** `KanbanItemHandle` spreads `role="button"`,
  `tabIndex`, `aria-pressed`, `aria-roledescription` and `aria-disabled` onto the anchor; `mergeProps` lets an
  explicit `undefined` win, an omitted prop does not. A test pins that the link keeps its own role.
- **A menu's focus return decision is made as it UNMOUNTS, after `onOpenChangeComplete`.** Resetting the "Move to…
  pending" flag in that callback made `finalFocus` see `false` and return focus to the ⋯ trigger over the dialog.
  The flag stays set until the dialog closes, and the dialog gives focus back to ⋯ itself.
- **`AnchoredPopover`'s focus order puts the reference first**, so `initialFocus={0}` focuses the anchor. The Move to…
  dialog uses `initialFocus={1}` (the panel): a focused option would unmount when the step swaps, dropping focus out of a
  modal.
- **An empty menu has no trigger, but a locked one must stay.** Search, a settling refresh and a 503 switch movement
  off; the ⋯ must remain, disabled, rather than vanish and reappear. The Board takes `menuCapable` (the principal's raw
  capability) for that; a principal with no capability gets no ⋯ at all.
- **Collapse is disabled for the whole of a drag.** Mounting and unmounting droppables under
  `MeasuringStrategy.Always` is the re-measure loop #185 banned. A collapsed rail is still a `KanbanColumn`, so a drop
  on it appends to that Stage's end, but it mounts no cards.
- **Overdue means `isOverdueProject`, everywhere.** Delivered and archived Projects are never overdue, so the column
  figures sum to the Dashboard header's. The card used to colour them red on date alone.

## #447 Date popup on a phone
Tags: scheduling, qa-browser · #447

- **`collisionAvoidance` `side: "shift"` gives `--available-height` the whole viewport.** With the default `flip`, Base UI's
  `size()` measures the sliver above or below the trigger (~165px at 375x812), so a tall popup's body had a tiny scroll
  window. Below `sm`, `DateTimePopoverContent` shifts instead and may cover its trigger.
- **A nested scroll-area body needs `min-h-0` at every flex level.** `Frame` (`max-h-[var(--available-height)]`) > `FramePanel`
  > `ScrollArea` root each need `min-h-0` (and `flex flex-col` on the first two), or the viewport grows to its content and the
  footer is pushed out instead of the body scrolling. The fade targets the viewport with `*:` (direct child), so the time
  column's own scroll area gets none.
- **A truncated title in a `w-auto` popover needs `contain: inline-size`.** The popover sizes to its widest content, so a long
  label widens the popup rather than truncating. `[contain:inline-size]` on `FrameTitle` removes the title from that
  calculation; `min-w-0` plus a `block truncate` eyebrow then clips it. The full text stays in the DOM and in the `aria-label`.

## #450 Checklist rail is read-only on an archived Project
Tags: permissions · #450

- **The rail knows it is archived from a prop, and from a latch after a 409.** `ProjectWorkspace` passes
  `archived={Boolean(project.archivedAt)}` down; a write refused with 409 `subtask_project_archived` (#448) latches the rail
  read-only at once and refetches `detail`, `subtasks` and `activity` (with dashboard, calendar and gantt) so the header and the
  other surfaces catch up. The latch clears when the prop goes true to false (Restore). Two gaps, both failing safe: the
  collaboration-only view has no `archivedAt` in its summary DTO, so its rail turns read-only on the first refusal rather than on
  load; and a refetch that comes back un-archived (archived and restored inside one window) leaves the latch on until remount.
- **Lost focus is decided in a layout effect, from a capture taken when the request starts.** `disabled={busy}` applies when the
  request starts, but the refusal lands later and the controls unmount in the flip commit (a title input already unmounted at
  blur), after which the Project sheet's `FloatingFocusManager` can take focus to the sheet popup, an ancestor that contains the
  rail. So each write records whether focus was inside the rail at request start, and on a 409 flip focus goes to the always-mounted
  collapse button when that was true and focus is no longer on a connected element inside the rail, or when it is `<body>` or
  `:disabled` (Chrome resolves a focused control that becomes disabled to `<body>` a frame later). `section.contains()` is not
  used alone because the schedule popover and assignee combobox render in portals. It runs in a `useLayoutEffect`: a
  `setTimeout` loses to the sheet's focus manager. Only on a 409-driven flip, never on load.
- **Clearing the rail's in-progress state is keyed on `readOnly` going false to true, not on the 409.** The detail query refetches
  every 30 seconds and on focus, so `archived` usually arrives with no 409. An open composer, title edit, drafts, schedule errors
  and schedule popover are cleared on that edge (a held schedule popover also keeps the subtasks poll off and would reopen with
  focus on Restore). Only setting the latch, the invalidation and the focus fallback stay 409-only.
- **The reorder handler's bare 409 branch would otherwise win.** `isArchivedRefusal` is checked first in all four catch blocks
  (update, add, remove, reorder); a reorder refusal also skips `scheduleReorderFocus`, whose fallback target
  (`subtask-add-<id>`) no longer exists.

## #452 Archived Projects get a read-only TEAM field, and the header Stage reads as a value
Tags: permissions · #452

- **One refusal code for every membership write: 409 `membership_project_archived`.** Both add routes and both remove routes
  (`/photographers/:userId`, `/editors/:userId`) refuse on an archived Project, whatever else is true of the request. It supersedes
  #446's `subtask_project_archived` on the removal path: the refusal is about the Project, not the Checklist, and two codes would
  make the answer depend on whether the member happened to hold assignments. The fence is inside the D1 batch (an
  `EXISTS (... archived_at IS NULL)` on the add INSERT and on the remove DELETE, so the audit, outbox, ledger, activity and
  timestamp statements that depend on the row write nothing), plus a trailing `SELECT archived_at` snapshot as the last statement.
  Never reorder or drop batch statements: results are read by position. Classification is archived first (over stale, ineligible,
  unchanged and `confirmation_required`), so a repeated PUT of an existing member on an archived Project is also a 409.
- **Tonomo's photographer insert is fenced too.** `assignPhotographers` (`workers/background/src/tonomo/process.ts`) runs on the update
  path after `findProject` has read the Project live, so an archive can land in between. Its insert is now
  `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)`, and the audit row lists only
  photographers who are actually members. The test archives from the `getMetadata` dependency, which runs in exactly that window.
- **Left out of the fence on purpose:** initial members at `POST /projects`, Tonomo default-editor adds (create-time only), and
  hard delete (a Project deletion, not a membership change). Restore adds nobody and a test pins it.
- **Accepted consequence: role changes get harder.** `users.ts` blocks a role change while the user holds an incompatible
  membership, and that check includes archived Projects. An Admin who must clear such a blocker now has to restore the Project,
  remove the member, and archive it again. Excluding archived memberships from that blocker is a separate change.
- **External Editors are unchanged.** `hasProjectAccess` hides archived Projects from them, so the membership routes answer 403
  before any archived logic runs (and they lack `editProject` anyway). The "404" in the #452 issue text is the Subtask routes'.
- **The web latch refetches `detail` explicitly after `fail()`.** A `fail()` with nothing committed does not refresh the detail
  (`project-data.ts` `settle`), so without the explicit `invalidateProjectSurfaces` the header would keep showing an editable
  Team. Order matters: `fail()` first, then the invalidation. The 409 branch is checked before the confirmation loop and the
  generic error branch in both `add()` and `remove()`, and shows no Retry (and none while read-only), since a retry could only 409.
- **Focus goes to a `role="group" aria-label="Team"` wrapper (`tabIndex={-1}`), decided from a capture at request start.** The
  capture covers the chips root and the portalled `ComboboxContent` (give it a ref; `root.contains()` alone misses the portal).
  In a layout effect keyed on the latch, focus moves there only when the capture was true and the active element is `<body>`,
  `:disabled`, disconnected or outside both. Never on load. Base UI focuses the input on a chip-remove press and an option press,
  so a "focus elsewhere at request start" case cannot be driven through the real UI in a DOM test.
- **The post-409 focus move fires only on genuinely lost focus** (`<body>`, disabled, disconnected, or an ancestor containing the Team control or its portal). Focus the user moved to another connected, enabled control while the request was pending is left alone; an "outside the control" test alone yanked it back.
- **Read-only empty Team shows a "—"** (aria-hidden, header value tokens) beside an sr-only "No team assigned"; live Projects keep "Not assigned"
  for non-editors. Same gap as #450: a Project archived and restored inside one refetch window keeps the latch until remount.
- **Gantt Team popover race is accepted:** after the refusal the Gantt refetch turns `canEditTeam` false, the popover unmounts and
  focus falls to `<body>`. The popover also passes `archived={Boolean(detail.archivedAt)}` from the loaded detail, so a Project
  archived since the row was drawn opens read-only rather than waiting for a 409 (no DOM test: the Gantt suites do not drive the
  Team popover).
- **Header read-only Team is sized by the header, not the control:** `ProjectHeader` passes `rowClassName="min-h-[44px]"` (named `readOnlyClassName` until #458) so the
  chip row lines up with the 44px triggers beside it; the Gantt popover keeps the compact row. The notice is capped at `28ch` so it
  wraps rather than widening the column. The notice class is shared with the Checklist line (`archived-notice.ts`).
- **Header Stage on an archived Project** (and for any role that cannot move Stage) renders through `StageOption` instead of
  `StatusBadge`, whose label is hard-wired to the `.ey` eyebrow class (uppercase, wide tracking). Same text, value styling.
- **Out of scope, worth a follow-up:** the header's "Edit details" link and Deadline trigger still render for an Admin on an
  archived Project.

- **Entering read-only clears the assignee picker's own edit state, without its committing close.** The read-only branch removes the
  Combobox but `open`, `draftRef` and `baselineRef` are local, so a popup left open with picks would reopen on Restore and commit
  them. `SubtaskAssigneePicker` closes and resets the draft to baseline in an effect on `readOnly`, and sends no write.
- **The post-409 focus fallback only fires when focus was lost.** `body`, `:disabled`, disconnected, or an ancestor containing the rail
  (the sheet's focus manager); a connected, enabled control outside the rail (the comment editor) the user moved to keeps focus.

## Team picker list clipped by the vendor chips `min-w` variant (#456)
Tags: reui-vendor, css-tokens · #456

- **Override the plain property, not the variant.** `reui/combobox.tsx` floors the popup with `data-[chips=true]:min-w-(--anchor-width)`.
  twMerge keeps it next to a consumer `min-w-[...]` (different variant), and it wins on specificity (0,2,0 vs 0,1,0), so the popup
  stayed as narrow as its content-sized chips anchor. Override `w-` instead: twMerge drops the vendor `w-(--anchor-width)`, and
  `max-w-` still caps it. Matching the variant (`data-[chips=true]:min-w-...`) would tie the fix to a vendor attribute, and a
  `min-w` floor beats `max-w` on small screens. The DOM test pins the merged class string only; the browser pass proves pixels.
- The chips input is `w-[12ch]` (was 6ch, too narrow for "Add…"); it does not grow on focus because the box is the popup's anchor.

## #459 An archived Project's cover is read-only, and the legacy dropbox-sync route is gone
Tags: permissions, dropbox · #459

- **One refusal: 409 `cover_project_archived` on `POST /projects/:id/cover`, for a set and a clear alike.** Order: 400 bad id, 403 access, 403 capability, 400 input, 404 Project, then archived (which wins over the asset 404), then the asset check. The write is one `DB.batch` read by position: `[0]` the `UPDATE ... WHERE archived_at IS NULL RETURNING id`, `[1]` the audit INSERT fenced on `changes() = 1` (same `project.cover.set` action, `auditMeta` keeps `impersonatedBy`), `[2]` a trailing `SELECT archived_at` snapshot. Never reorder them. If `[0]` returned no row, the snapshot classifies it: archived is 409, row gone is 404, and a row that is present and not archived is a retryable 409 `cover_conflict` (archived then restored inside the write; the real batch is atomic, so the test re-takes the snapshot after the restore to reach it).
- **An unknown Project id is 403, not 404, for an Admin.** `hasProjectAccess` resolves a visible Project first, so the 404 branch only fires on a Project deleted between that check and the batch. The #459 plan said 404; the code says 403 and the test pins it.
- **`assets.ts` (cover cleared when its asset is deleted) is deliberately unfenced.** Deleting an asset is not a cover edit, and clearing a dangling reference on an archived Project is housekeeping that must not fail.
- **Web follows #450/#452.** `CollectionTabView` latches on a 409 with the code (checked first in `updateCover`, no toast), refetches detail and activity, and drops the latch when `archivedAt` goes set to unset. `canSetCover` is false while archived, so an archived-on-load Project never shows the control. The status notice appears only while latched. `PhotoGrid.onSetCover` resolves `"archived"`; the grid captures at click time whether focus was inside the tile, and a layout effect keyed on `canSetCover` going false moves focus to the tile only if focus was lost (`<body>`, disabled, disconnected, or an ancestor containing the tile). Never on load.
- **`POST /projects/:id/dropbox-sync` was removed** (web stopped calling it in 85e15fe1), with its manifest entry and probe line. `/sync-dropbox` is the live route.
## #455 Archived Projects get a fully read-only header
Tags: permissions · #455

- **Two new refusal codes, both 409.** `PATCH /projects/:id` answers `details_project_archived` (checked right after the 404, before the services-blocked 409, and again in the batch-loser branch right after the re-read, before the match/services classification, so an archive that lands inside the batch is not reported as "changed while saving"). `POST /projects/:id/sync-dropbox` answers `dropbox_sync_project_archived` (the old precheck 409 had no code; the "nothing to sync" 409 is unaffected). Batch positions did not move. A missing id answers 403 for an Admin too (`hasProjectAccess` runs before the 404), so a "missing id is 404" test is wrong for this route. Deadline needed nothing: `deadline_project_archived` already existed.
- **The header owns one latch: `null | "stage" | "deadline" | "dropbox"`.** `archived = Boolean(project.archivedAt) || latch !== null` flips the whole row (Stage, Team, Deadline, Dropbox, the details link) at once instead of one control per refusal. It clears when `archivedAt` goes truthy to falsy and when the Project id changes. Focus follows the #450/#452 rule: from a capture at request start (including a portalled popup), moved to the source's `role="group"` only if it was lost (`<body>`, disabled, disconnected, or an ancestor that contains the group); never on load.
- **Order matters in `ProjectDeadlineControl`'s refusal path.** Report (`onArchivedRefusal`), flip read-only (`refusedArchived` also flips a header-less caller, the Gantt cell, in place), release the query owner, and only then invalidate the detail. `runtime.acquireOwner` defers an invalidation while an owner holds the key, so invalidating first leaves the header showing the live Deadline. Apply then throws `ApplyDeclined` (no message); Resume returns. A version 409 is still "Deadline changed elsewhere."
- **A header popover must be closed on the read-only edge.** `ProjectHeaderDeadline` and `ProjectHeaderDropbox` reset `open` in a layout effect when `archived` becomes true, else Restore reopens the popover (with focus on the control) because `open` is local state.
- **Dropbox archived reads "Not monitored" whatever the folder facts say** (the monitor skips archived Projects), with an inline "Open in Dropbox" link kept for viewing. The sync callback resolves `"archived"` instead of toasting, after invalidating the surfaces; the header latches on that value only.
- **Details link:** an archived Project shows "Restore or delete" to an Admin with backend access and nothing to anyone else, since `EditProject` is the only UI path to Archive / Restore / Delete.
- **`EditProject` on an archived Project hides the form and Save** behind a `Notice tone="caution"`, keeps the Danger zone, and reads "Archived project". A Save refused as archived latches the same view, re-reads the Project (so Restore appears), invalidates the surfaces and shows no error. Focus goes to the heading only if it was in the form at Save. The "inside the form" check uses `closest("#edit-project-form")`: in jsdom `form.contains(ownControl)` answers false (the form wrapper is a Proxy whose identity differs between lookups), which a DOM test cannot tell from a real focus loss.
- **The ui-primitive ratchet matches a literal `role="listbox"`.** The Stage capture needed "focus is in the Select's portalled popup" without writing that attribute, so it reads the trigger's `aria-controls` and checks the element it names.
## Calendar sheets: the vendored close collides with the header (#462)
Tags: gantt-calendar, reui-vendor · #462

- **Why the vendored close was replaced.** `reui/sheet`'s `showCloseButton` pins a 28px close at top/right 12px over the header, so the
  Schedule editor's long street and the rail sheet's title ran under it, and on phones the target was far below 44px. Both calendar
  sheets pass `showCloseButton={false}` and render `quincy/SheetCloseButton` (`SheetClose` + `reui/button`, 28px desktop / 44px at
  <=721px) with `SHEET_CLOSE_CLEARANCE` reserving the header's end padding (48px / 64px). Desktop schedule-editor header end padding
  went 32px -> 48px on purpose. No vendor edit.
- **The close must be the LAST child of `SheetContent`.** Base UI's default initial focus is the first tabbable in the popup; a close
  rendered first takes focus on open instead of the form.
- **Phone rail header height uses the allowlisted `min-h-[44px]` on the title**, not a `min-h-[calc(...px...)]` on the header:
  `dashboard-fill.guard` rejects px heights in `ProductionEventCalendar.tsx`. Header `py-[var(--space-3)]` + 44px title = 68px.
- Pinned before the change: one click and one Escape each fire `onCancel` once; the new tests assert the same.
## Team picker drew two focus indicators (#458)
Tags: focus-overlays · #458

- **A layered `outline-none` cannot beat the unlayered base rule.** `tokens/base.css:25-28` sets `:focus-visible { outline }` outside any
  layer, so `ComboboxChipsInput`'s `outline-none` lost and the input painted a square outline inside the `ComboboxChips` pill, which
  also painted its own `focus-within:ring-3`. Two shapes, one focus. The fix: the pill draws the one indicator (token outline, on
  `has-[input:focus-visible]`, so a focused chip x or "+N" keeps its own outline and the pill stays quiet), and the input
  uses `focus-visible:!outline-none` (precedent `InputGroupInput`). Vendor divergence 7 in `reui/combobox.tsx`, tagged `QUINCY ADDITION (#458)`.
- **`reui-skin.guard.test.ts` now fails on a ring WIDTH under any focus variant** (`focus:`, `focus-visible:`, `focus-within:`, `has-[..focus..]`,
  `group-`/`peer-` forms). A `data-[focused=...]` attribute variant is app state, not focus, and passes. Known latent double indicators
  (`switch`, `field`, `item`, `scroll-area`, cascader x4) sit on a shrink-only exception list; they are not fixed here.
- **Header height.** `ProjectTeamCombobox`'s `readOnlyClassName` became `rowClassName` and applies to the editable box too; the header
  passes `min-h-[44px]`, the Gantt popover passes nothing and stays compact.

## Project sheet title ran under the close button (#460)
Tags: css-tokens · #460

- The sheet's close x is `position: absolute` (right `--space-4`, 44px) over the body, and `.project-header__identity > h2` had
  no inline-end clearance, so a long title slid beneath it. The fix is `padding-inline-end` on the h2 scoped to
  `.project-sheet__body`, mirroring the `.worktools` reservation; the header's own side padding is subtracted so the gap is
  exact. The phone value sits in a `max-width: 720px` block placed AFTER the base rule, because both have equal specificity
  and source order decides. Values are coupled to the close offset/size in `ProjectSheet.tsx`; `overflow-wrap: anywhere` lets an
  unbroken title wrap inside the reduced width. Pinned by CSS-text assertions in `styles/app-railed.test.ts`.

## Show in Calendar / Timeline from the Project sheet (#464)
Tags: gantt-calendar, routing · #464

- **`focus=<project id>` is a one-shot request, not view state.** It rides on the Timeline and Calendar-facet routes only (written last,
  after `q`; beside `calendar`, not inside `DashboardCalendarState`), so every pre-#464 URL stays byte-identical. The Dashboard
  captures it into a token-carrying request when its location gains `focus`, hands it to the matching view only, and `replace`s the
  location without `focus` once the view reports its ONE outcome (and only if the live location still names that Project). Keeping
  it in the URL would make "open the same Project's sheet and choose the same item again" a no-op (identical URL, no location
  change) and make Forward re-land. Because the request lives in Dashboard state, the Calendar's filter-reconcile `replace`
  (which carries a still-pending `focus`) and the strip itself cannot cancel a landing in flight; user writes drop it.
- **The router is read-only, so the control is an `InternalLink`, never `useNavigate`.** The control is the ReUI `c-button-group-1`
  composition (`reui/button-group` + `reui/button` rendering `InternalLink`), NOT a dropdown: the installed `reui/dropdown-menu`
  portals to `body` under the sheet. A plain click is an SPA push through `locationStore()` (Back returns to the sheet); Cmd-click
  and "open in new tab" are native. The sheet's `DashboardLayer.finalFocus` returns `false` while the live location is a Dashboard
  route carrying `focus`, so the opener does not steal focus the landing is about to place.
- **Broaden filters only where the Project's own data makes the hide certain** (Delivered stage, archived for an Admin, a completed
  target task). Anything else a filter hides is the Dashboard's "isn't shown with the current filters" notice (`role="status"`,
  Clear filters focused, Dismiss). Clear filters also clears `q`, keeps what the sheet already broadened and the Calendar's layers,
  and pushes the same view WITH `focus`, so it re-lands. The street comes from the query cache read with `getQueryData` (no
  observer, #423), falling back to "That Project" on a cold link.
- **Calendar landing**: Deadline, else the checklist item on the route date, else the earliest in range. The request ref survives
  `resetKey`; only the user's own navigation ends it (and clears the highlight). A chip folded under "+N more" has no DOM
  element, so focus goes to that day's control (the surface tags its `renderMoreIndicator` with `data-more-event-ids`) and the
  announcement says it is folded. The highlight is an OUTLINE: every chip already spends its inset ring and shadow on its
  rest/selected treatment, so a second inset ring would fight them.
- **Timeline landing** walks pages through the existing scroll-paging latch until the Project is found, the walk completes
  (`hidden`) or the draw cap stops it (`too-many`); a user filter change mid-walk reports `cancelled`.
- **A frozen visibility inventory flagged the new control, correctly.** `ProjectWorkspace.external-visibility` rendered Show in's
  disabled "Nothing scheduled" reason for the external fixture (no shoot date) but not for admin (has one): a fixture difference,
  not a leak. The fix was to give the external fixture a shoot date and re-freeze both literals (only Show in entries moved),
  not to loosen the "never anything an admin lacks" assertion.
- **A utility can't beat the unlayered `:focus-visible` rule in `base.css` without `!`.** The Timeline row link's `focus-visible:-outline-offset-2` computed to +2px in a real browser, so the ring stayed clipped by the street cell's `overflow: hidden`; it is `focus-visible:!-outline-offset-2` (the repo's leading-`!` form, as in `SubtaskChecklist`).


## Board order is derived, not stored (#470)
Tags: board-dnd · #470

- **One comparator, two sides.** `compareBoardCards` (shared, `board-order.ts`) orders a column: Priority 5 to 1 then unset, oldest
  Shoot date, street, id. The server builds `board.orderedProjectIdsByStage` with it per role (Priority is withheld from External
  Editors, so their tier is flat) and the client re-sorts optimistic moves with the same function. Do not fork either copy.
- **A move is a Stage move and always an append.** `placement` is `{ kind: "append" }` for every drop and every Move to; the server
  ignores neighbours. `/board-position` is retired; a same-column drop is refused client-side with an announcement and no request.
- **Focus follows the card to its sorted slot.** The optimistic overlay remounts the card in another column before the menu's own
  `finalFocus` runs, so the card menu keeps a `pendingMove` ref (`returnFocus: () => !pendingMove.current`) and the Dashboard's
  restore falls back to the Stage heading when `card-menu:<id>` is absent (collapsed rail), scrolling the target into view.
- **Moving out of Awaiting RAW can fill the Shoot date server-side**, so the client's slot may differ from the refetched order for a
  moment. Tests must not assert client slot equals server array for that move.

## Calendar and Timeline item menu (#463)
Tags: gantt-calendar · #463

- **One controlled host, not a context menu.** The vendor chip and bar are `<button>`s the vendor renders, so nothing can wrap
  or nest in them, and `renderEventMenu` (the Gantt's per-bar ContextMenu) would open on Base UI's 500ms touch long-press over
  the 250ms touch drag, the trap #432 hit on Board cards. `components/scheduling-item-menu.tsx` is one open-state host over
  `reui/dropdown-menu` with no Trigger, shared by `ProductionEventCalendar` and `ProductionGantt`; the Gantt import-boundary
  guard now fails a `renderEventMenu` prop. Click, Enter and right-click open it; a drag never does.
- **`anchor` is a QUINCY ADDITION on `DropdownMenuContent`** (a passthrough to the Positioner), because a triggerless menu needs
  somewhere to sit. A pointer open anchors to a VirtualElement re-read live from the item (follows scroll); a keyboard open
  anchors to the item. A virtual anchor is about 1px wide and the popup is `w-(--anchor-width)`, so the menu sets an explicit width.
- **A programmatic open focuses the popup, not the first row.** Enter (a native click) must focus the first enabled row itself.
- **A picked row is a hand-off.** The row only records the pick; once the menu has finished closing the host focuses the item and
  THEN runs the action, so the app router (Open project) and the dialogs capture the item as their opener and return focus to it.
  `finalFocus` is `false` while a hand-off is pending, and that flag is cleared on the NEXT open, never in `onOpenChangeComplete`
  (#432: the `finalFocus` decision runs as the popup unmounts, after the completion callback). Safari does not focus a clicked
  button, so Escape and outside press resolve the item live rather than trusting Base UI's default return.
- **Restore if lost.** A saved start re-keys a Timeline bar (a new element), so after a follow-on dialog closes the host re-checks
  focus (`body`, disconnected or `:disabled` count as lost, #450/#452) and focuses the re-resolved item.
- **Do not tag Timeline bars with `data-event-id`.** The controller's `"event"` focus fires a bare `.focus()` after every pointer
  drop; tagging would start yanking the Timeline's scroll after drags. The Gantt resolves bars by the existing
  `[data-gantt-resource=...] [data-slot="gantt-bar"]` query.
- **Touch.** A tap opens the menu; there is no long-press menu (long-press is the drag, and iOS fires no `contextmenu`). A
  touch-origin `contextmenu` is swallowed as `board/card.tsx` does. A 4px pointer-travel guard (`ProjectCalendarAnchor`'s
  threshold) covers a read-only Timeline bar, which has no gesture to swallow its click. The click guard needs `detail > 0`.
- **Keyboard.** Enter opens; Space keeps keyboard Adjust (ADR 0009); the Enter that commits Adjust fires no `onEventClick` on either
  tree; on an item nothing can adjust, Space falls through to a native click and opens the menu. The vendors gained
  `onEventContextMenu` and `eventPopup` (a bar or chip becomes `aria-haspopup="menu"` + `aria-expanded`, losing `aria-pressed`).
- **The Calendar opts out of vendor selection (`preventDefault`); the Gantt cannot.** `gantt-bar.tsx` calls `selectEvent` before
  the callback, so a clicked Timeline bar keeps its selected ring while its menu is open.
- **The selection strip is gone.** Its context line and overlap caution are the menu's label; its gates became
  `lib/scheduling-item-actions.ts` (not live: Deadline and checklist rows hide because the effective permissions narrow, Open
  project disables). `checklistScheduleEditorButtonLabel` and the `calendar-move:` focus key are deleted. Cmd/Ctrl-click Open
  project on the Calendar is accepted lost. The Timeline's Edit schedule… opened the sheet at every width (D7:
  `scheduleEditorPresentation` says how INLINE sessions draw); **superseded by #582**: it now opens the Due cell's own picker
  anchored to the bar, as an inline session with `inlineTarget: "item"`, so the Timeline no longer opens a non-inline session
  (the sheet stays only as the dialog host's safety net). **The Calendar followed in #583**: same host, anchored to the chip.
- **Test trap:** the vendor calendar ignores a click within 250ms of a drag end (a module flag an earlier test in the same file may
  set); wait it out before a grid click.
## Filter tree: OR, groups, negation across Projects, Calendar and Timeline (#461, PR A)
Tags: search-filters · #461

- **One compiler, an executable spec, and SQL that is a function of the tree's shape.** `evaluateDashboardFilterTree` (shared) is the
  spec; `workers/app/src/lib/dashboard-filter-sql.ts` is its only SQL form. Values never enter the text: every rule's values ride in ONE
  JSON bind read with `json_extract` / `json_each`, so the statement is stable per shape and the bound-parameter count does not grow
  with the tree. D1 allows 100 bound parameters, a 100,000-byte statement and a 2,000,000-byte value, so the JSON is what scales.
- **Strict 0/1 per rule, then NOT.** Every leaf compiles to `CASE WHEN <inner fragment> THEN 1 ELSE 0 END`. Wrapping a nullable
  fragment (a NULL shoot date, an unset priority) in NOT or OR without that turns "unknown" into TRUE or drops the row. Use the inner
  fragments, never `shootRangeSql` / `deadlineRangeSql` with their `'' OR` wrappers (an empty bound there means "no filter").
- **A not-applied People rule is dropped, not TRUE.** `or(people=<unknown>;stages=X)` must equal `stages=X`. Each compiled node is an
  `{applied, match}` pair; AND uses `NOT applied OR match`, OR uses `applied AND match`.
- **Moving a predicate from the base to a per-event-kind filter changes nothing observable only if the base keeps the necessary part.**
  Calendar and Timeline keep authorisation, search, Delivered, the Archived scope (`dashboardFilterArchivedMode`) and the Stage scope
  (`dashboardFilterStageScope`, three-valued, exact under negation) in `authorized_projects_base`; the tree itself is then evaluated on
  Deadline events with People = Editors, and on Subtask events with People = that Subtask's assignees. The Stage scope is bound as `[]`
  when there is no Stage rule, never as "every presentation key" (stored keys outside the presentation set would drop).
- **Gantt child cursors.** A request without `f` keeps `ganttPeopleFingerprint` and the people-only child context byte for byte (a page
  carrying stages/shoot/etc. still mints a child cursor over People only). With `f` the cursor binds to `dashboardFilterFingerprint(tree)`
  (`t:` + 14 hex; the cursor schema accepts both) and the child request names the whole tree. `child_matches` is not even emitted when the
  tree has no People / My tasks rule: the Subtask context is then the Project's own.
- **Tests that read "now" are not tree tests.** A fixture Deadline in August 2026 is overdue today, so an `overdue` rule matches it; pin
  tree semantics with Shoot dates and People, and keep Overdue to the legacy fixtures that fix their own windows.
- **`project-search.test.ts` SHA digests were re-pinned (characterisation, not a guard)** in the Calendar commit; the one other
  assertion that mentions bind slots was later rewritten for the 15-bind layout (see the fix round). Writer order `editors` before `stages` (#428) is untouched.

### #461 PR A fix round

- **A tree at the caps is a test, not an assumption.** 20 rules / depth 3 / 50 ids ran fine as one shape and died as another: `SQLITE_NOMEM` (20 People rules flat, Gantt page; nested People groups, Calendar) and "Expression tree is too large (maximum depth 100)". Cause: every People rule re-derived the People universe inside the statement, in `applied` and again in `match`, repeated per ancestor, and the Gantt page compiles the tree three times. `dashboard-filter-max-cap.test.ts` runs three shapes as Admin and External Editor through every statement on every surface; add a shape there before trusting a compiler change.
- **Resolve the universe once, in the handler.** `validPeopleIds` answers the request's valid ids; the ONE JSON bind carries each People rule's pre-filtered `ids` and a precomputed `a` (applied, 0/1). The compiler has no "universe" mode any more. AND / OR chains are balanced binary trees (depth log2 n).
- **`production-calendar.integration.test.ts` pins the Calendar's bind layout**: 15 binds, the Stage scope as the one `json_each(?8)`, People ids only inside the tree's JSON bind (`?15`). An earlier layout kept a dead `request_people` CTE at `?8` only to satisfy a `json_each(?8)` / `json_each(?9)` pin; the dead CTE and bind were removed and the pin rewritten to protect the same property (ids ride in JSON binds, never per-id placeholders; bounded bind count).
- **A standalone `childrenOf=` request never ran the page's parent check.** With no People / My tasks rule `childFilterSql` was the constant `1`, so an excluded parent still returned children. Embedded children keep the shortcut; a standalone request evaluates the tree on the parent. Role gates (Priority 400, Archived 403) run for every Gantt mode.
- **Legacy parity is a test against `origin/main`, not a reading.** Moving Priority / Shoot / Deadline / Overdue out of the Calendar base widened `filterFacets.projects` and dropped a no-Deadline Project from the density count under `overdue=1`. `production-calendar-legacy-parity.test.ts` passes unchanged on main's code; keep it that way. The Project facet applies the tree with People / My tasks dropped (`dropPeopleRules`); the flat Overdue facet keeps its candidate quirk (`overdueIncludesNoDeadline`, never for a tree).
- **A Stage / Priority-only list stays in memory.** Anything that routes it through D1 pays ceil(N/500) sequential statements for nothing.


## The Dashboard Filter is one popover over the tree (#461, PR B)
Tags: search-filters · #461

- **`{ ...state, ...filter }` leaks a stale tree.** A flat `DashboardFilter` has no `tree` / `order` keys, so spreading it over a state that carried a tree keeps the tree, and the serializer then writes `f` and drops the user's new flat edit. Every write goes through `applyDashboardFilter(base, filter)`, which drops `tree` / `order` from the base first. Pinned by a DOM test (tree, then a flat edit on the Calendar view, then no `f=` in the URL). `ganttFacetForWrite` / `writeCalendarState` take the filter as one value for the same reason.
- **The role clamp must clamp the tree.** `clampDashboardFilter` runs the shared `clampDashboardFilterForRole` over the filter's tree (a flat filter is a flat AND): forbidden Priority / Archived leaves widen under AND and narrow under OR. A flat-field spread (`priorities: canFilterPriority ? ... : []`) left a pasted tree untouched.
- **Read the filter through the tree helpers, never its flat fields** (`stage scope`, `HasNonStageLeaf`, `archived mode`, `isEmptyDashboardFilterTree`). `lib/dashboard-filter-access.guard.test.ts` fails a flat read in Dashboard, DashboardFilter, ProductionEventCalendar, ProductionGantt and `production-gantt-filters.ts`. The route <-> facet transport lives in `production-gantt-facet.ts`, so `production-gantt-filters.ts` holds only semantic consumers (the Delivered pair, pairing notice, legend) and is guarded too.
- **Cold `f=` URLs must be in `URLSearchParams` form.** The route parser rejects a query that is not byte-identical to `new URLSearchParams(...).toString()` (so `(`, `)`, `;`, `:` are percent-encoded); a hand-built `f=1:or(...)` reads as not-found.
- **The Filter popover's unfinished rows are real rows.** Opening the field picker leaves an unfinished row behind; it changes neither the URL nor the badge (the badge counts the URL tree's leaves). Tests read rows by role and accessible name inside the `Filter` group.
- **Delivered pairing.** A tree that names Delivered shows delivered Projects even with Display hiding them (`ganttDeliveredShown`); a flat `stages=delivered` keeps the empty-state recovery (#270). Turning Display's Show off does not edit the tree: delivered stays on and the Dashboard announces "Also showing delivered Projects."
- **Calendar `sameFilters` compares the tree by canonical spelling**, so the server's verbatim echo of `appliedFilters.tree` is not read as a change (no `history.replace` loop).
- **Phone stacking, not truncation.** Under the `@max-[26rem]/track` container breakpoint a rule row wraps onto lines: combinator + handle/menu, then field and operator side by side at explicit half-line bases (`basis-[calc(50%-0.1875rem)] shrink-0`), then the value on its own full line (`basis-full`). Two failed attempts first: a fixed `--filter-*-width` basis with `grow` still SHRANK the cells (grow only shares free space), and `basis-auto` collapsed them to their padding, because every cell is an `@container/cell` size container and a size container's content size resolves to ~0. On a size container, never size by content: give it an explicit basis. The Dashboard's cell widths are 8.5rem / 10rem / 8.5rem (field / operator / value): inside a nested group every cell shrinks, and below about 10rem the operator "is not any of" lost its last letters even at 1280 (measure after the popover's zoom-in finishes, or a live check reads a mid-animation layout). The negated operator reads "is not any of" via `LABELS.negated`; the popup is `100vw - 2 * --space-4` wide with `collisionPadding={16}`; the trigger badge stays visible on the phone.


## Board order Stage B: stop writing `board_position` (#475)
Tags: board-dnd, d1-migrations · #475

- **Nothing writes `board_position` any more; the Board order is derived from the data (#470).** A Stage move is a mover-only
  `UPDATE` (stage, `board_revision`), with no whole-column fence, no compaction and no renumbering. The column stays in the schema
  and `project_board_order_0037_rollback` is untouched: dropping either is a later migration, not this change.
- **Four callers used to read `board_position` off the `RETURNING` row** (`ingest.ts`, `automatic-stage.ts`, `project-stage.ts`,
  `deriveStageFinalizerIntent`). With the write gone the column is not in the row, so each caller's *reported outcome* and its
  follow-ups (raw_ready notification, finalizer, shoot-date fill) are asserted in tests, not only the DB state: a caller that
  silently read `undefined` as "no change" would pass a DB-only test and skip its side effects.
- **The web seam stopped reading the server order map too.** `boardMapPresent` / `boardRank` / `authorizedBoardOrder` are gone from
  `ProjectSummary` and `BoardModel`, so Priority editability no longer depends on map evidence; the old "missing-map" test was
  replaced by one proving editability with no map fields at all.
- **`fence-rework-normative-sql.md` was re-pinned (characterisation, not a guard)** because the SQL it records no longer exists.

## The Project whiteboard's socket and shell (#498)
Tags: whiteboard, workers-runtime · #498

- **A WebSocket upgrade is a GET, so `requireAppOrigin` never sees it.** The route checks `Origin === APP_ORIGIN` itself; without it any site could open a socket with the user's cookie. Access (session, collaboration, Project row) is decided BEFORE a Durable Object is addressed, so a refused request creates none.
- **The Durable Object gets identity from headers on a FRESH `Request`.** Forwarding the browser's request would let a client set `x-wb-user` / `x-wb-mode`; `project-whiteboard.test.ts` pins that they are discarded.
- **A browser cannot read a refused upgrade's status.** It gets close 1006 and nothing else, so `whiteboard-socket.ts` asks `collaboration-summary` after a connect that never opened and feeds THAT error to the Workspace's `accessFailure`. A status-0 answer is a network drop and keeps retrying.
- **Reconcile per element, never per scene.** One row per element (`version`, then lower `versionNonce` wins; tombstones kept) means two people saving over each other cannot replace the whole board, and no row nears the 2 MB limit.
- **The Workspace's tab-sync effect rewrites the URL to the tab it shows.** Two gates keep `?whiteboard=open` standing: `syncProjectTab` returns while `route.whiteboard`, and the Workspace's `onTabShown` effect skips while `whiteboardOpen`. The Workspace stays mounted (hidden) so the previous tab and drafts survive; Close steps back when the entry below is this Project's workspace, else replaces with the shown tab.
- **Excalidraw must stay out of the entry and vendor chunks.** `vendor-chunk-guard.ts` fails the build if an `@excalidraw` module reaches either; `ProjectWhiteboard` lazy-loads the block, whose own `whiteboard-canvas` import is lazy too.
- **Esc belongs to the board.** `hasOpenInnerLayer` treats `[data-quincy-whiteboard]` as an open layer so Esc inside the canvas never closes the sheet.
- **Vite's `/api` proxy needs `ws: true` and the Origin rewrite on `proxyReqWs`**, or `npm run dev` refuses the whiteboard's handshake exactly as it once refused every mutation (#191).
- **DOM tests stub `WebSocket` like `fetch`.** `no-unmocked-fetch.ts` records and refuses a real socket; mock `lib/whiteboard-socket` instead.
## Auto-move to Edited review records an arrival; one pass moves it (#486)
Tags: scheduling, board-dnd · #486

An Editor Output import and a Portal Edited upload only record `projects.edited_arrived_at`; the per-minute `reconcileEditedArrivals` pass is the single place the move happens, through `commitAutomaticStage` with the closed `edited_arrival_quiet` premise. AutoHDR finals and a human import therefore converge on one compare-and-set and one `edited_landed`.

- **An arrival does not bump `board_revision`, so the revision compare-and-set cannot see one.** The winner SQL carries the scanned `latestArrivalAt` and the `cutoffAt` in its premise, so an arrival landing between the scan and the commit finds the Project not quiet and loses. The postcondition repeats the check.
- **Fence every arrival write on its own fresh ingest.** The Output import's arrival `UPDATE` is gated on the audit row that attempt inserted (that audit only exists when the insert changed a row); the Portal upload on the asset it created (same id and `created_at`); the External completion on its session being `completed` at that instant. An unchanged rescan, a rejected hash, a losing supersede or a duplicate `/uploads/complete` never restarts the 15 minutes. The arrival statement is appended LAST in each batch so `changes()` adjacency and the positional result indexes of the earlier statements are untouched.
- **The Stage winner clears the arrival, atomically, for every path.** Every Stage winner that enters `edited_review` or `delivered` (cron move, AutoHDR finals/fetch, a manual move) sets `edited_arrived_at`, `edited_arrival_attempts` and `edited_arrival_retry_at` back to NULL/0/NULL in the same batch, in `stage-board-bundles.ts`. A separate clear after the win left a window (and a failed clear) in which a human move-back to Editing was undone by the same, already-acted-on arrival, with a second `edited_landed`. Housekeeping now only handles Archived and "no current Edited asset".
- **A bounded page needs a way off for every row (#194), but a valid arrival is never abandoned.** The scan is `ORDER BY edited_arrived_at, id LIMIT 25`. A move, a Stage change, Archive or a deleted Edited set takes a row off it. A failed or lost commit on an unchanged Project, or a thrown error, increments `edited_arrival_attempts` and sets `edited_arrival_retry_at` (1, 2, 4 ... capped at 60 minutes), which the scan honours; a new arrival resets both. An earlier cut cleared the marker on failure, which turned a transient D1 error into a permanently stuck Project. A lost commit gets one immediate retry first, because it also loses when an unrelated Project lands in the destination column. The pass returns before scanning when automatic board writes are off, otherwise every row comes back `deferred` and the same page repeats.
- **"Landed" needs a READY current Edited asset, in the scan and in the winner SQL.** Portal uploads commit as `publish_status = 'pending'` and can end `failed`; moving and notifying on those shows reviewers nothing. The premise re-checks it at commit, so an asset deleted between scan and commit does not move the Project. Such a Project keeps its arrival and moves when an asset becomes ready.
- **The generic workflow-premise CTE names every premise kind's columns.** SQLite resolves a column at prepare time, so adding `edited_arrival_quiet` made `projects.edited_arrived_at` a requirement of EVERY Stage winner, not just this one. Migration 0054 must be applied before the code ships (CI-Deploy order), and the 0037-pinned proof schema in `test/tb5a-proof-support.ts` now applies 0054 on top. The byte-for-byte fixture `test/fixtures/fence-rework-normative-sql.md` was updated with the new branch.
- **Notification rows are per recipient.** "Exactly one `edited_landed`" is one per active admin and member, so race tests compare against the recipient count, not `1`. The pass notifies only for a verified winner, with `edited_landed:<winning audit id>` as the source key.

## Automatic Deadline rides every Shoot-date write (#484)
Tags: scheduling · #484

- **Provenance is a stored column, never a value comparison.** `projects.deadline_source` (`automatic` / `manual` / `none`, migration 0055) is what says whether a Deadline was set by the system. A person's save always records `manual`, even at exactly the automatic value, so `saveProjectDeadlineSchedule` deliberately bypasses its "identical schedule is a no-op" shortcut when the stored source is `automatic` (the version bumps, a stale `expectedVersion` still conflicts). The read model reports a held Deadline whose stored source is not `automatic` as `manual`, which also covers the many test fixtures that insert `deadline_at` directly. The CHECK is not tied to `deadline_at` for the same reason. External DTOs never carry `source`: the strict External schema would 500 the whole detail, so `external-project-query.ts` strips it.
- **One bundle, appended to the END of the batch that writes the date.** `buildAutomaticDeadlineBundle` (`packages/db/src/automatic-deadline.ts`) is the UPDATE (all eligibility in SQL: `deadline_at IS NULL`, `shoot_date` is the value just written, not archived, not Delivered), a system audit gated on `changes() = 1` directly after it, then one occurrence INSERT per reminder gated on that audit row. Gate the UPDATE on the caller's own winner audit row (`create`, `project.update`, the shoot-date fill audit), never on `changes()` of an earlier statement; Tonomo create/update write no audit row, so there the UPDATE's own predicates are the gate. Appending last keeps every existing positional `results[n]` valid, and in `composeStageBundle` the fill (now carrying the bundle) must stay last.
- **Only gaining a date qualifies.** Empty to canonical, and unparsed text to canonical, count; a canonical date moving to another canonical date is a reschedule and belongs to #485. A `deadline_set` fill never qualifies (that Project already holds a Deadline). Never compute from non-canonical text, and never from an instant: the weekday comes from calendar arithmetic on the `YYYY-MM-DD` components, then 17:00 is resolved through `resolveSydneyCivilMinute`, so Sydney DST cannot move it.
- **A backdated Automatic Deadline records every occurrence skipped, `due_now` included** (`planDeadlineOccurrences(..., { skipElapsedDueNow: true })`), so importing an old shoot never fires an immediate reminder. A person's save still keeps an elapsed `due_now` pending. Confirming an automatic Deadline at the same value is different: only provenance changes, so it is ONE compare-and-set (`confirmAutomaticDeadline`: `deadline_source = 'automatic'` and the expected version and the stored value) plus the audit row. It does NOT bump `deadline_version` and does not touch occurrences or the outbox. Do not "carry reminders forward" by bumping the version: the scanner claims an occurrence against the version it read and delivery admission compares the outbox payload's `scheduleVersion` with the project's, so a bump racing either one leaves a fired reminder with no delivery or suppresses an in-flight one. #485's reschedule rule must CAS on `deadline_source = 'automatic'` AND the version, so a concurrent confirm and reschedule serialise. The popup's Apply also submits an untouched draft for an automatic Deadline (`applyUntouched`), or the user could never confirm it.

## #487 — the Team combobox inside the New shoot `<form>`
Tags: focus-overlays, reui-vendor · #487

- Base UI's chips input lets Enter through to implicit form submission when no list item is highlighted (it says so in `ComboboxInput`), and the Project header never noticed because it is not inside a form. `ProjectTeamCollectCombobox` cancels the Enter default (`blockEnterSubmit`); a synthetic key event in a DOM test never submits, so `CreateProject.dom.test.tsx` asserts `defaultPrevented`.
- Default editors are display-only on New shoot: the candidates endpoint flags them (`editors[].defaultEditor`) and the combobox locks their chip, but they are never put in `editorUserIds`. Sending them would make a Default editor deactivated between page load and Create a 422, which the server's default-editor rule deliberately never raises.

## #488 — Deadline and Priority on New shoot
Tags: scheduling · #488

- **A manual Deadline is written by the create INSERT itself, never by a second `saveProjectDeadlineSchedule` after it.** A second call can half-land (a Project with no Deadline after a 201), and with a shoot date it would also race the Automatic Deadline bundle. The INSERT gains the nine `priority` / `deadline_*` columns at the END of its column and SELECT lists, so the `fieldValues.slice(0, 12)` / `.slice(12)` bind split stays valid; the `schedule_saved` audit and the occurrences follow `projectAudit` in the batch, gated on it. A manual value and the automatic bundle are mutually exclusive.
- **`createProjectFields` was non-strict, so `deadline` and `priority` were silently stripped until they were declared.** The nested `deadline` object is `.strict()` so a client cannot name a source: the only way to get `automatic` is to send null and let the server compute it.
- **The automatic preview on New shoot is display only.** It is recomputed from the shoot date every render (`automaticDeadlineFor`, the server's own function) and the request carries `deadline: null` while the draft is automatic. Editing the time, or only a reminder, makes it manual; an untouched Apply keeps it automatic (`DateTimePopup` never calls `onApply` for an untouched draft).
- **`DateTimeField`'s `adornment` is part of the trigger's accessible name** (its id joins `aria-labelledby`), so "Automatic" is announced with the value instead of being a silent decoration.

## Email digest (#489)
Tags: notifications · #489

- **Staff default to a digest, so every test of the immediate email path must opt in.** A user with no `notification_preferences` row reads as Twice daily, so `notifyProject` / the outbox consumer defer the email. A test that asserts `EMAIL.send` fires must insert `email_digest_cadence = 'immediate'` for its recipient first (see `notifications.test.ts`, `subtask-assignee-column-dropped.test.ts`).
- **Digest rows need a deterministic order in assertions.** Items created in one run share a millisecond and a random id; `ORDER BY created_at, id` made a test flaky. Order by `state, outcome_code` or assert the whole array.
- **A new table with an FK parent outside the QA-seed fixture needs a decision in `qa-seed/teardown-graph.ts` (`SHARED_PARENT_TABLES`), and a new bare `*_message_id` column needs a line in `qa-seed-no-fk-columns.guard.test.ts`.** Both guards fire on `notification_digests`.
- **Digest slots are UTC hourly ticks; the 8:00 and 14:00 labels are Sydney time.** The run decides eligibility by converting the tick to Sydney local time (DST-safe), never by comparing UTC hours, and a missed tick is caught up by the next run via the per-recipient-per-slot UNIQUE row.
- **`external-notification-visibility.ts` moved to `packages/db/src/`** so the background worker can re-apply the centre's External visibility gate before a digest email; `tb4-contracts.test.ts` reads it from there.
- **A backdated Automatic Deadline records every occurrence skipped, `due_now` included** (`planDeadlineOccurrences(..., { skipElapsedDueNow: true })`), so importing an old shoot never fires an immediate reminder. A person's save still keeps an elapsed `due_now` pending. Confirming an automatic Deadline at the same value is different: only provenance changes, so it is ONE compare-and-set (`confirmAutomaticDeadline`: `deadline_source = 'automatic'` and the expected version and the stored value) plus the audit row. It does NOT bump `deadline_version` and does not touch occurrences or the outbox. Do not "carry reminders forward" by bumping the version: the scanner claims an occurrence against the version it read and delivery admission compares the outbox payload's `scheduleVersion` with the project's, so a bump racing either one leaves a fired reminder with no delivery or suppresses an in-flight one. #485's reschedule rule gates on `deadline_source = 'automatic'` (not on a pre-read version), so a concurrent confirm and reschedule serialise: the confirm flips the source and the move writes nothing. The popup's Apply also submits an untouched draft for an automatic Deadline (`applyUntouched`), or the user could never confirm it.

## Project activity in Email digests (#490)
Tags: notifications · #490

- **The digest item for activity is the tenth statement of `deliverBroadInApp`, appended LAST and gated on this batch's own `notification.delivery.delivered` audit row (a pre-generated id), never on `changes()`.** Indexes 0-8 and the `terminalOutcomes` check are asserted positionally; an earlier statement owns `changes()`. A replayed or suppressed occurrence writes no delivered audit, so it adds no item, and `ON CONFLICT (notification_id)` is the second fence.
- **Activity items have `ledger_id` NULL on purpose.** A broad outbox has no email phase: an email ledger row would be re-pended by an admin replay and never drained, so the outbox could never complete. The outcome lives on the item. `CLAIMABLE_ITEM` and the legacy emitter already accept NULL.
- **Cadence is not a predicate for activity.** `Immediately` users get activity items too and drain hourly because `isDigestSlotDue("immediate")` is true every tick.
- **The "Include Project activity" switch is checked at claim time AND in the `sending` admission fence.** Items queued before a toggle-off are suppressed (`activity_excluded`); a toggle that lands during composition releases the slot (the next slot suppresses). A user with no preference row is on, so the switch must exist AND be 0.
- **The preferences response is strict for External editors** (`externalNotificationPreferenceResponseSchema`): a new field must be added there or their screen fails validation.
- **A DOM test that picked the first checkbox by position broke when a second control joined the first card.** The tests now scope by the card's `aria-labelledby`; and `test-seam.guard` rejects a selector held in a constant, so write the literal at the call site.

## An Automatic Deadline follows a reschedule by a second bundle, not a rewrite (#485)
Tags: scheduling · #485

- **The move is its own bundle, `buildAutomaticDeadlineMoveBundle`, appended last, and it must NOT depend on a pre-read Deadline version.** A first cut CASed on the version the caller read; any concurrent write that bumped the version while staying automatic (a Resume, a second reschedule) made the move silently lose while the new shoot date committed, leaving the old Deadline behind for good. The UPDATE's own predicates are the whole rule: `shoot_date` is the date this write put on the row, `deadline_source = 'automatic'` (a concurrent person's save or confirm flips it to manual, which alone protects a person-set Deadline), a held Deadline, not archived, not Delivered, and the value differs. It bumps `deadline_version` in SQL and the occurrence INSERTs read `p.deadline_version` (and the replaced version, `- 1`) in SQL. A reschedule that resolves to the same Deadline (Saturday to Sunday) writes nothing. Offsets are untouched, because any offset change is a person's save and makes the Deadline manual. Append it whenever the date changes; do not decide "set or move" from a pre-read.
- **Fence the date write, or a lost race strands the Deadline.** Tonomo's returning-date UPDATE is fenced on the `shoot_date` snapshot it read and THROWS on a lost fence so the queue retries; writing over a newer date would leave its Deadline behind, and redelivery cannot repair it once the date already matches.
- **Never mutate an occurrence to a new version.** The scanner claims a row against the version it read and delivery admission compares the payload's `scheduleVersion`, so the move supersedes the old version's pending rows (every pending row of the Project) and INSERTs four new rows at the new version. A slot the old version already sent is carried into the new version as `fired` with its `fired_at` (a sent reminder is never re-armed, through any number of moves); the rest are `pending`, or `skipped` when already past, `due_now` included. The carried row has no fire audit and no outbox, so the scanner never claims it. A reminder claimed but not yet delivered when the move lands is lost to admission (`schedule_replaced`): the same window as a person's save.
- **Which writes append it.** Edit details (a held Deadline and a canonical date that differs from the stored one) and Tonomo (`commitShootDateChange` for a canonical-to-canonical reschedule, `updateProject`'s gained-date path for a returning date). A canonical-to-canonical change on a Project with NO Deadline appends nothing: the set bundle fires on gaining a date, never on a reschedule. Clearing the date or writing free text appends nothing, so an automatic Deadline stays in place and stays automatic. The automatic shoot-date fill on leaving Awaiting RAW is covered by #510 (below).
- **One suppression definition.** The pending-ledger and outbox suppression for a replaced schedule is `buildDeadlineScheduleReplacementStatements` (`stage-board-bundles.ts`), used by a person's save and by the move, so the two cannot drift.
- **The shoot-date fill appends the move too, and still takes no version (#510).** `buildShootDateFillBundle` (stage-move trigger only) appends `buildAutomaticDeadlineMoveBundle` after the #484 set bundle, gated on the fill's own audit row, reason `shoot_date_fill`; `ShootDateFillIndexes.automaticDeadlineMove` records its position and every earlier index is unchanged. Set and move are mutually exclusive on `deadline_at` (the set needs it NULL, the move needs it held), and if the set lands the move's `deadline_local_civil IS NOT` predicate makes it a no-op. The original ticket asked for a pre-read `deadline_version` CAS plumbed through `project-stage.ts`, `automatic-stage.ts` and ingest; that is the #485 first-cut bug (a concurrent automatic-staying bump silently loses the move and strands the old Deadline), so it was deliberately not adopted and no caller changed. All three fill callers (manual Stage move, RAW reconciliation, direct-upload ingest) inherit the move.

## The Project discussion composer is `QuincyRichTextEditor` on vendored `rich-text-editor-2` (#491)
Tags: rich-text, reui-vendor · #491

- **Never import the vendor's extension set.** `createRichTextExtensions` enables h1, blockquote, code, codeBlock, hr, alignment, highlight and StarterKit v3's default `autolink` / `linkOnPaste`; autolink turns a typed `a@b.com` into a `mailto:` mark and `parseRichTextDoc` rejects that with a 400. The composer builds on `lib/rich-text-tiptap.ts` (relocated from the legacy editor), and `RichTextEditor.dom.test.tsx` pins the Link extension's resolved options with a stock-StarterKit control so the assertion can fail.
- **The vendor's selectors call commands our schema removed.** `can().toggleCode()` throws (`code: false`), `setHeading({ level: 1 })` is always false with levels [2, 3], and `storage.characterCount` is undefined. `reui/rich-text-editor/rich-text-state.ts` is trimmed to what the schema can express.
- **Base UI's `finalFocus` is not told why the popover closed.** Return focus to the trigger on Escape / outside press but to the editor after Apply / Remove with a ref set by the form (`rich-text-link.tsx`); a collapsed caret must keep a stored link mark (not insert the typed address as text) or the doc assertions change.
- **A vendored `<form>` inside a portalled popover still bubbles synthetic submit through the editor's React ancestors.** `stopPropagation` in the form's own handler.
- **`no-scrollbar` / `scroll-fade-x` are not utilities in this Tailwind**: the vendor toolbar scrolled with visible scrollbars and no fade until they were replaced with the legacy phone mask.
- **Run the editor tests against both editors (`describe.each`) until the legacy one is retired (#492).** Steps that differ (link dialog vs popover, `<select>` vs menu) go through translator helpers; the translated cases are listed in the PR.

## The Project whiteboard goes live (#499)
Tags: whiteboard · #499

- **An `ack` alone is not convergence.** `scene-store.reconcile()` returns the winners (relayed to every other socket) AND the stored rows that beat the sender's batch; the sender gets those back BEFORE its `ack`. A retried batch (same version and nonce) is neither a win nor a loss, so it is acked and never relayed or "corrected".
- **Notifications carry nothing, the Durable Object rereads.** `refreshAccess()` rereads the Project and each connected user's access (`hasProjectCollaborationAccessForUser`) and applies mode flips / 4403 closes. It is serialised through a promise chain: two RPCs in flight could otherwise apply an older read last. Call it AFTER the SQL batch commits, awaited, never inside it, and also on `already_done` (a retry heals a lost notification). Every element batch rechecks the same state, so a notification that never arrives cannot let a write through; a mode a refresh set during the batch's await wins over the batch's own older read.
- **A header is a ByteString.** A non-Latin-1 display name in `x-wb-name` throws; the route `encodeURIComponent`s it and the DO decodes. Name and colour are never client-supplied: presence frames are schema-stripped to pointer/button/selection and the relay stamps identity from the attachment.
- **Apply remote edits with `reconcileElements` + `CaptureUpdateAction.NEVER`, never `controller.replace()`** (which bumps versions and tombstones everything it was not given). Then `saver.adoptRemote(appliedFromRemote(remote, scene))` records exactly what the scene holds of it as stored AND transmitted: without that the saver echoes it, or escalates its version. Set `elementsRef` from the merged scene before the editor's change event, or the saver reads the remote element as "gone" and tombstones it. `applyRemote` also records the merged element hash so the editor's own change event does not flip the status to "Unsaved changes" on every remote tick.
- **A server close with 4403 is an answer, not a drop.** The socket probes access and ends the session (`onAccessFailure`); only a status-0 probe failure reconnects.
- **Presence is memory, not storage.** Pointer and selection live in an in-memory map (the 2 KB attachment holds identity only); it is rebuilt by each client's next frame after an eviction. Frames over ~30/s per socket are dropped, never queued.
- **Init size.** The 1 MiB cap bounds what a client SENDS per batch; a scene is the sum of batches. Workers accept WebSocket messages up to 32 MiB (Oct 2025 limit), so `init` is not chunked; `project-whiteboard.test.ts` sends a 3 MiB init.
- **Admission is a read, in the refresh queue.** The route's authorisation can be older than a removal whose refresh already ran, so the DO rereads access and archive state before accepting a socket, inside the same queue as `refreshAccess` (the accepted socket is registered before any later refresh reads the sockets). The mode comes from that read, not from the route's header.
- **A write never upgrades a socket.** "Mode unchanged" is not "read is fresh": a stale "restored" read can outlive an archive refresh that confirmed view. Only `refreshAccess` and admission move a socket to edit; a write may only downgrade (fail closed), and a read overtaken by a refresh is handled by the epoch rule in the round 2 note below.
- **Buffer remote batches as batches.** Two versions of one id in one `restoreElements` call make Excalidraw rename the duplicate and keep both. Also, `reconcileElements` skips an element being edited/resized/drawn; those winners are deferred and replayed when the interaction ends, or the client stays stale forever.
- **Excalidraw 0.18.1 ignores `Collaborator.color`.** Cursor, label and selection colours are `hsl` of a hash of `collaborator.id || socketId`; the controller writes `colorKey` (the user id) there while the map key stays the session id.


### #499 round 2: an access read is trusted only if no refresh was invoked while it ran, and a renderer repair never changes a revision

- **Epoch at invocation, not generation at start and end.** `ProjectWhiteboardDO.accessEpoch` is bumped synchronously inside `refreshAccess()`, before the call is queued. A write (and admission) captures it, reads, and if it moved, awaits the refresh queue's tail, rereads once, and rejects (`stale`) if it moved again; the client keeps the edit and resends. A counter bumped when a refresh STARTS misses a refresh that is queued behind another one (the archive has committed, its notification is waiting, and an in-flight write still sees an unchanged counter), and a bounded retry loop that finally accepts its last read commits from a read it already knew was stale. After the final await the handler rechecks the socket's attachment and then reconciles, broadcasts, sends loser corrections and acks with no await between. Writes are deliberately NOT put on the refresh queue (a D1 round-trip on every ack, and it would not close the race alone). Correctness assumes D1 PRIMARY reads (no Sessions API or read replication) and that every route calls `refreshAccess()` after its change commits. The queue tail recovers from a failed refresh, so one D1 error does not wedge writes.
- **The client keeps trying.** A rejected or failed save used to wait for the next edit. `useAutosave` now re-arms its own timer (1 s doubling to a 30 s bound) until the save goes through or the board closes.
- **Excalidraw repairs fractional indices with `mutateElement`, which bumps `version` and draws a new `versionNonce`, and it does so in three places: inside `restoreElements`, inside `reconcileElements` (on LOCAL elements as well as remote ones), and in `updateScene`/`replaceAllElements`, and for `initialData` on first load.** A bump the person never made reads as an edit: the saver sends it (overwriting the sender's genuine later edit with a stale shape) and a drawn nonce can beat or lose against that genuine edit. Pinning only the remote batch's revisions was not enough. `mergeRemote` (`lib/whiteboard-merge.ts`, restore/reconcile passed in, tested with the INSTALLED functions) resets the restored objects to the revisions they arrived with, snapshots every local object's revision, reconciles, then resets every output object by identity (`reconcileElements` returns the objects it was given) before the one `updateScene`. The first load calls `controller.adoptRevisions(init.elements)` from `onReady`, before buffered remote batches drain. The first design then kept the repaired index local (see the next section for why that was replaced): the SERVER now stores unique indices, so a client has nothing to repair, and a genuine reorder is an ordinary edit with its own version.

### #499 round 3: stored indices are unique, because a client-side canonical index could not converge

- **The server guarantees the invariant: stored indices (tombstones included) are unique and valid.** `@quincy/shared` `whiteboard-index.ts` (`reconcileRows`, `normaliseRows`, `IndexSpace`; the SQLite adapter is `workers/app/src/whiteboard/scene-store.ts`, dependency `fractional-indexing@3.2.0`, the version Excalidraw pins). Inside the transaction revision winners are resolved first; then any winner whose index is missing, malformed (`isValidIndex`: base-62 and accepted by `generateKeyBetween`, which does NOT reject a stray character) or held by another id (a stored row or an earlier element of the same batch) is re-keyed just above the contested index. An element moving off an index frees it for another in the same batch. Peers receive the STORED form; the sender receives its own re-keyed rows before the ack, like a loser.
- **A server re-key NEVER changes `version` or `versionNonce` (Sol round 9).** A synthetic revision (`version + 1`, nonce 2^31-1) overrode Excalidraw's authored nonce tiebreak: A's reorder of `e` (v2/nonce 50) collided and was stored as v3, so B's concurrent delete (v2/nonce 40, which wins in Excalidraw) lost and the deleted element came back. Content is decided by authored revisions only. The server stores the winner at a new index with its authored revision and sends the stored row back (to the sender before its ack, to peers as the relay). On a client, an incoming element at EXACTLY the revision of its local copy is an index correction (`mergeRemote`): the server holds that revision at that index, so the copy takes it (in place for an element under interaction), claims it first, and no revision changes, so the saver sees nothing dirty. An element at another revision is an ordinary incoming element: if it loses, nothing happens and the revision the client holds is decided, and re-keyed again, when it arrives. Claiming even a same-index equal-revision row matters: otherwise an in-flight copy undoes its provisional move back onto an index the server gave away. The model test checks, after every drain, that each id's stored (nonce, deleted) equals Excalidraw's reconcile of all authored revisions.
- **Legacy tables are normalised once, when the Durable Object is constructed** (`blockConcurrencyWhile`, before init is served or a write accepted), and the changed rows go to every socket `ctx.getWebSockets()` still holds (hibernated sockets survive a wake). The lowest id keeps a contested index (the order a fresh load already showed). An already-unique table is a scan. No migration, no new DO class.
- **Why the `IndexLedger` failed.** It tracked a "canonical" index beside the rendered one on every client and reconciled on canonical indices. Each review found a tab that ordered overlapping shapes differently from a fresh load: repairs fed back into later merges (Sol 4), locally saved shapes never registered (Sol 5), the sender not reordered after its own save (Sol 6), and Codex's two cases against the first server-side sketch (an unsent local `0:a0` against a stored `a:a0`, and a server correction at `v2` with old geometry overwriting a genuine `v2`). The state was never going to close: two tabs can disagree about an index the server has never been asked to arbitrate. Uniqueness at the source removes the state.
- **A client's only index decision is to move an element OUT OF THE WAY, without changing its revision** (`mergeRemote`, `lib/whiteboard-merge.ts`, with the same `IndexSpace` the server uses). Who keeps an index, in order: incoming elements; local elements exactly what the server holds (`saver.hold(...)` is `stored`); local elements SENT and not acknowledged, at the index they were SENT with (`in-flight`); then unsent or edited ones. Two traps found by the model test: (1) re-keying a local element one at a time lets an earlier re-key take the index a later, un-clashing element holds, so claim first, then place; (2) an index-only change with an unchanged revision is invisible to the saver and the server ignores it, so moving an element that is IN FLIGHT is only provisional: the server keeps the index it was sent with unless it answers with a re-keyed copy before the ack, and the next merge that frees the index must put it back.
- **Never replace the object an interaction holds.** `appState.newElement` / `resizingElement` / `editingTextElement` are references to the scene's own object, and the next pointer event mutates THAT object. A re-key that installed a copy (the rule for every other element) left the scene and the saver at the gesture's first frame while the original took the rest. `mergeRemote` re-keys an `interacting` element IN PLACE: `index` is a plain field Excalidraw only reads, a direct write bumps no revision, and no snapshot of it has to differ. Dragging and group resizes re-query the scene per pointer event, so they are unaffected. The model test now makes the interacting client mutate THROUGH the held object and fails if a merge ever replaces it.
- **The gate is a seeded randomised model**, `lib/whiteboard-model.test.ts`: the real stored-row rules over an in-memory `ElementStore`, two to four clients with the INSTALLED Excalidraw `restoreElements`/`reconcileElements`, the real saver, FIFO per-socket queues. After every step it checks unique stored and scene indices, that a merge changes no revision and no stored element's index, and that a flush sends only what a person authored; after every step it also forks (a deterministic replay, because the saver's state is private), drains, and requires every tab to equal a fresh load of the stored rows with no genuine edit lost. A failure prints its seed and a minimised trace; `WB_REPLAY=<trace json> ... -t replay` prints it state by state. Equality with a fresh load only holds after draining: an unsent create or an undelivered message necessarily differs.


### #499 round 10: a remote echo is told apart per element, and one tie is an accepted gap

- **Never suppress "dirty" for a whole scene because a remote merge just ran.** Excalidraw's `onChange` arrives after the merge, so a local edit it has not reported yet lands in the SAME event; a scene-wide "this event is remote" flag then skips `markDirty`, the edit is never relayed, and the board reads Saved (Sol round 10). `lib/whiteboard-changes.ts` keeps the revision (`version`, `versionNonce`) of every element it has seen; a merge records only the elements actually TAKEN from the remote batch; an event is remote only when no element moved except those. Any other moved element is the person's own edit. Regression: `lib/whiteboard-changes.test.ts` (the model has no editor-change event, so it cannot express this ordering).
- **Accepted gap: an exact `version` + `versionNonce` tie between two clients with DIFFERENT payloads.** `whiteboard-remote.ts` and Excalidraw's own `reconcileElements` treat equal version and nonce as the same element, so the later copy is not applied and the tie is never repaired. It needs two clients to independently draw the same 31-bit `versionNonce` for the same element at the same version (about 1 in 2^31). Excalidraw's upstream collaboration has the same property, and a write-authorised client that forced a tie gains nothing it cannot already do by bumping `version`. Deliberately not built (Sol round 10, finding 2).

### #499 round 11: a skipped save is not a saved save, and a refresh answers only for the sockets it read for

- **`onSave` resolving is "stored" unless it says otherwise.** A view-only shell declined to send and resolved, so `useAutosave` cleared dirty and reported Saved while an archive frame had updated `modeRef` before React's `paused` effect committed; the restore never flushed the edit. `onSave` may now resolve `WHITEBOARD_SAVE_SKIPPED` (`"skipped"`): the hook keeps the edit dirty, reports `unsaved`, and arms the same bounded retry as a failed save (1 s doubling to 30 s). The pause ending also flushes it, but that alone is not enough: if the restore lands before React ever commits `paused=true`, `paused` never flips and the resume effect never runs (round 12). Each retry goes through the normal flush, which respects the pause gate (paused: stays dirty and waits) and the single in-flight save, so the retry and the resume effect cannot double-send. A shell that deliberately sends nothing must say so; never return plain success for a save that did not go out. Gate: `whiteboard-autosave.test.ts` and `ProjectWhiteboard.dom.test.tsx`.
- **A `refreshAccess` applies only to the session IDs present when it began.** Its reads can predate the change that admitted a later socket: an archive refresh held an External editor's denial, the restore committed, the editor reopened and got `init:edit`, then the older refresh closed the new socket with 4403 and the restore's refresh could not reopen it. Newcomers are covered by their own admission read and the refresh that change queued. Deletion still applies to everyone. Gate: `project-whiteboard.test.ts` "an older refresh never applies its stale denial...".

### #499 round 13: the scene and the saver never disagree on a transmitted revision

- **The saver never authors a revision; a vanish becomes an editor-style deletion at observation time (re-plan 2, after Sol 13/14).** Rounds 13 and 14 grew a "floor" in the saver: it raised versions above what it had transmitted, wrote them into live scene elements (`onRaised`), synthesised tombstones for dropped elements (`onTombstoned`, `noteRemote`, `sync()`), and each fix opened the next hole (a remote loser raised the local winner and changed Excalidraw's conflict outcome; an adopted raise suppressed autosave). All of it is deleted. `createWhiteboardSaver` is a pure sender: it diffs the scene by exact (id, version, nonce) keys, sends snapshots unchanged, and writes nothing into the scene (the gate hands it frozen elements). Every revision is authored by the editor or by code that behaves exactly like an editor operation: `lib/whiteboard-vanish.ts` keeps `lastScene` (the editor's own element objects, so an unreported mutation counts) on every editor change, and an element the server may hold (`saver.mayHold`: seeded, adopted, sent by the server whether or not the scene took it, transmitted or acked) that is missing from the scene gets `newElementWith(last, { isDeleted: true })` (last version + 1, a fresh nonce, the last valid geometry so a restore does not drop a zero-size tombstone, a free index). It goes onto the board through `controller.applyLocal` (a `mergeRemote`, never a raw append, whose index repair would bump it) and is a LOCAL change, so the board is dirty and autosave sends it. Teardown (`stop()`) and unsupported elements are excluded. Imports keep `replaceContent`'s numbering (max of incoming and what the board holds, deleted included, plus one, a fresh nonce), so an import over a vanished element is authored above its deletion; `whiteboard-scene-routes.guard.test.ts` names every route that puts elements on the board. Don't reintroduce a floor, a raise or a synthetic revision: if a case seems to need one, the editor-side operation is what is missing. Gates: `whiteboard-authorship.test.ts` (frozen scene, Sol 14 #1 in every order), `reui/whiteboard/whiteboard-authorship.test.ts` (Sol 13 through the production controller and `replaceContent`, Sol 14 #2 through classification and `useAutosave`, a vanish is local), `whiteboard-vanish.test.ts`, and the model, whose RANDOM draw keeps `vanish` and `import` with an immutable (id, version, nonce) authored-set oracle (default 500x40, and `SEEDS=2000 STEPS=60`).
- **Accepted gap: edit versus delete.** A remote edit deferred during a gesture is not in the scene, so a concurrent deletion authored at lastScene + 1 may tie or lose to it. That is concurrent edit-versus-delete under Excalidraw's own rule (higher version wins, a tie goes to the lower nonce), not something the saver should paper over.
- **`adoptRevisions` must not overwrite an edit made before `onReady`.** It puts the server's revisions back in place after the editor's restore of `initialData` bumped them. An edit that landed first (the editor reports nothing until its next change) had its revision replaced with the stored one: the saver then saw the stored key, so the edit showed Saved and no elements frame was ever sent. It now skips an element the change tracker says moved off its loaded revision other than by a merge (`editedSinceLoad`). Reproduced at the harness level (the browser pass B-11 symptom matches; not confirmed in a browser). Gate: `whiteboard-mount-after-restore.test.ts`.

### #499 round 15: zero-size elements (browser FAILs 1 and 2)

- **A remote winner the renderer drops is not an interaction skip.** `restoreElements` discards a live 0x0 element, so "incoming wins but the scene did not take it" is not always an edit in progress. The applier deferred it and replayed it on every change event; each replay re-ran `updateScene`, which fired another change event (React error 185). Now `mergeRemote` lets a dropped winner claim its index and take the local copy it beats off the board (a fresh load shows neither; under a gesture the local copy stays), the applier defers only ids `interactingIds()` names at apply time and replays only when that set is empty, and an id the scene never took is passed to the vanish observer's `forget` so a non-author tab never authors its deletion.
- **Invisibly-small live elements are finalized as deletions by the author's editor, never on load.** A shrink that leaves a live 0x0 element with no pointer-up finalize would be sent as an ordinary edit. The canvas's `handleChange` reports the scene once, drops such elements (`unfinalized`, minus anything a gesture holds) through `updateScene`, and the vanish observer authors the deletion with the last valid geometry (a restorable 1x1 when it never saw one). A stored live 0x0 row is already "not on the board" for every tab, so there is deliberately no load-time cleanup: authorship needs a user action, every tab would race with different nonces, and a view-only tab cannot send.

## 2026-10-04 — Embedded images in Project discussion (#493)
Tags: rich-text · #493

- An embedded image is a stored-document node that names media by id (`{type:"image",attrs:{mediaId}}`); the editor's Tiptap `EmbeddedImage` has no `parseHTML`, so a pasted `<img>` or `data:` URL never becomes a node, and both `toTiptap` and `tiptapToRichTextDoc` need an explicit image branch or the attr is dropped.
- A comment's media statements are appended after every statement whose result is read by position (since #527 a trailing archived-snapshot SELECT follows them) and fenced on the winner's audit row, so positional batch results stay valid and a lost race attaches nothing. They are self-validating in SQL (every wanted id is attached by an UPDATE whose WHERE accepts only a fresh pending upload of this author, or a row this comment already owns; the rest is detached; a guard INSERT violating `bytes > 0` rolls the whole batch back when the attached count is short, surfaced as `CommentMediaConflictError` / 409). The route's pre-read (`resolveCommentMedia`) is advisory only: state read before the batch is stale by the time it runs. Delete marks the media detached with `detached_at = 0` (due now) in the same batch; the route then deletes objects and rows best-effort and the daily sweep is the backstop.
- Do not keep a standing `<input type="file">` in the composer: the Workspace tests (and the external inventory) treat any file input as an upload control. The picker is the installed ReUI `Input type=file`, mounted only while a choice is being made (unmounted on change or cancel). A DOM-created native input is NOT the answer: it dodges the JSX-only primitive ratchet.
- Cleanup ownership must outlive the row. A row can vanish (Project cascade, a sweep) while R2 still holds, or is about to receive, its bytes: a multipart abort can fail, a completion can finish late. So every path that gives up a row, or an object, either deletes the object or writes its key (plus the multipart `upload_id`) to `embedded_media_cleanup`, which has NO foreign key on purpose. The Project hard delete queues every media key in the same batch as the cascade and drops the entries it resolved afterwards, keeping those whose abort failed. The sweep never deletes an expired uploading row's objects itself: one batch moves its keys to the queue and deletes the row under the expiry predicate, then the drain aborts the upload (a missing upload is terminal), deletes the object and only then the entry. `complete` is claim-first: a rejection or lost promotion calls `claimAndDiscardUploadingMedia`, which in ONE batch deletes the still-`uploading` row and queues its key under that claim, and only the claim winner deletes the object. A row that is gone, pending or attached is someone else's: do not touch R2 (a delete-then-claim order destroys a live image another writer just attached). The hard delete dequeues only the keys it queued itself (`queued_at` = its own timestamp) AND deleted AND aborted, never a Project-wide delete, which would erase entries a sweep or a concurrent completion queued. Deleting the object of an uploading row before its upload is terminal is wrong, a late completion recreates it.
- For pending and detached rows the sweep still claims first (CAS to `detached`/`detached_at = 0`, an unowned row taking its own id as `owner_id` per the table's CHECK), deletes objects, then the row, queueing the keys if R2 refuses. `complete` promotes with a CAS that requires a live, unarchived Project.
- aws4fetch retries 5xx with long backoff: an S3 stub that answers 500 makes a test take 17s and time out. Stub 403 for a failing abort, and read the method from the `Request` (aws4fetch passes no `init`).
- An async upload must remember where it started: capture the position (cursor, or `posAtCoords` for a drop) and map it through every later transaction (`editor.on('transaction')` + `transaction.mapping`), or completion replaces whatever the user selected meanwhile. An unmounted editor must not call its host's busy callback, or it clears the flag of the editor that replaced it.
- jsdom has no layout: ProseMirror's `handleDrop` never runs unless `document.elementFromPoint` / `caretPositionFromPoint` are stubbed.

## Embedded images on the Notice board (#496)
Tags: rich-text · #496

- **A post is created after its images are uploaded, so the R2 key cannot carry the post id.** Notice media sits under `notice-board/embedded-media/<mediaId>/original` (outside `projects/`, so a Project hard delete never touches it) and the post owns it through the D1 row (`owner_kind='notice_post'`, `owner_id`). Deleting a post is a D1 operation, never a key-prefix delete.
- **The Notice profile must take images on the read path too.** `storedContent` falls back to the plain-text document on a parse failure, so a profile that writes images but whose read profile does not shows every image post as plain text (the same failure #492 hit for tables). `NOTICE_RICH_TEXT_PROFILE.allowMedia` is set on the profile itself, once.
- **The attach/preflight/purge SQL is owner-generic** (`lib/embedded-media.ts`: `preflightOwnedMedia`, `ownedMediaStatements`, `purgeDetachedOwnerMedia`), fenced by a caller-supplied EXISTS clause: the audit row for comments, `EXISTS (post id AND author_id)` for notices. Without the post fence an edit racing a delete attaches images to a post that no longer exists, and attached rows are never swept. The attach UPDATE also requires `kind = 'image'`.
- **Notice routes live on `noticeBoardRoutes`** so the `/notice-board/*` capability gate covers them (External editors get 403 before routing, trailing slashes included). The media route gates an attached notice image by `viewNoticeBoard` and answers 404 (not 403) to anyone without it.
- **A raw `D1Database.batch` is needed once media statements are involved**: the Drizzle batch cannot carry the raw SQL, so PATCH and DELETE moved into `editNoticeBoardPost` / `deleteNoticeBoardPost`. The delete batch detaches the images with `detached_at = 0` only if the post is gone (`NOT EXISTS`).
- **The new-post and edit composers keep separate upload locks**; Ctrl/Cmd+Enter goes through `submit()` / `saveEdit()`, which refuse while their own composer uploads.

## Embedded image viewer: never upscale, 48px close, editable alt (#553)
Tags: rich-text, css-tokens · #553

- **Fit the dialog to the image, do not stretch the image to the dialog.** `DialogContent` is `w-fit` and the viewer `<img>` is `w-auto max-w-full h-auto max-h-[90dvh]`; `w-full` upscaled a 600px photo to 1024px.
- **A scrim chip needs the dialog's corner and a hairline ring, or it reads as a bite out of the corner.** `--scrim-overlay` is also the backdrop, so the chip is `rounded-xl` with `ring-border`, and the Close button fills it (`size-[var(--space-7)]`, 48px) instead of the built-in 28px one (`showCloseButton={false}`). `EmbeddedVideoDialog` still has the old chip.
- **Alt is a node attribute, not a label.** `{type:"image",attrs:{mediaId,alt?}}`; the validator trims it, drops blank/null, rejects non-strings and over `RICH_TEXT_IMAGE_ALT_MAX_LENGTH` (200). The Tiptap attribute is `rendered:false` and both mappings (`toTiptap`, `tiptapToRichTextDoc`) must carry it or it silently disappears (#493). The default is `imageAltFromFileName(file.name)` at insert time (no schema or D1 change); the editor's selected image shows an "Alt text" popover (`EmbeddedImageEditorNode`, the LinkPreview node-view pattern).
- **A trigger `aria-label` replaces the image's alt for screen readers.** The thumbnail button is named `View image: <alt>`, never a generic label. An image with no alt falls back to `Embedded image`.

## A date popup opened under the sticky top bar with its month navigation scrolled away (#528)
Tags: focus-overlays, css-tokens · #528, #597, #602

- **`collisionPadding` is measured from the viewport, not from the sticky shell header.** On New shoot the Deadline sits low in "Add details now" and its form (shortcuts, calendar, time column, reminders, the #509 note) is taller than the room above or below it, so the desktop `{ fallbackAxisSide: "none" }` policy flipped it above the field, where `--popover` (z 90) painted over the 50px top bar (z 75), and `--available-height` capped the body so it scrolled. Source-confirmed; the browser pass confirms the geometry (popup top >= header bottom + 16, month navigation and Today / Tomorrow visible with the body at `scrollTop` 0).
- **Fix, scoped to New shoot's Deadline.** `DateTimeField` takes `popupCollisionAvoidance` / `popupCollisionPadding`, resolved `override ?? default` by `resolveDateTimePopupPlacement` (an `undefined` override never erases the #447 phone policy). New shoot passes `{ side: "shift", align: "shift", fallbackAxisSide: "none" }` and a top padding of `shellChromeBottom() + 16`, read once when the popup opens (it includes the impersonation banner). It may cover its own trigger. `fallbackAxisSide: "none"` stays (#422).
- **Initial focus must not scroll the body.** Base UI's own `focus()` on the selected day scrolled a short body past the month navigation and presets. `initialFocus` now focuses with `{ preventScroll: true }` and returns `false`; the Popup / Range `focusOnMount` do the same, and `reui/calendar`'s day button no longer re-focuses a day that is already active.
- **Other date popups keep the default policy** (Project header Deadline, Checklist, Dashboard Table, shoot date, Calendar Move dialog). **Amended by #587:** the Timeline pickers (Due cell, bar picker, Project Deadline cell) now take the same shell-aware shift, through the shared `SHELL_AWARE_SHIFT_AVOIDANCE` / `shellAwarePopupPadding()`; the rest stay on the default. **Amended by #597:** placement policy is now two tiers. Timeline and the Dashboard Deadline cell (same `ProjectDeadlineCell`) take the full shell-aware shift (`SHELL_AWARE_SHIFT_AVOIDANCE` + `shellAwarePopupPadding`). The Project header Deadline and the Checklist take the padding only, with the default avoidance. `shellAwarePopupPadding()` measures the top from the open Project sheet (`[data-slot="sheet-content"][data-open]`, the last one) when there is one, else the shell header, because the modal sheet is what covers the viewport top there; a `data-closed` sheet is ignored. The padding callback is also re-read on a `resize` while the popup is open (`useReresolveOnResize`, one read per frame, #602), never together with `pinnedToField`, which scrolls the page.

## A stored 29th or 30th opened a date picker with the day out of sight (#587)
Tags: focus-overlays, scheduling, qa-browser · #587

- **#537's "wholly outside the body is ignored" skip was right for the secondary item and wrong for the day being edited.** A late-month stored day sits in the sixth grid row; with the popup capped by `--available-height` (a short viewport, a phone) it starts wholly below the fold, so `scrollTopClearOfFade` skipped it and the body opened at 0 with the selected day out of sight. `scrollTopClearOfFade` items now take `required`: a required item is never skipped, and if the intersection comes out empty the solve retries with the required items alone (the optional ones give way), and if those conflict too, with the `priority` item alone: the focused control wins over the reveal day (WCAG 2.4.11). A resize solves from the current `scrollTop` while a control has focus, rather than resetting to 0 first, or the conflict rule would return 0 and leave the focused input below the body. Non-required items keep #537's skip.
- **What is required.** `PopupFrame` takes `reveal`, a selector inside the body: the picked day for the date and date-time forms, a range's ACTIVE end (`button[data-range-${active}="true"], button[data-selected-single="true"]`), never every in-range day. Mount and resize require the reveal day and the focused element inside the body; a selection change requires only the focused element, so changing the month with the month select focused does not scroll the select away. The Start/End toggle changes `reveal` through a ref, not an effect dependency, because re-running the effect would reset the manual-scroll latch.
- **`focusin` covers `preventScroll` focus** (the opening focus, the Start/End handoff). It always solves with the focused element required and fade-aware, starting from the current scroll, so a clear cell does not move. It must not stop at "inside the body box": the calendar's arrow-key `focus()` scrolls natively, and can leave the cell inside the fade band (64px on a phone, a 44px cell), where it reads muddy; the follow-on nudge is at most the fade height. Writes are `viewport.scrollTop` only, never `scrollIntoView` (it also scrolls the page and the Gantt, see "Gantt landing row"), and every write sets `applied` so the manual-scroll latch (`userScrolled`) still holds. A manual scroll followed by a resize leaves the body where the person put it; focus is never latched out, because focus has to be visible.
- **Timeline pickers shift instead of flip.** `SubtaskScheduleControl` and `ProjectDeadlineCell` take optional `popupCollisionAvoidance` / `popupCollisionPadding`; the Timeline Due cell, the bar picker and the Timeline Project Deadline cell pass `SHELL_AWARE_SHIFT_AVOIDANCE` and `shellAwarePopupPadding` (shared with New shoot, behaviour unchanged there). The padding function runs once per open. `SubtaskScheduleControl` resolves it on the closed to open edge of `open` in render, because the bar host mounts it with `open` already true, so `DateTimeField`'s `onOpenChange` pattern does not transfer.
- **Test it with a rect mock that follows `scrollTop`.** A static `getBoundingClientRect` makes every resize case vacuous (the day never moves, so nothing needs a scroll). `PopupFrame-reveal.dom.test.tsx` gives every day a document offset and subtracts the body's `scrollTop`; key the day by `[role="gridcell"]`, because the day button carries its own locale-formatted `data-day`.

## `reui/select` popup takes the overlay treatment, and its item ring is inset with `!` on colour and offset (#522)
Tags: reui-vendor, focus-overlays · #522

The vendored Select popup shipped `ring-1 ring-foreground/10`, no shadow and no inner padding, so the highlighted row ran edge to edge and its outward `:focus-visible` ring was clipped by `overflow-x-hidden`, while the `focus:bg-accent` fill painted a second indicator. It now matches `reui/dropdown-menu` and `quincy/menu` (`border border-border`, `shadow-[var(--shadow-md)]`, `rounded-none`, `p-1` on the List so scroll arrows stay flush). The item draws the global ring inside the fill: `focus-visible:!outline-[color:var(--accent-on)] focus-visible:!-outline-offset-4`. Both need `!` because `tokens/base.css:25` is an unlayered `outline` shorthand that resets colour and offset; `outline-none` is suppression and guard 3 tracks it. Pinned as source text in `styles/design-system-guards.test.ts` (happy-dom resolves no cascade); the built CSS is the proof the utilities were emitted.

## The Notice-board table bar: zone per pass, phone group, and one breakpoint (#535)
Tags: css-tokens, search-filters · #535, #555, #594, #595

- **A boundary's edges are the final bar's limits.** Tiptap 3.30.2 orders flip -> shift -> offset, so flip/shift judge the bar BEFORE the 8px offset; their `padding: 8` and the offset's 8 cancel, which makes the boundary rect's edges equal where the bar finally sits. `tableBubbleZone` (`rich-text-table-position.ts`) therefore computes the fits (`row.top - 8 - H >= ceiling`, `row.bottom + 8 + H <= floor`) in final-position terms and adds the WebKit visualViewport offset to the rect afterwards, never before.
- **Protect the ROW, not the cell, and read the bar's height from floating-ui.** The old boundary was one rect (surface top down to the helper), so a middle row could be covered by clamping or the bar could land on the neighbouring paragraph. `flip`/`shift`/`offset` are derivable options reading `state.rects.floating.height` and fresh neighbour rects on every pass, so the answer does not depend on which placement floating-ui is trying (it resets per pass).
- **There is no "wide" tier: a bar that covers a neighbouring block is a bug (#535, tight fit).** The measured case (a middle row with 41.2px above and 33.2px below, a 37.6px bar needing 45.6) fell to the wide zone and covered the previous paragraph by 4.4px. The zone now picks, in order: `clean` (8px gap above, else below, inside the viewport), `tight` (the roomier side, gap = room - H - 0.5, so 0 <= gap < 8), `offscreen` (the viewport cuts the room, the blocks allow it: `rootBoundary: "document"`, the bar is partly scrolled out, never clamped onto the row), else `none`. The offset is a function returning that same gap and the flip/shift padding is `{top: gap, bottom: gap, left: 8, right: 8}`, so the side flip judges is the side the bar lands on. `fallbackStrategy` is `bestFit`.
- **#555 supersedes the "never covers a neighbouring block" rule: the bar docks to the TABLE and may cover adjacent text, never a cell or the frame (owner decision 2026-10-06).** With real layouts the room between the previous block and the table is 8px (and 0 or 8px below), so a zone bounded by the neighbouring blocks was `none` every time and the controls always lived in the toolbar group. `tableBubbleZone` now anchors to the whole table (`tableBubbleAnchor`: the table's vertical extent, the active cell's column clamped to the table) and judges room above = table top minus the higher of the surface top and the visible viewport top (`shellChromeBottom()`, the sticky header covers about 75px), room below = the lower of the surface bottom and the viewport bottom minus the table bottom. Above with the 8px gap if it fits, else below, else tier `none`. A table scrolled so both docked spots are outside the visible area is `none` too (the old `tight` and `offscreen` tiers are gone). The bar may float over the paragraph above or below the table, but never over a cell, and never past the surface bottom, so the helper line stays visible. Pinned by the "dock" cases in `rich-text-table-position.test.ts`.
- **Shift must not move the bar vertically.** With `crossAxis: true` the far-side padding nudged a bar that was already clear (a row sitting at the viewport's bottom edge got a 16px gap instead of 8) and, on a side that does not fit, clamped it onto the row. `shift` is horizontal only (`crossAxis: false`).
- **Tier `none` hands the controls to the toolbar group, once.** `tableBubbleOptions({ onTier })` fires only when the tier changes (the zone is recomputed by flip, shift and offset on every pass, so the callback dedupes; the options are rebuilt when the caret enters or leaves a table so the memory restarts). `QuincyRichTextEditor` shows `RichTextTableTools` when `phone || tier === "none"`. The bar stays MOUNTED (unmounting makes the height 0 and the tier flickers) but `RichTextBubbleBar` is `inactive`: `inert`, `aria-hidden`, `invisible` on the bar element, never on Tiptap's own menu element (Tiptap rewrites its inline `visibility` every pass). `focusFirstToolbarStop` refuses an inert root, so Alt+F10 reaches the group's handler instead of a bar that cannot take focus (happy-dom does not implement `inert`). An unmeasured bar (height 0) is judged `clean` so the group does not flash before the first layout. The presentation-switch focus transfer is keyed on "table controls are in the toolbar", not on `phone`.
- **#595 supersedes "the group is the FIRST group" on a desktop (owner decision 2026-10-06).** Leading the toolbar with `RichTextTableTools` shoved every control about 150px sideways and pushed Redo under the scroll fade. At tier `none` a desktop now swaps the Insert-table button (useless inside a table anyway) for `RichTextTableMenu`, one icon-only "Table options" dropdown in the same Layout-group slot, with the SAME size and variant as the Insert-table button (a labelled "Table ▾" trigger was 78px against 28px and pushed Insert image/Undo/Redo 50px right), so the toolbar's order and x positions are unchanged. A DOM test compares its className to the Insert-table button's. Only the phone (`phone && state.inTable`) still leads with `RichTextTableTools`. The bar, the phone group and the menu share `tableCommands`; Alt+F10 focuses the menu trigger and Escape returns to the text (capture phase, as above). The desktop no longer resets `scrollLeft`; the menu writes `scrollLeft` only if its slot is scrolled out, and never calls `scrollIntoView`, which moves the page. The focus-transfer check matches `rich-text-table-menu` as well as `rich-text-table-tools`.
- **The Notice board composer's toolbar is sticky (#594), and the stuck toolbar is a second ceiling.** The element that sticks is the `InputGroupAddon` (a sticky `RichTextToolbar` alone does nothing: its containing block is the toolbar's own wrapper, not the field). It carries the named class `.rich-text-toolbar-sticky` (`app.css`, `top: var(--shell-header-height)`, `z-index: 2`, `background: var(--card)`, plus the `.app--impersonating` variant); a utility `sticky` would be banned by `unlayered-utility.guard`. Document preset only; the discussion composer is unchanged. The table bar's `viewport` top is `max(shellChromeBottom(), ceiling())` (`viewportBelow`), the editor passing the addon's bottom, so a bar never docks under the stuck toolbar. Document-preset `h2`/`h3` carry a `scroll-margin-top` clearing header plus toolbar, so an outline-rail jump (`scrollToRichTextHeading`) is not hidden under it.
- **ProseMirror scrolls a caret into view against the viewport edges only (#594).** A caret moved up (ArrowUp, typing at the top) landed under the stuck toolbar. The document preset sets `scrollThreshold.top` (the toolbar bottom) AND `scrollMargin.top` (the toolbar bottom plus 8px, `--space-2`, so the caret lands clear, not flush) (ProseMirror only scrolls once the caret is within the threshold of the edge; the margin alone never triggers it) with `top` = the addon's computed sticky `top` plus its height (constant, so independent of being stuck right now), refreshed on resize, on the addon's resize and on editor focus. The composer preset leaves it alone.
- **The bar's own outer `p-1` cost 8px.** `RichTextToolbar` already pads its scroller by `--space-1`; the extra card padding made the bar ~46px, which did not fit above row 2 of a first-block table. Without it the bar is ~38px.
- **Below 721px the table controls are a toolbar group, not a floating bar** (owner decision): `RichTextTableTools` leads the Formatting toolbar (`order-first`), `RichTextTableBubble` is unmounted (not CSS-hidden, so no stale plugin or Alt+F10 handler), and `RichTextTableControls` is the one shared control set. The group appears with the caret in a table and resets the toolbar's `scrollLeft` to 0.
- **The JS phone query must be `"(width < 721px)"`.** Tailwind's `max-[721px]:` compiles to `@media (width < 721px)`; `"(max-width: 721px)"` (what `TABLE_NARROW_QUERY` uses for the dashboard table) also matches at exactly 721px, so the two presentations would disagree at one width. `RICH_TEXT_PHONE_QUERY` lives in `rich-text-toolbar.tsx` and a contract test pins it.
- **Escape from a Base UI control does not bubble.** A `button` / tooltip trigger handles Escape and stops it, so a bubble-phase `onKeyDown` on the wrapper never saw it: the phone group listens in the capture phase (`onKeyDownCapture`, with the `fromOwnDom` guard so portalled menu events are ignored). Tiptap's `commands.focus()` lands on the next animation frame; await it in tests.

## A finished upload selected the inserted image, so the next keystroke replaced it
Tags: rich-text · #494

- **Tiptap's `insertContentAt` selects the inserted content by default.** An embedded-image upload completes asynchronously, so the insert landed a `NodeSelection` on the whole image while the author was still typing; the next keystroke replaced the image with a paragraph (seen in real Chrome).
- **Async inserts must pass `{ updateSelection: false }`** as the third argument so the caret stays where the author is typing. Pinned by `QuincyRichTextEditor-media.dom.test.tsx` ("keeps the image when the author types on after it lands"). Behaviour change: a just-uploaded image is no longer selected, so Backspace right after an upload no longer deletes it.
- **Video uploads share that one insert call (#494).** Images and videos complete through the same `insertContentAt(..., { updateSelection: false })`; the video case is pinned by `QuincyRichTextEditor-video.dom.test.tsx` ("keeps the video when the author types on after it lands").

## 2026-10-05 — Video in Project discussion (#494)
Tags: rich-text, media-renditions · #494

- **`fetch` cannot report upload bytes, so a video's parts go over XHR.** `uploadMultipartFile` takes an opt-in `UploadControl` (`signal`, `onBytes`); a caller that passes none keeps the fetch path unchanged. Cancel aborts the part in flight, starts no further part and rejects as an `AbortError`; the editor then tells the server (abort route) so no reservation is left.
- **The poster is captured in the uploader's browser, best effort.** `captureVideoPoster` seeks to min(1s, 10% of duration), draws at most 1280 on the long edge and exports a JPEG. A file the browser cannot decode (ProRes) answers `null` and the video posts without a poster; capture runs alongside the byte upload and never delays it.
- **Playability is a per-viewer decision.** Nothing is transcoded, so `EmbeddedVideo` falls back to a download link from the `<video>` element's own `error` event, not from the stored content type.
- **`/media/embedded/:id` answers byte ranges** (parser in `@quincy/shared`, unit table beside it), which is what makes a large file seekable. The sweep deletes poster and display keys with `UPDATE ... RETURNING` at claim time, so a claimed row owns the keys it removes.
- **A video upload warns on `beforeunload`**, only while one is running; images finish too fast to warrant it. Unmounting the editor cancels any running upload.
- **The playback-failure fallback is the same box as the player (#592).** It renders inside `EmbeddedVideo`'s own wrapper as `.rich-text__embedded-video.rich-text__embedded-video--unavailable`, so it inherits the 16/9 box and clamp and swapping it in for the `<video>` moves nothing below it; the modifier only centres the content (no own `aspect-ratio`/`max-height`). A posterless video's player `src` (composer preview and posted) carries `#t=0.1` so the browser paints a first frame; the download href and `renderHTML` stay on the bare URL. The composer node's own `onError` shows "This video can't preview in this browser." in the same box and keeps the Video badge.

- **The embedded media cleanup queue is a lease, and a claim is permanent for adoption (#494).** The sweep claims an entry (`claimed_until` = now + 10 min, `attempts + 1`), cleans the object, and deletes the entry only after that succeeded. Fence every post-claim statement (dequeue and release) on `storage_key`, the `attempts` and `queued_at` the claim returned, never on `claimed_until`: two sweeps sharing a scheduled `now` get identical lease values, and a stalled sweep must never touch an entry a later claim or a re-queue owns. Release sets `claimed_until` to 0, not NULL: still reclaimable, but a poster adoption requires NULL, so no claim can ever be followed by an adoption (a NULL release let a late PUT adopt an object the stalled first sweep then deleted). Only a re-queue clears it to NULL, and only for an object the route has given up on. Every PUT uses a fresh nonce key.
- **Accepted gap (poster PUT).** If the adoption batch throws or loses, the route deletes the object, then re-queues it if R2 refused. An orphan can remain only when the R2 delete AND the following D1 write both fail back to back. It is logged as `Embedded poster ORPHANED` with the key. A throw after the batch is verified from the row in three outcomes: adopted (keep, 204), confirmed not adopted (discard), unknown because the verification read threw too (keep the object, delete nothing, queue nothing, log `outcome UNKNOWN` with the key, 500): deleting or queueing there could destroy a live poster, so a possible leak in that case falls under the same accepted gap. The orphan sweep (#549, `docs/lessons.md` § "Embedded media orphan sweep (#549)") now queues such an object once it is a week old.
- **A finished upload's own insertion must not clear upload problems (#494).** `QuincyRichTextEditor`'s `onUpdate` clears `uploadErrors` on every doc change, and an async upload completes with `insertContentAt`, which is a doc change: the cap or type problem shown for one file vanished as soon as a sibling upload landed. The upload insertion transaction carries `UPLOAD_INSERT_META` and `onUpdate` skips the clear for it; only the author's own edits (and a host content replacement or a new pick) clear errors.

## 2026-10-05 — Link previews in discussion and Notice board (#497)
Tags: rich-text · #497

- **A card node stores its id and nothing else.** The editor node carries the display fields only so it can draw; `tiptapToRichTextDoc` strips it to `{ previewId }` and the server's `fillLinkPreviews` fills title, description, site, URL and image back in from its own row. Both the Tiptap mappings are explicit (an attribute with no mapping silently disappears, #493), and a request that carries a forged title has it dropped on save.
- **The fetch lives in the background worker, and the checks still run twice.** The deployed `global_fetch_strictly_public` flag keeps a fetch off private networks, but local development has no such protection, so `checkPreviewTarget` runs on the address, on every redirect hop (followed by hand, three at most) and on the image. The fetch is injected as `(...a) => fetch(...a)` (the Workers illegal-invocation lesson above), under one deadline that covers every await, and the first 1 MiB of HTML is parsed.
- **Image bytes come back over RPC.** A Workers RPC call may carry 32 MiB serialised, and the image is at most 5 MiB, so the background worker returns the bytes and the app worker writes R2 claim-first like any embedded media. The image type comes from the bytes (JPEG, PNG, WebP); a GIF or anything else gives a card with no image.
- **A card is asked for when a link is applied, not when the post is saved.** `RichTextLinkPopover` gained an optional `onApplied(href)` (called after Apply, never Remove). Autolink and link-on-paste are off, so a pasted bare URL gets no card. The answer is dropped if the host replaced the content (a post cleared the composer), the editor unmounted, three cards already exist or that address already has one; no card, a 429 or a failure all leave the link a link and posting unaffected.
- **Save reconciles previews in the post's own fenced batch.** `linkPreviewStatements` is appended last (batch results are read by position): one UPDATE takes the wanted previews, the rest of the owner's are deleted, their images detach for the seven-day grace, and a guard insert violates a CHECK if the wanted previews are not all held. `ownedMediaStatements` leaves `preview_image` rows to it.
- **Count attempts, not results, and reserve in one statement.** A limit counted from `link_previews` rows was bypassed three ways: failed fetches left no row, deleting a card gave the fetch back, and concurrent requests all passed a read-then-write count (35 admitted). `link_preview_attempts` has a row per fetch started (kept when a card goes, swept after a day), reserved by one `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < 30 ON CONFLICT DO NOTHING`, so 0 rows changed means 429 or in progress. The partial unique index (`WHERE status = 'fetching'`) lets one fetch per person, place and address run at a time: the duplicate gets 409 `link_preview_in_progress` and the client asks once more after a moment. A fetching row older than two minutes is treated as lost.
- **A late card must check its link is still there.** The fetch outlives the editing, so before inserting the card the editor checks the doc still has a link mark with that exact href (Undo and replacing the link both remove it), as well as that it is mounted and its content not replaced.
- **The card keeps the typed address.** `checkPreviewTarget` returns `url` (fragment kept, the card's target) and `fetchUrl` (fragment dropped, fetched and used as the attempt key). Entities are decoded with the `entities` package, not a hand list.
- **A persistent `mockRejectedValue` fails a Vitest 4 test** even when the code handles the rejection, so a test that needs a rejection uses `mockRejectedValueOnce` per call.
- **Link-preview cards are async inserts too (#548/#497).** The arriving card uses `insertContentAt(..., { updateSelection: false })`, pinned by "keeps the author's selection and the card when the author types on after it arrives". And Remove returns focus with `editor.view.focus()` *before* the button unmounts: Tiptap's `commands.focus()` defers to the next frame, and the Project sheet's focus manager parks focus on the popup in between (Cmd+Z then goes nowhere). jsdom cannot reproduce the parking, so the test asserts the editor holds focus in the same tick as the click.
- **`::selection { color: inherit }` inherits the parent's `::selection`, not the element's colour (#497).** With Chrome's highlight inheritance the card's "transparent, inherit" rule resolved to the global paper-050 selection text, so a selected card stayed paper-on-white. Give each slot the explicit token its normal colour uses (`--text-primary`, `--text-secondary`); the contract test in `styles/link-preview-card.design.test.ts` rejects `inherit`/`currentColor` there. And a card in the composer is `interactive={false}` (no `<a>`), so a click only selects the node instead of opening a tab.

## Whiteboard versions, server half: snapshots, the single alarm and restore (#500, Phase S)
Tags: whiteboard, workers-runtime · #500

- **A snapshot is an R2 object plus a D1 index row, written in that order.** `project_whiteboard_versions` (migration 0061; 0059 and 0060 are reserved by open PRs, so it lands after them or is renumbered at merge) is metadata only, and a `ready` row is inserted only after its object exists. Prune is mark `pruning`, delete the object (a missing one counts as deleted), delete the row, so a failure leaves a `pruning` row for the next alarm and the listing never offers it.
- **Dirty is a revision, not a flag.** `scene_revision` rises inside the SAME `transactionSync` as the winning rows (`reconcile`'s `afterWrite`), `published_revision` is what a capture covered, and a publication clears dirtiness only THROUGH the revision it captured. An edit that lands during the R2 PUT or the D1 insert stays dirty, and arms its own deadline because the capture cleared `snapshot_due_at`.
- **The cadence never slides.** The first winning change sets `snapshot_due_at = now + 30 s` with `COALESCE`, later edits leave it, and one alarm serves every deadline (cadence, publish retry, prune retry, audit retry) as the earliest of them. An alarm that wakes early only re-arms. Tests drive time through the object's `clock` and assert `getAlarm()`; they override the clock with a time an hour ahead so the REAL alarm never fires mid-test.
- **Last leave goes through the alarm, not an un-awaited publish in `webSocketClose`.** A close handler's floating promise is not durable in a hibernating object. `markLeave()` sets the deadline to now and the alarm publishes. "Last" counts `ctx.getWebSockets()` that are OPEN apart from the leaving session (viewers and a person's other tabs count), never the in-memory presence map; revoke, close and error share the path, and an equal scene hash dedupes the second publish.
- **Dedupe hashes the rows in id order, tombstones included.** An unchanged cadence or leave checkpoint publishes nothing and still advances `published_revision`. `pre_restore` is never deduped. A retried publication reuses the same version id (so the same R2 key) and recaptures the scene, and a row that already exists is adopted rather than overwritten.
- **Restore returns, it never throws, inside `blockConcurrencyWhile`.** A throw there resets the object (presence, the refresh queue and the access epoch are in memory). Every failure (missing or corrupt snapshot, backup failure, archive, removal) is a returned result. `blockConcurrencyWhile` holds new events, but a write that was already past its `authorize` await is not an event: the `restoring` flag and a generation recheck AFTER that await refuse it, and the install itself is one synchronous transaction.
- **A restore installs the snapshot's rows exactly and bumps the board generation.** An old snapshot cannot enter ordinary version/nonce reconciliation (a stale high-version edit would beat it, and Undo would resurrect a removed shape). So `generation` is on `init`, every batch in both directions, `ack`, `rejected` and the new `reset` frame; an absent or stale generation is refused with reason `generation`. A tab that predates generations is refused, not closed, so it can say "reload". Until Phase C resets the editor, a restored board's connected tabs have their sends rejected.
- **The request id is the idempotency key.** `wb_restores` records a committed restore by request id: a repeat answers with the same result, a different version under the same id is `request_id_reused`, and a failed attempt records nothing so the same id can be retried. The audit row (`project_whiteboard.restore`, effective user, `impersonatedBy` in `metaJson`) is written from that durable record with a deterministic id, so a failed write is retried by the alarm and a repeat inserts nothing.
- **Purge raises a fence first.** `purge()` sets it before closing sockets; an operation that sees it move abandons itself (and deletes a key it already PUT), and the purge drains what was running before it deletes the storage. A purge that is not followed by the Project's deletion leaves a working board, because the fence is a counter, not a flag.

## Whiteboard versions, client half: a restore resets the editor (#500, Phase C)
Tags: whiteboard · #500

- A `reset` frame, or a reconnect's `init` on a newer generation, REMOUNTS the editor (`key` = reset count) on the restored scene; it is never merged. Merging would let a stale tab's higher element versions beat the restored rows. The socket, the peers and the collaborators stay.
- The saver, vanish observer and remote applier are one *session per generation* (`startSession` in `ProjectWhiteboard.tsx`): `saver.seed` only adds, so reusing one carries `transmitted`/in-flight state across a restore. Each session seals its saves for its own generation (`socket.send(batch, generation)` refuses a mismatch without sending), so an old editor's late save is never stamped with the restored generation.
- The canvas autosave flushes on unmount. That flush is exactly what would resurrect a shape the restore removed, so `discardSave` (a `Whiteboard` prop) makes both the teardown and the timer flush drop the pending edit. The flag is raised synchronously when the reset is seen and lowered in an effect after the new editor commits.
- An `elements` relay (or a rejection) of a NEWER generation than the socket knows means the socket missed the `reset`: it closes and the reconnect's `init` carries the scene. Relays of another generation are never delivered.

## Whiteboard media, server half: attach on snapshot and the stale-tab gate (#501, Phase S)
Tags: whiteboard, media-renditions · #501

- **A board image is a reference, not bytes.** An `image` element whose `fileId` is an `embedded_media` id plus `customData.quincyMedia.kind`; the schema checks the shape only and ownership is enforced by the attach SQL's Project scope and the read rule. A well-formed element for a row the viewer cannot read just renders "unavailable".
- **Attach and detach are one D1 batch per published snapshot, folded into `prune()`.** The retry is `prune_retry_at` (a throw lands in prune's catch), because `CREATE TABLE IF NOT EXISTS wb_state` would never add a column to a live object. Every id list is ONE JSON bind through `json_each(?)` (D1 allows 100 binds). The kept set is `project_whiteboard_versions.media_ids` (0062), written in the same INSERT as the row, so no snapshot object is ever re-read. `detached_at > cutoff` is what keeps the sweep's claim marker (0) from being re-attached.
- **Whiteboard media is readable in every state but `uploading`** by anyone with collaboration access to the ROW's Project: attach waits for the next snapshot (up to 30 s), and an undone image is detached while it can still come back. Comment and Notice rules are unchanged.
- **A tab loaded before #501 must never join.** It sweeps every image element on each change (remote ones too) and its vanish observer would author `isDeleted: true` for everyone's media. The socket path now carries `?protocol=2` (`WHITEBOARD_PROTOCOL`) and the upgrade route answers 426 `client_outdated` before addressing a Durable Object. Bump the constant when an older client could damage the board by joining.
- **The dev `direct` upload had no archived fence** (presign, complete and poster did): a reservation made before the archive could still take bytes. It now answers 409 `project_archived`.
- **In a test, `runInDurableObject` wakes a purged object and its constructor recreates `wb_state`**: assert the purge on `elements` (as the #498 test does), never on `wb_state`.

## Whiteboard media, web half: the resolver, the sweep and the click (#501, Phase W)
Tags: whiteboard · #501

- **The change-event sweep must never remove a well-formed Quincy media element.** `handleChange` also runs for REMOTE merges; a peer's new image has a `fileId` this client has never seen, and sweeping it makes the vanish observer author `isDeleted: true` for everyone. `isUnsupportedElement` is now "an `image` WITHOUT a UUID `fileId` and `customData.quincyMedia.kind`" (a foreign Excalidraw image), and the refusal of another board's media lives only at LOCAL entry points: paste (`pasteIsUnsupported(data, known)`), the scene-file load (`withoutForeignMedia` inside `controller.load`, which also drops the file's own image data) and the library (images stay excluded). `known` = an element of this board references the id (deleted included) or it was uploaded in this session.
- **Never give Excalidraw a URL that can fail.** A load error makes `updateImageCache` rewrite the element with `status: "error"`, a version bump the saver ships to everyone as THIS viewer's edit; and `addFiles` skips an id it already holds, so a placeholder can never be swapped for the real file in that editor. `lib/whiteboard-media-files.ts` resolves every reference into a loaded data URL first: transient failure (network, 5xx) adds nothing and retries bounded; 404/403 adds a drawn "Media unavailable" bitmap; a video is its poster with the play badge baked in (a poster 404 is asked again with a one-byte range on the video to tell "no poster" from "no video"). The cache lives in `ProjectWhiteboard` (a ref), because a restore remounts the editor: `onReady` attaches the new editor and `ensure` re-adds from the cache with no request.
- **`insertMedia` sets `status: "saved"`** (`newImageElement` defaults to `"pending"`), appends with one undoable `updateScene`, THEN `addFiles` (the editor scans the scene for uncached images), and never touches selection or scroll. Its `updateScene({ elements })` is listed in `whiteboard-scene-routes.guard.test.ts` under its own expression: reusing the `insert` route's text would make the guard's found list one longer than its expected list.
- **Excalidraw does not report what a click hit in view mode, and a pasted image FILE is handled before `onPaste`.** So a video click is the controller's own hit test (`videoAt`, only observing: edit mode still selects) and a pasted file is taken at the document's capture phase, while focus is inside the board and not in a text field. Dropped files route through `planSceneDrop`.
- **The Image tool slot is the host's.** `tools.image` stays false (it caps files at 4 MiB, downsizes to 1440 px, hashes the fileId, takes SVG/GIF and no video); the toolbar's Image toggle is relabelled "Image or video" and calls the host. The editor's key 9 does nothing now, so the tooltip and the shortcuts dialog no longer advertise it.

## HEIC in Embedded media, server half (#495)
Tags: media-renditions, queues-workflows, d1-migrations · #495

- **A HEIC image is `kind = 'image'` with its own `rendition_status`, and its original is never served.** `state` already means "uploaded, not attached", so the display copy's progress needed its own column (`not_required`, `pending`, `ready`, `failed`, migration 0063). The JPEG goes into `display_key`, which nothing had written before, so the sweep, the abort, the owner purge and the Project hard delete already cleaned it. `/media/embedded/:id` answers 409 `rendition_pending` (with `retry-after`), 404 `rendition_failed`, or streams `display_key`. A HEIC row that says `not_required` is a 404 too, so a bad row can never stream the original.
- **`EMBEDDED_IMAGE_CONTENT_TYPES` is not widened.** It feeds the presign enums, the web `accept` string and the serving content type. HEIC has its own list (`EMBEDDED_HEIC_CONTENT_TYPES`), `embeddedMediaKindFor` returns `image` for it, and `isEmbeddedMediaContentType` stays JPEG, PNG, WebP and video.
- **The video sniffer used to accept any `ftyp` box as MP4**, so a HEIC declared `video/mp4` was stored as a video. It now refuses every HEIF and AVIF brand. A HEIC `ftyp` lists its brands after byte 16 (the Samsung samples are 24 bytes: `heic`, then `mif1heic`), so the completion verifier reads 4096 bytes for every kind, and the upload sniff refuses a brand table that the bytes supplied truncate (a HEIC cannot hide behind a short read). A bare `mif1` or `msf1` is not HEIC (AVIF uses them too).
- **Admin-or-flag gate, checked twice.** `heicGate` runs at presign and again at complete, on the effective user, so an impersonating Admin is the staff they act as. Renditions off is a loud 503 `heic_unavailable`, never a silent drop. The flag `embedded_heic_uploads` is seeded off by the migration with `DO NOTHING` (the ownership guard fails any other seed) and flipped by the audited `PATCH /api/users/embedded-heic-settings`.
- **A processing or failed HEIC cannot be posted.** `ownedMediaStatements` and `preflightOwnedMedia` accept a fresh pending row only when it is `not_required` or `ready`. The gate is in the batch's own SQL, so a preflight that is bypassed still ends in the guard's CHECK. The whiteboard's snapshot reconcile deliberately has no such predicate: it is set-based and runs only on a snapshot, so a row that became ready later would never re-attach.
- **The conversion lives in `@quincy/db`, not in either Worker.** `generateEmbeddedDisplay` and the three cleanup helpers (`enqueueEmbeddedMediaCleanup`, `discardUnreferencedObject`, `settleThrownAdoption`) moved to `packages/db/src/embedded-media-lifecycle.ts` because both Workers import `@quincy/db` and its tsconfig already has the Workers types. The app lib re-exports them. The caller injects `transformUrl` and `fetch`, which is why the app's HTTP tests can run the whole conversion against a stubbed Image Transformations response. The background wires the signing in `embedded-display.ts`.
- **The lease must be released before a transient failure throws.** The claim holds the row for five minutes. A throw leads to `message.retry()`, and the redelivery arrives within seconds: with the lease still held it finds nothing claimable, acks, and the row sits until the ten minute cron. Every transient path (network, 5xx, 429, 408, a 403 HTML edge page, `err=9401`, a failed R2 put or queue insert, a thrown adoption) sets `rendition_lease_until = 0` first. A permanent failure (not a JPEG, `err=` decode, over 4096 px, EXIF or XMP left) sets `failed` and acks.
- **"Strip EXIF and GPS" is a check.** The request says `metadata=none`, and the consumer still walks the JPEG's marker segments (`inspectJpeg`) and fails a copy with an EXIF or XMP APP1. A HEIC passed through untransformed fails the `image/jpeg` content-type check, so the original can never become the display copy.
- **Adoption is claim-first, as the video poster is.** Queue the key, put the object, then one batch sets `ready` and unqueues the key, fenced on `rendition_status = 'pending'`, `display_key IS NULL`, the live `state`, the attempt count and the unclaimed queue entry. A lost batch deletes the object. A late conversion after a hard delete matches no row and discards its own object. A drain claim between the put and the batch makes the adoption lose.
- **The DLQ branch must come before the unparseable fallback.** An unrecognised body on `quincy-renditions-dlq` inserts a `rendition_dlq_events` row with `asset_id = 'unparseable-dlq-body'`, which the admin DLQ card shows as a broken asset. An `embedded_display` message sets the row `failed` (`rendition_error = 'dlq'`) and writes no event, since that table and its replay are keyed by asset. The uploader sees `failed` with a Retry.
- **Lost sends are repaired by the minute cron.** `recoverEmbeddedRenditions` picks at most ten `pending` rows requested more than ten minutes ago whose lease is free, stamps `rendition_resent_at` with a conditional UPDATE, then sends (so overlapping runs send once). Recovery never touches `rendition_requested_at`: that column is the generation, written only by complete and Retry, and it stays stable across recovery. Ten minutes, not two: the rendition queue runs one message at a time, so a HEIC job can wait behind an asset backlog.
- **Retry and status are the uploader's alone** (`GET .../rendition`, `POST .../rendition/retry`, project and Notice board). Retry compare-and-sets `failed` to `pending` with attempts back to zero, and only the winner enqueues. The status body is the status and nothing else: no key, no error text. Every new route needs its `terminal-route.ts` registry entry or the route manifest test fails.
- **Sol review fixes (#495).** The `ftyp` brand parser reads both box headers (size field 1 puts a 64-bit largesize at byte 8 and the major brand at byte 16), and the video sniffer refuses any `ftyp` whose brand table cannot be parsed, so a HEIC cannot hide behind a header the parser skips. `inspectJpeg` reads to EOI (FF00, RSTn and fill bytes are scan data, any other FFxx is a marker), because EXIF/XMP can follow a scan, and a JPEG with no SOS or no EOI is invalid. The `embedded_display` message carries `generation` (= `rendition_requested_at`, written only by complete and Retry; the recovery cron stamps `rendition_resent_at` instead, so the generation is stable): the consumer's claim, every later write (fail, release, ready) and the DLQ failure are fenced on it, because Retry resets `rendition_attempts` to 0 and a stale run and the new run can hold the same count. A PUT that throws may have committed: delete the object (`discardUnreferencedObject`), never just its queue entry. `fail()` releases the lease if its own D1 write throws, or the redelivery no-ops and acks.
- **Test traps.** The worker test harness splits the migration on `;`, so a semicolon inside a SQL comment breaks it. `generateEmbeddedDisplay` must be handed a wrapped `fetch`, never the bare global (an unbound `fetch` throws "Illegal invocation"). A seeded HEIC row's `bytes` must equal the object's size or the verifier rejects it as a size mismatch.

## HEIC in Embedded media, web half (#495)
Tags: rich-text, whiteboard, focus-overlays · #495

- **A HEIC is not usable when `complete` answers.** `uploadEmbeddedImage` reports `preparing`, polls the uploader-only status route (1, 2, 4 ... capped at 10 s) and resolves only at `ready`, so the composers and the whiteboard insert exactly once and never a reference to a copy that is not there. `failed` rejects with `RenditionFailedError`; the composer keeps that row (and its place in `inFlight`, so Post stays held) until Remove or a Retry that ends ready.
- **Browsers often report an empty type for a HEIC**, so the file is identified by MIME and then by `.heic` / `.heif`, and the resolved type (not `file.type`) goes in the presign body. The picker, paste and drop all use the same check, and HEIC joins `accept` only when `GET /api/embedded-media/settings` says `heic` (fail closed: no provider, no answer, or a bad answer is "off").
- **The whiteboard skips `adoptImage` for a HEIC.** The browser cannot decode the original, and the uploader should see the JPEG every peer will; it resolves the server copy at ready.
- **Remove and unmount abort a prepared Project upload** (`abortEmbeddedImage`, keepalive). The Notice board has no abort route, so there the row is only forgotten and the sweep reclaims it. A DOM test that leaves a preparing row mounted needs a stubbed `fetch`, or the unmount abort trips the no-unmocked-fetch guard.
- **Any new `apiGet` on a mounted composer shows up in tests that count `apiGet` calls** (the Notice board freshness suite did): answer the settings path in such a mock rather than letting it reach the counted function.

## Folding two vitest configs into projects removes each suite's own executed-tests gate (2026-10-05)
Tags: testing-guards, deploy-ci

- `apps/web` had `vitest.config.ts` (unit) and `vitest.dom.config.ts` (DOM), each run by its own CI
  step, so `requireExecutedTests` failed a DOM run that executed nothing. Merged into one config
  with `test.projects` [unit, dom], one run executes both and the whole-run check is satisfied by
  `unit` alone — an empty or all-skipped `dom` project went green. Sol caught it in review.
- `portal/packages/shared/src/testing/require-executed-tests.ts` now also requires every project to
  execute a test in a full run (no file filter, no `--project` narrowing);
  `test/require-executed-tests.test.ts` covers it with a two-project fixture.
- `vitest-timeouts.guard.test.ts` checked only the root config's budgets; it now requires each
  inline project to set `extends: true` or both shared budgets.
- `.gitattributes` gives `docs/lessons.md` `merge=union` for local merges and rebases. GitHub's
  merge button ignores it, so a conflict there still needs resolving by hand.
## #527 The Project discussion is read-only on an archived Project
Tags: permissions · #527

- **Create is gated on ONE row, the audit row, written first.** The audit insert is `SELECT ... WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)`; the comment insert, every mention insert and everything after (outbox, ledger, activity, media) are `WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`. Fencing only the comment insert does not work: the mention inserts would then violate their foreign key on the missing comment and the whole batch would throw instead of skipping. The leading block is still audit + comment + mentions + read marker, so `activityStatementStart` keeps its value (a test pins the broad outbox ids).
- **Edit and delete fence in the statement itself** (`COMMENT_ARCHIVE_FENCE` on the UPDATE / DELETE); their audit rows were already `WHERE changes() = 1`. A check made only before the write is beaten by an archive landing in between (#446), so the routes check up front AND the batch fences.
- **The archived snapshot is now the LAST statement of every comment batch, after the media statements.** `ARCHIVED_SNAPSHOT_SQL`, `archivedInSnapshot` and `projectIsArchived` moved to `lib/project-archive.ts` (shared with the Checklist). Nothing after the activity block is read by position, so the media statements no longer being last is safe. A lost write throws `CommentProjectArchivedError` only when the write did not happen: archived wins over the same-state no-op, so an identical PATCH on an archived Project is 409.
- **Archived is checked before authorship** (a non-author's PATCH or DELETE is 409, not 403; an impersonating Admin gets the same 409), and an External Editor gets 404 (they cannot see an archived Project), including on the race path. The read marker stays writable: it is per-person read state, not the discussion.
- **Web:** `archived` reaches the thread through `ProjectCollaborationPanel`; a 409 `comment_project_archived` from Post, Save or Delete latches the thread read-only until the detail refetch catches the prop up (cleared on Restore). The composer is replaced by `ARCHIVED_NOTICE_CLASS` copy and the "⋯" menu is hidden. The saved draft is kept on purpose (it returns after Restore); an open edit is dropped. Focus moves to the notice only when it was genuinely lost (#450/#452 rule). Only Post, Save and Delete refusals switch the thread: an upload that 409s `project_archived` stays an in-editor error, and the prop catches up on the next detail refetch.
- **The collaboration-only view reads `archived` from the staff collaboration summary.** `GET /projects/:id/collaboration-summary` returns `project.archived` for STAFF only; the External shape is `.strict()` and does not carry it (an External Editor cannot see an archived Project at all), and a test pins both. `CollaborationOnlyView` passes it to `ProjectCollaborationPanel`, so the thread and the Checklist rail (which already took `archived`) render read-only up front instead of waiting for a 409. A 409 refusal now also invalidates the summary query next to `detail`, so a Restore elsewhere is picked up by the next refetch/poll and the latch clears (`archived` true -> false). The web validator for the summary is exact-keys: a new summary field needs the validator and every test mock updated together.
- **A detail 403 AFTER the full workspace mounted must make the same decision as on first load.** Archiving removes a photographer's ordinary visibility (`resolveVisibleProject`) but not their project-membership collaboration access, so the refusal handler's `detail` invalidation (discussion, Checklist) refetched into a 403 and the workspace showed "Project unavailable" while `collaboration-summary` still returned 200. The workspace only probed the summary when `initial` (no detail data yet); `accessFailure` now probes on every detail 403 and un-readies the mounted workspace (`manualReadyFor` / `detailReadyFor`), and `ProjectWorkspaceQueryOwner` holds Loading on a 403 even with cached detail. A failed probe lands where a first load would (404 "Project unavailable"; summary 403 collaboration-unavailable). Do not drop `detail` from the refusal invalidations to dodge this. The draft provider sits in `App.tsx` above the router, so the discussion draft survives the switch.

## Video notes: a reply copies its root in SQL, and delete decides hard-versus-tombstone in one batch (#741 5a)
Tags: permissions, d1-migrations · #741

- **0068 has no cross-row CHECK and migrations carry no triggers, so a reply's visibility, Project, Video and Version are selected FROM THE ROOT ROW inside the INSERT.** `REPLY_INSERT_SQL` (`lib/video-notes-sql.ts`) has no visibility bind at all, and a test pins that. Any later writer of `video_notes` (5c paste, 13 guest notes) reuses the shape.
- **Author-only is in the statement as well as the route** (`author_user_id = ?`), with no role bypass; an impersonating Admin passes only because the session user IS the author. A guest-authored note has a NULL author, so no staff user can ever match.
- **Delete is one batch of DELETE (guarded by `NOT EXISTS` a reply by someone else), its audit, UPDATE-to-tombstone, its audit, markup delete, archived snapshot.** Each audit is `WHERE changes() = 1`, and `changes()` excludes FK-cascaded rows, so exactly one audit row lands. The hard-delete test uses the JS `meta.changes >= 1` (cascades included) while the tombstone uses `=== 1`.
- **Archived is checked before the note lookup and before authorship** (a non-author's PATCH on an archived Project is 409, not 403), and repeated in every batch, so a write that loses the race writes no audit row either.
- **External editors on an assigned Project read and write internal notes (story 42).** The staff and External list are the same strict response; the internal filter belongs to the guest surface only, in SQL.

## Notice board "⋯" menu and Delete confirmation (#523)
Tags: focus-overlays, css-tokens · #523

- **A menu item that opens a dialog must stop the menu's own close hand-off.** The `Menu`'s exit returns focus to its trigger (`finalFocus`), which would steal it back from the dialog. `quincy/menu.tsx` now takes `finalFocus` returning `false` ("do not move focus"); `NoticeItem` returns `false` while a Delete is pending and clears the flag the next time the menu opens (not in a completion callback, #463).
- **The "⋯" is hidden on the notice being edited, so the menu unmounts with the edit and its close hand-off never runs.** Focus into the editor is an effect on `isEditing` (retrying until the editor's contenteditable exists), not the menu's `finalFocus`.
- **The dialog's `finalFocus` must never return `undefined`, and must not read state the confirm has just cleared.** It runs after `deleteTarget` is null, so the target and the post order live in a ref. After a delete focus goes to the next surviving "⋯", then the previous, then the composer; Cancel/Escape return to the notice's own "⋯".
- **A 404 on delete means already gone**: close the dialog, no error. `deleteNoticeBoardPost` refetches in `finally`, so a failure never leaves a stale list. Any other failure keeps the dialog open with the message beside the action.
- **The confirm button says "Delete", not "Delete notice" / "Delete comment".** In the `size="sm"` dialog (max-w-xs) the two-column footer gives each button about 121px, and an uppercase `--tracking-wide` "DELETE COMMENT" needs about 134px, so it filled its own padding. The dialog title already names the target. **When a delete fails, focus goes to the error Notice** (`tabIndex={-1}`, done once in `ConfirmDeleteDialog`): both buttons are disabled while "Deleting…", so focus had dropped to `<body>` and the critical message was never announced as focused. Both callers (Notice board, Project discussion) have a DOM test for it (#568).
- **In a test, Base UI Menu positioning makes `IntersectionObserver`s of its own** (floating-ui `autoUpdate`), so "the last observer" in a fake is no longer the presentation hook's. `NoticeBoard.freshness` picks the last one that is still observing. And `Node.contains(document.activeElement)` was unreliable here; assert with `closest(...)`.

## Embedded media orphan sweep (#549)
Tags: media-renditions, queues-workflows · #549

- **Reference before bytes is the contract that makes age a safe test.** An original's row is reserved at presign; a poster, display copy or preview image gets a cleanup entry before its PUT; keys are never reused (a uuid plus a per-attempt nonce). So an object older than the retention window that no `embedded_media` row and no `embedded_media_cleanup` entry names cannot be in flight. A new writer that puts bytes before recording the reference breaks the sweep's premise; record first.
- **The sweep never deletes, it enqueues.** `embedded-media-orphan-sweep.ts` inserts the key into `embedded_media_cleanup` in one statement guarded by `NOT EXISTS` on the exact key (`original_key`, `display_key` or `poster_key` of the row with the key's media id), and the existing drain deletes with its lease and retry. A row inserted between the listing and the enqueue wins. An existing queue entry, claimed or not, is left alone. Only an inserted row counts as reclaimed, and each one writes an `embedded_media.orphan_reclaimed` audit row.
- **Exact key, not "has a row".** A stale poster or display copy beside a live row is an orphan; matching on the media id alone would have kept it forever.
- **Traversal is bounded and resumable; a bound must never be spent on work that cannot lead to an orphan.** First shape: a stored-cursor-free daily shard walk with one counter for list calls (300) and one for "old recognised objects seen" (500). Sol found both starved: 500 live old keys ahead of an orphan used the whole enqueue budget, and 299 RAW-only Project folders used all 300 list calls, so later Projects and the Notice-board prefix were never visited and every rotation repeated the same keys. Now there are three bounds: list calls, classifications (the D1 lookups), and candidates (reclaim: successful enqueues; observe: would-reclaim). The object that trips a bound is not consumed, and the position (shard, stage, last completed Project folder, folder in progress, last key) is saved as one JSON object in the MEDIA bucket at `_state/embedded-media-orphan-sweep.json`, outside every prefix the sweep lists. The next run resumes there; finishing a shard advances to the next (first run starts at day number mod 16), so a rotation is at least 16 runs and a bounded run only delays coverage. Corrupt or missing progress restarts the shard (idempotent). Observe mode saves progress too. Follow `truncated`/`cursor` even on an empty page. Keys are matched against strict regexes immediately before acting; anything else is `unrecognised` and never touched (whiteboard, RAW and unknown names share these prefixes' neighbours).
- **`startAfter` on a delimiter listing does not skip the folder you pass.** `list({ delimiter: "/", startAfter: "projects/x/" })` still returns `projects/x/` because keys after the marker roll up into that same prefix, so a resumed run rescanned the folder it had just finished and starved again. Resume past a whole folder with `startAfter: folder + "\u{10ffff}"`.
- **Why R2 for the progress and not a table.** The background worker binds no KV, and `jobs` rows are project-scoped workflow state that other sweeps and the retry endpoints act on (`queued`/`running` get recovered), so a progress row there would be picked up by the wrong readers. A new D1 table would be a production migration. One object per sweep in the bucket the sweep already owns needs neither.
- **Out of scope: unfinished multipart uploads.** `list()` does not show them. Tracked ones stay with the row sweep; untracked parts need an R2 lifecycle rule (not set up, so this is not solved).
- **Rollout.** `EMBEDDED_MEDIA_ORPHAN_SWEEP` is `off` (absent), `observe` (counts and logs `wouldReclaim`, writes nothing) or `reclaim`. It ships as `observe` in the background wrangler config; read one full 16-day rotation of `wouldReclaim` logs before flipping to `reclaim` in a follow-up.
- **Test harness trap.** Tests fix `now` at a round number while the local R2 stamps a real `uploaded`, so an "old" or "young" object needs `list()` wrapped to report the age (the test's `bucket()` proxy), and ids built to start with the shard's hex digit.
## A shifted date popup cut through its own label, and its selected day sat under the body fade (#537, #536)
Tags: focus-overlays, css-tokens · #537, #536

- **`shift` with a low field pulls the popup's top to wherever the viewport padding allows, which can be mid-label.** New shoot's Deadline now passes `popupPinTopToField`: `DateTimeField` reads the padding callback, scrolls the field row to the top of the viewport (below the padding's top edge, via a temporary `scrollMarginTop`, `behavior: "instant"` so the trigger is measured on the same open), then raises the padding's top to the trigger's top. The popup covers the trigger, never the label. If the page cannot scroll far enough, the pin leaves less room and the body scrolls (not measured).
- **The body's fade is `min(--fade-size, overflow)` per edge, and the body opens at scroll 0 (#528).** A selected day or pressed slot in the bottom band reads grey, not ink. `PopupFrame` nudges the body by the least amount that clears the band (`scrollTopClearOfFade`, a pure function over rects), reads `--fade-size` by measuring a probe, re-runs on body resize because Base UI sets `--available-height` after mount, and stops the moment the person scrolls. An item wholly below the fold is left alone, so the month navigation stays. **Amended by #587:** that skip is only for optional items. The day the person is editing (and the focused element) is `required`, and is scrolled into view even when it starts wholly outside the body.
- **`16` is `--space-4`, named once.** `DATE_TIME_POPUP_EDGE_GAP` (`lib/date-time-field.ts`) is the default `collisionPadding` and New shoot's four edges.
- **A read-only Deadline panel has no frame.** `DateTimePopoverContent` is `p-0` because the editable form brings `reui/frame` padding; the read-only branch renders bare content, so it carries `POPOVER_READONLY_PANEL` (`project-header-popover.ts`, `p-[var(--space-4)]`).
## Unlayered element resets beat Tailwind utilities (#569, #552)
Tags: css-tokens, testing-guards · #569, #552

- **An element-type selector outside `@layer` silently beats every utility.** `p { margin: 0 }`, `h1..h4`, `a`, `button { font-family }`, `*`, `body`, `img` in `tokens/base.css` and `app.css` were unlayered, so `mt-*` / `mb-*` / `ms-*` on a `<p>` or heading did nothing (the code carried `!mt-[…]`, and #527's note had to move its `mb-*` to a wrapper). They now live in `@layer base` (order `theme, base, components, utilities` is declared at the top of `index.css`), so utilities win and the `!` workarounds are gone. A guard in `design-system-guards.test.ts` fails on an unlayered element-type selector in `styles/`.
- **Sites that were dead and are now live** are the cost: every `mt-`/`mb-`/`my-`/`ms-` on a `<p>` or heading that never carried `!` now applies. Those were swept and listed for a browser pass in the #569 PR; when you remove a reset's win, grep for margin utilities on the tags it covered, not just for `!`.
- **`:focus-visible` stays unlayered on purpose.** Layering it would let every `outline-none` / `outline-hidden` utility in the vendored ReUI components (menu, tabs, switch, checkbox, …) suppress the ring, which Guard 3b/3c pins. It is a separate, audited change, not part of the reset sweep.
- **Setting only `outline-color` at rest (#532) left width and offset to animate.** Under `transition: all` the offset slid 0 → 2px on focus. `outline-width` / `outline-offset` are now also set at rest in `@layer base`, equal to the `:focus-visible` shorthand, so only `outline-style` changes on focus. A guard pins the equality.
## Link preview selection flake: Apply must sync the editor selection (#562)
Tags: rich-text, focus-overlays, testing-guards · #562

- **Apply now ends with `editor.view.focus()`, as Remove does.** `chain().focus()` defers a frame in Tiptap. In happy-dom the document selection stays in the editor while an `<input>` holds focus, and is clamped to a mid-document caret when ProseMirror rewrites the text node. Base UI's no-animation `finalFocus` then focuses the editor with that stale DOM selection, so any ProseMirror DOM-observer flush (its 20 ms mount timer) before the deferred `view.focus()` reads the caret and collapses the author's range. Real browsers were covered only by the popover's 100 ms exit animation.
- **The test hid it by snapshotting `before` AFTER Apply.** "Unchanged from a later snapshot" passes when Apply itself collapsed the range. Assert the absolute selection (`{ from: 12, to: 17 }`) right after Apply.
- **happy-dom repairs the selection on the focus event, so the race itself is not reproducible deterministically.** The regression test pins the sync instead: it clicks Apply synchronously and asserts `view.focus` was called in the same tick (red without the fix), then forces `domObserver.flush()` and asserts the range survives. The flush call is test-only internals.
- **The old issue command is stale:** the web tests run with `npx vitest run --config vitest.config.ts <file>` (happy-dom), not a `vitest.dom.config.ts` / jsdom.

## Pasted HEIC flake: one setTimeout(0) does not cover react-query's notify (#576)
Tags: rich-text, testing-guards · #576

`QuincyRichTextEditor`'s paste handler reads the HEIC setting synchronously from the rendered editor (`heicRef.current`). React Query hands a resolved query to React in its own `setTimeout(0)` (`notifyManager`'s default scheduler), so a test that waits one `setTimeout(0)` after mount races that timer: when the two timers are set within the same millisecond, Node may fire the test's first and the paste is refused as "not a JPEG, PNG or WebP image". It failed about half the time run alone and twice in a row on CI, blocking main deploys. Users can't hit it — the gap is one timer tick. Fix: in tests that act on a query result synchronously, set `notifyManager.setScheduler((cb) => cb())` in `beforeEach` and restore `defaultScheduler` in `afterEach`, so "the query resolved" and "the component rendered it" are one event (same pattern as `PrincipalFreshnessBoundary.dom.test.tsx`). Never add another tick or sleep.

## A conflicted Gantt draft must outlive the controller session that raised it (#585)
Tags: gantt-calendar, scheduling, focus-overlays · #585

- **Escape and an outside press end the session; they must not end the draft.** The Gantt's Due cell and the item menu's bar
  picker (#582) are presentations of the scheduling controller's own schedule editor, so a passive close (`Popover`
  `onOpenChange(false)`, which Escape and an outside press both reach) used to be a controller Cancel. A 409's `validationError`
  and `latestItem` live on that session, so the reopened picker lost its "Latest schedule · vN" notice even though the draft
  (`retainedSchedules`, a ref above the vendor tree) survived. #423's rule is that only Cancel and Use latest discard; the Checklist
  already kept it, the Gantt did not.
- **Keep the session short and the notice long.** The session cannot simply stay alive while closed: the controller is shared with
  the Calendar, and a closed-but-live session holds `commandLockRef` and the accept gate, which freezes the chart. So
  `ProductionGantt` owns a `conflictStash` (Subtask id to `{ validationError, latestItem }`), `dismissScheduleEditor()` stashes
  then calls `cancelScheduleEditor()` in the same handler, and `use-scheduling-commands` is unchanged.
- **Only the popup's Cancel button is a discard.** `SubtaskScheduleControl` gains `onDiscard`, fired from its `onCancel` after
  `discard()`. `useSchedulePickerClose` arms its one-shot swallow for Save, Use latest and `onDiscard` (each clears the stash first)
  and sends an unarmed close to `onDismiss`, not `onCancel`. Escape never reaches `onDiscard`.
- **The notice is named against the live row.** The editor's own error wins (a fresh 409), else the stash; a stashed error is
  rebuilt by `scheduleErrorFromStash(stash, row)` so a refetch that brought v4 while the picker was closed shows v4 and the reapply
  carries `expectedVersion` 4. A stashed `latestItem` older than the row is dropped. The stash is dropped on a new `generationKey`.
- **Test it with a reapply, not just a look.** The reopened picker showing the draft is not enough: assert one more PATCH at the
  latest `expectedVersion`, that the accept gate is released while dismissed, and that a Due to bar reopen shares the same stash.
## The Calendar's Edit schedule… picker: anchor to what can be re-keyed, move focus only if lost (#583)
Tags: gantt-calendar, scheduling, focus-overlays · #583

- **One host, two surfaces.** `components/scheduling-item-schedule-picker.tsx` (`SchedulingItemSchedulePicker`, the #582 bar picker
  renamed) draws the item menu's Edit schedule… for the Timeline AND the Calendar: an inline `inlineTarget: "item"` session over
  `SubtaskScheduleControl`. The Calendar must also pass `scheduleEditorPresentation="inline"` to `ProductionEventCalendarDialogs`,
  or the sheet draws as well as the picker. The sheet branch is now only the dialog host's safety net.
- **#585's stash had to leave `ProductionGantt`.** The draft and a dismissed conflict's notice are `useScheduleConflictStash` in the
  picker file, called once per surface with its own reset key (the Gantt's `generationKey`, the Calendar's `resetKey`). The Gantt
  keeps only its prune-by-confirmed-removal effect, because that depends on its paged, walked data. The Calendar has no such prune:
  an item that leaves the drawn data cancels the session and clears its stash entry, nothing more; the rest clears on `resetKey`.
  A save conflict on the Calendar now keeps the draft and offers "Use latest" (the owner accepted this; it was a sheet that
  re-seeded before).
- **The anchor is a ladder, never the chip alone.** A Calendar chip is re-keyed on a Start move, and a chip folded under "+N more"
  has no element at all. Anchor: the live chip, then the element the menu handed focus to (captured as `document.activeElement` in
  `runItemAction`), then the originating day's "+N more", then the picker's last rect. A multi-day item sits in several overflow
  lists, so the id alone picks the wrong button: `renderMoreIndicator` carries `data-more-day` and `findMoreFor(key, day)` reads it.
  Chip loss and width changes never cancel the session; only the item leaving the data does.
- **A controller restore must not steal focus from an outside press.** A popover picker closes on an outside press that may have
  landed on another control, and `finishChecklistInteraction`'s `focusDescriptor(... "event")` then focused the chip a tick later.
  `CalendarFocusDescriptor.ifLost` makes an inline session's restore move focus only when it is lost (`<body>`, disconnected or
  `:disabled`); a non-inline (modal) session still always restores. On the Gantt it is a no-op (bars carry no `data-event-id`).
  Pin it with a real button pressed outside and a wait past the controller's and the menu's restore timers.
- **An untouched Apply is not a save.** The sheet's Save always PATCHed; the picker's Apply on an unchanged range sends nothing. A
  test that clicked Save to "write the same value" must change the range first.

## One confirm look: the AlertDialog renderer for `lib/confirm`, and what its portal does to popovers (#625)
Tags: focus-overlays, reui-vendor, testing-guards · #625

`lib/confirm`'s promise API, queue, abort signal and every caller stayed; only `ConfirmDialog`'s renderer moved from `Modal` onto
`reui/alert-dialog` (the look `ConfirmDeleteDialog` and EditProject's Restore already used).

- **An alert dialog sets no `aria-modal` and ignores scrim presses.** Base UI's `AlertDialog` popup is `role="alertdialog"` with no
  `aria-modal`, and a press on the scrim does nothing. Both are the standard behaviour, adopted deliberately: Escape and Cancel
  answer `false`, the scrim leaves the confirm pending. Anything that detected the old `[role="dialog"][aria-modal="true"]` shape
  needs its own arm — `project-sheet-layers.ts` now matches `[role="alertdialog"][data-open]`, else Escape on a confirm inside the
  Project sheet closes the sheet too.
- **The AlertDialog portal is inert-marked, so a Base UI popover dismisses on any press inside it.** A popover's outside-press check
  skips an element "injected after it opened" only when that element's body-level ancestor holds no `data-base-ui-inert` marker. The
  old `Modal` portal held none; the AlertDialog portal holds its overlay and focus guards, which Base marks inert. So Cancel, Confirm
  or the scrim of a confirm raised from the Deadline popover (Clear) or the Team popover (final-role removal) closed the popover and
  discarded its draft (`ProjectHeaderDeadline` and `ProductionGantt-inline-edit` T2 failed red). Escape and the focus move into the
  dialog dismissed it the same way. `reui/popover.tsx` now cancels those `outside-press` / `escape-key` / `focus-out` dismissals
  while an alert dialog is the target or is open (`lib/alert-dialog-press.ts`), declared as a Quincy adaptation and pinned by
  `popover-adaptation.guard.test.ts` so a plain `shadcn add popover` cannot revert it. `AnchoredPopover` uses the same helper
  instead of a confirm-specific `data-confirm-modal-root` marker, so any alert dialog raised from a popover behaves the same. The exemption must NOT apply to a popover opened from inside an alert
  dialog (the Calendar Move Deadline dialog's date/time popup: Escape closes the popup, not the dialog), so `AlertDialogContent`
  provides `InsideAlertDialogContext` and `Popover` skips the adaptation when it is inside one.
- **The Team list is a Base UI Combobox, not a Popover (browser pass 3c).** It closed when the confirm opened and stayed closed after
  Cancel. The dismissal-cancel logic is one helper, `keepOpenBehindAlertDialog(open, details, insideAlertDialog)` in
  `lib/alert-dialog-press.ts`, used by `reui/popover.tsx` and the `reui/combobox.tsx` Root (both declared adaptations, both pinned by
  `popover-adaptation.guard.test.ts`). In happy-dom `main` also closes the list the moment the confirm takes focus, so this is the
  plan's "a confirm must not close the popup that raised it" applied to a third popup kind rather than a regression from the
  AlertDialog. Menus and Selects are not adapted: every confirm caller reaches `confirm()` after the item select has closed them
  (stage move from the header Select and the board card menu, scheduling commands from the item menu).
- **Test seam.** `.dom.test.tsx` may not assert incidental class names, but may assert a Tailwind utility that encodes a design
  contract: `ConfirmDialog.dom.test.tsx` pins `danger` -> destructive (`text-destructive`) and the default variant (no `text-destructive`).
  The alert dialog's focus guards (`data-base-ui-focus-guard`) sit in the same portal as the overlay, so the popover exemption
  matches the portal, not just the panel and scrim; `AnchoredPopover`'s Floating UI `focus-out` close is skipped while an alert
  dialog is mounted for the same reason.

## A plain width on a SheetContent loses to the sheet's data-side width
Tags: css-tokens, reui-vendor, focus-overlays · #648

The Calendar's rail sheet set `w-[320px] max-w-[90vw]` on `SheetContent`, but `reui/sheet.tsx` carries
`data-[side=left]:w-3/4`. tailwind-merge only merges classes that share the same variant chain, so a plain
`w-[320px]` and a `data-[side=left]:w-3/4` are both kept, and the data-variant rule wins on specificity. The sheet was
240px at a 320px viewport (clipping the mini month's "Su" column, which needs 256px) and 384px on tablets; the 320px
never applied. Fix: set the consumer width through the same variant (`data-[side=left]:w-[320px]
data-[side=left]:max-w-[90vw]`, as `quincy/RailSheet.tsx` does). `styles/sheet-width.guard.test.ts` fails on a plain `w-` / `max-w-` utility in any
`<SheetContent className>` outside `components/reui/`. The general rule: a consumer override of a utility the vendor
sets under a data or state variant must use that same variant, or it silently loses.

## A programmatically focused container rings
Tags: focus-overlays, css-tokens · #598

Base UI focuses a popup or sheet container (`tabIndex -1`, never a Tab stop) on open. After a keyboard open, or before
any pointer input on the page, Chrome treats that as `:focus-visible`, and the unlayered global ring in
`styles/tokens/base.css` outlines the whole container. Three sightings, one mechanism: the Deadline popover frame while
`ProjectDetailGate` showed its skeleton (`DateTimeField`'s `initialFocus` returns `true` when no day button exists yet),
the Project sheet on a fresh load, and the Gantt Due/bar picker. Fix: `focus-visible:!outline-none` on the container
only (the `!` is needed against the unlayered rule), as `NotificationBell`'s panel already did. Rings on controls inside
are untouched, and focus still lands on the named dialog, so screen readers are unaffected.
`components/quincy/container-focus.guard.test.ts` pins the container list, now including `RailSheet` and `Modal.tsx`'s
`panelClasses` (#659; `Modal` had a dead `focus:outline-none` that loses to the unlayered rule). Not covered yet: the
Calendar rail sheet, deliberately (`initialFocus` resolves to the first tabbable, so the container is unreachable; its
focus-motion guard bans `!outline-none`). Rejected: `focus({ focusVisible: false })` (cannot apply when `initialFocus` returns `true`) and
a `data-focus-pending` marker (state for a ring that is never useful).

A fourth sighting (#662): the Subtask Actions popover (`AnchoredPopover`, `SubtaskChecklist` `initialFocus={0}`). Its
`FloatingFocusManager` ordered focus `["reference", "floating", "content"]`, so index 0 was the trigger and the panel
itself became a Tab stop with a square ring. Fix: set `order={["content"]}` explicitly; a keyboard open
now focuses Delete, and Escape returns to the trigger. Check `initialFocus` against the order list, not just against the
container class.

## A masked scroll viewport's outline never paints
Tags: focus-overlays, css-tokens · #660

The time list's 96 slot buttons were each a Tab stop, and the ring on a focused slot was drawn outward. Their scroll viewport carries a `mask`, and a mask clips everything painted outside the element's box, so an outline never showed (a box-shadow would clip the same way). Fix: an inward ring, `RING_IN` from `AnchoredPopover`. Its old bare `focus-visible:!outline` was dropped by twMerge inside `cn()`, and a width plus colour with no style draws nothing, so callers had to patch `!outline-solid` on themselves (`TimeColumn`, `ShortcutList`); `RING_IN` now carries `focus-visible:!outline-solid` itself, which survives `cn()`, and `AnchoredPopover.ring.test.ts` proves it for each caller pattern. The list is also one roving Tab stop (as `PriorityStars`; a click re-seats the stop on the clicked slot, via `onFocus`), and the column's own viewport is `tabIndex -1` through `reui/scroll-area`'s `viewportProps`, so Base UI's overflow stop does not double it. `TimeColumn.focus.guard.test.ts` pins the classes; ring painting itself is only visible in a browser.

## A pressed time slot under either fade reads as a grey bar, and focus before reveal jumps the body (#662)
Tags: focus-overlays, scheduling · #662

Three defects in the 390px time list (`TimeColumn` in a stacked `PopupFrame`), one family with the #636 bottom-fade sliver
(`docs/maps/date-time-controls.md` § "Popup placement and the selected day"):

- **Sliver under the top fade.** `slivered` in `scrollTopClearOfFade` (`lib/date-time-field.ts`) tested only the bottom
  band, and `TimeColumn.reveal` never passed the pressed slot as `noSliver`, so a solid pressed chip half under the top
  mask read as a grey bar. The solver now checks both bands (top `min(fade, s)`, bottom `min(fade, max - s)`); with no
  `snaps` it picks the clear whole scroll nearest the current one (smaller on a tie), and falls back to the #630 choice so
  required and `priority` items stay authoritative. The phone fade is `--space-5` (24px), not `--space-6`: 24 + 44 + 4 + 44
  + 24 = 140 <= the 144px column, so even the adjacent-row case clears.
- **Body jumped ~66px over two arrow presses.** `TimeColumn` focused the slot, then scrolled the column, and
  `PopupFrame`'s `focusin` handler solves against where the slot is when focus lands, so it measured the old position and
  scrolled the body twice (48px, then 18px). Rule: **reveal (write the column's `scrollTop`) first, then
  `focus({ preventScroll: true })`**, so a focus handler sees the final geometry. An already-clear slot leaves the body
  still.
- **A pick re-centred the column.** The `useLayoutEffect` on `selected` centred after every pick. A one-shot `pickedRef`
  now skips the centre for that exact selection after a pointer or Enter pick (cleared if the slot was already pressed, since
  no selection change follows). Opening, a complete typed time and a crossing of 721px still centre.

Guards: `TimeColumn.scroll.dom.test.tsx` (nested-viewport geometry), `lib/date-time-field.test.ts`. Layout-dependent, so
only a browser at 390px proves it (jsdom has no geometry): see the map's measured check.

- **#674: snaps must be fade-aware, and a 32px phone fade made the rules unsatisfiable.** `PopupFrame.presetSnaps` returns
  raw preset-row tops, so landing on row r put that row flush under the top band and its chip read cut (Table-view Deadline
  at 390: scroll 74, the Next week row under a 32px fade). With a 32px fade the row-clear rule (scroll <= 42) and the
  pressed-slot rule (scroll >= 47) had no common scroll; at 24px, scroll 50 satisfies both. `scrollTopClearOfFade` now
  resolves each snap r > 0 to `floor(max(r - fade, r / 2))` (snap 0 stays 0), the phone popup body fade is `--space-5` at
  every width (the owner's decision, superseding #597's 32px), and the active shortcut chip (`aria-pressed`) joins `noSliver`
  next to the pressed slot. Row 1 may still straddle the top edge (scrolled off, not fade-slivered); only the active chip is
  protected.
- **#677: the TIME field starts below the fold at 390, and the 110 landing sliced it.** The Table Today/Tomorrow landing (110)
  left 4.31px of the TIME input in the bottom fade; the Checklist range picker left 6.3px of the START TIME label cut by the
  body's edge. The fix is a constraint on that landing, not a new snap: `PopupFrame` (open only) passes the `data-time-boundary`
  Field's input and label as `boundaries`, and the preset chips as `chips`. A landing that already clears them stays (no-shortcut
  50, Next week 50). Otherwise the smallest whole scroll at which the input is wholly below the body wins (Table Today/Tomorrow
  and Checklist 102), provided no `noSliver` item is slivered and no preset chip crosses the top fade's inner edge. **A label
  wholly inside the bottom band is allowed** (the "more below" cue, the mirror of #674's accepted top tail); only a label or
  input cut by the body's bottom edge is rejected. Trap: putting the Field in `noSliver` without the bottom candidates scrolls
  the presets away (~170-198). Nothing valid keeps the previous landing. The whole Field (label + input) as the boundary has no
  valid Table landing, since it needs scroll <= 83 while the row-2 chips need >= 102. Guards: `lib/date-time-field.test.ts`
  ("#677"), `PopupFrame-presets.dom.test.tsx`.

## Focus scrolls a mid-form field flush and clips its ring; an inactive window hides the ring in screenshots (#673)
Tags: focus-overlays, css-tokens · #673

- **Shoot date ring clipped at the sheet body's bottom.** When focus lands on a mid-form field, the browser scrolls it
  flush with the bottom of the scroller, and the ring's 4px outset falls outside the scroll box. Bottom padding cannot fix
  a field in the middle of the form. Rule: give the **scroller** `scroll-padding` (`scroll-py-[var(--space-2)]` on
  `project-sheet-body`), so every focusable control in it gets clearance; keep `preventScroll: true` in `reui/popover.tsx`.
- **Ring radius must match the visible shape.** A trigger that wraps a pill rings as a rounded rect unless the trigger
  itself takes the pill radius; do it per value-bearing trigger, not on the shared `META_TRIGGER`. The `⋯` comment action
  rings past the column edge by the ring outset (2px offset + 2px), so it takes `me-[var(--space-1)]`.
- **A ring missing from a screenshot is not a defect until `document.hasFocus()` is true.** Chrome drops
  `:focus-visible` when the window is inactive; the #669 harness captured P4-390 without checking, and a re-run that kept
  focus showed the ring held. Record `hasFocus` on every focus row (Subagent-Orchestration §2a).

Guards: `ProjectSheet.dom.test.tsx`, `SubtaskScheduleControl.dom.test.tsx`, `ProjectDiscussionThread.dom.test.tsx`. The
geometry itself only a browser proves.
## A FloatingPortal renders inline siblings while open, so structural selectors near its trigger change (#670)
Tags: focus-overlays, css-tokens · #670

The checklist meta row pushes its last child right with `[&>:last-child]:ms-auto`. `ActionsControl` returned the trigger and
its `AnchoredPopover` as bare siblings. While the popover is open, a non-modal `FloatingPortal` renders focus guards and an
`aria-owns` span in place, after the trigger (`@floating-ui/react`), so the last child became an out-of-flow guard and the
trigger lost `ms-auto` and jumped left on open. Rule: **a trigger and its floating popover share one wrapper element**
(here `<span className="inline-flex shrink-0">`), so the guards render inside a stable last child. Any `:last-child`, `+` or
`:nth-child` selector near a trigger that owns a FloatingPortal changes when it opens. A wrapper, not an explicit `ms-auto`
on the trigger, keeps the read-only row (no Actions) right-aligning its assignee picker. Guard:
`SubtaskChecklist.dom.test.tsx` ("keeps the Actions trigger inside the meta row's last child while its popover is open").

## My tasks on the Timeline lists every Subtask of a Project I edit (#680)
Tags: search-filters, gantt-calendar · #680

On the Timeline, `mine` in the Subtask (child) context is `timelineSubtaskContext` (`lib/dashboard-filter-sql.ts`): Editor of
the Subtask's Project OR assignee of the Subtask. Before, `childFilterSql` used `assigneeContext`, so a Project I edit listed
only my own Subtasks. One seam (`childFilterSql` in `routes/production-gantt.ts`) feeds `child_matches`, the density count,
embedded children and standalone `childrenOf` pages and totals. `!mine` is the strict complement, so a Project I edit drops
out. A Project I do not edit but hold a Subtask in is unchanged: a context row with only my Subtasks. **Deliberate, do not
"fix" for consistency:** People = me on the Timeline stays per-assignee, so #429's "My tasks = People = me" no longer holds
there. The Calendar, Board and Table keep `assigneeContext` / their own contexts (do not edit `assigneeContext` in place; the
Calendar uses it). An External Editor can only see Projects they edit, so for them My tasks shows the same rows as no filter.
`mine` only narrows rows already inside the authorized scope; nothing new is exposed. Guards:
`production-gantt-people.test.ts`, `production-gantt-tree.test.ts`, `production-gantt-mine-subtasks.test.ts`,
`dashboard-filter-sql.test.ts`.

## A range shortcut that sets both ends silently rewrites the one you were not editing (#683)
Tags: scheduling, focus-overlays · #683

- **Today on the Start tab replaced the End too.** The range popup's shortcuts set a whole range, so pressing Today while
  editing Start discarded an end the user had already chosen (and its typed time and Earlier / Later). Rule: a shortcut
  sets the **active end only**; the untouched end is `"keep"`, never re-derived. Project default is the one deliberate
  exception.
- **Collisions are decided once, in a pure function.** `applyRangeShortcut` moves the end by the old duration when a new
  start lands on or after it (measured in civil minutes, not instants, so a DST change does not shift 17:00), and on END
  takes the shortcut's own start when the new end is not after the start, because keeping the duration would reach the
  past. Do not re-implement either rule in the popup.
- **Pressed is per active end, and it can be several.** Today and This week are the same START moment, so both read
  pressed; `ShortcutList` accepts a list. Project default needs both ends to match.

Guards: `lib/date-time-range.test.ts`, `DateTimeField-range.dom.test.tsx`, `DateTimeField-range-reminders.dom.test.tsx`.

## A nested scroller taller than its host's window traps the wheel (#686)
Tags: focus-overlays, css-tokens · #686

At a landscape phone's height the date popups' body was a ~68px window (header, Start/End toggle and footer took the rest), and the
time-slot list inside it was its own scroller: it caught every wheel and swipe, so the calendar and TIME below it could not be reached.

- **Rule: below `POPUP_SHORT_QUERY` (`(height < 520px)`, `lib/date-time-field.ts`) the slot list is not rendered.** Not CSS-hidden: `PopupFrame`
  reads `PRESSED_SLOT` / `SELECTED` rects by selector. The typed TIME stays and takes any minute; day picks keep their 09:00 / 17:00 defaults.
- **The title scrolls with the body** (`PopupFrame` `scrollTitle`); the Start/End toggle and Cancel / Apply stay pinned. A stacked short body shows the
  calendar before the shortcuts (`ordered`, keyed so a live resize does not remount either).
- Height only, not width: the wide layout has the same trap. Do not nest a scroller inside a body window that can shrink below it.

Guards: `popup-breakpoint.contract.test.ts`, `DateTimePopup-short.dom.test.tsx`.

## Escape on a closed picker trigger was swallowed by the draft's own key boundary (#688)
Tags: gantt-calendar, focus-overlays · #688

- Not a regression and not the title input: Escape in the title already closed the row. The failing runs pressed Escape on the **closed Due trigger**, which `gestureBoundary` (`ProductionGanttCreateDraft.tsx`) stopped on desktop (it only let a closed trigger through in the phone sheet), and the row had no Escape handler of its own.
- Fix: `GanttGroupCreateRow` handles Escape in a bubble-phase `onKeyDown` on the row, and `gestureBoundary` lets a closed trigger's Escape through everywhere. React bubbles a portaled popup's events through the row, so the guard is `rowRef.current.contains(event.target)` plus not `aria-expanded="true"`, never the React tree alone.
- When a bug report says "Escape does nothing", find which element had focus first.

Guards: `gantt-create-task.dom.test.tsx` ("Escape on the desktop row"), `ProductionGantt-create-draft.dom.test.tsx`.

## A touch phone matches `pointer-coarse:` too, and that variant wins the cascade (#692, #693)
Tags: css-tokens, gantt-calendar · #692, #693, #695

- **The breakpoint spelling.** The phone breakpoint is `max-[721px]:` / `min-[721px]:`.
  - `max-[720px]:` compiles to `width < 720`, so at exactly 720 neither the phone nor the desktop variant applied.
  - `min-[722px]:` left 721 in neither variant (the rich-text rail padding, the `alert-dialog` footer).
  - `config/phone-breakpoint.guard.test.ts` now fails on `(max|min)-[719|720|722px]`.
- **The cascade trap.** A phone with a touchscreen matches **both** `pointer-coarse:` and `max-[721px]:`.
  - In the built CSS the `pointer-coarse:` rules come after the `max-[…]` ones, so where both set the same property, the coarse-pointer value wins.
  - The sticky `+` kept its 40px-row geometry (`-my-1`, a 6px-short backing) on 44px phone rows, and showed bands inside the button.
  - A narrow desktop window does not match `pointer-coarse`, so it looked fixed there.
  - Fix: scope the coarse value to the widths it is for (`min-[721px]:pointer-coarse:-my-1`) rather than adding a competing `max-[721px]:` override or `!`.
  - Confirm the result in the built CSS: grep `dist/assets/index-*.css` for the rule order.
- **Key the JS row metric on the same media feature as the CSS variant (#695).** The row height came from `narrowTree` (`max-width: 720px`) while the `+` target followed `pointer-coarse:`, so a touch tablet above 720px had 44px targets in 40px rows.
  - Neighbouring `+` targets overlapped, so a `-my-1` workaround was needed. It was a patch for the mismatch, not a layout.
  - Fix: `useMediaQuery("(pointer: coarse)")` (what `pointer-coarse:` compiles to) selects the 44px metric too, and the workaround tokens go.
  - Use `pointer`, not `any-pointer`, so a touch laptop with a fine primary pointer stays 40px in both JS and CSS.
  - Tailwind scans comments too: a source comment that spells a removed class keeps its rule in the built CSS. Describe it in words.
- **Measuring truncation.** `scrollWidth`/`clientWidth` round to whole pixels, so a label 0.2px too wide (50.2 in 50) read as 50/50 "fits" while the screen showed an ellipsis.
  - Measure a fit with fractional `getBoundingClientRect()` widths, and look at the crop.
  - Measure candidate wording in the real font, with canvas or an offscreen span, before choosing it.

Guards: `config/phone-breakpoint.guard.test.ts`, `reui/gantt/gantt-create-task.dom.test.tsx` (the `+` token pins), `ProductionGantt-attention-badge.dom.test.tsx`.

## In-process MCP dispatch skips the Origin check by object identity, never by header (#701)
Tags: auth, workers-runtime · #701, #710

- **Why a bearer path skips `requireAppOrigin`.** An MCP tool calls the real Hono route in-process with a synthetic `Request` that carries no Origin, cookie or Authorization header, so the cookie-session Origin check would reject it.
- **The skip must not be spoofable.** The verified principal is bound to that one `Request` object in `AsyncLocalStorage` (`lib/mcp-dispatch-context.ts`), and `requireAppOrigin` and `requireSession` read it with `mcpDispatchFor(c.req.raw)`, which answers only when the store's request **is** the request being handled (`===`).
  - A header such as `X-MCP-Principal`, or a flag on `c.env`, would be forgeable by any browser request, so neither is used.
  - A nested or stray call gets `null` and falls back to the Origin check; a browser request can never reach the bound path.
- **Rules that follow.** Do not spread or clone `env` when dispatching (#360), do not add a route to the MCP allowlist (`mcp/route-allowlist.ts`) without its own review, and keep the skip to exactly the dispatched request.

Guards: `workers/app/src/mcp/route-allowlist.ts` (the dispatch throws `McpRouteNotAllowedError` for any other route).
## A server cannot borrow Excalidraw's elbow router, so it refuses what it cannot route (#708)
Tags: whiteboard, workers-runtime · #708

- **The router is not reachable from a Worker.** `@excalidraw/excalidraw` 0.18.1 ships one entry point; importing it in workerd throws `window is not defined` at module load (`constants.ts`).
  - `updateElbowArrowPoints` is not exported. The exported `mutateElement` reaches it only through `Scene.getScene(element)`, and with no Scene it routes against an empty element map, so bound shapes are invisible to it.
  - Bundling it anyway took the `workers/app` dry-run bundle from 2.38 MB to 10.83 MB (0.61 to 3.16 MB gzip).
- **A hand-written copy of an editor's normalisation never converges.** Four review rounds each found a case where the server's elbow re-route disagreed with the editor. The last: an end moved onto a pinned run's line makes two segments collinear, and the editor merges them and drops the pin (`fixedSegments: null`).
- **Fix:** a move that would re-route an elbow arrow with a non-empty `fixedSegments` is refused (`pinned_elbow_arrow`, 422, nothing applied). Un-pinned elbow and curved arrows still re-route. A person moves the pinned case in the board editor.

Guards: `apps/web/src/lib/whiteboard-server-edits.test.ts` ("refuses to move a shape whose bound elbow arrow has a pinned segment"), `workers/app/test/mcp-whiteboard.test.ts` ("elbow arrows").

## Touch targets: grow a 44px box toward empty space, and inset the focus ring of a first-row control (#697, #698)
Tags: gantt-calendar, focus-overlays · #697, #698

- **#697.** The create row's Cancel x got a 44px minimum box on coarse pointers, centred in a 20px gutter with 4px before the title input. It spilled 12px, 8px of it into the input, which paints later and won the tap.
  - Fix the box, not the neighbour: a start margin and equal start padding (`-ms-6` / `ps-6`) grow it toward the empty indent while the glyph and the input stay put. Moving the input would break its alignment with child-row titles.
  - The inline create row only renders at 1024px and wider since #734, so the fix matters on coarse pointers at >=1024px (tablets, touch laptops); the `max-[721px]` twin is kept for parity only.
  - Check with real coarse-pointer emulation: `elementFromPoint` on a grid over the box must return the button.
- **#698.** On 44px touch rows the `+` fills its row, so the outset focus ring (2px, offset 2px) reaches 4px above it. At scrollTop 0 the sticky tree header (z-30) paints over that.
  - Scroll padding cannot help at scrollTop 0, and a spacer breaks the flush landing. Draw the ring inside the box on coarse pointers and phones (`-outline-offset-2` plus the important focus-visible twin and the at-rest twin that `insetOffsetProblems` requires). Fine-pointer desktop keeps the outset ring.
  - Check with the page focused (`document.hasFocus()`), Tab to the first row, and read the computed outline offset.

Guards: `reui/gantt/gantt-create-task.dom.test.tsx` (the x and `+` token pins), `design-system-guards.test.ts`, `config/phone-breakpoint.guard.test.ts`.

## Don't mirror server reservation state on the client (#751)
Tags: media-renditions, workers-runtime · #741, #751

- **What went wrong.** The film uploader (#741 4d-i) kept its own copy of two things the server already decides: how many reservations a person holds (a client cap of three) and whether a cancel's cleanup had been confirmed (a `cleaning` phase, abort retries with backoff, "settle only after confirmed cleanup"). Three Sol review rounds each found another race between the copy and the server (a late 401, a 503 `abort_pending`, a cancel that lost to a complete, a second tab).
- **Rule.** The cap and the cleanup state belong to the server's DTO and status codes. The client sends the request, reads the answer, re-reads the list, and shows the server's own message.
  - Reserve: a refused reserve (429 `too_many_uploads`, 409 `upload_in_progress`, ...) keeps the person's file and title and shows the server's words. No client counter.
  - Cancel: send the abort, await its response whatever it is (204, 409 `upload_completed`, 503 `abort_pending`, a network failure), invalidate `videos` and `detail`, drop the local row. A 503 or no answer is a toast; the server sweep reclaims the reservation.
  - A reservation the tab has no job for (a reload, another device) is visible in the DTO (`uploading.reservationId`), and its owner can abort it from the card.
- **A notice about a person names the person.** The terminal-principal broadcast carries the principal id of the query client that saw the 401 (`bindQueryClientPrincipal`), and the store clears only that person's uploads, so a retired person's late 401 clears nothing the current person owns.

Guards: `apps/web/src/lib/video-upload-store.test.ts` ("Cancel leaves the reservation to the server"), `video-upload-terminal.test.ts` ("the terminal notice names its principal"), `components/video/VideoCollectionPanel.dom.test.tsx` ("The server owns the reservation").
## A media element taken out of the page keeps playing, and a fake clock needs the element's real events (#741 4d-ii)
Tags: media-renditions, testing-guards · #741

- **A removed `<video>` does not stop.** Switching Version re-keys the player, which unmounts the old element. The browser keeps decoding and playing a detached media element (sound and all) until it is collected. `VideoFrameClock.dispose` therefore pauses the element, and `VideoReviewViewer.dom.test.tsx` ("switching Version pauses the old one") asserts the old element reports `paused`.
- **Reverse play does not exist.** Chrome and Firefox ignore a negative `playbackRate`. J is emulated by seeking backward one seek at a time, after each `seeked`, muted, stopping at frame 0; it never queues seeks, so it degrades on long GOPs instead of storming the decoder.
- **Seek to the middle of the frame.** `currentTime = frameSeekSeconds(f)` lands on frame f; the start of the frame can land on f-1 after rounding. The frame on screen is read back from `requestVideoFrameCallback`'s `mediaTime`, with a 250 ms fallback to the playhead when the browser presents nothing (a seek to the frame already shown).
- **Testing without a decoder.** happy-dom has no media pipeline. `testing/video-element.ts` replaces `currentTime`, `paused`, `seeking`, `play`/`pause`, `requestVideoFrameCallback` on the prototype and finishes seeks only when the test says so, which is what makes coalescing and the reverse loop assertable.

Guards: `lib/video-frame-clock.dom.test.tsx`, `components/quincy/VideoPlayer.dom.test.tsx`, `components/video/VideoReviewViewer.dom.test.tsx`.

## Escape needs an order, decided before anything runs; per-Version state must not outlive its Version (#741 5b)
Tags: focus-overlays, testing-guards · #741

- **Escape has four owners, innermost first.** In the review viewer: an open menu, popover, list or confirm; then an active note composer, reply or edit form; then the viewer. Base UI reports one Escape to `onOpenChange` more than once per keydown, so the answer is a snapshot taken at window capture (`escapeSnapshot` in `VideoReviewViewer.tsx`, the `ProjectSheet` pattern), never state the first call changed. The form work (close a clean reply or edit, move focus to the dialog for anything dirty or for the composer) happens in that same capture handler, and `onOpenChange` only calls `cancel()`. `hasOpenInnerLayer` could not be reused: from inside a portalled dialog it sees the Project sheet beneath as an open modal and would never let the viewer close, so its floating-popup half is exported as `hasOpenFloatingPopup`.
- **State keyed to a Version dies with the Version.** The notes hook kept marks in `{ assetId, marks }` and ignored them when `assetId` differed, but never cleared them, so switching v2 -> v1 -> v2 brought the old marks back. Reset in render (`if (local.assetId !== assetId) setLocal(fresh(assetId))`), not by reading around the stale value.
- **A strict DTO schema rejects `key: undefined`.** `videoNoteThreadDtoSchema` is `.strict()`; a test fixture carrying `copiedFromNote: undefined` made every 409 conflict classify as `other`. Build fixtures with the real keys only.
- **A heavier import graph can break a cold-chunk timing test.** Two existing viewer tests wait a fixed number of ticks for the lazy viewer chunk; statically importing the notes UI into it pushed them past it. The notes UI is its own lazy chunk (`VideoNotesHost.tsx`), loaded only when the notes part is on, so the notes-off viewer is unchanged.

Guards: `components/video/VideoNotes.dom.test.tsx` ("Escape order"), `VideoNoteThread.dom.test.tsx`, `VideoReviewViewer.dom.test.tsx`.

## Form lifetime is not component lifetime (#741 5b)
Tags: focus-overlays, media-renditions · #741

- **What broke, three review rounds running.** Note forms lived in React state and refs that remounted with the Version, the panel and the filters. So Post on v2, switch to v1 and back lost the pending state or double-posted; a success cleared the wrong form or a newer draft (compared by text); a frame confirmation outlived its form; a filter that hid the edited note discarded the edit; pausing for I/O raced the seek. Each fix patched one lifetime and exposed the next.
- **Rule.** One store that outlives the components (created by the collection, one per person + Project, retired on a change of either). A completion addresses the slot (Version) and operation it started in, never "the form on screen", and acts only if that operation still owns the slot. Compare a draft revision captured at submit, not its text. Closing or hiding a view never discards a form; the filter pins the thread instead.
- Related: "Don't mirror server reservation state on the client (#751)" is the same rule for uploads: state that outlives the view belongs to one owner, not the component.

Guards: `lib/video-note-form-store.test.ts`, `components/video/VideoNotes.dom.test.tsx` ("form lifetime").
