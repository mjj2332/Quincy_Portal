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
`npx vitest run --config packages/shared/vitest.config.ts` separately, as `AGENTS.md` says.

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
present or not. (Note `portal/package.json` pins React **19.2.8**; `AGENTS.md`'s "18.3.1 baseline"
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

## The hovered card is not the successor when you drag downwards (#99, 2026-09-11)

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

A template-literal separator was typed as a raw NUL character. The code compiled and every test
passed. But `grep` now treated `board.tsx` as a binary file, so `grep -n` and `grep -c` against it
printed nothing, not even `0`. That reads exactly like "no match". A verification step
("is the old name gone?") briefly reported success against a file it had never actually searched.
`file` gave it away: `data` instead of `UTF-8 text`.

**Rule.** When `grep` prints nothing for a string you have just written, distrust the grep before
the file. Check `file <path>` or use `grep -a`. Separators in keys should be visible characters
(`|`), never control characters.

## A workspace with no `test` script is silently absent from "the full suite" (#83, 2026-09-12)

`portal/package.json`'s `test` is `npm run test --workspaces --if-present`. `packages/shared` had a
`typecheck` script and no `test` script, so its 20 files and 145 tests — including the entire staff
route grammar, the closed `view` allow-list that #83 changes — never ran in the root suite. They ran
only when invoked directly in that directory. Nothing failed; the suite simply reported a smaller,
greener world. `--if-present` is what makes the omission silent.

**Rule.** After adding tests to a workspace, confirm the ROOT suite count moves. If a package has
tests, it needs a `test` script, or `--if-present` quietly excludes it forever.

## The vendored board hard-codes the measuring strategy a shipped white-screen banned (#83, 2026-09-12)

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
outline shorthand and the focus ring already documented above (`docs/lessons.md:1181-1219`) are —
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

## Tonomo's created webhook carries a display date, and null-fill never upgrades it (2026-09-14)

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

Base UI's `sideOffset`/`alignOffset` callbacks receive `{ side, align, anchor: { width, height },
positioner: { width, height } }` and nothing about where the anchor is. To align a panel's top with
a trigger inside a taller anchor (the bell inside the rail), the callback has to read both elements'
`getBoundingClientRect()` itself. Happy-dom lays nothing out, so the DOM test can prove the callback
runs and reads the trigger's rect, and the arithmetic is a pure exported function with its own
tests; the pixel result is a browser check.

## The bell's narrow-header grid keys off `placement`, not a breakpoint; a decorative thumbnail must silence its own placeholder's `role="status"` (#114, 2026-09-15)

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

## Cookie-session scripts must send an `Origin` header or every mutation is a 403 (2026-09-15)

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
skipped. DOM tests need `--config vitest.dom.config.ts` (the `test` script runs both).

**Rule:** when you add a latch, add the place a human sees it in the same change — and when you
read one, ask what it actually stops, and whether it can outlive the reason it was set.

## A dev proxy that forwards the browser's Origin unchanged fails every exact-Origin check (#191)

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
deviation, however many of them run.

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

**A DOM test cannot observe an optimistic cache write while a mutation is pending, in this
component, and that is not this bug.** `Dashboard.tsx` renders the `acceptedProjects` SNAPSHOT
(~:370), not the query cache directly, and the effect that would refresh that snapshot from a fresh
`queryProjects` explicitly defers while `interactionBlocked` is true (~:354, which includes
`pendingOrdering.size > 0`) — for the ENTIRE duration of a priority mutation, searched or not, on
`main` today, independent of this fix. A rendered `<select>`/star control genuinely cannot show "2"
while its own POST is still in flight; the correct assertion for "did the optimistic/confirmed/
rollback write land in the right place" is `queryClient.getQueryData` on the exact key directly, not
the rendered control — proven empirically here (a temporary render/tick trace showed the control
stuck at the old value through every tick of even a FAST-resolving POST, with a refetch already
fired by the first tick) before trusting it, rather than assumed from reading the effect once. Filed
separately as its own issue; not touched by this fix.

## A captured key or a captured timestamp is only as fresh as the render that captured it (#230, Sol review round 2)

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

## A typed config key can be silently dropped by a runtime allow-list (#219, 2026-09-21)

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
