# Reading production data

Production D1 is `quincy-portal`, `database_id` at `portal/workers/app/wrangler.jsonc:20`. Agents
read it; writes follow `docs/Guides/CI-Deploy.md` and the owner's say-so.

## Querying

- **Cloudflare MCP:** `mcp__cloudflare-bindings__d1_database_query` with that `database_id` and one
  `SELECT`.
- **wrangler**, from `portal/workers/app`:
  `npx wrangler d1 execute DB --remote --json --command "SELECT …"` (the same shape as
  `docs/Guides/Default-Editors-Backfill.md:18`). Save the JSON to your scratch dir and read it from
  there rather than re-running.

## Schema

- Read table and column names from `portal/packages/db/src/schema.ts`; it is the Drizzle source of
  every migration in `portal/packages/db/migrations/`.
- Fallback for a table it lacks: `SELECT sql FROM sqlite_master WHERE name = '<table>'`.
  `pragma_table_info` is refused remotely with `SQLITE_AUTH` (`docs/retros/2026-10-05.md` §9); it
  works on local D1 only.
- **Timestamps are epoch milliseconds** wherever the column is `integer(…, { mode: "timestamp_ms" })`
  (`createdAt`/`updatedAt` helpers at `schema.ts:10-13` and most `*_at` columns). Convert with
  `datetime(created_at / 1000, 'unixepoch')`. Plain `integer("…_at")` columns with no mode
  (`schema.ts:184`, `:193`) carry no type hint: read their writer before converting. Dates the
  owner thinks of as calendar days are text, e.g. `shoot_date` `YYYY-MM-DD` (`schema.ts:168`).

## Keep queries small

- Count several things with one `SELECT` of scalar subqueries, not a `UNION ALL` chain: local D1
  caps a compound `SELECT` at 5 terms (`portal/packages/db/setup-local.mjs:38`), so keep remote
  ones within that too and the query runs in both places.
- Select the columns you need and add `LIMIT`; never `SELECT *` from `audit_log` or `user`.
- Personal data stays in your scratch file: report counts and ids, not names or emails.

## `QUINCY_SESSION_COOKIE` (bulk scripts)

Used only by the one-off bulk scripts `portal/scripts/bulk-archive-delete-*-2026.mjs` (e.g.
`bulk-archive-delete-oct-2026.mjs:53`), which call the real routes as an Admin so the audit row,
guards and cascade stay the route's.

The owner supplies it: from their own signed-in Admin browser session (devtools → Network → any
`/api` request → Request Headers → `cookie`), exported into the environment of their own
terminal, where they run the script (`bulk-archive-delete-oct-2026.mjs:26-29`). It is a live
production session. Agents never ask for it in chat, print, log, paste or store it; a script that
needs it and does not find it is a blocker to report to the owner
(`docs/subagents/Subagent-Orchestration.md` §2).
