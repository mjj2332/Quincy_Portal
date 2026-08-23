# Quincy Portal

An internal media-pipeline + client-delivery web app for **Quincy Productions**, a
real-estate photography studio — replacing our [Pixieset site](https://quincyproductions.pixieset.com).
It runs the full pipeline for a shoot: RAW capture → internal QA & markup → editing handoff →
client delivery, with role-based access for admin, photographers, and editors.

**Production is live at <https://quincy.flamingfire.my>.**

## What's in this repo

| Folder | What it is |
|---|---|
| **`portal/`** | **The production app.** TypeScript monorepo — React 18 + Vite SPA, Hono API on Cloudflare Workers, D1 · R2 · KV · Queues · Workflows, Google-OAuth sign-in. This is the real, deployed software. |
| **`prototype/`** | The original **design prototype** (HTML/CSS/JS, React via CDN, mock data — no backend). A look-and-flow reference the production app was built from; not extended. Demo at <https://prototype.quincy.flamingfire.my>. |
| **`docs/`** | Product & planning docs — [PRD](docs/PRD.md), [Personas](docs/Personas.md), [Sitemap](docs/Sitemap.md), the approved [Decision Sheet](docs/Decision-Sheet.md), the [Implementation Plan](docs/Implementation-Plan.md), setup/handoff guides, plus the live [to-do list](docs/todo.md), [lessons log](docs/lessons.md), and archived [reviews](docs/reviews/). |
| **`test-data/`** | Local-only test fixtures (media is large and gitignored — see [test-data/README.md](test-data/README.md)). |
| **`chats/`** | Early design-conversation transcript (archival). |

`CLAUDE.md` / `AGENTS.md` are the guide for coding agents (identical mirrors).

## Working on the production app

Everything lives under `portal/` (an npm-workspaces monorepo). From `portal/`:

```bash
npm run dev -w @quincy/web          # run the SPA locally (needs the app worker too)
npx wrangler dev                    # in workers/app — the API + auth + SPA host
npm run build -w @quincy/web        # build the SPA
npx vitest run --config workers/app/vitest.config.ts   # API/integration tests
```

Local app/auth secrets go in `portal/workers/app/.dev.vars`; background-provider secrets such as
`AUTOHDR_API_KEY` go in `portal/workers/background/.dev.vars` (both are gitignored). See the
adjacent `.dev.vars.example` files, [docs/Google-OAuth-Setup.md](docs/Google-OAuth-Setup.md) for
sign-in, and [CLAUDE.md](CLAUDE.md) for the full build/verify/deploy workflow and conventions.
Provision the production AutoHDR key from `portal/workers/background/` with
`npx wrangler secret put AUTOHDR_API_KEY`; never place it in `wrangler.jsonc`.

Deploys go out in dependency order (**background → webhook-ingress → app**) via
`wrangler deploy`. Current work is on the `build/phase-0-2` branch.

## Reviewing the prototype

Open [`prototype/index.html`](prototype/index.html) in a modern browser — no build step. It
shows the intended design and flows (team dashboard, project workspace with RAW/Edited review
and freehand markup, and the client delivery page). It is a reference only; the shipping
product is `portal/`.

## Design system & brand

Built on the Quincy Productions design system (ink-on-paper; Mazius Review display, Apfel
Grotezk UI). The prototype's design system under `prototype/_ds/` has been ported into
`portal/apps/web/src/styles/`.
