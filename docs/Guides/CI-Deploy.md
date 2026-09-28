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

1. Apply it: `npx wrangler d1 migrations apply DB --remote` in `portal/workers/app`.
2. Re-run the job: `gh run rerun <run-id> --failed`.

The code ships after the schema, never before it.

## After a deploy

The job log names each new version: `gh run view --job <deploy-job-id> --log | grep "Current
Version ID"` prints background, webhook-ingress, then app. Then check production read-only:

- `curl -sS https://quincy.flamingfire.my/ | grep -o 'index-[A-Za-z0-9_-]*\.js'` names the bundle
  the build produced.
- `/api/auth/get-session` answers 200, and an authenticated route such as
  `/api/production-gantt?scope=active` answers 401 to a signed-out request: the route mounts and
  doesn't crash. Whether the signed-in pages work is the owner's check in their browser.

## When the job fails

| Failing step and message | Cause | Fix |
|---|---|---|
| Token check: "The CLOUDFLARE_API_TOKEN repository secret is not set" | No secret | Owner adds it (below) |
| Migration guard: "No migrations to apply" missing, with real migrations listed | A merged PR's migration isn't applied | §A PR that adds a D1 migration |
| Migration guard: `[code: 7403]` "The given account is not valid or is not authorized to access this service" on `/d1/database/…/query` | The token lacks **Account · D1 · Edit**, or its Account Resources leave out the account (the first run, 2026-09-28) | Owner edits the token; the value doesn't change, so `gh run rerun <run-id> --failed` |
| A `wrangler deploy` step: an authentication error | The token lacks the permission the error names | Owner adds it to the token, then re-run |

## Rolling back

`npx wrangler rollback <version-id>` in that Worker's folder, or Cloudflare dashboard → Workers &
Pages → the Worker → **Deployments**. A rollback holds only until the next merge to `main`
redeploys, so follow it with a revert PR or a fix.

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
