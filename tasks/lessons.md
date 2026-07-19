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

## 2026-07-19 — D1 exec() SQL loading
`D1Database.exec()` processes statements line-by-line; multiline SQL fails with
"incomplete input", and comment lines can contain `;` which breaks naive splitting.
**Rule:** strip comment lines FIRST, then split on statement boundaries, then flatten
each statement to one line.
