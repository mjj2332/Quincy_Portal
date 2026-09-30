# Production deploy from CI

Production deploys itself: a merge to `main` that touches `portal/` runs the `deploy` job in
`.github/workflows/portal.yml` once `typecheck`, `test` and `build-web` pass. So merging a PR *is*
deploying it. A merge that touches only docs or `.github/` deploys nothing; **Run workflow** on
`main` (GitHub → Actions → Quincy Portal, or `gh workflow run portal.yml --ref main`) redeploys
without one. Pull requests and other branches never deploy. Verified end to end 2026-09-28
(run 36366028127).

The job runs its steps in this order, and any failure stops everything after it:

1. **Token check.** The `CLOUDFLARE_API_TOKEN` repository secret is set.
2. **Migration guard.** `wrangler d1 migrations list DB --remote` prints "No migrations to apply".
3. **Web build.** `npm run build -w @quincy/web`, because the app Worker serves `apps/web/dist`.
4. **Workers**, in binding order: background, webhook-ingress, app.

One deploy runs at a time, and a running one is never cancelled half-way.

## A PR that adds a D1 migration

CI never applies migrations. Merging such a PR turns the deploy job red at the migration guard,
with nothing deployed and production still on the previous version. Then, with the owner's
go-ahead (a production schema migration is high-stakes work, AGENTS.md):

0. Capture a Time Travel bookmark first: `npx wrangler d1 time-travel info DB` in `portal/workers/app`,
   and record the bookmark id in the PR thread. `npx wrangler d1 time-travel restore DB
   --bookmark=<id>` restores the schema and data to it, and loses every write since the bookmark, so
   it is the last resort.
1. Apply it: `npx wrangler d1 migrations apply DB --remote` in `portal/workers/app`. It must list
   only that PR's migration, and if it lists two, stop: the previous migration PR was never applied.
2. Re-run the job: `gh run rerun <run-id> --failed`.

The code ships after the schema, never before it.

## After a deploy

The job log names each new version: `gh run view --job <deploy-job-id> --log | grep "Current
Version ID"` prints background, webhook-ingress, then app. Then check production read-only:

- `curl -sS https://quincy.flamingfire.my/ | grep -o 'index-[A-Za-z0-9_-]*\.js'` names the bundle
  the build produced.
- `curl -sI https://quincy.flamingfire.my/assets/index-<hash>.js | grep -i cache-control` (use the
  hash from the line above) prints `public, max-age=31536000, immutable` (#359). If it prints
  `max-age=0, must-revalidate`, `apps/web/public/_headers` did not reach `dist/`.
- `/api/auth/get-session` answers 200, and an authenticated route such as
  `/api/production-gantt?scope=active` answers 401 to a signed-out request: the route mounts and
  doesn't crash. Whether the signed-in pages work is the owner's check in their browser.
- To see where load time goes after a deploy, follow `Load-Time-Measurement.md`.

## When the job fails

| Failing step and message | Cause | Fix |
|---|---|---|
| Token check: "The CLOUDFLARE_API_TOKEN repository secret is not set" | No secret | Owner adds it (below) |
| Migration guard: "No migrations to apply" missing, with real migrations listed | A merged PR's migration isn't applied | §A PR that adds a D1 migration |
| Migration guard: `[code: 7403]` "The given account is not valid or is not authorized to access this service" on `/d1/database/…/query` | The token lacks **Account · D1 · Edit**, or its Account Resources leave out the account (the first run, 2026-09-28) | Owner edits the token; the value doesn't change, so `gh run rerun <run-id> --failed` |
| A `wrangler deploy` step: an authentication error | The token lacks the permission the error names | Owner adds it to the token, then re-run |

## Rolling back

`npx wrangler rollback <version-id>` in that Worker's folder, or Cloudflare dashboard → Workers &
Pages → the Worker → **Deployments**. A rollback holds only until the next deploy (a merge to
`main` that touches `portal/`, or a manual **Run workflow**), so follow it with a revert PR or a fix.

### Multi-assignee Subtasks (#358)

The Worker rollback target depends on how far the series has shipped. Rolling back below the floor
loses or misreads assignees.

| Live code | Safe rollback target | Why |
|---|---|---|
| #364 (relation and dual-write) | anything | old code ignores the table, and drift is healed by the next migration (0049) |
| #368-#372, flag off | #364 or later, never below it once 0049 is applied | #364 dual-writes and nothing re-syncs after 0049 |
| any, flag on | #368 or later (#364 is degraded: it sees the first assignee only and keeps the rest) | #364's writes are replace-one and never delete unknown assignees |
| #373 detach | the previous PR (never below #368 once multi-assignee data exists) | earlier readers still read the mirror, which is stale once the detach writes without it |
| #373 drop | the detach PR or later only | the column is gone, and restoring it means Time Travel, which loses writes |

`docs/adr/0012-subtask-assignees-are-a-relation.md` has the reasoning.

#### Multi-assignee rollout flag

The `feature_flags` row `subtask_multi_assignee` (seeded **off** by migration 0049, missing row = off)
gates *growth*: while it is off the API refuses to save a Subtask with more than one assignee
(`subtask_multi_assignee_disabled`, HTTP 400) on create and on any update that adds a person and leaves
more than one. Removing assignees and replacing one person with another always work. The server, not the
UI, enforces it, and `GET /api/projects/:projectId/subtask-assignee-options` reports it as `multiAssignee`.

Turn it on only when the reader PRs are all deployed and checked in production: due reminders (#369),
per-person team removal (#371), Calendar (#370) and Gantt (#372), plus the Checklist UI (#368). Until
then a second assignee would get no due reminder and would be missing from Calendar, Gantt and team counts.

```sh
# from portal/workers/app; verify with the SELECT afterwards
npx wrangler d1 execute DB --remote --command "UPDATE feature_flags SET enabled = 1, updated_at = CAST(unixepoch('now') AS INTEGER) * 1000 WHERE key = 'subtask_multi_assignee' AND enabled = 0"
npx wrangler d1 execute DB --remote --command "SELECT enabled FROM feature_flags WHERE key = 'subtask_multi_assignee'"
```

Turning it back off (`enabled = 0`) is safe: it only blocks adding people beyond one and never
touches existing assignees. A migration must never re-assert the row (`docs/lessons.md`, #160).

### Calendar (since #224)

The ReUI event calendar is the Dashboard's only Calendar renderer. FullCalendar and its per-browser
opt-out were deleted in #224, so a stored `quincy:dashboard:calendar:renderer` value is ignored.
To back out a Calendar regression, use a Worker rollback (above) for an emergency and a revert PR
for anything durable; there is no switch.

## One-time setup: the Cloudflare API token

The owner creates it and adds it to GitHub; an agent never handles the token.

1. Cloudflare dashboard → My Profile → **API Tokens** → **Create Token** → the **Edit Cloudflare
   Workers** template.
2. Add **Account · D1 · Edit** and **Account · Queues · Edit**. The Workers bind D1, Queues, R2,
   KV, Durable Objects and Workflows; the template covers the rest.
3. Account Resources: the one account ("Mjj2332@gmail.com's Account"). Zone Resources:
   `flamingfire.my`. Create, and copy the token.
4. GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**, name
   `CLOUDFLARE_API_TOKEN`. Or `gh secret set CLOUDFLARE_API_TOKEN --repo mjj2332/Quincy_Portal`
   and paste at the prompt.
