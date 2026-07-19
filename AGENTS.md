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

## Quincy Portal prototype handoff

This repository is the Quincy Portal prototype, exported from Claude Design as HTML/CSS/JS. The prototype communicates the intended design and flows for a real implementation.

### Portal implementation rules

1. Read `project/index.html` in full before implementing portal work. The user had this file open during the handoff, so it is the primary design reference.
2. Follow every import from `project/index.html`. Open the shared components, CSS, scripts, assets, and design-system files it pulls in before changing code.
3. Match the visual output of the prototype. Do not copy the prototype's internal structure unless it fits the target codebase.
4. Do not render the prototype in a browser or take screenshots unless the user asks. Dimensions, colors, layout rules, and flow details should be read from the source.
5. Use `project/index.html` as the current review entry point. The standalone single-file builds are older snapshots unless regenerated.

### Portal bundle contents

- `README.md` — prototype overview and review notes.
- `project/index.html` — current multi-file entry point.
- `project/app/` — React/JSX prototype components.
- `project/app.css` — app styles.
- `project/_ds/` — Quincy Productions design system.
- `project/docs/` — PRD, personas, and sitemap.
- `project/assets/` — logos and patterns.
- `chats/` — early design conversation transcript.
