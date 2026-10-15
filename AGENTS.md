# Quincy Portal

Internal media-pipeline + client-delivery web app for a real-estate photography studio. 
**Production is live** at https://quincy.flamingfire.my/, and **a merge to `main` that touches `portal/`
deploys it** from CI. Before merging a D1 migration, or to redeploy or roll back, read
`docs/Guides/CI-Deploy.md`.
## Orchestration workflow

The session orchestrates — plans, decomposes, delegates, synthesizes — regardless of which Claude
model is driving. UI build task → **ui-builder** subagent (Opus, high effort: reads the prototype
frame and the ReUI skill, stops on a conflict, runs verify, never opens a PR). Other build tasks →
**fast-worker** subagent (Sonnet: mechanical, well-specified work — boilerplate, tests, formatting,
straightforward edits — it stops and reports back rather than guessing on anything ambiguous or
design-level). Reasoning-heavy phase → **deep-reasoner** subagent
(architecture, hard debugging, algorithm design, tradeoff analysis). **Codex**
(`/codex:rescue --background`) is a peer, not a reviewer — same standing as deep-reasoner, a
different model family's take on the same problem.

**Every plan gets Opus and Codex in parallel.** New-feature planning, bug fixes, UI/UX changes,
revamps, and high-stakes work (a production schema migration, an auth/authorization logic change,
an irreversible data operation, a cross-cutting architecture change) all route the plan through
both, each blind to the other's answer, synthesized by the session before build starts.
Once the plan is settled, ui-builder or fast-worker executes the build — this step is
planning/review, not a build-routing change. Keep your own context lean: fork or spawn rather than
pasting full transcripts back and forth.

Sol owns diff review. Luna owns test code and non-browser QA. **The session runs every browser
pass** — Agy is retired from it. **Every UI change gets a two-stage browser pass:**

1. **The session measures**: the built-in browser for desktop and tablet widths; **Safari on the
   iOS Simulator for every phone row**, with the on-screen keyboard up for any input surface. A
   narrow desktop window cannot raise the keyboard or reproduce iOS's visual viewport.
   `scripts/agents/ios-pass.sh <path>` boots the Simulator, opens the served branch and makes the
   screenshot folder. The session may hand mechanical capture to a Sonnet subagent, but judges
   every screenshot itself.
2. **design-reviewer** (Opus) judges the screenshots, blind to the session's verdicts until it has
   looked. Its yardstick is the prototype frame when one exists, otherwise the rest of the Portal.

Full roster, the pass contract and invocation mechanics live in
`docs/subagents/Subagent-Orchestration.md`. The agent definitions are committed in
`.claude/agents/`.

## One codebase

**`portal/`** — the production app, and the only place implementation happens. TS monorepo:
React 19.2.8 current baseline + Vite SPA, Hono API on Cloudflare Workers, D1 / R2 / KV / Queues / Workflows,
Google OAuth via better-auth.

**UI is ReUI (`base-nova`) composed on the Quincy token set**, in
`portal/apps/web/src/components/reui/`. There is no legacy primitive set: `components/ui/` **no
longer exists** — do not recreate it or import from it. `components/quincy/` is the surviving
Quincy-owned layer; `quincy/menu.tsx` is a Base UI (`@base-ui/react/menu`) component that moved
there in #56 and is **Quincy-owned Base UI, not a ReUI component** — do not "restore" it to the
registry.

**Routing is TanStack Router** (`lib/app-router.tsx`), with one caveat that reads as working code
if you miss it: `lib/staff-history.ts` gives the router a **read-only** history. It observes the
URL and never writes it, because `Transitioner` canonicalises the URL on mount with no opt-out
(it rewrote `/%61dmin` to `/admin` and mounted the real Admin screen). So a `useNavigate()`,
`<Link>`, or `router.navigate(...)` anywhere in the app **silently does nothing**. Navigation goes
through `InternalLink` / `locationStore()`. See docs/lessons.md § "A router that owns the URL will
canonicalise it" and `lib/routing-transport.guard.test.ts`, which makes that a build failure.

The original `prototype/` design export was retired in #48. What was worth keeping is
archived under `docs/archive/` — **historical, explicitly not authoritative**. Current prototypes
live in `design/prototypes/` (see "Design" below).

