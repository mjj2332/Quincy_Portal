# Subagent Frontend Orchestration

Pipeline for frontend/UI implementation work in this repo — screens, components, visual
convergence, design-system adoption. Supersedes `docs/Subagent-Orchestration.md`'s standard
Sol-drafts/Luna-builds routing for this work only; that doc's CLI mechanics (§3), spawn procedure
(§4), Agy's testing role (§2.8–§2.10), the §5 gate's general content, and known failure modes (§6)
still apply unchanged — read it alongside this one, not instead of it.

## Why a separate lane

Sol and Luna are the same `gpt-5.6` base model under different personas. Neither carries design
judgment: early Luna-built UI on this project shipped with poor taste despite passing every
mechanical review. This lane keeps Sol for what it's actually good at — scope and diff correctness
— and gives every design decision, plan and build alike, to Claude.

## Pipeline

1. **Opus drafts the plan.** Load `/frontend-design` first. Write at implementation-detail
   resolution — exact Tailwind classes/tokens, spacing scale, every component state (default/
   hover/focus/disabled/error) — never directional prose ("make it feel more premium"). Every
   token traces to an existing design-system source (below); invent none. **Done when:** the plan
   closes every design decision itself rather than deferring it to the builder's judgment.
2. **Sol reviews scope and correctness** (`codex exec`, read-only, ≤2 rounds — mechanics in
   `Subagent-Orchestration.md` §3–4). Not aesthetics — Sol has no more taste than Luna does. **Done
   when:** Sol returns APPROVE, or a findings list Opus/Sol resolves within the 2-round cap.
3. **Opus plan-approves**, or — past the 2-round cap — edits the plan itself and self-approves.
4. **A Sonnet subagent builds** (`Agent` tool, `model: sonnet`) — never Luna. A different model
   family catches and fixes plan ambiguity in place instead of defaulting to generic-shadcn output.
5. **Builder self-checks the diff against every plan item** before reporting done.
6. **A fresh Sol diff review** — mechanical correctness and regressions only, same as the standard
   pipeline.
7. **Builder applies Sol's fixes.**
8. **Opus visual/taste review.** Compare the actual rendering — local dev or deployed, in the
   Browser pane — against the plan's intent, not just the diff. This step exists specifically to
   catch what Luna's pipeline missed.
9. **The §5 gate** (this session — `Subagent-Orchestration.md` §5 for the general content), plus a
   visual pass in the Browser pane against the plan before sign-off.
10. **Deploy and commit**, per standing order.

## Scope: full UI rescue, not just the named control

Plan every touched surface as a rescue-and-revamp pass — assess and, where warranted, redesign the
whole visual surface a task reaches, not only the specific control that motivated the task. A task
named for one control ("fix the filter dropdown") still gets the whole panel it lives in looked at.
This doesn't waive any product rule below — it widens what counts as in scope for the visual pass.

Every plan still holds to: matched evidence at this repo's fixed viewports (1440×900, 1024×768,
390×844); preserved accessibility/security/product behavior; owner approval for intentional
evolution or deferral; one styling/data owner per surface; no whole-app rewrite; no stock-shadcn
appearance; no raw framework palette contract; full product/accessibility/test/QA coverage.

## Design-system source — cite it, never invent

`prototype/_ds/quincy-productions-design-system-*/` (`readme.md` plus its CSS) is authoritative:
ink/paper duotone, greige ramp, Mazius Review/Apfel Grotezk/Messapia/Athelas type roles, hairline
rules, square corners, no-shadow elevation. It's ported into
`portal/apps/web/src/styles/tokens/*.css` — that's what a plan actually cites. Confirm every token
referenced in a plan exists there.

## Gotcha: unlayered `app.css` beats Tailwind utilities

`portal/apps/web/src/styles/index.css` declares `@layer theme, base, components, utilities`, then
imports `app.css` outside any layer — so any legacy rule there beats an ordinary Tailwind utility
regardless of specificity, on every surface, not just one. Any plan touching a legacy selector
needs an explicit disposition, stated per selector: retire the CSS and keep the class only as a
non-styling hook; split into a new component-specific class when the legacy one has consumers
outside the current task's scope; or fall back to `!`-prefixed utilities when neither fits.

## Applies to

Any frontend/UI implementation task in this repo — new screens, component redesigns, visual
convergence releases, design-system adoption — not only the TB8 tracer-bullet series that
originated this lane. `docs/plans/revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md`
is TB8's own candidate list and ranking; consult it for that series specifically, but this pipeline
itself generalizes to frontend work outside TB8.
