# Quincy Portal

An internal media-pipeline + client-delivery web app for **Quincy Productions**, a
real-estate photography studio — replacing our [Pixieset site](https://quincyproductions.pixieset.com).
It runs the full pipeline for a shoot: RAW capture → internal QA & markup → editing handoff →
client delivery, with role-based access for admin, photographers, and editors.

**Production is live at <https://quincy.flamingfire.my>.**

## What's in this repo

| Folder | What it is |
|---|---|
| **`portal/`** | **The production app, and the only place implementation happens.** TypeScript monorepo — React 19.2.8 + Vite SPA, Hono API on Cloudflare Workers, D1 · R2 · KV · Queues · Workflows, Google-OAuth sign-in. This is the real, deployed software. |
| **`docs/`** | [`PRD/`](docs/PRD/) — [PRD](docs/PRD/PRD.md), [Personas](docs/PRD/Personas.md), [Sitemap](docs/PRD/Sitemap.md). [`Guides/`](docs/Guides/) — Cloudflare/Google/Dropbox setup and admin how-tos. [`subagents/`](docs/subagents/) — orchestration docs and CLI references. [`agents/`](docs/agents/) — issue tracker, triage labels, domain docs. [`archive/`](docs/archive/) — **historical, not authoritative**. Plus the [lessons log](docs/lessons.md) at the top level. (The Decision Sheet, Implementation Proposal, Implementation Plan, to-do list, `plans/`, and `reviews/` were retired to start a fresh development cycle.) |
| **`test-data/`** | Local-only test fixtures (media is large and gitignored — see [test-data/README.md](test-data/README.md)). |
| **`chats/`** | Early design-conversation transcript (archival). |

`CLAUDE.md` is the guide for coding agents; `AGENTS.md` is a symlink to it, so non-Claude
agents read the same file.

## Working on the production app

Everything lives under `portal/` (an npm-workspaces monorepo). From `portal/`:

```bash
npm run db:migrate:local            # FIRST, per worktree — migrate local D1 and enable dev flags
npm run dev -w @quincy/web          # run the SPA locally (needs the app worker too)
npx wrangler dev                    # in workers/app — the API + auth + SPA host
npm run build -w @quincy/web        # build the SPA
npx vitest run --config workers/app/vitest.config.ts   # API/integration tests
```

Run `db:migrate:local` before the first `dev` in **each git worktree** — every worktree gets its
own `.wrangler/state`, so a fresh one starts with an empty database. It also switches on the
feature flags that production already has on but that ship disabled from their staged-rollout
migration, the Board contract among them; without it the Kanban renders as disabled and no drag
can be started (#160). It is safe to re-run, and local-only by construction — it refuses any
argument that could point it at another environment.

Local app/auth secrets go in `portal/workers/app/.dev.vars`; background-provider secrets such as
`AUTOHDR_API_KEY` go in `portal/workers/background/.dev.vars` (both are gitignored). See the
adjacent `.dev.vars.example` files, [docs/Guides/Google-OAuth-Setup.md](docs/Guides/Google-OAuth-Setup.md) for
sign-in, and [CLAUDE.md](CLAUDE.md) for the full build/verify/deploy workflow and conventions.
Provision the production AutoHDR key from `portal/workers/background/` with
`npx wrangler secret put AUTOHDR_API_KEY`; never place it in `wrangler.jsonc`.

Deploys go out in dependency order (**background → webhook-ingress → app**) via
`wrangler deploy`.

## Design system & brand

Built on the Quincy Productions design system (ink-on-paper; Mazius Review display, Apfel
Grotezk UI). **The live token set at [`portal/apps/web/src/styles/`](portal/apps/web/src/styles/)
is the sole design authority**, guarded by `design-system-guards.test.ts` beside it.

Components are **ReUI (`base-nova` variant) composed on that Quincy token set**, in
`portal/apps/web/src/components/reui/`; `components/quincy/` holds the Quincy-owned layer built
alongside them. There is no separate legacy primitive set.

The original design-system export it was ported from is kept at
[`docs/archive/`](docs/archive/) for provenance only — it has since been diverged from and is
explicitly not authoritative. The `prototype/` reference app it shipped inside was retired in
#48; it is recoverable from git history (`git log -- prototype/`).