## Read first

`docs/lessons.md` collects real bugs from this build — read it before touching auth, Hono
routing, or the review lightbox, and keep it current as you work. Find entries with
`node scripts/lessons-index.mjs <tag|#NNN|text>`; every new section gets a `Tags:` line from
`docs/lessons-tags.md`. Cite a lesson by its heading text, never a line number.

- **Shell is macOS zsh:** `sed -i ''`, quote globs or use `rg -g`, `perl -e 'alarm N; exec @ARGV'`
  for time limits.
- **Test & verify:** `docs/agents/runbook.md` — single-file runs, workspace names, and the
  touching-X-read-Y table. `npm run verify` (from `portal/`) runs everything CI runs.
- **Area maps:** `docs/maps/README.md` — notifications, queues, routes, Project sheet, date/time
  controls, new tables, Base UI, tokens. Read the matching map before exploring.
- **MCP (AI clients):** `docs/Guides/MCP.md` — connecting, scopes, tool table, controls, rollback.
- **Orchestration tooling:** `scripts/agents/` (`preflight.sh`, `serve-branch.sh`, `ios-pass.sh`,
  `sol-review.sh`, `codex-plan.sh`) and brief templates in `docs/subagents/templates/`. QA serves a
  branch only through `serve-branch.sh`, never from the main checkout. Settled plans go to the
  issue or `docs/plans/`. Production D1 and session cookies: `docs/agents/production-data.md`.

Authority order when docs conflict: `docs/PRD/PRD.md` → `Personas.md` / `Sitemap.md`.

## Design: the prototype decides, the tokens express it

**The prototype decides layout and look.** A revamp or a new screen starts from a Claude design
prototype, committed under `design/prototypes/<name>/` (see `design/README.md`). Its frames are the
layout, hierarchy, sizes, copy and behaviour the build must match. Smaller UI changes need no
prototype; they match the rest of the Portal.

**The tokens are the vocabulary** — `portal/apps/web/src/styles/`. The build expresses the
prototype in Quincy tokens (colour, type, spacing, radius, motion), not in the prototype's raw
values. `design-system-guards.test.ts` beside them still mechanises the rules that have shipped
defects more than once, and stays green. The 2026-06-19 export in `docs/archive/` records where the
tokens came from and has since been diverged from — never reconcile the app back to that export.

**Building from a prototype:**

