# Lessons — Quincy Portal build

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
