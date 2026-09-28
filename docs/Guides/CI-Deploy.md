# Production deploy from CI

The `deploy` job in `.github/workflows/portal.yml` deploys production after every merge to `main`
that touches `portal/`, once `typecheck`, `test` and `build-web` pass. "Run workflow" on `main`
(GitHub → Actions → Quincy Portal) redeploys without a merge. Pull requests and other branches
never deploy.

It deploys the three Workers in binding order: background, webhook-ingress, then app (which also
uploads the web app, built in the same job). One deploy runs at a time, and a running one is never
cancelled half-way.

## One-time setup: the Cloudflare API token

The job reads a repository secret, `CLOUDFLARE_API_TOKEN`. Until it exists, the job fails at its
first check and nothing deploys. The owner creates it; an agent never handles the token.

1. Cloudflare dashboard → My Profile → **API Tokens** → **Create Token** → the **Edit Cloudflare
   Workers** template.
2. Add two permissions to the template's list: **Account · D1 · Edit** and **Account · Queues ·
   Edit**. The Workers bind D1, Queues, R2, KV, Durable Objects and Workflows; the template covers
   the rest.
3. Account Resources: the one account. Zone Resources: `flamingfire.my`. Create, and copy the token.
4. Add it to GitHub: repo → Settings → Secrets and variables → Actions → **New repository secret**,
   name `CLOUDFLARE_API_TOKEN`, paste the token. Or run `gh secret set CLOUDFLARE_API_TOKEN --repo
   mjj2332/Quincy_Portal` and paste at the prompt.

If a deploy step then fails with an authentication error, the error names the missing permission:
edit the token in Cloudflare, add it, and re-run the job.

## Migrations stay manual

CI never applies D1 migrations. Before deploying, the job lists production's unapplied migrations
and stops if there are any, because code that needs a table production lacks would break the live
site. When that happens: apply them by hand (`npx wrangler d1 migrations apply DB --remote` in
`portal/workers/app`), then re-run the job.

## Rolling back

Cloudflare dashboard → Workers & Pages → the Worker → **Deployments** → roll back to the previous
version, or `npx wrangler rollback <version-id>` in that Worker's folder. The deploy log in the
Actions run prints each new version ID.
