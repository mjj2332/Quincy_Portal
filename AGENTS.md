# AGENTS.md — Working in Quincy projects

This is the coding-agent operating manual for Quincy Productions work. It adapts the project guidance from `CLAUDE.md` for agents that may edit files, run scripts, and implement production code.

Maintainer: Terry Lee. Treat the physical files in these Quincy folders as the source of truth.

## Communication

- Minimize optional commentary. During execution, send only required notices, blocking questions, meaningful progress updates, risk/verification notes, and the final result.
- Ask a blocking question before implementation when scope is genuinely ambiguous or when a reasonable assumption could cause rework.
- After material changes to Quincy production workflows, documents, templates, or generated outputs, tell Terry what changed.

## Before doing anything

1. Read the local `README.md` for the folder map and current project context.
2. For any client-facing output, read the agent's profile in `Customer Vault/Real Estate Agent/Agencies/[AGENCY]/Agents/[AGENT].md`. `§2 Standing Restrictions` is the most critical field; it governs music, shot, and edit rules.
3. For workflow questions, use `docs/PRODUCTION_WORKFLOW.md` as the authoritative reference.
4. For any HTML document work, read `Templates/QP_DOCUMENT_DESIGN_SPEC.md` first. Brand tokens live in `Studio Assets/BRAND_GUIDE.md`.
5. Prefer editing existing files. Create new files only where the folder convention requires it, such as new job folders or new agent profiles from `AGENT_TEMPLATE.md`.

## Quincy workflow mental model

| Layer | Folder | Role |
|---|---|---|
| 1. Studio Assets | `Studio Assets/` | Brand bible; applies to all clients |
| 2. Customer Vault | `Customer Vault/` | One profile per client; tailors output |
| 3. Job Orders | `Job Orders/` | Where actual work lives, organized by job folder |
| 4. Templates | `Templates/` | Blank starting points, HTML and Markdown |
| 5. Scripts | `scripts/` | Node.js automation for render and PDF workflows |

## Production document types

Every production document exists in three forms: `.md` source, `.html` styled document, and `.pdf` deliverable.

- `JOB_ORDER` — client-facing brief. Bespoke HTML from `Templates/HTML/JOB_ORDER_DOSSIER_TEMPLATE.html`.
- `EDIT_PLAN` — editor's manual. Bespoke HTML; includes Musicbed filters and SUNO prompts for both tiers.
- `STOCK_SHOOT_PLAN` — lifestyle/neighbourhood shoot plan. Coordinate as 2-day blocks when shoots are back-to-back in the same suburb.
- `VIDEOGRAPHER_BRIEF` — post-shoot only. Voice note `.m4a` → ElevenLabs STT → `.txt` → `.md` → bespoke HTML → PDF.
- `PRE_SHOOT_PLAN` — pre-shoot; auto-rendered from Markdown.
- `SCRIPT` — VO/caption script when required; auto-rendered.

`render_markdown_folder_to_html.mjs` overwrites `EDIT_PLAN.html` and `VIDEOGRAPHER_BRIEF.html`. Always regenerate the PDF immediately after running the render script on a folder containing those files.

## Scripts

Run these from the Workflow Automation project root:

```bash
# Render all .md files in a job folder to .html
node scripts/render_markdown_folder_to_html.mjs "Job Orders/YYYY.MM.DD - ..."

# Generate a PDF from any HTML file
node scripts/generate_pdf.mjs "path/in.html" "path/out.pdf"
```

Never generate a final PDF from HTML that has not been brought into compliance with `Templates/QP_DOCUMENT_DESIGN_SPEC.md`.

For Chrome or PDF artifact issues, see `docs/workflow/PDF_GENERATION_GUIDE.md`.

## Naming conventions

- Job folder: `YYYY.MM.DD - [agency] - [agent] - [property address]`
- Master video: `[ROOT] - Master - V1.3Q.mp4` for 16:9
- Hook Reel: `[ROOT] - Reel - V1.3Q.mp4` for 9:16
- 9:16 master cut: `[ROOT] - Master-916 - V1.3Q.mp4`
- Stock footage: `[SUBURB-CODE]_STOCK_[YEAR]_[CATEGORY]_[LOCATION]_[SHOT-TYPE]_[SEQUENCE]`

## Client-specific rules

- Victoria Pillinger, Pillinger agency: "exclude Guitar" applies only to Victoria, not to other agents or agencies. Do not generalize her music restriction.
- Always check `§2 Standing Restrictions` in the agent profile before writing any Edit Plan or SUNO prompt.

## Brand quick reference

Colours: Ink `#0a0a0a`; Warm Paper `#faf8f2`; Paper-100 `#f4f0e7`; Greige ramp `#e4ded0` to `#4d473c`; Signals `#3f5b3a`, `#9a6a1f`, `#7a2420`, `#2f3b4d`.

Fonts: Mazius Review for display; Apfel Grotezk for body and UI; Messapia for statement text; Athelas for long-form; system mono for code and metadata.

## Where to go for what

| I need to... | Go to |
|---|---|
| Full production workflow | `docs/PRODUCTION_WORKFLOW.md` |
| Brand definition | `Studio Assets/BRAND_GUIDE.md` |
| Build HTML from scratch | `Templates/QP_DOCUMENT_DESIGN_SPEC.md` |
| Start a new Job Order | `Templates/HTML/JOB_ORDER_DOSSIER_TEMPLATE.html` |
| Start a new Edit Plan | `Templates/HTML/EDIT_PLAN_TEMPLATE.html` |
| Start a new Videographer Brief | `Templates/HTML/VIDEOGRAPHER_BRIEF_TEMPLATE.html` |
| Start a new Stock Shoot Plan | `Templates/Markdown/STOCK_SHOOT_PLAN_TEMPLATE.md` |
| All template options | `Templates/README.md` |
| Agent restrictions | `Customer Vault/Real Estate Agent/Agencies/[AGENCY]/Agents/[AGENT].md` |
| PDF troubleshooting | `docs/workflow/PDF_GENERATION_GUIDE.md` |

