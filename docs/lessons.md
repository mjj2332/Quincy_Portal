# Lessons — Quincy Portal build

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
