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
