<!--
  Everything below this comment is mirrored verbatim in CLAUDE.md (read by Claude Code).
  Update BOTH together.
-->

# Quincy Portal

Internal media-pipeline + client-delivery web app for a real-estate photography studio. 
**Production is live** at https://quincy.flamingfire.my/
## Orchestration workflow

The session orchestrates — plans, decomposes, delegates, synthesizes — regardless of which Claude
model is driving. Default build task → **fast-worker** subagent (mechanical, well-specified work:
boilerplate, tests, formatting, straightforward edits — it stops and reports back rather than
guessing on anything ambiguous or design-level). Reasoning-heavy phase → **deep-reasoner** subagent
(architecture, hard debugging, algorithm design, tradeoff analysis). **Codex**
(`/codex:rescue --background`) is a peer, not a reviewer — same standing as deep-reasoner, a
different model family's take on the same problem.

**Every plan gets Opus and Codex in parallel.** New-feature planning, bug fixes, UI/UX changes,
revamps, and high-stakes work (a production schema migration, an auth/authorization logic change,
an irreversible data operation, a cross-cutting architecture change) all route the plan through
both, each blind to the other's answer, synthesized by the session before build starts.
**fast-worker still executes the build** once the plan is settled — this step is planning/review,
not a build-routing change. Keep your own context lean: fork or spawn rather than pasting full
transcripts back and forth.

Sol  owns diff review; Luna owns testing, including any Chrome/browser pass — Luna can
drive a real authenticated Chrome unsandboxed when a task needs it. Full roster, invocation
mechanics options live in
`docs/subagents/Subagent-Orchestration.md`.

## Two codebases, not one

- **`portal/`** — the production app, and the only place implementation happens. TS monorepo:
  React 18.3.1 current baseline + Vite SPA, Hono API on Cloudflare Workers, D1 / R2 / KV / Queues / Workflows,
  Google OAuth via better-auth.
- **`prototype/`** — the original Claude-Design export (CDN React, in-browser Babel, mock
  data, no backend). **Reference only: never extend it, never copy its structure into
  `portal/`.** Match its look and flows — its design system is already ported to
  `portal/apps/web/src/styles/`. Served at <https://prototype.quincy.flamingfire.my>.

## Read first

`docs/lessons.md` collects real bugs from this build — read it before touching auth, Hono
routing, or the review lightbox, and keep it current as you work.




Authority order when docs conflict: `docs/PRD/PRD.md` → `Personas.md` / `Sitemap.md`. Auth is
**Google OAuth**, not Cloudflare Access; renditions use the **remote Image Transformation** path,
not a Container.

Design-system source —`prototype/_ds/quincy-productions-design-system-*/`