# Lessons — Quincy Portal build

## 2026-07-19 — Hono router-wide middleware leaks across sibling mounts
`subRouter.use("*", middleware)` + `parent.route("/", subRouter)` applies the middleware to
EVERY router mounted at "/" AFTER it — not just the subrouter's own routes. Two route files
did this with capability gates (manageUsers, manageIntegrations), silently 403-locking
photographers/editors out of all later-mounted API routes. Caught only by the integration
test that exercised a real photographer session end-to-end.
**Rules:** (1) In Hono, always scope router-level middleware to the router's own path prefix
(`use("/users", mw)` + `use("/users/*", mw)`), never `use("*")` on a router mounted at "/".
(2) Boot-and-curl checks are not authorization tests — every capability matrix claim needs at
least one authenticated-session integration test per role.

## 2026-07-19 — Verify agent-reported success independently
Codex agents' sandboxes couldn't bind loopback ports, so their "boot verification" steps
silently didn't run; one agent shimmed `@quincy/shared` types rather than fixing the root
tsconfig cause (which was my own gap: files added after the package's last green typecheck).
**Rules:** (1) Re-run every verification the agent claims, outside its sandbox. (2) Full-
workspace typecheck after each wave — per-package green ≠ integration green. (3) Reject
type shims/facades over workspace packages; fix the owning package's config instead.

## 2026-07-19 — MCP servers added mid-session aren't usable mid-session
`claude mcp add` (and the Cloudflare MCP setup it enabled) writes to `~/.claude.json`, but
a *running* session's tool list is fixed at startup — `ToolSearch` won't surface a server
registered after the session began, even once `claude mcp list` shows it "Connected". Needs
a fresh session to actually call its tools.
**Rule:** when asked to configure a new MCP server for "yourself" mid-conversation, register
it, but don't expect to use it this session — verify via ToolSearch, and if empty, fall back
to an already-authenticated CLI (wrangler, gh, etc.) for the actual work rather than blocking.

## 2026-07-19 — Codex `codex exec` (non-interactive) can't approve MCP write actions
Handing Codex a Cloudflare-provisioning task with its Cloudflare MCP configured failed
silently: `mcp: cloudflare/execute (failed)` → "account lookup was cancelled before
execution." `codex exec` runs with `approval: never`, and this MCP server's write actions
apparently need a per-call approval Codex can't grant non-interactively — it isn't a network/
sandbox permission issue (network access was enabled; `search` on the same server worked).
**Rule:** for real-account write operations (cloud resource provisioning, anything
consequential) via an MCP that a subagent can't self-approve, don't retry-tune the agent
invocation — do it directly with an already-authenticated CLI instead.

## 2026-07-19 — D1 exec() SQL loading
`D1Database.exec()` processes statements line-by-line; multiline SQL fails with
"incomplete input", and comment lines can contain `;` which breaks naive splitting.
**Rule:** strip comment lines FIRST, then split on statement boundaries, then flatten
each statement to one line.