- Every plan maps each prototype frame id to the component that renders it.
- ui-builder reads the prototype source (the frame's JSX and CSS), not only the text plan.
- Where the prototype conflicts with a ReUI component's structure, a guard, or a product
  capability it does not show, the builder stops and the session asks the owner. Never a silent
  choice either way.
- Both browser-pass stages compare each build screenshot with the prototype frame at the same
  size and state.

The video review revamp (#879–#884) is the first such work:
`design/prototypes/video-review-revamp/project/`, frame ids P1–P10, F1–F4, W1–W4, T1–T5, V1–V6.
The audit of what shipped against it is `docs/plans/video-revamp-prototype-audit.md`.

## Author-only rules and impersonation

Annotation, project-comment and notice-board edit/delete are **author-only** — admins are not
exempt — for audit integrity, and every mutation is audit-logged. **One deliberate exception:**
while an Admin is impersonating a user through the runtime-gated impersonation feature
(`docs/Guides/Admin-Impersonation.md`), they act as that user for every author-only check. That
bypass is intentional, toggle-gated and audit-logged (`metaJson.impersonatedBy`) — it is the
design, so leave it in place.

## ReUI component registry — do not "correct" the URL

The component registry in `portal/apps/web/components.json` is:

```
https://proxy.collectui.pro/api/r/reui/{style}/{name}.json
```

**Deliberate and owner-chosen; changing it needs the owner's say-so.** ReUI's docs and MCP advertise
`https://reui.io/r/…` and `mcp.reui.io`; ours (and the owner's MCP config) use the
`proxy.collectui.pro` equivalents on purpose.

Also on this pipeline:

- The license key is `REUI_LICENSE_KEY` in `portal/apps/web/.env.local` (gitignored). It must sit
  *beside* `components.json` — the shadcn CLI looks for `.env.local` in its own working directory,
  so a key at the repo root will not be found. `components.json` refers to it as
  `${REUI_LICENSE_KEY}`, which the CLI expands. **Never inline the key itself.**
- `portal/apps/web/src/config/reui-registry.guard.test.ts` enforces both rules; when it fails,
  revert the change that tripped it and keep the guard as is.
- `.mcp.json` is gitignored because MCP client configs *cannot* expand `${VAR}` and so must carry
  a raw bearer token. The token-free equivalents in `.cursor/mcp.json` and `opencode.json` are
  committed. If you add an MCP config, check it for credentials before staging.
- **Secrets stay in the environment.** `.dev.vars`, `.env*` and `.mcp.json` are read by the
  runtime, never by an agent: no cat, grep, head, copy or session derived from them, in this session
  or any subprocess. An authenticated session comes from a human sign-in
  (`docs/subagents/Subagent-Orchestration.md` §2).
- Style variant is `base-nova` — the one the owner evaluated and approved. Not `base-sera`.

**Before adopting another ReUI block, read `docs/reui-block-adoption.md`.** The Board (#76, shipped
across #80–#83) is the reference adoption: what it actually cost, the traps in order, and how to
estimate the next one. Two decisions are ADRs, not preferences — `frame` is the Portal's committed
ReUI surface (`docs/adr/0014`, superseding 0002's `card`), and the five-star priority control is Quincy-owned rather
than the registry's `rating` (`docs/adr/0003`), so do not "restore" it to `components/reui/`.

## Reuse ReUI before building UI

Reuse means don't reinvent the wheel, not don't change the wheel. Every UI element starts from
something premade, and adapting it — a scoped variant, a different size, radius or layout to match
the prototype — is expected. Search in this order and take the first that fits:

1. What is already installed: `portal/apps/web/src/components/reui/` and `components/quincy/`.
2. A ReUI component, or one of its `c-*` examples.
3. A ReUI block or template.
4. A shadcn base-nova primitive. A 404 on `@reui/<name>` points here (`sheet`, `sidebar`,
   `breadcrumb`, `dialog`, …), not to a missing component.
5. Hand-built, only when nothing above fits.

**Query the ReUI MCP for steps 2–4** (`mcp__ReUI__search` → `get_component` / `get_examples`): it
serves the current registry. The local source copy in `~/quincy-ref/reui/` (outside the repo:
it holds paid Pro blocks and the repo is public, so **never copy it into the repo**) is the
fallback for when the MCP is unavailable, and can be out of date. When the MCP shows a newer
version of an item already installed, reuse the installed copy and say so in the PR: updating a
vendored item is its own change, because it carries Quincy's adaptations.

Load the ReUI skill (`.claude/skills/reui/SKILL.md`, with its `rules/`) for the find → read-the-API
→ adapt loop, and read `docs/reui-reuse.md` for how this repo installs: through the sandbox, since
`shadcn add` in `portal/apps/web` overwrites Quincy's adapted `button` and `badge`. Where the two
differ, the doc wins. Adapt by wiring real data, theming with Quincy tokens, and changing whatever
the prototype calls for; keep the item's behaviour and accessibility. A change to a shared
`components/reui/` item goes in as a scoped variant with an adaptation note in the file, so other
callers render as before.

There is no reuse ledger any more (owner decision, #891). What stays mechanical is
`portal/apps/web/src/config/ui-primitive-ratchet.guard.test.ts`: a new raw
`<button>`/`<input>`/`<select>`/`<textarea>`/`<dialog>` or widget `role` outside
`components/reui/` and `components/quincy/` fails the build unless `config/ui-primitive-allowlist.ts`
gains an entry whose `ledger` field says why nothing premade fits. The allowlist may only shrink.

<!-- BEGIN:reui-agent-rules -->
## ReUI design rules (every UI edit, follow-ups included)

This project uses an existing design system: ReUI on shadcn/ui. Keep its look. Generic frontend advice (vary fonts or themes, gradients, page-load or staggered reveals, "2-3 intentional motions", Framer Motion) does not apply here, and other design skills lose where they disagree.

1. Use installed components first (`components/ui`, `components/reui`): tables `data-grid`, filtering `filters`, boards `kanban`, modals `Dialog` or `AlertDialog`, toasts `sonner`. Never set height, radius, padding, shadow or motion on them; use `size`, `variant`, `spacing`.
2. Color: semantic tokens. State: `<Badge variant="success-light">` from `@/components/reui/badge` at default size, or Alert variants. Raw palette only for categorical identity, with its `dark:` pair.
3. Spacing: `gap-*` on the parent: `gap-1` to `gap-2` in a row, `gap-3` to `gap-4` between groups, `gap-6` to `gap-8` between sections. Type: `text-sm` body, `text-xs` meta, nothing smaller; never resize FrameTitle or CardTitle.
4. Motion: installed parts already animate; never retime them. Yours: hover `transition-colors`; reveal `duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]`; transform and opacity only; never `transition-all`, bounce, or a stagger on table rows or lists of 20+; at most 1 entrance per view; `MotionConfig reducedMotion="user"` plus `motion-reduce:`.
5. Every data region: empty state with an action, `Skeleton` loading, inline error with Retry.
6. Before UI code, write the plan from `.agents/skills/reui/SKILL.md` in your reply. Before you finish, run its self-check on the files you changed and fix every hit (2 rounds at most). Full rules: `.agents/skills/reui/SKILL.md`. If that folder is missing, call the `reui` MCP tool `get_agent_skill`.

Managed by the ReUI installer. Edits between the markers are replaced on the next run.
<!-- END:reui-agent-rules -->

**How the installer block reads in this repo** (outside the markers, so the installer leaves it):

- **The prototype wins over rule 1.** "Never set height, radius, padding, shadow or motion" holds
  for screens with no prototype. Where a prototype frame needs a different size, radius, padding
  or layout, adapt the component to match it — through a scoped `variant`/`size` or a token-built
  class, never a raw value — and keep its behaviour. Rules 2–5 still apply.
- `components/ui/` does not exist here (see "One codebase"); "installed" means `components/reui/` and
  `components/quincy/`. The Portal's surface is `frame` (ADR 0014), not `card`.
- Quincy's tokens in `portal/apps/web/src/styles/` are the semantic tokens of rule 2. Where the
  codebase spells spacing, type or motion as tokens (`--space-*`, `--type-*`, `--dur-*` /
  `--ease-*`), use the token, and `design-system-guards.test.ts` wins over the block's raw values.
- `.agents/skills/reui/` is a local, uncommitted install; the committed copy of the skill is
  `.claude/skills/reui/`. `docs/reui-reuse.md` still governs how to install.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (github.com/mjj2332/Quincy_Portal), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: root `GLOSSARY-MAP.md` + one `GLOSSARY.md` per workspace package under `portal/`. See `docs/agents/domain.md`.

A UI browser pass is stage 1 of two: a Claude design reviewer reads its output next. Save every
screenshot as a file in one folder, named per viewport and open state (phone shots from the iOS
Simulator, keyboard states included), and give every PASS/FAIL row its measurement and screenshot.
When a prototype exists, name the frame each row is checked against. See
`docs/subagents/Subagent-Orchestration.md` §2a.

### TypeSafe verdicts

A development tool for agents, never part of `portal/`. Get a typed **verdict** from TypeSafe for
any narrow judgment over text you already hold whose outcomes you can name in advance — triaging
review findings, sorting failing tests, routing a spec, grading or checking a batch of anything.
Worth most on a pile, and always advice you verify. The owner exports a working key as
`TYPESAFE_API_KEY`, so the API is ready to call — read it from the environment at request time and
keep the value itself out of files, logs and output. Questions, thresholds and what may be sent:
`docs/agents/typesafe.md`.

## Codex only

Other agents skip this section; the Orchestration workflow above governs them.

For complex coding tasks, use the `astra-orchestrator` skill when its trigger conditions match.
The root agent owns architecture, decomposition, integration, and final verification. Prefer
specialized subagents for bounded exploration, implementation, testing, review, and technical
research. Delegate for a reason other than parallelism, and give each implementation agent
explicit ownership of the files it edits. User instructions take precedence over this policy.