## Output expectations

- When producing client-facing documents, always read both the agent profile, especially `§2 Standing Restrictions`, and the relevant template before drafting.
- When transcribing a videographer voice note, use the ElevenLabs STT skill/workflow available in the current agent environment.
- Preserve existing folder conventions and naming patterns.

## Quincy Portal — prototype vs. production build

This repository contains **two things**, and they serve different purposes. Do not confuse them.

1. **`project/`** — the original Claude-Design-exported HTML/CSS/JS **prototype**. It is a
   *design and interaction reference only* — no build step, no backend, mock data in
   `app/data.jsx`. It is not being extended further as an app; it exists to show what the
   real thing should look and feel like.
2. **`portal/`** — the actual **production Cloudflare app** being built to replace it: a
   TypeScript monorepo (Vite SPA + Hono API on Workers, D1, R2, Queues/Workflows). This is
   where implementation work happens now.

### Source of truth, in order

1. `project/docs/Decision-Sheet.md` — approved product decisions (D-01…D-15). Anything here
   overrides older docs where they conflict.
2. `project/docs/Implementation-Plan.md` — the current architecture and phase plan (v1.0,
   Cloudflare-audited). Supersedes `Implementation-Proposal.md` wherever they disagree
   (notably: auth is Google OAuth not Cloudflare Access; image renditions use Cloudflare's
   remote Image Transformation path, not a Cloudflare Container).
3. `project/docs/PRD.md`, `Personas.md`, `Sitemap.md` — product requirements and UX detail.
4. `tasks/todo.md` — the live phase-by-phase checklist. **Read this first** to see exactly
   what's done, in progress, or blocked before starting any new work.
5. `tasks/lessons.md` — patterns and bugs hit during this build (e.g. a Hono middleware
   footgun that silently 403's whole routers). Read it before touching auth/routing code.

### Build status (as of 2026-07-19)

Phases 0, 1, and 2 of the Implementation Plan are built on branch **`build/phase-0-2`**
(not yet merged to `main`), across 5 commits — `e6d3719` (monorepo scaffold + `@quincy/shared`
+ `@quincy/db` schema), `91ee387` (SPA shell + staff API worker + background/webhook
workers), `f9f30fe` (Phase-1 UI + test suite + CI), `60ac4a8` (Phase-2: autoHDR flow, Edited
QA, RAW↔Edited compare, annotations), `be88a83` (real Cloudflare resources provisioned).

All 6 npm workspaces under `portal/` typecheck clean and the test suite passes
(`packages/shared` + `workers/app` vitest suites, incl. the XMP star-rating parser verified
against real Lightroom exports in `Test Images with star rating/` — gitignored, not in git).
Before committing any further work, re-run: `npx tsc -p <workspace>/tsconfig.json` for all
six workspaces, both `vitest run --config .../vitest.config.ts` suites, and
`npm run build -w @quincy/web`.

**Infra state:** D1 (`quincy-portal`), KV (`quincy-portal-sessions`), and a Queue
(`quincy-ingest`) are provisioned on the real Cloudflare account and wired into the three
`wrangler.jsonc` files with real IDs; the D1 schema + seed are applied remotely.
**R2 is not yet enabled on the account** (dashboard action only the account owner can take)
— the `quincy-portal-media` bucket is still pending, which blocks end-to-end upload/rendition
testing. Google OAuth client secrets are not yet configured — see
`project/docs/Google-OAuth-Setup.md` (a standalone handoff doc, written for someone without
prior context).

### Working agreements for `portal/` work

- Never run `npm install` casually inside `portal/` without checking `package.json` first —
  all Phase 0–2 dependencies are already pinned and installed.
- `@quincy/shared` is the single source of truth for capabilities, pipeline stage keys, JPEG
  ingest rules, and the XMP rating parser — extend it, don't duplicate its logic elsewhere.
- Router-level middleware in the Hono workers must be path-scoped
  (`router.use("/x", mw); router.use("/x/*", mw)`), never `router.use("*", mw)` — see
  `tasks/lessons.md` for why this is a real, previously-shipped bug.
- Keep `tasks/todo.md` and `tasks/lessons.md` current as you go; they are how the next agent
  (human or not) picks up context without re-deriving it.

### Prototype reference (still useful, `project/`)

1. Read `project/index.html` in full before porting any prototype interaction — it is the
   primary design reference and pulls in the shared components, CSS, scripts, and
   design-system files.
2. Match the prototype's visual output; do not copy its internal structure (globals +
   Babel-in-browser) into `portal/` — that part has already been rebuilt properly as typed
   Vite/React modules.
3. Do not render the prototype in a browser or take screenshots unless asked.

**Bundle contents:** `README.md` (prototype overview), `project/index.html` (prototype entry
point), `project/app/` (prototype JSX components — reference only), `project/app.css`,
`project/_ds/` (Quincy design system — already ported into `portal/apps/web/src/styles/`),
`project/docs/` (PRD, personas, sitemap, decision sheet, implementation plan), `project/assets/`
(logos/patterns), `chats/` (early design conversation transcript).
